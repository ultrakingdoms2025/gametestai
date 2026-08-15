import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { Physics } from '../../src/physics/Physics.js';
import { CONFIG } from '../../src/core/Config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readSrc = async (p) => (await readFile(path.join(root, p), 'utf8')).replace(/\r\n/g, '\n');

/**
 * HOW FAST THE PLAYER ACTUALLY GOES.
 *
 * ── The mechanism ─────────────────────────────────────────────────────────
 * `Player._move` runs friction and then acceleration on every grounded step:
 *
 *     friction     v -= v * friction * dt          (above STOP_SPEED)
 *     accelerate   v += min(acceleration * dt, wish - v)
 *
 * At the fixed point the two cancel: `v * friction * dt = acceleration * dt`,
 * so **v = acceleration / friction**. The step length cancels, and so does the
 * wish - every wish at or above the cap converges on exactly the same speed.
 * A gait whose wish is UNDER the cap reaches its wish exactly instead, which is
 * why a walk is 4.6 and a sprint is whatever the ratio says.
 *
 * ── The two defects this file was opened for, and how they were closed ────
 * `CONFIG.player.sprintSpeed` read 8.2 while the ratio was 60/10 = 6.0, so
 * nothing in the game could go 8.2. That is not a rounding error, it is a
 * number readers reasoned from - a balance test asserted "nothing outruns a
 * sprinting player" against it, and another hard-coded 8.2 as the top speed.
 * And a speed pickup did NOTHING to a sprint: `boostSpeed` scaled only the
 * wish, which was already over the cap, so 1.5x and 3.0x both measured 6.0.
 *
 * The first pass made the config honest by writing 6.0 into `sprintSpeed` and
 * moving the 8.2 to `sprintWishSpeed`. The owner's decision was the other
 * option that pass recorded: make 8.2 TRUE, by moving the ratio.
 *
 *   - `acceleration` 60 -> 82. `friction` deliberately untouched at 10, because
 *     friction is the only thing that sheds momentum and lowering it to 7.317
 *     would have bought the same 8.2 by taking 37% longer to stop, to turn and
 *     to decay a landing. @see ../../src/core/Config.js `acceleration` for the
 *     measured comparison of the two levers.
 *   - `_move` now scales the grounded acceleration by `speedMultiplier`, so a
 *     boost moves the CAP as well as the wish and is felt at every gait.
 *   - `sprintWishSpeed` 8.2 -> 11.2, holding its ratio to the cap. It is
 *     load-bearing at that ratio in two places, both pinned below: the decay
 *     of a parkour landing, and the FOV sprint-kick amplitude.
 *
 * Measured here by driving the real controller, not derived:
 *
 *                        was        now
 *     walk             4.6000     4.6000     (unchanged, and asserted so)
 *     sprint           6.0000     8.2000
 *     crouch           2.2000     2.2000
 *     walk  + 1.5x     6.0000     6.9000     (= 1.5 * walkSpeed)
 *     sprint + 1.5x    6.0000    12.3000     (= 1.5 * the cap)
 *     sprint + 3.0x    6.0000    24.6000
 *
 * The last case is the ratchet: an FNV-1a hash of position and velocity over a
 * 30-second scripted run. It was recorded at c6b3b94 to prove the rename of
 * `sprintSpeed` changed nothing, and is re-recorded here because this change is
 * the one it existed to catch.
 */

const DT = 1 / 60;
const P = CONFIG.player;

/**
 * The one renderer-bound thing `Player` builds is `Weapon`, whose viewmodel
 * textures are painted on a 2D canvas and thrown away headless. Same concession
 * `player-slope.test.mjs` makes, for the same reason: it takes no part in
 * locomotion.
 */
function shimCanvas() {
  if (globalThis.document?.createElement) return;
  const noop = () => {};
  const ctx2d = () => ({
    createImageData: (a, b) => ({
      data: new Uint8ClampedArray((a | 0) * ((b ?? a) | 0) * 4), width: a | 0, height: (b ?? a) | 0,
    }),
    getImageData: (x, y, a, b) => ({
      data: new Uint8ClampedArray((a | 0) * (b | 0) * 4), width: a | 0, height: b | 0,
    }),
    putImageData: noop, fillRect: noop, clearRect: noop, beginPath: noop, closePath: noop,
    arc: noop, moveTo: noop, lineTo: noop, fill: noop, stroke: noop, save: noop,
    restore: noop, rotate: noop, translate: noop, scale: noop, drawImage: noop,
    setTransform: noop, fillText: noop, strokeText: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    measureText: () => ({ width: 0 }),
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalCompositeOperation: '',
    globalAlpha: 1, font: '', textAlign: '', textBaseline: '',
  });
  const existing = globalThis.document ?? {};
  globalThis.document = {
    hidden: false, getElementById: () => null, querySelector: () => null,
    ...existing,
    createElement: (tag) => {
      if (tag !== 'canvas') return {};
      const c = { width: 1, height: 1, style: {}, tagName: 'CANVAS' };
      c.getContext = ctx2d;
      return c;
    },
  };
}
shimCanvas();
const { Player } = await import('../../src/player/Player.js');

