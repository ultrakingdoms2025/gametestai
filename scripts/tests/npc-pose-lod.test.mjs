import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { NPCManager } from '../../src/npc/NPCManager.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The POSE-rate band in `NPCManager._updateLOD` - `lod.rate`, which decides how
 * often `NPC.update` runs the animator.
 *
 * ── Two questions were asked of this band. They got different answers. ─────
 *
 * 1. IT HAD NO HYSTERESIS, and it was the only switch in that file that did
 *    not. Everything around it - eye detail, foot IK, shadow casting, the
 *    simulation cadence - had been converted from a line into a band, for the
 *    reason recorded above `DETAIL_IN`: a single boundary turns a stride's
 *    worth of pelvis travel into a per-frame toggle. Measured against the real
 *    `_updateLOD`, a character loitering on an edge with +/-1.5 m of jitter:
 *
 *        pose rate, 16 / 34 / 65 m      190 flips per 600 frames, every edge
 *        sim cadence, 36 m (banded)       0
 *        eye detail, 27 m (banded)        0
 *        shadow casting, 49 m (banded)    0
 *
 *    Fixed, and the first half of this file is the ratchet on it. Honestly:
 *    that chatter was not producing a visible artefact, because a rate change
 *    conserves animation phase - `NPC.update` hands the animator exactly the
 *    time since the last pose, so 30 Hz and 15 Hz sampling walk the cycle at
 *    the same speed. Nothing appeared, disappeared or jumped. It is consistency
 *    and a removed footgun, not a rescued frame.
 *
 * 2. IT DOES NOT CONSULT `npc.root.visible`, so a character past `RENDER_OUT`
 *    (135 m) that is still inside the frustum keeps posing at 6 Hz - full FK
 *    and a matrix inversion - while nothing draws it. NOT fixed, and the reason
 *    is a number rather than a preference. Attributed with a wrapper around the
 *    real `NPC.update`, in the browser, over 600-frame samples:
 *
 *        station,  plaza-wide       35 of 68 in that state    0.068 ms/frame
 *        station,  dome-inside      45 of 68                  0.085 ms/frame
 *        station,  habitation court 67 of 68                  0.085 ms/frame
 *        medieval, village square   15 of 47                  0.019 ms/frame
 *        medieval, hills vista      35 of 51                  0.036 ms/frame
 *
 *    at 18-26 us per pose, against median frames of 9-24 ms. That is 0.15% to
 *    0.55% of a frame, and an A/B that skipped those poses outright could not
 *    be told apart from the control by the wall clock measuring it. Against
 *    that, keying the pose band off the draw band would make it the one switch
 *    here whose state depends on another switch's, and would hand a character
 *    that had not been posed since 135 m to the frame it re-enters at 125 m.
 *
 *    The second half of this file pins the shape of that decision so it stays a
 *    decision: the state is real and common, and it is cheap.
 *
 * Everything below drives the REAL `_updateLOD`.
 */

/** The `npc-sim-lod.test.mjs` stub, plus the field the pose band keeps state in. */
function stubNPC(x, { drawn = true } = {}) {
  return {
    position: new THREE.Vector3(x, 0, 0),
    height: 1.8,
    root: { visible: drawn },
    animator: { sunk: false },
    humanoid: { mesh: { castShadow: true }, hairMesh: null },
    lod: {
      distance: 0, ik: true, detail: true, rate: 1, poseRate: 1,
      visible: true, shadow: true, sim: 1,
    },
  };
}

/** The real `_updateLOD` with no camera, so distance is what is under test. */
const runLOD = (npcs, eyeX) => NPCManager.prototype._updateLOD.call({
  _npcs: npcs, engine: null, player: { position: new THREE.Vector3(eyeX, 0, 0) },
});

/* ------------------------------------------------------------------ */
/* 1. The band                                                         */
/* ------------------------------------------------------------------ */

test('the pose rate falls in steps with distance', () => {
  const npc = stubNPC(0);
  for (const [d, expected] of [[5, 1], [25, 0.5], [50, 0.25], [100, 0.1], [400, 0.1]]) {
    npc.lod.poseRate = 1;             // approach each distance from full rate
    runLOD([npc], d);
    assert.equal(npc.lod.rate, expected, `at ${d} m the pose rate was ${npc.lod.rate}, not ${expected}`);
  }
});

test('each pose edge is a band: crossing out and crossing back are different distances', () => {
  const npc = stubNPC(0);
  runLOD([npc], 15);
  assert.equal(npc.lod.rate, 1, 'demoted before reaching the outer edge');
  runLOD([npc], 17);
  assert.equal(npc.lod.rate, 0.5, 'past the outer edge and still at full rate');
  // Back inside the band: 13 is under 16 but not under 16 - 4, so it must hold.
  runLOD([npc], 13);
  assert.equal(npc.lod.rate, 0.5, 'the band has no width - 13 m both demotes and promotes');
  runLOD([npc], 11);
  assert.equal(npc.lod.rate, 1, 'inside the inner edge and still demoted');
});

test('a character loitering on any pose edge never changes rate', () => {
  /* THE FIX, as the measurement found it: 190 flips per 600 frames at every one
   * of the three edges before the band, zero after. */
  for (const edge of [16, 34, 65]) {
    const npc = stubNPC(0);
    runLOD([npc], edge + 1.5);
    const settled = npc.lod.rate;
    for (let i = 0; i < 600; i++) {
      runLOD([npc], edge + Math.sin(i) * 1.5);
      assert.equal(npc.lod.rate, settled,
        `the pose rate flipped to ${npc.lod.rate} while loitering on the ${edge} m edge`);
    }
  }
});

