import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { boxGeo, markRampProxy } from '../station/StationKit.js';

/** Chamfer threshold for interior fittings; see `ShipBuild#ibox`. */
const IBOX_BEVEL_MIN = 0.12;

/**
 * LODESTAR YARD — the ship builder.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THIS EXISTS AND `InteriorKit` DOES NOT ANSWER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `src/worlds/InteriorKit.js` is 864 lines of exactly the shapes a ship
 * interior wants, and it cannot be used for one. Five reasons, all structural:
 *
 * 1. **No rotation.** Its own header says so: "everything is built axis-aligned
 *    in world space, so every collider is an exact `physics.addBox`". `cbox`
 *    calls `addBox` and nothing else. Every hull in this yard stands on a
 *    cradle at a yaw, because four ships all facing the same way is a car park.
 * 2. **No small rooms.** `buildHouse` floors at `INT = max(2.6, …)` — a 5.2 m
 *    minimum square. The Kestrel's cabin is 2.4 m across and the Pike's gun bay
 *    is 1.6 m.
 * 3. **`_deckWithHoles` is hard-coded `N = 10` panels regardless of size.** On
 *    a 3 m deck that is 30 cm panels and 100 colliders, per deck, per ship.
 * 4. **No ladders and no half levels.** A stair at <= 0.45 m of rise costs 4 m
 *    of run for a 3 m gap, which does not fit inside a 14 m hull.
 * 5. **The palette is stone / plaster / plank / beam / slate / iron.**
 *
 * So the SHAPES are borrowed and the code is not: a wall with an opening is
 * still five segments plus a lintel, a hatch is still a record whose leaves
 * `Interiors._onWorld` can drive, a lift is still `setBoxColliderY` — but every
 * one of them is expressed in a hull's own local frame.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE LOCAL FRAME, AND WHY A COLLIDER CANNOT DRIFT FROM ITS GEOMETRY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every hull is authored around its own origin — **`+Z` is the nose, `+X` is
 * starboard, `y 0` is the cradle's bearing face** — which is
 * `station/ZoneContext.js:36`'s rationale exactly: a builder that has to think
 * in world coordinates spends its whole length rotating points by hand, and
 * gets one of them wrong.
 *
 * `GeoBatch.localAt` sends local `+X` to world `(cos yaw, -sin yaw)` and local
 * `+Z` to `(sin yaw, cos yaw)`. {@link ShipBuild.P} is that same pair of lines
 * and nothing else, so a collider placed at `P(lx, ly, lz)` and geometry placed
 * at `(lx, ly, lz)` are in the same place BY CONSTRUCTION rather than by two
 * authors agreeing. `station/Tower.js:425` records what the alternative costs:
 * a rider stopped dead two thirds of the way up a flight by a soffit that
 * exists only as a decoration.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE CLIMB CONTRACT — THIS IS WHY THE HULLS ARE SHAPED LIKE THIS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `player/FreeClimb.js` probes three rays at `yaw ± 0.26` rad out to
 * `0.35 + 0.62 = 0.97 m` at eye height × 0.72 = **1.166 m**, and takes any face
 * whose `|normal.y| <= 0.5`. `player/Climb.js` finishes with a mantle needing a
 * top face at `normal.y >= 0.7`, a rise inside `[0.25, 2.4]`, **1.55 m** of
 * headroom over the landing, and a `resolveCapsule` that reports grounded
 * **0.77 m inboard** of the edge (`P.radius 0.35 + LAND_INSET 0.42`).
 *
 * Three consequences, all load-bearing:
 *
 * - **Boxes, never soup.** `CitadelWorld.js:71-74`: "a triangle soup would give
 *   the climb probe a surface normal per triangle and make ledge detection
 *   chatter along every seam." Visual and collision decouple — draw whatever
 *   swept form you like, collide a stack of yawed boxes.
 * - **A ledge is 0.9 m deep or it is not a ledge.** A mantle needs 0.77 m of
 *   flat inboard before `resolveCapsule` calls the player grounded, so the
 *   bolted string course the lore hangs on every section joint cannot BE the
 *   rest ledge — a 0.3 m flange is a handhold the mantle refuses to finish on.
 *   What makes the ledge is the hull STEPPING IN at the joint; the course is
 *   the flange bolted over the step. Which is also what a hull re-assembled
 *   from sections narrow enough to walk through a gateway arch looks like.
 * - **Bands, because stamina is a movement budget.** `DRAIN_UP = 5.4`/s against
 *   a 100 bar at `SPEED_UP = 2.05` m/s is 13.7 m of continuous climb, and
 *   holding on costs only 1.6/s, so a ledge is a real rest. Every hull here
 *   bands at under 4.2 m.
 */

/* ------------------------------------------------------------------ */
/* Module scratch. The build itself does not churn a Vector3 per        */
/* collider; nothing in this file runs in a frame handler at all.       */
/* ------------------------------------------------------------------ */
const _c = new THREE.Vector3();
const _h = new THREE.Vector3();
const _euler = new THREE.Euler();
const _quat = new THREE.Quaternion();

/** Flat depth a mantle needs before `resolveCapsule` reports grounded. */
export const MANTLE_INBOARD = 0.77;
/** Headroom `Climb._probe` demands over a landing (`P.height - 0.2`). */
export const MANTLE_HEADROOM = 1.55;
/** Height above the feet `FreeClimb.poll` fires its three-ray fan from. */
export const GRIP_HEIGHT = 1.166;
/** Tallest rise a mantle will take, from `Climb.MAX_RISE`. */
export const MANTLE_MAX_RISE = 2.4;

/**
 * Half the run of flank a bi-parting sliding hatch of clear width `w` occupies.
 *
 * Exported, and used by both {@link ShipBuild#hatch} and every hull builder,
 * because the two have to agree and they are 700 lines apart. A hull declares
 * its aperture at the top of its builder — before the plating is dressed — and
 * the hatch declares the same span again when it is finally cut at the bottom;
 * a number derived twice from this one function cannot drift, and if a future
 * hull forgets the early declaration the aperture probe in
 * `dock-hull-shape.test.mjs` says so with a count rather than a boolean.
 *
 * `w * 0.75 + 0.25` is the leaf travel `w/2 + 0.06`, plus half a leaf
 * `(w/2 + 0.02) / 2`, plus the end post at 0.08 and 0.10 of margin.
 */
export const slidePocket = (w) => w * 0.75 + 0.25;

/**
 * How far in front of an opening nothing may be built, and how far past its
 * jambs.
 *
 * The capsule is `P.radius 0.35` in radius, so 1.1 m of approach is a body's
 * width and a stride; 0.35 past each jamb is the same body not clipping the
 * corner. Both are the geometry the player occupies, not a taste.
 */
const APPROACH = 0.95;
const APPROACH_SIDE = 0.35;
/** A crouch hole is approached on hands and knees; a stride does not apply. */
const CRAWL_APPROACH = 0.6;
/**
 * How much air a collectible keeps round it.
 *
 * The pickup itself is a hand-sized mesh; what has to stay clear is enough for
 * it to be SEEN from the room it is in. Wider than this and the prize on the
 * Dray`s console reserves the console.
 */
const COLLECTIBLE_CLEAR = 0.28;

/**
 * One hull under construction, in its own frame.
 *
 * Handed the world's batches and physics rather than the world, for the reason
 * `station/ZoneContext.js:36` gives: a builder that can only be used by one
 * caller is a builder that gets copied.
 */
export class ShipBuild {
  /**
   * @param {object} o
   * @param {any} o.batch    exterior `GeoBatch`
   * @param {any} o.interior interior `GeoBatch` — its own LOD band
   * @param {any} o.physics
   * @param {(c:any)=>any} o.track the world's collider tracker
   * @param {THREE.Group} o.group where loose objects (hatch leaves, proxies) go
   * @param {number} o.x world X of the cradle centre
   * @param {number} o.y world Y of the cradle bearing face — ship-local y 0
   * @param {number} o.z world Z of the cradle centre
   * @param {number} o.yaw world yaw of the ship's local frame
   * @param {boolean} [o.yard] true when this hull is being built INTO A BERTH —
   *   see {@link ShipBuild#yard}. `ShipModel` passes false.
   */
  constructor({ batch, interior, physics, track, group, x, y, z, yaw, yard = true }) {
    /**
     * IS THIS HULL STANDING IN THE YARD, OR IS IT THE ONE YOU FLY?
     *
     * ── The defect, in a screenshot ─────────────────────────────────────
     * `ShipModel.buildShipModel` runs the SAME builders as `DockWorld`, which
     * is the whole point of that file — one description of a hull, so the ship
     * on the pier and the ship you fly cannot drift apart. What nobody noticed
     * is that a hull builder does not only draw a hull. It also draws the
     * YARD'S fittings on it: the berth stencil, the boarding brow with its
     * landing plate and hazard stripes, and the Pike's dorsal access scaffold.
     *
     * So the Kestrel flew through interstellar space with `BERTH B1 / KESTREL
     * // COURIER` lit on both flanks and a flight of stairs trailing off her
     * belly; the Pike towed a railed scaffold larger than her own tail; the
     * Dray's group measured 35.5 x 15.7 m against a 29.6 x 13.2 m hull —
     * roughly 6 m of yard furniture projecting past her nose and 2.4 m of
     * gangway out to starboard, in vacuum. Four reviews reported it.
     *
     * ── Why a flag and not a second builder ─────────────────────────────
     * For exactly the reason {@link ShipBuild#mute} is a flag: two copies of a
     * hull drift. This is the same code path with one boolean off, and the
     * things it gates are the things that belong to the BERTH rather than to
     * the ship — a berth number is not part of a spacecraft, and a brow that
     * descends to the cradle's bearing face has nothing to descend to once the
     * cradle is 400 km astern. `Piloting.disembark` teleports the pilot to a
     * ground-resolved point beside the hull and has never used the brow, so
     * nothing is lost when it is not built.
     *
     * Nothing gated here is collided in the yard's own reach graph in a way
     * the flown hull needs: `DockWorld` reads `out.ramp` behind an `if`, and
     * the flown build already throws its colliders away.
     */
    this.yard = !!yard;
    this.B = batch;
    this.I = interior;
    this.physics = physics;
    this.track = track;
    this.group = group;
    this.ox = x; this.oy = y; this.oz = z; this.yaw = yaw;
    this._cos = Math.cos(yaw);
    this._sin = Math.sin(yaw);
    /** Colliders this hull registered, so the caller can count them. */
    this.colliders = [];
    /**
     * Where this hull's engine bells exit, in HULL-LOCAL metres, and how wide.
     *
     * Recorded by `Hulls.bell` as it draws, because the alternative is a second
     * table of nozzle positions in `HullPlan` that nothing checks against the
     * cones actually drawn - and a plume 40 cm off the back of its own bell is
     * the kind of thing nobody sees in a screenshot and everybody sees in
     * motion. `ShipModel` reads this to hang the exhaust; the yard ignores it,
     * because a hull on a cradle has its engines cold.
     * @type {{x:number, y:number, z:number, r:number}[]}
     */
    this.nozzles = [];
    /** Ramp proxies this hull registered, for the audit. */
    this.proxies = [];
    /** Door records for `Interiors`. */
    this.doors = [];
    /** Lift records for `Interiors`. */
    this.lifts = [];
    /** Authored collectible spots, already in world space. */
    this.spots = [];
    /**
     * Local-frame AABB of every part drawn into the INTERIOR batch.
     *
     * Recorded because {@link fitOut} runs after the hull builder and has to
     * fit around what that builder already put in the room. Local rather than
     * world for the reason the whole class is local: the AABB of a yawed box is
     * not the box, and at the Dray's 0.20 rad a 9 m hold measures 10.6 m across
     * in world axes.
     */
    this.iparts = [];
    /**
     * Volumes a fitting may not stand in: doorways and their approaches, the
     * swing of every hatch leaf, the run of every flight, lift shafts, and the
     * collectibles the hull authored.
     *
     * `MedievalWorld`'s ore benches were built across their own building's
     * entrance and shipped: from outside the door was a door, and the room
     * behind it could not be entered. Nothing found it because a doorway is not
     * a thing any test knew about. Here it is: every opening this class cuts
     * publishes the volume that has to stay empty, at the moment it is cut, so
     * a fitting cannot be placed in one without {@link fits} saying no.
     */
    this.ways = [];
    /**
     * THE APERTURES, AND THE DEFECT THEY EXIST TO STOP.
     *
     * `ways` reserves the volume a FITTING may not stand in — it is consulted
     * by {@link fitOut} and by nothing else. The outside of a hull has no
     * fit-out pass and therefore never consulted anything, and the result was
     * the one the player reported: **80 of 81 rays fired through the Kestrel's
     * boarding aperture from 1.6 m outside were stopped before they reached the
     * plating**, by relief patches at local x 2.32-2.52 against a flank at
     * 2.30, by a section rib dead on the hatch centreline at z -1.50, by a
     * panel line at -1.80, by two string-course members, and by the berth
     * stencil, a 2.2 x 0.9 m sign plane at z -2.10..0.10 laid straight over the
     * door. The hatch was cut correctly through the PLATING by `plated`'s
     * `opening` and then covered by six later passes that had never heard of
     * it. Measured the same way: Dray 73/81, Pike 67/81.
     *
     * So an aperture is declared ONCE, by {@link hatch}, and every flank
     * dressing asks {@link flankRuns} or {@link clearOfAperture} before it
     * draws. It is the same rule `intactRuns` already applies to the plating,
     * moved to where the plating's dressing can see it — and it covers the
     * POCKETS as well as the opening, because a leaf that slides has to slide
     * over bare plating or it slides through a vent.
     *
     * @type {{side:number, axis:'z'|'x', a0:number, a1:number, y0:number, y1:number}[]}
     */
    this.apertures = [];
    /** What {@link fitOut} managed to build, and what it had to refuse. */
    this.fitStats = { placed: 0, refused: 0, unknown: [] };
    /** @see mute — exterior drawing suppressed while an authored skin stands in. */
    this._muted = false;
  }

  /**
   * DRAW NOTHING FOR A WHILE, AND STILL BUILD EVERYTHING ELSE.
   *
   * A hull whose skin arrives as an authored .glb (see `src/ships/
   * ShipAssets.js`) still needs every other thing its procedural builder does:
   * the flank colliders the climb bands grip, the inscribed boxes under each
   * loft, the aperture record every flank dressing asks about, the bulkheads,
   * the rooms. Only the DRAWING is replaced.
   *
   * The alternative was a second copy of `buildKestrel` that emits colliders
   * and no geometry, and this project has a long memory of what two
   * descriptions of one object do: they drift, and the ship on the pier stops
   * being the ship you fly. So the procedural shell still runs, in full, with
   * `put` muted — one flag, one call site, and the fallback arm is the same
   * code path with the flag off.
   *
   * Exterior only. `iput` is not muted: the interior is not what an authored
   * skin replaces, and a muted room would be a room with no walls.
   *
   * @param {boolean} on
   */
  mute(on) {
    this._muted = !!on;
    return this;
  }

  /* ---------------------------------------------------------------- */
  /* Apertures                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Declare a run of a flank that must stay bare: an opening plus its pockets.
   *
   * `side` is the sign of local X for a flank aperture and `0` for a
   * transverse one; `axis` is the direction the opening runs in.
   */
  aperture(side, axis, a0, a1, y0, y1) {
    const a = { side, axis, a0, a1, y0, y1 };
    this.apertures.push(a);
    return a;
  }

  /**
   * Is this patch of a flank clear of every aperture?
   *
   * Takes a box rather than a point because the things that were covering the
   * Kestrel's doorway were 0.5-2.2 m wide and their CENTRES were mostly outside
   * the opening. A point test would have passed them all.
   *
   * @param {number} side sign of local X, or 0 for a transverse face
   */
  clearOfAperture(side, a0, a1, y0, y1) {
    for (const ap of this.apertures) {
      if (ap.side !== side) continue;
      if (a1 <= ap.a0 || a0 >= ap.a1) continue;
      if (y1 <= ap.y0 || y0 >= ap.y1) continue;
      return false;
    }
    return true;
  }

  /**
   * The runs of `[a0, a1]` on one flank that no aperture crosses.
   *
   * The same decomposition `Hulls.intactRuns` does for the plating and the
   * Bastion's stripped bays, driven off the declared apertures so a run cannot
   * disagree with a hole. `y0/y1` are the band being drawn: a course at deck
   * height is not cut by a hatch that stops below it.
   */
  flankRuns(side, a0, a1, y0, y1) {
    let runs = [[a0, a1]];
    for (const ap of this.apertures) {
      if (ap.side !== side) continue;
      if (y1 <= ap.y0 || y0 >= ap.y1) continue;
      const next = [];
      for (const [p, q] of runs) {
        if (q <= ap.a0 || p >= ap.a1) { next.push([p, q]); continue; }
        if (p < ap.a0) next.push([p, ap.a0]);
        if (q > ap.a1) next.push([ap.a1, q]);
      }
      runs = next;
    }
    return runs.filter(([p, q]) => q - p > 0.05);
  }

