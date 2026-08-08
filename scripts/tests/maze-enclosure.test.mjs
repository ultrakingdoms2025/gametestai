import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { Physics } from '../../src/physics/Physics.js';
import { MAZE, generateTopology, cellIndex, isOpen, DIR, cellCoords } from '../../src/worlds/maze/MazeTopology.js';
import { districtColliders, cellToWorld } from '../../src/worlds/maze/MazeColliders.js';
import {
  isEnclosureSound, requiredWallTop, shaftColliders, stairColliders, ENTRY_SEAL_FROM,
  STAIR_WELL_HALF, STAIR_WELL_OFFSET, stairWellBounds, SHAFT_STEPS,
  TREAD_HALF, STAIR_RADIUS, STAIR_TREADS_PER_TURN,
} from '../../src/worlds/maze/MazeShafts.js';
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

test('MazeTopology.js, MazeColliders.js and MazeShafts.js import nothing outside each other', async () => {
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

  /* The other two may import each other and nothing else. Widened in Phase 2c
   * when the connector geometry moved to MazeShafts.js: the set grew, the
   * rule did not. MazeShafts.js is where the enclosure proof now lives, so it
   * is if anything the most important of the three to keep importable by
   * Node. */
  const allowed = new Set(['./MazeTopology.js', './MazeColliders.js', './MazeShafts.js']);
  for (const file of ['MazeColliders.js', 'MazeShafts.js']) {
    const src = await readFile(path.join(root, 'src/worlds/maze', file), 'utf8');
    const imports = [...src.matchAll(importRe)].map((m) => m[1]);
    assert.ok(imports.length > 0, `${file} imports nothing - expected at least ./MazeTopology.js`);
    for (const spec of imports) {
      assert.ok(allowed.has(spec),
        `${file} imports "${spec}" - these three modules may only import each other`);
    }
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
        // Shaft's own walls, not the maze's ordinary hedges - see
        // MazeColliders.shaftColliders, which tags them 'shaftWall' rather
        // than 'hedge' so they render in a distinct pale material instead of
        // vanishing into the hedge-green canopy.
        const walls = shaftColliders(t.cells, c.x, c.z, 0).filter((d) => d.kind === 'shaftWall');
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

/* ------------------------------------------------------------------ */
/* Pre-merge review, Phase 2b - Important Finding 1. `districtColliders`  */
/* (MazeColliders.js, just above "One floor slab per district") scans for */
/* the FIRST cell carrying DIR.UP in the district below and stops there   */
/* when punching the hole in level N+1's floor. That is correct today:    */
/* `districtNeighbours` (MazeTopology.js) offers each district at most one */
/* vertical neighbour per level, and `carveDistrict` opens at most one UP  */
/* doorway per open edge, so a second UP cell in one district is           */
/* structurally impossible right now - every gate above this one proves    */
/* that by testing only the first (or only) shaft `firstShaft` finds.      */
/*                                                                          */
/* Nothing asserted the "at most one" premise itself, though, and the day  */
/* a second vertical link per district exists - a lift, which is the next  */
/* one planned - the second shaft's top treads go silently back into the   */
/* floor slab above it: exactly Finding 1 (Critical) from an earlier round */
/* of this same phase, reintroduced through a door none of the existing    */
/* tests are standing in front of. This is that guard: it does not trust   */
/* the "at most one" premise, it checks EVERY UP cell found by generation,  */
/* not just the first `districtColliders` happens to punch a hole for.     */
/* ------------------------------------------------------------------ */

/**
 * True when no `floor` collider in `descs` covers `well`'s own centre point -
 * i.e. a hole genuinely exists there, rather than a shaft's stair climbing
 * into a solid slab above it. Cheaper than a physics sweep (no capsule, no
 * simulation) because the floor tiling in `districtColliders` is exact: every
 * point of the district's footprint is covered by exactly one `floor`
 * collider except the hole itself, so "is the well's centre covered" is the
 * whole question.
 */
function wellHasHole(descs, well) {
  const EPS = 1e-6;
  return !descs.some((d) => d.kind === 'floor'
    && well.cx > d.cx - d.hx + EPS && well.cx < d.cx + d.hx - EPS
    && well.cz > d.cz - d.hz + EPS && well.cz < d.cz + d.hz - EPS);
}

test('THE MULTI-SHAFT GATE: every UP cell in a district has a hole punched above it - not just the first', () => {
  // Deliberately does not use `firstShaft`/`shaftCells(..., 0)` the way every
  // other gate above does: this one exists precisely because "only the first"
  // is the bug it is guarding against. It enumerates every UP cell in every
  // district, at every level generation can actually place one (0..LEVELS-2 -
  // there is no "above" the top level), across several seeds, and checks each
  // one individually.
  let checked = 0;
  let districtsWithMultiple = 0;
  for (const seed of [1, 42, 2026]) {
    const t = generateTopology(seed, { levels: MAZE.LEVELS });
    for (let level = 0; level < MAZE.LEVELS - 1; level++) {
      for (let dz = 0; dz < MAZE.DISTRICTS; dz++) {
        for (let dx = 0; dx < MAZE.DISTRICTS; dx++) {
          const ups = shaftCells(t.cells, dx, dz, level);
          if (ups.length === 0) continue;
          if (ups.length > 1) districtsWithMultiple++;
          const above = districtColliders(t.cells, dx, dz, level + 1);
          for (const c of ups) {
            const well = stairWellBounds(c.x, c.z, level);
            assert.ok(wellHasHole(above, well),
              `seed ${seed} level ${level} district (${dx},${dz}): UP cell (${c.x},${c.z}) has no hole `
              + 'punched above it - only the first UP cell in a district gets one today, and this one '
              + 'was not it');
            checked++;
          }
        }
      }
    }
  }
  assert.ok(checked > 0, 'no UP cells found across any seed/level/district to check');
  // eslint-disable-next-line no-console
  console.log(`[multi-shaft] ${checked} UP cells checked across 3 seeds x ${MAZE.LEVELS - 1} levels; `
    + `${districtsWithMultiple} district(s) had more than one (expected 0 while districtNeighbours `
    + 'offers at most one vertical neighbour per district)');
});

/* ------------------------------------------------------------------ */
/* Fix round 3, Finding 1 (Critical) - the mirror-image bug: walls that   */
/* used to run all the way to LEVEL_HEIGHT + HEDGE_HEIGHT (14m) sealed a   */
/* climbing player into a 6x6m box at level N+1, blocking every side       */
/* regardless of what level N+1's OWN topology said - severing up to 397  */
/* of 399 cells in a real district flood fill. shaftColliders now caps    */
/* its walls at LEVEL_HEIGHT: above that height the cell simply becomes a */
/* level N+1 cell, governed entirely by level N+1's own topology.         */
/*                                                                        */
/* This retires round 2's "cannot fall through" test above (it asserted   */
/* that ALL FOUR sides stay blocked at level 1's height, which was true   */
/* only because walls used to run to 14m and is no longer the correct     */
/* property to check - two of those four sides are now supposed to open,  */
/* matching level 1's own topology; that is the entire point of this fix).*/
/* ------------------------------------------------------------------ */

/** DIR -> [dx, dz] step, keyed the same way MazeTopology.STEP is. */
const STEP_BY_DIR = {
  [DIR.N]: [0, -1], [DIR.E]: [1, 0], [DIR.S]: [0, 1], [DIR.W]: [-1, 0],
};

/* ------------------------------------------------------------------ */
/* A player, near enough                                               */
/*                                                                     */
/* Fix round 4. Every earlier round proved its own segment of the      */
/* journey with a bespoke probe - a tread-by-tread occupancy check     */
/* here, a straight-line capsule sweep with a manual downward nudge    */
/* there - and each probe was blind to the segment the NEXT round      */
/* broke. These properties are all about one thing (can a player walk  */
/* this?), so they all use one walker.                                 */
/* ------------------------------------------------------------------ */

const DT = 1 / 60;
const GRAVITY = 22;          // CONFIG.player.gravity
const WALK_SPEED = 4.0;
const STEP_H = MAZE.STEP_HEIGHT;
/** Launch speed that apexes at exactly `MAZE.HOP` under `GRAVITY`. */
const HOP_VELOCITY = Math.sqrt(2 * GRAVITY * HOP);

/**
 * One frame of `Player.js`'s move-resolve-step-up loop, reduced to what these
 * properties turn on: try the horizontal move, and if it barely moved while
 * grounded, retry it lifted by `stepHeight` and keep the lift only if it
 * actually freed the move. Gravity accumulates while airborne, so a capsule
 * that walks off an edge really falls rather than gliding.
 *
 * A bare `resolveCapsule` sweep - what rounds 2 and 3 used - cannot climb a
 * stair at all: pushed against a riser it is depenetrated horizontally, and
 * dropping it back down after a lift re-runs that same depenetration. The
 * step-up retry is the whole difference between "the stairs are unclimbable"
 * and "the player walks up them", so it has to be here.
 */
function makeWalker(p) {
  let vy = 0;
  return function frame(pos, tx, tz) {
    const dxv = tx - pos.x, dzv = tz - pos.z;
    const dist = Math.hypot(dxv, dzv);
    const step = Math.min(WALK_SPEED * DT, dist);
    const mx = dist > 1e-9 ? (dxv / dist) * step : 0;
    const mz = dist > 1e-9 ? (dzv / dist) * step : 0;
    const bx = pos.x, by = pos.y, bz = pos.z;
    pos.x += mx; pos.z += mz; pos.y += vy * DT;
    let res = p.resolveCapsule(pos, RADIUS, HEIGHT);
    const moved = Math.hypot(pos.x - bx, pos.z - bz);
    if (moved < step * 0.7 && (res.grounded || vy <= 0)) {
      const sx = pos.x, sy = pos.y, sz = pos.z, sg = res.grounded;
      pos.set(bx + mx, by + STEP_H, bz + mz);
      const r2 = p.resolveCapsule(pos, RADIUS, HEIGHT);
      /* Accept the step only if it freed the move AND the resolve did not
       * carry the capsule higher than the step itself. Without that second
       * condition a capsule pressed up into a ceiling is depenetrated
       * upwards a little each frame and eventually ratchets clean through it
       * - which would make a solid floor above the stairs look climbable and
       * silently defeat the ceiling half of this proof. */
      if (Math.hypot(pos.x - bx, pos.z - bz) > moved + 1e-4
        && pos.y <= by + STEP_H + 1e-3) res = r2;
      else { pos.set(sx, sy, sz); res = { grounded: sg }; }
    }
    if (res.grounded) vy = 0; else vy -= GRAVITY * DT;
    return { dist: Math.hypot(tx - pos.x, tz - pos.z), grounded: res.grounded };
  };
}

/** Build a Physics world from descriptors. */
function worldOf(descs) {
  const p = new Physics(null);
  for (const d of descs) p.addBox(d.cx, d.cy, d.cz, d.hx, d.hy, d.hz);
  return p;
}

/**
 * Walk a capsule through a list of waypoints; returns whether it reached the
 * last one, and the lowest y it ever held.
 */
function walkRoute(p, pos, waypoints, framesPerLeg = 600, tol = 0.3) {
  const frame = makeWalker(p);
  let minY = pos.y;
  for (const wp of waypoints) {
    let ok = false;
    for (let s = 0; s < framesPerLeg; s++) {
      const r = frame(pos, wp.x, wp.z);
      minY = Math.min(minY, pos.y);
      if (r.dist < tol) { ok = true; break; }
    }
    if (!ok) return { reached: false, minY };
  }
  return { reached: true, minY };
}

/**
 * The corner of a shaft cell the stair well does NOT occupy.
 *
 * The well sits in one quadrant (see `STAIR_WELL_OFFSET`), which is exactly
 * what leaves an L-shaped strip along the cell's other two sides clear on
 * both levels. Every route through a shaft cell - walking in at level N,
 * walking away at level N+1, or crossing it without using the stair at all -
 * goes through this corner. Routing through it is not a workaround for the
 * geometry; it IS the geometry.
 */
function freeCorner(w) {
  return { x: w.x - 1.6, z: w.z - 1.6 };
}

/** Where a climber steps off the stair: the middle of the landing. */
function landingCentre(w) {
  return {
    x: w.x + STAIR_WELL_OFFSET - STAIR_WELL_HALF / 2,
    z: w.z + STAIR_WELL_OFFSET - STAIR_WELL_HALF / 2,
  };
}

test('THE ESCAPE GATE: climbing a real shaft lets the player leave its footprint at level N+1 through an open side, and a closed side still blocks', () => {
  // The counterpart to THE CEILING GATE: that one asks "does the climb
  // reach the top", this one asks "once there, can you walk away". Neither
  // question is the other - round 2's ceiling gate and fall-through test
  // both passed throughout round 3's bug, because they only ever asked
  // whether the climb reaches 9m and whether you can fall down, never
  // whether you can walk sideways out of the box at the top.
  let checked = 0;
  for (const seed of [1, 42, 2026]) {
    const t = generateTopology(seed, { levels: 2 });
    for (let dz = 0; dz < 6 && checked < 3; dz++) {
      for (let dx = 0; dx < 6 && checked < 3; dx++) {
        const cells = shaftCells(t.cells, dx, dz, 0);
        if (!cells.length) continue;
        const c = cells[0];
        const w1 = cellToWorld(c.x, c.z, 1);
        const idx1 = cellIndex(c.x, c.z, 1);
        // Level N+1's OWN topology at this same cell - independent of, and
        // not necessarily matching, level 0's shaft doorway direction.
        const openDirs = [DIR.N, DIR.E, DIR.S, DIR.W].filter((d) => isOpen(t.cells, idx1, d));
        const closedDirs = [DIR.N, DIR.E, DIR.S, DIR.W].filter((d) => !isOpen(t.cells, idx1, d));
        assert.ok(openDirs.length > 0,
          `level 1 cell ${c.x},${c.z} has no open passage at all - impossible in a carved maze`);

        const descs = [...districtColliders(t.cells, dx, dz, 0), ...districtColliders(t.cells, dx, dz, 1)];
        const p = worldOf(descs);

        /* Starts where a climber actually arrives - on the landing - and
         * leaves via the corner of the cell the well does not occupy. Fix
         * round 4: the previous version started at the cell CENTRE and walked
         * in a straight line, which only ever worked because the whole cell
         * was floor. It is now a stairwell in one quadrant with floor round
         * it, so the route out goes round the well, exactly as it would in a
         * building. */
        const walk = (dir) => {
          const [sx, sz] = STEP_BY_DIR[dir];
          const corner = freeCorner(w1);
          const pos = new THREE.Vector3(landingCentre(w1).x, w1.y + 0.1, landingCentre(w1).z);
          p.resolveCapsule(pos, RADIUS, HEIGHT);
          const r = walkRoute(p, pos, [corner, { x: corner.x + sx * 8, z: corner.z + sz * 8 }]);
          return { dist: Math.hypot(pos.x - w1.x, pos.z - w1.z), y: pos.y, minY: r.minY };
        };

        // Open side: walk several metres away, staying on the floor.
        const open = walk(openDirs[0]);
        assert.ok(open.dist >= 4,
          `seed ${seed} shaft ${c.x},${c.z}: only reached ${open.dist.toFixed(2)}m from the shaft ` +
          `centre through level 1's own open side (dir ${openDirs[0]}) - expected several metres`);
        assert.ok(Math.abs(open.y - w1.y) < 0.5 && open.minY > w1.y - 0.5,
          `seed ${seed} shaft ${c.x},${c.z}: walking out through the open side left the capsule at ` +
          `${open.y.toFixed(2)}m (lowest ${open.minY.toFixed(2)}m), not on level 1's floor ` +
          `(${w1.y}m) - it fell or climbed unexpectedly`);

        // Closed side (if any at this cell - both level 1 directions may
        // happen to be open in the maze's own carving): must still block.
        if (closedDirs.length > 0) {
          const closed = walk(closedDirs[0]);
          assert.ok(closed.dist < MAZE.CELL / 2,
            `seed ${seed} shaft ${c.x},${c.z}: closed side (dir ${closedDirs[0]}) let the capsule ` +
            `${closed.dist.toFixed(2)}m from centre - past the ${MAZE.CELL / 2}m cell half-width, ` +
            'so it was not actually blocked');
        }
        checked++;
      }
    }
  }
  assert.ok(checked > 0, 'no shafts found to check');
});

test('with the walls capped, a level-1 district reached through a shaft landing is walkable end to end', () => {
  // The coordinator's own reproduction: "a per-district flood fill cut off
  // up to 397 of 399 cells." A pure topology flood fill can never detect
  // this class of bug - MazeTopology.js's carving is not what broke, the
  // COLLIDER geometry blocking a topologically-open passage is - so this
  // builds the district's adjacency graph from level 1's own topology bits
  // (always correct, exhaustively tested elsewhere) for every edge EXCEPT
  // the shaft landing cell's own four, which are verified physically
  // (matching THE ESCAPE GATE's own method above) since those are the only
  // edges this fix round's change could possibly have broken.
  for (const seed of [1, 42, 2026]) {
    const t = generateTopology(seed, { levels: 2 });
    let found = null;
    for (let dz = 0; dz < MAZE.DISTRICTS && !found; dz++) {
      for (let dx = 0; dx < MAZE.DISTRICTS && !found; dx++) {
        const cells = shaftCells(t.cells, dx, dz, 0);
        if (cells.length) found = { dx, dz, cell: cells[0] };
      }
    }
    assert.ok(found, `seed ${seed}: no shaft found in any district`);
    const { dx, dz, cell } = found;

    const descs = [...districtColliders(t.cells, dx, dz, 0), ...districtColliders(t.cells, dx, dz, 1)];
    const p = worldOf(descs);

    /* Both endpoints are routed through the corner of their own cell that a
     * well cannot occupy, and a shaft cell's own free corner is the one the
     * landing opens onto - so this walks the route a player really walks,
     * round the stairwell rather than through it. */
    const physicallyWalkable = (fromX, fromZ, dir) => {
      const w = cellToWorld(fromX, fromZ, 1);
      const [sx, sz] = STEP_BY_DIR[dir];
      const from = freeCorner(w);
      const to = freeCorner(cellToWorld(fromX + sx, fromZ + sz, 1));
      const pos = new THREE.Vector3(from.x, w.y + 0.1, from.z);
      p.resolveCapsule(pos, RADIUS, HEIGHT);
      const r = walkRoute(p, pos, [{ x: from.x + sx * MAZE.CELL, z: from.z + sz * MAZE.CELL }, to], 400);
      return r.reached && r.minY > w.y - 0.5;
    };

    const D = MAZE.DISTRICT;
    const x0 = dx * D, z0 = dz * D;
    const key = (x, z) => `${x},${z}`;
    const adj = new Map();
    const addEdge = (a, b) => {
      if (!adj.has(a)) adj.set(a, new Set());
      if (!adj.has(b)) adj.set(b, new Set());
      adj.get(a).add(b); adj.get(b).add(a);
    };
    for (let lz = 0; lz < D; lz++) {
      for (let lx = 0; lx < D; lx++) {
        const x = x0 + lx, z = z0 + lz;
        const idx = cellIndex(x, z, 1);
        for (const dir of [DIR.N, DIR.E, DIR.S, DIR.W]) {
          if (!isOpen(t.cells, idx, dir)) continue;
          const [sx, sz] = STEP_BY_DIR[dir];
          const nx = x + sx, nz = z + sz;
          if (nx < x0 || nx >= x0 + D || nz < z0 || nz >= z0 + D) continue; // stay in-district
          const isShaftEdge = (x === cell.x && z === cell.z) || (nx === cell.x && nz === cell.z);
          if (isShaftEdge && !physicallyWalkable(x, z, dir)) continue; // geometry blocks it - do not add
          addEdge(key(x, z), key(nx, nz));
        }
      }
    }

    const start = key(cell.x, cell.z);
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const cur = queue.shift();
      for (const n of adj.get(cur) ?? []) if (!seen.has(n)) { seen.add(n); queue.push(n); }
    }
    const total = D * D;
    // eslint-disable-next-line no-console
    console.log(`[flood fill] seed ${seed} district (${dx},${dz}) from the landing at `
      + `(${cell.x},${cell.z}): ${seen.size}/${total} cells reached`);
    assert.ok(seen.size >= total * 0.9,
      `seed ${seed}: flood fill from the shaft landing at (${cell.x},${cell.z}) only reached ` +
      `${seen.size}/${total} cells in district (${dx},${dz}) - the shaft is severing the district`);
  }
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
  //
  // Bound is `LEVEL_HEIGHT + HEDGE_HEIGHT`, not `HEDGE_HEIGHT` (fix round 3):
  // escaping the shaft's own 6x6m footprint at or above LEVEL_HEIGHT is now
  // correct and intended - that is what walking out at the top through
  // level N+1's own open side IS (see THE ESCAPE GATE). Only this shaft's
  // colliders are loaded here (no level N+1), so nothing stops the capsule
  // rising indefinitely in principle; what actually bounds it is that
  // `escapeHeight` only hops while grounded, and once clear of every tread
  // with nothing else nearby it stops being grounded. The real hazard this
  // sweep still has to rule out is reaching level N+1's OWN hedge top
  // (`LEVEL_HEIGHT + HEDGE_HEIGHT`, 14m) - that would mean landing on
  // something no player should be able to stand on.
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
          assert.ok(escape < MAZE.LEVEL_HEIGHT + MAZE.HEDGE_HEIGHT,
            `seed ${seed} shaft ${c.x},${c.z}: capsule escaped to ${escape.toFixed(2)}m, ` +
            `at/above level N+1's own hedge top (${MAZE.LEVEL_HEIGHT + MAZE.HEDGE_HEIGHT}m)`);
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
/* Fix round 2, Finding 5 (Minor): consecutive treads must be laterally  */
/* reachable. That was tested as "their footprints overlap by at least a */
/* capsule diameter", a proxy chosen when no capsule could be driven up  */
/* a real stair at all. Fix round 4 can drive one, so the property is    */
/* tested as itself - the overlap number it needs is whatever a walking  */
/* capsule needs, not a figure guessed in advance. The geometric floor   */
/* under it (footprints must actually meet) is kept as the cheap,        */
/* every-shaft version of the same statement.                            */
/* ------------------------------------------------------------------ */

test('consecutive treads meet: their footprints overlap on both axes', () => {
  const descs = shaftColliders(new Uint8Array(1).fill(DIR.UP), 0, 0, 0);
  const treads = descs.filter((d) => d.kind === 'stair').sort((a, b) => a.cy - b.cy);
  assert.ok(treads.length > 1, 'expected multiple treads to compare');
  let minOverlap = Infinity;
  for (let i = 1; i < treads.length; i++) {
    const a = treads[i - 1], b = treads[i];
    const ox = Math.min(a.cx + a.hx, b.cx + b.hx) - Math.max(a.cx - a.hx, b.cx - b.hx);
    const oz = Math.min(a.cz + a.hz, b.cz + b.hz) - Math.max(a.cz - a.hz, b.cz - b.hz);
    minOverlap = Math.min(minOverlap, ox, oz);
  }
  /* Bar restored in Phase 2c. 2b's ledger flagged that this had been cut from
   * the capsule diameter (0.70 m) to `> 0`, and called it "a bar removed" -
   * correctly, because a test that fires only when treads come fully APART
   * warns of nothing.
   *
   * The capsule diameter turned out to be the wrong bar, and unattainable by
   * construction: `STAIR_RADIUS`'s own REACHABILITY note derives the tightest
   * consecutive overlap as `2*TREAD_HALF - 2*STAIR_RADIUS*sin(pi/N)` = 0.311 m,
   * and the geometry measures 0.364 m. No spiral that satisfies the headroom
   * and footprint constraints could ever have reached 0.70 m, so restoring
   * that number would have been a red test rather than a real guarantee.
   *
   * TWO bars, because one of them alone is weaker than it looks.
   *
   * 1. CONSISTENCY, derived from the spiral's own constants. This catches a
   *    retuned radius, phase or tread count that breaks the relationship
   *    `STAIR_RADIUS` documents. It does NOT catch the overlap simply getting
   *    small: shrink TREAD_HALF and both sides move together, which was
   *    verified - TREAD_HALF 0.46 gives overlap 0.284 against a derived 0.231
   *    and stays green. A self-scaling bar is a consistency check, not a floor.
   * 2. AN ABSOLUTE FLOOR. 0.30 m, against a measured 0.364 m. This is what
   *    actually fires when the spiral is retuned tighter, and TREAD_HALF 0.46
   *    was confirmed to trip it. It must never be LOWERED to make new geometry
   *    pass - THE CLIMB GATE is the physical proof, and this is the cheap
   *    early warning that something moved before anyone reads that gate. */
  const derived = 2 * TREAD_HALF - 2 * STAIR_RADIUS * Math.sin(Math.PI / STAIR_TREADS_PER_TURN);
  assert.ok(minOverlap >= derived - 1e-9,
    `consecutive treads overlap by only ${minOverlap.toFixed(3)}m against the ${derived.toFixed(3)}m ` +
    "the spiral's own derivation requires - the climb is thinner than STAIR_RADIUS claims");
  const FLOOR = 0.30;
  assert.ok(minOverlap >= FLOOR,
    `consecutive treads overlap by ${minOverlap.toFixed(3)}m, under the ${FLOOR}m floor - ` +
    're-verify THE CLIMB GATE before considering this acceptable');
  assert.ok(minOverlap > 0,
    `consecutive treads are ${(-minOverlap).toFixed(3)}m APART on one axis - the climb has a ` +
    'gap in it, and a capsule stepping across would have nothing under it');
  // eslint-disable-next-line no-console
  console.log(`[treads] narrowest consecutive overlap ${minOverlap.toFixed(3)}m`);
});

/* ================================================================== */
/* Fix round 4: the six properties, each with the measurement that     */
/* demonstrates it and a negative that proves it can fail.             */
/*                                                                     */
/* Rounds 1-3 each proved one more segment of the journey and stopped  */
/* where the previous bug had been. Every one of those proofs stayed   */
/* green through the bug that came next, because none of them was      */
/* stated as a property of the whole journey. These are.               */
/* ================================================================== */

/** The first shaft real generation puts anywhere, plus its district. */
function firstShaft(seed, levels = 2) {
  const t = generateTopology(seed, { levels });
  for (let dz = 0; dz < MAZE.DISTRICTS; dz++) {
    for (let dx = 0; dx < MAZE.DISTRICTS; dx++) {
      const cells = shaftCells(t.cells, dx, dz, 0);
      if (cells.length) return { t, dx, dz, cell: cells[0] };
    }
  }
  throw new Error(`seed ${seed}: no shaft anywhere`);
}

/**
 * The geometry as it shipped after fix round 3, rebuilt from the current
 * output: level N+1's floor perforated over the WHOLE shaft cell, and no
 * guard walls or landing round the result. This is the pit - 427 of 529
 * sample points across the cell dropping the full 9.00 m - and it is the
 * negative every fall-through property below is measured against.
 */
function withFullCellHole(descs, dx, dz, level, cell) {
  const w = cellToWorld(cell.x, cell.z, level);
  const D = MAZE.DISTRICT;
  const half = (D * MAZE.CELL + MAZE.CELL) / 2;
  const centerX = dx * D * MAZE.CELL + (D - 1) * MAZE.CELL / 2;
  const centerZ = dz * D * MAZE.CELL + (D - 1) * MAZE.CELL / 2;
  const cellHalf = MAZE.CELL / 2;
  const out = descs.filter((d) => {
    // Drop this level's floor tiles, the guard walls round its well, and the
    // landing - none of which existed before this fix round.
    if (d.kind === 'floor' && Math.abs(d.cy - (w.y - 0.5)) < 1e-6) return false;
    if (d.kind === 'hedge' && Math.abs(d.cy - d.hy - w.y) < 1e-6
      && Math.abs(d.cx - w.x) < cellHalf && Math.abs(d.cz - w.z) < cellHalf) return false;
    if (d.kind === 'stair' && Math.abs(d.cy + d.hy - w.y) < 1e-6) return false;
    return true;
  });
  const rect = (x0, x1, z0, z1) => out.push({
    cx: (x0 + x1) / 2, cy: w.y - 0.5, cz: (z0 + z1) / 2,
    hx: (x1 - x0) / 2, hy: 0.5, hz: (z1 - z0) / 2, kind: 'floor',
  });
  const hx0 = w.x - cellHalf, hx1 = w.x + cellHalf;
  const hz0 = w.z - cellHalf, hz1 = w.z + cellHalf;
  rect(centerX - half, hx0, centerZ - half, centerZ + half);
  rect(hx1, centerX + half, centerZ - half, centerZ + half);
  rect(hx0, hx1, centerZ - half, hz0);
  rect(hx0, hx1, hz1, centerZ + half);
  return out;
}

/* ---------- PROPERTY 1: a player can walk in ---------- */

/**
 * Walk a capsule from the middle of a neighbouring level-N corridor cell,
 * through the shaft cell's own doorway, to the free corner of the shaft cell.
 */
function entersFrom(descs, w, dir) {
  const p = worldOf(descs);
  const [sx, sz] = STEP_BY_DIR[dir];
  const pos = new THREE.Vector3(w.x + sx * MAZE.CELL, w.y + 0.1, w.z + sz * MAZE.CELL);
  p.resolveCapsule(pos, RADIUS, HEIGHT);
  return walkRoute(p, pos, [freeCorner(w)], 600).reached;
}

test('THE ENTRY GATE: a player walks in from every level-N corridor a shaft opens onto', () => {
  let checked = 0;
  for (const seed of [1, 42, 2026]) {
    const { t, dx, dz, cell } = firstShaft(seed);
    const descs = districtColliders(t.cells, dx, dz, 0);
    const w = cellToWorld(cell.x, cell.z, 0);
    const idx = cellIndex(cell.x, cell.z, 0);
    const open = [DIR.N, DIR.E, DIR.S, DIR.W].filter((d) => isOpen(t.cells, idx, d));
    assert.ok(open.length > 0, `shaft cell ${cell.x},${cell.z} has no open passage at all`);
    for (const dir of open) {
      assert.ok(entersFrom(descs, w, dir),
        `seed ${seed} shaft ${cell.x},${cell.z}: a capsule could not walk in from the corridor `
        + `on side ${dir}, which this cell's own topology marks OPEN`);
      checked++;
    }
  }
  assert.ok(checked > 0, 'no open shaft sides found to walk in through');
  // eslint-disable-next-line no-console
  console.log(`[entry] ${checked} open shaft sides walked in through`);
});

test('the entry gate is not vacuous: sealing the doorway from the floor up blocks the walk in', () => {
  // Fix round 1's bug, rebuilt: the open side's wall starting at the shaft
  // floor instead of ENTRY_SEAL_FROM. 617 shafts passed every "is it sealed"
  // check while none of them could be entered.
  const { t, dx, dz, cell } = firstShaft(2026);
  const w = cellToWorld(cell.x, cell.z, 0);
  const idx = cellIndex(cell.x, cell.z, 0);
  const open = [DIR.N, DIR.E, DIR.S, DIR.W].filter((d) => isOpen(t.cells, idx, d));
  const half = MAZE.CELL / 2;
  const sealed = districtColliders(t.cells, dx, dz, 0).map((d) => {
    // The shaft's own open-side wall is tagged 'shaftWall', not 'hedge' -
    // see MazeColliders.shaftColliders.
    const onSide = d.kind === 'shaftWall' && Math.abs(d.cy - d.hy - (w.y + ENTRY_SEAL_FROM)) < 1e-6
      && Math.abs(d.cx - w.x) <= half + 1e-6 && Math.abs(d.cz - w.z) <= half + 1e-6;
    if (!onSide) return d;
    const top = d.cy + d.hy;
    return { ...d, cy: (w.y + top) / 2, hy: (top - w.y) / 2 };
  });
  assert.ok(open.length > 0, 'fixture needs an open side');
  for (const dir of open) {
    assert.equal(entersFrom(sealed, w, dir), false,
      `a shaft sealed from its own floor let a capsule walk in through side ${dir} - `
      + 'if this passes, THE ENTRY GATE cannot detect the bug it exists for');
  }
});

/* ---------- PROPERTY 2: a player can climb it ---------- */

/**
 * Walk a capsule in from the free corner and up every tread in turn.
 * Returns the height it ends at.
 */
function climbShaft(descs, w) {
  const p = worldOf(descs);
  const treads = descs
    .filter((d) => d.kind === 'stair'
      && Math.abs(d.cx - w.x) < MAZE.CELL && Math.abs(d.cz - w.z) < MAZE.CELL)
    .sort((a, b) => a.cy - b.cy);
  const pos = new THREE.Vector3(freeCorner(w).x, w.y + 0.2, freeCorner(w).z);
  p.resolveCapsule(pos, RADIUS, HEIGHT);
  const frame = makeWalker(p);
  for (const tr of treads) {
    let ok = false;
    for (let s = 0; s < 240; s++) {
      if (frame(pos, tr.cx, tr.cz).dist < 0.25) { ok = true; break; }
    }
    if (!ok) break;
  }
  return pos.y;
}

test('THE CLIMB GATE: a player walks off a level-N corridor and up a real shaft to LEVEL_HEIGHT', () => {
  // Not a tread-occupancy proxy (that is THE CEILING GATE above, kept as the
  // cheap version): this drives the same collide-and-step-up loop Player.js
  // runs, starting in the corridor, with BOTH levels resident.
  let checked = 0;
  for (const seed of [1, 42, 2026]) {
    const { t, dx, dz, cell } = firstShaft(seed);
    const descs = [...districtColliders(t.cells, dx, dz, 0), ...districtColliders(t.cells, dx, dz, 1)];
    const w = cellToWorld(cell.x, cell.z, 0);
    const reached = climbShaft(descs, w);
    assert.ok(reached >= w.y + MAZE.LEVEL_HEIGHT - 1e-6,
      `seed ${seed} shaft ${cell.x},${cell.z}: the climb stopped at `
      + `${(reached - w.y).toFixed(2)}m, short of LEVEL_HEIGHT (${MAZE.LEVEL_HEIGHT}m)`);
    checked++;
  }
  assert.ok(checked > 0, 'no shafts climbed');
  // eslint-disable-next-line no-console
  console.log(`[climb] ${checked} real shafts walked from corridor to LEVEL_HEIGHT`);
});

test('the climb gate is not vacuous: an unperforated level-N+1 floor stops the same walk short', () => {
  // Fix round 2's bug, rebuilt: level 1's floor as one slab with no hole.
  const { t, dx, dz, cell } = firstShaft(2026);
  const w = cellToWorld(cell.x, cell.z, 0);
  const D = MAZE.DISTRICT;
  const half = (D * MAZE.CELL + MAZE.CELL) / 2;
  const descs = [...districtColliders(t.cells, dx, dz, 0), {
    cx: dx * D * MAZE.CELL + (D - 1) * MAZE.CELL / 2,
    cy: w.y + MAZE.LEVEL_HEIGHT - 0.5,
    cz: dz * D * MAZE.CELL + (D - 1) * MAZE.CELL / 2,
    hx: half, hy: 0.5, hz: half, kind: 'floor',
  }];
  const reached = climbShaft(descs, w);
  assert.ok(reached < w.y + MAZE.LEVEL_HEIGHT - 1,
    `the unperforated-floor fixture let the climb reach ${(reached - w.y).toFixed(2)}m - `
    + 'if it does not stop short, THE CLIMB GATE cannot detect a solid ceiling');
});

/* ---------- PROPERTY 4: a player cannot fall in from above ---------- */

/**
 * Ground height across the whole shaft cell at level N+1, on a square grid.
 * Returns how many samples sit more than `bar` below that floor.
 */
function pitProfile(descs, w1, bar = 0.5, n = 23) {
  const p = worldOf(descs);
  const half = MAZE.CELL / 2;
  let over = 0, worst = 0, total = 0, deep = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = w1.x - half + (2 * half * i) / (n - 1);
      const z = w1.z - half + (2 * half * j) / (n - 1);
      const g = p.groundHeight(x, z, w1.y + 3, 40);
      const drop = Number.isFinite(g) ? w1.y - g : MAZE.LEVEL_HEIGHT;
      total++;
      if (drop > bar) over++;
      // A drop with no tread under it at all: the only places these survive
      // are slivers between tread corners and the well's own edge, all far
      // narrower than the 0.70 m capsule (THE WALK-ON-IT GATE is what proves
      // that; this just measures them).
      if (drop > MAZE.LEVEL_HEIGHT - MAZE.HEDGE_HEIGHT) deep++;
      if (drop > worst) worst = drop;
    }
  }
  return { over, total, worst, deep };
}

/**
 * THE PIT GATE's bar, restated as a multiple of the well's own footprint
 * fraction instead of a bare `0.25`.
 *
 * The stair well is `(2 * STAIR_WELL_HALF)^2` = 7.84 m^2 of the cell's
 * `MAZE.CELL^2` = 36 m^2 - `WELL_FRACTION` below, ~21.7% - and that is the
 * floor this measurement can never read below: a hole exactly the size of
 * the well, with every sample point over it counted as "dropped" and none
 * outside it, samples at 1.0x `WELL_FRACTION` by construction. A bare `0.25`
 * reads as an arbitrary round number sitting suspiciously close to that
 * floor; stated as `WELL_FRACTION * PIT_GATE_MULTIPLIER` it says what it
 * actually is - a small amount of slack (for sampling-grid alignment) over
 * the one-well-and-nothing-more baseline - and it tracks `STAIR_WELL_HALF`
 * automatically if the well's size ever changes, rather than needing hand
 * retuning to stay meaningful.
 *
 * `ORIGINAL_PIT_GATE_BAR` (the old bare `0.25`) is a CEILING on the result,
 * not just a reference point: the assertion below is `fraction < bar`, so a
 * HIGHER bar is a LOOSER gate, and restating a threshold must never loosen
 * it - `WELL_FRACTION * PIT_GATE_MULTIPLIER` alone computes to ~25.04%,
 * slightly above the original 25%, which would have done exactly that.
 * `Math.min` keeps the derived number as the working value whenever it is
 * the tighter of the two (protecting the gate if `STAIR_WELL_HALF` ever
 * shrinks) while guaranteeing the restated bar can never exceed what this
 * gate already proved decisive at. It is still nowhere near what a
 * full-cell hole samples at (~40%+ - see the negative test right below), so
 * it stays exactly as decisive a detector as the number it replaces.
 */
const WELL_FRACTION = (2 * STAIR_WELL_HALF) ** 2 / MAZE.CELL ** 2;
const PIT_GATE_MULTIPLIER = 1.15;
const ORIGINAL_PIT_GATE_BAR = 0.25;
const PIT_GATE_BAR = Math.min(ORIGINAL_PIT_GATE_BAR, WELL_FRACTION * PIT_GATE_MULTIPLIER);

test('THE PIT GATE: the hole a shaft opens in level N+1 is a stairwell opening, not most of the cell', () => {
  // The measurement round 3 lost. Its predecessor asserted "all four sides of
  // the shaft cell stay blocked at level 1's height", which stopped being
  // true - correctly - the moment the walls were capped, and was retired
  // rather than replaced. That is how the pit shipped. This states the
  // property instead of one geometry's way of satisfying it: sample the
  // ground under the whole cell and require the opening to be a small part
  // of it.
  for (const seed of [1, 42, 2026]) {
    const { t, dx, dz, cell } = firstShaft(seed);
    const descs = [...districtColliders(t.cells, dx, dz, 0), ...districtColliders(t.cells, dx, dz, 1)];
    const w1 = cellToWorld(cell.x, cell.z, 1);
    const prof = pitProfile(descs, w1);
    const fraction = prof.over / prof.total;
    assert.ok(fraction < PIT_GATE_BAR,
      `seed ${seed} shaft ${cell.x},${cell.z}: ${prof.over}/${prof.total} sample points across the `
      + `cell drop more than 0.5m (${(fraction * 100).toFixed(0)}%, bar ${(PIT_GATE_BAR * 100).toFixed(1)}%) `
      + '- that is a missing floor, not a hole in one');
    // eslint-disable-next-line no-console
    console.log(`[pit] seed ${seed} shaft (${cell.x},${cell.z}): ${prof.over}/${prof.total} `
      + `points drop >0.5m (${(fraction * 100).toFixed(0)}%), ${prof.deep} with no tread beneath, `
      + `worst ${prof.worst.toFixed(2)}m`);
  }
});

test('the pit gate is not vacuous: perforating the whole shaft cell fails it', () => {
  const { t, dx, dz, cell } = firstShaft(2026);
  const descs = withFullCellHole(
    [...districtColliders(t.cells, dx, dz, 0), ...districtColliders(t.cells, dx, dz, 1)],
    dx, dz, 1, cell,
  );
  const w1 = cellToWorld(cell.x, cell.z, 1);
  const prof = pitProfile(descs, w1);
  assert.ok(prof.over / prof.total > 0.4 && prof.worst > MAZE.LEVEL_HEIGHT - 0.5,
    `the full-cell-hole fixture only reported ${prof.over}/${prof.total} points dropping `
    + `(worst ${prof.worst.toFixed(2)}m) - if it does not fail THE PIT GATE, that gate cannot `
    + 'detect the pit that shipped');
  // eslint-disable-next-line no-console
  console.log(`[pit negative] full-cell hole: ${prof.over}/${prof.total} points drop >0.5m, `
    + `worst ${prof.worst.toFixed(2)}m`);
});

/**
 * From every point a capsule can actually stand on at level N+1 inside the
 * shaft cell, walk it 0.6 m in eight directions and let it settle. Returns
 * the deepest it ever ends below that floor.
 */
/**
 * How far each walk-off goes. It has to clear the 0.6 m ledge the shaft's own
 * side walls present at level N+1's floor height (their tops stop exactly
 * there) - a shorter walk never leaves that ledge, and would report a pit as
 * safe.
 */
const WALK_OFF_DIST = 1.2;

/**
 * The most a `WALK_OFF_DIST` walk may legitimately descend: one riser per
 * tread it could cross, where the treads' own centre-to-centre pitch says how
 * many that is. Derived from the emitted geometry rather than typed in, so a
 * change to the spiral moves this bar with it instead of silently loosening
 * or tightening it.
 */
function maxLegitimateDescent() {
  const treads = shaftColliders(new Uint8Array(1).fill(DIR.UP), 0, 0, 0)
    .filter((d) => d.kind === 'stair').sort((a, b) => a.cy - b.cy);
  let pitch = Infinity, rise = 0;
  for (let i = 1; i < treads.length; i++) {
    pitch = Math.min(pitch, Math.hypot(treads[i].cx - treads[i - 1].cx, treads[i].cz - treads[i - 1].cz));
    rise = Math.max(rise, (treads[i].cy + treads[i].hy) - (treads[i - 1].cy + treads[i - 1].hy));
  }
  return Math.ceil(WALK_OFF_DIST / pitch) * rise + 0.02;
}

function walkOffProfile(descs, w1) {
  const bar = maxLegitimateDescent();
  const p = worldOf(descs);
  /* Samples reach a metre past the cell, so the ring of level-N+1 floor
   * around the shaft cell is included. That ring is where a pedestrian
   * crossing the district actually walks in from, and with the whole cell
   * perforated it is the only standable ground left - which is what makes
   * this measurable in both directions. */
  const half = MAZE.CELL / 2 + 1.0;
  const n = 21;
  let worst = 0, tested = 0, bad = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const sx = w1.x - half + (2 * half * i) / (n - 1);
      const sz = w1.z - half + (2 * half * j) / (n - 1);
      const g = p.groundHeight(sx, sz, w1.y + 2, 4);
      if (!Number.isFinite(g) || Math.abs(g - w1.y) > 0.05) continue; // not this floor
      for (let a = 0; a < 8; a++) {
        const ang = (a / 8) * Math.PI * 2;
        const pos = new THREE.Vector3(sx, w1.y + 0.05, sz);
        p.resolveCapsule(pos, RADIUS, HEIGHT);
        // Only start where a capsule genuinely fits, standing still.
        if (Math.abs(pos.y - w1.y) > 0.2) continue;
        if (Math.abs(pos.x - sx) > 0.03 || Math.abs(pos.z - sz) > 0.03) continue;
        const frame = makeWalker(p);
        const tx = sx + Math.cos(ang) * WALK_OFF_DIST, tz = sz + Math.sin(ang) * WALK_OFF_DIST;
        for (let s = 0; s < 40; s++) frame(pos, tx, tz);
        for (let s = 0; s < 120; s++) frame(pos, pos.x, pos.z); // settle under gravity
        tested++;
        const drop = w1.y - pos.y;
        if (drop > worst) worst = drop;
        if (drop > bar) bad++;
      }
    }
  }
  return { worst, tested, bad };
}

