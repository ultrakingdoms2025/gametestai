import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { Physics } from '../../src/physics/Physics.js';
import { CONFIG } from '../../src/core/Config.js';
import { EventBus } from '../../src/core/EventBus.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readSrc = async (p) => (await readFile(path.join(root, p), 'utf8')).replace(/\r\n/g, '\n');

/**
 * THE PARKOUR SET, DRIVEN.
 *
 * `src/player/Parkour.js` had no test file at all: leap, dive, roll and the
 * whole fall-damage model shipped in three worlds unmeasured, and the six
 * events they raise had **zero listeners anywhere in `src/`** - the identical
 * defect `camera:shake` shipped with (eight emitters, no listener, dead in all
 * five worlds). Half of this file drives the real `Player` through the real
 * integrator; the other half is the ratchet that stops the wiring going dead
 * again, because a pose nobody registers and an event nobody hears are both
 * invisible to every other kind of test.
 *
 * ── The design's numbers, checked ─────────────────────────────────────────
 * The Citadel design (docs/superpowers/specs/2026-08-17-citadel-reach-design.md
 * section 1.6) publishes six numbers as "the metric every rooftop gap, ledge
 * band and objective placement in this design is authored against". Driven
 * against the real controller, three are right and three are wrong:
 *
 *     move           design gap    measured    design apex   measured
 *     walk jump         2.61        2.607          0.93        0.878
 *     sprint jump       4.65        4.647          0.93        0.878
 *     leap              7.57        7.569          1.17        1.109
 *
 * The gaps are correct to the millimetre. The apexes are the CONTINUOUS-time
 * closed form `v^2 / 2g` - 0.9309 and 1.1677 - and the game does not integrate
 * in continuous time. `Player._move` is semi-implicit Euler at a fixed 1/60,
 * and `fixedUpdate` adds gravity BEFORE the position update, so the first step
 * of the rise is taken at `v0 + g*dt` rather than at `v0`. That loses
 * `|g| * dt^2 / 2` on the way up and buys nothing back: 0.9309 - 0.0526 =
 * 0.878, and 1.1677 - 0.0589 = 1.109. The horizontal number survives because
 * the same discretisation shortens the flight time and the closed form for the
 * distance happens to land within a millimetre of it.
 *
 * A 5 cm error in the apex is a ledge band that a leap does not clear, so the
 * corrected numbers are asserted here and the wrong ones are named.
 *
 * ── The five defects this file closed ─────────────────────────────────────
 *   (a) THE MOMENTUM REWARD SELF-CANCELLED. `ROLL_SPEED` scaled the velocity
 *       once and held crouch then set `wishSpeed = crouchSpeed = 2.2`, so
 *       friction ate the whole reward. Measured, sprint off a 12 m ledge with
 *       crouch held: 15.064 m/s at touchdown, 5.045 at +0.1 s, 2.200 at +0.2 s.
 *       The roll now owns a floor for `ROLL_TIME`: 9.184 m/s held flat across
 *       all 33 steps of the roll, then released.
 *   (b) `ROLL_MAX_DAMAGE = 32` was unreachable - the curve tops out at
 *       `maxHealth * (1 - ROLL_ABSORB)` = 28. Deleted rather than lowered, and
 *       the survivability invariant it claimed is asserted below instead.
 *   (c) The docstring's "stays armed briefly after landing too" was false.
 *       Split: the DAMAGE window is the approach only, and the ROLL is
 *       available for `ROLL_WINDOW` after touchdown too. Both halves asserted.
 *   (d) A pre-armed roll ran at the full 1.75 m capsule. It now tucks to
 *       0.735 m whatever the key is doing.
 *   (e) `rolling` and `diveWeight` had no readers. Both now drive real state,
 *       and the source ratchet at the bottom says so.
 */

const DT = 1 / 60;
const P = CONFIG.player;

/**
 * The one renderer-bound thing `Player` builds is `Weapon`, whose viewmodel
 * textures are painted on a 2D canvas and thrown away headless. Same concession
 * `player-speed.test.mjs` makes, for the same reason: it takes no part in
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

/* Source snapshots for the wiring ratchet at the bottom.
 * Read HERE, above the first `test()`, and not next to the cases that use
 * them: a top-level `await` yields, and node:test starts running whatever is
 * already registered the moment it does. Read after the registrations and the
 * early cases race the file I/O and fail on an empty map. */
const SRC = new Map();
function readSrcSync(rel) {
  const v = SRC.get(rel);
  if (v === undefined) throw new Error(`source ${rel} was not preloaded`);
  return v;
}
for (const rel of [
  'src/player/Parkour.js',
  'src/player/Player.js',
  'src/audio/AudioDirector.js',
  'src/audio/Sfx.js',
  'src/systems/VFX.js',
  'src/player/PlayerAvatar.js',
  'src/core/Input.js',
]) {
  SRC.set(rel, await readSrc(rel));
}

const { Parkour } = await import('../../src/player/Parkour.js');

/* ------------------------------------------------------------------ */
/* Worlds                                                              */
/* ------------------------------------------------------------------ */

const addTo = (physics) => (m) => {
  m.updateWorldMatrix(true, false);
  physics.addBoxFromObject(m);
  return m;
};

/** A single flat slab, large enough that no run can reach an edge. */
function flatWorld() {
  const physics = new Physics();
  const deck = new THREE.Mesh(new THREE.BoxGeometry(8000, 2, 8000));
  deck.position.set(0, -1, 0);
  addTo(physics)(deck);
  return physics;
}

/** Flat ground at y = 0 with a run-up plateau of height `H` covering x < 0. */
function ledgeWorld(H) {
  const physics = new Physics();
  const add = addTo(physics);
  const deck = new THREE.Mesh(new THREE.BoxGeometry(8000, 2, 8000));
  deck.position.set(0, -1, 0);
  add(deck);
  const ledge = new THREE.Mesh(new THREE.BoxGeometry(80, H, 80));
  ledge.position.set(-40, H / 2, 0);
  add(ledge);
  return physics;
}

/**
 * Flat ground with a slab bridging x in [10.5, 11.5] whose underside is at
 * `gap`. 40 m across the Z axis, so there is no going round it.
 *
 * Its span matters as much as its height. The capsule radius is 0.35, so the
 * obstructed band is x in [10.15, 11.85] - 1.7 m, which at the roll's 9.184 m/s
 * is 0.185 s out of a 0.55 s roll. A 2 m slab eats 0.29 s of it and leaves the
 * capsule only part-tucked at the entry and already growing at the exit, which
 * the solver then SQUEEZES through rather than admitting: measured, a 2 m slab
 * let the player past with the capsule 1.06 m tall under a 0.9 m gap. That is a
 * pass, and it is not a pass-under, so the geometry is sized to make the
 * difference visible instead of hiding it.
 */
function beamWorld(gap, span = 1) {
  const physics = new Physics();
  const add = addTo(physics);
  const deck = new THREE.Mesh(new THREE.BoxGeometry(8000, 2, 8000));
  deck.position.set(0, -1, 0);
  add(deck);
  /* `span` widens it from the default 1 m without moving its leading face, so
   * the pass-under case above keeps measuring exactly the geometry its numbers
   * were taken against while the settle-underneath case below can build a
   * crawl-space longer than the ~5 m a roll covers. */
  const beam = new THREE.Mesh(new THREE.BoxGeometry(span, 6, 40));
  beam.position.set(10.5 + span / 2, gap + 3, 0);
  add(beam);
  return physics;
}

/* ------------------------------------------------------------------ */
/* Driving                                                             */
/* ------------------------------------------------------------------ */

/** Facing is -Z at yaw 0, so this points forward along +X. */
const YAW_PLUS_X = -Math.PI / 2;

/**
 * A real `Player` on a real `EventBus`.
 *
 * The bus has to be real, not a `{ on: () => () => {} }` stub: `Parkour`
 * subscribes to `player:landed` in its constructor and every landing verdict in
 * this file arrives through that subscription. A stubbed bus silently measures
 * a game with no fall damage in it, which is how this was nearly written.
 */
function makePlayer(physics, { yaw = YAW_PLUS_X, log = null } = {}) {
  const bus = new EventBus();
  if (log) {
    const raw = bus.emit.bind(bus);
    bus.emit = (t, e) => { log.push([t, e]); return raw(t, e); };
  }
  const input = {
    state: {
      forward: 0, right: 0, jump: false, sprint: false, crouch: false, fire: false,
      aim: false, reload: false, interact: false, lookX: 0, lookY: 0, wheel: 0,
    },
    consumeLook: () => ({ dx: 0, dy: 0 }),
    pressed: () => false,
    textCaptured: false,
  };
  const player = new Player({
    scene: new THREE.Scene(), engine: {}, physics, bus, materials: {}, input,
    camera: new THREE.PerspectiveCamera(),
  });
  player.setYaw(yaw);
  player.bus = bus;
  return player;
}

/** Sprint is rationed and the ration is not the question in most cases here. */
function unlimitedStamina(player) {
  if (!player.stamina) return;
  Object.defineProperty(player.stamina, 'canSprint', { get: () => true, configurable: true });
  player.stamina.drain = () => {};
}

const planar = (p) => Math.hypot(p.velocity.x, p.velocity.z);

/** Settle on the ground, then hold forward until the speed is at its ceiling. */
function cruise(player, { sprint = false, at = [0, 0.5, 0], warm = 300 } = {}) {
  player._position.set(at[0], at[1], at[2]);
  for (let i = 0; i < 180; i++) player.fixedUpdate(DT, i * DT);
  unlimitedStamina(player);
  player.input.state.forward = 1;
  player.input.state.sprint = sprint;
  let t = 3;
  for (let i = 0; i < warm; i++, t += DT) player.fixedUpdate(DT, t);
  return t;
}

/* ------------------------------------------------------------------ */
/* 1. The movement envelope                                            */
/* ------------------------------------------------------------------ */

/**
 * Run flat out, jump, and report the gap actually crossed and the height
 * actually reached.
 *
 * The gap is measured from the LAST grounded position to the first grounded
 * position after, which is the distance a player would have to have as open
 * air in front of them; the apex is measured against the ground the take-off
 * happened from, not against the position one integration step into the rise,
 * which under-reads by 10 cm.
 */
function jumpArc(physics, { sprint, allowLeap }) {
  const player = makePlayer(physics);
  let t = cruise(player, { sprint });
  if (!allowLeap) player.parkour.tryLeap = () => false;
  const groundY = player.position.y;
  const s = player.input.state;
  s.jump = true;
  let takeoff = null;
  let apex = -Infinity;
  let landing = null;
  let air = 0;
  for (let i = 0; i < 400; i++, t += DT) {
    const before = player.position.clone();
    player.fixedUpdate(DT, t);
    if (i === 2) s.jump = false;
    if (takeoff === null && !player.grounded) takeoff = before;
    if (takeoff !== null) {
      air++;
      apex = Math.max(apex, player.position.y - groundY);
      if (player.grounded && air > 3) { landing = player.position.clone(); break; }
    }
  }
  assert.ok(landing, 'the player never came back down');
  return {
    gap: Math.hypot(landing.x - takeoff.x, landing.z - takeoff.z),
    apex,
    air: air * DT,
    cruise: planar(player),
  };
}

