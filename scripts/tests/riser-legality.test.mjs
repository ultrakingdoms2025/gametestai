import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

import { buildCitadel } from './citadel-reach-kit.mjs';
import { buildStation } from './world-kit.mjs';
import { CONFIG } from '../../src/core/Config.js';
import { Physics } from '../../src/physics/Physics.js';
import { PROMENADE, promenadeFlight } from '../../src/worlds/station/StationKit.js';

/**
 * A THING SHAPED LIKE A STAIR HAS TO BE CLIMBABLE, AND HAS TO BE WHERE IT LOOKS.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE TWO DEFECTS THIS EXISTS FOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * CITADEL. The stair up to the inner ward is ten colliders whose top faces are
 * `cy + 0.6 * (s + 1)`, so every riser is 0.600 m. The player's step-up is
 * `CONFIG.player.stepHeight` = 0.45, so the walk probe refused all ten; and
 * 0.600 is under `Climb.MIN_RISE_GROUND` = 1.0, so no mantle was offered
 * either. The only way up was to JUMP ten times - and the comment directly
 * above the loop says the stair exists so that "a vertical world that requires
 * the vertical mechanic to see its centrepiece" does not lock anybody out.
 * `citadel-reach.test.mjs` was green throughout because its `ReachGraph`
 * models jump edges, so a flight of pure jumps reads as connected.
 *
 * RACE. Both grandstands draw their terraces with `B.box(...)` and called no
 * `physics.add*` in the loop at all. The whole rake was stood in for by one
 * rotated block whose top is `base.y + 10.00`, while the topmost DRAWN terrace
 * tops out at `base.y + 1.205 + 8 * 1.05` = 9.605 and the front row at 1.205.
 * The walking surface floated 0.40 m over the back row and 8.80 m over the
 * front one, across fifteen bays; the smaller open stand had the identical
 * defect at 0.40 m over six rows.
 *
 * Those are two different questions, so this file asks two.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  1. THE DEAD BAND - what makes a rise illegal
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The player has exactly two ways up a step:
 *
 *   walk   rise <= `CONFIG.player.stepHeight`            0.45 m
 *   mantle `MIN_RISE_GROUND` <= rise <= `MAX_RISE`       1.0 - 2.4 m
 *
 * so `(0.45, 1.0)` is a DEAD BAND - too tall to walk, too short to grab - and
 * anything over 2.4 m is out of reach altogether. A riser in either of those
 * is a stair the game has no move for. That is the whole rule, and it is why
 * this gate PASSES the race grandstand at 1.05 m: a terrace is meant to be
 * mantled, and 1.05 is a legal mantle with 0.05 m clear of the boundary. It is
 * not a rule about comfort.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  2. WHAT IS A FLIGHT? Detected, never listed
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A hand-written list of stairs is a list that goes stale the first time
 * somebody adds one. So flights are found in the collision itself: four or
 * more solid boxes of IDENTICAL half-extents at a CONSTANT 3-D offset from
 * each other. That is not a heuristic about what stairs look like, it is the
 * shape a `for` loop emitting treads necessarily produces, and it is what both
 * of the defects above are made of. A crate stack, a shelf and a terrace of
 * houses all fail one of the two conditions.
 *
 * Detection running is asserted (the citadel's flight and the race terraces
 * must both be found), and the detector is separately driven against a
 * synthetic ten-step stack at the citadel's OWN pre-fix numbers, so this file
 * cannot pass by finding nothing.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  3. WHERE THE COLLIDER IS versus WHERE THE TREAD IS DRAWN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The race defect is invisible to rule 1 - with no tread colliders there is no
 * stack to detect - so the second test compares the surface a body stands on
 * with the surface a player can see, by casting down through the drawn scene
 * and through the collision at the same column. `stepHeight` is the tolerance
 * for a whole world (the seat planks drawn on every terrace stand 0.41 m proud
 * of it, and 0.41 < 0.45), and 0.04 m for the station's promenade, where
 * nothing is drawn on top of the walking surface and the two defects this pass
 * fixed were 0.092 m and 0.05 m.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIMB_SRC = path.join(HERE, '..', '..', 'src', 'player', 'Climb.js');

const STEP = CONFIG.player.stepHeight;

/**
 * The mantle band, restated here and PINNED to its source.
 *
 * `Climb.js` keeps both as module-private constants, so they cannot be
 * imported. Restating a number is how a test comes to disagree with the game,
 * which is the failure mode this whole suite exists to prevent - so the values
 * below are read back out of the file that owns them and asserted, and a
 * change there fails here rather than silently widening this gate.
 */
