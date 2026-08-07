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
