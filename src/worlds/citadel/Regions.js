/**
 * THE SIX REGIONS OF THE OUTER RING - authored against the measured body.
 *
 * ── What this file is for ─────────────────────────────────────────────────
 *
 * `terrain/CitadelHeight.js` raised five landforms in the ring and the extent
 * stage proved they were in budget. Nothing stood on any of them. This file is
 * the content: a lower town, a quarry, an aqueduct, a monastery, a ruin and a
 * caravan camp, each sitting at a declared point on one difficulty curve that
 * runs outward from the mesa.
 *
 * ── The one rule everything here obeys ────────────────────────────────────
 *
 * **A GAP IS DERIVED FROM THE BODY, NEVER CHOSEN.**
 *
 * Drop Two measured the old souk and found `pearson(ring, gap) = 0.1485` and a
 * mean gap of 2.01 m against a 4.65 m sprint jump: two thirds of a "difficulty
 * gradient" was a walk, because the gaps were three independent random terms
 * and nobody had ever measured what came out. The souk's answer was to solve
 * `w` from the gap instead of discovering the gap from `w`, and this file does
 * the same thing one step earlier: it solves the GAP from the trajectory.
 *
 * `jumpSpan(budget, rise)` flies `Player.fixedUpdate`'s real integrator - the
 * one that applies gravity BEFORE the move, so every rise loses |g|dt^2/2 and
 * the closed form is wrong by 5 cm, which is a ledge - and reports how far the
 * body has travelled on the last step it is still `rise` metres above where it
 * left. `gapFor` subtracts what the landing costs and what the tier is allowed
 * to keep in hand. Every gap in the ring is that number. Change the tier, or
 * change the rise, and the geometry moves; nothing here is a literal that a
 * later edit can drift away from the body that has to cross it.
 *
 * ── Height is authored too, and that is the other half of the lesson ──────
 *
 * The same measurement found **189 of 340 souk edges one-way**, because height
 * noise inside a ring exceeded what a jump gains. Re-authoring gaps alone would
 * have reproduced that exactly. So every deck height in this file is an
 * ABSOLUTE authored number and the plinth under it absorbs whatever the terrain
 * is doing: a block's decks are `deck0` plus an authored saw-tooth, the rise
 * between neighbours is therefore known before anything is built, and the gap
 * is solved for the UPHILL direction. Both directions of every crossing inside
 * a block are then routes, by construction rather than by luck.
 *
 * ── The curve ─────────────────────────────────────────────────────────────
 *
 * Six tiers, ordered by how far a player is likely to be into the world when
 * they meet them rather than by distance from the origin - all six landforms
 * sit at roughly the same radius, so "outward from the mesa" has to be read as
 * a route, not as a radius. `TIERS` is that ordering and it is what the region
 * table indexes.
 *
 * ── What is deliberately NOT here ─────────────────────────────────────────
 *
 * No parapets on any deck a route crosses. A 0.55 m parapet is under the leap's
 * 1.109 m apex and reads as decoration, but `flyArc` resolves the feet arriving
 * INSIDE a solid as `blocked` and it wins over a landing lower in the column -
 * so a ring of parapet round every roof turns a measured route into a wall on
 * the descending half of the arc. Roof furniture (vents, stair heads, chimneys)
 * is emitted as VISUAL geometry with no collider wherever it stands on a route.
 */

import { CONFIG } from '../../core/Config.js';

const TAU = Math.PI * 2;

/* ================================================================== */
/* The movement envelope. Measured in a browser; do NOT recompute.     */
/* ================================================================== */

/** `Player.fixedUpdate`'s tick. */
export const DT = 1 / 60;
/** `Config.player.gravity`. */
export const GRAVITY = -22;

/**
 * The three budgets a body can leave a deck with, and what the real integrator
 * produces from each on flat ground.
 *
 * `flat` and `apex` are the figures measured live in a browser and re-derived
 * by `scripts/tests/citadel-reach.test.mjs`'s first test. They are carried here
 * so `jumpSpan` can be checked against them rather than believed.
 */
export const BUDGETS = Object.freeze({
  walk: Object.freeze({ id: 'walk', v: 6.4, h: 4.6, flat: 2.607, apex: 0.878 }),
  sprint: Object.freeze({ id: 'sprint', v: 6.4, h: 8.2, flat: 4.647, apex: 0.878 }),
  leap: Object.freeze({ id: 'leap', v: 6.4 * 1.12, h: 8.2 * 1.42, flat: 7.569, apex: 1.109 }),
});

/** Drop at which fall damage first appears, and the one that kills outright. */
export const FALL_DAMAGE_M = 7.5;
export const FALL_LETHAL_M = 40.0;
/** Continuous ascent one stamina bar buys. */
export const CLIMB_SUSTAIN_M = 29.3;
/**
 * `NPC.GROUND_PROBE_UP`: the tallest step an NPC's ground-follower absorbs.
 *
 * NOT the player's. Kept because the ring's NPC routing is still described
 * against it, and renamed nowhere so the two are never confused again: what a
 * FLIGHT is authored against is `PLAYER_STEP` below.
 */
export const STEP_UP = 0.95;

/**
 * The tallest riser a player's own legs take, from the engine that takes it.
 *
 * `Player._move` accepts a tread when `treadY <= prev.y + P.stepHeight + 0.01`
 * and nothing else in the game raises that. Imported rather than copied,
 * because every number in this file that a body has to obey is imported.
 */
export const PLAYER_STEP = CONFIG.player.stepHeight;

/** What `helix` keeps in hand between its solved target and `PLAYER_STEP`. */
const HELIX_MARGIN = 0.02;

/**
 * What a landing costs, in metres of the arc's run.
 *
 * Three separate terms, and every one of them is somebody else's constant:
 *
 *   0.40  `LANDING_MARGIN` - how far inside the target deck the feet must come
 *         down for `arcClears` to call it an arrival rather than a fall. The
 *         arc is flown as a POINT, so this also stands in for the 0.33 m the
 *         capsule is wide.
 *   0.05  the inset `padPerimeter` uses when it picks launch points, so the
 *         body leaves from just inside its own edge rather than from the edge.
 *   0.10  one step of the integrator at the slowest budget (4.6 m/s x 1/60 =
 *         0.077 m), rounded up. `jumpSpan` reports the LAST step still above
 *         the target height, and the landing itself happens between that step
 *         and the next.
 */
export const LAND_COST = 0.55;

/**
 * How far a body has travelled on the last integrator step it is still `rise`
 * metres above its takeoff.
 *
 * THE CLOSED FORM IS WRONG AND THIS IS WHY THE FUNCTION EXISTS. `Player.
 * fixedUpdate` applies gravity before `_move` integrates, so the first step of
 * every rise is taken at `v0 + g*dt` and the trajectory permanently loses
 * |g|dt^2/2. `v^2/2g` gives a 0.93 m apex for a jump; the body gets 0.878 m,
 * and five centimetres is a ledge band a leap does not clear.
 *
 * Returns `NaN` when the budget never gets that high - which is the honest
 * answer for "how far can I jump onto something 1.2 m up" at any budget but the
 * leap, and it is why `gapFor` throws rather than quietly emitting a gap
 * nothing can cross.
 *
 * @param {{v:number,h:number}} budget
 * @param {number} rise metres the target deck stands above the takeoff deck;
 *   negative for a drop.
 * @returns {number} metres of horizontal run, or `NaN`
 */
export function jumpSpan(budget, rise) {
  let y = 0;
  let vy = budget.v;
  let dist = 0;
  let last = NaN;
  let falling = false;
  for (let n = 1; n <= 240; n++) {
    vy += GRAVITY * DT;
    if (vy < -60) vy = -60;                 // `Player`'s terminal velocity
    y += vy * DT;
    dist += budget.h * DT;
    if (vy < 0) falling = true;
    if (y >= rise) last = dist;
    else if (falling) break;
  }
  return last;
}

/**
 * The widest gap a body on `budget` can cross onto a deck `rise` metres up.
 *
 * `slack` is the only taste in the whole file and it is what a tier means: how
 * much of the budget the author refuses to spend. Tier 0 keeps half a metre in
 * hand so a caravan camp is a stroll; tier 5 keeps 0.12 m, which is a jump you
 * have to mean.
 *
 * @param {{v:number,h:number}} budget
 * @param {number} rise
 * @param {number} slack metres held back from the ceiling
 */
export function gapFor(budget, rise, slack) {
  const span = jumpSpan(budget, rise);
  if (!Number.isFinite(span)) {
    throw new Error(`gapFor: ${budget.id} cannot reach a deck ${rise} m up (apex ${budget.apex})`);
  }
  const gap = span - LAND_COST - slack;
  if (gap <= 0.6) {
    throw new Error(`gapFor: ${budget.id} at rise ${rise} slack ${slack} leaves ${gap.toFixed(2)} m: a stride, not a jump`);
  }
  return gap;
}

/**
 * THE DIFFICULTY CURVE, ORDERED.
 *
 * `order` is the position on the curve and it is what "the curve runs outward
 * from the mesa" actually means here: all six landforms sit at r = 280-420, so
 * a radius cannot order them. A ROUTE can. The caravanserai is where a player
 * arrives first because it is the one region a horse crosses the flats to; the
 * Eyrie is last because it is on the far side of the aqueduct and 26 m of
 * climb above its own approach.
 *
 * `rises` is the saw-tooth a block's decks step through, in metres. The gap
 * between two neighbours is then solved for whichever of the two is higher, so
 * both directions of every crossing are routes and the histogram has no
 * one-way edges in it by construction.
 */
export const TIERS = Object.freeze([
  Object.freeze({
    order: 0, id: 'rest', budget: BUDGETS.walk, slack: 0.50,
    rises: Object.freeze([0, 0.20, 0, 0.35]),
    note: 'a stroll: every crossing inside a standing walk jump',
  }),
  Object.freeze({
    order: 1, id: 'teach', budget: BUDGETS.sprint, slack: 0.42,
    rises: Object.freeze([0, 0.30, 0, 0.45]),
    note: 'the sprint jump, taught: too wide to walk, well inside a run',
  }),
  Object.freeze({
    order: 2, id: 'commit', budget: BUDGETS.sprint, slack: 0.16,
    rises: Object.freeze([0, 0.45, 0.20, 0.60]),
    note: 'the sprint jump at its limit; a misjudged run-up falls',
  }),
  Object.freeze({
    order: 3, id: 'span', budget: BUDGETS.leap, slack: 0.45,
    rises: Object.freeze([0, 0.40, 0.20, 0.55]),
    note: 'the leap, required: no sprint jump on this route reaches',
  }),
  Object.freeze({
    order: 4, id: 'broken', budget: BUDGETS.leap, slack: 0.26,
    rises: Object.freeze([0, 0.55, 0.30, 0.80]),
    note: 'the leap over broken ground, with the step-up eating the margin',
  }),
  Object.freeze({
    order: 5, id: 'test', budget: BUDGETS.leap, slack: 0.12,
    rises: Object.freeze([0, 0.70, 0.35, 0.95]),
    note: 'the leap at its ceiling, and a mantle where the step beats the apex',
  }),
]);
export const TIER = Object.freeze(Object.fromEntries(TIERS.map((t) => [t.id, t])));

