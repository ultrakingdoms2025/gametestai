import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { Physics } from '../../src/physics/Physics.js';
import { MAZE, generateTopology, cellIndex, isOpen, DIR, cellCoords } from '../../src/worlds/maze/MazeTopology.js';
import {
  isEnclosureSound, districtColliders, cellToWorld, shaftColliders, SHAFT_ENTRY_CLEARANCE,
} from '../../src/worlds/maze/MazeColliders.js';
import { CONFIG } from '../../src/core/Config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const RADIUS = 0.35, HEIGHT = 1.75, SPRINT = 8.2, STEP = 1 / 60;
// Kept in step with the maze's own derivation (`MAZE.HOP`) rather than
// retyped as a sibling literal, so this file cannot drift from it.
const HOP = MAZE.HOP;

const SHAFT = { cx: 0, cz: 0, floorY: 0 };

/* ------------------------------------------------------------------ */
/* Fixture builders                                                    */
/* ------------------------------------------------------------------ */

function fullWalls(height) {
  const c = MAZE.CELL, H = height;
  return [
    { cx: -c / 2, cy: H / 2, cz: 0, hx: 0.6, hy: H / 2, hz: c / 2, kind: 'hedge' }, // west
    { cx: c / 2, cy: H / 2, cz: 0, hx: 0.6, hy: H / 2, hz: c / 2, kind: 'hedge' },  // east
    { cx: 0, cy: H / 2, cz: -c / 2, hx: c / 2, hy: H / 2, hz: 0.6, kind: 'hedge' }, // north
    { cx: 0, cy: H / 2, cz: c / 2, hx: c / 2, hy: H / 2, hz: 0.6, kind: 'hedge' },  // south
  ];
}

function floorSlab(halfSpan = MAZE.CELL) {
  return { cx: 0, cy: -0.5, cz: 0, hx: halfSpan, hy: 0.5, hz: halfSpan, kind: 'floor' };
}

/**
 * Nested boxes rising from the floor to `topY`, spread across x between
 * `xStart` and `xEnd` - the same shape a lever staircase's treads present to
 * this proof, without needing real stair geometry to exist yet.
 */
function makeLadder(count, topY, xStart, xEnd) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const top = (topY * (i + 1)) / count;
    const cx = count > 1 ? xStart + ((xEnd - xStart) * i) / (count - 1) : (xStart + xEnd) / 2;
    out.push({ cx, cy: top / 2, cz: 0, hx: 0.8, hy: top / 2, hz: 0.8, kind: 'stair', enclosed: true });
  }
  return out;
}

/**
 * The west wall split into two pieces stacked vertically, with `gap` metres
 * of nothing between the top of the first and the bottom of the second.
 * `gap: 0` makes them touch exactly (contiguous coverage).
 */
function splitWestWall(totalHeight, gap) {
  const c = MAZE.CELL;
  const mid = totalHeight / 2;
  const secondBottom = mid + gap;
  const secondHeight = totalHeight - secondBottom;
  return [
    { cx: -c / 2, cy: mid / 2, cz: 0, hx: 0.6, hy: mid / 2, hz: c / 2, kind: 'hedge' },
    { cx: -c / 2, cy: secondBottom + secondHeight / 2, cz: 0, hx: 0.6, hy: secondHeight / 2, hz: c / 2, kind: 'hedge' },
  ];
}

/* ------------------------------------------------------------------ */
/* The simulated proof                                                 */
/* ------------------------------------------------------------------ */

/**
 * Every point a capsule could plausibly launch a hop from inside this shaft:
 * the floor, plus the top of every `enclosed` standable whose footprint
 * overlaps it. Seeding the floor alone misses exactly the escape a staircase
 * enables - from the top step, not the bottom - which is how a wall too short
 * to clear its own stairs previously passed this sweep undetected.
 */
