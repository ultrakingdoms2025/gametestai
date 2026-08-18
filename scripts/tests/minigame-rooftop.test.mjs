import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

/**
 * THE ROOFTOP TIME TRIAL, AS A CONTEST.
 *
 * This file asks whether the trial is a game: does the clock start where the
 * manager thinks it starts, do the rings have to be taken in order, does a
 * shortcut get refused, does a medal mean what the card says, and does the
 * whole thing come apart cleanly when a player quits.
 *
 * It deliberately does NOT ask whether the medal times are achievable - that is
 * a question about the citadel and about the player's body, and it is answered
 * in `minigame-rooftop-times.test.mjs` by building the world and driving the
 * real `Player`. Two files because the two questions fail for different reasons
 * and a single red would not say which.
 *
 * The player here is a bare position, moved by hand. That is not a shortcut:
 * the contest reads `player.position` and nothing else, so a real capsule would
 * add a physics solver to a test about a cursor.
 */

const noopCtx = () => {
  const grad = { addColorStop() {} };
  const real = {
    createLinearGradient: () => grad, createRadialGradient: () => grad, createPattern: () => null,
    measureText: () => ({ width: 10 }), getLineDash: () => [],
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  };
  return new Proxy(real, { get: (o, k) => (k in o ? o[k] : () => undefined), set: () => true });
};
globalThis.document ??= {
  createElement(tag) {
    if (tag !== 'canvas') return {};
    return { width: 1, height: 1, getContext: () => noopCtx(), style: {} };
  },
};

const {
  RooftopTrial, createRooftopTrial, parTimes, medalFor, chainLength, climbLegs,
  venueBounds, venueCoversRoute, clockText,
  REF_PACE, CLIMB_LEG_S, LEAP_APEX, MEDAL_FACTOR, TIMEOUT_FACTOR, START_RADIUS, CP_Y_GATE,
  ROOFTOP_GAME_ID,
} = await import('../../src/minigames/RooftopTrial.js');
const { MinigameManager, MINIGAME_STATE } = await import('../../src/minigames/MinigameManager.js');
const { RaceRings, DRAGON_RACE } = await import('../../src/race/RaceRings.js');

const DT = 1 / 60;

/**
 * A straight rooftop route: six rings 40 m apart on one deck, one 2 m step up
 * near the end so `climbLegs` has something real to count in the fixtures that
 * want it.
 */
function straightRoute({ n = 6, spacing = 40, y = 20.5, riseAt = -1 } = {}) {
  const cps = [];
  let h = y;
  for (let i = 0; i < n; i++) {
    if (i === riseAt) h += 2.0;
    cps.push({ x: i * spacing, y: h, z: 0 });
  }
  return cps;
}

/**
 * The same route bent into a zig-zag, 30 m off the axis each way.
 *
 * A straight line of rings cannot test a shortcut: the segment from the start
 * to the finish sweeps every ring on the way, so a teleport to the end
 * correctly validates all of them. The corners are what make a cut a cut.
 */
function zigzagRoute({ n = 6, spacing = 40, y = 20.5, off = 30 } = {}) {
  const cps = [];
  for (let i = 0; i < n; i++) cps.push({ x: i * spacing, y, z: i % 2 ? off : -off });
  return cps;
}

function makeVenue(cps, extra = {}) {
  const b = venueBounds(cps);
  return {
    id: 'test_route',
    kind: 'rooftop',
    label: 'Test Rooftop Route',
    centre: b.centre,
    radius: b.radius,
    yTolerance: b.yTolerance,
    reward: 12,
    requires: 'parkour',
    config: { checkpoints: cps, ringRadius: 2.6, routeLength: chainLength(cps), ...extra.config },
    rival: extra.rival ?? null,
  };
}

function makeCtx(cps) {
  const events = [];
  const bus = { on: () => () => {}, off() {}, emit: (n, p) => events.push([n, p]) };
  const player = { position: new THREE.Vector3(cps[0].x, cps[0].y + 0.875, cps[0].z) };
  return { ctx: { player, bus, input: null, scene: new THREE.Scene() }, events, player, bus };
}