/* ================================================================== */
/* The kit: what a region is built out of                              */
/* ================================================================== */

/**
 * Roof-lip overhang, total across a footprint, and how thick the lip is.
 *
 * The souk's `SOUK_LIP` for the same reason: the lip is the ledge a body
 * mantles onto and it is the footprint every gap in this file is measured
 * between, so it has to be a real collider standing proud of the wall rather
 * than the top face of the wall itself.
 */
export const LIP = 0.7;
export const LIP_T = 0.5;
/** How far a plinth is driven below the lowest ground under its own footprint. */
export const PLINTH_SINK = 1.2;
/** Shortest wall a plot may have between its plinth and its lip. */
export const MIN_STOREY = 2.4;

/** Nine sample points over a footprint, in units of its own half-extents. */
const FOOT_SAMPLES = [
  [-1, -1], [1, -1], [-1, 1], [1, 1], [0, 0],
  [-1, 0], [1, 0], [0, -1], [0, 1],
];

/**
 * One region under construction.
 *
 * Holds nothing but the host's callbacks and the report it is filling in, so a
 * region function below reads as a description of a place rather than as
 * plumbing.
 */
export class RegionSite {
  /**
   * @param {object} ctx host callbacks - see `CitadelWorld._buildRegions`
   * @param {object} spec the row from `REGIONS`
   */
  constructor(ctx, spec) {
    this.ctx = ctx;
    this.spec = spec;
    this.tier = TIERS[spec.tier];
    /** Every deck this region published, in build order. */
    this.decks = [];
    /** Every authored crossing: `{gap, rise, budget, kind}`. */
    this.crossings = [];
    /** Every flight of steps, as `{steps, rise, length, from, to}`. */
    this.stairs = [];
    /** Every authored drop a route takes downward: `{fall, kind, hay}`. */
    this.drops = [];
    this.min = { x: Infinity, y: Infinity, z: Infinity };
    this.max = { x: -Infinity, y: -Infinity, z: -Infinity };
    this.groundLo = Infinity;
    this.groundHi = -Infinity;
    this.pieces = 0;
    this.colliders = 0;
    this._sliceMark = 0;
    this.worstSlice = 0;
  }

  /** Widen the region's own AABB. */
  _grew(x, y, z, hx, hy, hz) {
    if (x - hx < this.min.x) this.min.x = x - hx;
    if (x + hx > this.max.x) this.max.x = x + hx;
    if (y - hy < this.min.y) this.min.y = y - hy;
    if (y + hy > this.max.y) this.max.y = y + hy;
    if (z - hz < this.min.z) this.min.z = z - hz;
    if (z + hz > this.max.z) this.max.z = z + hz;
  }

  /** Terrain height, remembered, so the region can report its own relief. */
  ground(x, z) {
    const h = this.ctx.ground(x, z);
    if (h < this.groundLo) this.groundLo = h;
    if (h > this.groundHi) this.groundHi = h;
    return h;
  }

  /** Highest terrain anywhere under a footprint, sampled on the same nine. */
  groundOver(x, z, w, d, rot) {
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    let hi = -Infinity;
    for (const u of FOOT_SAMPLES) {
      const lx = u[0] * w * 0.5;
      const lz = u[1] * d * 0.5;
      const h = this.ground(x + lx * c + lz * s, z - lx * s + lz * c);
      if (h > hi) hi = h;
    }
    return hi;
  }

  /** Lowest terrain anywhere under a footprint, sampled on nine points. */
  groundUnder(x, z, w, d, rot) {
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    let lo = Infinity;
    for (const u of FOOT_SAMPLES) {
      const lx = u[0] * w * 0.5;
      const lz = u[1] * d * 0.5;
      const h = this.ground(x + lx * c + lz * s, z - lx * s + lz * c);
      if (h < lo) lo = h;
    }
    return lo;
  }

  /** A visual box with no collider. Roof furniture, and nothing a route needs. */
  shell(key, w, h, d, x, y, z, rot = 0, tint = null) {
    this.ctx.box(key, w, h, d, x, y, z, rot, tint);
    this.pieces++;
  }

  /** A visual box that is also solid. */
  piece(key, w, h, d, x, y, z, rot = 0, tint = null) {
    this.ctx.box(key, w, h, d, x, y, z, rot, tint);
    this.ctx.solid(x, y, z, w * 0.5, h * 0.5, d * 0.5, rot);
    this.pieces++;
    this.colliders++;
    this._grew(x, y, z, w * 0.5, h * 0.5, d * 0.5);
  }

  /**
   * A building with a walkable roof whose lip top is EXACTLY `deck`.
   *
   * The plinth is what makes that possible: it runs from `PLINTH_SINK` below
   * the lowest ground under the footprint up to the lip, so the terrain never
   * gets a vote on the deck height. That is the whole trick behind every
   * authored rise in this file - a deck sampled off the ground carries the
   * ground's noise into the jump, which is the defect that made 189 of 340
   * souk edges one-way.
   */
  plot({ x, z, w, d, rot = 0, deck, key = 'plaster.wall', tint = 0xdccba6,
    roofKey = 'stone.castle', roofTint = 0xc6b58f, label = null, kind = 'plot',
    from = null }) {
    const lo = this.groundUnder(x, z, w, d, rot);
    const base = from === null ? lo - PLINTH_SINK : from;
    const wallTop = deck - LIP_T;
    const h = wallTop - base;
    if (h < MIN_STOREY) {
      throw new Error(`${this.spec.id}: plot at (${x.toFixed(1)}, ${z.toFixed(1)}) has a ${h.toFixed(2)} m wall - deck ${deck.toFixed(2)} against ground ${lo.toFixed(2)}`);
    }
    this.piece(key, w, h, d, x, (base + wallTop) * 0.5, z, rot, tint);
    this.piece(roofKey, w + LIP, LIP_T, d + LIP, x, deck - LIP_T * 0.5, z, rot, roofTint);
    const rec = {
      x, y: deck, z, w, d, rot, kind,
      region: this.spec.id, anchor: { x, y: deck, z },
    };
    if (label) rec.label = label;
    this.decks.push(rec);
    this.ctx.roofs.push(rec);
    return rec;
  }

  /**
   * A free-standing platform: a deck on legs, with no room under it to enter.
   *
   * Used for gantries, aqueduct spans and pilgrim ledges - anywhere the deck is
   * the point and a building underneath it would be a lie. The legs are VISUAL
   * ONLY, and that is not laziness: a leg is never a route, and a collider
   * hanging under a deck is one more thing `flyArc` can resolve as `blocked`
   * on an arc that was passing underneath.
   */
  slab({ x, z, w, d, rot = 0, top, thick = 0.6, key = 'wood.plank', tint = 0x8a6a44,
    legs = true, legKey = 'wood.beam', legTint = 0x6a5133, legInset = 0.9,
    register = true, kind = 'slab' }) {
    this.piece(key, w, thick, d, x, top - thick * 0.5, z, rot, tint);
    if (legs) {
      const c = Math.cos(rot);
      const s = Math.sin(rot);
      const lx = Math.max(0.3, w * 0.5 - legInset);
      const lz = Math.max(0.3, d * 0.5 - legInset);
      for (const u of [[-lx, -lz], [lx, -lz], [-lx, lz], [lx, lz]]) {
        const px = x + u[0] * c + u[1] * s;
        const pz = z - u[0] * s + u[1] * c;
        const g = this.ground(px, pz);
        const legTop = top - thick;
        const hh = legTop - (g - 1.0);
        if (hh < 0.5) continue;
        this.shell(legKey, 0.44, hh, 0.44, px, legTop - hh * 0.5, pz, rot, legTint);
      }
    }
    const rec = {
      x, y: top, z, w, d, rot, kind,
      region: this.spec.id, anchor: { x, y: top, z },
    };
    this.decks.push(rec);
    if (register) this.ctx.roofs.push(rec);
    return rec;
  }

  /** Highest terrain anywhere under a straight run, sampled every metre. */
  maxGround({ x, z, dirX, dirZ, length, width }) {
    const n = Math.max(2, Math.ceil(length));
    const px = -dirZ;
    const pz = dirX;
    let hi = -Infinity;
    for (let i = 0; i <= n; i++) {
      const s = -length * 0.5 + (length * i) / n;
      for (const t of [-0.5, 0, 0.5]) {
        const h = this.ground(x + dirX * s + px * width * t, z + dirZ * s + pz * width * t);
        if (h > hi) hi = h;
      }
    }
    return hi;
  }

