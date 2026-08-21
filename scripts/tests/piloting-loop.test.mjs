import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { rig, goto, settle, DT, steerTo, approach, fly } from './_flightrig.mjs';

/**
 * THE WHOLE LOOP, FLOWN.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT THIS FILE IS FOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The brief names ten arrows:
 *
 *   dock (on foot) -> board at a pier -> launch -> fly -> approach the planet
 *   -> descend -> land -> leave on foot -> explore and mine -> board -> lift
 *   off -> fly back -> dock -> disembark
 *
 * and says that every arrow is a seam and every seam is where this breaks.
 * So this file flies all of them, in order, in one continuous run, with the
 * real integrator, the real `WorldManager`, the real `Physics` and the real
 * hull geometry. Nothing is placed by hand between arrows: the autopilot in
 * `_flightrig.steerTo` writes the same five command fields a keyboard writes
 * and `Piloting` does the rest, so a route it can fly is a route a player can
 * fly.
 *
 * ── The three defects this project keeps shipping, and where each is caught ─
 *
 *  BUILT BUT UNREACHABLE. `Bodies.CINDER` names `surfaceWorld: 'planet:cinder'`
 *  and `planets/index.js` registers `'cinder'`. Case 1 asserts every landable
 *  body resolves to something in `worldManager.ids`, because a planet you can
 *  approach forever and never land on is fifteen unenterable buildings with a
 *  different skin.
 *
 *  A TEST THAT CANNOT FAIL. Every measured claim below is reported as
 *  floor / achieved / ceiling, and the ceiling is taken by ABLATION - the same
 *  run with the thing under test removed. "The nav readout is what gets you
 *  home" is worth nothing unless flying without it fails, so case 9 measures
 *  both.
 *
 *  CONTENT WITH NO ROUTE. Landing sites, mineral nodes and berths are all
 *  reached by flying to them, never by teleporting to them.
 *
 * ── Timings ────────────────────────────────────────────────────────────────
 * Every number in a comment here was produced by this file on this machine and
 * is reproduced by running it. They are simulated seconds, not wall clock.
 */

/* Every landable body has to resolve to a registered world. */
const { BODY_BY_ID, DOCK_ANCHOR, landableBodies, approachState } =
  await import('../../src/worlds/space/Bodies.js');
const { BERTHS } = await import('../../src/worlds/dock/YardPlan.js');
const { NOSE_YAW, FLYABLE } = await import('../../src/ships/ShipModel.js');
const PIL = await import('../../src/ships/Piloting.js');
const { cruiseTopSpeed, boostTopSpeed } = await import('../../src/ships/Flight.js');

const MOUTH = new THREE.Vector3(...DOCK_ANCHOR.mouth);
const CINDER = new THREE.Vector3(...BODY_BY_ID.cinder.position);

/** Stand the player at a berth's apron - the ramp foot a body actually boards from. */
function atApron(r, id) {
  const b = BERTHS.find((x) => x.id === id);
  r.player.position.set(b.apron.x, b.cradleTop, b.apron.z);
  return b;
}

/* ====================================================================== */
/* 1. The registration seam                                               */
/* ====================================================================== */

test('every landable body names a world that is actually registered', async () => {
  const r = await rig();
  const landable = landableBodies();
  assert.ok(landable.length > 0, 'no landable bodies at all - the loop has no destination');

  const missing = [];
  for (const b of landable) {
    const resolved = r.piloting._resolveSurfaceWorld(b.surfaceWorld);
    if (!resolved || !r.wm.ids.includes(resolved)) missing.push(`${b.id} -> ${b.surfaceWorld}`);
  }
  assert.deepEqual(missing, [], `landable bodies with no world: ${missing.join(', ')}`);

  /* THE ABLATION. `_resolveSurfaceWorld` is the whole reason this passes -
   * `Bodies.js` says 'planet:cinder' and the registry says 'cinder'. If a
   * plain lookup also worked, this resolver would be dead code and the case
   * would be measuring nothing. */
  const bare = r.wm.ids.includes(BODY_BY_ID.cinder.surfaceWorld);
  assert.equal(bare, false,
    'Bodies.js and the planet registry now agree on the id, so the resolver in '
    + 'Piloting is dead code and this case no longer proves anything - delete one of them');
});

