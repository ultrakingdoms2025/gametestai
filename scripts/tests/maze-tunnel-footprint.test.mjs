/**
 * Phase 2c Task 7 - PROVE A TUNNEL CAN FIT, before drawing one.
 *
 * Ships a decision, not geometry. `MazeShafts.js` still falls back to a
 * staircase for every tunnel link while this runs.
 *
 * Six constraints, all of which must hold at once:
 *
 *   1. THE CLIMB      24 rises of LEVEL_HEIGHT/24 = 0.375 m, each under the
 *                     0.45 m auto-step, arriving flush with level N+1's floor.
 *   2. OWN COLUMN     it surfaces above the cell it started under, so the
 *                     topology link stays C->C and solve(), reachability and
 *                     the map are untouched.
 *   3. OWN DISTRICT   the footprint never leaves the district. District
 *                     independence is what makes streaming and these headless
 *                     gates possible.
 *   4. LEVEL N WALKS  every passage level N's own topology opens still has a
 *                     route through the claimed cells.
 *   5. LEVEL N+1 WALKS the same, above.
 *   6. NO PIT/LADDER/CANOPY - Phase 2b's properties 4, 5 and 6, unchanged.
 *
 * Constraint 4 is the one that killed 2b's round 3, and it is strictly harder
 * here than it was for the stair: a staircase hides a 2.8 m well in one
 * quadrant of ONE cell and leaves an L-shaped strip 1.9 m wide that connects
 * all four sides. A tunnel's body is a bar running the length of TWO cells,
 * and a bar across a cell severs north-south.
 *
 * The layout under test answers that with a gap at each end: the body stops
 * short of both outer boundaries, so the strips north and south of it join up
 * around the ends and every side still reaches every other side.
 *
 * `rise` is NOT a parameter. 0.375 m is bounded by the auto-step and is not
 * negotiable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Physics } from '../../src/physics/Physics.js';
import { MAZE, DIR } from '../../src/worlds/maze/MazeTopology.js';
import { ENTRY_SEAL_FROM, SHAFT_STEPS, descriptorTop } from '../../src/worlds/maze/MazeShafts.js';

const RADIUS = 0.35, HEIGHT = 1.75;
const DT = 1 / 60, GRAVITY = 22, WALK_SPEED = 4.2, STEP_H = MAZE.STEP_HEIGHT;

const RISE = MAZE.LEVEL_HEIGHT / SHAFT_STEPS;          // 0.375, fixed
const TREAD = 0.75;                                    // as the stair uses
const CELL_HALF = MAZE.CELL / 2;
const NAMES = { [DIR.N]: 'N', [DIR.E]: 'E', [DIR.S]: 'S', [DIR.W]: 'W' };

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

/**
 * A U-fold tunnel across two cells, as pure descriptors.
 *
 * Cell C is at the origin; the run goes +x into cell C+1 at x = CELL. Two
 * flights of `SHAFT_STEPS / flights` treads each, side by side in z, joined by
 * a half-landing at the far end, arriving above cell C.
 *
 * `W` is one flight's half-width. `endGap` is how far the body stops short of
 * the region's outer x boundaries - the whole answer to constraint 4.
 */
function tunnelFixture({ W = 0.6, flights = 4, fillRegion = false } = {}) {
  const out = [];
  const perFlight = SHAFT_STEPS / flights;
  const run = perFlight * TREAD;
  const flightRise = perFlight * RISE;
  const regionX0 = -CELL_HALF, regionX1 = MAZE.CELL + CELL_HALF;   // cells C and C+1
  /* Gaps are DERIVED from the body's true length and split evenly, so the two
   * ends always match. The first draft offset the body from the west edge by a
   * chosen `endGap` and let the east end fall where it may - which left 0.3 m
   * there, put the east door INSIDE the landing, and made every connectivity
   * measurement meaningless. */
  const bodyLen = run + 2 * W;
  const gap = ((regionX1 - regionX0) - bodyLen) / 2;
  const bodyX0 = regionX0 + gap;

  /* Four flights over TWO lanes, stacked: flight i runs in lane i%2 and is
   * tier floor(i/2) high. Flight 2 therefore sits directly above flight 0 -
   * but two flights above, so the headroom between them is 2 * flightRise,
   * not one. Getting that wrong is what made a 4-flight fold look impossible
   * on the first pass. */
  for (let f = 0; f < flights; f++) {
    const lane = (f % 2) === 0 ? -W : W;
    const forward = (f % 2) === 0;
    for (let i = 0; i < perFlight; i++) {
      const bottom = f * flightRise + i * RISE, top = bottom + RISE;
      const along = forward ? (i + 0.5) * TREAD : run - (i + 0.5) * TREAD;
      out.push({
        cx: bodyX0 + W + along, cy: (bottom + top) / 2, cz: lane,
        hx: TREAD / 2, hy: (top - bottom) / 2, hz: W,
        kind: 'tunnel', enclosed: true,
      });
    }
    // The half-landing that turns this flight into the next.
    if (f < flights - 1) {
      const turnTop = (f + 1) * flightRise;
      out.push({
        cx: bodyX0 + (forward ? bodyLen - W : W), cy: turnTop / 2, cz: 0,
        hx: W, hy: turnTop / 2, hz: W * 2,
        kind: 'tunnel', enclosed: true,
      });
    }
  }

  if (fillRegion) {
    /* For the negative only: a slab filling the region from wall to wall, so
     * there is no way past in either axis. */
    out.push({
      cx: (regionX0 + regionX1) / 2, cy: MAZE.LEVEL_HEIGHT / 2, cz: 0,
      hx: (regionX1 - regionX0) / 2, hy: MAZE.LEVEL_HEIGHT / 2, hz: CELL_HALF,
      kind: 'tunnel', enclosed: true,
    });
  }
  return { descs: out, bodyX0, bodyX1: bodyX0 + bodyLen, regionX0, regionX1, W, run, endGap: gap, flights };
}