function launchPoints(descs, shaft) {
  const half = MAZE.CELL / 2;
  const EPS = 1e-6;
  const points = [{ x: shaft.cx, y: shaft.floorY, z: shaft.cz }];
  for (const d of descs) {
    if (!d.enclosed) continue;
    if (d.cx - d.hx > shaft.cx + half - EPS || d.cx + d.hx < shaft.cx - half + EPS) continue;
    if (d.cz - d.hz > shaft.cz + half - EPS || d.cz + d.hz < shaft.cz - half + EPS) continue;
    points.push({ x: d.cx, y: d.cy + d.hy, z: d.cz });
  }
  return points;
}

/**
 * Drive a capsule around inside a set of colliders and report the highest it
 * ever gets outside the shaft footprint. This is the proof that an `enclosed`
 * exemption is honest: steps may exist in the hop band only if a player using
 * them cannot arrive on top of a hedge - checked from every place inside the
 * shaft a player could actually be standing, not just the floor.
 */
function escapeHeight(descs, shaft) {
  const p = new Physics(null);
  for (const d of descs) p.addBox(d.cx, d.cy, d.cz, d.hx, d.hy, d.hz);
  const pos = new THREE.Vector3();
  let highestOutside = -Infinity;
  for (const launch of launchPoints(descs, shaft)) {
    for (let a = 0; a < 32; a++) {
      const ang = (a / 32) * Math.PI * 2;
      pos.set(launch.x, launch.y + 0.05, launch.z);
      const vx = Math.cos(ang) * SPRINT, vz = Math.sin(ang) * SPRINT;
      // Standing on the launch surface counts as grounded for the first hop.
      let grounded = true;
      for (let s = 0; s < 200; s++) {
        pos.x += vx * STEP; pos.z += vz * STEP;
        // Only hop when the previous resolve left the capsule grounded - a
        // real player cannot chain a second hop while still airborne from the
        // first. `Physics` applies no gravity of its own (that lives in the
        // caller's game loop), so hopping unconditionally regardless of
        // ground contact would let height accumulate without bound and float
        // the capsule above any finite wall, including a genuinely sealed
        // one. That would be an artifact of an ungated sweep, not a real
        // exploit, so it is gated out here.
        if (s % 20 === 0 && grounded) pos.y += HOP;   // try to hop out on the way
        const res = p.resolveCapsule(pos, RADIUS, HEIGHT);
        grounded = res.grounded;
        const outside = Math.abs(pos.x - shaft.cx) > MAZE.CELL / 2
                     || Math.abs(pos.z - shaft.cz) > MAZE.CELL / 2;
        if (outside) highestOutside = Math.max(highestOutside, pos.y - shaft.floorY);
      }
    }
  }
  return highestOutside;
}

/* ------------------------------------------------------------------ */
/* Geometric + simulated proof, fixture by fixture                     */
/* ------------------------------------------------------------------ */

test('a sealed shaft is sound', () => {
  // Four full-height walls around one cell, with a step ladder inside, walls
  // tall enough to clear the ladder's own top tread by more than a hop.
  const descs = [floorSlab(), ...fullWalls(6.0), ...makeLadder(8, 4.0, -1, 1.1)];
  assert.equal(isEnclosureSound(descs, SHAFT), true);
  assert.ok(escapeHeight(descs, SHAFT) < MAZE.HEDGE_HEIGHT,
    'a capsule escaped a sealed shaft above hedge height');
});

test('a shaft with a missing wall is NOT sound', () => {
  const walls = fullWalls(6.0).filter((w) => w.cx !== MAZE.CELL / 2); // east missing
  const descs = [floorSlab(MAZE.CELL * 3), ...walls, ...makeLadder(8, 4.0, -1, 1.1)];
  assert.equal(isEnclosureSound(descs, SHAFT), false,
    'an open-sided shaft was reported sound');
});