/** Walk the player from its current position to `to` in 0.2 m steps, stepping the trial. */
function walkTo(trial, player, to, clockRef, speed = 8.2) {
  let guard = 0;
  let out = null;
  while (guard++ < 20000) {
    const dx = to.x - player.position.x;
    const dz = to.z - player.position.z;
    const dy = to.y + 0.875 - player.position.y;
    const d = Math.hypot(dx, dz);
    if (d < 0.05) break;
    const stepLen = Math.min(d, speed * DT);
    player.position.x += (dx / d) * stepLen;
    player.position.z += (dz / d) * stepLen;
    player.position.y += dy * (stepLen / d);
    clockRef.t += DT;
    out = trial.fixedUpdate(DT, clockRef.t) ?? out;
    if (out) break;
  }
  return out;
}

/* ================================================================== */
/* The par model                                                       */
/* ================================================================== */

test('par times are ordered, positive, and split running from climbing', () => {
  const flat = straightRoute();
  const climby = straightRoute({ riseAt: 3 });
  /* Both priced against the SAME chain length, so the only thing that can move
   * between them is the climb term. The 2 m step lengthens its own leg by 5 cm,
   * which is enough to make an equality on the climb charge fail for a reason
   * that has nothing to do with climbing. */
  const pf = parTimes(flat, 200);
  const pc = parTimes(climby, 200);

  assert.equal(pf.climbLegs, 0, 'a flat route has no climb legs');
  assert.equal(pc.climbLegs, 1, 'a 2 m step is above the leap apex and must be climbed');
  for (const p of [pf, pc]) {
    assert.ok(p.gold > 0 && p.silver > p.gold && p.bronze > p.silver, 'medals must widen');
    assert.ok(p.timeout > p.bronze, 'the timeout must be outside bronze');
  }
  // The climb term is flat across medals: the extra is the same in all three.
  assert.ok(Math.abs((pc.gold - pf.gold) - CLIMB_LEG_S) < 1e-9, 'gold gained something other than the climb charge');
  assert.ok(Math.abs((pc.bronze - pf.bronze) - CLIMB_LEG_S) < 1e-9, 'bronze gained something other than the climb charge');
  /* This is the property the header argues for: if the climb term were scaled
   * by the medal factor, bronze would gain 1.60x the charge and a slow runner
   * would be handed 5.4 free seconds for a 2.05 m/s manoeuvre that takes
   * everybody the same time. */
  assert.notEqual(MEDAL_FACTOR.bronze, 1, 'the fixture below is meaningless if bronze does not scale');
  assert.ok(pc.bronze - pf.bronze < CLIMB_LEG_S * MEDAL_FACTOR.bronze - 1e-6, 'the climb charge is being scaled by the medal');
});

test('par uses the world`s own measured chain length when it publishes one', () => {
  const cps = straightRoute();
  const own = chainLength(cps);
  assert.ok(Math.abs(own - 200) < 1e-9, 'fixture: five 40 m legs');
  // A world that measured its route against the built colliders may report a
  // length the naive chain does not reproduce; the published number wins.
  const p = parTimes(cps, 260);
  assert.equal(p.chain, 260);
  assert.ok(Math.abs(p.run - 260 / REF_PACE) < 1e-9);
  // ...but only when it is usable.
  assert.equal(parTimes(cps, 0).chain, own);
  assert.equal(parTimes(cps, NaN).chain, own);
});

test('the leap apex is what separates a jumpable leg from a climbable one', () => {
  const under = [{ x: 0, y: 0, z: 0 }, { x: 10, y: LEAP_APEX - 0.001, z: 0 }, { x: 20, y: LEAP_APEX - 0.001, z: 0 }];
  const over = [{ x: 0, y: 0, z: 0 }, { x: 10, y: LEAP_APEX + 0.001, z: 0 }, { x: 20, y: LEAP_APEX + 0.001, z: 0 }];
  assert.equal(climbLegs(under), 0, 'a rise inside the leap apex is a leap, not a climb');
  assert.equal(climbLegs(over), 1, 'a rise outside the leap apex has no ballistic answer');
  /* 1.109, driven in a browser, not the closed form 1.17. Six centimetres is a
   * ledge band a leap does not clear, and it is the reason three numbers in
   * this drop's design document were wrong. */
  assert.equal(LEAP_APEX, 1.109);
});

