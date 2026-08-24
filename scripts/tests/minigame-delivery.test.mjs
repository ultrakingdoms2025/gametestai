import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

/**
 * THE DELIVERY RUN, DRIVEN.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT MAKES THIS A CONTEST AND NOT A SECOND ROOFTOP TRIAL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Brief 5.3 names eight contests; `rooftop` already covers "parkour route" and
 * `test_fire` covers "target range". A "delivery run" that were simply a chain
 * of checkpoints under one clock would be `RooftopTrial` with different art,
 * and this repo's recorded lesson is that shipping the same thing twice is
 * worse than shipping it once.
 *
 * Two properties make it a different game, and both are asserted here rather
 * than described:
 *
 *  1. **You carry ONE parcel at a time.** The round is `depot -> drop -> depot
 *     -> drop -> ...`, so half of every run is a return leg and the route is a
 *     star, not a chain. A trial is a line you run down once.
 *  2. **Every leg carries its own deadline**, derived from that leg's own
 *     length at a published pace. A trial has one clock and medal times; this
 *     has a *schedule*, and falling behind on the second leg ends the run
 *     there rather than at the finish line.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  AND THE FAILURE THIS FILE IS REALLY WRITTEN AGAINST
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A drop the player is standing under. `_arrived` is a planar test plus a
 * vertical band, and a band wide enough to be forgiving on a ramp is a band
 * that pays out to somebody on the walkway ten metres overhead. Test 5 is that
 * band, stated as a number.
 */

const DT = 1 / 60;

const {
  DeliveryRun, createDeliveryRun, readRound, DELIVERY_GAME_ID, legPlan,
} = await import('../../src/minigames/DeliveryRun.js');

/* ================================================================== */
/* Apparatus                                                           */
/* ================================================================== */

function fakeBus() {
  const seen = [];
  const subs = new Map();
  return {
    seen,
    emit(name, payload) { seen.push({ name, payload }); },
    on(name, fn) {
      if (!subs.has(name)) subs.set(name, new Set());
      subs.get(name).add(fn);
      return () => subs.get(name).delete(fn);
    },
    find(name) { return seen.filter((e) => e.name === name).map((e) => e.payload); },
  };
}

/** A square round: depot at the origin, three drops 30 m out. */
function venue(over = {}) {
  return {
    id: 'test_round',
    kind: 'courier',
    label: 'The Test Round',
    centre: { x: 0, y: 0, z: 0 },
    radius: 60,
    yTolerance: 12,
    reward: 12,
    config: {
      depot: { x: 0, y: 0, z: 0 },
      drops: [
        { id: 'north', label: 'North Bay', x: 0, y: 0, z: -30 },
        { id: 'east', label: 'East Bay', x: 30, y: 0, z: 0 },
        { id: 'south', label: 'South Bay', x: 0, y: 0, z: 30 },
      ],
      dropR: 3.0,
      band: 3.0,
      pace: 0.5,
      grace: 6,
      seconds: 240,
      ...(over.config ?? {}),
    },
    ...over,
  };
}

/** A player object the module reads a position off. */
function body(x = 0, y = 0, z = 0) {
  return { position: new THREE.Vector3(x, y, z) };
}

/** Build a run, past its countdown, with a recording bus. */
function running(v = venue(), ctx = {}) {
  const bus = ctx.bus ?? fakeBus();
  const player = ctx.player ?? body(v.config.depot.x, v.config.depot.y, v.config.depot.z);
  const game = new DeliveryRun(v, { bus, player, ...ctx });
  game.begin(0);
  return { game, bus, player };
}

/** Walk the body to a point and step the sim once. */
function stepTo(game, player, p, clock) {
  player.position.set(p.x, p.y, p.z);
  return game.fixedUpdate(DT, clock);
}

/* ================================================================== */
/* 1. The venue contract                                               */
/* ================================================================== */