  /**
   * A walkable flight of steps, every riser inside the PLAYER's step.
   *
   * This is what makes a one-way descent a place rather than a trap. The
   * terraces, the pit and the aqueduct all drop further than a body can jump
   * back up, and every one of them gets a flight.
   *
   * ── THE CONSTANT THIS WAS AUTHORED AGAINST WAS THE WRONG BODY ───────────
   *
   * It said "every riser inside `STEP_UP`", and `STEP_UP` is 0.95 quoted from
   * `NPC.GROUND_PROBE_UP` - how far a wandering NPC's ground-follower will
   * absorb before it re-plants its feet. It is not what a player can step.
   * `Player._move` takes a tread only when
   *
   *     treadY <= prev.y + CONFIG.player.stepHeight + 0.01
   *
   * and `CONFIG.player.stepHeight` is 0.45. So the file's default riser of
   * 0.82 was 0.37 m OVER a step - and 0.82 is also under `Climb`'s
   * `MIN_RISE_GROUND` = 1.0, so no mantle was offered either. The only way up
   * any of these flights was to jump every tread (`parkour` apex 0.878).
   *
   * Measured on the built ring before this changed: THIRTY-SIX flights, every
   * one of them, risers 0.679 to 0.810 m. Not one was walkable. That is the
   * same defect the ward stair carried at 0.600 m, six regions wide, and
   * `citadel-reach.test.mjs` was green throughout because its own flood also
   * quoted 0.95.
   *
   * ── The repair: more treads, same total run, same pitch ────────────────
   *
   * `rise` and `run` stay what they always were - the flight's PITCH - and the
   * riser is clamped to the player's step with the going scaled to match, so
   * `rise / run` is bit-for-bit unchanged and a flight occupies the same
   * ground it always did. The default 0.82 / 1.30 becomes 0.45 / 0.713, which
   * is 32.24 degrees either way. Treads double and overlap by the same
   * fraction of their pitch (`tread = going * 1.6`), so the collision surface
   * is continuous exactly as before.
   *
   * The alternative - keep the riser and hide a ramp proxy under it - is the
   * one the ward stair refused for the reason that still holds: a proxy puts
   * the collision surface off the drawn treads, and drawn and solid staying
   * identical is what `riser-legality.test.mjs` is able to check.
   */
  stair({ x, z, dirX, dirZ, fromY, toY, width = 2.6, rise = 0.82, run = 1.3,
    key = 'stone.castle', tint = 0xb9a884, anchorTop = false }) {
    const climb = toY - fromY;
    /* Clamp the riser to the body, and take the going with it so the pitch a
     * caller authored survives. A caller that already asks for a legal riser
     * is untouched: `riser === rise` leaves `going === run`. */
    const riser = Math.min(rise, PLAYER_STEP);
    const going = riser === rise ? run : run * (riser / rise);
    const steps = Math.max(1, Math.ceil(Math.abs(climb) / riser));
    const dy = climb / steps;
    if (Math.abs(dy) > PLAYER_STEP + 1e-9) {
      throw new Error(`${this.spec.id}: stair riser ${dy.toFixed(2)} m exceeds the player's step ${PLAYER_STEP}`);
    }
    const rot = Math.atan2(-dirZ, dirX);
    const tread = going * 1.6;
    /* `anchorTop` puts `(x, z)` at the HEAD of the flight rather than its foot.
     * Every stair in this file exists to reach a deck whose edge is already
     * known, and computing the foot backwards from the head is the only way
     * the top tread lands the same distance from the lip whatever the climb
     * turns out to be. */
    if (anchorTop) {
      x -= dirX * steps * going;
      z -= dirZ * steps * going;
    }
    for (let i = 0; i < steps; i++) {
      const s = (i + 0.5) * going;
      const px = x + dirX * s;
      const pz = z + dirZ * s;
      const top = fromY + dy * (i + 1);
      const lo = this.groundUnder(px, pz, tread, width, rot) - PLINTH_SINK;
      const h = Math.max(0.5, top - lo);
      this.piece(key, tread, h, width, px, top - h * 0.5, pz, rot, tint);
      /* PUBLISHED, and this is not bookkeeping.
       *
       * `ReachGraph` takes its terrain nodes from a 6 m lattice, and a tread is
       * 1.3 m of run: a whole flight can fall between two darts, and the two
       * darts that do land on it are 6 m and 3.7 m of height apart, which is no
       * walk edge at any limit. Measured before this line existed, five of the
       * Deepworks' decks and all three of Ashfall's fallen floors reported
       * "you can get there, you cannot get back" - and the way back was a
       * flight of steps standing right there in the collider set, invisible.
       * A world that builds stairs has to say where they are. */
      this.ctx.steps?.push({ x: px, y: top, z: pz, w: tread, d: width, rot, region: this.spec.id });
    }
    const rec = {
      steps,
      rise: dy,
      going,
      length: steps * going,
      foot: { x, y: fromY, z },
      top: { x: x + dirX * steps * going, y: toY, z: z + dirZ * steps * going },
    };
    this.stairs.push(rec);
    return rec;
  }

  /**
   * A flight that FOLLOWS the rock instead of cutting across it.
   *
   * ── Why a straight stair cannot climb this face ──────────────────────────
   *
   * `stair` lays treads on a fixed pitch and a fixed riser, and plinths each
   * one down to its own ground. On flat or gently sloping ground that is a
   * staircase. On the karst face - `smoothstep(28, 12, d)` over 26 m, a
   * gradient of 2.6 at its middle - the ground climbs faster than any legal
   * riser, so every tread past the third is BURIED: `top - groundUnder` goes
   * negative, the box collapses to its 0.5 m minimum, and the flight is a row
   * of stones inside a mountain.
   *
   * The first cut of this region hit the same wall from the other side: twelve
   * ledges spaced evenly in radius and evenly in height, against a face that
   * is an S-curve. Measured, ledges 8 through 11 and both storeys of the Eyrie
   * sat up to 4 m inside the rock and every one of them reported "you can get
   * down from here, you cannot get up".
   *
   * So the path is solved rather than authored. At each tread the radius step
   * is chosen so the ROCK rises by `rise`, clamped, and the rest of the pitch
   * is spent going round; the tread stands `proud` above whatever the rock
   * turns out to be there. Where the face is steep the ramp wraps the peak
   * almost tangentially and where it eases it drives straight in - which is
   * what a pilgrim stair cut into a mountain does, and it is the only shape
   * that keeps every riser inside `STEP_UP` on ground this steep.
   *
   * @returns {{treads:number, rise:{min:number,max:number}, top:{x,y,z}, turns:number}}
   */
  helix({ cx, cz, dStart, dStop, theta0, spin = 1, rise = 0.80, pitch = 1.5,
    tread = 2.4, width = 3.0, proud = 0.55, key = 'stone.castle', tint = 0xb0a184,
    maxTreads = 60 }) {
    /* Same correction `stair` carries, and for the same reason: this flight
     * was solved against a 0.70 m rock gain per tread and a player steps 0.45.
     * Measured before this line existed, the Pilgrim Stair's 38 treads rose
     * 0.700 m apiece - a jump every tread, up 26 m, on the region whose whole
     * verb is SUSTAINED CLIMB.
     *
     * The riser is clamped to the body and the going scaled with it, so the
     * path's slope is unchanged and the flight wraps the peak exactly as far
     * as it did; `maxTreads` is scaled by the same ratio so the cap still
     * stops the same runaway rather than truncating the fix.
     *
     * `HELIX_MARGIN` and not zero: `stair`'s riser is arithmetic (`climb /
     * steps`) and lands exactly where it is put, but this one is DISCOVERED -
     * the bisect solves for a rock gain and the tread is then built from a
     * second probe at the settled angle, so the two disagree by a little. Aim
     * at 0.45 and the built flight comes out at 0.450, on the wrong side of
     * the gate by a rounding error. Two centimetres is the same order of
     * margin the ward stair left (0.021) and it is spent once, at the target,
     * rather than by loosening what the gate accepts. */
    const ratio = rise > PLAYER_STEP - HELIX_MARGIN ? (PLAYER_STEP - HELIX_MARGIN) / rise : 1;
    rise *= ratio;
    pitch *= ratio;
    tread *= ratio;
    maxTreads = Math.ceil(maxTreads / ratio);
    let d = dStart;
    let th = theta0;
    let prevTop = null;
    let lo = Infinity;
    let hi = -Infinity;
    let n = 0;
    let last = null;
    for (; n < maxTreads && d > dStop; n++) {
      /* How far in this tread has to reach for the rock to gain `rise`.
       * Bisected on the real field, not differentiated: the face is a
       * smoothstep and its gradient swings by a factor of five along it. */
      /* Bisect on the SAME quantity the tread is then built from - the lowest
       * rock anywhere under a tread-sized footprint, not the rock at its
       * centre. Solving one and building the other is how the first attempt
       * came out with a 0.95 m riser against a 0.95 m limit: the nine-point
       * footprint minimum lags the centre by up to 0.3 m on a 2.6 gradient,
       * and the whole margin is in that lag. */
      const probe = (dd2, th2) => this.groundUnder(
        cx + Math.cos(th2) * dd2, cz + Math.sin(th2) * dd2, tread, width, 0
      );
      const here = probe(d, th);
      let step = 0.15;
      let hiS = 3.5;
      for (let i = 0; i < 26; i++) {
        const mid = (step + hiS) * 0.5;
        const t2 = th + (spin * Math.sqrt(Math.max(0.36, pitch * pitch - mid * mid))) / Math.max(1, d - mid);
        if (probe(d - mid, t2) - here < rise) step = mid; else hiS = mid;
      }
      const dd = Math.min(Math.max(step, 0.15), Math.min(3.0, d - dStop));
      const tang = Math.sqrt(Math.max(0.36, pitch * pitch - dd * dd));
      d -= dd;
      th += (spin * tang) / Math.max(1, d);
      const px = cx + Math.cos(th) * d;
      const pz = cz + Math.sin(th) * d;
      const top = this.groundUnder(px, pz, tread, width, 0) + proud;
      if (prevTop !== null) {
        const step2 = Math.abs(top - prevTop);
        if (step2 < lo) lo = step2;
        if (step2 > hi) hi = step2;
        if (step2 > PLAYER_STEP + 1e-9) {
          throw new Error(`${this.spec.id}: helix riser ${step2.toFixed(2)} m exceeds the player's step ${PLAYER_STEP}`);
        }
      }
      prevTop = top;
      const rot = Math.atan2(-Math.cos(th) * spin, -Math.sin(th) * spin);
      const base = this.groundUnder(px, pz, tread, width, rot) - PLINTH_SINK;
      this.piece(key, tread, Math.max(0.5, top - base), width, px, top - Math.max(0.5, top - base) * 0.5, pz, rot, tint);
      this.ctx.steps?.push({ x: px, y: top, z: pz, w: tread, d: width, rot, region: this.spec.id });
      last = { x: px, y: top, z: pz };
    }
    const rec = { treads: n, rise: { min: lo, max: hi }, top: last, turns: Math.abs(th - theta0) / TAU };
    this.stairs.push({ steps: n, rise: hi, length: n * pitch, foot: null, top: last, helix: true });
    return rec;
  }

  /** A haystack that catches: the thatch, its collider, and the published entry. */
  hay({ x, z, r = 3.2, on = null }) {
    const y = on === null ? this.ground(x, z) : on;
    const bw = r * 1.625;
    this.ctx.box('thatch.roof', bw, 2.4, bw, x, y + 1.2, z, this.ctx.rnd() * 0.4, 0xd8bd6e);
    this.ctx.solid(x, y + 1.0, z, bw * 0.5, 1.0, bw * 0.5, 0);
    this.pieces++;
    this.colliders++;
    this._grew(x, y + 1.0, z, bw * 0.5, 1.0, bw * 0.5);
    const rec = { x, y: y + 2.4, z, r, region: this.spec.id };
    this.ctx.haystacks.push(rec);
    return rec;
  }