test('a body whose surface world is not registered is refused loudly, not silently', async () => {
  const r = await rig();
  assert.equal(r.piloting._resolveSurfaceWorld('planet:nowhere'), null);
  assert.equal(r.piloting._resolveSurfaceWorld(null), null);
  // ...and the real one still resolves, so the guard is not simply always-null.
  assert.equal(r.piloting._resolveSurfaceWorld('planet:cinder'), 'cinder');
});

/* ====================================================================== */
/* 2. Boarding at a pier                                                  */
/* ====================================================================== */

test('a body standing at a pier apron can board, and the handover is complete', async () => {
  const r = await rig();
  await goto(r, 'dock');
  r.piloting._recoverToBerth();

  for (const id of FLYABLE) {
    atApron(r, id);
    assert.equal(r.piloting.boardableAt(), id, `${id} is not boardable from its own apron`);
  }

  /* AND NOT WHILE RIDING SOMETHING ELSE. F is the dismount key, and
   * `MountManager` polls the same edge-triggered press in the same frame, so
   * without this a player who rode a hoverboard out onto a pier and pressed F
   * would dismount AND board at once - a mount despawning underneath a ship
   * that has just taken the body. */
  atApron(r, 'kestrel');
  r.piloting.mounts = { mounted: true };
  assert.equal(r.piloting.boardableAt(), null, 'boarded a ship while sitting on a mount');
  r.piloting.mounts = null;
  assert.equal(r.piloting.boardableAt(), 'kestrel');

  // Ten metres off any apron is not a boarding point.
  r.player.position.set(0, 1.2, 40);
  assert.equal(r.piloting.boardableAt(), null, 'the middle of the bay offers a ship to board');

  /* THE REGISTRY HAS TO SEE THE HULLS.
   *
   * `ShipRegistry._adopt` read `worldManager.current`, which has never existed
   * - `WorldManager` publishes `active`. So the registry was dead in the real
   * game: no hulls, `canCustomise` always false, and every livery and upgrade
   * tier stored and applied to nothing. It survived because
   * `ship-customizer.test.mjs` builds its own `{ current: { ships } }` stub and
   * so pinned the wrong property name in both places at once. This asserts it
   * against the REAL manager. */
  assert.deepEqual(
    r.ships.hulls().map((h) => h.id).sort(),
    r.wm.active.ships.map((h) => h.id).sort(),
    'the ship registry cannot see the hulls the yard publishes'
  );
  assert.equal(r.ships.canCustomise, true);

  atApron(r, 'kestrel');
  assert.equal(r.piloting.board('kestrel'), true);
  assert.equal(r.piloting.active, true);

  /* The handover, field by field. Each of these is load-bearing and each has
   * its own consequence if it is missing:
   *   movementOverride        the player would walk out from under the ship
   *   movementOverrideCollide a capsule solve at the keel origin ejects the hull
   *   _harnessFrozen          Player/CameraRig/Unstuck all fight the chase cam
   *   avatar hidden           a running animation on a stationary pair of feet */
  assert.equal(r.player.movementOverride, true);
  assert.equal(r.player.movementOverrideCollide, false);
  assert.equal(r.player._harnessFrozen, true);
  assert.equal(r.piloting.avatar.visible, false);

  // And the ship is on its cradle, not at the origin.
  const b = BERTHS.find((x) => x.id === 'kestrel');
  assert.ok(r.piloting.flight.position.distanceTo(new THREE.Vector3(b.x, b.cradleTop, b.z)) < 0.01);

  /* The hull bias applied. `Flight.setShip` throws when `applyPowers` was never
   * called, and a stock Kestrel that flies at 120 m/s instead of 210 has no
   * symptom at all - so this pins the number rather than trusting the throw. */
  assert.ok(Math.abs(r.piloting.flight.cruiseTop - cruiseTopSpeed(1.75)) < 0.01,
    `stock Kestrel cruise top is ${r.piloting.flight.cruiseTop.toFixed(1)}, expected 210`);

  r.piloting.disembark({ force: true });
  assert.equal(r.player.movementOverride, false);
  assert.equal(r.player._harnessFrozen, false);
  assert.equal(r.piloting.avatar.visible, true);
});

