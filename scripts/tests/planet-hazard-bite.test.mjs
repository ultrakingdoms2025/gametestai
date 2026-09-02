import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { CONFIG } from '../../src/core/Config.js';
import { PLANETS } from '../../src/worlds/planets/index.js';
import { hazardSpec, makeHazardSample } from '../../src/worlds/planets/PlanetHazard.js';
import { Physics } from '../../src/physics/Physics.js';
import { harness, world_ } from './planet-walk-kit.mjs';
import { HUD } from '../../src/ui/HUD.js';

/**
 * THE HAZARDS BITE.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DEFECT THIS FILE CLOSES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `PlanetWorld._buildHazardField` said it in as many words: *"Nothing in
 * `src/player` reads this field today. The world publishes it, the tells are
 * drawn, the tests measure it ... Until it lands these three hazards are
 * visible and measured and do not yet bite."* So Cinder drew a 24 m scorch
 * ring nobody could be hurt by, Sirocco's ash thickened on a crest that pushed
 * nothing, and Cathedra's summit cost no breath. `planet-hazards.test.mjs`
 * asserts the FIELD is right. This file asserts the field is CHARGED - against
 * the real `Player`, the real friction, the real stamina pool and the real
 * alert bar.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE ONE MEASUREMENT THAT CHANGED THE IMPLEMENTATION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The handover patch applied the wind through `Player.applyImpulse` with
 * `push * dt`, i.e. as an acceleration. Driven against the real controller
 * that measures **0.0000 m/s of settled drift**: `_applyFriction` is
 * Source-style, so below `STOP_SPEED` it is a CONSTANT deceleration of
 * `STOP_SPEED * friction` - 11 m/s², or 2.42 once the impulse stagger has cut
 * friction to 22% - against 0.854 m/s² of moving air. The wind is shed in full
 * every step and the player never leaves the origin.
 *
 * There is no scaling that rescues it. The same rig at ten times the
 * acceleration measures 3.74 m/s, which is 81% of `walkSpeed` and breaks the
 * one guarantee the design makes. The channel is bimodal - nothing, then
 * nearly unwalkable - because friction's floor is a step and not a slope. And
 * `applyImpulse` re-arms `IMPULSE_STAGGER` on every call, so a player standing
 * in the wind would hold a permanent stagger and walk the whole planet on 22%
 * friction (`_impulseTime` measured pinned at 0.403).
 *
 * So the wind enters where a moving medium enters: the DISPLACEMENT `_move`
 * integrates, swept and resolved by the capsule solver like every other metre.
 * The settled drift is then the descriptor's own number with no tuning
 * constant in between, and block 2 measures it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  EVERY BLOCK HAS BEEN WATCHED TO FAIL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Seven mutations were applied to the source and the failures recorded. None
 * of these is a description of what SHOULD happen; each is what DID.
 *
 *   A  drop the fractional carry (floor the per-step damage instead)
 *      -> 6 fail: 1a 1b 1c 1d 5b 6a. 5 dps at 60 Hz is 0.083 of a point and
 *         `Math.floor` of that is zero, every step, for ever.
 *   B  apply the push through `applyImpulse` - the handover patch's channel
 *      -> 3 fail: 2a 2c 2e. The settled drift reads 0.000000 m/s.
 *   C  make the drain a constant instead of following the intensity ramp
 *      -> 5 fail: 3a 3b 3c 4d 6b. 3b is the one that matters: `Stamina.drain`
 *         writes `_lastDrainAt` on every non-zero call and regeneration waits
 *         on it, so a drain that never reaches zero pins the pool at zero for
 *         the rest of the session. The ramp reaching zero below the floor is
 *         the ONLY thing that makes thin air recoverable.
 *   D  drop `setAlert('hazard', null)` from the HUD's leave branch
 *      -> 1 fails: 4b. The heat warning outlives the heat.
 *   E  drop `_endWeather`'s emit, keeping its state reset - the exact shape of
 *      the handover patch's `{ this._hazCarry = 0; this._hazIn = false; }`
 *      -> 2 fail: 4d 4e.
 *   F  move one Cinder rescue point into the band
 *      -> 1 fails: 5a.
 *   G  move the `tickHazard` call below the death and mount branches
 *      -> 2 fail: 4e 6a.
 *   H  remove the `tickHazard` call entirely - THE DEFECT EXACTLY AS FOUND
 *      -> 15 of 22 fail.
 */

/* The planet harness first: it installs the richer 2D context stub that a
 * `PlanetWorld` build needs, and `Weapon`'s viewmodel is happy with it. Both
 * use `??=`, so whichever runs first wins - and it has to be this one. */
harness(THREE);
const { Player } = await import('../../src/player/Player.js');

const DT = 1 / 60;
const P = CONFIG.player;

/* ---------------------------------------------------------------------- */
/* Rig                                                                     */
/* ---------------------------------------------------------------------- */

