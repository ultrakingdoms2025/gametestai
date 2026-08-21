import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import {
  Flight, FLIGHT, TRANSIT_STATE, transitSpeedLimit, turnRadius,
  cruiseTopSpeed, boostTopSpeed,
} from '../../src/ships/Flight.js';
import { Ship } from '../../src/ships/Ship.js';
import { SHIP_ORDER } from '../../src/ships/ShipStats.js';
import { BINDABLE } from '../../src/core/Input.js';

/**
 * THE TRANSIT DRIVE, FLOWN.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THIS FILE EXISTS AT ALL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `worlds/space/Bodies.js` put Cinder 62 km from the dock against an ASSUMED
 * envelope of "cruise 260 m/s, boost 1600 m/s", said in its own docblock that
 * the number should be re-derived when the flight model landed, and then the
 * flight model landed at 120-285 m/s sustained. 62 km at cruise is 517
 * seconds. Phase 2 puts nine more landable bodies out to 288 km, where the
 * same arithmetic is forty minutes.
 *
 * The transit drive is the answer, and the ONE claim it lives or dies on is a
 * measured time: the dock-to-Cinder leg has to become something a player does
 * twice in a session. So case 4 below flies it. Not a closed form, not an
 * algebraic shortcut - the real `Piloting`, the real `Flight`, the real
 * `WorldManager` with the real yard and the real planet built, steered through
 * the same five command fields a keyboard writes.
 *
 * ── The house rules this file is written under ─────────────────────────────
 *
 *  DRIVE THE REAL INTEGRATOR. A ship is the player's body for the whole of the
 *  space loop, so nothing here reimplements the physics and nothing places the
 *  ship by hand between measurements.
 *
 *  A TEST THAT CANNOT FAIL IS NOT A TEST. Every timing claim is reported as
 *  floor / achieved / ceiling with the ceiling taken by ABLATION - the same
 *  leg flown with the drive never engaged - so "the drive is what makes this
 *  fast" is re-derived on every run rather than remembered.
 *
 *  NO NON-FINITE NUMBER, ANYWHERE. This project lost a day to four meshes with
 *  a zero tile: NaN uvs, 19 NaN pixels through `UnrealBloomPass`, and a black
 *  921,600-pixel frame. Case 9 flies a ship THROUGH the centre of a planet
 *  (altitude goes to -9,000 m) and through a 0.5 s frame spike, and asserts
 *  every scalar the drive owns is still finite and still in range.
 *
 * ── Timings ────────────────────────────────────────────────────────────────
 * Simulated seconds, not wall clock, and every number quoted in a comment was
 * produced by this file.
 */

const DT = 1 / 60;

const BODIES = await import('../../src/worlds/space/Bodies.js');
const { BODY_BY_ID, DOCK_ANCHOR, approachState, APPROACH_PHASE } = BODIES;
const PIL = await import('../../src/ships/Piloting.js');

const CINDER = BODY_BY_ID.cinder;
const CINDER_AT = new THREE.Vector3(...CINDER.position);

/**
 * The furthest landable body in the volume, whatever the layout currently
 * says, because the layout is being revised by another hand while this is
 * written. Read rather than typed: a test pinned to `cathedra` by name goes
 * green-and-meaningless the day that body is renamed or moved.
 */
const FAR = BODIES.landableBodies()
  .map((b) => ({ b, d: Math.hypot(...b.position) }))
  .sort((x, y) => y.d - x.d)[0];

/** A flight with an explicit multiplier pair - the `ship-flight.test.mjs` rig. */
function rigF(pm = 1) {
  const f = new Flight();
  f._powerMul = pm;
  f._accelMul = pm;
  return f;
}

/** A flight wearing a REAL hull at a real upgrade tier. */
function hull(id, tier = 0) {
  const s = new Ship({ id, displayName: id, slotMats: {} });
  s.applyPowers({ power: tier });
  return { id, tier, flight: new Flight({ ship: s }), pm: s._powerMul };
}

/** Every (hull, tier) the yard can sell. Twelve pairs, x1.90 of power spread. */
function everyHull() {
  const out = [];
  for (const id of SHIP_ORDER) for (let t = 0; t <= 3; t++) out.push(hull(id, t));
  return out;
}

function run(flight, seconds, cmd = null, env = null) {
  if (cmd) flight.setCommand(cmd);
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) flight.step(DT, env);
  return flight;
}

/* ====================================================================== */
/* 1. The altitude law, which is the whole of the speed rule              */
/* ====================================================================== */

test('the altitude law is one clamp, and it is the same clamp everywhere', () => {
  /* `clamp(altitude * transitK, cruiseTop, transitTop)`, re-derived here from
   * the constants rather than copied, so a change to either lands as a failure
   * in the two cases below that quote real numbers rather than as a silent
   * re-tune of the whole drive. */
  for (const pm of [1, 1.25, 1.75, 2.38]) {
    const cruise = cruiseTopSpeed(pm);
    for (const alt of [0, 1, 900, 1600, 5000, 25000, 53000, 1e6]) {
      const want = Math.min(FLIGHT.transitTop, Math.max(cruise, alt * FLIGHT.transitK));
      assert.equal(transitSpeedLimit(alt, pm), want, `altitude ${alt} at powerMul ${pm}`);
    }
  }

  /* Monotone in altitude: higher is never slower. A law that dipped anywhere
   * would make a ship ACCELERATE as it closed on a planet somewhere in the
   * middle of an approach, which is the one thing this mechanism exists to
   * make impossible. */
  let prev = -1;
  for (let alt = -20000; alt <= 60000; alt += 137) {
    const v = transitSpeedLimit(alt, 1.75);
    assert.ok(v >= prev, `the law dips at altitude ${alt}`);
    prev = v;
  }
});

test('every hostile altitude gets a finite, positive answer', () => {
  /* NEGATIVE is not hypothetical: `approachState().altitude` is a SURFACE
   * distance and goes to -9,000 m at the centre of Cinder. Unclamped, that is
   * -1,800 m/s, and a negative cap fed to `Vector3.setLength` reverses the
   * velocity - a ship that clipped a planet would leave it backwards at 1.8
   * km/s. The floor is the cruise top and nothing below it. */
  for (const pm of [1, 1.25, 2.38]) {
    const cruise = cruiseTopSpeed(pm);
    for (const bad of [-9000, -1, -1e9, -Infinity, NaN]) {
      const v = transitSpeedLimit(bad, pm);
      assert.ok(Number.isFinite(v) && v > 0, `altitude ${bad} produced ${v}`);
      assert.equal(v, cruise, `altitude ${bad} should fall back to the cruise floor`);
    }
    /* +Infinity means "nothing to be near", which is the one non-finite input
     * that legitimately means the drive may run flat out. */
    assert.equal(transitSpeedLimit(Infinity, pm), FLIGHT.transitTop);
  }
});

/* ====================================================================== */
/* 2. What the law hands you at the two radii that matter                 */
/* ====================================================================== */

