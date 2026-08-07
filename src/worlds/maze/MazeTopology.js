/**
 * Maze topology - pure, seeded, and deliberately free of THREE and the DOM.
 *
 * That purity is not tidiness. It is what lets the solvability, reachability
 * and containment gates run under `node --test` in seconds instead of inside a
 * browser, in a project where almost nothing else can be imported by Node at
 * all. Nothing in this file may import a renderer, touch `document`, or reach
 * for `performance` - see docs/superpowers/specs/2026-08-07-maze-world-design.md
 * section 12.
 *
 * A cell is one byte. A SET bit means the passage is OPEN, not that a wall is
 * present - the array starts as solid rock and carving turns bits on.
 */

export const MAZE = Object.freeze({
  /** Grid pitch, metres. Corridor + hedge thickness must equal this exactly. */
  CELL: 6.0,
  CORRIDOR: 4.8,
  HEDGE_THICK: 1.2,
  HEDGE_HEIGHT: 5.0,
  /** Cells along one district edge. */
  DISTRICT: 20,
  /** Districts along one level edge. */
  DISTRICTS: 20,
  LEVELS: 4,
  /** Cells along one level edge = DISTRICT * DISTRICTS. */
  CELLS: 400,
  LEVEL_CELLS: 160000,
  TOTAL_CELLS: 640000,
  /** Vertical spacing between levels, metres. Clears a 5 m hedge plus headroom. */
  LEVEL_HEIGHT: 9.0,
});

/** Passage bits. N is -z, S is +z, E is +x, W is -x. */
export const DIR = Object.freeze({ N: 1, E: 2, S: 4, W: 8, UP: 16, DOWN: 32 });

export const OPPOSITE = Object.freeze({
  [DIR.N]: DIR.S, [DIR.S]: DIR.N,
  [DIR.E]: DIR.W, [DIR.W]: DIR.E,
  [DIR.UP]: DIR.DOWN, [DIR.DOWN]: DIR.UP,
});

/** Horizontal steps only. Vertical movement changes level, not x/z. */
export const STEP = Object.freeze({
  [DIR.N]: [0, -1],
  [DIR.E]: [1, 0],
  [DIR.S]: [0, 1],
  [DIR.W]: [-1, 0],
});

/** The four horizontal directions, in a fixed order. */
export const HORIZONTAL = Object.freeze([DIR.N, DIR.E, DIR.S, DIR.W]);

/**
 * FNV-1a over the bytes of each argument, finished with an avalanche mix.
 * Order-sensitive on purpose: hash32(a,b) must differ from hash32(b,a) so that
 * a district's seed cannot collide with its neighbour's.
 * @param {...number} ints
 * @returns {number} uint32
 */
