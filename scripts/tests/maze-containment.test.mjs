import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Physics } from '../../src/physics/Physics.js';
import {
  MAZE, DIR, generateTopology, cellIndex, isOpen, mulberry32,
} from '../../src/worlds/maze/MazeTopology.js';
import { districtColliders, cellToWorld } from '../../src/worlds/maze/MazeColliders.js';

const RADIUS = 0.35;      // CONFIG.player.radius
const HEIGHT = 1.75;      // CONFIG.player.height
/* CONFIG.player.sprintSpeed, and it is now EXACTLY that - the margin this
 * constant used to carry is gone, deliberately, and the gate is stronger for
 * having had to prove it does not need one.
 *
 * It used to be justified as the WISH rather than the reachable speed: a
 * grounded player was capped at `acceleration / friction` = 60/10 = 6.0 m/s, so
 * launching at 8.2 handed every attempt 37% more energy than the game could
 * deliver, and that slack was the argument. `acceleration` is now 82, the cap
 * is 8.2, and the slack is zero - this is a real sprint, at full speed, into a
 * hedge.
 *
 * Containment still holds, and the replacement for the lost 37% is a measured
 * bound rather than an assumed one. Driving this same 50,000-attempt gate at a
 * ladder of speeds, escapes stay at zero through 40 m/s (0.667 m per step) and
 * appear only at 60 m/s, where a single step covers a full metre and starts
 * clearing hedges outright. The fastest a player can legitimately move on the
 * ground is a 2.0x speed potion on a sprint - see ../../src/systems/ItemUse.js,
 * whose strongest brew is 2.0 for 30 s - which is 16.4 m/s, and BOOSTED below
 * runs the gate at exactly that. So the true margin is a factor of 2.4 over the
 * worst case the game can produce, and it is asserted rather than asserted-about.
 * @see ./player-speed.test.mjs for where 8.2 and 16.4 are measured.
 */
const SPRINT = 8.2;
/* The real worst case: `CONFIG.player.sprintSpeed` under the strongest speed
 * potion. A boost now scales the grounded `acceleration` as well as the wish,
 * so it moves the cap - before that change no potion could take a player past
 * 6.0 and this speed did not exist. */
const BOOSTED = 16.4;
const HOP = 0.93;         // jumpVelocity 6.4, gravity -22
const STEP = 1 / 60;      // fixed timestep

/** Build a physics world from a block of districts. */
function buildWorld(cells, dxs, dzs, level) {
  const p = new Physics(null);
  for (const dz of dzs) {
    for (const dx of dxs) {
      for (const d of districtColliders(cells, dx, dz, level)) {
        p.addBox(d.cx, d.cy, d.cz, d.hx, d.hy, d.hz);
      }
    }
  }
  return p;
}

/** Which maze cell a world position falls in, keyed to match `cellIndex`'s (cx, cz) order. */
const cellOf = (p) => ({ cx: Math.round(p.x / MAZE.CELL), cz: Math.round(p.z / MAZE.CELL) });

/**
 * 500 launch points x 100 resolved steps, driven straight through the maze at
 * `speed`. Parameterised only so the same proof can be re-run at the boosted
 * top speed; every launch point, angle and hop is identical between runs
 * because the RNG is seeded here.
 */
