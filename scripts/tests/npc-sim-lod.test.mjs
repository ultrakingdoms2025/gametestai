import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { NPCManager } from '../../src/npc/NPCManager.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The SIMULATION-rate band in `NPCManager` - `lod.sim` and the cadence in
 * `fixedUpdate`.
 *
 * Ablating `NPCManager.fixedUpdate` on the station measured -2.0 ms at the
 * plaza, -2.0 ms on the walkway loop and -3.6 ms in the construction court for
 * zero draw calls, so the crowd's think/steer/integrate work is worth banding.
 * Two things make that safe, and both are what these tests hold:
 *
 *   1. Nobody is switched off. A demoted character is simulated on one step in
 *      N and handed the N steps' worth of `dt` it banked, so it covers the same
 *      ground per wall-clock second. A frozen crowd at 100 m is worse than a
 *      slightly stuttery one.
 *   2. Every edge is a band. Cadence popping at a boundary is the failure mode,
 *      so a character loitering on a threshold must never change divisor.
 *
 * Everything below drives the REAL methods, so the bands cannot drift from the
 * shipped code the way a re-derivation would.
 */

const DT = 1 / 60;

/** A character that records the `dt` of every simulation step it is given. */
function stubNPC(x, seed = 0) {
  return {
    seed,
    position: new THREE.Vector3(x, 0, 0),
    height: 1.8,
    root: { visible: true },
    animator: { sunk: false },
    humanoid: { mesh: { castShadow: true }, hairMesh: null },
    lod: { distance: 0, ik: true, detail: true, rate: 1, visible: true, shadow: true, sim: 1 },
    _simAccum: 0,
    _simPhase: seed & 7,
    steps: [],
    fixedUpdate(dt) { this.steps.push(dt); },
  };
}

/** The real `_updateLOD`, with no camera so the distance band is what is under test. */
function runLOD(npcs, eyeX) {
  NPCManager.prototype._updateLOD.call({
    _npcs: npcs,
    engine: null,
    player: { position: new THREE.Vector3(eyeX, 0, 0) },
  });
}

/** The real `fixedUpdate`, with everything that is not the cadence stubbed out. */
function makeManager(npcs) {
  return {
    _npcs: npcs,
    _pauseUntil: 0,
    _coverToken: 0,
    _simStep: 0,
    _separateBodies() {},
    _updateRespawns() {},
    _updateChatProximity() {},
    _updateGroundingWatchdog() {},
    step(n = 1) {
      for (let i = 0; i < n; i++) NPCManager.prototype.fixedUpdate.call(this, DT, 1 + i * DT);
    },
  };
}

test('the divisor rises in bands with distance, and 135 m is the not-drawn band', () => {
  const npc = stubNPC(0);
  for (const [d, expected] of [[5, 1], [30, 1], [50, 2], [100, 4], [200, 8]]) {
    npc.lod.sim = 1;                 // approach each distance from full rate
    runLOD([npc], d);
    assert.equal(npc.lod.sim, expected, `at ${d} m the divisor was ${npc.lod.sim}, not ${expected}`);
  }
});

test('each cadence edge is a band: crossing out and crossing back are different distances', () => {
  const npc = stubNPC(0);

  // Walking away from a full-rate start: 36 is the OUT edge, so 35 must not demote.
  runLOD([npc], 35);
  assert.equal(npc.lod.sim, 1, 'demoted before reaching the outer edge');
  runLOD([npc], 37);
  assert.equal(npc.lod.sim, 2, 'past the outer edge and still at full rate');

  // Walking back in: 37 -> 33 is inside the band, so it must NOT promote yet.
  runLOD([npc], 33);
  assert.equal(npc.lod.sim, 2, 'the band has no width - 33 m both demotes and promotes');
  runLOD([npc], 31);
  assert.equal(npc.lod.sim, 1, 'inside the inner edge and still demoted');
});

test('a character loitering on a boundary never changes cadence', () => {
  /* The failure this exists to catch, as the player would see it: a character
   * standing at a switch distance, jostled by a neighbour or just swinging its
   * pelvis through a stride, flipping between 60 Hz and 30 Hz simulation every
   * frame. Jitter of +/-1.5 m - well over a stride - must produce exactly one
   * divisor for the whole run. */
  const npc = stubNPC(0);
  runLOD([npc], 37);                       // settle just outside the OUT edge
  const settled = npc.lod.sim;
  for (let i = 0; i < 400; i++) {
    runLOD([npc], 35.5 + Math.sin(i) * 1.5);
    assert.equal(npc.lod.sim, settled, `cadence flipped to ${npc.lod.sim} while loitering in the band`);
  }
});

