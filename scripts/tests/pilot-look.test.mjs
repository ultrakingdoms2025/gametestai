import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { rig, domHarness } from './_flightrig.mjs';

domHarness();
const { Player } = await import('../../src/player/Player.js');
const { Flight } = await import('../../src/ships/Flight.js');
const { Piloting } = await import('../../src/ships/Piloting.js');
const { EventBus } = await import('../../src/core/EventBus.js');
const { Physics } = await import('../../src/physics/Physics.js');

/**
 * WHO OWNS THE MOUSE.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DEFECT THIS FILE EXISTS FOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A ship could not be steered. Not "steered badly" - pitch and yaw were
 * exactly zero for every frame of every flight since the piloting drop landed,
 * and a player could throttle, boost, brake and thrust vertically and could
 * not turn the nose one degree.
 *
 * The cause is one word: `consumeLook` is DESTRUCTIVE. It returns the mouse
 * delta accumulated since the last call and zeroes it. `main.js` runs
 * `player.update` before `piloting.update`, `Player.update` called it
 * unconditionally on its first line, and `Flight.readInput` - which is the
 * entire steering input of the flight model - called it three frames' worth of
 * call stack later and got `{0, 0}` every single time.
 *
 * ── Why nothing caught it ──────────────────────────────────────────────────
 *
 * Every existing test of the flight model, and the autopilot in
 * `_flightrig.mjs` that flies `piloting-loop`, `piloting-return` and
 * `space-combat`, writes `flight.setCommand(...)` directly. That is deliberate
 * and correct - it is the same struct a keyboard writes and it keeps those
 * cases about flying rather than about input plumbing - but it enters the
 * pipeline DOWNSTREAM of the half that was broken. Nine hundred seconds of
 * green flight tests could not see it, and neither could a screenshot: a ship
 * flying straight looks exactly like a ship whose stick is dead.
 *
 * It was found by trying to aim a gun at something that was moving.
 *
 * ── What this file does about it ───────────────────────────────────────────
 *
 * It drives a REAL `Player` and a REAL `Flight` in the real frame order, with
 * an input object that counts how many times its look delta is taken. That is
 * the only shape of test that can see this class of bug, because the bug is
 * not in either object - it is in the handover between them.
 */

/** The surface `Player.update` touches, with a counted `consumeLook`. */
function countingInput() {
  return {
    state: {
      forward: 0, right: 0, jump: false, sprint: false, crouch: false,
      fire: false, aim: false, reload: false, interact: false,
      lookX: 0, lookY: 0, wheel: 0,
    },
    textCaptured: false,
    consumed: 0,
    taken: [],
    consumeLook() {
      this.consumed++;
      const l = { dx: this.state.lookX, dy: this.state.lookY };
      this.taken.push(l);
      this.state.lookX = 0;
      this.state.lookY = 0;
      return l;
    },
    consumeWheel() { const w = this.state.wheel; this.state.wheel = 0; return w; },
    pressed() { return false; },
    held() { return false; },
    get locked() { return true; },
  };
}

function makePlayer(input) {
  const bus = new EventBus();
  const physics = new Physics(bus);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 2000);
  const engine = {
    renderer: null, camera, running: false, elapsed: 0,
    onFrameUpdate: () => () => {}, onFixedUpdate: () => () => {}, onResize: () => () => {},
  };
  const player = new Player({
    scene, engine, physics, bus,
    materials: { get: () => new THREE.MeshStandardMaterial(), dispose() {} },
    input, camera,
  });
  return { player, bus, physics, scene, camera, engine };
}

test('an ordinary walk still gets its mouse, and turns with it', () => {
  const input = countingInput();
  const { player } = makePlayer(input);
  const yaw0 = player.yaw;
  input.state.lookX = 0.30;
  input.state.lookY = 0.10;
  player.update(1 / 60, 0);
  console.log(`  on foot: consumed ${input.consumed}x, yaw ${yaw0.toFixed(3)} -> ${player.yaw.toFixed(3)}`);
  assert.equal(input.consumed, 1, 'the player controller must take the mouse when it owns it');
  assert.ok(Math.abs(player.yaw - (yaw0 - 0.30)) < 1e-6,
    `on foot the delta must turn the body - yaw went to ${player.yaw}`);
});

test('a driver that owns yaw and pitch is handed the mouse untouched', () => {
  const input = countingInput();
  const { player } = makePlayer(input);
  /* Exactly what `Piloting._takeBody` writes. */
  player.movementOverride = true;
  player.movementOverrideLook = false;
  player._harnessFrozen = true;

  const yaw0 = player.yaw;
  input.state.lookX = 0.30;
  input.state.lookY = 0.10;
  player.update(1 / 60, 0);

  console.log(`  in a seat: consumed ${input.consumed}x, `
    + `lookX left in the input ${input.state.lookX}`);
  assert.equal(input.consumed, 0,
    'a controller that will not use the delta must not consume it either');
  assert.equal(input.state.lookX, 0.30, 'the delta must still be there for the ship');
  assert.equal(input.state.lookY, 0.10);
  assert.equal(player.yaw, yaw0, 'and the body must not have turned');
});