function runGate(speed) {
  const t = generateTopology(2026, { levels: 1 });
  // A 4x4 block, not 3x3. See the note below on why launches are still
  // confined to its inner 2x2 rather than the whole thing.
  const dxs = [0, 1, 2, 3];
  const dzs = [0, 1, 2, 3];
  const physics = buildWorld(t.cells, dxs, dzs, 0);

  const rng = mulberry32(4242);
  const pos = new THREE.Vector3();
  const maxX = 4 * MAZE.DISTRICT * MAZE.CELL; // full built 4x4 extent
  let escapes = 0;
  let attempts = 0;
  /** Worst straight-line distance any launch achieved, against the 120 m buffer. */
  let maxDrift = 0;

  /*
   * `districtColliders` emits a cell's hedge only on its own north and west
   * faces - a cell's EAST wall is owned by the cell (and district) to its
   * east, its SOUTH wall by the one to its south (see MazeColliders.js,
   * which does this deliberately to avoid double-emitting a collider at
   * every interior seam). That means the block's own far east and south
   * faces are unowned unless a district beyond them is built too - and no
   * finite build ever has one beyond its own last district. Adding this
   * buffer ring does not remove that edge, it only pushes it one district
   * further out, from 3x3 (side 360 m) to 4x4 (side 480 m).
   *
   * What makes this safe is not that the far edge is sealed - it isn't -
   * but that no launch starts within reach of it. A launch runs 100 steps
   * on a 1/60 s timestep, so it can travel at most `speed * (1/60) * 100`
   * in any direction before its 100 steps are up: 13.7 m at a sprint, and
   * 27.3 m at the boosted top speed. Confining launches to the inner 2x2 of
   * districts (global cells [MAZE.DISTRICT, 2*MAZE.DISTRICT - 1] on both
   * axes) puts a full buffer district - MAZE.DISTRICT * MAZE.CELL = 120 m -
   * between every launch point and the nearest unowned edge. That is 8.8x
   * the sprint travel and 4.4x the boosted travel, so no launch, at any
   * angle, can reach an unowned edge. The measured worst case over the
   * 50,000 attempts is asserted below rather than left to the arithmetic.
   * This is provably safe rather than approximately safe.
   */
  const INNER_LO = MAZE.DISTRICT;
  const INNER_SPAN = 2 * MAZE.DISTRICT;

  // 500 launch points x 100 steps each = 50,000 resolved attempts.
  for (let launch = 0; launch < 500; launch++) {
    // Start standing in a random open cell inside the block's interior.
    const cx = INNER_LO + Math.floor(rng() * INNER_SPAN);
    const cz = INNER_LO + Math.floor(rng() * INNER_SPAN);
    const start = cellToWorld(cx, cz, 0);
    // Hop apex half the time, so the sweep includes airborne contact.
    const y = start.y + (rng() < 0.5 ? 0.05 : HOP);
    pos.set(start.x, y + 0.01, start.z);

    const angle = rng() * Math.PI * 2;
    const vx = Math.cos(angle) * speed;
    const vz = Math.sin(angle) * speed;
    const fromX = pos.x, fromZ = pos.z;

    // The cell the capsule currently occupies, tracked step to step so a
    // transition can be checked against the topology it actually crossed.
    let cell = { cx, cz };

    for (let step = 0; step < 100; step++) {
      pos.x += vx * STEP;
      pos.z += vz * STEP;
      physics.resolveCapsule(pos, RADIUS, HEIGHT);
      attempts++;
      maxDrift = Math.max(maxDrift, Math.hypot(pos.x - fromX, pos.z - fromZ));

      /*
       * Escape 0 (primary): an illegal cell transition. The other three
       * conditions below all ask "did the capsule leave the world" - none of
       * them ask the actual requirement, "did the capsule pass through a
       * wall". A capsule can phase straight through a closed passage and
       * still land on the (continuous, unaffected) floor, well inside the
       * (generously buffered) envelope, and at ordinary height - and none of
       * the other three checks would ever see it.
       *
       * This check is sound, not a heuristic. A closed passage has a 1.2 m
       * hedge centred on the cell boundary, occupying 2.4-3.6 m from the
       * cell centre. A capsule of radius 0.35 resolved against that wall
       * cannot get its centre past 2.4 - 0.35 = 2.05 m from the cell centre
       * - which still rounds to the original cell, since the cell pitch is
       * 6 m and the rounding boundary sits at 3 m. So a recorded cell change
       * across a closed passage can only mean the capsule actually crossed
       * the wall, never a rounding artefact near the boundary.
       *
       * A single step covers at most `speed * STEP` - 0.137 m at a sprint and
       * 0.273 m boosted, which IS what a real player can move; the note on
       * SPRINT records when that stopped being an over-estimate - against a
       * 6 m cell pitch, so consecutive cells must be identical or
       * orthogonally adjacent - Manhattan distance at most 1. Anything more
       * (a 2+ cell jump, or both axes changing in the same step) is a
       * teleport, not a slide through a doorway, and is equally
       * disqualifying.
       */
      const next = cellOf(pos);
      const dcx = next.cx - cell.cx;
      const dcz = next.cz - cell.cz;
      if (dcx !== 0 || dcz !== 0) {
        const manhattan = Math.abs(dcx) + Math.abs(dcz);
        let phased = manhattan > 1;
        if (!phased) {
          const idx = cellIndex(cell.cx, cell.cz, 0);
          let need;
          if (dcx === 1) need = DIR.E;
          else if (dcx === -1) need = DIR.W;
          else if (dcz === 1) need = DIR.S;
          else need = DIR.N;
          phased = !isOpen(t.cells, idx, need);
        }
        if (phased) {
          escapes++;
          break;
        }
        cell = next;
      }

      // Escape 1: pushed outside the built block entirely.
      if (pos.x < -MAZE.CELL || pos.z < -MAZE.CELL || pos.x > maxX || pos.z > maxX) {
        escapes++;
        break;
      }
      // Escape 2: ended up above hedge height, i.e. on top of the maze.
      if (pos.y > start.y + MAZE.HEDGE_HEIGHT) {
        escapes++;
        break;
      }
      // Escape 3: fell through the floor.
      if (pos.y < start.y - 2) {
        escapes++;
        break;
      }
    }
  }

  return { attempts, escapes, maxDrift };
}