test('a shaft with a wall too short to clear its own stairs is NOT sound, and the sweep proves it from the top step', () => {
  // East wall reaches only 4.2 m - above the ladder's own top tread (4.0 m)
  // but below the derived bar (top tread + hop + margin = 5.43 m). A sweep
  // seeded only on the floor never climbs high enough to notice: it stays
  // pinned below 4.2 m the whole time and reports no escape at all. Seeded
  // from the top step instead, a single hop clears the short wall.
  const walls = fullWalls(6.0).filter((w) => w.cx !== MAZE.CELL / 2);
  walls.push({ cx: MAZE.CELL / 2, cy: 2.1, cz: 0, hx: 0.6, hy: 2.1, hz: MAZE.CELL / 2, kind: 'hedge' }); // 4.2 m
  const descs = [floorSlab(), ...walls, ...makeLadder(8, 4.0, -1, 1.1)];
  assert.equal(isEnclosureSound(descs, SHAFT), false,
    'a shaft with a too-short wall was reported sound');
  assert.ok(escapeHeight(descs, SHAFT) >= MAZE.HEDGE_HEIGHT,
    'the capsule sweep failed to find the escape over the short wall from the top step');
});

test('a wall assembled from two contiguous pieces is sound', () => {
  const others = fullWalls(6.0).filter((w) => w.cx !== -MAZE.CELL / 2);
  const descs = [floorSlab(), ...splitWestWall(6.0, 0), ...others, ...makeLadder(8, 4.0, -1, 1.1)];
  assert.equal(isEnclosureSound(descs, SHAFT), true,
    'two contiguous wall pieces were not recognised as full coverage');
  assert.ok(escapeHeight(descs, SHAFT) < MAZE.HEDGE_HEIGHT);
});

test('a wall assembled from two pieces with a gap between them is NOT sound', () => {
  const others = fullWalls(6.0).filter((w) => w.cx !== -MAZE.CELL / 2);
  const descs = [floorSlab(), ...splitWestWall(6.0, 0.5), ...others, ...makeLadder(8, 4.0, -1, 1.1)]; // 0.5 m gap
  assert.equal(isEnclosureSound(descs, SHAFT), false,
    'a gap between two wall pieces was reported as full coverage');
  // The capsule itself is 1.75 m tall, taller than the 0.5 m gap, so it can
  // never occupy the gap without also touching one of the two pieces - this
  // rule is intentionally more conservative than what this specific capsule
  // can exploit (see spec: this case is "conservative rather than
  // dangerous"), and is kept that way rather than tuned to one capsule size.
  assert.ok(escapeHeight(descs, SHAFT) < MAZE.HEDGE_HEIGHT);
});

test('a staircase climbing a full level inside hedge-height walls is NOT sound - the bug the spec amendment describes', () => {
  // This is the exact failure the amended spec calls out by name: a
  // staircase climbing LEVEL_HEIGHT (9.0 m) inside walls that only reach
  // hedge height (5.0 m) - the first draft of this rule ("to at least hedge
  // height") reported this SOUND. Measured escape on this geometry in the
  // spec's own review: 10.0 m.
  const descs = [floorSlab(), ...fullWalls(MAZE.HEDGE_HEIGHT), ...makeLadder(24, MAZE.LEVEL_HEIGHT, -1.5, 1.5)];
  assert.equal(isEnclosureSound(descs, SHAFT), false,
    '9 m of stairs inside 5 m walls was reported sound');
  assert.ok(escapeHeight(descs, SHAFT) >= MAZE.HEDGE_HEIGHT,
    'the capsule sweep failed to find the escape over hedge-height walls');
});

test('the same staircase is sound once the walls actually clear it', () => {
  const tallEnough = MAZE.LEVEL_HEIGHT + MAZE.HOP + 1.0; // comfortably past the derived bar
  const descs = [floorSlab(), ...fullWalls(tallEnough), ...makeLadder(24, MAZE.LEVEL_HEIGHT, -1.5, 1.5)];
  assert.equal(isEnclosureSound(descs, SHAFT), true);
  assert.ok(escapeHeight(descs, SHAFT) < MAZE.HEDGE_HEIGHT);
});