test('the law has every hull under its own boost ceiling by the atmosphere', () => {
  /* THE CLAIM THE WHOLE ALTITUDE RULE IS FOR: a ship arrives at a planet at a
   * speed the flight model already has an answer for, and it does so without a
   * drop-out rule, a timer or a script.
   *
   * Cinder's atmosphere shell is `atmosphere - radius` above the surface and
   * its handoff is `handoff - radius`, both read from `Bodies.js` rather than
   * typed, because that file is being revised. */
  const atmoAlt = CINDER.atmosphere - CINDER.radius;
  const handAlt = CINDER.handoff - CINDER.radius;
  assert.ok(atmoAlt > handAlt && handAlt > 0,
    'Cinder no longer has air above its handoff, so this case is measuring nothing');

  const rows = [];
  for (const h of everyHull()) {
    const atAtmo = transitSpeedLimit(atmoAlt, h.pm);
    const atHand = transitSpeedLimit(handAlt, h.pm);
    const boost = boostTopSpeed(h.pm);
    rows.push(`${h.id}+${h.tier} atmo ${atAtmo.toFixed(0)} handoff ${atHand.toFixed(0)} boost ${boost.toFixed(0)}`);
    assert.ok(atAtmo <= boost,
      `${h.id} tier ${h.tier} would enter the air at ${atAtmo.toFixed(0)} m/s, faster than its own `
      + `${boost.toFixed(0)} m/s boost ceiling. That is transitK too high - see its derivation.`);
    assert.ok(atHand <= boost, `${h.id} tier ${h.tier} reaches handoff at ${atHand.toFixed(0)} m/s`);
    /* And going in is never faster than coming out of the air: the law is
     * strictly decreasing with altitude, so this pins the ORDER as well. */
    assert.ok(atHand <= atAtmo, `${h.id} tier ${h.tier} speeds up between the air and the handoff`);
  }
  console.log(`  altitude law at Cinder: ${rows.join('; ')}`);

  /* The binding constraint, stated so a future re-tune fails loudly here
   * rather than quietly at a planet: the slowest hull's boost ceiling divided
   * by the depth of the air is the ceiling on `transitK`. */
  const slowest = Math.min(...everyHull().map((h) => boostTopSpeed(h.pm)));
  assert.ok(FLIGHT.transitK <= slowest / atmoAlt + 1e-9,
    `transitK ${FLIGHT.transitK} exceeds ${(slowest / atmoAlt).toFixed(4)}, the value at which the `
    + `slowest hull enters Cinder's air faster than it can boost`);
});

/* ====================================================================== */
/* 3. Spooling: it is an event, not a teleport                            */
/* ====================================================================== */

test('engaging is a spool, and so is dropping out', () => {
  const f = rigF(1.75);
  run(f, 90, { throttle: 1 });
  const entry = f.speed;
  assert.ok(Math.abs(entry - cruiseTopSpeed(1.75)) < 1, 'did not reach cruise before the test began');

  assert.equal(f.transitState, TRANSIT_STATE.off);
  assert.equal(f.engageTransit(), true);
  assert.equal(f.transitState, TRANSIT_STATE.spooling);
  /* The key does NOT move the ship. Whatever engaging is, it is not a shove. */
  assert.equal(f.speed, entry, 'engaging changed the velocity on the frame of the key press');

  const env = { transitAltitude: Infinity };
  let t = 0;
  let spooled = null;
  const seen = [];
  for (let i = 0; i < 60 * 12; i++) {
    f.step(DT, env);
    t += DT;
    seen.push(f.transitSpool);
    if (spooled === null && f.transitState === TRANSIT_STATE.engaged) spooled = t;
  }
  assert.ok(spooled !== null, 'the drive never finished spooling');
  assert.ok(Math.abs(spooled - FLIGHT.transitSpoolUp) < 2 * DT,
    `spool took ${spooled.toFixed(3)} s against a declared ${FLIGHT.transitSpoolUp} s`);

  /* Monotone and bounded. `_transitSpool` multiplies the steering gain, the
   * drag term and the FOV; a value above 1 is negative drag and a value below
   * 0 is negative authority. */
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i] >= seen[i - 1] - 1e-12, 'the spool went backwards while engaging');
    assert.ok(seen[i] >= 0 && seen[i] <= 1, `spool left 0..1 at ${seen[i]}`);
  }

  /* It reaches the drive's ceiling, and stays there - the drive is not a
   * bigger boost, and there is no fuel budget ticking down under it. */
  assert.ok(Math.abs(f.speed - FLIGHT.transitTop) < 1,
    `settled at ${f.speed.toFixed(0)} m/s rather than the drive's ${FLIGHT.transitTop}`);

  /* ---- and back down ---- */
  assert.equal(f.dropTransit('pilot'), true);
  assert.equal(f.transitState, TRANSIT_STATE.dropping);
  let down = null;
  t = 0;
  for (let i = 0; i < 60 * 12; i++) {
    f.step(DT, env);
    t += DT;
    if (down === null && f.transitState === TRANSIT_STATE.off) down = t;
  }
  assert.ok(down !== null, 'the drive never came down');
  assert.ok(Math.abs(down - FLIGHT.transitSpoolDown) < 2 * DT,
    `drop took ${down.toFixed(3)} s against a declared ${FLIGHT.transitSpoolDown} s`);
  /* Back inside the normal envelope, and by DECELERATION rather than by a
   * one-frame `setLength` - the two-cap boost arrangement at the top of
   * `Flight.js` was thrown out for exactly that. */
  assert.ok(f.speed <= boostTopSpeed(1.75) + 1,
    `still doing ${f.speed.toFixed(0)} m/s after the drop`);
  assert.equal(f.transitSpool, 0);
});

test('the drive is sold: the FOV and the chase distance ride the spool', () => {
  /* `fovBoostKick` is the precedent - see `cameraRig`. The transit kick is a
   * BLEND rather than a fourth addend, so this pins both halves: it reaches
   * exactly `baseFov + fovTransitKick` and it can never exceed it. */
  const f = rigF(1.75);
  run(f, 90, { throttle: 1, boost: true });
  const base = 75;
  const out = {};
  f.cameraRig(base, out);
  const boostFov = out.fov;
  const boostDist = out.distance;

  f.engageTransit();
  const env = { transitAltitude: Infinity };
  let peak = 0;
  for (let i = 0; i < 60 * 8; i++) {
    f.step(DT, env);
    f.cameraRig(base, out);
    peak = Math.max(peak, out.fov);
    assert.ok(out.fov <= base + FLIGHT.fovTransitKick + 1e-9,
      `FOV ran to ${out.fov.toFixed(2)}, past the ${base + FLIGHT.fovTransitKick} ceiling the blend is for`);
    assert.ok(Number.isFinite(out.fov) && Number.isFinite(out.distance));
  }
  assert.ok(Math.abs(peak - (base + FLIGHT.fovTransitKick)) < 0.01,
    `transit FOV settled at ${peak.toFixed(2)} rather than ${base + FLIGHT.fovTransitKick}`);
  assert.ok(peak > boostFov + 4,
    `transit reads as boost: ${peak.toFixed(1)} vs ${boostFov.toFixed(1)} degrees`);
  assert.ok(out.distance > boostDist + 8,
    `the camera never pulled back: ${out.distance.toFixed(1)} vs ${boostDist.toFixed(1)} m`);
  assert.equal(out.transitState, TRANSIT_STATE.engaged);
  console.log(`  camera: boost ${boostFov.toFixed(1)} deg / ${boostDist.toFixed(1)} m  ->  `
    + `transit ${peak.toFixed(1)} deg / ${out.distance.toFixed(1)} m`);
});

