import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { makeProportions, buildSkeletonSpec, createSkeleton } from '../../src/npc/Humanoid.js';
import { NPCAnimator } from '../../src/npc/NPCAnimator.js';

/**
 * THE AIM CROSSFADE MAY NOT TELEPORT THE FOREARM.
 *
 * `NPCAnimator._poseAimArms` used to blend the FK arm swing toward the IK aim
 * pose with a single slerp weighted by `aimWeight`. At sprint amplitude those
 * two poses are very nearly ANTIPODAL at the elbow - measured with a
 * per-frame quaternion probe on the code as it stood, the forearm slerp's two
 * endpoints sat 177-180 degrees apart (about 128 degrees of bone direction,
 * the rest twist: basisQuat resolves roll from the bend plane, the FK layer
 * from authored eulers). A slerp across 180 degrees is genuinely ambiguous -
 * which great circle it takes is the sign of a dot product - and because the
 * FK endpoint oscillates with the gait, that sign flipped mid-blend.
 *
 * Measured on the pre-fix code, this exact drive, worst single frame:
 *
 *   raise  (weight 0.39-0.56)   152.3 - 171.0 degrees, foreArm/hand
 *   lower  (weight 0.39-0.44)   152.3 - 172.9 degrees, the same bones
 *
 * against a p50 well under 2 degrees. Every NPC that raised or lowered a
 * weapon while moving hit it; the player only escaped because a sprint parks
 * `aimWeight` at 1 and drops the muzzle TARGET instead (see PlayerAvatar,
 * "STOWING THE CARBINE FOR A SPRINT").
 *
 * The fix routes the crossfade instead of straightening it: below
 * AIM_RAISE_START the layer arms itself against an anchor pose that IS the FK
 * swing re-expressed by the solver (hand target on the FK wrist, pole on the
 * FK elbow, twist reference from the FK basis - exact, so arming moves
 * nothing); above it the layer holds full authority while the wrist targets
 * sweep on an arc around the shoulder up onto the weapon, on their own clock
 * (AIM_RAISE_RATE - `aimWeight` decays 1 to 0.35 in nine frames when
 * lowering, and a sweep slaved to the weight covered its travel at 80-90
 * degrees a frame). Far-apart slerp endpoints now only ever coincide with a
 * blend parameter of 1, where slerp is a copy and a great-circle swap costs
 * nothing.
 *
 * These tests drive a real skeleton through the real `update()` and measure
 * WORLD orientations - what a player actually sees - exactly like
 * player-pose-continuity.test.mjs, and for the same reason: all of this was
 * found by measurement, not by reading the source, where the old code looked
 * perfectly reasonable.
 */

const HUMAN = { build: 2, frame: 0, shoulderScale: 1.2 };
/** The long-armed hero body plan - it found two real defects in this fix
 *  (a chord-path forearm whip and a twist-reference projection whip) that the
 *  human rig never showed, so it stays in the net. */
const APE = { build: 2, frame: 0, shoulderScale: 1.2, ape: 1 };

const ARM_BONES = ['upperArmR', 'foreArmR', 'handR', 'upperArmL', 'foreArmL', 'handL'];

function makeRig(seed = 7, opts = HUMAN) {
  const P = makeProportions(opts);
  const spec = buildSkeletonSpec(P);
  const { skeleton, bones, byName, root: boneRoot } = createSkeleton(spec);
  const root = new THREE.Group();
  const rig = new THREE.Group();
  root.add(rig);
  rig.add(boneRoot);
  const humanoid = {
    P, spec, skeleton, boneRoot,
    bones: byName, boneList: bones,
    root, rig, heightScale: 1,
    headBone: byName.get('head'), eyes: [],
  };
  return { anim: new NPCAnimator({ humanoid, physics: null, seed }), root, byName };
}

/**
 * Drive a raise at `raiseAt` and a lower at `lowerAt` (the target stays live,
 * only the want drops - the honest lowering path, and the one HostileNPC's
 * combat loop takes) and report the worst single-frame world move per window.
 */
