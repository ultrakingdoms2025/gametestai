/**
 * Phase 2c Task 4 - PROVE A LIFT LANDING CAN EXIST, before building one.
 *
 * This file ships a decision, not geometry. Nothing in `src/` changes because
 * of it; `MazeShafts.js` still falls back to a staircase for every lift link.
 *
 * Why it exists. Phase 2b's Task 3 spent four fix rounds on the staircase,
 * and each round's fix created the next round's Critical. The eventual root
 * cause was that the geometry it started from could not satisfy its
 * constraints AT ALL - a 1.90 m spiral needed a hole nearly the size of the
 * cell, so "climb through the floor", "do not sever the corridors" and "do
 * not leave a pit" were mutually unsatisfiable. Three rounds of patching
 * could not find that. Round 4 found it in one, by being handed every
 * constraint at once with licence to redesign.
 *
 * The lift has a problem of the same class, and a sharper one:
 *
 *   A LIFT SHAFT WITH THE CAR AT THE BOTTOM IS A NINE-METRE HOLE IN LEVEL
 *   N+1's FLOOR.
 *
 * The staircase's opening is safe because there are treads under every point
 * of it - THE WALK-ON-IT GATE measures a worst-case walk-off drop of 0.758 m.
 * Under a lift's opening, car down, there is nothing for a whole level.
 *
 * Seven properties, all of which must hold at once. A candidate that passes
 * six is not a near miss; it is a rejected candidate.
 *
 *   1. WALK IN     from every level-N corridor side the shaft opens onto.
 *   2. RIDE        a capsule on the car is carried floor to landing.
 *   3. WALK AWAY   level N+1 stays traversable across the shaft cell.
 *   4. NO FALL IN  walk-offs at level N+1, CAR AT THE BOTTOM, worst drop
 *                  under the same bar the stair is held to.
 *   5. NO ESCAPE   grounded rest heights outside the shaft never reach a
 *                  canopy (5.0 m at level N, 14.0 m at level N+1).
 *   6. THE CAP     nothing emitted tops out above floorN + LEVEL_HEIGHT.
 *   7. NO LADDER   no collider top, at ANY point in any moving part's travel,
 *                  sits in the 0.45-5.0 m band outside the sealed shaft.
 *
 * Property 4 is what rejects the obvious arrangement. Property 7 is what
 * rejects the obvious fix for property 4.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Physics } from '../../src/physics/Physics.js';
import { MAZE, DIR } from '../../src/worlds/maze/MazeTopology.js';
import {
  stairWellBounds, STAIR_WELL_HALF, ENTRY_SEAL_FROM, stairColliders, descriptorTop,
} from '../../src/worlds/maze/MazeShafts.js';

const RADIUS = 0.35, HEIGHT = 1.75;
const DT = 1 / 60, GRAVITY = 22, WALK_SPEED = 4.2, STEP_H = MAZE.STEP_HEIGHT;
const WALK_OFF_DIST = 1.2;

/* The shaft under test: cell (0,0) at level 0, so its floor is y=0, its cell
 * centre is the world origin, and level 1's floor slab is at y 8..9. */
const CELL_HALF = MAZE.CELL / 2;
const WELL = stairWellBounds(0, 0, 0);
const LANDING_Y = MAZE.LEVEL_HEIGHT;

/* Car geometry. Derived, not written down: the rest clearance is a fraction
 * of the auto-step so the car is always something you WALK onto rather than
 * hop onto, and both of this project's shaft constants have been wrong when
 * written as literals. */
const CAR_HALF = STAIR_WELL_HALF - 0.05;
const CAR_HALF_THICK = 0.15;
const CAR_REST_CLEARANCE = MAZE.STEP_HEIGHT * (2 / 3);   // 0.30 m

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
      if (Math.hypot(pos.x - bx, pos.z - bz) > moved + 1e-4
        && pos.y <= by + STEP_H + 1e-3) res = r2;
      else { pos.set(sx, sy, sz); res = { grounded: sg }; }
    }
    if (res.grounded) vy = 0; else vy -= GRAVITY * DT;
    return { grounded: res.grounded };
  };
}

