import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

/**
 * THE PERSONAL-BEST GHOST.
 *
 * ── The defect ────────────────────────────────────────────────────────────
 *
 * `RooftopTrial._paceRival` ran `par.chain / par.silver` metres a second, so
 * the rival on the roof literally WAS the silver par - the same rival on the
 * first run and on the fiftieth. `GhostCompetitor.place` accepts an arbitrary
 * position every fixed step and owns no pace logic, and NOTHING ANYWHERE IN
 * THE TREE recorded a replay of anything, so there was no other pace to give
 * it. Meanwhile `trial:checkpoint` had been firing with a time on it the
 * whole time.
 *
 * Two properties are worth more than the feature, and both are gated below:
 *
 *  1. **The replay cannot drive a body through a wall.** It is a polyline of
 *     PROGRESS, not of position, and the live route decides where a progress
 *     fraction is. A replay from a re-authored route is refused outright on
 *     top of that, so the failure mode is "no ghost", never "a ghost inside a
 *     building".
 *  2. **No ghost is the supported state.** A first run has none, a refused one
 *     has none, and both fall back to the analytic pace the contest shipped
 *     with - which is exactly what `GhostCompetitor.create` already does when
 *     there is no humanoid factory.
 *
 * ── The proof each gate can fail ──────────────────────────────────────────
 *
 * Run against the pre-change tree: every case in sections 1-3 fails to import
 * (`GhostReplay.js` did not exist), and the two in section 4 fail on the real
 * `RooftopTrial` - `a stored ghost drives the rival` because `_paceRival` was
 * unconditionally analytic, and `a finished run hands up a replay` because
 * `_finish` returned no `replay` key at all. Section 4's fallback case is the
 * regression guard and passes both before and after, by design.
 */

/* `RaceRings` builds label canvases at construction, exactly as in
 * `minigame-rooftop.test.mjs` - the same stub, for the same reason. */
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

const {
  GhostReplay, ReplayRecorder, courseKey, REPLAY_VERSION, REPLAY_MAX_SAMPLES,
} = await import('../../src/minigames/GhostReplay.js');
const {
  RooftopTrial, parTimes, chainLength, venueBounds,
} = await import('../../src/minigames/RooftopTrial.js');

const DT = 1 / 60;

/* ====================================================================== */
/* 1. The recorder                                                         */
/* ====================================================================== */

test('a recorder keeps a strictly ascending polyline and nothing else', () => {
  const r = new ReplayRecorder('k');
  assert.equal(r.mark(0, 0), true);
  assert.equal(r.mark(10, 0.3), true);
  /* Two checkpoints swept in one fixed step is a real case - see
   * `RooftopTrial._advance`, which can advance the cursor twice on one
   * segment. The second must be dropped rather than making time stand still. */
  assert.equal(r.mark(10, 0.4), false, 'a knot at the same time was kept');
  assert.equal(r.mark(9, 0.5), false, 'time went backwards');
  assert.equal(r.mark(12, 0.2), false, 'progress went backwards');
  assert.equal(r.mark(NaN, 0.5), false);
  assert.equal(r.mark(12, NaN), false);
  assert.equal(r.length, 2);
});

test('a run that did not reach the finish is not a ghost', () => {
  const r = new ReplayRecorder('k');
  r.mark(0, 0);
  r.mark(10, 0.4);
  /* No finishing knot. A ghost that stops four tenths of the way down the
   * route is a rival the player beats by walking. */
  assert.equal(r.serialize(), null);
});

test('a single knot is not a polyline', () => {
  const r = new ReplayRecorder('k');
  r.mark(0, 0);
  assert.equal(r.serialize(), null, 'a run that passed no checkpoint became a ghost');
});

test('a recorder with no course key refuses, because it could never be validated', () => {
  const r = new ReplayRecorder('');
  r.mark(0, 0);
  r.mark(10, 1);
  assert.equal(r.serialize(10), null);
});

