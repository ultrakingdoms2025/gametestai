/**
 * The ape body plan, and the two-bone IK it has to survive.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 *
 * Phase 6 shipped the eleven named station roles an authored ape HEAD and the
 * right kit, on a human body. The head read; the silhouette did not, and a
 * silhouette is what a player perceives first at any distance. `demopics/g1`
 * through `g4` and `n1`/`n2` are all the same animal: short legs, a long deep
 * barrel torso, a shoulder line half again as wide as a person's, and arms that
 * hang past the crotch toward the knee.
 *
 * Giving them that body means moving the two things every weapon pose depends
 * on - the humerus and the forearm - so this file is the safety net for the
 * change, and it was written to FAIL before it was made.
 *
 * ── What is actually pinned, and why each one ─────────────────────────────
 *
 *  1. **The ape rig is an ape.** Leg fraction, arm-to-leg ratio, shoulder span
 *     and chest depth, each against a number a human rig cannot reach. Without
 *     this the rest of the file passes on a human and proves nothing.
 *
 *  2. **The IK band still contains the aim target.** `solveTwoBone` CLAMPS the
 *     root-to-target distance into `[|l1-l2|, l1+l2]`. `_poseAimArms` aims the
 *     hands at points a fixed distance off the chest, so a longer arm is only
 *     safe while the two bones stay close enough in length to fold that far.
 *     A humerus that outgrows the forearm raises the floor of that band, and
 *     the first thing that happens when the floor crosses the target is that
 *     the weapon is shoved out in front of the character with straight arms.
 *     That is the failure this project would otherwise have found in a
 *     screenshot, so it is measured here instead.
 *
 *  3. **Both hands land on the weapon, for every model in the table.** The
 *     right hand holds the grip; the left supports the barrel. Both are
 *     checked against the real per-model mount transform out of
 *     `NPCWeapons.WEAPON_MOUNTS`, not against a copy, so a mount edit that
 *     breaks the pose fails here.
 *
 *  4. **A default humanoid is untouched.** One sha256 over every proportion
 *     and every bone of twenty-four human archetypes. `makeProportions` gained
 *     ape keys; if a single human number moved with them, this is the line
 *     that says so.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as THREE from 'three';

import { makeProportions, buildSkeletonSpec, createSkeleton } from '../../src/npc/Humanoid.js';
import { NPCAnimator } from '../../src/npc/NPCAnimator.js';
import { NPC_WEAPONS, WEAPON_MOUNTS } from '../../src/npc/NPCWeapons.js';

/* ------------------------------------------------------------------ */
/* rigs                                                                */
/* ------------------------------------------------------------------ */

/** The two authored hero archetypes, straight out of `NPCManager._heroLook`. */
const RAIDER = { build: 2, frame: 0, shoulderScale: 1.2, ape: 1 };
const CREW = { build: 2, frame: 0, shoulderScale: 1.15, ape: 0.85 };
/** What every other character in the game is: no ape keys at all. */
const HUMAN = { build: 2, frame: 0, shoulderScale: 1.2 };

const def = (spec, name) => spec.find((d) => d.name === name);
const seg = (spec, name) => {
  const d = def(spec, name);
  return Math.hypot(d.tail[0] - d.pos[0], d.tail[1] - d.pos[1], d.tail[2] - d.pos[2]);
};

/**
 * Landmarks a silhouette is actually read from, measured off the bone table
 * rather than off `makeProportions` - the skeleton is what the animator drives
 * and what the mesh is skinned to, so it is the honest witness.
 */
function landmarks(opts) {
  const P = makeProportions(opts);
  const spec = buildSkeletonSpec(P);
  const crown = def(spec, 'head').tail[1];
  const hipY = def(spec, 'thighR').pos[1];
  const legLen = seg(spec, 'thighR') + seg(spec, 'calfR');
  const armLen = seg(spec, 'upperArmR') + seg(spec, 'foreArmR') + seg(spec, 'handR');
  return {
    P,
    spec,
    crown,
    hipY,
    legLen,
    armLen,
    /** Hip height over total height. A person is ~0.55; an ape is far lower. */
    legFraction: hipY / crown,
    /** Shoulder to fingertip against hip to ankle. Over 1 is an ape. */
    intermembral: armLen / legLen,
    shoulderSpan: P.shoulderX * 2,
    chestDepth: P.torso(P.chestY).rf + P.torso(P.chestY).rb,
    /** Where the fingertips hang, as a fraction of the way from hip to ankle. */
    knuckleDrop: (hipY - def(spec, 'handR').tail[1]) / hipY,
  };
}

