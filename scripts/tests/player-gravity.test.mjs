import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { Physics } from '../../src/physics/Physics.js';
import { CONFIG } from '../../src/core/Config.js';
import { worldGravity, worldGravityRatio, GRAVITY_RATIO_MIN } from '../../src/worlds/WorldRules.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readSrc = async (p) => (await readFile(path.join(root, p), 'utf8')).replace(/\r\n/g, '\n');

/**
 * DOES A PLANET'S GRAVITY REACH THE PLAYER'S FEET?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE GAP THIS FILE CLOSED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ten planet descriptors publish a real surface gravity, from Tessera's 1.62
 * m/s² to Verdigris' 10.10 - a 6.2x span. `Piloting._env` read it for the SHIP
 * and nothing read it for the PLAYER, so a pilot could feel a sixth of a g
 * settle their hull onto a moon, step out, and jump precisely as high as they
 * do in a shopping concourse. Both planet docstrings said so out loud, which
 * was the honest thing to do with one planet and a waste of a whole dimension
 * of variety with ten.
 *
 * ── What is asserted here, and why each one can go red ────────────────────
 *
 *  1. SIX SHIPPED WORLDS ARE UNTOUCHED. Station, medieval, citadel, sports,
 *     race, maze and dock publish no gravity, and there are tests pinned to
 *     their feel down to the metre. The ratchet below is an FNV-1a hash of a
 *     30-second scripted run - walk, sprint, leap, jump, fall, crouch, stop -
 *     recorded against the controller BEFORE per-world gravity existed, by
 *     checking `src/player/Player.js` out at HEAD and driving the same tape.
 *     If any of this leaks into a world that said nothing, the hash moves.
 *
 *  2. THE JUMP IS A DESIGN AND NOT AN ACCIDENT. Scaling gravity and leaving
 *     the impulse alone makes Tessera's apex 6.1x the default and 5.2x
 *     Cinder's, which is a catapult. The rule chosen is `airtime grows as the
 *     square of jump height`, which fixes the exponent at exactly 1/3 rather
 *     than to taste, and it is asserted as that relation and not as two
 *     remembered numbers.
 *
 *  3. FALL DAMAGE IS NOT A TRAP. It is keyed to impact SPEED in `Parkour` and
 *     therefore scales for free - but "for free" is a claim, so it is driven:
 *     the player is dropped onto a real slab from a real height under a real
 *     integrator and the health bar is read afterwards.
 *
 *  4. THE REACH PROBES AND THE GAME STILL AGREE. `planet-reach.test.mjs` and
 *     `planet-minerals.test.mjs` flood a walk graph - 0.45 m step-up, 38 deg
 *     slope, 3.0 m drop, no jump, no mantle - to prove every mineral node on
 *     every planet can be walked to. Those probes model NO gravity at all, so
 *     the question is whether the GAME's walkable envelope moved underneath
 *     them. It is driven both ways below.
 *
 *  5. NOTHING GOES NON-FINITE. This project lost a day to nineteen NaN pixels
 *     blacking out a 921,600-pixel frame through the bloom pass. A long fall,
 *     a zero-gravity world and a half-second frame spike are all walked with
 *     every numeric field on the controller checked every step.
 */

const DT = 1 / 60;
const P = CONFIG.player;

/* ================================================================== */
/* Harness                                                             */
/* ================================================================== */

/**
 * The one renderer-bound thing `Player` builds is `Weapon`, whose viewmodel
 * textures are painted on a 2D canvas and thrown away headless. Same concession
 * `player-speed.test.mjs` and `player-slope.test.mjs` make, for the same
 * reason: it takes no part in locomotion.
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
const SRC_PLAYER = await readSrc('src/player/Player.js');

/**
 * A real event bus, not the `() => {}` stub the speed tests use.
 *
 * `Parkour` learns about a landing by SUBSCRIPTION - `Player._land` emits
 * `player:landed` and `Parkour._onLand` computes the damage from it - so a bus
 * that drops events is a fall-damage test that always measures zero.
 */
function makeBus() {
  const map = new Map();
  return {
    on(key, fn) {
      let set = map.get(key);
      if (!set) map.set(key, (set = new Set()));
      set.add(fn);
      return () => set.delete(fn);
    },
    emit(key, payload) {
      const set = map.get(key);
      if (set) for (const fn of [...set]) fn(payload);
    },
  };
}

/** A single flat slab with its top at y = 0, large enough that no run reaches an edge. */
function flatWorld() {
  const physics = new Physics();
  const deck = new THREE.Mesh(new THREE.BoxGeometry(8000, 2, 8000));
  deck.position.set(0, -1, 0);
  deck.updateWorldMatrix(true, false);
  physics.addBoxFromObject(deck);
  return physics;
}

/** Add an axis-aligned box by its extents, top-inclusive. */
function slab(physics, { x0, x1, z0 = -40, z1 = 40, y0, y1 }) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0));
  mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  mesh.updateWorldMatrix(true, false);
  physics.addBoxFromObject(mesh);
  return mesh;
}

/** Facing is -Z at yaw 0, so this points forward along +X. */
const YAW_PLUS_X = -Math.PI / 2;

