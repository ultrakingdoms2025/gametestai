import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Physics } from '../../src/physics/Physics.js';
import { CONFIG } from '../../src/core/Config.js';
import * as Grounding from '../../src/npc/Grounding.js';
import { walkwayStairFlight, WALKWAY } from '../../src/worlds/station/StationKit.js';

const { capsuleSlopeLift } = Grounding;

/**
 * Does the PLAYER slide down slopes the way the NPCs did? No. This pins why.
 *
 * ── The question ─────────────────────────────────────────────────────────
 * `Grounding.capsuleSlopeLift` was added because every NPC in the game was on
 * a treadmill on every ramp: `NPC._followGround` seats the feet at the
 * VERTICAL ground height each step, which on a slope buries the capsule's
 * bottom sphere by `r * (1 - cos p)`, and `resolveCapsule` then evicts it along
 * the surface normal - downhill. Measured on the station's walkway flight,
 * 0.0231 m per fixed step, 1.39 m/s, against a 1.4 m/s walk.
 * @see ../../src/npc/Grounding.js capsuleSlopeLift
 * @see ./npc-flight-climb.test.mjs
 *
 * `src/player/Player.js` has its own integrator and its own `stepHeight`, and
 * had never been examined. So it was: driven, not read.
 *
 * ── The answer, measured ─────────────────────────────────────────────────
 * The player is IMMUNE, and immune for a structural reason worth keeping.
 *
 * It shares `Physics.resolveCapsule` with the NPCs. What it does NOT share is
 * the re-seat: the player has no `_followGround`. `physics.groundHeight` is
 * called exactly once in the whole controller - the tread probe inside `_move`'s
 * step-up branch - and never to place the feet. The capsule is integrated,
 * handed to the solver, and LEFT WHERE THE SOLVER PUT IT. A solver that has
 * evicted a capsule onto a slope has, by construction, put it exactly tangent
 * to that slope, which is the height `capsuleSlopeLift` computes. The NPCs had
 * to be told that height because they overwrote it every step; the player is
 * already standing on it.
 *
 * That is the whole difference, and it is measurable to six decimal places:
 * `restingHeightAbove` below reproduces the player's settled height on a slope
 * from `capsuleSlopeLift` and the ground-stick bias alone.
 *
 * ── What is NOT pinned here, and why ─────────────────────────────────────
 * Measuring this turned up a SEPARATE defect, of the opposite sign: on any
 * smooth ramp of 15 degrees or more, `_move`'s step-up branch mistakes the
 * solver's slope loss for an obstruction and fires 20-30 times a second,
 * teleporting the player up to the surface height ~0.36 m ahead of itself. The
 * player ends up hovering up to 0.2 m over a 30-degree ramp, airborne a third
 * to a half of all steps, and climbing at 1.10x its own walk speed - it goes
 * UP a 30-degree ramp faster than it crosses flat ground, and at 45 degrees,
 * 1.41x. The cases at the bottom of this file bound that behaviour so it cannot
 * quietly get worse; they deliberately do not bless it. Fixing it is a change
 * to the feel of the core controller and was not what this investigation was
 * asked for.
 */

const DT = 1 / 60;
const P = CONFIG.player;
/** The downward bias `_move` applies while grounded, in metres per fixed step. */
const STICK_PER_STEP = 2.2 * DT;

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

/**
 * The one renderer-bound thing `Player` builds in its constructor is `Weapon`,
 * whose procedural viewmodel textures are painted on a 2D canvas. Everything
 * drawn is thrown away headless, so the shim answers the API and draws nothing.
 * Stubbing it is the same concession `npc-flight-climb.test.mjs` makes for the
 * animator: it takes no part in locomotion.
 */
