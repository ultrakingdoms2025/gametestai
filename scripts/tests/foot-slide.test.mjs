import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BeastBody, BEAST_PROFILES } from '../../src/npc/BeastBody.js';
import { BeastAnimator } from '../../src/npc/BeastAnimator.js';
import { GAITS, GAIT_PHASE, LEG_ORDER, legPhase, isSwing } from '../../src/npc/BeastGait.js';
import { PlayerAvatar } from '../../src/player/PlayerAvatar.js';

/**
 * A PLANTED FOOT MUST NOT MOVE.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 * Two gates already look at these rigs and neither of them can see a skate.
 *
 *   - `player-pose-continuity.test.mjs` bounds per-frame bone deltas. Foot
 *     slide is not a per-frame delta: a foot gliding smoothly along the ground
 *     at 3 m/s moves 5 cm a frame with a perfectly continuous pose, and that
 *     suite passes it without a murmur.
 *   - `beast-gait.test.mjs` holds the footfall PATTERN - support counts, beat
 *     counts, suspension - and it holds them well. But `supportCount` only ever
 *     asks whether a leg is in stance. It never asks what the leg DOES there.
 *
 * So a defect that made every four-legged animal in the game skate the entire
 * stride, at every speed, shipped through both of them. It is
 * `.probe/artreview/BASELINE.md`'s "VERIFIED: quadruped foot skate": the stance
 * curve at `BeastGait.legPose` was a sine HUMP -
 *
 *     swing: -Math.sin(u * Math.PI) * reach * 0.62
 *
 * - which starts at zero, sweeps rearward, and comes BACK to zero. Net
 * displacement of the contact point across the whole stance: nothing. The paw
 * therefore travels with the body for the whole of every stance, and for the
 * second half of it the paw is travelling FORWARD faster than the animal is.
 *
 * This suite measures the thing itself: where the contact point is IN THE
 * WORLD, on a real rig, driven by the real animator, while the body moves
 * underneath it.
 *
 * ── What is asserted, and why it is not "a few millimetres" ───────────────
 * On the humanoid it IS a few millimetres, and that is asserted below. On the
 * quadruped it cannot be, and the reason is arithmetic in the gait tables
 * rather than anything a stance curve can fix: a leg's fore-aft sweep is at
 * best `2 · legLength · sin(theta)` and the ground the body covers during one
 * stance is `stride · (1 - swing)`, and for six of the seven gaits the second
 * is larger than the first can ever be. `BeastGait.stanceReach` now carries
 * that accounting; this file does not duplicate it, it MEASURES what comes out
 * the far end of it. Per gait, front legs, on the real rig at 60 Hz - the
 * fraction of the ground the body covers that a planted paw hands back:
 *
 *     wolf trot 67%   wolf lope 77%   wolf sprint 75%   bear amble 60%
 *     bear charge 83%   camel pace 86%   camel gallop 95%
 *
 * The bear's amble is the tightest because its `lift` is small and the reach a
 * leg can hold while clearing the ground is bounded by it. Demanding 100% -
 * millimetres - would be a gate that measures something the game cannot do,
 * which this repo has paid for nine times over. @see the world-06 note.
 *
 * What IS reachable, and what the two gates below hold, is:
 *
 *   1. **A planted paw never outruns the animal standing on it.** Its
 *      world-space forward speed must stay under the body's own. This is the
 *      defect stated in world space and it is amplitude-free: a leg that sweeps
 *      rearward monotonically satisfies it however small the sweep, and a leg
 *      that reverses mid-stance cannot.
 *   2. **A planted paw gives most of the ground back.** Net world displacement
 *      across the stance, as a fraction of the ground the body covered.
 *
 * ── The measurements these thresholds come from ───────────────────────────
 * Every species x moving gait x leg x two speeds inside each band, on the real
 * `BeastBody` and the real `BeastAnimator`, 60 Hz. The middle row is what the
 * shipped stance curve produced before it was corrected, re-measured through
 * this same harness:
 *
 *                            worst peak speed      worst ground given back
 *     the sine hump            1.59 - 2.32x            -8% .. 0%
 *     a leg frozen through     exactly 1.00x           exactly 0%
 *       its own stance
 *     the corrected sweep      0.22 - 0.58x            60% .. 95%
 *     these gates             < 0.85x                  > 30%
 *
 * The thresholds sit in the gap with roughly 1.5x of headroom on the live side
 * and a wide margin on the defect side. The frozen-leg row is why the peak gate
 * cannot simply be 1.0: a leg that stops moving during stance skates just as
 * completely as the sine hump did and lands exactly on 1.00, so the bound has
 * to exclude it rather than sit on it.
 *
 * Neither gate reads `stanceReach` or `LEG_LENGTH`. A gate that recomputed the
 * amplitude the animator is using would agree with any amplitude it was given,
 * including a wrong one; these two only know where the paw was and where the
 * body was.
 *
 * ── And the humanoid, which is why any of this is credible ────────────────
 * `NPCAnimator` already does this correctly - `foot.fwd = halfStride * (1 - 2s)`
 * over a `cycleTime` that is `strideLen / speed`, so the contact point sweeps
 * rearward at exactly ground speed - and it passes these same gates untouched,
 * to a far tighter bound. Measured on a real `PlayerAvatar`, both feet, 14 s a
 * speed with the blends given 6 s to settle:
 *
 *     1.5 m/s   4.9 mm     4.4 m/s   7.2 mm     6.0 m/s   20.5 mm
 *     3.0 m/s   6.7 mm     4.6 m/s   6.8 mm     8.2 m/s   89.0 mm
 *
 * of total wander per stance, against 0.55 - 1.37 m of body travelling over it.
 * That is a gate that can tell the two rigs apart, which is the only reason to
 * believe what it says about either.
 *
 * The 89 mm at 8.2 m/s - the player's `sprintSpeed` - is a real but much
 * smaller and quite separate defect: `halfStride` reaches 0.73 m there, the two
 * bone IK runs out of leg, and `solveTwoBone` lands the ankle short of the
 * target it was given. It is bounded rather than ignored below so that it
 * cannot quietly grow.
 */

