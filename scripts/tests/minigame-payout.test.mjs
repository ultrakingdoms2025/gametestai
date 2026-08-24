import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * WHAT A CONTEST PAYS WHEN YOU LOSE IT.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DEFECT, WHICH IS A DESIGN DEFECT AND NOT A CRASH
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `2026-08-23-mission-architecture.md` §8, measured rather than guessed: six
 * kinds, twelve venues, "all paying 8-18 CR on a win and **zero on a loss**",
 * and the conclusion it draws is the one this file gates —
 *
 *   > Zero for a completed contest against a named rival teaches players not to
 *   > enter. A participation floor below the win prize keeps the contest
 *   > meaningful and the venue used.
 *
 * The failure is invisible to every other test in this suite because nothing
 * is broken: `_finish` pays `won ? reward : 0` and every assertion about it
 * passes. It is a number that is wrong, not a path that is dead.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  AND THE THING A FLOOR MUST NOT BECOME
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * §5 of the same document is equally measured and points the other way: the
 * whole-game faucet is over 250,000 CR against five spend sites, so this is a
 * SINK problem and a new faucet is the last thing it needs. Three properties
 * keep the floor from being one, and all three are asserted below rather than
 * described:
 *
 *  1. **The floor is strictly below the prize**, at every venue in the repo and
 *     for every prize a venue could publish. A floor that met the prize would
 *     make winning optional.
 *  2. **Walking out still pays nothing.** `abort` never reaches `_finish`, and
 *     that is the difference between "you finished and came second" and "you
 *     left when it stopped going your way". If quitting paid the floor, the
 *     floor would be a faucet with no contest attached to it at all.
 *  3. **A win pays exactly what it paid before.** The ceiling of the faucet is
 *     untouched; only the gap between winning and finishing narrows.
 */

const DT = 1 / 60;

const {
  MinigameManager, MINIGAME_STATE, MINIGAME_PRIZE, consolationFor,
} = await import('../../src/minigames/MinigameManager.js');

/* ================================================================== */
/* Apparatus                                                           */
/* ================================================================== */

/** A bus that both records and delivers. */
function fakeBus() {
  const seen = [];
  const handlers = new Map();
  return {
    seen,
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
      return () => {
        const a = handlers.get(name);
        const i = a.indexOf(fn);
        if (i >= 0) a.splice(i, 1);
      };
    },
    off() {},
    emit(name, payload) {
      seen.push([name, payload]);
      for (const fn of [...(handlers.get(name) ?? [])]) fn(payload);
    },
    find(name) { return this.seen.filter(([n]) => n === name).map(([, p]) => p); },
  };
}

/**
 * A contest that ends the way the caller asks on its first simulated step.
 *
 * Deliberately not one of the shipped sports: the property under test belongs
 * to `MinigameManager._finish`, and driving a real swim or a real trial would
 * measure that sport's route instead.
 */
function stub(won) {
  return {
    id: 'stub_game',
    countdown: 0.001,
    begin() {},
    fixedUpdate() {
      return { won, place: won ? 1 : 2, total: 2, score: 3, scoreLabel: '3', rivalName: 'The Pacesetter' };
    },
    snapshot() { return { rows: [] }; },
    dispose() {},
  };
}

/** Run one contest to its end and return everything that came out of it. */
function play({ won, venue }) {
  const bus = fakeBus();
  const wallet = [];
  const player = { position: { x: 0, y: 0, z: 0 } };
  const mgr = new MinigameManager({
    bus, player, economy: { add: (n, why) => wallet.push({ n, why }) },
    input: null, worldManager: null,
  });
  mgr.registerGame(venue.kind, () => stub(won));
  bus.emit('world:changed', { id: 'testworld', world: { minigameVenues: [venue] } });
  assert.equal(mgr.venues.length, 1, 'the venue did not arm');
  mgr.update(DT);
  assert.equal(mgr.start(venue.id), true, 'the contest did not start');
  for (let i = 0; i < 600 && mgr.running; i++) mgr.fixedUpdate(DT, i * DT);
  assert.equal(mgr.state, MINIGAME_STATE.FINISHED, 'the contest never finished');
  const result = mgr.result;
  mgr.dispose();
  return { bus, wallet, result };
}