function makePlayer(physics, { yaw = YAW_PLUS_X, bus = makeBus() } = {}) {
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

function unlimitedStamina(player) {
  if (!player.stamina) return;
  Object.defineProperty(player.stamina, 'canSprint', { get: () => true, configurable: true });
  player.stamina.drain = () => {};
  player.stamina.spend = () => true;
}

/** A world object shaped exactly like the one `world:changed` carries. */
const planet = (id, gravity) => ({ id, gravity });

/* The published descriptors, transcribed. Not imported: `src/worlds/planets/*`
 * is being edited by other agents as the last bodies land, and this file is
 * about the CONTROLLER, not about which planets exist this hour. The ladder
 * test below re-reads the real descriptors where it can. */
const PLANETS = [
  ['tessera', 1.62], ['lathe', 1.90], ['cathedra', 6.60], ['carnelian', 7.40],
  ['vitrine', 7.80], ['sallow', 8.10], ['cinder', 8.44], ['sirocco', 9.10],
  ['shoal', 9.60], ['verdigris', 10.10],
];
const LIGHTEST = planet('tessera', 1.62);
const HEAVIEST = planet('verdigris', 10.10);

/* ================================================================== */
/* 1. A world that publishes nothing is the game that shipped          */
/* ================================================================== */

test('a world with no published gravity restores the config by assignment', () => {
  const player = makePlayer(flatWorld());

  // Every shape of "this world says nothing", including the null the player
  // holds before the first world ever loads.
  for (const world of [null, undefined, {}, { id: 'station' }, { id: 'maze', gravity: null },
    { id: 'x', gravity: NaN }, { id: 'x', gravity: Infinity }, { id: 'x', gravity: '9.81' }]) {
    player.setWorldGravity(LIGHTEST);   // dirty it first, or this proves nothing
    player.setWorldGravity(world);
    assert.equal(player.gravity, P.gravity, `gravity drifted for ${JSON.stringify(world)}`);
    assert.equal(player.jumpVelocity, P.jumpVelocity, `jump drifted for ${JSON.stringify(world)}`);
    assert.equal(player.airAcceleration, P.airAcceleration, `air control drifted`);
    assert.equal(player.gravityRatio, 1);
  }
});

test('the four values are the config values, not a multiply that lands near them', () => {
  /* `-22 * 1.0` is -22 and `6.4 * Math.pow(1, 1/3)` is 6.4, so a multiply would
   * pass the equality above today. It would not survive someone changing the
   * exponent, and the six shipped worlds cannot be allowed to depend on the
   * exactness of `Math.pow`. The restore path is an assignment and the source
   * says so. */
  assert.match(SRC_PLAYER, /if \(published === null\) \{[\s\S]{0,400}?this\._gravity = P\.gravity;/,
    'the "world published nothing" branch no longer restores `P.gravity` by assignment');
});

test('a world that publishes Earth is indistinguishable from one that publishes nothing', () => {
  /* The scale test. `CONFIG.player.gravity` is -22 and `gravityReference` is
   * 9.81, which asserts that -22 IS one g in this game. A descriptor that
   * publishes 9.81 must therefore come out at exactly -22 and not near it, or
   * the two constants are not talking about the same thing. */
  const player = makePlayer(flatWorld());
  player.setWorldGravity(planet('earthlike', P.gravityReference));
  assert.equal(player.gravityRatio, 1);
  assert.equal(player.gravity, P.gravity);
  assert.equal(player.jumpVelocity, P.jumpVelocity);
  assert.equal(player.airAcceleration, P.airAcceleration);
});

/** FNV-1a, 8 hex characters. The same hash `SaveGame.js` and `player-speed` use. */
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
 * Everything per-world gravity can touch is in the tape and not just the jog:
 * the standing jump (`_jumpVelocity`), the sprinting leap (whose lift `Parkour`
 * writes absolutely and `Player` rescales), the airborne steering
 * (`_airAcceleration`), the fall and the landing.
 *
 * Quantised to 0.1 mm over both position and velocity, so a run that ends in
 * the same place by a different route still fails.
 */
function runHash(world) {
  const physics = flatWorld();
  const player = makePlayer(physics);
  player.setWorldGravity(world);
  player._position.set(0, 0.5, 0);
  for (let i = 0; i < 120; i++) player.fixedUpdate(DT, i * DT);

  const s = player.input.state;
  /** [seconds, forward, right, sprint, crouch, jump, yaw] */
  const tape = [
    [3, 1, 0, false, false, false, YAW_PLUS_X],   // walk from rest
    [3, 1, 0, true, false, false, YAW_PLUS_X],    // into a sprint
    [1, 1, 0, false, false, true, YAW_PLUS_X],    // a standing-gait jump
    [1, 1, 0, false, false, false, YAW_PLUS_X],   // ...and the landing
    [2, 1, 1, true, false, false, YAW_PLUS_X],    // sprint on the diagonal
    [2, 1, 0, true, false, true, YAW_PLUS_X],     // sprinting jump: the leap
    [3, 1, 0, true, false, false, YAW_PLUS_X],    // ...and the landing decay
    [2, 0, 1, false, false, false, YAW_PLUS_X],   // strafe
    [2, 1, 0, false, false, false, Math.PI],      // turn and walk
    [2, 1, 0, false, true, false, Math.PI],       // crouch-walk
    [2, 0, 0, false, false, false, Math.PI],      // stop dead
    [3, -1, 0, true, false, false, Math.PI],      // back away, sprint refused
    [4, 1, 0, true, false, false, Math.PI],       // sprint until stamina bites
  ];

  const parts = [];
  const q = (v) => Math.round(v * 1e4);
  let t = 2;
  for (const [secs, forward, right, sprint, crouch, jump, yaw] of tape) {
    s.forward = forward; s.right = right; s.sprint = sprint; s.crouch = crouch; s.jump = jump;
    player.setYaw(yaw);
    for (let i = 0, n = Math.round(secs / DT); i < n; i++, t += DT) {
      player.fixedUpdate(DT, t);
      const p = player.position;
      const v = player.velocity;
      parts.push(`${q(p.x)},${q(p.y)},${q(p.z)},${q(v.x)},${q(v.y)},${q(v.z)}`);
    }
  }
  return { hash: fnv1a(parts.join(';')), steps: parts.length };
}

/**
 * THE RATCHET.
 *
 * Recorded by checking `src/player/Player.js` out at HEAD - the controller
 * before per-world gravity existed - and driving the identical tape through it.
 * It is the promise to station, medieval, citadel, sports, race, maze and dock
 * that this change cannot be felt in any of them.
 *
 * If this fails, per-world gravity has leaked into a world that published none.
 * Do not re-record it without knowing which step diverged first.
 */
const BASELINE_HASH = 'e70852dc';

test('a world with no gravity moves byte-for-byte as it did before planets had any', () => {
  const before = runHash(null);
  assert.equal(before.hash, BASELINE_HASH,
    `the default-gravity tape now hashes ${before.hash} over ${before.steps} steps`);
});

test('...and so does a world that publishes 9.81, down to the same hash', () => {
  assert.equal(runHash(planet('earthlike', P.gravityReference)).hash, BASELINE_HASH);
});

test('...while every planet moves differently, or nothing was wired up at all', () => {
  const base = runHash(null).hash;
  const seen = new Map();
  for (const [id, g] of PLANETS) {
    const h = runHash(planet(id, g)).hash;
    assert.notEqual(h, base, `${id} (${g} m/s²) produced the default tape - gravity never reached it`);
    assert.equal(seen.has(h), false, `${id} moves identically to ${seen.get(h)}`);
    seen.set(h, id);
  }
});

/* ================================================================== */
/* 2. The jump: what was preserved, and what it measures               */
/* ================================================================== */

/**
 * One standing jump on flat ground, driven through the real integrator.
 *
 * @returns {{apex:number, hang:number, takeoff:number, impact:number}}
 */
function jumpArc(world, { sprint = false } = {}) {
  const physics = flatWorld();
  const player = makePlayer(physics);
  player.setWorldGravity(world);
  player._position.set(0, 0.5, 0);
  const s = player.input.state;
  // Settle onto the deck, then run up if this is a leap.
  for (let i = 0; i < 180; i++) player.fixedUpdate(DT, i * DT);
  unlimitedStamina(player);
  let t = 3;
  if (sprint) {
    s.forward = 1; s.sprint = true;
    for (let i = 0; i < 240; i++, t += DT) player.fixedUpdate(DT, t);
  }
  const groundY = player.position.y;

  // The jump is an EDGE: held is consumed by `_jumpHeld` on the first step.
  s.jump = true;
  player.fixedUpdate(DT, t); t += DT;
  s.jump = false;
  const takeoff = player.velocity.y;

  let apex = player.position.y;
  let hang = 0;
  let impact = 0;
  for (let i = 0; i < 3000; i++, t += DT) {
    const wasAir = !player.grounded;
    player.fixedUpdate(DT, t);
    if (!player.grounded) {
      hang += DT;
      apex = Math.max(apex, player.position.y);
      impact = Math.min(impact, player.velocity.y);
    } else if (wasAir && hang > 0) {
      break;
    }
  }
  return { apex: apex - groundY, hang, takeoff, impact: -impact };
}

test('apex and hang time on the lightest and heaviest planets are the design, measured', () => {
  const base = jumpArc(null);
  const light = jumpArc(LIGHTEST);
  const heavy = jumpArc(HEAVIEST);

  const row = (n, r) => `  ${n.padEnd(11)} takeoff ${r.takeoff.toFixed(3)} m/s   `
    + `apex ${r.apex.toFixed(3)} m   hang ${r.hang.toFixed(3)} s`;
  console.log('   A STANDING JUMP, DRIVEN');
  console.log(row('default', base));
  console.log(row('tessera', light));
  console.log(row('verdigris', heavy));

  /* ── The rule, stated as a relation and not as remembered numbers ──────
   * `airtime grows as the square of jump height`. With apex ratio A and hang
   * ratio H against the default world, the design says H = A². It is what
   * fixes the exponent at 1/3, so it is what has to be asserted; two hard
   * numbers would pass just as well if someone changed BOTH by hand. */
  const A = light.apex / base.apex;
  const H = light.hang / base.hang;
  /* 5%, and the slack is the 60 Hz quantiser and not the design: `hang` is
   * counted in whole steps and the measurement drops the takeoff step, which
   * is a 3-step bite out of a 32-step default jump and out of a 113-step
   * Tessera one alike. The relation is exact in the closed form. */
  assert.ok(Math.abs(H - A * A) / H < 0.05,
    `Tessera is ${A.toFixed(3)}x the apex and ${H.toFixed(3)}x the hang time; `
    + `the design says hang = apex² = ${(A * A).toFixed(3)}x`);

  /* ── Floaty, not a trampoline ─────────────────────────────────────────
   * The failure mode this exponent exists to prevent is scaling gravity and
   * leaving the impulse alone, which puts Tessera's apex at 6x the default
   * and 6.2x Verdigris'. Both rails are asserted: high enough to be
   * unmistakably a moon, low enough not to be a catapult over authored
   * geometry that has no roof on it. */
  assert.ok(A > 1.5 && A < 2.2,
    `Tessera's jump apex is ${A.toFixed(2)}x the default (${light.apex.toFixed(3)} m). `
    + 'Under 1.5x nobody can feel the moon; over 2.2x it clears things no world has a lid on');
  assert.ok(H > 3.0 && H < 3.7,
    `Tessera hangs for ${H.toFixed(2)}x the default (${light.hang.toFixed(3)} s)`);

  /* ── A 1.03 g planet is a 1.00 g planet, felt ─────────────────────────
   * Verdigris publishes 10.10 against Earth's 9.81, so it must come out a
   * shade heavier than every hand-built world and no more. If this drifts,
   * somebody has fed the raw m/s² to the integrator and Verdigris - the
   * HEAVIEST body in the system - has become less than half the weight of a
   * shopping concourse. */
  assert.ok(heavy.apex < base.apex && heavy.apex > base.apex * 0.95,
    `Verdigris apex ${heavy.apex.toFixed(3)} m against the default ${base.apex.toFixed(3)} m`);
  /* Non-strict on the hang, because 3% of a 32-step jump is one step and the
   * quantiser eats it. Apex is continuous and carries the ordering. */
  assert.ok(heavy.hang <= base.hang && heavy.hang > base.hang * 0.9,
    `Verdigris hang ${heavy.hang.toFixed(3)} s against the default ${base.hang.toFixed(3)} s`);

  /* The span the whole change exists for: 1.62 against 10.10 is 6.2x of
   * gravity, and that has to be legible on foot. */
  assert.ok(light.hang / heavy.hang > 3,
    `the lightest and heaviest planets are only ${(light.hang / heavy.hang).toFixed(2)}x apart in hang time`);
});

test('the ladder is monotonic: heavier planets jump lower and land sooner', () => {
  let prev = null;
  const rows = [];
  for (const [id, g] of PLANETS) {
    const r = jumpArc(planet(id, g));
    rows.push(`  ${id.padEnd(10)} ${g.toFixed(2)} m/s²  apex ${r.apex.toFixed(3)} m  hang ${r.hang.toFixed(3)} s`);
    if (prev) {
      assert.ok(r.apex < prev.r.apex, `${id} jumps higher than the lighter ${prev.id}`);
      /* Non-strict, and deliberately: `hang` is counted in 60 Hz steps, and
       * the closest pair on this ladder - Sallow 8.10 against Cinder 8.44 -
       * is 1.07 steps apart. Asserting `<` there would be asserting that the
       * quantiser rounded the way it happens to today. Apex is a continuous
       * measurement and carries the strict ordering. */
      assert.ok(r.hang <= prev.r.hang + 1e-9, `${id} hangs longer than the lighter ${prev.id}`);
    }
    prev = { id, r };
  }
  console.log('   THE LADDER'); for (const line of rows) console.log(line);
});

test('a sprinting leap scales with the world too, or one key beats the other by 4x', () => {
  /* `Parkour.tryLeap` writes `v.y = P.jumpVelocity * LEAP_LIFT` straight off
   * the config - the one absolute lift in the jump. Left alone it would take
   * off at 7.17 m/s on Tessera against an ordinary jump's 3.51, i.e. a leap
   * would clear four times the height of a jump on the same moon, on a key the
   * player holds anyway. `Player` rescales what `Parkour` wrote. */
  for (const world of [null, LIGHTEST, HEAVIEST]) {
    const plain = jumpArc(world);
    const leap = jumpArc(world, { sprint: true });
    const ratio = leap.takeoff / plain.takeoff;
    assert.ok(Math.abs(ratio - 1.12) < 0.02,
      `on ${world?.id ?? 'the default world'} a leap takes off at ${ratio.toFixed(3)}x an `
      + `ordinary jump against Parkour's LEAP_LIFT of 1.12`);
  }
});

test('mid-air steering authority is invariant, so a floaty jump is a committed one', () => {
  /* Hang time alone would make low gravity EASIER to steer, not harder: air
   * control is `airAcceleration` applied for as long as you are off the
   * ground, so 3.5x the airtime would be 3.5x the mid-air Δv and a player
   * could reverse a full sprint twice over before landing. That is the
   * opposite of "hard to change your mind mid-air", so the PRODUCT `a·T` is
   * what is held - the total Δv one jump buys, on every planet.
   *
   * Asserted first on the constants, where the relation is exact and a changed
   * exponent shows up to the last bit, and then driven, where the 60 Hz
   * quantiser is worth a few percent. */
  const player = makePlayer(flatWorld());
  const closedForm = (world) => {
    player.setWorldGravity(world);
    return player.airAcceleration * (2 * player.jumpVelocity / Math.abs(player.gravity));
  };
  const exact = closedForm(null);
  for (const [id, g] of PLANETS) {
    const a = closedForm(planet(id, g));
    assert.ok(Math.abs(a - exact) < 1e-9,
      `${id} buys ${a.toFixed(9)} m/s of mid-air steering against ${exact.toFixed(9)} everywhere `
      + 'else - the air-control exponent is no longer 1 - JUMP_EXP');
  }

  /* Driven: jump from a standstill with nothing pressed, then hold forward for
   * the whole arc and read the speed at touchdown. A speed boost lifts the
   * WISH out of the way - `_accelerate` stops at the wish, and 4.6 m/s of walk
   * would saturate before the authority ran out - without touching the air
   * acceleration, which `_move` scales only on the ground. */
  const steer = (world) => {
    const p = makePlayer(flatWorld());
    p.setWorldGravity(world);
    p._position.set(0, 0.5, 0);
    for (let i = 0; i < 180; i++) p.fixedUpdate(DT, i * DT);
    p.boostSpeed(6, 1e6);
    const s = p.input.state;
    let t = 3;
    s.jump = true;
    p.fixedUpdate(DT, t); t += DT;
    s.jump = false;
    s.forward = 1;
    for (let i = 0; i < 3000; i++, t += DT) {
      p.fixedUpdate(DT, t);
      if (p.grounded) break;
    }
    return Math.hypot(p.velocity.x, p.velocity.z);
  };
  const d0 = steer(null);
  const dL = steer(LIGHTEST);
  const dH = steer(HEAVIEST);
  console.log(`   AIR CONTROL  closed form ${exact.toFixed(3)} m/s per jump; `
    + `driven: default ${d0.toFixed(3)}  tessera ${dL.toFixed(3)}  verdigris ${dH.toFixed(3)}`);
  assert.ok(Math.abs(dL - d0) / d0 < 0.10,
    `one Tessera jump steers ${dL.toFixed(2)} m/s against the default ${d0.toFixed(2)}`);
  assert.ok(Math.abs(dH - d0) / d0 < 0.10,
    `one Verdigris jump steers ${dH.toFixed(2)} m/s against the default ${d0.toFixed(2)}`);
});

/* ================================================================== */
/* 3. Fall damage                                                      */
/* ================================================================== */

/**
 * Drop the player from `height` above the deck and read the health bar.
 *
 * Driven end to end: `Player._move` detects the landing, emits `player:landed`
 * on a REAL bus, `Parkour._onLand` computes the verdict off the impact speed
 * and calls `applyDamage`. Nothing here reproduces the curve.
 */
function dropFrom(world, height) {
  const physics = flatWorld();
  const player = makePlayer(physics);
  player.setWorldGravity(world);
  player._position.set(0, 0.5, 0);
  for (let i = 0; i < 120; i++) player.fixedUpdate(DT, i * DT);
  player._position.set(0, height, 0);
  player._velocity.set(0, 0, 0);
  // Teleporting does not un-ground the capsule; the settle above left it
  // standing, and a `!grounded` loop would exit before the first step.
  player._grounded = false;
  player._wasGrounded = false;
  let t = 2;
  for (let i = 0; i < 20000; i++, t += DT) {
    player.fixedUpdate(DT, t);
    if (player.grounded) break;
  }
  // A couple of steps past touchdown so the landing has been resolved.
  for (let i = 0; i < 4; i++, t += DT) player.fixedUpdate(DT, t);
  const landing = player.parkour.lastLanding ?? { speed: 0, damage: 0 };
  return { speed: landing.speed, damage: landing.damage, health: player.health, dead: player.isDead };
}

test('a 20 m fall costs nothing on Tessera and half a health bar on Verdigris', () => {
  /* The item this whole change exists for. Fall damage is keyed to impact
   * SPEED, so `v = √(2gh)` scales it for free - but "for free" is a claim and
   * this drives it. If low gravity did not reach the fall, a moon would be a
   * trap: all the reach of a 3x hang time and the same lethal ledge. */
  const base = dropFrom(null, 20);
  const light = dropFrom(LIGHTEST, 20);
  const heavy = dropFrom(HEAVIEST, 20);
  console.log('   A 20 m FALL');
  for (const [n, r] of [['default', base], ['tessera', light], ['verdigris', heavy]]) {
    console.log(`  ${n.padEnd(11)} impact ${r.speed.toFixed(2)} m/s   damage ${r.damage}   health ${r.health}`);
  }
  assert.equal(light.damage, 0,
    `20 m on a sixth-g moon cost ${light.damage} - low gravity is a trap, not a feature`);
  assert.ok(heavy.damage > 40 && heavy.damage < 60,
    `20 m on Verdigris cost ${heavy.damage}`);
  assert.ok(Math.abs(heavy.damage - base.damage) < 5,
    `Verdigris (${heavy.damage}) and a default world (${base.damage}) should barely differ at 1.03 g`);
});

test('the free drop and the lethal drop both scale with the world', () => {
  /* The two heights the `Parkour` docstring names for a default world - about
   * 7.5 m free and about 40 m lethal - are what a player learns. On a lighter
   * world they must MOVE, and by the gravity ratio, or the number learned in
   * the citadel is a lie on the moon. Bracketed rather than pinned: the exact
   * metre is the discrete integrator's business. */
  const freeDrop = (world, lo, hi) => {
    assert.equal(dropFrom(world, lo).damage, 0, `${lo} m hurt on ${world?.id ?? 'default'}`);
    assert.ok(dropFrom(world, hi).damage > 0, `${hi} m was free on ${world?.id ?? 'default'}`);
  };
  freeDrop(null, 6.5, 9);
  freeDrop(HEAVIEST, 6.5, 9);
  freeDrop(LIGHTEST, 40, 50);

  assert.equal(dropFrom(null, 45).dead, true, 'a 45 m fall is survivable on a default world');
  assert.equal(dropFrom(HEAVIEST, 45).dead, true, 'a 45 m fall is survivable on Verdigris');
  assert.equal(dropFrom(LIGHTEST, 45).dead, false,
    'a 45 m fall kills on a sixth-g moon, where it is barely faster than a 7 m fall at home');
  assert.equal(dropFrom(LIGHTEST, 260).dead, true,
    'nothing is lethal on Tessera at any height - the damage model has been scaled out of existence');
});

/* ================================================================== */
/* 4. The reach probes, and whether they still describe the game       */
/* ================================================================== */

test('the walk envelope the planet reach probes flood models no gravity, and still need not', async () => {
  /* `planet-reach.test.mjs` and `planet-walk-kit.mjs` prove every mineral node
   * on every planet can be WALKED to: a lattice flood with a 0.45 m step-up, a
   * 38 degree slope ceiling, a 3.0 m drop cap and no jump. Those files contain
   * no integrator and no gravity term at all, which is exactly why this change
   * cannot invalidate them - but "contains no gravity term" is checkable, so it
   * is checked rather than asserted in a comment.
   *
   * THE SECOND NAME MOVED, and this case went red on the move rather than
   * quietly passing over a file that no longer had the constants in it. The
   * lattice was `planet-minerals.test.mjs`'s until a second case in that file
   * needed to flood the same graph; it lives in `planet-walk-kit.mjs` now and
   * `planet-minerals.test.mjs` imports it. The `assert.match` lines below are
   * what caught it - a scrape that cannot tell "absent" from "moved" would have
   * gone green on a file with no walk graph in it at all. */
  for (const file of ['scripts/tests/planet-reach.test.mjs', 'scripts/tests/planet-walk-kit.mjs']) {
    const src = await readSrc(file);
    /* `gravity:` appears in both, but only inside the descriptor they build a
     * probe world from - a PUBLISHED value, never a consumed one. What must
     * not appear is the player's: a flood that integrated a fall would start
     * answering a different question on every planet, and the ore that is
     * "reachable" would become a function of which moon you asked about. */
    assert.doesNotMatch(src, /player\.gravity|\bjumpVelocity\b|_velocity/,
      `${file} has grown an integrator; the walk graph and the controller can now disagree`);
    assert.match(src, /STEP_UP = 0\.45/,
      `${file} no longer models the game's 0.45 m step-up`);
    assert.match(src, /DROP_MAX = 3\.0/,
      `${file} no longer models the 3.0 m drop cap`);
  }
  /* And the three numbers those probes model the game with are still the
   * game's. `stepHeight` is read by `Player._move`'s step probe; the slope
   * ceiling is the solver's and not gravity's. */
  assert.equal(P.stepHeight, 0.45, 'the reach probes model a 0.45 m step-up');
});

/**
 * A flat apron at y = 0 for x < 0, a ramp of pitch `deg` climbing toward +X
 * whose top face is exactly the plane `y = x tan p`, and a plateau at the top.
 * Lifted verbatim from `player-slope.test.mjs`, which is where the geometry was
 * worked out, so the two files are asking about the same surface.
 */
function rampWorld(deg, { run = 400, width = 400 } = {}) {
  const physics = new Physics();
  const p = (deg * Math.PI) / 180;
  const rise = run * Math.tan(p);
  const add = (m) => { m.updateWorldMatrix(true, false); physics.addBoxFromObject(m); };
  const apron = new THREE.Mesh(new THREE.BoxGeometry(80, 2, width));
  apron.position.set(-40, -1, 0);
  add(apron);
  const len = Math.hypot(run, rise);
  const ramp = new THREE.Mesh(new THREE.BoxGeometry(len, 0.5, width));
  ramp.position.set(run / 2 + 0.25 * Math.sin(p), rise / 2 - 0.25 * Math.cos(p), 0);
  ramp.rotation.set(0, 0, p);
  add(ramp);
  const top = new THREE.Mesh(new THREE.BoxGeometry(80, 2, width));
  top.position.set(run + 40, rise - 1, 0);
  add(top);
  return physics;
}

/** Hold forward from a standing start and tape the capsule every step. */
function walkTape(build, world, steps) {
  const player = makePlayer(build());
  player.setWorldGravity(world);
  player._position.set(-5, 0.5, 0);
  for (let i = 0; i < 120; i++) player.fixedUpdate(DT, i * DT);
  player.input.state.forward = 1;
  const tape = [];
  let t = 2;
  for (let i = 0; i < steps; i++, t += DT) {
    player.fixedUpdate(DT, t);
    tape.push([player.position.x, player.position.y, player.grounded ? 1 : 0]);
  }
  return tape;
}

const deviation = (a, b) => {
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    max = Math.max(max, Math.abs(a[i][0] - b[i][0]), Math.abs(a[i][1] - b[i][1]));
  }
  return max;
};
const airborne = (tape) => tape.reduce((n, r) => n + (r[2] ? 0 : 1), 0);

test('a walk up a slope never reads gravity at all, on any world', () => {
  /* THE PART MOST LIKELY TO BREAK SILENTLY. The reach probes prove ore is
   * reachable with a WALK, so if gravity changed what a walk can traverse then
   * ten planets were validated against a model of a player that no longer
   * exists.
   *
   * It did not, and the reason is structural rather than lucky: `_move` zeroes
   * `velocity.y` on every grounded step and `fixedUpdate` then writes the
   * fixed -2.2 ground-stick bias, so the gravity term - which lives inside
   * `if (!this._grounded)` - IS NEVER REACHED while walking. The slope ceiling
   * is `WALKABLE_NORMAL_Y` in the solver and has nothing to do with weight.
   *
   * Driven at 20 degrees and at the 38 the probes model: zero airborne steps
   * in 600, and the tape agrees to 70 FEMTOMETRES. */
  for (const deg of [20, 38]) {
    const base = walkTape(() => rampWorld(deg), null, 600);
    assert.equal(airborne(base), 0, `${deg} deg: the default walk left the ground; the case is wrong`);
    for (const world of [LIGHTEST, HEAVIEST, planet('cinder', 8.44)]) {
      const other = walkTape(() => rampWorld(deg), world, 600);
      assert.equal(airborne(other), 0, `${deg} deg: a walk on ${world.id} left the ground`);
      assert.ok(deviation(base, other) < 1e-12,
        `${deg} deg: a walk on ${world.id} diverged by ${deviation(base, other)} m - the slope `
        + 'envelope is now a function of gravity and the reach probes no longer describe the game');
      assert.deepEqual(other[599], base[599], `${deg} deg: ${world.id} finished somewhere else`);
    }
  }
});

test('a step-up is one airborne frame, and it lands on the same tread everywhere', () => {
  /* The one place a WALK does leave the ground: mounting a riser pops the
   * capsule off the tread for a single 60 Hz step. That frame reads gravity,
   * so it is the whole of the difference a planet can make to the walk graph -
   * and it is 4.3 mm of carry on Tessera, resolved before the next step.
   *
   * What matters is the outcome, and it is identical: the 0.40 m riser is
   * mounted on every world and the capsule ends at exactly 0.400000 m. The
   * probes' 0.45 m step-up is still the game's. */
  const riser = () => {
    const physics = new Physics();
    slab(physics, { x0: -60, x1: 60, z0: -200, z1: 200, y0: -2, y1: 0 });
    slab(physics, { x0: 10, x1: 200, z0: -200, z1: 200, y0: -2, y1: P.stepHeight - 0.05 });
    return physics;
  };
  const base = walkTape(riser, null, 400);
  assert.equal(airborne(base), 1, 'a riser is meant to cost exactly one airborne frame');
  /* 1e-6 and not 1e-9: `Physics` stores collider extents as float32, so a
   * 0.40 m tread resolves at 0.40000004768, which is 2^-24 of it. */
  assert.ok(Math.abs(base[399][1] - (P.stepHeight - 0.05)) < 1e-6,
    `the default walk finished at ${base[399][1]} and never mounted the riser`);
  for (const world of [LIGHTEST, HEAVIEST, planet('cinder', 8.44)]) {
    const other = walkTape(riser, world, 400);
    assert.equal(airborne(other), 1, `${world.id} took a different number of frames to mount a riser`);
    assert.ok(Math.abs(other[399][1] - base[399][1]) < 1e-6,
      `${world.id} ended the run at ${other[399][1]} against ${base[399][1]} - the riser was not `
      + 'climbed the same way');
    const dev = deviation(base, other);
    assert.ok(dev < 5e-3,
      `${world.id} deviated by ${(dev * 1000).toFixed(2)} mm crossing a riser; the transient is `
      + 'meant to be the single airborne frame and nothing else');
  }
});

test('what gravity DOES change is drops, and only in the direction that adds reach', () => {
  /* The probes cap an edge at a 3.0 m drop and never use a jump, so anything
   * they prove reachable is still reachable: a lighter world falls slower,
   * carries further, and hurts less. The guarantee is one-directional and this
   * is the direction. */
  const build = () => {
    const physics = new Physics();
    slab(physics, { x0: -60, x1: 60, y0: -2, y1: 0 });
    slab(physics, { x0: -20, x1: 6, y0: -2, y1: 3 });   // a 3 m lip at x = 6
    return physics;
  };
  const runOff = (world) => {
    const player = makePlayer(build());
    player.setWorldGravity(world);
    player._position.set(-4, 3.5, 0);
    for (let i = 0; i < 120; i++) player.fixedUpdate(DT, i * DT);
    player.input.state.forward = 1;
    let t = 2;
    for (let i = 0; i < 600; i++, t += DT) {
      player.fixedUpdate(DT, t);
      if (player.position.y < 0.4 && player.grounded) break;
    }
    return { x: player.position.x, damage: player.parkour.lastLanding?.damage ?? 0 };
  };
  const base = runOff(null);
  const light = runOff(LIGHTEST);
  console.log(`   3 m LIP  default lands at x=${base.x.toFixed(2)}  tessera x=${light.x.toFixed(2)}`);
  assert.ok(light.x > base.x,
    `a 3 m drop carries ${light.x.toFixed(2)} m on Tessera against ${base.x.toFixed(2)} m at home - `
    + 'a lighter world made a drop SHORTER, which can only take reach away');
  assert.equal(base.damage, 0, 'the probes cap drops at 3.0 m to stay free; it is not free at home');
  assert.equal(light.damage, 0, 'a 3 m drop hurt on a sixth-g moon');
});

/* ================================================================== */
/* 5. Nothing goes non-finite                                          */
/* ================================================================== */

/** Every number and every Vector3 the controller holds, walked. */
function assertFinite(player, where) {
  for (const [key, value] of Object.entries(player)) {
    if (typeof value === 'number') {
      assert.ok(Number.isFinite(value), `${where}: player.${key} is ${value}`);
    } else if (value && typeof value === 'object' && typeof value.isVector3 === 'boolean' && value.isVector3) {
      assert.ok(Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z),
        `${where}: player.${key} is (${value.x}, ${value.y}, ${value.z})`);
    }
  }
  const k = player._kick;
  for (const key of Object.keys(k)) assert.ok(Number.isFinite(k[key]), `${where}: kick.${key} is ${k[key]}`);
}