function drive({ fps = 60, speed = 6, turn = 0, aimY = 1.45, seed = 7, opts = HUMAN }) {
  const DT = 1 / fps;
  const frames = Math.round(12 * fps);
  const raiseAt = Math.round(2.5 * fps);
  const lowerAt = Math.round(7 * fps);
  const { anim, root } = makeRig(seed, opts);
  const target = new THREE.Vector3(0, aimY, -12);
  const prev = new Map();
  const scratch = new THREE.Quaternion();
  const win = () => ({ worst: 0, bone: '', at: -1, travel: new Map() });
  const windows = { raise: win(), lower: win() };
  for (let i = 0; i < frames; i++) {
    anim.setLocomotion(speed, turn);
    if (i === raiseAt) anim.setAimTarget(target);
    if (i === lowerAt) anim.setAiming(false);
    anim.update(DT, i * DT, { ik: false, detail: false });
    root.updateMatrixWorld(true);
    const w = i >= lowerAt ? windows.lower : i >= raiseAt ? windows.raise : null;
    for (const name of ARM_BONES) {
      const b = anim.byName.get(name);
      b.getWorldQuaternion(scratch);
      const p = prev.get(name);
      if (p && w) {
        const dot = Math.min(1, Math.abs(p.dot(scratch)));
        // Normalised to degrees per 16.7 ms so frame rates compare honestly.
        const deg = (2 * Math.acos(dot) * 180 / Math.PI) * (fps / 60);
        w.travel.set(name, (w.travel.get(name) ?? 0) + deg);
        if (deg > w.worst) { w.worst = deg; w.bone = name; w.at = i; }
      }
      prev.set(name, scratch.clone());
    }
  }
  return { windows, anim };
}

/**
 * The pre-fix worst was 152-173: a cut, not a blend. 30 is the brief's bar;
 * the measured post-fix worst across every drive below is 19.7.
 */
const MAX_STEP_DEG = 30;
/** And the biggest frame may not be the whole journey (share, as in
 *  player-pose-continuity.test.mjs). Pre-fix the flip WAS the journey. */
const MAX_SHARE = 0.25;

function assertWindow(w, label) {
  const total = w.travel.get(w.bone) ?? 0;
  const share = total > 1 ? w.worst / total : 0;
  const detail = `${label}: worst ${w.worst.toFixed(1)} deg on ${w.bone} at frame ${w.at}`
    + ` (${(share * 100).toFixed(1)}% of that bone's travel in the window)`;
  assert.ok(w.worst < MAX_STEP_DEG, detail);
  assert.ok(share < MAX_SHARE, detail);
}

test('raising and lowering the carbine at sprint amplitude blends, both directions', () => {
  for (const seed of [7, 1234]) {
    for (const aimY of [0.8, 1.45, 2.4]) {
      const { windows } = drive({ speed: 6, seed, aimY });
      assertWindow(windows.raise, `raise sprint seed=${seed} aimY=${aimY}`);
      assertWindow(windows.lower, `lower sprint seed=${seed} aimY=${aimY}`);
    }
  }
});

test('an idle raise and a walking raise blend the same way', () => {
  for (const speed of [0, 1.6]) {
    const { windows } = drive({ speed });
    assertWindow(windows.raise, `raise speed=${speed}`);
    assertWindow(windows.lower, `lower speed=${speed}`);
  }
});

test('turning in place while raising does not flip either', () => {
  const { windows } = drive({ speed: 0.2, turn: 2.0 });
  assertWindow(windows.raise, 'raise while turning');
  assertWindow(windows.lower, 'lower while turning');
});

test('the ape body plan sweeps its longer arms just as cleanly', () => {
  const { windows } = drive({ speed: 6, opts: APE });
  assertWindow(windows.raise, 'ape raise');
  assertWindow(windows.lower, 'ape lower');
});