test('the flown hull points where the flight model says it points', async () => {
  const r = await rig();
  await goto(r, 'dock');
  r.piloting._recoverToBerth();
  atApron(r, 'pike');
  r.piloting.board('pike');

  const f = r.piloting.flight;
  /* Roll and pitch it into a pose no axis-aligned test would catch, then
   * compare the MODEL's nose with the FLIGHT's forward. `HullPlan` puts a nose
   * at local +Z and `Flight` puts forward at local -Z; a missing `NOSE_YAW`
   * flies the ship tail first and looks almost right in a still. */
  f.quaternion.setFromEuler(new THREE.Euler(0.4, 1.1, 0.7, 'YXZ'));
  r.piloting._poseModel();
  r.piloting._model.group.updateMatrixWorld(true);

  const hullNose = new THREE.Vector3(0, 0, 1)
    .applyQuaternion(r.piloting._model.group.getWorldQuaternion(new THREE.Quaternion()));
  const flightNose = f.forward(new THREE.Vector3());
  const deg = THREE.MathUtils.radToDeg(hullNose.angleTo(flightNose));
  assert.ok(deg < 1, `hull nose is ${deg.toFixed(2)} deg off the flight nose`);

  // Ablation: without the offset the two are 180 apart, which is the bug.
  const without = new THREE.Vector3(0, 0, 1).applyQuaternion(f.quaternion);
  assert.ok(THREE.MathUtils.radToDeg(without.angleTo(flightNose)) > 179,
    'NOSE_YAW is no longer doing anything, so this case cannot fail');
  assert.equal(NOSE_YAW, Math.PI);

  r.piloting._recoverToBerth();
});

/* ====================================================================== */
/* 3-8. The loop, in one continuous flight                                */
/* ====================================================================== */

/**
 * ONE RUN, ALL TEN ARROWS. Everything after this is measured from it.
 *
 * It is a single test rather than eight because the arrows are a chain: an
 * "it lands" case that started by teleporting a ship to 400 m over a pad would
 * not be testing the descent seam that put it there. The per-arrow assertions
 * are made in place, in order, and the run reports its timings so a change in
 * any one of them is visible in the output rather than only in a pass/fail.
 */
