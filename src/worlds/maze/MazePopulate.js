/**
 * Where to put things in the maze - pure functions over the topology array,
 * exactly like `MazeTopology.js` and for the same reason: this is what lets
 * the dead-end and patrol-connectivity gates run under `node --test` across
 * many seeds in a fraction of a second, with no THREE, no renderer, and no
 * per-build geometry cost.
 *
 * Nothing here places anything in world space. `MazeWorld.build()` converts
 * the cell indices this module returns into world positions with
 * `MazeColliders.cellToWorld` and builds meshes/NPC specs from them - the
 * split matches the one the design doc requires between colliders and
 * geometry (section 11).
 */

import {
  MAZE, DIR, HORIZONTAL, OPPOSITE, cellIndex, cellCoords, isOpen, mulberry32, hash32,
  neighbourOf,
} from './MazeTopology.js';

/** Bitmask of the four horizontal passage bits, as opposed to DIR.UP/DOWN. */
const HMASK = DIR.N | DIR.E | DIR.S | DIR.W;

/** How many of a cell's four horizontal passages are open. */
export function openDirCount(cells, idx) {
  let n = 0;
  for (const d of HORIZONTAL) if ((cells[idx] & d) !== 0) n++;
  return n;
}

/**
 * A dead end: exactly one open horizontal passage. The corridor punishes you
 * for walking in - which is exactly why a reward belongs here (see the maze
 * design doc, "things to find").
 */
export function isDeadEnd(cells, idx) {
  return openDirCount(cells, idx) === 1;
}

/**
 * Every dead-end cell on `level`, in scan order (z-major, then x), excluding
 * anything in `exclude`.
 */
export function findDeadEnds(cells, level, exclude = null) {
  const out = [];
  for (let z = 0; z < MAZE.CELLS; z++) {
    for (let x = 0; x < MAZE.CELLS; x++) {
      const idx = cellIndex(x, z, level);
      if (exclude && exclude.has(idx)) continue;
      if ((cells[idx] & HMASK) === 0) continue; // orphaned cell, not a dead end
      if (isDeadEnd(cells, idx)) out.push(idx);
    }
  }
  return out;
}

/** Fisher-Yates using a supplied RNG, so callers get a deterministic shuffle. */
function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Pick `count` dead-end cells spread across the whole grid rather than
 * clustered wherever the scan happens to find them first.
 *
 * The grid is divided into `REGIONS x REGIONS` coarse buckets; at most one
 * dead end is drawn from each bucket, in a seed-shuffled bucket order, so a
 * seed that happens to carve most of its dead ends near the entrance still
 * yields tokens spread across the level. If there are fewer dead ends than
 * `count` (or they are concentrated into fewer buckets than `count`), the
 * remainder is filled from whatever is left over - "roughly `count`", not a
 * hard guarantee, because a maze that carved unusually few dead ends must
 * not throw.
 *
 * @param {Uint8Array} cells
 * @param {number} level
 * @param {number} seed
 * @param {number} [count]
 * @param {Set<number>} [exclude] cell indices that must never be chosen
 *   (e.g. the entrance and centre cells)
 * @returns {number[]} cell indices, each unique
 */
export function pickDeadEndTokens(cells, level, seed, count = 40, exclude = null) {
  const deadEnds = findDeadEnds(cells, level, exclude);
  if (deadEnds.length === 0) return [];

  const REGIONS = 8;
  const regionSize = MAZE.CELLS / REGIONS;
  const byRegion = new Map();
  for (const idx of deadEnds) {
    const { x, z } = cellCoords(idx);
    const key = Math.floor(z / regionSize) * REGIONS + Math.floor(x / regionSize);
    let bucket = byRegion.get(key);
    if (!bucket) { bucket = []; byRegion.set(key, bucket); }
    bucket.push(idx);
  }

  const rng = mulberry32(hash32(seed, 0x70c3));
  const regionKeys = shuffle([...byRegion.keys()], rng);

  const picked = [];
  const pickedSet = new Set();
  for (const key of regionKeys) {
    if (picked.length >= count) break;
    const bucket = byRegion.get(key);
    const choice = bucket[Math.floor(rng() * bucket.length)];
    picked.push(choice);
    pickedSet.add(choice);
  }

  // Regions ran out before count did (fewer buckets populated than `count`
  // asks for) - top up from whatever dead ends were not already used.
  if (picked.length < count) {
    for (const idx of deadEnds) {
      if (picked.length >= count) break;
      if (pickedSet.has(idx)) continue;
      picked.push(idx);
      pickedSet.add(idx);
    }
  }

  return picked;
}

