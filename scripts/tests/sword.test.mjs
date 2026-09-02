import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import {
  makeBladeGeometry, swingArcAt, swingBearing, swingBladeDirection, swingBlend,
  trailSchedule,
} from '../../src/weapons/Sword.js';
import { WEAPON_STATS } from '../../src/systems/WeaponStats.js';

/**
 * The sword had no tests at all, and that is why the damage sweep shipped
 * running BACKWARDS along the blade's own arc.
 *
 * `_bearingAt` returned `dir * (half - 2*half*s)` - +50 degrees falling to -50 -
 * while the pose over the same `s` and the same `dir` rotated the model from
 * -1.02 to +1.24 radians, which is -58 rising to +71. Same swing, same sign
 * convention, opposite sense. Every target on the blade's leading side was
 * therefore cut LAST: the edge passed through it early in the window and the
 * damage arrived at the end, and a target the edge never reached until the last
 * frame was cut first. Nobody could see it because damage has no silhouette.
 *
 * That defect is only possible when one motion has two independent
 * descriptions, so the first case below is not "does the bearing look right" -
 * it is "does the bearing agree with the yaw the pose actually writes", and it
 * is checked against the old formula as well as the new one. A test that cannot
 * fail against the code that shipped the bug is worth nothing.
 *
 * ── What can and cannot be built here ─────────────────────────────────────
 * `SwordWeapon` itself cannot be constructed under Node: `_buildMaterials` goes
 * through `makeCanvas`, which is `document.createElement('canvas')`, and every
 * one of the five texture sets walks a 2D context pixel by pixel. Stubbing that
 * would be stubbing the thing under test. So this file exercises the exported
 * pure functions - which is precisely why the arc, the bearing, the blend and
 * the trail schedule were pulled out into pure functions in the first place,
 * and why `makeBladeGeometry` carries a comment saying it is exported so it can
 * be verified here. That comment had been true and unacted on since the file
 * was written.
 */

const SPEC = WEAPON_STATS.sword;
const DEG = Math.PI / 180;
const SRC = readFileSync(fileURLToPath(new URL('../../src/weapons/Sword.js', import.meta.url)), 'utf8');

/** Walk the damage window at a fixed step, oldest first. */
function acrossWindow(step = 0.005) {
  const out = [];
  for (let t = SPEC.strikeStart; t <= SPEC.strikeEnd + 1e-9; t += step) out.push(Math.min(t, SPEC.strikeEnd));
  return out;
}

/* ==================================================================== */
/* (f) The sweep and the blade                                          */
/* ==================================================================== */

test('the bearing agrees in SIGN with the yaw the pose writes - the old formula does not', () => {
  const arc = {};
  let checked = 0;
  let oldDisagreed = 0;

  for (const dir of [1, -1]) {
    for (const t of acrossWindow()) {
      swingArcAt(t, dir, arc);
      // What the pose puts on the two joints. `_updatePose` writes `yawPivot`
      // onto `_swingPivot.rotation.y` and `yaw` onto `_model.rotation.y`, and a
      // positive rotation about Y swings the point to the player's left - the
      // same direction `_sweep` calls a positive bearing.
      const visible = arc.yaw + arc.yawPivot;
      const bearing = swingBearing(t, dir);
      if (Math.abs(visible) < 2 * DEG) continue;
      checked++;
      assert.equal(
        Math.sign(bearing), Math.sign(visible),
        `t=${t.toFixed(3)} dir=${dir}: sweep bearing ${(bearing / DEG).toFixed(1)} deg `
        + `against a visible yaw of ${(visible / DEG).toFixed(1)} deg`,
      );
      // ...and of comparable magnitude. They are not equal and should not be:
      // bearing is the yaw of the blade's ground projection, and a blade held
      // 40 degrees above horizontal projects a WIDER bearing than its own yaw
      // (atan2(sin y, cos p * cos y) - dividing by cos p opens the angle). At
      // the extremes of the cut, where the pitch is greatest, that is worth
      // 13.4 degrees. The tolerance is set above that and well below the 100
      // degrees a sign error costs.
      assert.ok(
        Math.abs(bearing - visible) < 16 * DEG,
        `t=${t.toFixed(3)}: bearing ${(bearing / DEG).toFixed(1)} vs yaw ${(visible / DEG).toFixed(1)} deg`,
      );

      // The formula this replaced, reproduced exactly. `s` was the smoothstep
      // of the same clamped ramp, and this is what `_bearingAt` returned.
      const u = Math.max(0, Math.min(1, (t - 0.2) / 0.36));
      const sOld = u * u * (3 - 2 * u);
      const half = SPEC.arc * 0.5 * DEG;
      const legacy = dir * (half - 2 * half * sOld);
      if (Math.abs(legacy) > 2 * DEG && Math.sign(legacy) !== Math.sign(visible)) oldDisagreed++;
    }
  }

  assert.ok(checked > 80, `only ${checked} samples carried enough yaw to test`);
  // The regression this file exists for: the old formula must FAIL the check
  // above over most of the arc, or the check is not testing anything.
  assert.ok(
    oldDisagreed > checked * 0.6,
    `the retired formula disagreed on only ${oldDisagreed}/${checked} samples - `
    + 'this test would not have caught the bug it was written for',
  );
});

