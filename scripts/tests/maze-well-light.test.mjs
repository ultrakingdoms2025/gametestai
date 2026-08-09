import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAZE, generateTopology, cellIndex, isOpen, DIR, connectorAt,
} from '../../src/worlds/maze/MazeTopology.js';
import { districtColliders, cellToWorld } from '../../src/worlds/maze/MazeColliders.js';
import { connectorHoleBounds } from '../../src/worlds/maze/MazeShafts.js';
import { wellLightColumns, WELL_LIGHT_RADIUS } from '../../src/worlds/maze/MazeFoliage.js';

const SEEDS = Number(process.env.MAZE_SEEDS ?? 3);
/** Districts per axis scanned per seed. */
const SPAN = 5;

/** Every cell in a district carrying an UP link - i.e. every hole in the roof. */
function upCells(cells, dx, dz, level) {
  const D = MAZE.DISTRICT;
  const out = [];
  for (let lz = 0; lz < D; lz++) {
    for (let lx = 0; lx < D; lx++) {
      const x = dx * D + lx, z = dz * D + lz;
      if (isOpen(cells, cellIndex(x, z, level), DIR.UP)) out.push({ x, z });
    }
  }
  return out;
}

test('a column of daylight stands where, and only where, the roof is open', () => {
  /* The claim in `wellLightColumns`'s docstring is that this light is honest
   * rather than decorative: levels 0 to 2 are roofed by the floor above, so a
   * shaft is the ONLY place daylight can reach them. That claim is only true
   * while a column requires DIR.UP - a column over a cell with a slab above it
   * is a light source shining through a metre of stone, and on a roofed level
   * it is also a false landmark, because the one thing a lit tower tells the
   * player is where a way up is.
   *
   * Asserted as set equality, both directions: every UP cell gets a column and
   * every column stands on an UP cell.
   *
   * WHERE it stands is `connectorHoleBounds`, NOT `cellToWorld`. This
   * assertion used to demand the cell centre, and that encoded the bug it was
   * supposed to catch: the hole daylight comes through is the connector's own
   * well, which `STAIR_WELL_OFFSET` pushes 0.9 m into one quadrant of the cell
   * (a well centred on the cell would sever the corridor it sits in - see
   * `STAIR_WELL_OFFSET`). A column on the cell centre spans -1.9..1.9 m
   * against a well spanning -0.5..2.3 m, so roughly half its cross-section
   * stood under solid slab, which is why the god-rays never read as light
   * coming down a tower. `connectorHoleBounds` is the single source of truth
   * for where that hole is - the same call `districtColliders` punches the
   * floor with - and it dispatches on connector kind, so a lift (same well as
   * a stair) and a tunnel (a hole nowhere near the stair well) are each right
   * for their own reason rather than by luck. */
  let columns = 0;
  for (let seed = 0; seed < SEEDS; seed++) {
    const t = generateTopology(seed);
    for (let level = 0; level < MAZE.LEVELS; level++) {
      for (let dz = 0; dz < SPAN; dz++) {
        for (let dx = 0; dx < SPAN; dx++) {
          const ups = upCells(t.cells, dx, dz, level);
          const wells = wellLightColumns(t.cells, dx, dz, level);
          assert.equal(wells.length, ups.length,
            `seed ${seed} level ${level} district (${dx},${dz}): ${wells.length} columns for `
            + `${ups.length} shafts`);
          const want = new Set(ups.map((c) => {
            const w = cellToWorld(c.x, c.z, level);
            const hole = connectorHoleBounds(t.cells, c.x, c.z, level);
            return `${hole.cx.toFixed(4)},${w.y.toFixed(4)},${hole.cz.toFixed(4)}`;
          }));
          for (const c of wells) {
            const k = `${c.x.toFixed(4)},${c.y.toFixed(4)},${c.z.toFixed(4)}`;
            assert.ok(want.delete(k),
              `seed ${seed} level ${level} district (${dx},${dz}): a column at ${k} stands over no `
              + 'shaft - daylight through a solid floor');
            columns++;
          }
          assert.equal(want.size, 0,
            `seed ${seed} level ${level} district (${dx},${dz}): ${want.size} shafts got no column`);
        }
      }
    }
  }
  assert.ok(columns > 0, 'not one column was found across the whole scan - this gate proved nothing');
  // eslint-disable-next-line no-console
  console.log(`[well light] ${columns} columns matched to their shafts across ${SEEDS} seed(s)`);
});