test('a 500 m fall on the lightest world stays finite the whole way down', () => {
  const physics = flatWorld();
  const player = makePlayer(physics);
  player.setWorldGravity(LIGHTEST);
  player._position.set(0, 500, 0);
  let t = 0;
  for (let i = 0; i < 4000; i++, t += DT) {
    player.fixedUpdate(DT, t);
    assertFinite(player, `tessera fall step ${i}`);
    if (player.grounded && i > 10) break;
  }
  assert.ok(player.position.y < 1, 'the player never arrived');
});

test('a zero-gravity world is clamped, not divided by, and remains playable', () => {
  /* There is no zero-g world yet. This is what would happen if one were
   * authored: a ratio of 0 is not floaty, it is broken - the player never
   * falls, so `_grounded` never returns, so the jump, the footsteps, the
   * sprint gate and the landing all stop existing, and `jumpVelocity * 0`
   * means you could not leave the ground to begin with. The ratio is clamped
   * to a hundredth of a g, which is absurd, finite and above all playable. */
  const physics = flatWorld();
  const player = makePlayer(physics);
  const warned = [];
  const realWarn = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    player.setWorldGravity(planet('void', 0));
  } finally {
    console.warn = realWarn;
  }
  assert.equal(warned.length, 1, 'a clamped gravity was applied silently');
  assert.match(warned[0], /void/, 'the warning does not name the world');

  assert.ok(player.gravity < 0 && Number.isFinite(player.gravity), `gravity is ${player.gravity}`);
  assert.ok(player.jumpVelocity > 0 && Number.isFinite(player.jumpVelocity));
  assert.ok(player.airAcceleration > 0 && Number.isFinite(player.airAcceleration));

  // And it still plays: the player falls, lands, jumps, and comes back down.
  player._position.set(0, 6, 0);
  let t = 0;
  for (let i = 0; i < 12000 && !player.grounded; i++, t += DT) {
    player.fixedUpdate(DT, t);
    assertFinite(player, `zero-g settle ${i}`);
  }
  assert.equal(player.grounded, true, 'a clamped zero-g world never lets the player touch down');
  const arc = jumpArc(planet('void', 0));
  console.log(`   CLAMPED ZERO-G  apex ${arc.apex.toFixed(2)} m  hang ${arc.hang.toFixed(2)} s`);
  assert.ok(Number.isFinite(arc.apex) && arc.apex > 0 && arc.apex < 40);
  assert.ok(Number.isFinite(arc.hang) && arc.hang > 0 && arc.hang < 60);
});