test('the swept arc is exactly SPEC.arc, centred on the aim direction', () => {
  const half = SPEC.arc * 0.5 * DEG;
  for (const dir of [1, -1]) {
    const a = swingBearing(SPEC.strikeStart, dir);
    const b = swingBearing(SPEC.strikeEnd, dir);
    // Within a thousandth of a degree: this is solved for at module load, not
    // hoped for. `SPEC.arc` is documented as the total sweep centred on aim and
    // for the life of this file it described nothing that happened on screen -
    // the pose swept 129 degrees, off-centre, against a declared 100.
    assert.ok(Math.abs(Math.abs(a) - half) < 1e-5, `start bearing ${(a / DEG).toFixed(4)} deg`);
    assert.ok(Math.abs(Math.abs(b) - half) < 1e-5, `end bearing ${(b / DEG).toFixed(4)} deg`);
    assert.ok(Math.abs(a + b) < 1e-5, 'the arc is not centred on the aim direction');
    assert.equal(Math.sign(a), -dir, 'the cut must start on the far side and cross');
  }
});

test('the two hands are exact mirrors, and the bearing crosses the arc once', () => {
  for (const t of acrossWindow()) {
    assert.ok(
      Math.abs(swingBearing(t, 1) + swingBearing(t, -1)) < 1e-9,
      `t=${t.toFixed(3)}: the alternating hand is not a mirror`,
    );
  }
  // Monotone: `_sweep` tests the BAND between two ticks, so an arc that
  // doubled back would hand it a band the edge never crossed.
  let prev = -Infinity;
  for (const t of acrossWindow(0.002)) {
    const b = swingBearing(t, 1);
    assert.ok(b >= prev - 1e-12, `bearing reversed at t=${t.toFixed(3)}`);
    prev = b;
  }
});

test('the ring-down never touches the yaw, so it cannot widen the sweep', () => {
  const end = {};
  swingArcAt(SPEC.strikeEnd, 1, end);
  const after = {};
  for (let t = SPEC.strikeEnd; t <= 1.0001; t += 0.01) {
    swingArcAt(t, 1, after);
    assert.equal(after.yaw, end.yaw, `yaw moved after the damage window at t=${t.toFixed(2)}`);
    assert.equal(after.yawPivot, end.yawPivot, `pivot yaw moved after the window at t=${t.toFixed(2)}`);
  }
  // ...but the blade is not parked: pitch and roll ring down through it.
  let moved = 0;
  for (let t = SPEC.strikeEnd + 0.01; t < 0.85; t += 0.01) {
    swingArcAt(t, 1, after);
    if (Math.abs(after.roll - end.roll) > 0.5 * DEG) moved++;
  }
  assert.ok(moved > 10, 'the recovery parks the blade instead of ringing it down');
});

test('the damage window sits strictly inside the full-weight swing pose', () => {
  // `swingBladeDirection` composes the swing pose alone. That is only the
  // blade's real direction where the blend is exactly 1, so the sweep is only
  // honest while this holds. Retune `_swingBlend` and this fails first.
  for (let t = SPEC.strikeStart; t <= SPEC.strikeEnd + 1e-9; t += 0.005) {
    assert.equal(swingBlend(Math.min(t, SPEC.strikeEnd)), 1, `blend is partial at t=${t.toFixed(3)}`);
  }
  assert.equal(swingBlend(-1), 0);
  assert.equal(swingBlend(1), 0);
  assert.ok(swingBlend(0.06) > 0 && swingBlend(0.06) < 1, 'the ramp-in must still ramp');
});