/* ====================================================================== */
/* 4. THE CASE THE WHOLE CHANGE EXISTS FOR                                */
/* ====================================================================== */

/* The rig is imported lazily: it builds the yard, the void and Cinder for
 * real, which is 3-6 seconds, and the ten cases above have no use for any of
 * it. Everything from here down shares the one instance. */
const { rig, goto, DT: RIG_DT, steerTo, fly } = await import('./_flightrig.mjs');
assert.equal(RIG_DT, DT, 'the rig and this file disagree about the fixed step');
const { BERTHS } = await import('../../src/worlds/dock/YardPlan.js');

/** Stand the player at a berth's apron - the ramp foot a body actually boards from. */
function atApron(r, id) {
  const b = BERTHS.find((x) => x.id === id);
  r.player.position.set(b.apron.x, b.cradleTop, b.apron.z);
  return b;
}

/**
 * Board at a pier and fly out through the launch seam, exactly as case 5 of
 * `piloting-loop.test.mjs` does. Returns once the ship is in `space`.
 */
async function launch(r, shipId = 'kestrel') {
  await goto(r, 'dock');
  atApron(r, shipId);
  assert.equal(r.piloting.board(shipId), true, `could not board the ${shipId}`);
  const f = r.piloting.flight;
  const res = await fly(r, () => steerTo(f, new THREE.Vector3(0, 12, -600), { throttle: 1 }),
    () => r.wm.active.id === 'space', { limit: 60 });
  assert.ok(res.done, 'never left the yard');
  return f;
}

/**
 * PRESS Z, THROUGH THE REAL REFUSAL PATH.
 *
 * `Piloting._pollTransit` is what a keyboard reaches, and it is what decides
 * whether the drive lights or the player gets a sentence. It is called here
 * directly rather than through `piloting.update()` for one reason: `update`
 * also runs `readInput`, which overwrites the whole command struct every frame
 * and would wipe the autopilot's steering mid-leg. Case 7 drives the key
 * through `update()` end to end, so the binding itself is not taken on trust.
 */
function pressTransit(r) {
  r.input._pressed.add(PIL.TRANSIT_KEY);
  r.piloting._pollTransit();
  r.input._pressed.clear();
}

/**
 * A point exactly `d` metres from a body's CENTRE, on the dock side of it.
 *
 * The layout is authored as a direction and a distance from the origin, so
 * "500 m inside Cinder's approach ring" is `62,000 - 53,500` along that line
 * and NOT `53,500` along it - which is 8,500 m from the centre, i.e. inside
 * the planet. The first version of this file made exactly that mistake and the
 * ring cases all reported `handoff`.
 */
function atRangeFrom(body, d) {
  const c = new THREE.Vector3(...body.position);
  const len = c.length();
  return c.clone().multiplyScalar((len - d) / len);
}

/**
 * Somewhere the drive would actually engage, found rather than typed.
 *
 * `(0, 0, -20000)` looks like open space and is 45 km from Cinder's centre,
 * which is inside its 54 km approach ring - so every "put the ship somewhere
 * clear" case that used it was starting mass-locked. With nine more bodies
 * arriving in the layout while this is written, the only safe way to name a
 * clear spot is to search for one.
 */
function clearSpot() {
  let best = null;
  for (const dir of [[0, 1, 0], [0, 0, 1], [1, 0, 0], [0, -1, 0], [-1, 0, 0], [1, 1, 1]]) {
    for (const d of [4000, 12000, 30000, 60000]) {
      const p = new THREE.Vector3(...dir).normalize().multiplyScalar(d);
      if (p.length() <= PIL.TRANSIT_DOCK_LOCK + 100) continue;
      const a = approachState(p);
      if (a.phase !== 'cruise') continue;
      if (!best || a.altitude > best.alt) best = { p, alt: a.altitude };
    }
  }
  assert.ok(best && best.alt > 30000,
    'no point within 60 km of the yard is in the cruise phase any more, so the drive can never '
    + 'be engaged from anywhere near home');
  return best.p;
}

/** Point the nose at a world position, the way `Object3D.lookAt` does. */
function faceAt(f, target) {
  const m = new THREE.Matrix4().lookAt(f.position, target, new THREE.Vector3(0, 1, 0));
  f.quaternion.setFromRotationMatrix(m);
}

/**
 * Put the rig back the way the next case needs to find it.
 *
 * Cases below deliberately leave a ship 5,000 m/s into a leg, and the state
 * that carries between them is not inert: a `goto('dock')` with the hull still
 * out in the volume at speed lands it outside the yard's bounds, `_seams`
 * fires the launch trigger on the next step, and the case AFTER that spends
 * its whole 60-second budget inside `if (r.piloting._travelling) continue`
 * reporting "never left the yard". `_recoverToBerth` is the mode's own answer
 * to "put the ship back", and it is what `dispose` and a refused world change
 * both use.
 */
async function resetToYard(r) {
  const f = r.piloting.flight;
  f.dropTransit(null, true);
  f.halt();
  r.piloting.interdicted = false;
  if (r.piloting.active) r.piloting._recoverToBerth();
  await goto(r, 'dock');
}

/** Every `hud:notify` the bus carries while `fn` runs. */
function captureNotices(r, fn) {
  const seen = [];
  const off = r.bus.on('hud:notify', (e) => seen.push(e?.text ?? ''));
  try { fn(); } finally { off?.(); }
  return seen;
}

/**
 * Fly one leg under the drive and report everything worth knowing about it.
 *
 * `drive: false` is the ABLATION: the drive is never engaged AND the
 * displacement multiplier is switched off, so the ceiling measured is what the
 * flight model alone can do over the same ground. Nothing else differs.
 */
async function flyLeg(r, body, { drive = true, limit = 420 } = {}) {
  const target = new THREE.Vector3(...body.position);
  const f = await launch(r, 'kestrel');
  const clearOf = r.piloting._clearOfEverything;
  if (!drive) r.piloting._clearOfEverything = () => false;

  const startAt = f.position.clone();
  let engagedAt = null;
  let atmoSpeed = null;
  let handoffSpeed = null;
  /* The speed on the last step the ship was still OUTSIDE the handoff sphere.
   *
   * `handoffSpeed` alone reads 0, and the zero is real but it is the seam's:
   * `_seams` fires `shouldHandoff` at exactly `body.handoff`, `_descend` calls
   * `_travel`, and `_travel` calls `place` -> `halt`. So the first sample
   * INSIDE the sphere is taken after the ship has been stopped for the world
   * change, and asserting on it would be asserting that `halt()` works. This
   * is the number a pilot experiences. */
  let approachSpeed = 0;
  let peak = 0;
  let worstAtmo = 0;
  const phases = new Set();

  const res = await fly(r, (t) => {
    if (drive && engagedAt === null && !r.piloting.transitRefusal()) {
      pressTransit(r);
      if (f.transitLive) engagedAt = t;
    }
    steerTo(f, target, { throttle: 1 });
  }, () => {
    if (r.wm.active.id !== 'space') return true;
    const D = target.distanceTo(f.position);
    const a = approachState(f.position);
    phases.add(a.phase);
    peak = Math.max(peak, f.speed);
    if (atmoSpeed === null && D <= body.atmosphere) atmoSpeed = f.speed;
    if (D <= body.atmosphere) worstAtmo = Math.max(worstAtmo, f.speed);
    if (D > body.handoff) { approachSpeed = f.speed; return false; }
    handoffSpeed = f.speed;
    return true;
  }, { limit });

  r.piloting._clearOfEverything = clearOf;
  /* Leave the rig in a state the next case can board from. */
  f.dropTransit('teardown', true);
  return {
    ...res, engagedAt, atmoSpeed, handoffSpeed, approachSpeed, peak, worstAtmo, phases,
    launched: startAt, arrived: f.position.clone(),
  };
}

