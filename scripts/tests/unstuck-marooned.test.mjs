import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

/**
 * THE RESCUE KEY TELLS THE TRUTH.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DEFECT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Measured in a real boot on Cinder, at (21.55, 63.05, -222.41) - the spot four
 * separate 40-second sprints up the flank all stalled at, 39 m short of the
 * Rimhold Shelf pad the ship is parked on:
 *
 *     K  ->  (21.56, 63.03, -222.42)     moved 0.032 m
 *            "Position reset  •  clear of geometry"
 *
 * That is `_tryNudgeUp` succeeding on rung one. The player is standing on
 * perfectly valid ground, so a 0.25 m lift probes clear and has support under
 * it, the rung reports success, and the ladder never reaches the ring search or
 * the spawn. The key moved the player three centimetres and told them it had
 * fixed something.
 *
 * A recovery key that lies is worse than no recovery key, because it takes the
 * player's last idea away from them. The cases below are about the two halves of
 * the fix:
 *
 *   1. A RUNG IS ONLY OFFERED WHEN IT ADDRESSES WHAT IS WRONG. The nudge is for
 *      a body the solver is fighting. On open ground there is nothing to nudge
 *      out of, and a rung whose success condition is satisfied by standing on a
 *      floor is a rubber stamp.
 *   2. THE MESSAGE SAYS WHAT HAPPENED. "Position reset" over a 1 cm nudge and
 *      over a 300 m carry is the same sentence for two different events.
 *
 * ── The fake world ────────────────────────────────────────────────────────
 * `UnstuckSystem` talks to four things - a player, a `Physics`, a world manager
 * and a bus - and every one of them is small enough to stand up honestly here.
 * The physics fake is a FLAT FLOOR at y 0 with an optional block: `resolveCapsule`
 * pushes out of the block and leaves anything else alone, which is exactly the
 * signal `_measurePenetration` reads. Nothing is stubbed to return the answer
 * the test wants.
 */

const FLOOR = 0;

function makeRig({ block = null, pads = [], spawn = [0, 0.3, 40], terrain = true } = {}) {
  const events = [];
  const bus = {
    _h: new Map(),
    on(evt, fn) {
      if (!this._h.has(evt)) this._h.set(evt, []);
      this._h.get(evt).push(fn);
      return () => {};
    },
    emit(evt, payload) {
      events.push({ evt, payload });
      for (const fn of this._h.get(evt) ?? []) fn(payload);
    },
  };

  const inBlock = (p) => block
    && p.x > block.x0 && p.x < block.x1
    && p.y > block.y0 && p.y < block.y1
    && p.z > block.z0 && p.z < block.z1;

  const physics = {
    colliders: [],
    resolveCapsule(p) {
      if (inBlock(p)) p.y = block.y1 + 0.01;      // eject upward, as the solver does
      else if (p.y < FLOOR) p.y = FLOOR;
      return p;
    },
    raycast(origin, dir, dist) {
      // Downward only, and the floor is everywhere.
      if (dir.y >= 0) return null;
      return origin.y + dist >= FLOOR && origin.y >= FLOOR ? { point: new THREE.Vector3(origin.x, FLOOR, origin.z) } : null;
    },
    groundHeight() { return FLOOR; },
    groundHeightOrFallback() { return FLOOR; },
    terrainHeight(x, z) {
      if (!terrain) return null;
      // A flat plain with a 40 m-wide, 30 m-deep pit at the origin: standing in
      // it there is no walk out, and standing outside it there is.
      return Math.hypot(x, z) < 20 ? FLOOR - 30 : FLOOR;
    },
  };

  const player = {
    position: new THREE.Vector3(0, FLOOR, 0),
    velocity: new THREE.Vector3(),
    yaw: 1.234,
    grounded: true,
    isDead: false,
    _capsuleHeight: 1.75,
    teleport(p, yaw) { this.position.copy(p); this.yaw = yaw; },
  };

  const world = {
    id: 'testworld',
    bounds: new THREE.Box3(new THREE.Vector3(-200, -60, -200), new THREE.Vector3(200, 200, 200)),
    playerSpawn: new THREE.Vector3(...spawn),
    landingSites: pads,
  };

  return { bus, physics, player, world, events, worldManager: { active: world } };
}

