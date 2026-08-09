/**
 * Which district edges carry a puzzle, and of what kind.
 *
 * Pure, and decided from the DISTRICT GRAPH rather than from geometry - the
 * same discipline `connectorKind` follows and for the same reason: the map,
 * the solvability gate and the placement all have to agree about where a
 * puzzle is, and only the topology is available to all three.
 *
 * ## The safety argument lives here
 *
 * Section 8 of the spec requires that one-way gates never strand a player, and
 * says the graph is validated after placement to confirm it. This does
 * something stronger and cheaper:
 *
 *   A gate is placed ONLY on an edge of the district-level entrance-to-centre
 *   path, and oriented FORWARD along that path.
 *
 * Passing a gate therefore always moves the player closer to the centre, so no
 * closure can ever put the centre behind a door that only opens the way they
 * came. It is a property of the construction, not a search result.
 *
 * The other half of the constraint - an abandon route - needs no validation at
 * all since Phase 3 shipped hold-L, which works from anywhere at any depth.
 * There is no arrangement of gates that can stop a player leaving.
 *
 * `scripts/tests/maze-puzzles.test.mjs` re-solves with every gate shut anyway,
 * and shuts them harder than a one-way gate does. Not because the construction
 * is in doubt, but because a construction guarantee nobody checks is exactly
 * how Phase 2b's `enclosed` flag became self-certifying.
 */
import {
  MAZE, DIR, hash32, districtIndex, districtCoords, edgeKey, isEdgeOpen,
  doorwayOffset, cellIndex,
} from './MazeTopology.js';

export const PUZZLE = Object.freeze({ NONE: 0, GATE: 1, SLIDE: 2 });

/**
 * Roughly one puzzle per this many districts.
 *
 * "Density is a guess until the maze is walkable and is expected to change" -
 * the spec's own words about this number, which is why it is named here rather
 * than inlined at the two places that use it.
 */
const DISTRICTS_PER_PUZZLE = 7;

/** Every third path edge carries a gate. Hashed, so which third re-rolls. */
const GATE_EVERY = 3;

/**
 * Six-neighbourhood of a district, in bounds.
 *
 * Mirrors `districtNeighbours` exactly rather than re-deriving its bounds
 * loosely: a puzzle placed on an edge that does not exist is a puzzle nobody
 * can reach, and it would not show up as an error anywhere.
 */
function neighbours(index) {
  const { dx, dz, level } = districtCoords(index);
  const out = [];
  if (dz > 0) out.push(districtIndex(dx, dz - 1, level));
  if (dx < MAZE.DISTRICTS - 1) out.push(districtIndex(dx + 1, dz, level));
  if (dz < MAZE.DISTRICTS - 1) out.push(districtIndex(dx, dz + 1, level));
  if (dx > 0) out.push(districtIndex(dx - 1, dz, level));
  if (level > 0) out.push(districtIndex(dx, dz, level - 1));
  if (level < MAZE.LEVELS - 1) out.push(districtIndex(dx, dz, level + 1));
  return out;
}

/**
 * Breadth-first path over the graph's OPEN edges.
 *
 * @returns {number[]} district indices from `from` to `to`, or `[]` if there
 *   is no route - which for a graph built by a spanning tree should be
 *   impossible, and is returned rather than thrown so a caller can assert it.
 */
export function districtPath(graph, from, to) {
  if (from === to) return [from];
  const total = MAZE.DISTRICTS * MAZE.DISTRICTS * MAZE.LEVELS;
  const prev = new Int32Array(total).fill(-1);
  const seen = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0, tail = 0;
  queue[tail++] = from;
  seen[from] = 1;

  while (head < tail) {
    const cur = queue[head++];
    for (const n of neighbours(cur)) {
      if (seen[n] || !isEdgeOpen(graph, cur, n)) continue;
      seen[n] = 1;
      prev[n] = cur;
      if (n === to) {
        const path = [to];
        for (let c = to; prev[c] >= 0; c = prev[c]) path.push(prev[c]);
        return path.reverse();
      }
      queue[tail++] = n;
    }
  }
  return [];
}