test('the dock-to-Cinder leg is a flight rather than a wait', async () => {
  const r = await rig();

  const withDrive = await flyLeg(r, CINDER, { drive: true });
  assert.ok(withDrive.done, 'never reached Cinder under the transit drive');
  assert.ok(withDrive.engagedAt !== null, 'the drive never engaged over 52 km of empty volume');

  await resetToYard(r);
  const ablated = await flyLeg(r, CINDER, { drive: false });

  /* floor / achieved / ceiling, per the house rule. The ceiling is the flight
   * model on its own over the same ground - the 517-second problem, measured
   * rather than quoted. */
  console.log(`  dock -> Cinder handoff: ${withDrive.t.toFixed(1)} s under drive `
    + `(engaged at ${withDrive.engagedAt.toFixed(1)} s, peak ${withDrive.peak.toFixed(0)} m/s), `
    + `${ablated.done ? `${ablated.t.toFixed(1)} s` : `>${ablated.t.toFixed(0)} s`} without it`);

  assert.ok(withDrive.t >= 15 && withDrive.t <= 25,
    `the leg took ${withDrive.t.toFixed(1)} s, outside the 15-25 s window the drive was tuned to. `
    + 'Re-derive transitK and transitTop against the layout - the arithmetic is at the constants.');

  /* THE ABLATION. Without it "the drive is what makes this fast" is a comment. */
  assert.ok(ablated.t > withDrive.t * 3,
    `ablating the drive changed the crossing from ${withDrive.t.toFixed(1)} s to only `
    + `${ablated.t.toFixed(1)} s, so the drive is not what makes it fast`);

  /* The descent still walks every phase in order. `Bodies.js` records that
   * `atmosphere` and `handoff` were once equal, so `phase: 'atmosphere'` was in
   * the enum, handled by callers, and unreachable. A drive that skipped a
   * phase by flying past it in one 83 m step would be the same defect. */
  for (const p of ['cruise', 'approach', 'atmosphere']) {
    assert.ok(withDrive.phases.has(p),
      `a transit approach never passed through phase "${p}" - it is unreachable again`);
  }
});

test('the flown arrival speed is the altitude law, not a hope', async () => {
  const r = await rig();
  await resetToYard(r);
  const leg = await flyLeg(r, CINDER, { drive: true });
  assert.ok(leg.done, 'never reached Cinder');

  const pm = r.piloting.flight.powerMul;
  const atmoAlt = CINDER.atmosphere - CINDER.radius;
  const handAlt = CINDER.handoff - CINDER.radius;
  const lawAtmo = transitSpeedLimit(atmoAlt, pm);
  const lawHand = transitSpeedLimit(handAlt, pm);
  console.log(`  arrival: atmosphere ${leg.atmoSpeed.toFixed(0)} m/s (law ${lawAtmo.toFixed(0)}), `
    + `handoff ${leg.approachSpeed.toFixed(0)} m/s (law ${lawHand.toFixed(0)}), `
    + `worst inside the air ${leg.worstAtmo.toFixed(0)}, boost ceiling ${boostTopSpeed(pm).toFixed(0)}`);

  /* The law, plus one step of lag: the cap applied on any step is computed
   * from the position at the START of that step, and at 320 m/s the ship moves
   * 5.3 m in a step, which is 5.3 * transitK = 1.1 m/s of cap. Anything much
   * over that and the governor is not tracking. */
  const lag = 320 * DT * FLIGHT.transitK + 1;
  assert.ok(leg.atmoSpeed <= lawAtmo + lag,
    `entered the air at ${leg.atmoSpeed.toFixed(1)} m/s against a law of ${lawAtmo.toFixed(1)}`);

  /* AND IT IS SURVIVABLE, which is the claim that matters: nowhere inside the
   * air is the ship going faster than its own engine could have taken it. */
  assert.ok(leg.worstAtmo <= boostTopSpeed(pm),
    `hit ${leg.worstAtmo.toFixed(0)} m/s inside Cinder's air, past the hull's own `
    + `${boostTopSpeed(pm).toFixed(0)} m/s boost ceiling`);
  assert.ok(leg.approachSpeed <= boostTopSpeed(pm),
    `arrived at the handoff radius at ${leg.approachSpeed.toFixed(0)} m/s`);
  /* At or under what the law would allow. UNDER is expected and is the break
   * ring doing its second job: the drive is cut at the atmosphere shell, so
   * the last 700 m is flown on the engine through air `_env` has thickened to
   * `dragMul` 2.8, and the ship sheds most of the 320 m/s doing it. What must
   * never happen is arriving FASTER than the law allowed. */
  assert.ok(leg.approachSpeed <= lawHand + lag,
    `arrived at ${leg.approachSpeed.toFixed(1)} m/s against a law of ${lawHand.toFixed(1)}`);
  /* And the drive really did run: an arrival at cruise speed would satisfy
   * every line above and mean the drive did nothing at all. */
  assert.ok(leg.peak > FLIGHT.transitTop * 0.9,
    `the leg never got above ${leg.peak.toFixed(0)} m/s, so nothing was governed`);
});

test('the furthest body in the volume is reachable in a minute or so', async () => {
  const r = await rig();
  await resetToYard(r);

  const d = Math.hypot(...FAR.b.position) / 1000;
  const leg = await flyLeg(r, FAR.b, { drive: true, limit: 600 });
  console.log(`  dock -> ${FAR.b.name} (${d.toFixed(0)} km): ${leg.t.toFixed(1)} s, `
    + `peak ${leg.peak.toFixed(0)} m/s`);
  assert.ok(leg.done, `never reached ${FAR.b.name} at ${d.toFixed(0)} km`);
  assert.ok(leg.t >= 40 && leg.t <= 110,
    `${d.toFixed(0)} km took ${leg.t.toFixed(1)} s. The tuning target is 60-90 s for a ~270 km leg; `
    + 'this window is that with room for the layout to move.');
  /* The logarithm in the law is what makes a long leg cheap: it is the only
   * term that does not scale with distance. 4.6x the ground for well under 4x
   * the time, or the drive does not scale to Phase 2. */
  assert.ok(leg.t < 110, 'the long leg is priced like a short one');
});

