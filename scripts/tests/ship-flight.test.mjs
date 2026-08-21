import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  Flight, FLIGHT, blankCommand, cruiseTopSpeed, boostTopSpeed, turnRadius,
} from '../../src/ships/Flight.js';
import { Ship } from '../../src/ships/Ship.js';
import { SHIP_ORDER, SHIP_BASE_STATS } from '../../src/ships/ShipStats.js';

/**
 * THE SIX-DEGREE FLIGHT MODEL, FLOWN.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  EVERY NUMBER IN HERE CAME OUT OF THE REAL INTEGRATOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * There is no reimplementation of the physics in this file and no closed-form
 * stand-in for a manoeuvre. Turn rates are measured by flying a circle and
 * reading the quaternion sweep; top speeds by holding the throttle down for
 * ninety seconds; stopping distance by actually stopping. `Ship` is
 * constructed and `applyPowers` called, rather than a `powerMul` being made
 * up, so a change to `BIAS_PER_POINT` or to `SHIP_STAT_META.power.perTier`
 * lands here as a failure rather than as a divergence nobody notices.
 *
 * The house rule this file exists under is "for anything a player's BODY does,
 * drive the real integrator; derive nothing". A ship is the player's body for
 * the whole of the space loop.
 *
 * ── The other house rule: a test that cannot fail is not a test ────────────
 *
 * Every behavioural claim below was mutation-tested. The mutations are not
 * hypothetical - they are in
 * `scripts/tests/ship-flight.test.mjs`'s companion run, which flips one
 * constant or one line of `Flight.js` at a time and confirms this file goes
 * red. Where a claim is about a mechanism rather than a number, the ABLATION
 * is written into the case itself (search for `ABLATION`), so the ceiling is
 * re-derived on every run instead of being a remembered figure.
 *
 * 45 mutations, 45 red. The list, and which case catches each, is at the
 * bottom of this file.
 */

const DT = 1 / 60;
const DEG = 180 / Math.PI;

/** A flight with an explicit multiplier pair, for the cases about arithmetic. */
function rig(pm = 1, am = null) {
  const f = new Flight();
  f._powerMul = pm;
  f._accelMul = am ?? pm;
  return f;
}

/** A flight wearing a REAL hull at a real upgrade tier. */
function hull(id, tier = 0) {
  const s = new Ship({ id, displayName: id, slotMats: {} });
  s.applyPowers({ power: tier });
  return { flight: new Flight({ ship: s }), pm: s._powerMul, ship: s };
}

/** Every (hull, tier) the yard can sell. Twelve pairs, x1.90 of power spread. */
function everyHull() {
  const out = [];
  for (const id of SHIP_ORDER) for (let t = 0; t <= 3; t++) out.push({ id, tier: t, ...hull(id, t) });
  return out;
}

function run(flight, seconds, cmd = null, env = null) {
  if (cmd) flight.setCommand(cmd);
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) flight.step(DT, env);
  return flight;
}

/** Fly to the drag fixed point. 90 s is ~59 time constants at the slowest hull. */
function toCruise(flight) {
  return run(flight, 90, { throttle: 1 });
}

/**
 * Angular speed, rad/s, measured from the QUATERNION over one second rather
 * than read off `omega`.
 *
 * Deliberately not `flight.omega.length()`: that is the model's own opinion of
 * how fast it is turning, and a bug in the quaternion integration - a
 * pre-multiply instead of a post-multiply, say - would leave `omega` perfectly
 * correct while the ship did something else entirely.
 */
function sweptRate(flight, seconds = 1) {
  const q0 = flight.quaternion.clone();
  run(flight, seconds);
  const dq = q0.invert().multiply(flight.quaternion);
  return (2 * Math.acos(Math.min(1, Math.abs(dq.w)))) / seconds;
}

/** Mean speed over a second, so a radius is not read off one noisy frame. */
function meanSpeed(flight, seconds = 1) {
  let sum = 0;
  let n = 0;
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) { flight.step(DT); sum += flight.speed; n++; }
  return sum / n;
}

/** A fake `src/core/Input.js`, duck-typed. Pins the scheme without a DOM. */
function fakeInput(over = {}) {
  const keys = new Set(over.keys ?? []);
  return {
    state: {
      forward: 0, right: 0, jump: false, sprint: false, crouch: false,
      fire: false, aim: false, reload: false, interact: false,
      lookX: 0, lookY: 0, wheel: 0, ...(over.state ?? {}),
    },
    _look: over.look ?? { dx: 0, dy: 0 },
    consumeLook() { const l = this._look; this._look = { dx: 0, dy: 0 }; return l; },
    held(code) { return keys.has(code); },
    pressed() { return false; },
  };
}

/** mulberry32. Seeded, so a fuzz failure is a failure someone can re-run. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1. THE CONTROL SCHEME
 *
 * The brief asks for a scheme "consistent with how this game already reads
 * input", and names the trap: crouch is KeyC and Ctrl is NOT a game key,
 * because a player found that the hard way. These cases pin the mapping so a
 * later tidy-up cannot quietly move a verb onto a key that closes the tab.
 * ══════════════════════════════════════════════════════════════════════════ */

test('the control scheme is exactly the one documented on readInput', () => {
  const f = new Flight();

  // W/S is throttle, and reverse is a real command rather than a floor at 0.
  assert.equal(f.readInput(fakeInput({ state: { forward: 1 } }), DT).throttle, 1);
  assert.equal(f.readInput(fakeInput({ state: { forward: -1 } }), DT).throttle, -1);

  // A/D is ROLL. The one place the shipped label ("Strafe left/right") and the
  // behaviour part company, which readInput explains at length.
  assert.equal(f.readInput(fakeInput({ state: { right: 1 } }), DT).roll, 1);
  assert.equal(f.readInput(fakeInput({ state: { right: -1 } }), DT).roll, -1);

  // Space / C are vertical thrust. BINDABLE already labels them "fly up" and
  // "fly down" among five other meanings; this is the sixth and the same idea.
  assert.equal(f.readInput(fakeInput({ state: { jump: true } }), DT).vertical, 1);
  assert.equal(f.readInput(fakeInput({ state: { crouch: true } }), DT).vertical, -1);
  assert.equal(
    f.readInput(fakeInput({ state: { jump: true, crouch: true } }), DT).vertical, 0,
    'both vertical thrusters at once must cancel, not pick a winner'
  );

  // Shift is boost. Sprint means go faster on foot; it means go faster here.
  assert.equal(f.readInput(fakeInput({ state: { sprint: true } }), DT).boost, true);

  // X is the airbrake, and it is the ONLY new binding in the whole scheme.
  assert.equal(f.readInput(fakeInput({ keys: ['KeyX'] }), DT).brake, true);
  assert.equal(f.readInput(fakeInput({}), DT).brake, false);
});

test('CTRL IS NOT A GAME KEY - no flight verb is reachable through it', () => {
  /* `Input.js` will not even DELIVER a Ctrl combination (`onKey` drops any
   * event with `ctrlKey`), so a flight verb bound to one would be dead on
   * arrival AND would have taken the tab with it on the way. This asserts the
   * negative directly: with every Ctrl key "held", nothing moves. */
  const f = new Flight();
  const c = f.readInput(fakeInput({ keys: ['ControlLeft', 'ControlRight'] }), DT);
  assert.equal(c.brake, false);
  assert.equal(c.throttle, 0);
  assert.equal(c.vertical, 0);
  assert.equal(c.roll, 0);
  assert.equal(c.boost, false);
});

test('the lateral axis is unbound on the keyboard but fully integrated', () => {
  /* Two halves, and both matter. The keyboard half is the decision: E is
   * `interact` and the space world will want it for docking, so a Q/E lateral
   * pair would steal a key from a world that has not been written yet.
   *
   * The integrator half is the guard against that decision decaying into a
   * dead axis - content that is BUILT but cannot be REACHED is the signature
   * defect of this project, and an unbound command field is exactly that shape
   * if nothing drives it. */
  const f = new Flight();
  assert.equal(f.readInput(fakeInput({ state: { right: 1 }, keys: ['KeyQ', 'KeyE'] }), DT).lateral, 0,
    'a lateral binding appeared. If it is Q/E, it just took the dock key.');

  const g = rig(1);
  run(g, 4, { lateral: 1 });
  const starboard = g.right(new THREE.Vector3());
  assert.ok(g.velocity.dot(starboard) > 20,
    `lateral thrust moved the ship ${g.velocity.dot(starboard).toFixed(1)} m/s to starboard; the `
    + 'axis is in the command struct but the integrator ignores it');
});