test('a negative or absurd published gravity is clamped at both ends', () => {
  const player = makePlayer(flatWorld());
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    for (const g of [-9.81, -1e9, 1e9, 1e-30]) {
      player.setWorldGravity(planet(`odd${g}`, g));
      assert.ok(player.gravity < 0 && Number.isFinite(player.gravity),
        `a published ${g} produced a gravity of ${player.gravity}`);
      assert.ok(player.gravityRatio >= 0.01 && player.gravityRatio <= 4,
        `a published ${g} produced a ratio of ${player.gravityRatio}`);
      assert.ok(Number.isFinite(player.jumpVelocity) && Number.isFinite(player.airAcceleration));
    }
  } finally {
    console.warn = realWarn;
  }
});

test('a half-second frame spike leaves nothing non-finite on any planet', () => {
  /* A stall - a shader compile, a world build, a tab restored - hands the
   * fixed step a dt it was never sized for. Every planet, because the
   * gravity-derived constants are the new thing in that path. */
  for (const [id, g] of [['default', null], ...PLANETS.map(([i, v]) => [i, v])]) {
    const physics = flatWorld();
    const player = makePlayer(physics);
    player.setWorldGravity(g === null ? null : planet(id, g));
    player._position.set(0, 12, 0);
    player.input.state.forward = 1;
    player.input.state.jump = true;
    let t = 0;
    for (let i = 0; i < 40; i++) {
      const dt = i % 4 === 3 ? 0.5 : DT;
      player.fixedUpdate(dt, t);
      t += dt;
      player.input.state.jump = i % 5 === 0;
      assertFinite(player, `${id} spike step ${i}`);
    }
  }
});