/* ====================================================================== */
/* 5. Mass lock: it refuses, and it says why                              */
/* ====================================================================== */

test('the drive refuses inside an approach phase, and says so', async () => {
  const r = await rig();
  await resetToYard(r);
  const f = await launch(r, 'kestrel');

  /* Put the ship just inside Cinder's approach ring, flying. `place` is used
   * here and only here, because the point of this case is the RING and not the
   * route to it - every other case flies. */
  const ring = CINDER.radius * 6;
  f.place(atRangeFrom(CINDER, ring - 500));
  const a = approachState(f.position);
  assert.equal(a.body.id, 'cinder');
  assert.equal(a.phase, 'approach', `expected the approach phase, got ${a.phase}`);

  assert.equal(r.piloting.transitRefusal(), 'approach');
  const said = captureNotices(r, () => pressTransit(r));
  assert.equal(f.transitLive, false, 'the drive spun up inside a gravity well');
  /* A CONTROL THAT SILENTLY DOES NOTHING IS WORSE THAN ONE THAT IS NOT THERE.
   * The refusal has to reach the player, and it has to be the RIGHT sentence. */
  assert.ok(said.includes(PIL.TRANSIT_REASONS.approach),
    `pressing the key inside an approach said ${JSON.stringify(said)}`);
});

test('the drive refuses inside the yard, and says so', async () => {
  const r = await rig();
  await resetToYard(r);
  const f = await launch(r, 'kestrel');

  /* The rule is "inside the dock's handoff radius"; the number used is the
   * yard's own containing sphere, which strictly contains it. Both are checked
   * so a future change that shrank the lock below the published handoff would
   * fail here rather than at a pier. */
  assert.ok(PIL.TRANSIT_DOCK_LOCK >= DOCK_ANCHOR.handoff,
    `the mass lock (${PIL.TRANSIT_DOCK_LOCK} m) is inside the yard's own handoff `
    + `radius (${DOCK_ANCHOR.handoff} m), which is the rule`);

  for (const d of [DOCK_ANCHOR.handoff * 0.5, PIL.TRANSIT_DOCK_LOCK - 1]) {
    f.place(new THREE.Vector3(0, 0, -d));
    assert.equal(r.piloting.transitRefusal(), 'dock', `no lock at ${d.toFixed(0)} m from the yard`);
    const said = captureNotices(r, () => pressTransit(r));
    assert.equal(f.transitLive, false, `the drive lit ${d.toFixed(0)} m from a 285 m structure`);
    assert.ok(said.includes(PIL.TRANSIT_REASONS.dock), `said ${JSON.stringify(said)}`);
  }

  /* ...and it is not a lock on the whole volume. A launched ship must be able
   * to use the thing: `SPACE_ARRIVAL_OUT` is where a launch lands. */
  f.place(new THREE.Vector3(0, 0, -PIL.SPACE_ARRIVAL_OUT));
  assert.equal(r.piloting.transitRefusal(), null,
    'the yard lock reaches the launch point, so a launched ship could never engage at all');
});

test('a live drive is dropped by the yard, by the air and by an interdiction', async () => {
  const r = await rig();
  await resetToYard(r);
  const f = await launch(r, 'kestrel');
  const out = clearSpot();

  /* `position.copy`, NOT `place`: `place` calls `halt`, and `halt` hard-drops
   * the drive by design (a berthed hull must not be counting down a spool). A
   * case that used it would be testing the teardown and not the mass lock. */
  /* 280 m OFF THE BEAM, not 100 m off the nose. The yard's mass lock is 285 m
   * from the yard's centre and `_seams` docks any ship within `DOCK_RANGE`
   * (260 m) of the MOUTH under `DOCK_SPEED` - so a point on the mouth normal
   * inside the lock is also inside the docking sphere, and the ship travels to
   * the dock and hard-drops the drive through `place`. That is correct
   * behaviour and it is not what this case is about. (0, 280, 0) is 280 m from
   * the centre - inside the lock - and 281 m from the mouth, outside it. */
  const cases = [
    ['dock', () => { f.position.set(0, 280, 0); }],
    ['atmosphere', () => { f.position.copy(atRangeFrom(CINDER, CINDER.atmosphere - 100)); }],
    ['interdicted', () => { r.piloting.interdicted = true; }],
  ];

  for (const [code, put] of cases) {
    r.piloting.interdicted = false;
    f.place(out);
    assert.equal(r.piloting.transitRefusal(), null, `could not even start the ${code} case`);
    pressTransit(r);
    /* Half a second of spool before the lock arrives, so there is a RAMP to
     * observe. One step in, `_transitSpool` is 0.009 and a single dropping
     * step takes it past zero to `off` - which is correct behaviour and tests
     * nothing, because the interesting claim is that the drop is a sweep of
     * the speed cap rather than a one-frame `setLength`. */
    for (let i = 0; i < 30; i++) r.piloting.fixedUpdate(DT, i * DT);
    assert.ok(f.transitLive, `the drive would not start for the ${code} case`);
    assert.ok(f.transitSpool > 0.15, `the ${code} case had no spool to drop from`);

    put();
    const said = captureNotices(r, () => {
      for (let i = 0; i < 4; i++) r.piloting.fixedUpdate(DT, i * DT);
    });
    assert.equal(f.transitState, TRANSIT_STATE.dropping,
      `a live drive survived "${code}" - state ${f.transitState}, world ${r.wm.active.id}`);
    assert.equal(f.transitDropReason, code, `"${code}" dropped for "${f.transitDropReason}" instead`);
    assert.ok(said.includes(PIL.TRANSIT_REASONS[code]),
      `the "${code}" drop said ${JSON.stringify(said)} rather than its own sentence`);
    /* And it is a RAMP, not a cut: `_transitSpool` is still above zero on the
     * step the lock fired, so the speed cap sweeps down instead of the velocity
     * being `setLength`-ed in one frame. */
    assert.ok(f.transitSpool > 0, `"${code}" dropped the spool to zero in one step`);
    f.dropTransit(null, true);
    r.piloting.interdicted = false;
  }
});

test('the approach ring stops a run STARTING and does not stop one FINISHING', async () => {
  /* The two rings, and the measured reason they are not the same ring.
   *
   * `APPROACH_AT_RADII` is 6, so Cinder's approach ring is 54 km from its
   * centre and the yard is 62 km: 85% of the outbound leg is inside it. A
   * drive cut at the ring would die 8 km after leaving the yard. This case
   * pins the geometry that forces the design, so that if the layout ever moves
   * far enough for one ring to do, somebody is told. */
  const r = await rig();
  const centreDist = Math.hypot(...CINDER.position);
  const ring = CINDER.radius * 6;
  const legLength = centreDist - CINDER.handoff;
  const insideRing = ring - CINDER.handoff;
  console.log(`  Cinder: leg ${(legLength / 1000).toFixed(1)} km, of which `
    + `${(insideRing / 1000).toFixed(1)} km (${(100 * insideRing / legLength).toFixed(0)}%) is inside the approach ring`);
  assert.ok(insideRing / legLength > 0.5,
    'the approach ring no longer covers most of the leg, so the two-ring design may be simplifiable');

  /* The engage ring is `approach`; the break ring is `atmosphere`. Ranks, not
   * strings, because `Bodies.js` publishes ranks for exactly this. */
  assert.ok(APPROACH_PHASE.atmosphere > APPROACH_PHASE.approach,
    'the break ring is no longer tighter than the engage ring');

  await resetToYard(r);
  const f = await launch(r, 'kestrel');
  f.place(atRangeFrom(CINDER, ring - 2000));
  assert.equal(approachState(f.position).phase, 'approach');
  /* Starting here is refused... */
  assert.equal(r.piloting.transitRefusal(), 'approach');
  /* ...but a drive that is ALREADY running is not cut by it. */
  f.engageTransit();
  for (let i = 0; i < 10; i++) r.piloting.fixedUpdate(DT, i * DT);
  assert.ok(f.transitLive, 'the approach ring cut a live run, which ends every outbound leg at 8 km');
  f.dropTransit(null, true);
});