/**
 * Choose puzzles.
 *
 * Gates go ONLY on solution-path edges, oriented forward - see this file's
 * header for why that is the whole "never strands a player" guarantee.
 *
 * Sliding walls go only OFF the path. A gate is a committal: you pass it and
 * carry on. A wall that stays shut until its plate is found, sitting on the
 * only route to the centre, is a puzzle that can be failed permanently - which
 * is a trap, and the spec allows the former and not the latter.
 *
 * @returns {Map<string, {kind:number, forward:[number,number]}>} keyed by
 *   `edgeKey`; `forward` is the ordered pair a gate may be passed in.
 */
export function placePuzzles(seed, graph, fromDistrict, toDistrict) {
  const out = new Map();
  const path = districtPath(graph, fromDistrict, toDistrict);
  const onPath = new Set(path);
  const total = MAZE.DISTRICTS * MAZE.DISTRICTS * MAZE.LEVELS;
  const want = Math.max(1, Math.round(total / DISTRICTS_PER_PUZZLE));

  /* Gates first, along the path - "weighted onto the solution path", which for
   * a gate is not a weighting but a requirement. */
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    if (hash32(seed, a, b, 0x9e1) % GATE_EVERY !== 0) continue;
    out.set(edgeKey(a, b), { kind: PUZZLE.GATE, forward: [a, b] });
  }

  /* Sliding walls fill the rest of the budget, off the path. Iterating
   * `graph.open` gives a stable order for a given graph, and the hash decides
   * which of them qualify, so this re-rolls with the seed rather than always
   * picking the first N edges the Set happens to yield. */
  for (const key of graph.open) {
    if (out.size >= want) break;
    if (out.has(key)) continue;
    const [a, b] = key.split('|').map(Number);
    if (onPath.has(a) && onPath.has(b)) continue;
    if (hash32(seed, a, b, 0x3c7) % DISTRICTS_PER_PUZZLE !== 0) continue;
    out.set(key, { kind: PUZZLE.SLIDE, forward: [a, b] });
  }

  return out;
}

/**
 * The exact cell a district edge's doorway was carved at.
 *
 * `carveDistrict` places one doorway per open border edge, at
 * `doorwayOffset(seed, self, other, DISTRICT)` along that border. Recomputing
 * it here rather than scanning `cells` for an open border passage is
 * deliberate: the two districts either side of a border both carve, so a scan
 * would have to disambiguate, and the offset is the actual authority.
 *
 * Only meaningful for a HORIZONTAL edge - a vertical one is a connector, and
 * connectors are not where puzzles go.
 *
 * @returns {{cell:number, dir:number}|null} the cell on `a`'s side, and the
 *   direction that crosses into `b`.
 */
export function edgeDoorwayCell(seed, a, b) {
  const A = districtCoords(a), B = districtCoords(b);
  if (A.level !== B.level) return null;
  const D = MAZE.DISTRICT;
  const x0 = A.dx * D, z0 = A.dz * D;
  const off = doorwayOffset(seed, a, b, D);

  const ddx = B.dx - A.dx, ddz = B.dz - A.dz;
  if (ddx === 1) return { cell: cellIndex(x0 + D - 1, z0 + off, A.level), dir: DIR.E };
  if (ddx === -1) return { cell: cellIndex(x0, z0 + off, A.level), dir: DIR.W };
  if (ddz === 1) return { cell: cellIndex(x0 + off, z0 + D - 1, A.level), dir: DIR.S };
  if (ddz === -1) return { cell: cellIndex(x0 + off, z0, A.level), dir: DIR.N };
  return null;
}

/**
 * Puzzles keyed by the CELL they physically occupy.
 *
 * This is what geometry consumes. `districtColliders` has no seed and must not
 * gain one - the same constraint that put connector kinds in the topology
 * array - so the seed-dependent decision is made once here, at build time, and
 * handed down as a plain cell lookup.
 *
 * @returns {Map<number, {kind:number, dir:number}>}
 */
export function puzzleCells(seed, graph, fromDistrict, toDistrict) {
  const out = new Map();
  for (const [key, p] of placePuzzles(seed, graph, fromDistrict, toDistrict)) {
    const [a, b] = p.kind === PUZZLE.GATE ? p.forward : key.split('|').map(Number);
    const at = edgeDoorwayCell(seed, a, b);
    if (!at) continue;                        // vertical edge: a connector, not a puzzle
    out.set(at.cell, { kind: p.kind, dir: at.dir });
  }
  return out;
}
