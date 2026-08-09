/**
 * Collision descriptors for a district - plain numbers, no THREE, no meshes.
 *
 * This separation is a spec requirement, not a style choice. The browser turns
 * these into `physics.addBox` calls *and* into instanced meshes; Node turns the
 * same descriptors into a collision world with no renderer at all, which is
 * what lets the containment, seam and prop-ladder gates run headless in
 * seconds. Derive colliders from built meshes instead and every one of those
 * gates becomes browser-bound.
 *
 * @typedef {{ cx:number, cy:number, cz:number,
 *             hx:number, hy:number, hz:number,
 *             kind:'hedge'|'floor'|'stair'|'shaftWall',
 *             enclosed?:boolean }} ColliderDesc
 */

import { MAZE, DIR, cellIndex, isOpen, cellToWorld } from './MazeTopology.js';
import {
  shaftColliders, landingColliders, connectorHoleBounds, gateColliders,
  slidingWallColliders,
} from './MazeShafts.js';
import { PUZZLE } from './MazePuzzles.js';

/* Moved to MazeTopology.js in Phase 2c so that MazeShafts.js can use it
 * without importing this module, which would make the two import each
 * other - the cycle MazeChunks.js's own comment records avoiding. Re-exported
 * here because a dozen call sites and three test files already import it from
 * this path, and a rename adds churn without adding safety. */
export { cellToWorld } from './MazeTopology.js';

export const FORECOURT_HALF_WIDTH = 9;
/** North (far, closed) wall's z. South edge is the grid boundary at z=0. */
export const FORECOURT_NORTH_Z = -20;
/**
 * Where the portal itself stands - centred, and far enough from every wall
 * (10 m to the north wall, 9 m to each side wall) that the ~4.6 m widest
 * reach of the plinth and its steps cannot touch one.
 */
export const FORECOURT_PORTAL_Z = FORECOURT_NORTH_Z / 2;

/**
 * The walled forecourt outside the maze's north edge, where the return portal
 * stands.
 *
 * `PortalSystem`'s generic plinth (see PLINTH_TIERS in systems/Portals.js) is
 * an octagon of radius ~4.15 m plus front approach steps reaching another
 * ~4.6 m further out - nowhere near small enough to fit inside a single 6 m
 * maze cell with a 4.8 m corridor. `MazeTopology.carveEntranceCorridor` opens
 * a one-cell corridor from the entrance out to the grid's edge; this is the
 * room that corridor opens into - 18 m wide, 20 m deep, walled on three
 * sides, with the fourth (the side facing the corridor) left open.
 *
 * @param {number} entranceX world-space x of the entrance column
 *   (`cellToWorld(ex, ez, level).x`)
 * @param {number} [level]
 * @returns {ColliderDesc[]}
 */
export function forecourtColliders(entranceX, level = 0) {
  const baseY = level * MAZE.LEVEL_HEIGHT;
  const HH = MAZE.HEDGE_HEIGHT / 2;
  const HT = MAZE.HEDGE_THICK / 2;
  /** @type {ColliderDesc[]} */
  const out = [];

  // Floor. Extends half a cell past the grid boundary (z = HALF_CELL) to
  // overlap the entrance district's own floor slab, which overhangs the same
  // amount the other way - the same seam-closing trick `districtColliders`
  // uses at every other district border.
  const southZ = MAZE.CELL / 2;
  out.push({
    cx: entranceX,
    cy: baseY - 0.5,
    cz: (FORECOURT_NORTH_Z + southZ) / 2,
    hx: FORECOURT_HALF_WIDTH,
    hy: 0.5,
    hz: (southZ - FORECOURT_NORTH_Z) / 2,
    kind: 'floor',
  });

  // North (far) wall - closes the room off from open air behind the portal.
  out.push({
    cx: entranceX,
    cy: baseY + HH,
    cz: FORECOURT_NORTH_Z,
    hx: FORECOURT_HALF_WIDTH,
    hy: HH,
    hz: HT,
    kind: 'hedge',
  });

  // West and east walls, running the room's full depth. Left open at z=0: the
  // corridor mouth.
  const wallHalfDepth = (0 - FORECOURT_NORTH_Z) / 2;
  const wallCz = FORECOURT_NORTH_Z / 2;
  for (const sx of [-1, 1]) {
    out.push({
      cx: entranceX + sx * FORECOURT_HALF_WIDTH,
      cy: baseY + HH,
      cz: wallCz,
      hx: HT,
      hy: HH,
      hz: wallHalfDepth,
      kind: 'hedge',
    });
  }

  return out;
}