/* ------------------------------------------------------------------ */
/* Part 3 of the proof: binding `enclosed` to a shaft that actually     */
/* passed parts 1 and 2, on real generated geometry - not just fixtures */
/* ------------------------------------------------------------------ */

/**
 * Every shaft cell whose footprint a box's footprint overlaps - not just the
 * cell containing the box's centre.
 *
 * `requiredWallTop` and `launchPoints` both decide relevance by footprint
 * overlap (see their own filters above), so grouping had to match that or
 * the two would disagree about which shaft a wide descriptor belongs to. A
 * descriptor's centre landing in cell A does not mean its footprint stays
 * inside A: a stair with `hx` wider than half a cell can reach into a
 * neighbouring cell while still rounding to A's centre, and centre-only
 * grouping would check A and never notice the neighbour it actually reaches
 * into is unsealed. A small integer overscan on the candidate range keeps
 * this exact regardless of how wide a descriptor is.
 */
function overlappingShaftCells(cx, hx, cz, hz) {
  const half = MAZE.CELL / 2;
  const EPS = 1e-6;
  const gxLo = Math.floor((cx - hx) / MAZE.CELL) - 1;
  const gxHi = Math.ceil((cx + hx) / MAZE.CELL) + 1;
  const gzLo = Math.floor((cz - hz) / MAZE.CELL) - 1;
  const gzHi = Math.ceil((cz + hz) / MAZE.CELL) + 1;
  const cells = [];
  for (let gx = gxLo; gx <= gxHi; gx++) {
    const cellCx = gx * MAZE.CELL;
    if (cellCx - half > cx + hx + EPS || cellCx + half < cx - hx - EPS) continue;
    for (let gz = gzLo; gz <= gzHi; gz++) {
      const cellCz = gz * MAZE.CELL;
      if (cellCz - half > cz + hz + EPS || cellCz + half < cz - hz - EPS) continue;
      cells.push({ gx, gz });
    }
  }
  return cells;
}

/**
 * Every `enclosed` descriptor in `descs`, grouped by every shaft cell its
 * footprint overlaps (see `overlappingShaftCells`). `level` supplies the
 * shaft floor height, since a descriptor's position alone does not say which
 * level it belongs to.
 */
function groupEnclosedByShaft(descs, level = 0) {
  // + SHAFT_ENTRY_CLEARANCE for the same reason THE ENCLOSURE GATE test
  // applies it: a real shaft's entry side is open at floor level by design,
  // so the floor-to-need coverage check `isEnclosureSound` performs must be
  // asked from just above that gap, not from the true floor. See
  // shaftColliders's comment in MazeColliders.js.
  const floorY = level * MAZE.LEVEL_HEIGHT + SHAFT_ENTRY_CLEARANCE;
  const groups = new Map();
  for (const d of descs) {
    if (!d.enclosed) continue;
    for (const { gx, gz } of overlappingShaftCells(d.cx, d.hx, d.cz, d.hz)) {
      const key = `${gx},${gz}`;
      if (!groups.has(key)) {
        groups.set(key, { key, shaft: { cx: gx * MAZE.CELL, cz: gz * MAZE.CELL, floorY } });
      }
    }
  }
  return [...groups.values()];
}