test('a column lands on ITS OWN level\'s floor, not on level 0 four floors down', () => {
  /* The `level` argument is threaded through three calls to get here, and the
   * failure mode if it is ever dropped is invisible from inside one level: the
   * column would still be over a real shaft, still the right height, just
   * standing 9, 18 or 27 metres below where the player is walking. So the
   * height is checked against the level's own floor plane and against the
   * cell's own y, which is the only thing that distinguishes the four. */
  const t = generateTopology(2026);
  let checked = 0;
  for (let level = 0; level < MAZE.LEVELS; level++) {
    const floorY = level * MAZE.LEVEL_HEIGHT;
    for (let dz = 0; dz < SPAN; dz++) {
      for (let dx = 0; dx < SPAN; dx++) {
        for (const c of wellLightColumns(t.cells, dx, dz, level)) {
          assert.equal(c.y, floorY,
            `a column on level ${level} lands at y=${c.y}, not on that level's floor (${floorY})`);
          /* And it has to reach the ceiling it is supposed to be coming
           * through, or it is a glowing stump in the middle of the shaft. */
          assert.ok(c.height >= MAZE.LEVEL_HEIGHT,
            `a column reaches ${c.height}m, short of the ${MAZE.LEVEL_HEIGHT}m to the floor above`);
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 0, 'no columns found to check the level of');
});

test('the top level has no roof to be open, and grows no columns', () => {
  /* DIR.UP cannot be set on the last level - there is nothing above it to
   * link to - so this is really a check that the function derives its
   * placement from the topology rather than from "is this a shaft cell"
   * counted some other way. It is also the one level where the sky is doing
   * the lighting anyway, so a column there would be double-counting. */
  const t = generateTopology(7);
  const top = MAZE.LEVELS - 1;
  for (let dz = 0; dz < SPAN; dz++) {
    for (let dx = 0; dx < SPAN; dx++) {
      assert.equal(wellLightColumns(t.cells, dx, dz, top).length, 0,
        `district (${dx},${dz}) grew a daylight column on the open-air top level`);
    }
  }
});

test('the whole column fits inside the hole it is supposed to shine through', () => {
  /* Standing over the hole is not enough on its own - the column also has to
   * be no wider than it. Any part of the cylinder outside the opening is a
   * shaft of daylight with a metre of floor slab across it, which is the same
   * artifact as standing in the wrong place and reads the same way in a
   * screenshot.
   *
   * Checked against every connector kind, because they do NOT share a hole
   * size: a stair and a lift get the 2.8 m stair well, and a tunnel gets
   * `tunnelExitBounds`, which is the bounding box of the treads that break
   * through the slab and is only 2.0 m across its narrow axis. That narrow
   * axis is the real bound on `WELL_LIGHT_RADIUS`, and it is measured here
   * from the actual bounds rather than assumed, so widening a tunnel or its
   * padding cannot silently push the column under the slab. */
  let checked = 0;
  const kinds = new Set();
  for (let seed = 0; seed < SEEDS; seed++) {
    const t = generateTopology(seed);
    for (let level = 0; level < MAZE.LEVELS; level++) {
      for (let dz = 0; dz < SPAN; dz++) {
        for (let dx = 0; dx < SPAN; dx++) {
          for (const c of upCells(t.cells, dx, dz, level)) {
            kinds.add(connectorAt(t.cells, c.x, c.z, level));
            const hole = connectorHoleBounds(t.cells, c.x, c.z, level);
            const col = wellLightColumns(t.cells, dx, dz, level)
              .find((w) => Math.abs(w.x - hole.cx) < 1e-6 && Math.abs(w.z - hole.cz) < 1e-6);
            assert.ok(col, `seed ${seed} level ${level}: no column over the shaft at ${c.x},${c.z}`);
            const room = Math.min(
              col.x - WELL_LIGHT_RADIUS - hole.x0, hole.x1 - (col.x + WELL_LIGHT_RADIUS),
              col.z - WELL_LIGHT_RADIUS - hole.z0, hole.z1 - (col.z + WELL_LIGHT_RADIUS),
            );
            assert.ok(room >= -1e-6,
              `seed ${seed} level ${level}: the ${WELL_LIGHT_RADIUS}m column at ${c.x},${c.z} overhangs `
              + `its own opening by ${(-room).toFixed(2)}m - that much of it shines through solid slab`);
            checked++;
          }
        }
      }
    }
  }
  assert.ok(checked > 0, 'no column was measured against its hole');
  assert.ok(kinds.has('tunnel'),
    'no tunnel turned up in the scan, so the tightest hole in the world - the one that actually bounds '
    + `WELL_LIGHT_RADIUS - was never tested (saw ${[...kinds].join(', ')})`);
});

test('the column is narrow enough to clear the shaft\'s own walls', () => {
  /* "Narrower than the 6 m well, so it clears the walls" - the radius's own
   * comment. Clearing the CELL is not the same as clearing the walls: a
   * shaft's panels stand on the cell boundary and are 0.6 m thick, so their
   * inner faces are 2.4 m from the centre, not 3.0 m. A column wide enough to
   * intersect one would be a cylinder of additive light with a wall through
   * it, which reads as a lighting bug rather than as a shaft of sun. Derived
   * from the real wall descriptors rather than from the constants, so it stays
   * true if a panel is ever made thicker. */
  const t = generateTopology(2026);
  let checked = 0;
  for (let dz = 0; dz < SPAN; dz++) {
    for (let dx = 0; dx < SPAN; dx++) {
      const wells = wellLightColumns(t.cells, dx, dz, 0);
      if (!wells.length) continue;
      const walls = districtColliders(t.cells, dx, dz, 0).filter((d) => d.kind === 'shaftWall');
      for (const c of wells) {
        for (const w of walls) {
          // Only the panels around THIS column's own cell can be hit by it.
          if (Math.abs(w.cx - c.x) > MAZE.CELL || Math.abs(w.cz - c.z) > MAZE.CELL) continue;
          const gapX = Math.abs(w.cx - c.x) - w.hx;
          const gapZ = Math.abs(w.cz - c.z) - w.hz;
          assert.ok(Math.max(gapX, gapZ) >= WELL_LIGHT_RADIUS,
            `a ${WELL_LIGHT_RADIUS}m column at (${c.x}, ${c.z}) reaches into the shaft wall `
            + `${Math.max(gapX, gapZ).toFixed(2)}m away`);
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 0, 'no column and wall pair was measured');
});