const MIN_RISE_GROUND = 1.0;
const MAX_RISE = 2.4;

test('the mantle band this file tests against is the one Climb.js implements', () => {
  const src = readFileSync(CLIMB_SRC, 'utf8');
  const min = src.match(/^const MIN_RISE_GROUND = ([\d.]+);/m);
  const max = src.match(/^const MAX_RISE = ([\d.]+);/m);
  assert.ok(min && max, 'Climb.js no longer declares MIN_RISE_GROUND / MAX_RISE at module scope');
  assert.equal(Number(min[1]), MIN_RISE_GROUND, 'the mantle floor moved - re-take it here');
  assert.equal(Number(max[1]), MAX_RISE, 'the mantle ceiling moved - re-take it here');
  assert.equal(CONFIG.player.stepHeight, 0.45, 'the step-up moved - re-take the dead band');
});

/** A rise the player has a move for. */
function climbable(rise) {
  if (rise <= STEP + 1e-9) return true;
  return rise >= MIN_RISE_GROUND - 1e-9 && rise <= MAX_RISE + 1e-9;
}

/**
 * Every run of >= `MIN_STEPS` solid boxes with identical half-extents at a
 * constant offset, ordered from the bottom.
 *
 * @param {Array} colliders `physics.colliders`
 * @returns {Array<{rise:number, going:number, steps:number, at:THREE.Vector3}>}
 */