const DT = 1 / 60;
/** Full detail, IK on, close enough that no LOD band is skipping work. */
const LOD = { detail: true, ik: true, distance: 6 };
const bus = { on: () => () => {}, off() {}, emit() {} };

/* ---------------------------------------------------------------- */
/* The measurement                                                   */
/* ---------------------------------------------------------------- */

/**
 * One contiguous stance, reduced to the four numbers that describe a skate.
 *
 * `fwd` and `body` are both metres travelled down -Z, which is forward
 * everywhere in this game, so they are directly comparable: for a foot that is
 * truly planted `fwd` is a constant while `body` climbs.
 *
 * @param {{body:number, fwd:number, x:number}[]} run
 */
function summarise(run) {
  const first = run[0];
  const last = run[run.length - 1];
  const bodyDist = last.body - first.body;
  const slip = last.fwd - first.fwd;
  let minF = Infinity, maxF = -Infinity, minX = Infinity, maxX = -Infinity;
  let peak = -Infinity;
  for (let i = 0; i < run.length; i++) {
    const s = run[i];
    if (s.fwd < minF) minF = s.fwd;
    if (s.fwd > maxF) maxF = s.fwd;
    if (s.x < minX) minX = s.x;
    if (s.x > maxX) maxX = s.x;
    if (i > 0) {
      /* Per frame rather than per second, and divided by the body's own step,
       * so the number is a RATIO and does not have to be re-derived for every
       * speed in the table. 1.0 is "moving with the body"; above 1.0 the foot
       * is being driven forward faster than the animal it is carrying. */
      const step = s.body - run[i - 1].body;
      if (step > 1e-9) peak = Math.max(peak, (s.fwd - run[i - 1].fwd) / step);
    }
  }
  return {
    bodyDist,
    slip,
    /** Fraction of the ground the body covered that the foot did NOT slide. */
    giveBack: bodyDist > 1e-6 ? 1 - slip / bodyDist : 0,
    /** Busiest frame's forward travel, as a multiple of the body's. */
    peak: peak === -Infinity ? 0 : peak,
    /** Total wander of the contact point while down, metres, fore-aft + lateral. */
    spread: Math.hypot(maxF - minF, maxX - minX),
  };
}