/** A bus that records, so an assertion can be about an EDGE and not a state. */
function makeBus() {
  const subs = new Map();
  const events = [];
  return {
    events,
    on(type, fn) {
      if (!subs.has(type)) subs.set(type, []);
      subs.get(type).push(fn);
      return () => {
        const a = subs.get(type);
        const i = a.indexOf(fn);
        if (i >= 0) a.splice(i, 1);
      };
    },
    emit(type, e) {
      events.push({ type, ...e });
      for (const fn of [...(subs.get(type) ?? [])]) fn(e);
    },
    of: (type) => events.filter((e) => e.type === type),
  };
}

/** A single flat slab, large enough that no run can reach an edge. */
function flatWorld() {
  const physics = new Physics();
  const deck = new THREE.Mesh(new THREE.BoxGeometry(8000, 2, 8000));
  deck.position.set(0, -1, 0);
  deck.updateWorldMatrix(true, false);
  physics.addBoxFromObject(deck);
  return physics;
}

/**
 * A world publishing one hazard field, in the shape `PlanetWorld` publishes.
 *
 * `sample` is a function of the body's position, so a test can put the player
 * inside the hazard, outside it, or on a boundary without needing terrain.
 */
function hazardWorld(id, cause, name, sample) {
  /* `armed` starts FALSE and `settle` raises it, so the three seconds of
   * settling the controller needs are not also three seconds of burning. The
   * first version of this file measured 17.0 s to death instead of 20.0 for
   * exactly that reason - the rig was charging the player before the clock
   * started. */
  const w = {
    id: 'rig',
    armed: false,
    hazardField: {
      id, kind: id, name, cause,
      peak: { dps: 0, push: 0, stamina: 0 },
      at(x, y, z, o) {
        const s = w.armed ? sample(x, y, z) : {};
        o.intensity = s.intensity ?? 0;
        o.dps = s.dps ?? 0;
        o.pushX = s.pushX ?? 0;
        o.pushZ = s.pushZ ?? 0;
        o.stamina = s.stamina ?? 0;
        return o;
      },
    },
  };
  return w;
}

/** A real `Player` on real physics, told about one world. */
function makePlayer(physics, world, { yaw = -Math.PI / 2 } = {}) {
  const bus = makeBus();
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
  bus.emit('world:changed', { id: world?.id ?? 'rig', world: world ?? null });
  return { player, bus, input };
}

/**
 * Settle the controller on the ground, then arm the hazard.
 *
 * The order is the point: a capsule dropped onto a deck needs a couple of
 * seconds to stop reporting a fall, and a hazard that was already charging
 * through them moves every reading in this file by three seconds' worth.
 */
function settle(player, world = null, steps = 180, t0 = 0) {
  let t = t0;
  for (let i = 0; i < steps; i++, t += DT) player.fixedUpdate(DT, t);
  if (world) world.armed = true;
  return t;
}

/* ====================================================================== */
/* 1. Damage: the published rate, and the truncation that would eat it     */
/* ====================================================================== */

const CINDER = hazardSpec(PLANETS.cinder);

test('1a. the heat band charges at exactly the rate the descriptor derives', () => {
  /* 240 dps of lava spread over the 24 m it radiates across, halved by the
   * declared shimmer strength: 5.0 dps at the shoreline. Driven, not derived -
   * the claim is about `Swim.tickHazard` and `Player.applyDamage`, so those are
   * what answer it. */
  assert.equal(CINDER.peakDps, 5, 'the descriptor no longer derives 5 dps; re-measure the rest of this file');
  const physics = flatWorld();
  const world = hazardWorld('heat', 'heat', CINDER.name, () => ({ intensity: 1, dps: CINDER.peakDps }));
  const { player } = makePlayer(physics, world);
  player._position.set(0, 0.5, 0);
  let t = settle(player, world);

  const start = player.health;
  const n = Math.round(10 / DT);
  for (let i = 0; i < n; i++, t += DT) player.fixedUpdate(DT, t);
  const lost = start - player.health;
  /* Whole points only, so the reading lands on an integer boundary: 50 points
   * in ten seconds, within the one point the carry can be holding. */
  assert.ok(Math.abs(lost - 50) <= 1,
    `ten seconds in the band cost ${lost} of an expected 50 health`);
  console.log(`   [heat] 10.0 s at ${CINDER.peakDps} dps cost ${lost} health of ${start}`);
});

test('1b. twenty seconds in the hottest air is exactly fatal, and no sooner', () => {
  const physics = flatWorld();
  const world = hazardWorld('heat', 'heat', CINDER.name, () => ({ intensity: 1, dps: CINDER.peakDps }));
  const { player, bus } = makePlayer(physics, world);
  player._position.set(0, 0.5, 0);
  let t = settle(player, world);

  /* `SPAWN_INVULN` is not in play here - the player has been alive for three
   * seconds of settling - but the health pool is, and so is the regeneration
   * delay: damage lands five times a second, so `_lastDamageAt` is refreshed
   * long before `healthRegenDelay` and nothing heals under the burn. */
  let died = -1;
  const n = Math.round(30 / DT);
  for (let i = 0; i < n; i++, t += DT) {
    player.fixedUpdate(DT, t);
    if (died < 0 && player.isDead) died = (i + 1) * DT;
  }
  assert.ok(died > 0, 'thirty seconds in a 5 dps band and the player never died');
  assert.ok(Math.abs(died - P.maxHealth / CINDER.peakDps) < 0.25,
    `death at ${died.toFixed(3)} s against ${P.maxHealth}/${CINDER.peakDps} = ${(P.maxHealth / CINDER.peakDps).toFixed(3)} s`);
  const dead = bus.of('player:died');
  assert.equal(dead.length, 1, 'the player died more than once');
  console.log(`   [heat] time to death standing in the hottest air: ${died.toFixed(3)} s`);
});