/**
 * Every collider for one district.
 *
 * A hedge is emitted on a cell's north and west sides only, plus on the south
 * and east sides of a cell that sits on the GLOBAL grid's far edge (`z`/`x` ===
 * `MAZE.CELLS - 1`), where no neighbouring cell exists to own that face.
 * Emitting all four sides per cell would double every interior wall - two
 * coincident colliders in the same place, each answering every query. The
 * south/east fallback used to key on the *district's* last row and column
 * instead, which was wrong: every internal district seam is also a district's
 * last row or column from one side, so that version emitted a duplicate hedge
 * at every seam. Keying on the grid's edge instead of the district's edge is
 * what keeps this to one hedge per interior wall.
 *
 * @param {Uint8Array} cells
 * @param {number} dx
 * @param {number} dz
 * @param {number} level
 * @returns {ColliderDesc[]}
 */
export function districtColliders(cells, dx, dz, level, puzzles = null) {
  const D = MAZE.DISTRICT;
  const x0 = dx * D;
  const z0 = dz * D;
  const baseY = level * MAZE.LEVEL_HEIGHT;
  /** @type {ColliderDesc[]} */
  const out = [];

  /* Fix round 2, Finding 1: a shaft's stairs climb into this district's OWN
   * floor slab unless it has a hole where the shaft lands. The district
   * graph allows at most one UP edge per (dx,dz,level) node (see
   * buildDistrictGraph - each node has at most one "up" neighbour), and
   * carveDistrict places at most one vertical doorway per open edge, so at
   * most one cell in this whole district can carry DIR.UP at level-1
   * landing here. Scanning for it costs one pass over the district's own
   * cells at the level below - cheap, and simpler than threading district
   * coordinates into a per-cell "is this a shaft landing" query. */
  let hole = null;
  if (level > 0) {
    for (let lz = 0; lz < D && !hole; lz++) {
      for (let lx = 0; lx < D; lx++) {
        const hx = x0 + lx, hz = z0 + lz;
        if (isOpen(cells, cellIndex(hx, hz, level - 1), DIR.UP)) { hole = { x: hx, z: hz }; break; }
      }
    }
  }

  /* One floor slab per district, extended half a cell past every border so it
   * overlaps its neighbours. A chunk boundary must never be a hole to fall
   * through, and an overlap is the cheapest possible guarantee of that -
   * EXCEPT the one deliberate hole above a shaft landing, which must let a
   * climbing capsule through while still supporting a pedestrian walking
   * level `level` everywhere else.
   *
   * Nothing walls that pedestrian off from the hole any more - the shaft's
   * own walls stop at `LEVEL_HEIGHT`, and they have to (fix round 3: running
   * them higher sealed the climber into a 6x6 m box and severed level
   * `level`'s own corridors). What keeps the pedestrian safe instead is that
   * the hole is only the stair well, with the floor still all round it and
   * guard walls on the three sides where walking in would be a fall. The
   * fourth side is the landing, whose top is flush with this floor. */
  const half = (D * MAZE.CELL + MAZE.CELL) / 2;
  const originX = x0 * MAZE.CELL;
  const originZ = z0 * MAZE.CELL;
  const centerX = originX + (D - 1) * MAZE.CELL / 2;
  const centerZ = originZ + (D - 1) * MAZE.CELL / 2;
  const floorX0 = centerX - half, floorX1 = centerX + half;
  const floorZ0 = centerZ - half, floorZ1 = centerZ + half;

  const pushFloorRect = (fx0, fx1, fz0, fz1) => {
    out.push({
      cx: (fx0 + fx1) / 2,
      cy: baseY - 0.5,
      cz: (fz0 + fz1) / 2,
      hx: (fx1 - fx0) / 2,
      hy: 0.5,
      hz: (fz1 - fz0) / 2,
      kind: 'floor',
    });
  };

  if (!hole) {
    pushFloorRect(floorX0, floorX1, floorZ0, floorZ1);
  } else {
    /* Tile the district floor as four rectangles around the hole - west and
     * east strips run the full Z span; north and south strips fill the
     * remaining middle column only. Together with the hole itself (left
     * empty) this covers the district's full floor footprint exactly once:
     * no overlap, no gap, anywhere except the hole.
     *
     * Fix round 4: the hole is the STAIR WELL, not the shaft cell. Round 2
     * punched out the whole 6x6 m cell, which is what put an open 9 m pit
     * over every shaft the moment round 3 stopped walling that cell off from
     * above - 427 of 529 sample points across the cell dropped the full
     * level. The stair only ever needs the well (2.8 m of the cell's 6 m,
     * one quadrant of it), which is 7.8 of the cell's 36 square metres; the
     * floor stays put everywhere else, which is what a stairwell is. The
     * bounds come from `connectorHoleBounds` rather than being re-derived
     * here, so the hole and the geometry inside it can never disagree - and
     * since Phase 2c that is a per-CONNECTOR question, because a tunnel needs
     * a rectangle two cells long where a stair needs one square well.
     *
     * NOTE THE `level - 1`: the hole is punched in level `level`'s floor for a
     * connector that lives one level BELOW, which is how the `hole` scan above
     * found it. Getting this off by one would put a correctly-shaped hole in
     * the wrong place with every gate still green, because the geometry and
     * the hole would both be self-consistent and both wrong. */
    const well = connectorHoleBounds(cells, hole.x, hole.z, level - 1);
    pushFloorRect(floorX0, well.x0, floorZ0, floorZ1); // west
    pushFloorRect(well.x1, floorX1, floorZ0, floorZ1); // east
    pushFloorRect(well.x0, well.x1, floorZ0, well.z0); // north (middle column)
    pushFloorRect(well.x0, well.x1, well.z1, floorZ1); // south (middle column)

    /* Guard rails, and for a lift its landing door. A hole in a floor you can
     * simply walk into is a pit; a hole with a rail round it and one way in is
     * a stairwell. The layout differs per connector, so it lives in
     * `landingColliders` beside the geometry it guards rather than here -
     * a lift's door in particular has to agree with the car it admits you to.
     *
     * Emitted unconditionally, including on faces where level `level`'s own
     * hedge may already stand. That is Trap 2's rule: a shaft's safety must
     * never depend on a NEIGHBOURING cell's collider output, and south/east
     * hedges are owned by the neighbour, which can be in a different
     * district. Two possibly-redundant colliders per shaft is the price. */
    for (const d of landingColliders(cells, hole.x, hole.z, level - 1)) out.push(d);
  }

  const HH = MAZE.HEDGE_HEIGHT / 2;
  const HT = MAZE.HEDGE_THICK / 2;
  const HALF_CELL = MAZE.CELL / 2;

  /** Wall spanning a full cell edge, thickness across the passage direction. */
  const pushHedge = (cx, cz, axis) => {
    out.push({
      cx,
      cy: baseY + HH,
      cz,
      hx: axis === 'x' ? HT : HALF_CELL,
      hy: HH,
      hz: axis === 'x' ? HALF_CELL : HT,
      kind: 'hedge',
    });
  };

  for (let lz = 0; lz < D; lz++) {
    for (let lx = 0; lx < D; lx++) {
      const x = x0 + lx;
      const z = z0 + lz;
      const idx = cellIndex(x, z, level);
      const w = cellToWorld(x, z, level);

      // North face (-z). Owned by this cell.
      if (!isOpen(cells, idx, DIR.N)) pushHedge(w.x, w.z - HALF_CELL, 'z');
      // West face (-x). Owned by this cell.
      if (!isOpen(cells, idx, DIR.W)) pushHedge(w.x - HALF_CELL, w.z, 'x');
      // South and east only on the global grid's far edges, where no adjacent cell
      // exists to own them. Using global grid coordinates (z, x not lz, lx) prevents
      // duplicate emission at district seams, where both adjacent districts would
      // otherwise emit hedges at the same position.
      if (z === MAZE.CELLS - 1 && !isOpen(cells, idx, DIR.S)) pushHedge(w.x, w.z + HALF_CELL, 'z');
      if (x === MAZE.CELLS - 1 && !isOpen(cells, idx, DIR.E)) pushHedge(w.x + HALF_CELL, w.z, 'x');

      // A cell carrying the UP link becomes a shaft: steps plus its own full
      // enclosure, emitted regardless of which side of the district (x,z)
      // falls on - shaftColliders walls all four of ITS OWN sides itself, so
      // (unlike the N/W-owned hedges above) a shaft's enclosure never depends
      // on a neighbouring district's output.
      if (isOpen(cells, idx, DIR.UP)) {
        for (const d of shaftColliders(cells, x, z, level)) out.push(d);
      }

      /* A puzzle, if one was placed at this cell. The map is handed down from
       * the world rather than derived here: placement is a SEED and GRAPH
       * decision, and this function has neither - the same constraint that put
       * connector kinds in the topology array. A caller with no puzzles (every
       * headless gate) simply gets none. */
      const pz = puzzles?.get(idx);
      if (pz) {
        const make = pz.kind === PUZZLE.SLIDE ? slidingWallColliders : gateColliders;
        for (const d of make(cells, x, z, level, pz.dir)) out.push(d);
      }
    }
  }

  return dropHedgesInsideShafts(out, neighbouringShaftWalls(cells, dx, dz, level));
}

