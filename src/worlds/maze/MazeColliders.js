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
 *             kind:'hedge'|'floor' }} ColliderDesc
 */

import { MAZE, DIR, cellIndex, isOpen } from './MazeTopology.js';

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
 * and east sides of the district's last row and column. Emitting all four sides
 * per cell would double every interior wall - two coincident colliders in the
 * same place, each answering every query.
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
      // South and east only on the district's far edges, where no further cell
      // exists to own them.
      if (lz === D - 1 && !isOpen(cells, idx, DIR.S)) pushHedge(w.x, w.z + HALF_CELL, 'z');
      if (lx === D - 1 && !isOpen(cells, idx, DIR.E)) pushHedge(w.x + HALF_CELL, w.z, 'x');
    }
  }

  return out;
}