test('medalFor reads the boundaries inclusively and refuses a stroll', () => {
  const par = parTimes(straightRoute());
  assert.equal(medalFor(par.gold, par), 'gold', 'exactly on gold is gold');
  assert.equal(medalFor(par.gold + 1e-9, par), 'silver');
  assert.equal(medalFor(par.silver, par), 'silver');
  assert.equal(medalFor(par.bronze, par), 'bronze');
  assert.equal(medalFor(par.bronze + 0.001, par), null, 'outside bronze is no medal at all');
  assert.equal(medalFor(0, par), null);
  assert.equal(medalFor(-4, par), null);
});

/* ================================================================== */
/* The venue disc                                                      */
/* ================================================================== */

test('venueBounds returns a disc that MinigameManager would hold for the whole route', () => {
  const cps = straightRoute({ n: 9, spacing: 30, riseAt: 5 });
  const b = venueBounds(cps);
  const venue = { centre: b.centre, radius: b.radius, yTolerance: b.yTolerance };
  assert.ok(venueCoversRoute(venue, cps), 'the bounds do not cover the route they were computed from');
  /* And the failure this exists to prevent: a start-line-sized disc. The
   * manager abandons a contest LEAVE_GRACE_S = 9 s after the player leaves the
   * venue, so a disc that only holds checkpoint 0 self-aborts every run. */
  const tiny = { centre: cps[0], radius: 12, yTolerance: 5 };
  assert.equal(venueCoversRoute(tiny, cps), false, 'a 12 m start disc must not read as covering a 240 m route');
});

test('venueCoversRoute agrees with MinigameManager._inVenue point by point', () => {
  const cps = straightRoute({ n: 7, spacing: 35, riseAt: 4 });
  const b = venueBounds(cps);
  const player = { position: new THREE.Vector3() };
  const mgr = new MinigameManager({ bus: null, player, economy: null, input: null, worldManager: null });
  const venue = { centre: b.centre, radius: b.radius, yTolerance: b.yTolerance };
  for (const c of cps) {
    player.position.set(c.x, c.y + 0.875, c.z);
    assert.ok(mgr._inVenue(venue, 0), `the manager would drop the player at (${c.x}, ${c.y}, ${c.z})`);
  }
  mgr.dispose();
});

/* ================================================================== */
/* The contest                                                         */
/* ================================================================== */

test('the rings must be taken in order, and a shortcut takes none of them', () => {
  const cps = zigzagRoute();
  const { ctx, player } = makeCtx(cps);
  const trial = new RooftopTrial(makeVenue(cps), ctx);
  trial.begin(0);
  const clock = { t: 0 };

  /* Cut to the LAST ring by a line that misses every ring in between. On a
   * straight route this would be no test at all: the segment from the start to
   * the end passes through all six, and the swept test would - correctly -
   * count ring 1. The zig-zag is what makes the shortcut a shortcut. */
  player.position.set(cps[5].x, cps[5].y + 0.875, cps[5].z);
  trial.fixedUpdate(DT, (clock.t += DT));
  assert.equal(trial.done, 0, 'a jump to the far end of the route validated something');
  assert.equal(trial.nextCp, 1);

  // Back to the start and run it properly.
  player.position.set(cps[0].x, cps[0].y + 0.875, cps[0].z);
  trial._px = cps[0].x;
  trial._pz = cps[0].z;
  for (let i = 1; i < cps.length; i++) {
    const out = walkTo(trial, player, cps[i], clock);
    if (i < cps.length - 1) {
      assert.equal(out, null, `the trial ended at ring ${i}`);
      assert.equal(trial.done, i, `ring ${i} was not credited`);
    } else {
      assert.ok(out, 'the last ring did not end the trial');
      assert.equal(trial.done, cps.length - 1);
    }
  }
  trial.dispose();
});