test('every enclosed descriptor emitted by real generation sits in a proven shaft', () => {
  // Real staircases now exist (Task 3: `shaftColliders`, wired into
  // `districtColliders` for every cell carrying DIR.UP). This tripwire used
  // to assert `shaftsChecked === 0`, on purpose, until that happened - the
  // comment on that assertion said to delete it rather than keep it passing
  // once generation started emitting `enclosed`. This is that deletion: the
  // loop below now does real work, and the assertion at the bottom is
  // flipped to prove it is doing that work rather than silently checking
  // nothing (see the companion test below, which proves the check itself is
  // not vacuous even when it has nothing real to check).
  //
  // The scan window matters: a narrow one (a couple of seeds, a couple of
  // districts, one level) is a tripwire that a staircase landing outside it
  // would simply never trip. Real staircases can land in any district on
  // any of the four levels, so the window has to be the same size - the
  // whole grid, every level - or it is not actually a tripwire. Measured
  // cost of doing that (`districtColliders` over all 1,600 districts): ~40 ms
  // per seed, `generateTopology(levels: MAZE.LEVELS)`: ~170 ms per seed - a
  // couple of seeds is cheap enough to run on every `npm test`.
  const seeds = [11, 47];
  const t0 = Date.now();
  let shaftsChecked = 0;
  for (const seed of seeds) {
    const t = generateTopology(seed, { levels: MAZE.LEVELS });
    for (let level = 0; level < MAZE.LEVELS; level++) {
      for (let dz = 0; dz < MAZE.DISTRICTS; dz++) {
        for (let dx = 0; dx < MAZE.DISTRICTS; dx++) {
          const descs = districtColliders(t.cells, dx, dz, level);
          for (const g of groupEnclosedByShaft(descs, level)) {
            shaftsChecked++;
            assert.equal(isEnclosureSound(descs, g.shaft), true,
              `seed ${seed} level ${level} district (${dx},${dz}) shaft ${g.key} is not a proven enclosure`);
          }
        }
      }
    }
  }
  const elapsedMs = Date.now() - t0;
  const districtsScanned = seeds.length * MAZE.LEVELS * MAZE.DISTRICTS * MAZE.DISTRICTS;
  // eslint-disable-next-line no-console
  console.log(
    `[enumeration] ${seeds.length} seed(s) x ${MAZE.LEVELS} levels x ` +
    `${MAZE.DISTRICTS * MAZE.DISTRICTS} districts/level = ${districtsScanned} districts scanned, ` +
    `${shaftsChecked} shafts checked, ${elapsedMs} ms`,
  );
  assert.ok(shaftsChecked > 0,
    'expected real generated shafts to be found and checked across the whole grid - ' +
    'if this is 0 again, something stopped shaftColliders from being wired into ' +
    'districtColliders, and every assertion above just became vacuous');
});

test('the bound-to-exemption check is not vacuous: an enclosed descriptor placed in an unsealed real cell fails it', () => {
  // A real maze cell always has at least one open passage - that is what
  // makes it navigable - so no interior cell is ever walled on all four
  // sides by construction. Injecting an `enclosed` descriptor into one real
  // generated district stands in for "generation emitted enclosed:true
  // somewhere it should not have," and this is the check that must catch it.
  // Without this test, the check above could pass merely because it never
  // finds anything to check - which is exactly the "self-certifying" failure
  // mode this whole part of the proof exists to rule out.
  const t = generateTopology(7, { levels: 1 });
  const dx = 5, dz = 5;
  const descs = districtColliders(t.cells, dx, dz, 0);
  const lx = 10, lz = 10; // well inside the district - no border complications
  const gx = dx * MAZE.DISTRICT + lx;
  const gz = dz * MAZE.DISTRICT + lz;
  const centre = cellToWorld(gx, gz, 0);
  const rigged = [...descs, {
    cx: centre.x, cy: 1, cz: centre.z, hx: 0.8, hy: 1, hz: 0.8, kind: 'stair', enclosed: true,
  }];
  const groups = groupEnclosedByShaft(rigged, 0);
  assert.ok(groups.length > 0, 'expected the injected descriptor to be grouped into a shaft');
  for (const g of groups) {
    assert.equal(isEnclosureSound(rigged, g.shaft), false,
      `expected the rigged shaft at ${g.key} to be reported unsound - ` +
      'if this passes, the bound-to-exemption check is vacuous');
  }
});