function worldOf(descs) {
  const p = new Physics(null);
  for (const d of descs) p.addBox(d.cx, d.cy, d.cz, d.hx, d.hy, d.hz);
  return p;
}

/** The bar THE WALK-ON-IT GATE holds the staircase to, recomputed here. */
function stairWalkOffBar() {
  const treads = stairColliders(new Uint8Array(1).fill(DIR.UP), 0, 0, 0)
    .filter((d) => d.kind === 'stair').sort((a, b) => a.cy - b.cy);
  let pitch = Infinity, rise = 0;
  for (let i = 1; i < treads.length; i++) {
    pitch = Math.min(pitch, Math.hypot(treads[i].cx - treads[i - 1].cx, treads[i].cz - treads[i - 1].cz));
    rise = Math.max(rise, (treads[i].cy + treads[i].hy) - (treads[i - 1].cy + treads[i - 1].hy));
  }
  return Math.ceil(WALK_OFF_DIST / pitch) * rise + 0.02;
}

/* ------------------------------------------------------------------ */
/* Shared shaft shell - identical for every candidate                  */
/* ------------------------------------------------------------------ */

/**
 * The parts no candidate varies: the shaft's four walls at level N, level
 * N+1's floor slab perforated by the well, and level N's own floor.
 *
 * `open` lists which sides of the level-N cell are corridor openings, exactly
 * as `stairColliders` treats them - sealed from ENTRY_SEAL_FROM upward,
 * doorway below.
 */
function shell({ open = [DIR.S], railSides = ['n', 'w', 'e'] } = {}) {
  const out = [];
  const H = MAZE.LEVEL_HEIGHT;

  // Level N floor.
  out.push({ cx: 0, cy: -0.5, cz: 0, hx: MAZE.CELL, hy: 0.5, hz: MAZE.CELL, kind: 'floor' });

  // The shaft's four walls.
  const sides = [
    { dir: DIR.N, dx: 0, dz: -1 }, { dir: DIR.E, dx: 1, dz: 0 },
    { dir: DIR.S, dx: 0, dz: 1 }, { dir: DIR.W, dx: -1, dz: 0 },
  ];
  for (const s of sides) {
    const isOpenSide = open.includes(s.dir);
    const baseY = isOpenSide ? ENTRY_SEAL_FROM : 0;
    out.push({
      cx: s.dx * CELL_HALF, cy: (baseY + H) / 2, cz: s.dz * CELL_HALF,
      hx: s.dx ? 0.6 : CELL_HALF, hy: (H - baseY) / 2, hz: s.dz ? 0.6 : CELL_HALF,
      kind: 'shaftWall',
    });
  }

  // Level N+1's floor, tiled around the well exactly as districtColliders does.
  const f0 = -CELL_HALF - MAZE.CELL, f1 = CELL_HALF + MAZE.CELL;
  const slab = (x0, x1, z0, z1) => out.push({
    cx: (x0 + x1) / 2, cy: LANDING_Y - 0.5, cz: (z0 + z1) / 2,
    hx: (x1 - x0) / 2, hy: 0.5, hz: (z1 - z0) / 2, kind: 'floor',
  });
  slab(f0, WELL.x0, f0, f1);
  slab(WELL.x1, f1, f0, f1);
  slab(WELL.x0, WELL.x1, f0, WELL.z0);
  slab(WELL.x0, WELL.x1, WELL.z1, f1);

  // Guard rails round the opening at level N+1, on the named sides.
  const T = 0.2, railTop = LANDING_Y + MAZE.HEDGE_HEIGHT;
  const rail = (x0, x1, z0, z1) => out.push({
    cx: (x0 + x1) / 2, cy: (LANDING_Y + railTop) / 2, cz: (z0 + z1) / 2,
    hx: (x1 - x0) / 2, hy: (railTop - LANDING_Y) / 2, hz: (z1 - z0) / 2, kind: 'hedge',
  });
  if (railSides.includes('n')) rail(WELL.x0 - T, WELL.x1 + T, WELL.z0 - T, WELL.z0);
  if (railSides.includes('s')) rail(WELL.x0 - T, WELL.x1 + T, WELL.z1, WELL.z1 + T);
  if (railSides.includes('w')) rail(WELL.x0 - T, WELL.x0, WELL.z0 - T, WELL.z1 + T);
  if (railSides.includes('e')) rail(WELL.x1, WELL.x1 + T, WELL.z0 - T, WELL.z1 + T);

  return out;
}