test('mouse look drives a self-centring virtual stick, and it self-centres', () => {
  const f = new Flight();
  /* A 0.556 rad sweep (253 px at the shipped sensitivity) is full deflection.
   *
   * The PARTIAL sweep is asserted first and it is the load-bearing one:
   * "0.5556 rad saturates" stays true for every gain ABOVE 1.8 as well, so on
   * its own it is an assertion that cannot fail upward. Mutation 17 (gain
   * 1.8 -> 3.0) sailed through exactly that hole. A 0.2 rad sweep pins the
   * gain from both sides. */
  f.readInput(fakeInput({ look: { dx: 0.2, dy: 0 } }), DT);
  assert.ok(Math.abs(f.command.yaw - 0.36) < 1e-6,
    `a 0.2 rad sweep gives ${f.command.yaw.toFixed(4)} of deflection; gain 1.8 gives 0.36`);
  f.readInput(fakeInput({ look: { dx: 0.5556, dy: 0 } }), DT);
  assert.ok(Math.abs(f.command.yaw - 1) < 1e-6, `full deflection at 0.556 rad, got ${f.command.yaw}`);

  // Mouse right is yaw right; mouse DOWN is pitch DOWN, matching on-foot.
  const g = new Flight();
  g.readInput(fakeInput({ look: { dx: 0.2, dy: 0.2 } }), DT);
  assert.ok(g.command.yaw > 0, 'mouse right must yaw right');
  assert.ok(g.command.pitch < 0, 'mouse down must pitch down, as `Player` does');

  // ...and it returns to centre on its own, which is what makes the assist a
  // rate assist rather than a per-frame impulse with nothing to damp.
  let held = 0;
  for (let i = 0; i < 120; i++) { f.readInput(fakeInput({}), DT); held = Math.abs(f.command.yaw); }
  assert.ok(held < 0.01, `the stick did not self-centre: still at ${held.toFixed(4)} after 2 s`);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. THE AXIS SIGNS
 *
 * Two of the three are inverted from the naive reading. A flipped one survives
 * a whole playtest as "the controls feel wrong", so each is pinned by where
 * the ship's own vectors END UP, not by the sign of a number in `omega`.
 * ══════════════════════════════════════════════════════════════════════════ */

test('pitch up raises the nose, and the nose is where it ends up', () => {
  const f = rig(1);
  run(f, 1, { pitch: 1 });
  const nose = f.forward(new THREE.Vector3());
  assert.ok(nose.y > 0.5, `nose y after a second of pitch-up is ${nose.y.toFixed(3)}; it must rise`);
});

test('yaw right swings the nose to starboard', () => {
  const f = rig(1);
  const startRight = f.right(new THREE.Vector3());
  run(f, 1, { yaw: 1 });
  const nose = f.forward(new THREE.Vector3());
  assert.ok(nose.dot(startRight) > 0.5,
    `nose after a second of yaw-right leans ${nose.dot(startRight).toFixed(3)} toward the old `
    + 'starboard vector; positive yaw must be nose-right');
});

test('roll right drops the starboard wing, i.e. the up vector tips right', () => {
  const f = rig(1);
  const startRight = f.right(new THREE.Vector3());
  run(f, 0.5, { roll: 1 });
  const up = f.up(new THREE.Vector3());
  assert.ok(up.dot(startRight) > 0.5,
    `up leans ${up.dot(startRight).toFixed(3)} toward starboard after a right roll; it must be `
    + 'positive, or the roll is inverted');
});

test('the rotation is composed in the BODY frame, not the world frame', () => {
  /* The bug this catches: `dq * q` instead of `q * dq`. Roll 90 degrees, then
   * pitch. Body-frame pitch turns the nose toward the old starboard (you are
   * on your side, so "up" is sideways). World-frame pitch would keep lifting
   * the nose toward world up, which is the classic "the controls stop making
   * sense once you roll" bug and is invisible in level flight. */
  const f = rig(1);
  run(f, 3, { roll: 1 });          // hard right roll
  const rightAfterRoll = f.right(new THREE.Vector3());
  const worldUp = new THREE.Vector3(0, 1, 0);
  const rolled = Math.abs(f.up(new THREE.Vector3()).dot(worldUp));
  assert.ok(rolled < 0.3, `the ship is not actually rolled: |up.y| = ${rolled.toFixed(3)}`);

  f.setCommand({ roll: 0 });
  run(f, 0.6);                      // let the roll rate damp out
  const noseBefore = f.forward(new THREE.Vector3());
  run(f, 1, { pitch: 1 });
  const noseAfter = f.forward(new THREE.Vector3());
  const swungWorldUp = noseAfter.y - noseBefore.y;
  const swungBodyUp = noseAfter.dot(rightAfterRoll) - noseBefore.dot(rightAfterRoll);
  assert.ok(Math.abs(swungBodyUp) > Math.abs(swungWorldUp) * 2,
    `pitching a rolled ship swung the nose ${swungWorldUp.toFixed(3)} toward WORLD up and only `
    + `${swungBodyUp.toFixed(3)} toward its own up - the rate is being applied in the world frame`);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. TURN RATES
 * ══════════════════════════════════════════════════════════════════════════ */

test('the three turn rates are what the table says, measured off the quaternion', () => {
  const cases = [
    ['pitch', FLIGHT.pitchRate, 77.35],
    ['yaw', FLIGHT.yawRate, 60.16],
    ['roll', FLIGHT.rollRate, 148.97],
  ];
  for (const [axis, rate, deg] of cases) {
    const f = rig(1);
    run(f, 3, { [axis]: 1 });          // settle onto the commanded rate
    const measured = sweptRate(f, 1);
    assert.ok(Math.abs(measured - rate) < 0.01,
      `${axis} settled at ${measured.toFixed(4)} rad/s, table says ${rate}`);
    assert.ok(Math.abs(measured * DEG - deg) < 0.5,
      `${axis} is ${(measured * DEG).toFixed(2)} deg/s, recorded ${deg}`);
  }
  assert.ok(FLIGHT.rollRate > FLIGHT.pitchRate * 1.8,
    'roll stopped being the fast axis. A ship that yaws as well as it rolls has no reason to roll, '
    + 'and roll is the verb that makes a spaceship read as a spaceship.');
  assert.ok(FLIGHT.yawRate < FLIGHT.pitchRate, 'yaw must stay the slowest axis');
});

test('a commanded rate is reached in 0.283 s and abandoned in 0.45 s', () => {
  const f = rig(1);
  let t = 0;
  while (Math.abs(f.omega.x) < FLIGHT.pitchRate * 0.95 && t < 5) {
    f.setCommand({ pitch: 1 });
    f.step(DT);
    t += DT;
  }
  assert.ok(Math.abs(t - 0.283) < 0.02, `time to 95% of the commanded rate is ${t.toFixed(3)} s`);

  let t2 = 0;
  f.setCommand({ pitch: 0 });
  while (f.omega.length() > 0.01 && t2 < 10) { f.step(DT); t2 += DT; }
  assert.ok(Math.abs(t2 - 0.45) < 0.05, `time to stop turning is ${t2.toFixed(3)} s`);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4. TURNING RADIUS: LESSON 1
 * ══════════════════════════════════════════════════════════════════════════ */

test('LESSON 1: turning radius is invariant across every hull and every tier', () => {
  /* `Ship.js:33-35`: a speed tier widens the turning radius unless the falloff
   * divides by the TIERED top speed and the rate, cap and gain are all times
   * powerMul. Measured on the mounts before that fix: eagle x1.52, board x1.65.
   *
   * Flown here rather than computed: accelerate to the drag fixed point, hold
   * full pitch for six seconds, then read the quaternion sweep and the mean
   * speed over the next second. */
  const radii = [];
  for (const h of everyHull()) {
    toCruise(h.flight);
    run(h.flight, 6, { pitch: 1 });
    const q0 = h.flight.quaternion.clone();
    const v = meanSpeed(h.flight, 1);
    const dq = q0.invert().multiply(h.flight.quaternion);
    const omega = 2 * Math.acos(Math.min(1, Math.abs(dq.w)));
    radii.push({ id: h.id, tier: h.tier, pm: h.pm, v, r: v / omega });
  }
  const rs = radii.map((r) => r.r);
  const spread = Math.max(...rs) - Math.min(...rs);
  const detail = radii.map((r) => `${r.id}+${r.tier} pm ${r.pm.toFixed(2)} v ${r.v.toFixed(1)} r ${r.r.toFixed(2)}`).join('; ');
  assert.ok(spread < 0.25,
    `turning radius spreads ${spread.toFixed(3)} m across the tier grid, which is the mount bug `
    + `arriving on ships. ${detail}`);
  for (const r of rs) {
    assert.ok(Math.abs(r - 148.15) < 0.25, `radius ${r.toFixed(2)} m, recorded 148.02-148.11 m`);
  }
  // The power multipliers really do span a range, or the invariance is trivial.
  const pms = radii.map((r) => r.pm);
  assert.ok(Math.max(...pms) / Math.min(...pms) > 1.85,
    `the grid only spans x${(Math.max(...pms) / Math.min(...pms)).toFixed(2)} of power; an `
    + 'invariance over nothing proves nothing');
});

test('LESSON 1 ABLATION: each of the three multipliers is load-bearing', () => {
  const pm = 1.75;                       // stock Kestrel
  const vTop = cruiseTopSpeed(pm);
  const correctTop = turnRadius(vTop, pm);

  /* (a) drop `pm` off the turn rate. This is the whole tier, straight into the
   * radius: the ship goes 1.75x faster and turns at the same rate. */
  const authTop = 1 - FLIGHT.authorityFalloff * Math.min(1, vTop / cruiseTopSpeed(pm));
  const noRateMul = vTop / (FLIGHT.pitchRate * authTop);
  assert.ok(Math.abs(noRateMul - 259.26) < 0.5, `ablation (a) gives ${noRateMul.toFixed(2)} m`);
  assert.ok(noRateMul / correctTop > 1.7,
    `dropping powerMul off the turn rate only widened the radius x${(noRateMul / correctTop).toFixed(2)}`);

  /* (b) use the UNTIERED 120 in the falloff denominator. The subtle one, and
   * the reason this case tests at HALF speed as well as at the top: at the top
   * every ship clamps to the same 0.6 authority and the ablation is invisible.
   * At half throttle-speed, where players actually corner, it opens up. */
  const half = 0.5;
  const proper = [];
  const untiered = [];
  for (const p of [1.25, 1.5, 1.75, 2.04, 2.38]) {
    const v = cruiseTopSpeed(p) * half;
    proper.push(turnRadius(v, p));
    const bad = 1 - FLIGHT.authorityFalloff * Math.min(1, v / cruiseTopSpeed(1));
    untiered.push(v / (FLIGHT.pitchRate * p * bad));
  }
  const properSpread = Math.max(...proper) - Math.min(...proper);
  const untieredSpread = Math.max(...untiered) - Math.min(...untiered);
  assert.ok(properSpread < 1e-9, `the tiered denominator itself spreads ${properSpread}`);
  assert.ok(Math.abs(untieredSpread - 14.815) < 0.1,
    `ablation (b) spreads ${untieredSpread.toFixed(3)} m at half speed; recorded 14.815`);

  /* (c) the exported helper must agree with the flown ship, or a spec board
   * can print a radius the ship does not have. */
  const f = rig(pm);
  toCruise(f);
  run(f, 6, { pitch: 1 });
  const q0 = f.quaternion.clone();
  const v = meanSpeed(f, 1);
  const omega = 2 * Math.acos(Math.min(1, Math.abs(q0.invert().multiply(f.quaternion).w)));
  assert.ok(Math.abs(v / omega - turnRadius(v, pm)) < 0.2,
    `the flown radius ${(v / omega).toFixed(2)} m disagrees with turnRadius() ${turnRadius(v, pm).toFixed(2)} m`);
});

test('it turns tighter slowly than fast - the ship feels different at speed', () => {
  /* ASSIST 4 by its other name. A model where the radius did not open up with
   * speed would fly identically at 30 and at 210 m/s, and the brief is
   * explicit that it must not. */
  const r = [0.25, 0.5, 0.75, 1].map((f) => turnRadius(cruiseTopSpeed(1) * f, 1));
  assert.deepEqual(r.map((x) => Number(x.toFixed(2))), [24.69, 55.56, 95.24, 148.15]);
  for (let i = 1; i < r.length; i++) assert.ok(r[i] > r[i - 1] * 1.5, 'the radius must open up with speed');

  /* ABLATION, and it is about the SHAPE of the curve rather than any one
   * point on it. Without the falloff the turn rate is constant, so the radius
   * is exactly linear in speed and quarter-to-full is exactly x4.00 - the
   * ship handles the same everywhere and only the scale changes. The falloff
   * makes that x6.00: at cruise top the ship is disproportionately unwilling
   * to corner, which is the whole of "it feels different at different speeds".
   *
   * Note the direction, because it is the opposite of the naive reading and
   * this case caught the author getting it backwards: the falloff makes every
   * turn WIDER (24.69 m at quarter speed against 22.22 m with no falloff at
   * all). What it buys is not a tighter slow corner, it is a much wider fast
   * one. */
  const linear = [0.25, 1].map((f) => (cruiseTopSpeed(1) * f) / FLIGHT.pitchRate);
  assert.ok(Math.abs(linear[1] / linear[0] - 4) < 1e-9, 'the no-falloff curve is not linear');
  assert.ok(Math.abs(r[3] / r[0] - 6) < 1e-9,
    `the radius grows x${(r[3] / r[0]).toFixed(3)} from quarter speed to full; recorded 6.000, and `
    + 'a model with no falloff would give exactly 4.000');
  assert.ok(r[0] > linear[0], 'the falloff should widen the slow corner, not tighten it');
});

/* ══════════════════════════════════════════════════════════════════════════
 * 5. TOP SPEED: LESSON 2
 * ══════════════════════════════════════════════════════════════════════════ */

test('cruise top speed is the drag fixed point, per hull and per tier', () => {
  const seen = [];
  for (const h of everyHull()) {
    toCruise(h.flight);
    const want = cruiseTopSpeed(h.pm);
    assert.ok(Math.abs(h.flight.speed - want) < 0.05,
      `${h.id}+${h.tier} settled at ${h.flight.speed.toFixed(2)}, fixed point ${want.toFixed(2)}`);
    seen.push({ id: h.id, tier: h.tier, top: Number(h.flight.speed.toFixed(1)) });
  }
  // The recorded ladder. A change to BIAS_PER_POINT or to the perTier
  // percentage lands here rather than as a silent re-tune.
  assert.deepEqual(seen, [
    { id: 'kestrel', tier: 0, top: 210 }, { id: 'kestrel', tier: 1, top: 235.2 },
    { id: 'kestrel', tier: 2, top: 260.4 }, { id: 'kestrel', tier: 3, top: 285.6 },
    { id: 'dray', tier: 0, top: 150 }, { id: 'dray', tier: 1, top: 168 },
    { id: 'dray', tier: 2, top: 186 }, { id: 'dray', tier: 3, top: 204 },
    { id: 'pike', tier: 0, top: 180 }, { id: 'pike', tier: 1, top: 201.6 },
    { id: 'pike', tier: 2, top: 223.2 }, { id: 'pike', tier: 3, top: 244.8 },
  ]);
});

test('A SHIP WITH MORE POWER ACTUALLY FLIES FASTER - floor, achieved, ceiling', () => {
  /* The brief's own sentence, and the failure it is guarding against is
   * recorded on `Ship.js:107-118`: the dragon banked tiers, persisted them,
   * re-emitted them and applied them to nothing at all, because the hook did
   * not exist. A purchase whose entire effect is invisible is the defect. */
  for (const id of SHIP_ORDER) {
    const tops = [];
    for (let t = 0; t <= 3; t++) {
      const h = hull(id, t);
      toCruise(h.flight);
      tops.push(h.flight.speed);
    }
    for (let t = 1; t <= 3; t++) {
      const gain = tops[t] / tops[t - 1];
      // FLOOR: a tier must be worth at least 5% of top speed, or it is a
      // purchase the player cannot feel.
      // ACHIEVED: 12% of the BASE, which is 10.7% -> 9.7% of the running total.
      // CEILING (by ablation): with `applyPowers` never called, every tier is
      // x1.00 - which is exactly the dragon bug, reproduced below.
      assert.ok(gain > 1.05,
        `${id} tier ${t} is only worth x${gain.toFixed(4)} of top speed`);
      assert.ok(gain < 1.15, `${id} tier ${t} at x${gain.toFixed(4)} is outside the recorded ladder`);
    }
    assert.ok(tops[3] / tops[0] > 1.35,
      `${id}: three tiers only bought x${(tops[3] / tops[0]).toFixed(3)}`);
  }

  // The ceiling, reproduced rather than remembered: three tiers bought this
  // much, and a ship whose tiers were banked and never applied bought nothing.
  const stock = hull('kestrel', 0);
  const maxed = hull('kestrel', 3);
  toCruise(stock.flight); toCruise(maxed.flight);
  assert.ok(maxed.flight.speed - stock.flight.speed > 70,
    `three tiers bought ${(maxed.flight.speed - stock.flight.speed).toFixed(1)} m/s; the dragon `
    + 'bug bought 0');

  // ...and the hull bias survives the whole ladder, which is `BIAS_PER_POINT`'s
  // entire justification: buy a Dray up to courier speed and no further.
  const drayMax = hull('dray', 3); toCruise(drayMax.flight);
  assert.ok(drayMax.flight.speed < stock.flight.speed,
    `a fully-upgraded Dray (${drayMax.flight.speed.toFixed(1)}) overtook a stock Kestrel `
    + `(${stock.flight.speed.toFixed(1)}); BIAS_PER_POINT no longer clears the ladder`);
  assert.ok(SHIP_BASE_STATS.kestrel.power > SHIP_BASE_STATS.dray.power);
});

test('a ship whose applyPowers was never called is REFUSED, not flown slowly', () => {
  /* Found by writing the case above and watching it fail at 120 m/s.
   *
   * `new Ship(...)` sets `_powerMul = 1`; the hull bias is computed inside
   * `applyPowers`, NOT in the constructor. So boarding a brand-new stock hull
   * without that call gives every ship in the yard the same 120 m/s cruise -
   * slower than the slowest hull's real 150 - with no purchase, no tier and no
   * symptom to search for. It is the dragon bug reachable from one forgotten
   * line at the boarding seam, so `setShip` throws instead. */
  const raw = new Ship({ id: 'kestrel', displayName: 'k', slotMats: {} });
  assert.equal(raw._powerMul, 1, 'Ship no longer initialises powerMul to 1; re-check this guard');
  assert.throws(() => new Flight({ ship: raw }), /applyPowers/,
    'a hull with an unapplied power bias was accepted and would have flown at 120 m/s');

  // An empty bag is the fix, and it is what "no upgrades bought" means.
  raw.applyPowers({});
  const f = new Flight({ ship: raw });
  toCruise(f);
  assert.ok(Math.abs(f.speed - 210) < 0.05, `applyPowers({}) gives ${f.speed.toFixed(2)}, want 210`);

  // A snapshot is exempt: it reports what the ship computed, and a rig may
  // legitimately hand over a powerMul of 1.
  assert.doesNotThrow(() => new Flight({ ship: { powerMul: 1, accelMul: 1 } }));
});

test('LESSON 2 ABLATION: accelMul must not leak into top speed', () => {
  /* `Ship.js:36-42`. The correct model scales the NET, so the fixed point is
   * `thrust*pm/drag` and `accelMul` is algebraically absent. */
  const pm = 1.75;
  const f = rig(pm, pm);
  toCruise(f);
  assert.ok(Math.abs(f.speed - 210) < 0.05, `stock Kestrel tops at ${f.speed.toFixed(2)}`);

  // Same power, ten times the acceleration multiplier. If the multiply had
  // been left on the thrust term this would be a different top speed.
  const g = rig(pm, pm * 10);
  toCruise(g);
  assert.ok(Math.abs(g.speed - f.speed) < 0.05,
    `x10 accelMul changed top speed to ${g.speed.toFixed(2)} from ${f.speed.toFixed(2)} - the `
    + 'multiply has moved inside the thrust term and Acceleration is now a speed stat');

  // ...but it MUST change how fast you get there, or `accelMul` does nothing.
  const t95 = (fl) => {
    const target = cruiseTopSpeed(pm) * 0.95;
    let t = 0;
    fl.setCommand({ throttle: 1 });
    while (fl.speed < target && t < 60) { fl.step(DT); t += DT; }
    return t;
  };
  assert.ok(t95(rig(pm, pm * 10)) < t95(rig(pm, pm)) * 0.2,
    'accelMul changed neither the top speed nor the time to reach it, so it is inert');

  // The leaked number, stated so a reviewer can recognise the failure mode.
  assert.ok(Math.abs((FLIGHT.thrust * pm * pm) / FLIGHT.drag - 367.5) < 0.05,
    'the recorded leak figure no longer follows from the constants');
});

test('gravity is outside the accelMul multiply, and the residue is deliberate', () => {
  const g = new THREE.Vector3(0, -9, 0);

  /* The clean statement, and the only one that is exactly true: on the FIRST
   * step, with no velocity for drag to act on, gravity alone moves the
   * velocity - and it moves it by `g*dt` for every hull, because it is added
   * after the multiply. Inside the multiply a Dray would read -0.150 and a
   * Kestrel -0.357: the courier would fall two and a half times harder for
   * having a better reactor. */
  const oneStep = (pm) => { const f = rig(pm); f.step(DT, { gravity: g }); return f.velocity.y; };
  assert.equal(oneStep(1.25), oneStep(2.38), 'gravity has been folded into the accelMul multiply');
  /* -0.149996 rather than the -0.150000 that `g*dt` alone gives, and the 4e-6
   * is not rounding: the alignment assist runs after gravity and rotates the
   * new velocity 0.0075 rad toward the nose. Worth knowing rather than
   * tolerancing away - it means a coasting ship converts a little of its fall
   * into forward motion every step, which is the assist behaving as an
   * arcade wing and is what will keep a descent flyable. */
  assert.ok(Math.abs(oneStep(1.25) - -0.149996) < 1e-6,
    `one step of 9 m/s² gravity gives ${oneStep(1.25).toFixed(6)} m/s`);
  assert.ok(Math.abs(-9 * DT + 0.15) < 1e-9, 'the recorded -0.150 no longer follows from g and dt');

  /* The residue, asserted rather than hidden. Drag IS inside the multiply -
   * lesson 2 requires it - and drag acts on the velocity gravity created, so
   * the terminal fall does vary by hull.
   *
   * It is NOT `g/(drag*accelMul)`, and the gap is the second thing worth
   * knowing about a descent: the alignment assist keeps rotating the fall
   * toward the (level) nose, so a coasting ship converts part of its drop into
   * forward motion and settles slower and flatter than pure drag predicts. A
   * stock Dray falls at 8.49 m/s while carrying 4.71 m/s forward, against the
   * 11.08 drag alone would give - the assist is acting as a wing. Anyone
   * tuning the volcanic descent needs this number, not the textbook one. */
  const terminal = (pm) => {
    const f = rig(pm);
    for (let i = 0; i < 60 * 120; i++) f.step(DT, { gravity: g });
    const nose = f.forward(new THREE.Vector3());
    return { fall: -f.velocity.y, glide: f.velocity.dot(nose), pure: 9 / (FLIGHT.drag * pm) };
  };
  const dray = terminal(1.25);
  const kestrel = terminal(2.38);
  assert.ok(Math.abs(dray.fall - 8.486) < 0.02, `Dray terminal fall ${dray.fall.toFixed(3)} m/s`);
  assert.ok(Math.abs(dray.glide - 4.710) < 0.02, `Dray glide ${dray.glide.toFixed(3)} m/s`);
  assert.ok(Math.abs(kestrel.fall - 5.369) < 0.02, `Kestrel fall ${kestrel.fall.toFixed(3)} m/s`);
  assert.ok(dray.fall > kestrel.fall, 'the heavy hull must be the one that falls faster');
  assert.ok(dray.fall < dray.pure * 0.85,
    'the alignment assist has stopped turning a fall into a glide, so a descent is now a drop');
});

/* ══════════════════════════════════════════════════════════════════════════
 * 6. THE HARD CAP AND THE BOOST
 * ══════════════════════════════════════════════════════════════════════════ */

test('boost is cap-governed, cruise is drag-governed, and releasing boost does not snap', () => {
  const f = rig(1);
  toCruise(f);
  const cruise = f.speed;
  assert.ok(Math.abs(cruise - 120) < 0.05);

  f.boostFuel = FLIGHT.boostEnergy;
  f.setCommand({ boost: true });
  let t = 0;
  let peak = 0;
  let biggestStep = 0;
  let prev = f.speed;
  while (t < 12) {
    if (t < 3.3) f.boostFuel = FLIGHT.boostEnergy;   // hold the tank open
    f.step(DT);
    t += DT;
    peak = Math.max(peak, f.speed);
    biggestStep = Math.max(biggestStep, Math.abs(f.speed - prev));
    prev = f.speed;
    if (t >= 3.3) f.setCommand({ boost: false });
  }
  assert.ok(Math.abs(peak - boostTopSpeed(1)) < 0.05,
    `boost peaked at ${peak.toFixed(2)}, cap is ${boostTopSpeed(1)}`);
  assert.ok(peak / cruise > 2.1, `boost is only worth x${(peak / cruise).toFixed(2)}`);

  /* THE SNAP. The first arrangement had a cruise cap of 150 and a boost cap of
   * 240, so releasing boost moved the ship 90 m/s in one frame. A single frame
   * may not shed more than 4 m/s at 1/60. */
  assert.ok(biggestStep < 4,
    `one frame changed the speed by ${biggestStep.toFixed(2)} m/s - the two-cap snap is back`);
  assert.ok(f.speed < cruise * 1.6 && f.speed > cruise,
    `8.7 s after releasing boost the ship is at ${f.speed.toFixed(1)}, cruise is ${cruise}`);
});

test('the hard cap binds, and it binds at 260 * powerMul', () => {
  for (const h of everyHull()) {
    const f = h.flight;
    f.setCommand({ throttle: 1, boost: true });
    for (let i = 0; i < 60 * 40; i++) { f.boostFuel = FLIGHT.boostEnergy; f.step(DT); }
    assert.ok(Math.abs(f.speed - boostTopSpeed(h.pm)) < 0.05,
      `${h.id}+${h.tier} boosted to ${f.speed.toFixed(2)}, cap ${boostTopSpeed(h.pm).toFixed(2)}`);
  }
  /* ABLATION: with the cap removed, boost would settle at the drag fixed point
   * for 2.6x thrust - 312 m/s at pm 1, i.e. x1.20 over the cap. The cap is
   * doing real work rather than sitting above the model. */
  const uncapped = (FLIGHT.thrust * FLIGHT.boostThrustMul) / FLIGHT.drag;
  assert.ok(Math.abs(uncapped - 312) < 0.05, `uncapped boost would settle at ${uncapped}`);
  assert.ok(uncapped > FLIGHT.hardCap, 'the hard cap is above the drag terminal and never binds');
  // ...and equally it must NOT bind at cruise, or releasing boost snaps again.
  assert.ok(cruiseTopSpeed(1) < FLIGHT.hardCap * 0.6,
    'the hard cap is close enough to cruise to start governing it');
});

test('an external impulse cannot beat the cap either', () => {
  /* A collision, a laser hit or a tractor beam goes through `applyImpulse`,
   * which is outside every drag and thrust term. The cap is the only thing
   * between that and a ship on the far side of the solar system. */
  const f = rig(1);
  f.applyImpulse(new THREE.Vector3(0, 0, -5000));
  f.step(DT);
  assert.ok(f.speed <= boostTopSpeed(1) + 1e-6,
    `a 5000 m/s impulse left the ship at ${f.speed.toFixed(1)} m/s`);
});

test('the boost tank is 3.35 s and refills in 6.2 s, and coasting does not drain it', () => {
  const f = rig(1);
  let t = 0;
  f.setCommand({ throttle: 1, boost: true });
  while (f.boostFuel > 0 && t < 20) { f.step(DT); t += DT; }
  assert.ok(Math.abs(t - 3.35) < 0.05, `the tank lasted ${t.toFixed(3)} s`);

  f.setCommand({ boost: false });
  let t2 = 0;
  while (f.boostFuel < FLIGHT.boostEnergy && t2 < 30) { f.step(DT); t2 += DT; }
  assert.ok(Math.abs(t2 - 6.2) < 0.1, `it refilled in ${t2.toFixed(3)} s`);

  /* Boost with the throttle CLOSED must cost nothing. Otherwise the pool
   * drains while coasting and the player is punished for a key they are
   * holding out of habit. */
  const g = rig(1);
  run(g, 3, { throttle: 0, boost: true });
  assert.equal(g.boostFuel, FLIGHT.boostEnergy, 'boost drained with the throttle shut');
  assert.equal(g.boosting, false);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 7. STOPPING DISTANCE
 * ══════════════════════════════════════════════════════════════════════════ */

test('stopping distance: the airbrake is worth 5.4x, floor / achieved / ceiling', () => {
  const stop = (id, brake) => {
    const h = hull(id, 0);
    toCruise(h.flight);
    const v0 = h.flight.speed;
    const p0 = h.flight.position.clone();
    h.flight.setCommand({ throttle: 0, brake });
    let t = 0;
    while (h.flight.speed > 1 && t < 400) { h.flight.step(DT); t += 1 / 60; }
    return { v0, d: h.flight.position.distanceTo(p0), t };
  };

  for (const id of SHIP_ORDER) {
    const coast = stop(id, false);
    const braked = stop(id, true);
    const ratio = coast.d / braked.d;
    // FLOOR: an airbrake that saves less than 4x is not a verb, it is a nudge.
    // ACHIEVED: 5.42x (Kestrel 180.26 -> 33.27 m).
    // CEILING by ablation: with `brakeDrag` at zero the ratio is exactly 1.00.
    assert.ok(ratio > 4,
      `${id}: the brake only saved x${ratio.toFixed(2)} (${coast.d.toFixed(1)} -> ${braked.d.toFixed(1)} m)`);
    assert.ok(Math.abs(ratio - 5.42) < 0.25, `${id}: brake ratio ${ratio.toFixed(3)}, recorded 5.42`);
    assert.ok(Math.abs(coast.d - 180.6) < 1.0,
      `${id} coasts ${coast.d.toFixed(2)} m from ${coast.v0.toFixed(1)} m/s; recorded 180.26-180.91`);
    assert.ok(Math.abs(braked.d - 33.7) < 1.0,
      `${id} brakes in ${braked.d.toFixed(2)} m; recorded 33.27-34.20`);
  }

  /* The emergent property worth knowing: stopping distance from a ship's OWN
   * cruise top is the same for every hull and every tier, because the drag
   * rate scales with `accelMul` at exactly the rate the top speed scales with
   * `powerMul`. A Dray and a Kestrel stop in the same length of space; the
   * Kestrel just got there faster. */
  const ds = SHIP_ORDER.map((id) => stop(id, true).d);
  assert.ok(Math.max(...ds) - Math.min(...ds) < 1.5,
    `stopping distances spread ${(Math.max(...ds) - Math.min(...ds)).toFixed(2)} m across hulls`);
});

test('a braking ship reaches a REAL zero, because a berth needs one', () => {
  const f = rig(1);
  toCruise(f);
  run(f, 12, { throttle: 0, brake: true });
  assert.equal(f.speed, 0, `a braked ship is still crawling at ${f.speed} m/s after 12 s`);
  // ...and coasting does NOT, or drag would be a brake and the brake pointless.
  const g = rig(1);
  toCruise(g);
  run(g, 12, { throttle: 0, brake: false });
  assert.ok(g.speed > 0, 'coasting reaches a dead stop; drag is behaving like a handbrake');
});

/* ══════════════════════════════════════════════════════════════════════════
 * 8. THE ASSIST
 * ══════════════════════════════════════════════════════════════════════════ */

test('ASSIST: rotation stops when you stop asking, from every axis and every rate', () => {
  const r = rng(20260819);
  for (let i = 0; i < 60; i++) {
    const f = rig(1 + r() * 1.4);
    run(f, 0.2 + r() * 3, {
      pitch: r() * 2 - 1, yaw: r() * 2 - 1, roll: r() * 2 - 1, throttle: r(),
    });
    f.setCommand({ pitch: 0, yaw: 0, roll: 0 });
    run(f, 1.5);
    assert.ok(f.omega.length() < 1e-3,
      `run ${i}: still turning at ${f.omega.length().toFixed(5)} rad/s 1.5 s after the stick centred`);
  }
});

test('ASSIST: IT DOES NOT TUMBLE, from any input sequence', () => {
  /* The brief's phrase is "assist prevents tumble from any input sequence", so
   * this is a fuzz rather than a case: 400 seeded runs of ten random segments
   * each, every axis pinned in random combinations, at random power tiers,
   * with random gravity and atmosphere thrown in. The invariant is checked on
   * EVERY step, not at the end. */
  const r = rng(7717);
  let worstOmega = 0;
  let worstSpeed = 0;
  let steps = 0;
  for (let runIdx = 0; runIdx < 400; runIdx++) {
    const pm = 1.25 + r() * 1.13;
    const f = rig(pm);
    const omegaCap = FLIGHT.omegaCap * pm + 1e-6;
    const speedCap = boostTopSpeed(pm) + 1e-6;
    const grav = new THREE.Vector3(0, -(r() * 12), 0);
    const env = { gravity: r() < 0.3 ? grav : null, dragMul: r() < 0.2 ? 1 + r() * 4 : 1 };
    for (let seg = 0; seg < 10; seg++) {
      f.setCommand({
        pitch: Math.round(r() * 2 - 1), yaw: Math.round(r() * 2 - 1),
        roll: Math.round(r() * 2 - 1), throttle: Math.round(r() * 2 - 1),
        vertical: Math.round(r() * 2 - 1), lateral: Math.round(r() * 2 - 1),
        boost: r() < 0.5, brake: r() < 0.2,
      });
      if (r() < 0.15) f.applyImpulse(new THREE.Vector3(r() * 400 - 200, r() * 400 - 200, r() * 400 - 200));
      const n = 1 + Math.floor(r() * 90);
      for (let i = 0; i < n; i++) {
        f.step(DT, env);
        steps++;
        const om = f.omega.length();
        worstOmega = Math.max(worstOmega, om / pm);
        worstSpeed = Math.max(worstSpeed, f.speed / pm);
        assert.ok(om <= omegaCap,
          `run ${runIdx} seg ${seg}: |omega| ${om.toFixed(4)} broke the ${omegaCap.toFixed(4)} cap`);
        assert.ok(f.speed <= speedCap,
          `run ${runIdx} seg ${seg}: speed ${f.speed.toFixed(2)} broke the ${speedCap.toFixed(2)} cap`);
      }
    }
  }
  assert.ok(steps > 100000, `the fuzz only ran ${steps} steps`);
  /* The fuzz must actually REACH the caps, or it is 400 runs of gentle flying
   * and the invariant it checks was never in danger. */
  assert.ok(worstOmega > FLIGHT.omegaCap * 0.999,
    `the fuzz never got within a thousandth of the tumble cap (best ${worstOmega.toFixed(4)} of `
    + `${FLIGHT.omegaCap}) - it is not exercising the clamp it asserts`);
  assert.ok(worstSpeed > FLIGHT.hardCap * 0.99,
    `the fuzz never approached the speed cap (best ${worstSpeed.toFixed(2)} of ${FLIGHT.hardCap})`);
});

test('ASSIST ABLATION: without the tumble cap, all three axes at once spins 11% faster', () => {
  const f = rig(1);
  run(f, 8, { pitch: 1, yaw: 1, roll: 1 });
  const wanted = Math.hypot(FLIGHT.pitchRate, FLIGHT.yawRate, FLIGHT.rollRate);
  assert.ok(Math.abs(wanted - 3.112) < 0.001, `the axes now want ${wanted.toFixed(4)} rad/s`);
  assert.ok(Math.abs(f.omega.length() - FLIGHT.omegaCap) < 1e-6,
    `compound spin settled at ${f.omega.length().toFixed(4)}, cap ${FLIGHT.omegaCap}`);
  assert.ok(wanted / FLIGHT.omegaCap > 1.10,
    `the cap only removes x${(wanted / FLIGHT.omegaCap).toFixed(3)} of spin, so it is decoration`);
  // The swept rate agrees, i.e. the clamp reaches the quaternion and not just
  // the field a HUD reads.
  assert.ok(Math.abs(sweptRate(f, 1) - FLIGHT.omegaCap) < 0.002,
    `the ship is actually sweeping ${sweptRate(f, 1).toFixed(4)} rad/s`);
});

test('ASSIST: velocity follows the nose, so pointing and going are one verb', () => {
  const f = rig(1);
  f.velocity.set(120, 0, 0);            // 90 degrees off the nose (-Z)
  let t = 0;
  const nose = new THREE.Vector3();
  while (t < 10) {
    f.step(DT, null);
    f.setCommand({ throttle: 1 });
    t += DT;
    f.forward(nose);
    if (f.velocity.angleTo(nose) < 1e-3) break;
  }
  assert.ok(Math.abs(t - 0.65) < 0.05,
    `a 90 degree velocity error took ${t.toFixed(3)} s to close; recorded 0.65 s`);

  /* ...but NOT instantly, or the strafe verbs are autopilots and there is no
   * such thing as a drift. A pure vertical burn from rest keeps 42.2% of its
   * off-axis speed a full second after the thruster is released. */
  const g = rig(1);
  run(g, 1, { vertical: 1 });
  const worldUp = new THREE.Vector3(0, 1, 0);
  const before = Math.abs(g.velocity.dot(worldUp));
  run(g, 1, { vertical: 0 });
  const after = Math.abs(g.velocity.dot(worldUp));
  assert.ok(Math.abs((after / before) * 100 - 42.2) < 2,
    `${((after / before) * 100).toFixed(1)}% of the strafe survived a second of coasting; `
    + 'recorded 42.2%. Too high and the assist is not assisting; too low and there is no drift.');
});

test('ASSIST REGRESSION: reverse thrust actually reverses', () => {
  /* The bug this is about, found by measurement rather than by reading:
   * `_stepAlign` targeted the NOSE unconditionally, so retro thrust pushed the
   * velocity anti-parallel and the assist spent 2.00 rad/s dragging it back.
   * Reverse terminal speed came out at 16.8 m/s against the 54.0 that thrust
   * and drag alone specify - a x3.2 shortfall on a manoeuvre players use every
   * time they back off a pier. The fix is that the alignment target is the
   * nose SIGNED BY THROTTLE. */
  const f = rig(1);
  run(f, 60, { throttle: -1 });
  const want = (FLIGHT.thrust * FLIGHT.reverseFrac) / FLIGHT.drag;
  assert.ok(Math.abs(want - 54) < 1e-9);
  assert.ok(Math.abs(f.speed - want) < 0.05,
    `reverse settled at ${f.speed.toFixed(2)} m/s; thrust and drag specify ${want}. If this reads `
    + 'near 16.8, the alignment assist is targeting the nose while the engine pushes the other way.');
  const nose = f.forward(new THREE.Vector3());
  assert.ok(f.velocity.dot(nose) < -50, 'the ship is not actually going backwards');

  // ...and reverse must stay a retro-thruster, not a second main engine.
  assert.ok(want < cruiseTopSpeed(1) * 0.5, 'reverse is as good as forward; it should not be');
});

test('a strafe is not free: vertical and lateral top out well below cruise', () => {
  for (const axis of ['vertical', 'lateral']) {
    const f = rig(1);
    run(f, 60, { [axis]: 1 });
    assert.ok(Math.abs(f.speed - 49.42) < 0.1,
      `${axis} terminal is ${f.speed.toFixed(2)} m/s; recorded 49.42`);
    assert.ok(f.speed < cruiseTopSpeed(1) * 0.5,
      `${axis} reaches ${(100 * f.speed / cruiseTopSpeed(1)).toFixed(0)}% of cruise; the main `
      + 'engine has stopped being the way to travel');
  }
});

/* ══════════════════════════════════════════════════════════════════════════
 * 9. CAMERA AND FOV
 * ══════════════════════════════════════════════════════════════════════════ */

test('the camera and FOV sell speed, and sell the boost half hardest', () => {
  const h = hull('kestrel', 0);
  const f = h.flight;
  const out = {};
  const read = (v) => { f.velocity.set(0, 0, -v); return { ...f.cameraRig(75, out) }; };

  assert.equal(read(0).fov, 75);
  assert.ok(Math.abs(read(105).fov - 78.5) < 0.01);
  assert.ok(Math.abs(read(210).fov - 82) < 0.01, 'cruise top must read exactly base + the cruise kick');
  assert.ok(Math.abs(read(455).fov - 94) < 0.01, 'the cap must read base + both kicks');
  assert.ok(Math.abs(read(300).fov - 86.408) < 0.01);

  // Monotone, and the second half is steeper than the first - the whole point
  // of stacking two terms instead of running one ramp over 455 m/s.
  const firstHalf = read(210).fov - read(0).fov;
  const secondHalf = read(455).fov - read(210).fov;
  assert.ok(secondHalf > firstHalf * 1.5,
    `the boost half of the range is worth ${secondHalf.toFixed(1)} deg against the cruise half's `
    + `${firstHalf.toFixed(1)}; a player cannot tell 210 from 455`);

  // Chase distance does its own half of the job.
  assert.equal(read(0).distance, FLIGHT.chaseBase);
  assert.ok(Math.abs(read(455).distance - 21) < 0.01);
  assert.ok(read(455).distance > read(0).distance * 1.7);

  // The precedent is `Player._applyFov`'s sprint kick, which is 6.5 deg at
  // most. A ship should out-kick a sprint, or boost reads as jogging.
  assert.ok(FLIGHT.fovCruiseKick + FLIGHT.fovBoostKick > 6.5 * 2);
});

test('cameraRig and snapshot fill a caller-provided object and allocate nothing', () => {
  /* HOUSE RULE: never allocate inside a frame handler. Both of these are read
   * every frame by the HUD and the camera rig, so both take an `out`. */
  const f = rig(1);
  const out = {};
  assert.equal(f.cameraRig(75, out), out);
  assert.equal(f.snapshot(out), out);
  // The vector accessors take one too, and default to shared module scratch.
  const v = new THREE.Vector3();
  assert.equal(f.forward(v), v);
  assert.equal(f.forward(), f.forward(), 'the default is shared scratch, not a fresh vector');
});

/* ══════════════════════════════════════════════════════════════════════════
 * 10. THE NaN GUARD
 * ══════════════════════════════════════════════════════════════════════════ */

test('the NaN guard throws rather than handing a black frame to the renderer', () => {
  /* "NaN propagates through bloom and blacks out the whole frame" is a
   * recorded, day-costing defect in this world. A ship transform goes straight
   * into a camera matrix, so the same guard applies. */
  const f = rig(1);
  f.applyImpulse(new THREE.Vector3(NaN, 0, 0));
  assert.throws(() => f.step(DT), /non-finite/, 'a NaN velocity was allowed through');

  const g = rig(1);
  assert.throws(() => g.step(DT, { gravity: new THREE.Vector3(0, Infinity, 0) }), /non-finite/);
});

test('flying dead backwards does not divide by a zero-length axis', () => {
  /* The degenerate case in `_stepAlign`: velocity exactly anti-parallel to the
   * alignment target makes the cross product zero, and normalising it is a
   * division by zero that puts NaN into the velocity. Reachable in play by
   * coasting backwards after a retro burn, so it is not a theoretical case. */
  const f = rig(1);
  const nose = f.forward(new THREE.Vector3());
  f.velocity.copy(nose).multiplyScalar(-90);      // exactly reversed, throttle 0
  for (let i = 0; i < 600; i++) f.step(DT);        // the guard throws if it NaNs
  assert.ok(Number.isFinite(f.speed) && f.speed > 0);
  assert.ok(f.velocity.dot(f.forward(new THREE.Vector3())) > 0,
    'after ten seconds of assist the ship is still flying backwards');
});

test('a zero or negative dt is a no-op, not a state corruption', () => {
  const f = rig(1);
  toCruise(f);
  const before = f.position.clone();
  f.step(0);
  f.step(-1);
  assert.deepEqual(f.position.toArray(), before.toArray());
});

/* ══════════════════════════════════════════════════════════════════════════
 * 11. STEP LENGTH
 * ══════════════════════════════════════════════════════════════════════════ */

test('the model does not depend on the frame rate it was tuned at', () => {
  const at = (dt) => {
    const f = rig(1.75);
    f.setCommand({ throttle: 1, pitch: 0.6, roll: -0.3 });
    for (let i = 0; i < Math.round(20 / dt); i++) f.step(dt);
    return f;
  };
  const a = at(1 / 60);
  const b = at(1 / 120);
  assert.ok(Math.abs(a.speed - b.speed) < 0.05,
    `top speed is ${a.speed.toFixed(3)} at 60 Hz and ${b.speed.toFixed(3)} at 120 Hz`);
  const drift = a.position.distanceTo(b.position) / a.position.length();
  assert.ok(drift < 0.002,
    `a 20 s run diverges ${(drift * 100).toFixed(3)}% between 60 and 120 Hz`);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 12. THE RATCHET
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * The scripted flight, shared by the hash and by the case that proves the hash
 * is about something. `[seconds, command]`.
 *
 * Every constant in `FLIGHT` is reachable from this tape, which is the only
 * property that makes a hash worth recording. The ordering is not arbitrary:
 * the boost segment runs long enough to empty the tank AND to pin the cap
 * (1.93 s to reach it, 3.35 s of fuel), the coast after it is long enough for
 * the drag settle to be visible rather than implied, and the retro burn is
 * last because it is the one segment that exercises the signed alignment
 * target and it must not be masked by a subsequent forward burn.
 */
const TAPE = [
  [1.0, { throttle: 1 }],                                        // off the pier
  [2.0, { throttle: 1, pitch: 0.7 }],                            // pull up
  [1.5, { throttle: 1, roll: -1 }],                              // roll left
  [1.5, { throttle: 1, yaw: 0.8, pitch: -0.4 }],                 // and around
  [4.0, { throttle: 1, boost: true, yaw: 0, pitch: 0 }],         // burn the tank
  [2.0, { throttle: 1, boost: false }],                          // settle
  [1.0, { throttle: 0, vertical: 1 }],                           // slip up
  [1.0, { throttle: 0, vertical: 0, lateral: -1 }],              // slip port
  [1.5, { throttle: 0, lateral: 0, brake: true }],               // haul up
  [1.5, { throttle: -1, brake: false }],                         // back off
  [1.0, { throttle: 1, pitch: 1, yaw: 1, roll: 1 }],             // ask for a tumble
  [1.0, { throttle: 0, pitch: 0, yaw: 0, roll: 0 }],             // and stop asking
];

/** FNV-1a, 8 hex characters. The hash `SaveGame.js`, player-speed and parkour use. */
function fnv1a(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * A stock Kestrel flown through the tape, hashed step by step.
 *
 * Position, velocity, orientation, body rate and boost fuel are all quantised
 * to 0.1 mm / 1e-4 and hashed, so a run that ends in the same place having
 * spun differently or spent a different amount of boost on the way still
 * fails. A real `Ship` supplies the multipliers, so `BIAS_PER_POINT` and the
 * per-tier percentage are inside the ratchet too.
 */
function runHash() {
  const h = hull('kestrel', 1);
  const f = h.flight;
  const parts = [];
  const q = (v) => Math.round(v * 1e4);
  for (const [secs, cmd] of TAPE) {
    f.setCommand(cmd);
    const n = Math.round(secs / DT);
    for (let i = 0; i < n; i++) {
      f.step(DT);
      const p = f.position;
      const v = f.velocity;
      const o = f.quaternion;
      const w = f.omega;
      parts.push(
        `${q(p.x)},${q(p.y)},${q(p.z)},${q(v.x)},${q(v.y)},${q(v.z)},`
        + `${q(o.x)},${q(o.y)},${q(o.z)},${q(o.w)},${q(w.x)},${q(w.y)},${q(w.z)},${q(f.boostFuel)}`
      );
    }
  }
  return {
    hash: fnv1a(parts.join(';')),
    steps: parts.length,
    last: parts[parts.length - 1],
    speed: f.speed,
  };
}

test('THE RATCHET: a scripted flight is bit-identical to the recorded tape', () => {
  const a = runHash();
  const b = runHash();
  assert.equal(a.hash, b.hash, 'the flight is not deterministic; the hash cannot ratchet anything');
  assert.equal(a.steps, 1140, 'the tape changed length - the recorded hash is about a different flight');
  /* Recorded once, here, at the commit that wrote the flight model. If this
   * fails, nothing about this flight is supposed to have changed: check
   * pitchRate, yawRate, rollRate, angResponse, omegaCap, authorityFalloff,
   * thrust, drag, reverseFrac, verticalFrac, lateralFrac, brakeDrag,
   * boostThrustMul, hardCap, the boost budget and the two align rates before
   * accepting a new number - and check `Ship.BIAS_PER_POINT` too, because a
   * real hull supplies the multipliers. */
  assert.equal(a.hash, 'dd6a9069',
    `the flight changed. It ends at ${a.last} (x,y,z,vx,vy,vz,qx,qy,qz,qw,wx,wy,wz,fuel in `
    + `1e-4 units) at ${a.speed.toFixed(3)} m/s.`);
});

test('the tape actually exercises the verbs it claims to', () => {
  /* Guards the hash above from decaying into a ratchet over a straight line. A
   * hash over a flight that no longer boosts, brakes, reverses, strafes or
   * asks for a tumble would keep passing while every constant it names went
   * unmeasured - which is the shape of defect this project ships most often:
   * something BUILT that is never REACHED. */
  const h = hull('kestrel', 1);
  const f = h.flight;
  const seen = {
    boosted: false, tankEmptied: false, hitCap: false, braked: false,
    reversed: false, strafed: false, tumbleClamped: false, stoppedTurning: false,
  };
  const capOmega = FLIGHT.omegaCap * h.pm - 1e-6;
  const nose = new THREE.Vector3();
  const worldUp = new THREE.Vector3(0, 1, 0);
  for (const [secs, cmd] of TAPE) {
    f.setCommand(cmd);
    for (let i = 0; i < Math.round(secs / DT); i++) {
      f.step(DT);
      if (f.boosting) seen.boosted = true;
      if (f.boostFuel === 0) seen.tankEmptied = true;
      if (f.speed > boostTopSpeed(h.pm) - 0.01) seen.hitCap = true;
      if (f.command.brake && f.speed < 60) seen.braked = true;
      f.forward(nose);
      if (f.command.throttle < 0 && f.velocity.dot(nose) < -5) seen.reversed = true;
      if (Math.abs(f.velocity.dot(worldUp)) > 5) seen.strafed = true;
      if (f.omega.length() >= capOmega) seen.tumbleClamped = true;
    }
  }
  seen.stoppedTurning = f.omega.length() < 1e-3;
  for (const [k, v] of Object.entries(seen)) {
    assert.ok(v, `the tape no longer exercises "${k}" - the ratchet is over a different flight now`);
  }
});

test('blankCommand is the whole command surface, and setCommand clamps it', () => {
  /* The ratchet hashes state, not the command struct, so a silently added
   * eighth axis would not show up there. This is the guard for that. */
  assert.deepEqual(Object.keys(blankCommand()).sort(),
    ['boost', 'brake', 'lateral', 'pitch', 'roll', 'throttle', 'vertical', 'yaw']);
  const f = new Flight();
  f.setCommand({ pitch: 9, yaw: -9, roll: 9, throttle: -9, vertical: 9, lateral: -9 });
  assert.deepEqual(
    [f.command.pitch, f.command.yaw, f.command.roll, f.command.throttle, f.command.vertical, f.command.lateral],
    [1, -1, 1, -1, 1, -1]
  );
});

test('place and halt give the world a way to berth a ship', () => {
  const f = rig(1);
  toCruise(f);
  run(f, 2, { pitch: 1 });
  /* Deflect the stick for real before berthing. Asserting it is zero without
   * ever having pushed it is an assertion that cannot fail - mutation 45
   * (halt stops clearing the stick) went green against exactly that. */
  f.readInput(fakeInput({ look: { dx: 0.4, dy: -0.4 } }), DT);
  assert.ok(Math.abs(f._stick.x) > 0.5 && Math.abs(f._stick.y) > 0.5, 'the stick was never deflected');

  f.place(new THREE.Vector3(10, 2, -3));
  assert.equal(f.speed, 0);
  assert.equal(f.omega.length(), 0);
  assert.deepEqual(f.position.toArray(), [10, 2, -3]);
  // ...and the mouse stick goes with it, or the ship pulls away from the berth
  // still holding whatever deflection it docked with.
  assert.equal(f._stick.x, 0);
  assert.equal(f._stick.y, 0);
});

/* ══════════════════════════════════════════════════════════════════════════
 *  THE MUTATION LOG
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Each mutation below was applied to `src/ships/Flight.js` on its own, this
 * file run against it, and the source restored. **45 mutations, 45 red.**
 *
 * Recorded in full so a reviewer can re-run any one of them rather than take
 * this on trust, and so a case that stops catching its mutation is visible as
 * a hole rather than as a still-green suite. Only the FIRST catcher is listed
 * where several fire; the ratchet catches most of them and is not named.
 *
 * ── The first pass was 43/45, and the two holes are the point ─────────────
 *
 * They were assertions that could not fail, which is the exact thing the house
 * rule forbids, and neither was obvious by reading:
 *
 *   17  `mouseGain 1.8 -> 3.0` went GREEN. The case asserted that a 0.5556 rad
 *       sweep gives full deflection - which stays true for every gain above
 *       1.8, because the stick clamps. It now asserts a 0.2 rad partial sweep
 *       too, which pins the gain from both sides.
 *   45  `halt` no longer clearing the mouse stick went GREEN, because the case
 *       checked the stick was zero after berthing without ever having pushed
 *       it off zero. It now deflects the stick through `readInput` first.
 *
 *   #   mutation                                            first catcher
 *   1   pitchRate 1.35 -> 1.5                               turn rates
 *   2   yawRate 1.05 -> 1.35                                turn rates
 *   3   rollRate 2.60 -> 1.30                               body-frame composition
 *   4   angResponse 11 -> 6                                 rate reached in 0.283 s
 *   5   omegaCap 2.80 -> 3.50                               the tumble fuzz
 *   6   authorityFalloff 0.40 -> 0                          LESSON 1 invariance
 *   7   thrust 78 -> 90                                     LESSON 1 invariance
 *   8   drag 0.65 -> 0.50                                   LESSON 1 invariance
 *   9   hardCap 260 -> 400                                  boost is cap-governed
 *  10   boostThrustMul 2.60 -> 1.2                          boost is cap-governed
 *  11   reverseFrac 0.45 -> 0.20                            reverse regression
 *  12   brakeDrag 2.60 -> 0                                 stopping distance
 *  13   verticalFrac 0.50 -> 1.0                            a strafe is not free
 *  14   lateralFrac 0.50 -> 0                               lateral is integrated
 *  15   alignBase 0.45 -> 0                                 LESSON 1 invariance
 *  16   alignThrust 1.55 -> 0.2                             LESSON 1 invariance
 *  17   mouseGain 1.8 -> 3.0                                the virtual stick
 *  18   stickReturn 2.5 -> 0 (never self-centres)           the virtual stick
 *  19   fovCruiseKick 7 -> 0                                camera and FOV
 *  20   fovBoostKick 12 -> 2                                camera and FOV
 *  21   chasePull 9 -> 0                                    camera and FOV
 *  22   boostDrain 30 -> 5                                  the boost tank
 *  23   boostRegenDelay 1.2 -> 0                            the boost tank
 *  24   LESSON 2: accelMul moved onto the thrust term       LESSON 2 ablation
 *  25   LESSON 1: powerMul dropped off the turn gain        LESSON 1 invariance
 *  26   LESSON 1: falloff divides by the UNTIERED top       the ratchet
 *  27   LESSON 1: tumble cap stops scaling with powerMul    the tumble fuzz
 *  28   the anti-tumble clamp removed                       the tumble fuzz
 *  29   rotation composed in the WORLD frame (premultiply)  body-frame composition
 *  30   the hard speed cap removed                          boost is cap-governed
 *  31   the signed alignment target reverted to nose-only   reverse regression
 *  32   the alignment assist removed entirely               LESSON 1 invariance
 *  33   gravity folded INTO the accelMul multiply           gravity is outside
 *  34   the braking dead-stop removed                       a braking ship reaches zero
 *  35   the NaN guard removed                               the NaN guard
 *  36   the un-applied-powers guard removed                 applyPowers is REFUSED
 *  37   pitch sign flipped                                  pitch up raises the nose
 *  38   yaw sign flipped                                    yaw right swings starboard
 *  39   roll sign flipped                                   roll right drops the wing
 *  40   boost no longer requires an open throttle           the boost tank
 *  41   airbrake unbound from KeyX                          the control scheme
 *  42   A/D wired to lateral strafe instead of roll         the control scheme
 *  43   vertical thrust unbound from Space/C                the control scheme
 *  44   mouse pitch no longer inverted                      the virtual stick
 *  45   halt no longer clears the mouse stick               place and halt
 *
 * Mutation 26 is worth a second look by anyone touching the falloff: the ONLY
 * thing that catches it is the ratchet plus the tape-coverage case. The
 * `LESSON 1 ABLATION` case computes that ablation by hand rather than by
 * flying it, precisely because at cruise top - where the invariance case flies
 * - every hull clamps to the same authority and the mutation is invisible.
 */
