import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import {
  makeProportions,
  buildSkeletonSpec,
  createSkeleton,
  handLandmarks,
  HumanoidFactory,
} from '../../src/npc/Humanoid.js';
import { NPCAnimator, GRIPS } from '../../src/npc/NPCAnimator.js';
import { WEAPON_MOUNTS, weaponHold } from '../../src/npc/NPCWeapons.js';

/**
 * HANDS THAT GRIP, AND AN OFF HAND THAT IS ON THE WEAPON.
 *
 * Two defects, one rig change.
 *
 * 1. `buildSkeletonSpec` defined 22 bones and none of them was a finger. The
 *    whole hand - palm, four digits, thumb - weighted to `hand` and `foreArm`,
 *    and the finger curl was BAKED INTO THE VERTICES at build time, so every
 *    character in the game held every object with the same permanently
 *    half-open hook and a weapon was pushed into it and intersected.
 *
 * 2. `NPCAnimator._poseAimArms` sent the left hand to a hardcoded 0.44 m from
 *    the chest along the aim direction, for every weapon in the game. Measured
 *    against the shipped `WEAPON_MOUNTS`: that is 36% of the way down a
 *    rifle's handguard, and it is 7 cm PAST THE END of a pistol's 0.169 m
 *    barrel. A staff is 1.083 m long and got the same 0.44.
 *
 * These tests drive the real `NPCAnimator` through the real `update()` and
 * measure WORLD positions - what a player actually sees - for the same reason
 * npc-aim-singularity.test.mjs does: the old code read perfectly reasonably.
 *
 * WHAT FAILS ON THE OLD CODE, checked by re-deriving the old numbers rather
 * than by trusting the assertion to be sharp: `offHandAlongBarrel` below
 * returns 0.24 m for EVERY weapon under a constant 0.44 reach, and the pistol
 * and bow cases assert values that 0.24 cannot satisfy (a pistol's whole
 * barrel is 0.169 m; the bow's off hand must come out NEGATIVE, behind the
 * grip). `every weapon is held differently` asserts the spread directly.
 */

const HUMAN = { build: 2, frame: 0, shoulderScale: 1.2 };

/** A rig with a prop in the right hand, driven by the real animator. */
function makeRig({ model = 'rifle', opts = HUMAN, seed = 7 } = {}) {
  const P = makeProportions(opts);
  const spec = buildSkeletonSpec(P);
  const { skeleton, bones, byName, root: boneRoot } = createSkeleton(spec);
  const root = new THREE.Group();
  const rig = new THREE.Group();
  root.add(rig);
  rig.add(boneRoot);

  // Exactly what `HumanoidFactory.create` builds: an identity child of handR.
  const weaponMount = new THREE.Object3D();
  byName.get('handR').add(weaponMount);
  let prop = null;
  if (model) {
    const m = WEAPON_MOUNTS[model];
    prop = new THREE.Object3D();
    prop.position.set(m.pos[0], m.pos[1], m.pos[2]);
    prop.rotation.set(m.rot[0], m.rot[1], m.rot[2]);
    prop.userData.hold = weaponHold(model);
    weaponMount.add(prop);
  }

  const humanoid = {
    P, spec, skeleton, boneRoot,
    bones: byName, boneList: bones,
    root, rig, heightScale: 1, weaponMount,
    headBone: byName.get('head'), eyes: [],
  };
  const anim = new NPCAnimator({ humanoid, physics: null, seed });
  return { anim, root, byName, spec, prop, model, P };
}

/** Run to steady state at a full aim hold on a target straight ahead. */
function settle(r, { seconds = 1.5, aimY = 1.45, speed = 0 } = {}) {
  const { anim, root } = r;
  anim.setAimTarget(new THREE.Vector3(0, aimY, -14));
  anim.setAiming(true);
  anim.aimWeight = 1;
  anim.setLocomotion(speed, 0);
  const dt = 1 / 60;
  let t = 0;
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    anim.update(dt, t);
    t += dt;
  }
  root.updateMatrixWorld(true);
  return r;
}

const worldOf = (o) => {
  o.updateWorldMatrix(true, false);
  return new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
};