test('the three gap distances are what the design says, to the millimetre', () => {
  const walk = jumpArc(flatWorld(), { sprint: false, allowLeap: false });
  const sprint = jumpArc(flatWorld(), { sprint: true, allowLeap: false });
  const leap = jumpArc(flatWorld(), { sprint: true, allowLeap: true });

  assert.ok(Math.abs(walk.cruise - P.walkSpeed) < 1e-9, 'the walk never reached walkSpeed');
  assert.ok(Math.abs(sprint.cruise - P.sprintSpeed) < 1e-9, 'the sprint never reached the cap');

  for (const [name, got, want] of [
    ['walk jump', walk.gap, 2.607],
    ['sprint jump', sprint.gap, 4.647],
    ['leap', leap.gap, 7.569],
  ]) {
    assert.ok(Math.abs(got - want) < 0.001,
      `a ${name} crossed ${got.toFixed(4)} m against the ${want} m the design is authored `
      + 'against. Every rooftop gap in the citadel is spaced off these three numbers.');
  }

  // A leap is worth 2.92 m more than a sprint jump. That margin is the only
  // reason the verb exists, so it is asserted as a margin and not just as a
  // pair of totals.
  assert.ok(leap.gap - sprint.gap > 2.9,
    `a leap buys ${(leap.gap - sprint.gap).toFixed(3)} m over a sprint jump; under 2.9 m no `
    + 'rooftop gap can be authored that demands the leap and admits nothing else');
  assert.ok(leap.air > sprint.air,
    'a leap is no longer in the air longer than a sprint jump - LEAP_LIFT has gone');
});

test('THE DESIGN IS WRONG ABOUT THE APEX: 0.878 m and 1.109 m, not 0.93 and 1.17', () => {
  /* The design's apexes are the continuous closed form `v^2/2g`. The game is
   * semi-implicit Euler at 1/60 with gravity applied before the position
   * update, which loses `|g| dt^2 / 2` = 0.00306 m on the first step and never
   * gets it back. See the header for the arithmetic. This case exists so that
   * the next person to author a ledge band uses the number the integrator
   * produces rather than the one the algebra does. */
  const walk = jumpArc(flatWorld(), { sprint: false, allowLeap: false });
  const sprint = jumpArc(flatWorld(), { sprint: true, allowLeap: false });
  const leap = jumpArc(flatWorld(), { sprint: true, allowLeap: true });

  const closed = (v) => (v * v) / (2 * -P.gravity);
  const plainClosed = closed(P.jumpVelocity);
  const leapClosed = closed(P.jumpVelocity * 1.12);
  assert.ok(Math.abs(plainClosed - 0.9309) < 0.0005 && Math.abs(leapClosed - 1.1677) < 0.0005,
    'the continuous closed form moved, so the design numbers this case corrects came from '
    + 'somewhere else and the correction needs re-deriving');

  for (const [name, got, want] of [
    ['walk jump', walk.apex, 0.8783],
    ['sprint jump', sprint.apex, 0.8783],
    ['leap', leap.apex, 1.1088],
  ]) {
    assert.ok(Math.abs(got - want) < 0.001,
      `a ${name} reached ${got.toFixed(4)} m, not ${want} m`);
  }
  // The gap between algebra and integrator, named so it cannot be rounded away.
  assert.ok(plainClosed - walk.apex > 0.05,
    'the integrator now agrees with the continuous closed form, which would mean the fixed '
    + 'step or the order of the gravity term changed; re-derive the ledge bands');
});

/* ------------------------------------------------------------------ */
/* 2. The leap and its stamina gate                                    */
/* ------------------------------------------------------------------ */

test('the leap refuses a walk, refuses without sprint, and costs 14 stamina', () => {
  const player = makePlayer(flatWorld());
  cruise(player, { sprint: false });
  // Restore the real pool: the gate is the question here.
  const pool = player.stamina;
  pool._value = pool.max;

  player.input.state.sprint = false;
  assert.equal(player.parkour.tryLeap(), false, 'a leap was granted with no sprint key held');

  player.input.state.sprint = true;
  assert.ok(planar(player) < 5.2,
    `the walk is at ${planar(player).toFixed(3)} m/s, which is over LEAP_MIN_SPEED - this case `
    + 'is no longer testing the speed gate');
  assert.equal(player.parkour.tryLeap(), false, 'a walking leap was granted');
  assert.equal(pool.value, pool.max, 'a refused leap still charged stamina');
});

test('a full stamina bar affords exactly 7 leaps', () => {
  /* The design publishes "a full bar affords 7 leaps" as a planning number for
   * rooftop chain length. It is `floor(maxStamina / LEAP_STAMINA)` =
   * floor(100/14) = 7 with 2 left over, and it is driven rather than divided
   * because `spend` is atomic - the eighth must be REFUSED, not part-paid. */
  const player = makePlayer(flatWorld());
  player._position.set(0, 0.5, 0);
  // Settled, never sprinted: the sprint tap is a separate cost and draining it
  // here would make this a measurement of two things at once.
  for (let i = 0; i < 120; i++) player.fixedUpdate(DT, i * DT);
  const pool = player.stamina;
  assert.equal(pool.value, pool.max, 'the pool was not full when the count started');
  player.input.state.sprint = true;

  let granted = 0;
  for (let i = 0; i < 20; i++) {
    // Re-establish the run-up each time: `tryLeap` scales the standing velocity.
    player._velocity.set(-Math.sin(player.yaw) * P.sprintSpeed, 0, -Math.cos(player.yaw) * P.sprintSpeed);
    if (player.parkour.tryLeap()) granted++;
  }
  assert.equal(granted, 7,
    `a full bar afforded ${granted} leaps, not the 7 the citadel's rooftop chains are `
    + `authored against (${pool.max} stamina / 14 a leap)`);
  assert.ok(pool.value < 14 && pool.value >= 0,
    `${pool.value} stamina left after seven leaps - the eighth should have been refused for `
    + 'want of a whole cost, not part-paid');
});

/* ------------------------------------------------------------------ */
/* 3. The fall-damage curve and the roll                               */
/* ------------------------------------------------------------------ */

/**
 * Put the player on the flat and announce a landing at `speed`.
 *
 * Drives the real `_onLand` through the real bus subscription, which is the
 * only way `Parkour` ever learns an impact speed. `_peakFall` is cleared first
 * so the number under test is the one passed in.
 */
function landAt(speed, { crouch = false, armed = false } = {}) {
  const player = makePlayer(flatWorld());
  player._position.set(0, 0.5, 0);
  // Long enough to have fallen the half metre and be genuinely grounded: the
  // post-landing window below only opens for a player standing on something.
  for (let i = 0; i < 60; i++) player.fixedUpdate(DT, i * DT);
  const before = player.health;
  const pk = player.parkour;
  pk._peakFall = 0;
  if (armed) pk._rollArmed = 0.2;
  player.input.state.crouch = crouch;
  player.bus.emit('player:landed', { speed, position: player.position });
  return { player, verdict: pk.lastLanding, lost: before - player.health };
}

test('the fall damage curve: free under 18 m/s, lethal at 42, linear between', () => {
  assert.equal(landAt(17.9).verdict.damage, 0, 'a 17.9 m/s arrival hurt');
  assert.equal(landAt(18.0).verdict.damage, 0, 'the safe threshold itself hurt');
  // The midpoint of the band is exactly half of maxHealth.
  const mid = landAt(30).verdict.damage;
  assert.equal(mid, 50, `30 m/s cost ${mid}, not half of ${P.maxHealth}`);
  const lethal = landAt(42);
  assert.equal(lethal.verdict.damage, P.maxHealth, 'the lethal speed is no longer lethal');
  assert.equal(lethal.player.isDead, true, 'a 42 m/s arrival from full health did not kill');
  // Past lethal is clamped, not extrapolated.
  assert.equal(landAt(120).verdict.damage, P.maxHealth, 'the curve is not clamped above lethal');
});

test('the fall-damage thresholds in METRES, and the design is a little long about them', () => {
  /* The speeds are the model; the drop heights are what a level author needs,
   * and they are not `v^2/2g` either. A player stepping off a ledge already
   * carries `_move`'s -2.2 m/s ground-stick bias in the velocity, so a fall is
   * shorter than one starting from rest: measured 7.0 m free / 7.5 m for the
   * first point of damage, and 39 m survivable / 40 m fatal, against the
   * design's 7.79 m and 40.8 m.
   *
   * Four drops, not a sweep: the sweep that found these numbers built 780
   * Players and took four minutes. */
  const fall = (H) => {
    const player = makePlayer(ledgeWorld(H));
    player._position.set(-2, H + 0.5, 0);
    for (let i = 0; i < 180; i++) player.fixedUpdate(DT, i * DT);
    // The half-metre settle drop onto the ledge is itself a landing, and it
    // arrives at 4.8 m/s. Clearing the verdict is what makes the loop below
    // wait for the real one.
    player.parkour.lastLanding = null;
    player.input.state.forward = 1;
    let t = 3;
    for (let i = 0; i < 1200 && player.parkour.lastLanding === null; i++, t += DT) {
      player.fixedUpdate(DT, t);
    }
    return { verdict: player.parkour.lastLanding, dead: player.isDead };
  };

  const free = fall(7);
  assert.equal(free.verdict.damage, 0,
    `a 7 m drop cost ${free.verdict.damage} - it arrives at 17.60 m/s against a safe 18`);
  const hurt = fall(7.5);
  assert.equal(hurt.verdict.damage, 1,
    `a 7.5 m drop is the first that costs anything; this one reported `
    + `${JSON.stringify(hurt.verdict)}`);

  const survived = fall(39);
  assert.equal(survived.dead, false,
    `a 39 m drop killed outright; it arrives at 41.43 m/s and costs 98 of 100, which is the `
    + 'margin the whole "every fall has an answer" thesis lives in');
  assert.equal(fall(40).dead, true, 'a 40 m drop is no longer fatal from full health');
});

