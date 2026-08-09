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
  neighbourOf, districtCoords,
} from './MazeTopology.js';

/** Bitmask of the four horizontal passage bits, as opposed to DIR.UP/DOWN. */
const HMASK = DIR.N | DIR.E | DIR.S | DIR.W;
/** Either vertical passage. A cell with one of these carries a connector. */
const VMASK = DIR.UP | DIR.DOWN;

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
 * SUPERSEDED by `pickDistrictTokens` below, which places per district so that
 * population follows residency. Kept, with its seed sweep, because it is the
 * whole-level reference the district picker is the specialisation of - the same
 * standing `walkPatrol` has kept since `routeToward` replaced it.
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
 * SUPERSEDED by `pickDistrictWanderer` below - see the note on
 * `pickDeadEndTokens` for why this stays.
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


/* ==================================================================== */
/* Per-district placement - population that follows residency            */
/* ==================================================================== */

/**
 * How many tokens a single district is worth.
 *
 * ## Why this replaced a global count
 *
 * The maze is 2394 m square across four levels - about 5.7 km2 - and only a
 * ~240 m neighbourhood is ever streamed in (see `MazeChunks`). A flat 200
 * tokens spread over the whole thing measured, live at the entrance, as TWO
 * within 120 m and FOUR within 240 m: a collectable the player would only ever
 * meet by accident. Wanderers were worse - the nearest was 543 m away, in a
 * district that does not exist until you walk to it.
 *
 * Raising the global count would have fixed the density and multiplied the
 * simulated entity count by the same factor. Placing per DISTRICT instead ties
 * population to exactly the thing geometry is already tied to: three tokens in
 * every district that is streamed in, none at all in the 1,580 that are not.
 * Density near the player rises by more than an order of magnitude and the live
 * entity count stays bounded by the residency radius, not by the maze size.
 */
export const TOKENS_PER_DISTRICT = 3;

/**
 * Probability that a given district holds one of the lost wanderers.
 *
 * At most ONE per district, so they never bunch: a district is 120 m square and
 * two people in it would read as a pair rather than as two separate encounters.
 * 0.3 over the ~21 districts resident at the entrance is ~6 wanderers within
 * the streamed region, against ONE before this work - and over the 43 districts
 * resident deep in the maze (a full 5x5 block plus the rings on the levels
 * either side) it is ~13, which is what `MAX_LIVE_WANDERERS` below is sized
 * against.
 */
export const WANDERER_CHANCE = 0.3;

/**
 * Hard ceiling on simultaneously-live wanderers, whatever residency asks for.
 *
 * `NPCManager.maxNPCs` is 44 for the whole game and a skinned character is the
 * most expensive thing in the scene, so the streamed population must not be
 * able to eat the budget on an unlucky seed. 0.3 x 43 districts is ~13 with a
 * standard deviation around 3, so 24 is roughly three sigma clear - it is a
 * safety valve, not a routine limit.
 */
export const MAX_LIVE_WANDERERS = 24;

/**
 * True when a cell carries a vertical connector - a staircase, a lift well or
 * the mouth of a tunnel.
 *
 * Nothing streamed may stand or float in one: the cell is full of treads, a car
 * or a fold, so a token 0.6 m up is inside a collider and a patrol waypoint is
 * a character asked to walk into a staircase.
 */
export function isConnectorCell(cells, idx) {
  return (cells[idx] & VMASK) !== 0;
}

/**
 * Every cell in district `key` that may carry a token.
 *
 * A dead end, exactly as `findDeadEnds` means it - the corridor punished you for
 * walking in, so a reward belongs there - with two exclusions the whole-level
 * picker never needed:
 *
 *  - Cells carrying a VERTICAL passage. A dead end that is also a shaft, a lift
 *    well or a tunnel mouth has stair treads, a car or a fold in it, and a
 *    token 0.6 m off the floor there is a token inside a collider. The
 *    whole-level picker got away with ignoring this because 195 of its 200
 *    tokens were in districts that were never built; every token this one
 *    places is in a district that IS built, so the no-standable-token gate
 *    actually tests them all now.
 *  - Anything the caller excludes: the entrance, the centre, and the puzzle
 *    doorways, where a gate or a sliding hedge wall moves through the cell.
 *
 * @param {Uint8Array} cells
 * @param {number} key district index
 * @param {Set<number>|Map<number, any>} [exclude] cells that must never be used
 * @returns {number[]} cell indices, in scan order
 */
export function districtTokenCells(cells, key, exclude = null) {
  const { dx, dz, level } = districtCoords(key);
  const x0 = dx * MAZE.DISTRICT;
  const z0 = dz * MAZE.DISTRICT;
  const out = [];
  for (let lz = 0; lz < MAZE.DISTRICT; lz++) {
    for (let lx = 0; lx < MAZE.DISTRICT; lx++) {
      const idx = cellIndex(x0 + lx, z0 + lz, level);
      if (exclude && exclude.has(idx)) continue;
      const bits = cells[idx];
      if ((bits & VMASK) !== 0) continue;       // a connector, not a corridor
      if ((bits & HMASK) === 0) continue;       // orphaned cell
      if (openDirCount(cells, idx) !== 1) continue;
      out.push(idx);
    }
  }
  return out;
}

/**
 * The token cells for district `key`, chosen from its dead ends.
 *
 * Deterministic in `(seed, key)` alone - NOT in the order districts happen to
 * stream in - which is what lets a district be released and re-entered without
 * its tokens moving, and what lets the headless tests assert placement without
 * a renderer. Returns fewer than `count` only when the district genuinely has
 * fewer usable dead ends than that, which a district full of long corridors
 * legitimately can.
 *
 * @param {Uint8Array} cells
 * @param {number} key district index
 * @param {number} seed the run's seed
 * @param {number} [count]
 * @param {Set<number>|Map<number, any>} [exclude]
 * @returns {number[]} cell indices, each unique
 */