/**
 * Where the off hand sits along the weapon, in metres from the right hand.
 * Positive is toward the muzzle. This is the number the old constant pinned at
 * 0.24 for every weapon in the game.
 *
 * Measured along the AIM DIRECTION rather than along the prop's own barrel,
 * because that is the line the solver reasons about - the grip is parented to
 * the hand and the weapon is taken to lie along the aim from there. It is also
 * the only line available: measured on the shipped mounts, an NPC rifle's
 * barrel sits 65 degrees off the character's aim direction once the arms are
 * up (bow 73, pistol 65; the player's own `carbine` and `sword` mounts, solved
 * in-engine at full aim weight, come out at 27-29). That is a real defect in
 * `WEAPON_MOUNTS`' rotations and it is not this one - it predates the off-hand
 * fix bit for bit, because the right hand's target and wrist are untouched.
 *
 * `lateral` is the same displacement perpendicular to that line: how far the
 * off hand is from the weapon it is supposed to be holding.
 */
function offHandAlongBarrel(r) {
  r.root.updateMatrixWorld(true);
  const chest = worldOf(r.byName.get('spine03'));
  // Exactly `_poseAimArms`' own construction, including the 0.16 m drop.
  const aim = new THREE.Vector3(0, 1.45, -14).sub(chest);
  aim.y -= 0.16;
  aim.normalize();
  const hand = worldOf(r.byName.get('handL')).sub(worldOf(r.byName.get('handR')));
  const along = hand.dot(aim);
  return {
    along,
    lateral: hand.clone().addScaledVector(aim, -along).length(),
    len: weaponHold(r.model).length,
  };
}

/* ------------------------------------------------------------------ */
/* 1. the off hand is on the weapon                                    */
/* ------------------------------------------------------------------ */

test('a two-handed weapon puts the off hand between the grip and the muzzle', () => {
  for (const model of ['rifle', 'staff', 'carbine']) {
    const r = settle(makeRig({ model }));
    const { along, len, lateral } = offHandAlongBarrel(r);
    assert.ok(
      along > 0.04 && along < len,
      `${model}: off hand ${along.toFixed(3)} m along a ${len.toFixed(3)} m weapon - not on it`
    );
    /* And near the weapon's line, not merely level with a point on it. The old
     * lateral of 0.02 against a grip at 0.115 left the support hand 9.5 cm to
     * the side of the barrel it was supposed to be under, before the IK's own
     * slack was added. */
    assert.ok(lateral < 0.12, `${model}: off hand ${lateral.toFixed(3)} m off the weapon's line`);
  }
});

test('the bow draws behind the grip, because the riser is the mounted hand', () => {
  const r = settle(makeRig({ model: 'bow' }));
  const { along } = offHandAlongBarrel(r);
  assert.ok(along < -0.05, `string hand ended up ${along.toFixed(3)} m along the limb, not behind the grip`);
});

test('a one-handed weapon does not send the off hand past its own muzzle', () => {
  /* The measured defect. Under the old constant the left hand sat 0.24 m
   * along a barrel 0.169 m long - 7 cm of daylight past the end of it -
   * closing on nothing at all. */
  for (const model of ['pistol', 'sword']) {
    const r = settle(makeRig({ model }));
    const { along, len } = offHandAlongBarrel(r);
    assert.ok(
      along < 0,
      `${model}: off hand ${along.toFixed(3)} m along a ${len.toFixed(3)} m weapon - still reaching for a foregrip that does not exist`
    );
    // And it is genuinely off to the side, hanging, not tucked under the aim.
    const chest = worldOf(r.byName.get('spine03'));
    const hand = worldOf(r.byName.get('handL'));
    assert.ok(hand.y < chest.y, `${model}: the counterweight hand is not below the chest`);
  }
});

test('every weapon is held differently - the reach is no longer a constant', () => {
  /* The single assertion that fails hardest on the old code: it returned the
   * same 0.24 m for all six. */
  const seen = new Map();
  for (const model of ['rifle', 'pistol', 'staff', 'bow', 'sword', 'gauntlet']) {
    seen.set(model, offHandAlongBarrel(settle(makeRig({ model }))).along);
  }
  const vals = [...seen.values()];
  const spread = Math.max(...vals) - Math.min(...vals);
  assert.ok(
    spread > 0.35,
    `the off hand moved only ${spread.toFixed(3)} m across every weapon in the game: ${[...seen].map(([k, v]) => `${k} ${v.toFixed(3)}`).join(', ')}`
  );
  /* Every weapon NOT held two-handed in front of the body has to land clear of
   * the old constant. The two-handers legitimately do not: measured, the left
   * arm runs out of reach at 0.24 m of separation (the target for a staff is
   * 0.325 m and `solveTwoBone` clamps it to 0.243), so a rifle and a staff
   * converge on the same number because the ARM is the binding constraint
   * there, not the weapon. That is exactly why one constant looked right for
   * so long - it was right for the only case anyone checked. */
  for (const [model, v] of seen) {
    if (model === 'rifle' || model === 'staff') continue;
    assert.ok(v < 0, `${model} still reaches forward like a rifle (${v.toFixed(3)} m)`);
  }
});

