import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * RACES FINALLY PERSIST SOMETHING.
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 *
 * Twelve minigame venues write a personal best through `SaveGame._recordTrial`
 * and have done since the progress layer landed. The three circuits on Vellum
 * Ridge write NOTHING. Run the Cinder Gorge on expert, win it, quit, come back:
 * the game has no record that it ever happened, and neither does the server.
 *
 * That is not only a missing scoreboard. Vellum Ridge's whole job in the
 * mission design is RACING - "three circuits at three difficulties" is the
 * entire content of its record - so with no ledger there is nothing for its
 * charter to be made of, and one of the eighteen gateways can never be
 * restored by any action available in the game.
 *
 * ── Why a FINISH and not a WIN ─────────────────────────────────────────────
 *
 * `_recordTrial` records only a win, and says why: a "best time" that could be
 * set by losing is not a record of anything. A race is different in the one way
 * that matters. A minigame contest is you against one rival; a race is you
 * against a field of ten on expert, and requiring first place at every
 * difficulty would put a gateway's charter behind beating the hardest AI in the
 * game three times. "A gold nobody can reach is the same defect as a relic
 * nobody can find" (`SpaceObjectives.js:65`).
 *
 * So the bar is a FINISH: you ran the circuit and the clock has a number on it.
 * A DNF still records nothing, because a DNF has no time - there is no run to
 * be the best of.
 *
 * ── Why it lives in SaveGame ───────────────────────────────────────────────
 *
 * The same reason the trial ledger does, written down in `_trialLedger`:
 * `RaceManager` emits and forgets, it is owned elsewhere, and a best time that
 * lives only in a running manager is lost by the world change that follows the
 * race. And the same escape hatch: hand in a `races` system with `serialize()`
 * and it wins.
 */

/* ---------------------------------------------------------------------- */
/* Environment: SaveGame touches localStorage and window at construction    */
/* ---------------------------------------------------------------------- */

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
globalThis.window = globalThis.window ?? globalThis;
globalThis.window.addEventListener = globalThis.window.addEventListener ?? (() => {});
globalThis.window.removeEventListener = globalThis.window.removeEventListener ?? (() => {});

const { SaveGame, SAVE_KEY } = await import('../../src/systems/SaveGame.js');
const { RACE_PRIZES } = await import('../../src/race/RaceManager.js');

function makeBus() {
  const handlers = new Map();
  return {
    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(fn);
      return () => handlers.get(type)?.delete(fn);
    },
    emit(type, payload) { for (const fn of [...(handlers.get(type) ?? [])]) fn(payload); },
  };
}

function makeSave() {
  store.clear();
  const bus = makeBus();
  const save = new SaveGame({
    bus,
    player: { position: { x: 0, y: 2, z: 0 }, yaw: 0, health: 100, maxHealth: 100 },
    worldManager: { active: { id: 'race' }, ids: ['race'] },
    economy: { credits: 0 },
  });
  save.disableAutosave();
  return { bus, save };
}

/**
 * A `race:finished` payload in EXACTLY the shape `RaceManager` emits it.
 *
 * Restated from the emit site (`RaceManager.js:1269`) rather than invented,
 * because a ledger keyed on fields the manager does not send is a ledger that
 * records nothing in the shipped game - which is the defect this file exists
 * to close, one level up.
 */
function finished({ place = 1, time = 90, dnf = false, circuitId = 'vellum', difficulty = 'standard' } = {}) {
  const results = [{
    place, id: 'player', name: 'You', isPlayer: true, color: 0,
    time: dnf ? 0 : time, gap: 0, laps: 3, bestLap: time / 3, dnf,
    credits: RACE_PRIZES[place - 1] ?? 0,
  }];
  return {
    results,
    circuitId,
    circuitName: 'Vellum Ridge Circuit',
    raceType: 'car',
    place,
    credits: 0,
    pickups: 0,
    pickupCredits: 0,
    dnf,
    difficulty,
    time: dnf ? 0 : time,
    laps: 3,
  };
}

/* ====================================================================== */
/* 1. A finished race is recorded                                          */
/* ====================================================================== */

test('finishing a circuit records a personal best', () => {
  const { bus, save } = makeSave();
  assert.equal(save.raceLedger(), null, 'a fresh ledger is not empty');

  bus.emit('race:finished', finished({ place: 3, time: 128.5 }));

  const led = save.raceLedger();
  assert.ok(led && led.best, 'nothing was recorded');
  assert.equal(save.bestRaceTime('vellum', 'standard', 'race'), 128.5);
});

test('the key names the circuit AND the difficulty', () => {
  const { bus, save } = makeSave();
  /* The same circuit at two grades is two records. `RaceWorld.setDifficulty`
   * reconfigures the chicanes, so an expert lap is not a standard lap with a
   * faster field on it - and Vellum Ridge's charter is "three circuits at
   * three difficulties", which is nine rows and not three. */
  bus.emit('race:finished', finished({ circuitId: 'vellum', difficulty: 'easy', time: 100 }));
  bus.emit('race:finished', finished({ circuitId: 'vellum', difficulty: 'expert', time: 140 }));

  const keys = Object.keys(save.raceLedger().best).sort();
  assert.deepEqual(keys, ['race/vellum/easy', 'race/vellum/expert']);
});