test('doubling back over a ring already taken does nothing', () => {
  const cps = straightRoute();
  const { ctx, player } = makeCtx(cps);
  const trial = new RooftopTrial(makeVenue(cps), ctx);
  trial.begin(0);
  const clock = { t: 0 };
  walkTo(trial, player, cps[1], clock);
  assert.equal(trial.done, 1);
  const wasDone = trial.done;
  // Run back and forth across ring 1 twenty times.
  for (let i = 0; i < 20; i++) {
    walkTo(trial, player, { x: cps[1].x - 6, y: cps[1].y, z: 0 }, clock);
    walkTo(trial, player, { x: cps[1].x + 6, y: cps[1].y, z: 0 }, clock);
  }
  assert.equal(trial.done, wasDone, 'a ring already taken was credited again');
  assert.equal(trial.nextCp, 2);
  trial.dispose();
});

test('a leap-speed step cannot tunnel a ring', () => {
  const cps = straightRoute();
  const { ctx, player } = makeCtx(cps);
  const trial = new RooftopTrial(makeVenue(cps), ctx);
  trial.begin(0);
  /* One step from 6 m short of ring 1 to 6 m past it. The ring is 2.6 m, so
   * neither end is inside it - a point test scores this as a miss. A dive
   * reaches 40 m/s, which is 0.67 m a step, so the case is not hypothetical
   * once a bridge or a launch beam is involved. */
  player.position.set(cps[1].x - 6, cps[1].y + 0.875, 0);
  trial._px = player.position.x;
  trial._pz = player.position.z;
  player.position.x = cps[1].x + 6;
  trial.fixedUpdate(DT, DT);
  assert.equal(trial.done, 1, 'a step that passed straight through the ring was scored as a miss');
  trial.dispose();
});

test('a runner in the street below is not credited with a rooftop ring', () => {
  const cps = straightRoute();
  const { ctx, player } = makeCtx(cps);
  const trial = new RooftopTrial(makeVenue(cps), ctx);
  trial.begin(0);
  /* The souk's outer ring decks stand 6.6 m over the street. `player.position`
   * is the capsule CENTRE, so a runner on the ground under ring 1 reads
   * cp.y - 6.6 + 0.875 = -5.7 against the gate. */
  player.position.set(cps[1].x, cps[1].y - 6.6 + 0.875, 0);
  trial._px = cps[1].x - 4;
  trial._pz = 0;
  trial.fixedUpdate(DT, DT);
  assert.equal(trial.done, 0, 'a pass 6.6 m under the ring was counted');
  // ...and standing IN it, at capsule height, is taken.
  player.position.set(cps[1].x, cps[1].y + 0.875, 0);
  trial.fixedUpdate(DT, 2 * DT);
  assert.equal(trial.done, 1, 'a pass at deck height was refused');
  assert.ok(CP_Y_GATE > 1.109 + 0.875, 'the gate must accept a body at the top of a leap');
  trial.dispose();
});

test('a finish inside bronze wins and carries its medal; outside bronze does not', () => {
  const cps = straightRoute();
  const venue = makeVenue(cps);
  const par = parTimes(cps, venue.config.routeLength);

  const run = (finishAt) => {
    const { ctx, player } = makeCtx(cps);
    const trial = new RooftopTrial(venue, ctx);
    trial.begin(0);
    // Take every ring in one step each, then finish the clock where we want it.
    for (let i = 1; i < cps.length; i++) {
      trial._px = cps[i].x - 1;
      trial._pz = 0;
      player.position.set(cps[i].x, cps[i].y + 0.875, 0);
      const out = trial.fixedUpdate(DT, i === cps.length - 1 ? finishAt : 0.01 * i);
      if (out) return out;
    }
    return null;
  };

  const gold = run(par.gold - 0.5);
  assert.equal(gold.won, true);
  assert.equal(gold.score, 'gold');
  assert.match(gold.scoreLabel, /gold/);

  const silver = run(par.gold + 0.5);
  assert.equal(silver.score, 'silver');
  assert.equal(silver.won, true);

  const none = run(par.bronze + 0.5);
  assert.equal(none.score, 'none');
  assert.equal(none.won, false, 'a run outside bronze must not be a win');
  /* Because SaveGame._recordTrial keeps the times of wins ONLY, "won" is the
   * gate on the personal-best ledger. A stroll that recorded itself as a best
   * would poison the row for good. */
});