async function system(rig) {
  const { UnstuckSystem } = await import('../../src/systems/Unstuck.js');
  const u = new UnstuckSystem({
    bus: rig.bus, player: rig.player, physics: rig.physics,
    worldManager: rig.worldManager, input: null,
  });
  // `_elapsed` only advances in `fixedUpdate`; the manual paths read it.
  u._elapsed = 100;
  return u;
}

function harness() {
  if (globalThis.__unstuckHarness) return;
  globalThis.__unstuckHarness = true;
  globalThis.window = globalThis;
  globalThis.window.addEventListener = () => {};
  globalThis.window.removeEventListener = () => {};
  globalThis.document = { activeElement: null };
  globalThis.performance = globalThis.performance ?? { now: () => Date.now() };
}
harness();

const PAD = [{
  id: 'rimhold', name: 'Rimhold Shelf',
  position: new THREE.Vector3(60, 0, -80), radius: 20,
}];

/* ================================================================== */

test('a body standing on open ground is not "freed from geometry"', async () => {
  const rig = makeRig({ pads: PAD });
  const u = await system(rig);
  rig.player.position.set(40, FLOOR, 40);

  u.unstuck('manual');

  const moved = rig.events.find((e) => e.evt === 'player:unstuck');
  assert.ok(moved, 'unstuck emitted nothing');
  assert.notEqual(moved.payload.method, 'nudge',
    'the nudge rung fired on a body that was not inside anything - this is the 1 cm "Position reset" defect,'
    + ' and it reports success for having done nothing');
  assert.equal(moved.payload.method, 'recall',
    'a body that is not stuck IN anything needs a destination, not a lift');

  const note = rig.events.filter((e) => e.evt === 'hud:notify').pop();
  assert.ok(/Rimhold Shelf/.test(note.payload.text),
    `the message has to name where the player went; it said "${note.payload.text}"`);
  assert.ok(!/clear of geometry/.test(note.payload.text),
    'the message still claims geometry was cleared');
});

test('a body genuinely inside geometry still gets the cheap lift, and is told so', async () => {
  /* THE OTHER HALF OF THE GUARANTEE. Gating the nudge is only correct if the
   * case the nudge exists for still reaches it - otherwise this "fix" has
   * traded a lying key for a key that carries people across the map every time
   * their feet clip a kerb. */
  const rig = makeRig({ pads: PAD, block: { x0: -2, x1: 2, y0: -1, y1: 0.6, z0: -2, z1: 2 } });
  const u = await system(rig);
  rig.player.position.set(0, FLOOR, 0);

  assert.ok(u.penetration >= 0);
  u.unstuck('penetration');

  const moved = rig.events.find((e) => e.evt === 'player:unstuck');
  assert.equal(moved.payload.method, 'nudge',
    'a body the solver is ejecting every frame should be lifted out where it stands, not carried to a pad');
  assert.ok(rig.player.position.y > FLOOR, 'the lift did not lift');
  assert.ok(Math.abs(rig.player.position.x) < 1e-6 && Math.abs(rig.player.position.z) < 1e-6,
    'the lift moved the player in plan view; the whole point of rung one is that it does not');
});

test('yaw survives a rescue', async () => {
  const rig = makeRig({ pads: PAD });
  const u = await system(rig);
  rig.player.position.set(40, FLOOR, 40);
  rig.player.yaw = -2.5;
  u.unstuck('manual');
  assert.equal(rig.player.yaw, -2.5, 'being spun to face a new direction reads as a second bug');
});

/* ================================================================== */