test('1c. the fractional carry is the whole hazard: without it 5 dps is zero forever', () => {
  /* THE FAILURE PROOF, RUN RATHER THAN DESCRIBED.
   *
   * `applyDamage` takes whole points. 5 dps at 60 Hz is 0.0833 of a point per
   * step, and `Math.floor(0.0833)` is 0 - every step, for ever. The same
   * arithmetic that makes `_burn` and `_breathe` keep an accumulator. Both
   * loops below are driven against the same controller; only the carry
   * differs. */
  const naive = (() => {
    const physics = flatWorld();
    const { player } = makePlayer(physics, null);
    player._position.set(0, 0.5, 0);
    let t = settle(player);
    const start = player.health;
    for (let i = 0; i < Math.round(20 / DT); i++, t += DT) {
      player.applyDamage(Math.floor(CINDER.peakDps * DT), null, 'heat');
      player.fixedUpdate(DT, t);
    }
    return start - player.health;
  })();
  assert.equal(naive, 0,
    'flooring the per-step damage no longer truncates to zero - the carry may no longer be load-bearing');

  const carried = (() => {
    const physics = flatWorld();
    const world = hazardWorld('heat', 'heat', CINDER.name, () => ({ intensity: 1, dps: CINDER.peakDps }));
    const { player } = makePlayer(physics, world);
    player._position.set(0, 0.5, 0);
    let t = settle(player, world);
    const start = player.health;
    for (let i = 0; i < Math.round(20 / DT); i++, t += DT) player.fixedUpdate(DT, t);
    return start - player.health;
  })();
  assert.equal(carried, P.maxHealth, `the carried burn cost ${carried} of ${P.maxHealth}`);
  console.log(`   [heat] 20 s: floored-per-step ${naive} health, carried ${carried} health`);
});

test('1d. a hazard death is attributed to the hazard, not to the void', () => {
  const physics = flatWorld();
  const world = hazardWorld('heat', 'heat', CINDER.name, () => ({ intensity: 1, dps: 40 }));
  const { player, bus } = makePlayer(physics, world);
  player._position.set(0, 0.5, 0);
  let t = settle(player, world);
  for (let i = 0; i < Math.round(6 / DT) && !player.isDead; i++, t += DT) player.fixedUpdate(DT, t);
  assert.equal(player.isDead, true);
  const died = bus.of('player:died');
  assert.equal(died[0].killerId, CINDER.cause,
    `the kill was attributed to ${JSON.stringify(died[0].killerId)} rather than to ${CINDER.cause}`);
  /* And the string survives the trip to the notice the player reads. `_nameOf`
   * is where a `killerId` becomes a kill-feed row, and it needs no npc list to
   * name a cause - the same path 'drowning' and 'lava' already take. */
  assert.equal(HUD.prototype._nameOf.call({}, died[0].killerId), 'HEAT');
  assert.equal(HUD.prototype._nameOf.call({}, null), 'THE VOID',
    'a hazard death that lost its cause would read as THE VOID - that is what this is guarding');
});

/* ====================================================================== */
/* 2. Wind: a carry, and one a body can always out-walk                    */
/* ====================================================================== */

const SIROCCO = hazardSpec(PLANETS.sirocco);

/** Hold `forward` for `seconds` in a full-exposure wind and report the drift. */
function windRun({ forward = 0, yaw = -Math.PI / 2, seconds = 20, viaImpulse = false } = {}) {
  const physics = flatWorld();
  const world = hazardWorld('wind', 'wind', SIROCCO.name, () => ({
    intensity: 1,
    pushX: SIROCCO.dirX * SIROCCO.push,
    pushZ: SIROCCO.dirZ * SIROCCO.push,
  }));
  /* `viaImpulse` reproduces the handover patch's channel exactly: the field is
   * withheld from the player so nothing sets a drift, and the same push is
   * delivered as an acceleration instead. */
  const { player } = makePlayer(physics, viaImpulse ? null : world, { yaw });
  player._position.set(0, 0.5, 0);
  let t = settle(player, world);
  player.input.state.forward = forward;
  for (let i = 0; i < 300; i++, t += DT) {
    if (viaImpulse) player.applyImpulse({ x: SIROCCO.dirX * SIROCCO.push * DT, y: 0, z: SIROCCO.dirZ * SIROCCO.push * DT });
    player.fixedUpdate(DT, t);
  }
  const from = player.position.clone();
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++, t += DT) {
    if (viaImpulse) player.applyImpulse({ x: SIROCCO.dirX * SIROCCO.push * DT, y: 0, z: SIROCCO.dirZ * SIROCCO.push * DT });
    player.fixedUpdate(DT, t);
  }
  const d = player.position.clone().sub(from);
  return {
    along: (d.x * SIROCCO.dirX + d.z * SIROCCO.dirZ) / seconds,
    total: Math.hypot(d.x, d.z) / seconds,
    impulseTime: player._impulseTime,
  };
}

