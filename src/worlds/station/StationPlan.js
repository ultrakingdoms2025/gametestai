import {
  DEG, OCC_CELL, occCellKey,
  PLAZA_R, DECK_R, ROAD_EDGE_HALF, ROAD_ANGLES_DEG,
  GATEWAY_BEARINGS_DEG,
} from './StationKit.js';

/**
 * THE STATION PLAN - what the deck is FOR, decided before anything is built on it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THIS EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The station has four partial answers to "is this square metre free?" and none
 * of them is asked before a thing is placed:
 *
 *   `_markOccupancy`  rasterises what has already been DRAWN, so it can only
 *                     be consulted by a builder that runs after the thing it
 *                     must avoid - which is why it is called once, near the
 *                     end, by the bulk scatter.
 *   `_footprintClear` reads COLLIDERS, which do not exist yet for anything the
 *                     structure pass has not reached, and asks
 *                     `physics.containsPoint`, which has no branch for the
 *                     triangle soup that carries most of the hub.
 *   `_selfCollided` / `_enterableRoomFootprints`  two hand-published lists of
 *                     rectangles, each read by one pass.
 *   the road loops    nine separate copies of "is this on an avenue?" written
 *                     inline against `roadAngles`, in nine builders.
 *
 * So a builder that runs early cannot ask anything at all, and the answer a
 * late one gets is "what happens to be drawn", never "what this ground is for".
 * That is how buildings end up half on a road: nothing ever said the road was
 * there first.
 *
 * This is the missing half. It is pure arithmetic over the layout constants -
 * no colliders, no geometry, no scene graph - so it can be built as the FIRST
 * step of the build and be true for every builder after it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT IT DOES IN THIS PHASE: NOTHING. DELIBERATELY.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The plan is seeded and every solid the world authors is recorded against it,
 * and then **nothing reads it back**. No placement changes. That is the point:
 * a reservation model that starts by moving four thousand props is one whose
 * first bug is indistinguishable from its first correct decision.
 *
 * Running it in shadow answers the question that decides the next phase -
 * HOW MUCH of the station is standing on its own circulation, and where - with
 * a number, before anything is authored against it. The conflicts it reports
 * are a measurement of the world as it is, not a list of things to fix today.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE GRID, AND WHY IT STAYS IN HERE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `OCC_CELL` (1.5 m) and `occCellKey`, the raster the station already uses, so
 * this is not a fifth spatial convention. It is INTERNAL to the build and must
 * stay that way: the station's bounds are +/-744 m, so a 1.5 m grid is 993
 * samples an axis, and the editor's wire format refuses anything over 400 and
 * caps the payload at 4 MB - a refusal that is SILENT (the layout reads as
 * "keep prior"). If plan roles are ever published to the editor they go at the
 * ground grid's own 6 m step, as a separate raster, not by widening this one.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  MARK WIDE, TEST TRUE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The two asymmetries are carried over from `Gym.scope()`, which is the working
 * version of this idea one zone already has, and they are not an oversight:
 *
 *   marking uses the CONSERVATIVE axis-aligned box of a rotated rect, so a
 *   claim never under-states what it occupies;
 *   testing uses the TRUE rotated rect, so a query is not refused by a corner
 *   the claim never really had.
 *
 * And the floor is not an obstacle. A painted bay, a 12 cm sprung deck and a
 * kerb are all things you walk ON, and a plan that treated them as occupancy
 * would report the deck as conflicting with itself. `MIN_CLAIM_TOP` is the
 * same 0.45 m line the gym drew.
 */

/** Roles a cell can carry. A cell holds at most one; later seeds do not overwrite. */
export const ROLE = Object.freeze({
  /** A radial avenue: the six carriageways out of the plaza. */
  CARRIAGEWAY: 'carriageway',
  /** The plaza floor itself, inside `PLAZA_R`. */
  PLAZA: 'plaza',
  /** A gateway's approach corridor - kept readable so a portal can be seen and walked to. */
  SIGHTLINE: 'sightline',
});

/**
 * How tall a solid must be before it counts as occupying ground.
 *
 * Below this it is floor: plating, a kerb, a painted bay, a ramp lip. The gym's
 * own raster drew the line at the same height for the same reason - a hall that
 * refused to overlap its own floor would refuse to place anything at all.
 */
const MIN_CLAIM_TOP = 0.45;