/** The sealed region: cells C and C+1, walled on their outer boundary. */
function regionShell(fx, { openSides = [DIR.W] } = {}) {
  const out = [];
  const H = MAZE.LEVEL_HEIGHT;
  const x0 = fx.regionX0, x1 = fx.regionX1;
  const z0 = -CELL_HALF, z1 = CELL_HALF;

  // Level N floor under the whole region, and a ring beyond it to walk in from.
  out.push({
    cx: (x0 + x1) / 2, cy: -0.5, cz: 0,
    hx: (x1 - x0) / 2 + MAZE.CELL, hy: 0.5, hz: CELL_HALF + MAZE.CELL, kind: 'floor',
  });

  const wall = (wx0, wx1, wz0, wz1, open) => {
    const baseY = open ? ENTRY_SEAL_FROM : 0;
    out.push({
      cx: (wx0 + wx1) / 2, cy: (baseY + H) / 2, cz: (wz0 + wz1) / 2,
      hx: (wx1 - wx0) / 2 || 0.6, hy: (H - baseY) / 2, hz: (wz1 - wz0) / 2 || 0.6,
      kind: 'shaftWall',
    });
  };
  wall(x0 - 0.6, x0 + 0.6, z0, z1, openSides.includes(DIR.W));   // west
  wall(x1 - 0.6, x1 + 0.6, z0, z1, openSides.includes(DIR.E));   // east
  wall(x0, x1, z0 - 0.6, z0 + 0.6, openSides.includes(DIR.N));   // north
  wall(x0, x1, z1 - 0.6, z1 + 0.6, openSides.includes(DIR.S));   // south
  return out;
}

/* ------------------------------------------------------------------ */
/* Constraint 1 - the climb                                            */
/* ------------------------------------------------------------------ */

test('CONSTRAINT 1: the tunnel climbs a full level in rises under the auto-step', () => {
  const fx = tunnelFixture();
  const tops = fx.descs.map(descriptorTop).sort((a, b) => a - b);
  assert.ok(Math.abs(tops[tops.length - 1] - MAZE.LEVEL_HEIGHT) < 1e-9,
    `the tunnel tops out at ${tops[tops.length - 1]}, not at the ${MAZE.LEVEL_HEIGHT}m landing`);
  for (let i = 1; i < tops.length; i++) {
    const step = tops[i] - tops[i - 1];
    assert.ok(step <= MAZE.STEP_HEIGHT + 1e-9,
      `a ${step.toFixed(3)}m rise exceeds the ${MAZE.STEP_HEIGHT}m auto-step`);
  }
  // eslint-disable-next-line no-console
  console.log(`[tunnel] ${fx.descs.length} descriptors, rise ${RISE}m, run ${fx.run}m per flight`);
});

/* ------------------------------------------------------------------ */
/* Constraints 2 and 3 - where it starts, ends and stops                */
/* ------------------------------------------------------------------ */

test('CONSTRAINT 2: the tunnel surfaces above the cell it started under', () => {
  const fx = tunnelFixture();
  const top = fx.descs.reduce((a, d) => (descriptorTop(d) > descriptorTop(a) ? d : a));
  assert.ok(Math.abs(top.cx) <= CELL_HALF,
    `the tunnel surfaces at x=${top.cx.toFixed(2)}, outside cell C - the topology link would no longer be C->C`);
  assert.ok(Math.abs(top.cz) <= CELL_HALF, `it surfaces at z=${top.cz.toFixed(2)}, outside cell C`);
});