/** Facing straight into the wind: `Player`'s forward is (-sin yaw, -cos yaw). */
const YAW_UPWIND = Math.atan2(SIROCCO.dirX, SIROCCO.dirZ);

test('2a. the settled drift is the metres per second of air the descriptor declares', () => {
  const r = windRun({});
  assert.ok(Math.abs(r.along - SIROCCO.push) < 1e-6,
    `a body standing in the full wind drifted ${r.along.toFixed(6)} m/s against a published ${SIROCCO.push.toFixed(6)}`);
  assert.ok(Math.abs(r.total - r.along) < 1e-9, 'the drift is not along the wind');
  console.log(`   [wind] settled drift on Sirocco: ${r.along.toFixed(4)} m/s (published ${SIROCCO.push.toFixed(4)})`);
});

test('2b. the drift stays under the budget the design named', () => {
  /* 0.9 m/s is the number the brief put on this, and 4.6 is `walkSpeed`. The
   * second assertion is the one that matters if the descriptor's drift is ever
   * re-authored: a wind at a fifth of a walk is weather, a wind at four fifths
   * of one is a wall. */
  const r = windRun({});
  assert.ok(r.along < 0.9, `the settled drift is ${r.along.toFixed(4)} m/s, over the 0.9 budget`);
  assert.ok(r.along < P.walkSpeed * 0.25,
    `the wind is ${(100 * r.along / P.walkSpeed).toFixed(1)}% of walkSpeed; over 25% and it stops reading as weather`);
});

test('2c. a body always out-walks the wind, and the margin is a walk and not a sprint', () => {
  const up = windRun({ forward: 1, yaw: YAW_UPWIND });
  const down = windRun({ forward: 1, yaw: Math.atan2(-SIROCCO.dirX, -SIROCCO.dirZ) });
  const net = -up.along;
  assert.ok(net > 0, `walking straight upwind made ${net.toFixed(4)} m/s of progress - the wind is a wall`);
  assert.ok(Math.abs(net - (P.walkSpeed - SIROCCO.push)) < 1e-6,
    `upwind progress ${net.toFixed(6)} against walkSpeed - push = ${(P.walkSpeed - SIROCCO.push).toFixed(6)}`);
  assert.ok(Math.abs(down.along - (P.walkSpeed + SIROCCO.push)) < 1e-6,
    `downwind ${down.along.toFixed(6)} against walkSpeed + push = ${(P.walkSpeed + SIROCCO.push).toFixed(6)}`);
  /* The escape is 40 m at worst (`MAX_ESCAPE`, measured on the built terrain by
   * `planet-hazards.test.mjs`). At the worst heading that is: */
  console.log(`   [wind] upwind ${net.toFixed(4)} m/s, downwind ${down.along.toFixed(4)} m/s; `
    + `40 m dead upwind takes ${(40 / net).toFixed(1)} s`);
  assert.ok(40 / net < 15, 'the worst escape upwind takes longer than a held sprint');
});

test('2d. the acceleration channel measures nothing, which is why it is not the channel', () => {
  /* THE MEASUREMENT THAT CHOSE THE IMPLEMENTATION, kept as a gate.
   *
   * `_applyFriction` below `STOP_SPEED` is a CONSTANT deceleration of
   * `STOP_SPEED * friction`. Any continuous acceleration under that is shed in
   * full every step, and 0.854 m/s² is 8% of it. If someone lowers friction or
   * raises the wind past the floor this fails, and the right response is to
   * re-measure the whole block rather than to delete it. */
  const floor = 1.1 * P.friction * 0.22;   // STOP_SPEED * friction * IMPULSE_FRICTION
  assert.ok(SIROCCO.push < floor,
    `the wind (${SIROCCO.push.toFixed(3)}) now exceeds the staggered friction floor (${floor.toFixed(3)})`);
  const r = windRun({ viaImpulse: true });
  assert.ok(Math.abs(r.along) < 1e-9,
    `the impulse channel drifted ${r.along.toFixed(9)} m/s - it used to measure exactly zero`);
  assert.ok(r.impulseTime > 0.3,
    'the impulse channel no longer pins a permanent stagger - the second reason it was rejected is gone');
  console.log(`   [wind] impulse channel: ${r.along.toFixed(6)} m/s drift, `
    + `_impulseTime pinned at ${r.impulseTime.toFixed(3)} (a permanent 22% friction)`);
});

test('2e. the carry never enters velocity, so nothing downstream reads it as running', () => {
  /* The bob, the footsteps, the sprint gate and every speed readout in the HUD
   * are `Math.hypot(velocity.x, velocity.z)`. A wind written into velocity
   * would have a standing player jogging on the spot. */
  const physics = flatWorld();
  const world = hazardWorld('wind', 'wind', SIROCCO.name, () => ({
    intensity: 1, pushX: SIROCCO.dirX * SIROCCO.push, pushZ: SIROCCO.dirZ * SIROCCO.push,
  }));
  const { player } = makePlayer(physics, world);
  player._position.set(0, 0.5, 0);
  let t = settle(player, world);
  for (let i = 0; i < 600; i++, t += DT) player.fixedUpdate(DT, t);
  assert.ok(Math.hypot(player.velocity.x, player.velocity.z) < 1e-6,
    `a body standing in the wind reports ${Math.hypot(player.velocity.x, player.velocity.z).toFixed(6)} m/s of velocity`);
  assert.ok(Math.abs(player.environmentDrift.x - SIROCCO.dirX * SIROCCO.push) < 1e-9,
    'the drift is not where the drift belongs');
});