test('a demoted character is slowed, not stopped, and is handed every second it banked', () => {
  /* Time conservation is the whole safety argument for the band: a character
   * simulated on one step in four with four steps of `dt` walks exactly as far
   * as one simulated on every step. If this drifts, distant crowds arrive late
   * (or early) at the places their state machines are steering for. */
  const near = stubNPC(0, 1);
  const far = stubNPC(0, 2);
  const mgr = makeManager([near, far]);
  near.lod.sim = 1;
  far.lod.sim = 4;

  mgr.step(240);                            // four wall-clock seconds

  const nearTotal = near.steps.reduce((a, b) => a + b, 0);
  const farTotal = far.steps.reduce((a, b) => a + b, 0);
  assert.equal(near.steps.length, 240, 'a full-rate character missed steps');
  assert.equal(far.steps.length, 60, 'a 1-in-4 character was not simulated at a quarter rate');
  assert.ok(far.steps.length > 0, 'the far character was frozen, not slowed');
  /* Every second is either spent or still owed - nothing is dropped. The
   * residual is whatever the far character banked since its last turn in the
   * cycle, which is why this is `+ _simAccum` rather than a bare equality. */
  assert.ok(Math.abs(nearTotal - (farTotal + far._simAccum)) < 1e-9,
    `the far character was handed ${farTotal.toFixed(4)}s + ${far._simAccum.toFixed(4)}s owed, `
    + `against the near one's ${nearTotal.toFixed(4)}s`);
  assert.ok(far._simAccum < DT * 4,
    `the far character is owed ${far._simAccum.toFixed(4)}s, more than one turn of its cycle`);
  /* From the second turn on, every step is exactly four steps' worth. The
   * first is short by however far into the cycle the character joined, which is
   * the correct answer for a body that has only existed for part of one. */
  for (const dt of far.steps.slice(1)) {
    assert.ok(Math.abs(dt - DT * 4) < 1e-9, `a 1-in-4 step carried ${dt}s, not four steps' worth`);
  }
  assert.ok(far.steps[0] > 0 && far.steps[0] <= DT * 4,
    `the first banded step carried ${far.steps[0]}s`);
});

test('demoted characters are spread across the cycle rather than all landing on one step', () => {
  /* Without a phase offset the saving is a sawtooth: seven cheap steps and one
   * that costs more than no banding at all, which is a stutter rather than a
   * speed-up. */
  const crowd = [];
  for (let i = 0; i < 64; i++) {
    const npc = stubNPC(0, i);
    npc.lod.sim = 8;
    crowd.push(npc);
  }
  const mgr = makeManager(crowd);
  const perStep = [];
  for (let i = 0; i < 8; i++) {
    for (const npc of crowd) npc.steps.length = 0;
    mgr.step(1);
    perStep.push(crowd.reduce((n, npc) => n + npc.steps.length, 0));
  }
  assert.equal(perStep.reduce((a, b) => a + b, 0), 64, 'one full cycle did not simulate everyone exactly once');
  const worst = Math.max(...perStep);
  assert.ok(worst <= 64 / 8 + 2,
    `the busiest step simulated ${worst} of 64 characters - the phase offset is not spreading the work`);
});

test('promotion pays out the debt in one step, and that step is capped', () => {
  const npc = stubNPC(0, 0);
  const mgr = makeManager([npc]);

  npc.lod.sim = 8;
  mgr.step(4);                              // bank four steps without firing
  assert.equal(npc.steps.length, 0, 'the phase-0 character fired inside its own cycle');
  npc.lod.sim = 1;                          // the player walks towards it
  mgr.step(1);
  assert.equal(npc.steps.length, 1);
  assert.ok(Math.abs(npc.steps[0] - DT * 5) < 1e-9,
    `promotion handed ${npc.steps[0]}s, not the five steps it owed`);

  // And the cap, which the bands themselves can never reach - it is there for a
  // stalled tab or a world build, where the alternative is a character
  // teleporting the length of the plaza.
  npc.steps.length = 0;
  npc._simAccum = 60;
  mgr.step(1);
  assert.ok(npc.steps[0] <= 0.4 + 1e-9, `an uncapped ${npc.steps[0]}s step reached _integrate`);
});

test('the cadence bands sit outside the pose bands and end at the draw band', async () => {
  /* The simulation must never be coarser than the animation sampling it, and
   * the last band must be the one where nothing is drawn at all - that is what
   * makes 1-in-8 defensible. Textual, because the pose rates are literals in
   * the LOD loop. */
  const src = await readFile(path.join(root, 'src/npc/NPCManager.js'), 'utf8');
  const num = (re) => Number(re.exec(src)?.[1]);
  const band = num(/const SIM_BAND = (\d+(?:\.\d+)?);/);
  const half = num(/const SIM_HALF_OUT = (\d+(?:\.\d+)?);/);
  const quarter = num(/const SIM_QUARTER_OUT = (\d+(?:\.\d+)?);/);
  const renderOut = num(/const RENDER_OUT = (\d+(?:\.\d+)?);/);
  assert.ok([band, half, quarter, renderOut].every(Number.isFinite),
    'the SIM_* bands are no longer plain constants next to the other LOD bands');
  assert.ok(band > 0 && half > band, `the hysteresis band (${band} m) does not fit under the first edge`);
  assert.ok(half < quarter && quarter < renderOut,
    `the cadence bands are not increasing: ${half} / ${quarter} / ${renderOut}`);

  assert.match(src, /const SIM_EIGHTH_OUT = RENDER_OUT;/,
    'the coarsest cadence band is no longer tied to the distance at which the body stops being drawn');

  // The pose rates, which the cadence bands must sit outside of.
  const rate = /lod\.rate = !lod\.visible \? 0\.12 : d < (\d+) \? 1 : d < (\d+) \? 0\.5 : d < (\d+) \? 0\.25 : 0\.1;/.exec(src);
  assert.ok(rate, 'the pose-rate bands moved - re-check the cadence bands against them');
  const poseHalf = Number(rate[2]);
  const poseQuarter = Number(rate[3]);
  assert.ok(half > poseHalf,
    `simulation drops to half rate at ${half} m but the pose is still at 1/2 out to ${poseHalf} m`);
  assert.ok(quarter > poseQuarter,
    `simulation drops to quarter rate at ${quarter} m but the pose is still at 1/4 out to ${poseQuarter} m`);
});