/* ================================================================== */
/* 6. One source, read twice                                           */
/* ================================================================== */

test('the player and the ship read the same field through the same predicate', async () => {
  /* The failure this guards is not a crash, it is a DISAGREEMENT: a hull
   * settling onto Tessera at a sixth of a g while the pilot who steps out of it
   * walks in the same -22 as the station. That was the shipped state. */
  const rules = await readSrc('src/worlds/WorldRules.js');
  assert.match(rules, /export function worldGravity/,
    'the shared reader is gone; whoever removed it has given the two consumers their own');
  assert.match(SRC_PLAYER, /worldGravity/, 'Player no longer goes through the shared reader');

  // Same predicate, same answers, for every shape a world can be.
  const piloting = (w) => (typeof w?.gravity === 'number' && Number.isFinite(w.gravity) ? w.gravity : null);
  for (const w of [null, undefined, {}, { gravity: 0 }, { gravity: 1.62 }, { gravity: 10.1 },
    { gravity: NaN }, { gravity: Infinity }, { gravity: -1 }, { gravity: '9.81' }]) {
    assert.equal(worldGravity(w), piloting(w),
      `worldGravity and Piloting._env disagree about ${JSON.stringify(w)}`);
  }
});

test('nothing in the controller integrates the config gravity any more', () => {
  /* The whole defect in one grep: `Player.fixedUpdate` used `P.gravity` while
   * `Piloting._env` used the world's. Both integration sites - the living body
   * and the corpse - must read the resolved value. */
  assert.doesNotMatch(SRC_PLAYER, /_velocity\.y \+= P\.gravity/,
    'an integration site is back on the global config gravity');
  assert.doesNotMatch(SRC_PLAYER, /_velocity\.y = P\.jumpVelocity/,
    'the jump is back on the global config jump velocity');
  assert.doesNotMatch(SRC_PLAYER, /wishSpeed, P\.airAcceleration/,
    'air control is back on the global config acceleration');
  // ...and `setWorldGravity` is the only writer of the resolved values.
  const writers = SRC_PLAYER.match(/this\._gravity =/g) ?? [];
  assert.equal(writers.length, 3,
    `\`_gravity\` is written in ${writers.length} places; it should be the constructor seed plus `
    + 'the two branches of setWorldGravity');
});

/* ================================================================== */
/* 7. Everything else that falls                                       */
/* ================================================================== */

/**
 * THE GAP THIS SECTION CLOSED.
 *
 * Per-world gravity reached the player's legs and stopped there. Four things
 * downstream of it were still absolute, and each was wrong in its own way:
 *
 *   - `Parkour.DIVE_ACCEL = 16` is 0.73x gravity at -22 and **4.4x** at
 *     Tessera's -3.633. The one verb whose whole purpose is "fall faster" was a
 *     steepening on the station and a rocket on the moon.
 *   - `NPC._integrate` integrated `CONFIG.player.gravity` directly, twice. On a
 *     sixth-g moon the player floated and every beast, bandit and corpse in the
 *     world dropped at -22.
 *   - `Climb.MIN_RISE_GROUND = 1.0` was justified by "jump apex is 0.93", which
 *     is false on nine of the ten planets - on Tessera the apex is 1.697, so
 *     every ledge from 1.0 m to 1.67 m was mantled where a hop would do.
 *   - `Piloting._env` re-implemented the `worldGravity` predicate inline, which
 *     is the shape of the original defect left standing underneath its own fix.
 *
 * What is deliberately NOT scaled is asserted here too, because a decision that
 * lives only in a comment is a decision the next change reverses by accident.
 */

const SRC_PARKOUR = await readSrc('src/player/Parkour.js');
const SRC_CLIMB = await readSrc('src/player/Climb.js');
const SRC_NPC = await readSrc('src/npc/NPC.js');

/** `DIVE_ACCEL / -CONFIG.player.gravity` - the fraction of gravity a dive IS. */
const DIVE_FRACTION = 16 / 22;

/**
 * Two identical players dropped together, then one of them crouches.
 *
 * The difference on the step they diverge is the dive's own acceleration and
 * nothing else: same world, same gravity, same step, same integrator, one
 * boolean apart.
 */
function diveProbe(world) {
  const make = () => {
    const pl = makePlayer(flatWorld());
    pl.setWorldGravity(world);
    pl._position.set(0, 400, 0);
    return pl;
  };
  const a = make();
  const b = make();
  /* Far enough past the threshold that the dive is unambiguously armed, and
   * nowhere near the -60 terminal clamp, which would flatten both. */
  const target = 3.0 * a.jumpScale * 2.5;
  let t = 0;
  for (let i = 0; i < 6000; i++, t += DT) {
    a.fixedUpdate(DT, t);
    b.fixedUpdate(DT, t);
    if (a.velocity.y < -target) break;
  }
  assert.equal(a.velocity.y, b.velocity.y, 'the two probes diverged before the crouch');
  a.input.state.crouch = true;
  a.fixedUpdate(DT, t);
  b.fixedUpdate(DT, t);
  return {
    diving: a.parkour.diving,
    accel: (b.velocity.y - a.velocity.y) / DT,
    gravity: Math.abs(a.gravity),
  };
}

test('a dive is the same fraction of the world it is in, and not 4.4x on Tessera', () => {
  const rows = [];
  for (const [id, g] of [['default', null], ...PLANETS]) {
    const r = diveProbe(g === null ? null : planet(id, g));
    assert.equal(r.diving, true, `${id} never entered the dive at all`);
    const f = r.accel / r.gravity;
    rows.push(`  ${id.padEnd(11)} gravity ${r.gravity.toFixed(3)}  dive +${r.accel.toFixed(3)} m/s²`
      + `  = ${f.toFixed(3)}x gravity`);
    assert.ok(Math.abs(f - DIVE_FRACTION) < 0.02,
      `${id} dives at ${f.toFixed(3)}x its own gravity against ${DIVE_FRACTION.toFixed(3)} `
      + 'everywhere else - DIVE_ACCEL is absolute again');
  }
  console.log('   THE DIVE'); for (const line of rows) console.log(line);
});

test('the dive always steepens the fall and never inverts or doubles it', () => {
  /* What the fraction test alone would miss is a sign flip or a scale applied
   * twice. A dive must ADD to the fall on every world, and by less than the
   * fall itself, which is what makes it a steepening rather than a second g. */
  for (const [id, g] of PLANETS) {
    const r = diveProbe(planet(id, g));
    assert.ok(r.accel > 0 && Number.isFinite(r.accel),
      `${id} dives at ${r.accel} m/s² - a dive that does not go down is not a dive`);
    assert.ok(r.accel < r.gravity, `${id} dives harder than it falls`);
  }
});