/* ====================================================================== */
/* 3. Thin air: a ration, not a wound                                      */
/* ====================================================================== */

const CATHEDRA = hazardSpec(PLANETS.cathedra);

function thinAirWorld(intensity = 1) {
  return hazardWorld('thin_air', 'altitude', CATHEDRA.name,
    () => ({ intensity, stamina: intensity * CATHEDRA.drain }));
}

test('3a. thin air rations the sprint and cannot cost a single hit point', () => {
  /* The property the whole design rests on: `PlanetHazard` allows a landing pad
   * inside the thin air and forbids one inside the heat, because "a stamina
   * drain cannot trap anybody". That is only true while nothing in this path
   * can reach `applyDamage`. */
  const physics = flatWorld();
  const world = thinAirWorld(1);
  const { player, input } = makePlayer(physics, world);
  player._position.set(0, 0.5, 0);
  let t = settle(player, world);
  const health = player.health;
  input.forward = 1;
  player.input.state.forward = 1;
  player.input.state.sprint = true;

  let exhaustedAt = -1;
  for (let i = 0; i < Math.round(60 / DT); i++, t += DT) {
    player.fixedUpdate(DT, t);
    if (exhaustedAt < 0 && player.stamina.exhausted) exhaustedAt = (i + 1) * DT;
  }
  assert.equal(player.health, health, 'thin air took health');
  assert.equal(player.isDead, false);
  assert.ok(exhaustedAt > 0, 'a held sprint in thin air never ran the pool out');
  /* 15/s of sprint plus 3.0/s of altitude out of a pool of 100. The sprint
   * latches off at zero and re-arms at a fifth, so the ration cycles rather
   * than ending - which is why the assertion is a band and not an equality. */
  const together = P.sprintStaminaDrain + CATHEDRA.drain;
  assert.ok(exhaustedAt < P.maxStamina / P.sprintStaminaDrain,
    `thin air made the sprint no shorter (${exhaustedAt.toFixed(2)} s against a sea-level ${(P.maxStamina / P.sprintStaminaDrain).toFixed(2)} s)`);
  console.log(`   [thin air] held sprint on the summit ran out at ${exhaustedAt.toFixed(2)} s `
    + `(${P.sprintStaminaDrain} + ${CATHEDRA.drain} = ${together}/s out of ${P.maxStamina})`);
});

test('3b. descending below the floor gives the breath back, in full', () => {
  /* THE UNRECOVERABLE STATE THIS IS GUARDING.
   *
   * `Stamina.drain` writes `_lastDrainAt` on every non-zero call, and
   * regeneration waits `staminaRegenDelay` after the last one - so ANY
   * continuous drain, however small, suppresses recovery outright. That is the
   * intended behaviour on the summit ("standing still stops refilling"), and it
   * is only survivable because the ramp reaches zero: below `THIN_AIR_FLOOR`
   * the sampler returns `intensity` 0, `tickHazard` returns before it calls
   * `drain`, and the pool refills. Remove that early return and this test never
   * comes back. */
  const physics = flatWorld();
  let altitude = 1;
  const world = hazardWorld('thin_air', 'altitude', CATHEDRA.name,
    () => ({ intensity: altitude, stamina: altitude * CATHEDRA.drain }));
  const { player } = makePlayer(physics, world);
  player._position.set(0, 0.5, 0);
  let t = settle(player, world);

  for (let i = 0; i < Math.round(60 / DT); i++, t += DT) player.fixedUpdate(DT, t);
  assert.equal(player.stamina.value, 0, 'a minute standing on the summit did not empty the pool');
  assert.equal(player.stamina.exhausted, true);

  altitude = 0;                                   // walked back down below the floor
  for (let i = 0; i < Math.round(60 / DT); i++, t += DT) player.fixedUpdate(DT, t);
  assert.equal(player.stamina.value, player.stamina.max,
    `a minute below the floor recovered to ${player.stamina.value.toFixed(1)} of ${player.stamina.max}`);
  assert.equal(player.stamina.exhausted, false, 'the exhaustion latch never released');
  console.log(`   [thin air] summit -> floor: pool 0 -> ${player.stamina.value} inside 60 s`);
});