test('K asks before it carries you, and both answers are true', async () => {
  /* Automatic recovery commits at once - there is nothing to consent to when
   * you are inside a wall. A manual press on solid ground is the case where the
   * honest answer is sometimes "you are not stuck", and a key that silently
   * teleports anyone who presses it out of curiosity is a fast-travel button on
   * a planet whose entire content is the walk. */
  const rig = makeRig({ pads: PAD });
  const u = await system(rig);
  // In the pit: 30 m down, 40 m across, no way out on the terrain lattice.
  rig.player.position.set(0, FLOOR, 0);
  rig.physics.terrainHeight = (x, z) => (Math.hypot(x, z) < 20 ? FLOOR : FLOOR + 60);

  u._keyUnstuck('manual');
  let notes = rig.events.filter((e) => e.evt === 'hud:notify');
  assert.equal(notes.length, 1, 'the first press should report, not move');
  assert.equal(rig.events.filter((e) => e.evt === 'player:unstuck').length, 0,
    'the first press moved the player without being asked');
  assert.match(notes[0].payload.text, /No walking route out of here/,
    `the probe should have found the pit closed; it said "${notes[0].payload.text}"`);
  assert.match(notes[0].payload.text, /Rimhold Shelf/, 'the offer has to name the destination');

  /* A press that arrives before the offer has been standing for `CONFIRM_ARM`
   * is the SAME press coming down the second manual route, not an answer. */
  u._lastKeyAt = -1e9;
  u._keyUnstuck('manual');
  assert.equal(rig.events.filter((e) => e.evt === 'player:unstuck').length, 0,
    'a press in the same instant confirmed the offer it had just made - one tap became a teleport');

  // Second press, once the question has actually been asked: take the ride.
  u._elapsed += 1;
  u._lastKeyAt = -1e9;
  u._keyUnstuck('manual');
  const moved = rig.events.find((e) => e.evt === 'player:unstuck');
  assert.ok(moved, 'the confirmed press did not move the player');
  assert.equal(moved.payload.method, 'recall');
  assert.ok(rig.player.position.distanceTo(new THREE.Vector3(60, 0, -80)) < 25,
    `the player was carried to ${rig.player.position.toArray()} rather than to the pad`);
});

test('the offer expires, and an expired offer reports again rather than moving you', async () => {
  const rig = makeRig({ pads: PAD });
  const u = await system(rig);
  rig.player.position.set(40, FLOOR, 40);

  u._keyUnstuck('manual');
  u._elapsed += 60;              // long past the window
  u._lastKeyAt = -1e9;
  u._keyUnstuck('manual');

  assert.equal(rig.events.filter((e) => e.evt === 'player:unstuck').length, 0,
    'a press a minute later confirmed an offer the player had forgotten making');
  assert.equal(rig.events.filter((e) => e.evt === 'hud:notify').length, 2,
    'the second press should have made a fresh offer');
});

test('the escape probe sees fences, not just slopes', async () => {
  /* Driven on Shoal before this existed: a body standing on the sea bed 20 m
   * outside a 3.9 m shore fence was told "there IS a walking route from here",
   * because the fence is a box collider and the probe only walked the height
   * field. A confident wrong answer in the one message that exists to be
   * trusted. */
  const rig = makeRig({ pads: PAD });
  rig.physics.terrainHeight = () => FLOOR;         // a featureless plain
  const u = await system(rig);
  rig.player.position.set(0, FLOOR, 0);

  u._keyUnstuck('manual');
  const open = rig.events.filter((e) => e.evt === 'hud:notify').pop().payload.text;
  assert.match(open, /There IS a walking route/, `on an open plain the probe should find the pad; it said "${open}"`);

  // Now ring the player with solid boxes and ask again.
  rig.physics.colliders = [];
  for (let a = 0; a < 64; a++) {
    const th = (a / 64) * Math.PI * 2;
    const x = Math.cos(th) * 12;
    const z = Math.sin(th) * 12;
    rig.physics.colliders.push({
      solid: true, type: 'box',
      halfExtents: new THREE.Vector3(2.5, 4, 2.5),
      matrix: new THREE.Matrix4().makeTranslation(x, FLOOR + 4, z),
    });
  }
  rig.events.length = 0;
  u._index = null;
  u._lastKeyAt = -1e9;
  u._offerTo = null;
  u._elapsed += 30;
  u._keyUnstuck('manual');
  const walled = rig.events.filter((e) => e.evt === 'hud:notify').pop().payload.text;
  assert.match(walled, /No walking route out of here/,
    `a ring of 8 m walls is not a walking route; it said "${walled}"`);
});