export function pickDistrictTokens(cells, key, seed, count = TOKENS_PER_DISTRICT, exclude = null) {
  const candidates = districtTokenCells(cells, key, exclude);
  if (candidates.length <= count) return candidates;
  const rng = mulberry32(hash32(seed, 0x70c3, key));
  return shuffle(candidates, rng).slice(0, count);
}

/**
 * The wanderer this district holds, or -1 for the ones that hold nobody.
 *
 * The roll comes first and off `(seed, key)` only, so whether a district has
 * someone in it is fixed for the run before anything about the cell is looked
 * at - a district that streams out and back in gets the same answer.
 *
 * Sites are JUNCTIONS (two or more open passages), never dead ends: a wanderer
 * whose patrol starts in a dead end can only pace in and out of it, and these
 * are people the spec describes as still walking toward the centre after years.
 *
 * @param {Uint8Array} cells
 * @param {number} key district index
 * @param {number} seed
 * @param {Set<number>|Map<number, any>} [exclude]
 * @returns {number} cell index, or -1
 */
export function pickDistrictWanderer(cells, key, seed, exclude = null) {
  const rng = mulberry32(hash32(seed, 0x9e17, key));
  if (rng() >= WANDERER_CHANCE) return -1;

  const { dx, dz, level } = districtCoords(key);
  const x0 = dx * MAZE.DISTRICT;
  const z0 = dz * MAZE.DISTRICT;
  const sites = [];
  for (let lz = 0; lz < MAZE.DISTRICT; lz++) {
    for (let lx = 0; lx < MAZE.DISTRICT; lx++) {
      const idx = cellIndex(x0 + lx, z0 + lz, level);
      if (exclude && exclude.has(idx)) continue;
      if ((cells[idx] & VMASK) !== 0) continue; // standing in a stairwell
      if (openDirCount(cells, idx) < 2) continue;
      sites.push(idx);
    }
  }
  if (sites.length === 0) return -1;
  return sites[Math.floor(rng() * sites.length)];
}

/**
 * Which of the written cast this district's wanderer is.
 *
 * Keyed on `(seed, key)` for the same reason the site is: walking away from a
 * district and back must not turn Corvin Ashe into Marta Wren.
 *
 * @param {number} key district index
 * @param {number} seed
 * @param {number} castLength
 * @returns {number} index into the cast
 */
export function districtCastIndex(key, seed, castLength) {
  return hash32(seed, 0xca57, key) % castLength;
}

/**
 * A token's bob/spin phase. Derived from its CELL rather than from a running
 * counter, so a token that streams out mid-bob comes back at the same phase
 * instead of visibly snapping.
 */
export function tokenPhase(cell, seed) {
  return mulberry32(hash32(seed, 0x704e, cell))() * Math.PI * 2;
}

/**
 * A route from `startIdx` toward whatever `parents` is rooted at.
 *
 * The lost wanderers are described as having been in here a long time and
 * still looking for the centre, and a four-cell random shuffle does not read
 * as that - it reads as someone pacing. Following the parent field means they
 * are genuinely walking the shortest path toward the centre, which is what
 * "trying to solve the maze" looks like from the outside.
 *
 * They never arrive: the route is cut at `steps`, and `FriendlyNPC` cycles its
 * waypoints, so each one walks its stretch toward the centre and back again.
 * For someone who has been lost for years that is more honest than arriving,
 * and it keeps them spread through the maze instead of piling up at the prize.
 *
 * @param {Int32Array} parents from `parentField`
 * @param {number} startIdx
 * @param {number} steps how many cells to follow
 * @param {((cell:number) => boolean)|null} [isBlocked] cells the route must
 *   stop short of. Optional, and absent it behaves exactly as it always has -
 *   see the note below on why the streamed population always passes one.
 * @returns {number[]} cell indices, starting with `startIdx`
 */
export function routeToward(parents, startIdx, steps, isBlocked = null) {
  const route = [startIdx];
  let cur = startIdx;
  for (let i = 0; i < steps; i++) {
    const next = parents[cur];
    if (next < 0) break;                 // the root itself, or unreachable
    /* Stop short of anything the caller says is not standable.
     *
     * A patrol waypoint is a place a character is asked to walk to, and the
     * shortest path to the centre happily crosses cells that are full of
     * geometry: a stairwell's treads and walls, a lift car, a tunnel's fold, a
     * doorway with a sliding hedge wall resting shut in it. The spawn SITE
     * already avoids all of those, and until this was added the route did not -
     * which measured, on a full build, as a wanderer whose patrol ran straight
     * into a staircase.
     *
     * Cut rather than routed around, for the same reason the level-change cut
     * below is: these are people who have been lost for years, and a stair they
     * never found is exactly why. */
    if (isBlocked?.(next)) break;
    /* Stop at a level change. `parentField` walks ALL directions, including
     * the vertical links, and a shortest path to the centre will happily take
     * one - but a patrol waypoint a level up teleports the NPC through a
     * floor, which the spawn-connectivity gate rightly refuses.
     *
     * Cutting the route here rather than routing around it is also the truer
     * behaviour: these are people who have been lost for years, and a
     * staircase they never found is exactly why. They walk toward the centre
     * until the way on goes up, and then turn back. */
    if (Math.abs(next - cur) !== 1 && Math.abs(next - cur) !== MAZE.CELLS) break;
    route.push(next);
    cur = next;
  }
  return route;
}