test('the forward carry of a dive is invariant, so a dive is committed and not free', () => {
  /* `DIVE_FORWARD` is mid-air steering by another name and takes the exponent
   * air control takes, which holds the product `a·T` invariant. Driven rather
   * than asserted on the constants: jump straight up with crouch held and
   * NOTHING else pressed, so `_airAcceleration` has a wish of zero to work with
   * and friction never runs (it is ground-only), then read the horizontal speed
   * at touchdown. Every metre per second of it came from `DIVE_FORWARD`. */
  const carry = (world) => {
    const pl = makePlayer(flatWorld());
    pl.setWorldGravity(world);
    pl._position.set(0, 0.5, 0);
    for (let i = 0; i < 180; i++) pl.fixedUpdate(DT, i * DT);
    const st = pl.input.state;
    let t = 3;
    st.jump = true;
    pl.fixedUpdate(DT, t); t += DT;
    st.jump = false;
    st.crouch = true;
    let dove = false;
    for (let i = 0; i < 6000; i++, t += DT) {
      pl.fixedUpdate(DT, t);
      if (pl.parkour.diving) dove = true;
      if (dove && pl.grounded) break;
    }
    assert.equal(dove, true, 'the arc never dived at all');
    return Math.hypot(pl.velocity.x, pl.velocity.z);
  };
  const base = carry(null);
  const rows = [];
  for (const [id, g] of PLANETS) {
    const c = carry(planet(id, g));
    rows.push(`  ${id.padEnd(11)} ${c.toFixed(3)} m/s`);
    assert.ok(Math.abs(c - base) / base < 0.12,
      `${id} carries ${c.toFixed(3)} m/s out of one dive against ${base.toFixed(3)} on the `
      + 'default world - DIVE_FORWARD is not on the air-control exponent');
  }
  console.log(`   DIVE CARRY  default ${base.toFixed(3)} m/s`); for (const l of rows) console.log(l);
});

test('the dive arms at the same point in the arc on every world', () => {
  /* `DIVE_MIN_FALL` is a vertical SPEED. Left absolute, 3.0 m/s is 47% of a
   * default take-off and 85% of Tessera's - the dive would arm almost too late
   * to be worth pressing on the world it matters most on.
   *
   * Measured as a fraction of THIS world's take-off speed rather than as a
   * height, and that is not a dodge: both are read at step boundaries, but the
   * speed overshoots its threshold by at most `g·dt`, which is 5.7% of take-off
   * at default gravity and 1.7% on Tessera, while the HEIGHT quantises far
   * harder - a default apex is 0.878 m and one 60 Hz step at 3 m/s is already
   * 5.7% of it before the speed error is counted at all. The height fraction is
   * reported below for the reader and deliberately not asserted on. */
  const armPoint = (world) => {
    const pl = makePlayer(flatWorld());
    pl.setWorldGravity(world);
    pl._position.set(0, 0.5, 0);
    for (let i = 0; i < 180; i++) pl.fixedUpdate(DT, i * DT);
    const groundY = pl.position.y;
    const st = pl.input.state;
    let t = 3;
    st.jump = true;
    pl.fixedUpdate(DT, t); t += DT;
    st.jump = false;
    const takeoff = pl.velocity.y;
    st.crouch = true;
    let apex = pl.position.y;
    let armY = null;
    let armV = null;
    for (let i = 0; i < 6000; i++, t += DT) {
      /* The velocity the PREDICATE saw, which is the one before this step
       * integrated. Read afterwards it carries a step of gravity plus a step
       * of dive, and that error is itself per-world. */
      const before = pl.velocity.y;
      const beforeY = pl.position.y;
      pl.fixedUpdate(DT, t);
      if (armY === null && !pl.parkour.diving) apex = Math.max(apex, pl.position.y);
      else if (armY === null) { armY = beforeY; armV = before; }
      if (armY !== null && pl.grounded) break;
    }
    assert.ok(armY !== null, 'the dive never armed');
    return {
      armV: -armV,
      threshold: 3.0 * pl.jumpScale,
      step: Math.abs(pl.gravity) * DT,
      speed: -armV / takeoff,
      height: (apex - armY) / (apex - groundY),
    };
  };
  const rows = [];
  for (const [id, g] of [['default', null], ...PLANETS]) {
    const f = armPoint(g === null ? null : planet(id, g));
    rows.push(`  ${id.padEnd(11)} arms at ${f.armV.toFixed(3)} m/s against this world's own `
      + `threshold of ${f.threshold.toFixed(3)} - ${(f.speed * 100).toFixed(1)}% of take-off, `
      + `${(f.height * 100).toFixed(1)}% of the way down from apex`);
    /* `3.0 * jumpScale` is `DIVE_MIN_FALL` transcribed and the scale Parkour is
     * supposed to be using. If it went back to the absolute 3.0, Tessera would
     * arm at 3.0 against a threshold of 1.645 and this fails by 82%. */
    assert.ok(f.armV >= f.threshold - 1e-9 && f.armV < f.threshold + f.step + 1e-9,
      `${id} armed its dive at ${f.armV.toFixed(4)} m/s, which is not the first 60 Hz step `
      + `past its own threshold of ${f.threshold.toFixed(4)} m/s - DIVE_MIN_FALL is absolute again`);
  }
  console.log('   THE DIVE THRESHOLD'); for (const l of rows) console.log(l);
});

test('Parkour reads the law off Player rather than keeping a second copy of it', () => {
  assert.doesNotMatch(SRC_PARKOUR, /-= DIVE_ACCEL \* dt/,
    'the dive integrates DIVE_ACCEL absolutely again');
  assert.doesNotMatch(SRC_PARKOUR, /Math\.pow\([^)]*,\s*(?:1|2)\s*\/\s*3/,
    'Parkour has re-derived a gravity exponent for itself; the design rule now has two definitions');
  assert.match(SRC_PARKOUR, /DIVE_ACCEL \* p\.gravityRatio/, 'the dive no longer scales with the world');
  assert.match(SRC_PARKOUR, /DIVE_FORWARD \* p\.airScale/, 'the dive carry no longer scales with the world');
  assert.match(SRC_PARKOUR, /DIVE_MIN_FALL \* p\.jumpScale/,
    'the dive threshold no longer scales with the world');
  /* ...and the two fall-damage rails deliberately do NOT move: damage is keyed
   * to impact SPEED and `v = √(2gh)` already scales the HEIGHT for free.
   * Scaling these as well would scale it twice and hand Tessera back its lethal
   * 7 m ledge. @see the design block in Player.js */
  assert.match(SRC_PARKOUR, /const SAFE_SPEED = 18;/, 'SAFE_SPEED moved; fall damage would now scale twice');
  assert.match(SRC_PARKOUR, /const LETHAL_SPEED = 42;/,
    'LETHAL_SPEED moved; fall damage would now scale twice');
});

/**
 * The controller as it behaved BEFORE any of this, on any world.
 *
 * Every per-world term the dive and the mantle read is published by `Player` as
 * a scale, so pinning all four to their default values reproduces the OLD
 * absolute code exactly, whatever world the player is standing on. That is what
 * makes the pair of hashes below a real before-and-after rather than a promise:
 * the same tape is driven through the same file twice, once with the scales
 * live and once with them pinned.
 */
function pinScales(player) {
  const def = (name, value) => Object.defineProperty(player, name, { get: () => value, configurable: true });
  def('gravityRatio', 1);
  def('jumpScale', 1);
  def('airScale', 1);
  def('jumpApex', (P.jumpVelocity * P.jumpVelocity) / (2 * -P.gravity));
  return player;
}

/**
 * A scripted 12-second run that LEAPS, DIVES and lands, hashed step by step.
 *
 * `runHash` above never presses crouch in the air, so it says nothing at all
 * about the dive. This one does nothing else: sprint, leap off, hold crouch
 * through the fall, and land.
 */
function diveHash(world, { pinned = false } = {}) {
  const physics = flatWorld();
  const player = makePlayer(physics);
  player.setWorldGravity(world);
  if (pinned) pinScales(player);
  unlimitedStamina(player);
  player._position.set(0, 0.5, 0);
  for (let i = 0; i < 120; i++) player.fixedUpdate(DT, i * DT);

  const s = player.input.state;
  /** [seconds, forward, sprint, crouch, jump] */
  const tape = [
    [2.0, 1, true, false, false],   // run up
    [0.2, 1, true, false, true],    // sprinting jump: the leap
    [3.0, 1, false, true, false],   // crouch held through the whole descent
    [1.0, 1, false, false, false],  // release and settle
    [2.0, 1, true, false, false],   // run on
    [0.2, 1, true, false, true],    // and again
    [3.0, 0, false, true, false],   // dive with no steering input at all
    [1.0, 0, false, false, false],
  ];
  const parts = [];
  const q = (v) => Math.round(v * 1e4);
  let t = 2;
  for (const [secs, forward, sprint, crouch, jump] of tape) {
    s.forward = forward; s.sprint = sprint; s.crouch = crouch; s.jump = jump;
    for (let i = 0, n = Math.round(secs / DT); i < n; i++, t += DT) {
      player.fixedUpdate(DT, t);
      const pp = player.position;
      const v = player.velocity;
      parts.push(`${q(pp.x)},${q(pp.y)},${q(pp.z)},${q(v.x)},${q(v.y)},${q(v.z)},`
        + `${player.parkour.diving ? 1 : 0}`);
    }
  }
  return { hash: fnv1a(parts.join(';')), steps: parts.length };
}

test('a leap-and-dive tape is bit-identical to the absolute code on a world with no gravity', () => {
  /* THE BYTE-IDENTICAL PROOF FOR THE DIVE. The scales are all exactly 1 on a
   * world that publishes nothing, and `x * 1` is exact in IEEE-754, so the
   * scaled code and the absolute code must produce the same 480 steps to the
   * last 0.1 mm. If this fails, per-world gravity has leaked into station,
   * medieval, citadel, sports, race, maze or dock. */
  const live = diveHash(null);
  const pinned = diveHash(null, { pinned: true });
  assert.equal(live.steps, pinned.steps);
  assert.equal(live.hash, pinned.hash,
    `the default world now hashes ${live.hash} live against ${pinned.hash} with the scales pinned`);
  console.log(`   DIVE TAPE  default world ${live.hash} over ${live.steps} steps, `
    + 'scaled and absolute alike');
});

