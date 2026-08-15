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
 * `CONFIG.player.sprintSpeed` read 8.2 and nothing in the game could go 8.2.
 * That is not a rounding error, it is a number a reader would reason from - and
 * did: a balance test asserted "nothing outruns a sprinting player" against it,
 * and another test hard-coded 8.2 as the player's top speed.
 *
 * ── The mechanism ─────────────────────────────────────────────────────────
 * `Player._move` runs friction and then acceleration on every grounded step:
 *
 *     friction     v -= v * friction * dt          (above STOP_SPEED)
 *     accelerate   v += min(acceleration * dt, wish - v)
 *
 * At the fixed point the two cancel: `v * friction * dt = acceleration * dt`,
 * so **v = acceleration / friction**, 60 / 10 = 6.0 m/s. The step length
 * cancels, and so does the wish - every wish at or above the cap converges on
 * exactly the same speed. A sprint therefore tops out at 6.0 whatever the
 * config says, and so does a boosted walk, and so does a boosted sprint.
 *
 * ── What changed, and what deliberately did not ───────────────────────────
 * `sprintSpeed` now reads 6.0, the speed a sprint reaches. The number the
 * accelerator consumes moved to `sprintWishSpeed` and is unchanged at 8.2,
 * because lowering it is NOT free: while the player is above the cap - coming
 * down from a parkour leap landing at 8.52 m/s - a wish of 8.2 keeps pushing
 * and a wish of 6.0 does not, and that is momentum you can feel.
 *
 * The alternative was to make sprint genuinely faster instead (`acceleration:
 * 82`, or `friction: 7.3`, either of which puts the cap at 8.2 and makes the
 * old constant true). That changes how the whole game moves, so it was left for
 * the owner to decide. @see ../../src/core/Config.js
 *
 * The last case is the ratchet on "deliberately did not": an FNV-1a hash of
 * position and velocity over a 30-second scripted run, which is unchanged from
 * c6b3b94.
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
  /* THE FIX, in one line. It read 8.2. */
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

test('a speed boost cannot make a sprint faster, because the wish is already over the cap', () => {
  /* Not a hypothetical: `Player.boostSpeed` is what the speed pickup calls, and
   * `speedMultiplier` only ever scales the WISH. Worth pinning because it is
   * the most expensive consequence of the ceiling and the least obvious - a
   * pickup that reads as a no-op to anyone who tries it while sprinting. */
  const cap = P.acceleration / P.friction;
  for (const boost of [1.5, 3]) {
    const r = settledSpeed({ sprint: true, boost });
    assert.ok(Math.abs(r.velocity - cap) < 1e-9,
      `a ${boost}x speed boost took a sprint to ${r.velocity.toFixed(6)} m/s, not ${cap}`);
  }
  // A boosted WALK does move, because its wish starts under the cap - it just
  // stops at the cap rather than at 1.5 * walkSpeed.
  const walk = settledSpeed({ boost: 1.5 });
  assert.ok(Math.abs(walk.velocity - cap) < 1e-9,
    `a boosted walk settled at ${walk.velocity.toFixed(6)}, not the ceiling`);
  assert.ok(1.5 * P.walkSpeed > cap, 'the fixture no longer exercises a boost that the cap clips');
});

test('the controller consumes the wish, and the wish is documented as unreachable', async () => {
  const src = await readSrc('src/player/Player.js');
  assert.match(src, /this\._sprinting \? P\.sprintWishSpeed : P\.walkSpeed/,
    'the sprint wish is back to reading `sprintSpeed`; with that constant now truthful, this '
    + 'silently changes how a leap landing decays');
  assert.doesNotMatch(src, /P\.sprintSpeed/,
    'something in the controller reads the advertised speed as if it were a wish');
  assert.ok(P.sprintWishSpeed > P.sprintSpeed,
    'the wish is no longer above the ceiling, which is the only reason there are two constants');
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
 * that actually distinguishes a wish of 8.2 from a wish of 6.0 - a sprinting
 * jump, whose `parkour.tryLeap` scales the standing velocity to 8.52 m/s and
 * lands the player back on the deck ABOVE the friction cap, where the wish is
 * still being applied on the way down.
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

test('THE RATCHET: a scripted flat-ground run is bit-identical to c6b3b94', () => {
  /* Recorded by running this exact function against c6b3b94 - before
   * `sprintSpeed` was split into an advertised speed and a wish - and again
   * after. The whole no-feel-change claim is this one string.
   *
   * If this fails, the rename stopped being a rename. Check `Player._move`'s
   * wish first: `sprintWishSpeed` must still be 8.2 and must still be what the
   * accelerator is handed. */
  const a = runHash();
  const b = runHash();
  assert.equal(a.hash, b.hash, 'the run is not deterministic; the hash cannot ratchet anything');
  assert.equal(a.steps, 1800, 'the tape changed length - the recorded hash is about a different run');
  assert.equal(a.hash, '834f9782',
    `flat-ground movement changed. The run ends at ${a.last} (x,y,z,vx,vy,vz in 0.1 mm units).`);
});

test('the leap in the tape really does land the player over the friction cap', () => {
  /* Guards the case above from decaying into a test of a jog. If the sprinting
   * jump ever stops exceeding 6.0 m/s, the hash stops covering the ONE state in
   * which the wish and the cap disagree, and the ratchet quietly weakens. */
  const physics = flatWorld();
  const player = makePlayer(physics);
  player._position.set(0, 0.5, 0);
  for (let i = 0; i < 180; i++) player.fixedUpdate(DT, i * DT);
  unlimitedStamina(player);
  player.input.state.forward = 1;
  player.input.state.sprint = true;
  let t = 3;
  for (let i = 0; i < 180; i++, t += DT) player.fixedUpdate(DT, t);
  player.input.state.jump = true;
  let peak = 0;
  for (let i = 0; i < 240; i++, t += DT) {
    player.fixedUpdate(DT, t);
    if (i === 2) player.input.state.jump = false;
    if (!player.grounded) peak = Math.max(peak, planarSpeed(player));
  }
  assert.ok(peak > P.sprintSpeed + 1,
    `a sprinting jump peaked at ${peak.toFixed(3)} m/s, which is not meaningfully over the `
    + `${P.sprintSpeed} m/s ground cap - the hash no longer exercises the wish`);
  assert.ok(peak <= P.sprintWishSpeed + 0.4,
    `a sprinting jump reached ${peak.toFixed(3)} m/s, past the wish it is accelerated toward`);
});