function shimCanvas() {
  if (globalThis.document?.createElement) return;
  const noop = () => {};
  const ctx2d = () => ({
    createImageData: (a, b) => ({
      data: new Uint8ClampedArray((a | 0) * ((b ?? a) | 0) * 4),
      width: a | 0,
      height: (b ?? a) | 0,
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

/**
 * A flat apron at y = 0 for x < 0, a ramp of pitch `deg` climbing toward +X
 * whose top face is exactly the plane `y = x tan p`, and a plateau at the top.
 *
 * Wide by default: a run across the fall line covers a lot of ground, and a
 * player that walks off the edge measures free fall instead of a slope.
 */
function rampWorld(deg, { run = 400, width = 400 } = {}) {
  const physics = new Physics();
  const p = deg * Math.PI / 180;
  const rise = run * Math.tan(p);
  const add = (m) => { m.updateWorldMatrix(true, false); physics.addBoxFromObject(m); return m; };

  const apron = new THREE.Mesh(new THREE.BoxGeometry(80, 2, width));
  apron.position.set(-40, -1, 0);
  add(apron);

  /* Rotating a box by +p about Z carries its local +Y to (-sin p, cos p, 0),
   * which is the up-normal of a slope that rises toward +X. The centre is
   * offset by half the slab thickness down that normal so the TOP face passes
   * through the origin and through (run, rise) - `surfaceY` below is then exact
   * rather than approximate, which is what lets the tangent-height case assert
   * to 1e-6. */
  const len = Math.hypot(run, rise);
  const ramp = new THREE.Mesh(new THREE.BoxGeometry(len, 0.5, width));
  ramp.position.set(run / 2 + 0.25 * Math.sin(p), rise / 2 - 0.25 * Math.cos(p), 0);
  ramp.rotation.set(0, 0, p);
  add(ramp);

  const top = new THREE.Mesh(new THREE.BoxGeometry(80, 2, width));
  top.position.set(run + 40, rise - 1, 0);
  add(top);

  return { physics, pitch: p, rise, run, surfaceY: (x) => x * Math.tan(p) };
}

/** Yaw that points the player's forward axis along +X. Facing is -Z at yaw 0. */
const YAW_PLUS_X = -Math.PI / 2;
/** ...and along +Z, which on the ramps above is the contour. */
const YAW_PLUS_Z = Math.PI;

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

/** Drop the player in and run the real fixed step until it has stopped moving. */
function settle(player, x, z, y, steps = 180) {
  player._position.set(x, y, z);
  player._velocity.set(0, 0, 0);
  for (let i = 0; i < steps; i++) player.fixedUpdate(DT, i * DT);
  return player;
}

/**
 * Hold an input for `seconds` and report what the capsule actually did.
 * `warm` seconds are burned first so acceleration is not averaged into the
 * result - the question is the sustained speed, not the launch.
 */
function drive(player, seconds, { warm = 2, downhillAxis = 0 } = {}) {
  let t = 10;
  for (let i = 0; i < Math.round(warm / DT); i++, t += DT) player.fixedUpdate(DT, t);
  const from = player.position.clone();
  const n = Math.round(seconds / DT);
  let groundedSteps = 0;
  let downhillSteps = 0;
  let worstDownhill = 0;
  for (let i = 0; i < n; i++, t += DT) {
    const wasX = player.position.x;
    player.fixedUpdate(DT, t);
    if (player.grounded) groundedSteps++;
    const stepX = (player.position.x - wasX) * downhillAxis;
    if (stepX < -1e-6) {
      downhillSteps++;
      worstDownhill = Math.min(worstDownhill, stepX);
    }
  }
  const to = player.position.clone();
  return {
    from, to, seconds,
    along: from.distanceTo(to) / seconds,
    horizontal: Math.hypot(to.x - from.x, to.z - from.z) / seconds,
    driftX: (to.x - from.x) / seconds,
    driftPerStep: (to.x - from.x) / n,
    grounded: groundedSteps / n,
    downhillSteps, worstDownhill, steps: n,
  };
}

/* ------------------------------------------------------------------ */
/* The thing itself: the player does not slide                         */
/* ------------------------------------------------------------------ */

test('the player climbs the station walkway flight and arrives on the plate', () => {
  /* The same geometry `npc-flight-climb.test.mjs` drives an NPC up, at the same
   * 30.478 degrees, so the two characters are answering the identical question
   * about the identical collider. */
  const f = walkwayStairFlight();
  const physics = new Physics();
  const add = (m) => { m.updateWorldMatrix(true, false); physics.addBoxFromObject(m); return m; };
  const deck = new THREE.Mesh(new THREE.BoxGeometry(400, 2, 80));
  deck.position.set(0, -1, 0);
  add(deck);
  const promenade = new THREE.Mesh(new THREE.BoxGeometry(20, 0.6, WALKWAY.WIDTH));
  promenade.position.set(f.rInner - 10, f.rise - 0.3, 0);
  add(promenade);
  const ramp = new THREE.Mesh(
    new THREE.BoxGeometry(WALKWAY.STAIR_W, 0.5, Math.hypot(f.run, f.rise))
  );
  ramp.position.set((f.rOuter + f.rHead) / 2, f.rampSeat, 0);
  ramp.rotation.set(0, -Math.PI / 2, 0, 'YXZ');
  ramp.rotateX(-f.pitch);
  add(ramp);
  const plate = new THREE.Mesh(new THREE.BoxGeometry(WALKWAY.STAIR_W, 0.3, f.landingHalf * 2));
  plate.position.set(f.landingR, f.rise - 0.15, 0);
  plate.rotation.set(0, -Math.PI / 2, 0, 'YXZ');
  add(plate);

  // The flight climbs toward -X, so forward is -X.
  const player = settle(makePlayer(physics, Math.PI / 2), f.rOuter + 1.5, 0, 0.3, 120);
  player.input.state.forward = 1;

  let t = 2;
  let slips = 0;
  let arrivedAt = null;
  for (let i = 0; i < 60 * 20; i++, t += DT) {
    const wasX = player.position.x;
    player.fixedUpdate(DT, t);
    // Uphill is -X here, so a positive step in x is the treadmill.
    if (player.position.x - wasX > 1e-6) slips++;
    if (arrivedAt === null && player.position.y > f.rise - 0.05) arrivedAt = t - 2;
    if (player.position.x < f.rInner - 3) break;
  }

  assert.notEqual(arrivedAt, null, `never reached the plate at y = ${f.rise}`);
  // Measured 4.15 s. Eight is that with room for the solver to be re-tuned and
  // still tight enough that a character reduced to a creep fails.
  assert.ok(arrivedAt < 8, `took ${arrivedAt.toFixed(2)} s to climb 10 m`);
  // The whole defect, in one number. The NPCs took 0.0231 m of this per step.
  assert.equal(slips, 0, `slipped downhill on ${slips} steps`);
});

test('standing on a slope the player does not move by so much as a float', () => {
  /* `_move` pins the planar position outright when there is no horizontal
   * motion to integrate, precisely because the ground-stick bias plus the
   * solver's normal push would otherwise creep downslope.
   * @see src/player/Player.js `_move`, the `wanted < 1e-4` branch. */
  for (const deg of [10, 20, 25, 30, 35, 40]) {
    const w = rampWorld(deg);
    const player = settle(makePlayer(w.physics), 30, 0, w.surfaceY(30) + 0.5);
    const before = player.position.clone();
    for (let i = 0; i < 240; i++) player.fixedUpdate(DT, 3 + i * DT);
    assert.equal(
      player.position.x, before.x,
      `stood still on ${deg} degrees and drifted ${(player.position.x - before.x).toFixed(6)} m in x`
    );
    assert.equal(player.position.z, before.z, `drifted in z on ${deg} degrees`);
  }
});

test('the solver leaves the feet at the slope tangent height, which is the lift NPCs had to be given', () => {
  /* THE STRUCTURAL CLAIM, and the reason the player needs no `capsuleSlopeLift`.
   *
   * A capsule the solver has finished evicting is tangent to the surface, and
   * tangency on a slope of pitch p puts the feet `r * (1/cos p - 1)` above the
   * vertical ground height - which is exactly what `capsuleSlopeLift` returns.
   * The player settles there because nothing ever overwrites it; an NPC did not
   * because `_followGround` put the feet back on the ground height every step.
   *
   * The one correction is the ground-stick bias: while grounded, `_move` sets
   * `velocity.y = -2.2`, sinking the capsule `2.2 * dt` before each resolve, and
   * the eviction that undoes it converges one `stick * tan^2 p` short of true
   * tangency. Both terms are needed to reproduce the measured height, and
   * reproducing it to 1e-6 is what makes this a claim about the mechanism
   * rather than a curve fit. */
  for (const deg of [0, 10, 20, 25, 30, 35, 40]) {
    const w = rampWorld(deg);
    const player = settle(makePlayer(w.physics), 30, 0, w.surfaceY(30) + 0.5, 300);
    const measured = player.position.y - w.surfaceY(player.position.x);
    const predicted =
      capsuleSlopeLift(P.radius, Math.cos(w.pitch)) - STICK_PER_STEP * Math.tan(w.pitch) ** 2;
    assert.ok(
      Math.abs(measured - predicted) < 1e-5,
      `at ${deg} degrees the feet rest ${measured.toFixed(6)} m above the ground height; ` +
      `tangency minus the stick bias predicts ${predicted.toFixed(6)}`
    );
  }
  // Flat ground: the lift is exactly zero and the player stands exactly on it.
  assert.equal(capsuleSlopeLift(P.radius, 1), 0);
});

test('a capsule that re-seats its feet at the ground height DOES slide - the fixture can fail', () => {
  /* The contrast that makes the cases above mean something. Same solver, same
   * ramp, same radius; the only change is the NPC pattern of writing the feet
   * back to the vertical ground height every step. It slides, at the rate the
   * NPC investigation measured. If some future change made the player re-seat
   * its feet, this is the drift it would inherit. */
  const w = rampWorld(30);
  const pos = new THREE.Vector3(30, w.surfaceY(30), 0);
  for (let i = 0; i < 40; i++) {
    const gy = w.physics.groundHeight(pos.x, pos.z, pos.y + 2, 6);
    if (gy !== null) pos.y = gy;
    w.physics.resolveCapsule(pos, P.radius, P.height);
  }
  const x0 = pos.x;
  const n = 60;
  for (let i = 0; i < n; i++) {
    const gy = w.physics.groundHeight(pos.x, pos.z, pos.y + 2, 6);
    if (gy !== null) pos.y = gy;
    w.physics.resolveCapsule(pos, P.radius, P.height);
  }
  const perStep = (pos.x - x0) / n;
  // Measured -0.0234 m per step at radius 0.35 on 30 degrees - the same
  // arithmetic that gave 0.0231 at the NPC's 0.33 on the station's 30.478.
  assert.ok(perStep < -0.02, `a re-seating capsule only drifted ${perStep.toFixed(5)} m/step`);
  assert.ok(
    Math.abs(perStep + P.radius * (1 - Math.cos(w.pitch)) * Math.sin(w.pitch)) < 0.002,
    'the drift should be the normal eviction of the burial depth, and is not'
  );
});

test('uphill progress is real at every walkable pitch', () => {
  /* A treadmill of any size shows up here as a collapse in along-slope speed.
   * Measured: 4.15-5.36 m/s from 10 to 35 degrees against a 4.6 m/s walk. */
  for (const deg of [10, 15, 20, 25, 30, 35]) {
    const w = rampWorld(deg);
    const player = settle(makePlayer(w.physics), 30, 0, w.surfaceY(30) + 0.5);
    player.input.state.forward = 1;
    const r = drive(player, 4, { downhillAxis: 1 });
    assert.ok(
      r.along > P.walkSpeed * 0.85,
      `only ${r.along.toFixed(3)} m/s along a ${deg} degree slope, against a ${P.walkSpeed} m/s walk`
    );
    assert.ok(r.to.y > r.from.y + 0.5, `barely gained height on ${deg} degrees`);
    assert.equal(r.downhillSteps, 0, `${r.downhillSteps} downhill steps while climbing ${deg} degrees`);
  }
});

test('walking across the fall line slips downhill, but far less than the NPC treadmill did', () => {
  /* The one place the player does drift. Running the contour there is no uphill
   * component to absorb the eviction, so the ground-stick bias's `stick * cos p
   * * sin p` of downhill push per step survives: 0.0159 m/step at 30 degrees,
   * 0.95 m/s against 4.6 m/s of contour travel - a 12 degree lean off the
   * contour, not a treadmill, and it cannot stop anyone going anywhere.
   *
   * Bounded rather than blessed. If a change ever makes this approach the NPCs'
   * 0.0234 m/step, that is the same defect arriving by another door. */
  for (const [deg, bound] of [[20, 0.014], [30, 0.018], [35, 0.020]]) {
    const w = rampWorld(deg);
    const player = settle(makePlayer(w.physics, YAW_PLUS_Z), 30, -60, w.surfaceY(30) + 0.5);
    player.input.state.forward = 1;
    const r = drive(player, 6, { downhillAxis: 1 });
    assert.ok(
      Math.abs(r.driftPerStep) < bound,
      `${deg} degrees: ${Math.abs(r.driftPerStep).toFixed(5)} m/step of downhill slip, bound ${bound}`
    );
    // ...and it must not be a treadmill: the contour run still happens.
    assert.ok(
      Math.abs(r.to.z - r.from.z) / r.seconds > P.walkSpeed * 0.9,
      `only made ${(Math.abs(r.to.z - r.from.z) / r.seconds).toFixed(2)} m/s along the contour`
    );
  }
});

/* ------------------------------------------------------------------ */
/* The separate defect this turned up, bounded so it cannot get worse  */
/* ------------------------------------------------------------------ */

test('the step-up branch fires on smooth ramps, and the hover it causes is bounded', () => {
  /* `_move` retries blocked horizontal motion as a step-up when it got less
   * than 86% of the motion it asked for. On a slope the solver ALWAYS returns
   * less than that - projecting a horizontal velocity onto a plane of pitch p
   * costs a factor of cos^2 p, which passes 0.86 at 22 degrees - so a smooth
   * ramp with no riser anywhere on it reads as an obstruction, and the branch
   * probes a tread 0.36 m ahead and teleports the player onto it.
   *
   * This is the player's version of the blind spot `Navigation._probe` had:
   * a horizontal test that cannot tell a floor it can walk up from a wall it
   * cannot. The navigation fix was to classify a hit whose normal passes
   * `WALKABLE_NORMAL_Y` as floor. The same idea would apply here.
   *
   * Measured on a 30 degree ramp: 20 probes a second, the feet hovering between
   * 0.054 m (true tangency) and 0.198 m over the surface, airborne on a third
   * of all steps. The bounds below are the measurements with a margin. They are
   * a ratchet on a known defect, not an endorsement of it. */
  const w = rampWorld(30);
  const player = settle(makePlayer(w.physics), 30, 0, w.surfaceY(30) + 0.5);
  player.input.state.forward = 1;
  let t = 12;
  for (let i = 0; i < 120; i++, t += DT) player.fixedUpdate(DT, t);

  let maxHover = -Infinity;
  let grounded = 0;
  const n = 240;
  for (let i = 0; i < n; i++, t += DT) {
    player.fixedUpdate(DT, t);
    maxHover = Math.max(maxHover, player.position.y - w.surfaceY(player.position.x));
    if (player.grounded) grounded++;
  }
  assert.ok(maxHover < 0.25, `the player floated ${maxHover.toFixed(4)} m over a 30 degree ramp`);
  assert.ok(
    grounded / n > 0.6,
    `grounded on only ${(grounded / n * 100).toFixed(0)}% of steps walking up a 30 degree ramp`
  );
});

test('the climb is fast rather than slow - the defect here is the opposite sign to the NPCs', () => {
  /* Recorded because it is the surprise, and because a future fix to the
   * step-up branch will move these numbers and should be seen to. A player that
   * climbs a 30 degree ramp at 1.10x its own flat-ground walk speed is getting
   * height for free; the geometrically honest answer, velocity projected onto
   * the plane, is cos^2 p = 0.75x horizontally and 0.87x along the slope. */
  const w = rampWorld(30);
  const player = settle(makePlayer(w.physics), 30, 0, w.surfaceY(30) + 0.5);
  player.input.state.forward = 1;
  const r = drive(player, 4, { downhillAxis: 1 });
  // Between the honest projection and the measured free lift, so this fails
  // both if the climb collapses to a treadmill and if the free lift grows.
  assert.ok(r.along > P.walkSpeed * 0.85, `along-slope ${r.along.toFixed(3)} m/s`);
  assert.ok(r.along < P.walkSpeed * 1.25, `along-slope ${r.along.toFixed(3)} m/s - the free lift grew`);
});