test('the whole loop: board, launch, cross, descend, land, walk, mine, return, dock', async () => {
  const r = await rig();
  await goto(r, 'dock');
  r.piloting._recoverToBerth();
  r.economy.credits = 0;
  const log = [];

  /* ---- 1. board the ore tender at Pier Three ---- */
  atApron(r, 'dray');
  assert.equal(r.piloting.board('dray'), true);
  const f = r.piloting.flight;
  assert.equal(r.piloting.landed, true, 'a berthed ship should start landed, not falling');

  /* ---- 2. launch: fly off the end of the pier ---- */
  let res = await fly(r, () => steerTo(f, new THREE.Vector3(0, 12, -600), { throttle: 1 }),
    () => r.wm.active.id === 'space', { limit: 60 });
  assert.ok(res.done, 'never left the yard');
  log.push(['launch', res.t]);
  assert.equal(r.wm.active.id, 'space');
  assert.equal(r.piloting.active, true, 'the launch seam dropped the player out of the seat');
  assert.equal(r.player.movementOverride, true, 'the world change released the body mid-flight');

  /* The arrival has to be OUTSIDE both the yard and its own docking trigger,
   * or the ship docks again on the frame after it launched. */
  const outByMouth = f.position.distanceTo(MOUTH);
  assert.ok(outByMouth > PIL.DOCK_RANGE,
    `launched to ${outByMouth.toFixed(0)} m from the mouth, inside the ${PIL.DOCK_RANGE} m docking trigger`);
  assert.ok(outByMouth > DOCK_ANCHOR.radius,
    `launched to ${outByMouth.toFixed(0)} m, inside the yard's own ${DOCK_ANCHOR.radius} m envelope`);
  assert.ok(f.speed > 20, 'the launch arrived at a standstill - that is a loading screen, not a flight');

  /* ---- 3-4. cross to Cinder and hand off to its surface ---- */
  let maxTransit = 0;
  const phases = new Set();
  res = await fly(r, () => steerTo(f, CINDER, { throttle: 1, boost: true }), () => {
    maxTransit = Math.max(maxTransit, r.piloting._transit);
    if (r.wm.active.id === 'space') phases.add(approachState(f.position).phase);
    return r.wm.active.id !== 'space';
  }, { limit: 400 });
  assert.ok(res.done, 'never reached Cinder');
  log.push(['crossing', res.t]);
  assert.equal(r.wm.active.id, 'cinder', 'the handoff went somewhere that is not the volcanic planet');

  /* Every phase in `APPROACH_PHASE` was entered, in a real descent. This is the
   * regression guard for the defect `Bodies.js` documents: `atmosphere` and
   * `handoff` were both 9,700 once, so `phase: 'atmosphere'` existed in the
   * enum and could never be reached. */
  for (const p of ['cruise', 'approach', 'atmosphere']) {
    assert.ok(phases.has(p), `the descent never passed through phase "${p}" - it is unreachable again`);
  }
  assert.ok(maxTransit > 1.5, 'transit never engaged over 62 km of empty volume');

  /* ---- 5. descend and land on the pad ---- */
  const world = r.wm.active;
  const pad = world.landingSites.find((s) => s.primary);
  assert.ok(pad, 'the planet has no primary landing site');
  const entryAlt = f.position.y - pad.position.y;
  assert.ok(entryAlt > 200,
    `entered at ${entryAlt.toFixed(0)} m over the pad - that is a drop, not a descent`);
  const half = world.planet.half;
  assert.ok(Math.max(Math.abs(f.position.x), Math.abs(f.position.z)) < half,
    'entered OUTSIDE the playfield, which fires the departure seam on the first step');

  const aim = pad.position.clone().setY(pad.position.y + 2);
  res = await fly(r, () => approach(f, aim, { k: 0.3, min: 7, max: 90 }),
    () => r.piloting.landed || r.wm.active.id !== 'cinder', { limit: 200 });
  assert.ok(res.done, 'never got down');
  log.push(['descent', res.t]);
  assert.equal(r.wm.active.id, 'cinder', 'bounced back off the planet instead of landing on it');
  assert.equal(r.piloting.landed, true);
  assert.equal(r.piloting.landedSite?.id, 'ashfall',
    `set down at ${r.piloting.landedSite?.id ?? 'open ground'} rather than the primary pad`);
  assert.equal(r.player.damageTaken, 0, 'a controlled approach still hurt the pilot');

  /* AND IT IS SITTING FLAT.
   *
   * A ship keeps whatever attitude it was flying when it touched down, and a
   * pilot on final approach is nose-down. This exact clean landing - 8 m/s,
   * dead centre of the primary pad - left the Kestrel standing on its tail at
   * 65 degrees off level, and every assertion above passed. It was found by
   * walking away from the parked ship in a browser and turning round to look
   * at it, which is the only instrument that would have. */
  const settled = f.up(new THREE.Vector3());
  assert.ok(settled.y > 0.999,
    `parked at ${THREE.MathUtils.radToDeg(Math.acos(Math.min(1, settled.y))).toFixed(1)} deg off level `
    + '- the hull is standing on its tail');

  /* ---- 6. leave the ship on foot ---- */
  assert.equal(r.piloting.disembark(), true, 'could not get out on a landing pad');
  assert.equal(r.player.movementOverride, false);
  const gFeet = r.physics.groundHeight(r.player.position.x, r.player.position.z, r.player.position.y + 4, 40);
  assert.notEqual(gFeet, null, 'stepped out over a hole in the world');
  assert.ok(Math.abs(r.player.position.y - gFeet) < 0.5,
    `stepped out ${(r.player.position.y - gFeet).toFixed(2)} m off the deck`);
  assert.ok(r.player.position.distanceTo(f.position) < 20, 'stepped out a long way from the ship');

  /* OUT OF THE DOOR, NOT THROUGH THE FAR FLANK.
   *
   * Every walkable hull cuts its hatch in local -X, and the model's `NOSE_YAW`
   * maps that to the flight frame's POSITIVE right. The first version stepped
   * out the other way, and on a 28 m ore tender that is the blind side. Here
   * there is no berth apron to fall back on - this is open ground on a
   * planet - so the sign is the only thing carrying it. */
  const side = new THREE.Vector3().subVectors(r.player.position, f.position)
    .dot(f.right(new THREE.Vector3()));
  assert.ok(side > 0,
    `stepped out ${(-side).toFixed(1)} m to the blind side of the hull, away from the hatch`);

  /* ---- 7. mine ---- */
  const before = r.piloting.cargoUnits;
  let mined = 0;
  let refusedFull = 0;
  for (const node of world.mineralNodes) {
    r.player.position.copy(node.position);
    const near = r.mining.nearest();
    assert.equal(near?.id, node.id, 'standing on a node and the prompt does not see it');
    const m = r.mining.mine(near);
    if (m.ok) mined++;
    else if (m.reason === 'hold-full') refusedFull++;
  }
  assert.ok(mined > 0, 'nothing on the planet could be mined');
  assert.equal(r.piloting.cargoUnits, r.piloting.cargoCapacity,
    'the hold did not fill, so its capacity is not what limits a run');
  assert.ok(refusedFull > 0, 'the hold never refused - capacity is not enforced');
  assert.ok(r.piloting.cargoValue > 0, 'the ore is worth nothing');
  log.push(['mined', mined, 'refused', refusedFull, 'value', r.piloting.cargoValue]);
  void before;

  /* A mined node is gone: it cannot be taken twice and it is no longer drawn. */
  const first = world.mineralNodes[0];
  assert.equal(r.mining.mine(first).ok, false, 'a worked-out seam can be worked again');
  const m4 = new THREE.Matrix4();
  first.mesh.getMatrixAt(first.slot, m4);
  const scale = new THREE.Vector3().setFromMatrixScale(m4);
  assert.ok(scale.length() < 1e-6, 'a mined node is still drawn');

  /* ---- 8. board again and lift off ---- */
  r.player.position.copy(f.position);
  assert.equal(r.piloting.boardableAt(), 'dray', 'cannot board the ship you are standing next to');
  assert.equal(r.piloting.board('dray'), true);
  res = await fly(r, () => f.setCommand({ pitch: 0.6, yaw: 0, roll: 0, throttle: 1, vertical: 1, boost: true }),
    () => r.wm.active.id === 'space', { limit: 120 });
  assert.ok(res.done, 'could not climb off the planet');
  log.push(['liftoff', res.t]);

  /* Out along the line home, and OUTSIDE the atmosphere - otherwise the
   * handoff fires again and the ship falls straight back down. */
  const a = approachState(f.position);
  assert.equal(a.shouldHandoff, false, 'departing orbit puts the ship straight back into the handoff sphere');
  assert.ok(a.distance > BODY_BY_ID.cinder.atmosphere,
    `departed to ${a.distance.toFixed(0)} m, still inside the ${BODY_BY_ID.cinder.atmosphere} m atmosphere`);

  /* ---- 9-10. fly home and dock ---- */
  const cargoWorth = r.piloting.cargoValue;
  res = await fly(r, () => {
    const d = f.position.distanceTo(MOUTH);
    if (d > 4000) steerTo(f, MOUTH, { throttle: 1, boost: true });
    else approach(f, MOUTH, { k: 0.35, min: 12, max: 240 });
  }, () => r.wm.active.id === 'dock', { limit: 500 });
  assert.ok(res.done, 'could not find the way home');
  log.push(['home', res.t]);

  assert.equal(r.piloting.active, false, 'docking left the player sealed in the cockpit');
  assert.equal(r.player.movementOverride, false, 'docked and the body was never handed back');
  assert.equal(r.piloting.cargoUnits, 0, 'the hold was not unloaded on docking');
  assert.equal(r.economy.credits, cargoWorth,
    `sold ${r.economy.credits} credits of ore against ${cargoWorth} aboard`);

  const gPier = r.physics.groundHeight(r.player.position.x, r.player.position.z, r.player.position.y + 4, 40);
  assert.notEqual(gPier, null, 'disembarked over vacuum');
  assert.ok(Math.abs(r.player.position.y - gPier) < 0.5, 'disembarked inside the pier deck');

  /* AND YOU ARE STANDING WHERE YOU CAN GET BACK IN.
   *
   * Not "somewhere near the ship": at the apron, which is the one point the
   * boarding prompt is measured from. The first browser run put the pilot out
   * through the far flank of a 28 m ore tender, 24 m from her ramp foot, and
   * `boardableAt` came back null - the loop ended rather than closing, and
   * every assertion above still passed. */
  assert.equal(r.piloting.boardableAt(), 'dray',
    'disembarked somewhere the ship cannot be boarded from - walk round the hull to continue');
  const apron = BERTHS.find((b) => b.id === 'dray').apron;
  const offApron = Math.hypot(r.player.position.x - apron.x, r.player.position.z - apron.z);
  assert.ok(offApron < 1.0, `stepped out ${offApron.toFixed(1)} m from the ramp foot`);

  const total = log.filter((l) => typeof l[1] === 'number').reduce((s, l) => s + l[1], 0);
  console.log(`    loop: ${log.map((l) => l.join(' ')).join(' | ')} | ${total.toFixed(1)} s flown`);
});