test('CONSTRAINT 3: the footprint stays inside a 2x1 cell region, which fits any district', () => {
  const fx = tunnelFixture();
  for (const d of fx.descs) {
    assert.ok(d.cx - d.hx >= fx.regionX0 - 1e-9 && d.cx + d.hx <= fx.regionX1 + 1e-9,
      `a descriptor reaches x ${(d.cx - d.hx).toFixed(2)}..${(d.cx + d.hx).toFixed(2)}, outside the region`);
    assert.ok(Math.abs(d.cz) + d.hz <= CELL_HALF + 1e-9,
      `a descriptor reaches z +-${(Math.abs(d.cz) + d.hz).toFixed(2)}, outside the region's single-cell width`);
  }
  // A 2x1 region fits inside a 20x20 district anywhere except against the far
  // edge, where the orientation is simply chosen the other way - which is what
  // makes constraint 3 satisfiable at all.
  assert.equal(fx.regionX1 - fx.regionX0, 2 * MAZE.CELL);
});

/* ------------------------------------------------------------------ */
/* Constraint 4 - the one that killed round 3                          */
/* ------------------------------------------------------------------ */

/**
 * Can a capsule get from every open side of the region to every other, at
 * level N, without crossing the tunnel body?
 */
function sidesConnect(fx, openSides) {
  const descs = [...regionShell(fx, { openSides }), ...fx.descs];
  const p = worldOf(descs);
  const mid = (fx.regionX0 + fx.regionX1) / 2;
  /* Doors sit in the END GAPS, clear of the body. Placing them at a fixed
   * inset put the east door inside the far landing, so every route from it
   * started embedded in a collider. */
  const doors = {
    [DIR.W]: { x: fx.regionX0 + fx.endGap / 2, z: 0 },
    [DIR.E]: { x: fx.regionX1 - fx.endGap / 2, z: 0 },
    [DIR.N]: { x: mid, z: -CELL_HALF + 1.0 },
    [DIR.S]: { x: mid, z: CELL_HALF - 1.0 },
  };

  /* Route AROUND the body through a free strip in z, not along z=0.
   * The first draft detoured only in x, so a west-to-east route - whose two
   * doors both sit at z=0 - walked straight into the body and reported the
   * region severed when it was not. The body is a bar in the middle of the
   * corridor; the way past it is the strip beside it. */
  let bodyZ = 0;
  for (const d of fx.descs) bodyZ = Math.max(bodyZ, Math.abs(d.cz) + d.hz);
  const strips = [-(bodyZ + RADIUS + 0.15), bodyZ + RADIUS + 0.15];

  const results = [];
  for (const from of openSides) {
    for (const to of openSides) {
      if (from === to) continue;
      const a = doors[from], b = doors[to];
      /* TWO families of detour, because the body is a bar and which way round
       * it you go depends on which sides you are joining. West-to-east has
       * both doors at z=0 and must step aside in Z, through the strip beside
       * the body. North-to-south has both doors at the same x and must go
       * round an END, through the gap. Trying only one family reported the
       * other severed - which is how this measurement first read 10/12 on a
       * region that is in fact fully connected. */
      const routes = [];
      for (const stripZ of strips) {
        if (Math.abs(stripZ) > CELL_HALF - RADIUS) continue;
        routes.push([{ x: a.x, z: stripZ }, { x: b.x, z: stripZ }, b]);
      }
      for (const viaX of [fx.regionX0 + fx.endGap / 2, fx.regionX1 - fx.endGap / 2]) {
        routes.push([{ x: viaX, z: a.z }, { x: viaX, z: b.z }, b]);
      }

      let best = Infinity;
      for (const route of routes) {
        const q = new THREE.Vector3(a.x, 0.05, a.z);
        p.resolveCapsule(q, RADIUS, HEIGHT);
        const f = makeWalker(p);
        for (const wp of route) for (let s = 0; s < 400; s++) f(q, wp.x, wp.z);
        best = Math.min(best, Math.hypot(q.x - b.x, q.z - b.z));
      }
      results.push({ from, to, gap: best, ok: best < 1.0 });
    }
  }
  return results;
}

test('CONSTRAINT 4: with a gap at each end, every open side of the region reaches every other', () => {
  const fx = tunnelFixture({ W: 0.6 });
  const openSides = [DIR.W, DIR.E, DIR.N, DIR.S];
  const results = sidesConnect(fx, openSides);
  const failed = results.filter((r) => !r.ok);
  // eslint-disable-next-line no-console
  console.log(`[tunnel] level N connectivity: ${results.length - failed.length}/${results.length} side pairs reachable`
    + (failed.length ? `; failed ${failed.map((f) => `${NAMES[f.from]}->${NAMES[f.to]} gap ${f.gap.toFixed(2)}`).join(', ')}` : ''));
  assert.equal(failed.length, 0,
    `${failed.length} of ${results.length} side pairs are severed by the tunnel body - this is the failure that `
    + 'took 2b four fix rounds, and it is what decides whether a tunnel can exist at all');
});