/* ==================================================================== */
/* (d) The timing                                                       */
/* ==================================================================== */

test('the arc is pinned to the damage window, so the two cannot drift apart', () => {
  const a = {};
  assert.equal(swingArcAt(SPEC.strikeEnd, 1, a).s, 1, 'the arc must complete exactly at strikeEnd');
  assert.ok(swingArcAt(SPEC.strikeStart, 1, a).s < 0, 'the damage window must open at the cock');
  assert.ok(swingArcAt(1, 1, a).s === 1, 'the arc must not run on past the window');
  // Named against the stats, not retyped from them.
  assert.match(SRC, /const LOAD_END = SPEC\.strikeStart;/);
  assert.match(SRC, /const STRIKE_END = SPEC\.strikeEnd;/);
});

test('the wind-up MOVES - it is not a cross-fade onto an already-cocked pose', () => {
  const a = {}; const b = {};
  // The old ramp was `clamp((t - 0.2) / 0.36, 0, 1)`, so the arc value was
  // exactly 0 for the whole first 0.2 of the timeline: the sword was already
  // cocked on frame one and only the blend weight moved. Nothing may plateau.
  let worst = Infinity;
  for (let t = 0.01; t < SPEC.strikeStart; t += 0.002) {
    const d = Math.abs(swingArcAt(t + 0.01, 1, b).s - swingArcAt(t, 1, a).s);
    if (d < worst) worst = d;
  }
  assert.ok(worst > 1e-4, `the wind-up stalls for at least one 0.01 window (min travel ${worst})`);
  // And it travels backwards first: a pre-cock, not a lean.
  const cocked = swingArcAt(SPEC.strikeStart, 1, a).s;
  assert.ok(cocked < -0.1, `the pre-cock is only ${cocked}`);
  assert.ok(
    swingBearing(SPEC.strikeStart, 1) < swingBearing(0.001, 1) - 10 * DEG,
    'the blade must visibly go back before it comes forward',
  );
});

test('the strike is front-loaded and the recovery starts where the arc ends', () => {
  // Where the snap comes from, given that `strikeStart`/`strikeEnd` live in
  // WeaponStats and were not moved: 80%+ of the arc inside the first 0.115 s.
  const half = SPEC.arc * 0.5 * DEG;
  const done = (t) => (swingBearing(t, 1) + half) / (2 * half);
  // +0.16 of the timeline is 0.115 s at the current swingTime.
  assert.ok(done(SPEC.strikeStart + 0.16) > 0.85, `only ${done(SPEC.strikeStart + 0.16).toFixed(2)} of the arc by +0.16`);
  assert.ok(done(SPEC.strikeStart + 0.04) > 0.3, 'the strike does not leave the cock hard enough');
  // ...and it decelerates into the follow-through rather than stopping dead.
  assert.ok(done(SPEC.strikeEnd - 0.04) > 0.97, 'the last of the arc is not a follow-through');
  // The old pair left 0.115 s of dead air: the arc finished at 0.56 and the
  // recovery ramp did not start until 0.62. It now starts at the arc's end.
  assert.match(
    SRC, /sstep\(STRIKE_END, 0\.95, t\)/,
    'the recovery ramp must begin at STRIKE_END, or the dead freeze is back',
  );
});

/* ==================================================================== */
/* (e) Secondary motion                                                 */
/* ==================================================================== */

test('the swing damps the idle motion instead of switching it off', () => {
  // `(1 - swing)` is exactly zero at full blend: no breathing, no bob and no
  // sway for the 0.4 s anyone is actually looking at the weapon.
  assert.doesNotMatch(SRC, /const anim = \(1 - aim \* 0\.7\) \* \(1 - swing\);/);
  const m = SRC.match(/const anim = \(1 - aim \* 0\.7\) \* \(1 - swing \* ([\d.]+)\);/);
  assert.ok(m, 'the idle gate is no longer in the form this test can read');
  const k = Number(m[1]);
  assert.ok(k > 0 && k < 1, `the swing must not zero the idle motion (factor ${k})`);
});

/* ==================================================================== */
/* (g) The trail                                                        */
/* ==================================================================== */

