import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Physics } from '../../src/physics/Physics.js';
import { CONFIG } from '../../src/core/Config.js';
import { WALKABLE_NORMAL_Y } from '../../src/npc/Grounding.js';

/**
 * THE WALKABLE CEILING THE GAME ACTUALLY HAS, AND WHY IT IS NOT 56.6 DEGREES.
 *
 * Three numbers in this codebase claim to decide what a character may walk on:
 *
 *     Grounding.WALKABLE_NORMAL_Y      0.55   56.6 deg
 *     Physics.resolveCapsule           0.64   50.2 deg   (`grounded`)
 *     ...and the one in effect                ~45 deg
 *
 * The third is not written anywhere. It falls out of `resolveCapsule`'s
 * closest-point iteration, whose comment used to read "Two passes is enough for
 * the convex shapes we use" - and is, up to a pitch this file computes exactly
 * and no further. Past it the reported contact normal is not the face normal,
 * and a caller comparing it against either of the first two numbers is asking
 * about something else.
 *
 * Everything here is a measurement of the solver at 7178224, pinned so the next
 * person to read `WALKABLE_NORMAL_Y` and believe it does not have to spend a
 * day rediscovering that it is not the threshold in effect.
 *
 * ── What is NOT asserted here, deliberately ───────────────────────────────
 * That any of this is correct. It is not. A third pass of the same iteration
 * makes the normal exact to 1e-16 up to 60.6 degrees, costs +24-27% of
 * `resolveCapsule`, and leaves flat ground bit-identical - and it was measured
 * and rejected, because on its own it swaps this defect for a 50.2-56.6 degree
 * band where a character can neither stand nor step and an 8-degree-wider step
 * ladder. The full argument is at the call site.
 * @see ../../src/physics/Physics.js `resolveCapsule`
 * @see ../../src/npc/Grounding.js `WALKABLE_NORMAL_Y`
 * @see ../../src/player/Player.js `_move`
 */

const DT = 1 / 60;
const P = CONFIG.player;
/** The downward bias `_move` applies while grounded, m/s. */
const GROUND_STICK = 2.2;
const R = P.radius;
const H = P.height;

/* ------------------------------------------------------------------ */
/* Worlds: the same plane as an oriented box and as a heightfield       */
/* ------------------------------------------------------------------ */

/** A slab whose TOP FACE is exactly the plane `y = x tan p`. */
function boxRamp(deg, { run = 400, width = 400 } = {}) {
  const physics = new Physics();
  const p = deg * Math.PI / 180;
  const rise = run * Math.tan(p);
  const len = Math.hypot(run, rise);
  const m = new THREE.Mesh(new THREE.BoxGeometry(len, 0.5, width));
  m.position.set(run / 2 + 0.25 * Math.sin(p), rise / 2 - 0.25 * Math.cos(p), 0);
  m.rotation.set(0, 0, p);
  m.updateWorldMatrix(true, false);
  physics.addBoxFromObject(m);
  return { physics, pitch: p, surfaceY: (x) => x * Math.tan(p) };
}

/** The same plane sampled onto a heightfield, so the two can be compared. */
function hfRamp(deg, { run = 400, width = 400, step = 4 } = {}) {
  const physics = new Physics();
  const p = deg * Math.PI / 180;
  const nx = Math.round(run / step) + 1;
  const nz = Math.round(width / step) + 1;
  const heights = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) heights[j * nx + i] = (i * step) * Math.tan(p);
  }
  physics.addHeightfield({
    heights, nx, nz, originX: 0, originZ: -width / 2, stepX: step, stepZ: step,
  });
  return { physics, pitch: p, surfaceY: (x) => x * Math.tan(p) };
}

/** A slab whose UNDERSIDE is a plane pitched by `deg`, for the overhead case. */
function boxRoof(deg, { C = 3, span = 400 } = {}) {
  const physics = new Physics();
  const p = deg * Math.PI / 180;
  const m = new THREE.Mesh(new THREE.BoxGeometry(span / Math.cos(p), 0.5, span));
  m.position.set(0, C + 0.25, 0);
  m.rotation.set(0, 0, -p);
  m.updateWorldMatrix(true, false);
  physics.addBoxFromObject(m);
  return { physics, pitch: p, underY: C };
}

