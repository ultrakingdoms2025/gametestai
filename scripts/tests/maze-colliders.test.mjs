import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAZE, generateTopology, cellIndex, cellCoords, isOpen, DIR, connectorAt,
} from '../../src/worlds/maze/MazeTopology.js';
import { districtColliders, forecourtColliders, cellToWorld } from '../../src/worlds/maze/MazeColliders.js';
import { shaftColliders, stairColliders, descriptorTop, connectorRegion } from '../../src/worlds/maze/MazeShafts.js';

test('cellToWorld places cell 0,0 at the origin corner and steps by the pitch', () => {
  const a = cellToWorld(0, 0, 0);
  const b = cellToWorld(1, 0, 0);
  const c = cellToWorld(0, 1, 0);
  assert.equal(b.x - a.x, MAZE.CELL);
  assert.equal(c.z - a.z, MAZE.CELL);
  assert.equal(a.y, 0);
});

test('levels are stacked by LEVEL_HEIGHT', () => {
  assert.equal(cellToWorld(0, 0, 1).y - cellToWorld(0, 0, 0).y, MAZE.LEVEL_HEIGHT);
});

test('a district emits a floor and some hedges', () => {
  const t = generateTopology(3, { levels: 1 });
  const descs = districtColliders(t.cells, 2, 2, 0);
  assert.ok(descs.length > 0);
  assert.ok(descs.some((d) => d.kind === 'floor'), 'no floor emitted');
  assert.ok(descs.some((d) => d.kind === 'hedge'), 'no hedges emitted');
});

test('THE ANTI-LADDER GATE: no collider top sits in the hop band', () => {
  // Fix round 2 (Task 3), Finding 3: this used to generate with `levels: 1`,
  // which by construction can never contain a vertical link at all -
  // buildDistrictGraph only ever opens an UP/DOWN edge between two levels
  // that both exist, so with one level this gate exercised the
  // `d.enclosed` exemption path zero times and could not regress-detect
  // anything the stair-shaft work added. `levels: MAZE.LEVELS` produces
  // real shafts and lets the exemption path actually run.
  //
  // Hedge height, thickness, and floor thickness are constants independent
  // of topology and district position, so every hedge in every district at
  // a given level has an identical top relative to that level's own floor -
  // testing a 4x4 district block per level adds belt-and-braces but doesn't
  // improve coverage; a single district would suffice for hedges. Keeping
  // the loop for defense-in-depth, and because it is what turns up shafts.
  const t = generateTopology(99, { levels: MAZE.LEVELS });
  let checked = 0;
  let exempted = 0;
  for (let level = 0; level < MAZE.LEVELS; level++) {
    // Relative to THIS level's own floor, not always level 0's - the
    // original version subtracted a hardcoded `cellToWorld(0, 0, 0).y`
    // (always 0), which happened to be harmless at `levels: 1` (nothing
    // else existed) but would have silently blinded the gate to any
    // in-band violation on levels 1-3 once they were included.
    const levelFloorY = cellToWorld(0, 0, level).y;
    const allDescs = [];
    for (let dz = 0; dz < 4; dz++) {
      for (let dx = 0; dx < 4; dx++) {
        allDescs.push(...districtColliders(t.cells, dx, dz, level));
      }
    }
    // The forecourt is the one piece of maze geometry authored by hand
    // rather than derived from topology, which makes it the most likely
    // place for a stray standable surface to appear - so it belongs in this
    // gate too, not just the district colliders. It only ever exists at the
    // entrance's own level (fixed at level 0 - see buildDistrictGraph).
    // Called the same way MazeWorld.build() does: world-x of the entrance
    // column, plus its level.
    if (level === 0) {
      const e = cellCoords(t.entranceCell);
      const ew = cellToWorld(e.x, e.z, e.level);
      allDescs.push(...forecourtColliders(ew.x, e.level));
    }

    for (const d of allDescs) {
      // A step inside a sealed shaft is allowed in the band: it cannot reach a
      // hedge top, and scripts/tests/maze-enclosure.test.mjs proves that
      // separately by driving a capsule around inside each shaft. Everything
      // else in the band is a ladder.
      if (d.enclosed) { exempted++; continue; }
      /* `descriptorTop`, not `d.cy + d.hy`: a SWEPT descriptor (a lift car)
       * rests low and travels through the whole band, so its rest position is
       * a lie about how high it gets. Imported from MazeShafts.js rather than
       * recomputed, so this scan and `requiredWallTop` can never disagree
       * about what a top is. */
      const top = descriptorTop(d);
      const relative = top - levelFloorY;
      const inBand = relative > 0.45 && relative < 5.0;
      assert.ok(!inBand, `level ${level} collider top at ${relative.toFixed(2)}m is a ladder over a hedge`);
      checked++;
    }
  }
  assert.ok(exempted > 0,
    'no enclosed (stair) tops were exempted at all - levels: MAZE.LEVELS should have produced real ' +
    'shafts for this gate to actually exercise the exemption path against');
  // eslint-disable-next-line no-console
  console.log(`[anti-ladder] ${checked} non-enclosed tops checked, ${exempted} enclosed stair tops exempted`);
});