/**
 * Group frames into contiguous stances.
 *
 * The run in progress when sampling STARTS is dropped - it is a stance already
 * half over, and its first sample is wherever the foot happened to be, which
 * would report a smaller slide than really happened. The run in progress when
 * sampling ENDS is dropped for the mirror reason: it is never closed.
 */
function stances(samples) {
  const runs = [];
  let cur = null;
  let sawSwing = false;
  for (const s of samples) {
    if (!s.down) {
      if (cur) { runs.push(cur); cur = null; }
      sawSwing = true;
      continue;
    }
    if (!sawSwing) continue;
    (cur ??= []).push(s);
  }
  // Four frames is the shortest stance worth a verdict; anything less is a
  // sampling artefact at a band edge rather than a step.
  return runs.filter((r) => r.length >= 4).map(summarise);
}

/* ---------------------------------------------------------------- */
/* The quadruped rig                                                 */
/* ---------------------------------------------------------------- */

/** One body per species, reused: building three is most of this file's cost. */
const bodies = new Map();
function bodyFor(species) {
  if (!bodies.has(species)) {
    // A fixed seed pins `heightScale`, which scales the legs - and therefore
    // the reach - while `GAITS.stride` stays put. A random one would move the
    // measurement under the thresholds.
    bodies.set(species, new BeastBody({ species, materials: null, seed: 7 }));
  }
  return bodies.get(species);
}

/**
 * The point the animal actually stands on, in the lower leg's own space.
 *
 * Taken from the shipped profile - the underside of the paw blob `BeastBody`
 * builds at `legs.paw` - rather than guessed, so a reshaped foot moves the
 * measurement with it.
 */
function contactLocal(species) {
  const L = BEAST_PROFILES[species].legs;
  return new THREE.Vector3(L.paw.p[0], L.paw.p[1] - L.paw.r[1], L.paw.p[2]);
}

/**
 * Walk a real beast in a straight line at a constant speed, and record for each
 * of its four legs where the contact point was IN THE WORLD every frame, and
 * whether it was down at the time.
 *
 * Stance is decided by the same two functions the animator poses from -
 * `legPhase` and `isSwing`, off the animator's own `stridePhase` and `gait` -
 * so the test and the game can never disagree about which feet are planted.
 */
function walkBeast(species, speed, seconds = 6) {
  const body = bodyFor(species);
  const animator = new BeastAnimator({ body, species, seed: 3, bus, owner: null });
  animator.setLocomotion(speed, 0);
  const local = contactLocal(species);
  const v = new THREE.Vector3();
  const legs = LEG_ORDER.map(() => []);
  body.root.position.set(0, 0, 0);

  const frames = Math.round(seconds / DT);
  const warm = Math.round(1.5 / DT);
  for (let i = 0; i < frames; i++) {
    /* Move the body first and then pose it, which is the order `NPC.update`
     * uses: the animator advances its stride phase by the same `speed * dt`
     * this line just travelled, so pose and position always describe the same
     * instant. */
    body.root.position.z -= speed * DT;
    animator.update(DT, i * DT, LOD);
    if (i < warm) continue;
    body.root.updateMatrixWorld(true);
    const gait = animator.gait;
    const offsets = GAIT_PHASE[gait.name] ?? GAIT_PHASE.stand;
    for (let k = 0; k < body.legs.length; k++) {
      const t = legPhase(animator.stridePhase, offsets[k]);
      v.copy(local);
      body.legs[k].lower.localToWorld(v);
      legs[k].push({
        body: -body.root.position.z,
        fwd: -v.z,
        x: v.x,
        down: !isSwing(t, gait.swing),
      });
    }
  }
  return { gait: animator.gait, legs: legs.map(stances) };
}

/** Two speeds inside each gait's own band, so no sample straddles a band edge. */
function speedsFor(list, i) {
  const lo = i === 0 ? 0 : list[i - 1].max;
  const hi = Number.isFinite(list[i].max) ? list[i].max : lo + 4;
  return [lo + (hi - lo) * 0.4, lo + (hi - lo) * 0.85];
}

