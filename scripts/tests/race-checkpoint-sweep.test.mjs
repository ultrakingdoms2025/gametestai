import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';

/**
 * THE EXTRACTION, PROVED HARMLESS.
 *
 * `RaceManager._advance` owned the only correct "did this body pass the
 * checkpoint it was supposed to pass" in the repo, and the rooftop time trials
 * need exactly it. The instruction was explicit: lift the sweep into a pure
 * helper both callers use, and prove the race world behaves identically
 * afterwards. This file is that proof, and it is in two halves because
 * "identical" has two meanings that a single test would blur:
 *
 *   1. **The predicate is the same predicate.** `ORACLE` below is the
 *      pre-extraction expression, transcribed verbatim from the shipped
 *      `_advance` (the six lines from `const d2 =` to `if (yGap > gate)`), and
 *      the extracted `sweptPass` is required to agree with it on a corpus that
 *      is proved able to tell wrong answers apart - see the mutant test, which
 *      exists because a corpus that cannot separate a POINT test from a SWEPT
 *      one would pass this file while proving nothing.
 *
 *   2. **The race still races.** The predicate could be perfect and the call
 *      site still wrong: the tail `_px/_pz` has to advance on every step
 *      including misses, the cursor has to advance by one, and the lap has to
 *      tick on the pass of checkpoint 0 that follows the last one. So a real
 *      `RaceManager` is armed on a real circuit and driven, and the emitted
 *      `race:lap` and `race:ring` streams are asserted.
 *
 * There is a third guard, cheap and worth having: a source assertion that
 * `RaceManager.js` no longer carries its own `segDistSq` and that the only
 * checkpoint acceptance in `_advance` is `sweptPass`. Two modules already hold
 * hand-copies of this function (`minigames/TrackRace.js:152`,
 * `minigames/SkiRun.js:174`); a fourth copy landing back inside the race is
 * exactly the regression the extraction exists to prevent.
 */

const { sweptPass, segDistSq } = await import('../../src/race/CheckpointSweep.js');

/* ================================================================== */
/* 1. The predicate                                                    */
/* ================================================================== */

/**
 * The pre-extraction test, transcribed from `RaceManager._advance` as it stood
 * before this change. Deliberately written in the original's shape - the same
 * squared-radius compare, the same `?? cp.y` on the height, the same
 * `cp.yGate > 0` ternary - so a reader can diff it against the git history
 * rather than take this file's word for it.
 *
 * @returns {boolean} true when the original would have counted the pass
 */
function ORACLE(px0, pz0, px1, pz1, py, cp, fallbackYGate) {
  const ex = cp.x - px0;
  void ex;
  // segDistSq, inlined exactly as RaceManager.js:140 had it.
  const sx = px1 - px0;
  const sz = pz1 - pz0;
  const e2 = sx * sx + sz * sz;
  let t = e2 > 1e-9 ? ((cp.x - px0) * sx + (cp.z - pz0) * sz) / e2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = cp.x - (px0 + sx * t);
  const dz = cp.z - (pz0 + sz * t);
  const d2 = dx * dx + dz * dz;
  if (d2 > cp.radius * cp.radius) return false;
  const yGap = Math.abs((py ?? cp.y) - cp.y);
  const gate = cp.yGate > 0 ? cp.yGate : fallbackYGate;
  return !(yGap > gate);
}

/** A wrong answer: the end POINT, not the segment. The tunnelling bug. */
function POINT_MUTANT(px0, pz0, px1, pz1, py, cp, fallbackYGate) {
  void px0;
  void pz0;
  const dx = cp.x - px1;
  const dz = cp.z - pz1;
  if (dx * dx + dz * dz > cp.radius * cp.radius) return false;
  const yGap = Math.abs((py ?? cp.y) - cp.y);
  const gate = cp.yGate > 0 ? cp.yGate : fallbackYGate;
  return !(yGap > gate);
}