test('3c. thin air is drawn from the pool the sprint is drawn from, at the published fifth', () => {
  assert.equal(CATHEDRA.drain, 3);
  assert.ok(Math.abs(CATHEDRA.drain / P.sprintStaminaDrain - 0.2) < 1e-9,
    `the drain is ${(CATHEDRA.drain / P.sprintStaminaDrain).toFixed(3)} of a sprint, not the documented fifth`);
  const physics = flatWorld();
  const world = thinAirWorld(1);
  const { player, bus } = makePlayer(physics, world);
  player._position.set(0, 0.5, 0);
  let t = settle(player, world);
  const before = player.stamina.value;
  for (let i = 0; i < Math.round(5 / DT); i++, t += DT) player.fixedUpdate(DT, t);
  const rate = (before - player.stamina.value) / 5;
  assert.ok(Math.abs(rate - CATHEDRA.drain) < 0.05,
    `standing still in thin air drained ${rate.toFixed(3)}/s against a published ${CATHEDRA.drain}`);
  assert.equal(player.stamina.lastReason, CATHEDRA.cause,
    'the drain is not attributed to the altitude');
  assert.equal(bus.of('player:damaged').length, 0, 'thin air raised a damage event');
});

/* ====================================================================== */
/* 4. The tell: a standing alert, raised and cleared on the edges          */
/* ====================================================================== */

/** `_wireAlerts` and `setAlert` over a real bus and a shim bar. */
function alertRig() {
  const bus = makeBus();
  const h = Object.create(HUD.prototype);
  h.bus = bus;
  h._offs = [];
  h._alerts = new Map();
  h.alertText = { textContent: '' };
  h.alertEl = { hidden: true };
  h.notify = () => {};
  h._wireAlerts();
  return { h, bus };
}

test('4a. entering a hazard raises the bar, and it names the weather and the way out', () => {
  for (const planet of [PLANETS.cinder, PLANETS.sirocco, PLANETS.cathedra]) {
    const spec = hazardSpec(planet);
    const { h, bus } = alertRig();
    assert.equal(h.alertEl.hidden, true);
    bus.emit('player:hazard', { in: true, id: spec.id, name: spec.name, cause: spec.cause });
    assert.equal(h.alertEl.hidden, false, `${planet.id} raised no alert`);
    const text = h.alertText.textContent;
    assert.ok(text.toLowerCase().includes(spec.name.toLowerCase()),
      `${planet.id}: the bar reads ${JSON.stringify(text)} and never names "${spec.name}"`);
    assert.ok(!text.includes('Move clear of it.'),
      `${planet.id} fell through to the generic instruction - its cause "${spec.cause}" has no line`);
    console.log(`   [alert] ${planet.id}: ${text}`);
  }
});

test('4b. leaving clears it, and clears only it', () => {
  const { h, bus } = alertRig();
  bus.emit('session:offline', { reason: 'test' });
  bus.emit('player:hazard', { in: true, id: 'heat', name: 'radiant heat off the lava', cause: 'heat' });
  assert.ok(h.alertText.textContent.includes('heat'), 'the newest condition is not the one shown');

  bus.emit('player:hazard', { in: false, id: 'heat' });
  assert.equal(h.alertEl.hidden, false,
    'clearing the hazard took down the offline warning with it - the Map is not keyed');
  assert.ok(h.alertText.textContent.startsWith('Offline'),
    `the bar fell back to ${JSON.stringify(h.alertText.textContent)} rather than to the condition still true`);

  bus.emit('session:offline', { reason: null });   // re-raise; nothing clears this one
  bus.emit('player:hazard', { in: false, id: 'heat' });
  assert.ok(!h._alerts.has('hazard'), 'a cleared hazard is still in the Map');
});

test('4c. an unrecognised cause still gets a bar, so a fourth hazard is visible on day one', () => {
  const { h, bus } = alertRig();
  bus.emit('player:hazard', { in: true, id: 'rime', name: 'freezing rime', cause: 'cold' });
  assert.equal(h.alertEl.hidden, false);
  assert.ok(h.alertText.textContent.startsWith('Freezing rime'),
    `an unknown cause produced ${JSON.stringify(h.alertText.textContent)}`);
});

test('4d. the edge is an edge: standing in it does not re-raise, and leaving twice is once', () => {
  /* The bar is a state, so `Swim.tickHazard` must emit once on entry and once
   * on exit. Driven against the real module rather than asserted about it. */
  const physics = flatWorld();
  let inside = 1;
  const world = hazardWorld('heat', 'heat', CINDER.name, () => ({ intensity: inside, dps: inside * CINDER.peakDps }));
  const { player, bus } = makePlayer(physics, world);
  player._position.set(0, 0.5, 0);
  let t = settle(player, world);
  bus.events.length = 0;

  for (let i = 0; i < 300; i++, t += DT) player.fixedUpdate(DT, t);
  let evts = bus.of('player:hazard');
  assert.equal(evts.length, 1, `five seconds in the band raised ${evts.length} hazard events`);
  assert.equal(evts[0].in, true);

  inside = 0;
  for (let i = 0; i < 300; i++, t += DT) player.fixedUpdate(DT, t);
  evts = bus.of('player:hazard');
  assert.equal(evts.length, 2, `five seconds out of the band raised ${evts.length - 1} more`);
  assert.equal(evts[1].in, false);
  assert.equal(evts[1].id, 'heat');
});