/* ====================================================================== */
/* 9. Transit, measured with the ablation                                 */
/* ====================================================================== */

test('transit is what makes 62 km a flight rather than a wait', async () => {
  const r = await rig();

  async function runToCinder({ transit }) {
    await goto(r, 'dock');
    r.piloting._recoverToBerth();
    atApron(r, 'kestrel');
    r.piloting.board('kestrel');
    const f = r.piloting.flight;
    /* THE ABLATION: pin the multiplier at 1 by making the clear-space test
     * always say no. Everything else - thrust, drag, boost, the cap - is
     * untouched, so the difference measured is transit and nothing else. */
    const real = r.piloting._clearOfEverything;
    if (!transit) r.piloting._clearOfEverything = () => false;
    try {
      await fly(r, () => steerTo(f, new THREE.Vector3(0, 12, -600), { throttle: 1 }),
        () => r.wm.active.id === 'space', { limit: 60 });
      const res = await fly(r, () => steerTo(f, CINDER, { throttle: 1, boost: true }),
        () => r.wm.active.id !== 'space', { limit: 900 });
      return res;
    } finally {
      r.piloting._clearOfEverything = real;
      r.piloting._recoverToBerth();
      await goto(r, 'dock');
    }
  }

  const withT = await runToCinder({ transit: true });
  assert.ok(withT.done, 'could not reach Cinder even with transit');

  const withoutT = await runToCinder({ transit: false });

  /* BUDGET / ACHIEVED / CEILING, and for a duration the budget is an upper
   * bound rather than a floor.
   *
   *   budget    90 s. Set against the SLOWEST hull rather than the fastest:
   *             a stock Dray (powerMul 1.25) crosses in 78.8 s on this run and
   *             a stock Kestrel (1.75) in 55.2, and a budget that only the
   *             courier could meet would be a budget the ore tender fails
   *             silently. Two minutes each way is a chore; one is a journey.
   *   ceiling   the same run with transit ablated - what the flight model
   *             alone gives, which is the open assumption `Bodies.js` flagged
   *             when it laid the volume out against a boost of 1,600 m/s.
   *
   * The ratio is what matters and it is 4.3x. */
  const BUDGET = 90;
  console.log(`    dock -> Cinder: budget <= ${BUDGET} s | achieved ${withT.t.toFixed(1)} s `
    + `| ablated ${withoutT.done ? `${withoutT.t.toFixed(1)} s` : '> 900 s (never arrived)'} `
    + `| ratio x${withoutT.done ? (withoutT.t / withT.t).toFixed(2) : '>16'}`);
  assert.ok(withT.t < BUDGET, `the crossing took ${withT.t.toFixed(1)} s`);
  assert.ok(!withoutT.done || withoutT.t > withT.t * 2.5,
    'ablating transit barely changed the crossing, so transit is not what makes it fast');
  assert.equal(PIL.TRANSIT_MAX, 8);
});