test('...and so does a world that publishes 9.81', () => {
  const earth = planet('earthlike', P.gravityReference);
  assert.equal(diveHash(earth).hash, diveHash(null, { pinned: true }).hash);
});

test('...while on Tessera the two disagree, or the dive was never wired up', () => {
  const live = diveHash(LIGHTEST);
  const pinned = diveHash(LIGHTEST, { pinned: true });
  assert.notEqual(live.hash, pinned.hash,
    'Tessera dives exactly as the absolute code did - nothing reached Parkour');
  console.log(`   DIVE TAPE  tessera scaled ${live.hash}, absolute ${pinned.hash}`);
});

/* ---------------------------------------------------------------- */
/* NPCs fall in the world they are standing in                       */
/* ---------------------------------------------------------------- */

const { NPC } = await import('../../src/npc/NPC.js');
const { NPCManager } = await import('../../src/npc/NPCManager.js');

/** `setWorldGravity` touches one field, so it needs no body to be driven. */
function bareNPC() {
  return Object.create(NPC.prototype);
}

test('an NPC resolves EXACTLY the gravity the player does, on every planet', () => {
  /* Not "close to". The two go through one `worldGravityRatio`, so any
   * difference at all means a second copy of the division has appeared. */
  const player = makePlayer(flatWorld());
  const npc = bareNPC();
  const worlds = [null, undefined, {}, { id: 'maze' }, planet('earthlike', P.gravityReference),
    ...PLANETS.map(([id, g]) => planet(id, g))];
  for (const w of worlds) {
    player.setWorldGravity(w);
    npc.setWorldGravity(w);
    assert.equal(npc._gravity, player.gravity,
      `on ${JSON.stringify(w)} the player falls at ${player.gravity} and the NPC at ${npc._gravity}`);
    assert.ok(npc._gravity < 0 && Number.isFinite(npc._gravity));
  }
});

test('an NPC on a clamped world is finite too, and clamped the same way', () => {
  const player = makePlayer(flatWorld());
  const npc = bareNPC();
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    for (const g of [0, -9.81, -1e9, 1e9, 1e-30, NaN, Infinity]) {
      const w = planet(`odd${g}`, g);
      player.setWorldGravity(w);
      npc.setWorldGravity(w);
      assert.equal(npc._gravity, player.gravity, `a published ${g} split the two apart`);
      assert.ok(Number.isFinite(npc._gravity) && npc._gravity < 0);
    }
  } finally {
    console.warn = realWarn;
  }
});

test('a real beast, built by the real manager, falls with the player and not at -22', () => {
  /* The end-to-end one. `NPCManager` is the thing that has to hand the world
   * down, and it does it at the same line it hands water down - so a beast
   * built by a caravan top-up or a respawn, long after `spawnForWorld` ran, is
   * covered by the same call. Driven through `BeastNPC`, which inherits both
   * integration sites and overrides neither. */
  const physics = flatWorld();
  const mgr = Object.create(NPCManager.prototype);
  Object.assign(mgr, {
    scene: new THREE.Scene(), engine: null, physics, bus: null, materials: null, player: null,
    _npcs: [], _hostiles: [], _friendlies: [], _vendors: [], _respawnQueue: [],
    theme: 'medieval', worldId: 'tessera', maxNPCs: 72, water: null, gravityWorld: LIGHTEST,
    _seedCounter: 1, _groundCursor: 0, _simStep: 0, _pauseUntil: 0,
    _coverToken: 0, _groundFixes: 0, _contact: null, _chatNPC: null,
  });
  const beast = mgr.spawnBeast({ position: new THREE.Vector3(0, 1, 0), species: 'wolf' });
  assert.ok(beast, 'the manager built no beast at all');

  const player = makePlayer(flatWorld());
  player.setWorldGravity(LIGHTEST);
  assert.equal(beast._gravity, player.gravity,
    `the wolf falls at ${beast._gravity} and the player at ${player.gravity}`);

  /* Now DRIVE it: lift the animal clear of the deck and integrate. Free air is
   * `v += g·dt` on both, so the two velocities have to track step for step. */
  beast.position.set(0, 30, 0);
  beast.velocity.set(0, 0, 0);
  player._position.set(0, 30, 0);
  player._velocity.set(0, 0, 0);
  player._grounded = false;
  for (let i = 0; i < 30; i++) {
    beast._integrate(DT);
    player.fixedUpdate(DT, i * DT);
    assert.ok(Math.abs(beast.velocity.y - player.velocity.y) < 1e-9,
      `after ${i + 1} steps the wolf is at ${beast.velocity.y} m/s and the player at `
      + `${player.velocity.y} m/s`);
  }
  const half = 0.5 * Math.abs(CONFIG.player.gravity) * (30 * DT) * (30 * DT);
  console.log(`   TESSERA FALL  wolf ${(-beast.velocity.y).toFixed(3)} m/s after 0.5 s; `
    + `at the old absolute -22 it would have been ${(22 * 30 * DT).toFixed(3)}`);
  assert.ok(-beast.velocity.y < 22 * 30 * DT * 0.5,
    'the wolf is still falling at something close to the config gravity');
  void half;
});

test('a corpse falls in the world it died in', () => {
  /* `_integrateDead` is the second integration site and it was the second copy
   * of `CONFIG.player.gravity`. A body that lands faster than it fell is a
   * ragdoll with the wrong planet in it. */
  const physics = flatWorld();
  const mgr = Object.create(NPCManager.prototype);
  Object.assign(mgr, {
    scene: new THREE.Scene(), engine: null, physics, bus: null, materials: null, player: null,
    _npcs: [], _hostiles: [], _friendlies: [], _vendors: [], _respawnQueue: [],
    theme: 'medieval', worldId: 'tessera', maxNPCs: 72, water: null, gravityWorld: LIGHTEST,
    _seedCounter: 1, _groundCursor: 0, _simStep: 0, _pauseUntil: 0,
    _coverToken: 0, _groundFixes: 0, _contact: null, _chatNPC: null,
  });
  const beast = mgr.spawnBeast({ position: new THREE.Vector3(0, 1, 0), species: 'wolf' });
  beast.position.set(0, 30, 0);
  beast.velocity.set(0, 0, 0);
  for (let i = 0; i < 30; i++) beast._integrateDead(DT);
  const expected = beast._gravity * 30 * DT;
  assert.ok(Math.abs(beast.velocity.y - expected) < 1e-9,
    `a corpse fell to ${beast.velocity.y} m/s where its own world says ${expected}`);
});

test('no NPC integrates the config gravity any more', () => {
  assert.doesNotMatch(SRC_NPC, /velocity\.y \+= CONFIG\.player\.gravity/,
    'an NPC integration site is back on the global config gravity');
  const writers = SRC_NPC.match(/this\._gravity = /g) ?? [];
  assert.equal(writers.length, 2,
    `\`_gravity\` is written in ${writers.length} places in NPC.js; it should be the constructor `
    + 'seed plus setWorldGravity');
  assert.match(SRC_NPC, /worldGravityRatio/, 'NPC no longer goes through the shared ratio');
  // The terminal clamp is a solver limit in metres per step and stays absolute.
  assert.match(SRC_NPC, /if \(this\.velocity\.y < -40\) this\.velocity\.y = -40;/,
    'the NPC terminal clamp moved - it is a tunnelling limit, not a feel parameter');
});

/* ---------------------------------------------------------------- */
/* The mantle stops taking ledges a jump already clears              */
/* ---------------------------------------------------------------- */

/** `Climb`'s own default, recomputed here from the config it is derived from. */
const DEFAULT_APEX = (P.jumpVelocity * P.jumpVelocity) / (2 * -P.gravity);
/** `Climb.MAX_RISE` and `Climb.MIN_RISE_CEILING`, transcribed. */
const CLIMB_MAX_RISE = 2.4;

test('the mantle floor is EXACTLY 1.0 m on every world that publishes no gravity', () => {
  /* The multiply is `MIN_RISE_GROUND * (apex / DEFAULT_APEX)`, and on a world
   * with no published gravity `apex` is the same expression over the same
   * config constants - so the quotient is exactly 1 and this is exactly 1.0.
   * Strict equality, because a float residue here is a mantle band that has
   * quietly moved in seven shipped worlds. */
  const player = makePlayer(flatWorld());
  for (const w of [null, undefined, {}, { id: 'maze' }, planet('earthlike', P.gravityReference)]) {
    player.setWorldGravity(w);
    assert.equal(player.climb._minRiseGround(), 1.0,
      `the mantle floor is ${player.climb._minRiseGround()} on ${JSON.stringify(w)}`);
  }
});

test('the mantle never takes a ledge the jump on that world already clears', () => {
  /* The constant's stated justification - "anything below this is already
   * reachable and a mantle would only feel like the game taking the controls" -
   * asserted as the relation it is, on every planet. */
  const player = makePlayer(flatWorld());
  const rows = [];
  for (const [id, g] of [['default', null], ...PLANETS]) {
    player.setWorldGravity(g === null ? null : planet(id, g));
    const floor = player.climb._minRiseGround();
    rows.push(`  ${id.padEnd(11)} apex ${player.jumpApex.toFixed(3)} m   mantle floor `
      + `${floor.toFixed(3)} m`);
    assert.ok(floor >= player.jumpApex,
      `${id} mantles from ${floor.toFixed(3)} m while a jump there reaches `
      + `${player.jumpApex.toFixed(3)} m - the mantle is taking the controls for a hop`);
  }
  console.log('   THE MANTLE FLOOR'); for (const l of rows) console.log(l);
});