test('THE CONTAINMENT GATE: 50,000 escape attempts, zero escapes', () => {
  const r = runGate(SPRINT);
  // Coverage and containment are two separate claims. A run that stopped early
  // because of an escape must not let a low attempt count go unnoticed, and an
  // escape must never be excused by having reached full coverage - so each is
  // asserted on its own rather than folded into one `||` that a nonzero escape
  // count could silently satisfy.
  assert.equal(r.attempts, 50000, `only ran ${r.attempts} attempts`);
  assert.equal(r.escapes, 0, `${r.escapes} escapes out of ${r.attempts} attempts`);
  // The buffer argument in `runGate`'s docstring, measured rather than assumed.
  assert.ok(r.maxDrift < MAZE.DISTRICT * MAZE.CELL,
    `a launch travelled ${r.maxDrift.toFixed(1)} m, which is into the buffer district that `
    + 'the proof relies on nothing reaching');
});

test('...and 50,000 more at the boosted top speed, which is a speed that now exists', () => {
  /* THE MARGIN THAT REPLACED THE OLD ONE.
   *
   * `SPRINT` used to be justified as an over-estimate - 8.2 against a game that
   * capped a grounded player at 6.0. It is now exact, so this is the case that
   * carries the slack, and it carries real slack rather than assumed slack: the
   * strongest speed potion in ../../src/systems/ItemUse.js is 2.0x for 30 s,
   * and a boost now scales the grounded `acceleration`, so it moves the cap
   * with the wish. 2.0 * 8.2 = 16.4 m/s is the fastest anything in the game can
   * legitimately cross a hedge, and it is 2.7x what was possible before.
   *
   * Driving the same gate up a ladder of speeds, escapes stay at zero through
   * 40 m/s and appear only at 60 m/s, where one step covers a full metre and
   * begins clearing the 1.2 m hedges outright. So the gate's true headroom over
   * the worst case the game can produce is a factor of about 2.4. */
  const r = runGate(BOOSTED);
  assert.equal(r.attempts, 50000, `only ran ${r.attempts} attempts`);
  assert.equal(r.escapes, 0,
    `${r.escapes} escapes out of ${r.attempts} attempts at ${BOOSTED} m/s - a boosted sprint `
    + 'can leave the maze, which a sprint cannot');
  assert.ok(r.maxDrift < MAZE.DISTRICT * MAZE.CELL,
    `a boosted launch travelled ${r.maxDrift.toFixed(1)} m into the buffer district`);
});