/* ------------------------------------------------------------------ */
/* 2. the hand has bones and they move                                 */
/* ------------------------------------------------------------------ */

test('the skeleton has finger drivers, on the knuckle circle the mesh uses', () => {
  const P = makeProportions(HUMAN);
  const spec = buildSkeletonSpec(P);
  for (const side of [1, -1]) {
    const s = side > 0 ? 'R' : 'L';
    const f = spec.find((d) => d.name === `fingers${s}`);
    const t = spec.find((d) => d.name === `thumb${s}`);
    assert.ok(f && t, `no finger drivers on the ${s} hand`);
    assert.equal(f.parent, `hand${s}`);
    assert.equal(t.parent, `hand${s}`);
    // The bone has to be where the mesh puts the knuckles, or skin weighting
    // measures the digits against a segment that is not inside them.
    const HL = handLandmarks(P, side);
    const d = new THREE.Vector3(...f.pos).distanceTo(HL.knuckle);
    assert.ok(d < 1e-9, `fingers${s} sits ${d.toFixed(4)} m off the knuckle circle`);
    // A driver without an axis cannot be posed.
    assert.equal(f.axis.length, 3);
    assert.ok(Math.abs(new THREE.Vector3(...f.axis).length() - 1) < 1e-9);
  }
});

test('an unanimated body still has relaxed hands, and the bind pose is open', () => {
  /* `MountManager`'s rider proxy poses its own figure and never runs an
   * `NPCAnimator`, so the default the rig ships with is what a player sees on
   * a saddle. It has to be the relaxed grip, not the flat bind pose - and the
   * BIND has to stay open, or the driver would add a second curl on top of a
   * baked one, which is the defect all of this exists to remove. */
  const P = makeProportions(HUMAN);
  const spec = buildSkeletonSpec(P);
  const { byName, skeleton } = createSkeleton(spec);
  const f = byName.get('fingersR');
  const angle = 2 * Math.acos(Math.min(1, Math.abs(f.quaternion.w)));
  assert.ok(
    Math.abs(angle - GRIPS.relaxed[0]) < 1e-6,
    `an unposed hand sits at ${angle.toFixed(3)} rad, not GRIPS.relaxed (${GRIPS.relaxed[0]})`
  );
  /* The bind inverse is what `Skeleton` captured, and it must describe the
   * OPEN hand: its rotation part has to be identity. */
  const inv = skeleton.boneInverses[spec.findIndex((d) => d.name === 'fingersR')];
  const q = new THREE.Quaternion().setFromRotationMatrix(inv);
  assert.ok(
    Math.abs(Math.abs(q.w) - 1) < 1e-9,
    'the relaxed pose got baked into the bind - a driver would now curl an already-curled hand'
  );
});

test('a positive driver angle closes either hand', () => {
  const P = makeProportions(HUMAN);
  for (const side of [1, -1]) {
    const HL = handLandmarks(P, side);
    const inward = new THREE.Vector3(-side, 0, 0);
    const rel = HL.fingerTip.clone().sub(HL.knuckle);
    const before = rel.dot(inward);
    const after = rel
      .clone()
      .applyQuaternion(new THREE.Quaternion().setFromAxisAngle(HL.curl, 0.6))
      .dot(inward);
    assert.ok(
      after > before + 0.02,
      `side ${side}: a positive curl did not fold the fingers into the palm (${before.toFixed(3)} -> ${after.toFixed(3)})`
    );
  }
});

test('the grip closes on a weapon and opens without one', () => {
  const armed = settle(makeRig({ model: 'rifle' }));
  const bare = settle(makeRig({ model: null }));
  const curl = (r) => r.anim._curl.R[0];
  assert.ok(
    Math.abs(curl(armed) - GRIPS.grip[0]) < 0.02,
    `an armed right hand settled at ${curl(armed).toFixed(3)}, not the grip pose`
  );
  assert.ok(
    Math.abs(curl(bare) - GRIPS.relaxed[0]) < 0.02,
    `an empty right hand settled at ${curl(bare).toFixed(3)}, not relaxed`
  );
  assert.ok(curl(armed) > curl(bare) + 0.25, 'gripping a rifle is no tighter than holding nothing');

  // And the bones actually carry it: the fingertip moves toward the palm.
  const tip = (r) => {
    r.root.updateMatrixWorld(true);
    const b = r.byName.get('fingersR');
    const d = r.spec.find((x) => x.name === 'fingersR');
    const len = new THREE.Vector3(...d.tail).distanceTo(new THREE.Vector3(...d.pos));
    return b.localToWorld(new THREE.Vector3(0, -len, 0)).distanceTo(worldOf(r.byName.get('handR')));
  };
  assert.ok(tip(armed) < tip(bare), 'the closed hand is no more compact than the open one');
});