test('hedge colliders are the specified thickness and height', () => {
  const t = generateTopology(4, { levels: 1 });
  const hedges = districtColliders(t.cells, 1, 1, 0).filter((d) => d.kind === 'hedge');
  assert.ok(hedges.length > 0);
  for (const h of hedges) {
    assert.equal(h.hy * 2, MAZE.HEDGE_HEIGHT);
    const thin = Math.min(h.hx, h.hz) * 2;
    assert.ok(
      Math.abs(thin - MAZE.HEDGE_THICK) < 1e-9,
      `hedge thickness is ${thin}, expected ${MAZE.HEDGE_THICK}`,
    );
  }
});

test('the floor covers the district with a half-cell overlap on every side', () => {
  const t = generateTopology(6, { levels: 1 });
  const floor = districtColliders(t.cells, 3, 3, 0).find((d) => d.kind === 'floor');
  assert.ok(floor);
  const span = MAZE.DISTRICT * MAZE.CELL + MAZE.CELL; // district plus half a cell each side
  assert.ok(Math.abs(floor.hx * 2 - span) < 1e-9, `floor x span ${floor.hx * 2}, expected ${span}`);
  assert.ok(Math.abs(floor.hz * 2 - span) < 1e-9, `floor z span ${floor.hz * 2}, expected ${span}`);
});

test('a multi-district block has zero exact positional duplicates among hedges', () => {
  // Ensures that the S/E fallback emission does not create duplicates at district seams.
  // A 3x3 district block has 2+2=4 internal seams per direction, plenty to catch the bug.
  const t = generateTopology(1234, { levels: 1 });
  const allDescs = [];
  for (let dz = 0; dz < 3; dz++) {
    for (let dx = 0; dx < 3; dx++) {
      allDescs.push(...districtColliders(t.cells, dx, dz, 0));
    }
  }

  const hedges = allDescs.filter((d) => d.kind === 'hedge');
  const seen = new Map();
  let duplicates = 0;
  for (const h of hedges) {
    const key = `${h.cx},${h.cy},${h.cz},${h.hx},${h.hy},${h.hz}`;
    if (seen.has(key)) {
      duplicates++;
    } else {
      seen.set(key, true);
    }
  }
  assert.equal(duplicates, 0, `${duplicates} exact positional duplicates found among hedges`);
});

test('an open passage has no hedge across it', () => {
  // Tests both East and South passages across adjacent districts.
  // Spans at least two adjacent districts to catch seam bugs.
  const t = generateTopology(8, { levels: 1 });

  // Build a 2x2 district block to span seams.
  const allDescs = [];
  for (let dz = 0; dz < 2; dz++) {
    for (let dx = 0; dx < 2; dx++) {
      allDescs.push(...districtColliders(t.cells, dx, dz, 0));
    }
  }

  let checkedEast = 0;
  let checkedSouth = 0;

  // Check East passages across all cells in the 2x2 block
  for (let ddz = 0; ddz < 2; ddz++) {
    for (let ddx = 0; ddx < 2; ddx++) {
      for (let z = 0; z < MAZE.DISTRICT; z++) {
        for (let x = 0; x < MAZE.DISTRICT - 1; x++) {
          const gx = ddx * MAZE.DISTRICT + x;
          const gz = ddz * MAZE.DISTRICT + z;
          const idx = cellIndex(gx, gz, 0);
          if ((t.cells[idx] & 2) === 0) continue; // East passage is closed
          const here = cellToWorld(gx, gz, 0);
          const gapX = here.x + MAZE.CELL / 2;
          const blocking = allDescs.filter(
            (d) => d.kind === 'hedge'
              && Math.abs(d.cx - gapX) < d.hx
              && Math.abs(d.cz - here.z) < d.hz,
          );
          assert.equal(blocking.length, 0, `open East passage at (${gx},${gz}) is blocked`);
          checkedEast++;
        }
      }
    }
  }

  // Check South passages across all cells in the 2x2 block
  for (let ddz = 0; ddz < 2; ddz++) {
    for (let ddx = 0; ddx < 2; ddx++) {
      for (let z = 0; z < MAZE.DISTRICT - 1; z++) {
        for (let x = 0; x < MAZE.DISTRICT; x++) {
          const gx = ddx * MAZE.DISTRICT + x;
          const gz = ddz * MAZE.DISTRICT + z;
          const idx = cellIndex(gx, gz, 0);
          if ((t.cells[idx] & 4) === 0) continue; // South passage is closed
          const here = cellToWorld(gx, gz, 0);
          const gapZ = here.z + MAZE.CELL / 2;
          const blocking = allDescs.filter(
            (d) => d.kind === 'hedge'
              && Math.abs(d.cx - here.x) < d.hx
              && Math.abs(d.cz - gapZ) < d.hz,
          );
          assert.equal(blocking.length, 0, `open South passage at (${gx},${gz}) is blocked`);
          checkedSouth++;
        }
      }
    }
  }

  assert.ok(checkedEast > 0, 'found no open East passages to check');
  assert.ok(checkedSouth > 0, 'found no open South passages to check');
});