/** The car, as a swept descriptor, resting at `at` ('down' | 'up'). */
function car(at = 'down') {
  const downTop = CAR_REST_CLEARANCE;
  const topTop = LANDING_Y;
  const restTop = at === 'up' ? topTop : downTop;
  return {
    cx: WELL.cx, cy: restTop - CAR_HALF_THICK, cz: WELL.cz,
    hx: CAR_HALF, hy: CAR_HALF_THICK, hz: CAR_HALF,
    kind: 'lift', enclosed: true,
    swept: { y0: downTop - 2 * CAR_HALF_THICK, y1: topTop },
  };
}

/* ------------------------------------------------------------------ */
/* Candidates                                                          */
/* ------------------------------------------------------------------ */

/**
 * CANDIDATE 1 - car is the landing, three rails, entry side open.
 *
 * The arrangement anyone would write first, and the direct analogue of the
 * staircase's: rail three sides of the opening, leave the fourth as the way
 * on. With the car up you step onto it; with the car down you step into a
 * nine-metre hole.
 */
function candidate1(at = 'down') {
  return [...shell({ railSides: ['n', 'w', 'e'] }), car(at)];
}

/**
 * CANDIDATE 2 - a landing door on the entry side.
 *
 * The same opening, but the fourth side carries a collider driven the way the
 * car is: recessed below the auto-step when the car is present, standing at
 * level N+1's own hedge height when it is not. `doorOpen` says which.
 *
 * The hazard this has to answer is property 7. A door in motion presents a
 * standable top sweeping the whole band OUTSIDE the shaft, on level N+1's
 * floor - and above `ENTRY_SEAL_FROM` a player standing on it could hop a
 * level-N+1 hedge. "It moves quickly" is not a proof.
 */
function candidate2(at = 'down', doorOpen = false) {
  const T = 0.2;
  const closedTop = LANDING_Y + MAZE.HEDGE_HEIGHT;
  const openTop = LANDING_Y + MAZE.STEP_HEIGHT * 0.5;   // walk-over-able
  const top = doorOpen ? openTop : closedTop;
  const door = {
    cx: (WELL.x0 - T + WELL.x1 + T) / 2, cy: (LANDING_Y + top) / 2, cz: (WELL.z1 + WELL.z1 + T) / 2,
    hx: (WELL.x1 + T - (WELL.x0 - T)) / 2, hy: (top - LANDING_Y) / 2, hz: T / 2,
    kind: 'liftDoor',
    /* The door's own travel, declared for the same reason the car's is. */
    swept: { y0: LANDING_Y, y1: closedTop },
  };
  return [...shell({ railSides: ['n', 'w', 'e'] }), car(at), door];
}

/* ------------------------------------------------------------------ */
/* The seven properties                                                */
/* ------------------------------------------------------------------ */