  /* ---------------------------------------------------------------- */
  /* Occupancy                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Record a drawn interior part's local AABB.
   *
   * Taken from the GEOMETRY's own bounds and its eight rotated corners rather
   * than from `(w, h, d)`, so a cylinder laid on its side and a box tilted on
   * three axes both measure correctly and there is one code path instead of
   * one per primitive.
   */
  _occupy(geo, lx, ly, lz, ry, rx, rz) {
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox;
    if (!bb) return;
    _euler.set(rx, ry, rz, 'YXZ');
    _quat.setFromEuler(_euler);
    let x0 = Infinity, y0 = Infinity, z0 = Infinity;
    let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      _c.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z);
      _c.applyQuaternion(_quat);
      if (_c.x < x0) x0 = _c.x;
      if (_c.x > x1) x1 = _c.x;
      if (_c.y < y0) y0 = _c.y;
      if (_c.y > y1) y1 = _c.y;
      if (_c.z < z0) z0 = _c.z;
      if (_c.z > z1) z1 = _c.z;
    }
    /* The AABB, and — where the part is a plain yaw — its OWN frame as well.
     *
     * The frame is what lets a strap be laid over a crate that is standing at
     * 0.8 rad rather than over the crate's bounding box, which on a 1.5 x 1.0 m
     * box at that angle is 0.35 m wider than the crate. Parts carrying a pitch
     * or a roll fall back to the AABB with `ry 0`: a swept form dressed in its
     * own frame would need the frame, and nothing in this yard dresses one. */
    const plain = rx === 0 && rz === 0;
    this.iparts.push({
      x0: lx + x0, x1: lx + x1, y0: ly + y0, y1: ly + y1, z0: lz + z0, z1: lz + z1,
      cx: plain ? lx : lx + (x0 + x1) / 2,
      cy: ly + (bb.min.y + bb.max.y) / 2,
      cz: plain ? lz : lz + (z0 + z1) / 2,
      hx: plain ? (bb.max.x - bb.min.x) / 2 : (x1 - x0) / 2,
      hy: (bb.max.y - bb.min.y) / 2,
      hz: plain ? (bb.max.z - bb.min.z) / 2 : (z1 - z0) / 2,
      ry: plain ? ry : 0,
    });
  }

  /**
   * The recorded interior part that overlaps `probe` most, or null.
   *
   * This is how the fit-out finds a mass the hull already built — a seat pan, a
   * bunk board, a powerplant block — so the trim it hangs on that mass follows
   * it if the hull moves it. Largest overlap rather than nearest centre, because
   * a probe reaching across a room touches several small parts and one big one,
   * and the big one is the furniture.
   */
  partIn(probe) {
    let best = null, bestV = 0;
    for (const p of this.iparts) {
      const w = Math.min(p.x1, probe.x1) - Math.max(p.x0, probe.x0);
      const h = Math.min(p.y1, probe.y1) - Math.max(p.y0, probe.y0);
      const d = Math.min(p.z1, probe.z1) - Math.max(p.z0, probe.z0);
      if (w <= 0 || h <= 0 || d <= 0) continue;
      const v = w * h * d;
      if (v > bestV) { bestV = v; best = p; }
    }
    return best;
  }

  /** Every recorded interior part whose centre lies inside `probe`. */
  partsIn(probe) {
    const out = [];
    for (const p of this.iparts) {
      if (p.cx === undefined) continue;
      if (p.cx < probe.x0 || p.cx > probe.x1) continue;
      if (p.cy < probe.y0 || p.cy > probe.y1) continue;
      if (p.cz < probe.z0 || p.cz > probe.z1) continue;
      out.push(p);
    }
    return out;
  }

  /** Reserve a volume nothing may be built in. */
  way(x0, x1, y0, y1, z0, z1) {
    this.ways.push({ x0, x1, y0, y1, z0, z1 });
  }

  /**
   * Is this local AABB clear of everything already in the room?
   *
   * `SLOP` is subtracted from the CANDIDATE, so a fitting whose back face lands
   * exactly on a lining panel is legal and one that buries itself 30 mm into it
   * is not. Touching is how furniture meets a wall; overlapping is z-fighting.
   */
  fits(box, except = null) {
    return this.blocker(box, except) === null;
  }

  /**
   * What stops this fitting, or null.
   *
   * Separate from {@link fits} because "it did not fit" is not a diagnosis. A
   * fit-out that silently refuses a third of its own fittings looks exactly like
   * one that placed them, and the only way to tell is to name the obstruction.
   *
   * `except` is the parts a fitting is ALLOWED to touch — the mass it is being
   * bolted to. A cushion overlaps the pan it sits in by design; a casing band
   * goes round the core, not beside it.
   */
  blocker(box, except = null) {
    const SLOP = 0.02;
    const a = {
      x0: box.x0 + SLOP, x1: box.x1 - SLOP,
      y0: box.y0 + SLOP, y1: box.y1 - SLOP,
      z0: box.z0 + SLOP, z1: box.z1 - SLOP,
    };
    for (const list of [this.iparts, this.ways]) {
      for (const p of list) {
        if (except && except.includes(p)) continue;
        if (a.x0 < p.x1 && a.x1 > p.x0
          && a.y0 < p.y1 && a.y1 > p.y0
          && a.z0 < p.z1 && a.z1 > p.z0) return p;
      }
    }
    return null;
  }

  /**
   * A part, plus everything resting on it, as one mass.
   *
   * A bunk is a board with a mattress on it and the bedding goes on the
   * MATTRESS; a seat pan under a cushion is the same shape of question. Two
   * passes, because a mattress can itself carry a cover.
   */
  stack(part) {
    const out = [part];
    let top = part.y1;
    for (let pass = 0; pass < 2; pass++) {
      let next = top;
      for (const p of this.iparts) {
        if (out.includes(p)) continue;
        if (p.y0 < top - 0.03 || p.y0 > top + 0.08) continue;
        if (p.x1 <= part.x0 + 0.02 || p.x0 >= part.x1 - 0.02) continue;
        if (p.z1 <= part.z0 + 0.02 || p.z0 >= part.z1 - 0.02) continue;
        out.push(p);
        if (p.y1 > next) next = p.y1;
      }
      if (next === top) break;
      top = next;
    }
    return { parts: out, top };
  }

  /* ---------------------------------------------------------------- */
  /* The frame                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Local point -> world. The ONE place this frame is defined.
   *
   * Identical arithmetic to `GeoBatch.localAt`, which is the point: a collider
   * derived any other way can drift from the geometry it describes, and the
   * drift is invisible until a player walks into thin air.
   * @returns {THREE.Vector3} a NEW vector — callers keep these
   */
  P(lx, ly, lz) {
    return new THREE.Vector3(
      this.ox + lx * this._cos + lz * this._sin,
      this.oy + ly,
      this.oz - lx * this._sin + lz * this._cos
    );
  }

  /** World yaw of a heading `ry` in the ship's frame. */
  Y(ry = 0) { return this.yaw + ry; }

  /* ---------------------------------------------------------------- */
  /* Geometry                                                          */
  /* ---------------------------------------------------------------- */

  /** Exterior geometry at a local pose. Suppressed by {@link mute}. */
  put(key, geo, lx, ly, lz, ry = 0, rx = 0, rz = 0) {
    if (this._muted) {
      /* The caller built this geometry before it knew it would not be drawn.
       * `GeoBatch` would have owned it; nobody does now, so it is disposed
       * here rather than left for the GC to find a GPU-less buffer. */
      geo?.dispose?.();
      return null;
    }
    return this.B.localAt(key, geo, this.ox, this.oy, this.oz, this.yaw, lx, ly, lz, ry, rx, rz);
  }

  /**
   * Interior geometry — a second batch, LOD-banded by the caller.
   *
   * Every part is recorded in {@link iparts} on the way past. `localAt` applies
   * the matrix to the geometry and the batch then owns it, so the bounds have
   * to be taken here or not at all.
   */
  iput(key, geo, lx, ly, lz, ry = 0, rx = 0, rz = 0) {
    this._occupy(geo, lx, ly, lz, ry, rx, rz);
    return this.I.localAt(key, geo, this.ox, this.oy, this.oz, this.yaw, lx, ly, lz, ry, rx, rz);
  }

  /**
   * THE TILE GUARD, AND THE BLACK WORLD IT EXISTS TO STOP.
   *
   * `boxUV` gives a box constant texel density by dividing each face's size by
   * `tile`. A `tile` of 0 makes that division infinite, and `uv * Infinity` is
   * `Infinity` where the unit uv is 1 and NaN where it is 0 — so the box ships
   * with NaN texture coordinates, every fragment it draws samples the albedo at
   * NaN, and the fragment is NaN.
   *
   * A handful of NaN fragments is not a handful of bad pixels. `UnrealBloomPass`
   * high-passes the frame and blurs the result through five mip levels, so ONE
   * NaN texel is smeared across the entire bloom pyramid, and the additive
   * composite back over the scene writes NaN over EVERY pixel. The measured
   * result, at `VIEWS.dock` `berth-b1`, was a frame with a mean luminance of
   * 4.1 out of 255 that no light in the world could change: flooding ambient
   * from 0.22 to 6.0 moved it by 0.07, because there was nothing left of the
   * image to brighten. Nineteen NaN pixels at `gantry-crossing` blacked out
   * 921,600.
   *
   * Three call sites in `Hulls.js` did it, all the same way: they meant to pass
   * a ROLL and wrote it as a tenth argument, so `0` landed in `tile`. There is
   * no roll parameter here — see `rbox` — and this guard makes the mistake a
   * build-time throw rather than a world that renders black.
   */
  static _tile(tile, where) {
    if (!(Number.isFinite(tile) && tile > 0)) {
      throw new Error(
        `ShipBuild.${where}: tile must be a positive number, got ${tile}. `
        + 'A tile of 0 divides by zero in boxUV and ships NaN uvs, which bloom '
        + 'then smears over the whole frame. Did you mean rbox() for a roll?'
      );
    }
    return tile;
  }

  /** A drawn box, exterior. `l*` is the CENTRE, `w/h/d` are full sizes. */
  box(key, w, h, d, lx, ly, lz, ry = 0, tile = 2) {
    this.put(key, boxGeo(w, h, d, ShipBuild._tile(tile, 'box')), lx, ly, lz, ry);
  }

  /**
   * A drawn box on a full rotation triple — a raking strut, a canted knee, a
   * panel hanging off one hinge, a stringer following a ramp.
   *
   * The argument order after the position is `(ry, rx, rz)` and that is not an
   * accident: it is `put`'s order, and `put`'s order is what five call sites in
   * `Hulls.js` reached for when they wanted to tilt a box. `box` does not take
   * a rotation triple — its ninth argument is `tile` — so all five silently
   * dropped their tilt and put a rotation angle into the texel density.
   * Whichever of the two orders a caller has in their head, this signature is
   * the one they wrote.
   */
  rbox(key, w, h, d, lx, ly, lz, ry = 0, rx = 0, rz = 0, tile = 2) {
    this.put(key, boxGeo(w, h, d, ShipBuild._tile(tile, 'rbox')), lx, ly, lz, ry, rx, rz);
  }

  /**
   * A drawn box, interior.
   *
   * Chamfered from 12 cm rather than the kit default of a metre.
   *
   * `boxGeo`'s threshold is set for the station, where a box is read across a
   * concourse. Everything `ibox` places is read from arm's length inside a
   * compartment - a console lip, a locker face, a grab rail, a bunk board -
   * and a metre would chamfer EIGHT of the 1,175 boxes a full yard build emits
   * through here (the distribution's median smallest-dimension is 3 cm).
   *
   * 12 cm is where the radius rule stops refusing anyway: `bevelRadius` clamps
   * to 22% of the smallest dimension, so under about 9 cm there is no round
   * left to catch a highlight and the 9x buys nothing. Measured on a headless
   * `buildDockFresh()`, it chamfers 123 fittings for +13,248 triangles - the
   * yard's whole chamfer bill is +18,720 on 266,770, and the exterior `box`
   * at the kit default accounts for only 5,472 of it.
   *
   * The exterior `box`/`rbox` deliberately keep the kit default. Hull plating
   * is laid plate against plate and a chamfered run of it is a ladder of dark
   * seams - but plating is thin, so the smallest-dimension rule has already
   * excluded it, and what is left above 80 cm is the chunky masses (cargo
   * blocks, nacelles, cradle timbers) that should be eased. `cbox` draws
   * through `box` and collides the FULL box, so the chamfer only ever cuts
   * geometry away from inside the collider, never the other way round.
   */
  ibox(key, w, h, d, lx, ly, lz, ry = 0, tile = 2) {
    this.iput(key, boxGeo(w, h, d, ShipBuild._tile(tile, 'ibox'), IBOX_BEVEL_MIN), lx, ly, lz, ry);
  }

  /* ---------------------------------------------------------------- */
  /* Collision                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * A solid volume in the ship's frame. ALWAYS a rotated box.
   *
   * `physics.addRotatedBox` takes a world centre, half-extents in the box's own
   * frame and a world yaw, which is exactly what a hull section is. There is no
   * `addBox` anywhere in this file on purpose: an axis-aligned collider under a
   * yawed hull is a wall the player meets before they reach the plating and a
   * hole where the plating actually is.
   */
  solid(lx, ly, lz, hx, hy, hz, ry = 0, opts) {
    const c = this.track(this.physics.addRotatedBox(
      _c.set(
        this.ox + lx * this._cos + lz * this._sin,
        this.oy + ly,
        this.oz - lx * this._sin + lz * this._cos
      ),
      _h.set(hx, hy, hz),
      this.yaw + ry,
      opts
    ));
    this.colliders.push(c);
    return c;
  }

  /** Draw and collide the same box. The common case, and the one that cannot drift. */
  cbox(key, w, h, d, lx, ly, lz, ry = 0, tile = 2) {
    this.box(key, w, h, d, lx, ly, lz, ry, tile);
    return this.solid(lx, ly, lz, w / 2, h / 2, d / 2, ry);
  }

  /* ---------------------------------------------------------------- */
  /* Structure                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * A transverse bulkhead with a rectangular opening: segments, plus a lintel.
   *
   * `InteriorKit.js:361-373`'s shape, and the reason is the same one: a single
   * box the size of the wall fills the room behind it, and a wall drawn with a
   * hole but collided as one box is a doorway the player cannot walk through.
   *
   * The wall lies in the ship's local XY plane at `lz`, spanning `[a0, a1]` in
   * local X and `[y0, y1]` in local Y, with an opening from `o0` to `o1` and
   * `oh` tall measured from `y0`.
   */
  wallX(key, lz, a0, a1, y0, y1, o0, o1, oh, t = 0.12) {
    const seg = (x0, x1, ya, yb) => {
      if (x1 - x0 < 0.01 || yb - ya < 0.01) return;
      this.cbox(key, x1 - x0, yb - ya, t, (x0 + x1) / 2, (ya + yb) / 2, lz, 0, 2);
    };
    seg(a0, o0, y0, y1);                 // port of the opening
    seg(o1, a1, y0, y1);                 // starboard of it
    seg(o0, o1, y0 + oh, y1);            // the lintel over it
    /* The opening, and a metre of approach on each side of it. `Interiors`
     * offers a door within 3.0 m horizontally and the capsule is 0.70 m across,
     * so a fitting standing a body's width off the threshold is a fitting the
     * player has to walk round to reach a prompt they can already see. */
    const near = oh >= 1.8 ? APPROACH : CRAWL_APPROACH;
    this.way(o0 - APPROACH_SIDE, o1 + APPROACH_SIDE, y0, y0 + oh, lz - near, lz + near);
  }

  /** The same, for a longitudinal wall in the local YZ plane at `lx`. */
  wallZ(key, lx, a0, a1, y0, y1, o0, o1, oh, t = 0.12) {
    const seg = (z0, z1, ya, yb) => {
      if (z1 - z0 < 0.01 || yb - ya < 0.01) return;
      this.cbox(key, t, yb - ya, z1 - z0, lx, (ya + yb) / 2, (z0 + z1) / 2, 0, 2);
    };
    seg(a0, o0, y0, y1);
    seg(o1, a1, y0, y1);
    seg(o0, o1, y0 + oh, y1);
    const near = oh >= 1.8 ? APPROACH : CRAWL_APPROACH;
    this.way(lx - near, lx + near, y0, y0 + oh, o0 - APPROACH_SIDE, o1 + APPROACH_SIDE);
  }

  /**
   * A bolted string course round a hull section — FOUR members, one per face.
   *
   * ── THE FULL-PLAN-BOX RULE, AND WHY THIS SIGNATURE HAS NO PLAN SIZE ──────
   * This is the fourth occurrence of one defect. Medieval plank courses,
   * medieval string courses, medieval bressumers and the station tower's string
   * course were every one of them authored as ONE box the size of the whole
   * plan. From outside it is invisible. Inside it is a slab of boarding hanging
   * through the middle of the room, and it accounted for 251 of 407 z-fighting
   * hits and one sealed atrium. The measured version: raycast up from the
   * Marcher Hall's ground floor and the first thing over your head was plank at
   * **1.66 m**, not the ceiling at 2.85. Nothing caught it, because those
   * members have no colliders and a headroom probe probes colliders.
   *
   * So there is no `(w, d)` parameter here that could be handed the whole plan.
   * Four members are emitted, each spanning one face, each INSET by `inset` so
   * its inner face lands inside the plating — buried, never coplanar, and
   * identical from outside.
   *
   * @param {number} hw half-beam of the section the course runs round
   * @param {number} z0,z1 the run in local Z
   * @param {number} y centre height of the course
   */
  course(key, hw, z0, z1, y, o = {}) {
    const h = o.h ?? 0.22;
    const proud = o.proud ?? 0.14;
    const inset = o.inset ?? 0.16;
    const len = z1 - z0, cz = (z0 + z1) / 2;
    /* Port and starboard: a member per flank, inset so the inner face is
     * buried — and CUT where a door is. Two of these ran straight across the
     * Kestrel's boarding hatch, one at local y 1.50 and one at 2.66 against an
     * opening from 0.76 to 2.76. A course runs into a door surround and stops;
     * it does not cross it. */
    for (const s of [-1, 1]) {
      for (const [a, c2] of this.flankRuns(s, z0, z1, y - h / 2, y + h / 2)) {
        this.box(key, proud + inset, h, c2 - a, s * (hw + proud / 2 - inset / 2), y, (a + c2) / 2, 0, 1);
      }
    }
    if (o.ends === false) return;
    // Fore and aft, stopped short of the flank members so nothing is doubled.
    for (const s of [-1, 1]) {
      this.box(key, (hw - inset) * 2, h, proud + inset, 0, y,
        cz + s * (len / 2 - inset / 2 + proud / 2), 0, 1);
    }
  }

  /** A row of bolt heads down a seam. Batched, so it is zero extra draws. */
  bolts(key, x, y, z0, z1, n, r = 0.055) {
    const side = Math.sign(x) || 1;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const z = z0 + (z1 - z0) * t;
      // Bolts follow the course they head, so they stop where the course does.
      if (!this.clearOfAperture(side, z - r, z + r, y - r, y + r)) continue;
      this.put(key, new THREE.CylinderGeometry(r, r, 0.05, 6), x, y, z, 0, 0, Math.PI / 2);
    }
  }

  /**
   * A rib frame standing proud of a flank — drawn, and grabbable because it is
   * thin.
   *
   * Skipped where it would cross a doorway. The Kestrel's four ribs were
   * spaced 1.9 m from `lower.z0 + 1.0`, which lands one of them at z -1.50:
   * the exact centreline of its boarding hatch. A 0.18 m post through the
   * middle of a 1.1 m door, drawn and not collided, so the player walked
   * through it.
   */
  rib(key, hw, y0, y1, lz, t = 0.18, proud = 0.1) {
    for (const s of [-1, 1]) {
      if (!this.clearOfAperture(s, lz - t, lz + t, y0, y1)) continue;
      this.box(key, proud + t, y1 - y0, t, s * (hw + proud / 2), (y0 + y1) / 2, lz, 0, 1);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Walkable slopes                                                   */
  /* ---------------------------------------------------------------- */

  /**
   * A walkable flight in the ship's frame: treads drawn, ONE hidden ramp proxy
   * collided.
   *
   * `station/Tower.js:527` is the whole reason: the capsule solver resolves
   * slopes and does NOT step up, so a flight drawn as treads and collided as
   * treads stops the body dead at the first riser. And the proxy sits LOW by
   * `0.25 / cos(pitch)` because its 0.5 m-thick box has its CENTRE on the
   * slope, so its walkable top surface is that much above the plane — placed on
   * the centreline, the flight lands a third of a metre proud of the deck it is
   * supposed to meet, at both ends.
   *
   * The real ceiling on `pitch` is about 45 degrees and it does NOT come from
   * the `delta.y > 0.64` test in `resolveCapsule` — it comes from the
   * closest-point iteration, which stops reporting the true face normal past
   * ~44 degrees. Nothing in this yard goes past 38.
   *
   * @param {'x'|'z'} axis travel direction in the ship's frame
   * @param {number} lx0,ly0,lz0 the FOOT, in the ship's frame
   * @param {number} run SIGNED horizontal travel
   * @param {number} rise height gained
   */
  flight(axis, lx0, ly0, lz0, run, rise, width, risers, o = {}) {
    const key = o.key ?? 'deckg';
    const sideKey = o.sideKey ?? 'dark';
    const stepRun = run / risers;
    const stepRise = rise / risers;
    for (let i = 0; i < risers; i++) {
      const t = (i + 0.5) / risers;
      const cx = axis === 'x' ? lx0 + run * t : lx0;
      const cz = axis === 'z' ? lz0 + run * t : lz0;
      const cy = ly0 + rise * t;
      const w = axis === 'x' ? Math.abs(stepRun) + 0.02 : width;
      const d = axis === 'x' ? width : Math.abs(stepRun) + 0.02;
      this.box(key, w, 0.08, d, cx, cy + 0.04, cz, 0, 1.4);
      this.box(sideKey,
        axis === 'x' ? 0.05 : width, stepRise, axis === 'x' ? width : 0.05,
        axis === 'x' ? cx - stepRun / 2 : cx, cy - stepRise / 2 + 0.04,
        axis === 'z' ? cz - stepRun / 2 : cz, 0, 1);
    }
    const len = Math.hypot(run, rise);
    const pitch = Math.atan2(rise, Math.abs(run));
    /* Local +Z of the proxy must point up the slope. `GeoBatch.localAt` sends
     * local +Z to `(sin yaw, cos yaw)` and local +X to `(cos yaw, -sin yaw)`,
     * and a three.js Y rotation by `a` sends +Z to `(sin a, cos a)`. So a
     * flight climbing the frame's +X is a proxy yawed to `yaw + PI/2`, and one
     * climbing -X to `yaw - PI/2`. */
    const a = this.yaw + (axis === 'z'
      ? (run > 0 ? 0 : Math.PI)
      : (run > 0 ? Math.PI / 2 : -Math.PI / 2));
    const mid = this.P(
      axis === 'x' ? lx0 + run / 2 : lx0,
      ly0 + rise / 2 - 0.25 / Math.cos(pitch),
      axis === 'z' ? lz0 + run / 2 : lz0
    );
    const proxy = new THREE.Mesh(new THREE.BoxGeometry(width, 0.5, len));
    proxy.visible = false;
    /* NAMED and FLAGGED, not merely invisible: `visible` belongs to the
     * renderer, and the boot shader rehearsal clears it across a whole world
     * group for three frames, so anything identifying a proxy by
     * `visible === false` finds none at all inside that window. */
    markRampProxy(proxy);
    proxy.position.copy(mid);
    proxy.rotation.set(0, a, 0, 'YXZ');
    proxy.rotateX(-pitch);
    proxy.updateWorldMatrix(true, false);
    this.group.add(proxy);
    const c = this.track(this.physics.addBoxFromObject(proxy));
    this.colliders.push(c);
    this.proxies.push(proxy);
    /* The flight, plus a stride at each end and 2.0 m of headroom over every
     * tread. `station/Tower.js:425` is a rider stopped two thirds of the way up
     * a flight by a soffit that existed only as a decoration; this is the same
     * defect written down so it cannot be authored a second time. */
    const zLo = Math.min(lz0, axis === 'z' ? lz0 + run : lz0) - (axis === 'z' ? APPROACH : width / 2 + 0.2);
    const zHi = Math.max(lz0, axis === 'z' ? lz0 + run : lz0) + (axis === 'z' ? APPROACH : width / 2 + 0.2);
    const xLo = Math.min(lx0, axis === 'x' ? lx0 + run : lx0) - (axis === 'x' ? APPROACH : width / 2 + 0.2);
    const xHi = Math.max(lx0, axis === 'x' ? lx0 + run : lx0) + (axis === 'x' ? APPROACH : width / 2 + 0.2);
    /* From the FOOT, not below it. A flight on an upper deck reserving 0.3 m
     * under its own first tread is a flight reserving the ceiling of the room
     * beneath — which on the Dray is the cockpit deckhead, 0.14 m under the
     * foredeck companionway. */
    this.way(xLo, xHi, ly0 - 0.05, ly0 + rise + 2.0, zLo, zHi);
    return { proxy, pitch, len };
  }

  /**
   * Guard rail down one edge of an exterior walkway, in the ship's frame.
   *
   * `CitadelWorld.js:1495`: "a detail the player can see and not grab would be
   * a lie." So the rail is collided, which also means it is a climb face on the
   * way past and a thing that stops a body walking off a spine seven metres up.
   */
  rail(key, accentKey, axis, a0, a1, fixed, y, h = 1.05) {
    const len = a1 - a0, c = (a0 + a1) / 2;
    const along = (w, hh, d, cy, offA) => {
      if (axis === 'z') this.box(key, w, hh, d, fixed, cy, c + (offA ?? 0), 0, 1);
      else this.box(key, d, hh, w, c + (offA ?? 0), cy, fixed, 0, 1);
    };
    along(0.09, 0.09, len, y + h);
    if (axis === 'z') this.box(accentKey, 0.05, 0.05, len, fixed, y + h + 0.075, c, 0, 1);
    else this.box(accentKey, len, 0.05, 0.05, c, y + h + 0.075, fixed, 0, 1);
    along(0.08, 0.08, len, y + h * 0.5);
    const n = Math.max(2, Math.round(len / 2.0));
    for (let i = 0; i <= n; i++) {
      const at = a0 + (len * i) / n;
      if (axis === 'z') this.box(key, 0.09, h, 0.09, fixed, y + h / 2, at, 0, 1);
      else this.box(key, 0.09, h, 0.09, at, y + h / 2, fixed, 0, 1);
    }
    if (axis === 'z') this.solid(fixed, y + h / 2, c, 0.08, h / 2, len / 2);
    else this.solid(c, y + h / 2, fixed, len / 2, h / 2, 0.08);
  }

  /* ---------------------------------------------------------------- */
  /* Doors                                                             */
  /* ---------------------------------------------------------------- */

  /**
   * A BI-PARTING SLIDING HATCH `Interiors` can drive, in the ship's frame.
   *
   * ── It used to swing, and it swung into its own doorway ──────────────────
   * The player's words: "if i open a door a door swings open but the entrance
   * still has the ships side covering it. the doors should slide open on a
   * spaceship with a swoosh sound." Both halves were real, and the first one
   * was worse than it sounded. The hinged version put the pivot at
   * `P(lx, ly, lz - hw)` and the leaf at local `+X` of a pivot yawed `PI/2` —
   * and a three.js Y rotation sends `+X` to `(cos a, 0, -sin a)`, so the leaf's
   * CLOSED centre landed at `lz - w`: one full width aft of the hole it was
   * meant to cover. On the Kestrel that is z -2.60 against an opening spanning
   * -2.05..-0.95. Shut, the doorway had a slab bolted up beside it and nothing
   * in it; opened, the leaf swung `0.68 PI` and came to rest at 39 degrees off
   * the flank at local (2.62, -1.70) — diagonally ACROSS the entrance. Measured
   * with a 9 x 9 ray fan fired inboard from 1.6 m outside: 81 of 81 samples
   * stopped, 27 of them on the leaf itself.
   *
   * So this is a slider, and `Interiors` grew the one verb it needed: a leaf
   * carrying `slide` (a world-space travel vector) and `closedPos` is
   * translated instead of rotated. Two leaves parting from the centre, because
   * on a spaceship that is the shape the movement has, and because two 0.55 m
   * leaves clear a 1.1 m hole in half the travel one leaf needs.
   *
   * ── The leaves run OUTBOARD of the plating, on visible rails ─────────────
   * A pocket door needs somewhere to pocket, and there is nowhere: the flank
   * skin is `SKIN` = 0.22 m thick and the compartment lining sits directly
   * behind it — on the Kestrel the plating's inner face is at local x 2.08 and
   * the lining's outer face is at 2.08 as well. A leaf hidden inside that wall
   * would be a leaf inside the lining. So the assembly is a blast shutter: two
   * leaves in a plane `faceOff` proud of the door line, running on a head rail
   * and a sill between two end posts, with the whole pocket span declared as an
   * {@link aperture} so no later dressing pass puts a vent under the door.
   *
   * ── `position` is where the FEET are, not where the hull origin is ───────
   * `Interiors.js:374` only offers a door when `|player.y - door.position.y|
   * <= 2.6` and the horizontal distance is under 3.0. The medieval winding
   * house published its door at the sill, 2.03 m over the street, and its
   * prompt therefore never appeared at all: built, glazed, furnished, silently
   * unenterable. So `standY` is a REQUIRED argument and it is the LOCAL height
   * of the surface a player stands on to use this hatch — on the ramp head, not
   * at the hull origin.
   *
   * @param {string} id unique across the world
   * @param {object} o
   * @param {'x'|'z'} o.plane which local axis the door's NORMAL runs along
   * @param {number} [o.faceOff] how far proud of `l*` the leaves run, along
   *   that normal. Flank doors pass the plating's own half-thickness plus a
   *   clearance so the leaves ride outside the skin rather than inside it.
   * @param {1|-1} [o.faceSign] which way `faceOff` points; defaults to the
   *   flank the door is on for `plane: 'x'`, and `+1` otherwise.
   */
  hatch(id, o) {
    const { lx, ly, lz, w, h, plane, standY, mat } = o;
    const g = new THREE.Group();
    g.name = `ship:${id}`;
    this.group.add(g);
    const hw = w / 2;
    const alongX = plane === 'z';          // the opening runs along local X
    /** Centre of the opening on its own axis, and the flank it is cut in. */
    const c = alongX ? lx : lz;
    const side = alongX ? 0 : Math.sign(lx) || 1;
    const faceSign = o.faceSign ?? (alongX ? 1 : side);
    const faceOff = o.faceOff ?? 0.14;
    const nx = alongX ? 0 : faceSign * faceOff;
    const nz = alongX ? faceSign * faceOff : 0;
    const T = 0.09;                        // leaf thickness
    /** Each leaf overlaps the centreline by 20 mm so the shut pair has no slot. */
    const leafLen = hw + 0.02;
    /** Travel clears the whole opening, plus 60 mm so the jamb is not grazed. */
    const travel = hw + 0.06;

    /* ── The two leaves ─────────────────────────────────────────────────
     * Loose meshes rather than batch geometry, because they move; everything
     * else in this assembly is static and goes in the batch, where it costs no
     * draw call at all. */
    const leaves = [];
    for (const s of [-1, 1]) {
      const pivot = new THREE.Group();
      const uClosed = c + s * (leafLen / 2 - 0.02);
      const closedPos = alongX
        ? this.P(uClosed + nx, ly, lz + nz)
        : this.P(lx + nx, ly, uClosed + nz);
      const openPos = alongX
        ? this.P(uClosed + s * travel + nx, ly, lz + nz)
        : this.P(lx + nx, ly, uClosed + s * travel + nz);
      pivot.position.copy(closedPos);
      pivot.rotation.y = this.yaw;
      /* ONE MESH PER LEAF, and the three parts merged into it rather than
       * parented to it.
       *
       * A leaf moves, so it cannot go into the hull's `GeoBatch` — but a loose
       * mesh is a draw call, and `DockWorld`'s budget is 220 for the whole
       * frame with the portals, NPCs and HUD still to pay for. Four doors x two
       * leaves x three parts is twenty-four draws for the door furniture alone;
       * merged it is eight, and the slab, the shoulder and the grab rib all use
       * the same two materials anyway. The trim parts are merged into the leaf
       * material because a second material would put the count straight back. */
      const slab = alongX ? boxGeo(leafLen, h, T, 2) : boxGeo(T, h, leafLen, 2);
      /* The raked meeting shoulder and the grab rib: the two details that stop
       * a sliding door reading as a rectangle sliding sideways. */
      const nose = alongX ? boxGeo(0.34, h * 0.34, T + 0.05, 1) : boxGeo(T + 0.05, h * 0.34, 0.34, 1);
      nose.translate(alongX ? -s * (leafLen / 2 - 0.17) : 0, h * 0.10,
        alongX ? 0 : -s * (leafLen / 2 - 0.17));
      const rib = alongX ? boxGeo(0.09, h - 0.30, T + 0.06, 1) : boxGeo(T + 0.06, h - 0.30, 0.09, 1);
      rib.translate(alongX ? s * (leafLen * 0.22) : 0, 0, alongX ? 0 : s * (leafLen * 0.22));
      const leaf = new THREE.Mesh(mergeGeometries([slab, nose, rib], false), mat);
      /* One name per LEAF, not per hatch. A hatch has two, and both used to
       * carry `hatchleaf:${id}` - so the map editor's catalogue offered a
       * single row for two nodes, its de-duplication kept the shallowest, and
       * the applier's depth-first `getObjectByName` resolved to whichever it
       * reached first. Moving that row moved one leaf and left the other where
       * it was, reporting ok: true. `s` is -1 then +1 across the pair, which
       * makes `a` the leaf toward -X/-Z and `b` its opposite. */
      leaf.name = `hatchleaf:${id}:${s < 0 ? 'a' : 'b'}`;
      leaf.castShadow = leaf.receiveShadow = true;
      pivot.add(leaf);
      g.add(pivot);
      leaves.push({
        pivot,
        /* `closed`/`open` are still published, and still equal, so anything
         * that lerps a rotation between them is a no-op rather than a hull
         * with a door spinning in it. `slide` is what `Interiors` reads. */
        closed: pivot.rotation.y,
        open: pivot.rotation.y,
        closedPos: closedPos.clone(),
        slide: openPos.clone().sub(closedPos),
      });
    }

    /* ── The static frame ───────────────────────────────────────────────
     * Head rail, sill and two end posts spanning the whole pocket, plus a
     * recessed back plate the leaves run in front of. Drawn only: the sill
     * stands 0.03 m over the threshold, which is what a ship's door has and is
     * far under `stepHeight`; the head rail is over a 2 m opening. The
     * COLLIDER is the one thin box below, and `Interiors` clears it. */
    const frameKey = o.frameKey ?? 'trim';
    const backKey = o.backKey ?? 'dark';
    const pocket = slidePocket(w) - 0.10;         // half-span of the assembly
    const put = (key, along, hh, thick, u, y, off) => {
      if (alongX) this.box(key, along, hh, thick, u, y, lz + off, 0, 1);
      else this.box(key, thick, hh, along, lx + off, y, u, 0, 1);
    };
    const backOff = faceSign * (faceOff - T / 2 - 0.055);
    const railOff = faceSign * (faceOff + T / 2 + 0.035);
    // The back plate, only across the POCKETS: over the opening itself it
    // would be exactly the sheet of steel the player complained about.
    for (const s of [-1, 1]) {
      const a = hw + 0.01, bnd = pocket;
      put(backKey, bnd - a, h + 0.12, 0.06, c + s * (a + bnd) / 2, ly, backOff);
    }
    put(frameKey, pocket * 2, 0.16, 0.20, c, ly + h / 2 + 0.08, railOff * 0.55);   // head rail
    put(frameKey, pocket * 2, 0.08, 0.18, c, ly - h / 2 + 0.03, railOff * 0.55);   // sill
    for (const s of [-1, 1]) {
      put(frameKey, 0.16, h + 0.30, 0.16, c + s * pocket, ly, railOff * 0.55);     // end post
    }
    // A status strip over the head rail: the one lit thing on the assembly, and
    // the reason a dark flank reads as having a door in it at thirty metres.
    put(o.glowKey ?? 'glow', pocket * 1.5, 0.07, 0.10, c, ly + h / 2 + 0.20, railOff * 0.6);

    /* Nothing else may be built on this run of flank. See {@link apertures}.
     * The band stops 0.08 m under the sill and 0.30 m over the head rail, which
     * leaves the deck-edge and bilge knuckle strakes to run straight past — a
     * hull whose outline breaks at every doorway would be a worse picture than
     * the one this is fixing. */
    this.aperture(side, alongX ? 'x' : 'z',
      c - slidePocket(w), c + slidePocket(w),
      ly - h / 2 - 0.08, ly + h / 2 + 0.30);

    const collider = this.solid(
      lx, ly, lz,
      alongX ? hw : 0.06, h / 2, alongX ? 0.06 : hw,
      0, { solid: true }
    );
    const rec = {
      id,
      leaves,
      collider,
      /** FOOT height at the threshold. See the winding-house note above. */
      position: this.P(lx, standY, lz),
      /** What `AudioDirector` plays when this door is worked. */
      sound: o.sound ?? 'slide',
      /** How big the mechanism is, against the 1.1 m hatch this was pitched at. */
      size: w / 1.1,
      open: false,
      anim: 0,
    };
    this.doors.push(rec);
    /* The opening, its pockets and a stride in front of it. The pockets are
     * reserved as well as the hole: on a transverse door they are INSIDE the
     * compartment, and a locker built against the jamb is a leaf that slides
     * into a locker. */
    if (alongX) this.way(c - pocket, c + pocket, ly - h / 2, ly + h / 2, lz - APPROACH, lz + APPROACH);
    else this.way(lx - APPROACH, lx + APPROACH, ly - h / 2, ly + h / 2, c - pocket, c + pocket);
    return rec;
  }

  /**
   * A vertical service lift `Interiors` can drive, in the ship's frame.
   *
   * ── Why a lift and not a ladder ──────────────────────────────────────────
   * `Interiors` has exactly two verbs, and a ladder is neither of them. A
   * ladder-shaped hole between two decks is therefore a one-way drop: the
   * player gets down and cannot get back, which is the soft lock this whole
   * drop exists to avoid. `Physics.setBoxColliderY` is Y-only and safe
   * precisely because the broadphase is XZ-indexed, which is what makes a
   * vertical lift legal where a moving walkway is not.
   *
   * The collider is a rotated box and `setBoxColliderY` writes `elements[13]`,
   * which is the translation regardless of the rotation baked into the upper
   * 3x3 — so a lift inside a yawed hull rides correctly.
   *
   * `callPos` is published because `Interiors.update` derives an axis-aligned
   * one otherwise, which lands inside a bulkhead on any hull that is not
   * pointing down the world Z axis.
   */
  lift(id, o) {
    const { lx, lz, half, mat, railMat } = o;
    const plateThick = 0.16;
    /* WORLD Y, not local. `Interiors._onWorld` writes `l.pos` straight into
     * `setBoxColliderY(l.collider, l.pos - l.plateThick / 2)` and
     * `car.position.y`, both of which are world-space — so a record carrying a
     * hull-local stop puts the car and its collider on the shed floor and the
     * ride goes DOWN through the belly. Everything else on a `ShipBuild` is
     * local; this one field is not, and it is converted here rather than at
     * eleven call sites. */
    const stops = o.stops.map((s) => this.oy + s);
    const stop0 = stops[0];
    const collider = this.solid(lx, stop0 - this.oy - plateThick / 2, lz, half - 0.04, plateThick / 2, half - 0.04);
    const car = new THREE.Group();
    car.name = `ship:${id}`;
    const plate = new THREE.Mesh(boxGeo((half - 0.04) * 2, plateThick, (half - 0.04) * 2, 1.4), mat);
    plate.position.y = -plateThick / 2;
    plate.castShadow = plate.receiveShadow = true;
    car.add(plate);
    // A hoop over the plate, so the car reads as a cage rather than a floating
    // slab. Drawn only — a collider on it would be a lip the rider trips over.
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(boxGeo(0.07, 1.05, 0.07, 1), railMat ?? mat);
      post.position.set(s * (half - 0.12), 0.52, -(half - 0.12));
      car.add(post);
    }
    const bar = new THREE.Mesh(boxGeo((half - 0.12) * 2, 0.07, 0.07, 1), railMat ?? mat);
    bar.position.set(0, 1.05, -(half - 0.12));
    car.add(bar);
    const at = this.P(lx, stop0 - this.oy, lz);
    car.position.copy(at);
    car.rotation.y = this.yaw;
    car.updateMatrixWorld(true);
    this.group.add(car);

    /* `Interiors` writes `car.position.y` directly, so the car has to be
     * parented somewhere whose own Y is zero — `world.group` is, and this is
     * why the car is added there rather than to the ship's LOD group. */
    const rec = {
      id,
      collider,
      car,
      plateThick,
      stops: stops.slice(),
      stopIndex: 0,
      target: 0,
      pos: stop0,
      speed: 2.2,
      callPos: this.P(lx, stop0 - this.oy, lz - half - 0.6),
      footprint: { cx: at.x, cz: at.z, half },
    };
    this.lifts.push(rec);
    /* THE WHOLE SHAFT, from the lowest stop to the highest, and a landing on
     * the call side. A lift is the one fitting in this yard that moves, so
     * anything standing in its column is something the car drives through. */
    const lo = Math.min(...o.stops), hi = Math.max(...o.stops);
    this.way(lx - half - 0.1, lx + half + 0.1, lo - 0.3, hi + 1.2,
      lz - half - APPROACH, lz + half + 0.1);
    return rec;
  }

  /**
   * A collectible spot, authored in the ship's frame.
   *
   * `Interiors` streams these at 46 m in / 64 m out with `snap: false`, so the
   * authored Y is kept exactly and a spot on a cockpit seat five metres up is
   * legal. What is NOT legal is two enterables sharing a `label`: the collected
   * tag is `interior:dock:${label}#${i}`, so two hulls both called 'ship' share
   * tags and one of them silently loses its loot.
   */
  spot(lx, ly, lz, tier) {
    this.spots.push({ position: this.P(lx, ly, lz), tier });
    /* `Interiors` picks a collectible up within `PICKUP_R` and draws it where
     * the hull authored it. A fitting built over one is loot inside a locker:
     * still collected, never seen, and `dock-reach` would go on passing because
     * the spot is still reachable. */
    this.way(lx - COLLECTIBLE_CLEAR, lx + COLLECTIBLE_CLEAR, ly - COLLECTIBLE_CLEAR, ly + COLLECTIBLE_CLEAR, lz - COLLECTIBLE_CLEAR, lz + COLLECTIBLE_CLEAR);
  }
}