const VENUE = (over = {}) => ({
  id: 'test_venue', kind: 'stub', label: 'The Test Venue',
  centre: { x: 0, y: 0, z: 0 }, radius: 40, yTolerance: 30, ...over,
});

/* ================================================================== */
/* 1. A completed loss pays something                                  */
/* ================================================================== */

test('a contest you finish and lose pays a participation floor, not zero', () => {
  const { wallet, result } = play({ won: false, venue: VENUE({ reward: 12 }) });
  assert.ok(wallet.length === 1,
    `a completed loss credited ${wallet.length} times: ${JSON.stringify(wallet)}`);
  assert.ok(wallet[0].n > 0,
    'a completed loss still pays zero — the venue teaches the player not to enter');
  assert.equal(wallet[0].why, 'minigame',
    'the floor must ride the reason the ledger already prices, or the server refuses it');
  assert.equal(result.credits, wallet[0].n,
    'the result card and the wallet disagree about what was paid');
  assert.equal(result.won, false, 'the floor must not turn a loss into a win');
});

test('the floor is strictly below the prize, and the prize is unchanged', () => {
  const won = play({ won: true, venue: VENUE({ reward: 12 }) });
  const lost = play({ won: false, venue: VENUE({ reward: 12 }) });
  assert.equal(won.wallet[0].n, 12, 'the win no longer pays the venue reward');
  assert.ok(lost.wallet[0].n < won.wallet[0].n,
    `a loss pays ${lost.wallet[0].n} against a win's ${won.wallet[0].n} — winning has stopped mattering`);
});

test('every prize a venue could publish yields a floor in (0, prize)', () => {
  /* The band the shipped venues sit in is 8-18 (§8), and the two edges below it
   * are where a naive `Math.floor(prize * share)` breaks: at a prize of 1 it
   * rounds to 0 (which `_finish` would then skip paying, and `resolveReportedEvent`
   * would refuse anyway - "a zero-credit event cannot enter"), and at 2 it can
   * round back up to the prize itself. */
  for (let prize = 1; prize <= 200; prize++) {
    const floor = consolationFor({ reward: prize });
    assert.ok(Number.isInteger(floor), `prize ${prize} yields a non-integer floor ${floor}`);
    assert.ok(floor >= 0, `prize ${prize} yields a negative floor ${floor}`);
    assert.ok(floor < prize, `prize ${prize} yields a floor of ${floor}, which is not below it`);
    if (prize >= 2) assert.ok(floor >= 1, `prize ${prize} yields a floor of ${floor} — nothing is still nothing`);
  }
  // The default prize, named, so the band in the design document and the code agree.
  assert.ok(consolationFor({ reward: MINIGAME_PRIZE }) > 0);
  assert.ok(consolationFor({ reward: MINIGAME_PRIZE }) < MINIGAME_PRIZE);
});

test('a venue may name its own floor, and it is still clamped below the prize', () => {
  assert.equal(consolationFor({ reward: 20, consolation: 7 }), 7);
  assert.equal(consolationFor({ reward: 20, consolation: 0 }), 0,
    'a venue that wants a contest to pay nothing on a loss must be able to say so');
  assert.equal(consolationFor({ reward: 20, consolation: 40 }), 19,
    'a published floor at or above the prize is a typo, and it must be clamped rather than obeyed');
  assert.equal(consolationFor({ reward: 20, consolation: -5 }), 0);
  // ...and a venue that publishes nonsense falls back to the derived floor.
  assert.equal(consolationFor({ reward: 20, consolation: 'lots' }), consolationFor({ reward: 20 }));
});

test('the manager honours a venue-published floor end to end', () => {
  const { wallet } = play({ won: false, venue: VENUE({ reward: 16, consolation: 5 }) });
  assert.deepEqual(wallet, [{ n: 5, why: 'minigame' }]);
});