/** P4 / P3: walk-off drops measured on level N+1 across the shaft cell. */
function walkOffProfile(descs) {
  const p = worldOf(descs);
  const half = CELL_HALF + 1.0;
  const n = 17;
  let worst = 0, tested = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const sx = -half + (2 * half * i) / (n - 1);
      const sz = -half + (2 * half * j) / (n - 1);
      const g = p.groundHeight(sx, sz, LANDING_Y + 2, 4);
      if (!Number.isFinite(g) || Math.abs(g - LANDING_Y) > 0.05) continue;
      for (let a = 0; a < 16; a++) {
        const ang = (a / 16) * Math.PI * 2;
        const pos = new THREE.Vector3(sx, LANDING_Y + 0.05, sz);
        p.resolveCapsule(pos, RADIUS, HEIGHT);
        if (Math.abs(pos.y - LANDING_Y) > 0.2) continue;
        if (Math.abs(pos.x - sx) > 0.03 || Math.abs(pos.z - sz) > 0.03) continue;
        const frame = makeWalker(p);
        const tx = sx + Math.cos(ang) * WALK_OFF_DIST, tz = sz + Math.sin(ang) * WALK_OFF_DIST;
        for (let s = 0; s < 40; s++) frame(pos, tx, tz);
        for (let s = 0; s < 120; s++) frame(pos, pos.x, pos.z);
        tested++;
        const drop = LANDING_Y - pos.y;
        if (drop > worst) worst = drop;
      }
    }
  }
  return { worst, tested };
}

/** P7: every top any moving part presents, at any point in its travel. */
function ladderViolations(descs) {
  const bad = [];
  for (const d of descs) {
    if (d.enclosed) continue;          // inside the sealed shaft, proven separately
    if (!d.swept) continue;            // still geometry: covered by THE ANTI-LADDER GATE
    /* A moving part outside the shaft presents EVERY top between y0 and y1 at
     * some moment, so the band test has to be applied to the whole interval,
     * not to either endpoint. */
    for (const levelFloor of [0, LANDING_Y]) {
      const lo = d.swept.y0 - levelFloor, hi = d.swept.y1 - levelFloor;
      if (hi > 0.45 && lo < MAZE.HEDGE_HEIGHT) {
        bad.push({ kind: d.kind, lo, hi, levelFloor });
      }
    }
  }
  return bad;
}

test('CANDIDATE 1 fails property 4: with the car down, the landing opening is a nine-metre hole', () => {
  const bar = stairWalkOffBar();
  const { worst, tested } = walkOffProfile(candidate1('down'));
  // eslint-disable-next-line no-console
  console.log(`[lift c1] car down: worst walk-off drop ${worst.toFixed(3)}m over ${tested} walk-offs (stair bar ${bar.toFixed(3)}m)`);
  assert.ok(tested > 200, `expected a dense sweep, ran ${tested}`);
  assert.ok(worst > bar,
    'candidate 1 was expected to FAIL property 4 - if it now passes, the arrangement changed and this ' +
    'file\'s conclusion must be re-derived rather than assumed');
});

test('CANDIDATE 1 passes property 4 with the car UP - which is why the failure above is about the car, not the opening', () => {
  const bar = stairWalkOffBar();
  const { worst } = walkOffProfile(candidate1('up'));
  // eslint-disable-next-line no-console
  console.log(`[lift c1] car up:   worst walk-off drop ${worst.toFixed(3)}m (stair bar ${bar.toFixed(3)}m)`);
  assert.ok(worst <= bar,
    `car up should fill the opening, but the worst drop is ${worst.toFixed(3)}m`);
});

test('CANDIDATE 2 passes property 4 with the car down: the closed door is what makes it safe', () => {
  const bar = stairWalkOffBar();
  const { worst, tested } = walkOffProfile(candidate2('down', false));
  // eslint-disable-next-line no-console
  console.log(`[lift c2] car down, door closed: worst walk-off drop ${worst.toFixed(3)}m over ${tested} walk-offs`);
  assert.ok(worst <= bar,
    `a closed landing door should stop every walk-in, but the worst drop is ${worst.toFixed(3)}m`);
});

test('CANDIDATE 2 fails property 7: the door sweeps a standable top through the band OUTSIDE the shaft', () => {
  const bad = ladderViolations(candidate2('down', false));
  // eslint-disable-next-line no-console
  console.log(`[lift c2] property 7 violations: ${JSON.stringify(bad)}`);
  assert.ok(bad.length > 0,
    'candidate 2 was expected to FAIL property 7 - a door travelling from the floor to hedge height ' +
    'passes through the whole band, and above ENTRY_SEAL_FROM a rider could hop a hedge');
});