test('transit refuses to engage anywhere it could fly the ship through something', async () => {
  const r = await rig();
  await goto(r, 'space');
  r.piloting._recoverToBerth();
  const f = r.piloting.flight;

  // Near the yard: never, whatever the throttle says.
  f.place(new THREE.Vector3(0, 0, -1200));
  f.velocity.set(0, 0, -400);
  f.setCommand({ throttle: 1 });
  assert.equal(r.piloting._clearOfEverything(), false, 'transit would engage 1.2 km off the yard');

  // Near a planet: never.
  f.place(CINDER.clone().add(new THREE.Vector3(0, 0, BODY_BY_ID.cinder.radius + 1500)));
  assert.equal(r.piloting._clearOfEverything(), false, 'transit would engage 1.5 km off a planet surface');

  // Out in the empty: yes.
  f.place(new THREE.Vector3(0, 40000, -20000));
  assert.equal(r.piloting._clearOfEverything(), true, 'transit never engages, so it does nothing at all');
  assert.equal(PIL.TRANSIT_CLEAR, 4000);
});

/* ====================================================================== */
/* 10. The seam envelope itself                                           */
/* ====================================================================== */

test('the launch and docking triggers cannot overlap', async () => {
  /* Pure arithmetic on the published constants, and it is here because the two
   * seams are each other's inverse. If a launch arrived inside the docking
   * sphere the ship would ping-pong: out, in, out, in, forever, inside one
   * second. `SEAM_COOLDOWN` hides that rather than fixing it, so the geometry
   * has to be right underneath it. */
  const arrival = PIL.SPACE_ARRIVAL_OUT;
  assert.ok(arrival > PIL.DOCK_RANGE + 100,
    `a launch arrives ${arrival} m out and docking triggers at ${PIL.DOCK_RANGE} m - only ${arrival - PIL.DOCK_RANGE} m apart`);
  assert.ok(arrival > DOCK_ANCHOR.radius,
    `a launch arrives ${arrival} m out, inside the yard's own ${DOCK_ANCHOR.radius} m envelope`);
  assert.ok(PIL.SEAM_COOLDOWN > 1);
});