export function hash32(...ints) {
  let h = 0x811c9dc5;
  for (let i = 0; i < ints.length; i++) {
    const v = ints[i] | 0;
    h ^= v & 0xff;          h = Math.imul(h, 0x01000193);
    h ^= (v >>> 8) & 0xff;  h = Math.imul(h, 0x01000193);
    h ^= (v >>> 16) & 0xff; h = Math.imul(h, 0x01000193);
    h ^= (v >>> 24) & 0xff; h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Mulberry32. Small, fast, and good enough for level layout.
 * @param {number} seed
 * @returns {() => number} values in [0, 1)
 */
export function mulberry32(seed) {
  let s = seed >>> 0;
  return function next() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @returns {number} index into the cells array */
export function cellIndex(x, z, level) {
  return level * MAZE.LEVEL_CELLS + z * MAZE.CELLS + x;
}

/** @returns {{x:number, z:number, level:number}} */
export function cellCoords(index) {
  const level = Math.floor(index / MAZE.LEVEL_CELLS);
  const rem = index - level * MAZE.LEVEL_CELLS;
  const z = Math.floor(rem / MAZE.CELLS);
  return { x: rem - z * MAZE.CELLS, z, level };
}

/** True when x,z lie inside a level. */
export function inBounds(x, z) {
  return x >= 0 && z >= 0 && x < MAZE.CELLS && z < MAZE.CELLS;
}

/** True when the passage out of `index` in direction `dir` is open. */
export function isOpen(cells, index, dir) {
  return (cells[index] & dir) !== 0;
}

/* ------------------------------------------------------------------ */
/* District graph                                                      */
/*                                                                     */
/* The maze is 640,000 cells, which is far too many to reason about as */
/* one connected structure every time it is generated. Instead the     */
/* 1,600 districts are connected first, by a spanning tree, and that   */
/* tree is what *guarantees* an entrance-to-centre route exists. The   */
/* cells inside each district are carved afterwards and independently. */
/* ------------------------------------------------------------------ */

const DISTRICTS_PER_LEVEL = MAZE.DISTRICTS * MAZE.DISTRICTS;

/** Fraction of non-tree candidate edges opened, to create loops. */
const EXTRA_EDGE_FRACTION = 0.10;

/**
 * How often a vertical neighbour is even considered during the walk.
 *
 * Vertical connections must be rare or the four levels read as one soup, but
 * they cannot be forbidden or the upper levels would be unreachable. Biasing
 * the *order* rather than pruning the edge keeps the graph connected by
 * construction: the walk still takes a vertical edge whenever a level has no
 * unvisited horizontal neighbours left, which is exactly when it must.
 */
const VERTICAL_BIAS = 0.12;

export function districtIndex(dx, dz, level) {
  return level * DISTRICTS_PER_LEVEL + dz * MAZE.DISTRICTS + dx;
}

export function districtCoords(index) {
  const level = Math.floor(index / DISTRICTS_PER_LEVEL);
  const rem = index - level * DISTRICTS_PER_LEVEL;
  const dz = Math.floor(rem / MAZE.DISTRICTS);
  return { dx: rem - dz * MAZE.DISTRICTS, dz, level };
}

/** Canonical undirected edge key. */
export function edgeKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function isEdgeOpen(graph, aIndex, bIndex) {
  return graph.open.has(edgeKey(aIndex, bIndex));
}

/**
 * Six-neighbourhood of a district, in-bounds only.
 * @param {number} index
 * @param {number} [levels] how many levels exist; a neighbour on or above this
 *   is out of bounds. Defaults to all four.
 */
function districtNeighbours(index, levels = MAZE.LEVELS) {
  const { dx, dz, level } = districtCoords(index);
  const out = [];
  if (dz > 0) out.push({ i: districtIndex(dx, dz - 1, level), vertical: false });
  if (dx < MAZE.DISTRICTS - 1) out.push({ i: districtIndex(dx + 1, dz, level), vertical: false });
  if (dz < MAZE.DISTRICTS - 1) out.push({ i: districtIndex(dx, dz + 1, level), vertical: false });
  if (dx > 0) out.push({ i: districtIndex(dx - 1, dz, level), vertical: false });
  if (level > 0) out.push({ i: districtIndex(dx, dz, level - 1), vertical: true });
  if (level < levels - 1) out.push({ i: districtIndex(dx, dz, level + 1), vertical: true });
  return out;
}

/**
 * Build the district connectivity graph for a seed.
 *
 * `levelLimit` restricts the walk to the lowest N levels. This exists because
 * a tree spanning all four levels can route between two level-0 districts *via*
 * level 1 - and if only level 0 is ever carved, that route does not exist and
 * the maze is unsolvable. Phase 1 shipped 25 seeds in 40 with no path to the
 * centre before this was understood. One walk, parameterised, rather than two
 * that have to be kept in step.
 *
 * @param {number} seed
 * @param {number} [levelLimit] lowest N levels to span; defaults to all
 * @returns {{ open: Set<string>, entrance: {dx:number,dz:number,level:number},
 *             centre: {dx:number,dz:number,level:number},
 *             treeEdges: number, extraEdges: number }}
 */
export function buildDistrictGraph(seed, levelLimit = MAZE.LEVELS) {
  const levels = Math.max(1, Math.min(MAZE.LEVELS, levelLimit));
  const total = levels * DISTRICTS_PER_LEVEL;
  const rng = mulberry32(hash32(seed, 0x6a11));
  const open = new Set();
  const visited = new Uint8Array(total);

  /* Iterative DFS. Recursion would blow the stack at 1,600 deep on some
   * engines, and this has to run on every entry. */
  const stack = [0];
  visited[0] = 1;
  let treeEdges = 0;

  while (stack.length) {
    const cur = stack[stack.length - 1];
    const candidates = districtNeighbours(cur, levels).filter((n) => !visited[n.i]);
    if (candidates.length === 0) {
      stack.pop();
      continue;
    }
    // Horizontal first unless the bias roll says otherwise; vertical edges stay
    // rare without ever being unavailable.
    const horizontal = candidates.filter((c) => !c.vertical);
    const vertical = candidates.filter((c) => c.vertical);
    let pick;
    if (horizontal.length && (vertical.length === 0 || rng() > VERTICAL_BIAS)) {
      pick = horizontal[Math.floor(rng() * horizontal.length)];
    } else {
      pick = vertical[Math.floor(rng() * vertical.length)];
    }
    open.add(edgeKey(cur, pick.i));
    treeEdges++;
    visited[pick.i] = 1;
    stack.push(pick.i);
  }

  /* Loops. Walk every candidate edge once and open a fraction of the ones the
   * tree did not already use. Deterministic order, so the seed fully
   * determines the result. */
  let extraEdges = 0;
  for (let i = 0; i < total; i++) {
    for (const n of districtNeighbours(i, levels)) {
      if (n.i < i) continue; // consider each undirected edge once
      const key = edgeKey(i, n.i);
      if (open.has(key)) continue;
      if (rng() < EXTRA_EDGE_FRACTION) {
        open.add(key);
        extraEdges++;
      }
    }
  }

  return {
    open,
    treeEdges,
    extraEdges,
    /* Fixed, so the forecourt is always in the same place and the return arch
     * can be authored rather than discovered. */
    entrance: { dx: 10, dz: 0, level: 0 },
    /* Horizontally central, but on a level the seed chooses - so not even
     * which floor the prize is on can be learned between runs. Folded into
     * range here so a centre outside the limit is structurally impossible
     * rather than something callers have to correct afterwards. */
    centre: { dx: 10, dz: 10, level: hash32(seed, 0xc0ffee) % levels },
  };
}

/* ------------------------------------------------------------------ */
/* District interiors                                                  */
/*                                                                     */
/* Each district is carved from its own seed and knows nothing about   */
/* its neighbours. The only shared information is where the doorway on */
/* a border sits, and both sides derive that from the *edge* rather    */
/* than from either district - so they agree without ever meeting.     */
/* That independence is what makes chunk streaming possible.           */
/* ------------------------------------------------------------------ */

/**
 * Where along a shared border the doorway sits.
 * Canonical in a/b, so both districts compute the same answer.
 * @returns {number} 0..span-1
 */
export function doorwayOffset(seed, aIndex, bIndex, span) {
  const lo = Math.min(aIndex, bIndex);
  const hi = Math.max(aIndex, bIndex);
  return hash32(seed, lo, hi, 0xd00d) % span;
}

/**
 * Carve one district's 20x20 cells, plus its open border doorways.
 *
 * Writes only cells belonging to this district: the far side of each doorway is
 * opened by the neighbouring district's own call, which derives the same offset.
 *
 * @param {number} seed
 * @param {ReturnType<typeof buildDistrictGraph>} graph
 * @param {number} dx
 * @param {number} dz
 * @param {number} level
 * @param {Uint8Array} cells mutated in place
 */
export function carveDistrict(seed, graph, dx, dz, level, cells) {
  const D = MAZE.DISTRICT;
  const x0 = dx * D;
  const z0 = dz * D;
  const rng = mulberry32(hash32(seed, dx, dz, level, 0x5eed));

  /* Recursive backtracker over the district's own cells, iteratively. Produces
   * a perfect maze inside the district: every cell reachable, no loops. Loops
   * in the finished maze come from the district graph's extra edges, not from
   * here. */
  const visited = new Uint8Array(D * D);
  const local = (lx, lz) => lz * D + lx;
  const stack = [[0, 0]];
  visited[0] = 1;

  while (stack.length) {
    const [lx, lz] = stack[stack.length - 1];
    const options = [];
    for (const dir of HORIZONTAL) {
      const [sx, sz] = STEP[dir];
      const nx = lx + sx;
      const nz = lz + sz;
      if (nx < 0 || nz < 0 || nx >= D || nz >= D) continue;
      if (visited[local(nx, nz)]) continue;
      options.push({ dir, nx, nz });
    }
    if (options.length === 0) {
      stack.pop();
      continue;
    }
    const pick = options[Math.floor(rng() * options.length)];
    const here = cellIndex(x0 + lx, z0 + lz, level);
    const there = cellIndex(x0 + pick.nx, z0 + pick.nz, level);
    cells[here] |= pick.dir;
    cells[there] |= OPPOSITE[pick.dir];
    visited[local(pick.nx, pick.nz)] = 1;
    stack.push([pick.nx, pick.nz]);
  }

  /* Border doorways. Only the near side is opened here. */
  const self = districtIndex(dx, dz, level);

  const borders = [
    { dir: DIR.N, ddx: 0, ddz: -1 },
    { dir: DIR.E, ddx: 1, ddz: 0 },
    { dir: DIR.S, ddx: 0, ddz: 1 },
    { dir: DIR.W, ddx: -1, ddz: 0 },
  ];

  for (const b of borders) {
    const ndx = dx + b.ddx;
    const ndz = dz + b.ddz;
    if (ndx < 0 || ndz < 0 || ndx >= MAZE.DISTRICTS || ndz >= MAZE.DISTRICTS) continue;
    const other = districtIndex(ndx, ndz, level);
    if (!isEdgeOpen(graph, self, other)) continue;

    const off = doorwayOffset(seed, self, other, D);
    let cx;
    let cz;
    if (b.dir === DIR.N) { cx = x0 + off; cz = z0; }
    else if (b.dir === DIR.S) { cx = x0 + off; cz = z0 + D - 1; }
    else if (b.dir === DIR.W) { cx = x0; cz = z0 + off; }
    else { cx = x0 + D - 1; cz = z0 + off; }
    cells[cellIndex(cx, cz, level)] |= b.dir;
  }

  /* Vertical doorways. The offset indexes the district's whole 20x20 block, so
   * a stair or lift can land anywhere inside it rather than only on a border. */
  for (const [dir, dl] of [[DIR.UP, 1], [DIR.DOWN, -1]]) {
    const nl = level + dl;
    if (nl < 0 || nl >= MAZE.LEVELS) continue;
    const other = districtIndex(dx, dz, nl);
    if (!isEdgeOpen(graph, self, other)) continue;
    const off = doorwayOffset(seed, self, other, D * D);
    const lx = off % D;
    const lz = Math.floor(off / D);
    cells[cellIndex(x0 + lx, z0 + lz, level)] |= dir;
  }
}

/* ------------------------------------------------------------------ */
/* Whole-maze generation and search                                    */
/* ------------------------------------------------------------------ */

/**
 * Generate a complete maze topology.
 *
 * @param {number} seed
 * @param {{ levels?: number }} [opts] `levels` limits generation to the lowest
 *   N levels. Phase 1 passes 1; the default builds all four.
 * @returns {{ seed:number, cells:Uint8Array,
 *             graph:ReturnType<typeof buildDistrictGraph>,
 *             entranceCell:number, centreCell:number }}
 */
export function generateTopology(seed, opts = {}) {
  const levels = Math.max(1, Math.min(MAZE.LEVELS, opts.levels ?? MAZE.LEVELS));
  const graph = buildDistrictGraph(seed, levels);

  const cells = new Uint8Array(MAZE.TOTAL_CELLS);

  for (let level = 0; level < levels; level++) {
    for (let dz = 0; dz < MAZE.DISTRICTS; dz++) {
      for (let dx = 0; dx < MAZE.DISTRICTS; dx++) {
        carveDistrict(seed, graph, dx, dz, level, cells);
      }
    }
  }

  const cellOf = (d, lvl) =>
    cellIndex(
      d.dx * MAZE.DISTRICT + Math.floor(MAZE.DISTRICT / 2),
      d.dz * MAZE.DISTRICT + Math.floor(MAZE.DISTRICT / 2),
      lvl,
    );

  return {
    seed,
    cells,
    graph,
    entranceCell: cellOf(graph.entrance, graph.entrance.level),
    centreCell: cellOf(graph.centre, graph.centre.level),
  };
}

/**
 * Punch a one-cell-wide corridor from a level's north boundary (z=0) straight
 * to the entrance cell, and breach that boundary so the corridor actually
 * opens onto open air instead of terminating at the outer wall.
 *
 * `buildDistrictGraph` fixes the entrance at the *centre* of district (10,0)
 * - ten cells inside the district, not on its edge - because that is what
 * makes the forecourt authorable at a fixed world position. Nothing carves a
 * path from the grid's edge to that cell on its own, so without this call the
 * entrance cell is sealed on every side but the ones the perfect-maze
 * backtracker happened to open, which is not necessarily any of them.
 *
 * Only ever opens passage bits, never closes any - so this cannot disconnect
 * anything that was already reachable. THE GATE (entrance-to-centre
 * solvability) is asserted *after* this runs in `MazeWorld.build()`, which is
 * what proves that claim rather than assuming it.
 *
 * @param {Uint8Array} cells mutated in place
 * @param {{x:number, z:number, level:number}} entrance cell coords - the
 *   entrance column stays fixed at `x` for every row from the boundary down.
 */
export function carveEntranceCorridor(cells, entrance) {
  const { x: ex, z: ez, level } = entrance;
  for (let z = 1; z <= ez; z++) {
    const here = cellIndex(ex, z, level);
    const prev = cellIndex(ex, z - 1, level);
    cells[here] |= DIR.N;
    cells[prev] |= DIR.S;
  }
  // Breach the outer boundary wall itself - without this the corridor is
  // fully open internally but still capped by the hedge `districtColliders`
  // draws across every cell's unowned north face at the grid's edge.
  cells[cellIndex(ex, 0, level)] |= DIR.N;
}

/**
 * Neighbour cell index across `dir`, or -1 if it leaves the grid.
 * Exported for `MazePopulate.js`, which walks NPC patrol routes one open
 * passage at a time and needs the exact same stepping rule `solve` and
 * `reachableCount` use below - a second implementation would be a second
 * place for the level-wrap and boundary rules to drift out of sync.
 */
export function neighbourOf(index, dir) {
  const { x, z, level } = cellCoords(index);
  if (dir === DIR.UP) return level + 1 < MAZE.LEVELS ? cellIndex(x, z, level + 1) : -1;
  if (dir === DIR.DOWN) return level > 0 ? cellIndex(x, z, level - 1) : -1;
  const [sx, sz] = STEP[dir];
  const nx = x + sx;
  const nz = z + sz;
  return inBounds(nx, nz) ? cellIndex(nx, nz, level) : -1;
}

const ALL_DIRS = [DIR.N, DIR.E, DIR.S, DIR.W, DIR.UP, DIR.DOWN];

/**
 * Breadth-first shortest route between two cells.
 * @returns {number[]|null} cell indices from `from` to `to`, or null
 */
export function solve(cells, from, to) {
  if (from === to) return [from];
  const prev = new Int32Array(MAZE.TOTAL_CELLS).fill(-1);
  const seen = new Uint8Array(MAZE.TOTAL_CELLS);
  /* A plain array used as a queue with a head cursor. Array.shift() on a
   * 640,000-entry queue is O(n) per call and turns this into minutes. */
  const queue = new Int32Array(MAZE.TOTAL_CELLS);
  let head = 0;
  let tail = 0;
  queue[tail++] = from;
  seen[from] = 1;

  while (head < tail) {
    const cur = queue[head++];
    for (const dir of ALL_DIRS) {
      if ((cells[cur] & dir) === 0) continue;
      const n = neighbourOf(cur, dir);
      if (n < 0 || seen[n]) continue;
      seen[n] = 1;
      prev[n] = cur;
      if (n === to) {
        const path = [to];
        let step = cur;
        while (step !== from) { path.push(step); step = prev[step]; }
        path.push(from);
        return path.reverse();
      }
      queue[tail++] = n;
    }
  }
  return null;
}

/** How many cells are reachable from `from`. Used to prove there are no pockets. */
export function reachableCount(cells, from) {
  const seen = new Uint8Array(MAZE.TOTAL_CELLS);
  const queue = new Int32Array(MAZE.TOTAL_CELLS);
  let head = 0;
  let tail = 0;
  queue[tail++] = from;
  seen[from] = 1;
  let count = 1;
  while (head < tail) {
    const cur = queue[head++];
    for (const dir of ALL_DIRS) {
      if ((cells[cur] & dir) === 0) continue;
      const n = neighbourOf(cur, dir);
      if (n < 0 || seen[n]) continue;
      seen[n] = 1;
      count++;
      queue[tail++] = n;
    }
  }
  return count;
}

/* ------------------------------------------------------------------ */
/* Residency                                                           */
/*                                                                     */
/* Which districts should be built for a player standing somewhere.    */
/* Pure integer maths, deliberately: the chunk manager that consumes    */
/* this needs THREE, and keeping the decision here means the residency  */
/* set can be tested without a renderer.                                */
/* ------------------------------------------------------------------ */

/** One district edge, in metres. */
export const DISTRICT_SPAN = MAZE.DISTRICT * MAZE.CELL;

/**
 * District containing a world position, clamped to the grid.
 *
 * Clamping matters: the entrance forecourt sits in negative z, outside the
 * cell grid entirely, and a player standing there must still hold the maze's
 * first districts resident rather than an empty set.
 *
 * Derived from the geometry's own rule: cell = round(x / CELL), district = floor(cell / DISTRICT).
 * Working from cell position instead of metres prevents boundary drift.
 */
export function districtAtWorld(x, z, level) {
  const clampCell = (v) => Math.min(MAZE.CELLS - 1, Math.max(0, Math.round(v / MAZE.CELL)));
  const clampDist = (v) => Math.min(MAZE.DISTRICTS - 1, Math.max(0, v));
  const dx = clampDist(Math.floor(clampCell(x) / MAZE.DISTRICT));
  const dz = clampDist(Math.floor(clampCell(z) / MAZE.DISTRICT));
  const lv = Math.min(MAZE.LEVELS - 1, Math.max(0, level | 0));
  return districtIndex(dx, dz, lv);
}

/**
 * District indices within `radius` districts of `centreKey`, same level only.
 * Sorted ascending so two calls with the same argument compare equal.
 */
export function neighbourhoodKeys(centreKey, radius) {
  const { dx, dz, level } = districtCoords(centreKey);
  const out = [];
  for (let z = dz - radius; z <= dz + radius; z++) {
    if (z < 0 || z >= MAZE.DISTRICTS) continue;
    for (let x = dx - radius; x <= dx + radius; x++) {
      if (x < 0 || x >= MAZE.DISTRICTS) continue;
      out.push(districtIndex(x, z, level));
    }
  }
  out.sort((a, b) => a - b);
  return out;
}