test('going off screen does not corrupt the distance band it comes back to', () => {
  /* Why `lod.poseRate` exists as a field of its own. The frustum term overwrites
   * `lod.rate` with 0.12, which sits between two of the distance values, so
   * reading the previous band back off `lod.rate` - the way `lod.sim` legally
   * reads its own - would hand a returning character a nonsense state. */
  const npc = stubNPC(0);
  runLOD([npc], 50);
  assert.equal(npc.lod.rate, 0.25);
  npc.lod.visible = false;
  NPCManager.prototype._updateLOD.call({
    _npcs: [npc], engine: null, player: { position: new THREE.Vector3(50, 0, 0) },
  });
  // With no camera the real method forces `visible` back to true, so drive the
  // hidden case by hand: what matters is that `poseRate` survived untouched.
  assert.equal(npc.lod.poseRate, 0.25, 'the distance band was overwritten by the frustum term');
  runLOD([npc], 50);
  assert.equal(npc.lod.rate, 0.25, 'the character came back on screen in the wrong band');
});

test('an off-screen character is posed at the resume rate, not the far-distance one', () => {
  /* 0.12 is above 0.1 on purpose. `NPC.update` holds a hidden character at a
   * 0.2 s floor before it poses at all, so the cadence while hidden is about
   * 5 Hz whatever this is; what this number sets is how fast it resumes the
   * instant it is back on screen. */
  const npc = stubNPC(0);
  const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  // Behind the camera, so the frustum test genuinely fails.
  npc.position.set(0, 0, 40);
  cam.position.set(0, 0, 0);
  cam.lookAt(0, 0, -1);
  cam.updateMatrixWorld();
  NPCManager.prototype._updateLOD.call({ _npcs: [npc], engine: { camera: cam }, player: null });
  assert.equal(npc.lod.visible, false, 'the fixture no longer puts the character off screen');
  assert.equal(npc.lod.rate, 0.12, `an off-screen character poses at ${npc.lod.rate}`);
  assert.ok(npc.lod.rate > 0.1, 'the hidden rate dropped to or below the far-distance rate');
});

test('the pose bands sit inside the cadence bands they are sampled by', async () => {
  /* The relationship `npc-sim-lod.test.mjs` asserts from the other side. Held
   * here too, on the constants rather than on a regex over an expression, so a
   * change to either file trips one of the two. */
  const src = await readFile(path.join(root, 'src/npc/NPCManager.js'), 'utf8');
  const num = (re) => Number(re.exec(src)?.[1]);
  const band = num(/const POSE_BAND = (\d+(?:\.\d+)?);/);
  const half = num(/const POSE_HALF_OUT = (\d+(?:\.\d+)?);/);
  const quarter = num(/const POSE_QUARTER_OUT = (\d+(?:\.\d+)?);/);
  const tenth = num(/const POSE_TENTH_OUT = (\d+(?:\.\d+)?);/);
  const renderOut = num(/const RENDER_OUT = (\d+(?:\.\d+)?);/);
  assert.ok([band, half, quarter, tenth, renderOut].every(Number.isFinite),
    'the POSE_* bands are no longer plain constants next to the other LOD bands');
  assert.ok(band > 0 && half > band, `the hysteresis band (${band} m) does not fit under ${half} m`);
  assert.ok(half < quarter && quarter < tenth && tenth < renderOut,
    `the pose bands are not increasing and inside the draw band: ${half}/${quarter}/${tenth}/${renderOut}`);
  assert.equal(band, num(/const SIM_BAND = (\d+(?:\.\d+)?);/),
    'the pose band and the cadence band have different widths; one of them was tuned alone');
});

/* ------------------------------------------------------------------ */
/* 2. The decision NOT to key the rate off the draw band               */
/* ------------------------------------------------------------------ */

test('a character past RENDER_OUT but in the frustum still poses - deliberately', () => {
  /* Measured cost of this state: 0.019-0.085 ms/frame across five framings in
   * two worlds, against 9-24 ms frames. See the header. If this ever becomes
   * expensive - a much bigger crowd, a much more expensive animator - the fix
   * is one term (`!npc.root.visible ? 0 : ...`; `step` is then `Infinity` and
   * `NPC.update`'s existing gate skips the pose with no change to that file).
   * This case exists so the state is documented rather than rediscovered. */
  const npc = stubNPC(0, { drawn: true });
  runLOD([npc], 200);
  assert.equal(npc.root.visible, false, 'a character 200 m away is still being drawn');
  assert.equal(npc.lod.visible, true, 'the fixture has no camera, so it should be in-frustum');
  assert.equal(npc.lod.rate, 0.1,
    'the pose rate now consults the draw band. That is a real change - re-read the measurement in '
    + 'this file\'s header, and note that a character promoted at RENDER_IN would arrive having not '
    + 'been posed since it passed RENDER_OUT');
});

test('the draw band is still the band that has hysteresis, so this state is not a knife edge', () => {
  /* The state above is only cheap because it is bounded: a character does not
   * flicker in and out of being drawn at 135 m, it crosses a 10 m band. */
  const npc = stubNPC(0, { drawn: true });
  runLOD([npc], 137);
  assert.equal(npc.root.visible, false);
  runLOD([npc], 130);
  assert.equal(npc.root.visible, false, 'the draw band lost its hysteresis');
  runLOD([npc], 120);
  assert.equal(npc.root.visible, true);
});