test('ROLL_MAX_DAMAGE is gone, and the maximum a rolled landing can cost is 28', () => {
  /* DEFECT (b). `ROLL_MAX_DAMAGE = 32` was documented as the guarantee that "a
   * rolled landing is survivable" and could not bind: the unrolled curve tops
   * out at `maxHealth`, so the rolled curve tops out at
   * `maxHealth * (1 - ROLL_ABSORB)` = 28, and `Math.min(32, ...)` never chose
   * its left operand at any speed the model can produce. Deleted rather than
   * lowered - a rail above the maximum is not a rail - and this is the
   * assertion that took its place, which CAN fail: lower `ROLL_ABSORB` past
   * 0.70 and it does. */
  const src = readSrcSync('src/player/Parkour.js');
  // The DECLARATION, not the name: the header still discusses the constant at
  // length, because a deletion nobody can find the reasoning for gets undone.
  assert.doesNotMatch(src, /^const ROLL_MAX_DAMAGE/m,
    'ROLL_MAX_DAMAGE is back. If it has been given a value that actually binds, this case '
    + 'needs rewriting to assert where it binds rather than that it is absent.');
  assert.doesNotMatch(src, /Math\.min\(\s*ROLL_MAX_DAMAGE/,
    'the unreachable cap is back in the damage path');

  /* One player, healed between arrivals. Constructing 43 of them costs 20
   * seconds of the suite, almost all of it painting viewmodel textures onto a
   * canvas that is thrown away - and the sweep is about the curve, not about
   * the constructor. */
  const player = makePlayer(flatWorld());
  player._position.set(0, 0.5, 0);
  for (let i = 0; i < 60; i++) player.fixedUpdate(DT, i * DT);
  const pk = player.parkour;
  player.input.state.crouch = true;
  let worst = 0;
  for (let speed = 18; speed <= 60; speed += 0.5) {
    player.heal(P.maxHealth);
    pk._peakFall = 0;
    pk.rollTime = 0;
    player.bus.emit('player:landed', { speed, position: player.position });
    assert.equal(pk.lastLanding.rolled, true, `a crouched arrival at ${speed} m/s did not roll`);
    worst = Math.max(worst, pk.lastLanding.damage);
    assert.equal(player.isDead, false,
      `a rolled landing at ${speed} m/s killed a player at full health`);
  }
  assert.equal(worst, 28,
    `the worst a rolled landing can cost is ${worst}, not the 28 the curve implies `
    + '(maxHealth * (1 - ROLL_ABSORB))');
  assert.ok(worst < P.maxHealth * 0.3,
    'a rolled landing can now cost more than 30% of the bar, which is the invariant the '
    + 'deleted cap claimed to provide');
});

test('the roll is armed by a press on the way DOWN, and that half of the window is real', () => {
  const held = landAt(30, { crouch: true });
  assert.equal(held.verdict.rolled, true, 'crouch held through touchdown did not roll');
  assert.equal(held.verdict.damage, 14, `a rolled 30 m/s landing cost ${held.verdict.damage}`);

  const armedOnly = landAt(30, { crouch: false, armed: true });
  assert.equal(armedOnly.verdict.rolled, true,
    'a crouch pressed inside ROLL_WINDOW before touchdown and released did not roll - the '
    + 'window is the difference between a mechanic and a coin flip');
  assert.equal(armedOnly.verdict.damage, 14);

  const neither = landAt(30);
  assert.equal(neither.verdict.rolled, false);
  assert.equal(neither.verdict.damage, 50, 'the unrolled landing is no longer the full curve');
});

test('DEFECT (c): a press AFTER touchdown still rolls, and still cannot un-hurt you', () => {
  /* The docstring claimed the window "stays armed briefly after landing too".
   * It did not - the late path only ever read HELD crouch on the landing step.
   * The resolution was to split the claim rather than to delete it: the DAMAGE
   * verdict is resolved at touchdown and stays resolved, because un-applying
   * damage a fifth of a second later reads as a health bar with a bug in it;
   * the ROLL is now available for ROLL_WINDOW afterwards through the same path
   * a running dodge takes. Both halves are asserted here, and the second half
   * is the one that fails on the old code. */
  const { player, verdict } = landAt(30);
  assert.equal(verdict.rolled, false);
  assert.equal(verdict.damage, 50, 'the un-rolled hit was not taken in full');
  const hpAfterHit = player.health;

  // Two frames later - well inside ROLL_WINDOW - the player presses crouch.
  let t = 60 * DT;
  player.input.state.crouch = false;
  player.fixedUpdate(DT, (t += DT));
  player.input.state.crouch = true;
  player.fixedUpdate(DT, (t += DT));

  assert.equal(player.parkour.rolling, true,
    'a crouch pressed two frames after a hard landing did nothing. The header promises this '
    + 'half of ROLL_WINDOW; either the code or the header has drifted again.');
  assert.equal(player.parkour.rollKind, 'late');
  assert.equal(player.health, hpAfterHit,
    'the late press refunded damage that had already been applied');

  // ...and it is not available forever.
  const late = landAt(30).player;
  let t2 = 60 * DT;
  for (let i = 0; i < 40; i++) late.fixedUpdate(DT, (t2 += DT)); // 0.67 s > ROLL_WINDOW
  late.input.state.crouch = true;
  late.fixedUpdate(DT, (t2 += DT));
  assert.equal(late.parkour.rolling, false,
    'the post-landing window never closes, so crouch on the flat rolls at any time');
});

test('a haystack landing takes no damage at any speed and announces itself', () => {
  const player = makePlayer(flatWorld());
  player._position.set(0, 0.5, 0);
  for (let i = 0; i < 120; i++) player.fixedUpdate(DT, i * DT);
  player.parkour.worldManager = { active: { haystacks: [{ x: 0, y: 0.5, z: 0, r: 3 }] } };
  const seen = [];
  player.bus.on('player:softland', (e) => seen.push(e));
  player.parkour._peakFall = 0;
  player.bus.emit('player:landed', { speed: 58, position: player.position });
  assert.equal(player.parkour.lastLanding.soft, 'hay');
  assert.equal(player.parkour.lastLanding.damage, 0, 'a haystack charged for a 58 m/s fall');
  assert.equal(seen.length, 1, 'player:softland was not raised for the hay');
  assert.equal(seen[0].kind, 'hay');
});

/* ------------------------------------------------------------------ */
/* 4. Momentum through a roll - DEFECT (a)                             */
/* ------------------------------------------------------------------ */

/**
 * Sprint off a ledge of height `H` holding crouch, and sample the ground speed
 * every step after touchdown.
 *
 * Crouch held is the case that matters and the case that was broken: it is what
 * the docstring tells the player to do, and it is what sets `wishSpeed` to
 * `crouchSpeed` and hands the whole reward to friction.
 */
function rollDecay(H) {
  const player = makePlayer(ledgeWorld(H));
  let t = cruise(player, { sprint: true, at: [-30, H + 0.5, 0], warm: 200 });
  const s = player.input.state;
  const speeds = [];
  let landed = -1;
  for (let i = 0; i < 600; i++, t += DT) {
    if (!player.grounded) s.crouch = true;
    player.fixedUpdate(DT, t);
    if (landed < 0 && player.grounded && player.position.y < H * 0.5) landed = i;
    if (landed >= 0) speeds.push(planar(player));
    if (landed >= 0 && i - landed > 80) break;
  }
  return { speeds, verdict: player.parkour.lastLanding };
}

test('DEFECT (a): the roll holds its momentum for ROLL_TIME instead of shedding it in 0.2 s', () => {
  /* MEASURED BEFORE THE FIX, off a 12 m ledge with crouch held:
   *
   *     +0.00 s   15.064 m/s
   *     +0.10 s    5.045 m/s
   *     +0.20 s    2.200 m/s      <- crouchSpeed. The reward is gone.
   *
   * AFTER: 9.184 m/s - the sprint cap times ROLL_SPEED - held flat from +0.05 s
   * to the end of the roll, then released back to whatever the keys ask for.
   * The floor is capped there deliberately: uncapped, this 30 m/s impact would
   * have held 33.6 m/s of ground speed for half a second. */
  const r = rollDecay(12);
  assert.equal(r.verdict.rolled, true, 'the drop did not produce a roll at all');

  const at = (sec) => r.speeds[Math.round(sec / DT)];
  const cap = P.sprintSpeed * 1.12;

  assert.ok(at(0.20) > P.sprintSpeed,
    `two tenths of a second after a rolled landing the player is doing ${at(0.20).toFixed(3)} `
    + `m/s. It was 2.200 before the floor existed - crouchSpeed - and a rooftop run that stops `
    + 'dead every time it drops a level is the opposite of parkour.');
  for (const sec of [0.20, 0.30, 0.40, 0.50]) {
    assert.ok(Math.abs(at(sec) - cap) < 1e-6,
      `the floor is meant to hold ${cap.toFixed(3)} m/s flat through the roll; at +${sec} s it `
      + `measures ${at(sec).toFixed(6)}`);
  }
  // ...and then let go. Crouch is still held, so the wish is back to 2.2.
  assert.ok(at(0.90) < 3,
    `the floor is still holding ${at(0.90).toFixed(3)} m/s 0.9 s after touchdown, which is `
    + 'longer than ROLL_TIME - the roll has become a permanent speed boost');
});

test('the speed floor is a floor and not a boost: it never adds beyond the cap', () => {
  /* The floor scales velocity UP to a target and does nothing when the player
   * is already faster. Without that, `holdRollSpeed` running every step would
   * compound 1.12x per frame into a launcher. */
  const player = makePlayer(flatWorld());
  cruise(player, { sprint: true });
  const pk = player.parkour;
  pk._startRoll(P.sprintSpeed, 'dodge');
  const floor = P.sprintSpeed * 1.12;
  player._velocity.x = -Math.sin(player.yaw) * 40;
  player._velocity.z = -Math.cos(player.yaw) * 40;
  assert.equal(pk.holdRollSpeed(), false, 'the floor slowed a player who was already faster');
  assert.ok(Math.abs(planar(player) - 40) < 1e-9);
  // ...and a player stopped dead by a wall is not shoved back into it.
  player._velocity.set(0, 0, 0);
  assert.equal(pk.holdRollSpeed(), false, 'the floor re-accelerated a roll that had been stopped');
  /* `assert.ok(floor > P.sprintSpeed)` used to stand here, with `floor`
   * computed two lines above as `P.sprintSpeed * 1.12`. Both operands came from
   * the same config value and a literal, so it reduced to `8.2 * 1.12 > 8.2`
   * and could not fail for any edit to the module under test. The cap is now
   * exported and the assertion is about it. */
  assert.ok(Math.abs(Parkour.ROLL_FLOOR_MAX - floor) < 1e-12,
    `Parkour.ROLL_FLOOR_MAX is ${Parkour.ROLL_FLOOR_MAX} against the ${floor} the roll is `
    + 'tuned around');
  assert.ok(Parkour.ROLL_FLOOR_MAX > P.sprintSpeed,
    'the roll can no longer hold a player above a flat sprint, so it buys no momentum at all');
});

/* ------------------------------------------------------------------ */
/* 5. The ground dodge roll - the capsule, the eye, and the pass-under */
/* ------------------------------------------------------------------ */

/**
 * Sprint at a beam whose underside is at `gap` and report how far the player
 * got, plus the smallest capsule and eye height seen on the way.
 *
 * `player.update` is driven as well as `fixedUpdate`, because the eye is a
 * PER-FRAME spring and lives in `update`; a test that only steps the physics
 * measures a capsule that ducks and a camera that does not.
 */
function runAtBeam(gap, { dodge = false, crouchThroughout = false, trigger = 8.4 } = {}) {
  const player = makePlayer(beamWorld(gap));
  const s = player.input.state;
  if (crouchThroughout) s.crouch = true;
  // Started far enough back that the run-up never reaches the beam, so every
  // case below arrives at it at its own top speed rather than from a standstill
  // against it.
  let t = cruise(player, { sprint: true, at: [-40, 0.5, 0], warm: 180 });
  let minCapsule = Infinity;
  let minEye = Infinity;
  let tallestUnder = 0;
  let fired = false;
  let rollSteps = 0;
  for (let i = 0; i < 1800; i++, t += DT) {
    if (dodge && !fired && player.position.x > trigger) { s.crouch = true; fired = true; }
    else if (fired && s.crouch && player.parkour.rolling) s.crouch = false;
    player.fixedUpdate(DT, t);
    player.update(DT, t);
    minCapsule = Math.min(minCapsule, player.capsuleHeight);
    minEye = Math.min(minEye, player.eyeHeight);
    // Inside the obstructed band, capsule radius included.
    if (player.position.x > 10.15 && player.position.x < 11.85) {
      tallestUnder = Math.max(tallestUnder, player.capsuleHeight);
    }
    if (player.parkour.rolling) rollSteps++;
    if (player.position.x > 20) break;
  }
  return { x: player.position.x, minCapsule, minEye, tallestUnder, rollSteps };
}

test('DEFECT (d) + the new verb: a dodge roll tucks the capsule AND drops the eye', () => {
  /* Both halves matter and only one of them is obvious. The capsule is damped
   * in `fixedUpdate`; the eye is a SEPARATE spring in `update`, keyed off
   * `_crouching` and not off the capsule, so a roll that only touched the
   * capsule would duck the body and leave the camera at 1.62 m. */
  const r = runAtBeam(6, { dodge: true });
  assert.ok(r.rollSteps > 25 && r.rollSteps < 40,
    `the roll ran for ${r.rollSteps} steps against the 33 that ROLL_TIME buys`);
  assert.ok(Math.abs(r.minCapsule - Parkour.ROLL_HEIGHT) < 0.01,
    `the capsule bottomed out at ${r.minCapsule.toFixed(4)} m against ROLL_HEIGHT `
    + `${Parkour.ROLL_HEIGHT.toFixed(4)}`);
  assert.ok(Math.abs(r.minEye - Parkour.ROLL_EYE) < 0.01,
    `the eye bottomed out at ${r.minEye.toFixed(4)} m against ROLL_EYE `
    + `${Parkour.ROLL_EYE.toFixed(4)} - the camera did not follow the body down`);
  assert.ok(Parkour.ROLL_HEIGHT < P.height * 0.58,
    'ROLL_HEIGHT is no longer under CROUCH_HEIGHT, so the roll cannot go anywhere a crouch '
    + 'cannot and the pass-under below is measuring a crouch');
});

test('the dodge roll passes under a 0.9 m beam that stops a sprint and stops a crouch', () => {
  /* THE POINT OF THE VERB. 0.9 m clears the 0.735 m roll capsule and blocks
   * both the 1.75 m stand and the 1.015 m crouch, so all three cases below are
   * the same wall asked the same question three ways. */
  const rolled = runAtBeam(0.9, { dodge: true });
  const standing = runAtBeam(0.9);
  const crouched = runAtBeam(0.9, { crouchThroughout: true });

  assert.ok(rolled.x > 19,
    `the dodge roll only reached x = ${rolled.x.toFixed(2)}; the beam ends at x = 11.5`);
  assert.ok(rolled.tallestUnder < 0.9,
    `the roll got through with the capsule ${rolled.tallestUnder.toFixed(3)} m tall under a `
    + '0.9 m gap, which means the solver squeezed it rather than it fitting. Measured at '
    + '0.789 m when it fits properly.');
  assert.ok(standing.x < 10.2,
    `a sprint got to x = ${standing.x.toFixed(2)} under a beam it is 0.85 m too tall for`);
  assert.ok(crouched.x < 10.2,
    `a crouch-walk got to x = ${crouched.x.toFixed(2)}; if a crouch fits, the roll is not `
    + 'buying anything and this world is the wrong height');
  assert.ok(crouched.minCapsule > 0.9,
    'the control is rolling too - it is meant to be an ordinary held crouch, which raises no '
    + 'edge and so can never dodge');
});

test('a dodge roll is briefly invulnerable, and a landing roll is not', () => {
  /* i-frames on the deliberate entries only. On a landing roll they would fire
   * before `_onLand` applies the fall damage and cancel the very hit the roll
   * is meant to be softening rather than negating. */
  const player = makePlayer(flatWorld());
  cruise(player, { sprint: true });
  let t = 5;
  player.input.state.crouch = true;
  player.fixedUpdate(DT, (t += DT));
  assert.equal(player.parkour.rollKind, 'dodge', 'a sprint plus crouch did not dodge');
  assert.equal(player.isInvulnerable, true, 'a dodge roll granted no i-frames');
  assert.equal(player.applyDamage(40, null, 'test'), 0, 'a dodge roll took damage');

  // ...and the landing roll pays in full, minus ROLL_ABSORB and nothing else.
  const land = landAt(30, { crouch: true });
  assert.equal(land.verdict.rolled, true);
  assert.equal(land.lost, 14,
    `a rolled 30 m/s landing cost ${land.lost} health; i-frames on the landing path would `
    + 'make it 0 and delete fall damage from the game for anyone holding crouch');
});

test('a walk plus crouch is still a crouch, and a crouch held is not a roll every frame', () => {
  /* The dodge shares `KeyC` with five other meanings and is disambiguated by
   * grounded-and-running alone, so the two ways to get a false positive are a
   * walk (under LEAP_MIN_SPEED) and a hold (no edge). Both are asserted,
   * because a dodge firing on an ordinary crouch-walk would change the feel of
   * every world in the game and would not fail any other test. */
  const player = makePlayer(flatWorld());
  cruise(player, { sprint: false });
  assert.ok(planar(player) < 5.2, 'the walk is over LEAP_MIN_SPEED; this case tests nothing');
  let t = 5;
  player.input.state.crouch = true;
  for (let i = 0; i < 10; i++) player.fixedUpdate(DT, (t += DT));
  assert.equal(player.parkour.rolling, false, 'a crouch pressed while WALKING dodge-rolled');
  assert.equal(player.isCrouching, true, 'the ordinary crouch stopped working');

  // Now bring the speed up with crouch already down: no edge, so no dodge.
  player.input.state.sprint = true;
  for (let i = 0; i < 200; i++) player.fixedUpdate(DT, (t += DT));
  assert.equal(player.parkour.rolling, false,
    'a crouch that was already held started a roll when the speed crossed the threshold');
});

/* ------------------------------------------------------------------ */
/* 6. The dive                                                         */
/* ------------------------------------------------------------------ */

test('DEFECT (e): diveWeight is a live smoothed number the camera reads', () => {
  /* `diveWeight` returned `this.diving ? 1 : 0` and had no readers at all.
   * It is now the blend the pose and the view pitch are both driven by, and
   * it is smoothed rather than binary because `Player.update` turns it
   * straight into camera pitch - a step function there is 19 degrees in one
   * frame. */
  const player = makePlayer(ledgeWorld(40));
  let t = cruise(player, { sprint: true, at: [-30, 40.5, 0], warm: 200 });
  const s = player.input.state;
  const dives = [];
  const weights = [];
  player.bus.on('player:dive', (e) => dives.push(e.state));
  let peakPitch = 0;
  for (let i = 0; i < 120; i++, t += DT) {
    if (!player.grounded) s.crouch = true;
    player.fixedUpdate(DT, t);
    player.update(DT, t);
    if (player.parkour.diving) weights.push(player.parkour.diveWeight);
    peakPitch = Math.min(peakPitch, player._posePitch);
  }
  assert.equal(dives[0], 'start', 'crouch while falling never raised player:dive');
  assert.ok(weights.length > 20, 'the dive never held for long enough to measure');
  assert.ok(weights[0] < 0.35,
    `the dive blend was ${weights[0].toFixed(3)} on its first frame; it is meant to ease in`);
  assert.ok(weights[weights.length - 1] > 0.9, 'the dive blend never reached full weight');
  assert.ok(peakPitch < -0.3,
    `the camera pitched ${peakPitch.toFixed(3)} rad at the deepest point of a full dive; `
    + 'diveWeight has lost its reader again');
  assert.ok(peakPitch > -0.5,
    `the camera pitched ${peakPitch.toFixed(3)} rad. The BODY goes fully head-first at 1.18 `
    + 'rad; the camera deliberately does not, because 68 degrees of involuntary pitch in first '
    + 'person is the motion-sickness failure state the dip clamp already refuses to ship.');
});

/* ------------------------------------------------------------------ */
/* 7. The wiring - the camera:shake defect class                       */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 6b. The pose actually wins                                          */
/* ------------------------------------------------------------------ */

/**
 * A stand-in for `Humanoid`: a bone Map and a rig, and nothing else.
 *
 * `applyPose` touches exactly those two things, and the real `Humanoid` builds
 * lofted geometry on a canvas - so the stub is what makes "does the pose win?"
 * answerable headless. The bone names are the ones `createSkeleton` produces.
 */
function stubHumanoid() {
  const names = ['pelvis', 'spine01', 'spine02', 'spine03', 'neck', 'head'];
  for (const side of ['R', 'L']) {
    for (const b of ['clavicle', 'upperArm', 'foreArm', 'hand', 'thigh', 'calf', 'foot', 'toe']) {
      names.push(b + side);
    }
  }
  const bones = new Map(names.map((n) => [n, new THREE.Bone()]));
  return { bones, rig: new THREE.Object3D() };
}

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const eulerQ = (x, y, z) => _q.setFromEuler(_e.set(x, y, z)).clone();

test('a LATE ABSOLUTE slerp beats PlayerAvatar._applyAirPose, and it is not an assumption', () => {
  /* The design asserts this and it is worth proving rather than believing,
   * because the two halves of it are independent and either could rot.
   *
   * ORDER: `Player._installLatePose` registers on the first `update()`, which
   * happens INSIDE main.js's own frame callback, so it is appended to
   * `Engine._frameUpdaters` behind it - and `Engine` iterates a Set, whose
   * order is insertion order (Engine.js:104, :191, :329). That is asserted in
   * the case above, on the source.
   *
   * MECHANISM, here: `_applyAirPose` is the only additive pose in the codebase
   * - `bone.quaternion.multiply(delta)` - and multiplying a delta onto a bone
   * leaves the result dependent on what the bone held. A slerp toward an
   * ABSOLUTE target at weight 1 does not. So the test pre-rotates the bones to
   * something arbitrary, exactly as an air pose would, and asks whether the
   * roll pose lands on its target anyway.
   */
  const player = makePlayer(flatWorld());
  const humanoid = stubHumanoid();
  player.avatar = { humanoid };
  const pk = player.parkour;

  // Halfway through the roll: sin(pi * 0.5) ** 0.65 is exactly 1.
  pk.rollTime = Parkour.ROLL_TIME * 0.5;

  // What PlayerAvatar would have left behind: a locomotion pose with the
  // additive air tuck multiplied on top.
  const junk = eulerQ(0.9, -0.4, 0.25);
  for (const name of ['thighR', 'upperArmL', 'head']) {
    humanoid.bones.get(name).quaternion.copy(junk);
  }

  pk.applyPose(DT, 1);

  const want = {
    thighR: eulerQ(1.72, 0, 0.20),
    upperArmL: eulerQ(0.55, 0, -0.62),
    head: eulerQ(0.34, 0, 0),
  };
  for (const [name, q] of Object.entries(want)) {
    const got = humanoid.bones.get(name).quaternion;
    assert.ok(got.angleTo(q) < 1e-6,
      `${name} ended ${got.angleTo(q).toFixed(6)} rad from the absolute target the roll asked `
      + 'for. At full envelope weight a slerp lands on its target whatever the bone held - if '
      + 'this drifts, either the pose went additive or something is running after it.');
  }
  // ...and the somersault is on the rig, not folded into the spine.
  assert.ok(Math.abs(humanoid.rig.quaternion.angleTo(new THREE.Quaternion()
    .setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI))) < 1e-6,
    'half a roll is meant to be half a turn of the rig about +X');
  assert.ok(Math.abs(humanoid.rig.position.y - 0.62 * 2) < 1e-9,
    `the rig lifted ${humanoid.rig.position.y.toFixed(4)} m at full inversion. The pivot is at `
    + 'the FEET, so an upside-down body with no lift has its head a metre underground.');
});