/* ------------------------------------------------------------------ */
/* 1. the ape rig is an ape                                            */
/* ------------------------------------------------------------------ */

test('the ape body plan stands on short legs', () => {
  const human = landmarks(HUMAN);
  const raider = landmarks(RAIDER);
  const crew = landmarks(CREW);

  assert.ok(
    human.legFraction > 0.53,
    `a human rig should carry its hips high; got ${human.legFraction.toFixed(3)}`
  );
  for (const [name, m] of [['raider', raider], ['crew', crew]]) {
    assert.ok(
      m.legFraction < 0.47,
      `${name} legs are still human length: hip at ${m.legFraction.toFixed(3)} of height`
    );
  }
});

test('the ape body plan has arms longer than its legs', () => {
  const human = landmarks(HUMAN);
  const raider = landmarks(RAIDER);
  const crew = landmarks(CREW);

  assert.ok(
    human.intermembral < 1.0,
    `a human arm is shorter than its leg; got ${human.intermembral.toFixed(3)}`
  );
  for (const [name, m] of [['raider', raider], ['crew', crew]]) {
    assert.ok(
      m.intermembral > 1.15,
      `${name} arms do not out-reach its legs: ${m.intermembral.toFixed(3)}`
    );
    // g1 and n2 both hang the fingertips well past the crotch.
    assert.ok(
      m.knuckleDrop > 0.28,
      `${name} fingertips stop at the hip: drop ${m.knuckleDrop.toFixed(3)}`
    );
  }
});

test('the ape body plan is broader in the shoulder and deeper in the chest', () => {
  const human = landmarks(HUMAN);
  for (const [name, opts] of [['raider', RAIDER], ['crew', CREW]]) {
    const m = landmarks(opts);
    assert.ok(
      m.shoulderSpan > human.shoulderSpan * 1.1,
      `${name} shoulder span ${m.shoulderSpan.toFixed(3)} is not broader than a person's ${human.shoulderSpan.toFixed(3)}`
    );
    assert.ok(
      m.chestDepth > human.chestDepth * 1.12,
      `${name} chest depth ${m.chestDepth.toFixed(3)} is not deeper than a person's ${human.chestDepth.toFixed(3)}`
    );
  }
});

/* ------------------------------------------------------------------ */
/* 2 + 3. the aim rig                                                  */
/* ------------------------------------------------------------------ */

/**
 * A character with nothing on it but a skeleton, driven by the real animator.
 *
 * `HumanoidFactory.create` bakes canvas-backed textures and cannot run under
 * Node, but `NPCAnimator` only ever touches the rig - so a rig plus the three
 * fields it reads off the humanoid is a complete and honest subject.
 */
function poseAiming(opts, { aimFrom = [0, 1.5, 0], aimAt = [0, 1.45, -12] } = {}) {
  const P = makeProportions(opts);
  const spec = buildSkeletonSpec(P);
  const { skeleton, bones, byName, root: boneRoot } = createSkeleton(spec);

  const root = new THREE.Group();
  const rig = new THREE.Group();
  root.add(rig);
  rig.add(boneRoot);
  root.position.set(aimFrom[0], 0, aimFrom[2]);

  const humanoid = {
    P, spec, skeleton, boneRoot,
    bones: byName,
    boneList: bones,
    root,
    rig,
    heightScale: 1,
    headBone: byName.get('head'),
    eyes: [],
  };

  const anim = new NPCAnimator({ humanoid, physics: null, seed: 7 });
  anim.setAimTarget(new THREE.Vector3(aimAt[0], aimAt[1], aimAt[2]));
  anim.aimWeight = 1;
  anim._aimWant = 1;
  // Two frames: the first establishes the FK chain the aim solver reads from.
  for (let i = 0; i < 6; i++) anim.update(1 / 60, i / 60, { ik: false, detail: false });
  root.updateMatrixWorld(true);
  return { P, spec, anim, byName, root };
}

/** Fold headroom and extension slack, per arm, for one archetype. */
function ikMargins(opts) {
  const { anim, P } = poseAiming(opts);
  const l1 = anim.upperArmLen;
  const l2 = anim.foreArmLen;
  const floor = Math.abs(l1 - l2);
  const span = l1 + l2;
  const out = { P, anim, l1, l2, floor, span };
  for (const s of ['R', 'L']) {
    const reach = anim._fkPos[anim._idx(`upperArm${s}`)]
      .distanceTo(anim._fkPos[anim._idx(`hand${s}`)]);
    out[s] = { reach, headroom: reach - floor, slack: span - reach };
  }
  return out;
}