test('4e. a world with no hazard clears the bar, and so does dying in one', () => {
  /* Both are exits nothing else would ever emit. The handover patch cleared the
   * state on both and emitted on NEITHER, which leaves a heat warning standing
   * on a planet with no lava and over a corpse. */
  for (const exit of ['world', 'death']) {
    const physics = flatWorld();
    const world = hazardWorld('heat', 'heat', CINDER.name, () => ({ intensity: 1, dps: 400 }));
    const { player, bus } = makePlayer(physics, world);
    player._position.set(0, 0.5, 0);
    let t = settle(player, world);
    for (let i = 0; i < 6; i++, t += DT) player.fixedUpdate(DT, t);
    assert.equal(bus.of('player:hazard').length, 1, `${exit}: never entered`);

    if (exit === 'world') bus.emit('world:changed', { id: 'nowhere', world: { id: 'nowhere' } });
    for (let i = 0; i < Math.round(2 / DT); i++, t += DT) player.fixedUpdate(DT, t);

    const evts = bus.of('player:hazard');
    assert.equal(evts.length, 2, `${exit}: the leave edge never fired (${evts.length} events)`);
    assert.equal(evts[1].in, false);
    if (exit === 'death') assert.equal(player.isDead, true, 'the death exit never killed anybody');
  }
});

/* ====================================================================== */
/* 5. Not a trap: nothing puts a player back inside a hazard              */
/* ====================================================================== */

test('5a. every destination a stuck or dead player is sent to reads zero hazard', async () => {
  /* `Unstuck` has exactly three classes of destination - the pad the ship was
   * set down on, the nearest landing site, and the world spawn - and
   * `Player.respawn` teleports to the last anchor, which is written by
   * `teleport` and is a pad on arrival. So the whole rescue surface is
   * `landingSites` plus `playerSpawn`, and every one of them has to read zero
   * or the rescue key is a way to die twice. */
  const out = makeHazardSample();
  for (const planet of [PLANETS.cinder, PLANETS.sirocco, PLANETS.cathedra]) {
    const { world } = await world_(planet);
    const f = world.hazardField;
    assert.ok(f, `${planet.id} publishes no hazard field`);
    const points = [
      { id: 'spawn', p: world.playerSpawn },
      ...world.landingSites.map((s) => ({ id: `pad:${s.id}`, p: { x: s.position.x, y: s.position.y + 0.4, z: s.position.z } })),
    ];
    for (const { id, p } of points) {
      const s = f.at(p.x, p.y, p.z, out);
      /* DAMAGE is the trap condition and nothing else is. `PlanetHazard` says
       * so and this agrees with it: a stamina drain gates the sprint and the
       * climb and never the walk, and a push is a push. */
      assert.equal(s.dps, 0, `${planet.id} ${id} stands in ${s.dps.toFixed(2)} dps of ${f.name}`);
      /* Measured rather than assumed, and the measurement corrected the first
       * draft of this assertion: Sirocco's own arrival pad sits in the full
       * 0.85 m/s of its wind, which is CORRECT - it is a windy planet and the
       * pad is on it. What would not be correct is a rescue point a body
       * cannot walk off, so the bound is against `walkSpeed`, not zero. */
      const blown = Math.hypot(s.pushX, s.pushZ);
      assert.ok(blown < P.walkSpeed * 0.25,
        `${planet.id} ${id} is blown at ${blown.toFixed(2)} m/s on arrival - a body cannot walk off it`);
      if (blown > 0) console.log(`   [trap] ${planet.id} ${id} arrives in ${blown.toFixed(2)} m/s of wind (walkable)`);
    }
    console.log(`   [trap] ${planet.id}: ${points.length} rescue points, none of them damaging (${f.name})`);
  }
});