/** A single flat slab, large enough that no run can reach an edge. */
function flatWorld() {
  const physics = new Physics();
  const deck = new THREE.Mesh(new THREE.BoxGeometry(8000, 2, 8000));
  deck.position.set(0, -1, 0);
  deck.updateWorldMatrix(true, false);
  physics.addBoxFromObject(deck);
  return physics;
}

/** Facing is -Z at yaw 0, so this points forward along +X. */
const YAW_PLUS_X = -Math.PI / 2;

function makePlayer(physics, yaw = YAW_PLUS_X) {
  const bus = { on: () => () => {}, emit() {} };
  const input = {
    state: {
      forward: 0, right: 0, jump: false, sprint: false, crouch: false, fire: false,
      aim: false, reload: false, interact: false, lookX: 0, lookY: 0, wheel: 0,
    },
  };
  const player = new Player({
    scene: new THREE.Scene(), engine: {}, physics, bus, materials: {}, input,
    camera: new THREE.PerspectiveCamera(),
  });
  player.setYaw(yaw);
  return player;
}

/**
 * Sprint is rationed - 100 stamina draining at 15/s - and the ration is not the
 * question here. Removing it is what makes "the top speed" a property of the
 * controller rather than of the pool.
 */
function unlimitedStamina(player) {
  if (!player.stamina) return;
  Object.defineProperty(player.stamina, 'canSprint', { get: () => true, configurable: true });
  player.stamina.drain = () => {};
}

const planarSpeed = (p) => Math.hypot(p._velocity.x, p._velocity.z);

/** Hold an input on flat ground until the speed settles, and report it. */
function settledSpeed({ sprint = false, crouch = false, boost = 0, seconds = 20 } = {}) {
  const physics = flatWorld();
  const player = makePlayer(physics);
  player._position.set(0, 0.5, 0);
  for (let i = 0; i < 180; i++) player.fixedUpdate(DT, i * DT);
  unlimitedStamina(player);
  if (boost) player.boostSpeed(boost, 1e6);
  player.input.state.forward = 1;
  player.input.state.sprint = sprint;
  player.input.state.crouch = crouch;
  let t = 3;
  // Three seconds of run-up before the clock starts: the question is the
  // sustained speed, not the average of the acceleration ramp and it.
  for (let i = 0; i < 180; i++, t += DT) player.fixedUpdate(DT, t);
  const n = Math.round(seconds / DT);
  const from = player.position.clone();
  for (let i = 0; i < n; i++, t += DT) player.fixedUpdate(DT, t);
  return {
    velocity: planarSpeed(player),
    displacement: from.distanceTo(player.position) / seconds,
    sprinting: player._sprinting,
  };
}

/* ------------------------------------------------------------------ */
/* The ceiling, and the config agreeing with it                        */
/* ------------------------------------------------------------------ */

test('the top ground speed is acceleration / friction, whatever is wished for', () => {
  /* Driven, not derived: the claim is about `Player._move`, so `_move` is what
   * answers it. The closed form is asserted alongside because a match to six
   * decimals is what makes this a statement about the mechanism rather than a
   * recorded observation. */
  const cap = P.acceleration / P.friction;
  const r = settledSpeed({ sprint: true });
  assert.equal(r.sprinting, true, 'the sprint never engaged - the measurement is of a walk');
  assert.ok(Math.abs(r.velocity - cap) < 1e-9,
    `a sprint settles at ${r.velocity.toFixed(6)} m/s against acceleration/friction = ${cap}`);
  assert.ok(Math.abs(r.displacement - cap) < 1e-6,
    `the capsule covered ${r.displacement.toFixed(6)} m/s of ground at a velocity of ${cap}`);
});