test('a run that never finishes is called off at the timeout, as a loss', () => {
  const cps = straightRoute();
  const venue = makeVenue(cps);
  const par = parTimes(cps, venue.config.routeLength);
  const { ctx, player } = makeCtx(cps);
  const trial = new RooftopTrial(venue, ctx);
  trial.begin(0);
  // Take one ring, then stand still.
  trial._px = cps[1].x - 1;
  player.position.set(cps[1].x, cps[1].y + 0.875, 0);
  trial.fixedUpdate(DT, 1);
  assert.equal(trial.done, 1);
  assert.equal(trial.fixedUpdate(DT, par.bronze + 1), null, 'the trial ended before its timeout');
  const out = trial.fixedUpdate(DT, par.timeout);
  assert.ok(out, 'the trial ran past its timeout');
  assert.equal(out.won, false);
  assert.equal(out.score, 'dnf');
  assert.ok(Math.abs(par.timeout - par.bronze * TIMEOUT_FACTOR) < 1e-9);
  trial.dispose();
});

test('the rival is a pace, and the pace is the silver par', () => {
  const cps = straightRoute();
  const venue = makeVenue(cps);
  const par = parTimes(cps, venue.config.routeLength);
  const { ctx } = makeCtx(cps);
  const trial = new RooftopTrial(venue, ctx);
  trial.begin(0);
  trial.fixedUpdate(DT, par.silver);
  assert.ok(Math.abs(trial.rivalDist - par.chain) < 1e-6, 'the rival did not finish exactly on its own par');
  trial.fixedUpdate(DT, par.silver * 2);
  assert.ok(Math.abs(trial.rivalDist - par.chain) < 1e-6, 'the rival ran off the end of the route');
  // Halfway through the silver time is halfway along the chain.
  const t2 = new RooftopTrial(venue, makeCtx(cps).ctx);
  t2.begin(0);
  t2.fixedUpdate(DT, par.silver / 2);
  assert.ok(Math.abs(t2.rivalDist - par.chain / 2) < 1e-6);
  trial.dispose();
  t2.dispose();
});

test('the rival body walks the authored chain, not a straight line to the end', () => {
  // An L-shaped route: a straight interpolation would cut the corner and the
  // body would leave the roofs entirely.
  const cps = [{ x: 0, y: 20, z: 0 }, { x: 60, y: 20, z: 0 }, { x: 60, y: 20, z: 60 }];
  const venue = makeVenue(cps);
  const { ctx } = makeCtx(cps);
  const trial = new RooftopTrial(venue, ctx);
  const out = new THREE.Vector3();
  trial._chainPoint(30, out);
  assert.ok(Math.abs(out.x - 30) < 1e-6 && Math.abs(out.z) < 1e-6, 'the pace left the first leg');
  trial._chainPoint(90, out);
  assert.ok(Math.abs(out.x - 60) < 1e-6 && Math.abs(out.z - 30) < 1e-6, 'the pace cut the corner');
  trial.dispose();
});

/* ================================================================== */
/* The start gate and the factory                                      */
/* ================================================================== */