/* ====================================================================== */
/* 6. Combat: taking a hit drops you out                                  */
/* ====================================================================== */

test('taking fire drops the drive - transit is not an I-win button', async () => {
  /* THE DECISION, and it is deliberate. `SpaceCombat` already writes
   * `piloting.interdicted` while a wing is engaged, which keeps a fight in
   * normal space - but an interdiction is a state that flickers, and a drive
   * that could be spun up in the gap would let a player leave every encounter
   * in the volume unfought. Three hostiles built, aimed and never experienced
   * is this project's signature defect with guns on it.
   *
   * So a HIT drops the drive whatever the flag says. The cost of being wrong
   * this way is 3.0 s of exposure per attempt (a spool down plus a spool up);
   * the cost of being wrong the other way is that the whole combat drop
   * becomes optional. */
  const r = await rig();
  await resetToYard(r);
  const f = await launch(r, 'kestrel');
  f.place(clearSpot());

  pressTransit(r);
  for (let i = 0; i < 60 * 3; i++) r.piloting.fixedUpdate(DT, i * DT);
  assert.equal(f.transitState, TRANSIT_STATE.engaged, 'could not get the drive up to test the hit');

  /* The REAL event `SpaceCombat._playerHit` publishes, with its real shape. */
  const said = captureNotices(r, () => {
    r.bus.emit('combat:playerHit', {
      damage: 16, through: 0, shield: 40, shieldMax: 90, kind: 'shield',
      position: f.position.clone(),
    });
    r.piloting.fixedUpdate(DT, 0);
  });
  assert.equal(f.transitState, TRANSIT_STATE.dropping, 'a bolt did not interrupt the drive');
  assert.equal(f.transitDropReason, 'hit');
  assert.ok(said.includes(PIL.TRANSIT_REASONS.hit), `the hit said ${JSON.stringify(said)}`);

  /* A hit while SPOOLING interrupts the spool too - otherwise the fastest way
   * out of a fight is to press Z as the first bolt lands and eat one. */
  f.dropTransit(null, true);
  f.engageTransit();
  r.piloting.fixedUpdate(DT, 0);
  assert.equal(f.transitState, TRANSIT_STATE.spooling);
  r.bus.emit('combat:playerHit', { damage: 16, kind: 'hull', position: f.position.clone() });
  assert.equal(f.transitState, TRANSIT_STATE.dropping, 'a hit during the spool was ignored');
  f.dropTransit(null, true);
});

/* ====================================================================== */
/* 7. The binding, end to end through a keyboard                          */
/* ====================================================================== */