test('CONFIG.player.sprintSpeed is that speed, and no longer a number nothing can reach', () => {
  /* THE FIX, in one line - twice over. This constant read 8.2 against a ratio
   * of 60/10, was corrected down to the 6.0 that ratio delivered, and now reads
   * 8.2 again because the ratio was moved to 82/10 to meet it. The assertion is
   * the same one throughout: whatever it says, a sprint measures it. */
  const r = settledSpeed({ sprint: true });
  assert.ok(Math.abs(P.sprintSpeed - r.velocity) < 1e-9,
    `the config advertises ${P.sprintSpeed} m/s and a sprint measures ${r.velocity.toFixed(6)}`);
  assert.equal(P.sprintSpeed, P.acceleration / P.friction,
    'sprintSpeed has drifted off acceleration/friction; one of the three was changed alone');
});

test('walkSpeed and crouchSpeed are under the ceiling, so they were always honest', () => {
  /* The contrast that says the sprint constant was the defect and not the
   * scheme: a wish BELOW the cap is reached exactly. */
  const walk = settledSpeed({});
  assert.ok(Math.abs(walk.velocity - P.walkSpeed) < 1e-9,
    `a walk settles at ${walk.velocity.toFixed(6)} against a configured ${P.walkSpeed}`);
  const crouch = settledSpeed({ crouch: true });
  assert.ok(Math.abs(crouch.velocity - P.crouchSpeed) < 1e-9,
    `a crouch settles at ${crouch.velocity.toFixed(6)} against a configured ${P.crouchSpeed}`);
  assert.ok(P.walkSpeed < P.sprintSpeed && P.crouchSpeed < P.walkSpeed,
    'the three stances no longer order the way the player expects them to');
});

test('a speed boost multiplies the CAP, so it is felt at every gait', () => {
  /* THE SECOND FIX. `Player.boostSpeed` is what the speed pickup calls, and
   * `speedMultiplier` used to scale only the WISH - which a sprint is already
   * over, so a 1.5x and a 3.0x potion both measured exactly the cap and the
   * pickup read as a no-op to anyone who tried it while running.
   *
   * `_move` now hands `P.acceleration * speedMultiplier` to the grounded
   * accelerator. The cap is `acceleration / friction`, so scaling the numerator
   * scales the ceiling by the same factor the wish is scaled by, and every gait
   * ends up at exactly `multiplier * ` its unboosted speed - a sprint because
   * the cap moved, a walk because its wish was under the cap all along and
   * still is. Friction is untouched, so a boosted player stops in the same
   * time, just from further out. */
  const cap = P.acceleration / P.friction;
  for (const boost of [1.5, 3]) {
    const sprint = settledSpeed({ sprint: true, boost });
    assert.ok(Math.abs(sprint.velocity - cap * boost) < 1e-9,
      `a ${boost}x speed boost took a sprint to ${sprint.velocity.toFixed(6)} m/s, `
      + `not ${(cap * boost).toFixed(6)} - the boost is scaling the wish alone again`);
    const walk = settledSpeed({ boost });
    assert.ok(Math.abs(walk.velocity - P.walkSpeed * boost) < 1e-9,
      `a ${boost}x boosted walk settled at ${walk.velocity.toFixed(6)}, not `
      + `${(P.walkSpeed * boost).toFixed(6)}`);
    // The boosted walk has to stay WISH-limited or the row above is measuring
    // the cap by accident: `acceleration * boost >= walkSpeed * boost * friction`
    // holds for every multiplier at once, so this is really a claim about 82.
    assert.ok(P.walkSpeed * boost < cap * boost,
      'a boosted walk is now at the boosted cap, and the two rows above no longer differ');
  }
  /* The regression that would be silent: raising the cap by lowering `friction`
   * instead of raising `acceleration` also gets 8.2, and every case above would
   * still pass. This is what says which lever was pulled.
   * @see ../../src/core/Config.js `acceleration` */
  assert.equal(P.friction, 10,
    'friction moved. Whatever the cap now reads, stopping, turning and landing decay all '
    + 'just got slower together - re-read the lever comparison in Config.js before accepting it');
});