test('a venue that publishes a zero floor pays nothing and calls economy.add zero times', () => {
  /* `resolveReportedEvent`'s third statement refuses a zero-credit event
   * outright, so a 0 must never be handed to the wallet at all - it would be a
   * refusal in the server log for an event that was correct. */
  const { wallet, result } = play({ won: false, venue: VENUE({ reward: 16, consolation: 0 }) });
  assert.deepEqual(wallet, [], 'a zero floor was still reported to the ledger');
  assert.equal(result.credits, 0);
});

/* ================================================================== */
/* 2. Quitting is still free, and still pays nothing                   */
/* ================================================================== */

test('abandoning a contest pays no floor — leaving is not finishing', () => {
  const bus = fakeBus();
  const wallet = [];
  const player = { position: { x: 0, y: 0, z: 0 } };
  const mgr = new MinigameManager({
    bus, player, economy: { add: (n, why) => wallet.push({ n, why }) },
    input: null, worldManager: null,
  });
  const venue = VENUE({ reward: 12 });
  mgr.registerGame('stub', () => ({
    id: 'stub_game', countdown: 0.001, begin() {}, fixedUpdate() { return null; },
    snapshot() { return { rows: [] }; }, dispose() {},
  }));
  mgr.arm({ minigameVenues: [venue] });
  mgr.update(DT);
  assert.equal(mgr.start(venue.id), true);
  for (let i = 0; i < 10; i++) mgr.fixedUpdate(DT, i * DT);
  mgr.abort('player');
  assert.deepEqual(wallet, [], 'quitting a contest paid the participation floor');
  assert.equal(mgr.result, null, 'quitting left a result card behind');

  // ...and the same for the two aborts the player does not press: walking away
  // and dying. Both go through `abort`, so this is the guard, stated.
  mgr.update(DT);
  assert.equal(mgr.start(venue.id), true);
  for (let i = 0; i < 10; i++) mgr.fixedUpdate(DT, i * DT);
  bus.emit('player:died', {});
  assert.deepEqual(wallet, [], 'dying mid-contest paid the participation floor');
  mgr.dispose();
});

/* ================================================================== */
/* 3. The notice says what happened                                    */
/* ================================================================== */

test('the loss notice names the floor, because a silent credit is a credit nobody sees', () => {
  const { bus } = play({ won: false, venue: VENUE({ reward: 12 }) });
  const notes = bus.find('hud:notify');
  assert.ok(notes.length >= 1, 'a finished contest said nothing at all');
  const text = notes[notes.length - 1].text;
  const floor = consolationFor({ reward: 12 });
  assert.match(text, new RegExp(`\\+${floor}\\b`),
    `the loss notice "${text}" does not name the ${floor} credits it just paid`);
});

/* ================================================================== */
/* 4. The published catalogue, checked against the rule                */
/* ================================================================== */

test('every venue the repo arms keeps a floor strictly under the prizes it can publish', async () => {
  const { VOCAB } = await import('../../scripts/quest-vocab.mjs');
  const byWorld = VOCAB.minigames.venuesByWorld;
  const armed = Object.values(byWorld).reduce((n, list) => n + list.length, 0);
  /* §8 measured twelve venues across six kinds before this phase. The count is
   * a floor and not an equality on purpose - this phase adds to it, and a test
   * that pinned the old number would fail on its own success. */
  assert.ok(armed >= 12,
    `${armed} venues arm across the repo; §8 measured twelve before this phase added any`);
  /* The vocabulary scrape carries identity, not economics, so the rule is
   * checked against the whole band §8 measured plus the yard butts' 120 - the
   * richest single minigame in the game. */
  for (const prize of [8, 10, 12, 14, 15, 18, 120]) {
    const floor = consolationFor({ reward: prize });
    assert.ok(floor > 0 && floor < prize, `prize ${prize} -> floor ${floor}`);
  }
});