test('the factory refuses to start a trial the player is not standing on', () => {
  const cps = straightRoute();
  const venue = makeVenue(cps);
  const { ctx, player, events } = makeCtx(cps);

  player.position.set(cps[3].x, cps[3].y + 0.875, cps[3].z);
  assert.equal(createRooftopTrial(venue, ctx), null, 'a trial started from the middle of its own route');
  const told = events.find(([n]) => n === 'hud:notify');
  assert.ok(told, 'the player was refused without being told where the start is');
  assert.match(told[1].text, /starts at the first ring/);

  // Just outside the start radius, on the line.
  player.position.set(cps[0].x + START_RADIUS + 0.5, cps[0].y + 0.875, cps[0].z);
  assert.equal(createRooftopTrial(venue, ctx), null);

  // Inside it.
  player.position.set(cps[0].x + START_RADIUS - 0.5, cps[0].y + 0.875, cps[0].z);
  const trial = createRooftopTrial(venue, ctx);
  assert.ok(trial instanceof RooftopTrial);
  trial.dispose();

  // At the line but on the wrong deck - a floor below is not the start line.
  player.position.set(cps[0].x, cps[0].y - 6.6, cps[0].z);
  assert.equal(createRooftopTrial(venue, ctx), null, 'the start gate ignored height');
});

test('a malformed venue is "not available", never a throw', () => {
  const { ctx } = makeCtx(straightRoute());
  for (const bad of [
    undefined, {}, { config: null }, { config: {} },
    { config: { checkpoints: [] } },
    { config: { checkpoints: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }] } },
    { config: { checkpoints: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 'nope', y: 0, z: 0 }] } },
  ]) {
    assert.equal(createRooftopTrial(bad, ctx), null, `${JSON.stringify(bad)} should be inert, not fatal`);
  }
});

/* ================================================================== */
/* The lifecycle, through the real manager                             */
/* ================================================================== */

test('the manager arms, counts down, runs and pays a rooftop venue', () => {
  const cps = straightRoute();
  const venue = makeVenue(cps);
  const wallet = [];
  const seen = [];
  const handlers = new Map();
  const bus = {
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
      return () => {};
    },
    off() {},
    emit(name, payload) {
      seen.push([name, payload]);
      for (const fn of handlers.get(name) ?? []) fn(payload);
    },
  };
  const player = { position: new THREE.Vector3(cps[0].x, cps[0].y + 0.875, cps[0].z) };
  const mgr = new MinigameManager({
    bus, player, economy: { add: (n, why) => wallet.push({ n, why }) },
    input: null, worldManager: null,
  });
  mgr.registerGame('rooftop', (v, ctx) => createRooftopTrial(v, { ...ctx, scene: new THREE.Scene() }));
  bus.emit('world:changed', { id: 'citadel', world: { minigameVenues: [venue] } });
  assert.equal(mgr.venues.length, 1, 'the rooftop venue did not arm');

  mgr.update(1 / 60);
  assert.equal(mgr.ready, true, 'standing on the start line, the venue should offer a start');
  assert.equal(mgr.start('test_route'), true);
  assert.equal(mgr.state, MINIGAME_STATE.COUNTDOWN);

  // Burn the countdown.
  for (let i = 0; i < 4 * 60 && mgr.state === MINIGAME_STATE.COUNTDOWN; i++) mgr.fixedUpdate(DT, i * DT);
  assert.equal(mgr.state, MINIGAME_STATE.PLAYING, 'the countdown never ended');

  // Run the route: one ring per step, well inside gold.
  for (let i = 1; i < cps.length; i++) {
    mgr._game._px = cps[i].x - 1;
    mgr._game._pz = 0;
    player.position.set(cps[i].x, cps[i].y + 0.875, 0);
    mgr.fixedUpdate(DT, 0);
  }
  assert.equal(mgr.state, MINIGAME_STATE.FINISHED, 'the trial did not finish');
  assert.equal(mgr.result.won, true);
  assert.equal(mgr.result.score, 'gold');
  assert.equal(mgr.result.gameId, ROOFTOP_GAME_ID);
  assert.deepEqual(wallet, [{ n: 12, why: 'minigame' }], 'the venue reward was not paid');

  /* The two events the rest of the game reads off a finish: the quest hook and
   * the row SaveGame._recordTrial keeps. */
  const quest = seen.find(([n]) => n === 'quest:activity');
  assert.ok(quest, 'no quest:activity was emitted');
  assert.equal(quest[1].target, ROOFTOP_GAME_ID);
  const fin = seen.find(([n]) => n === 'minigame:finished');
  assert.equal(fin[1].venueId, 'test_route');
  assert.equal(fin[1].worldId, 'citadel');
  assert.ok(fin[1].time >= 0, 'SaveGame records `time`; it must be a number');
  mgr.dispose();
});