  /**
   * Yield to the frame, and reset the slice's collider count.
   *
   * C5's budget is 250 colliders between two yields - the quantity, not the
   * wall clock, because a 24 ms assertion passes alone and fails under a
   * 24-way parallel runner. Every region calls this at a phase boundary and
   * `regionSlices` in the report records what the worst one cost.
   */
  async breathe() {
    if (this.colliders - this._sliceMark > (this.worstSlice ?? 0)) {
      this.worstSlice = this.colliders - this._sliceMark;
    }
    this._sliceMark = this.colliders;
    await this.ctx.breathe();
  }

  /**
   * Record an authored crossing, so the report can be checked against the world.
   *
   * `a` and `b` are the two deck records, carried rather than described:
   * `citadel-regions.test.mjs` re-measures every one of these with
   * `footprintGap` against the built colliders and flies both directions with
   * `takeoffFan`, and a crossing that only said "3.13 m somewhere in the
   * Undercliff" could not be checked at all.
   */
  crossing(gap, rise, kind, a = null, b = null) {
    this.crossings.push({ gap, rise, budget: this.tier.budget.id, kind, a, b });
  }

  /** Record an authored one-way descent and whether hay answers it. */
  drop(fall, kind, hay) {
    this.drops.push({ fall, kind, hay: !!hay });
  }

  /**
   * A straight run of buildings with authored decks and solved gaps.
   *
   * `dirX, dirZ` is the unit direction the row runs in; `w` is the extent ALONG
   * it and `d` across it, which is what makes every gap in the row a gap
   * between two parallel lips rather than a quantity that swings with compass
   * bearing - the third of the three faults the old souk was rebuilt to end.
   */
  row({ x, z, dirX, dirZ, n, w, d, deck0, key, tint, roofKey, roofTint,
    kind = 'row', label = null, riseAt = null }) {
    const T = this.tier;
    const R = riseAt ?? T.rises;
    /* Every entry in the tier's saw-tooth gets used, in order, so a row of
     * five plots produces four DIFFERENT rises rather than one repeated twice.
     * `rises[0]` is 0 in every tier, which is what makes `deck0` the datum. */
    const decks = new Array(n);
    for (let i = 0; i < n; i++) decks[i] = deck0 + R[i % R.length];
    const gaps = new Array(Math.max(0, n - 1));
    let span = 0;
    for (let i = 0; i < n - 1; i++) {
      gaps[i] = gapFor(T.budget, Math.abs(decks[i + 1] - decks[i]), T.slack);
      span += gaps[i] + w + LIP;
    }
    const rot = Math.atan2(-dirZ, dirX);
    let s = -span * 0.5;
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push(this.plot({
        x: x + dirX * s, z: z + dirZ * s, w, d, rot, deck: decks[i],
        key, tint, roofKey, roofTint, kind,
        label: label && i === 0 ? label : null,
      }));
      if (i > 0) {
        this.crossing(gaps[i - 1], Math.abs(decks[i] - decks[i - 1]), kind, out[i - 1], out[i]);
      }
      if (i < n - 1) s += w + LIP + gaps[i];
    }
    return { plots: out, gaps, decks, span, dirX, dirZ, rot };
  }

  /**
   * A tower: stacked storeys, each 0.7 m narrower per side than the one below.
   *
   * The taper is not a silhouette decision, it is what makes the tower
   * CLIMBABLE in the graph. `ReachGraph` samples a deck's perimeter 0.45 m
   * OUTSIDE its own footprint and asks what is in the column there; a stack of
   * equal-width storeys answers "nothing", and every gallery above the first
   * becomes an island. 0.7 m per side clears that by 0.25 m, so each storey's
   * lip stands over the one below and the whole stack chains - which is exactly
   * what the minarets' balcony rings do on the mesa.
   */
  tower({ x, z, w, rot = 0, deck0, levels, levelH, key = 'stone.castle',
    tint = 0xc9b993, roofKey = 'stone.castle', roofTint = 0xd6c69c, label = null, taper = 1.4 }) {
    let prev = null;
    for (let i = 0; i < levels; i++) {
      const lw = w - i * taper;
      const deck = deck0 + i * levelH;
      if (levelH > CLIMB_SUSTAIN_M) {
        throw new Error(`${this.spec.id}: tower storey ${levelH} m exceeds one stamina bar`);
      }
      prev = this.plot({
        x, z, w: lw, d: lw, rot, deck, key, tint, roofKey, roofTint,
        kind: 'tower', label: i === levels - 1 ? label : null,
        from: i === 0 ? null : deck0 + (i - 1) * levelH - LIP_T,
      });
    }
    this.ctx.towers.push({ x, y: prev.y, z, r: prev.w * 0.5, region: this.spec.id });
    return prev;
  }

  /**
   * A viewpoint, with the haystack that answers whatever it offers.
   *
   * `launch` and `hay` published TOGETHER are what `Viewpoints.
   * normaliseViewpoint` reads as "this viewpoint has a leap of faith", and it
   * raises the prompt the moment a body stands within 3 m of the launch point.
   * So a region only passes `launch` when the arc from that point on that
   * bearing has been FLOWN against the built colliders and lands in the hay -
   * the four minarets are the standing lesson in what happens otherwise. The
   * flying is done in `scripts/tests/citadel-regions.test.mjs`; what is
   * authored here is the offer, and the test is what makes it true.
   */
  viewpoint({ id, name, x, y, z, r, bearing, launch = null, hayRun, hayR = 3.4, hayOn = null }) {
    /* `r` is the SYNC platform, and `Viewpoints` adds `SYNC_PAD` to it before
     * asking whether a body is on it. `citadel-discovery.test.mjs` holds the
     * pair to 4.5 m across, because a viewpoint narrower than that is one a
     * running player passes through between two fixed steps without ever
     * triggering. Callers pass the deck's own lip half-width, which is the
     * thing the feet are actually on. */
    const ox = launch ? launch.x : x;
    const oz = launch ? launch.z : z;
    const hx = ox + Math.cos(bearing) * hayRun;
    const hz = oz + Math.sin(bearing) * hayRun;
    const hay = this.hay({ x: hx, z: hz, r: hayR, on: hayOn });
    const vp = { id, name, x, y, z, r, bearing, hay, region: this.spec.id };
    if (launch) vp.launch = launch;
    this.ctx.viewpoints.push(vp);
    return vp;
  }
}

/* ================================================================== */
/* THE CARAVANSERAI - tier 0, the flats                                */
/* ================================================================== */

/**
 * The dune pan at (342, 296), and the one thing on this map that is a REST.
 *
 * A difficulty curve needs a bottom or its top means nothing, and every other
 * region in the ring is a test of something. So the serai is a walled court on
 * the flattest ground in the world - `DUNES.panGrip` levels 94% of a 30 m disc
 * to 12.6-12.9 m - with four low ranges round it, every crossing inside a
 * STANDING walk jump, and a mast in the corner that is the cheapest viewpoint
 * in the ring to reach.
 *
 * It is also the mounted region. `duneLift` is deliberately 4.2 m of crest on a
 * 5.4 m swell because the first pass built the dune boxes six metres tall and
 * the test horse spawned against one and could not move; the court sits in the
 * pan for the same reason, so a rider can get in and out of it.
 */
async function buildCaravanserai(site) {
  const cx = 342;
  const cz = 296;
  const deck = 17.2;
  const W = 7.0;
  const D = 8.0;

  // Four ranges round a 52 x 48 m court. The court itself stays empty: it is
  // where a caravan stands, and it is the only open ground in the ring big
  // enough to bring a mount to a halt in.
  const north = site.row({ x: cx, z: cz - 24, dirX: 1, dirZ: 0, n: 5, w: W, d: D, deck0: deck, kind: 'range', label: 'The Caravanserai' });
  const south = site.row({ x: cx, z: cz + 24, dirX: 1, dirZ: 0, n: 5, w: W, d: D, deck0: deck, kind: 'range' });
  const west = site.row({ x: cx - 24, z: cz, dirX: 0, dirZ: 1, n: 4, w: W, d: D, deck0: deck + 0.4, kind: 'range' });
  const east = site.row({ x: cx + 24, z: cz, dirX: 0, dirZ: 1, n: 4, w: W, d: D, deck0: deck + 0.4, kind: 'range' });
  await site.breathe();

  // Stairs up from the court, one against each range, laid from the DECK back
  // so the head always lands the same distance off the lip.
  const lipHalf = (D + LIP) * 0.5;
  site.stair({ x: cx, z: cz - 24 + lipHalf + 0.5, dirX: 0, dirZ: -1, fromY: site.ground(cx, cz - 14), toY: deck, anchorTop: true });
  site.stair({ x: cx, z: cz + 24 - lipHalf - 0.5, dirX: 0, dirZ: 1, fromY: site.ground(cx, cz + 14), toY: deck, anchorTop: true });
  site.stair({ x: cx - 24 + lipHalf + 0.5, z: cz, dirX: -1, dirZ: 0, fromY: site.ground(cx - 14, cz), toY: deck + 0.4, anchorTop: true });
  site.stair({ x: cx + 24 - lipHalf - 0.5, z: cz, dirX: 1, dirZ: 0, fromY: site.ground(cx + 14, cz), toY: deck + 0.4, anchorTop: true });

  /* The well, the awnings and the water trough. Visual only where they stand
   * in the court, because the court is the one piece of ground in this world a
   * horse is expected to cross without picking its way. */
  await site.breathe();
  const gy = site.ground(cx, cz);
  site.piece('stone.cobble', 3.2, 1.1, 3.2, cx, gy + 0.55, cz, 0.3, 0xbfb094);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU + 0.2;
    const px = cx + Math.cos(a) * 13.5;
    const pz = cz + Math.sin(a) * 13.5;
    const g = site.ground(px, pz);
    site.shell('fabric.banner', 4.6, 0.12, 4.6, px, g + 2.8, pz, a, i % 2 ? 0xb8452f : 0xc98a2a);
    for (const u of [[-2.1, -2.1], [2.1, -2.1], [-2.1, 2.1], [2.1, 2.1]]) {
      site.shell('wood.beam', 0.16, 2.8, 0.16, px + u[0], g + 1.4, pz + u[1], a, 0x6a4f31);
    }
  }

  /* The mast: four storeys in the north-east corner, and the whole point of it
   * is that it is the cheapest high place in the ring. A player who has never
   * left the mesa can walk here across flat sand, take four flights of stairs
   * and a walk jump, and be 15 m over the desert. */
  await site.breathe();
  const mx = cx + 24;
  const mz = cz - 24;
  /* Five storeys, not four. `citadel-discovery.test.mjs` refuses a viewpoint
   * under y = 30 - "that is not a vantage point" - and the pan this stands on
   * is the lowest ground any region occupies, so four storeys put the mast at
   * 28.0 m. The fifth is what makes it one, and the extra width keeps the top
   * storey a platform rather than a post after four tapers. */
  const mast = site.tower({ x: mx, z: mz, w: 11.6, deck0: deck, levels: 5, levelH: 3.6, label: 'The Caravan Mast' });
  site.stair({ x: mx, z: mz + (11.6 + LIP) * 0.5 + 0.5, dirX: 0, dirZ: -1, fromY: site.ground(mx, mz + 14), toY: deck, anchorTop: true });
  /* No `launch`: the drop from the mast to the pan is 15.0 m, which is damage
   * rather than death, and a leap-of-faith prompt on a fall a player survives
   * anyway is the minaret mistake in a different costume. The hay is here for
   * a missed landing off the top gallery, which is what a tier-0 region owes
   * somebody still learning the verb. */
  site.viewpoint({
    id: 'caravan-mast', name: 'The Caravan Mast',
    x: mx, y: mast.y, z: mz, r: (mast.w + LIP) * 0.5,
    /* Into the court, not along the range. The first placement ran the hay
     * north from the mast and landed it on the east range's own roof 2.58 m
     * below its recorded height, which `Parkour._softLandingAt` cannot credit -
     * the identical failure design 1.1 records for all five mesa viewpoints,
     * reproduced on the first new one built. The court is the one piece of open
     * ground in this region and the hay belongs in it. */
    bearing: 2.394, hayRun: 20.0, hayR: 3.4,
  });

  return { rows: [north, south, west, east], mast };
}