test('the mantle band can never close, at either end of the ratio clamp', () => {
  /* `MAX_RISE` does not scale - it is how far a pair of arms reaches - so a
   * floor that scaled without a ceiling would cross it, and `min >= max` is not
   * a narrow band, it is the verb deleted with no log and no error. The
   * unclamped floor at the ratio floor of 0.01 is 4.64 m, nearly twice
   * MAX_RISE. */
  const player = makePlayer(flatWorld());
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    for (const g of [0, 1e-30, 1e9, -1e9, 0.0001, 39.24, ...PLANETS.map(([, v]) => v)]) {
      player.setWorldGravity(planet(`odd${g}`, g));
      const floor = player.climb._minRiseGround();
      assert.ok(Number.isFinite(floor) && floor > 0,
        `a published ${g} produced a mantle floor of ${floor}`);
      assert.ok(floor < CLIMB_MAX_RISE - 0.3,
        `a published ${g} puts the mantle floor at ${floor.toFixed(3)} m against a ceiling of `
        + `${CLIMB_MAX_RISE} - the band is closing`);
    }
  } finally {
    console.warn = realWarn;
  }
});

test('Climb reasons from the live apex and not from a remembered 0.93', () => {
  assert.match(SRC_CLIMB, /player\?\.jumpApex/, 'Climb no longer reads the world it is standing on');
  assert.match(SRC_CLIMB, /const DEFAULT_APEX = \(P\.jumpVelocity \* P\.jumpVelocity\) \/ \(2 \* -P\.gravity\)/,
    'the default apex is retyped rather than derived; the two can now drift');
  assert.doesNotMatch(SRC_CLIMB, /Math\.pow/,
    'Climb has re-derived a gravity exponent for itself');
  assert.ok(Math.abs(DEFAULT_APEX - 0.9309) < 0.001,
    `the config now puts the default apex at ${DEFAULT_APEX} and the docstrings say 0.93`);
});

/* ---------------------------------------------------------------- */
/* What was deliberately left absolute                               */
/* ---------------------------------------------------------------- */

test('a weapon carries its own droop between worlds, and the reasoning is written down', async () => {
  /* THE DECISION, PINNED. Arrows fall at -11.5 and fireballs at -2.4 against a
   * player gravity of -22 - 0.52x and 0.11x. Neither was ever the world's
   * gravity; they are weapon parameters, authored on the same page as draw time
   * and damage. And unlike a jump, which announces its gravity in the first
   * step you take, a shot announces nothing: there is no ballistic reticle in
   * this game, so the arc IS the aim, learned by firing, and the same bow is
   * carried through a portal. The rule is: a BODY falls at the world's gravity,
   * a PROJECTILE at its weapon's.
   *
   * If this test is what is in the way of scaling them, read the block at
   * `p.grav[slot]` in Projectiles.js first and then change both together. */
  const projectiles = await readSrc('src/systems/Projectiles.js');
  const bow = await readSrc('src/weapons/Bow.js');
  const fireball = await readSrc('src/weapons/Fireball.js');
  assert.match(bow, /gravity: -11\.5,/, 'the arrow arc moved');
  assert.match(fireball, /gravity: -2\.4,/, 'the fireball droop moved');
  assert.match(projectiles, /p\.grav\[slot\] = opts\.gravity \?\? 0;/,
    'the projectile pool has grown a world term; the weapon owns this number');
  assert.doesNotMatch(projectiles, /worldGravity/,
    'the projectile pool now reads the world - see the block at `p.grav[slot]`');
  for (const [name, src] of [['Projectiles.js', projectiles], ['Bow.js', bow],
    ['Fireball.js', fireball]]) {
    assert.match(src, /not the world's gravity|does not scale|do not scale|does NOT scale/i,
      `${name} no longer says anywhere why a projectile's droop is not per-world`);
  }
});

test('buoyancy scales its terminal speeds with gravity, and not its rate', async () => {
  /* THE CASE THAT USED TO STAND HERE said buoyancy had no gravity term and
   * could not reach a world that would give it one, because `PlanetWorld` set
   * `swim: false` for all ten planets. That is no longer true - swimmability
   * is per LIQUID now, and four planets publish water - so this is the same
   * question asked of the code that exists.
   *
   * The note on `BUOYANCY` told the next person exactly how to answer it, and
   * what is asserted here is that the instruction was followed rather than
   * improvised: "the honest scaling is `BUOY_UP_MAX`/`BUOY_DOWN_MAX` as
   * terminal speeds (sqrt(r) under quadratic drag), not `BUOYANCY`, which is a
   * 1/s rate". A rate scaled by gravity is a stiffer spring, and the spring is
   * what holds down the documented oscillation at the waterline. */
  const swim = await readSrc('src/player/Swim.js');
  const planetWorld = await readSrc('src/worlds/PlanetWorld.js');
  assert.match(planetWorld, /swim: liquidSwimmable\(P\.liquid\)/,
    'PlanetWorld no longer decides swimming per liquid - if it is back to a flat false, '
    + 'the gravity term below is unreachable again and this case should say so');

  /* The ratio comes from the ONE shared reader, through the player, and is
   * never re-derived. `worldGravityRatio` owns the clamp and the warning, and
   * a second division by `gravityReference` anywhere in the tree is the exact
   * defect the case below this one exists to prevent. */
  assert.match(swim, /this\.player\?\.gravityRatio/,
    'Swim derives a gravity ratio of its own rather than reading the player\'s');
  assert.doesNotMatch(swim, /gravityReference/,
    'Swim divides by the gravity reference itself - there is a second ratio in the tree now');

  /* The rate is untouched and the two caps are square-rooted, in source. */
  assert.match(swim, /const BUOYANCY = 2\.8;/, 'the buoyancy rate moved');
  assert.match(swim, /Math\.sqrt\(Math\.max\(1e-3, this\.player\?\.gravityRatio \?\? 1\)\)/,
    'the buoyancy scaling is no longer a guarded square root of the shared ratio');
  assert.match(swim, /-BUOY_DOWN_MAX \* gr, BUOY_UP_MAX \* gr/,
    'the terminal speeds are no longer the things being scaled');
  assert.doesNotMatch(swim, /BUOYANCY \* gr|gr \* BUOYANCY/,
    'the buoyancy RATE has been scaled by gravity - see the note on BUOYANCY');

  /* And the arithmetic, over the range that is actually reachable. The four
   * swimmable planets run 7.80 to 10.10 m/s^2, so the caps move by -11% to
   * +1.5%: small, correct, and specifically not large enough to be worth
   * destabilising the spring for. */
  const { PLANETS } = await import('../../src/worlds/planets/index.js');
  const { liquidSwimmable } = await import('../../src/worlds/planets/PlanetLiquid.js');
  const wet = Object.values(PLANETS).filter((P) => liquidSwimmable(P.liquid));
  assert.ok(wet.length >= 1, 'no planet is swimmable, so this case is measuring nothing');
  const rows = wet.map((P) => {
    const r = worldGravityRatio(P);
    const gr = Math.sqrt(r);
    assert.ok(Number.isFinite(gr) && gr > 0, `${P.id}: sqrt of the ratio is ${gr}`);
    return `${P.id} ${P.gravity} m/s^2 (${r.toFixed(4)}x) -> rise cap ${(1.7 * gr).toFixed(3)} m/s`;
  });
  console.log(`   buoyancy caps on the swimmable planets: ${rows.join(', ')}`);

  /* The floor of the clamp is what stops a low-gravity sea producing a zero.
   * `worldGravityRatio` clamps to 0.01, so the worst reachable cap is a tenth
   * of the default rather than nothing at all - a bob that never converges is
   * a swimmer stuck under the waterline. */
  const floor = Math.sqrt(GRAVITY_RATIO_MIN);
  assert.ok(floor > 0.09 && Number.isFinite(floor),
    `the clamped floor puts the buoyancy cap at ${floor}x, which is not a bob`);
});

test('the ship and the player still read one field through one predicate, in source', async () => {
  /* `Piloting._env` used to spell the predicate out - `typeof w?.gravity ===
   * "number" && Number.isFinite(w.gravity)` - which is the shape of the
   * original defect standing underneath its own fix. */
  const piloting = await readSrc('src/ships/Piloting.js');
  assert.match(piloting, /import \{ worldGravity \} from '\.\.\/worlds\/WorldRules\.js'/,
    'Piloting no longer imports the shared reader');
  assert.doesNotMatch(piloting, /if \(typeof w\?\.gravity/,
    'Piloting._env has re-inlined the gravity predicate');
  assert.match(piloting, /const surface = worldGravity\(w\);/,
    'Piloting._env no longer goes through worldGravity');
});

test('the ratio, the clamp and the warning exist exactly once in the whole tree', async () => {
  const rules = await readSrc('src/worlds/WorldRules.js');
  assert.match(rules, /export function worldGravityRatio/, 'the shared ratio is gone');
  assert.match(rules, /export const GRAVITY_RATIO_MIN = 0\.01;/, 'the clamp floor moved');
  assert.match(rules, /export const GRAVITY_RATIO_MAX = 4;/, 'the clamp ceiling moved');
  // Nobody else may divide by the reference.
  for (const [name, src] of [['Player.js', SRC_PLAYER], ['Parkour.js', SRC_PARKOUR],
    ['Climb.js', SRC_CLIMB], ['NPC.js', SRC_NPC]]) {
    assert.doesNotMatch(src, /P.gravityReference|CONFIG.player.gravityReference/,
      `${name} divides by gravityReference itself - there is a second ratio in the tree now`);
  }
});