test('the car itself raises no property 7 violation: it is enclosed, and the shaft is what proves it', () => {
  const bad = ladderViolations([...shell(), car('down')]);
  assert.deepEqual(bad, [],
    'the car is inside a sealed shaft and carries enclosed:true, so the band exemption applies to it - ' +
    'proven by THE SWEPT ENCLOSURE GATE, not by this file');
});

/* ------------------------------------------------------------------ */
/* CANDIDATE 3 - the door, plus the invariant that makes it safe       */
/* ------------------------------------------------------------------ */

/**
 * Candidate 2's geometry, with one behavioural rule added:
 *
 *   THE DOOR NEVER MOVES WHILE ITS OWN FOOTPRINT IS OCCUPIED.
 *
 * That converts property 7 from a statement about geometry into a statement
 * about reachability, which is what it always meant. A standable top in the
 * band is only a ladder if a player can GET ON IT and RIDE IT UP. If the door
 * halts the instant it is boarded, the highest a rider can ever be is the
 * highest they could board at unaided - `LANDING_Y + HOP + STEP_HEIGHT` -
 * and their reach from there is one more `HOP + STEP_HEIGHT`. Against level
 * N+1's own hedge tops at `LANDING_Y + HEDGE_HEIGHT` that leaves real margin,
 * derived below rather than asserted.
 *
 * It is the same occupancy predicate the crush guard needs for the car, so
 * this is one mechanism serving two properties rather than a special case.
 */
const DOOR_SPEED = 2.0;   // m/s

function doorFootprint() {
  const T = 0.2;
  return { x0: WELL.x0 - T, x1: WELL.x1 + T, z0: WELL.z1, z1: WELL.z1 + T };
}

/** True when the capsule at `pos` is standing on, or inside, the door column. */
function doorOccupied(pos, doorTop) {
  const f = doorFootprint();
  const overlapsXZ = pos.x + RADIUS > f.x0 && pos.x - RADIUS < f.x1
                  && pos.z + RADIUS > f.z0 && pos.z - RADIUS < f.z1;
  if (!overlapsXZ) return false;
  // Standing on it, or with any part of the capsule inside its column.
  return pos.y + HEIGHT > LANDING_Y && pos.y < doorTop + 1e-3;
}

/**
 * Drive a capsule that is actively TRYING to ride the door up, and return the
 * highest it ever gets while grounded outside the shaft.
 */
function maxRideHeight() {
  const closedTop = LANDING_Y + MAZE.HEDGE_HEIGHT;
  const f = doorFootprint();
  let highest = -Infinity;

  // Start beside the door at several offsets, and try to board it at every
  // point in its ascent.
  for (let boardAt = LANDING_Y; boardAt <= closedTop; boardAt += 0.25) {
    let doorTop = LANDING_Y + MAZE.STEP_HEIGHT * 0.5;
    const pos = new THREE.Vector3((f.x0 + f.x1) / 2, LANDING_Y + 0.05, f.z0 - 0.8);

    for (let step = 0; step < 600; step++) {
      // Rebuild the world with the door at its current height. Cheap enough
      // at this fixture's size, and it keeps the door a real collider rather
      // than a special case inside the walker.
      const descs = [...shell({ railSides: ['n', 'w', 'e'] }), car('down'), {
        cx: (f.x0 + f.x1) / 2, cy: (LANDING_Y + doorTop) / 2, cz: (f.z0 + f.z1) / 2,
        hx: (f.x1 - f.x0) / 2, hy: (doorTop - LANDING_Y) / 2, hz: (f.z1 - f.z0) / 2,
        kind: 'liftDoor',
      }];
      const p = worldOf(descs);
      const frame = makeWalker(p);

      // Walk onto the door's footprint once it is low enough to board.
      const target = doorTop <= boardAt + 1e-6
        ? { x: (f.x0 + f.x1) / 2, z: (f.z0 + f.z1) / 2 }
        : { x: pos.x, z: pos.z };
      const r = frame(pos, target.x, target.z);
      if (r.grounded && pos.y > highest) highest = pos.y;

      // THE INVARIANT. The door rises only while unoccupied.
      if (!doorOccupied(pos, doorTop) && doorTop < closedTop) {
        doorTop = Math.min(closedTop, doorTop + DOOR_SPEED * DT);
      }
    }
  }
  return highest;
}