/**
 * Where a body launched at `fromY` on `bearing` comes back down to the ground.
 *
 * Solved against the integrator and the terrain, then iterated three times
 * because the ground under the landing is itself a function of how far the run
 * turns out to be. This is how every haystack in the ring gets its distance,
 * and it is the direct answer to the defect §1.1 of the design records: the
 * old hay was placed on a bearing derived from where a tower happened to stand
 * and at a run nobody had flown, and eight of eleven did not catch.
 *
 * It is still only half the job. The arc flown here knows about the terrain and
 * nothing else; `citadel-regions.test.mjs` flies the same arc through
 * `flyArc` against the finished collider set, which is the half that can see a
 * roof in the way.
 */
function leapRun(site, ox, oz, fromY, bearing) {
  let run = 12;
  for (let i = 0; i < 4; i++) {
    const g = site.ground(ox + Math.cos(bearing) * run, oz + Math.sin(bearing) * run);
    const next = jumpSpan(BUDGETS.leap, g - fromY);
    if (!Number.isFinite(next)) break;
    run = next;
  }
  return run;
}

/* ================================================================== */
/* THE UNDERCLIFF - tier 1, the terraced lower town                    */
/* ================================================================== */

/**
 * Four benches stepping down and out from the mesa's southern foot, and the
 * region that TEACHES.
 *
 * The terrain gives the shape: a walk-up ramp out of the desert (measured peak
 * gradient 0.547 against a 0.678 walk limit) onto a 20 m shelf that then falls
 * away outward in four 5 m risers. The town is laid along the OUTER edge of
 * each bench, three blocks to a terrace, so every terrace looks down on the
 * street of the next one.
 *
 * ── The verb, and what it costs to author ─────────────────────────────────
 *
 * Descent. Roof to roof inside a terrace is a sprint jump; terrace to terrace
 * is not a jump at all - the bench pitch is 32 m and no budget in the game
 * crosses that - it is a DROP of 10-13 m onto the street below, which is past
 * `FALL_DAMAGE_M` 7.5 and nowhere near `FALL_LETHAL_M` 40. So every one of
 * those edges gets hay, on the line it is taken from, and the descent becomes a
 * route the player chooses rather than a mistake.
 *
 * The way back up is a flight of steps on each riser, two per riser, at 0.82 m
 * a tread. That is not a courtesy either: a one-way town is a town a player
 * visits once.
 */
async function buildUndercliff(site) {
  const A = Math.PI * 0.5;                 // the sector is centred on +Z
  const BEARINGS = [-0.16, 0, 0.16];
  /* One CONTINUOUS row per terrace, at the OUTER edge of its own bench.
   *
   * The first cut broke each terrace into three blocks of five with a 19.4 m
   * alley between them, which reads well and is unrunnable: 19.4 m is past
   * every budget in the game and past the 26 m radius the trial route graph
   * even looks in, so the Undercliff's own venue had a leg with no path over
   * the decks at all. A nine-plot row spans 80.8 m of arc - 0.254 rad at
   * r = 322, comfortably inside the shelf's 0.68 rad window - and every
   * crossing on it is the authored tier-1 sprint jump.
   *
   * 322 and not 318 because the bench runs 302..328: at 322 a nine-metre deep
   * footprint still lands on the flat and its outer lip overlooks the riser,
   * which is what makes the drop to the next street the region's own verb
   * rather than a mistake. */
  const RADII = [322, 354, 386, 418];
  const W = 6.4;
  const D = 8.4;
  const terraces = [];

  for (let k = 0; k < RADII.length; k++) {
    const r = RADII[k];
    const a = A;
    const cxx = Math.cos(a) * r;
    const czz = Math.sin(a) * r;
    const dirX = -Math.sin(a);
    const dirZ = Math.cos(a);
    const hi = site.maxGround({ x: cxx, z: czz, dirX, dirZ, length: 84, width: D });
    const row = site.row({
      x: cxx, z: czz, dirX, dirZ, n: 9, w: W, d: D,
      deck0: hi + 4.6, kind: `terrace-${k}`,
      label: k === 0 ? 'The Undercliff' : null,
    });
    terraces.push({ r, rows: [row], row });
    await site.breathe();
  }

  /* Hay on the street of the next bench down, under the line every outer roof
   * edge drops onto. `RADII[k] + 20` puts it on the flat of bench k+1 rather
   * than on the riser between them, and the last terrace drops onto the open
   * apron at r = 434. */
  for (let k = 0; k < RADII.length; k++) {
    for (const db of BEARINGS) {
      const a = A + db;
      /* Offset 0.055 rad off the block bearing, which at r = 338 is 18.6 m of
       * arc. The hay used to sit dead on it, and dead on it is where the NEXT
       * terrace's access stair runs: haystack 13 measured its own surface 1.12 m
       * below itself, standing inside a flight of steps. */
      const hr = RADII[k] + 16;
      const hx = Math.cos(a + 0.055) * hr;
      const hz = Math.sin(a + 0.055) * hr;
      const deck = terraces[k].row.decks[0];
      site.hay({ x: hx, z: hz, r: 3.6 });
      site.drop(deck - site.ground(hx, hz), `terrace-${k}-to-street`, true);
    }
  }

  /* Two flights on every riser, one either side of the middle block. The
   * riser runs from `302 + 32k + 26` to `302 + 32k + 32`; the flight is laid
   * from the lower bench up to the higher one across the whole of it. */
  await site.breathe();
  for (let k = 0; k < 3; k++) {
    for (const db of [-0.09, 0.09]) {
      const a = A + db;
      const rLo = 340 + k * 32;
      const rHi = 326 + k * 32;
      const foot = { x: Math.cos(a) * rLo, z: Math.sin(a) * rLo };
      const head = { x: Math.cos(a) * rHi, z: Math.sin(a) * rHi };
      site.stair({
        x: head.x, z: head.z,
        dirX: -Math.cos(a), dirZ: -Math.sin(a),
        fromY: site.ground(foot.x, foot.z), toY: site.ground(head.x, head.z),
        width: 3.0, rise: 0.78, run: 1.35, anchorTop: true,
      });
    }
  }

  await site.breathe();
  /* Stairs from each bench street up onto its own terrace, two per row. */
  for (let k = 0; k < RADII.length; k++) {
    for (const db of [-0.09, 0.09]) {
      const a = A + db;
      const deck = terraces[k].row.decks[0];
      const rHead = RADII[k] - (D + LIP) * 0.5 - 0.6;
      const hx = Math.cos(a) * rHead;
      const hz = Math.sin(a) * rHead;
      site.stair({
        x: hx, z: hz, dirX: Math.cos(a), dirZ: Math.sin(a),
        fromY: site.ground(Math.cos(a) * (rHead - 10), Math.sin(a) * (rHead - 10)),
        toY: deck, width: 2.8, anchorTop: true,
      });
    }
  }

  /* The watchtower, on the sector's eastern edge where nothing is built, so the
   * leap of faith has 22 m of clear air under it and lands on bench 1's street
   * rather than on somebody's roof. */
  await site.breathe();
  const ta = A + 0.30;
  const tr = 316;
  const tx = Math.cos(ta) * tr;
  const tz = Math.sin(ta) * tr;
  const tBase = site.maxGround({ x: tx, z: tz, dirX: 1, dirZ: 0, length: 9, width: 9 }) + 5.0;
  const tower = site.tower({
    x: tx, z: tz, w: 11.6, deck0: tBase, levels: 5, levelH: 4.2,
    label: 'The Undercliff Watch',
  });
  site.stair({
    x: tx - Math.cos(ta) * ((11.6 + LIP) * 0.5 + 0.6), z: tz - Math.sin(ta) * ((11.6 + LIP) * 0.5 + 0.6),
    dirX: Math.cos(ta), dirZ: Math.sin(ta),
    fromY: site.ground(tx - Math.cos(ta) * 12, tz - Math.sin(ta) * 12), toY: tBase,
    width: 2.8, anchorTop: true,
  });
  const launch = {
    x: tx + Math.cos(ta) * (tower.w * 0.5 - 0.4),
    y: tower.y,
    z: tz + Math.sin(ta) * (tower.w * 0.5 - 0.4),
  };
  const run = leapRun(site, launch.x, launch.z, tower.y, ta);
  site.viewpoint({
    id: 'undercliff-watch', name: 'The Undercliff Watch',
    x: tx, y: tower.y, z: tz, r: (tower.w + LIP) * 0.5,
    bearing: ta, launch, hayRun: run, hayR: 4.0,
  });

  return { terraces, tower, leap: run };
}

/* ================================================================== */
/* THE QUARRY AND DEEPWORKS - tier 2, vertical DOWN                    */
/* ================================================================== */