test('the sweep is frame-rate honest at 30 and 120 fps', () => {
  for (const fps of [30, 120]) {
    const { windows } = drive({ fps, speed: 6 });
    assertWindow(windows.raise, `raise fps=${fps}`);
    assertWindow(windows.lower, `lower fps=${fps}`);
  }
});

/**
 * The PlayerAvatar contract. A direct write of `aimWeight = 1` is the respawn
 * park ("parked, not ramped") and must mean the FINISHED aim pose - and a
 * naturally ramped raise must settle onto exactly that pose, because at
 * weight 1 the routed crossfade reduces to the pre-fix math bit for bit.
 */
test('a parked weight is the finished pose and a ramped raise lands on it exactly', () => {
  const DT = 1 / 60;
  const target = new THREE.Vector3(0, 1.45, -12);
  const A = makeRig(7);
  const B = makeRig(7);
  for (let i = 0; i < 700; i++) {
    A.anim.setLocomotion(6, 0);
    B.anim.setLocomotion(6, 0);
    if (i === 150) {
      A.anim.setAimTarget(target); // natural ramp
      B.anim.setAimTarget(target); // the park gesture
      B.anim.aimWeight = 1;
    }
    A.anim.update(DT, i * DT, { ik: false, detail: false });
    B.anim.update(DT, i * DT, { ik: false, detail: false });
  }
  A.root.updateMatrixWorld(true);
  B.root.updateMatrixWorld(true);
  const qa = new THREE.Quaternion();
  const qb = new THREE.Quaternion();
  for (const name of ARM_BONES) {
    A.byName.get(name).getWorldQuaternion(qa);
    B.byName.get(name).getWorldQuaternion(qb);
    const deg = 2 * Math.acos(Math.min(1, Math.abs(qa.dot(qb)))) * 180 / Math.PI;
    assert.ok(deg < 0.05, `${name}: ramped and parked settle ${deg.toFixed(3)} deg apart`);
  }
});

/**
 * The gate is `aimWeight > 0.001 && aimTarget`, and it must stay exactly
 * that: PlayerAvatar routes around this solver on the strength of it, and
 * its pose-continuity suite measures against it.
 */
test('no target, or a negligible weight, means the aim solve never runs', () => {
  const DT = 1 / 60;
  const control = makeRig(7);
  const noTarget = makeRig(7);
  const tinyWeight = makeRig(7);
  const target = new THREE.Vector3(0, 1.45, -12);
  for (let i = 0; i < 120; i++) {
    for (const { anim } of [control, noTarget, tinyWeight]) anim.setLocomotion(6, 0);
    if (i === 30) {
      // Weight without a target: the gate's second clause.
      noTarget.anim.aimWeight = 1;
      noTarget.anim._aimWant = 1;
      // A target without weight: the first clause. 0.0009 sits under 0.001.
      tinyWeight.anim.aimTarget = target;
      tinyWeight.anim.aimWeight = 0.0009;
    }
    for (const { anim } of [control, noTarget, tinyWeight]) {
      anim.update(DT, i * DT, { ik: false, detail: false });
      // Freeze the blends the drives above would otherwise move.
      if (i >= 30) { noTarget.anim.aimWeight = 1; tinyWeight.anim.aimWeight = 0.0009; }
    }
  }
  const qa = new THREE.Quaternion();
  const qb = new THREE.Quaternion();
  control.root.updateMatrixWorld(true);
  for (const rig of [noTarget, tinyWeight]) {
    rig.root.updateMatrixWorld(true);
    for (const name of ARM_BONES) {
      control.byName.get(name).getWorldQuaternion(qa);
      rig.byName.get(name).getWorldQuaternion(qb);
      const deg = 2 * Math.acos(Math.min(1, Math.abs(qa.dot(qb)))) * 180 / Math.PI;
      // 1e-3 deg: far under anything visible, comfortably above the ~1e-5 deg
      // noise floor of acos on matrix-decomposed world quaternions.
      assert.ok(deg < 1e-3, `${name}: gated-off solver still moved the arm ${deg.toFixed(5)} deg`);
    }
  }
});