test('a malformed venue yields no round and no exception', () => {
  assert.equal(readRound(null), null);
  assert.equal(readRound({ config: null }), null);
  assert.equal(readRound({ config: { depot: { x: 0, y: 0, z: 0 }, drops: [] } }), null,
    'a round with no drops is a walk, not a delivery');
  assert.equal(readRound({ config: { drops: [{ id: 'a', x: 1, y: 0, z: 1 }] } }), null,
    'a round with no depot has nowhere to collect from');
  assert.equal(readRound({ config: { depot: { x: 0, y: 0, z: 'over there' }, drops: [{ id: 'a', x: 1, y: 0, z: 1 }] } }), null);
  // A drop with a non-finite coordinate is dropped, not fatal...
  const partial = readRound({
    config: {
      depot: { x: 0, y: 0, z: 0 },
      drops: [{ id: 'a', x: 1, y: 0, z: 1 }, { id: 'b', x: NaN, y: 0, z: 2 }],
    },
  });
  assert.equal(partial.drops.length, 1);
  // ...and a venue whose every drop is unusable yields nothing at all.
  assert.equal(readRound({ config: { depot: { x: 0, y: 0, z: 0 }, drops: [{ x: NaN, y: 0, z: 0 }] } }), null);
  assert.equal(createDeliveryRun({ id: 'x', label: 'x', config: {} }, {}), null);
});

test('the game id is declared in the shape quest-vocab scrapes', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../src/minigames/DeliveryRun.js', import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n');
  assert.match(src, /export const DELIVERY_GAME_ID = 'delivery_run'/,
    'quest-vocab reads this constant by `export const (\\w*GAME_ID) = \'([a-z0-9_]+)\'`');
  assert.equal(DELIVERY_GAME_ID, 'delivery_run');
});

/* ================================================================== */
/* 2. The round is a star, and it comes home                           */
/* ================================================================== */

test('the plan is depot-drop-depot per parcel, and the last leg comes home', () => {
  const round = readRound(venue());
  const legs = legPlan(round);
  assert.equal(legs.length, round.drops.length * 2,
    'a round of three parcels is six legs: out and back, three times');
  for (let i = 0; i < legs.length; i++) {
    const outbound = i % 2 === 0;
    assert.equal(legs[i].outbound, outbound);
    if (outbound) {
      assert.equal(legs[i].to.id, round.drops[i / 2].id, `leg ${i} does not carry parcel ${i / 2}`);
      assert.equal(legs[i].from.id, 'depot');
    } else {
      assert.equal(legs[i].to.id, 'depot', `leg ${i} does not return to the depot`);
    }
  }
  assert.equal(legs[legs.length - 1].to.id, 'depot', 'the round does not end at the depot');
});

test('each leg is timed against ITS OWN length, not a flat number', () => {
  /* A star round's legs are all 30 m here, so the property is stated against a
   * round whose legs deliberately are not: a flat per-leg limit would give the
   * 90 m leg the same time as the 5 m one, and the run would be trivial at one
   * end and impossible at the other. */
  const v = venue({
    config: {
      depot: { x: 0, y: 0, z: 0 },
      drops: [
        { id: 'near', label: 'Near', x: 5, y: 0, z: 0 },
        { id: 'far', label: 'Far', x: 90, y: 0, z: 0 },
      ],
      dropR: 3.0, band: 3.0, pace: 0.5, grace: 6, seconds: 400,
    },
  });
  const legs = legPlan(readRound(v));
  assert.equal(legs[0].limit, 5 * 0.5 + 6);
  assert.equal(legs[2].limit, 90 * 0.5 + 6);
  assert.ok(legs[2].limit > legs[0].limit * 3,
    'the long leg is not meaningfully longer than the short one — the pace is not being used');
});

/* ================================================================== */
/* 3. Delivering                                                       */
/* ================================================================== */