/**
 * A benched pit cut into a raised crown at (325, -96), and the one place in
 * this world that teaches DOWN.
 *
 * Every height in the old playfield is a roof you climb to; the pit inverts it.
 * The descent is the content - a gantry chain hung off the rim, eight timber
 * platforms 2.9 m apart, each drop inside `FALL_DAMAGE_M` 7.5 so the whole way
 * down is free - and the way back out is the difficulty, which is one 25-tread
 * flight up the pit wall.
 *
 * ── The gantry chain is one-way, and that is authored ─────────────────────
 *
 * 2.9 m is over the leap's 1.109 m apex, so no budget climbs it: the chain
 * reads DOWN only. That is deliberate and it is the shape of a mine. What it is
 * not allowed to be is a trap, so the pit floor, both benches and the rim are
 * joined by a flight of steps at 0.80 m a tread, which the graph links with
 * plain walk edges in both directions.
 *
 * ── Why the rim buildings stand outside the pit lip ───────────────────────
 *
 * `QUARRY.crown` is 58 and `QUARRY.pitR` is 54, so there are exactly four
 * metres of solid rock between the rim of the pit and the head of the outer
 * slope. A 7.5 m deep building put on that lip straddles the rim. The rim rows
 * are therefore at d = 64, on the outer slope, where the ground falls 25.9 to
 * 24.8 across their own footprint and the plinth absorbs it.
 */
async function buildQuarry(site) {
  const QX = 325;
  const QZ = -96;
  const at = (d, a) => ({ x: QX + Math.cos(a) * d, z: QZ + Math.sin(a) * d });
  const tang = (a) => ({ dirX: -Math.sin(a), dirZ: Math.cos(a) });

  const rows = [];
  /** One straight row on a circle of radius `d` about the pit centre. */
  const ring = (d, a, n, w, dep, clear, kind, label) => {
    const p = at(d, a);
    const t = tang(a);
    const hi = site.maxGround({ x: p.x, z: p.z, dirX: t.dirX, dirZ: t.dirZ, length: 30, width: dep });
    const r = site.row({
      x: p.x, z: p.z, dirX: t.dirX, dirZ: t.dirZ, n, w, d: dep,
      deck0: hi + clear, kind, label,
      key: 'stone.castle', tint: 0xbcae8c, roofKey: 'wood.plank', roofTint: 0x8f6f4a,
    });
    rows.push(r);
    return r;
  };

  // The surface works, on the outer slope where a cart could stand.
  const rimA = ring(64, 0.75, 4, 6.0, 7.5, 4.8, 'rim', 'The Deepworks');
  const rimB = ring(64, 3.90, 4, 6.0, 7.5, 4.8, 'rim', null);
  // The two benches, and the yard on the floor.
  await site.breathe();
  const benchA = ring(38, 1.60, 3, 5.5, 6.0, 4.4, 'bench-1', null);
  const benchB = ring(26, 4.70, 3, 5.5, 6.0, 4.4, 'bench-2', null);
  const yard = ring(9, 2.60, 3, 5.5, 6.0, 4.4, 'floor', null);

  /* The gantry chain: eight platforms spiralling into the pit off the rim lip.
   * The angular step is 0.10 rad and not the 0.30 the first cut used, because
   * 0.30 at d = 40 is twelve metres of arc and no drop makes twelve metres a
   * platform - it makes it a fall into the pit wall. */
  await site.breathe();
  const gantry = [];
  const gA = 5.55;
  let prevTop = null;
  for (let k = 0; k < 7; k++) {
    const d = 53 - k * 6.5;
    const a = gA + k * 0.10;
    const p = at(d, a);
    const rot = -a;
    /* THE PLATFORM STANDS ON WHAT IS THERE, and the first cut did not.
     *
     * The gantry was authored as eight platforms 2.9 m apart on a straight
     * line from 26.5 down to 6.2, against a pit that is a STEPPED cone: three
     * benches at 26.1 / 19.4 / 12.8 / 6.1 with a 5 m riser between each. Five
     * of the eight came out buried - 355.2, 351.3 and 342.0 measured their deck
     * as the bench ABOVE them - and the trial venue built on them had three
     * checkpoints standing inside rock. Reading the ground and standing 1.7 m
     * proud of the HIGHEST rock under its own footprint puts every platform over
     * the drop it is meant to hang over - the lowest was tried first and buried
     * the uphill half of every platform standing on a riser, where the ground
     * moves five metres across a five-metre slab -
     * and the fall between two of them becomes whatever the pit is doing there:
     * 0.1 m on a bench, 6.6 m over a riser, all of it inside the 7.5 m where
     * fall damage starts. */
    const top = site.groundOver(p.x, p.z, 5.0, 5.0, rot) + 1.7;
    gantry.push(site.slab({
      x: p.x, z: p.z, w: 5.0, d: 5.0, rot, top, thick: 0.55, kind: 'gantry',
    }));
    if (prevTop !== null) {
      const fall = prevTop - top;
      if (fall > FALL_DAMAGE_M) {
        throw new Error(`${site.spec.id}: gantry drop ${fall.toFixed(2)} m takes damage`);
      }
      site.drop(fall, 'gantry', false);
    }
    prevTop = top;
  }

  /* The way out. One flight from the floor to the crown lip, 42 m of run for
   * 20 m of climb: 25 treads at 0.80, which is inside `STEP_UP` 0.95 with
   * 0.15 m to spare. */
  await site.breathe();
  const sA = 2.05;
  const foot = at(14, sA);
  site.stair({
    x: foot.x, z: foot.z,
    dirX: Math.cos(sA), dirZ: Math.sin(sA),
    fromY: site.ground(foot.x, foot.z),
    toY: site.ground(at(56, sA).x, at(56, sA).z),
    width: 3.2, rise: 0.80, run: 1.68,
  });
  // And a short flight from the crown out to the rim buildings' decks.
  for (const [a, row] of [[0.75, rimA], [3.90, rimB]]) {
    const head = at(64 - (7.5 + LIP) * 0.5 - 0.6, a);
    site.stair({
      x: head.x, z: head.z, dirX: Math.cos(a), dirZ: Math.sin(a),
      fromY: site.ground(at(48, a).x, at(48, a).z), toY: row.decks[0],
      width: 2.8, anchorTop: true,
    });
  }

  /* The headframe: the winding tower over the shaft, and the one thing in the
   * Deepworks visible from the flats. */
  await site.breathe();
  const hA = 2.20;
  const hp = at(66, hA);
  const hBase = site.maxGround({ x: hp.x, z: hp.z, dirX: 1, dirZ: 0, length: 9, width: 9 }) + 5.0;
  const head = site.tower({
    x: hp.x, z: hp.z, w: 10.4, deck0: hBase, levels: 4, levelH: 4.5,
    key: 'wood.beam', tint: 0x8a6a44, roofKey: 'wood.plank', roofTint: 0x9a7a52,
    label: 'The Headframe',
  });
  site.stair({
    x: hp.x - Math.cos(hA) * ((10.4 + LIP) * 0.5 + 0.6), z: hp.z - Math.sin(hA) * ((10.4 + LIP) * 0.5 + 0.6),
    dirX: Math.cos(hA), dirZ: Math.sin(hA),
    fromY: site.ground(at(54, hA).x, at(54, hA).z), toY: hBase, width: 2.8, anchorTop: true,
  });
  const launch = {
    x: hp.x + Math.cos(hA) * (head.w * 0.5 - 0.4),
    y: head.y,
    z: hp.z + Math.sin(hA) * (head.w * 0.5 - 0.4),
  };
  const run = leapRun(site, launch.x, launch.z, head.y, hA);
  site.viewpoint({
    id: 'deepworks-headframe', name: 'The Headframe',
    x: hp.x, y: head.y, z: hp.z, r: (head.w + LIP) * 0.5,
    bearing: hA, launch, hayRun: run, hayR: 4.0,
  });

  return { rows, gantry, head, rim: [rimA, rimB], benches: [benchA, benchB], yard, leap: run };
}

/* ================================================================== */
/* THE AQUEDUCT - tier 3, and the reason a 900 m map is crossable      */
/* ================================================================== */

/**
 * A spine from the mesa to the karst massif, 152 m of it, four spans missing.
 *
 * THIS IS LOAD-BEARING DESIGN, NOT SCENERY. Without it the expansion is a
 * bigger empty desert: the ring's five landforms all sit 280-420 m out and the
 * only thing between them and the town is flat sand, so crossing the map is a
 * walk. The aqueduct makes one of those crossings a parkour route instead - a
 * long line at 21-33 m over the flats, run at speed, with four leaps in it.
 *
 * ── Why the deck is 26 slabs and not one ramp ─────────────────────────────
 *
 * An aqueduct falls toward the town it feeds. 11.5 m over 152 m is a 0.075
 * gradient, which is right, and a box cannot be sloped. So the fall is carried
 * by the JOINTS: 26 level slabs, each 0.46 m below the one behind it. 0.46 is
 * inside `STEP_UP` 0.95, so the whole line walks and runs as one surface, and
 * at the four breaks that same 0.46 becomes the rise the gap is solved for.
 *
 * ── Why the leap is genuinely required ────────────────────────────────────
 *
 * `gapFor(leap, 0.46, 0.45)` is 5.50 m. A sprint jump onto a deck 0.46 m up
 * carries 3.90 m of run and has to spend 0.55 of it landing: 3.35 m. The break
 * is 2.15 m wider than the best a sprint can do. That is what "the leap,
 * required" means as an assertion rather than as a label, and the gate for it
 * is in `citadel-regions.test.mjs`.
 *
 * ── The piers are solid and the legs are not ──────────────────────────────
 *
 * A pier is a 25 m column a player can be under, walk into and shelter behind,
 * so it is a collider. The deck's own legs elsewhere in this file are visual,
 * because a collider hanging under a deck is one more thing `flyArc` resolves
 * as `blocked` on an arc that was only passing beneath.
 */