test('the trail window is frame-rate independent', () => {
  // 18 samples at one per frame is 0.30 s of arc at 60 Hz, 0.125 s at 144 -
  // under half the cut - and 0.60 s at 30, where it outlived the swing.
  const rate = (fps, seconds = 2) => {
    let accum = 0;
    let count = 0;
    const dt = 1 / fps;
    for (let i = 0; i < Math.round(fps * seconds); i++) {
      const r = trailSchedule(dt, accum);
      accum = r.accum;
      count += r.count;
    }
    return count / seconds;
  };

  const reference = rate(60);
  assert.ok(reference > 10, 'the ribbon must actually sample');
  for (const fps of [30, 45, 72, 90, 120, 144, 165, 240]) {
    const r = rate(fps);
    assert.ok(
      Math.abs(r - reference) <= 1,
      `${fps} Hz emits ${r}/s against ${reference}/s at 60 Hz`,
    );
    // The defect, stated directly: the sample rate must not be the frame rate.
    if (fps !== Math.round(reference)) {
      assert.notEqual(Math.round(r), fps, `${fps} Hz is still sampling once per frame`);
    }
  }
});

test('a hitch cannot queue a backlog of trail samples', () => {
  // A one-second stall has already overwritten every slot in the ring; carrying
  // its remainder would spend the next frames drawing arc nobody can see.
  const stall = trailSchedule(1.0, 0);
  assert.equal(stall.accum, 0);
  assert.ok(stall.count <= 18, `a stall emitted ${stall.count} samples into an 18-slot ring`);
  // And a frame short of a step owes nothing but keeps its credit.
  const tiny = trailSchedule(0.001, 0);
  assert.equal(tiny.count, 0);
  assert.ok(tiny.accum > 0.0009);
});

/* ==================================================================== */
/* The blade                                                            */
/* ==================================================================== */

test('makeBladeGeometry builds a closed, consistently wound, outward-facing solid', () => {
  const geo = makeBladeGeometry({
    halfWidth: 0.0245, halfThick: 0.0058, z0: -0.052, z1: -0.855,
  });
  const pos = geo.attributes.position.array;
  const nrm = geo.attributes.normal.array;
  const idx = geo.index.array;

  assert.ok(idx.length % 3 === 0, 'the index buffer is not whole triangles');
  for (const v of pos) assert.ok(Number.isFinite(v), 'a position is NaN');
  for (const v of nrm) assert.ok(Number.isFinite(v), 'a normal is NaN');

  const a = new THREE.Vector3(); const b = new THREE.Vector3(); const c = new THREE.Vector3();
  const ab = new THREE.Vector3(); const ac = new THREE.Vector3(); const n = new THREE.Vector3();
  const cross = new THREE.Vector3();

  // No degenerate triangles. A zero-area face contributes a zero-length normal
  // to `computeVertexNormals`, which is the defect that has bitten authored
  // geometry in this repo before and is invisible until something lights it.
  let volume = 0;
  for (let i = 0; i < idx.length; i += 3) {
    a.fromArray(pos, idx[i] * 3);
    b.fromArray(pos, idx[i + 1] * 3);
    c.fromArray(pos, idx[i + 2] * 3);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    n.crossVectors(ab, ac);
    assert.ok(n.length() * 0.5 > 1e-9, `degenerate triangle at index ${i}`);
    volume += a.dot(cross.crossVectors(b, c)) / 6;
  }

  // Closed and orientable: every directed edge is used exactly once, and its
  // reverse exists. A hole or a flipped face breaks one of the two.
  const edges = new Map();
  for (let i = 0; i < idx.length; i += 3) {
    for (const [p, q] of [[idx[i], idx[i + 1]], [idx[i + 1], idx[i + 2]], [idx[i + 2], idx[i]]]) {
      const key = `${p}:${q}`;
      assert.ok(!edges.has(key), `directed edge ${key} is used twice - two faces wound the same way`);
      edges.set(key, true);
    }
  }
  for (const key of edges.keys()) {
    const [p, q] = key.split(':');
    assert.ok(edges.has(`${q}:${p}`), `edge ${key} has no opposite twin - the surface is open`);
  }

  // Outward, not inward. On a closed consistently wound mesh the signed volume
  // is positive exactly when the winding faces out; a blade with the fuller
  // sunk into both flats has legitimately inward-pointing *radial* normals in
  // the groove, so this - not a per-face radial test - is the check that works.
  assert.ok(volume > 0, `the solid is wound inside-out (signed volume ${volume})`);
  // Sanity on the magnitude: a 0.8 m blade 49 mm wide and 11.6 mm thick cannot
  // enclose more than its bounding box, and should fill a fair share of it.
  const box = 0.803 * 0.049 * 0.0116;
  assert.ok(volume < box, `volume ${volume} exceeds the bounding box ${box}`);
  assert.ok(volume > box * 0.3, `volume ${volume} is implausibly hollow against ${box}`);

  // The extremities point the right way: out of the point, out of the base, and
  // out of the edge at the widest station.
  const verts = pos.length / 3;
  assert.ok(nrm[(verts - 2) * 3 + 2] < -0.9, 'the tip apex normal does not point out of the point');
  assert.ok(nrm[(verts - 1) * 3 + 2] > 0.9, 'the base cap normal does not point back down the tang');
  let widest = 0;
  for (let i = 0; i < verts; i++) if (Math.abs(pos[i * 3]) > Math.abs(pos[widest * 3])) widest = i;
  assert.ok(
    Math.sign(nrm[widest * 3]) === Math.sign(pos[widest * 3]),
    'the edge normal at the widest station points into the blade',
  );

  geo.dispose();
});

