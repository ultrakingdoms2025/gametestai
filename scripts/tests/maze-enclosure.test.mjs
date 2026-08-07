import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Physics } from '../../src/physics/Physics.js';
import { MAZE, generateTopology } from '../../src/worlds/maze/MazeTopology.js';
import { isEnclosureSound, districtColliders, cellToWorld } from '../../src/worlds/maze/MazeColliders.js';

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

/** Every `enclosed` descriptor in `descs`, grouped by the cell it sits in. */
function groupEnclosedByShaft(descs) {
  const groups = new Map();
  for (const d of descs) {
    if (!d.enclosed) continue;
    const gx = Math.round(d.cx / MAZE.CELL);
    const gz = Math.round(d.cz / MAZE.CELL);
    const key = `${gx},${gz}`;
    if (!groups.has(key)) {
      groups.set(key, { key, shaft: { cx: gx * MAZE.CELL, cz: gz * MAZE.CELL, floorY: 0 } });
    }
  }
  return [...groups.values()];
}

test('every enclosed descriptor emitted by real generation sits in a proven shaft', () => {
  // Nothing in generation emits `enclosed` yet - real staircases are a later
  // task, not this one - so this runs zero real assertions today. It exists
  // now, before the first staircase, so that the day generation starts
  // emitting `enclosed` descriptors this test starts checking every one of
  // them automatically, rather than the exemption being self-certifying
  // (see the companion test below, which proves this check is not vacuous).
  let shaftsChecked = 0;
  for (const seed of [11, 47, 103]) {
    const t = generateTopology(seed, { levels: 1 });
    for (let dz = 4; dz < 6; dz++) {
      for (let dx = 4; dx < 6; dx++) {
        const descs = districtColliders(t.cells, dx, dz, 0);
        for (const g of groupEnclosedByShaft(descs)) {
          shaftsChecked++;
          assert.equal(isEnclosureSound(descs, g.shaft), true,
            `seed ${seed} district (${dx},${dz}) shaft ${g.key} is not a proven enclosure`);
        }
      }
    }
  }
  assert.equal(shaftsChecked, 0,
    'generation now emits `enclosed` descriptors - the loop above is no longer vacuous, ' +
    'so this line should be deleted rather than kept passing');
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
  const groups = groupEnclosedByShaft(rigged);
  assert.ok(groups.length > 0, 'expected the injected descriptor to be grouped into a shaft');
  for (const g of groups) {
    assert.equal(isEnclosureSound(rigged, g.shaft), false,
      `expected the rigged shaft at ${g.key} to be reported unsound - ` +
      'if this passes, the bound-to-exemption check is vacuous');
  }
});