async function buildAqueduct(site) {
  /* Both ends are derived from the geometry they meet rather than authored:
   * the mesa abutment sits at r = 134, eight metres outside the mesa's own
   * top edge and sixteen outside the curtain wall, and the far abutment at
   * d = 42 from the karst centre, which is on the monastery shelf (30..44) and
   * not on the face above it. */
  const KX = -40;
  const KZ = -326;
  const len = Math.hypot(KX, KZ);
  const ux = KX / len;
  const uz = KZ / len;
  const ax = ux * 134;
  const az = uz * 134;
  const bx = KX - ux * 42;
  const bz = KZ - uz * 42;
  const dx = bx - ax;
  const dz = bz - az;
  const run = Math.hypot(dx, dz);
  const hx = dx / run;
  const hz = dz / run;
  const rot = Math.atan2(-hz, hx);

  const DECK_A = 21.5;
  const DECK_B = 33.0;
  const N = 26;                                   // deck slabs
  const BREAK_AT = [5, 11, 16, 21];               // joints that are missing
  const rise = (DECK_B - DECK_A) / (N - 1);
  const gap = gapFor(BUDGETS.leap, rise, site.tier.slack);
  const slab = (run - BREAK_AT.length * gap) / N;
  if (slab < 3.0) {
    throw new Error(`aqueduct: ${slab.toFixed(2)} m spans - too short to run on`);
  }

  const decks = [];
  let s = 0;
  for (let i = 0; i < N; i++) {
    const c = s + slab * 0.5;
    const px = ax + hx * c;
    const pz = az + hz * c;
    const top = DECK_A + rise * i;
    decks.push(site.slab({
      x: px, z: pz, w: slab, d: 4.2, rot, top, thick: 0.7,
      key: 'stone.castle', tint: 0xc4b48e, legs: false, kind: 'span',
    }));
    /* The channel cheeks: VISUAL ONLY. A 0.55 m cheek is under the leap's
     * 1.109 m apex and looks like nothing, but `flyArc` reads the feet arriving
     * inside a solid as `blocked` and blocked beats a landing lower in the same
     * column - so a collider here would turn all twenty-two butted joints into
     * a wall on the descending half of every arc. */
    for (const side of [-1, 1]) {
      site.shell('stone.castle', slab, 0.55, 0.5,
        px - hz * side * 1.85, top + 0.275, pz + hx * side * 1.85, rot, 0xcfbf99);
    }
    // A pier under every other slab, driven into whatever the ground is doing.
    if (i % 2 === 0) {
      const g = site.ground(px, pz);
      const h = top - 0.7 - (g - 1.5);
      if (h > 1.2) site.piece('stone.castle', 3.0, h, 3.4, px, top - 0.7 - h * 0.5, pz, rot, 0xbdad88);
    }
    s += slab;
    if ((i & 7) === 7) await site.breathe();
    if (BREAK_AT.includes(i + 1)) {
      /* Recorded AFTER the loop, because the far side of a break is the slab
       * that has not been built yet and a crossing with one end is a crossing
       * `citadel-regions.test.mjs` cannot fly. */
      s += gap;
    }
  }

  for (const i of BREAK_AT) site.crossing(gap, rise, 'break', decks[i - 1], decks[i]);

  /* Getting on, at both ends. The mesa flight climbs 7.7 m off the plateau; the
   * shelf flight climbs 4 m off the monastery court. Both are laid from the
   * deck backwards so the head lands the same distance from the lip. */
  await site.breathe();
  const px = -hz;
  const pz = hx;
  site.stair({
    x: ax + px * 2.6, z: az + pz * 2.6, dirX: -px, dirZ: -pz,
    fromY: site.ground(ax + px * 16, az + pz * 16), toY: DECK_A,
    width: 3.0, anchorTop: true,
  });
  site.stair({
    x: bx + px * 2.6, z: bz + pz * 2.6, dirX: -px, dirZ: -pz,
    fromY: site.ground(bx + px * 14, bz + pz * 14), toY: DECK_B,
    width: 3.0, anchorTop: true,
  });

  /* Hay under the high middle. The deck stands 25 m over the flats at its
   * worst, which is damage rather than death - but a 25 m fall off a running
   * line, four times a crossing, is a line nobody runs twice. */
  for (const t of [0.26, 0.40, 0.54, 0.68]) {
    const hxp = ax + hx * (run * t) + px * 5.5;
    const hzp = az + hz * (run * t) + pz * 5.5;
    site.hay({ x: hxp, z: hzp, r: 3.8 });
    site.drop(DECK_A + rise * (N - 1) * t - site.ground(hxp, hzp), 'off-the-spine', true);
  }

  return { decks, gap, rise, slab, span: run, a: { x: ax, z: az, y: DECK_A }, b: { x: bx, z: bz, y: DECK_B } };
}

/* ================================================================== */
/* ASHFALL - tier 4, the ruined second citadel                         */
/* ================================================================== */

/**
 * A rect-topped plateau at (-325, 190) with a collapsed hall across it and a
 * subsided quarter in one corner, and the region whose verb is IMPROVISATION.
 *
 * The ground was broken before anything was built on it - `ASHFALL.scar` cuts
 * 7.5 m out of the middle and `ASHFALL.fall` drops 9 m out of the north-west -
 * so the ruin is laid across three surfaces that do not join: the 30.3 m top,
 * the 22.8 m scar floor, and the 21.3 m subsidence. Getting between them is a
 * drop one way and a stair the other, which is what a ruin is.
 *
 * Tier 4 is the leap with the step-up eating the margin: `gapFor(leap, 0.80,
 * 0.26)` is 4.82 m where the same tier at a level joint is 6.56 m. That 1.74 m
 * spread inside ONE region is the point of authoring height as carefully as
 * gap - it is the difference between a run you can take at speed and one where
 * every third crossing has to be set up.
 */
async function buildAshfall(site) {
  const rows = [];
  const put = (x, z, dirX, dirZ, n, deck0, kind, label) => {
    const r = site.row({
      x, z, dirX, dirZ, n, w: 7.0, d: 9.0, deck0, kind, label,
      key: 'stone.castle', tint: 0xb3a68a, roofKey: 'stone.castle', roofTint: 0xa89b80,
    });
    rows.push(r);
    return r;
  };

  // Three ranges on the western top, and one across the scar on the eastern.
  const westA = put(-350, 150, 1, 0, 4, 35.3, 'ward', 'Ashfall');
  const westB = put(-350, 178, 1, 0, 4, 36.6, 'ward', null);
  const westC = put(-350, 200, 1, 0, 3, 34.4, 'ward', null);
  const east = put(-282, 178, 0, 1, 4, 35.3, 'ward', null);

  /* The collapsed hall. Three floor slabs left standing in the scar, 3.4 m
   * over its floor - which is 9 m under the ward decks either side, so getting
   * in is a drop and getting out is the flight at the scar's north end. */
  await site.breathe();
  const fallen = [];
  for (const z of [160, 180, 200]) {
    fallen.push(site.slab({
      x: -307, z, w: 8.0, d: 8.0, top: 26.2, thick: 0.7,
      key: 'stone.castle', tint: 0xa89a7e, legs: false, kind: 'fallen-floor',
    }));
  }
  site.hay({ x: -307, z: 145, r: 3.6 });
  site.drop(35.3 - 22.8, 'ward-into-the-scar', true);

  // Out of the scar at its northern end, where the cut feathers back to the top.
  site.stair({
    x: -307, z: 231, dirX: 0, dirZ: 1,
    fromY: site.ground(-307, 231), toY: site.ground(-307, 244),
    width: 3.2, rise: 0.78, run: 1.25,
  });

  await site.breathe();
  // Stairs from the top onto each western range, and onto the eastern one.
  for (const [r, dirX, dirZ] of [[westA, 0, -1], [westB, 0, -1], [westC, 0, 1], [east, 1, 0]]) {
    const lip = (9.0 + LIP) * 0.5 + 0.6;
    const p0 = r.plots[Math.floor(r.plots.length / 2)];
    const hxp = p0.x - dirX * lip;
    const hzp = p0.z - dirZ * lip;
    site.stair({
      x: hxp, z: hzp, dirX, dirZ,
      fromY: site.ground(hxp - dirX * 12, hzp - dirZ * 12), toY: r.decks[Math.floor(r.plots.length / 2)],
      width: 2.8, anchorTop: true,
    });
  }

  /* The beacon: a broken tower on the southern lip, and the only structure in
   * the ring that is deliberately shorter than it looks - four storeys where
   * the Eyrie has the height and the great tower keeps the record. */
  await site.breathe();
  const bx = -352;
  const bz = 128;
  const bBase = site.maxGround({ x: bx, z: bz, dirX: 1, dirZ: 0, length: 10, width: 10 }) + 5.0;
  const beacon = site.tower({
    x: bx, z: bz, w: 10.6, deck0: bBase, levels: 4, levelH: 4.2,
    key: 'stone.castle', tint: 0xa2957a, roofKey: 'stone.castle', roofTint: 0x9a8e74,
    label: 'The Ashfall Beacon',
  });
  site.stair({
    x: bx, z: bz + (10.6 + LIP) * 0.5 + 0.6, dirX: 0, dirZ: -1,
    fromY: site.ground(bx, bz + 14), toY: bBase, width: 2.8, anchorTop: true,
  });
  const bearing = 0;
  const launch = { x: bx + (beacon.w * 0.5 - 0.4), y: beacon.y, z: bz };
  const run = leapRun(site, launch.x, launch.z, beacon.y, bearing);
  site.viewpoint({
    id: 'ashfall-beacon', name: 'The Ashfall Beacon',
    x: bx, y: beacon.y, z: bz, r: (beacon.w + LIP) * 0.5,
    bearing, launch, hayRun: run, hayR: 4.0,
  });

  return { rows, fallen, beacon, leap: run };
}

/* ================================================================== */
/* THE KARST MASSIF AND THE EYRIE - tier 5, the test                   */
/* ================================================================== */

/**
 * A monastery on a 29 m shelf, a 26 m face above it, and the highest thing a
 * player can stand on outside the citadel itself.
 *
 * The verb is sustained climb and the number that shapes it is measured: ONE
 * stamina bar sustains 29.3 m. So the massif is not one face. It is a walkable
 * outer ramp to the shelf, a cloister on it at tier 5, and then twelve pilgrim
 * ledges 2.17 m apart up 26 m of rock - inside a single bar with 3.3 m in hand,
 * and nothing above it to strand a player who arrives empty.
 *
 * ── The ledges taper into the face, and that is the graph talking ─────────
 *
 * Each ledge steps 1.5 m inward and 0.10 rad round, so consecutive footprints
 * OVERLAP by 0.9 m. That is not a look: `ReachGraph` samples a deck's perimeter
 * 0.45 m outside its own footprint and chains whatever tops it finds in that
 * column into a climb, and a stack of ledges that do not overlap chains
 * nothing. `Climb.MANTLE_MAX` is 2.4 m, so 2.17 is a mantle a body actually
 * makes rather than a number that merely satisfies a probe.
 *
 * ── Why the Eyrie stops at 63.5 m ─────────────────────────────────────────
 *
 * The great tower's deck is 67.6. The citadel has to keep the skyline or the
 * whole map stops pointing at it, so the monastery is authored four metres
 * short - close enough that standing on it you can see you are not the highest
 * thing in the world.
 */