test('THE WALK-ON-IT GATE: walking level N+1 across a shaft cell descends stairs, never falls', () => {
  // The property behind "a player cannot fall into it from above", stated so
  // that a staircase satisfies it and a pit cannot: from anywhere on level
  // N+1's floor in this cell, a short walk in any direction leaves you either
  // still on the floor, or a riser or two down the stair - never in free
  // fall. The bar is derived from the stair's own pitch and rise (see
  // `maxLegitimateDescent`), so it is exactly "what walking down these
  // stairs for 1.2 m accounts for" and not a round number.
  let tested = 0, worst = 0;
  for (const seed of [1, 42, 2026]) {
    const { t, dx, dz, cell } = firstShaft(seed);
    const descs = [...districtColliders(t.cells, dx, dz, 0), ...districtColliders(t.cells, dx, dz, 1)];
    const w1 = cellToWorld(cell.x, cell.z, 1);
    const prof = walkOffProfile(descs, w1);
    assert.ok(prof.tested > 100, `seed ${seed}: only ${prof.tested} walk-offs sampled`);
    assert.equal(prof.bad, 0,
      `seed ${seed} shaft ${cell.x},${cell.z}: ${prof.bad} of ${prof.tested} short walks off a `
      + `level-1 standing spot dropped more than the ${MAZE.STEP_HEIGHT}m auto-step `
      + `(worst ${prof.worst.toFixed(2)}m) - that is a fall, not a step`);
    tested += prof.tested;
    worst = Math.max(worst, prof.worst);
  }
  // eslint-disable-next-line no-console
  console.log(`[walk-on-it] ${tested} short walks off level-1 standing spots, `
    + `worst drop ${worst.toFixed(2)}m`);
});