test('arriving in order delivers a parcel; arriving at the wrong bay does not', () => {
  const v = venue();
  const { game, player } = running(v);
  assert.equal(game.delivered, 0);
  assert.equal(game.leg, 0);

  // The SOUTH bay is leg 4's target, not leg 0's.
  assert.equal(stepTo(game, player, { x: 0, y: 0, z: 30 }, 1), null);
  assert.equal(game.leg, 0, 'a delivery to a bay later in the round was accepted early');
  assert.equal(game.delivered, 0);

  // The north bay is.
  assert.equal(stepTo(game, player, { x: 0, y: 0, z: -30 }, 2), null);
  assert.equal(game.leg, 1, 'arriving at the first bay did not advance the round');
  assert.equal(game.delivered, 1, 'the parcel was not booked in');

  // ...and now the depot, for the next parcel.
  assert.equal(stepTo(game, player, { x: 0, y: 0, z: 0 }, 3), null);
  assert.equal(game.leg, 2);
  assert.equal(game.delivered, 1, 'the return leg booked a second parcel in');
  game.dispose();
});

test('the arrival radius is real: one metre outside it is not a delivery', () => {
  const v = venue();
  const { game, player } = running(v);
  const r = v.config.dropR;
  stepTo(game, player, { x: r + 1.0, y: 0, z: -30 }, 1);
  assert.equal(game.leg, 0, `a body ${r + 1} m from a ${r} m bay delivered`);
  stepTo(game, player, { x: r - 0.5, y: 0, z: -30 }, 2);
  assert.equal(game.leg, 1);
  game.dispose();
});

test('a body on the gantry overhead has not delivered anything', () => {
  /* THE DEFECT THIS FILE EXISTS FOR. A vertical band forgiving enough for a
   * ramp pays out to somebody on the walkway above the bay, who never came
   * down to it. The station's promenade deck stands 10 m over its floor. */
  const v = venue();
  const { game, player } = running(v);
  stepTo(game, player, { x: 0, y: v.config.band + 2, z: -30 }, 1);
  assert.equal(game.leg, 0, 'a delivery was booked from above the vertical band');
  stepTo(game, player, { x: 0, y: v.config.band - 0.5, z: -30 }, 2);
  assert.equal(game.leg, 1, 'a delivery inside the band was refused');
  game.dispose();
});

/* ================================================================== */
/* 4. Finishing, both ways                                             */
/* ================================================================== */

test('running the whole round home is a win carrying every parcel', () => {
  const v = venue();
  const { game, player, bus } = running(v);
  const round = readRound(v);
  const legs = legPlan(round);
  let out = null;
  for (let i = 0; i < legs.length; i++) {
    out = stepTo(game, player, legs[i].to, i + 1);
    if (out) break;
  }
  assert.ok(out, 'the round never ended');
  assert.equal(out.won, true, 'a completed round did not win');
  assert.equal(out.score, round.drops.length, 'the win does not carry the parcel count');
  assert.equal(game.delivered, round.drops.length);
  assert.match(out.scoreLabel, /3\/3/);
  assert.ok(bus.find('delivery:leg').length >= legs.length - 1,
    'the run reported no leg progress at all');
  game.dispose();
});

test('a missed leg deadline is a loss, named, that still carries what was delivered', () => {
  const v = venue();
  const { game, player } = running(v);
  // Deliver the first parcel and get back to the depot, then stand still.
  stepTo(game, player, { x: 0, y: 0, z: -30 }, 1);
  stepTo(game, player, { x: 0, y: 0, z: 0 }, 2);
  assert.equal(game.leg, 2);
  assert.equal(game.delivered, 1);

  const limit = game.legLimit;
  assert.ok(limit > 0);
  let out = null;
  for (let t = 0; t < limit * 60 + 120 && !out; t++) out = game.fixedUpdate(DT, 2 + t * DT);
  assert.ok(out, 'a leg whose deadline passed never ended the run');
  assert.equal(out.won, false);
  assert.equal(out.score, 1, 'the loss forgot the parcel that WAS delivered');
  assert.match(out.detail, /East Bay/, `the loss does not name the leg it was lost on: ${out.detail}`);
  game.dispose();
});