test('the controller consumes the wish, and the wish is still above the reachable speed', async () => {
  const src = await readSrc('src/player/Player.js');
  assert.match(src, /this\._sprinting \? P\.sprintWishSpeed : P\.walkSpeed/,
    'the sprint wish is back to reading `sprintSpeed`; with that constant now truthful, this '
    + 'silently changes how a leap landing decays');
  assert.doesNotMatch(src, /P\.sprintSpeed/,
    'something in the controller reads the advertised speed as if it were a wish');
  assert.ok(P.sprintWishSpeed > P.sprintSpeed,
    'the wish is no longer above the ceiling, which is the only reason there are two constants');
  /* The boost has to reach the ACCELERATION, not just the wish, or the cap
   * stops moving with it and the pickup goes back to being a no-op on a sprint.
   * Asserted on the source as well as on the measurement above because the
   * measurement would also pass if someone raised the wish instead. */
  assert.match(src, /P\.acceleration \* boost/,
    'the grounded accelerator no longer scales with `speedMultiplier`; a speed boost can only '
    + 'move the wish again, and a sprint is already over it');
  /* The wish is a ratio to the cap, not a constant: `Parkour.tryLeap` scales
   * standing velocity, so the speed the wish has to out-reach scales with the
   * cap too. 8.2/6.0 was 1.367; 11.2/8.2 is 1.366. */
  const ratio = P.sprintWishSpeed / P.sprintSpeed;
  assert.ok(ratio > 1.3 && ratio < 1.45,
    `the wish is now ${ratio.toFixed(3)}x the cap against the 1.367 it was designed at - both `
    + 'the landing decay and the FOV sprint-kick amplitude are set by this ratio');
});

/* ------------------------------------------------------------------ */
/* Nothing moved: the hash                                             */
/* ------------------------------------------------------------------ */