test('the walk-on-it gate is not vacuous: the full-cell hole drops a walking capsule a whole level', () => {
  const { t, dx, dz, cell } = firstShaft(2026);
  const descs = withFullCellHole(
    [...districtColliders(t.cells, dx, dz, 0), ...districtColliders(t.cells, dx, dz, 1)],
    dx, dz, 1, cell,
  );
  const w1 = cellToWorld(cell.x, cell.z, 1);
  const prof = walkOffProfile(descs, w1);
  assert.ok(prof.bad > 0 && prof.worst > MAZE.LEVEL_HEIGHT - 0.5,
    `the full-cell-hole fixture only dropped ${prof.bad}/${prof.tested} capsules, worst `
    + `${prof.worst.toFixed(2)}m - if it does not fail THE WALK-ON-IT GATE, that gate is blind`);
  // eslint-disable-next-line no-console
  console.log(`[walk-on-it negative] full-cell hole: ${prof.bad}/${prof.tested} walks fell, `
    + `worst ${prof.worst.toFixed(2)}m`);
});

/* ---------- PROPERTY 5: a player cannot escape onto the canopy ---------- */

/**
 * `escapeHeight`'s question, sharpened: not how high the capsule ever gets
 * outside the shaft's footprint (mid-hop it is briefly high and falling), but
 * how high it ever comes to REST out there. Landing on a hedge top is the
 * exploit; sailing over one and falling into the corridor is not.
 */
