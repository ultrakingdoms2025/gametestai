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

test('an open passage has no hedge across it', () => {
  const t = generateTopology(8, { levels: 1 });
  const descs = districtColliders(t.cells, 0, 0, 0);
  // Find a cell with an open east passage and assert nothing solid sits in the
  // gap between it and its neighbour.
  let checked = 0;
  for (let z = 0; z < MAZE.DISTRICT; z++) {
    for (let x = 0; x < MAZE.DISTRICT - 1; x++) {
      const idx = cellIndex(x, z, 0);
      if ((t.cells[idx] & 4 /* DIR.S */) === 0 && (t.cells[idx] & 2 /* DIR.E */) === 0) continue;
      if ((t.cells[idx] & 2) === 0) continue;
      const here = cellToWorld(x, z, 0);
      const gapX = here.x + MAZE.CELL / 2;
      const blocking = descs.filter(
        (d) => d.kind === 'hedge'
          && Math.abs(d.cx - gapX) < d.hx
          && Math.abs(d.cz - here.z) < d.hz,
      );
      assert.equal(blocking.length, 0, `open passage at ${x},${z} is blocked`);
      checked++;
      if (checked > 50) return;
    }
  }
  assert.ok(checked > 0, 'found no open east passages to check');
});
