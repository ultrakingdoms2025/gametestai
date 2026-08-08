import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { Physics } from '../../src/physics/Physics.js';
import { MAZE, generateTopology, cellIndex, isOpen, DIR, cellCoords } from '../../src/worlds/maze/MazeTopology.js';
import {
  isEnclosureSound, districtColliders, cellToWorld, shaftColliders, ENTRY_SEAL_FROM,
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
  // Fix round 1: coverage is only required from ENTRY_SEAL_FROM (~3.57m)
  // upward, not from the floor - a gap that sits entirely BELOW that height
  // is now legitimately harmless (that is the whole point of the fix), so a
  // gap positioned at the old fixture's 3.0-3.5m band no longer proves
  // anything. The gap here is widened and repositioned to straddle
  // ENTRY_SEAL_FROM (3.0-4.0m: the split still sits at mid=3.0m, but a 1.0m
  // gap pushes the second piece's bottom to 4.0m, above the ~3.57m bound),
  // so this still exercises a gap that matters - one a player could stand in
  // above the height where leaving becomes an exploit.
  const others = fullWalls(6.0).filter((w) => w.cx !== -MAZE.CELL / 2);
  const descs = [floorSlab(), ...splitWestWall(6.0, 1.0), ...others, ...makeLadder(8, 4.0, -1, 1.1)]; // 1.0 m gap, 3.0-4.0m
  assert.equal(isEnclosureSound(descs, SHAFT), false,
    'a gap between two wall pieces, straddling the entry-seal threshold, was reported as full coverage');
  // The capsule itself is 1.75 m tall, taller than the 1.0 m gap, so it can
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
  // The shaft's TRUE floor - fix round 1 moved the "don't seal the entry
  // side all the way down" allowance into `isEnclosureSound` itself (the
  // `ENTRY_SEAL_FROM` lower bound), so callers pass the real floor and no
  // longer need to shift it themselves. See ENTRY_SEAL_FROM's own comment
  // in MazeColliders.js.
  const floorY = level * MAZE.LEVEL_HEIGHT;
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
  // way in - so `isEnclosureSound` itself (fix round 1) applies its
  // floor-to-need coverage check from `ENTRY_SEAL_FROM` above the floor, not
  // from the true floor. Callers pass the shaft's real floor and let the
  // function apply that lower bound, so both the geometry
  // (`shaftColliders`) and this gate share exactly one derived number rather
  // than two that have to be kept in step by hand. See ENTRY_SEAL_FROM's own
  // comment in MazeColliders.js for the derivation.
  for (const seed of [1, 42, 2026]) {
    const t = generateTopology(seed, { levels: 2 });
    for (let dz = 0; dz < 3; dz++) for (let dx = 0; dx < 3; dx++) {
      const descs = districtColliders(t.cells, dx, dz, 0);
      for (const c of shaftCells(t.cells, dx, dz, 0)) {
        const w = cellToWorld(c.x, c.z, 0);
        assert.equal(
          isEnclosureSound(descs, { cx: w.x, cz: w.z, floorY: w.y }), true,
          `seed ${seed} shaft at ${c.x},${c.z} is not sealed`,
        );
      }
    }
  }
});

/* ------------------------------------------------------------------ */
/* Fix round 1: sealing from the floor made every shaft unenterable.   */
/* "Is it sealed" was asserted six ways above; "can anyone get in" was */
/* asserted nowhere. This is that check.                               */
/* ------------------------------------------------------------------ */