/** Every species x moving gait x speed x leg, as one flat list of stances. */
let _allStances = null;
function everyBeastStance() {
  if (_allStances) return _allStances;
  const out = [];
  for (const [species, list] of Object.entries(GAITS)) {
    for (let i = 0; i < list.length; i++) {
      if (list[i].stride <= 0) continue;      // `stand` has no stance to measure
      for (const speed of speedsFor(list, i)) {
        const r = walkBeast(species, speed);
        // If the band arithmetic ever drifts, this suite would silently measure
        // the wrong gait four times over rather than fail.
        assert.equal(r.gait.name, list[i].name,
          `${species} at ${speed.toFixed(2)} m/s selected "${r.gait.name}", not "${list[i].name}"`);
        r.legs.forEach((runs, k) => {
          assert.ok(runs.length > 0,
            `${species} "${list[i].name}" ${LEG_ORDER[k]} never planted at ${speed.toFixed(2)} m/s`);
          for (const s of runs) {
            out.push({ species, gait: list[i].name, leg: LEG_ORDER[k], speed, ...s });
          }
        });
      }
    }
  }
  _allStances = out;
  return out;
}

const label = (s) => `${s.species} "${s.gait}" ${s.leg} at ${s.speed.toFixed(2)} m/s`;

/* ---------------------------------------------------------------- */
/* The humanoid rig                                                  */
/* ---------------------------------------------------------------- */

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

/** A player stub with exactly the surface `PlayerAvatar.update` reads. */
function makePlayer() {
  return {
    position: new THREE.Vector3(), velocity: new THREE.Vector3(), yaw: 0, pitch: 0,
    grounded: true, isDead: false, isAiming: false, isSprinting: false, lastFiredAt: -100,
    crouchAmount: 0, movementOverride: null, parkour: null, swim: null, physics: null,
    avatar: null,
    cameraRig: { isThird: true, boomLength: 4, aimPoint: new THREE.Vector3(0, 1.6, -30) },
    _harnessFrozen: false,
  };
}

/**
 * The same walk on the biped rig, driven through the same `update()` the frame
 * loop calls.
 *
 * The bone is read rather than `foot.local`, because a target the IK failed to
 * reach is exactly the case worth catching, and stance comes from the
 * animator's own `foot.stance` flag rather than being re-derived here.
 */
function walkHumanoid(speed, seconds = 14) {
  const player = makePlayer();
  const avatar = new PlayerAvatar({
    scene: new THREE.Scene(), engine: null, materials, player, bus, physics: null,
  });
  avatar.setVisible(true);
  const v = new THREE.Vector3();
  const feet = { R: [], L: [] };
  const frames = Math.round(seconds / DT);
  /* Six seconds of warm-up. `runBlend`, `moveBlend` and `strideLen` are all
   * damped approaches, and a stride length still creeping is a stride length
   * the feet are legitimately chasing - measuring through it would report the
   * ramp as a skate. */
  const warm = Math.round(6 / DT);
  for (let i = 0; i < frames; i++) {
    player.velocity.set(0, 0, -speed);
    player.position.z -= speed * DT;
    // Keep the crosshair 30 m down the player's own facing, moving with them -
    // a fixed world point turns the aim solver through 180 degrees as they run
    // past it. @see the same note in player-pose-continuity.test.mjs.
    player.cameraRig.aimPoint.set(0, 1.6, player.position.z - 30);
    avatar.update(DT, i * DT);
    if (i < warm) continue;
    avatar.humanoid.root.updateMatrixWorld(true);
    for (const foot of avatar.animator.feet) {
      avatar.humanoid.bones.get(`foot${foot.name}`).getWorldPosition(v);
      feet[foot.name].push({
        body: -player.position.z, fwd: -v.z, x: v.x, down: !!foot.stance,
      });
    }
  }
  avatar.dispose();
  return { R: stances(feet.R), L: stances(feet.L) };
}

/* ---------------------------------------------------------------- */
/* The gates                                                         */
/* ---------------------------------------------------------------- */