/** Smallest cols x rows rectangle that has at least `count` cells. */
function regionGrid(count) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.max(1, Math.ceil(count / cols));
  return { cols, rows };
}

/**
 * Pick `count` sites spread across the grid for standing/patrolling NPCs.
 *
 * Unlike `pickDeadEndTokens`, every cell is a legitimate site - the floor is
 * continuous everywhere in this level, only the passages between cells are
 * ever closed - so this does not need to search for anything: it lays a
 * `cols x rows` region grid sized to `count`, shuffles the region order by
 * seed, and takes the centre cell of each of the first `count` regions.
 * That is what keeps eight wanderers from ever bunching into one corner of a
 * 2.4 km level.
 *
 * @param {Uint8Array} cells
 * @param {number} level
 * @param {number} seed
 * @param {number} [count]
 * @param {Set<number>} [exclude] cell indices to steer clear of
 * @returns {number[]} exactly `count` cell indices (regionGrid always
 *   produces at least `count` regions)
 */
export function pickWandererSites(cells, level, seed, count = 8, exclude = null) {
  const { cols, rows } = regionGrid(count);
  const regionW = MAZE.CELLS / cols;
  const regionH = MAZE.CELLS / rows;

  const regionKeys = [];
  for (let ry = 0; ry < rows; ry++) {
    for (let rx = 0; rx < cols; rx++) regionKeys.push(ry * cols + rx);
  }
  const rng = mulberry32(hash32(seed, 0x9e17));
  shuffle(regionKeys, rng);

  const sites = [];
  for (const key of regionKeys) {
    if (sites.length >= count) break;
    const rx = key % cols;
    const ry = Math.floor(key / cols);
    let x = Math.min(MAZE.CELLS - 1, Math.floor((rx + 0.5) * regionW));
    let z = Math.min(MAZE.CELLS - 1, Math.floor((ry + 0.5) * regionH));
    let idx = cellIndex(x, z, level);
    // A region centre landing exactly on an excluded cell (entrance/centre)
    // is vanishingly unlikely given 400x400 cells and a handful of regions,
    // but nudge off it rather than ever hand back a forbidden cell.
    if (exclude && exclude.has(idx) && x + 1 < MAZE.CELLS) {
      x += 1;
      idx = cellIndex(x, z, level);
    }
    sites.push(idx);
  }
  return sites;
}

/**
 * Walk a patrol route of up to `steps` further cells from `startIdx`,
 * stepping only through passages the topology actually has open. Never
 * reverses the immediately-previous step unless that is the only option, so
 * a two-way dead end does not just read as pacing on the spot every time.
 *
 * The route can end early (fewer than `steps` extra points) if it walks into
 * a genuine dead end with no other option and immediate backtrack was the
 * only choice too - which is correct: stopping short is a valid, fully-open
 * route, and forcing extra steps would risk manufacturing a step that is not
 * actually open.
 *
 * @param {Uint8Array} cells
 * @param {number} level
 * @param {number} startIdx
 * @param {number} steps
 * @param {number} seed
 * @returns {number[]} cell indices, `startIdx` first; consecutive entries
 *   are always connected by an open passage
 */
export function walkPatrol(cells, level, startIdx, steps, seed) {
  const rng = mulberry32(seed >>> 0);
  const route = [startIdx];
  let cur = startIdx;
  let lastDir = null;

  for (let i = 0; i < steps; i++) {
    const options = HORIZONTAL.filter((d) => isOpen(cells, cur, d));
    if (options.length === 0) break; // unreachable in a fully-connected maze, but never trust that blindly

    let choices = options;
    if (lastDir != null && options.length > 1) {
      const reverse = OPPOSITE[lastDir];
      const forward = options.filter((d) => d !== reverse);
      if (forward.length > 0) choices = forward;
    }

    const dir = choices[Math.floor(rng() * choices.length)];
    const next = neighbourOf(cur, dir);
    if (next < 0) break; // would leave the level - never happens for a horizontal dir inside bounds, but guard anyway

    route.push(next);
    lastDir = dir;
    cur = next;
  }

  return route;
}