test('serialize closes the polyline at the finish and rounds it small', () => {
  const r = new ReplayRecorder('k');
  r.mark(0, 0);
  r.mark(12.3456789, 0.333333333);
  r.mark(30.1, 0.777777777);
  const data = r.serialize(41.98765);
  assert.ok(data);
  assert.equal(data.v, REPLAY_VERSION);
  assert.equal(data.k, 'k');
  assert.equal(data.d, 41.988, 'the duration is not the finishing time, to the millisecond');
  assert.deepEqual(data.s, [0, 0, 12.346, 0.3333, 30.1, 0.7778, 41.988, 1]);

  /* THE SIZE BUDGET. This is the whole storage argument: a run is twenty
   * floats, not a position track. The longest citadel route has seven rings,
   * so eight knots, and this is a four-knot run in the same shape. */
  assert.ok(JSON.stringify(data).length < 120,
    `a four-knot replay serialised to ${JSON.stringify(data).length} bytes`);
});

test('the sample count is bounded whatever a venue publishes', () => {
  const r = new ReplayRecorder('k');
  for (let i = 0; i < REPLAY_MAX_SAMPLES * 3; i++) r.mark(i, i / (REPLAY_MAX_SAMPLES * 3));
  assert.equal(r.length, REPLAY_MAX_SAMPLES);
});

/* ====================================================================== */
/* 2. The course key                                                       */
/* ====================================================================== */

const line = (n, spacing = 40) =>
  Array.from({ length: n }, (_, i) => ({ x: i * spacing, y: 20.5, z: 0 }));

test('the course key moves when the route does, and not when a float wobbles', () => {
  const a = line(6);
  assert.equal(courseKey(a), courseKey(a.map((c) => ({ ...c }))));
  /* Sub-metre noise is the same route: `cacheSiteId` rounds for exactly this
   * reason, and invalidating every player's ghost over 4 mm would be a
   * self-inflicted wipe. */
  const jitter = a.map((c) => ({ ...c, x: c.x + 0.004 }));
  assert.equal(courseKey(jitter), courseKey(a));

  assert.notEqual(courseKey(line(7)), courseKey(a), 'a ring added did not move the key');
  assert.notEqual(courseKey(line(6, 41)), courseKey(a), 'a longer route did not move the key');
  /* A route re-anchored somewhere else at the same length and count. The
   * chain length alone would not notice this; the ends do. */
  const moved = a.map((c) => ({ ...c, z: c.z + 300 }));
  assert.notEqual(courseKey(moved), courseKey(a));
  assert.equal(courseKey([]), '', 'an unusable chain produced a key that could match');
});

/* ====================================================================== */
/* 3. Reading one back                                                     */
/* ====================================================================== */

const goodData = () => {
  const r = new ReplayRecorder('K');
  r.mark(0, 0);
  r.mark(10, 0.5);
  return r.serialize(20);
};

test('a replay reads back and interpolates between its knots', () => {
  const g = GhostReplay.from(goodData(), 'K');
  assert.ok(g);
  assert.equal(g.duration, 20);
  assert.equal(g.progressAt(0), 0);
  assert.equal(g.progressAt(5), 0.25);
  assert.equal(g.progressAt(10), 0.5);
  assert.equal(g.progressAt(15), 0.75);
  /* Past the end it HOLDS: a rival standing at the finish, which is the honest
   * picture of a run already over. */
  assert.equal(g.progressAt(20), 1);
  assert.equal(g.progressAt(500), 1);
  /* Before the first knot it interpolates from the ORIGIN, so a ghost never
   * teleports off the start line. */
  assert.equal(g.progressAt(-1), 0);
  assert.ok(g.paceAt(5) > 0);
  assert.equal(g.paceAt(25), 0, 'a finished ghost is still running');
});

test('a replay from a different course is refused, never partly trusted', () => {
  const data = goodData();
  assert.equal(GhostReplay.from(data, 'DIFFERENT'), null);
  assert.equal(GhostReplay.from(data, ''), null);
  assert.equal(GhostReplay.from(data, null), null);
  assert.ok(GhostReplay.from(data, 'K'), 'the matching key was refused too');
});

test('a replay from another schema version is refused', () => {
  assert.equal(GhostReplay.from({ ...goodData(), v: REPLAY_VERSION + 1 }, 'K'), null);
  assert.equal(GhostReplay.from({ ...goodData(), v: 0 }, 'K'), null);
});