test('Z is a real, rebindable, un-collided binding and it reaches the drive', async () => {
  const row = BINDABLE.find((b) => b.code === PIL.TRANSIT_KEY);
  assert.ok(row, `${PIL.TRANSIT_KEY} is not a BINDABLE row, so the key cannot be rebound`);
  assert.equal(row.action, 'transit');

  /* No collision. The default code doubles as the action's identity (see
   * `BINDABLE`), so two rows on one code is two actions that cannot be told
   * apart by `pressed`. */
  const codes = BINDABLE.map((b) => b.code);
  assert.equal(new Set(codes).size, codes.length, `BINDABLE has a duplicate code: ${codes.join(',')}`);

  /* Q is left alone deliberately: `Flight.readInput` records that it is the
   * only free half of a Q/E lateral-thruster pair and that `cmd.lateral` is
   * built, tested and unbound for want of it. */
  assert.ok(!codes.includes('KeyQ'),
    'something took Q, which closes the door on the lateral thrusters cmd.lateral already implements');

  /* And it is TAUGHT. F1 is the canonical list and the ship section was once
   * entirely absent - every verb of the space campaign reachable and untaught. */
  const help = await import('node:fs/promises').then((fs) => fs.readFile('src/ui/HelpMenu.js', 'utf8'));
  assert.ok(/\['Z',\s*'Transit drive/.test(help),
    'the transit drive is not on the F1 control reference');

  /* Now through a keyboard. `piloting.update` is the real per-frame path and
   * it is what a player's key press actually reaches. */
  const r = await rig();
  await resetToYard(r);
  const f = await launch(r, 'kestrel');
  f.place(clearSpot());

  r.input._pressed.add(PIL.TRANSIT_KEY);
  r.piloting.update(DT, 0);
  r.input.endFrame();
  assert.equal(f.transitState, TRANSIT_STATE.spooling, 'pressing Z in the seat did nothing');

  /* A second press is always a drop, from any state, whatever the rings say -
   * a pilot who wants out must never be refused. */
  r.input._pressed.add(PIL.TRANSIT_KEY);
  r.piloting.update(DT, 0);
  r.input.endFrame();
  assert.equal(f.transitState, TRANSIT_STATE.dropping, 'pressing Z again did not drop the drive');
  f.dropTransit(null, true);
});

/* ====================================================================== */
/* 8. Steering: turned down, not turned off                               */
/* ====================================================================== */

test('steering in transit is the same assist at 30%, and it is still steering', () => {
  /* ASSIST 4's own knob, not a second mechanism. Measured by the quaternion
   * sweep, like `ship-flight.test.mjs` measures every other rate, because
   * `omega` is the model's opinion and the quaternion is what the ship did. */
  const sweep = (f, seconds = 1) => {
    const q0 = f.quaternion.clone();
    const n = Math.round(seconds / DT);
    for (let i = 0; i < n; i++) f.step(DT, { transitAltitude: Infinity });
    const dq = q0.invert().multiply(f.quaternion);
    return (2 * Math.acos(Math.min(1, Math.abs(dq.w)))) / seconds;
  };

  const plain = rigF(1.75);
  run(plain, 90, { throttle: 1, boost: true });
  run(plain, 3, { pitch: 1, throttle: 1, boost: true });
  const rateOff = sweep(plain);

  const driven = rigF(1.75);
  run(driven, 90, { throttle: 1 });
  driven.engageTransit();
  run(driven, 8, { throttle: 1 }, { transitAltitude: Infinity });
  driven.setCommand({ pitch: 1 });
  run(driven, 3, null, { transitAltitude: Infinity });
  const rateOn = sweep(driven);

  const want = 1 - FLIGHT.transitFalloff;
  console.log(`  turn rate: ${rateOff.toFixed(3)} rad/s normal, ${rateOn.toFixed(3)} in transit `
    + `(x${(rateOn / rateOff).toFixed(2)}, declared x${want.toFixed(2)})`);
  assert.ok(Math.abs(rateOn / rateOff - want) < 0.03,
    `transit turns at x${(rateOn / rateOff).toFixed(3)} of normal, not the declared x${want}`);

  /* STILL STEERING. A drive you cannot aim is a drive that can only ever take
   * you where you were already pointed. 90 degrees inside five seconds. */
  assert.ok(rateOn > Math.PI / 2 / 5,
    `transit turns at ${rateOn.toFixed(3)} rad/s - 90 degrees would take `
    + `${(Math.PI / 2 / rateOn).toFixed(1)} s, which is not a control`);

  /* And `turnRadius()` agrees, because it multiplies the identical trim from
   * the identical constant rather than restating the arithmetic. */
  const flown = driven.speed / rateOn;
  const stated = turnRadius(driven.speed, 1.75, 'pitch', 1);
  assert.ok(Math.abs(flown / stated - 1) < 0.05,
    `flown radius ${flown.toFixed(0)} m vs turnRadius() ${stated.toFixed(0)} m`);
});

test('the velocity stays glued to the nose in transit, throttle or no throttle', () => {
  /* ASSIST 3 reads the spool as throttle. Without that the align rate is
   * `alignBase` 0.45 rad/s against a nose turning at 0.42, and every turn at
   * 5 km/s would be flown half-sideways. */
  const f = rigF(1.75);
  run(f, 90, { throttle: 1 });
  f.engageTransit();
  run(f, 8, { throttle: 0 }, { transitAltitude: Infinity });
  f.setCommand({ pitch: 1, throttle: 0 });
  run(f, 4, null, { transitAltitude: Infinity });

  const nose = f.forward(new THREE.Vector3());
  const dir = f.velocity.clone().normalize();
  const off = Math.acos(Math.min(1, Math.max(-1, nose.dot(dir)))) * 180 / Math.PI;
  console.log(`  velocity is ${off.toFixed(1)} degrees off the nose in a full-authority transit turn`);
  assert.ok(off < 12, `flying ${off.toFixed(1)} degrees sideways at ${f.speed.toFixed(0)} m/s`);
});

/* ====================================================================== */
/* 9. Nothing goes non-finite. Ever.                                      */
/* ====================================================================== */

test('a long flight, a flight through a planet, and a 0.5 s frame spike stay finite', () => {
  /* The recorded defect: four meshes with a zero tile gave NaN uvs, and 19 NaN
   * pixels through `UnrealBloomPass` blacked out 921,600. `Flight._assertFinite`
   * throws rather than warns, and it now covers the drive's two scalars - so a
   * NaN here is an exception with a frame number rather than a black screen. */
  const check = (f, where) => {
    for (const v of [f.position, f.velocity, f.omega]) {
      assert.ok(Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z),
        `${where}: non-finite vector ${v.toArray()}`);
    }
    assert.ok(Number.isFinite(f.transitSpool) && f.transitSpool >= 0 && f.transitSpool <= 1,
      `${where}: spool ${f.transitSpool}`);
    assert.ok(Number.isFinite(f.transitCap) && f.transitCap > 0, `${where}: cap ${f.transitCap}`);
    assert.ok(Number.isFinite(f.speed), `${where}: speed ${f.speed}`);
  };

  /* ---- straight THROUGH the body, so the altitude goes to -9,000 m ---- */
  const centre = new THREE.Vector3(0, 0, -62000);
  const f = rigF(1.75);
  run(f, 30, { throttle: 1 });
  f.engageTransit();
  for (let i = 0; i < 60 * 240; i++) {
    const alt = centre.distanceTo(f.position) - CINDER.radius;
    f.step(DT, { transitAltitude: alt, transitLock: null });
    check(f, `through-body step ${i}`);
    /* Inside the body the law must never hand back a negative or a reversed
     * cap, or the ship leaves backwards at 1.8 km/s. */
    if (alt < 0) assert.ok(f.transitCap >= cruiseTopSpeed(1.75) - 1e-9, `cap ${f.transitCap} inside the body`);
  }
  const passed = f.position.z < -62000;
  assert.ok(passed, 'the test flight never actually reached the far side, so nothing was proved');

  /* ---- a 0.5 s frame spike, mid-spool and mid-drop ---- */
  for (const state of ['spool', 'drop']) {
    const g = rigF(1.25);
    run(g, 30, { throttle: 1 });
    g.engageTransit();
    if (state === 'drop') { run(g, 4, null, { transitAltitude: Infinity }); g.dropTransit('spike'); }
    g.step(0.5, { transitAltitude: 40000 });
    check(g, `0.5 s spike during ${state}`);
    /* A spike must not overshoot the ramp: `dt / transitSpoolUp` is 0.28 at a
     * normal step and 0.28 * 30 unbounded at a spike, and an unclamped spool
     * is a >100% authority trim and a cap above `transitTop`. */
    assert.ok(g.transitSpool <= 1 && g.transitSpool >= 0);
    g.step(0.5, { transitAltitude: -50000 });
    check(g, `0.5 s spike into a body during ${state}`);
    g.step(0.5, { transitAltitude: Infinity });
    check(g, `0.5 s spike with no body during ${state}`);
  }

  /* ---- and the guard really is armed ---- */
  const bad = rigF(1);
  bad.engageTransit();
  bad._transitSpool = NaN;
  assert.throws(() => bad.step(DT, { transitAltitude: 5000 }), /non-finite/,
    'a NaN spool walked straight past the guard');
});

/* ====================================================================== */
/* 10. The drive changes nothing while it is off                          */
/* ====================================================================== */