async function buildEyrie(site) {
  const KX = -40;
  const KZ = -326;
  const at = (d, a) => ({ x: KX + Math.cos(a) * d, z: KZ + Math.sin(a) * d });
  const rows = [];

  /* The cloister. Bearings 0.30 / 2.45 / 4.60 leave the aqueduct's far
   * abutment (1.4485 rad, d = 42) a clear corridor onto the shelf, which is
   * the whole reason the spine was worth building. */
  for (const a of [0.30, 2.45, 4.60]) {
    const p = at(38, a);
    const dirX = -Math.sin(a);
    const dirZ = Math.cos(a);
    const hi = site.maxGround({ x: p.x, z: p.z, dirX, dirZ, length: 26, width: 7 });
    rows.push(site.row({
      x: p.x, z: p.z, dirX, dirZ, n: 3, w: 6.0, d: 7.0, deck0: hi + 4.6,
      kind: 'cloister', label: a === 0.30 ? 'The Eyrie Cloister' : null,
      key: 'plaster.wall', tint: 0xe2d6b6, roofKey: 'stone.castle', roofTint: 0xc0b08c,
    }));
    // Onto the cloister from the shelf.
    const head = at(38 - (7.0 + LIP) * 0.5 - 0.6, a);
    site.stair({
      x: head.x, z: head.z, dirX: Math.cos(a), dirZ: Math.sin(a),
      fromY: site.ground(at(28, a).x, at(28, a).z), toY: hi + 4.6,
      width: 2.6, anchorTop: true,
    });
  }

  /* THE PILGRIM STAIR: 26 m of ascent, cut round the peak.
   *
   * The verb this region owns is sustained climb, and the number that shapes
   * it is measured: one stamina bar sustains 29.3 m. The rock face itself is
   * the climb - `karstShape` gives it a gradient of 2.44, past the 1.73 a face
   * has to reach before `Climb` will grip it at all, over 26 m from the shelf
   * at 29.0 to the summit at 55.0, which is inside a single bar with 3.3 m in
   * hand and nothing above it to strand a player who arrives empty.
   *
   * The stair is the OTHER way up, and it exists for two reasons. A monastery
   * on a peak has a pilgrim path. And a reachability probe cannot see a free
   * climb: `ReachGraph` draws climb edges from colliders, so a 26 m face of
   * bare heightfield reads to it as a wall with nothing on it, and without
   * this flight the Eyrie, both summit landings and the last six rungs measure
   * as "you can get down from here, you cannot get up" - which is exactly what
   * they did measure before it existed.
   */
  await site.breathe();
  const stair = site.helix({
    cx: KX, cz: KZ, dStart: 29.5, dStop: 12.0, theta0: 3.40, spin: 1,
    rise: 0.70, pitch: 1.5, tread: 2.4, width: 3.0, proud: 0.55,
  });
  const ledges = [];

  /* Two landings on the summit plateau itself. The inner one is deliberately
   * at d = 6.4: the Eyrie's own perimeter is sampled 0.45 m outside its 9.1 m
   * lip, i.e. at d = 5.0, and that sample has to come down on something for
   * the tower to be climbable from the rock rather than only jumpable off it. */
  for (const d of [9.4, 6.4]) {
    const p = at(d, 3.40 + 2.2 + (d === 9.4 ? 0 : 0.9));
    ledges.push(site.slab({
      x: p.x, z: p.z, w: 3.6, d: 3.6, rot: 0, top: 55.5,
      thick: 0.5, key: 'stone.castle', tint: 0xb5a88a, legs: false, kind: 'ledge',
    }));
  }

  /* The Eyrie itself, on the summit. Two storeys, and the taper is what makes
   * the upper one reachable in the graph as well as in the fiction. */
  await site.breathe();
  const eyrie = site.tower({
    x: KX, z: KZ, w: 8.4, deck0: 59.5, levels: 2, levelH: 4.0,
    key: 'plaster.wall', tint: 0xe6dabb, roofKey: 'stone.castle', roofTint: 0xc8b892,
    label: 'The Eyrie',
  });

  /* The leap of faith. 1.0 rad is a corridor between the cloister ranges at
   * 0.30 and 2.45, so the arc has the face and then the open shelf under it
   * and lands on neither a roof nor the aqueduct's abutment. */
  const bearing = 1.0;
  const launch = {
    x: KX + Math.cos(bearing) * (eyrie.w * 0.5 - 0.4),
    y: eyrie.y,
    z: KZ + Math.sin(bearing) * (eyrie.w * 0.5 - 0.4),
  };
  const run = leapRun(site, launch.x, launch.z, eyrie.y, bearing);
  site.viewpoint({
    id: 'the-eyrie', name: 'The Eyrie',
    x: KX, y: eyrie.y, z: KZ, r: (eyrie.w + LIP) * 0.5,
    bearing, launch, hayRun: run, hayR: 4.2,
  });
  site.drop(eyrie.y - 29.0, 'eyrie-to-the-shelf', true);

  return { rows, ledges, stair, eyrie, leap: run };
}

/* ================================================================== */
/* The table, and the one entry point                                  */
/* ================================================================== */

/**
 * The six regions, in curve order.
 *
 * `landform` names the row in `CITADEL_LANDFORMS` each one stands on, and it
 * is asserted rather than decorative: a region built outside the support of its
 * own landform is a region standing on whatever the broad relief happens to be
 * doing, which is how a terrace ends up with an eleven-metre wall at one end
 * and none at the other.
 */
export const REGIONS = Object.freeze([
  Object.freeze({
    id: 'caravanserai', name: 'The Caravanserai', tier: 0,
    landform: 'caravanserai-dunes', build: buildCaravanserai,
    verb: 'mounts, rest, vendors', teaches: 'the walk jump, on flat ground',
  }),
  Object.freeze({
    id: 'undercliff', name: 'The Undercliff', tier: 1,
    landform: 'undercliff-terraces', build: buildUndercliff,
    verb: 'descent, drops, hay', teaches: 'the sprint jump, and that a fall can be a route',
  }),
  Object.freeze({
    id: 'deepworks', name: 'The Quarry & Deepworks', tier: 2,
    landform: 'quarry-deepworks', build: buildQuarry,
    verb: 'vertical down', teaches: 'the sprint jump at its limit, and the climb back out',
  }),
  Object.freeze({
    id: 'aqueduct', name: 'The Aqueduct', tier: 3,
    landform: null, build: buildAqueduct,
    verb: 'long-line running, the leap', teaches: 'the leap, required, four times in one run',
  }),
  Object.freeze({
    id: 'ashfall', name: 'Ashfall', tier: 4,
    landform: 'ashfall-plateau', build: buildAshfall,
    verb: 'broken geometry, improvisation', teaches: 'the leap with the step-up eating the margin',
  }),
  Object.freeze({
    id: 'eyrie', name: 'Karst Massif & the Eyrie', tier: 5,
    landform: 'karst-massif', build: buildEyrie,
    verb: 'sustained climb, stamina', teaches: 'the leap at its ceiling, and 26 m of mantles',
  }),
]);

/**
 * Build every region, and report exactly what was authored.
 *
 * The report is not a log. `citadel-regions.test.mjs` reads it as the AUTHOR'S
 * CLAIM and then measures the built world independently - the gap the row
 * solved for against the gap `footprintGap` finds between the two lips, the
 * budget the tier named against the budget `takeoffFan` actually needs. A
 * report that agreed with itself would be worth nothing; the point is that two
 * different pieces of arithmetic have to arrive at the same world.
 *
 * @param {object} ctx host callbacks: `box`, `solid`, `ground`, `rnd`,
 *   `breathe`, and the published arrays `roofs`, `towers`, `haystacks`,
 *   `viewpoints`.
 * @returns {Promise<{regions:Array, routes:object, bounds:object}>}
 */
export async function buildRegions(ctx) {
  const regions = [];
  const routes = {};
  const bounds = { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } };

  for (const spec of REGIONS) {
    /* One batch per region, opened and closed by the host.
     *
     * Not one batch for the whole ring, and the reason is the draw-call
     * budget rather than tidiness: `splitMesh` cuts every merged mesh down to
     * a 130 m bounding sphere, so a single `stone.castle` mesh holding all six
     * regions - 700 m apart at the extremes - comes back as a leaf per cluster,
     * against one leaf per region when each is merged on its own. Measured by
     * mutation over this content: one shared batch takes the whole world to
     * 194 draw calls against 136, on a ceiling of 150.
     */
    ctx.beginRegion?.(spec);
    const site = new RegionSite(ctx, spec);
    const built = await spec.build(site);
    await site.breathe();

    const gaps = site.crossings.map((c) => c.gap);
    const rises = site.crossings.map((c) => c.rise);
    const decks = site.decks.map((d) => d.y);
    const row = {
      id: spec.id,
      name: spec.name,
      tier: spec.tier,
      tierId: site.tier.id,
      budget: site.tier.budget.id,
      slack: site.tier.slack,
      verb: spec.verb,
      teaches: spec.teaches,
      landform: spec.landform,
      decks: site.decks.length,
      pieces: site.pieces,
      colliders: site.colliders,
      worstSlice: site.worstSlice,
      crossings: site.crossings,
      drops: site.drops,
      stairs: site.stairs,
      gap: extent(gaps),
      rise: extent(rises),
      deck: extent(decks),
      ground: { lo: site.groundLo, hi: site.groundHi, relief: site.groundHi - site.groundLo },
      aabb: { min: { ...site.min }, max: { ...site.max } },
      built,
    };
    regions.push(row);
    routes[spec.id] = built;
    await ctx.endRegion?.(spec, row);
    for (const k of ['x', 'y', 'z']) {
      if (site.min[k] < bounds.min[k]) bounds.min[k] = site.min[k];
      if (site.max[k] > bounds.max[k]) bounds.max[k] = site.max[k];
    }
  }

  return { regions, routes, bounds };
}

/** min / mean / max / n over a list, with `NaN`s for the empty case. */
function extent(xs) {
  if (!xs.length) return { n: 0, min: NaN, mean: NaN, max: NaN };
  let lo = Infinity;
  let hi = -Infinity;
  let sum = 0;
  for (const v of xs) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    sum += v;
  }
  return { n: xs.length, min: lo, mean: sum / xs.length, max: hi };
}