test('a hand-edited replay is refused rather than read out of order', () => {
  const bad = (s) => GhostReplay.from({ v: REPLAY_VERSION, k: 'K', d: 20, s }, 'K');
  assert.equal(bad([10, 0.5, 0, 0]), null, 'an unsorted polyline was accepted');
  assert.equal(bad([0, 0, 10, 0.5, 10, 0.9]), null, 'a repeated time was accepted');
  assert.equal(bad([0, 0.9, 10, 0.5]), null, 'progress running backwards was accepted');
  assert.equal(bad([0, 0, 10, 4]), null, 'progress above 1 was accepted');
  assert.equal(bad([0, 0, -1, 0.5]), null);
  assert.equal(bad([0, 0, 10]), null, 'an odd-length sample list was accepted');
  assert.equal(bad([0, 0]), null, 'a one-knot polyline was accepted');
  assert.equal(bad('nope'), null);
  assert.equal(GhostReplay.from(null, 'K'), null);
  assert.equal(GhostReplay.from([1, 2], 'K'), null);
});

/* ====================================================================== */
/* 4. The trial, driven for real                                           */
/* ====================================================================== */

function makeVenue(cps) {
  const b = venueBounds(cps);
  return {
    id: 'test_route',
    kind: 'rooftop',
    label: 'Test Rooftop Route',
    centre: b.centre,
    radius: b.radius,
    yTolerance: b.yTolerance,
    reward: 12,
    config: { checkpoints: cps, ringRadius: 2.6, routeLength: chainLength(cps) },
    rival: { name: 'Nadira the Swift' },
  };
}

/**
 * A trial with a bare-position player and an optional save.
 *
 * No scene and no factory, so `GhostCompetitor.create` answers null and the
 * body is absent - which is the documented headless path and leaves
 * `rivalDist` as the thing under test. `rivalDist` is the ONE number the body,
 * the HUD row and the progress marker all read, so gating it gates all three.
 */
function makeTrial(cps, save = null) {
  const player = { position: new THREE.Vector3(cps[0].x, cps[0].y + 0.875, cps[0].z) };
  const bus = { on: () => () => {}, off() {}, emit() {} };
  const trial = new RooftopTrial(makeVenue(cps), { player, bus, save });
  return { trial, player };
}

/** Sweep every ring in order, one per fixed step, finishing at `finishAt`. */
function runThrough(trial, player, cps, times) {
  let out = null;
  for (let i = 1; i < cps.length; i++) {
    trial._px = cps[i].x - 1;
    trial._pz = 0;
    player.position.set(cps[i].x, cps[i].y + 0.875, 0);
    out = trial.fixedUpdate(DT, times[i - 1]);
    if (out) return out;
  }
  return out;
}

test('with no stored ghost the rival is the analytic silver par, exactly as before', () => {
  const cps = line(6);
  const { trial } = makeTrial(cps);
  assert.equal(trial.replay, null);
  assert.equal(trial.racingSelf, false);
  assert.equal(trial.rivalName, 'Nadira the Swift');
  trial.begin(0);
  trial.fixedUpdate(DT, 10);
  assert.ok(Math.abs(trial.rivalDist - trial.rivalPace * 10) < 1e-9,
    'the fallback pace is no longer the silver par');
  // ..and it arrives at the finish exactly at the silver par.
  trial.fixedUpdate(DT, trial.par.silver);
  assert.ok(Math.abs(trial.rivalDist - trial.par.chain) < 1e-6);
  trial.dispose();
});

test('a finished run hands up a replay of itself, and a cut-off one does not', () => {
  const cps = line(6);
  const par = parTimes(cps, chainLength(cps));
  const { trial, player } = makeTrial(cps);
  trial.begin(0);
  const times = [4, 9, 14, 19, par.gold - 1];
  const out = runThrough(trial, player, cps, times);
  assert.ok(out, 'the run never finished');
  assert.equal(out.won, true);
  assert.ok(out.replay, 'a completed win handed up no replay');
  assert.equal(out.replay.k, trial.courseKey);
  assert.equal(out.replay.d, Number((par.gold - 1).toFixed(3)));
  /* One knot per ring taken, plus the start line. The finishing knot the
   * recorder adds coincides with the last ring - same time, progress already
   * 1 - so it is refused as a duplicate rather than doubling the last point,
   * which is what `mark`'s strictly-ascending rule is for. Six rings is six
   * knots and twelve floats: the storage claim, gated. */
  assert.equal(out.replay.s.length, 2 * cps.length,
    'one knot per ring plus the start line');
  assert.ok(JSON.stringify(out.replay).length < 200,
    `a whole run serialised to ${JSON.stringify(out.replay).length} bytes`);
  trial.dispose();

  /* A run called off at the timeout. `_finish(false)` must hand up nothing:
   * the recorder refuses an unfinished polyline, and a partial ghost would be
   * a rival who stops halfway down the roof. */
  const b = makeTrial(cps);
  b.trial.begin(0);
  b.trial._px = cps[1].x - 1;
  b.trial._pz = 0;
  b.player.position.set(cps[1].x, cps[1].y + 0.875, 0);
  b.trial.fixedUpdate(DT, 1);
  const timedOut = b.trial.fixedUpdate(DT, par.timeout + 1);
  assert.ok(timedOut && !timedOut.won);
  assert.equal(timedOut.replay, null, 'an abandoned run was stored as a ghost');
  b.trial.dispose();
});