/* ------------------------------------------------------------------ */
/* Reading one contact out of the solver                               */
/* ------------------------------------------------------------------ */

/**
 * Feet height at which the bottom sphere is exactly TANGENT to a plane of
 * pitch `p` - the zero of perpendicular penetration. This is the same quantity
 * `Grounding.capsuleSlopeLift` computes, restated here so the probe below can
 * dial a penetration in metres measured along the surface normal, which is the
 * only measure the solver's error is actually a function of.
 */
const tangentLift = (radius, p) => radius * (1 / Math.cos(p) - 1);

/**
 * The FIRST push `resolveCapsule` applies, which for a single-collider contact
 * is the contact normal and depth it decided on.
 *
 * Read by intercepting `addScaledVector` on the position vector handed in:
 * that is the one and only line in the solver that moves the capsule, so the
 * interception is exact and needs no copy of the solver's arithmetic here.
 */
function firstPush(physics, position, radius, height) {
  const log = [];
  const real = THREE.Vector3.prototype.addScaledVector;
  position.addScaledVector = function (v, s) {
    log.push({ y: v.y, depth: s });
    return real.call(this, v, s);
  };
  const res = physics.resolveCapsule(position, radius, height);
  delete position.addScaledVector;
  return { first: log[0] ?? null, pushes: log.length, res };
}

/** Reported contact normal `y` for a capsule sunk `pen` m into a ramp, or null. */
function reportedNormalY(make, deg, pen, { radius = R, height = H } = {}) {
  const w = make(deg);
  const y = w.surfaceY(50) + tangentLift(radius, w.pitch) - pen / Math.cos(w.pitch);
  const { first } = firstPush(w.physics, new THREE.Vector3(50, y, 0), radius, height);
  return first ? first.y : null;
}

/* ------------------------------------------------------------------ */
/* 1. The onset, which is a property of the capsule                     */
/* ------------------------------------------------------------------ */

/**
 * Pass 1 projects the axis MIDPOINT onto the collider. Pass 2 is exact only if
 * that landed at or below the bottom sphere centre, so `onSeg` snaps to the
 * endpoint and stays there. Working that condition through for a vertical
 * segment against a plane of pitch `p` gives
 *
 *     (height/2 - radius) sin^2 p  <=  radius cos p
 *
 * with equality at the onset. Solving for `cos p`:
 */
function predictedOnsetDeg(radius, height) {
  const k = height / 2 - radius;
  if (k <= 0) return 90;
  const c = (-radius + Math.sqrt(radius * radius + 4 * k * k)) / (2 * k);
  return Math.acos(Math.min(1, c)) * 180 / Math.PI;
}

/** The steepest pitch at which the solver still returns the true face normal. */
function measuredOnsetDeg(radius, height, make = boxRamp) {
  let lo = 1;
  let hi = 89;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    const got = reportedNormalY(make, mid, 1e-4, { radius, height });
    const want = Math.cos(mid * Math.PI / 180);
    if (got !== null && Math.abs(got - want) < 1e-4) lo = mid;
    else hi = mid;
  }
  return lo;
}

test('the two-pass closest point is exact below a pitch set by the CAPSULE, not the slope', () => {
  /* The onset moves with the capsule's shape, which is the tell that this is
   * the iteration and not the geometry: a crouched player, whose axis is short
   * relative to its radius, is accurate 23 degrees further up the same slope
   * than a standing one. Anything that changes `CONFIG.player.height` or an
   * NPC's radius moves the walkable ceiling with it, silently, and this is the
   * only place that says so. */
  const cases = [
    ['player standing', R, H],
    ['player crouched', R, H * 0.58],
    ['dismount probe', 0.35, 1.55],
    ['default NPC', 0.33, 1.8 * 0.92],
  ];
  for (const [name, radius, height] of cases) {
    const predicted = predictedOnsetDeg(radius, height);
    const measured = measuredOnsetDeg(radius, height);
    assert.ok(Math.abs(predicted - measured) < 0.05,
      `${name}: the onset law says ${predicted.toFixed(2)} deg, the solver does `
      + `${measured.toFixed(2)} - the law no longer describes the code`);
  }
  // The number the rest of this file, and the walkable ceiling, hang off.
  assert.ok(Math.abs(predictedOnsetDeg(R, H) - 43.88) < 0.02,
    `the standing player's onset moved to ${predictedOnsetDeg(R, H).toFixed(2)} deg; `
    + 'the capsule dimensions changed, and so did every number in this file');
});