/**
 * The key a best time is FILED under has to be the key it is LOOKED UP under.
 *
 * `SaveGame._recordTrial` files a win at `${worldId}/${venueId}`, taking
 * `worldId` off `minigame:finished` - which is the id `MinigameManager` caught
 * from `world:changed`, i.e. `World.id`. The trial reads its personal best back
 * with its own idea of the world. The first version of this module asked
 * `worldManager.activeId`, which does not exist on `WorldManager` at all: the
 * write went to `citadel/citadel_ascent` and the read to `?/citadel_ascent`, so
 * the HUD's BEST row would have stayed empty forever and nothing would have
 * thrown. Nothing else in the suite compares the two.
 */
test('the trial reads its personal best under the key SaveGame files it at', () => {
  const cps = straightRoute();
  const venue = makeVenue(cps);
  const filed = [];
  const handlers = new Map();
  const bus = {
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
      return () => {};
    },
    off() {},
    emit(name, payload) {
      for (const fn of handlers.get(name) ?? []) fn(payload);
    },
  };
  // The ledger, exactly as SaveGame keys it.
  const ledger = new Map();
  bus.on('minigame:finished', (r) => {
    if (!r?.won) return;
    const key = `${r.worldId ?? '?'}/${r.venueId}`;
    filed.push(key);
    ledger.set(key, r.time);
  });
  const save = {
    bestTrialTime: (venueId, worldId) => ledger.get(`${worldId ?? '?'}/${venueId}`) ?? null,
  };

  const player = { position: new THREE.Vector3(cps[0].x, cps[0].y + 0.875, cps[0].z) };
  const worldManager = { active: { id: 'citadel', group: new THREE.Scene() } };
  const mgr = new MinigameManager({ bus, player, economy: null, input: null, worldManager: null });
  mgr.registerGame('rooftop', (v, ctx) => createRooftopTrial(v, { ...ctx, worldManager, save }));
  bus.emit('world:changed', { id: 'citadel', world: { minigameVenues: [venue] } });
  mgr.update(DT);
  assert.equal(mgr.start('test_route'), true);
  const first = mgr._game;
  assert.equal(first.worldId, 'citadel', 'the trial does not know which world it is in');
  assert.equal(first.best, null, 'nothing has been filed yet');

  for (let i = 0; i < 4 * 60 && mgr.state === MINIGAME_STATE.COUNTDOWN; i++) mgr.fixedUpdate(DT, i * DT);
  for (let i = 1; i < cps.length; i++) {
    mgr._game._px = cps[i].x - 1;
    mgr._game._pz = 0;
    player.position.set(cps[i].x, cps[i].y + 0.875, 0);
    mgr.fixedUpdate(DT, 0);
  }
  assert.deepEqual(filed, ['citadel/test_route'], 'the win was filed under the wrong key');

  // A second run must find the first one.
  mgr.reset();
  player.position.set(cps[0].x, cps[0].y + 0.875, cps[0].z);
  mgr.update(DT);
  assert.equal(mgr.start('test_route'), true);
  assert.ok(mgr._game.best !== null, 'the trial cannot see the best time that was just filed for it');
  assert.equal(mgr._game.best, ledger.get('citadel/test_route'));
  mgr.dispose();
});