/**
 * Heights (above the shaft's own floor) at which coming to rest outside the
 * shaft is an exploit. Below `STEP_HEIGHT` there is nothing out there to
 * stand on - the capsule is mid-fall into the corridor. At `LEVEL_HEIGHT` it
 * has arrived on level N+1, which is the entire point of the stair; the
 * 0.25 m of slack under that bar is capsule-resolve tolerance on that floor,
 * and it is nowhere near `HEDGE_HEIGHT` (5.0 m), the height this band exists
 * to forbid.
 */
function inCanopyBand(h) {
  return h > MAZE.STEP_HEIGHT && h < MAZE.LEVEL_HEIGHT - 0.25;
}

function groundedEscapeHeights(descs, shaft) {
  const p = worldOf(descs);
  const pos = new THREE.Vector3();
  const heights = [];
  for (const launch of launchPoints(descs, shaft)) {
    for (let a = 0; a < 32; a++) {
      const ang = (a / 32) * Math.PI * 2;
      pos.set(launch.x, launch.y + 0.05, launch.z);
      const vx = Math.cos(ang) * SPRINT, vz = Math.sin(ang) * SPRINT;
      let grounded = true;
      let vy = 0;
      for (let s = 0; s < 200; s++) {
        pos.x += vx * STEP; pos.z += vz * STEP;
        if (s % 20 === 0 && grounded) vy = HOP_VELOCITY;
        vy -= GRAVITY * STEP;
        pos.y += vy * STEP;
        const res = p.resolveCapsule(pos, RADIUS, HEIGHT);
        grounded = res.grounded;
        if (grounded && vy < 0) vy = 0;
        const outside = Math.abs(pos.x - shaft.cx) > MAZE.CELL / 2
                     || Math.abs(pos.z - shaft.cz) > MAZE.CELL / 2;
        if (outside && grounded) heights.push(pos.y - shaft.floorY);
      }
    }
  }
  return heights;
}