/* ------------------------------------------------------------------ */
/* Phase 2c Task 2: the split, and the kind dispatch                   */
/* ------------------------------------------------------------------ */

test('the split changes nothing: shaftColliders dispatches stairs identically to stairColliders', () => {
  const { cells } = generateTopology(2026);
  let checked = 0;
  for (let level = 0; level < MAZE.LEVELS - 1 && checked < 12; level++) {
    for (let z = 0; z < MAZE.CELLS && checked < 12; z++) {
      for (let x = 0; x < MAZE.CELLS && checked < 12; x++) {
        if (!isOpen(cells, cellIndex(x, z, level), DIR.UP)) continue;
        if (connectorAt(cells, x, z, level) !== 'stair') continue;
        assert.deepEqual(
          shaftColliders(cells, x, z, level),
          stairColliders(cells, x, z, level),
          `dispatch diverged from the stair builder at ${x},${z},${level}`,
        );
        checked++;
      }
    }
  }
  assert.equal(checked, 12, 'expected 12 stair shafts to compare');
});

test('a TUNNEL link emits its own geometry when its placement allows one', () => {
  /* Not every tunnel link becomes a tunnel. Its body is a BAR across two
   * cells, and a bar severs any passage crossing it - measured by flood fill
   * as 2 of 4 open faces cut off on a crossroads cell. So placement is
   * constrained: a fold direction is valid only if neither cell has a passage
   * perpendicular to it, on either level. Where none is valid the link builds
   * a staircase, which is the connector proven six ways. */
  const { cells } = generateTopology(2026);
  let tunnels = 0, fellBack = 0;
  for (let level = 0; level < MAZE.LEVELS - 1; level++) {
    for (let z = 0; z < MAZE.CELLS; z++) {
      for (let x = 0; x < MAZE.CELLS; x++) {
        if (!isOpen(cells, cellIndex(x, z, level), DIR.UP)) continue;
        if (connectorAt(cells, x, z, level) !== 'tunnel') continue;
        const descs = shaftColliders(cells, x, z, level);
        if (descs.filter((d) => d.kind === 'tunnel').length === 0) { fellBack++; continue; }
        assert.equal(descs.filter((d) => d.kind === 'stair').length, 0, 'a tunnel emitted stair treads');
        assert.ok(descs.filter((d) => d.kind === 'tunnel').length > 20, 'too few tunnel treads');
        const region = connectorRegion(cells, x, z, level);
        assert.equal((region.x1 - region.x0) + (region.z1 - region.z0), 1,
          'a built tunnel must claim exactly two adjacent cells');
        tunnels++;
      }
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[tunnel placement] ${tunnels} built, ${fellBack} fell back to a staircase`);
  assert.ok(tunnels > 0, 'no tunnel link found a valid placement at all - the constraint is too strict to ship');
});

test('a LIFT link no longer falls back: it emits its own geometry', () => {
  const { cells } = generateTopology(2026);
  let seen = 0;
  for (let level = 0; level < MAZE.LEVELS - 1 && seen === 0; level++) {
    for (let z = 0; z < MAZE.CELLS && seen === 0; z++) {
      for (let x = 0; x < MAZE.CELLS && seen === 0; x++) {
        if (!isOpen(cells, cellIndex(x, z, level), DIR.UP)) continue;
        if (connectorAt(cells, x, z, level) !== 'lift') continue;
        const descs = shaftColliders(cells, x, z, level);
        assert.notDeepEqual(descs, stairColliders(cells, x, z, level));
        assert.equal(descs.filter((d) => d.kind === 'stair').length, 0, 'a lift emitted treads');
        seen++;
      }
    }
  }
  assert.equal(seen, 1, 'expected at least one lift link');
});
