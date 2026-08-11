/**
 * Pure map data - the cell array turned into things a canvas can draw.
 *
 * No DOM and no canvas, deliberately: both map surfaces (the `M` map and the
 * minimap's baked floorplan) need the same walls, and putting the derivation
 * here means it can be asserted under `node --test` instead of only being
 * looked at. The same division that lets the maze's collision gates run
 * headless in seconds.
 *
 * The spec makes the topology array the single source of truth for the map and
 * the minimap (section 3), so nothing here consults geometry - which is just
 * as well, since geometry only exists for the districts that happen to be
 * streamed in.
 */
import { MAZE, DIR, cellIndex, isOpen } from './MazeTopology.js';

/**
 * What makes a world's baked floorplan unique.
 *
 * `Minimap` caches baked plans, and cached them on `world.id` alone - correct
 * for the five worlds that are built once, and wrong for the maze, which
 * RE-ROLLS on every entry. The second visit was drawn with the first visit's
 * walls: a map of a maze that no longer exists, which is worse than no map,
 * because a player trusts it.
 *
 * A world that is more than its id says so by exposing `minimapPlanKey`.
 * Nothing here knows what a maze is.
 *
 * @param {{id?:string, minimapPlanKey?:string}|null|undefined} world
 * @returns {string}
 */
export function planCacheKey(world) {
  return world?.minimapPlanKey ?? world?.id ?? world?.constructor?.id ?? 'unknown';
}

/**
 * Every hedge segment on one level, in CELL coordinates.
 *
 * A segment is emitted for a cell's north and west faces when that passage is
 * closed, plus the grid's own far edges - the same ownership rule
 * `districtColliders` uses, and for the same reason: emitting all four faces
 * per cell would draw every interior wall twice.
 *
 * @param {Uint8Array} cells
 * @param {number} level
 * @returns {Array<{x0:number, z0:number, x1:number, z1:number}>}
 */
export function levelSegments(cells, level) {
  const out = [];
  const N = MAZE.CELLS;
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const idx = cellIndex(x, z, level);
      if (!isOpen(cells, idx, DIR.N)) out.push({ x0: x, z0: z, x1: x + 1, z1: z });
      if (!isOpen(cells, idx, DIR.W)) out.push({ x0: x, z0: z, x1: x, z1: z + 1 });
      if (z === N - 1 && !isOpen(cells, idx, DIR.S)) out.push({ x0: x, z0: z + 1, x1: x + 1, z1: z + 1 });
      if (x === N - 1 && !isOpen(cells, idx, DIR.E)) out.push({ x0: x + 1, z0: z, x1: x + 1, z1: z + 1 });
    }
  }
  return out;
}