/**
 * Per-hull material clones, and which of them each livery slot writes to.
 *
 * ── Why clones ───────────────────────────────────────────────────────────
 * `Car.js:859-861` records it: bind slots to CLONED materials only, because the
 * shared singletons feed the AI race grid — paint one car and the whole field
 * changes colour. Here the shared singletons are the yard's own plating and
 * steel, so a livery written to them would repaint the shed.
 *
 * Clones share their parent's MAPS, so this costs no texture memory, and with
 * identical defines it costs no new shader program either — which matters,
 * because `renderer.info.programs.length` is a budget in this repo (42 point
 * lights measured 59.8 s of compile against 12's 19.4 s on the same 207
 * programs).
 *
 * ── `clone()` does NOT carry the shader hook, and this cost four hulls ────
 * The comment here used to claim that `onBeforeCompile` and
 * `customProgramCacheKey` survive `clone()` by reference. They do not:
 * `Material.copy` in three r185 copies neither, so a clone reverts to the
 * prototype's empty hook and to the default cache key. Measured on the built
 * world: every yard emissive carried `key = 'yard-emfade'` and every hull glow
 * carried the default — so the four hulls' running lights rendered at full
 * intensity at every distance while the yard's own strips around them faded to
 * 0.30 by 140 m. From the apron the Bastion is ~115 m off, where the yard
 * renders at 0.414x and the hull rendered at 1.0x: a 2.4x mismatch, and
 * inconsistent WITHIN one hull, because the amber `warn` strips are shared by
 * reference and kept the fade while the cyan `glow` clone lost it. The fade
 * exists because a sub-pixel emitter at full intensity is an aliasing source,
 * so what this looked like was the four brightest, crawliest things in the far
 * half of every long frame. Copying the two properties across restores both
 * the grade and the shared program.
 *
 * ── The ORM multiplier, stated once ──────────────────────────────────────
 * These materials carry a `roughnessMap` and a SCALAR roughness that MULTIPLIES
 * over it (`M.plate` ships 0.50). So `FINISH_PROPS.matt`'s `roughness: 1.0` is
 * the identity multiplier — matt can never come out glossier than the bake —
 * and clearing a finish restores the RECORDED 0.50 through `Livery.factoryOf`,
 * not a guessed number. And `slot.defaultColor` below is the clone's real
 * factory `.color`, not a swatch chosen to look right: writing a swatch that is
 * not the factory value multiplies the albedo map by itself and the part
 * visibly darkens, which is the "put it back" button making it worse
 * (`MountMenu.js:189`).
 *
 * @param {Record<string, THREE.Material>} M the yard's material table
 * @param {{hull:number, trim:number, glass:number, glow:number, accent:number}} tint
 */