test('a stored ghost drives the rival, and says who it is', () => {
  const cps = line(6);
  const par = parTimes(cps, chainLength(cps));

  /* Set a record the honest way: run the real trial, keep what it hands up. */
  const first = makeTrial(cps);
  first.trial.begin(0);
  const out = runThrough(first.trial, first.player, cps, [4, 9, 14, 19, par.gold - 1]);
  const stored = out.replay;
  first.trial.dispose();

  const save = {
    bestTrialTime: () => par.gold - 1,
    bestTrialMedal: () => 'gold',
    bestTrialReplay: () => stored,
  };
  const { trial } = makeTrial(cps, save);
  assert.ok(trial.replay, 'the stored ghost was refused on its own route');
  assert.equal(trial.racingSelf, true);
  assert.equal(trial.rivalName, 'your best run',
    'the card would say "you beat Nadira the Swift" for beating yourself');
  assert.equal(trial.bestMedal, 'gold');

  trial.begin(0);
  /* The recorded run was at ring 2 (of 5 legs) at t = 9, so the ghost must be
   * exactly two fifths of the CHAIN along - not `rivalPace * 9`. */
  trial.fixedUpdate(DT, 9);
  const twoFifths = trial.par.chain * (2 / 5);
  assert.ok(Math.abs(trial.rivalDist - twoFifths) < 0.05,
    `the ghost is at ${trial.rivalDist.toFixed(2)} m, not the recorded ${twoFifths.toFixed(2)} m`);
  assert.ok(Math.abs(trial.rivalDist - trial.rivalPace * 9) > 1,
    'the ghost is still running the analytic pace');

  // And it finishes at the recorded time, which is what makes it a rival.
  trial.fixedUpdate(DT, par.gold - 1);
  assert.ok(Math.abs(trial.rivalDist - trial.par.chain) < 1e-6);
  trial.dispose();
});

test('a ghost recorded on a route since re-authored is refused, not driven', () => {
  const cps = line(6);
  const par = parTimes(cps, chainLength(cps));
  const first = makeTrial(cps);
  first.trial.begin(0);
  const stored = runThrough(first.trial, first.player, cps, [4, 9, 14, 19, par.gold - 1]).replay;
  first.trial.dispose();

  /* The world rebuilt: one more ring, a longer chain. The stored progress
   * fractions are fractions of a chain that no longer exists. */
  const rebuilt = line(8);
  const save = { bestTrialReplay: () => stored, bestTrialMedal: () => null };
  const { trial } = makeTrial(rebuilt, save);
  assert.equal(trial.replay, null, 'a replay from a different route drove the body');
  assert.equal(trial.racingSelf, false);
  assert.equal(trial.rivalName, 'Nadira the Swift',
    'the authored pacesetter did not come back when the ghost was refused');
  trial.begin(0);
  trial.fixedUpdate(DT, 10);
  assert.ok(Math.abs(trial.rivalDist - trial.rivalPace * 10) < 1e-9);
  trial.dispose();
});

test('a save that knows nothing about replays is the ordinary path', () => {
  /* Every existing player, and every headless harness. A `save` with none of
   * the three readers must not throw and must not change the contest. */
  const cps = line(6);
  const { trial } = makeTrial(cps, {});
  assert.equal(trial.replay, null);
  assert.equal(trial.bestMedal, null);
  assert.equal(trial.best, null);
  trial.dispose();
});
