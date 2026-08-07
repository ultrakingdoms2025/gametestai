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
 *             kind:'hedge'|'floor'|'stair',
 *             enclosed?:boolean }} ColliderDesc
 */

import { MAZE, DIR, cellIndex, isOpen } from './MazeTopology.js';

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
 * Centre of a cell's floor, in world metres.
 * Cell 0,0 sits at the origin; the grid extends into +x/+z.
 */
export function cellToWorld(x, z, level) {
  return {
    x: x * MAZE.CELL,
    y: level * MAZE.LEVEL_HEIGHT,
    z: z * MAZE.CELL,
  };
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
export function districtColliders(cells, dx, dz, level) {
  const D = MAZE.DISTRICT;
  const x0 = dx * D;
  const z0 = dz * D;
  const baseY = level * MAZE.LEVEL_HEIGHT;
  /** @type {ColliderDesc[]} */
  const out = [];

  /* One floor slab per district, extended half a cell past every border so it
   * overlaps its neighbours. A chunk boundary must never be a hole to fall
   * through, and an overlap is the cheapest possible guarantee of that. */
  const half = (D * MAZE.CELL + MAZE.CELL) / 2;
  const originX = x0 * MAZE.CELL;
  const originZ = z0 * MAZE.CELL;
  out.push({
    cx: originX + (D - 1) * MAZE.CELL / 2,
    cy: baseY - 0.5,
    cz: originZ + (D - 1) * MAZE.CELL / 2,
    hx: half,
    hy: 0.5,
    hz: half,
    kind: 'floor',
  });

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
    }
  }

  return out;
}

/**
 * Extra clearance added above `highest standable + HOP` when deriving a
 * shaft's required wall height. The hop figure alone is the theoretical apex;
 * this exists so a wall that clears it by inches, rather than comfortably,
 * still counts as sound after floating-point slop in the geometry that will
 * eventually generate these shafts.
 */
const ENCLOSURE_MARGIN = 0.5;

/**
 * How high a shaft's walls must reach to contain what is inside it.
 *
 * The first draft of this rule used a constant - hedge height - and that was
 * wrong in a way that destroyed the guarantee it existed to protect:
 * `LEVEL_HEIGHT` is 9.0 m, so a staircase climbing a real level inside 5.0 m
 * walls satisfied a fixed bar while leaving the top of the stairs 4 m above
 * the walls meant to contain them. A shaft's walls must clear its own
 * contents, so the bar is derived from the highest `enclosed` standable
 * surface actually inside the shaft's footprint - the highest point a player
 * can reach by walking to the top of it - plus one hop plus a margin. A shaft
 * with nothing enclosed in it (there is nothing to climb) falls back to hedge
 * height, matching the original band rule.
 *
 * @param {ColliderDesc[]} descs
 * @param {{cx:number, cz:number, floorY:number}} shaft
 * @returns {number} absolute world Y the walls must reach
 */
function requiredWallTop(descs, shaft) {
  const half = MAZE.CELL / 2;
  const EPS = 1e-6;
  let highest = -Infinity;
  for (const d of descs) {
    if (!d.enclosed) continue;
    // Only surfaces that actually sit inside this shaft's footprint count -
    // an enclosed descriptor belonging to a neighbouring shaft must not raise
    // this one's bar.
    if (d.cx - d.hx > shaft.cx + half - EPS || d.cx + d.hx < shaft.cx - half + EPS) continue;
    if (d.cz - d.hz > shaft.cz + half - EPS || d.cz + d.hz < shaft.cz - half + EPS) continue;
    const top = d.cy + d.hy;
    if (top > highest) highest = top;
  }
  if (highest === -Infinity) return shaft.floorY + MAZE.HEDGE_HEIGHT;
  return highest + MAZE.HOP + ENCLOSURE_MARGIN;
}

/**
 * Is a shaft genuinely sealed?
 *
 * Phase 1's rule was absolute: nothing standable between 0.45 m and 5.0 m,
 * because anything there is a step onto a 5 m hedge. A staircase is made
 * entirely of such steps, so four levels cannot exist under that rule.
 *
 * The rule is therefore narrowed rather than dropped: a step may sit in the
 * band only inside a sealed shaft. This function is what makes that exemption
 * honest - it checks that the shaft's cell is walled on all four sides, from
 * its floor to `requiredWallTop` (a function of what is actually inside the
 * shaft, never a constant - see that function's comment), so a player using
 * the steps arrives on the next level rather than on top of the maze.
 *
 * Coverage on a side may be assembled from several colliders, as long as they
 * are vertically contiguous - two wall pieces stacked with no gap between
 * them wall a side exactly as well as one collider spanning the same range.
 * A gap between two pieces does not.
 *
 * @param {ColliderDesc[]} descs every collider near the shaft
 * @param {{cx:number, cz:number, floorY:number}} shaft cell centre and floor
 * @returns {boolean}
 */
export function isEnclosureSound(descs, shaft) {
  const half = MAZE.CELL / 2;
  const need = requiredWallTop(descs, shaft);
  const EPS = 1e-6;
  const sides = [
    { axis: 'x', at: shaft.cx - half },
    { axis: 'x', at: shaft.cx + half },
    { axis: 'z', at: shaft.cz - half },
    { axis: 'z', at: shaft.cz + half },
  ];

  for (const side of sides) {
    // Every wall piece that reaches this side's plane and spans the shaft's
    // full width along it, regardless of its own vertical extent - coverage
    // is decided by merging these intervals, not by any single piece alone.
    const intervals = [];
    for (const d of descs) {
      if (d.enclosed) continue;                      // steps do not wall a shaft

      // A wall covers this side only if its slab actually reaches the side's
      // plane *and* spans the shaft's full width along that plane - not merely
      // if its centre happens to sit within some distance of it. A north/south
      // wall's half-extent along x can equal a whole cell (it runs the cell's
      // full width), which makes a naive distance-to-centre test mistake it
      // for an east/west wall reaching that far; checking the wall's own
      // thin axis (here, z) against the shaft's full span is what tells the
      // two apart.
      if (side.axis === 'x') {
        if (d.cx - d.hx > side.at + EPS || d.cx + d.hx < side.at - EPS) continue;
        if (d.cz - d.hz > shaft.cz - half + EPS || d.cz + d.hz < shaft.cz + half - EPS) continue;
      } else {
        if (d.cz - d.hz > side.at + EPS || d.cz + d.hz < side.at - EPS) continue;
        if (d.cx - d.hx > shaft.cx - half + EPS || d.cx + d.hx < shaft.cx + half - EPS) continue;
      }
      intervals.push([d.cy - d.hy, d.cy + d.hy]);
    }

    intervals.sort((a, b) => a[0] - b[0]);
    let covered = false;
    let runBottom = null;
    let runTop = null;
    for (const [bottom, top] of intervals) {
      if (runBottom === null) {
        runBottom = bottom;
        runTop = top;
      } else if (bottom <= runTop + EPS) {
        // Overlaps or touches the run so far - extend it.
        if (top > runTop) runTop = top;
      } else {
        // A gap opened before this piece. Check whether the run that just
        // closed already satisfied the requirement; if not, start a fresh run
        // rather than letting an earlier, insufficient run keep being tested.
        if (runBottom <= shaft.floorY + EPS && runTop >= need - EPS) { covered = true; break; }
        runBottom = bottom;
        runTop = top;
      }
    }
    if (!covered && runBottom !== null && runBottom <= shaft.floorY + EPS && runTop >= need - EPS) {
      covered = true;
    }
    if (!covered) return false;
  }
  return true;
}