test("THE CANOPY GATE: nothing inside a real shaft lets a player come to rest on level N's hedge tops", () => {
  // The maze's central guarantee. A capsule that leaves the shaft below
  // ENTRY_SEAL_FROM has nothing out there to stand on and falls into the
  // corridor; one that leaves at or above LEVEL_HEIGHT has arrived on level
  // N+1, which is the point of the stair. Coming to rest anywhere between -
  // on a HEDGE_HEIGHT hedge top - is the exploit.
  let checked = 0;
  for (const seed of [1, 42, 2026]) {
    const { t, dx, dz, cell } = firstShaft(seed);
    // Both levels resident - the configuration the player is ever actually
    // in. Level N+1's own hedges are what stand on top of this shaft's walls.
    const descs = [...districtColliders(t.cells, dx, dz, 0), ...districtColliders(t.cells, dx, dz, 1)];
    const w = cellToWorld(cell.x, cell.z, 0);
    const inBand = groundedEscapeHeights(descs, { cx: w.x, cz: w.z, floorY: w.y })
      .filter(inCanopyBand);
    assert.equal(inBand.length, 0,
      `seed ${seed} shaft ${cell.x},${cell.z}: a capsule came to rest outside the shaft at `
      + `${Math.max(...inBand, 0).toFixed(2)}m - on top of the maze`);
    checked++;
  }
  assert.ok(checked > 0, 'no shafts swept');
  // eslint-disable-next-line no-console
  console.log(`[canopy] ${checked} real shafts swept, 0 grounded escapes in `
    + `(${MAZE.STEP_HEIGHT}m, ${MAZE.LEVEL_HEIGHT}m)`);
});