test('the blade tapers in both axes and runs out to a point', () => {
  const geo = makeBladeGeometry({
    halfWidth: 0.0245, halfThick: 0.0058, z0: -0.052, z1: -0.855, stations: 22,
  });
  const pos = geo.attributes.position.array;
  const P = (geo.attributes.position.count - 2) / 22;
  const stationSpan = (i) => {
    let w = 0; let th = 0;
    for (let j = 0; j < P; j++) {
      w = Math.max(w, Math.abs(pos[(i * P + j) * 3]));
      th = Math.max(th, Math.abs(pos[(i * P + j) * 3 + 1]));
    }
    return { w, th };
  };
  const root = stationSpan(0);
  const mid = stationSpan(11);
  const last = stationSpan(21);
  assert.ok(root.w > mid.w && mid.w > last.w, 'the blade does not narrow toward the point');
  assert.ok(root.th > mid.th && mid.th > last.th, 'the blade has no distal taper in thickness');
  assert.ok(last.w < root.w * 0.25, 'the point is a chisel end, not a point');
  // The fuller sinks into the flat near the hilt and is gone before the distal
  // taper - "exactly as a forged blade's does", per the file header. Measured
  // by differencing against a build with the groove switched off, which needs
  // no knowledge of which section points are the fuller's.
  const flat = makeBladeGeometry({
    halfWidth: 0.0245, halfThick: 0.0058, z0: -0.052, z1: -0.855, stations: 22, fullerDepth: 0,
  });
  const fpos = flat.attributes.position.array;
  const grooveAt = (i) => {
    let d = 0;
    for (let j = 0; j < P; j++) d = Math.max(d, Math.abs(pos[(i * P + j) * 3 + 1] - fpos[(i * P + j) * 3 + 1]));
    return d;
  };
  assert.equal(grooveAt(0), 0, 'the fuller must start at the ricasso, not at the guard');
  assert.ok(grooveAt(4) > 0.0005, 'no fuller in the forte');
  assert.equal(grooveAt(14), 0, 'the fuller runs past the distal third');
  assert.equal(grooveAt(21), 0, 'the fuller runs into the point');
  flat.dispose();
  geo.dispose();
});

/* ==================================================================== */
/* (a) (b) (c) The rig                                                  */
/* ==================================================================== */

