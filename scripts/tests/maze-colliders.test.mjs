import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAZE, generateTopology, cellIndex } from '../../src/worlds/maze/MazeTopology.js';
import { districtColliders, cellToWorld } from '../../src/worlds/maze/MazeColliders.js';

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
  // Hedge height, thickness, and floor thickness are constants independent of topology
  // and district position, so every hedge in every district has an identical top.
  // Testing a 4x4 district block adds belt-and-braces but doesn't improve coverage;
  // a single district would suffice. Keeping the loop for defense-in-depth.
  const t = generateTopology(99, { levels: 1 });
  for (let dz = 0; dz < 4; dz++) {
    for (let dx = 0; dx < 4; dx++) {
      for (const d of districtColliders(t.cells, dx, dz, 0)) {
        const top = d.cy + d.hy;
        const relative = top - cellToWorld(0, 0, 0).y;
        const inBand = relative > 0.45 && relative < 5.0;
        assert.ok(!inBand, `collider top at ${relative.toFixed(2)}m is a ladder over a hedge`);
      }
    }
  }
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