function flightsIn(colliders, MIN_STEPS = 4) {
  const byShape = new Map();
  for (const c of colliders) {
    if (!c.solid || c.type !== 'box') continue;
    const e = c.halfExtents;
    const k = `${e.x.toFixed(3)}|${e.y.toFixed(3)}|${e.z.toFixed(3)}`;
    if (!byShape.has(k)) byShape.set(k, []);
    /* The box's own axes come along: whether consecutive treads OVERLAP is
     * what separates a stair from a line of stepping stones, and that is a
     * question about the box's depth in the direction the run travels.
     * `Matrix4.makeRotationY(a)` puts local +X at (cos a, -sin a) and +Z at
     * (sin a, cos a); read out rather than stored so a world that starts
     * composing rotations is not silently mis-measured. */
    const m = c.matrix.elements;
    byShape.get(k).push(Object.assign(c.center.clone(), {
      ax: m[0], az: -m[2], hx: e.x, hy: e.y, hz: e.z,
    }));
  }
  /** Half the box's reach along the horizontal unit vector (ux, uz). */
  const halfAlong = (b, ux, uz) =>
    Math.abs(b.hx * (b.ax * ux + (-b.az) * uz)) + Math.abs(b.hz * (b.az * ux + b.ax * uz));
  const out = [];
  const near = (a, b) => Math.abs(a - b) < 0.005;
  for (const list of byShape.values()) {
    if (list.length < MIN_STEPS) continue;
    list.sort((a, b) => a.y - b.y);
    const used = new Set();
    for (let i = 0; i < list.length; i++) {
      if (used.has(i)) continue;
      for (let j = 0; j < list.length; j++) {
        if (i === j || used.has(j)) continue;
        const dy = list[j].y - list[i].y;
        if (dy <= 1e-6 || dy > 3.0) continue;
        const dx = list[j].x - list[i].x, dz = list[j].z - list[i].z;
        const going = Math.hypot(dx, dz);
        if (going > 4.0) continue;
        /* A FLIGHT IS A CONTINUOUS SURFACE. Two exclusions, both of them
         * things a stack of identical boxes can be that a stair is not:
         *
         *   going ~ 0 is a VERTICAL COURSE - the citadel's minaret bands and
         *   the medieval ring walls are boxes at a constant rise on the same
         *   footprint, and nobody walks up the outside of a wall.
         *
         *   treads that do not reach each other are STEPPING STONES. The
         *   citadel's rope bridges are 276 identical 1.2 x 2.2 m planks and a
         *   straight run of them shares a constant offset exactly the way a
         *   stair does - but the planks are 1.393 m apart and 1.2 m deep, so
         *   there is a gap between every pair and crossing one is a jump. That
         *   is the reach suites' subject and it is measured there against the
         *   real integrator; a step-up rule has nothing true to say about it. */
        if (going < 0.05) continue;
        const ux = dx / going, uz = dz / going;
        if (halfAlong(list[i], ux, uz) + halfAlong(list[j], ux, uz) < going) continue;
        /* Follow the offset. A flight is a chain, so this walks it to the top
         * rather than counting pairs - two crates and a shelf that happen to
         * share a spacing do not survive four links. */
        const chain = [i, j];
        let k = j;
        for (;;) {
          let next = -1;
          for (let m = 0; m < list.length; m++) {
            if (m === k || chain.includes(m)) continue;
            if (near(list[m].y - list[k].y, dy)
              && near(list[m].x - list[k].x, dx)
              && near(list[m].z - list[k].z, dz)) { next = m; break; }
          }
          if (next < 0) break;
          chain.push(next);
          k = next;
        }
        if (chain.length >= MIN_STEPS) {
          for (const m of chain) used.add(m);
          out.push({
            rise: dy,
            going,
            steps: chain.length,
            at: new THREE.Vector3(list[chain[0]].x, list[chain[0]].y, list[chain[0]].z),
            step: new THREE.Vector3(dx, dy, dz),
            /** Half-height, so a caller can put the TOP FACE where it belongs. */
            halfY: list[chain[0]].hy,
          });
          break;
        }
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The worlds                                                          */
/* ------------------------------------------------------------------ */

const noopCtx = () => {
  const grad = { addColorStop() {} };
  return new Proxy({
    canvas: null,
    createLinearGradient: () => grad, createRadialGradient: () => grad, createPattern: () => null,
    measureText: () => ({ width: 10 }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  }, { get: (o, k) => (k in o ? o[k] : () => undefined), set: () => true });
};
globalThis.document ??= {
  createElement(tag) {
    if (tag !== 'canvas') return {};
    return { width: 1, height: 1, getContext: () => noopCtx(), style: {} };
  },
};

let RACE = null;
async function race() {
  if (RACE) return RACE;
  const { RaceWorld } = await import('../../src/worlds/RaceWorld.js');
  const matCache = new Map();
  const materials = {
    has: () => true,
    get: (k) => {
      if (!matCache.has(k)) matCache.set(k, new THREE.MeshStandardMaterial({ name: k }));
      return matCache.get(k);
    },
    register: (k, m) => matCache.set(k, m),
    tinted: (k) => materials.get(k),
  };
  const physics = new Physics();
  const world = new RaceWorld({
    scene: new THREE.Scene(), engine: null, physics,
    bus: { on() {}, off() {}, emit() {} }, materials,
  });
  const say = console.log;
  console.log = () => {};
  try { await world.build(); } finally { console.log = say; }
  RACE = { world, physics };
  return RACE;
}

/* ================================================================== */
/* 1. Nothing shaped like a flight is unclimbable                      */
/* ================================================================== */

test('the detector finds a ten-step 0.6 m stack - the citadel flight as it was', () => {
  /* PROOF THIS GATE CAN FAIL, on the real pre-fix geometry.
   *
   * These are the citadel's own numbers before the repair: `sy = cy + (s +
   * 0.5) * (wardH / 10)` and `sz = wardR + 6 - s * 0.7` with `wardH` = 6 and
   * `wardR` = 30, collided as `addBox(0, sy, sz, 4.5, wardH / 20, 0.8)`. Ten
   * boxes, identical extents, a constant (0, +0.6, -0.7) offset. */
  const physics = new Physics();
  const cy = 14;
  for (let s = 0; s < 10; s++) {
    physics.addBox(0, cy + (s + 0.5) * 0.6, 36 - s * 0.7, 4.5, 0.3, 0.8);
  }
  const found = flightsIn(physics.colliders);
  assert.equal(found.length, 1, `the detector found ${found.length} flights in a flight of stairs`);
  assert.equal(found[0].steps, 10);
  assert.ok(Math.abs(found[0].rise - 0.6) < 1e-9);
  assert.equal(climbable(found[0].rise), false,
    '0.600 m is 0.15 over the step-up and 0.40 under the mantle floor - if this reads climbable '
    + 'the dead band has been widened and the gate is decoration');
});

/**
 * WHAT IS STILL IN THE DEAD BAND IN THE CITADEL - a ratchet.
 *
 * One flight, and it is not a slip: it is authored that way, on purpose,
 * against the wrong constant.
 *
 * `citadel/Regions.js:stair()` says "a walkable flight of steps, every riser
 * inside `STEP_UP`" and throws if a riser exceeds it - but `STEP_UP` there is
 * 0.95, quoted from `NPC.GROUND_PROBE_UP`, which is the height an NPC's GROUND
 * FOLLOWER absorbs. The player has no ground follower: `Player._move` probes
 * for a tread and takes it only when `treadY <= prev.y + P.stepHeight + 0.01`,
 * and `P.stepHeight` is 0.45. So the file's default riser of 0.82 - and this
 * flight's measured 0.800 - is 0.35 m over what a player can step and 0.20 m
 * under what a player can mantle. `citadel-reach.test.mjs` is green because it
 * floods its lattice at the same 0.95.
 *
 * Only ONE of those flights was visible here, and that is worth knowing too:
 * `stair()` plinths every tread down to its own ground, so the treads have
 * DIFFERENT half-extents wherever the terrain moves under them, and the
 * detector's "identical boxes at a constant offset" cannot chain them. The one
 * that used to be listed below was a flight on ground flat enough that all
 * five treads came out the same size.
 *
 * ── CLOSED 2026-09-01, and the list is empty ────────────────────────────
 *
 * The repair was the one this note named: `Regions.stair` and `Regions.helix`
 * now clamp their riser to `CONFIG.player.stepHeight` and scale the going with
 * it, so the pitch a caller authored is bit-for-bit unchanged and a flight
 * occupies the same ground it always did. Measured across the whole outer ring
 * before and after:
 *
 *   before   36 flights, risers 0.679 - 0.810 m, 324 treads.  ALL 36 in the
 *            dead band; only this one was chainable by the detector.
 *   after    36 flights, risers 0.413 - 0.450 m, 564 treads.  None.
 *
 * `citadel-reach.test.mjs` grew the flood that would have caught the other 35:
 * it re-runs every walk edge at the player's step and asserts that tightening
 * the ruler from 0.95 to 0.45 costs neither a tread nor a ring deck.
 *
 * The number may fall and may never rise.
 */
const CITADEL_DEAD_BAND = [];

test('every flight in the citadel is a walk or a mantle', async () => {
  const { physics } = await buildCitadel();
  const flights = flightsIn(physics.colliders);
  /* The ward stair must be here: fourteen treads of `wardH / 14` = 0.428571 at
   * a 0.5 m going, at the middle of the world. Without it this test could pass
   * by detecting nothing at all. */
  const ward = flights.filter((f) => Math.hypot(f.at.x, f.at.z) < 45 && f.steps >= 10);
  assert.equal(ward.length, 1,
    `${ward.length} ward stairs detected among ${flights.length} flights - the gate is measuring nothing`);
  assert.ok(Math.abs(ward[0].rise - 6 / 14) < 1e-6,
    `the ward stair's riser is ${ward[0].rise.toFixed(4)}, not wardH / 14 = 0.428571`);
  assert.ok(climbable(ward[0].rise), 'the ward stair is not walkable');

  for (const f of flights) {
    console.log(`  citadel flight: ${f.steps} steps, rise ${f.rise.toFixed(3)}, going ${f.going.toFixed(3)} at (${f.at.x.toFixed(0)}, ${f.at.y.toFixed(1)}, ${f.at.z.toFixed(0)})`);
  }
  const bad = flights.filter((f) => !climbable(f.rise))
    .map((f) => `${f.steps} x ${f.rise.toFixed(3)} m at (${f.at.x.toFixed(0)}, ${f.at.z.toFixed(0)})`)
    .sort();
  assert.ok(bad.length <= CITADEL_DEAD_BAND.length,
    `${bad.length} citadel flights are in the dead band, up from ${CITADEL_DEAD_BAND.length}`);
  assert.deepEqual(bad, CITADEL_DEAD_BAND,
    'the set of unclimbable citadel flights changed: over 0.45 m is not a step and under 1.0 m '
    + 'is not a mantle. Lower the list when you fix one; never raise it.');
});

test('every flight in the race world is a walk or a mantle', async () => {
  const { physics } = await race();
  const flights = flightsIn(physics.colliders);
  /* The two grandstands must both be found - fifteen bays of nine terraces at
   * 1.05 m and six bays of six at 1.05 - or this test is measuring nothing. */
  const terraces = flights.filter((f) => f.steps >= 6 && f.rise > 0.9 && f.rise < 1.2);
  assert.ok(terraces.length >= 15,
    `only ${terraces.length} grandstand rakes detected - the terraces have stopped being collided`);
  const bad = flights.filter((f) => !climbable(f.rise));
  console.log(`  ${flights.length} flights detected in the race world, ${terraces.length} of them grandstand rakes`);
  assert.deepEqual(bad.map((f) => `${f.steps} x ${f.rise.toFixed(3)} m at (${f.at.x.toFixed(0)}, ${f.at.z.toFixed(0)})`), [],
    'a flight of stairs the player has no move for');
});

/* ================================================================== */
/* 2. The surface you stand on is the surface you can see              */
/* ================================================================== */

/**
 * Drawn surface and solid surface at one column, or nulls.
 *
 * The drawn cast ignores anything transparent or depth-write-disabled: paint,
 * decals, light pools and glass are drawn ON the walking surface and are not
 * it.
 */
function surfaces(world, physics, x, z, fromY, drop, rc) {
  rc.set(new THREE.Vector3(x, fromY, z), new THREE.Vector3(0, -1, 0));
  rc.far = drop;
  let drawn = null;
  for (const h of rc.intersectObject(world.group, true)) {
    const o = h.object;
    if (!o.visible || !o.isMesh) continue;
    /* Instanced fields are skipped: the grandstand's twelve hundred
     * spectators stand ON the terraces and a downward cast at a tread's
     * centre answers a head at +1.70 rather than the tread. Everything this
     * file measures is authored into a merged `Batch`, which is a plain Mesh. */
    if (o.isInstancedMesh) continue;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!m || m.transparent || m.depthWrite === false) continue;
    drawn = h.point.y;
    break;
  }
  const solid = physics.groundHeight(x, z, fromY, drop);
  return { drawn, solid };
}

test('a race grandstand terrace is collided where it is drawn', async () => {
  const { world, physics } = await race();
  world.group.updateMatrixWorld(true);
  const rc = new THREE.Raycaster();

  /* The rakes are FOUND, not listed - the same detector rule 1 uses. That is
   * what makes this test fail on the pre-fix world: with no tread colliders
   * there is no rake to find, so the floor below fails before a single column
   * is cast. Twenty-one is what the two grandstands build (fifteen bays of
   * nine terraces and six of six), and it is a floor rather than a count. */
  const rakes = flightsIn(physics.colliders)
    .filter((f) => f.steps >= 6 && f.rise > 0.9 && f.rise < 1.2);
  assert.ok(rakes.length >= 21,
    `only ${rakes.length} grandstand rakes are collided - a terrace that is drawn and not `
    + 'collided leaves the player walking on an invisible plane over the seats, which is '
    + 'exactly the defect this test exists for');

  let checked = 0;
  const worst = [];
  for (const f of rakes) {
    for (let k = 0; k < f.steps; k++) {
      const cx = f.at.x + f.step.x * k;
      const cy = f.at.y + f.step.y * k;
      const cz = f.at.z + f.step.z * k;
      const top = cy + f.halfY;
      const { drawn } = surfaces(world, physics, cx, cz, top + 3.0, 5.0, rc);
      if (drawn === null) { worst.push({ x: cx, z: cz, drawn: NaN, top, gap: Infinity }); continue; }
      checked++;
      const gap = Math.abs(drawn - top);
      if (gap > STEP) worst.push({ x: cx, z: cz, drawn, top, gap });
    }
  }
  worst.sort((a, b) => b.gap - a.gap);
  console.log(`  ${rakes.length} rakes, ${checked} terraces cast; ${worst.length} more than ${STEP} m from what is drawn`);
  for (const w of worst.slice(0, 8)) {
    console.log(`     (${w.x.toFixed(0)}, ${w.z.toFixed(0)}) drawn ${w.drawn.toFixed(2)} collider top ${w.top.toFixed(2)} gap ${w.gap.toFixed(2)}`);
  }
  assert.ok(checked >= 150, `only ${checked} terraces carried drawn geometry`);
  assert.deepEqual(worst.map((w) => `(${w.x.toFixed(0)}, ${w.z.toFixed(0)}) ${w.gap.toFixed(2)} m`), [],
    'a terrace collider is more than one step from the terrace drawn on it. The seat plank '
    + 'authored on every tread is 0.41 m proud and passes; a rake collided by one flat block '
    + 'over the whole stand does not.');
});

test('the promenade puts its collision where it draws its ramp and its deck', async () => {
  /* 0.04 m, and the tolerance is the point.
   *
   * Three defects of this exact shape have been fixed in the station and all
   * three are inside 0.10: the walkway flight's ramp seat was 0.051 m proud of
   * its treads, the promenade deck's collider stood 0.05 m over its own drawn
   * slab, and the promenade ramp's collision surface sat 0.092 m UNDER the
   * grate drawn on it - feet visibly sunk into the ramp. 0.04 fails all three
   * and passes a surface that is where it is drawn.
   *
   * The promenade is the right place to ask at this tolerance because nothing
   * is drawn on top of it: no paint, no plank, no kerb. The columns are the
   * two flights' own centres and the deck between the telescopes, taken from
   * `PROMENADE` and `promenadeFlight()` - the constants the builder itself
   * reads, so a change to either moves the probe with the world. */
  const { world, physics } = await buildStation();
  world.group.updateMatrixWorld(true);
  const rc = new THREE.Raycaster();
  rc.firstHitOnly = true;
  const flight = promenadeFlight();
  const bad = [];

  /* The flights are measured against their OWN proxy rather than against
   * `groundHeight`, which answers with the topmost surface over the column.
   * Measured while writing this: a 7.6 x 7.0 x 1.2 m `dressing:panel` slab
   * spans y 2.10 to 9.10 over x 142.2-149.8, z 47.5-48.7 - directly over the
   * +18 degree flight - so a cast from 8 m starts INSIDE it and answers 2.10.
   * That slab is a real headroom defect (1.10 m over the flight's centre,
   * 0.43 m near its head, against a 1.75 m player) and it is recorded in this
   * pass's report rather than papered over here; what this test claims is
   * about the ramp, so it asks the ramp. */
  const { rampProxiesIn } = await import('../../src/worlds/station/StationKit.js');
  const proxies = rampProxiesIn(world.group);
  for (const deg of PROMENADE.RAMP_DEG) {
    const th = (deg * Math.PI) / 180;
    const cx = Math.cos(th) * (PROMENADE.R0 - 3), cz = Math.sin(th) * (PROMENADE.R0 - 3);
    const p = proxies.find((q) => Math.hypot(q.position.x - cx, q.position.z - cz) < 0.5);
    assert.ok(p, `no ramp proxy at the ${deg} deg flight's centre`);
    /* The proxy's top face at its own centre. The box is 0.5 m thick and
     * pitched, so vertically that is `0.25 / cos(pitch)` over the centre - the
     * relationship `promenadeFlight().rampSeat` exists to satisfy. */
    const solid = p.position.y + 0.25 / Math.cos(flight.pitch);
    const { drawn } = surfaces(world, physics, cx, cz, 8, 10, rc);
    assert.ok(drawn !== null, `nothing drawn at the ${deg} deg flight's centre`);
    /* The walking line at the flight's own centre: half the rise, by
     * construction - foot flush with the deck at 0, head flush with the
     * promenade at `RAMP_RISE`. */
    const line = PROMENADE.RAMP_RISE / 2;
    if (Math.abs(drawn - solid) > 0.04) bad.push(`flight ${deg}: drawn ${drawn.toFixed(3)} solid ${solid.toFixed(3)}`);
    if (Math.abs(solid - line) > 0.04) bad.push(`flight ${deg}: solid ${solid.toFixed(3)} off its own walking line ${line.toFixed(3)}`);
  }

  /* The deck, sampled between the telescopes at r = 178 and the benches at
   * 170 so nothing authored is standing in the column. Only where the deck was
   * built: the two segments across avenue 0 are deliberately absent. */
  let deckCols = 0;
  for (let deg = -46; deg <= 46; deg += 2) {
    const th = (deg * Math.PI) / 180;
    const x = Math.cos(th) * 174, z = Math.sin(th) * 174;
    const { drawn, solid } = surfaces(world, physics, x, z, 8, 10, rc);
    if (drawn === null || solid === null) continue;
    if (drawn < 1.0) continue;              // the gap on the hub's axis
    deckCols++;
    if (Math.abs(drawn - solid) > 0.04) bad.push(`deck ${deg} deg: drawn ${drawn.toFixed(3)} solid ${solid.toFixed(3)}`);
    if (Math.abs(solid - PROMENADE.DECK_TOP) > 0.04) {
      bad.push(`deck ${deg} deg: solid ${solid.toFixed(3)} off DECK_TOP ${PROMENADE.DECK_TOP}`);
    }
  }
  console.log(`  promenade: 2 flight centres and ${deckCols} deck columns; pitch ${flight.pitchDeg.toFixed(2)} deg, seat ${flight.rampSeat.toFixed(4)}`);
  assert.ok(deckCols >= 30, `only ${deckCols} promenade deck columns found - the deck is not being built`);
  assert.deepEqual(bad, [],
    'the promenade collides somewhere other than where it draws. A flight whose collision surface '
    + 'is under its own grate sinks the player into the ramp; a deck whose collider stands over its '
    + 'slab floats every bench leg on it.');
});