test('the hand is not welded to the blade, and the swing pivots at the shoulder', () => {
  // The three structural facts the whole first-person read depends on. They are
  // not reachable through a pure function - the rig needs a canvas to build -
  // so they are pinned at the source, which is where they would be undone.
  assert.match(SRC, /this\._hand = new THREE\.Group\(\)/, 'the hand must be its own group');
  assert.match(
    SRC, /addMerged\(glove, this\.matGlove, 'hand', this\._hand\)/,
    'the glove must be merged into the hand, not into the sword model',
  );
  assert.match(
    SRC, /addMerged\(knuckle, this\.matFitting, 'knuckles', this\._hand\)/,
    'the knuckle steel must not merge back into the guard and pommel bucket',
  );
  assert.match(SRC, /this\._swingPivot\.position\.copy\(SHOULDER\)/, 'the pivot must sit at the shoulder');
  assert.match(SRC, /this\._swingPivot\.add\(this\._model\)/, 'the model must hang off the pivot');
  assert.match(
    SRC, /roll: \{ source: this\._hand, share: [\d.]+ \}/,
    'the arm must be given the hand as a roll source',
  );
  assert.match(SRC, /elbow: \{ fore: [\d.]+, upper: [\d.]+, pole:/, 'the sword arm must have an elbow');
  assert.match(SRC, /this\._arm\?\.solve\(dt\)/, 'the arm must be given a frame step so it can damp');
});

test('the shoulder carries a real share of the arc, and the wrist the rest', () => {
  const a = {};
  swingArcAt(SPEC.strikeEnd, 1, a);
  assert.ok(Math.abs(a.yawPivot) > 15 * DEG, 'the shoulder barely moves; this is still a wiper');
  assert.ok(Math.abs(a.yaw) > 15 * DEG, 'the wrist carries none of the arc');
  // Neither joint alone accounts for the sweep - which is the whole point:
  // rotating about the palm moved the hand 12 cm while the tip swept a metre.
  const total = Math.abs(a.yaw + a.yawPivot);
  assert.ok(Math.abs(a.yawPivot) < total * 0.75 && Math.abs(a.yaw) < total * 0.75);
});

test('a rotation about the shoulder cannot stretch the arm', () => {
  // The forearm used to stretch because the swing moved the hand while the
  // shoulder stayed put, and the previous fix was to lean the anchor to hide
  // it. Pivoting at the anchor makes the stretch impossible instead: the
  // hand-to-shoulder distance is invariant under the pivot's own rotation.
  const shoulder = new THREE.Vector3(0.27, -0.42, 0.14);
  const pivot = new THREE.Group();
  pivot.position.copy(shoulder);
  pivot.rotation.order = 'YXZ';
  const model = new THREE.Group();
  model.position.set(0.1 - shoulder.x, -0.12 - shoulder.y, -0.5 - shoulder.z);
  pivot.add(model);

  const arc = {};
  const at = new THREE.Vector3();
  let min = Infinity;
  let max = -Infinity;
  for (let t = 0; t <= 1.0001; t += 0.02) {
    swingArcAt(t, 1, arc);
    pivot.rotation.set(arc.pitchPivot, arc.yawPivot, 0, 'YXZ');
    pivot.updateMatrixWorld(true);
    at.setFromMatrixPosition(model.matrixWorld);
    const d = at.distanceTo(shoulder);
    min = Math.min(min, d);
    max = Math.max(max, d);
  }
  assert.ok(max - min < 1e-6, `the pivot changed the reach by ${(max - min).toExponential(2)} m`);
  assert.ok(min > 0.5, 'the hand is not on a plausible radius from the shoulder');
});

test('the shoulder pivot moves the hand a cut-sized distance', () => {
  // Rotating `_model` about its own origin - 4 cm inside the palm - moved the
  // hand ~12 cm while the point swept a metre. A real diagonal cut moves the
  // hand 30-60 cm around the shoulder and elbow.
  const shoulder = new THREE.Vector3(0.27, -0.42, 0.14);
  const pivot = new THREE.Group();
  pivot.position.copy(shoulder);
  pivot.rotation.order = 'YXZ';
  const model = new THREE.Group();
  model.position.set(0.1 - shoulder.x, -0.12 - shoulder.y, -0.5 - shoulder.z);
  pivot.add(model);

  const arc = {};
  const at = new THREE.Vector3();
  const prev = new THREE.Vector3();
  let path = 0;
  for (let t = SPEC.strikeStart; t <= SPEC.strikeEnd + 1e-9; t += 0.005) {
    swingArcAt(Math.min(t, SPEC.strikeEnd), 1, arc);
    pivot.rotation.set(arc.pitchPivot, arc.yawPivot, 0, 'YXZ');
    pivot.updateMatrixWorld(true);
    at.setFromMatrixPosition(model.matrixWorld);
    if (t > SPEC.strikeStart) path += at.distanceTo(prev);
    prev.copy(at);
  }
  assert.ok(path > 0.3, `the hand travelled only ${path.toFixed(3)} m through the cut`);
  assert.ok(path < 0.7, `the hand travelled ${path.toFixed(3)} m - that is a windmill, not a cut`);
});
