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
 * ── The SEPARATE defect this turned up, and which is now closed ──────────
 * Measuring the above found a second defect of the opposite sign: on any smooth
 * ramp of ~22 degrees or more, `_move`'s step-up branch mistook the solver's
 * slope loss for an obstruction and fired 20-30 times a second, teleporting the
 * player onto the surface ~0.36 m ahead of itself. Measured at 1862ed9: the
 * feet hovering 0.121-0.198 m over a 30-degree ramp, airborne on a third of all
 * steps, sprint dropping out on half of them, footsteps halved (36 to 18 over
 * six seconds), `_stepSmooth` pinned at its cap 100% of the time, and an
 * along-slope climb of 1.10x the flat-ground walk speed - 1.41x at 45 degrees.
 * The player went UP a ramp faster than it crossed a floor.
 *
 * `_move` now asks `resolveCapsule` whether anything it pushed against was
 * something other than floor before it probes a step, which is the question
 * `Navigation._probe` learned to ask for the NPCs. The cases at the bottom of
 * this file are the ratchet on that: probes at zero, the feet at the tangency
 * height and nowhere else, and a climb that is the projection and no more.
 * @see ../../src/player/Player.js `_move`
 * @see ../../src/npc/Navigation.js `isFloorHit`
 */

const DT = 1 / 60;
const P = CONFIG.player;
/** The downward bias `_move` applies while grounded, m/s. */
const GROUND_STICK = 2.2;
/** ...and the same thing in metres per fixed step. */
const STICK_PER_STEP = GROUND_STICK * DT;

/**
 * Along-slope speed a walk up a pitch of `p` is worth, with nothing added.
 *
 * A horizontal velocity `v` integrated into a plane of pitch `p` and evicted
 * back out along its normal advances `v cos^2 p` horizontally, and the
 * ground-stick bias, evicted by the same normal, takes `stick sin p cos p` of
 * that back downhill. Dividing by `cos p` for the along-slope distance leaves
 *
 *     v cos p - stick sin p
 *
 * which is the whole of what climbing a ramp is worth to a character that is
 * not being teleported. It reproduces the measured speed to four decimals from
 * 10 to 35 degrees; past 40 the solver's own contact normals start to drift off
 * the true face normal and the player climbs slower than this, which is a
 * property of `resolveCapsule`'s two-pass closest point and not of `_move`.
 */
function projectedAlong(pitch) {
  return P.walkSpeed * Math.cos(pitch) - GROUND_STICK * Math.sin(pitch);
}

/**
 * `physics.groundHeight` is called from exactly ONE place in the whole player
 * controller - the tread probe inside `_move`'s step-up branch - so wrapping it
 * counts step probes exactly. @see ../../src/player/Player.js `_move`
 */
function countProbes(physics) {
  const real = physics.groundHeight.bind(physics);
  let n = 0;
  physics.groundHeight = (...a) => { n++; return real(...a); };
  return () => n;
}

/**
 * How many times `_move`'s step-up branch was ENTERED, which is a broader
 * question than `countProbes`: the branch resolves a lifted copy of the capsule
 * twice before it ever reaches the tread probe, and gives up between the two
 * whenever the lift bought no extra motion - which is what happens at a wall.
 *
 * The lifted copy is a module scratch vector, never the player's own
 * `_position`, so resolves against anything else are the branch and nothing
 * else. Every other resolve in the controller is handed `_position` directly.
 */