/**
 * How high a solid may reach and still be standing ON the deck.
 *
 * The same band `_markOccupancy` draws, and for the reason its own note gives:
 * "higher than anything a deck-level prop can reach, low enough that a walkway
 * soffit 20 m up does not reserve the ground beneath it."
 *
 * Without it the measurement is dominated by things that are nowhere near the
 * floor. Measured before this existed: the great dome - a shallow cap a hundred
 * metres up - reported 33 conflicts against avenues, the plaza and gateway
 * approaches, and the promenade loop, which crosses every avenue 10 m overhead
 * BY DESIGN, reported 21 more. Fifty-four of 439, all of them noise, and all of
 * them burying the ones that are not.
 */
const GROUND_BAND_TOP = 6;

/**
 * Half-width of a gateway approach corridor, and how far out it runs.
 *
 * Taken from the rule the dressing scatter already applies by hand
 * (`StationWorld._buildDressing`: within 24 m of a gateway's bearing, between
 * r = 44 and r = 100). Stated once here instead of inline there, which is the
 * whole point of the exercise - that rule exists in the scatter loop and
 * nowhere else, so nothing built before the scatter has ever honoured it.
 */
const SIGHTLINE_HALF = 24;
const SIGHTLINE_R0 = 44;
const SIGHTLINE_R1 = 100;

export class StationPlan {
  constructor() {
    /** cellKey -> role. One role per cell; the first seed to claim it wins. */
    this._role = new Map();
    /**
     * Conflicts found in shadow: a solid that stands on a seeded role.
     * `{ role, owner, x, z, cells }` - the owner is whatever label the caller
     * passed, so a report can name the builder rather than a coordinate.
     */
    this.conflicts = [];
    /** How many solids were recorded, and how many of them were floor. */
    this.stats = { claims: 0, floorSkipped: 0, overheadSkipped: 0, cellsSeeded: 0, cellsClaimed: 0 };
    this._claimed = new Set();
  }

  /* ---------------------------------------------------------------- */
  /* Seeding - pure arithmetic over the layout constants               */
  /* ---------------------------------------------------------------- */

  /**
   * Lay down the circulation the hub is built around, from the same constants
   * the builders read.
   *
   * Nine separate loops in `StationWorld` re-derive "is this on an avenue?"
   * inline against `roadAngles`, each with its own margin - `ROAD_W / 2 + 3`,
   * `+ 7`, and so on. They are not collapsed here yet (that is the next phase);
   * this seeds the same shape from `ROAD_EDGE_HALF`, which is the width
   * `avenueClearance` itself uses, so the plan and the pinned clearance maths
   * cannot disagree about where a road is.
   *
   * @param {number[]} [roadAngles]
   * @param {number[]} [gatewayBearings]
   */
  seedCirculation(roadAngles = ROAD_ANGLES_DEG, gatewayBearings = GATEWAY_BEARINGS_DEG) {
    /* Stepped at half a cell so a diagonal strip cannot leave holes between
     * samples: a 1.5 m cell sampled every 1.5 m along a 60-degree bearing skips
     * cells the strip genuinely covers. */
    const STEP = OCC_CELL / 2;

    // The plaza floor, seeded first so it wins the cells the avenues share.
    for (let x = -PLAZA_R; x <= PLAZA_R; x += STEP) {
      for (let z = -PLAZA_R; z <= PLAZA_R; z += STEP) {
        if (x * x + z * z <= PLAZA_R * PLAZA_R) this._seed(x, z, ROLE.PLAZA);
      }
    }

    // The six avenues, from the plaza edge to the deck rim.
    for (const deg of roadAngles) {
      const t = deg * DEG;
      const ux = Math.cos(t), uz = Math.sin(t);
      const px = -uz, pz = ux;                 // across the carriageway
      for (let along = PLAZA_R - 3; along <= DECK_R; along += STEP) {
        for (let across = -ROAD_EDGE_HALF; across <= ROAD_EDGE_HALF; across += STEP) {
          this._seed(ux * along + px * across, uz * along + pz * across, ROLE.CARRIAGEWAY);
        }
      }
    }

    // The six gateway approaches.
    for (const deg of gatewayBearings) {
      const t = deg * DEG;
      const ux = Math.cos(t), uz = Math.sin(t);
      const px = -uz, pz = ux;
      for (let along = SIGHTLINE_R0; along <= SIGHTLINE_R1; along += STEP) {
        for (let across = -SIGHTLINE_HALF; across <= SIGHTLINE_HALF; across += STEP) {
          this._seed(ux * along + px * across, uz * along + pz * across, ROLE.SIGHTLINE);
        }
      }
    }

    this.stats.cellsSeeded = this._role.size;
    return this;
  }

  _seed(x, z, role) {
    const k = occCellKey(Math.floor(x / OCC_CELL), Math.floor(z / OCC_CELL));
    if (!this._role.has(k)) this._role.set(k, role);
  }