test('CANDIDATE 3 passes property 7: a door that halts when boarded cannot be ridden to a hedge top', () => {
  const highest = maxRideHeight();
  const hedgeTop = LANDING_Y + MAZE.HEDGE_HEIGHT;
  const boardCeiling = LANDING_Y + MAZE.HOP + MAZE.STEP_HEIGHT;
  const reachFromThere = highest + MAZE.HOP + MAZE.STEP_HEIGHT;
  // eslint-disable-next-line no-console
  console.log(`[lift c3] highest grounded ride ${highest.toFixed(3)}m; board ceiling ${boardCeiling.toFixed(3)}m; `
    + `reach from there ${reachFromThere.toFixed(3)}m; level N+1 hedge top ${hedgeTop.toFixed(3)}m`);

  assert.ok(highest <= boardCeiling + 1e-3,
    `a rider reached ${highest.toFixed(3)}m, above the ${boardCeiling.toFixed(3)}m they could board at unaided - `
    + 'the door carried them, so the halt invariant is not holding');
  assert.ok(reachFromThere < hedgeTop,
    `reach from the highest ride is ${reachFromThere.toFixed(3)}m against a hedge top at ${hedgeTop.toFixed(3)}m`);
});

test('the halt invariant is load-bearing: without it the door carries a rider to the hedge top', () => {
  // Same geometry, same rider, but the door ignores occupancy - which is
  // candidate 2. If this ever stops reaching the hedge line, the ride
  // simulation has stopped exercising the thing it exists to exercise.
  const closedTop = LANDING_Y + MAZE.HEDGE_HEIGHT;
  const f = doorFootprint();
  let doorTop = LANDING_Y + MAZE.STEP_HEIGHT * 0.5;
  const pos = new THREE.Vector3((f.x0 + f.x1) / 2, LANDING_Y + 0.05, (f.z0 + f.z1) / 2);
  let highest = -Infinity;
  for (let step = 0; step < 600; step++) {
    const descs = [...shell({ railSides: ['n', 'w', 'e'] }), car('down'), {
      cx: (f.x0 + f.x1) / 2, cy: (LANDING_Y + doorTop) / 2, cz: (f.z0 + f.z1) / 2,
      hx: (f.x1 - f.x0) / 2, hy: (doorTop - LANDING_Y) / 2, hz: (f.z1 - f.z0) / 2,
      kind: 'liftDoor',
    }];
    const p = worldOf(descs);
    const frame = makeWalker(p);
    const r = frame(pos, pos.x, pos.z);
    if (r.grounded && pos.y > highest) highest = pos.y;
    if (doorTop < closedTop) doorTop = Math.min(closedTop, doorTop + DOOR_SPEED * DT);
  }
  // eslint-disable-next-line no-console
  console.log(`[lift c2] unguarded door carried a rider to ${highest.toFixed(3)}m (hedge top ${closedTop.toFixed(3)}m)`);
  assert.ok(highest > LANDING_Y + MAZE.HOP + MAZE.STEP_HEIGHT,
    'the unguarded door was expected to carry the rider above what they could board at unaided');
});

/* ------------------------------------------------------------------ */
/* CANDIDATE 3 against the other five properties                       */
/* ------------------------------------------------------------------ */