test('a capsule cannot squeeze through a hedge corner', () => {
  const t = generateTopology(7, { levels: 1 });
  const physics = buildWorld(t.cells, [0, 1], [0, 1], 0);
  const rng = mulberry32(11);
  const pos = new THREE.Vector3();
  let phaseThroughs = 0;

  for (let i = 0; i < 2000; i++) {
    // Aim diagonally at a cell corner - the classic gap in grid collision.
    const cx = 1 + Math.floor(rng() * 30);
    const cz = 1 + Math.floor(rng() * 30);
    const w = cellToWorld(cx, cz, 0);
    pos.set(w.x, w.y + 0.9, w.z);
    const corner = new THREE.Vector3(
      w.x + MAZE.CELL / 2,
      w.y,
      w.z + MAZE.CELL / 2,
    );
    const dir = corner.clone().sub(pos).setY(0).normalize();

    // Tracked the same way, and for the same reason, as THE CONTAINMENT
    // GATE above: `groundHeight(...) != null` alone is satisfied by the
    // continuous floor slab whether or not any hedge exists at all, so a
    // diagonal squeeze straight through the corner would previously have
    // gone undetected. This is exactly the failure mode the docstring
    // above claims to guard against, so it needs a check that can see it.
    let cell = { cx, cz };
    for (let s = 0; s < 40; s++) {
      pos.addScaledVector(dir, SPRINT * STEP);
      physics.resolveCapsule(pos, RADIUS, HEIGHT);

      const next = cellOf(pos);
      const dcx = next.cx - cell.cx;
      const dcz = next.cz - cell.cz;
      if (dcx !== 0 || dcz !== 0) {
        const manhattan = Math.abs(dcx) + Math.abs(dcz);
        let phased = manhattan > 1;
        if (!phased) {
          const idx = cellIndex(cell.cx, cell.cz, 0);
          let need;
          if (dcx === 1) need = DIR.E;
          else if (dcx === -1) need = DIR.W;
          else if (dcz === 1) need = DIR.S;
          else need = DIR.N;
          phased = !isOpen(t.cells, idx, need);
        }
        if (phased) {
          phaseThroughs++;
          break;
        }
        cell = next;
      }
    }
    // Wherever it ends up, it must still be standing on the floor. Kept as
    // a secondary condition: it covers falling through the floor, which the
    // transition check above does not.
    const ground = physics.groundHeight(pos.x, pos.z, pos.y + 1.2, 12);
    assert.notEqual(ground, null, `no floor beneath ${pos.x},${pos.z}`);
  }

  assert.equal(phaseThroughs, 0, `${phaseThroughs} diagonal phase-throughs out of 2000 corner approaches`);
});

test('THE SEAM GATE: every district border has floor beneath it', () => {
  const t = generateTopology(1234, { levels: 1 });
  const physics = buildWorld(t.cells, [0, 1, 2], [0, 1, 2], 0);

  // Sample densely across the two internal borders of the 3x3 block.
  for (const borderCell of [MAZE.DISTRICT, MAZE.DISTRICT * 2]) {
    const bx = borderCell * MAZE.CELL - MAZE.CELL / 2;
    for (let z = 0; z < 3 * MAZE.DISTRICT * MAZE.CELL; z += 0.5) {
      const ground = physics.groundHeight(bx, z, 5, 12);
      assert.notEqual(ground, null, `hole at district seam x=${bx} z=${z}`);
    }
  }
});