/** FNV-1a, 8 hex characters. The same hash `SaveGame.js` uses. */
function fnv1a(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * A scripted 30-second run over flat ground, hashed step by step.
 *
 * Everything the sprint constants can touch is in the tape, not just the steady
 * jog: the acceleration ramp, a strafing turn, a stop, a crouch, and - the case
 * that actually distinguishes the wish from the cap - a sprinting jump, whose
 * `parkour.tryLeap` scales the standing velocity by 1.42 to 11.64 m/s and lands
 * the player back on the deck ABOVE the friction cap, where the wish is still
 * being applied on the way down.
 *
 * Quantised to 0.1 mm so the hash cannot be a float-formatting artefact, and
 * over both position and velocity so a run that ends in the same place by a
 * different route still fails.
 */
function runHash() {
  const physics = flatWorld();
  const player = makePlayer(physics);
  player._position.set(0, 0.5, 0);
  for (let i = 0; i < 120; i++) player.fixedUpdate(DT, i * DT);

  const s = player.input.state;
  /** [seconds, forward, right, sprint, crouch, jump, yaw] */
  const tape = [
    [3, 1, 0, false, false, false, YAW_PLUS_X],   // walk from rest
    [3, 1, 0, true, false, false, YAW_PLUS_X],    // into a sprint
    [2, 1, 1, true, false, false, YAW_PLUS_X],    // sprint on the diagonal
    [2, 1, 0, true, false, true, YAW_PLUS_X],     // sprinting jump: the leap
    [3, 1, 0, true, false, false, YAW_PLUS_X],    // ...and the landing decay
    [2, 0, 1, false, false, false, YAW_PLUS_X],   // strafe
    [2, 1, 0, false, false, false, Math.PI],      // turn and walk
    [2, 1, 0, false, true, false, Math.PI],       // crouch-walk
    [2, 0, 0, false, false, false, Math.PI],      // stop dead
    [3, -1, 0, true, false, false, Math.PI],      // back away, sprint refused
    [3, 1, 0, true, false, false, Math.PI],       // sprint until stamina bites
    [3, 1, 0, true, false, false, Math.PI],       // ...and past it
  ];

  const parts = [];
  const q = (v) => Math.round(v * 1e4);
  let t = 2;
  for (const [secs, forward, right, sprint, crouch, jump, yaw] of tape) {
    s.forward = forward; s.right = right; s.sprint = sprint; s.crouch = crouch; s.jump = jump;
    player.setYaw(yaw);
    for (let i = 0; i < Math.round(secs / DT); i++, t += DT) {
      player.fixedUpdate(DT, t);
      const p = player._position;
      const v = player._velocity;
      parts.push(`${q(p.x)},${q(p.y)},${q(p.z)},${q(v.x)},${q(v.y)},${q(v.z)}`);
    }
  }
  return { hash: fnv1a(parts.join(';')), steps: parts.length, last: parts[parts.length - 1] };
}

test('THE RATCHET: a scripted flat-ground run is bit-identical to the recorded tape', () => {
  /* RE-RECORDED, once, deliberately, and this is the change it was waiting for.
   *
   * It held '834f9782' from c6b3b94 through the split of `sprintSpeed` into an
   * advertised speed and a wish, which is exactly what that ratchet was for:
   * proving a rename was a rename. Raising `acceleration` from 60 to 82 is not
   * a rename - it moves every velocity in the tape - so the hash moves with it,
   * once, here.
   *
   * From here it ratchets the new movement. If it fails again, nothing about
   * this run is supposed to have changed: check `acceleration`, `friction`,
   * `sprintWishSpeed`, and that `_move` still hands the accelerator
   * `P.acceleration * boost` and the wish `P.sprintWishSpeed`. */
  const a = runHash();
  const b = runHash();
  assert.equal(a.hash, b.hash, 'the run is not deterministic; the hash cannot ratchet anything');
  assert.equal(a.steps, 1800, 'the tape changed length - the recorded hash is about a different run');
  assert.equal(a.hash, '61e1898c',
    `flat-ground movement changed. The run ends at ${a.last} (x,y,z,vx,vy,vz in 0.1 mm units).`);
});

test('the leap in the tape lands the player over the cap, and the wish is what decays it', () => {
  /* Guards the case above from decaying into a test of a jog, and pins the ONE
   * behaviour `sprintWishSpeed` exists for.
   *
   * `Parkour.tryLeap` SCALES standing velocity by 1.42 rather than setting a
   * speed, so raising the cap raised the leap with it: 6.0 * 1.42 = 8.52
   * before, 8.2 * 1.42 = 11.64 now. That is why the wish had to be raised in
   * proportion. Between the cap and the wish, `_accelerate` is still adding, so
   * the landing bleeds off over about a third of a second instead of snapping.
   * With the wish left at 8.2 - i.e. AT the new cap - the same landing measures
   * 11.644 -> 9.703 -> 8.200 and is over in 0.033 s. */
  const physics = flatWorld();
  const player = makePlayer(physics);
  player._position.set(0, 0.5, 0);
  for (let i = 0; i < 180; i++) player.fixedUpdate(DT, i * DT);
  unlimitedStamina(player);
  player.input.state.forward = 1;
  player.input.state.sprint = true;
  let t = 3;
  for (let i = 0; i < 180; i++, t += DT) player.fixedUpdate(DT, t);
  const cruise = planarSpeed(player);
  player.input.state.jump = true;
  let peak = 0, landStep = null, decay = null;
  for (let i = 0; i < 400; i++, t += DT) {
    player.fixedUpdate(DT, t);
    if (i === 2) player.input.state.jump = false;
    const v = planarSpeed(player);
    if (!player.grounded) peak = Math.max(peak, v);
    else if (landStep === null && i > 5) landStep = i;
    if (landStep !== null && decay === null && v <= cruise * 1.01) decay = (i - landStep) * DT;
  }
  assert.ok(peak > P.sprintSpeed + 1,
    `a sprinting jump peaked at ${peak.toFixed(3)} m/s, which is not meaningfully over the `
    + `${P.sprintSpeed} m/s ground cap - the hash no longer exercises the wish`);
  /* Tighter than the old `wish + 0.4` slack, and tied to the mechanism: the
   * peak is the cruise scaled by `Parkour`'s LEAP_BOOST and nothing else, which
   * is what makes "raising the cap raises the leap" a fact rather than a guess. */
  assert.ok(Math.abs(peak - cruise * 1.42) < 1e-6,
    `a sprinting jump peaked at ${peak.toFixed(6)} against a cruise of ${cruise.toFixed(6)} `
    + 'scaled by Parkour\'s LEAP_BOOST of 1.42 - something else is adding speed in the air');
  assert.ok(peak > P.sprintWishSpeed,
    `the leap peaks at ${peak.toFixed(3)} and the wish is ${P.sprintWishSpeed} - the wish now `
    + 'covers the whole landing, so it is no longer the decay that is being measured');
  /* 0.350 s, and it was 0.350 s at a cap of 6.0 and a wish of 8.2. Holding the
   * wish/cap ratio is what kept it there; the window is wide enough to allow a
   * frame either way and far too narrow to admit the 0.033 s collapse. */
  assert.ok(decay !== null && decay > 0.2 && decay < 0.5,
    `a leap landing decayed to the cap in ${decay} s against the 0.350 s it has always taken - `
    + 'check `sprintWishSpeed` against `sprintSpeed`, this is the ratio between them');
});