test('the ape arm never runs into either end of the IK band', () => {
  /* `solveTwoBone` CLAMPS the root-to-target distance into [|l1-l2|, l1+l2].
   * `_poseAimArms` puts the hands at points a fixed distance off the CHEST, so
   * the distance the arm has to cover does not grow with the arm - which means
   * the whole risk of a longer arm lives in the lower bound: a humerus that
   * outgrows its forearm cannot fold up small enough, the solve clamps, and
   * the character shoves the weapon out on straight arms.
   *
   * Reach strictly inside the band, with margin, IS the not-clamped condition:
   * a clamped solve lands exactly on one end of it. */
  const human = ikMargins(HUMAN);
  for (const [name, opts] of [['human', HUMAN], ['raider', RAIDER], ['crew', CREW]]) {
    const m = name === 'human' ? human : ikMargins(opts);
    for (const s of ['R', 'L']) {
      assert.ok(
        m[s].headroom > 0.08,
        `${name} ${s}: only ${m[s].headroom.toFixed(3)} m before the arm cannot fold further`
      );
      assert.ok(
        m[s].slack > 0.008,
        `${name} ${s}: only ${m[s].slack.toFixed(3)} m before the arm is straight`
      );
      /* And the ape must not have SPENT the margin a person had. The support
       * arm is the one that matters: a person's is already at 97% extension
       * (0.017 m of slack in 0.559 m of arm), which is the tightest number in
       * the aim rig and the one a longer arm could plausibly have eaten. */
      if (name !== 'human') {
        assert.ok(
          m[s].slack > human[s].slack - 0.02 && m[s].headroom > human[s].headroom - 0.02,
          `${name} ${s} gave up margin a person had: slack ${m[s].slack.toFixed(3)} vs ${human[s].slack.toFixed(3)}, headroom ${m[s].headroom.toFixed(3)} vs ${human[s].headroom.toFixed(3)}`
        );
      }
    }
  }
});

/**
 * Where a weapon's grip ends up in the world, given the hand that holds it.
 * Uses the shipped mount table, so a mount edit is caught here too.
 */
function gripWorld(byName, model) {
  const m = WEAPON_MOUNTS[model] ?? WEAPON_MOUNTS.rifle;
  const hand = byName.get('handR');
  hand.updateMatrixWorld(true);
  // `weaponMount` is an identity child of handR; the model group carries the
  // whole offset, exactly as `buildWeaponModel` sets it.
  const group = new THREE.Object3D();
  group.position.set(m.pos[0], m.pos[1], m.pos[2]);
  group.rotation.set(m.rot[0], m.rot[1], m.rot[2]);
  hand.add(group);
  group.updateMatrixWorld(true);
  const grip = new THREE.Vector3().setFromMatrixPosition(group.matrixWorld);
  hand.remove(group);
  return grip;
}

/** Closest approach from `p` to the segment a-b, and where along it that is. */
function toSegment(p, a, b) {
  const ab = new THREE.Vector3().subVectors(b, a);
  const len2 = ab.lengthSq();
  const t = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1, new THREE.Vector3().subVectors(p, a).dot(ab) / len2));
  return { dist: p.distanceTo(new THREE.Vector3().copy(a).addScaledVector(ab, t)), t };
}

test('the grip stays in the fist for every model an NPC can carry', () => {
  const models = [...new Set(Object.values(NPC_WEAPONS).map((w) => w.model))];
  assert.equal(Object.keys(NPC_WEAPONS).length, 6, 'the weapon table changed shape');
  assert.deepEqual(models.sort(), ['bow', 'pistol', 'rifle', 'staff']);

  /** Where each grip sits relative to the hand bone that holds it. */
  const seat = (opts) => {
    const { byName, root, spec } = poseAiming(opts);
    root.updateMatrixWorld(true);
    const hand = byName.get('handR');
    const wrist = new THREE.Vector3().setFromMatrixPosition(hand.matrixWorld);
    /* The hand bone's tail, in the world. The mounts are ABSOLUTE offsets in
     * this bone's frame, so "does the grip still sit in the palm" is a
     * question about the hand's LENGTH - and the ape's hand is built inside a
     * band the vertical remap compresses. Left uncorrected it came out 27%
     * short, which walks every grip toward the wrist. */
    const d = def(spec, 'handR');
    const tail = new THREE.Vector3(
      d.tail[0] - d.pos[0], d.tail[1] - d.pos[1], d.tail[2] - d.pos[2]
    ).applyQuaternion(hand.getWorldQuaternion(new THREE.Quaternion())).add(wrist);
    return Object.fromEntries(
      models.map((m) => [m, toSegment(gripWorld(byName, m), wrist, tail)])
    );
  };

  const human = seat(HUMAN);
  for (const [name, opts] of [['human', HUMAN], ['raider', RAIDER], ['crew', CREW]]) {
    const s = name === 'human' ? human : seat(opts);
    for (const model of models) {
      /* The bow is the loosest by design - a riser is held out in front of the
       * palm rather than wrapped in it - and it is the number this bound is
       * set from, at 65 mm. */
      assert.ok(
        s[model].dist < 0.08,
        `${name}/${model}: grip is ${s[model].dist.toFixed(3)} m off the hand bone`
      );
      assert.ok(
        s[model].t > 0.10 && s[model].t < 0.60,
        `${name}/${model}: grip sits at ${s[model].t.toFixed(2)} of the way down the hand, not in the palm`
      );
      // And the ape's hand holds it in the same place a person's does.
      if (name !== 'human') {
        assert.ok(
          Math.abs(s[model].dist - human[model].dist) < 0.003
          && Math.abs(s[model].t - human[model].t) < 0.03,
          `${name}/${model}: the grip moved in the fist - ${s[model].t.toFixed(3)} of the hand against a person's ${human[model].t.toFixed(3)}`
        );
      }
    }
  }
});