test('the envelope is zero at both ends, so nothing twitches on entry or exit', () => {
  const player = makePlayer(flatWorld());
  const humanoid = stubHumanoid();
  player.avatar = { humanoid };
  const pk = player.parkour;
  const junk = eulerQ(0.9, -0.4, 0.25);
  const head = humanoid.bones.get('head');

  for (const t of [1e-9, Parkour.ROLL_TIME - 1e-9]) {
    pk.rollTime = t;
    head.quaternion.copy(junk);
    pk.applyPose(DT, 1);
    assert.ok(head.quaternion.angleTo(junk) < 1e-3,
      `the roll pose had weight at its very ${t < 0.1 ? 'end' : 'start'} - slerping at full `
      + 'weight from frame one is what makes an avatar twitch (TennisPose.js:19-22)');
  }
});

test('the rig is handed back, and never taken while Swim still owns it', () => {
  /* The handover rule from `MinigamePose`: whoever writes `humanoid.rig` is
   * responsible for putting it back, and taking it while the swim pose is
   * still decaying snaps a prone body upright mid-stroke. */
  const player = makePlayer(flatWorld());
  const humanoid = stubHumanoid();
  player.avatar = { humanoid };
  const pk = player.parkour;

  pk.rollTime = Parkour.ROLL_TIME * 0.5;
  pk.applyPose(DT, 1);
  assert.ok(humanoid.rig.position.y > 1, 'the roll never took the rig');

  pk.rollTime = 0;
  pk.applyPose(DT, 1);
  assert.equal(humanoid.rig.position.y, 0, 'the rig was not handed back after the roll');
  assert.ok(humanoid.rig.quaternion.angleTo(new THREE.Quaternion()) < 1e-9);

  // Now with a swimmer still holding it.
  pk.rollTime = Parkour.ROLL_TIME * 0.5;
  pk.applyPose(DT, 1);
  player.swim._poseWeight = 1;
  humanoid.rig.position.y = 0.5;
  pk.rollTime = 0;
  pk.applyPose(DT, 1);
  assert.equal(humanoid.rig.position.y, 0.5,
    'the roll cleared the rig out from under the swim pose, which writes it every frame and '
    + 'restores it itself');
});