/* ================================================================== */

test('the spawn rung asks for the ground on the spawn\'s own storey', async () => {
  /* THE HANGAR ROOF. `groundHeightOrFallback` casts from y 400 and answers with
   * the first thing it hits, which inside a roofed world is the roof. Measured
   * in the Lodestar Yard: the spawn is (0, 0.3, 46), the shed's roof plate is a
   * real collider at 26.8 over the whole of it, and a player who fell out of the
   * bay mouth was recovered 26 m in the air on top of the hangar, walked to the
   * roof cut, and fell through it for 69 damage. */
  const rig = makeRig({ pads: [], spawn: [0, 0.3, 46] });
  /* Counted at the SPAWN's own xz only: the ring search legitimately asks about
   * ground it knows nothing about, and it now asks from the player's storey
   * too - but the rung under test is the spawn one. */
  let skyQueries = 0;
  rig.physics.groundHeight = (x, z, startY) => {
    if (startY > 100) { if (Math.hypot(x, z - 46) < 1) skyQueries++; return 26.8; }
    return FLOOR;
  };
  rig.physics.groundHeightOrFallback = (x, z) => {
    if (Math.hypot(x, z - 46) < 1) skyQueries++;
    return 26.8;
  };
  const u = await system(rig);
  rig.player.position.set(0, -40, 0);                    // fallen out of the world
  rig.player.grounded = false;

  u.unstuck('out-of-world');
  assert.ok(rig.player.position.y < 5,
    `recovery put the player at y ${rig.player.position.y} - that is the roof, not the deck`);
  assert.equal(skyQueries, 0, 'the recovery still asks the sky where the ground is');
});

test('a recall prefers the pad the ship was last set down on', async () => {
  const pads = [
    { id: 'near', name: 'Near Pad', position: new THREE.Vector3(10, 0, 0), radius: 10 },
    { id: 'far', name: 'Far Pad', position: new THREE.Vector3(150, 0, 0), radius: 10 },
  ];
  const rig = makeRig({ pads });
  const u = await system(rig);
  rig.player.position.set(0, FLOOR, 0);

  // No ship anywhere: the nearest pad wins.
  u.unstuck('manual');
  assert.match(rig.events.filter((e) => e.evt === 'hud:notify').pop().payload.text, /Near Pad/);

  // Ship parked on the far one: it wins outright, because "I cannot get back to
  // my ship" is the problem being solved.
  rig.events.length = 0;
  rig.bus.emit('pilot:landed', { world: 'testworld', site: { id: 'far', name: 'Far Pad' } });
  rig.player.position.set(0, FLOOR, 0);
  u.unstuck('manual');
  assert.match(rig.events.filter((e) => e.evt === 'hud:notify').pop().payload.text, /Far Pad/,
    'the rescue took the player to the nearest pad rather than to their ship');

  // Lifted off again: the ship is no longer on a pad and the answer goes back.
  rig.events.length = 0;
  rig.bus.emit('pilot:liftoff', { world: 'testworld' });
  rig.player.position.set(0, FLOOR, 0);
  u.unstuck('manual');
  assert.match(rig.events.filter((e) => e.evt === 'hud:notify').pop().payload.text, /Near Pad/,
    'a stale ship position outlived the take-off and stranded the player at an empty circle');
});

test('a NaN position is still rescued, and does not become NaN again', async () => {
  /* 19 NaN pixels once blacked out a 921,600-pixel frame in this project, and
   * the recovery path for a NaN POSITION used to throw every fixed step. */
  const rig = makeRig({ pads: PAD });
  const u = await system(rig);
  rig.player.position.set(Number.NaN, Number.NaN, Number.NaN);
  u.fixedUpdate(1 / 60, 101);
  for (const v of rig.player.position.toArray()) {
    assert.ok(Number.isFinite(v), `recovery left the player at ${rig.player.position.toArray()}`);
  }
});

/* ================================================================== */
/* THE BACKSTOP IS A CATCH, NOT A DESTINATION                          */
/* ================================================================== */