test('the ape holds its weapon exactly where a person holds it', () => {
  /* The strongest statement available, and the one that says the body plan is
   * invisible to the aim rig: the hand targets in `_poseAimArms` are offsets
   * from the CHEST, so if the solve is not clamping, both hands land in the
   * same place relative to the chest whatever the arms are. Every number below
   * agreed to within 1 mm when this was written. */
  const ref = poseAiming(HUMAN);
  const measure = ({ anim, byName }) => {
    const chest = anim._fkPos[anim._idx('spine03')];
    const hR = anim._fkPos[anim._idx('handR')];
    const hL = anim._fkPos[anim._idx('handL')];
    return { r: hR.distanceTo(chest), l: hL.distanceTo(chest), span: hR.distanceTo(hL) };
  };
  const base = measure(ref);

  for (const [name, opts] of [['raider', RAIDER], ['crew', CREW]]) {
    const m = measure(poseAiming(opts));
    for (const k of ['r', 'l', 'span']) {
      assert.ok(
        Math.abs(m[k] - base[k]) < 0.004,
        `${name}: ${k} hand geometry moved ${(m[k] - base[k]).toFixed(4)} m against a person's`
      );
    }
  }
});

/**
 * Undo the vertical remap. `profile.y` is monotone by construction, so a
 * bisection is exact to floating point in sixty steps, and it is what lets a
 * point measured on the posed rig be looked up in the canonical key tables.
 */
function canonicalY(P, y) {
  if (!P.profile) return y;
  let lo = -0.5;
  let hi = 2.5;
  for (let i = 0; i < 60; i++) {
    const m = (lo + hi) * 0.5;
    if (P.profile.y(m) < y) lo = m;
    else hi = m;
  }
  return (lo + hi) * 0.5;
}

test('a deeper chest does not swallow the weapon', () => {
  /* The one thing the barrel chest genuinely threatens. The right hand is held
   * a fixed 0.2 m forward of the CHEST BONE, and that offset knows nothing
   * about how deep the ribcage in front of it is; push the chest out far
   * enough and the rifle is inside it.
   *
   * Measured at the grip's OWN height rather than at the widest point of the
   * chest - the grip rides above the pectoral line, where the torso has
   * already tapered into the collar - and against the torso's front surface
   * including the ape's forward neck set, which moves that surface toward the
   * weapon. Worst case when written: raider with a pistol, 75 mm. */
  const models = [...new Set(Object.values(NPC_WEAPONS).map((w) => w.model))];
  for (const [name, opts] of [['human', HUMAN], ['raider', RAIDER], ['crew', CREW]]) {
    const { byName, P, root } = poseAiming(opts);
    root.updateMatrixWorld(true);
    for (const model of models) {
      const grip = gripWorld(byName, model);
      const cy = canonicalY(P, grip.y);
      // Torso rings are centred on z = 0 plus the ape's forward neck set.
      const surfaceZ = (P.profile ? P.profile.z(cy) : 0) - P.torso(cy).rf;
      // The character faces -Z and is not rotated in this rig.
      const clear = surfaceZ - grip.z;
      assert.ok(
        clear > 0.04,
        `${name}/${model}: grip clears the ribcage by only ${clear.toFixed(3)} m`
      );
    }
  }
});