export function shipMaterials(M, tint) {
  const hull = M.plate.clone();
  hull.color = new THREE.Color(tint.hull);
  const trim = M.steel.clone();
  trim.color = new THREE.Color(tint.trim);
  const accent = M.steel.clone();
  accent.color = new THREE.Color(tint.accent);
  const glass = M.glass.clone();
  glass.color = new THREE.Color(tint.glass);
  const glow = M.emCyan.clone();
  glow.emissive = new THREE.Color(tint.glow);
  glow.color = new THREE.Color(0x05070a);
  // See above: neither of these survives `clone()`, and without them the hull
  // is the one thing in the frame that does not grade with distance.
  glow.onBeforeCompile = M.emCyan.onBeforeCompile;
  glow.customProgramCacheKey = M.emCyan.customProgramCacheKey;

  const mats = {
    hull, trim, accent, glass, glow,
    dark: M.steelDark,
    deckg: M.grate,
    hazard: M.hazard,
    crate: M.crate,
    tarp: M.tarp,
    warn: M.emAmber,
    lamp: M.emSodium,
    danger: M.emRed,
    signs: M.signs,
  };
  /** Only these are this hull's own; everything else belongs to the yard. */
  const owned = [hull, trim, accent, glass, glow];
  /** `Livery.applyLivery`'s third argument. */
  const slotMats = {
    hull: [hull],
    trim: [trim],
    canopy: [glass],
    thruster: [{ mat: glow, emissive: true }],
    accent: [accent],
  };
  return { mats, owned, slotMats };
}