test('every event Parkour emits has an owner somewhere in src/', async () => {
  /* THE RATCHET ON THE DEFECT CLASS. `camera:shake` shipped with eight
   * emitters and no listener; these five shipped with one emitter each and no
   * listener, which is worse because nothing in the game so much as flickered.
   * A pose that is never registered and an event that is never heard are both
   * invisible to a unit test of the mechanic, so they are asserted on the
   * source. */
  const parkour = readSrcSync('src/player/Parkour.js');
  const emitted = new Set(
    [...parkour.matchAll(/emit\('(player:[a-z]+)'/g)].map((m) => m[1])
  );
  for (const e of ['player:leap', 'player:dive', 'player:roll', 'player:softland',
    'player:falldamage', 'player:hardland']) {
    /* `player:hardland` is NEW in this phase and belongs on this list for
     * exactly the reason the list exists. Left off it, commenting out its emit
     * kept every case in this file green while two live listeners -
     * `AudioDirector` and `VFX` - went permanently dead: the file written to
     * prevent the defect class reintroduced it in its own ratchet. */
    assert.ok(emitted.has(e), `${e} is no longer emitted by Parkour`);
  }

  const director = readSrcSync('src/audio/AudioDirector.js');
  for (const e of [...emitted]) {
    if (e === 'player:landed') continue;
    assert.ok(director.includes(`on('${e}'`),
      `${e} is emitted by Parkour and AudioDirector does not route it - this is exactly how `
      + 'the parkour set shipped silent in three worlds');
  }

  const sfx = readSrcSync('src/audio/Sfx.js');
  for (const recipe of ['leapGrunt', 'diveWind', 'rollThump', 'haystackWhump']) {
    assert.ok(sfx.includes(`  ${recipe}(`), `Sfx.${recipe} is gone; AudioDirector calls it`);
  }

  const vfx = readSrcSync('src/systems/VFX.js');
  assert.match(vfx, /on\('player:roll'/,
    'VFX no longer puffs dust on a roll. The pool it uses is the existing smoke pool - if '
    + 'this moved, check nothing built a second particle system for it.');
  assert.match(vfx, /groundPuff/, 'VFX.groundPuff is gone');
});

test('the pose is registered in the late pass, after the avatar has written every bone', () => {
  /* `PlayerAvatar.update()` rewrites all 26 bones every frame and runs after
   * the player in main.js's frame order, so a pose written from `update()` is
   * thrown away silently. This is the registration that makes it visible, and
   * its ORDER inside the pass is the blend priority. */
  const player = readSrcSync('src/player/Player.js');
  const pass = player.slice(player.indexOf('_installLatePose() {'));
  const body = pass.slice(0, pass.indexOf('\n  }'));
  const order = [...body.matchAll(/this\.(\w+)\??\.applyPose\??\.?\(/g)].map((m) => m[1]);
  assert.deepEqual(order, ['swim', 'parkour', 'freeClimb', 'climb', 'minigamePose'],
    'the late-pose order changed. It is blend priority, LATER WINS, so parkour sits BEFORE '
    + 'the two climbs: a leap or a dive that ends in a wall grab leaves its envelope decaying '
    + 'for up to half a second after FreeClimb has taken the body, and the wall is what the '
    + 'player is looking at. It shipped the other way round with a comment claiming this '
    + 'behaviour, which is how a head-first dive pose over a wall pose went unnoticed.');
});

test('the roll stance and the eye spring are both wired, and the KEY is not', () => {
  const src = readSrcSync('src/player/Player.js');
  assert.match(src, /setRollStance\(rollTuck, dt\)/,
    'the capsule no longer tucks for a roll; `parkour.rolling` is back to having no reader '
    + 'in the physics path');
  assert.match(src, /rolling \? Parkour\.ROLL_EYE/,
    'the eye spring no longer names the roll. It is a SEPARATE spring from the capsule, keyed '
    + 'off `_crouching`, so it has to be written explicitly or the camera stays up.');
  assert.match(src, /this\.parkour\.holdRollSpeed\(\)/, 'the momentum floor is not called');
  // The floor has to run after friction and the wish and before the integrate.
  const holdAt = src.indexOf('this.parkour.holdRollSpeed()');
  const moveAt = src.indexOf('this._move(dt);');
  const accelAt = src.indexOf('P.acceleration * boost, dt);');
  assert.ok(accelAt < holdAt && holdAt < moveAt,
    'the speed floor has moved out from between the accelerator and the integrate. Earlier and '
    + 'friction takes a sixth of it back inside the same step; later and the step just '
    + 'travelled was travelled at the wrong speed.');

  const input = readSrcSync('src/core/Input.js');
  const dodgeBind = /dodge|roll:/i.test(input.slice(input.indexOf('BINDABLE'), input.indexOf('BINDABLE') + 4000));
  assert.equal(dodgeBind, false,
    'a binding was added for the dodge. It is the sixth meaning of KeyC and is disambiguated '
    + 'by grounded-and-running; every key in this game is already spoken for.');
});

/* ------------------------------------------------------------------ */
/* 8. The ratchet                                                      */
/* ------------------------------------------------------------------ */

/**
 * The scripted run, shared by the hash and by the case that proves the hash is
 * about something. `[seconds, forward, sprint, crouch, jump]`.
 *
 * The two segments that look redundant are not. Segment 7 walks BEFORE the
 * crouch-walk in segment 8 because a crouch pressed at 8.2 m/s is a dodge by
 * definition - going straight from a sprint into the crouch-walk would fire a
 * third roll and the case below would be asserting the opposite of what it
 * says. And segment 4 runs the speed floor out before segment 5 dodges, so the
 * dodge starts from a sprint rather than from inside another roll.
 */
const TAPE = [
  [2.2, 1, true, false, false],   // run up to the lip
  [0.1, 1, true, false, true],    // leap off it
  [1.6, 1, true, true, false],    // dive the 12 m down, and roll on arrival
  [1.0, 1, true, false, false],   // ...and run the roll's speed floor out
  [0.1, 1, true, true, false],    // dodge, from a sprint
  [1.0, 1, true, false, false],   // out of the dodge and back to a sprint
  [1.0, 1, false, false, false],  // decay to a walk
  [1.0, 1, false, true, false],   // crouch-walk: must NOT dodge
  [0.5, 0, false, false, false],  // stop
];

/** FNV-1a, 8 hex characters. The same hash `SaveGame.js` and player-speed use. */
function fnv1a(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * A scripted run off a 12 m ledge and back along the flat, hashed step by step.
 *
 * Everything a parkour constant can touch is in the tape: a sprinting leap off
 * the lip, a dive held all the way down, a rolled landing, the speed floor
 * running out, a ground dodge from a sprint, and a crouch-walk that must NOT
 * dodge. Position, velocity, capsule height and health are all quantised to
 * 0.1 mm and hashed, so a run that ends in the same place having taken
 * different damage on the way still fails.
 *
 * Deliberately separate from `player-speed.test.mjs`'s tape, which is flat
 * ground and no parkour at all: that one ratchets the movement constants and
 * must not move when a roll is tuned, and this one is the opposite.
 */
function runHash() {
  const player = makePlayer(ledgeWorld(12));
  player._position.set(-20, 12.5, 0);
  for (let i = 0; i < 180; i++) player.fixedUpdate(DT, i * DT);
  unlimitedStamina(player);

  const s = player.input.state;
  const tape = TAPE;

  const parts = [];
  const q = (v) => Math.round(v * 1e4);
  let t = 3;
  for (const [secs, forward, sprint, crouch, jump] of tape) {
    s.forward = forward; s.sprint = sprint; s.crouch = crouch; s.jump = jump;
    for (let i = 0; i < Math.round(secs / DT); i++, t += DT) {
      player.fixedUpdate(DT, t);
      const p = player._position;
      const v = player._velocity;
      parts.push(
        `${q(p.x)},${q(p.y)},${q(p.z)},${q(v.x)},${q(v.y)},${q(v.z)},`
        + `${q(player.capsuleHeight)},${q(player.health)}`
      );
    }
  }
  return {
    hash: fnv1a(parts.join(';')),
    steps: parts.length,
    last: parts[parts.length - 1],
    verdict: player.parkour.lastLanding,
  };
}

test('THE RATCHET: a scripted leap-dive-roll-dodge run is bit-identical to the recorded tape', () => {
  const a = runHash();
  const b = runHash();
  assert.equal(a.hash, b.hash, 'the run is not deterministic; the hash cannot ratchet anything');
  assert.equal(a.steps, 510, 'the tape changed length - the recorded hash is about a different run');
  /* Recorded once, here, at the commit that wired the verbs up. If it fails,
   * nothing about this run is supposed to have changed: check LEAP_BOOST,
   * LEAP_LIFT, DIVE_ACCEL, DIVE_FORWARD, ROLL_TIME, ROLL_SPEED, ROLL_HEIGHT,
   * ROLL_ABSORB and LEAP_MIN_SPEED before accepting a new number. */
  assert.equal(a.hash, 'd340e819',
    `the parkour run changed. It ends at ${a.last} (x,y,z,vx,vy,vz,capsule,health in 0.1 mm `
    + `units) and its landing verdict was ${JSON.stringify(a.verdict)}.`);
});

test('the tape actually exercises the verbs it claims to', () => {
  /* Guards the hash above from decaying into a test of a jog: a ratchet over a
   * run that no longer leaps, dives, rolls or dodges would keep passing while
   * every constant it names went unmeasured. */
  const player = makePlayer(ledgeWorld(12));
  const log = [];
  player.bus.on('player:leap', (e) => log.push(['leap', e]));
  player.bus.on('player:dive', (e) => log.push([`dive:${e.state}`, e]));
  player.bus.on('player:roll', (e) => log.push([`roll:${e.kind}`, e]));

  player._position.set(-20, 12.5, 0);
  for (let i = 0; i < 180; i++) player.fixedUpdate(DT, i * DT);
  unlimitedStamina(player);
  const s = player.input.state;
  let t = 3;
  for (const [secs, forward, sprint, crouch, jump] of TAPE) {
    s.forward = forward; s.sprint = sprint; s.crouch = crouch; s.jump = jump;
    for (let i = 0; i < Math.round(secs / DT); i++, t += DT) player.fixedUpdate(DT, t);
  }
  const kinds = log.map((l) => l[0]);
  assert.ok(kinds.includes('leap'), 'the tape no longer leaps');
  assert.ok(kinds.includes('dive:start'), 'the tape no longer dives');
  assert.ok(kinds.includes('roll:land'), 'the tape no longer produces a landing roll');
  assert.ok(kinds.includes('roll:dodge'), 'the tape no longer produces a ground dodge');
  assert.equal(kinds.filter((k) => k.startsWith('roll:')).length, 2,
    `the tape produced ${kinds.filter((k) => k.startsWith('roll:')).length} rolls, not 2 - the `
    + 'crouch-walk segment at the end is dodging, which it must not');
});

/* ------------------------------------------------------------------ */
/* 9. Review findings - the holes the first pass left                  */
/*                                                                     */
/* Every case below was written against a defect that was reproduced   */
/* first, against the real `Player` on real `Physics`. Each one names  */
/* the number it measured before the fix.                              */
/* ------------------------------------------------------------------ */

test('the roll floor is PROPORTIONAL: a walk off a ledge comes out of the roll walking', () => {
  /* The floor was derived from the number `_onLand` had to hand, which is the
   * VERTICAL impact speed. Every rolled landing is hard enough to roll by
   * definition (impact > 9.9 m/s), so `min(impact * 1.12, cap)` always picked
   * the cap: measured, a player who walked off a 20 m ledge at 4.6 m/s was
   * accelerated to 9.184 m/s - twice their entry speed and 12% above the sprint
   * cap - free, for half a second. That is a set, not a floor. */
  const player = makePlayer(ledgeWorld(20));
  let t = cruise(player, { sprint: false, at: [-20, 20.5, 0], warm: 240 });
  const s = player.input.state;
  let fell = false;
  let landed = -1;
  let tapped = false;
  let entry = 0;
  let held = 0;
  for (let i = 0; i < 1200; i++, t += DT) {
    if (!player.grounded) fell = true;
    // One frame of crouch inside ROLL_WINDOW: enough to arm the roll, too
    // short for the dive to add any carry worth speaking of.
    if (fell && !tapped && !player.grounded && player.position.y < 1.6) {
      s.crouch = true;
      tapped = true;
    } else {
      s.crouch = false;
    }
    if (!player.grounded) entry = planar(player);
    player.fixedUpdate(DT, t);
    if (fell && landed < 0 && player.grounded) landed = i;
    if (landed >= 0 && i - landed === 18) { held = planar(player); break; }
  }
  assert.equal(player.parkour.rollKind, 'land', 'the drop did not produce a landing roll');
  assert.ok(Math.abs(entry - 4.725) < 0.01,
    `the fall arrived carrying ${entry.toFixed(4)} m/s of PLANAR speed, not the 4.725 this case `
    + 'is written around - the walk-up changed and the numbers below are about something else');
  assert.ok(Math.abs(held - entry * 1.12) < 1e-3,
    `the roll held ${held.toFixed(4)} m/s against the ${(entry * 1.12).toFixed(4)} that its own `
    + 'entry speed times ROLL_SPEED buys. A floor returns what it was given.');
  assert.ok(held < Parkour.ROLL_FLOOR_MAX - 3,
    `the roll held ${held.toFixed(4)} m/s, which is the ROLL_FLOOR_MAX ceiling of `
    + `${Parkour.ROLL_FLOOR_MAX.toFixed(4)} rather than anything to do with how fast this `
    + 'player was going. That is the impact speed leaking back into the planar floor.');
  assert.ok(held < P.sprintSpeed,
    'a walking player came out of a landing roll faster than a flat-out sprint');
});

test('a roll that ends under a low ceiling settles there instead of bouncing', () => {
  /* The roll makes 0.735 m reachable, so a player can now be somewhere a
   * 1.015 m crouch does not fit. Damping toward CROUCH_HEIGHT there hands
   * `resolveCapsule` an impossible body: measured under a 12 m wide beam at a
   * 0.9 m gap, the feet were ejected from y = 0.0 to y = 0.9 and dropped back
   * about twenty times a second, capsule 1.198-1.327, `_crouching` flickering,
   * for as long as the player stayed underneath. The pass-under case above
   * cannot see it, because it breaks at x > 20 - it only ever measures a player
   * who gets clean through. */
  const player = makePlayer(beamWorld(0.9, 12));
  let t = cruise(player, { sprint: true, at: [0, 0.5, 0], warm: 60 });
  const s = player.input.state;
  let dodged = false;
  let worstY = 0;
  let worstH = 0;
  for (let i = 0; i < 400; i++, t += DT) {
    if (!dodged && player.position.x > 8) { s.crouch = true; dodged = true; }
    else s.crouch = false;
    player.fixedUpdate(DT, t);
    player.update(DT, t);
    // Sample only after the roll has expired and while still under the beam.
    if (dodged && !player.parkour.rolling && player.position.x < 21) {
      worstY = Math.max(worstY, Math.abs(player.position.y));
      worstH = Math.max(worstH, player.capsuleHeight);
    }
  }
  assert.ok(dodged && player.position.x > 12,
    `the dodge never got under the beam (x = ${player.position.x.toFixed(2)})`);
  assert.ok(worstY < 0.05,
    `after the roll expired under the beam the feet moved ${worstY.toFixed(3)} m vertically. `
    + 'Measured at 0.7 m before the stance had a third target: the solver was ejecting the '
    + 'capsule into the beam and gravity was dropping it back, indefinitely.');
  assert.ok(worstH < Parkour.ROLL_HEIGHT + 0.02,
    `the capsule grew to ${worstH.toFixed(3)} m under a 0.9 m beam - a 1.015 m crouch does not `
    + 'fit there, and damping toward one is what caused the bounce');
});

test('the dodge cannot be spammed into permanent invulnerability', () => {
  /* MEASURED BEFORE THE COOLDOWN: crouch tapped the instant each roll expired
   * gave 52 rolls and 70.9% i-frame uptime over thirty seconds at a mean
   * 8.65 m/s, on a full stamina bar that never moved, sustainable for as long
   * as the player held forward. A running character who cannot be hit for seven
   * tenths of the time is not dodging, it is switched off. */
  const player = makePlayer(flatWorld());
  let t = cruise(player, { sprint: true, warm: 240 });
  const s = player.input.state;
  const pk = player.parkour;
  let rolls = 0;
  let invuln = 0;
  const frames = 1800;
  player.bus.on('player:roll', () => { rolls++; });
  for (let i = 0; i < frames; i++, t += DT) {
    // A perfect tap: crouch goes down on exactly the frame both gates open.
    s.crouch = pk.rollTime <= 0 && pk._dodgeReady <= 0;
    player.fixedUpdate(DT, t);
    player.update(DT, t);
    if (player.isInvulnerable) invuln++;
  }
  const uptime = invuln / frames;
  const ceiling = 0.40 / (Parkour.ROLL_TIME + Parkour.DODGE_COOLDOWN);
  assert.ok(rolls > 8, `only ${rolls} rolls in thirty seconds - the dodge has stopped working`);
  assert.ok(uptime < 0.30,
    `optimal crouch-tapping bought ${(uptime * 100).toFixed(1)}% invulnerability uptime. It was `
    + `70.9% before DODGE_COOLDOWN existed, and the ceiling is ROLL_IFRAMES / (ROLL_TIME + `
    + `DODGE_COOLDOWN) = ${(ceiling * 100).toFixed(1)}%.`);
  assert.ok(uptime > 0.10,
    `${(uptime * 100).toFixed(1)}% uptime - the cooldown has grown long enough that the dodge no `
    + 'longer dodges anything');
});

test('i-frames do not announce themselves as a buff', () => {
  /* `grantShield` emits `player:buffed {kind:"shield"}`, which is a PICKUP
   * announcement with a HUD icon behind it. Routed through it, the dodge put a
   * 1.7 Hz emitter on that event - 52 of them in the thirty seconds above. The
   * design forbade this for the right reason, even though the reason it gave
   * (a flashing icon) has no listener to flash yet. */
  const player = makePlayer(flatWorld());
  const buffs = [];
  player.bus.on('player:buffed', (e) => buffs.push(e));
  cruise(player, { sprint: true });
  let t = 5;
  player.input.state.crouch = true;
  player.fixedUpdate(DT, (t += DT));
  assert.equal(player.parkour.rollKind, 'dodge');
  assert.equal(player.isInvulnerable, true, 'the dodge granted no i-frames');
  assert.equal(buffs.length, 0,
    `a dodge roll raised ${buffs.length} player:buffed events. It is a movement, not a pickup.`);

  // ...and the real thing still announces itself, and is still not shortened.
  player.grantShield(5);
  assert.equal(buffs.length, 1, 'grantShield stopped announcing the buff');
  assert.equal(buffs[0].kind, 'shield');
  const long = player._invulnUntil;
  player.grantIFrames(0.01);
  assert.equal(player._invulnUntil, long, 'a brief roll shortened a real shield');
});

test('a dodge is refused while another controller owns the body', () => {
  /* The only thing stopping a crouch tap while swimming, mantling, clinging or
   * mounted from tucking the capsule and installing a speed floor underneath a
   * controller that already writes it. Replacing the whole conjunction with
   * `true` changed nothing anywhere else in this file. */
  for (const owner of ['isSwimming', 'isClimbing', 'isFreeClimbing', 'movementOverride']) {
    const player = makePlayer(flatWorld());
    cruise(player, { sprint: true });
    Object.defineProperty(player, owner, { get: () => true, configurable: true });
    const pk = player.parkour;
    player.input.state.crouch = true;
    /* Called directly. `Player.fixedUpdate` returns before
     * `parkour.fixedUpdate` for three of these four, so driving the player
     * would prove the early return works and nothing about the guard. */
    pk.fixedUpdate(DT);
    assert.equal(pk.rolling, false,
      `a crouch tap dodge-rolled while ${owner} was true, underneath a controller that is `
      + 'already writing the capsule itself');
  }
});

test('player:dive ends when the dive does - including the way dives normally end', () => {
  /* `_onLand` cleared `this.diving` silently, and `_onLand` runs from `_move`
   * at the END of `Player.fixedUpdate` - after `parkour.fixedUpdate` has
   * already taken its turn - so the branch that emits the end could never see
   * the flag again. Measured: three dives that finished on the ground produced
   * three `dive:start` and zero `dive:end`. */
  const player = makePlayer(ledgeWorld(20));
  const states = [];
  player.bus.on('player:dive', (e) => states.push(e.state));
  let t = cruise(player, { sprint: true, at: [-30, 20.5, 0], warm: 200 });
  const s = player.input.state;
  for (let i = 0; i < 400; i++, t += DT) {
    if (!player.grounded) s.crouch = true;
    player.fixedUpdate(DT, t);
    if (states.length >= 2) break;
  }
  assert.deepEqual(states, ['start', 'end'],
    `a dive that ended on the ground raised ${JSON.stringify(states)}. An event with a state `
    + 'and no end is the emitted-into-nothing defect this file exists to close.');
  assert.equal(player.parkour.diving, false);
});

test('the dive exit is the negation of the dive entry, so it cannot latch', () => {
  /* The exit used to read `grounded || !s.crouch`, which is not the opposite of
   * the entry. Airborne, crouch held and `vy >= -DIVE_MIN_FALL` satisfied
   * neither branch: measured, an upward impulse taken at full dive weight left
   * `diving` true and `_diveW` pinned at 1.0000 - a head-first pose and 19.5
   * degrees of camera pitch-down - for the whole of a four-second ASCENT. */
  const player = makePlayer(ledgeWorld(300));
  let t = cruise(player, { sprint: true, at: [-30, 300.5, 0], warm: 200 });
  const s = player.input.state;
  let bumpAt = -1;
  for (let i = 0; i < 400; i++, t += DT) {
    if (!player.grounded) s.crouch = true;
    if (bumpAt < 0 && player.parkour.diveWeight > 0.95) {
      bumpAt = i;
      player.applyImpulse(new THREE.Vector3(0, 60, 0));
    }
    player.fixedUpdate(DT, t);
    player.update(DT, t);
    // Half a second later: still rising, and `_diveW` has had time to decay.
    if (bumpAt >= 0 && i - bumpAt > 30) break;
  }
  const bumped = bumpAt >= 0;
  assert.equal(bumped, true, 'the dive never reached full weight, so nothing was tested');
  assert.ok(player.velocity.y > 0, 'the player is not travelling upwards; the case is moot');
  assert.equal(player.parkour.diving, false,
    'the dive is still running while the player is travelling upwards with crouch held');
  assert.ok(player.parkour.diveWeight < 0.05,
    `the dive blend is still ${player.parkour.diveWeight.toFixed(4)} on the way up`);
  assert.ok(Math.abs(player._posePitch) < 0.02,
    `the camera is still pitched ${player._posePitch.toFixed(3)} rad down while rising`);
});

test('a world that forbids parkour gets no roll, and nothing latches', () => {
  /* `_onLand` is a bus subscription: it is the one parkour touchpoint that does
   * not arrive through `Player.fixedUpdate`, so it is the one that has to ask
   * `allows` for itself. Measured in a world with `rules.parkour === false`
   * (MazeWorld sets exactly that): a 14 m drop with crouch held started a roll
   * that nothing then ticked down, so `rolling` read true and `rollTime` was
   * still 0.55 ten seconds later, and for the rest of the session. */
  const player = makePlayer(ledgeWorld(14));
  const world = { rules: { parkour: false } };
  player.bus.emit('world:changed', { world });
  player.parkour.worldManager = { active: world };
  const seen = [];
  player.bus.on('player:roll', (e) => seen.push(e));
  let t = cruise(player, { at: [-20, 14.5, 0], warm: 260 });
  const s = player.input.state;
  let fell = false;
  let landed = -1;
  for (let i = 0; i < 1400; i++, t += DT) {
    if (!player.grounded) { fell = true; s.crouch = true; }
    player.fixedUpdate(DT, t);
    if (fell && landed < 0 && player.grounded) landed = i;
    if (landed >= 0 && i - landed > 400) break;
  }
  assert.ok(landed > 0, 'the player never landed');
  assert.equal(seen.length, 0, 'a world with parkour switched off still rolled');
  assert.equal(player.parkour.rolling, false,
    '`rolling` latched true in a world that forbids the verb - nothing ticks `rollTime` there');
  assert.ok(player.parkour.lastLanding.damage > 0,
    'fall damage is not a parkour verb, and must still apply where the verbs are off');
});

test('death, a mount and a mantle all cancel the roll rather than freezing it', () => {
  /* Three early returns in `Player.fixedUpdate` sit ABOVE `parkour.fixedUpdate`
   * and none of them cancelled it, while `update()` and the late-pose pass kept
   * reading the frozen state every frame. Measured: killed 0.45 s into a dodge,
   * the corpse held `humanoid.rig` at 0.54 rad and 0.36 m off its own feet with
   * 4 degrees of bank on the death camera for the full 3.2 s respawn delay;
   * mounted inside a dodge, the eye stayed pinned at ROLL_EYE - the
   * third-person boom pivot, 1.07 m below the rider - for the whole ride. */
  const dodge = () => {
    const player = makePlayer(flatWorld());
    const humanoid = stubHumanoid();
    player.avatar = { humanoid };
    let t = cruise(player, { sprint: true });
    player.input.state.crouch = true;
    player.fixedUpdate(DT, (t += DT));
    player.input.state.crouch = false;
    assert.equal(player.parkour.rollKind, 'dodge');
    return { player, humanoid, t };
  };

  // 1. death
  {
    const { player, humanoid, t: t0 } = dodge();
    let t = t0;
    // Past ROLL_IFRAMES (0.40 s = 24 steps) and still inside ROLL_TIME (0.55):
    // the window that is exactly "rolled into a fireball".
    for (let i = 0; i < 28; i++, t += DT) {
      player.fixedUpdate(DT, t);
      player.update(DT, t);
      player.parkour.applyPose(DT, t);
    }
    player.applyDamage(999, null, 'test');
    assert.equal(player.isDead, true);
    for (let i = 0; i < 120; i++, t += DT) {
      player.fixedUpdate(DT, t);
      player.update(DT, t);
      player.parkour.applyPose(DT, t);
    }
    assert.equal(player.parkour.rolling, false, 'the corpse is still rolling');
    assert.equal(humanoid.rig.position.y, 0,
      `the corpse is floating ${humanoid.rig.position.y.toFixed(3)} m off its own feet`);
    assert.ok(Math.abs(player._poseRoll) < 1e-6,
      `${player._poseRoll.toFixed(4)} rad of roll bank is still on the death camera`);
  }

  // 2. a mount
  {
    const { player, t: t0 } = dodge();
    let t = t0;
    player.bus.emit('mount:mounted', {});
    player.movementOverride = true;
    for (let i = 0; i < 600; i++, t += DT) {
      player.fixedUpdate(DT, t);
      player.update(DT, t);
    }
    assert.equal(player.parkour.rolling, false, 'the roll clock froze for the length of a ride');
    assert.ok(Math.abs(player.eyeHeight - P.eyeHeight) < 0.02,
      `the rider's eye is at ${player.eyeHeight.toFixed(4)} m, not ${P.eyeHeight}. CameraRig `
      + 'uses it as the third-person boom pivot.');
  }

  // 3. a mantle
  {
    const { player, t: t0 } = dodge();
    let t = t0;
    player.climb._active = true;
    player.climb.fixedUpdate = () => {};
    for (let i = 0; i < 60; i++, t += DT) {
      player.fixedUpdate(DT, t);
      player.update(DT, t);
    }
    assert.equal(player.parkour.rolling, false,
      'a mantle started inside a roll freezes the roll for the length of the hoist');
  }
});

test('cancel hands the rig back, because applyPose will not get the chance', () => {
  /* `cancel` zeroes every weight, so the next `applyPose` takes its early-out
   * before it reaches the release - and a body left rotated by up to 2pi and
   * lifted 1.24 m would stay that way. */
  const player = makePlayer(flatWorld());
  const humanoid = stubHumanoid();
  player.avatar = { humanoid };
  const pk = player.parkour;
  pk.rollTime = Parkour.ROLL_TIME * 0.5;
  pk.applyPose(DT, 1);
  assert.ok(humanoid.rig.position.y > 1, 'the roll never took the rig');
  pk.cancel();
  assert.equal(humanoid.rig.position.y, 0, 'cancel left the body lifted off its own feet');
  assert.ok(humanoid.rig.quaternion.angleTo(new THREE.Quaternion()) < 1e-9,
    'cancel left the body rotated');
});

test('the rig is not TAKEN while Swim owns it either, not only handed back', () => {
  /* The release half of the handover was covered and the take half was not:
   * dropping the `swimWeight < SWIM_RIG_EPS` term from the take kept every case
   * in this file green, while a roll snapped a swimmer's prone body upright
   * mid-stroke - the exact hazard the rule in `MinigamePose` exists for. */
  const player = makePlayer(flatWorld());
  const humanoid = stubHumanoid();
  player.avatar = { humanoid };
  player.swim._poseWeight = 1;
  humanoid.rig.position.y = 0.5;
  humanoid.rig.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.2);
  const before = humanoid.rig.quaternion.clone();

  player.parkour.rollTime = Parkour.ROLL_TIME * 0.5;
  player.parkour.applyPose(DT, 1);
  assert.equal(humanoid.rig.position.y, 0.5,
    'a roll took the rig out from under a swimmer who is still writing it every frame');
  assert.ok(humanoid.rig.quaternion.angleTo(before) < 1e-9,
    'a roll rotated the rig while the swim pose still owned it');
});

test('the leap and the dive pose the body absolutely, exactly as the roll does', () => {
  /* The roll pose was pinned and the other two were not: deleting the entire
   * leap block, or the entire dive block, kept the whole file green. Same
   * mechanism and same proof - pre-rotate the bones to what an additive air
   * pose leaves behind, and check the slerp lands on its absolute target. */
  const junk = eulerQ(0.9, -0.4, 0.25);
  const seed = (humanoid) => {
    for (const name of ['thighR', 'upperArmL', 'head']) {
      humanoid.bones.get(name).quaternion.copy(junk);
    }
  };

  // --- the leap, sampled at the midpoint where the envelope is exactly 1 ---
  {
    const player = makePlayer(flatWorld());
    const humanoid = stubHumanoid();
    player.avatar = { humanoid };
    seed(humanoid);
    /* leapT = 0.5, so `sin(pi t) ** 0.65` is exactly 1. LEAP_WINDUP is 0.30, so
     * the drive term is `(0.5 - 0.30) / (1 - 0.30)` = 2/7 of the way through
     * the follow-through. */
    player.parkour._leapT = 0.55 * 0.5;
    player.parkour.applyPose(DT, 1);
    const drive = 2 / 7;
    const want = {
      thighR: eulerQ(0.20 + 1.05 * drive, 0, 0.05),
      upperArmL: eulerQ(-0.70 + 1.95 * drive, 0, -0.26),
      head: eulerQ(-0.14 + 0.08 * drive, 0, 0),
    };
    for (const [name, q] of Object.entries(want)) {
      const got = humanoid.bones.get(name).quaternion;
      assert.ok(got.angleTo(q) < 1e-6,
        `the LEAP pose left ${name} ${got.angleTo(q).toFixed(6)} rad from its absolute target. `
        + 'Deleting the leap block outright used to keep this whole file green.');
    }
    assert.equal(humanoid.rig.position.y, 0,
      'the leap took the rig; only the roll and the dive may');
  }

  // --- the dive, at full blend ---
  {
    const player = makePlayer(flatWorld());
    const humanoid = stubHumanoid();
    player.avatar = { humanoid };
    seed(humanoid);
    player.parkour._diveW = 1;
    player.parkour.applyPose(DT, 1);
    const want = {
      thighR: eulerQ(-0.24, 0, 0.10),
      upperArmL: eulerQ(-0.92, 0, -0.34),
      head: eulerQ(-0.30, 0, 0),
    };
    for (const [name, q] of Object.entries(want)) {
      const got = humanoid.bones.get(name).quaternion;
      assert.ok(got.angleTo(q) < 1e-6,
        `the DIVE pose left ${name} ${got.angleTo(q).toFixed(6)} rad from its absolute target`);
    }
    /* The dive folds on the rig, and its lift is `sin` and not `1 - cos`: it is
     * a fold and never goes over the top, so the two curves are not
     * interchangeable. */
    assert.ok(Math.abs(humanoid.rig.position.y - Math.sin(1.18) * 0.62) < 1e-9,
      `the dive lifted the rig ${humanoid.rig.position.y.toFixed(4)} m; the pivot is at the `
      + 'feet, so a fold with no lift buries the chest in the floor');
  }
});

test('the camera reads the roll and the leap: a bank, a dip and an FOV punch', () => {
  /* Three quarters of the design's camera brief had no assertion at all:
   * `ROLL_VIEW_BANK = 0`, deleting `punchFov(4.5)` and deleting
   * `addViewDip(-0.55)` were each invisible to every case in this file, and
   * `punchFov`/`addViewDip` are two new public methods on `Player`. */
  const player = makePlayer(flatWorld());
  let t = cruise(player, { sprint: true });

  // --- the dodge: a dip on the frame it starts, and a bank that peaks mid-roll
  const dipBefore = player._dipVel;
  player.input.state.crouch = true;
  player.fixedUpdate(DT, (t += DT));
  player.input.state.crouch = false;
  assert.ok(player._dipVel < dipBefore - 0.5,
    `the roll nudged the dip spring by ${(player._dipVel - dipBefore).toFixed(3)}; it asks for `
    + '-0.55, and a roll the camera does not acknowledge is an animation');
  let peakBank = 0;
  let peakDip = 0;
  for (let i = 0; i < 40; i++, t += DT) {
    player.fixedUpdate(DT, t);
    player.update(DT, t);
    peakBank = Math.max(peakBank, Math.abs(player._poseRoll));
    peakDip = Math.min(peakDip, player.viewDip);
  }
  assert.ok(peakBank > 0.12 && peakBank < 0.14,
    `the roll banked the camera ${peakBank.toFixed(4)} rad against the 0.13 ROLL_VIEW_BANK asks `
    + 'for. Setting that constant to zero used to change nothing measurable.');
  /* -0.0192 m measured. The dip spring is stiff (k = 150, c = 17) and clamped
   * at -0.42 because motion sickness is a failure state, so a -0.55 m/s impulse
   * buys about two centimetres of travel. The impulse itself is asserted above;
   * this is the proof that it reaches the camera. */
  assert.ok(peakDip < -0.015, `the view never dipped for the roll (${peakDip.toFixed(4)} m)`);
  // ...and the bank is gone by the end of the roll, not left on the camera.
  for (let i = 0; i < 60; i++, t += DT) { player.fixedUpdate(DT, t); player.update(DT, t); }
  assert.equal(player._poseRoll, 0, 'the roll left a permanent bank on the camera');

  // --- the leap: an additive FOV punch on top of the sprint kick
  assert.equal(player._fovPunch, 0);
  player.input.state.jump = true;
  player.fixedUpdate(DT, (t += DT));
  assert.ok(player._fovPunch > 4,
    `a leap punched the FOV by ${player._fovPunch.toFixed(2)} degrees, not the 4.5 it asks for`);
  // punchFov takes the larger rather than summing, so a chain of leaps off a
  // rooftop reads as one wide frame instead of ratcheting the lens open.
  player.punchFov(1);
  assert.ok(player._fovPunch > 4, 'punchFov let a smaller punch shrink a larger one');
  player.punchFov(9);
  assert.equal(player._fovPunch, 9, 'punchFov ignored a larger punch');
  assert.equal(player.punchFov(-1), false, 'punchFov accepted a negative');
  assert.equal(player.addViewDip(NaN), false, 'addViewDip accepted a NaN');
});

test('AudioDirector really calls the four recipes, and not just the strings', async () => {
  /* The whole audio half of this phase was grep-only. A misspelled method name
   * in the handler - `this.sfx.rollThumpXX(...)` - kept every case green,
   * because `EventBus.emit` catches handler throws: a silent console.error and
   * a permanently dead cue, which is exactly the class the ratchet exists to
   * close. The repo already clears this bar - `race-pace.test.mjs` calls
   * `AudioDirector.prototype.update.call({...})`. */
  const { AudioDirector } = await import('../../src/audio/AudioDirector.js');
  const calls = [];
  const sfx = new Proxy({}, {
    get: (_, name) => (...args) => calls.push([String(name), ...args]),
  });
  const bus = new EventBus();
  AudioDirector.prototype._bind.call({ bus, sfx, _offs: [], engine: { ready: false } });
  const named = () => calls.map((c) => c[0]);

  bus.emit('player:leap', { position: null, speed: 12 });
  assert.ok(named().includes('leapGrunt'), 'player:leap plays nothing');

  calls.length = 0;
  bus.emit('player:dive', { state: 'start', speed: 20, position: null });
  assert.deepEqual(named(), ['diveWind'], 'the dive start plays no wind');
  calls.length = 0;
  bus.emit('player:dive', { state: 'end', position: null });
  assert.deepEqual(named(), [],
    'the dive END played a cue. It is the state going away, not a second whoosh.');

  calls.length = 0;
  bus.emit('player:roll', { kind: 'land', speed: 30, material: 'wood', position: null });
  assert.deepEqual(named(), ['rollThump'], 'player:roll plays nothing');
  assert.equal(calls[0][2], 'wood',
    `the roll thumped on '${calls[0][2]}'. Neither the roll nor the hard landing carried a `
    + '`material` at first, so `surfaceOf(undefined)` returned concrete every time and the '
    + 'whole per-surface table in `Sfx.rollThump` was unreachable.');
  assert.ok(calls[0][3].hard > 0.9, 'a 30 m/s landing roll is not being played as a hard one');

  calls.length = 0;
  bus.emit('player:roll', { kind: 'dodge', speed: 8, material: 'dirt', position: null });
  assert.ok(calls[0][3].hard < 0.5, 'a flat dodge is being played as a fall');

  calls.length = 0;
  bus.emit('player:softland', { kind: 'hay', speed: 30, position: null });
  assert.deepEqual(named(), ['haystackWhump'], 'a haystack landing plays nothing');

  calls.length = 0;
  bus.emit('player:falldamage', { speed: 30, damage: 40, material: 'stone', position: null });
  assert.deepEqual(named(), ['impact'], 'fall damage plays nothing');
  assert.equal(calls[0][2], 'flesh', 'a fall that hurt is a body impact');

  calls.length = 0;
  bus.emit('player:hardland', { speed: 12, material: 'metal', position: null });
  assert.deepEqual(named(), ['impact'], 'a hard but harmless arrival plays nothing');
  assert.equal(calls[0][2], 'metal', 'the hard landing ignored the surface it landed on');
});

test('VFX really puffs, and a rolled landing puffs once and not twice', async () => {
  /* `_onLand` raises `player:roll` and then exactly one of `player:hardland` /
   * `player:falldamage` for the SAME touchdown, so subscribing to all three
   * spent two bursts of the shared 288-quad pool on one event - measured, dust
   * at intensity 1 followed by dust at 1.35 plus clods. Reducing `groundPuff`
   * to `return;` outright also used to keep this file green. */
  const { VFX } = await import('../../src/systems/VFX.js');
  const puffs = [];
  const stub = { _offs: [], groundPuff: (pt, i) => puffs.push(i) };
  const bus = new EventBus();
  VFX.prototype._bindBus.call(stub, bus);

  bus.emit('player:roll', { kind: 'dodge', position: { x: 0, y: 0, z: 0 } });
  assert.equal(puffs.length, 1, 'a ground dodge kicks up no dust');

  puffs.length = 0;
  bus.emit('player:roll', { kind: 'land', position: { x: 0, y: 0, z: 0 } });
  bus.emit('player:falldamage', { speed: 30, damage: 40, position: { x: 0, y: 0, z: 0 } });
  assert.equal(puffs.length, 1,
    `a rolled landing that hurt raised ${puffs.length} puffs for one touchdown`);
  assert.ok(puffs[0] > 1, 'the arrival, not the roll, should own the dust on a landing');

  puffs.length = 0;
  bus.emit('player:roll', { kind: 'land', position: { x: 0, y: 0, z: 0 } });
  bus.emit('player:hardland', { speed: 12, position: { x: 0, y: 0, z: 0 } });
  assert.equal(puffs.length, 1, 'a rolled hard landing raised two puffs for one touchdown');
});

test('the landing surface reaches the cues that claim to vary by it', () => {
  /* `player:landed` never carried a `material`, so `AudioDirector`'s handler -
   * which has always read `e.material` - fell through to 'concrete' on every
   * landing in the game, and `Parkour` then passed the same nothing on to the
   * roll and hard-land cues. A per-surface table nothing can reach reads like
   * working variation. */
  const physics = ledgeWorld(20);
  for (const c of physics.colliders) c.userData = { material: 'wood' };
  const player = makePlayer(physics);
  const seen = new Map();
  for (const type of ['player:landed', 'player:roll', 'player:hardland', 'player:falldamage']) {
    player.bus.on(type, (e) => { if (!seen.has(type)) seen.set(type, e.material); });
  }
  let t = cruise(player, { sprint: true, at: [-30, 20.5, 0], warm: 200 });
  const s = player.input.state;
  let fell = false;
  for (let i = 0; i < 600; i++, t += DT) {
    if (!player.grounded) { fell = true; s.crouch = true; }
    player.fixedUpdate(DT, t);
    if (fell && player.grounded && seen.has('player:landed')) break;
  }

  assert.equal(seen.get('player:landed'), 'wood',
    `player:landed reported ${JSON.stringify(seen.get('player:landed'))} on a wooden deck`);
  assert.equal(seen.get('player:roll'), 'wood', 'the roll cue lost the surface it rolled on');
  const arrival = seen.has('player:falldamage') ? 'player:falldamage' : 'player:hardland';
  assert.equal(seen.get(arrival), 'wood', `${arrival} lost the surface it arrived on`);
});

test('foot IK is off during a roll, so the pelvis is not dragged toward the ground', () => {
  /* A roll is the only full-body pose in the codebase that is GROUNDED and
   * raises no `movementOverride`, so it satisfied neither of the two terms that
   * turn IK off for every other one. `Parkour.applyPose` writes quaternions
   * only, and `NPCAnimator._poseLegs` writes `pelvis.position.y` - a position
   * is not overwritten by a pose that does not write positions, so the pelvis
   * was being dropped toward ground the body is mid-somersault above, worst on
   * exactly the stepped rooftops the landing roll is authored for. */
  const src = readSrcSync('src/player/PlayerAvatar.js');
  assert.match(src, /ik: this\._airWeight < 0\.3 && !p\.movementOverride && !p\.parkour\?\.rolling/,
    'the IK gate no longer names the roll');
});

test('a hop on a haystack is not a soft landing, and the whump is throttled', () => {
  /* `_softLandingAt` classifies by POSITION with no speed term, and
   * `player:landed` fires on any arrival at more than 3.0 m/s - a plain
   * standing jump lands at 6.07. So every hop taken while standing on thatch
   * used to fire a 41-node `haystackWhump` (against 5-11 for its three
   * siblings, and the only one of the four with no throttle) plus an
   * unthrottled "Soft landing" toast. The citadel puts one under every
   * viewpoint. */
  const sfx = readSrcSync('src/audio/Sfx.js');
  const whump = sfx.slice(sfx.indexOf('  haystackWhump(at) {'));
  assert.match(whump.slice(0, 500), /_throttled\('hay'/,
    'haystackWhump is unthrottled again - 41 WebAudio nodes and a 0.8 s voice hold per call');

  const player = makePlayer(flatWorld());
  player.parkour.worldManager = { active: { haystacks: [{ x: 0, y: 0, z: 0, r: 4 }] } };
  const notes = [];
  player.bus.on('player:softland', (e) => notes.push(e));
  player._position.set(0, 0.5, 0);
  for (let i = 0; i < 60; i++) player.fixedUpdate(DT, i * DT);
  // A standing hop: 6.07 m/s on arrival, which is a footstep and not a rescue.
  let t = 1;
  player.input.state.jump = true;
  for (let i = 0; i < 3; i++, t += DT) player.fixedUpdate(DT, t);
  player.input.state.jump = false;
  for (let i = 0; i < 90; i++, t += DT) player.fixedUpdate(DT, t);
  assert.equal(notes.length, 0,
    `hopping on the spot on a haystack raised ${notes.length} "Soft landing" cues`);

  // ...and a real fall into it still is one.
  player.parkour._peakFall = 0;
  player.bus.emit('player:landed', { speed: 30, position: player.position });
  assert.equal(notes.length, 1, 'a 30 m/s fall into a haystack is no longer a soft landing');
});