test("a descriptor spanning two cells is checked against both - the reviewer's exploit", () => {
  // Cell A (0,0) is fully sealed. Cell B (CELL,0) is not: it has only the
  // wall it shares with A (real maze geometry emits an internal wall once,
  // not duplicated per cell, so A's east wall doubles as B's west wall) and
  // nothing on its other three sides - genuinely open, part of the
  // navigable maze.
  //
  // A stair centred inside A - so a centre-only grouping rounds it into A
  // alone - but wide enough (hx: 3.0, matching the reviewer's own exploit)
  // that its footprint reaches 1.5 m into B's footprint must be checked
  // against B too, and B must fail, denying the exemption overall.
  const shaftA = { cx: 0, cz: 0, floorY: 0 };
  const shaftB = { cx: MAZE.CELL, cz: 0, floorY: 0 };
  const stair = { cx: 1.5, cy: 1.0, cz: 0, hx: 3.0, hy: 1.0, hz: 0.8, kind: 'stair', enclosed: true };
  const descs = [floorSlab(12), ...fullWalls(6.0), stair];

  // Sanity on the fixture itself, independent of grouping: A really is
  // sealed, B really is not.
  assert.equal(isEnclosureSound(descs, shaftA), true, 'fixture bug: A should be sealed');
  assert.equal(isEnclosureSound(descs, shaftB), false, 'fixture bug: B should not be sealed');

  const groups = groupEnclosedByShaft(descs, 0);
  const keys = groups.map((g) => g.key).sort();
  assert.deepEqual(keys, ['0,0', '1,0'],
    "the stair's footprint overlaps both cells, so grouping must enumerate both, not just the one its centre rounds to");
  for (const g of groups) {
    assert.equal(isEnclosureSound(descs, g.shaft), g.key === '0,0',
      `shaft ${g.key}: a wide descriptor must be checked against every cell it reaches into, ` +
      'and the exemption must be denied if any of them is unsound');
  }
});

/* ------------------------------------------------------------------ */
/* Guards on the machinery itself                                      */
/* ------------------------------------------------------------------ */

test('MAZE.STEP_HEIGHT stays in step with the live player config', () => {
  // MAZE.STEP_HEIGHT is a duplicate of CONFIG.player.stepHeight, forced by
  // MazeTopology.js being allowed to import nothing at all (see its own
  // comment on HOP and STEP_HEIGHT). A duplicate that can silently drift is
  // worse than no duplicate: if stepHeight is ever raised in Config.js
  // without this constant being updated to match, ENCLOSURE_MARGIN in
  // MazeColliders.js stops covering the player's real step-up reach and the
  // whole proof becomes unsafe with no test failing to say so. This is that
  // test.
  assert.equal(MAZE.STEP_HEIGHT, CONFIG.player.stepHeight,
    `MAZE.STEP_HEIGHT (${MAZE.STEP_HEIGHT}) has drifted from CONFIG.player.stepHeight ` +
    `(${CONFIG.player.stepHeight}) - update MAZE.STEP_HEIGHT in MazeTopology.js to match`);
});

test('MazeTopology.js and MazeColliders.js import nothing outside each other', async () => {
  // Textual, not behavioural - the same reason scripts/contract-check.mjs and
  // scripts/tests/rules-applied.test.mjs check source text rather than
  // runtime behaviour: purity is exactly what lets the containment, seam and
  // enclosure gates run headless in the first place, and nothing else
  // enforces it. A `three` (or any other) import landing in either file
  // would not fail any other test, since both files happen to work fine
  // under Node either way - it would just quietly cost this whole tier its
  // reason for existing.
  const importRe = /^\s*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]\s*;?\s*$/gm;

  const topoSrc = await readFile(path.join(root, 'src/worlds/maze/MazeTopology.js'), 'utf8');
  const topoImports = [...topoSrc.matchAll(importRe)].map((m) => m[1]);
  assert.deepEqual(topoImports, [],
    `MazeTopology.js must import nothing at all - found: ${topoImports.join(', ') || '(none)'}`);

  const collidersSrc = await readFile(path.join(root, 'src/worlds/maze/MazeColliders.js'), 'utf8');
  const collidersImports = [...collidersSrc.matchAll(importRe)].map((m) => m[1]);
  assert.ok(collidersImports.length > 0,
    'MazeColliders.js imports nothing - expected at least ./MazeTopology.js');
  for (const spec of collidersImports) {
    assert.ok(spec === './MazeTopology.js',
      `MazeColliders.js imports "${spec}" - it may only import from ./MazeTopology.js`);
  }
});