/**
 * How far outside a district a shaft wall can stand and still coincide with a
 * hedge this district emits.
 *
 * ONE cell for the shaft itself: a shaft in the last column of the district to
 * the west walls its own east side, and that wall stands on the shared cell
 * boundary - which is exactly where this district's first column draws its
 * west-face hedges. ONE MORE for a TUNNEL, whose region folds across two cells
 * (see `connectorRegion`), so its outermost wall can stand two cells away from
 * the cell that actually carries the UP link. Nothing reaches further: every
 * other connector lives inside a single cell.
 */
const SHAFT_WALL_REACH = 2;

/**
 * The shaft walls of cells just OUTSIDE this district.
 *
 * A district's hedges and its shafts are not the same district's business.
 * A hedge is emitted on a cell's north and west faces (see
 * `districtColliders`), so the hedge that duplicates a shaft's EAST or SOUTH
 * wall belongs to the neighbouring cell - and when the shaft sits at
 * `lx === DISTRICT - 1` or `lz === DISTRICT - 1` that neighbour is in the NEXT
 * district. A drop pass over one district's own finished list therefore never
 * saw those pairs: measured on seed 7, the shaft at cell (99,15) had district
 * (4,0) emit its wall at x=597, z=90 spanning y 0-9 m while district (5,0)
 * emitted a hedge with the identical footprint spanning y 0-5 m, and both the
 * stripe and the duplicate collider survived.
 *
 * So the walls come to the pass rather than the pass being moved into the cell
 * loop. They are DERIVED with `shaftColliders`, the same call the cell loop
 * makes, because "where a shaft's walls are" must have exactly one definition
 * in this repo - a second one that agrees today is the bug class this whole
 * file's history is made of. They are used only as drop candidates and never
 * emitted: the district that owns the shaft still emits it exactly once.
 *
 * The whole ring is scanned, not just the west and north sides that can
 * actually match. Which side of a cell owns which face is precisely the
 * reasoning `dropHedgesInsideShafts` exists to avoid re-encoding - containment
 * is the property, and it is checked directly - and a wall that cannot contain
 * anything simply never matches.
 *
 * SAFETY, since this drops a collider on the strength of a box in a district
 * that may not be resident: `MazeChunks.updateResidency` keeps a
 * `radius`-district neighbourhood around the PLAYER'S OWN district (default 2,
 * never less than 1). A hedge on this district's west border can only be
 * touched by a player standing in this district or in the one to the west, and
 * in either case both are inside that neighbourhood. The wall is always loaded
 * before anyone can walk into the space the hedge used to fill.
 */