test('a body standing on a planet\'s backstop is out of the world', async () => {
  /* ═══════════════════════════════════════════════════════════════════════
   * Every planet carries a flat height field 6 m under its deepest terrain,
   * so a body that gets under the ground - off the edge of the playfield, or
   * pushed past the height field's own lip by the solver - lands on something
   * instead of falling until the void catch notices at `bounds.min.y - 25`.
   *
   * That closes the fall and opens this: the backstop is an invisible plane
   * 1,260 m across with nothing on it, and a body standing on it is grounded,
   * not penetrating, and well above `bounds.min.y`. Every detector in
   * `Unstuck` reads "playing normally".
   *
   * MEASURED in a real boot after the backstop shipped. Walk off the edge of
   * Verdigris at (438, 40, 0): the body lands on the backstop at y -6.2 at
   * 2.3 s and is still standing there, hp 100, at 21.6 s, with no rescue and
   * no [K] prompt. Cinder survived the same walk only because the fall there
   * is long enough to be lethal and the death respawn cleaned up after it.
   *
   * MUTATION: drop the `census.floor` branch from `_isOutOfWorld` and this
   * reports a body at the backstop's own height as perfectly fine.
   * ═══════════════════════════════════════════════════════════════════════ */
  const rig = makeRig({ pads: PAD });
  /* A planet-shaped world: terrain bottoming out at -0.15, a backstop 6 m under
   * that, and `bounds.min.y` 6 m under the backstop. Verdigris's real numbers. */
  rig.world.census = { floor: { top: -6.15, half: 630, terrainMinY: -0.15 } };
  rig.world.bounds.min.y = -12.15;
  const u = await system(rig);

  // Standing on the backstop: grounded, unpenetrated, above bounds.min.y.
  assert.equal(u._isOutOfWorld(new THREE.Vector3(438, -6.15, 0)), true,
    'a body standing on the backstop reads as being in the world, so nothing will ever come for it');
  assert.equal(u._isOutOfWorld(new THREE.Vector3(438, -6.0, 0)), true,
    'a body a hand\'s breadth over the backstop is still on it');

  /* And the clearance is real: the deepest REAL ground on this world is 6 m
   * above the backstop, so nothing standing on the map can trip this. */
  assert.equal(u._isOutOfWorld(new THREE.Vector3(0, -0.15, 0)), false,
    'the deepest ground on the map now reads as out of the world - the backstop is too close to it');
  assert.equal(u._isOutOfWorld(new THREE.Vector3(0, 40, 0)), false, 'open air over the map');

  // The old rule still applies on a world with no backstop published.
  const plain = makeRig({});
  const u2 = await system(plain);
  assert.equal(u2._isOutOfWorld(new THREE.Vector3(0, -84, 0)), false, 'inside the void margin');
  assert.equal(u2._isOutOfWorld(new THREE.Vector3(0, -86, 0)), true, 'past bounds.min.y - 25');
});

test('the rescue off a backstop is a carry, not a nudge', async () => {
  /* A body on the backstop HAS FOOTING - that is the whole point of a backstop -
   * so the rungs that address a body the solver is fighting must not be offered,
   * and the recall must be. This is the same rule the file opens with, applied
   * to the one place where "there is a floor under you" is not reassuring. */
  const rig = makeRig({ pads: PAD });
  rig.world.census = { floor: { top: -6.15, half: 630, terrainMinY: -0.15 } };
  rig.world.bounds.min.y = -12.15;
  rig.player.position.set(438, -6.15, 0);
  const u = await system(rig);
  u.recordPad?.(PAD[0]);

  const moved = u.unstuck('out-of-world');
  assert.equal(moved, true, 'a body on the backstop was not moved');
  assert.ok(rig.player.position.y > -6.0,
    `the rescue left the body at y ${rig.player.position.y.toFixed(2)}, still under the map`);
  const ev = rig.events.filter((e) => e.evt === 'player:unstuck').pop();
  assert.ok(ev, 'no player:unstuck was emitted');
  assert.notEqual(ev.payload.method, 'nudge',
    'the backstop rescue used the cheap lift, which moves a body a few centimetres and leaves it under the map');
});