/* ------------------------------------------------------------------ */
/* 3. the weights do not bleed                                         */
/* ------------------------------------------------------------------ */

test('no digit is driven by its neighbour, and none by the thumb', () => {
  const f = new HumanoidFactory({ renderer: null });
  const h = f.create({ build: 2, frame: 0, shoulderScale: 1.2, seed: 3 });
  const names = h.spec.map((d) => d.name);
  const geo = h.mesh.geometry;
  const si = geo.getAttribute('skinIndex');
  const sw = geo.getAttribute('skinWeight');
  const iF = names.indexOf('fingersR');
  const iT = names.indexOf('thumbR');

  let digits = 0;
  let thumb = 0;
  let cross = 0;
  let weakest = 1;
  const tipD = new THREE.Vector3(...h.spec[iF].tail);
  const pos = geo.getAttribute('position');
  const p = new THREE.Vector3();
  for (let v = 0; v < pos.count; v++) {
    let wF = 0;
    let wT = 0;
    for (let k = 0; k < 4; k++) {
      const idx = si.getComponent(v, k);
      const w = sw.getComponent(v, k);
      if (idx === iF) wF += w;
      if (idx === iT) wT += w;
    }
    if (wF > 0.001) digits++;
    if (wT > 0.001) thumb++;
    if (wF > 0.001 && wT > 0.001) cross++;
    // Away from the knuckle the driver must clearly own the vertex; at the
    // root ring it deliberately shares with the palm, and that ring sits ON
    // the rotation axis so it barely moves whatever the share.
    p.fromBufferAttribute(pos, v);
    if (wF > 0.001 && p.distanceTo(tipD) < 0.03) weakest = Math.min(weakest, wF);
  }
  assert.ok(digits > 100 && thumb > 20, `hand parts are not weighted (${digits}/${thumb} vertices)`);
  assert.equal(cross, 0, `${cross} vertices are driven by BOTH the digits and the thumb`);
  assert.ok(weakest > 0.7, `a fingertip is only ${weakest.toFixed(3)} driven by its own bone`);
  h.dispose();
  f.dispose();
});

/* ------------------------------------------------------------------ */
/* 4. the melee arc                                                    */
/* ------------------------------------------------------------------ */

test('a melee swing sweeps the arm across and puts it back', () => {
  const r = settle(makeRig({ model: 'sword' }));
  const lateral = () => {
    r.root.updateMatrixWorld(true);
    return worldOf(r.byName.get('handR')).x;
  };
  const rest = lateral();
  r.anim.meleeSwing(1);

  const dt = 1 / 60;
  let t = 2;
  let lo = Infinity;
  let hi = -Infinity;
  const steps = [];
  let prev = worldOf(r.byName.get('handR'));
  for (let i = 0; i < 60; i++) {
    r.anim.update(dt, t);
    t += dt;
    const x = lateral();
    lo = Math.min(lo, x);
    hi = Math.max(hi, x);
    const now = worldOf(r.byName.get('handR'));
    steps.push(now.distanceTo(prev));
    prev = now;
  }
  assert.ok(hi - lo > 0.35, `the sword arm travelled ${(hi - lo).toFixed(3)} m - a statue, not a swing`);
  assert.ok(lo < rest, 'the wind-up never crossed to the far side');
  /* Continuity, stated as a SHAPE rather than a speed limit, because a sword
   * swing is legitimately fast: measured, the worst frame moves the wrist
   * 8.3 cm (5.0 m/s, which is the low end of a real cut) and the median frame
   * moves 3.4 cm. What must never happen is a step that stands out from its
   * neighbours - a solver flip, which is what npc-aim-singularity.test.mjs
   * spends its whole length on. Sorted, the top step may not be more than
   * three times the median. */
  const sorted = [...steps].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  const worst = sorted[sorted.length - 1];
  assert.ok(
    worst < median * 3,
    `one frame moved the hand ${(worst * 100).toFixed(1)} cm against a median of ${(median * 100).toFixed(1)} cm - that is a flip, not a swing`
  );
  assert.equal(r.anim.swinging, false, 'the swing never ended');
  const back = lateral();
  assert.ok(Math.abs(back - rest) < 0.03, `the arm settled ${(back - rest).toFixed(3)} m from where it started`);
});