/* ------------------------------------------------------------------ */
/* 4. humans are untouched                                             */
/* ------------------------------------------------------------------ */

/**
 * Every number `makeProportions` and `buildSkeletonSpec` produce, for the
 * twenty-four human archetypes the game actually rolls, hashed.
 *
 * This is deliberately a hash and not a handful of spot checks. The ape keys
 * touch the torso, leg, foot and arm tables and the bone spec; a spot check on
 * three of the five would have let the fourth move silently, and "the crowd
 * changed shape and nobody noticed" is a defect this project has already
 * recorded once.
 */
test('the ape keys leave every human archetype byte-identical', () => {
  const r = (v) => Math.round(v * 1e6) / 1e6;
  const lines = [];
  for (const build of [0, 1, 2]) {
    for (const frame of [0, 1]) {
      for (const ss of [0.90, 1.00, 1.15, 1.20]) {
        const P = makeProportions({ build, frame, shoulderScale: ss });
        lines.push(`P ${P.key} ${r(P.girth)} ${r(P.limbScale)} ${r(P.hipY)} ${r(P.pelvisY)} ${r(P.chestY)} ${r(P.neckY)} ${r(P.headY)} ${r(P.ankleY)} ${r(P.legSideX)} ${r(P.shoulderX)}`);
        for (let y = 0.05; y <= 1.62; y += 0.01) {
          const t = P.torso(y);
          const l = P.leg(y);
          lines.push(`t ${r(y)} ${r(t.rx)} ${r(t.rf)} ${r(t.rb)} ${r(t.e)} ${r(l.rx)} ${r(l.rf)} ${r(l.rb)} ${r(l.z)} ${r(P.bodyOuterX(y))}`);
        }
        for (let z = 0.08; z >= -0.21; z -= 0.01) {
          const f = P.foot(z);
          lines.push(`f ${r(z)} ${r(f.y)} ${r(f.rx)} ${r(f.ry)}`);
        }
        for (let u = 0; u <= 1.0001; u += 0.02) {
          const a = P.arm(u, 1);
          lines.push(`a ${r(u)} ${r(a.p.x)} ${r(a.p.y)} ${r(a.p.z)} ${r(a.rx)} ${r(a.ry)} ${r(a.armX)}`);
        }
        for (const d of buildSkeletonSpec(P)) {
          lines.push(`s ${d.name} ${d.parent} ${d.pos.map(r).join(',')} ${d.tail.map(r).join(',')}`);
        }
      }
    }
  }
  assert.equal(lines.length, 6240, 'the sampling grid changed, so the hash below means nothing');
  assert.equal(
    crypto.createHash('sha256').update(lines.join('\n')).digest('hex'),
    '9f861457d487e994f75aa4b577099bd6a97d5169f628a844a5966bace6547334',
    'a human archetype moved; the ape keys are not gated'
  );
});

test('reading landmarks off the rig gives a person exactly what the archetype did', () => {
  /* `NPCAnimator` used to take pelvis, hip, chest, head, ankle and hip-offset
   * straight from `makeProportions`. It now takes them from the bone table,
   * because on the ape body plan those two disagree on purpose. For a person
   * they must agree to the bit, or every civilian's stance has quietly moved.
   */
  const P = makeProportions(HUMAN);
  const { anim } = poseAiming(HUMAN);
  assert.equal(anim.P.pelvisY, P.pelvisY);
  assert.equal(anim.P.hipY, P.hipY);
  assert.equal(anim.P.chestY, P.chestY);
  assert.equal(anim.P.headY, P.headY);
  assert.equal(anim.P.ankleY, P.ankleY);
  assert.equal(anim.P.legSideX, P.legSideX);

  // And on an ape they must NOT - that is the whole point of the change.
  const ape = poseAiming(RAIDER).anim.P;
  assert.ok(ape.pelvisY < P.pelvisY - 0.15, `ape pelvis at ${ape.pelvisY.toFixed(3)}`);
  assert.ok(ape.hipY < P.hipY - 0.15, `ape hip at ${ape.hipY.toFixed(3)}`);
  assert.equal(ape.ankleY, P.ankleY, 'the ape ankle moved - its feet are off the ground');
});

test('an ape archetype is a different geometry cache family', () => {
  // Sharing a key with a human archetype would serve whichever body was built
  // first to both, which is the bug the hero key already exists to prevent.
  const human = makeProportions(HUMAN).key;
  const raider = makeProportions(RAIDER).key;
  const crew = makeProportions(CREW).key;
  assert.notEqual(raider, human);
  assert.notEqual(crew, human);
  assert.notEqual(raider, crew);
});