/** Candidate 3's geometry in a given state. */
function candidate3(at, doorOpen) {
  const f = doorFootprint();
  const closedTop = LANDING_Y + MAZE.HEDGE_HEIGHT;
  const top = doorOpen ? LANDING_Y + MAZE.STEP_HEIGHT * 0.5 : closedTop;
  return [...shell({ railSides: ['n', 'w', 'e'] }), car(at), {
    cx: (f.x0 + f.x1) / 2, cy: (LANDING_Y + top) / 2, cz: (f.z0 + f.z1) / 2,
    hx: (f.x1 - f.x0) / 2, hy: (top - LANDING_Y) / 2, hz: (f.z1 - f.z0) / 2,
    kind: 'liftDoor',
  }];
}

test('CANDIDATE 3, property 1 (WALK IN): a player enters the shaft from the level-N corridor', () => {
  const descs = candidate3('down', false);
  const p = worldOf(descs);
  const frame = makeWalker(p);
  // Start in the corridor south of the cell, walk north into it.
  const pos = new THREE.Vector3(0, 0.05, CELL_HALF + 1.5);
  p.resolveCapsule(pos, RADIUS, HEIGHT);
  for (let s = 0; s < 400; s++) frame(pos, 0, WELL.cz);
  assert.ok(pos.z < CELL_HALF - 0.3,
    `the capsule stopped at z=${pos.z.toFixed(3)} and never crossed the doorway into the shaft cell`);
  assert.ok(pos.y < 1.0, `the capsule ended at y=${pos.y.toFixed(3)}, not on the shaft floor`);
});

test('CANDIDATE 3, property 2 (RIDE): the car carries a capsule from the shaft floor to the landing', () => {
  const c = car('down');
  const travel = c.swept.y1 - (c.cy + c.hy);
  const speed = 1.5;
  const pos = new THREE.Vector3(WELL.cx, CAR_REST_CLEARANCE + 0.02, WELL.cz);
  let carTop = CAR_REST_CLEARANCE;
  for (let s = 0; s < 1200 && carTop < LANDING_Y; s++) {
    carTop = Math.min(LANDING_Y, carTop + speed * DT);
    const descs = [...shell({ railSides: ['n', 'w', 'e'] }), {
      cx: WELL.cx, cy: carTop - CAR_HALF_THICK, cz: WELL.cz,
      hx: CAR_HALF, hy: CAR_HALF_THICK, hz: CAR_HALF, kind: 'lift', enclosed: true,
    }];
    const p = worldOf(descs);
    pos.y -= 0.05;                       // gravity; the rising car pushes back
    p.resolveCapsule(pos, RADIUS, HEIGHT);
  }
  // eslint-disable-next-line no-console
  console.log(`[lift c3] rider ended at ${pos.y.toFixed(3)}m against a landing at ${LANDING_Y}m (travel ${travel.toFixed(2)}m)`);
  assert.ok(Math.abs(pos.y - LANDING_Y) < 0.05,
    `the rider ended at ${pos.y.toFixed(3)}m, not at the landing`);
});

test('CANDIDATE 3, property 3 (WALK AWAY): level N+1 stays crossable past the shaft cell', () => {
  /* Door closed and car down - the worst case, since that is when most of the
   * cell is blocked off.
   *
   * The route goes through the L-SHAPED STRIP along the cell's north and
   * west, not straight across the middle. That is not a concession to make
   * the test pass: the strip is the whole reason `STAIR_WELL_OFFSET` pushes
   * the well into one quadrant, and the stair depends on exactly the same
   * thing. A straight line through the well's centre line is correctly
   * blocked by the rails, and the companion test below asserts that it is -
   * a well you can walk through is not a well.
   *
   * The first draft of this test walked that straight line and failed. The
   * geometry was right and the test was wrong, which is worth recording:
   * "walk away" means a route exists, not that every line is clear. */
  const p = worldOf(candidate3('down', false));
  const frame = makeWalker(p);
  const strip = -CELL_HALF + 0.95;              // the middle of the north strip
  const waypoints = [
    { x: -CELL_HALF - 1.5, z: strip },
    { x: CELL_HALF + 1.5, z: strip },
  ];
  const pos = new THREE.Vector3(waypoints[0].x, LANDING_Y + 0.05, waypoints[0].z);
  p.resolveCapsule(pos, RADIUS, HEIGHT);
  for (const wp of waypoints) for (let s = 0; s < 600; s++) frame(pos, wp.x, wp.z);
  assert.ok(pos.x > CELL_HALF,
    `a pedestrian crossing level N+1 by the north strip got stuck at x=${pos.x.toFixed(3)} - the lift severed the corridor`);
  assert.ok(Math.abs(pos.y - LANDING_Y) < 0.2,
    `the pedestrian ended at y=${pos.y.toFixed(3)} rather than on level N+1's floor`);
});