/** A wrong answer: no vertical gate at all. The bridge-over-the-line bug. */
function NO_GATE_MUTANT(px0, pz0, px1, pz1, py, cp, fallbackYGate) {
  void py;
  void fallbackYGate;
  return segDistSq(px0, pz0, px1, pz1, cp.x, cp.z) <= cp.radius * cp.radius;
}

/**
 * A corpus that covers every branch on purpose rather than by luck.
 *
 * `mulberry32` so the run is identical on every machine and every day - a
 * randomised equivalence test that drifts is a test that fails for a reason
 * nobody can reproduce.
 */
function mulberry32(a) {
  return function rnd() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function corpus() {
  const rnd = mulberry32(0x51475);
  const cases = [];
  /* Hand-written edge cases first, so a randomiser that never happens to
   * produce them cannot hide behind volume. */
  const cp = (x, z, y, radius, yGate) => ({ x, z, y, radius, yGate });
  cases.push(
    // dead centre, on the deck
    [0, 0, 0, 0, 0, cp(0, 0, 0, 5, 0), 14],
    // exactly on the radius: `d2 > r*r` is false, so this PASSES
    [0, 0, 5, 0, 0, cp(0, 5, 0, 5, 0), 14],
    // a hair outside
    [0, 0, 5.0001, 0, 0, cp(0, 5.0001, 0, 5, 0), 14],
    // tunnelled: both endpoints outside, the segment through the middle
    [-40, 0, 40, 0, 0, cp(0, 0, 0, 5, 0), 14],
    // exactly on the y gate
    [0, 0, 0, 0, 14, cp(0, 0, 0, 5, 0), 14],
    [0, 0, 0, 0, 14.0001, cp(0, 0, 0, 5, 0), 14],
    // the checkpoint carries its own gate, which must win
    [0, 0, 0, 0, 4, cp(0, 0, 0, 5, 3), 14],
    [0, 0, 0, 0, 2, cp(0, 0, 0, 5, 3), 14],
    // a zero-length step (a stationary racer) still tests the point
    [3, 3, 3, 3, 0, cp(3, 3, 0, 5, 0), 14],
    // undefined height: the `?? cp.y` branch, which must pass the gate
    [0, 0, 0, 0, undefined, cp(0, 0, 100, 5, 0), 14],
    // the dragon fallback gate: radius * 0.9
    [0, 0, 0, 0, 4.6, cp(0, 0, 0, 5.2, 0), 5.2 * 0.9],
    [0, 0, 0, 0, 4.7, cp(0, 0, 0, 5.2, 0), 5.2 * 0.9],
    // a rooftop leap: 11.64 m/s crosses 0.194 m a step, but a 40 m/s dive
    // crosses 0.67 - and a teleport crosses the whole souk in one step
    [52.1, 88.9, 62.0, 60.0, 21.3, cp(56, 74, 20.5, 2.6, 0), 3.0],
  );
  for (let i = 0; i < 20000; i++) {
    const rad = 0.5 + rnd() * 8;
    const c = cp(
      (rnd() - 0.5) * 60,
      (rnd() - 0.5) * 60,
      (rnd() - 0.5) * 40,
      rad,
      rnd() < 0.3 ? rnd() * 6 : 0
    );
    /* Half the steps are aimed near the checkpoint so the interesting branch is
     * not swamped by misses; the other half are anywhere, including the long
     * teleporting steps that separate a swept test from a point test. */
    const aim = rnd() < 0.5;
    const ax = aim ? c.x + (rnd() - 0.5) * rad * 2.2 : (rnd() - 0.5) * 80;
    const az = aim ? c.z + (rnd() - 0.5) * rad * 2.2 : (rnd() - 0.5) * 80;
    const len = rnd() < 0.2 ? rnd() * 120 : rnd() * 3;
    const ang = rnd() * Math.PI * 2;
    const py = rnd() < 0.05 ? undefined : c.y + (rnd() - 0.5) * 24;
    cases.push([
      ax, az,
      ax + Math.cos(ang) * len, az + Math.sin(ang) * len,
      py, c,
      rnd() < 0.5 ? 14 : c.radius * 0.9,
    ]);
  }
  return cases;
}

const CASES = corpus();

test('the extracted sweep answers exactly what RaceManager._advance answered', () => {
  let passes = 0;
  for (const [ax, az, bx, bz, py, cp, gate] of CASES) {
    const want = ORACLE(ax, az, bx, bz, py, cp, gate);
    const got = sweptPass(ax, az, bx, bz, py, cp, gate);
    if (want) passes++;
    assert.equal(
      got, want,
      `disagreed on (${ax},${az})->(${bx},${bz}) y=${py} cp=(${cp.x},${cp.z},${cp.y}) r=${cp.radius} yGate=${cp.yGate} fallback=${gate}`
    );
  }
  /* A corpus of 20 013 cases in which nothing ever passes would agree with any
   * implementation that returns false. Both outcomes have to be well
   * represented for the equality above to mean anything. */
  console.log(`    ${CASES.length} cases, ${passes} of them passes (${((passes / CASES.length) * 100).toFixed(1)}%)`);
  assert.ok(passes > CASES.length * 0.1, 'the corpus barely ever passes - it cannot separate implementations');
  assert.ok(passes < CASES.length * 0.9, 'the corpus almost always passes - same problem, the other way up');
});

test('the corpus can tell a wrong implementation apart from the right one', () => {
  /* This is the test that stops the one above being vacuous. If the corpus
   * cannot separate `sweptPass` from a point test and from an ungated test,
   * then agreeing with the oracle proves nothing about either property. Both
   * mutants are the real historical bugs the original's header names. */
  let pointDiff = 0;
  let gateDiff = 0;
  for (const [ax, az, bx, bz, py, cp, gate] of CASES) {
    const want = ORACLE(ax, az, bx, bz, py, cp, gate);
    if (POINT_MUTANT(ax, az, bx, bz, py, cp, gate) !== want) pointDiff++;
    if (NO_GATE_MUTANT(ax, az, bx, bz, py, cp, gate) !== want) gateDiff++;
  }
  console.log(`    point-test mutant differs on ${pointDiff} cases; ungated mutant differs on ${gateDiff}`);
  assert.ok(pointDiff > 50, 'the corpus never tunnels, so it cannot prove the test is swept');
  assert.ok(gateDiff > 50, 'the corpus never crosses over a line, so it cannot prove the y gate exists');
});

test('RaceManager keeps no second copy of the checkpoint test', () => {
  const src = readFileSync(new URL('../../src/race/RaceManager.js', import.meta.url), 'utf8');
  assert.ok(
    /import \{ sweptPass \} from '\.\/CheckpointSweep\.js';/.test(src),
    'RaceManager should import the shared sweep'
  );
  assert.ok(
    !/function segDistSq/.test(src),
    'RaceManager still defines its own segDistSq - that is the copy the extraction removed'
  );
  const advance = src.slice(src.indexOf('  _advance(e, dt) {'), src.indexOf('  _rank() {'));
  assert.ok(advance.length > 200, 'could not find _advance to inspect');
  assert.equal(
    (advance.match(/sweptPass\(/g) ?? []).length, 1,
    '_advance should reach the shared sweep exactly once'
  );
  assert.ok(
    !/cp\.radius \* cp\.radius/.test(advance),
    '_advance is testing the radius itself again'
  );
  assert.ok(
    !/yGap/.test(advance),
    '_advance is computing its own vertical gate again'
  );
});

/* ================================================================== */
/* 2. The race still races                                             */
/* ================================================================== */

/* The least canvas `Pickups`' sprite atlas needs; same stub race-payout.test.mjs
 * installs, and for the same reason - nothing here reads a pixel. */
const noopCtx = () => {
  const grad = { addColorStop() {} };
  const real = {
    createLinearGradient: () => grad, createRadialGradient: () => grad, createPattern: () => null,
    measureText: () => ({ width: 10 }), getLineDash: () => [],
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  };
  return new Proxy(real, { get: (o, k) => (k in o ? o[k] : () => undefined), set: () => true });
};
globalThis.document ??= {
  createElement(tag) {
    if (tag !== 'canvas') return {};
    return { width: 1, height: 1, getContext: () => noopCtx(), style: {} };
  },
};

const { RaceManager, RACE_STATE, makeTestCircuit } = await import('../../src/race/RaceManager.js');

const matCache = new Map();
const materials = {
  has: () => true,
  get: (k) => {
    if (!matCache.has(k)) matCache.set(k, new THREE.MeshStandardMaterial());
    return matCache.get(k);
  },
  register: (k, m) => matCache.set(k, m),
  tinted: (k) => materials.get(k),
};

/**
 * A manager holding the synthetic circuit `RaceManager.armTestCircuit` builds,
 * with only the player entered.
 *
 * No world, no physics bodies, no rivals: this half of the file is about the
 * cursor and the events, and a field of `RacerAI`s would only add noise to the
 * `race:lap` stream being asserted.
 */
function drivable() {
  const laps = [];
  const rings = [];
  const bus = {
    on: () => () => {},
    off() {},
    emit(name, payload) {
      if (name === 'race:lap') laps.push(payload);
      if (name === 'race:ring') rings.push(payload);
    },
  };
  const player = { position: new THREE.Vector3(), velocity: new THREE.Vector3(), teleport(v) { this.position.copy(v); }, setYaw() {} };
  const race = new RaceManager({
    scene: new THREE.Scene(), physics: null, bus, materials, player,
    mounts: null, economy: null, worldManager: null,
  });
  race.loadTrack(makeTestCircuit({}));
  return { race, bus, laps, rings, player };
}

/**
 * Put the player somewhere and run ONE `_advance` step, the way the fixed
 * update does. Returns the cursor afterwards.
 */
function step(race, entry, x, z, y = 0) {
  entry.position.set(x, y, z);
  race._advance(entry, 1 / 60);
  return entry.nextCp;
}

/** The player entry, armed at the grid the way `start()` leaves it. */
function armEntry(race) {
  const cps = race.track.checkpoints;
  const e = {
    id: 'player', name: 'Player', isPlayer: true,
    position: new THREE.Vector3(cps[0].x, cps[0].y, cps[0].z),
    nextCp: 1, cpDone: 0, lap: 1, finished: false,
    _px: cps[0].x, _pz: cps[0].z, _lapStart: 0,
  };
  race.entries = [e];
  race.order = [e];
  race._playerEntry = e;
  race.clock = 0;
  race.lapCount = 2;
  race.state = RACE_STATE.RACING;
  return e;
}

test('an ordered lap of the circuit still counts as exactly one lap', () => {
  const { race, laps } = drivable();
  const e = armEntry(race);
  const cps = race.track.checkpoints;
  // Walk the checkpoints in order, in small steps, exactly as a car would.
  for (let round = 0; round < 2; round++) {
    for (let i = 1; i <= cps.length; i++) {
      const cp = cps[i % cps.length];
      const from = cps[(i - 1) % cps.length];
      for (let k = 1; k <= 10; k++) {
        const t = k / 10;
        step(race, e, from.x + (cp.x - from.x) * t, from.z + (cp.z - from.z) * t, cp.y);
      }
      race.clock += 1;
    }
  }
  assert.equal(laps.length, 2, 'two ordered rounds of the circuit are two laps');
  assert.equal(laps[0].lap, 1);
  assert.equal(laps[1].lap, 2);
  assert.equal(laps[0].laps, 2);
  assert.equal(e.cpDone, cps.length * 2);
});

test('reversing back over the line does not tick a lap', () => {
  const { race, laps } = drivable();
  const e = armEntry(race);
  const cps = race.track.checkpoints;
  const line = cps[0];
  /* Stop on the line, back up, come forward again - the exact cheat the
   * cursor exists to refuse. The cursor is on checkpoint 1, so nothing here
   * can move it. */
  for (let i = 0; i < 40; i++) {
    const t = (i % 20) / 20;
    step(race, e, line.x + (t - 0.5) * 8, line.z, line.y);
  }
  assert.equal(laps.length, 0, 'a lap was credited for driving back and forth over the line');
  assert.equal(e.nextCp, 1, 'the cursor moved without the racer reaching checkpoint 1');
  assert.equal(e.cpDone, 0);
});

test('cutting the infield validates nothing', () => {
  const { race } = drivable();
  const e = armEntry(race);
  const cps = race.track.checkpoints;
  const last = cps[cps.length - 1];
  // Teleport straight to the last checkpoint: every checkpoint in between is
  // inert because the cursor never armed them.
  step(race, e, last.x, last.z, last.y);
  assert.equal(e.nextCp, 1, 'a shortcut to the far side of the circuit advanced the cursor');
  assert.equal(e.cpDone, 0);
});

test('a step long enough to tunnel a checkpoint still counts it', () => {
  const { race } = drivable();
  const e = armEntry(race);
  const cps = race.track.checkpoints;
  const cp = cps[1];
  /* One step from well before the checkpoint to well past it, with neither end
   * inside the radius. A point test scores this as a miss - which is the bug
   * the swept test exists to prevent, and the reason it had to survive the
   * extraction intact. */
  const ux = cp.x - cps[0].x;
  const uz = cp.z - cps[0].z;
  const d = Math.hypot(ux, uz) || 1;
  const before = { x: cp.x - (ux / d) * 40, z: cp.z - (uz / d) * 40 };
  const after = { x: cp.x + (ux / d) * 40, z: cp.z + (uz / d) * 40 };
  e.position.set(before.x, cp.y, before.z);
  e._px = before.x;
  e._pz = before.z;
  assert.ok(
    Math.hypot(before.x - cp.x, before.z - cp.z) > cp.radius
    && Math.hypot(after.x - cp.x, after.z - cp.z) > cp.radius,
    'the tunnelling case is not set up: one of the endpoints is inside the radius'
  );
  step(race, e, after.x, after.z, cp.y);
  assert.equal(e.nextCp, 2, 'the swept test did not catch a checkpoint the step passed straight through');
});

test('a bridge over the line is still refused by the vertical gate', () => {
  const { race } = drivable();
  const e = armEntry(race);
  const cp = race.track.checkpoints[1];
  // 14 m is the car race's fallback gate; 40 m up is a flyover.
  step(race, e, cp.x, cp.z, cp.y + 40);
  assert.equal(e.nextCp, 1, 'a pass 40 m over the checkpoint was counted');
  // ...and the same place at deck height is taken.
  step(race, e, cp.x, cp.z, cp.y);
  assert.equal(e.nextCp, 2, 'a pass at deck height was refused');
});

test('the swept tail advances on misses as well as hits', () => {
  /* The subtle half of the extraction: `_px/_pz` are written before the radius
   * early-return, so a racer that spends a hundred steps nowhere near the
   * checkpoint does not accumulate a hundred-step-long segment that then
   * sweeps half the circuit. */
  const { race } = drivable();
  const e = armEntry(race);
  const cps = race.track.checkpoints;
  const far = cps[Math.floor(cps.length / 2)];
  for (let i = 0; i < 50; i++) step(race, e, far.x + i, far.z + i, far.y);
  assert.equal(e._px, far.x + 49, 'the tail did not follow the racer on a miss');
  assert.equal(e._pz, far.z + 49, 'the tail did not follow the racer on a miss');
  assert.equal(e.nextCp, 1, 'wandering past the far side of the circuit advanced the cursor');
});