test('the canopy gate is not vacuous: walls only as tall as a hedge let the climber onto the canopy', () => {
  // The bug the whole enclosure rule exists for: a staircase climbing a full
  // level inside HEDGE_HEIGHT walls. `isEnclosureSound` rejects it on paper
  // (test 6); this proves the simulated half catches it too.
  const { t, dx, dz, cell } = firstShaft(2026);
  const w = cellToWorld(cell.x, cell.z, 0);
  const half = MAZE.CELL / 2;
  const capped = districtColliders(t.cells, dx, dz, 0).map((d) => {
    // Ordinary hedges AND the shaft's own walls ('shaftWall' - see
    // MazeColliders.shaftColliders) both need capping here: the bug this
    // simulates is every wall round the shaft topping out at hedge height,
    // not just the ones tagged 'hedge'.
    if (d.kind !== 'hedge' && d.kind !== 'shaftWall') return d;
    if (Math.abs(d.cx - w.x) > half + 1e-6 || Math.abs(d.cz - w.z) > half + 1e-6) return d;
    const top = d.cy + d.hy, bottom = d.cy - d.hy;
    if (top <= w.y + MAZE.HEDGE_HEIGHT + 1e-6) return d;
    const newTop = w.y + MAZE.HEDGE_HEIGHT;
    if (newTop <= bottom) return null;
    return { ...d, cy: (bottom + newTop) / 2, hy: (newTop - bottom) / 2 };
  }).filter(Boolean);
  const inBand = groundedEscapeHeights(capped, { cx: w.x, cz: w.z, floorY: w.y })
    .filter(inCanopyBand);
  assert.ok(inBand.length > 0,
    'a shaft walled only to HEDGE_HEIGHT did not let a capsule rest on the canopy - '
    + 'if this passes, THE CANOPY GATE cannot detect the exploit it exists for');
  // eslint-disable-next-line no-console
  console.log(`[canopy negative] hedge-height walls: ${inBand.length} grounded escapes, `
    + `highest ${Math.max(...inBand).toFixed(2)}m`);
});