test('a DNF records nothing, because a DNF has no time', () => {
  const { bus, save } = makeSave();
  bus.emit('race:finished', finished({ dnf: true, place: 0, time: 0 }));
  assert.equal(save.raceLedger(), null);
});

test('a race with no circuit id records nothing', () => {
  const { bus, save } = makeSave();
  /* `RaceManager` falls back to `null` for the synthetic test circuit, which
   * has no `trackId`. A row keyed `race/null/standard` would be a record of a
   * circuit no world publishes, and it would sit in the charter's numerator
   * for ever without a denominator that could ever match it. */
  bus.emit('race:finished', finished({ circuitId: null }));
  assert.equal(save.raceLedger(), null);
});

/* ====================================================================== */
/* 2. Quicker wins, always                                                 */
/* ====================================================================== */

test('a slower run never replaces a quicker one', () => {
  const { bus, save } = makeSave();
  bus.emit('race:finished', finished({ time: 95 }));
  bus.emit('race:finished', finished({ time: 130 }));
  assert.equal(save.bestRaceTime('vellum', 'standard', 'race'), 95);

  bus.emit('race:finished', finished({ time: 88.25 }));
  assert.equal(save.bestRaceTime('vellum', 'standard', 'race'), 88.25);
});

test('a new best announces itself so the rest of the game can hear it', () => {
  const { bus, save } = makeSave();
  const heard = [];
  bus.on('race:best', (p) => heard.push(p));

  bus.emit('race:finished', finished({ time: 95 }));
  bus.emit('race:finished', finished({ time: 130 }));

  /* One event, not two. A "personal best" fired on a slower run is how a
   * charter panel and a toast both end up claiming an improvement that did not
   * happen. `trial:best` has the same rule. */
  assert.equal(heard.length, 1);
  assert.equal(heard[0].time, 95);
  assert.equal(heard[0].circuitId, 'vellum');
  assert.equal(heard[0].difficulty, 'standard');
  assert.equal(save.bestRaceTime('vellum', 'standard', 'race'), 95);
});

/* ====================================================================== */
/* 3. It survives a reload, which is the whole point                       */
/* ====================================================================== */

test('a best time survives a save and a load', async () => {
  const { bus, save } = makeSave();
  bus.emit('race:finished', finished({ time: 101.5, circuitId: 'cinder', difficulty: 'expert' }));
  save.save('test');
  const written = store.get(SAVE_KEY);

  /* A second SaveGame over the written payload, as a fresh page load builds
   * one. `makeSave` starts from empty storage, so the payload goes back in
   * after it - the same shape `save-progress.test.mjs` uses. */
  const b = makeSave();
  assert.equal(b.save.bestRaceTime('cinder', 'expert', 'race'), null, 'the fixture leaked state');
  store.set(SAVE_KEY, written);
  assert.equal(await b.save.load(), true);
  assert.equal(b.save.bestRaceTime('cinder', 'expert', 'race'), 101.5,
    'the restored save forgot the circuit time');
});

test('a save written before this drop still loads', async () => {
  /* The rule that matters more than any field here: an old save must not
   * become an unplayable one. Every save in the wild has no `races` key at
   * all, and absence has to be valid. */
  const { save } = makeSave();
  save.save('test');
  const data = JSON.parse(store.get(SAVE_KEY));
  delete data.races;
  delete data.charters;
  delete data.integrity;
  const legacy = JSON.stringify(data);

  const b = makeSave();
  store.set(SAVE_KEY, legacy);
  assert.equal(await b.save.load(), true, 'a save from before this drop was refused');
  assert.equal(b.save.raceLedger(), null);
});

/* ====================================================================== */
/* 4. Cross-device merge: quicker wins, and never the other way            */
/* ====================================================================== */

test('merging another device takes the quicker run and only the quicker run', () => {
  const { bus, save } = makeSave();
  bus.emit('race:finished', finished({ time: 95, circuitId: 'vellum' }));

  const improved = save.mergeRaces({
    'race/vellum/standard': { time: 120 },
    'race/aurora/easy': { time: 77 },
  });

  assert.equal(improved, 1, 'the slower phone run was taken as an improvement');
  assert.equal(save.bestRaceTime('vellum', 'standard', 'race'), 95);
  assert.equal(save.bestRaceTime('aurora', 'easy', 'race'), 77);
});

test('a merge with nothing in it changes nothing', () => {
  const { save } = makeSave();
  assert.equal(save.mergeRaces(null), 0);
  assert.equal(save.mergeRaces({}), 0);
  assert.equal(save.mergeRaces({ 'race/vellum/standard': { time: 0 } }), 0);
  assert.equal(save.raceLedger(), null);
});