test('below the onset the reported normal IS the true face normal, exactly', () => {
  for (const deg of [0, 10, 20, 30, 35, 40, 42, 43]) {
    const want = Math.cos(deg * Math.PI / 180);
    for (const [kind, make] of [['box', boxRamp], ['heightfield', hfRamp]]) {
      const got = reportedNormalY(make, deg, 0.001);
      assert.notEqual(got, null, `${kind} at ${deg} deg: a 1 mm overlap reported no contact`);
      assert.ok(Math.abs(got - want) < 1e-5,
        `${kind} at ${deg} deg reported ${got.toFixed(6)}, true face normal is ${want.toFixed(6)}`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* 2. Above it: the normal, and then the contact, go                    */
/* ------------------------------------------------------------------ */

test('above the onset the reported normal falls away - and it is the iteration, not the shape', () => {
  /* An oriented box and a heightfield are different code paths inside
   * `_closestPoint` - a matrix pair and a clamp against a triangle scan - and
   * they agree here to 1e-6. Whatever this is, it is not a box artefact. */
  const table = [
    // pitch, true n.y, reported at 1 mm of perpendicular penetration
    [44.0, 0.7193, 0.7162],
    [45.0, 0.7071, 0.6842],
    [46.0, 0.6947, 0.6501],
    [46.5, 0.6884, 0.6323],
  ];
  for (const [deg, want, expect] of table) {
    assert.ok(Math.abs(Math.cos(deg * Math.PI / 180) - want) < 5e-5, 'table pitch/normal disagree');
    const box = reportedNormalY(boxRamp, deg, 0.001);
    const hf = reportedNormalY(hfRamp, deg, 0.001);
    assert.ok(Math.abs(box - expect) < 1e-3,
      `box at ${deg} deg reported ${box.toFixed(4)}, was ${expect} at 7178224`);
    assert.ok(Math.abs(box - hf) < 1e-5,
      `box ${box.toFixed(6)} and heightfield ${hf.toFixed(6)} disagree at ${deg} deg - `
      + 'this stopped being a property of the segment-vs-plane iteration');
    assert.ok(box < want - 1e-3, `${deg} deg no longer under-reports; the solver changed`);
  }
});

test('a shallow contact on a steep face is dropped entirely, and the dead band grows with pitch', () => {
  /* The chord the inconsistent pair spans is LONGER than the true distance, so
   * `dist >= radius` rejects a real overlap. A capsule has to sink this far
   * before the solver notices it at all - which is also why a sprint, which
   * penetrates deeper per step than a walk, degrades a slope the walk survives.
   */
  const band = (deg) => {
    let lo = 0;
    let hi = R;
    for (let i = 0; i < 44; i++) {
      const mid = (lo + hi) / 2;
      if (reportedNormalY(boxRamp, deg, mid) !== null) hi = mid; else lo = mid;
    }
    return hi;
  };
  for (const deg of [40, 43]) {
    assert.ok(band(deg) < 1e-6, `${deg} deg has a ${band(deg).toFixed(6)} m dead band; it had none`);
  }
  const expected = [[45, 0.00016], [47, 0.00142], [50, 0.00644], [55, 0.02806], [58, 0.05435]];
  let previous = 0;
  for (const [deg, want] of expected) {
    const got = band(deg);
    assert.ok(Math.abs(got - want) < Math.max(2e-5, want * 0.05),
      `${deg} deg: a contact now registers at ${got.toFixed(5)} m of sink, was ${want} at 7178224`);
    assert.ok(got > previous, 'the dead band stopped growing with pitch');
    previous = got;
  }
});

test('steep OVERHEAD faces lose their normal the same way', () => {
  /* Same lag, other end of the axis: the crown sphere against a pitched roof.
   * Worth pinning because a head contact that reports the wrong direction is
   * how a character gets pushed sideways out from under an eave rather than
   * down, and nothing else in the suite looks at it. */
  for (const [deg, expect] of [[30, -0.8660], [40, -0.7660], [45, -0.5762], [50, -0.2990]]) {
    const p = deg * Math.PI / 180;
    const w = boxRoof(deg);
    const y = w.underY - (R - 0.001) / Math.cos(p) - (H - R);
    const { first } = firstPush(w.physics, new THREE.Vector3(0, y, 0), R, H);
    assert.notEqual(first, null, `${deg} deg overhead: a 1 mm overlap reported no contact`);
    assert.ok(Math.abs(first.y - expect) < 1e-3,
      `${deg} deg overhead reported ${first.y.toFixed(4)}, was ${expect} at 7178224 `
      + `(true face normal ${(-Math.cos(p)).toFixed(4)})`);
  }
});

/* ------------------------------------------------------------------ */
/* 3. The ceiling in effect, driven                                     */
/* ------------------------------------------------------------------ */

/**
 * The one renderer-bound thing `Player` builds is `Weapon`, whose viewmodel
 * textures are painted on a 2D canvas and thrown away headless. Same concession
 * `player-slope.test.mjs` and `player-speed.test.mjs` make, for the same
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

/** An apron, a ramp of pitch `deg`, and a plateau - the shape a player can walk. */
function rampWorld(deg, { run = 400, width = 400 } = {}) {
  const physics = new Physics();
  const p = deg * Math.PI / 180;
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
  return { physics, pitch: p, surfaceY: (x) => x * Math.tan(p) };
}

/** Facing is -Z at yaw 0, so this points forward and up the ramp. */
const YAW_PLUS_X = -Math.PI / 2;

function makePlayer(physics) {
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
  player.setYaw(YAW_PLUS_X);
  return player;
}

/**
 * Along-slope speed a walk up a pitch of `p` is worth with nothing added - the
 * horizontal velocity projected into the plane, less what the ground-stick bias
 * takes back downhill. Derived and checked to four decimals from 10 to 35
 * degrees in `player-slope.test.mjs`; here it is the yardstick the solver's
 * loss is measured against.
 */
const projectedAlong = (p) => P.walkSpeed * Math.cos(p) - GROUND_STICK * Math.sin(p);

/** Hold forward up a ramp for 3 s and report what the capsule actually did. */
function walkUp(deg) {
  const w = rampWorld(deg);
  const player = makePlayer(w.physics);
  /* `groundHeight` is called from exactly ONE place in the whole controller -
   * the tread probe inside `_move`'s step-up branch - so this counts step
   * probes exactly. @see ../../src/player/Player.js `_move` */
  const realGH = w.physics.groundHeight.bind(w.physics);
  let probes = 0;
  w.physics.groundHeight = (...a) => { probes++; return realGH(...a); };

  player._position.set(20, w.surfaceY(20) + 0.5, 0);
  player._velocity.set(0, 0, 0);
  for (let i = 0; i < 180; i++) player.fixedUpdate(DT, i * DT);
  player.input.state.forward = 1;
  let t = 3;
  for (let i = 0; i < 120; i++, t += DT) player.fixedUpdate(DT, t);

  probes = 0;
  const from = player.position.clone();
  let grounded = 0;
  const n = 180;
  for (let i = 0; i < n; i++, t += DT) {
    player.fixedUpdate(DT, t);
    if (player.grounded) grounded++;
  }
  const to = player.position.clone();
  const along = Math.hypot(to.x - from.x, to.z - from.z) / Math.cos(w.pitch) / (n * DT);
  return { along, probes, grounded: grounded / n, ratio: along / projectedAlong(w.pitch) };
}

test('THE CEILING IN EFFECT: the player walks honestly to 40 degrees and no further', () => {
  /* A moving capsule sinks far deeper than the 1 mm the static cases use - the
   * ground-stick bias alone is 37 mm per fixed step - so the driven onset is
   * BELOW the static 43.88. Up to 40 the climb is the projection to four
   * decimals; past it the wrong push direction spends motion backward. */
  for (const deg of [20, 30, 35]) {
    const r = walkUp(deg);
    assert.ok(Math.abs(r.ratio - 1) < 1e-3,
      `${deg} deg climbs at ${r.ratio.toFixed(4)}x the projection; it was 1.0000`);
    assert.equal(r.probes, 0, `${deg} deg fired ${r.probes} tread probes on a smooth ramp`);
    assert.equal(r.grounded, 1, `${deg} deg was airborne on some steps`);
  }
  for (const [deg, ratio] of [[40, 0.958], [42, 0.804], [44, 0.613], [45, 0.498]]) {
    const r = walkUp(deg);
    assert.ok(Math.abs(r.ratio - ratio) < 0.02,
      `${deg} deg climbs at ${r.ratio.toFixed(3)}x the projection, was ${ratio} at 7178224`);
    assert.equal(r.probes, 0,
      `${deg} deg fired ${r.probes} tread probes - the step ladder now starts below 46 deg`);
  }
});

test('past ~45 degrees the player is not stopped, it is LADDERED up by the step probe', () => {
  /* This is what "the effective ceiling is 45 degrees" really means, and it is
   * the reason raising `WALKABLE_NORMAL_Y` would change nothing. The solver
   * hands `_move` a normal under 0.55, `_move` concludes the slope is something
   * to step over, and the step-up branch finds a tread - the slope itself. The
   * player then ascends at multiples of a speed it can never reach on flat
   * ground, which is the same pathology `player-slope.test.mjs` closed for
   * ramps UNDER 45 degrees and which is still open above them. */
  /* The absolute speeds here were measured when `acceleration` was 60 and the
   * ground cap was 6.0, and they are NOT the property being claimed. Sprint was
   * subsequently made genuinely 8.2 (acceleration 60 -> 82), which moved every
   * one of them - a merge caught this, with 46 deg's 6.18 m/s no longer clearing
   * a cap that had risen to 8.2 underneath it.
   *
   * The claim is that the ladder beats the HONEST PROJECTION, which is what
   * proves a slope is being climbed as though it were a staircase. That ratio
   * is a property of the geometry and the step branch, not of how fast the
   * character runs on the flat, so it survives a change to either. The absolute
   * speed is still in the failure message, because when this does break the
   * number is what tells you which way it went. */
  for (const deg of [46, 50, 58]) {
    const r = walkUp(deg);
    const proj = projectedAlong((deg * Math.PI) / 180);
    assert.ok(r.probes > 30,
      `${deg} deg fired only ${r.probes} tread probes in 3 s; the ladder stopped running`);
    assert.ok(r.ratio > 3,
      `${deg} deg climbs at ${r.along.toFixed(2)} m/s along-slope, only `
      + `${r.ratio.toFixed(2)}x the ${proj.toFixed(2)} m/s projection - the ladder has stopped`);
    assert.ok(r.grounded < 0.8,
      `${deg} deg was grounded ${(r.grounded * 100).toFixed(0)}% of steps - a ladder is airborne`);
  }
});

test('the three walkability thresholds still disagree, and the constants still do not describe the game', () => {
  /* The ratchet on the whole finding. If someone reconciles these, every number
   * in this file needs re-measuring - which is exactly the moment to be told.
   *
   * `resolveCapsule`'s own gate is read out of the source rather than exported,
   * because exporting it would suggest it is a knob callers may reason with,
   * and the point of this file is that it is not. */
  assert.equal(WALKABLE_NORMAL_Y, 0.55,
    'Grounding.WALKABLE_NORMAL_Y moved; the 56.6 degree figure above is now wrong');

  /* At the pitch WALKABLE_NORMAL_Y nominally permits, a walking capsule reports
   * a normal nowhere near it. This one assertion is the entire finding. */
  const nominal = Math.acos(WALKABLE_NORMAL_Y) * 180 / Math.PI;
  assert.ok(Math.abs(nominal - 56.63) < 0.01, 'the nominal ceiling arithmetic changed');
  const reported = reportedNormalY(boxRamp, 50, 0.02);
  assert.ok(reported !== null && reported < WALKABLE_NORMAL_Y,
    `a capsule 2 cm into a 50 degree face now reports ${reported}, at or above `
    + `WALKABLE_NORMAL_Y - the solver was fixed, and every case in this file should be re-read`);
});