/* ------------------------------------------------------------------ */
/* Stair shafts (Task 3)                                               */
/* ------------------------------------------------------------------ */

/** Every cell in a district that carries an UP link. */
function shaftCells(cells, dx, dz, level) {
  const out = [];
  for (let lz = 0; lz < MAZE.DISTRICT; lz++) {
    for (let lx = 0; lx < MAZE.DISTRICT; lx++) {
      const x = dx * MAZE.DISTRICT + lx, z = dz * MAZE.DISTRICT + lz;
      if (isOpen(cells, cellIndex(x, z, level), DIR.UP)) out.push({ x, z });
    }
  }
  return out;
}

test('every shaft is climbable: no step exceeds the auto-step height', () => {
  const t = generateTopology(2026, { levels: 2 });
  let checked = 0;
  for (let dz = 0; dz < 4; dz++) for (let dx = 0; dx < 4; dx++) {
    for (const c of shaftCells(t.cells, dx, dz, 0)) {
      const steps = shaftColliders(t.cells, c.x, c.z, 0).filter((d) => d.kind === 'stair');
      assert.ok(steps.length > 0, `shaft at ${c.x},${c.z} has no steps`);
      const tops = steps.map((s) => s.cy + s.hy).sort((a, b) => a - b);
      for (let i = 1; i < tops.length; i++) {
        assert.ok(tops[i] - tops[i - 1] <= 0.45 + 1e-6,
          `step rise ${(tops[i] - tops[i - 1]).toFixed(3)}m exceeds the 0.45m auto-step`);
      }
      checked++;
    }
  }
  assert.ok(checked > 0, 'no shafts found to check');
});

test('every shaft reaches the next level', () => {
  const t = generateTopology(7, { levels: 2 });
  for (let dz = 0; dz < 3; dz++) for (let dx = 0; dx < 3; dx++) {
    for (const c of shaftCells(t.cells, dx, dz, 0)) {
      const steps = shaftColliders(t.cells, c.x, c.z, 0).filter((d) => d.kind === 'stair');
      const highest = Math.max(...steps.map((s) => s.cy + s.hy));
      const base = cellToWorld(c.x, c.z, 0).y;
      assert.ok(highest >= base + MAZE.LEVEL_HEIGHT - 0.45,
        `shaft tops out at ${(highest - base).toFixed(2)}m, short of LEVEL_HEIGHT`);
    }
  }
});

test('THE ENCLOSURE GATE: every shaft is sealed above hop height', () => {
  // A shaft's entry side is genuinely open at floor level - that is the only
  // way in - so `isEnclosureSound`'s plain floor-to-need coverage check is
  // applied from `floorY + SHAFT_ENTRY_CLEARANCE` upward, not from the true
  // floor. That is a conservative substitution, not a relaxed one:
  // SHAFT_ENTRY_CLEARANCE (0.45m) sits below HOP (0.93m), so proving "sealed
  // from 0.45m up" proves the thing that actually matters - you cannot leave
  // sideways once you are above hop height - with margin to spare. See
  // shaftColliders's own comment in MazeColliders.js.
  for (const seed of [1, 42, 2026]) {
    const t = generateTopology(seed, { levels: 2 });
    for (let dz = 0; dz < 3; dz++) for (let dx = 0; dx < 3; dx++) {
      const descs = districtColliders(t.cells, dx, dz, 0);
      for (const c of shaftCells(t.cells, dx, dz, 0)) {
        const w = cellToWorld(c.x, c.z, 0);
        assert.equal(
          isEnclosureSound(descs, { cx: w.x, cz: w.z, floorY: w.y + SHAFT_ENTRY_CLEARANCE }), true,
          `seed ${seed} shaft at ${c.x},${c.z} is not sealed`,
        );
      }
    }
  }
});