test('quitting pays nothing and disposes the rings and the rival', () => {
  const cps = straightRoute();
  const venue = makeVenue(cps);
  const wallet = [];
  const bus = { on: () => () => {}, off() {}, emit() {} };
  const player = { position: new THREE.Vector3(cps[0].x, cps[0].y + 0.875, cps[0].z) };
  const scene = new THREE.Scene();
  const mgr = new MinigameManager({ bus, player, economy: { add: (n) => wallet.push(n) }, input: null, worldManager: null });
  mgr.registerGame('rooftop', (v, ctx) => createRooftopTrial(v, { ...ctx, scene }));
  mgr.arm({ minigameVenues: [venue] });
  mgr.update(DT);
  assert.equal(mgr.start('test_route'), true);
  const trial = mgr._game;
  assert.ok(scene.getObjectByName(`rooftop-trial-rings-${venue.id}`), 'the rings were never added to the world');
  mgr.abort('player');
  assert.deepEqual(wallet, [], 'quitting paid out');
  assert.equal(trial.rings, null, 'the rings survived the quit');
  assert.equal(scene.getObjectByName(`rooftop-trial-rings-${venue.id}`), undefined, 'the ring root is still in the scene');
  // Idempotent: the manager tears down on death and world change too.
  trial.dispose();
  mgr.dispose();
});

/* ================================================================== */
/* The marker, parameterised                                           */
/* ================================================================== */

test('RaceRings still builds the dragon race exactly as it did', () => {
  const scene = new THREE.Scene();
  const r = new RaceRings({ scene });
  assert.equal(r.root.name, 'dragon-race-rings');
  assert.equal(r._torusGeo.parameters.radius, DRAGON_RACE.ringRadius);
  assert.equal(r._torusGeo.parameters.radius, 5.2);
  assert.equal(r._torusGeo.parameters.tube, 0.18);
  assert.equal(r._mat.color.getHex(), 0xffd166);
  assert.equal(r._nextMat.color.getHex(), 0x52e9ff);
  r.setCheckpoints([{ x: 0, y: 10, z: 0, number: 1 }, { x: 40, y: 10, z: 0, number: 2 }]);
  assert.equal(r.rings.length, 2);
  assert.equal(r.rings[0].group.name, 'dragon-ring-1');
  assert.equal(r.rings[0].label.position.y, 5.2 + 1.25);
  assert.equal(r.rings[0].label.scale.x, 3.6);
  r.dispose();
});

test('a rooftop trial gets a ring that fits on a roof', () => {
  const cps = straightRoute();
  const { ctx } = makeCtx(cps);
  const trial = new RooftopTrial(makeVenue(cps), ctx);
  assert.equal(trial.rings.radius, 2.6, 'the trial inherited the dragon race`s 5.2 m torus');
  assert.equal(trial.rings._torusGeo.parameters.radius, 2.6);
  assert.ok(trial.rings.root.name.startsWith('rooftop-trial-rings-'));
  assert.equal(trial.rings.rings[0].group.name, `rooftop-cp-${trial.venue.id}-1`);
  /* 8.5 m is the outer souk ring's roof lip. A 5.2 m torus is 10.4 m across
   * and would stand wider than the building it marks. */
  assert.ok(trial.rings.radius * 2 < 8.5, 'the ring is wider than the roof it stands on');
  trial.dispose();
});

test('two trials in the same scene do not share a ring root', () => {
  const cps = straightRoute();
  const scene = new THREE.Scene();
  const a = new RooftopTrial(makeVenue(cps), { ...makeCtx(cps).ctx, scene });
  const b = new RooftopTrial({ ...makeVenue(cps), id: 'other_route' }, { ...makeCtx(cps).ctx, scene });
  assert.notEqual(a.rings.root.name, b.rings.root.name);
  a.dispose();
  assert.ok(scene.getObjectByName(b.rings.root.name), 'disposing one trial removed the other`s rings');
  b.dispose();
});

test('clockText is the same m:ss.mm every timed contest prints', () => {
  assert.equal(clockText(0), '-');
  assert.equal(clockText(-1), '-');
  assert.equal(clockText(9.5), '0:09.50');
  assert.equal(clockText(75.25), '1:15.25');
});