/**
 * A planted foot may not travel forward faster than the body it carries.
 *
 * Well below 1.0, because 1.0 exactly is a leg frozen through its own stance -
 * a complete skate that happens to be a smooth one. Measured worst on the live
 * rigs: 0.58 on the quadruped, 0.35 on the humanoid. @see the header table.
 */
const MAX_PEAK = 0.85;

/**
 * And it must hand the ground back. The sine hump gave back between -8% and 0%;
 * the corrected sweep gives back 60% to 95%, the floor being the bear's amble,
 * whose small `lift` bounds the reach a leg can hold. Below a third of the
 * ground is not a step, it is a slide.
 */
const MIN_GIVE_BACK = 0.30;

test('QUADRUPED: a planted paw never outruns the animal standing on it', () => {
  let worst = null;
  for (const s of everyBeastStance()) if (!worst || s.peak > worst.peak) worst = s;
  assert.ok(worst, 'no beast stance was measured at all');
  assert.ok(
    worst.peak < MAX_PEAK,
    `${label(worst)}: a PLANTED paw travelled forward at ${worst.peak.toFixed(2)}x the body's `
    + 'own speed - a foot on the ground is being carried by the animal, not carrying it'
  );
});

test('QUADRUPED: a planted paw gives the ground back as the body passes over it', () => {
  let worst = null;
  for (const s of everyBeastStance()) if (!worst || s.giveBack < worst.giveBack) worst = s;
  assert.ok(worst, 'no beast stance was measured at all');
  assert.ok(
    worst.giveBack > MIN_GIVE_BACK,
    `${label(worst)}: the body covered ${worst.bodyDist.toFixed(2)} m over that stance and the `
    + `paw slid ${worst.slip.toFixed(2)} m with it - ${(worst.giveBack * 100).toFixed(0)}% of the `
    + 'ground given back'
  );
});

test('HUMANOID: a planted foot holds still while the body walks and runs over it', () => {
  /* The band the game actually spends its time in: `Config.npc` walks at 1.5
   * and runs at 4.4, and the player walks at 4.6. Measured worst here is
   * 7.2 mm; the bound is a shade over twice that. */
  for (const speed of [1.5, 3.0, 4.4, 4.6]) {
    const r = walkHumanoid(speed);
    for (const side of ['R', 'L']) {
      assert.ok(r[side].length > 0, `foot${side} never planted at ${speed} m/s`);
      for (const s of r[side]) {
        assert.ok(
          s.spread < 0.015,
          `foot${side} at ${speed} m/s wandered ${(s.spread * 1000).toFixed(1)} mm while planted, `
          + `with ${s.bodyDist.toFixed(2)} m of body passing over it`
        );
      }
    }
  }
});

test('HUMANOID: and never outruns the body, all the way up to a sprint', () => {
  /* 8.2 is `Config.player.sprintSpeed`, and it is where the two-bone IK runs
   * out of leg: `halfStride` asks for 0.73 m of reach and the ankle lands
   * short, for a measured 89 mm of drift against 1.37 m of body. That is a
   * real defect and a much smaller one than the quadruped's; it is bounded
   * here so it cannot grow quietly, not blessed. */
  for (const speed of [1.5, 4.6, 8.2]) {
    const r = walkHumanoid(speed);
    for (const side of ['R', 'L']) {
      assert.ok(r[side].length > 0, `foot${side} never planted at ${speed} m/s`);
      for (const s of r[side]) {
        assert.ok(
          s.peak < MAX_PEAK,
          `foot${side} at ${speed} m/s ran forward at ${s.peak.toFixed(2)}x the body`
        );
        assert.ok(
          s.giveBack > 0.85,
          `foot${side} at ${speed} m/s gave back only ${(s.giveBack * 100).toFixed(1)}% of the `
          + `${s.bodyDist.toFixed(2)} m the body covered`
        );
        assert.ok(
          s.spread < 0.15,
          `foot${side} at ${speed} m/s drifted ${(s.spread * 1000).toFixed(0)} mm while planted`
        );
      }
    }
  }
});