test('the launch line is clear of every structure in the yard', async () => {
  const r = await rig();
  const dock = r.wm.getWorld('dock');
  /* `LAUNCH_Z` must be beyond the furthest thing a ship could be hovering over,
   * or a pilot holding station at the end of Berth Zero launches themselves. */
  assert.ok(PIL.LAUNCH_Z < dock.bounds.min.z,
    `LAUNCH_Z ${PIL.LAUNCH_Z} is inside the yard, whose bounds reach ${dock.bounds.min.z}`);
  /* ...and not far past it either. Beyond the world's own bounds there is no
   * floor, no colliders and nothing drawn, so a launch line set well outside
   * makes the player fly through a void before the seam fires - which reads as
   * the game having forgotten about them. Forty metres is one ship-length of
   * slack past the last structure. */
  assert.ok(PIL.LAUNCH_Z > dock.bounds.min.z - 40,
    `LAUNCH_Z ${PIL.LAUNCH_Z} is ${(dock.bounds.min.z - PIL.LAUNCH_Z).toFixed(0)} m outside the yard - `
    + 'that is a stretch of nothing to fly through before anything happens');
  for (const b of BERTHS) {
    assert.ok(b.z > PIL.LAUNCH_Z + 20,
      `${b.id}'s berth at z ${b.z} is within 20 m of the launch line`);
  }
});