function countStepBranch(physics, player) {
  const real = physics.resolveCapsule.bind(physics);
  let n = 0;
  physics.resolveCapsule = (pos, ...rest) => {
    if (pos !== player._position) n++;
    return real(pos, ...rest);
  };
  return () => n;
}

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
   *
   * CHANGED at the step-up fix. This used to assert `along > walkSpeed * 0.85`
   * at every pitch, and that bound was only ever met because the step-up branch
   * was handing the player free lift: the honest projection is `walkSpeed *
   * cos p` less the ground-stick, which is 0.70x at 25 degrees and 0.55x at 35,
   * so 0.85 was a bound on the DEFECT and not on progress. It is replaced with
   * the projection itself, to 1%, which is a strictly tighter statement - it
   * fails on a treadmill exactly as before, and now also fails if any free lift
   * ever comes back. @see projectedAlong */
  for (const deg of [10, 15, 20, 25, 30, 35]) {
    const w = rampWorld(deg);
    const player = settle(makePlayer(w.physics), 30, 0, w.surfaceY(30) + 0.5);
    player.input.state.forward = 1;
    const r = drive(player, 4, { downhillAxis: 1 });
    const want = projectedAlong(w.pitch);
    assert.ok(
      Math.abs(r.along - want) < want * 0.01,
      `${r.along.toFixed(4)} m/s along a ${deg} degree slope; the projection is ${want.toFixed(4)}`
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
/* The step-up branch: fires on risers, never on a smooth ramp         */
/* ------------------------------------------------------------------ */

test('a smooth ramp does not probe for a step, at any walkable pitch', () => {
  /* THE FIX, in one case.
   *
   * CHANGED at the step-up fix, from `the step-up branch fires on smooth ramps,
   * and the hover it causes is bounded`. That case asserted `maxHover < 0.25`
   * and `grounded > 0.6` - a ratchet on the defect, chosen so it could not get
   * worse, and explicitly written not to bless it. Those bounds still pass
   * today, and that is the problem with them: they pass whether the branch
   * fires 20 times a second or never. This asserts the mechanism instead.
   *
   * `_move` retried blocked horizontal motion as a step-up whenever it got less
   * than 86% of the motion it asked for, and on a slope the solver ALWAYS
   * returns less than that: projecting a horizontal velocity onto a plane of
   * pitch p costs a factor of cos^2 p, which passes 0.86 at 22 degrees. So a
   * smooth ramp with no riser anywhere on it read as an obstruction, and the
   * branch probed a tread 0.36 m ahead and teleported the player onto it. At
   * 1862ed9 this ran at 20-30 probes a second from 20 degrees up.
   *
   * It now asks whether anything the solver pushed against was something other
   * than floor first, so the answer on a ramp is: nothing to step over. The
   * probe count is the direct evidence, and the height is the corroboration -
   * a player that is not being teleported sits exactly where the solver left
   * it, which is the tangency height the case above derives from first
   * principles. */
  for (const deg of [10, 15, 20, 25, 30, 35]) {
    const w = rampWorld(deg);
    const player = settle(makePlayer(w.physics), 30, 0, w.surfaceY(30) + 0.5);
    player.input.state.forward = 1;
    let t = 12;
    for (let i = 0; i < 120; i++, t += DT) player.fixedUpdate(DT, t);

    // Counted only over the measured window, so the settle is not on the bill.
    const probes = countProbes(w.physics);
    const branch = countStepBranch(w.physics, player);
    /* Tangency exactly, with none of the `stick * tan^2 p` shortfall the
     * STANDING case above carries: climbing, the uphill component of the
     * motion more than pays back the sink the ground-stick bias costs, so the
     * eviction restores full tangency every step. */
    const tangency = capsuleSlopeLift(P.radius, Math.cos(w.pitch));
    let maxHover = -Infinity;
    let grounded = 0;
    let smoothing = 0;
    const n = 240;
    for (let i = 0; i < n; i++, t += DT) {
      player.fixedUpdate(DT, t);
      maxHover = Math.max(maxHover, player.position.y - w.surfaceY(player.position.x));
      if (player.grounded) grounded++;
      smoothing = Math.max(smoothing, player.stepSmoothing);
    }
    assert.equal(branch(), 0, `the step-up branch ran on a smooth ${deg} degree ramp`);
    assert.equal(probes(), 0, `${probes()} step probes in 4 s on a smooth ${deg} degree ramp`);
    assert.ok(
      Math.abs(maxHover - tangency) < 1e-3,
      `on ${deg} degrees the feet reached ${maxHover.toFixed(4)} m over the surface; ` +
      `the tangency the solver leaves them at is ${tangency.toFixed(4)}`
    );
    assert.equal(grounded, n, `airborne on ${n - grounded} of ${n} steps up a ${deg} degree ramp`);
    /* `_stepSmooth` is a LATCH under this harness, and that is what makes it
     * worth asserting. Only a step-up charges it on land (the other writer is
     * the mantle landing, which no ramp reaches), and it only decays in the
     * render-rate view pass, which a test driving `fixedUpdate` never calls -
     * so any non-zero value means a step-up happened at some point in this
     * player's life, the settle included. At 1862ed9 this is where 10 degrees
     * failed: 0.198 m charged while the player was still settling onto a ramp
     * with no riser on it, and pinned at the 0.585 m cap at every pitch above. */
    assert.equal(smoothing, 0, `${smoothing.toFixed(4)} m of stair smoothing on a ${deg} degree ramp`);
  }
});

test('the climb is the projection and nothing more - never faster than a flat walk', () => {
  /* CHANGED at the step-up fix, from `the climb is fast rather than slow - the
   * defect here is the opposite sign to the NPCs`. That case asserted
   * `walkSpeed * 0.85 < along < walkSpeed * 1.25` at 30 degrees, a window
   * around a MEASURED 1.10x that was chosen to catch the free lift growing. The
   * free lift is gone, so the window is replaced by the thing it was a proxy
   * for: going uphill may not be quicker than going along the flat, and the
   * amount by which it is slower is the projection.
   *
   * The 45 degree entry is the one that used to be worst - 1.41x, the player
   * outrunning its own walk by half again while airborne every other step. */
  for (const deg of [10, 20, 25, 30, 35, 45]) {
    const w = rampWorld(deg);
    const player = settle(makePlayer(w.physics), 30, 0, w.surfaceY(30) + 0.5);
    player.input.state.forward = 1;
    const r = drive(player, 4, { downhillAxis: 1 });
    assert.ok(
      r.along <= P.walkSpeed,
      `${r.along.toFixed(4)} m/s up a ${deg} degree ramp against a ${P.walkSpeed} m/s flat walk - ` +
      'the player is being handed height for free'
    );
    // ...and it is still going up, at every one of them.
    assert.ok(r.to.y > r.from.y + 0.5, `only gained ${(r.to.y - r.from.y).toFixed(2)} m on ${deg} degrees`);
  }
});

/* ------------------------------------------------------------------ */
/* ...and what must still stop it, or still lift it                     */
/* ------------------------------------------------------------------ */

/** A straight flight of boxy steps climbing toward +X, on a flat apron. */
function stairWorld(n, rise, going, { width = 8 } = {}) {
  const physics = new Physics();
  const add = (m) => { m.updateWorldMatrix(true, false); physics.addBoxFromObject(m); return m; };
  const apron = new THREE.Mesh(new THREE.BoxGeometry(40, 2, width));
  apron.position.set(-20, -1, 0);
  add(apron);
  for (let i = 0; i < n; i++) {
    const top = (i + 1) * rise;
    const s = new THREE.Mesh(new THREE.BoxGeometry(going, top + 2, width));
    s.position.set(i * going + going / 2, top / 2 - 1, 0);
    add(s);
  }
  const landing = new THREE.Mesh(new THREE.BoxGeometry(40, 2, width));
  landing.position.set(n * going + 20, n * rise - 1, 0);
  add(landing);
  return { physics, topY: n * rise, topX: n * going };
}

test('a real riser still gets stepped, and still gets probed for', () => {
  /* The other half of the fix. Suppressing the probe on slopes is only correct
   * if it still fires on the things it was written for, so both flights the
   * worlds actually ship are driven here and both the arrival AND the probe
   * count are asserted - a flight that got climbed with zero probes would mean
   * something else was carrying the player and the branch had quietly died.
   *
   * The station's walkway flight is the third case, and it is the FIRST test in
   * this file: it is a smooth 30.478 degree ramp, so it now arrives with no
   * probes at all, which is the point. */
  const flights = [
    // The maze's spiral shaft: 24 rises of 0.375 m. @see ../../src/worlds/maze/MazeShafts.js
    { name: 'maze spiral', n: 24, rise: 0.375, going: 0.7, by: 8 },
    // A medieval doorstep: 0.30 m risers on a 0.62 m going.
    // @see ../../src/worlds/MedievalWorld.js `_entrySteps`
    { name: 'medieval entry steps', n: 8, rise: 0.30, going: 0.62, by: 4 },
  ];
  for (const f of flights) {
    const w = stairWorld(f.n, f.rise, f.going);
    assert.ok(f.rise < P.stepHeight, `${f.name} has a riser taller than the step height`);
    const player = settle(makePlayer(w.physics), -3, 0, 0.5, 120);
    const probes = countProbes(w.physics);
    player.input.state.forward = 1;
    let t = 2;
    let arrivedAt = null;
    for (let i = 0; i < 60 * 30; i++, t += DT) {
      player.fixedUpdate(DT, t);
      if (arrivedAt === null && player.position.y > w.topY - 0.05) arrivedAt = t - 2;
      if (player.position.x > w.topX + 6) break;
    }
    assert.notEqual(arrivedAt, null, `${f.name}: never reached the top at y = ${w.topY}`);
    assert.ok(arrivedAt < f.by, `${f.name}: took ${arrivedAt.toFixed(2)} s to climb ${f.n} steps`);
    assert.ok(probes() >= f.n, `${f.name}: only ${probes()} step probes for ${f.n} risers`);
  }
});

test('a wall still stops the player dead', () => {
  /* The step-up probe fires at a wall exactly as it always did - a wall's
   * contact normal has y at zero, nowhere near `WALKABLE_NORMAL_Y` - and finds
   * no tread, which is the outcome that has to survive the fix. */
  const physics = new Physics();
  const add = (m) => { m.updateWorldMatrix(true, false); physics.addBoxFromObject(m); return m; };
  const deck = new THREE.Mesh(new THREE.BoxGeometry(200, 2, 200));
  deck.position.set(0, -1, 0);
  add(deck);
  const wall = new THREE.Mesh(new THREE.BoxGeometry(2, 6, 60));
  wall.position.set(10, 3, 0);
  add(wall);

  const player = settle(makePlayer(physics), 0, 0, 0.5, 120);
  const probes = countProbes(physics);
  const branch = countStepBranch(physics, player);
  player.input.state.forward = 1;
  let t = 2;
  let maxY = -Infinity;
  for (let i = 0; i < 60 * 8; i++, t += DT) {
    player.fixedUpdate(DT, t);
    maxY = Math.max(maxY, player.position.y);
  }
  assert.ok(player.position.x < 9.0, `walked to x = ${player.position.x.toFixed(3)}, through a wall at 9`);
  assert.ok(maxY < 0.05, `climbed ${maxY.toFixed(4)} m up a sheer wall`);
  // The branch runs and gives up: lifting by the step height buys no extra
  // motion against 6 m of wall, so it never even reaches the tread probe.
  assert.ok(branch() > 0, 'the step-up branch never even looked at the wall');
  assert.equal(probes(), 0, `${probes()} tread probes at a sheer wall`);
});

test('the boundary between a slope you can climb and one you cannot has not moved', () => {
  /* The gate reads `Grounding.WALKABLE_NORMAL_Y`, the same number that decides
   * what a character may stand on, precisely so that no second definition of
   * walkable exists to disagree with the first. Where the player actually stops
   * climbing is set by `resolveCapsule`'s own contact normals rather than by
   * this gate, and the point of pinning it is that the fix did not move it:
   * measured at 1862ed9 and after, the last ramp the player still climbs is 58
   * degrees and 59 defeats it. */
  const climbs = (deg) => {
    const w = rampWorld(deg, { run: 60, width: 120 });
    const player = settle(makePlayer(w.physics), 8, 0, w.surfaceY(8) + 0.5, 200);
    player.input.state.forward = 1;
    const y0 = player.position.y;
    let t = 4;
    for (let i = 0; i < 60 * 4; i++, t += DT) player.fixedUpdate(DT, t);
    return player.position.y - y0 > 0.5;
  };
  assert.equal(climbs(57), true, 'a 57 degree ramp stopped being climbable');
  assert.equal(climbs(58), true, 'a 58 degree ramp stopped being climbable');
  assert.equal(climbs(59), false, 'a 59 degree ramp became climbable');
  assert.equal(climbs(65), false, 'a 65 degree ramp became climbable');
});