test('a mount still gets the old behaviour, because it steers from player.yaw', () => {
  const input = countingInput();
  const { player } = makePlayer(input);
  /* `MountManager` raises `movementOverride` and leaves `movementOverrideLook`
   * at its default of true, which means "keep taking mouse-look from here".
   * The fix must not change that: a rider turns the horse by looking. */
  player.movementOverride = true;
  const yaw0 = player.yaw;
  input.state.lookX = 0.20;
  player.update(1 / 60, 0);
  console.log(`  mounted: consumed ${input.consumed}x, yaw ${yaw0.toFixed(3)} -> ${player.yaw.toFixed(3)}`);
  assert.equal(input.consumed, 1, 'a mount still wants the player controller to take it');
  assert.ok(Math.abs(player.yaw - (yaw0 - 0.20)) < 1e-6, 'and to apply it');
});

test('IN THE REAL FRAME ORDER: a mouse sweep reaches the flight model and turns the ship', async () => {
  /* THE WHOLE POINT. Both objects, in the order `main.js` runs them, over the
   * same input - which is the only arrangement in which the defect exists.
   *
   * The measurement is the one a player makes: sweep the mouse and see whether
   * the nose moves. Sixty frames at a steady deflection, and the ship has to
   * have turned a real number of degrees.
   */
  const r = await rig();
  const input = countingInput();
  const { player } = makePlayer(input);
  const flight = new Flight();
  flight.setShip({ powerMul: 1.75, accelMul: 1.75 });

  const piloting = new Piloting({
    scene: r.scene, engine: r.ctx.engine, physics: r.physics, bus: r.bus,
    input, player, camera: r.camera, worldManager: null, ships: null,
  });
  /* Take the body the way boarding does, then hand this file's own `Flight` to
   * the mode so nothing else in the rig is disturbed. */
  piloting.flight = flight;
  piloting._active = true;
  piloting._takeBody();

  const nose = () => flight.forward(new THREE.Vector3());
  const before = nose().clone();

  const DT = 1 / 60;
  for (let i = 0; i < 60; i++) {
    /* One frame of mouse movement, exactly as `Input` accumulates it. */
    input.state.lookX = 0.05;
    input.state.lookY = 0;
    player.update(DT, i * DT);     // main.js: the player controller runs first
    piloting.update(DT, i * DT);   // ...and the ship second
    flight.step(DT, null);
  }

  const turned = Math.acos(Math.max(-1, Math.min(1, before.dot(nose())))) * 57.2958;
  console.log(`  60 frames of steady mouse: nose turned ${turned.toFixed(1)} degrees, `
    + `stick ${flight._stick.x.toFixed(3)}, yaw command ${flight.command.yaw.toFixed(3)}`);

  assert.ok(flight.command.yaw !== 0,
    'floor: the mouse never reached the flight model at all');
  assert.ok(turned > 20,
    `floor: one second of steady mouse must turn the nose - it moved ${turned.toFixed(1)} degrees`);
  /* CEILING: `FLIGHT.yawRate` is 1.05 rad/s (60.2 deg/s) at powerMul 1, and
   * 1.75 x that is 105 deg/s. A second of it cannot exceed that, and a number
   * above it would mean the delta was being applied more than once. */
  assert.ok(turned < 110,
    `ceiling: the ship turned ${turned.toFixed(1)} degrees in a second, past its own rate`);

  piloting.dispose();
});

test('leaving the seat gives the mouse back', () => {
  const input = countingInput();
  const { player } = makePlayer(input);
  const piloting = new Piloting({
    scene: new THREE.Scene(), engine: null, physics: null, bus: new EventBus(),
    input, player, camera: null, worldManager: null,
  });
  piloting._takeBody();
  assert.equal(player.movementOverrideLook, false, 'boarding must claim the mouse');
  piloting._giveBody();
  assert.equal(player.movementOverrideLook, true, 'disembarking must give it back');

  input.state.lookX = 0.25;
  const yaw0 = player.yaw;
  player.update(1 / 60, 0);
  console.log(`  after the hatch opens: consumed ${input.consumed}x, `
    + `yaw ${yaw0.toFixed(3)} -> ${player.yaw.toFixed(3)}`);
  assert.equal(input.consumed, 1);
  assert.ok(Math.abs(player.yaw - (yaw0 - 0.25)) < 1e-6,
    'a pilot who steps out must be able to look around');
  piloting.dispose();
});