/* ══════════════════════════════════════════════════════════════════════════ */
/*  THE FIT-OUT                                                               */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * WHAT A COMPARTMENT IS FOR, SAID WITHOUT A LABEL.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THIS IS A SEPARATE PASS AND NOT MORE LINES IN `Hulls.js`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A hull builder's job is the shell: plating, decks, openings, the climb bands.
 * It ends up dressing the rooms too, because they are right there — and what it
 * writes is one box per idea. A seat is a box. A console is a box with a glowing
 * strip. A bunk is a box with a second box on it. From outside that is invisible;
 * inside it is the whole content of the room, and the verdict on it was "a box
 * with a ceiling height".
 *
 * So the fit-out runs AFTER the hull, over the room envelope the hull published,
 * and it is driven entirely by that envelope — `{ id, hw, z0, z1, floorY, ceilY }`
 * and nothing else. Move a bulkhead and the fittings move with it. Re-proportion
 * a compartment and the bays re-space. Nothing in this section reads a hull
 * constant, which is what lets the exteriors be reshaped underneath it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE TWO RULES THAT DECIDE WHERE EVERY PIECE GOES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * **1. Nothing is built in a doorway.** `MedievalWorld` shipped a building whose
 * own ore benches stood across its own entrance: from the street the door was a
 * door, and the room behind it could not be entered. Nothing caught it because
 * no test knew what a doorway was. Now every opening `ShipBuild` cuts — `wallX`,
 * `wallZ`, `hatch`, `flight`, `lift` — publishes the volume that has to stay
 * empty at the moment it is cut, and {@link ShipBuild#fits} refuses any fitting
 * that lands in one. The keep-out is the body's own geometry: `P.radius 0.35`
 * gives 1.1 m of approach and 0.35 m past each jamb, and a hatch leaf swinging
 * `0.68 PI` about its port jamb sweeps a quarter disc of radius `w`.
 *
 * **2. Nothing is built through what is already there.** Every part drawn into
 * the interior batch records its local AABB, so this pass fits around the hull's
 * own dressing instead of z-fighting with it. Where the hull already put a mass
 * — a seat pan, a bunk board, a powerplant block — {@link ShipBuild#partIn}
 * finds it and this pass DRESSES it: a headrest on the back that is there,
 * harness webbing across it, armrests beside the pan, bedding on the bunk,
 * gauges and pipework on the block. The detail follows the mass, so a hull that
 * moves its furniture takes the trim with it rather than leaving it in the air.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHICH FITTINGS ARE SOLID, AND WHY THAT IS A MEASUREMENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Hulls.js` rule 4 says nothing is drawn that the player can touch and not
 * collide. Its own interior dressing does not obey it — every `ibox` in that
 * file is drawn only — and there is a real reason a fit-out cannot simply
 * collide everything:
 *
 * `dock-hulls.test.mjs`'s "no hull hides a room nothing can walk to" samples
 * every hull's volume on a 1 m lattice and demands that every STANDABLE surface
 * it finds is either a declared compartment floor (within 0.40 m of `floorY`) or
 * on the round trip. A surface is standable when it carries `HEADROOM = 1.9` m
 * of clear air over it. So a collided fitting whose top lands between
 * `floorY + 0.40` and `ceilY - 1.9` invents a standable surface in mid-room that
 * a 0.45 m step cannot reach: an orphan, and a correct test failure.
 *
 * Two of the eight compartments have any such band at all — the Dray's hold
 * (3.40 m clear, band 0.40-1.50) and its engine room (2.60 m, band 0.40-0.70).
 * The other six are 1.90-2.10 m clear, where `ceilY - 1.9` is at or below
 * `floorY + 0.20` and the band is empty: everything in them may be solid.
 * {@link solidHere} is that rule, evaluated per fitting against its own room,
 * and compound units are collided as ONE envelope box rather than per part —
 * which is this file's existing doctrine anyway: draw whatever swept form you
 * like, collide a stack of yawed boxes.
 */

/**
 * `dock-reach.test.mjs`'s standing headroom, and therefore the clear height over
 * which a surface counts as somewhere a body can stand.
 */
const WALK_HEADROOM = 1.9;
/** `dock-hulls.test.mjs`'s tolerance for "this surface IS the compartment floor". */
const FLOOR_BAND = 0.40;

/**
 * May a fitting whose top face is at `topY` carry a collider in this room?
 *
 * See the header. Either it is close enough to the deck to BE the deck, or it
 * has too little air over it to be stood on.
 */
function solidHere(room, topY) {
  return (topY - room.floorY) < FLOOR_BAND || (room.ceilY - topY) < WALK_HEADROOM;
}

/**
 * A deterministic 32-bit generator, so "scattered clutter" is the same scatter
 * every build.
 *
 * A fit-out seeded from `Math.random` is a room that is subtly different in
 * every screenshot, which makes every before/after comparison in this project
 * unreadable. Same generator as `YardTextures`; local because that one is not
 * exported.
 */
function rng32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A local AABB from a centre and full sizes. */
function bx(x, y, z, w, h, d) {
  return { x0: x - w / 2, x1: x + w / 2, y0: y - h / 2, y1: y + h / 2, z0: z - d / 2, z1: z + d / 2 };
}

/**
 * Build at the first candidate footprint that is clear.
 *
 * The footprint is claimed BEFORE `make` runs, so a later fitting sees the whole
 * unit rather than only the parts that happen to be drawn — a console's leg room
 * is as reserved as its casing.
 *
 * @returns {boolean} whether anything was built
 */
function place(b, cands, make, except = null) {
  for (const f of cands) {
    if (!b.fits(f, except)) continue;
    /* CHOSEN, and flagged as such. A footprint this pass picked is one it is
     * answerable for; trim bolted to a mass the hull put somewhere is not, and
     * `dock-interiors.test.mjs` has to tell the two apart to say which. */
    f.chosen = true;
    b.iparts.push(f);
    b.fitStats.placed++;
    make(f);
    return true;
  }
  b.fitStats.refused++;
  return false;
}

/**
 * Build something bolted to a mass the hull already put here.
 *
 * The mass and everything resting on it are what this fitting is allowed to
 * touch; anything else in the room is still an obstruction. Returns the stack's
 * top so bedding, cushions and covers go on the mattress rather than under it.
 */
function dress(b, part, cands, make) {
  const st = b.stack(part);
  for (const f of cands) {
    if (!b.fits(f, st.parts)) continue;
    f.bolted = true;
    b.iparts.push(f);
    b.fitStats.placed++;
    make(f, st.top);
    return true;
  }
  b.fitStats.refused++;
  return false;
}

/**
 * Divide a run into bays and build in every one that is clear.
 *
 * This is what makes a wrap-around console wrap AROUND something. The Kestrel's
 * cockpit already carries a nav station in its port forward corner; sweeping the
 * forward face in bays puts instrument panel in the ones that are free and
 * nothing in the ones that are not, instead of one full-width slab that either
 * fails to place or is buried in the nav station.
 *
 * @param {(c:number, w:number)=>object} foot footprint for the bay centred at `c`
 * @param {(c:number, w:number, i:number)=>void} make
 */
function bays(b, a0, a1, pitch, foot, make) {
  const span = a1 - a0;
  if (span < pitch * 0.5) return { built: 0, refused: 0 };
  const n = Math.max(1, Math.round(span / pitch));
  const step = span / n;
  let built = 0, refused = 0;
  for (let i = 0; i < n; i++) {
    const c = a0 + step * (i + 0.5);
    const f = foot(c, step);
    if (!b.fits(f)) { refused++; b.fitStats.refused++; continue; }
    f.chosen = true;
    b.iparts.push(f);
    b.fitStats.placed++;
    make(c, step, i);
    built++;
  }
  return { built, refused };
}

/* ------------------------------------------------------------------ */
/* Sub-assemblies                                                      */
/* ------------------------------------------------------------------ */

/**
 * A round instrument on a panel face at `z`, reading aft.
 *
 * `CylinderGeometry`'s axis is +Y, so `rx = PI/2` lays it along Z — the same
 * trick `bolts` uses with `rz` to lay a bolt head along X.
 */
function dial(b, x, y, z, r, lit = 'glow') {
  const A = Math.PI / 2;
  b.iput('dark', new THREE.CylinderGeometry(r, r, 0.045, 12), x, y, z + 0.022, 0, A);
  b.iput(lit, new THREE.CylinderGeometry(r * 0.72, r * 0.72, 0.02, 12), x, y, z - 0.012, 0, A);
  // A needle, parked somewhere plausible rather than at zero on every dial.
  b.ibox('dark', r * 1.3, 0.014, 0.012, x, y, z - 0.024, 0, 1);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    b.ibox('dark', 0.016, 0.016, 0.014,
      x + Math.cos(a) * r * 0.85, y + Math.sin(a) * r * 0.85, z - 0.02, 0, 1);
  }
}

/** A grid of annunciator lamps: the panel's one genuinely bright thing. */
function annunciator(b, x, y, z, w, h, cols, rows) {
  /* THREE keys, not four. Each one is a whole extra merged mesh in a hull's
   * interior batch, and the yard is measured at 141 meshes against a ceiling of
   * 140 — so the sodium the shed's own worklights use stays outdoors, where it
   * is the colour script, and a cockpit reads amber / cyan / red. */
  const LIT = ['warn', 'glow', 'danger'];
  b.ibox('dark', w + 0.03, h + 0.03, 0.03, x, y, z + 0.015, 0, 1);
  const cw = w / cols, ch = h / rows;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      /* A fixed pattern, not a random one: a caption board reads as a caption
       * board because it is the same one in every screenshot. */
      const k = LIT[(i * 3 + j * 2) % LIT.length];
      b.ibox(k, cw * 0.72, ch * 0.6, 0.02,
        x - w / 2 + cw * (i + 0.5), y - h / 2 + ch * (j + 0.5), z - 0.012, 0, 1);
    }
  }
}

/**
 * A lit display: four rows of unequal length, not one solid rectangle.
 *
 * Measured off the screenshots rather than reasoned: a 0.24 x 0.20 m block of
 * flat emissive at this material's `emissiveIntensity` is a bloom source with no
 * internal structure, and a bank of them reads as coloured tape. Four rows at
 * 88 / 54 / 72 / 34 percent of the width read as a readout at two metres and
 * cost three extra boxes.
 *
 * @param {'z'|'x'} plane which way the face points — aft, or inboard off a flank
 */
function screen(b, x, y, z, w, h, key, plane = 'z', s = 1) {
  const ROWS = [0.88, 0.54, 0.72, 0.34];
  const rh = (h / ROWS.length) * 0.56;
  for (let i = 0; i < ROWS.length; i++) {
    const ry = y + h / 2 - (h / ROWS.length) * (i + 0.5);
    const len = w * ROWS[i];
    const off = (w - len) / 2 - (w - len) / 2;
    if (plane === 'z') b.ibox(key, len, rh, 0.014, x + off, ry, z, 0, 1);
    else b.ibox(key, 0.014, rh, len, x, ry, z + off, 0, 1);
  }
  // The bezel behind them, so the rows sit in something.
  if (plane === 'z') b.ibox('dark', w + 0.02, h + 0.02, 0.02, x, y, z + s * 0.012, 0, 1);
  else b.ibox('dark', 0.02, h + 0.02, w + 0.02, x + s * 0.012, y, z, 0, 1);
}

/** A row of toggles with guards along the bottom of a panel. */
function switches(b, x, y, z, w, n) {
  b.ibox('dark', w, 0.10, 0.03, x, y, z + 0.015, 0, 1);
  for (let i = 0; i < n; i++) {
    const sx = x - w / 2 + (w / n) * (i + 0.5);
    b.ibox('trim', 0.022, 0.05, 0.03, sx, y, z - 0.02, 0, 1);
    b.ibox('trim', 0.05, 0.012, 0.04, sx, y + 0.035, z - 0.024, 0, 1);
  }
}

/** A keypad: twelve keys and a lit readout over them. */
function keypad(b, x, y, z, w, h) {
  b.ibox('dark', w, h, 0.03, x, y, z + 0.015, 0, 1);
  b.ibox('glow', w * 0.86, h * 0.22, 0.02, x, y + h * 0.34, z - 0.012, 0, 1);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 3; j++) {
      b.ibox('trim', w * 0.19, h * 0.13, 0.024,
        x - w * 0.3 + w * 0.2 * i, y + h * 0.12 - h * 0.2 * j, z - 0.014, 0, 1);
    }
  }
}

/** A run of pipe with a flange at each end. `axis` is the run's direction. */
function pipeRun(b, axis, a0, a1, u, v, r, key = 'trim') {
  const len = Math.abs(a1 - a0);
  if (len < 0.1) return;
  const mid = (a0 + a1) / 2;
  const A = Math.PI / 2;
  const at = axis === 'z' ? [u, v, mid] : axis === 'x' ? [mid, u, v] : [u, mid, v];
  const rx = axis === 'z' ? A : 0;
  const rz = axis === 'x' ? A : 0;
  b.iput(key, new THREE.CylinderGeometry(r, r, len, 8), at[0], at[1], at[2], 0, rx, rz);
  for (const s of [-1, 1]) {
    const e = mid + s * (len / 2 - 0.05);
    const p = axis === 'z' ? [u, v, e] : axis === 'x' ? [e, u, v] : [u, e, v];
    b.iput('dark', new THREE.CylinderGeometry(r * 1.7, r * 1.7, 0.07, 8), p[0], p[1], p[2], 0, rx, rz);
  }
}

/** A hand valve: a flanged body and a spoked wheel over it. */
function valve(b, x, y, z, r) {
  b.iput('dark', new THREE.CylinderGeometry(r * 0.8, r * 0.8, r * 1.1, 8), x, y, z);
  for (let i = 0; i < 3; i++) {
    b.ibox('accent', r * 1.9, 0.026, 0.026, x, y + r * 0.8, z, (i * Math.PI) / 3, 1);
  }
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    b.ibox('accent', 0.05, 0.026, 0.05, x + Math.cos(a) * r * 0.94, y + r * 0.8, z + Math.sin(a) * r * 0.94, -a, 1);
  }
}

/** A lit warning plate: a dark frame round a coloured face. */
function placard(b, x, y, z, w, h, key = 'warn', ry = 0) {
  b.ibox('dark', w + 0.04, h + 0.04, 0.02, x, y, z, ry, 1);
  b.ibox(key, w, h, 0.012, x - Math.sin(ry) * 0.016, y, z - Math.cos(ry) * 0.016, ry, 1);
}

/** A grab handle standing off a face, running along the axis given. */
function grab(b, axis, x, y, z, len, proud = 0.09) {
  const t = 0.035;
  if (axis === 'z') {
    b.ibox('accent', t, t, len, x, y, z, 0, 1);
    for (const s of [-1, 1]) b.ibox('trim', proud, t, t, x, y, z + s * (len / 2 - t), 0, 1);
  } else {
    b.ibox('accent', len, t, t, x, y, z, 0, 1);
    for (const s of [-1, 1]) b.ibox('trim', t, t, proud, x + s * (len / 2 - t), y, z, 0, 1);
  }
}

/**
 * Cable tray and conduit down ONE upper corner, with clips and a junction box.
 *
 * One run in one corner, never a plate across the plan: this is the fixed form
 * of the member that put plank at 1.66 m in a room with a 2.85 m ceiling.
 */
function conduit(b, r, sx) {
  const x = sx * (r.hw - 0.17);
  const y = r.ceilY - 0.26;
  const z0 = r.z0 + 0.3, z1 = r.z1 - 0.3;
  if (z1 - z0 < 0.8) return;
  /* Checked BEFORE anything is drawn. Every hull already hangs a cable tray in
   * one upper corner of every compartment it dresses, and a second run threaded
   * through it is the z-fight this pass exists not to author. */
  const foot = {
    x0: Math.min(x - 0.14, x + 0.14), x1: Math.max(x - 0.14, x + 0.14),
    y0: y - 0.20, y1: y + 0.14, z0, z1,
  };
  if (!b.fits(foot)) { b.fitStats.refused++; return false; }
  foot.chosen = true;
  b.iparts.push(foot);
  b.fitStats.placed++;
  for (let i = 0; i < 3; i++) {
    pipeRun(b, 'z', z0, z1, x - sx * i * 0.065, y - i * 0.055, 0.028, i === 1 ? 'accent' : 'dark');
  }
  bays(b, z0 + 0.2, z1 - 0.2, 1.2,
    (c, w) => bx(x, y + 0.08, c, 0.24, 0.06, Math.min(0.3, w * 0.4)),
    (c) => { b.ibox('trim', 0.22, 0.03, 0.05, x - sx * 0.06, y + 0.08, c, 0, 1); });
  place(b, [bx(x, y - 0.26, (z0 + z1) / 2 + 0.6, 0.18, 0.32, 0.26)], (f) => {
    const jz = (f.z0 + f.z1) / 2;
    b.ibox('dark', 0.16, 0.30, 0.24, x, f.y0 + 0.15, jz, 0, 1);
    b.ibox('glow', 0.02, 0.05, 0.14, x - sx * 0.09, f.y0 + 0.20, jz, 0, 1);
    for (const s of [-1, 1]) b.ibox('accent', 0.03, 0.03, 0.03, x - sx * 0.09, f.y0 + 0.06, jz + s * 0.08, 0, 1);
  });
}

/**
 * A lift-out deck panel with a recessed ring pull.
 *
 * Drawn 12 mm proud of the deck rather than flush: two opaque surfaces in one
 * plane is a z-fight, which is the family of defect that put 251 of 407 hits
 * into the medieval world.
 */
function deckPanel(b, r, x, z, w, d) {
  const y = r.floorY + 0.012;
  const foot = bx(x, y, z, w, 0.06, d);
  if (!b.fits(foot)) { b.fitStats.refused++; return; }
  foot.chosen = true;
  b.iparts.push(foot);
  b.fitStats.placed++;
  /* Drawn in 'trim', not in the deck's own 'deckg'. The deck plate is in the
   * EXTERIOR batch, so a grating key used only by this panel is a whole extra
   * draw call per hull for one 0.9 m plate — and the yard is measured at 143
   * meshes against a ceiling of 140. A lift-out panel is a plate anyway. */
  b.ibox('trim', w, 0.024, d, x, y, z, 0, 1.4);
  for (const s of [-1, 1]) b.ibox('trim', 0.04, 0.028, d, x + s * (w / 2 - 0.02), y + 0.002, z, 0, 1);
  b.iput('accent', new THREE.TorusGeometry(0.055, 0.014, 4, 8), x, y + 0.016, z + d / 2 - 0.14);
}

/* ------------------------------------------------------------------ */
/* Compartments                                                        */
/* ------------------------------------------------------------------ */

/**
 * A COCKPIT: something to fly it with, and something to read while you do.
 *
 * The panel is built as bays across the forward face rather than as one slab,
 * so it wraps around whatever the hull already put in the corners. Seats face
 * `+Z` on every hull in this yard — the pan is always aft of its own backrest —
 * so the panel is at `z1` and everything else is measured back from it.
 */
function fitCockpit(b, r) {
  const clear = r.ceilY - r.floorY;
  const fz = r.z1 - 0.06;                       // the forward face of the room
  const inner = r.hw - 0.14;                    // inside the hull's lining panels

  /* ── Where the instrument bank starts, and what it starts ON ──────────
   * Two of the three fitted hulls already carry a coaming across the forward
   * face — a wide thin member with a lit strip on it, at about desk height. It
   * IS the console top, so the bank is built standing on it rather than beside
   * it: `partsIn` takes the highest wide, thin thing on that face and the panel
   * begins a centimetre above it. The Kestrel has none (its coaming is authored
   * forward of its own forward bulkhead, sealed inside the nose), so there the
   * bank starts at desk height off the deck and is the whole console. */
  let deskTop = r.floorY + 0.70;
  let deskZ0 = fz - 0.40;
  for (const p of b.partsIn({
    x0: -r.hw, x1: r.hw,
    y0: r.floorY + 0.35, y1: r.floorY + 1.25,
    z0: fz - 1.0, z1: r.z1 + 0.4,
  })) {
    if (p.hx * 2 <= r.hw || p.hy * 2 >= 0.42) continue;   // a coaming is wide and thin
    if (p.y1 > deskTop) deskTop = p.y1;
    if (p.z0 < deskZ0) deskZ0 = p.z0;
  }
  const pBot = deskTop + 0.015;
  /* The top of the bank, held clear of the cable tray every hull hangs in one
   * upper corner at `ceilY - 0.30`: 0.62 puts the hood under its underside. */
  const pTop = r.floorY + Math.min(1.46, clear - 0.62);
  const pz0 = Math.min(Math.max(deskZ0, fz - 0.9), fz - 0.28);

  /* ── The instrument bank ──────────────────────────────────────────── */
  bays(b, -inner, inner, 0.36,
    (c, w) => ({ x0: c - w / 2, x1: c + w / 2, y0: pBot, y1: pTop + 0.18, z0: pz0, z1: fz }),
    (c, w, i) => {
      const ph = pTop - pBot;
      const cy = (pBot + pTop) / 2;
      const face = pz0;
      const pd = fz - pz0;
      b.ibox('trim', w - 0.012, ph, pd, c, cy, (pz0 + fz) / 2, 0, 1);
      b.ibox('dark', w - 0.07, ph - 0.06, 0.03, c, cy, face + 0.015, 0, 1);
      /* Four treatments on a fixed cycle. A bank of identical faces reads as
       * wallpaper; four reads as a cockpit laid out by trade. */
      const kind = i % 4;
      if (kind === 0) {
        dial(b, c, cy + ph * 0.20, face, Math.min(0.10, w * 0.34));
        dial(b, c, cy - ph * 0.18, face, Math.min(0.075, w * 0.26), 'warn');
      } else if (kind === 1) {
        annunciator(b, c, cy + ph * 0.14, face, w - 0.11, ph * 0.42, 2, 3);
        switches(b, c, cy - ph * 0.28, face, w - 0.11, 3);
      } else if (kind === 2) {
        screen(b, c, cy + ph * 0.16, face - 0.012, w - 0.12, ph * 0.36, 'glow', 'z');
        switches(b, c, cy - ph * 0.26, face, w - 0.11, 3);
      } else {
        keypad(b, c, cy, face, w - 0.11, ph * 0.66);
      }
      // The hood over it, raked aft so it shades the face from the deckhead.
      b.iput('dark', boxGeo(w - 0.012, 0.05, Math.min(0.30, pd + 0.06), 1), c, pTop + 0.14, face + 0.12, 0, -0.42);
      if (solidHere(r, pTop + 0.18)) {
        b.solid(c, (r.floorY + pTop + 0.18) / 2, (pz0 + fz) / 2, w / 2, (pTop + 0.18 - r.floorY) / 2, pd / 2);
      }
    });

  /* ── The bank wraps down both side walls ──────────────────────────────
   * Not decoration, and not optional. The Pike's forward bulkhead carries the
   * crouch hole through to its gun bay, whose approach reserves the middle
   * 1.7 m of a 2.4 m compartment up to the lintel — so a forward-only bank is
   * a Pike with no instruments at all. A cockpit this narrow would put them on
   * the side walls anyway. */
  for (const s of [-1, 1]) {
    const x = s * (r.hw - 0.25);
    bays(b, Math.max(r.z0 + 0.3, fz - Math.min(2.0, (r.z1 - r.z0) * 0.7)), pz0 - 0.05, 0.44,
      (c, w) => bx(x, (pBot + pTop) / 2, c, 0.22, pTop - pBot, w * 0.92),
      (c, w, i) => {
        const ph = pTop - pBot;
        const cy = (pBot + pTop) / 2;
        const d = w * 0.88;
        b.ibox('trim', 0.16, ph, d, x + s * 0.03, cy, c, 0, 1);
        b.ibox('dark', 0.03, ph - 0.06, d - 0.06, x - s * 0.05, cy, c, 0, 1);
        if (i % 2 === 0) {
          screen(b, x - s * 0.07, cy + ph * 0.14, c, d * 0.72, ph * 0.42, 'glow', 'x', s);
          for (let k = 0; k < 3; k++) {
            b.ibox('trim', 0.03, 0.05, 0.05, x - s * 0.075, cy - ph * 0.24, c - d * 0.26 + k * d * 0.26, 0, 1);
          }
        } else {
          for (let k = 0; k < 2; k++) {
            screen(b, x - s * 0.07, cy + ph * 0.22 - k * ph * 0.28, c, d * 0.62, ph * 0.18, k ? 'warn' : 'danger', 'x', s);
          }
          b.ibox('dark', 0.035, ph * 0.3, d * 0.66, x - s * 0.065, cy - ph * 0.26, c, 0, 1);
        }
        b.ibox('accent', 0.06, 0.04, d, x - s * 0.05, cy + ph / 2 - 0.02, c, 0, 1);
      });
  }

  /* ── Side consoles: throttle to starboard, chart to port ──────────── */
  for (const s of [-1, 1]) {
    const cw = Math.min(0.36, r.hw * 0.3), cd = Math.min(0.90, (r.z1 - r.z0) * 0.30);
    const cx = s * (inner - cw / 2);
    place(b, [
      bx(cx, r.floorY + 0.28, fz - 0.36 - cd / 2, cw, 0.58, cd),
      bx(cx, r.floorY + 0.28, fz - 0.62 - cd / 2, cw, 0.58, cd),
      bx(cx, r.floorY + 0.28, fz - 0.92 - cd / 2, cw, 0.58, cd),
      bx(cx, r.floorY + 0.28, fz - 1.24 - cd / 2, cw, 0.58, cd),
    ], (f) => {
      const cz = (f.z0 + f.z1) / 2;
      b.ibox('trim', cw, 0.44, cd, cx, r.floorY + 0.22, cz, 0, 1);
      b.ibox('dark', cw - 0.04, 0.04, cd - 0.04, cx, r.floorY + 0.46, cz, 0, 1);
      if (s > 0) {
        // Two throttle levers in a slotted gate, and their knobs.
        b.ibox('dark', 0.10, 0.02, cd - 0.16, cx, r.floorY + 0.485, cz, 0, 1);
        for (let i = 0; i < 2; i++) {
          const lx = cx - 0.05 + i * 0.10;
          b.iput('accent', boxGeo(0.03, 0.24, 0.05, 1), lx, r.floorY + 0.58, cz + 0.04 - i * 0.05, 0, -0.30);
          b.ibox('trim', 0.06, 0.06, 0.07, lx, r.floorY + 0.69, cz + 0.11 - i * 0.05, 0, 1);
        }
        b.ibox('glow', 0.05, 0.02, cd * 0.5, cx + cw * 0.28, r.floorY + 0.47, cz, 0, 1);
      } else {
        // A chart shelf with a rolled chart, a lit reader and a mug ring.
        b.ibox('glow', cw - 0.11, 0.015, cd * 0.42, cx, r.floorY + 0.485, cz - cd * 0.2, 0, 1);
        b.iput('tarp', new THREE.CylinderGeometry(0.045, 0.045, cd * 0.34, 6), cx, r.floorY + 0.52, cz + cd * 0.24, 0, Math.PI / 2);
        b.ibox('crate', cw - 0.14, 0.04, 0.14, cx, r.floorY + 0.50, cz + cd * 0.04, 0, 1);
      }
      if (solidHere(r, r.floorY + 0.52)) b.solid(cx, r.floorY + 0.26, cz, cw / 2, 0.26, cd / 2);
    });
  }

  /* ── The stick, and the pedals under the panel ────────────────────── */
  place(b, [
    bx(0, r.floorY + 0.36, fz - 1.02, 0.24, 0.72, 0.26),
    bx(0, r.floorY + 0.36, fz - 0.82, 0.24, 0.72, 0.26),
    bx(inner - 0.32, r.floorY + 0.36, fz - 1.02, 0.24, 0.72, 0.26),
  ], (f) => {
    const sx = (f.x0 + f.x1) / 2, sz = (f.z0 + f.z1) / 2;
    b.iput('dark', new THREE.CylinderGeometry(0.10, 0.12, 0.09, 8), sx, r.floorY + 0.045, sz);
    b.iput('tarp', new THREE.CylinderGeometry(0.055, 0.085, 0.16, 8), sx, r.floorY + 0.15, sz);
    b.iput('trim', boxGeo(0.045, 0.42, 0.045, 1), sx, r.floorY + 0.42, sz - 0.02, 0, 0.10);
    b.ibox('dark', 0.075, 0.16, 0.09, sx, r.floorY + 0.68, sz - 0.06, 0, 1);
    b.ibox('accent', 0.03, 0.03, 0.045, sx, r.floorY + 0.72, sz - 0.11, 0, 1);
    b.ibox('danger', 0.024, 0.016, 0.02, sx, r.floorY + 0.66, sz - 0.11, 0, 1);
  });
  for (const s of [-1, 1]) {
    place(b, [
      bx(s * 0.21, r.floorY + 0.16, fz - 0.52, 0.20, 0.32, 0.28),
      bx(s * 0.21, r.floorY + 0.16, fz - 0.85, 0.20, 0.32, 0.28),
      bx(s * 0.21, r.floorY + 0.16, fz - 1.18, 0.20, 0.32, 0.28),
    ], (f) => {
      const pz = (f.z0 + f.z1) / 2;
      b.iput('dark', boxGeo(0.15, 0.05, 0.22, 1), s * 0.21, r.floorY + 0.18, pz, 0, -0.55);
      b.ibox('trim', 0.06, 0.07, 0.16, s * 0.21, r.floorY + 0.07, pz + 0.07, 0, 1);
    });
  }

  /* ── Dress the seat the hull already put here ─────────────────────── */
  dressSeat(b, r, fz);

  /* ── Overhead: rails down the SIDES only ──────────────────────────── */
  /* Never across the middle. The Kestrel's compartment is roofed in glass over
   * its whole beam, and a breaker panel down the centreline would be a fitting
   * hung across the one thing in the room you can see out of. */
  for (const s of [-1, 1]) {
    const x = s * (r.hw - 0.30);
    bays(b, r.z0 + 0.35, r.z1 - 0.45, 0.62,
      (c, w) => bx(x, r.ceilY - 0.08, c, 0.24, 0.13, w * 0.8),
      (c, w) => {
        b.ibox('trim', 0.22, 0.06, w * 0.72, x, r.ceilY - 0.05, c, 0, 1);
        for (let i = 0; i < 3; i++) {
          b.ibox('accent', 0.022, 0.045, 0.05, x - s * 0.06, r.ceilY - 0.13, c - w * 0.24 + i * w * 0.24, 0, 1);
        }
        b.ibox('glow', 0.04, 0.012, w * 0.5, x + s * 0.10, r.ceilY - 0.12, c, 0, 1);
      });
  }
  if (conduit(b, r, -1) === false) conduit(b, r, 1);
  for (const s of [-1, 1]) {
    place(b, [bx(s * (r.hw - 0.14), r.floorY + 1.58, r.z0 + 0.55, 0.12, 0.12, 0.64)],
      () => grab(b, 'z', s * (r.hw - 0.14), r.floorY + 1.58, r.z0 + 0.55, 0.60));
    place(b, [
      bx(s * (r.hw - 0.13), r.floorY + 1.26, r.z0 + 1.25, 0.10, 0.24, 0.32),
      bx(s * (r.hw - 0.13), r.floorY + 1.26, r.z0 + 0.55, 0.10, 0.24, 0.32),
      bx(s * (r.hw - 0.13), r.floorY + 1.26, r.z0 + 1.95, 0.10, 0.24, 0.32),
    ], (f) => placard(b, s * (r.hw - 0.13), r.floorY + 1.26, (f.z0 + f.z1) / 2, 0.22, 0.14,
      s > 0 ? 'danger' : 'warn', s > 0 ? -Math.PI / 2 : Math.PI / 2));
  }
  deckPanel(b, r, 0, r.z0 + 0.55, Math.min(0.9, r.hw), 0.7);
}

/**
 * Armrests, a headrest, harness webbing, rails and a cushion, on whatever seat
 * is actually there.
 *
 * `partIn` finds the mass rather than assuming it: the Kestrel, the Dray and the
 * Pike all author their seats at different stations and to different sizes, and
 * all of them are dressed by this one function.
 */
function dressSeat(b, r, fz) {
  const seats = [];
  for (const sx of [-0.6, 0, 0.6]) {
    const pan = b.partIn(bx(sx, r.floorY + 0.45, fz - 1.35, 0.85, 0.55, 1.5));
    if (!pan) continue;
    if (pan.y1 - pan.y0 > 0.45) continue;              // a pan is a plank, not a cabinet
    const cx = (pan.x0 + pan.x1) / 2;
    if (seats.some((s) => Math.abs(s.x - cx) < 0.25)) continue;
    seats.push({ x: cx, pan });
  }
  for (const s of seats) {
    const p = s.pan;
    const cz = (p.z0 + p.z1) / 2, halfW = (p.x1 - p.x0) / 2;
    const pd = p.z1 - p.z0;
    const seatStack = b.stack(p);
    const top = seatStack.top;
    // A cushion ON the pan — on whatever is already lying in it, not under it.
    dress(b, p, [bx(s.x, top + 0.045, cz + pd * 0.06, (p.x1 - p.x0) * 0.9, 0.1, pd * 0.78)], () => {
      /* Dark, not canvas. Every hull draws its pan and its back in 'crate', and a
       * canvas cushion on a wooden pan is one tan mass — which is exactly what
       * the seats read as before this: a block, not somewhere to sit. */
      b.ibox('dark', (p.x1 - p.x0) * 0.88, 0.075, pd * 0.74, s.x, top + 0.04, cz + pd * 0.06, 0, 1);
      for (const sg of [-1, 1]) {
        b.ibox('dark', 0.06, 0.11, pd * 0.7, s.x + sg * (p.x1 - p.x0) * 0.42, top + 0.055, cz + pd * 0.06, 0, 1);
      }
    });
    // A pedestal and rails under it.
    if (p.y0 - r.floorY > 0.12) {
      place(b, [bx(s.x, (r.floorY + p.y0) / 2, cz, halfW * 1.3, p.y0 - r.floorY, pd * 0.55)], () => {
        for (const sg of [-1, 1]) {
          b.ibox('dark', 0.05, p.y0 - r.floorY, pd * 0.5, s.x + sg * halfW * 0.6, (r.floorY + p.y0) / 2, cz, 0, 1);
        }
        b.ibox('trim', halfW * 1.2, 0.04, pd * 0.46, s.x, r.floorY + 0.03, cz, 0, 1);
      }, seatStack.parts);
    }
    // Armrests either side, standing off the pan.
    for (const sg of [-1, 1]) {
      const ax = s.x + sg * (halfW + 0.055);
      place(b, [
        bx(ax, top + 0.20, cz + pd * 0.06, 0.10, 0.36, pd * 0.66),
        bx(ax, top + 0.20, cz + pd * 0.16, 0.10, 0.36, pd * 0.46),
      ], (f) => {
        const az = (f.z0 + f.z1) / 2, ad = f.z1 - f.z0;
        b.ibox('trim', 0.06, 0.26, 0.07, ax, top + 0.11, az + ad * 0.4, 0, 1);
        b.ibox('dark', 0.075, 0.06, ad * 0.9, ax, top + 0.28, az, 0, 1);
      }, seatStack.parts);
    }
    // The back, and a headrest and harness on it.
    const back = b.partIn(bx(s.x, top + 0.45, p.z0 - 0.24, (p.x1 - p.x0) * 0.95, 0.95, 0.6));
    if (!back || back.y1 - back.y0 < 0.4) continue;
    const bz = (back.z0 + back.z1) / 2;
    const bwd = back.x1 - back.x0;
    dress(b, back, [bx(s.x, back.y1 + 0.09, bz, bwd * 0.64, 0.19, (back.z1 - back.z0) + 0.02)], () => {
      b.ibox('dark', bwd * 0.62, 0.15, (back.z1 - back.z0) * 0.9, s.x, back.y1 + 0.09, bz, 0, 1);
      b.ibox('tarp', bwd * 0.5, 0.11, 0.02, s.x, back.y1 + 0.09, back.z1 + 0.012, 0, 1);
      for (const sg of [-1, 1]) {
        b.ibox('dark', 0.03, 0.10, 0.05, s.x + sg * bwd * 0.24, back.y1 - 0.02, bz, 0, 1);
      }
    });
    /* THE BACK OF THE SEAT, which is the face a compartment is normally seen
     * from. Every hull draws its backrest as one board in 'crate', so from the
     * cabin behind it a fitted cockpit read as a tan slab on a tan slab. A
     * shell, two stiffeners and a stowage pocket is what is actually there. */
    dress(b, back, [bx(s.x, (back.y0 + back.y1) / 2, back.z0 - 0.035, bwd + 0.03, back.y1 - back.y0, 0.07)], () => {
      const by = (back.y0 + back.y1) / 2, bh = back.y1 - back.y0;
      b.ibox('dark', bwd + 0.02, bh, 0.04, s.x, by, back.z0 - 0.02, 0, 1);
      for (const sg of [-1, 1]) {
        b.ibox('trim', 0.05, bh - 0.04, 0.05, s.x + sg * bwd * 0.36, by, back.z0 - 0.045, 0, 1);
      }
      b.ibox('tarp', bwd * 0.5, bh * 0.3, 0.04, s.x, back.y0 + bh * 0.28, back.z0 - 0.05, 0, 1);
      b.ibox('accent', bwd * 0.5, 0.02, 0.05, s.x, back.y0 + bh * 0.43, back.z0 - 0.05, 0, 1);
    });
    for (const sg of [-1, 1]) {
      const wx = s.x + sg * bwd * 0.26;
      dress(b, back, [bx(wx, back.y1 - 0.24, back.z1 + 0.026, 0.10, 0.52, 0.06)], () => {
        b.iput('tarp', boxGeo(0.07, 0.46, 0.022, 1), wx, back.y1 - 0.24, back.z1 + 0.018, 0, 0, sg * 0.16);
        b.ibox('accent', 0.05, 0.05, 0.03, wx, back.y1 - 0.48, back.z1 + 0.022, 0, 1);
      });
    }
  }
}

/**
 * Turn a cabinet-shaped mass into a locker with doors on it.
 *
 * Both hulls that carry one also carry a thin plate across its face, and that
 * plate IS the door — so this looks for it and dresses it rather than building a
 * second set of leaves 30 mm in front of it, which is the z-fight this whole
 * pass exists not to author. Where there is no plate, two leaves are built.
 */
function dressCabinet(b, r, lk) {
  const lxm = lk.cx, lzm = lk.cz;
  const side = lxm < 0 ? -1 : 1;
  const ld = lk.z1 - lk.z0;
  const half = (lk.x1 - lk.x0) / 2;
  // Is there already a plate across the face?
  const leaf = b.partIn(bx(lxm - side * (half + 0.05), (lk.y0 + lk.y1) / 2, lzm, 0.14, (lk.y1 - lk.y0) * 0.8, ld * 0.9));
  const face = leaf && leaf.hx * 2 < 0.14
    ? lxm - side * (Math.abs(leaf.cx - lxm) + leaf.hx + 0.016)
    : lxm - side * (half + 0.018);
  const skip = leaf ? [leaf] : [];
  for (const sg of [-1, 1]) {
    const foot = bx(face, (lk.y0 + lk.y1) / 2, lzm + sg * ld * 0.25, 0.055, lk.y1 - lk.y0 - 0.08, ld * 0.44);
    skip.push(foot);
    place(b, [foot], () => {
      if (!leaf) {
        b.ibox('trim', 0.028, lk.y1 - lk.y0 - 0.10, ld * 0.42, face, (lk.y0 + lk.y1) / 2, lzm + sg * ld * 0.25, 0, 1);
      }
      b.ibox('accent', 0.035, 0.11, 0.035, face - side * 0.018, (lk.y0 + lk.y1) / 2, lzm + sg * ld * 0.05, 0, 1);
      for (let i = 0; i < 4; i++) {
        b.ibox('dark', 0.022, 0.018, ld * 0.28, face - side * 0.012, lk.y1 - 0.18 - i * 0.05, lzm + sg * ld * 0.25, 0, 1);
      }
    }, skip);
  }
  /* The name plate goes ON a leaf, not in the shadow gap between two of them.
   * `skip` carries the leaves this function just claimed as well as any the hull
   * had already drawn, which is the whole reason it is a list. */
  place(b, [bx(face - side * 0.03, lk.y1 - 0.34, lzm - ld * 0.25, 0.07, 0.17, 0.24)], () => {
    placard(b, face - side * 0.022, lk.y1 - 0.34, lzm - ld * 0.25, 0.20, 0.11, 'glow', side > 0 ? -Math.PI / 2 : Math.PI / 2);
  }, skip);
  // A hook beside it, with somebody's kit still hanging on it.
  place(b, [
    bx(face - side * 0.10, lk.y1 - 0.38, lk.z0 - 0.2, 0.26, 0.72, 0.3),
    bx(face - side * 0.10, lk.y1 - 0.38, lk.z1 + 0.2, 0.26, 0.72, 0.3),
  ], (f) => {
    const hz = (f.z0 + f.z1) / 2;
    b.ibox('trim', 0.04, 0.05, 0.04, face, lk.y1 - 0.10, hz, 0, 1);
    b.iput('tarp', boxGeo(0.13, 0.52, 0.20, 1), face - side * 0.08, lk.y1 - 0.40, hz, 0, 0, side * 0.05);
  });
}

/**
 * A CABIN: somebody lives here.
 *
 * The three fittings a berth needs are already in this hull as three boxes. What
 * this adds is everything that makes them a bunk, a locker and a table rather
 * than three boxes: bedding, a lee cloth, a reading lamp, a shelf of somebody's
 * things, door leaves and handles, and the clutter of a watch half over.
 */
function fitCabin(b, r) {
  const inner = r.hw - 0.14;

  /* ── The bunk ─────────────────────────────────────────────────────── */
  const bunk = b.partIn(bx(0, r.floorY + 0.28, (r.z0 + r.z1) / 2, r.hw * 2, 0.55, (r.z1 - r.z0) * 0.92));
  if (bunk && bunk.z1 - bunk.z0 > 1.4) {
    const bxm = (bunk.x0 + bunk.x1) / 2, bzm = (bunk.z0 + bunk.z1) / 2;
    const bw = bunk.x1 - bunk.x0, bl = bunk.z1 - bunk.z0;
    const side = bxm < 0 ? -1 : 1;
    /* The MATTRESS top, not the board's. The hull draws a board and lays a
     * mattress on it as two separate parts, and bedding placed on the board is
     * bedding inside the mattress. */
    const mat = b.stack(bunk).top;
    // Pillow at the aft end, a folded blanket at the foot.
    dress(b, bunk, [bx(bxm, mat + 0.08, bunk.z0 + 0.26, bw * 0.82, 0.18, 0.44)], () => {
      b.ibox('tarp', bw * 0.78, 0.12, 0.38, bxm, mat + 0.06, bunk.z0 + 0.26, 0, 1);
      /* A dark welt round the pillow. Every hull draws its bunk board in 'crate'
       * and its mattress in 'tarp', which are the same value at this exposure —
       * so bedding drawn in either is a berth with no bedding on it. */
      for (const sg of [-1, 1]) {
        b.ibox('dark', bw * 0.8, 0.03, 0.03, bxm, mat + 0.115, bunk.z0 + 0.26 + sg * 0.19, 0, 1);
      }
    });
    dress(b, bunk, [bx(bxm, mat + 0.08, bunk.z1 - 0.32, bw * 0.9, 0.2, 0.5)], () => {
      b.ibox('dark', bw * 0.86, 0.09, 0.44, bxm, mat + 0.045, bunk.z1 - 0.32, 0, 1);
      b.ibox('tarp', bw * 0.82, 0.05, 0.40, bxm, mat + 0.115, bunk.z1 - 0.32, 0, 1);
      b.ibox('dark', bw * 0.84, 0.03, 0.42, bxm, mat + 0.15, bunk.z1 - 0.32, 0, 1);
    });
    // A lee cloth on a rail, so the berth is a berth and not a shelf. The rail
    // stands OUTBOARD of the mattress, on the side a body gets in from.
    const lx = bxm - side * (bw / 2 + 0.05);
    place(b, [bx(lx, mat + 0.32, bzm, 0.1, 0.66, bl * 0.88)], () => {
      b.ibox('trim', 0.045, 0.045, bl * 0.84, lx, mat + 0.58, bzm, 0, 1);
      b.ibox('tarp', 0.022, 0.30, bl * 0.80, lx, mat + 0.40, bzm, 0, 1);
      for (let i = 0; i < 4; i++) {
        b.ibox('accent', 0.03, 0.055, 0.03, lx, mat + 0.55, bzm - bl * 0.32 + i * bl * 0.21, 0, 1);
      }
    });
    // Drawers under it.
    if (bunk.y0 - r.floorY > 0.16) {
      bays(b, bunk.z0 + 0.08, bunk.z1 - 0.08, 0.64,
        (c, w) => bx(bxm, (r.floorY + bunk.y0) / 2, c, bw * 0.94, bunk.y0 - r.floorY, w * 0.92),
        (c, w) => {
          const dh = bunk.y0 - r.floorY - 0.04;
          b.ibox('trim', bw * 0.9, dh, w * 0.86, bxm, r.floorY + dh / 2 + 0.02, c, 0, 1);
          b.ibox('accent', 0.15, 0.03, 0.035, bxm + side * bw * 0.42, r.floorY + dh / 2 + 0.02, c, 0, 1);
        });
    }
    // A shelf over the head of the bunk, with somebody's things on it.
    const shx = bxm + side * (bw / 2 - 0.14);
    place(b, [
      bx(shx, mat + 0.74, bunk.z0 + 0.5, 0.32, 0.36, 0.94),
      bx(shx, mat + 0.66, bunk.z0 + 0.5, 0.28, 0.3, 0.8),
    ], (f) => {
      const sz = (f.z0 + f.z1) / 2, sl = f.z1 - f.z0, sy = f.y0 + 0.04;
      b.ibox('trim', 0.26, 0.03, sl * 0.92, shx, sy, sz, 0, 1);
      b.ibox('trim', 0.26, 0.06, 0.02, shx, sy + 0.04, f.z0 + 0.04, 0, 1);
      b.iput('accent', new THREE.CylinderGeometry(0.038, 0.038, 0.09, 8), shx - side * 0.04, sy + 0.06, f.z0 + 0.14);
      b.ibox('crate', 0.15, 0.04, 0.11, shx, sy + 0.035, f.z0 + 0.38, 0.3, 1);
      b.ibox('crate', 0.13, 0.05, 0.10, shx + side * 0.02, sy + 0.08, f.z0 + 0.4, 0.1, 1);
      b.iput('dark', new THREE.CylinderGeometry(0.03, 0.03, 0.11, 6), shx + side * 0.03, sy + 0.07, f.z0 + 0.6);
      b.ibox('dark', 0.07, 0.09, 0.03, shx, sy + 0.18, f.z1 - 0.1, 0, 1);
      b.ibox('glow', 0.05, 0.06, 0.012, shx - side * 0.02, sy + 0.18, f.z1 - 0.1, 0, 1);
    });
    // A reading lamp on a stalk over the pillow.
    place(b, [
      bx(shx, mat + 0.42, bunk.z0 + 0.16, 0.22, 0.26, 0.24),
      bx(shx, mat + 0.36, bunk.z0 + 0.14, 0.2, 0.22, 0.2),
    ], (f) => {
      const ly = f.y0 + 0.02, lz = (f.z0 + f.z1) / 2;
      b.ibox('dark', 0.05, 0.18, 0.05, shx, ly + 0.09, lz, 0, 1);
      b.ibox('warn', 0.09, 0.05, 0.11, shx - side * 0.06, ly + 0.19, lz, 0, 1);
    });
    if (solidHere(r, mat + 0.05)) {
      b.solid(bxm, (r.floorY + mat + 0.05) / 2, bzm, bw / 2, (mat + 0.05 - r.floorY) / 2, bl / 2);
    }
  }

  /* ── The locker ───────────────────────────────────────────────────── */
  const lk = b.partIn(bx(0, r.floorY + 1.05, (r.z0 + r.z1) / 2, r.hw * 2, 1.5, (r.z1 - r.z0) * 0.92));
  if (lk && lk.y1 - lk.y0 > 0.9 && lk.x1 - lk.x0 < 1.2) {
    dressCabinet(b, r, lk);
    const lxm = lk.cx, lzm = lk.cz, ld = lk.z1 - lk.z0;
    const side = lxm < 0 ? -1 : 1;
    // Boots kicked off at its foot.
    place(b, [
      bx(lxm, r.floorY + 0.1, lk.z0 - 0.28, 0.38, 0.22, 0.36),
      bx(lxm, r.floorY + 0.1, lk.z1 + 0.28, 0.38, 0.22, 0.36),
    ], (f) => {
      const bz = (f.z0 + f.z1) / 2;
      for (const sg of [-1, 1]) {
        b.ibox('dark', 0.11, 0.16, 0.26, lxm + sg * 0.08, r.floorY + 0.08, bz, sg * 0.12, 1);
      }
    });
    if (solidHere(r, lk.y1)) b.solid(lxm, (r.floorY + lk.y1) / 2, lzm, (lk.x1 - lk.x0) / 2 + 0.03, (lk.y1 - r.floorY) / 2, ld / 2);
  }

  /* ── The table ────────────────────────────────────────────────────── */
  const tb = b.partIn(bx(0, r.floorY + 0.78, (r.z0 + r.z1) / 2, r.hw * 2, 0.24, (r.z1 - r.z0) * 0.9));
  if (tb && tb.y1 - tb.y0 < 0.2 && tb.x1 - tb.x0 > 0.5) {
    const txm = (tb.x0 + tb.x1) / 2, tzm = (tb.z0 + tb.z1) / 2;
    const side = txm < 0 ? -1 : 1;
    place(b, [bx(txm, tb.y1 + 0.07, tzm, (tb.x1 - tb.x0) * 0.92, 0.14, (tb.z1 - tb.z0) * 0.92)], () => {
      b.iput('accent', new THREE.CylinderGeometry(0.04, 0.036, 0.10, 8), txm - side * 0.14, tb.y1 + 0.05, tzm - 0.08);
      b.ibox('crate', 0.16, 0.045, 0.12, txm + side * 0.10, tb.y1 + 0.03, tzm + 0.10, 0.22, 1);
      b.ibox('glow', 0.10, 0.008, 0.07, txm, tb.y1 + 0.012, tzm + 0.19, 0, 1);
    });
    place(b, [bx(txm - side * ((tb.x1 - tb.x0) / 2 - 0.06), (r.floorY + tb.y0) / 2, tzm, 0.1, tb.y0 - r.floorY, 0.12)], () => {
      b.iput('trim', boxGeo(0.05, tb.y0 - r.floorY + 0.1, 0.05, 1),
        txm - side * ((tb.x1 - tb.x0) / 2 - 0.06), (r.floorY + tb.y0) / 2, tzm, 0, 0, side * 0.16);
    });
  }

  /* ── The bulkheads: a service panel, a bottle, a first-aid box ────── */
  for (const s of [-1, 1]) {
    const x = s * (r.hw - 0.17);
    place(b, [
      bx(x, r.floorY + 1.30, r.z0 + 0.58, 0.14, 0.64, 0.54),
      bx(x, r.floorY + 1.30, r.z0 + 1.15, 0.14, 0.64, 0.54),
      bx(x, r.floorY + 1.30, r.z1 - 0.58, 0.14, 0.64, 0.54),
    ], (f) => {
      const pz = (f.z0 + f.z1) / 2;
      b.ibox('trim', 0.05, 0.56, 0.46, x, r.floorY + 1.30, pz, 0, 1);
      for (const a of [-1, 1]) {
        for (const c of [-1, 1]) {
          b.ibox('accent', 0.035, 0.055, 0.055, x - s * 0.025, r.floorY + 1.30 + a * 0.22, pz + c * 0.18, 0, 1);
        }
      }
      b.ibox('warn', 0.02, 0.05, 0.20, x - s * 0.045, r.floorY + 1.52, pz, 0, 1);
    });
    place(b, [
      bx(x - s * 0.10, r.floorY + 1.05, r.z1 - 0.5, 0.24, 0.5, 0.24),
      bx(x - s * 0.10, r.floorY + 1.05, r.z0 + 1.4, 0.24, 0.5, 0.24),
      bx(x - s * 0.10, r.floorY + 1.05, r.z0 + 2.1, 0.24, 0.5, 0.24),
    ], (f) => {
      const bz = (f.z0 + f.z1) / 2;
      b.iput('danger', new THREE.CylinderGeometry(0.075, 0.075, 0.36, 8), x - s * 0.10, r.floorY + 1.02, bz);
      b.iput('dark', new THREE.CylinderGeometry(0.035, 0.045, 0.10, 6), x - s * 0.10, r.floorY + 1.24, bz);
      b.ibox('trim', 0.05, 0.04, 0.19, x - s * 0.035, r.floorY + 1.10, bz, 0, 1);
    });
  }

  /* ── Overhead and deck ────────────────────────────────────────────── */
  place(b, [
    bx(0, r.ceilY - 0.31, (r.z0 + r.z1) / 2, 0.12, 0.16, (r.z1 - r.z0) * 0.55),
    bx(0, r.ceilY - 0.31, (r.z0 + r.z1) / 2, 0.12, 0.16, (r.z1 - r.z0) * 0.35),
  ], (f) => {
    const gz = (f.z0 + f.z1) / 2, gl = f.z1 - f.z0;
    b.ibox('accent', 0.04, 0.04, gl, 0, r.ceilY - 0.31, gz, 0, 1);
    for (const sg of [-1, 1]) b.ibox('trim', 0.04, 0.11, 0.04, 0, r.ceilY - 0.25, gz + sg * (gl / 2 - 0.03), 0, 1);
  });
  if (conduit(b, r, 1) === false) conduit(b, r, -1);
  deckPanel(b, r, 0, (r.z0 + r.z1) / 2 + 0.45, Math.min(0.86, r.hw * 0.8), 0.72);

  /* ── The last of it: a kit bag stowed in whichever corner is free ─── */
  for (const s of [-1, 1]) {
    place(b, [
      bx(s * (inner - 0.26), r.floorY + 0.16, r.z0 + 0.42, 0.5, 0.36, 0.44),
      bx(s * (inner - 0.26), r.floorY + 0.16, r.z1 - 0.42, 0.5, 0.36, 0.44),
      bx(s * (inner - 0.26), r.floorY + 0.16, (r.z0 + r.z1) / 2, 0.5, 0.36, 0.44),
      bx(s * (inner - 0.70), r.floorY + 0.16, r.z0 + 0.42, 0.5, 0.36, 0.44),
    ], (f) => {
      const cx = (f.x0 + f.x1) / 2, cz = (f.z0 + f.z1) / 2;
      b.ibox('tarp', 0.42, 0.26, 0.34, cx, r.floorY + 0.13, cz, 0.22, 1);
      b.ibox('accent', 0.30, 0.035, 0.05, cx, r.floorY + 0.24, cz, 0.22, 1);
      b.ibox('dark', 0.09, 0.05, 0.09, cx, r.floorY + 0.25, cz, 0.22, 1);
    });
  }
}

/**
 * A HOLD: racking, tie-downs, cargo actually strapped down, a loading rail.
 *
 * The one compartment in this yard with a standable-surface band to respect —
 * 3.40 m clear means a collided top between `floorY + 0.40` and `floorY + 1.50`
 * is a surface a body could stand on and cannot reach. So the shelving is either
 * against the deck or high enough that nothing could stand on it, and the
 * cantilevered wall racks carry their lowest shelf above the cargo rather than
 * beside it — which is also where a hold that is already full of ore boxes has
 * any room left.
 */
function fitHold(b, r) {
  /* Clear of the hull's own inner ribs, which stand `hw - 0.12` to `hw` on both
   * flanks. A rack 1.4 m long crosses one at some station whatever the pitch,
   * so the FACE is set inboard of them rather than the bay being refused. */
  const wall = r.hw - 0.14;
  const zc = (r.z0 + r.z1) / 2;

  /* ── The loading rail ─────────────────────────────────────────────── */
  const railY = r.ceilY - 0.52;
  /* Full length first, then shorter from the forward end. The Dray's own
   * companionway climbs out of this hold at its forward end and reserves 2.0 m
   * of headroom over every tread — a rail run the whole length would hang
   * 1.66 m over the fifth one. */
  const rl = (r.z1 - r.z0);
  place(b, [
    bx(0, railY, zc, 0.30, 0.34, rl - 1.2),
    bx(0, railY, zc - rl * 0.14, 0.30, 0.34, rl * 0.70),
    bx(0, railY, zc - rl * 0.24, 0.30, 0.34, rl * 0.48),
  ], (f) => {
    const z0 = f.z0, z1 = f.z1, len = z1 - z0, rz = (z0 + z1) / 2;
    b.ibox('dark', 0.10, 0.20, len, 0, railY, rz, 0, 1);
    for (const sg of [-1, 1]) b.ibox('trim', 0.26, 0.05, len, 0, railY + sg * 0.10, rz, 0, 1);
    /* Hangers up to the deckhead, in PAIRS outboard of the centreline. A single
     * hanger on the beam's own axis runs straight through the recessed
     * luminaires the hull sets down the middle of this compartment. */
    bays(b, z0 + 0.4, z1 - 0.4, 1.6,
      (c) => bx(0, railY + 0.3, c, 0.8, 0.44, 0.12),
      (c) => {
        for (const sg of [-1, 1]) {
          b.iput('trim', boxGeo(0.06, r.ceilY - railY - 0.04, 0.06, 1),
            sg * 0.20, (railY + 0.10 + r.ceilY) / 2, c, 0, 0, sg * 0.24);
        }
        b.ibox('accent', 0.52, 0.05, 0.06, 0, railY + 0.13, c, 0, 1);
      });
    // A trolley parked a third of the way along, with its hook down on a chain.
    const tz = z0 + len * 0.34;
    b.ibox('accent', 0.30, 0.16, 0.34, 0, railY - 0.03, tz, 0, 1);
    for (const sg of [-1, 1]) b.iput('dark', new THREE.CylinderGeometry(0.055, 0.055, 0.05, 8), sg * 0.11, railY + 0.07, tz, 0, 0, Math.PI / 2);
    for (let i = 0; i < 5; i++) {
      b.ibox('dark', 0.035, 0.09, 0.035, 0, railY - 0.16 - i * 0.085, tz, (i % 2) * 0.8, 1);
    }
    b.iput('accent', new THREE.TorusGeometry(0.075, 0.022, 4, 8), 0, railY - 0.63, tz, 0, 0, Math.PI / 2);
  });

  /* ── Wall racks, cantilevered clear of the cargo under them ───────── */
  for (const s of [-1, 1]) {
    const x = s * (wall - 0.28);
    bays(b, r.z0 + 0.5, r.z1 - 0.5, 1.5,
      (c, w) => bx(x, r.floorY + 2.06, c, 0.6, 1.26, w * 0.9),
      (c, w) => {
        const d = w * 0.86;
        for (const lv of [0, 1]) {
          const y = r.floorY + 1.5 + lv * 0.72;
          b.ibox('trim', 0.52, 0.035, d, x, y, c, 0, 1);
          b.ibox('trim', 0.52, 0.07, 0.03, x, y + 0.05, c + d / 2 - 0.02, 0, 1);
          for (const sg of [-1, 1]) {
            b.iput('dark', boxGeo(0.44, 0.05, 0.05, 1), x + s * 0.02, y - 0.13, c + sg * (d / 2 - 0.06), 0, 0, s * 0.5);
            b.ibox('dark', 0.06, 0.28, 0.06, s * (r.hw - 0.13), y - 0.12, c + sg * (d / 2 - 0.06), 0, 1);
          }
        }
        // What is on the shelves: boxes low, a drum and coiled line high.
        b.ibox('crate', 0.34, 0.26, d * 0.4, x - s * 0.04, r.floorY + 1.65, c - d * 0.22, 0.1, 1);
        b.ibox('crate', 0.30, 0.2, d * 0.3, x + s * 0.06, r.floorY + 1.62, c + d * 0.25, -0.2, 1);
        b.iput('accent', new THREE.CylinderGeometry(0.14, 0.14, 0.36, 8), x, r.floorY + 2.4, c - d * 0.2);
        b.iput('tarp', new THREE.TorusGeometry(0.15, 0.05, 4, 10), x, r.floorY + 2.28, c + d * 0.25);
        placard(b, x - s * 0.28, r.floorY + 1.42, c, 0.22, 0.09, 'glow', 0);
      });
  }

  /* ── Strap down the cargo the hull already loaded ─────────────────── */
  for (const p of b.partsIn(bx(0, r.floorY + 0.7, zc, r.hw * 2, 1.6, r.z1 - r.z0))) {
    if (Math.abs(p.y0 - r.floorY) > 0.12) continue;          // it is not standing on the deck
    if (p.hy * 2 < 0.5 || p.hy * 2 > 1.7) continue;          // nor a mat, nor a bulkhead
    if (p.hx * 2 < 0.6 || p.hz * 2 < 0.6) continue;
    const A = (px, py, pz) => [
      p.cx + px * Math.cos(p.ry) + pz * Math.sin(p.ry),
      p.cy + py,
      p.cz - px * Math.sin(p.ry) + pz * Math.cos(p.ry),
    ];
    // Two ratchet straps over the top and down both flanks.
    for (const t of [-0.42, 0.42]) {
      const sz = p.hz * 2 * t;
      let q = A(0, p.hy + 0.014, sz);
      b.ibox('tarp', p.hx * 2 + 0.03, 0.026, 0.09, q[0], q[1], q[2], p.ry, 1);
      for (const sg of [-1, 1]) {
        q = A(sg * (p.hx + 0.014), 0, sz);
        b.ibox('tarp', 0.026, p.hy * 2, 0.09, q[0], q[1], q[2], p.ry, 1);
      }
      q = A(p.hx + 0.05, -p.hy * 0.25, sz);
      b.ibox('accent', 0.11, 0.13, 0.07, q[0], q[1], q[2], p.ry, 1);
    }
    // Corner protectors, and a stencil plate on the aft face.
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const q = A(sx * (p.hx - 0.05), p.hy + 0.012, sz * (p.hz - 0.05));
        b.ibox('dark', 0.14, 0.03, 0.14, q[0], q[1], q[2], p.ry, 1);
      }
    }
    const st = A(0, p.hy * 0.25, -(p.hz + 0.014));
    placard(b, st[0], st[1], st[2], Math.min(0.42, p.hx * 1.3), 0.13, 'warn', p.ry + Math.PI);
  }

  /* ── Tie-downs down both margins and the centre lane ──────────────── */
  for (const x of [-(wall - 0.24), 0, wall - 0.24]) {
    bays(b, r.z0 + 0.7, r.z1 - 0.7, 1.15,
      (c) => bx(x, r.floorY + 0.045, c, 0.3, 0.1, 0.3),
      (c) => {
        b.ibox('dark', 0.26, 0.03, 0.26, x, r.floorY + 0.015, c, 0, 1);
        b.ibox('trim', 0.20, 0.035, 0.20, x, r.floorY + 0.03, c, 0.78, 1);
        b.iput('accent', new THREE.TorusGeometry(0.055, 0.016, 4, 8), x, r.floorY + 0.055, c, 0, 0, Math.PI / 2);
      });
  }

  /* ── The cargo door end: chevrons, a rubbing strip, a manifest ────── */
  for (const s of [-1, 1]) {
    place(b, [bx(s * (wall - 0.2), r.floorY + 0.05, zc, 0.34, 0.14, (r.z1 - r.z0) * 0.5)], (f) => {
      const fz = (f.z0 + f.z1) / 2, fl = f.z1 - f.z0;
      chevrons(b, r, s * (wall - 0.2), fz, 0.30, fl);
      bays(b, f.z0 + 0.3, f.z1 - 0.3, 0.8,
        (c) => bx(s * (wall - 0.08), r.floorY + 0.07, c, 0.14, 0.14, 0.2),
        (c) => b.iput('dark', new THREE.CylinderGeometry(0.055, 0.055, 0.16, 8), s * (wall - 0.08), r.floorY + 0.07, c, 0, 0, Math.PI / 2));
    });
    place(b, [
      bx(s * (wall - 0.09), r.floorY + 1.45, r.z1 - 0.9, 0.16, 0.66, 0.62),
      bx(s * (wall - 0.09), r.floorY + 1.45, r.z0 + 0.9, 0.16, 0.66, 0.62),
    ], (f) => {
      const mz = (f.z0 + f.z1) / 2;
      b.ibox('dark', 0.06, 0.60, 0.54, s * (wall - 0.06), r.floorY + 1.45, mz, 0, 1);
      b.ibox('glow', 0.02, 0.30, 0.44, s * (wall - 0.10), r.floorY + 1.56, mz, 0, 1);
      b.ibox('crate', 0.03, 0.16, 0.34, s * (wall - 0.10), r.floorY + 1.28, mz, 0, 1);
      b.ibox('accent', 0.05, 0.03, 0.46, s * (wall - 0.10), r.floorY + 1.18, mz, 0, 1);
    });
  }

  /* ── Coiled lashing gear on a rack, and the overheads ─────────────── */
  for (const s of [-1, 1]) {
    place(b, [bx(s * (wall - 0.22), r.floorY + 2.9, r.z0 + 0.75, 0.5, 0.7, 0.8)], (f) => {
      const gz = (f.z0 + f.z1) / 2;
      b.ibox('trim', 0.42, 0.05, 0.7, s * (wall - 0.22), r.floorY + 2.62, gz, 0, 1);
      for (let i = 0; i < 3; i++) {
        b.iput('tarp', new THREE.TorusGeometry(0.11, 0.038, 4, 10),
          s * (wall - 0.22), r.floorY + 2.72, gz - 0.24 + i * 0.24, 0, Math.PI / 2);
      }
      b.ibox('dark', 0.06, 0.3, 0.06, s * (wall - 0.03), r.floorY + 2.75, gz, 0, 1);
    });
  }
  conduit(b, r, -1);
  conduit(b, r, 1);
}

/**
 * AN ENGINE ROOM: a powerplant with mass and plumbing, gratings, heat shielding,
 * tools left out.
 *
 * The block is already here as one dark box. Everything below is bolted to it,
 * run off it, or left lying about it — found through `partIn` so the plumbing
 * meets the casing wherever the casing actually is.
 */
function fitEngine(b, r) {
  const wall = r.hw - 0.14;
  const zc = (r.z0 + r.z1) / 2;

  /* ── The powerplant ───────────────────────────────────────────────── */
  const core = b.partIn(bx(0, r.floorY + 0.9, zc, r.hw * 1.8, 1.9, (r.z1 - r.z0) * 0.7));
  if (core && core.hx * 2 > 0.9 && core.hy * 2 > 0.9) {
    const cz = core.cz, cx = core.cx;
    const top = core.y1;
    // The access panel, dogged shut, on the flank the room has room in front of.
    for (const s of [-1, 1]) {
      dress(b, core, [bx(cx + s * (core.hx + 0.05), (core.y0 + top) / 2 + 0.08, cz + core.hz * 0.3, 0.12, 0.8, 0.8)], () => {
        const px = cx + s * (core.hx + 0.022);
        b.ibox('trim', 0.03, 0.72, 0.72, px, (core.y0 + top) / 2 + 0.08, cz + core.hz * 0.3, 0, 1);
        for (const a of [-1, 1]) {
          for (const c of [-1, 1]) {
            b.ibox('accent', 0.045, 0.07, 0.07, px + s * 0.02, (core.y0 + top) / 2 + 0.08 + a * 0.28, cz + core.hz * 0.3 + c * 0.28, 0, 1);
          }
        }
        b.ibox('danger', 0.015, 0.06, 0.26, px + s * 0.03, (core.y0 + top) / 2 + 0.42, cz + core.hz * 0.3, 0, 1);
      });
      // A gauge cluster and a hand valve on the other flank.
      dress(b, core, [bx(cx + s * (core.hx + 0.12), top - 0.26, cz - core.hz * 0.45, 0.3, 0.42, 0.5)], () => {
        const gx = cx + s * (core.hx + 0.03);
        b.ibox('dark', 0.05, 0.34, 0.44, gx, top - 0.26, cz - core.hz * 0.45, 0, 1);
        for (let i = 0; i < 2; i++) {
          b.iput('warn', new THREE.CylinderGeometry(0.055, 0.055, 0.02, 10),
            gx + s * 0.035, top - 0.16 - i * 0.18, cz - core.hz * 0.45 - 0.1, 0, 0, Math.PI / 2);
          b.iput('glow', new THREE.CylinderGeometry(0.05, 0.05, 0.02, 10),
            gx + s * 0.035, top - 0.16 - i * 0.18, cz - core.hz * 0.45 + 0.11, 0, 0, Math.PI / 2);
        }
      });
    }
    // The lit core slot, and a placard under it.
    dress(b, core, [bx(cx, top - 0.3, core.z1 + 0.05, core.hx * 1.2, 0.4, 0.14)], () => {
      b.ibox('dark', core.hx * 1.1, 0.30, 0.05, cx, top - 0.3, core.z1 + 0.025, 0, 1);
      /* Five short bars rather than one long one. A 2 m emissive slot at this
       * material's intensity is the brightest thing in the compartment and has
       * no structure to read; five reads as a core running. */
      for (let i = 0; i < 5; i++) {
        b.ibox('warn', core.hx * 0.13, 0.13, 0.02, cx + (i - 2) * core.hx * 0.20, top - 0.3, core.z1 + 0.05, 0, 1);
      }
    });
    // Pipework off the crown to both bulkheads, with a valve on each run.
    for (const s of [-1, 1]) {
      const px = cx + s * core.hx * 0.55;
      dress(b, core, [bx(px, top + 0.42, (cz + (s > 0 ? r.z1 : r.z0)) / 2, 0.24, 0.3, Math.abs(r.z1 - r.z0) * 0.4)], (f) => {
        pipeRun(b, 'z', f.z0 + 0.05, f.z1 - 0.05, px, top + 0.42, 0.065, 'accent');
        valve(b, px, top + 0.42, (f.z0 + f.z1) / 2 + 0.3, 0.11);
      });
    }
    /* Casing bands and cooling fins LAST, because they are the only things on
     * this block that can go anywhere. The access panel has to be on a face the
     * room has standing room in front of and the gauges have to be where they
     * can be read; a band spaced to miss both is still a band. */
    // Casing bands round the drum.
    for (let i = 0; i < 3; i++) {
      const z = cz - core.hz * 0.55 + i * core.hz * 0.55;
      dress(b, core, [bx(cx, (core.y0 + top) / 2, z, core.hx * 2 + 0.12, top - core.y0, 0.14)], () => {
        for (const s of [-1, 1]) {
          b.ibox('accent', 0.06, top - core.y0 - 0.06, 0.12, cx + s * (core.hx + 0.028), (core.y0 + top) / 2, z, 0, 1);
        }
        b.ibox('accent', core.hx * 2 + 0.10, 0.06, 0.12, cx, top + 0.028, z, 0, 1);
      });
    }
    // Cooling fins along the crown.
    bays(b, cz - core.hz + 0.2, cz + core.hz - 0.2, 0.17,
      (c) => bx(cx, top + 0.13, c, core.hx * 1.5, 0.24, 0.08),
      (c) => b.ibox('dark', core.hx * 1.4, 0.20, 0.05, cx, top + 0.12, c, 0, 1));
    if (solidHere(r, top + 0.3)) {
      b.solid(cx, (r.floorY + top + 0.3) / 2, cz, core.hx + 0.1, (top + 0.3 - r.floorY) / 2, core.hz + 0.06);
    }
  }

  /* ── A bench with a vice, and tools left out ──────────────────────── */
  for (const s of [-1, 1]) {
    const bw = Math.min(0.52, r.hw * 0.32);
    const bd = Math.min(1.5, (r.z1 - r.z0) * 0.32);
    place(b, [
      bx(s * (wall - bw / 2), r.floorY + 0.46, r.z0 + 0.15 + bd / 2, bw, 0.94, bd),
      bx(s * (wall - bw / 2), r.floorY + 0.46, r.z1 - 0.15 - bd / 2, bw, 0.94, bd),
    ], (f) => {
      const cx = s * (wall - bw / 2), cz = (f.z0 + f.z1) / 2;
      b.ibox('crate', bw, 0.06, bd, cx, r.floorY + 0.89, cz, 0, 1);
      b.ibox('trim', bw - 0.04, 0.06, bd - 0.04, cx, r.floorY + 0.80, cz, 0, 1);
      for (const sg of [-1, 1]) {
        b.ibox('dark', 0.07, 0.82, 0.07, cx, r.floorY + 0.41, cz + sg * (bd / 2 - 0.08), 0, 1);
      }
      b.ibox('trim', bw - 0.06, 0.03, bd - 0.2, cx, r.floorY + 0.28, cz, 0, 1);
      // A vice on the outboard corner, and its handle.
      b.ibox('accent', 0.16, 0.14, 0.16, cx - s * 0.08, r.floorY + 0.99, cz - bd * 0.34, 0, 1);
      b.ibox('dark', 0.09, 0.10, 0.20, cx - s * 0.08, r.floorY + 1.04, cz - bd * 0.34, 0, 1);
      b.ibox('accent', 0.03, 0.03, 0.26, cx - s * 0.08, r.floorY + 0.99, cz - bd * 0.34 + 0.14, 0, 1);
      // Tools and a rag.
      b.ibox('dark', 0.20, 0.025, 0.045, cx, r.floorY + 0.93, cz + bd * 0.10, 0.35, 1);
      b.ibox('dark', 0.16, 0.02, 0.035, cx + s * 0.04, r.floorY + 0.93, cz + bd * 0.2, -0.2, 1);
      b.ibox('tarp', 0.16, 0.03, 0.14, cx - s * 0.05, r.floorY + 0.935, cz + bd * 0.32, 0.4, 1);
      b.ibox('trim', bw - 0.12, 0.05, 0.22, cx, r.floorY + 0.30, cz + bd * 0.28, 0, 1);
      if (solidHere(r, r.floorY + 0.92)) b.solid(cx, r.floorY + 0.46, cz, bw / 2, 0.46, bd / 2);
    });
    // A tool board over it: silhouettes, hooks and what is still hanging on them.
    place(b, [bx(s * (wall - 0.06), r.floorY + 1.42, r.z0 + 1.1, 0.14, 0.72, 0.9)], (f) => {
      const tz = (f.z0 + f.z1) / 2;
      b.ibox('crate', 0.04, 0.66, 0.84, s * (wall - 0.03), r.floorY + 1.42, tz, 0, 1);
      for (let i = 0; i < 5; i++) {
        const z = tz - 0.32 + i * 0.16;
        b.ibox('dark', 0.02, 0.30 + (i % 3) * 0.07, 0.05, s * (wall - 0.056), r.floorY + 1.42, z, 0, 1);
        b.ibox('trim', 0.03, 0.03, 0.04, s * (wall - 0.06), r.floorY + 1.62, z, 0, 1);
      }
      b.ibox('accent', 0.05, 0.16, 0.05, s * (wall - 0.08), r.floorY + 1.30, tz + 0.34, 0, 1);
    });
  }

  /* ── Heat shielding on the aft bulkhead ───────────────────────────── */
  bays(b, -wall + 0.2, wall - 0.2, 0.42,
    (c, w) => bx(c, r.floorY + 1.5, r.z0 + 0.1, w * 0.94, 1.5, 0.14),
    (c, w) => {
      for (let j = 0; j < 4; j++) {
        b.ibox('trim', w * 0.88, 0.34, 0.04, c, r.floorY + 0.95 + j * 0.37, r.z0 + 0.06, 0, 1);
        b.ibox('dark', w * 0.88, 0.03, 0.05, c, r.floorY + 1.13 + j * 0.37, r.z0 + 0.065, 0, 1);
      }
    });

  /* ── Flank plumbing, low, out of the walking envelope ─────────────────
   * In BAYS rather than as one run: the bench, the drum and the hull's own
   * spares crate are all against these flanks, and a single 4 m run either
   * threads all of them or is refused entirely. Flanged sections stop where
   * something is in the way, which is also what plumbing does. */
  for (const s of [-1, 1]) {
    const x = s * (wall - 0.05);
    for (let i = 0; i < 2; i++) {
      const y = r.floorY + 0.18 + i * 0.24;
      bays(b, r.z0 + 0.3, r.z1 - 0.3, 1.15,
        (c, w) => bx(x, y, c, 0.16, 0.16, w * 0.94),
        (c, w) => pipeRun(b, 'z', c - w * 0.45, c + w * 0.45, x, y, 0.055, i ? 'trim' : 'accent'));
    }
    place(b, [
      bx(x - s * 0.12, r.floorY + 0.78, r.z0 + 1.0, 0.32, 0.38, 0.36),
      bx(x - s * 0.12, r.floorY + 0.78, r.z1 - 1.0, 0.32, 0.38, 0.36),
    ], (f) => valve(b, x - s * 0.08, r.floorY + 0.70, (f.z0 + f.z1) / 2, 0.12));
  }

  /* ── A drum, a parts bin, gratings, a bottle, and the overheads ───── */
  for (const s of [-1, 1]) {
    place(b, [bx(s * (wall - 0.32), r.floorY + 0.3, r.z1 - 0.55, 0.6, 0.62, 0.6)], (f) => {
      const dx = (f.x0 + f.x1) / 2, dz = (f.z0 + f.z1) / 2;
      b.iput('accent', new THREE.CylinderGeometry(0.24, 0.24, 0.56, 10), dx, r.floorY + 0.28, dz);
      for (const yy of [0.10, 0.46]) b.iput('dark', new THREE.CylinderGeometry(0.255, 0.255, 0.04, 10), dx, r.floorY + yy, dz);
      b.ibox('warn', 0.2, 0.09, 0.02, dx, r.floorY + 0.34, dz - 0.245, 0, 1);
      if (solidHere(r, r.floorY + 0.56)) b.solid(dx, r.floorY + 0.28, dz, 0.25, 0.28, 0.25);
    });
    place(b, [bx(s * (wall - 0.11), r.floorY + 1.05, r.z1 - 1.3, 0.24, 0.5, 0.26)], () => {
      b.iput('danger', new THREE.CylinderGeometry(0.075, 0.075, 0.36, 8), s * (wall - 0.12), r.floorY + 1.02, r.z1 - 1.3);
      b.ibox('trim', 0.05, 0.04, 0.19, s * (wall - 0.05), r.floorY + 1.10, r.z1 - 1.3, 0, 1);
    });
  }
  deckPanel(b, r, 0, r.z1 - 0.75, Math.min(1.1, r.hw), 0.8);
  deckPanel(b, r, 0, r.z0 + 0.75, Math.min(1.1, r.hw), 0.8);
  conduit(b, r, -1);
  conduit(b, r, 1);
}

/**
 * AN ENTRY BAY: where a crew comes aboard, takes off what it was wearing
 * outside, and hangs it up.
 *
 * A vestibule with nothing in it reads as a corridor the builder ran out of.
 * The Pike's already has a suit locker, a bench and a shelf; this turns them
 * into a place somebody arrives.
 */
function fitEntry(b, r) {
  /* Inboard of the hull's own inner ribs — see the note in `fitHold`. */
  const wall = r.hw - 0.14;

  /* ── Dress the suit locker ────────────────────────────────────────── */
  const lk = b.partIn(bx(0, r.floorY + 0.9, (r.z0 + r.z1) / 2, r.hw * 2, 1.4, (r.z1 - r.z0) * 0.9));
  if (lk && lk.y1 - lk.y0 > 0.9) {
    dressCabinet(b, r, lk);
    const lxm = lk.cx, lzm = lk.cz;
    const side = lxm < 0 ? -1 : 1;
    place(b, [bx(lxm, lk.y1 + 0.14, lzm, lk.hx * 1.7, 0.28, lk.hz * 1.7)], () => {
      // A helmet on the locker top, and a lamp charging beside it.
      b.iput('trim', new THREE.SphereGeometry(0.115, 10, 7), lxm, lk.y1 + 0.11, lzm - lk.hz * 0.3);
      b.ibox('glow', 0.12, 0.06, 0.02, lxm - side * 0.10, lk.y1 + 0.12, lzm - lk.hz * 0.3, 0, 1);
      b.ibox('dark', 0.09, 0.13, 0.09, lxm, lk.y1 + 0.07, lzm + lk.hz * 0.4, 0, 1);
      b.ibox('warn', 0.05, 0.05, 0.02, lxm - side * 0.05, lk.y1 + 0.09, lzm + lk.hz * 0.4, 0, 1);
    });
  }

  /* ── A gear rail with kit hanging off it ──────────────────────────── */
  for (const s of [-1, 1]) {
    place(b, [bx(s * (wall - 0.16), r.floorY + 1.42, (r.z0 + r.z1) / 2 + 0.5, 0.34, 0.7, 1.1)], (f) => {
      const x = s * (wall - 0.1), gz = (f.z0 + f.z1) / 2, gl = f.z1 - f.z0;
      b.ibox('trim', 0.04, 0.04, gl - 0.1, x - s * 0.08, r.floorY + 1.72, gz, 0, 1);
      for (const sg of [-1, 1]) b.ibox('trim', 0.09, 0.04, 0.04, x - s * 0.04, r.floorY + 1.72, gz + sg * (gl / 2 - 0.08), 0, 1);
      for (let i = 0; i < 2; i++) {
        b.iput('tarp', boxGeo(0.11, 0.5, 0.24, 1), x - s * 0.08, r.floorY + 1.42, gz - 0.26 + i * 0.5, 0, 0, s * 0.05);
        b.ibox('accent', 0.03, 0.07, 0.03, x - s * 0.08, r.floorY + 1.70, gz - 0.26 + i * 0.5, 0, 1);
      }
    });
    // A boot rack over a drip tray.
    place(b, [bx(s * (wall - 0.22), r.floorY + 0.13, r.z0 + 0.55, 0.4, 0.3, 0.66)], (f) => {
      const x = (f.x0 + f.x1) / 2, bz = (f.z0 + f.z1) / 2;
      b.ibox('trim', 0.34, 0.03, 0.6, x, r.floorY + 0.03, bz, 0, 1);
      for (const sg of [-1, 1]) b.ibox('dark', 0.34, 0.05, 0.03, x, r.floorY + 0.05, bz + sg * 0.28, 0, 1);
      for (const sg of [-1, 1]) b.ibox('dark', 0.11, 0.17, 0.25, x + sg * 0.07, r.floorY + 0.12, bz - 0.1, sg * 0.1, 1);
    });
    // A fold-down seat, stowed up against the wall.
    place(b, [bx(s * (wall - 0.13), r.floorY + 0.72, r.z1 - 0.7, 0.3, 0.6, 0.52)], (f) => {
      const x = s * (wall - 0.05), sz = (f.z0 + f.z1) / 2;
      b.iput('trim', boxGeo(0.28, 0.04, 0.42, 1), x - s * 0.14, r.floorY + 0.66, sz, 0, 0, s * 1.15);
      b.ibox('dark', 0.05, 0.44, 0.46, x - s * 0.02, r.floorY + 0.72, sz, 0, 1);
      for (const sg of [-1, 1]) b.ibox('accent', 0.06, 0.05, 0.05, x - s * 0.04, r.floorY + 0.90, sz + sg * 0.20, 0, 1);
    });
  }

  /* ── Muster placard, a bottle, chevrons, a grating, grab rails ────── */
  for (const s of [-1, 1]) {
    place(b, [bx(s * (wall - 0.06), r.floorY + 1.72, r.z1 - 0.35, 0.1, 0.26, 0.42)],
      () => placard(b, s * (wall - 0.04), r.floorY + 1.72, r.z1 - 0.35, 0.32, 0.16, 'warn',
        s > 0 ? -Math.PI / 2 : Math.PI / 2));
    place(b, [bx(s * (wall - 0.11), r.floorY + 1.02, r.z0 + 1.5, 0.24, 0.5, 0.26)], () => {
      b.iput('danger', new THREE.CylinderGeometry(0.07, 0.07, 0.34, 8), s * (wall - 0.12), r.floorY + 1.0, r.z0 + 1.5);
      b.ibox('trim', 0.05, 0.04, 0.18, s * (wall - 0.05), r.floorY + 1.08, r.z0 + 1.5, 0, 1);
    });
    place(b, [bx(s * (wall - 0.07), r.floorY + 1.42, (r.z0 + r.z1) / 2 - 0.8, 0.12, 0.12, 0.8)],
      () => grab(b, 'z', s * (wall - 0.07), r.floorY + 1.42, (r.z0 + r.z1) / 2 - 0.8, 0.74));
  }
  deckPanel(b, r, 0, (r.z0 + r.z1) / 2, Math.min(0.8, r.hw * 1.2), 0.9);
  conduit(b, r, 1);
}

/**
 * A GUN BAY: 1.50 m of clear height, so everything in here is knee-high and
 * everything hugs one side.
 *
 * The compartment's own comment records why: a 0.5 m ammunition run across the
 * full 1.6 m of it covers 88% of the plan, and because it is drawn and not
 * collided that is 88% of a room the player crawls straight through. The lane
 * down the port side stays 0.7 m clear, so nothing below is built at negative X
 * except what is lying on the deck.
 */
function fitGunbay(b, r) {
  const gun = b.partIn(bx(0, r.floorY + 0.9, (r.z0 + r.z1) / 2 + (r.z1 - r.z0) * 0.25,
    r.hw * 2, 0.8, (r.z1 - r.z0) * 0.5));
  if (gun) {
    const gx = gun.cx, gz = gun.cz;
    // The barrel through the forward bulkhead, and its trunnion.
    dress(b, gun, [bx(gx, gun.cy, gun.z1 + 0.22, 0.3, 0.3, 0.42)], () => {
      b.iput('dark', new THREE.CylinderGeometry(0.085, 0.10, 0.42, 8), gx, gun.cy, gun.z1 + 0.2, 0, Math.PI / 2);
      b.iput('accent', new THREE.CylinderGeometry(0.12, 0.12, 0.07, 8), gx, gun.cy, gun.z1 + 0.05, 0, Math.PI / 2);
    });
    // A charging handle and a sighting head on the breech.
    dress(b, gun, [bx(gx, gun.y1 + 0.11, gz, gun.hx * 1.6, 0.24, gun.hz * 1.1)], () => {
      b.ibox('dark', 0.1, 0.13, 0.16, gx, gun.y1 + 0.07, gz - gun.hz * 0.4, 0, 1);
      b.ibox('glow', 0.05, 0.03, 0.05, gx, gun.y1 + 0.13, gz - gun.hz * 0.4, 0, 1);
      b.ibox('accent', 0.05, 0.05, 0.22, gx, gun.y1 + 0.06, gz + gun.hz * 0.35, 0, 1);
      b.ibox('trim', 0.04, 0.1, 0.04, gx, gun.y1 + 0.11, gz + gun.hz * 0.55, 0, 1);
    });
    // The feed chute, dropping from the ammunition run into the breech.
    dress(b, gun, [bx(gx, gun.y0 - 0.06, gun.z0 - 0.16, gun.hx * 1.4, 0.3, 0.3)], () => {
      b.iput('trim', boxGeo(gun.hx * 1.2, 0.32, 0.1, 1), gx, gun.y0 - 0.02, gun.z0 - 0.14, 0, 0.5);
      for (let i = 0; i < 3; i++) {
        b.ibox('accent', gun.hx * 0.9, 0.035, 0.035, gx, gun.y0 + 0.06 - i * 0.06, gun.z0 - 0.10 - i * 0.05, 0, 1);
      }
    });
  }

  /* ── Shells standing in the ammunition run ────────────────────────── */
  const run = b.partIn(bx(0, r.floorY + 0.25, (r.z0 + r.z1) / 2, r.hw * 2, 0.5, (r.z1 - r.z0) * 0.9));
  if (run && run.hz * 2 > 1.0) {
    bays(b, run.z0 + 0.18, run.z1 - 0.18, 0.22,
      (c) => bx(run.cx, run.y1 + 0.1, c, run.hx * 1.4, 0.16, 0.16),
      (c, w, i) => {
        const sx = run.cx + ((i % 2) - 0.5) * run.hx * 0.7;
        b.iput('accent', new THREE.CylinderGeometry(0.035, 0.035, 0.14, 6), sx, run.y1 + 0.07, c);
        b.iput('warn', new THREE.CylinderGeometry(0.03, 0.012, 0.05, 6), sx, run.y1 + 0.165, c);
      });
    /* A spent-case bin, aft of the run if there is room and outboard of it if
     * there is not.
     *
     * ── Why there are two candidates and there used to be one ─────────────
     * The bay's only entrance is a crouch hole in its aft bulkhead, and
     * `wallX` reserves 0.6 m of crawl approach in front of it. When the
     * ammunition run moved forward to clear that approach, the bin's single
     * site went with it and landed inside the reserve — so `place` correctly
     * refused it, and the compartment lost 13 of its 65 required `accent`
     * triangles with nothing saying why. A fitting with one candidate site is
     * a fitting that disappears the first time anything near it moves. */
    place(b, [
      bx(run.cx, r.floorY + 0.15, run.z0 - 0.3, run.hx * 1.6, 0.34, 0.42),
      bx(-run.cx, r.floorY + 0.15, run.cz + run.hz * 0.55, run.hx * 1.6, 0.34, 0.42),
    ], (f) => {
      const bxc = (f.x0 + f.x1) / 2, bz = (f.z0 + f.z1) / 2;
      b.ibox('dark', run.hx * 1.4, 0.28, 0.36, bxc, r.floorY + 0.14, bz, 0, 1);
      b.ibox('accent', run.hx * 1.5, 0.03, 0.38, bxc, r.floorY + 0.29, bz, 0, 1);
      for (let i = 0; i < 3; i++) {
        b.iput('accent', new THREE.CylinderGeometry(0.026, 0.026, 0.1, 6), bxc - 0.05 + i * 0.05, r.floorY + 0.33, bz - 0.06 + i * 0.05, 0, 0, 1.2 + i * 0.4);
      }
    });
  }

  /* ── The crawl: knee pads on the mat, a lit placard at head height ── */
  const mat = b.partIn(bx(0, r.floorY + 0.04, (r.z0 + r.z1) / 2, r.hw * 2, 0.14, (r.z1 - r.z0) * 0.9));
  if (mat) {
    dress(b, mat, [bx(mat.cx, mat.y1 + 0.03, mat.cz - mat.hz * 0.3, mat.hx * 1.6, 0.08, 0.4)], () => {
      for (const sg of [-1, 1]) {
        b.ibox('tarp', 0.16, 0.045, 0.2, mat.cx + sg * mat.hx * 0.45, mat.y1 + 0.025, mat.cz - mat.hz * 0.3, 0, 1);
      }
    });
  }
  for (const s of [-1, 1]) {
    place(b, [bx(s * (r.hw - 0.06), r.floorY + 1.1, r.z0 + 0.55, 0.1, 0.22, 0.34)],
      () => placard(b, s * (r.hw - 0.05), r.floorY + 1.1, r.z0 + 0.55, 0.24, 0.12, 'danger',
        s > 0 ? -Math.PI / 2 : Math.PI / 2));
  }
}

/** Which fit-out each published compartment id gets. */
const FIT = {
  cockpit: fitCockpit,
  cabin: fitCabin,
  hold: fitHold,
  engine: fitEngine,
  entry: fitEntry,
  gunbay: fitGunbay,
};

/**
 * Fit out every compartment a hull published.
 *
 * Called by `DockWorld._buildShips` with whatever the hull builder returned, so
 * this pass sees the finished shell and every doorway, flight and lift it cut.
 * A compartment whose `id` has no fit-out is COUNTED rather than ignored: a new
 * room type added to a hull should show up as a room with nothing in it in the
 * one place that would notice, not as a silently empty box.
 *
 * @param {ShipBuild} b
 * @param {Array<{id:string,hw:number,z0:number,z1:number,floorY:number,ceilY:number}>} rooms
 * @returns {{placed:number, refused:number, unknown:string[]}}
 */
export function fitOut(b, rooms) {
  b.fitStats = { placed: 0, refused: 0, unknown: [] };
  for (const r of rooms ?? []) {
    const f = FIT[r.id];
    if (!f) { b.fitStats.unknown.push(r.id); continue; }
    f(b, r);
  }
  return b.fitStats;
}