test('property 3 is not vacuous: the well itself is NOT walkable straight through', () => {
  const p = worldOf(candidate3('down', false));
  const frame = makeWalker(p);
  const pos = new THREE.Vector3(-CELL_HALF - 1.5, LANDING_Y + 0.05, WELL.cz);
  p.resolveCapsule(pos, RADIUS, HEIGHT);
  for (let s = 0; s < 900; s++) frame(pos, CELL_HALF + 1.5, WELL.cz);
  assert.ok(pos.x < WELL.x0,
    `a capsule walked straight across the well's centre line to x=${pos.x.toFixed(3)} - the rails are not `
    + 'holding, and property 3 above would pass for the wrong reason');
});

test('CANDIDATE 3, property 5 (NO ESCAPE): nothing comes to rest on a canopy outside the shaft', () => {
  const heights = new Set();
  for (const [at, open] of [['down', false], ['up', true], ['down', true], ['up', false]]) {
    const p = worldOf(candidate3(at, open));
    for (let i = 0; i <= 24; i++) {
      for (let j = 0; j <= 24; j++) {
        const sx = -CELL_HALF - 2 + (i * (2 * CELL_HALF + 4)) / 24;
        const sz = -CELL_HALF - 2 + (j * (2 * CELL_HALF + 4)) / 24;
        // Outside the shaft footprint only.
        if (Math.abs(sx) <= CELL_HALF && Math.abs(sz) <= CELL_HALF) continue;
        const pos = new THREE.Vector3(sx, LANDING_Y + MAZE.HEDGE_HEIGHT + 2, sz);
        const frame = makeWalker(p);
        for (let s = 0; s < 200; s++) frame(pos, sx, sz);
        heights.add(Math.round(pos.y * 100) / 100);
      }
    }
  }
  const canopies = [...heights].filter((h) => Math.abs(h - MAZE.HEDGE_HEIGHT) < 0.2
    || Math.abs(h - (LANDING_Y + MAZE.HEDGE_HEIGHT)) < 0.2);
  // eslint-disable-next-line no-console
  console.log(`[lift c3] grounded rest heights outside the shaft: ${[...heights].sort((a, b) => a - b).join(', ')}`);
  assert.deepEqual(canopies, [],
    `capsules came to rest at canopy height outside the shaft: ${canopies.join(', ')}`);
});

test('CANDIDATE 3, property 6 (THE CAP): nothing the SHAFT emits tops out above floorN + LEVEL_HEIGHT', () => {
  // The same carve-out the staircase has, and it must be stated rather than
  // quietly relied on: the guard rails and the landing door stand above
  // LANDING_Y, but they are level N+1's OWN geometry - emitted by
  // districtColliders, not by the shaft - exactly as the stair's guard walls
  // are. Property 6 is about what the shaft itself puts into level N's space.
  const shaftOnly = [car('down')];
  for (const d of shaftOnly) {
    assert.ok(descriptorTop(d) <= LANDING_Y + 1e-6,
      `${d.kind} tops out at ${descriptorTop(d).toFixed(3)}m, above the ${LANDING_Y}m cap`);
  }
  const doorTop = descriptorTop(candidate3('down', false).find((d) => d.kind === 'liftDoor'));
  assert.ok(doorTop > LANDING_Y,
    'the landing door is expected to live ABOVE the cap, as level N+1 geometry - if it no longer does, '
    + 'this carve-out is no longer needed and should be deleted rather than kept as dead reassurance');
});