test('the entry doorway on a real shaft is tall enough for the player to walk through', () => {
  // Derived from CONFIG.player.height, not a retyped literal, so a taller
  // player breaks THIS build rather than silently breaking the game (the
  // failure mode fix round 1 shipped: nothing asserted walkability at all).
  const CLEARANCE = 0.25;
  const REQUIRED = CONFIG.player.height + CLEARANCE;
  const sidesByDir = [
    { dir: DIR.N, dx: 0, dz: -1 }, { dir: DIR.E, dx: 1, dz: 0 },
    { dir: DIR.S, dx: 0, dz: 1 }, { dir: DIR.W, dx: -1, dz: 0 },
  ];
  const half = MAZE.CELL / 2;
  let checked = 0;
  let minGap = Infinity;
  for (const seed of [1, 42, 2026]) {
    const t = generateTopology(seed, { levels: 2 });
    for (let dz = 0; dz < 4; dz++) for (let dx = 0; dx < 4; dx++) {
      for (const c of shaftCells(t.cells, dx, dz, 0)) {
        const idx = cellIndex(c.x, c.z, 0);
        const w = cellToWorld(c.x, c.z, 0);
        const walls = shaftColliders(t.cells, c.x, c.z, 0).filter((d) => d.kind === 'hedge');
        for (const s of sidesByDir) {
          if (!isOpen(t.cells, idx, s.dir)) continue;
          const wall = walls.find((d) => Math.abs(d.cx - (w.x + s.dx * half)) < 1e-6
                                        && Math.abs(d.cz - (w.z + s.dz * half)) < 1e-6);
          assert.ok(wall, `shaft at ${c.x},${c.z} has no wall descriptor for its open side`);
          const gap = (wall.cy - wall.hy) - w.y;
          minGap = Math.min(minGap, gap);
          assert.ok(gap >= REQUIRED,
            `shaft at ${c.x},${c.z} doorway is ${gap.toFixed(2)}m, short of the ` +
            `${REQUIRED.toFixed(2)}m a ${CONFIG.player.height}m player plus clearance needs`);
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 0, 'no open shaft sides found to check');
  // eslint-disable-next-line no-console
  console.log(`[doorway] ${checked} open sides checked across 3 seeds, minimum measured gap ${minGap.toFixed(3)}m`);
});

test('a shaft whose entry-side wall starts above the exploit threshold is NOT sound', () => {
  // ENTRY_SEAL_FROM (~3.57m) is looser than sealing from the floor, but it
  // must not be so loose that a real escape gap - one a player could
  // actually stand in and walk out of - passes. A wall starting even a
  // little above the threshold leaves exactly that gap.
  const c = MAZE.CELL, H = 6.0;
  const tooHighBase = 4.0;
  assert.ok(tooHighBase > ENTRY_SEAL_FROM,
    'fixture bug: the wall must start above ENTRY_SEAL_FROM to test the boundary');
  const withoutEast = fullWalls(H).filter((w) => w.cx !== c / 2);
  const tooHigh = {
    cx: c / 2, cy: (tooHighBase + H) / 2, cz: 0, hx: 0.6, hy: (H - tooHighBase) / 2, hz: c / 2, kind: 'hedge',
  };
  const descs = [floorSlab(), ...withoutEast, tooHigh];
  assert.equal(isEnclosureSound(descs, SHAFT), false,
    `a wall starting at ${tooHighBase}m (above the ${ENTRY_SEAL_FROM.toFixed(2)}m exploit threshold) was reported sound`);
});

test('ENTRY_SEAL_MARGIN is load-bearing: a wall starting at the raw break-even height (no margin) is still NOT sound', () => {
  // HEDGE_HEIGHT - HOP - STEP_HEIGHT = 3.62m is the exact height above which
  // leaving becomes an exploit. ENTRY_SEAL_FROM sits a margin below that
  // (3.57m) on purpose, so a wall starting exactly at the raw, margin-free
  // bar must still fail - if it didn't, the margin would be decorative.
  const RAW_BAR = MAZE.HEDGE_HEIGHT - MAZE.HOP - MAZE.STEP_HEIGHT;
  const c = MAZE.CELL, H = 6.0;
  const withoutEast = fullWalls(H).filter((w) => w.cx !== c / 2);
  const atRawBar = {
    cx: c / 2, cy: (RAW_BAR + H) / 2, cz: 0, hx: 0.6, hy: (H - RAW_BAR) / 2, hz: c / 2, kind: 'hedge',
  };
  const descs = [floorSlab(), ...withoutEast, atRawBar];
  assert.equal(isEnclosureSound(descs, SHAFT), false,
    'a wall starting exactly at the raw 3.62m break-even (no margin) was reported sound');

  // A wall starting exactly at ENTRY_SEAL_FROM itself - what shaftColliders
  // actually emits - is sound.
  const atBound = {
    cx: c / 2, cy: (ENTRY_SEAL_FROM + H) / 2, cz: 0, hx: 0.6, hy: (H - ENTRY_SEAL_FROM) / 2, hz: c / 2, kind: 'hedge',
  };
  const soundDescs = [floorSlab(), ...withoutEast, atBound];
  assert.equal(isEnclosureSound(soundDescs, SHAFT), true,
    'a wall starting exactly at ENTRY_SEAL_FROM was reported unsound');
});

/* ------------------------------------------------------------------ */
/* Fix round 2: the stairs climb into a solid ceiling once level N+1's    */
/* floor is resident. Finding 1 (Critical). districtColliders(...,level)  */
/* now perforates that floor over a shaft landing; these tests prove it   */
/* actually works, in both directions, on real multi-level generation.    */
/* ------------------------------------------------------------------ */

/**
 * Walk a capsule up a real shaft's own treads, tread by tread, checking at
 * each one whether standing on it would put the capsule's body inside any
 * NON-tread collider (the floor slab above being the one that mattered:
 * level N+1's floor used to have no hole in it, so its underside acted as a
 * ceiling around 6m up). Reports the highest tread the capsule can actually
 * occupy before the first one that is blocked - a real step-up would refuse
 * to advance past that point exactly as a solid ceiling refuses it here.
 *
 * This does not reimplement Player.js's real step-up algorithm (grounded/
 * coyote gating, sweep-and-probe) - it is a simpler, direct proxy: "is the
 * space this tread's landing spot occupies actually clear of solid
 * geometry other than the tread itself." That is exactly the question
 * Finding 1 turns on, and it is cheap enough to run per shaft without a
 * physics-step simulation.
 */
function climbTreads(descs, shaft) {
  const treads = descs
    .filter((d) => d.kind === 'stair'
      && Math.abs(d.cx - shaft.cx) < MAZE.CELL && Math.abs(d.cz - shaft.cz) < MAZE.CELL)
    .sort((a, b) => a.cy - b.cy);
  const solids = descs.filter((d) => d.kind !== 'stair');
  const EPS = 1e-6;
  let maxY = shaft.floorY;
  for (const t of treads) {
    const standY = t.cy + t.hy; // feet height if standing on this tread's top
    const blocked = solids.some((d) => {
      const overlapX = Math.abs(d.cx - t.cx) < d.hx + RADIUS;
      const overlapZ = Math.abs(d.cz - t.cz) < d.hz + RADIUS;
      const dTop = d.cy + d.hy, dBottom = d.cy - d.hy;
      const overlapY = dBottom < standY + HEIGHT - EPS && dTop > standY + EPS;
      return overlapX && overlapZ && overlapY;
    });
    if (blocked) break;
    maxY = standY;
  }
  return maxY;
}

test('THE CEILING GATE: climbing a real shaft with level N+1 resident reaches LEVEL_HEIGHT', () => {
  // Finding 1: level N+1's own district floor slab used to cover a shaft
  // landing with no hole in it, so the top few treads were embedded inside
  // it - invisible with only level 0 loaded (nothing above to hit), and a
  // hard stop around 6m the moment level N+1 streams in. This is checked
  // with BOTH levels' colliders present together, which is what exposed the
  // bug in the first place.
  let checked = 0;
  for (const seed of [1, 42, 2026]) {
    const t = generateTopology(seed, { levels: 2 });
    for (let dz = 0; dz < 4 && checked < 6; dz++) {
      for (let dx = 0; dx < 4 && checked < 6; dx++) {
        const cells = shaftCells(t.cells, dx, dz, 0);
        if (!cells.length) continue;
        const c = cells[0];
        const w = cellToWorld(c.x, c.z, 0);
        const descs = [...districtColliders(t.cells, dx, dz, 0), ...districtColliders(t.cells, dx, dz, 1)];
        const reached = climbTreads(descs, { cx: w.x, cz: w.z, floorY: w.y });
        assert.ok(reached >= w.y + MAZE.LEVEL_HEIGHT - 1e-6,
          `seed ${seed} shaft ${c.x},${c.z}: climb stopped at ${(reached - w.y).toFixed(2)}m ` +
          `with level 1 resident, short of LEVEL_HEIGHT (${MAZE.LEVEL_HEIGHT}m)`);
        checked++;
      }
    }
  }
  assert.ok(checked > 0, 'no shafts found to check');
});

test('a shaft with level N+1\'s UNPERFORATED floor is stuck around 6m - confirms the ceiling gate would have caught Finding 1', () => {
  // Rebuilds the exact bug: level 1's floor as ONE slab with no hole,
  // exactly what districtColliders emitted before this fix round. Proves
  // climbTreads (and by extension the gate above) actually detects the
  // failure it claims to guard, rather than passing vacuously.
  const t = generateTopology(2026, { levels: 2 });
  const dx = 0, dz = 0;
  const cells = shaftCells(t.cells, dx, dz, 0);
  assert.ok(cells.length > 0, 'fixture needs a shaft in district (0,0)');
  const c = cells[0];
  const w = cellToWorld(c.x, c.z, 0);
  const descs0 = districtColliders(t.cells, dx, dz, 0);
  const D = MAZE.DISTRICT;
  const half = (D * MAZE.CELL + MAZE.CELL) / 2;
  const originX = dx * D * MAZE.CELL, originZ = dz * D * MAZE.CELL;
  const centerX = originX + (D - 1) * MAZE.CELL / 2, centerZ = originZ + (D - 1) * MAZE.CELL / 2;
  const unperforatedFloor = {
    cx: centerX, cy: MAZE.LEVEL_HEIGHT - 0.5, cz: centerZ, hx: half, hy: 0.5, hz: half, kind: 'floor',
  };
  const reached = climbTreads([...descs0, unperforatedFloor], { cx: w.x, cz: w.z, floorY: w.y });
  assert.ok(reached < w.y + MAZE.LEVEL_HEIGHT - 1,
    `expected the unperforated-floor fixture to stop the climb well short of LEVEL_HEIGHT ` +
    `(reached ${(reached - w.y).toFixed(2)}m) - if it doesn't, climbTreads can't be trusted to catch Finding 1`);
});

test('walking level 1 across a shaft cannot fall through the hole in its floor', () => {
  // The other half of Finding 1's ask: the hole that lets a climbing player
  // through must not let a level-1 pedestrian fall through it walking
  // normally. It doesn't, but not because there is floor under the hole -
  // the shaft's own walls (emitted once, at level 0, but physically
  // spanning up through this level's height) are sealed on every side by
  // ENTRY_SEAL_FROM (~3.57m), well below LEVEL_HEIGHT (9m), so nobody
  // walking the level-1 corridor grid can even reach the hole's footprint
  // sideways - the only way into that column is climbing up through it.
  // This drives a capsule from open corridor space toward the shaft centre
  // from all four cardinal directions, at level 1's floor height, with a
  // small per-step downward nudge standing in for gravity (Physics applies
  // none of its own) - if the wall ever failed to block entry, an
  // unsupported capsule over the hole would fall freely and `minY` would
  // drop far below the floor.
  let checked = 0;
  for (const seed of [1, 2026]) {
    const t = generateTopology(seed, { levels: 2 });
    for (let dz = 0; dz < 4 && checked < 3; dz++) {
      for (let dx = 0; dx < 4 && checked < 3; dx++) {
        const cells = shaftCells(t.cells, dx, dz, 0);
        if (!cells.length) continue;
        const c = cells[0];
        const w1 = cellToWorld(c.x, c.z, 1);
        const descs = [...districtColliders(t.cells, dx, dz, 0), ...districtColliders(t.cells, dx, dz, 1)];
        const p = new Physics(null);
        for (const d of descs) p.addBox(d.cx, d.cy, d.cz, d.hx, d.hy, d.hz);
        for (const [ddx, ddz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const pos = new THREE.Vector3(w1.x + ddx * 5, w1.y + 0.1, w1.z + ddz * 5);
          let minY = pos.y;
          for (let s = 0; s < 600; s++) {
            pos.x -= ddx * 0.02; pos.z -= ddz * 0.02;
            pos.y -= 0.05; // stands in for gravity - Physics applies none of its own
            p.resolveCapsule(pos, RADIUS, HEIGHT);
            minY = Math.min(minY, pos.y);
          }
          assert.ok(minY >= w1.y - 0.5,
            `seed ${seed} shaft ${c.x},${c.z}, approach (${ddx},${ddz}): capsule dropped to ` +
            `${minY.toFixed(2)}m walking toward the shaft at level 1 (floor is ${w1.y}m) - it fell through`);
        }
        checked++;
      }
    }
  }
  assert.ok(checked > 0, 'no shafts found to check');
});

/* ------------------------------------------------------------------ */
/* Fix round 2, Finding 2 (Important): the simulated proof (escapeHeight, */
/* seeded from every standable) had only ever run on synthetic fixtures - */
/* never on real shaftColliders output. This is the gap that let 617     */
/* unenterable shafts pass six ways of "is it sealed" undetected; running */
/* it on the real thing is the point.                                    */
/* ------------------------------------------------------------------ */

test('the simulated proof (escapeHeight) runs on real generated shafts, not just fixtures', () => {
  // escapeHeight is expensive (32 angles x ~25 launch points x 200 steps per
  // shaft), so this samples a small, fixed number of real shafts rather
  // than all 617 - enough to prove the simulated half of the proof runs on
  // the real thing, not to re-run the geometric enumeration a second way.
  const SAMPLE_PER_SEED = 2;
  let sampled = 0;
  const t0 = Date.now();
  for (const seed of [11, 47]) {
    const t = generateTopology(seed, { levels: 2 });
    let sampledThisSeed = 0;
    for (let dz = 0; dz < 6 && sampledThisSeed < SAMPLE_PER_SEED; dz++) {
      for (let dx = 0; dx < 6 && sampledThisSeed < SAMPLE_PER_SEED; dx++) {
        const descs = districtColliders(t.cells, dx, dz, 0);
        for (const c of shaftCells(t.cells, dx, dz, 0)) {
          if (sampledThisSeed >= SAMPLE_PER_SEED) break;
          const w = cellToWorld(c.x, c.z, 0);
          const shaft = { cx: w.x, cz: w.z, floorY: w.y };
          const escape = escapeHeight(descs, shaft);
          assert.ok(escape < MAZE.HEDGE_HEIGHT,
            `seed ${seed} shaft ${c.x},${c.z}: capsule escaped to ${escape.toFixed(2)}m, at/above hedge height`);
          sampledThisSeed++;
          sampled++;
        }
      }
    }
  }
  const elapsedMs = Date.now() - t0;
  assert.ok(sampled > 0, 'no real shafts sampled');
  // eslint-disable-next-line no-console
  console.log(`[simulated proof on real shafts] ${sampled} shafts sampled across 2 seeds, ${elapsedMs} ms`);
});

/* ------------------------------------------------------------------ */
/* Fix round 2, Finding 5 (Minor): the narrowest strip of one tread not   */
/* already covered by its neighbour, along either axis, had no headroom   */
/* over the capsule's own diameter. Treads were widened (0.75m -> 0.9m    */
/* half-extent); this is the regression test that fails loudly if a       */
/* future tweak to tread size, spiral radius, or capsule radius erodes    */
/* that margin again.                                                     */
/* ------------------------------------------------------------------ */

test('consecutive treads overlap by at least the capsule diameter, on both axes', () => {
  const descs = shaftColliders(new Uint8Array(1).fill(DIR.UP), 0, 0, 0);
  const treads = descs.filter((d) => d.kind === 'stair').sort((a, b) => a.cy - b.cy);
  assert.ok(treads.length > 1, 'expected multiple treads to compare');
  const capsuleDiameter = RADIUS * 2;
  let minOverlap = Infinity;
  for (let i = 1; i < treads.length; i++) {
    const a = treads[i - 1], b = treads[i];
    const ox = Math.min(a.cx + a.hx, b.cx + b.hx) - Math.max(a.cx - a.hx, b.cx - b.hx);
    const oz = Math.min(a.cz + a.hz, b.cz + b.hz) - Math.max(a.cz - a.hz, b.cz - b.hz);
    minOverlap = Math.min(minOverlap, ox, oz);
  }
  assert.ok(minOverlap >= capsuleDiameter,
    `narrowest consecutive-tread overlap is ${minOverlap.toFixed(3)}m, ` +
    `below the ${capsuleDiameter.toFixed(2)}m capsule diameter - a climbing capsule ` +
    'could lose support at the transition between treads');
});