test('a ship that flies at a body with no surface is told, not silently bounced', async () => {
  const r = await rig();
  await goto(r, 'space');
  r.piloting._recoverToBerth();
  r.piloting.shipId = 'kestrel';
  r.piloting._active = true;
  const warned = [];
  const off = r.bus.on('hud:notify', (e) => warned.push(e.text));
  /* Ceraunus has `handoff: 0` and no `surfaceWorld`, so `approachState` never
   * sets `shouldHandoff` for it - which is the correct behaviour and is
   * asserted here so a future editor who gives it a handoff without a world
   * gets a red light. */
  const ring = BODY_BY_ID.ceraunus;
  const at = new THREE.Vector3(...ring.position);
  assert.equal(approachState(at).shouldHandoff, false);

  // And the explicit path: a body that DOES claim a world nobody registered.
  r.piloting._descend({ id: 'fake', name: 'Nowhere', surfaceWorld: 'planet:nowhere' });
  await settle();
  assert.equal(r.wm.active.id, 'space', 'flew to a world that does not exist');
  assert.ok(warned.some((t) => /no surface/i.test(t)), 'the player was told nothing');
  off();
  r.piloting._recoverToBerth();
});

/* ====================================================================== */
/* 11. Budget                                                             */
/* ====================================================================== */

test('a flown hull is one group, registers no colliders, and fits the budget', async () => {
  const r = await rig();
  await goto(r, 'dock');
  r.piloting._recoverToBerth();

  const before = r.physics.colliders.length;
  const rows = [];
  for (const id of FLYABLE) {
    const m = r.piloting._ensureModel(id);
    assert.ok(m, `${id} has no flyable model`);
    let tris = 0;
    let meshes = 0;
    m.group.traverse((o) => {
      if (!o.isMesh) return;
      meshes++;
      const idx = o.geometry.getIndex();
      tris += (idx ? idx.count : o.geometry.getAttribute('position').count) / 3;
    });
    rows.push(`${id} ${Math.round(tris)} tris / ${meshes} meshes`);
    /* The yard's own ceiling for one hull is 38,000. A flown hull is the same
     * geometry, so the same ceiling applies - and it is drawn every frame from
     * twelve metres away, which the parked one is not. */
    assert.ok(tris < 38000, `${id} draws ${Math.round(tris)} triangles`);
    assert.ok(m.colliderCount > 0,
      `${id} built with no colliders at all, so the hull builders did not really run`);
  }
  assert.equal(r.physics.colliders.length, before,
    'building a flown hull registered colliders into the live world - '
    + 'the player will collide with an invisible ship parked at the origin forever');
  console.log(`    flown hulls: ${rows.join(' | ')}`);
  assert.ok(boostTopSpeed(1) > cruiseTopSpeed(1));
});