test('5b. dying in the heat band on Cinder respawns clear of it, at full health', async () => {
  /* The loop this is refusing: die in the band, respawn in the band, die again.
   * Driven end to end on the REAL planet - real terrain, real colliders, real
   * pads - with the player standing on the hottest walkable cell there is. */
  const { world, physics } = await world_(PLANETS.cinder);
  const f = world.hazardField;
  const out = makeHazardSample();

  /* The hottest cell a body can stand on AND still be standing on ground rather
   * than in the lake. The second half is load-bearing and was learned the hard
   * way: the first pass took the global maximum, which is d = 0 from the shore
   * - i.e. IN the lava - and `Player._ensureWater` builds its own
   * `WaterVolumes` fallback, so the run measured a 0.42 s death at 240 dps and
   * would have called it the heat band. The band is 5 dps and the lake is 240;
   * a test that cannot tell them apart is measuring the wrong hazard.
   *
   * Coarse on purpose at 6 m - the band is 24 m wide. */
  let hot = null;
  for (let x = -700; x <= 700; x += 6) {
    for (let z = -700; z <= 700; z += 6) {
      const g = world._terrainField.sampleHeight(x, z);
      if (g === null || !Number.isFinite(g)) continue;
      const feet = g + 0.3;
      const surface = world.liquidField?.surfaceAt?.(x, z) ?? null;
      if (surface !== null && Number.isFinite(surface) && feet <= surface + 0.02) continue;
      const s = f.at(x, feet, z, out);
      if (s.intensity <= 0) continue;
      if (!hot || s.intensity > hot.i) hot = { x, z, y: g, i: s.intensity, dps: s.dps };
    }
  }
  assert.ok(hot, 'no walkable cell on Cinder reads any heat at all');
  assert.ok(hot.i > 0.5, `the hottest dry cell in the band reads only ${hot.i.toFixed(3)} of full intensity`);
  console.log(`   [trap] Cinder's hottest walkable cell: (${hot.x}, ${hot.y.toFixed(1)}, ${hot.z}) `
    + `intensity ${hot.i.toFixed(4)} = ${hot.dps.toFixed(2)} dps, ${(P.maxHealth / hot.dps).toFixed(1)} s to death`);

  const { player } = makePlayer(physics, world);
  player.teleport(new THREE.Vector3(world.playerSpawn.x, world.playerSpawn.y, world.playerSpawn.z), 0);
  let t = settle(player, null, 120);
  /* Walk in without re-anchoring: `teleport` writes the respawn anchor, and
   * the whole question is where a player who WALKED into the band comes back. */
  player._position.set(hot.x, hot.y + 0.3, hot.z);
  player._velocity.set(0, 0, 0);

  let died = -1;
  let respawned = -1;
  for (let i = 0; i < Math.round(45 / DT); i++, t += DT) {
    player.fixedUpdate(DT, t);
    if (died < 0 && player.isDead) died = (i + 1) * DT;
    if (died > 0 && respawned < 0 && !player.isDead) respawned = (i + 1) * DT;
  }
  assert.ok(died > 0, 'standing in the hottest air on Cinder never killed anybody');
  /* And it was the AIR that did it, at the band's own rate - not the lake. */
  assert.ok(Math.abs(died - P.maxHealth / hot.dps) < 1.5,
    `death at ${died.toFixed(2)} s against the band's own ${(P.maxHealth / hot.dps).toFixed(2)} s - something else killed the player`);
  assert.ok(respawned > 0, `the player died at ${died.toFixed(1)} s and never came back`);
  assert.equal(player.health, player.maxHealth, 'the respawn was not to a full pool');

  const after = f.at(player.position.x, player.position.y, player.position.z, out);
  assert.equal(after.dps, 0,
    `the respawn put the player back into ${after.dps.toFixed(2)} dps of heat - that is the loop`);
  console.log(`   [trap] died at ${died.toFixed(1)} s, respawned at ${respawned.toFixed(1)} s `
    + `on ${after.dps.toFixed(2)} dps ground with ${player.health}/${player.maxHealth} health`);
});

/* ====================================================================== */
/* 6. The call site: charged from every branch, not just the walking one   */
/* ====================================================================== */

test('6a. a mounted rider is still in the air the planet is made of', () => {
  /* `swim.fixedUpdate` is never reached while a mount owns movement, which is
   * why the tick is called ABOVE that branch. Radiant heat is the air, and a
   * rider crossing a scorch ring is in it. */
  const physics = flatWorld();
  const world = hazardWorld('heat', 'heat', CINDER.name, () => ({ intensity: 1, dps: CINDER.peakDps }));
  const { player } = makePlayer(physics, world);
  player._position.set(0, 0.5, 0);
  let t = settle(player, world);
  player.movementOverride = true;
  player._selfOverride = false;
  const start = player.health;
  for (let i = 0; i < Math.round(10 / DT); i++, t += DT) player.fixedUpdate(DT, t);
  assert.ok(start - player.health >= 49,
    `ten seconds of heat while mounted cost ${start - player.health} health`);
});

test('6b. a climbing body breathes the same thin air a walking one does', () => {
  /* The reason the call moved out of `Swim.fixedUpdate` at all. `PlanetHazard`
   * says thin air is "the one of the three that a flying, falling or climbing
   * body is in as much as a walking one", and the free-climb branch returns
   * before the swim step ever runs - so on the one planet with a summit worth
   * climbing, climbing it would have cost nothing. */
  const physics = flatWorld();
  const world = thinAirWorld(1);
  const { player } = makePlayer(physics, world);
  player._position.set(0, 0.5, 0);
  let t = settle(player, world);
  const before = player.stamina.value;
  /* Stand the controller in the mantle branch, which returns above the swim
   * step exactly as the free climb does. */
  player.climb._active = true;
  for (let i = 0; i < Math.round(5 / DT); i++, t += DT) player.fixedUpdate(DT, t);
  player.climb._active = false;
  const drained = before - player.stamina.value;
  assert.ok(drained > 5 * CATHEDRA.drain * 0.9,
    `five seconds of climbing in thin air cost ${drained.toFixed(2)} stamina, not ${(5 * CATHEDRA.drain).toFixed(2)}`);
});

test('6c. a corpse takes no more damage and holds no carry', () => {
  const physics = flatWorld();
  const world = hazardWorld('wind', 'wind', SIROCCO.name, () => ({
    intensity: 1, pushX: SIROCCO.dirX * SIROCCO.push, pushZ: SIROCCO.dirZ * SIROCCO.push,
  }));
  const { player } = makePlayer(physics, world);
  player._position.set(0, 0.5, 0);
  let t = settle(player, world);
  player.applyDamage(player.maxHealth, null, 'test');
  assert.equal(player.isDead, true);
  for (let i = 0; i < 30; i++, t += DT) player.fixedUpdate(DT, t);
  assert.equal(player.environmentDrift.x, 0, 'a corpse is still being blown along the ground');
  assert.equal(player.environmentDrift.z, 0);
});
