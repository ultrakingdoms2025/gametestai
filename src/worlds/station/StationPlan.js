import {
  DEG, OCC_CELL, occCellKey,
  PLAZA_R, DECK_R, ROAD_R1, ROAD_EDGE_HALF, ROAD_ANGLES_DEG,
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
 *  THE PLAN IS SHAPES. THE GRID IS BOOKKEEPING.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The circulation is kept as the SHAPES it is - a plaza disc and twelve rotated
 * strips - and every question about it is answered against those shapes.
 *
 * This is the second version of this file. The first rasterised the corridors
 * to 1.5 m cells at seeding time, threw the shapes away, and answered every
 * question by asking the raster. That cost it two defects of opposite sign:
 *
 *   a claim SMALLER than a cell could sit squarely in a road and be missed,
 *   because a hit was confirmed by covering a cell CENTRE. Measured, not
 *   theorised: a 0.5 m hologram mast was moved off one avenue and onto
 *   another by a sweep that asked the raster and was told "clear". Asked at
 *   0.5, two of the six avenues reported no carriageway anywhere along their
 *   own centreline.
 *
 *   the obvious repair - testing the claim against the cell's EXTENT - was
 *   written, run and reverted. It took the carriageway count from 4 to 61,
 *   and 42 of the 57 it added were avenue lamp posts standing CORRECTLY: a
 *   lamp's inner face is 0.45 m clear of the kerb, but the cell holding the
 *   kerb sample reaches 0.6 m past it.
 *
 * Both errors are the same one - the cell is not the road, it is a
 * quantisation of the road to 1.5 m - and neither is fixable by choosing a
 * better way to ask a grid a sub-metre question. So the grid is not asked.
 * `roleAt`, `roleUnder` and `claim` test the true rotated rectangle of the
 * query against the true rotated rectangle of the corridor, and a 0.25 m lamp
 * 0.45 m clear of a kerb is clear by arithmetic that needs no instrument.
 *
 * `OCC_CELL` (1.5 m) and `occCellKey` survive for the one job a raster is
 * genuinely good at: `occupancyUnder`, which asks how much of a footprint
 * stands on ground SOMETHING ELSE ALREADY CLAIMED. That is an unbounded set of
 * arbitrary rectangles accumulated across a whole build - a raster is the right
 * shape for it, where thirteen corridors are not. It stays INTERNAL to the
 * build: the station's bounds are +/-744 m, so a 1.5 m grid is 993 samples an
 * axis, and the editor's wire format refuses anything over 400 and caps the
 * payload at 4 MB - a refusal that is SILENT (the layout reads as "keep
 * prior"). If plan roles are ever published to the editor they go at the
 * ground grid's own 6 m step, as a separate raster, not by widening this one.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  PRECEDENCE, AND WHY THE AVENUES START AT THE PLAZA CIRCLE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A point carries at most one role, and the regions are searched in seed order,
 * so an earlier region wins ground a later one also covers. That is the rule
 * the raster had - "the first seed to claim a cell wins" - stated exactly
 * instead of to the nearest cell.
 *
 * The plaza is seeded first, and the avenue strips now start at `PLAZA_R`
 * rather than the `PLAZA_R - 3` the surface is DRAWN from. Those three metres
 * are the tuck-in that lets a road meet a plaza without a seam, and they are
 * plaza floor: a pallet at r = 39.5 on an avenue bearing is standing on the
 * plaza. That is what the raster said too, because the plaza had already taken
 * those cells - so this is the same answer, not a new one. Starting the strip
 * at the plaza circle makes the two regions disjoint BY CONSTRUCTION rather
 * than by seed order, so "which role is this ground" never needs one shape
 * subtracted from another. It is exact: a strip point is `(along, across)` on
 * perpendicular axes, so `along >= PLAZA_R` already implies
 * `along^2 + across^2 >= PLAZA_R^2`.
 *
 * The avenues and the gateway corridors DO genuinely overlap, near r = 44-60
 * where a corridor is 48 m wide. The avenue wins, by seed order, which is again
 * the answer the raster gave.
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
 * Marking is now only `occupancyUnder`'s raster; testing is the corridor
 * shapes. It is the same asymmetry, one level less quantised.
 *
 * And the floor is not an obstacle. A painted bay, a 12 cm sprung deck and a
 * kerb are all things you walk ON, and a plan that treated them as occupancy
 * would report the deck as conflicting with itself. `MIN_CLAIM_TOP` is the
 * same 0.45 m line the gym drew.
 */

/** Roles the ground can carry. A point holds at most one; earlier regions win. */
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
    /**
     * The circulation, as shapes, in precedence order: a disc for the plaza,
     * then a rotated rectangle per avenue and per gateway corridor.
     *
     * Thirteen of them, which is why there is no spatial index over them. A
     * bounding-circle reject settles nearly every query before a separating
     * axis is computed, and thirteen of those is cheaper than rasterising one
     * large footprint was. If districts ever seed parcels by the hundred this
     * is where an index goes - and `occCellKey` is already here to build it
     * from.
     */
    this._regions = [];
    /**
     * Conflicts found in shadow: a solid that stands on a seeded role.
     * `{ role, owner, x, z }` - the owner is whatever label the caller passed,
     * so a report can name the builder rather than a coordinate.
     */
    this.conflicts = [];
    /** How many solids were recorded, and how many of them were floor. */
    this.stats = {
      claims: 0, floorSkipped: 0, overheadSkipped: 0,
      regionsSeeded: 0, seededArea: 0, cellsClaimed: 0,
    };
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
    // The plaza floor, first, so it owns the ground the avenue mouths tuck into.
    this._regions.push({
      role: ROLE.PLAZA, kind: 'disc', label: 'plaza',
      x: 0, z: 0, r: PLAZA_R, br: PLAZA_R,
    });

    /* The six avenues, from the plaza circle to WHERE THE ROAD ENDS.
     *
     * `ROAD_R1`, not `DECK_R`: the surface is laid to `DECK_R - 12` and this
     * used to reserve twelve metres past it. A role claimed where nothing is
     * built is not a conservative over-claim, it is a false one - it made the
     * conflict gate report geometry standing on bare deck as standing in a
     * road, which is how the four link mouths came to be recorded as an open
     * design question. */
    for (const deg of roadAngles) {
      this._regions.push(this._strip(deg, PLAZA_R, ROAD_R1, ROAD_EDGE_HALF, ROLE.CARRIAGEWAY, `avenue ${deg}`));
    }

    // The six gateway approaches.
    for (const deg of gatewayBearings) {
      this._regions.push(this._strip(deg, SIGHTLINE_R0, SIGHTLINE_R1, SIGHTLINE_HALF, ROLE.SIGHTLINE, `gateway ${deg}`));
    }

    this.stats.regionsSeeded = this._regions.length;
    this.stats.seededArea = this._regions.reduce(
      (a, g) => a + (g.kind === 'disc' ? Math.PI * g.r * g.r : 4 * g.hx * g.hz), 0,
    );
    return this;
  }

  /**
   * A radial corridor: `along` from `r0` to `r1` on `deg`, `half` either side.
   *
   * Stored in the convention `_rectCovers` reads, so one point test serves
   * corridors and claims alike. A yaw of `-deg` puts the rect's first local
   * axis on the bearing itself - `(cos(-t), -sin(-t))` is `(cos t, sin t)` - so
   * `hx` is the extent ALONG the corridor and `hz` is its half-width.
   */
  _strip(deg, r0, r1, half, role, label) {
    const t = deg * DEG;
    const mid = (r0 + r1) / 2;
    const hx = (r1 - r0) / 2;
    return {
      role, kind: 'rect', label,
      x: Math.cos(t) * mid, z: Math.sin(t) * mid,
      hx, hz: half, yaw: -t, br: Math.hypot(hx, half),
    };
  }

  /* ---------------------------------------------------------------- */
  /* Claiming - recorded as a side effect of authoring a solid          */
  /* ---------------------------------------------------------------- */

  /**
   * Record that something solid stands here, and report what it stands on.
   *
   * Called from the collider calls themselves rather than from a second list a
   * builder has to remember to write - the whole reason `Gym.scope()` works is
   * that there is no way to author an obstacle it does not see.
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
     * while burying every real conflict under one enormous one. Nothing in the
     * station trips it today; it is here so that the day something does, it
     * costs a refusal rather than a minute. */
    if ((gx1 - gx0 + 1) * (gz1 - gz0 + 1) > MAX_CLAIM_CELLS) return null;

    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) this._claimed.add(occCellKey(gx, gz));
    }

    /* Test true, against the corridor itself. Nothing below consults the raster
     * above it: the cells record what has been BUILT, and the question a
     * conflict answers is what the ground is FOR. */
    const hit = this._regionUnder(x, z, hx, hz, yaw, null)?.role ?? null;
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
   * what the box test in the physics layer does: 7,620 disagreements in 200,000
   * random cases with the negated angle, and ZERO with this one.
   *
   * The negation is already carried by the shape of the two expressions - the
   * pair `(dx*c - dz*s, dx*s + dz*c)` projects onto the rect's local axes when
   * `c`/`s` are the cosine and sine of the yaw ITSELF. Negating the angle as
   * well applies the inverse twice, which for a rotation is a reflection, and
   * a reflection is invisible on anything square or axis-aligned. That is why
   * it survived: it only shows on a rotated, non-square claim.
   *
   * It matters more now than when it was found. It is the confirm step for
   * `roleAt` and for the occupancy fraction, and the local axes it defines are
   * the ones `_strip`, `_rectsMeet` and `_discMeetsRect` are all written
   * against - so getting the sign wrong would mirror the CORRIDORS as well as
   * the claims.
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
   * Do two rotated rectangles share any ground? The separating-axis test.
   *
   * Four candidate axes, because a rectangle's edge normals are its two local
   * axes and a rectangle has only two distinct ones. If no axis separates them
   * they overlap - which for convex shapes is not a heuristic but the
   * definition - so this is exact, and it is the whole reason a 0.25 m lamp
   * beside a kerb and a 0.5 m mast in the middle of a road now get opposite
   * answers.
   *
   * Axes as `_rectCovers` defines them: `(cos y, -sin y)` and `(sin y, cos y)`.
   */
  _rectsMeet(a, b) {
    const ac = Math.cos(a.yaw), as = Math.sin(a.yaw);
    const bc = Math.cos(b.yaw), bs = Math.sin(b.yaw);
    const A = [[ac, -as], [as, ac]];
    const B = [[bc, -bs], [bs, bc]];
    const dx = b.x - a.x, dz = b.z - a.z;
    for (const L of [A[0], A[1], B[0], B[1]]) {
      const gap = Math.abs(dx * L[0] + dz * L[1]);
      const ra = a.hx * Math.abs(A[0][0] * L[0] + A[0][1] * L[1])
               + a.hz * Math.abs(A[1][0] * L[0] + A[1][1] * L[1]);
      const rb = b.hx * Math.abs(B[0][0] * L[0] + B[0][1] * L[1])
               + b.hz * Math.abs(B[1][0] * L[0] + B[1][1] * L[1]);
      if (gap > ra + rb) return false;
    }
    return true;
  }

  /**
   * Does a disc reach a rotated rectangle? The nearest point of the rect to the
   * disc's centre, found by clamping in the rect's own frame, is the whole
   * test - and it is exact for the same reason the separating axes are.
   */
  _discMeetsRect(d, r) {
    const c = Math.cos(r.yaw), s = Math.sin(r.yaw);
    const dx = d.x - r.x, dz = d.z - r.z;
    const lx = dx * c - dz * s, lz = dx * s + dz * c;
    const nx = Math.min(r.hx, Math.max(-r.hx, lx));
    const nz = Math.min(r.hz, Math.max(-r.hz, lz));
    return Math.hypot(lx - nx, lz - nz) <= d.r;
  }

  /**
   * The first seeded region a footprint touches, or null.
   *
   * `only` narrows it to one role AND turns precedence off, which is the
   * difference between the two questions this answers.
   *
   * Without it the question is "what ground is this thing standing on", and an
   * earlier region wins: a pallet at r = 39.5 straddling an avenue mouth is on
   * the PLAZA, because the plaza owns everything inside its circle.
   *
   * With it the question is "does this footprint touch that role at all", which
   * is what a placement loop wants before it commits - the same pallet DOES
   * reach the avenue strip, and a loop hunting a bearing that clears the road
   * should be told so rather than be told about the plaza.
   */
  _regionUnder(x, z, hx, hz, yaw, only) {
    const q = { x, z, hx, hz, yaw };
    const qbr = Math.hypot(hx, hz);
    for (const g of this._regions) {
      if (only && g.role !== only) continue;
      /* Bounding circles first: two shapes further apart than the sum of their
       * radii cannot meet. A conservative reject, so it can only save work. */
      if (Math.hypot(g.x - x, g.z - z) > g.br + qbr) continue;
      if (g.kind === 'disc' ? this._discMeetsRect(g, q) : this._rectsMeet(g, q)) return g;
    }
    return null;
  }

  /**
   * Which seeded role a footprint would land on - WITHOUT claiming it.
   *
   * `claim` is the reporting path: it records the conflict and marks the cells,
   * so a builder cannot use it to ask a question before deciding. This is the
   * question. It is the same corridor test, minus the bookkeeping, and it
   * exists so a placement loop can get out of a road rather than build across
   * it and be counted afterwards.
   *
   * `only` matters for a second reason as well: the plan seeds carriageways,
   * plazas AND sightlines, and refusing every block that clips a sightline
   * would delete most of the backdrop the gateways are silhouetted against. A
   * building standing in a road is a defect; a building at the edge of a
   * sightline is a composition question.
   *
   * ── There is no size floor any more ───────────────────────────────────────
   * The first version of this file could not see a footprint smaller than
   * `OCC_CELL / 2` = 0.75 m, and every caller was under instruction to pad its
   * query to at least 1.2 so it got an answer about the road rather than about
   * the grid. That instruction is withdrawn: ask at the footprint's own
   * half-extents, because a padded query is now a WRONG query.
   *
   * @param {string|null} [only] restrict to this role
   * @returns {string|null} the role hit, or null
   */
  roleUnder(x, z, hx, hz, yaw = 0, only = null) {
    return this._regionUnder(x, z, hx, hz, yaw, only)?.role ?? null;
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
   * ── This one is still a raster, and it should be ─────────────────────────
   * `roleUnder` stopped asking the grid because thirteen corridors can be
   * tested exactly. What this asks about is every solid the build has authored
   * so far - eleven thousand arbitrary rectangles - and a 1.5 m raster is the
   * right shape for that.
   *
   * So it inherits the raster's floor, stated here rather than discovered
   * later: a footprint smaller than a cell can cover no cell centre, and zero
   * covered cells answers 0, which reads as "clear". Its only callers are
   * backdrop blocks tens of metres across, and a sub-metre caller would be
   * asking the wrong question of it anyway - but that is the trap, and it is
   * the last one of its kind left in this file.
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

  /** The role at a world position, or null. A point in a shape, not in a cell. */
  roleAt(x, z) {
    for (const g of this._regions) {
      if (g.kind === 'disc') {
        if (Math.hypot(x - g.x, z - g.z) <= g.r) return g.role;
      } else if (this._rectCovers(g.x, g.z, g.hx, g.hz, g.yaw, x, z)) return g.role;
    }
    return null;
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