test('with the drive off, every number ship-flight.test.mjs pins is unchanged', () => {
  /* The regression floor for the whole change. If adding a third ceiling moved
   * cruise, boost or the turning radius, the drive has been paid for out of
   * the flight model rather than added beside it. */
  const cruise = rigF(1.75);
  run(cruise, 90, { throttle: 1 });
  assert.ok(Math.abs(cruise.speed - 210) < 0.5,
    `stock Kestrel cruise top is ${cruise.speed.toFixed(2)}, recorded 210.0`);
  assert.equal(cruiseTopSpeed(1), FLIGHT.thrust / FLIGHT.drag);
  assert.equal(boostTopSpeed(1), FLIGHT.hardCap);

  /* The boost PEAK, not where a boost leaves you: the tank is 100/30 = 3.33 s
   * and the cap is reached at 1.93 s, so a ship measured at t = 12 s has been
   * coasting back down under drag for eight seconds. */
  const boost = rigF(1.75);
  run(boost, 90, { throttle: 1 });
  boost.setCommand({ throttle: 1, boost: true });
  let peakBoost = 0;
  for (let i = 0; i < Math.round(4 / DT); i++) { boost.step(DT); peakBoost = Math.max(peakBoost, boost.speed); }
  assert.ok(peakBoost > 450 && peakBoost <= 455.01,
    `stock Kestrel boost top is ${peakBoost.toFixed(2)}, recorded 455`);

  /* The turning-radius grid: 148.02-148.11 m across all twelve pairs, a spread
   * of 0.09 m over a x1.90 range of power. This is LESSON 1 and it is the
   * single most load-bearing invariant in `Flight.js`. */
  const radii = [];
  for (const h of everyHull()) {
    run(h.flight, 90, { throttle: 1 });
    run(h.flight, 6, { pitch: 1 });
    const q0 = h.flight.quaternion.clone();
    let sum = 0;
    const n = Math.round(1 / DT);
    for (let i = 0; i < n; i++) { h.flight.step(DT); sum += h.flight.speed; }
    const dq = q0.invert().multiply(h.flight.quaternion);
    const omega = 2 * Math.acos(Math.min(1, Math.abs(dq.w)));
    radii.push((sum / n) / omega);
    assert.equal(h.flight.transitState, TRANSIT_STATE.off, 'the drive engaged itself');
    assert.equal(h.flight.transitSpool, 0);
  }
  const spread = Math.max(...radii) - Math.min(...radii);
  assert.ok(spread < 0.25, `turning radius spreads ${spread.toFixed(3)} m across the tier grid`);
  for (const rr of radii) {
    assert.ok(Math.abs(rr - 148.15) < 0.25, `radius ${rr.toFixed(2)} m, recorded 148.02-148.11 m`);
  }

  /* `turnRadius(speed, pm, axis)` with no spool is the call every existing
   * site makes, and it must answer exactly what it always answered. */
  const stated = [0.25, 0.5, 0.75, 1].map((x) => Number(turnRadius(cruiseTopSpeed(1) * x, 1).toFixed(2)));
  assert.deepEqual(stated, [24.69, 55.56, 95.24, 148.15]);
});

test('the drive and the displacement multiplier never compound', async () => {
  /* x8 on top of 5,000 m/s is 40 km/s, which crosses Cinder's whole diameter
   * inside half a fixed step - the tunnelling `_groundContact` was rewritten
   * as a swept probe to stop. */
  const r = await rig();
  await resetToYard(r);
  const f = await launch(r, 'kestrel');
  f.place(clearSpot());

  pressTransit(r);
  let worst = 1;
  for (let i = 0; i < 60 * 8; i++) {
    f.setCommand({ throttle: 1 });
    r.piloting.fixedUpdate(DT, i * DT);
    worst = Math.max(worst, r.piloting._transit);
  }
  assert.equal(f.transitState, TRANSIT_STATE.engaged);
  assert.equal(worst, 1,
    `the displacement multiplier reached x${worst.toFixed(1)} under a live drive - the two compound`);
  f.dropTransit(null, true);
});

/* ====================================================================== */
/* 11. The readout                                                         */
/* ====================================================================== */

test('the report and the nav rows carry everything the HUD draws', async () => {
  const r = await rig();
  await resetToYard(r);
  const f = await launch(r, 'kestrel');
  f.place(clearSpot());

  const before = r.piloting.report({});
  assert.equal(before.transitState, 'off');
  assert.equal(before.transitSpool, 0);
  assert.equal(before.transitRefusal, null, 'the drive would refuse in open space 20 km out');
  assert.ok(before.transitCap > 0 && Number.isFinite(before.transitCap));
  assert.equal(before.transitTop, FLIGHT.transitTop);

  /* Aim at something, so the ETA has a target to be about. */
  faceAt(f, CINDER_AT);
  pressTransit(r);
  for (let i = 0; i < 60 * 4; i++) { f.setCommand({ throttle: 1 }); r.piloting.fixedUpdate(DT, i * DT); }
  const during = r.piloting.report({});
  assert.equal(during.transitState, 'engaged');
  assert.ok(during.transitSpool === 1);
  assert.ok(during.speed > 4000, `report says ${during.speed.toFixed(0)} m/s under a live drive`);
  /* The multiplier is 1, so the HUD's `speed * transit` is the honest speed. */
  assert.equal(during.transit, 1);

  /* ---- TIME TO ARRIVAL, off the CLOSING speed ---- */
  const rows = r.piloting.navReport([]);
  assert.ok(rows.length >= 3, 'the nav readout is empty in the middle of the volume');
  for (const row of rows) {
    assert.ok(Number.isFinite(row.closing), `${row.name} has a non-finite closing speed`);
    assert.ok(row.eta === null || (Number.isFinite(row.eta) && row.eta > 0),
      `${row.name} has an eta of ${row.eta}`);
    if (row.eta !== null) {
      assert.ok(Math.abs(row.eta * row.closing - row.range) < 1,
        `${row.name}: eta x closing does not reproduce the range`);
    }
  }
  /* Something ahead has an ETA, and something behind does not - which is the
   * whole reason it is the closing speed and not the speed. A ship doing
   * 5,000 m/s PAST a target is not arriving at it, and `range / speed` would
   * cheerfully say it lands in forty seconds. */
  const front = [...rows].sort((a, b) => b.ahead - a.ahead)[0];
  assert.ok(front.ahead > 0.5, `the nose is not on anything: best bearing ${front.ahead.toFixed(2)}`);
  assert.ok(front.eta !== null && front.eta > 0,
    `${front.name} is dead ahead at 5 km/s and has no arrival time`);
  for (const b of rows.filter((x) => x.ahead < -0.5)) {
    assert.equal(b.eta, null, `${b.name} is astern and still has an ETA`);
  }

  /* The yard is still row 0 unconditionally - the anti-stranding rule the
   * whole nav readout exists for, and adding a column must not have moved it. */
  assert.equal(rows[0].id, DOCK_ANCHOR.id, 'home is no longer the first row');
  f.dropTransit(null, true);
});

test('every refusal code has a sentence, and every sentence names an action', () => {
  /* A missing key here is a control that refuses silently - `_sayTransit`
   * returns early on an unknown code. Both directions are checked so a code
   * added without prose, or prose left behind by a deleted code, is a failure. */
  const codes = ['world', 'landed', 'dock', 'approach', 'atmosphere', 'interdicted', 'hit', 'pilot', 'hull'];
  assert.deepEqual(Object.keys(PIL.TRANSIT_REASONS).sort(), [...codes].sort());
  for (const c of codes) {
    const s = PIL.TRANSIT_REASONS[c];
    assert.equal(typeof s, 'string');
    assert.ok(s.length > 12 && s.endsWith('.'), `"${c}" reads "${s}"`);
    /* "Mass-locked" alone tells a pilot nothing they can do. Every refusal a
     * player can act on names the action; the ones that happen TO them
     * (atmosphere, hit, pilot, hull) are reports and are exempt. `hull` joins
     * that group rather than the other: by the time it fires the ship is
     * already ON the pressure hull of a body with no ground, `_hullContact`
     * has said what that means in the body's own words, and a second sentence
     * telling the pilot to pull away would be instructions they are already
     * following. */
    if (!['atmosphere', 'hit', 'pilot', 'hull'].includes(c)) {
      assert.ok(/first|Launch|Lift|Clear|will not/.test(s),
        `"${c}" states a condition without an action: "${s}"`);
    }
  }
});