  /* ---------------------------------------------------------------- */
  /* Claiming - recorded as a side effect of authoring a solid          */
  /* ---------------------------------------------------------------- */

  /**
   * Record that something solid stands here, and report what it stands on.
   *
   * Called from the collider calls themselves rather than from a second list a
   * builder has to remember to write - the whole reason `Gym.scope()` works is
   * that there is no way to author an obstacle it does not see. Nothing acts on
   * the return value in this phase.
   *
   * @param {number} x world centre
   * @param {number} z
   * @param {number} bottomY world Y of the solid's underside
   * @param {number} topY world Y of the solid's top; below `MIN_CLAIM_TOP` it is floor
   * @param {number} hx half-extent before rotation
   * @param {number} hz
   * @param {number} yaw
   * @param {string|null} owner a label for the report
   * @returns {string|null} the role it conflicts with, or null
   */
  claim(x, z, bottomY, topY, hx, hz, yaw = 0, owner = null) {
    // Floor, not an obstacle.
    if (!(topY > MIN_CLAIM_TOP)) { this.stats.floorSkipped++; return null; }
    // Overhead: it spans no part of the band a body walks through.
    if (bottomY > GROUND_BAND_TOP) { this.stats.overheadSkipped++; return null; }
    this.stats.claims++;

    /* Mark wide: the axis-aligned bound of the rotated rect. A claim that
     * under-stated its extent would let the next thing overlap it. */
    const c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw));
    const ex = hx * c + hz * s;
    const ez = hx * s + hz * c;

    const gx0 = Math.floor((x - ex) / OCC_CELL), gx1 = Math.floor((x + ex) / OCC_CELL);
    const gz0 = Math.floor((z - ez) / OCC_CELL), gz1 = Math.floor((z + ez) / OCC_CELL);

    /* A guard, not a budget. A claim spanning more cells than this is a
     * district-sized box - the planting proxy that once measured 250 x 301 m
     * was exactly that - and rasterising it would cost more than it tells us
     * while burying every real conflict under one enormous one. */
    if ((gx1 - gx0 + 1) * (gz1 - gz0 + 1) > MAX_CLAIM_CELLS) return null;

    let hit = null;
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const k = occCellKey(gx, gz);
        this._claimed.add(k);
        if (!hit) {
          const role = this._role.get(k);
          /* Test true: the conservative box may reach a cell the rotated rect
           * does not, and a conflict reported on one of those is noise. */
          if (role && this._rectCovers(x, z, hx, hz, yaw, (gx + 0.5) * OCC_CELL, (gz + 0.5) * OCC_CELL)) hit = role;
        }
      }
    }

    if (hit) this.conflicts.push({ role: hit, owner, x: +x.toFixed(1), z: +z.toFixed(1) });
    return hit;
  }

  /**
   * Is `(px, pz)` inside the true rotated rect centred at `(x, z)`?
   *
   * ── The sign, and why it is worth a comment ───────────────────────────────
   * This read `Math.cos(-yaw)` / `Math.sin(-yaw)` and tested the rect MIRRORED
   * - reflected about its own local X axis. Measured against a real three.js
   * `Matrix4.makeRotationY(yaw).setPosition(x,0,z).invert()`, which is exactly
   * what `Physics.containsPoint` does to a box collider: 7,620 disagreements
   * in 200,000 random cases with the negated angle, and ZERO with this one.
   *
   * The negation is already carried by the shape of the two expressions - the
   * pair `(dx*c - dz*s, dx*s + dz*c)` projects onto the rect's local axes when
   * `c`/`s` are the cosine and sine of the yaw ITSELF. Negating the angle as
   * well applies the inverse twice, which for a rotation is a reflection, and
   * a reflection is invisible on anything square or axis-aligned. That is why
   * it survived: it only shows on a rotated, non-square claim.
   *
   * It matters because this is the CONFIRM step for every conflict the plan
   * reports and for every `roleUnder` query a builder makes. The rasterising
   * step above it is symmetric (`Math.abs` on both axes) and was never wrong,
   * so the effect was not noise - it was reporting some rotated claims against
   * the mirror image of their own footprint.
   *
   * Found by three independent readers of this file disagreeing with my own
   * hand-algebra, which said the code was right. The algebra was wrong; the
   * 200,000-case comparison against three.js is what settled it. Do not
   * re-derive this by hand - re-run the comparison.
   */
  _rectCovers(x, z, hx, hz, yaw, px, pz) {
    const dx = px - x, dz = pz - z;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    return Math.abs(dx * c - dz * s) <= hx && Math.abs(dx * s + dz * c) <= hz;
  }

  /**
   * Which seeded role a footprint would land on - WITHOUT claiming it.
   *
   * `claim` is the reporting path: it records the conflict and marks the cells,
   * so a builder cannot use it to ask a question before deciding. This is the
   * question. It is the same rasterise-and-test scan, minus the bookkeeping,
   * and it exists so a placement loop can get out of a road rather than build
   * across it and be counted afterwards.
   *
   * `only` narrows it to one role. That matters: the plan seeds carriageways,
   * plazas AND sightlines, and refusing every block that clips a sightline
   * would delete most of the backdrop the gateways are silhouetted against.
   * A building standing in a road is a defect; a building at the edge of a
   * sightline is a composition question.
   *
   * @param {string|null} [only] restrict to this role
   * @returns {string|null} the role hit, or null
   */
  roleUnder(x, z, hx, hz, yaw = 0, only = null) {
    const c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw));
    const ex = hx * c + hz * s;
    const ez = hx * s + hz * c;
    const gx0 = Math.floor((x - ex) / OCC_CELL), gx1 = Math.floor((x + ex) / OCC_CELL);
    const gz0 = Math.floor((z - ez) / OCC_CELL), gz1 = Math.floor((z + ez) / OCC_CELL);
    if ((gx1 - gx0 + 1) * (gz1 - gz0 + 1) > MAX_CLAIM_CELLS) return null;
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const role = this._role.get(occCellKey(gx, gz));
        if (!role || (only && role !== only)) continue;
        // Same true-rect test `claim` uses, so the two agree on what a hit is.
        if (this._rectCovers(x, z, hx, hz, yaw, (gx + 0.5) * OCC_CELL, (gz + 0.5) * OCC_CELL)) return role;
      }
    }
    return null;
  }

  /**
   * How much of a footprint stands on ground something else already claimed.
   *
   * This is Phase 4's "`_footprintClear` becomes a plan query", arrived at from
   * the far end: the skyline is built at 0.92, after every district, so by the
   * time it places a block the plan already holds the claims of the plaza, the
   * daises, the promenade, the commercial strip, the hangar, the habitat
   * stacks, the residential terrace, traffic control and the cargo yard. One
   * query replaces knowing about any of them.
   *
   * A FRACTION, not a boolean, because a boolean has no gradient. Asked
   * "is this spot clear?" a placement loop can only accept or give up, and
   * giving up is what left thirteen of sixteen backdrop blocks standing on the
   * station. Asked "how occupied is this spot?" it can choose the least bad of
   * two hundred candidates, which is what a backdrop ring needs - it has to go
   * somewhere, and somewhere is a comparison.
   *
   * The rasterisation is `roleUnder`'s, so the two agree on what a footprint
   * covers. Returns 0 for a footprint too large to raster, matching
   * `roleUnder`'s null - a caller cannot tell a huge clear area from a huge
   * refused one, and neither should place a backdrop block.
   *
   * @returns {number} 0..1, the share of covered cells already claimed
   */
  occupancyUnder(x, z, hx, hz, yaw = 0) {
    const c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw));
    const ex = hx * c + hz * s;
    const ez = hx * s + hz * c;
    const gx0 = Math.floor((x - ex) / OCC_CELL), gx1 = Math.floor((x + ex) / OCC_CELL);
    const gz0 = Math.floor((z - ez) / OCC_CELL), gz1 = Math.floor((z + ez) / OCC_CELL);
    if ((gx1 - gx0 + 1) * (gz1 - gz0 + 1) > MAX_CLAIM_CELLS) return 0;
    let covered = 0, taken = 0;
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const px = (gx + 0.5) * OCC_CELL, pz = (gz + 0.5) * OCC_CELL;
        if (!this._rectCovers(x, z, hx, hz, yaw, px, pz)) continue;
        covered++;
        if (this._claimed.has(occCellKey(gx, gz))) taken++;
      }
    }
    return covered ? taken / covered : 0;
  }

  /** The role seeded at a world position, or null. */
  roleAt(x, z) {
    return this._role.get(occCellKey(Math.floor(x / OCC_CELL), Math.floor(z / OCC_CELL))) ?? null;
  }

  /** Conflicts grouped by role and owner, for a one-line build report. */
  summary() {
    this.stats.cellsClaimed = this._claimed.size;
    const byRole = new Map();
    for (const c of this.conflicts) byRole.set(c.role, (byRole.get(c.role) ?? 0) + 1);
    return { ...this.stats, conflicts: this.conflicts.length, byRole: Object.fromEntries(byRole) };
  }
}

/** See the guard in `claim`. 1.5 m cells, so this is a 150 m square. */
const MAX_CLAIM_CELLS = 10000;