/* ---------- PROPERTY 6: a shaft's OWN geometry stops at the level it serves --- */

test('shaftColliders itself never emits anything above its own floor + LEVEL_HEIGHT (guard walls are level N+1\'s own geometry, not this)', () => {
  // Fix round 3's rule, kept as an assertion rather than a comment: above
  // that height the cell simply IS a level N+1 cell, and level N+1's own
  // topology governs it. A shaft reaching higher walled off corridors level
  // N+1 had deliberately carved, severing up to 397 of 399 cells.
  //
  // Scoped deliberately to `shaftColliders`'s own output, not everything a
  // shaft causes to exist. The guard rails round the hole in level N+1's
  // floor (the three railed sides plus the landing lip) sit at
  // `floorY(level+1) + HEDGE_HEIGHT` = `floorY(level) + LEVEL_HEIGHT +
  // HEDGE_HEIGHT` - genuinely above this bound - but they are emitted by
  // `districtColliders`'s hole-punching branch as level N+1's own hedge-height
  // fence, not by this function. A title or check that swept them in here too
  // could be "fixed" in the future by relocating an emitter rather than by
  // changing behaviour, which is exactly the failure mode a regression test
  // must not have. What this actually guarantees: the stairs, the landing and
  // the shaft's own enclosing walls - everything `shaftColliders` itself
  // draws - stay within the level they climb.
  let checked = 0;
  for (const seed of [1, 42, 2026]) {
    const { t, cell } = firstShaft(seed);
    for (const level of [0, 1]) {
      const w = cellToWorld(cell.x, cell.z, level);
      for (const d of shaftColliders(t.cells, cell.x, cell.z, level)) {
        assert.ok(d.cy + d.hy <= w.y + MAZE.LEVEL_HEIGHT + 1e-6,
          `a shaft at level ${level} emitted a ${d.kind} topping out at `
          + `${(d.cy + d.hy - w.y).toFixed(2)}m above its own floor, past LEVEL_HEIGHT`);
        checked++;
      }
    }
  }
  assert.ok(checked > 0, 'no shaft descriptors checked');
  // eslint-disable-next-line no-console
  console.log(`[cap] ${checked} shaft descriptors, none above LEVEL_HEIGHT`);
});

test('the cap check is not vacuous: a shaft whose walls run a hedge higher is caught', () => {
  // Fix round 3's bug, rebuilt: walls to LEVEL_HEIGHT + HEDGE_HEIGHT, which
  // is what sealed a climber into a 6x6 m box at level N+1.
  const { t, cell } = firstShaft(2026);
  const w = cellToWorld(cell.x, cell.z, 0);
  const raised = shaftColliders(t.cells, cell.x, cell.z, 0).map((d) => {
    // The shaft's own walls are tagged 'shaftWall', not 'hedge' - see
    // MazeColliders.shaftColliders.
    if (d.kind !== 'shaftWall') return d;
    const bottom = d.cy - d.hy;
    const top = w.y + MAZE.LEVEL_HEIGHT + MAZE.HEDGE_HEIGHT;
    return { ...d, cy: (bottom + top) / 2, hy: (top - bottom) / 2 };
  });
  const over = raised.filter((d) => d.cy + d.hy > w.y + MAZE.LEVEL_HEIGHT + 1e-6);
  assert.ok(over.length > 0,
    'raising a shaft\'s walls past LEVEL_HEIGHT produced nothing the cap check would reject - '
    + 'if this passes, that check cannot detect fix round 3\'s bug');
});