test('the overall ceiling ends a run even if every individual leg is being met', () => {
  /* Belt to the per-leg braces. A round whose legs are all being reset by
   * arrivals could otherwise run forever, and `MinigameManager` has no clock of
   * its own - a contest ends when its module says so. */
  const v = venue({ config: { ...venue().config, seconds: 12 } });
  const { game, player } = running(v);
  let out = null;
  for (let t = 0; t < 60 * 30 && !out; t++) {
    // Bounce between the depot and the first bay, always arriving in time.
    const p = (t % 120 < 60) ? { x: 0, y: 0, z: -30 } : { x: 0, y: 0, z: 0 };
    out = stepTo(game, player, p, t * DT);
  }
  assert.ok(out, 'the overall ceiling never fired');
  assert.equal(out.won, false);
  assert.ok(game.clock >= 12 - 1, `the run ended at ${game.clock} s against a 12 s ceiling`);
  game.dispose();
});

/* ================================================================== */
/* 5. Lifecycle                                                        */
/* ================================================================== */

test('nothing is delivered before begin() or after dispose()', () => {
  const v = venue();
  const bus = fakeBus();
  const player = body(0, 0, 0);
  const game = new DeliveryRun(v, { bus, player });
  player.position.set(0, 0, -30);
  assert.equal(game.delivered, 0, 'a parcel was delivered during the countdown');
  assert.equal(game.leg, 0);

  game.begin(0);
  game.fixedUpdate(DT, 1);
  assert.equal(game.delivered, 1);

  game.dispose();
  player.position.set(0, 0, 0);
  game.fixedUpdate(DT, 2);
  assert.equal(game.leg, 1, 'a disposed run went on booking legs in');
  // ...and it is idempotent, because the manager tears down on quit, death and
  // world change too.
  game.dispose();
});

test('the markers live in the world group and leave with the run', () => {
  const v = venue();
  const host = new THREE.Group();
  const { game } = running(v, { worldManager: { active: { group: host } } });
  assert.ok(host.children.length > 0, 'the run drew no target marker at all');
  game.dispose();
  assert.equal(host.children.length, 0, 'a marker survived the run that owned it');
});

test('a run with no host group is unchanged — the headless case is not a special case', () => {
  const { game, player } = running(venue(), { worldManager: null });
  assert.equal(stepTo(game, player, { x: 0, y: 0, z: -30 }, 1), null);
  assert.equal(game.delivered, 1);
  game.dispose();
});

/* ================================================================== */
/* 6. The factory's start gate                                         */
/* ================================================================== */

test('a run may only be started from the depot, and the refusal says where it is', () => {
  const v = venue();
  const near = fakeBus();
  assert.ok(createDeliveryRun(v, { bus: near, player: body(1, 0, 1) }) instanceof DeliveryRun);

  const far = fakeBus();
  assert.equal(createDeliveryRun(v, { bus: far, player: body(40, 0, 40) }), null,
    'a round started from the far side of the venue would teleport nobody and time out');
  const note = far.find('hud:notify')[0];
  assert.ok(note, 'the refusal said nothing');
  assert.match(note.text, /depot/i, `the refusal "${note.text}" does not say where to go`);
  assert.match(note.text, /\d+\s*m/, 'the refusal does not say how far');
});

test('the snapshot carries the three rows the HUD renders, and a progress bar', () => {
  const { game, player } = running(venue());
  const snap = game.snapshot();
  const keys = snap.rows.map((r) => r.k);
  assert.deepEqual(keys, ['TIME', 'LEG', 'PARCELS']);
  assert.ok(snap.progress >= 0 && snap.progress <= 1);
  stepTo(game, player, { x: 0, y: 0, z: -30 }, 1);
  assert.ok(game.snapshot().progress > snap.progress, 'delivering a parcel moved no progress');
  game.dispose();
});