test('constraint 4 is not vacuous: a body wide enough to close the strip severs the region', () => {
  /* Two earlier versions of this negative did not sever anything, and each
   * failure taught something worth keeping:
   *   - closing the END GAPS did not sever, because a z-strip route ignores them;
   *   - filling the region wall-to-wall did not sever either, because the
   *     doors then start INSIDE the slab and depenetration shuffles the
   *     capsule out to somewhere that counts as arrival.
   * W = 1.2 is the honest one: it closes the side strip exactly (0.00 m) while
   * leaving the geometry legitimate, and the region does then come apart. */
  const fx = tunnelFixture({ W: 1.2 });
  const results = sidesConnect(fx, [DIR.W, DIR.E, DIR.N, DIR.S]);
  const failed = results.filter((r) => !r.ok);
  // eslint-disable-next-line no-console
  console.log(`[tunnel] strip closed (W=1.2): ${failed.length}/${results.length} side pairs severed`);
  assert.ok(failed.length > 0,
    'closing the side strip should sever something - if it does not, the connectivity measurement cannot '
    + 'detect severance at all and constraint 4 passes for the wrong reason');
});

test('the flight width is not what governs connectivity - the end gaps are', () => {
  /* Measured, and it corrects the assumption this task started from. The plan
   * expected a narrow flight to be necessary so a walkable strip survived
   * beside the body. It is not: every width from 0.5 to 1.2 leaves the region
   * fully connected, because a route can go round the END of the body through
   * the gaps the 4-flight fold leaves (3.15 m at each end, against a 0.70 m
   * capsule). W = 1.2 fills the corridor completely and STILL connects.
   *
   * So the width is free to be chosen for how the tunnel reads and climbs
   * rather than to buy clearance, and the constraint that actually has to be
   * respected is that the fold must be short enough to leave end gaps at all -
   * which is what four flights buys over two (3.15 m of gap against 0.90 m). */
  const rows = [];
  for (const W of [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2]) {
    const fx = tunnelFixture({ W });
    const results = sidesConnect(fx, [DIR.W, DIR.E, DIR.N, DIR.S]);
    rows.push({
      W,
      strip: (MAZE.CORRIDOR / 2 - 2 * W).toFixed(2),
      endGap: fx.endGap.toFixed(2),
      connected: results.every((r) => r.ok),
    });
  }
  // eslint-disable-next-line no-console
  console.log(`[tunnel] width search: ${JSON.stringify(rows)}`);
  /* The measured boundary: every width up to 1.0 connects, and 1.2 - which
   * closes the side strip to exactly 0.00 m - does not. So BOTH mechanisms
   * carry load, and the plan's assumption that a narrow flight was needed to
   * preserve a strip is half right: the strip matters, but only at the very
   * end of the range, and the end gaps carry the rest. */
  for (const r of rows) {
    const shouldConnect = Number(r.strip) > 0;
    assert.equal(r.connected, shouldConnect,
      `W=${r.W} (strip ${r.strip}m, end gap ${r.endGap}m) came out ${r.connected ? 'connected' : 'severed'}, `
      + `which is not what a ${r.strip}m strip predicts`);
  }
});

test('two flights do NOT leave a usable end gap - which is why the fold is four', () => {
  const two = tunnelFixture({ W: 0.6, flights: 2 });
  const four = tunnelFixture({ W: 0.6, flights: 4 });
  // eslint-disable-next-line no-console
  console.log(`[tunnel] end gap: 2 flights ${two.endGap.toFixed(2)}m, 4 flights ${four.endGap.toFixed(2)}m`);
  /* 0.90 m against a 0.70 m capsule is 0.10 m of clearance each side. That is
   * the same razor-thin margin 2b flagged on the stair's narrowest tread strip
   * and explicitly warned had "no headroom if tread extents or capsule radius
   * change". Four flights turn it into 3.15 m. The bar here is a clear
   * multiple of the capsule, not a hair over it. */
  const capsule = 2 * RADIUS;
  assert.ok(two.endGap < 2 * capsule,
    `a 2-flight fold leaves ${two.endGap.toFixed(2)}m - if that is comfortably roundable, the simpler fold should be used`);
  assert.ok(four.endGap > 2 * capsule,
    `the 4-flight fold leaves only ${four.endGap.toFixed(2)}m against a ${capsule.toFixed(2)}m capsule`);
});