function neighbouringShaftWalls(cells, dx, dz, level) {
  const D = MAZE.DISTRICT;
  const R = SHAFT_WALL_REACH;
  const x0 = dx * D, z0 = dz * D;
  const out = [];
  for (let z = z0 - R; z < z0 + D + R; z++) {
    if (z < 0 || z >= MAZE.CELLS) continue;
    for (let x = x0 - R; x < x0 + D + R; x++) {
      if (x < 0 || x >= MAZE.CELLS) continue;
      // This district's own shafts are already in the list being filtered.
      if (x >= x0 && x < x0 + D && z >= z0 && z < z0 + D) continue;
      for (const d of shaftColliders(cells, x, z, level)) {
        if (d.kind === 'shaftWall') out.push(d);
      }
    }
  }
  return out;
}

/**
 * Remove hedges that a shaft wall already covers.
 *
 * A shaft walls all four of its own sides, and those walls stand exactly where
 * the hedges around that cell stand - same centre, same footprint, the hedge
 * simply being the lower five metres of a nine-metre wall. Both were emitted:
 * measured at 9 such pairs in a six-district sample, the worst of them 36 m3
 * of one box sitting entirely inside another.
 *
 * Two coplanar surfaces z-fight, and looking up a tower the stripes are the
 * most obvious artifact in the world - they survive shadows being switched
 * off, which is what ruled out shadow acne. Dropping the hedge also drops a
 * duplicate collider that was answering every query alongside the wall.
 *
 * Done as a pass over the finished list rather than as a condition inside the
 * cell loop because the four faces of a shaft are owned by four DIFFERENT
 * cells - a shaft's south face is the north face of the cell below it - so the
 * loop that emits a hedge does not generally know it is standing on a shaft.
 * Containment is the actual property, and it is checked directly.
 *
 * `extraWalls` extends that same reasoning across the district boundary: the
 * owning cell can be in the next district entirely, so the walls it must be
 * checked against are not all in `descs`. See `neighbouringShaftWalls`.
 */
function dropHedgesInsideShafts(descs, extraWalls = []) {
  const walls = descs.filter((d) => d.kind === 'shaftWall').concat(extraWalls);
  if (walls.length === 0) return descs;
  const inside = (h, w) => (
    h.cx - h.hx >= w.cx - w.hx - 1e-6 && h.cx + h.hx <= w.cx + w.hx + 1e-6
    && h.cy - h.hy >= w.cy - w.hy - 1e-6 && h.cy + h.hy <= w.cy + w.hy + 1e-6
    && h.cz - h.hz >= w.cz - w.hz - 1e-6 && h.cz + h.hz <= w.cz + w.hz + 1e-6
  );
  return descs.filter((d) => d.kind !== 'hedge' || !walls.some((w) => inside(d, w)));
}
