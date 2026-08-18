import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * THE SAVE FINALLY CARRIES THE PROGRESS LAYER.
 *
 * ── The defect ────────────────────────────────────────────────────────────
 * `_snapshot` carried world, player, credits, economy, weapons, mounts,
 * cosmetics, inventory and character - and nothing at all from the world-local
 * progress layer. Relics reset on every reload, viewpoint synchronisation had
 * nowhere to live because nothing consumed it, and a contest best time died
 * with the world change that followed the race.
 *
 * ── Why the trial ledger lives in this file ───────────────────────────────
 * `MinigameManager` keeps no record of a finished contest beyond the few
 * seconds its result card is up, and it is owned elsewhere. A best time that
 * exists only in a running manager is lost by the next world change. So this
 * file listens to `minigame:finished` itself - and the moment a system with
 * `serialize()` is handed in as `trials`, that wins and the internal ledger is
 * bypassed. Exactly the probe-first arrangement `_snapshotWeapons` and
 * `_snapshotMounts` already use for `Loadout` and `MountManager`.
 *
 * ── The old-save rule ─────────────────────────────────────────────────────
 * Every save written before this drop has none of these three keys. A save
 * system that refused those would delete the progress of every existing player
 * to defend against a field that did not exist yet, so absence is valid and
 * only a wrong TYPE is structural failure - the same rule `character` and
 * `cosmetics` already carry.
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

/** A minimal but real SaveGame, with recording progress systems. */
function makeSave({ relics, viewpoints, trials } = {}) {
  store.clear();
  const bus = makeBus();
  const save = new SaveGame({
    bus,
    player: { position: { x: 1, y: 2, z: 3 }, yaw: 0, health: 100, maxHealth: 100 },
    worldManager: { active: { id: 'citadel' }, ids: ['citadel'] },
    economy: { credits: 0 },
    relics, viewpoints, trials,
  });
  save.disableAutosave();
  return { bus, save };
}

const recorder = (payload) => ({
  restored: [],
  serialize: () => payload,
  deserialize(d) { this.restored.push(d); return true; },
});

const stored = () => JSON.parse(store.get(SAVE_KEY));

/* ====================================================================== */
/* The snapshot                                                            */
/* ====================================================================== */

test('the snapshot carries relics, viewpoints and trial times', () => {
  const relics = recorder({ found: { citadel: 7 }, paid: ['citadel:half'] });
  const viewpoints = recorder({ worlds: { citadel: ['great-tower'] }, sets: [] });
  const { bus, save } = makeSave({ relics, viewpoints });
  bus.emit('minigame:finished', {
    venueId: 'citadel_skyline', worldId: 'citadel', label: 'The Skyline', time: 41.5, won: true,
  });

  assert.equal(save.save('test'), true);
  const data = stored();
  assert.deepEqual(data.relics, { found: { citadel: 7 }, paid: ['citadel:half'] });
  assert.deepEqual(data.viewpoints, { worlds: { citadel: ['great-tower'] }, sets: [] });
  assert.equal(data.trials.best['citadel/citadel_skyline'].time, 41.5);
});

test('the payload still seals - the integrity tag covers the new fields', () => {
  /* `bodyOf` stringifies everything but the tag, so a field added to the
   * snapshot is inside the seal automatically. This asserts that rather than
   * assuming it: an unsealed progress field would be the one place a player
   * could hand-edit the save and have the game accept it. */
  const relics = recorder({ found: { citadel: 1 }, paid: [] });
  const { save } = makeSave({ relics });
  save.save('test');
  assert.equal(save.hasSave(), true);

  const data = stored();
  data.relics.found.citadel = 30;
  store.set(SAVE_KEY, JSON.stringify(data));
  assert.equal(save.hasSave(), false, 'an edited relic tally passed the integrity check');
});

test('a system with no serialize() writes null, not a crash', () => {
  const { save } = makeSave({ relics: {}, viewpoints: null });
  assert.equal(save.save('test'), true);
  const data = stored();
  assert.equal(data.relics, null);
  assert.equal(data.viewpoints, null);
});

/* ====================================================================== */
/* Restore                                                                 */
/* ====================================================================== */

test('a load hands each system its own slice back', async () => {
  const relics = recorder({ found: { citadel: 7 }, paid: [] });
  const viewpoints = recorder({ worlds: { citadel: ['great-tower'] }, sets: [] });
  const { bus, save } = makeSave({ relics, viewpoints });
  bus.emit('minigame:finished', {
    venueId: 'citadel_ascent', worldId: 'citadel', label: 'The Long Ascent', time: 63, won: true,
  });
  save.save('test');
  const written = store.get(SAVE_KEY);

  // A second SaveGame, as a fresh page load would build: `makeSave` starts from
  // empty storage, so the written payload is put back before the read.
  const b = makeSave({ relics: recorder(null), viewpoints: recorder(null) });
  store.set(SAVE_KEY, written);
  assert.equal(await b.save.load(), true);
  assert.deepEqual(b.save.relics.restored, [{ found: { citadel: 7 }, paid: [] }]);
  assert.deepEqual(b.save.viewpoints.restored, [{ worlds: { citadel: ['great-tower'] }, sets: [] }]);
  assert.equal(b.save.bestTrialTime('citadel_ascent', 'citadel'), 63,
    'the restored save forgot the best time');
});

test('a save written before this drop still loads', async () => {
  /* The one rule that matters more than any field here: an old save must not
   * become an unplayable one. Mutation that kills this: make `_validate`
   * require the three keys instead of merely type-checking them. */
  const { save } = makeSave({});
  save.save('test');
  const data = stored();
  delete data.relics;
  delete data.viewpoints;
  delete data.trials;
  // Re-seal it, exactly as a build without these fields would have.
  delete data.integrity;
  const legacy = { ...data };
  store.set(SAVE_KEY, JSON.stringify(legacy));

  const b = makeSave({ relics: recorder(null) });
  store.set(SAVE_KEY, JSON.stringify(legacy));
  assert.equal(await b.save.load(), true, 'a save from before this drop was refused');
  assert.deepEqual(b.save.relics.restored, [], 'an absent field was restored as something');
});

test('a wrong-typed progress field is a structural failure', () => {
  const { save } = makeSave({});
  save.save('test');
  for (const bad of [[1, 2], 'lots', 7]) {
    for (const key of ['relics', 'viewpoints', 'trials']) {
      const data = stored();
      data[key] = bad;
      delete data.integrity;
      store.set(SAVE_KEY, JSON.stringify(data));
      assert.equal(save.hasSave(), false,
        `a ${typeof bad} in "${key}" passed validation`);
      save.save('test');
    }
  }
});

/* ====================================================================== */
/* Trial times                                                             */
/* ====================================================================== */

test('only a WIN sets a record, and only a quicker one replaces it', () => {
  const { bus, save } = makeSave({});
  const fin = (time, won) => bus.emit('minigame:finished', {
    venueId: 'v', worldId: 'citadel', label: 'Trial', time, won,
  });

  fin(30, false);
  assert.equal(save.bestTrialTime('v', 'citadel'), null, 'losing a contest set a best time');

  fin(50, true);
  assert.equal(save.bestTrialTime('v', 'citadel'), 50);
  fin(60, true);
  assert.equal(save.bestTrialTime('v', 'citadel'), 50, 'a slower run overwrote the record');
  fin(42, true);
  assert.equal(save.bestTrialTime('v', 'citadel'), 42, 'a quicker run did not take the record');
});

test('records are keyed by world as well as venue', () => {
  const { bus, save } = makeSave({});
  bus.emit('minigame:finished', { venueId: 'v', worldId: 'citadel', time: 40, won: true });
  bus.emit('minigame:finished', { venueId: 'v', worldId: 'medieval', time: 90, won: true });
  assert.equal(save.bestTrialTime('v', 'citadel'), 40);
  assert.equal(save.bestTrialTime('v', 'medieval'), 90);
});

test('a malformed result is ignored rather than thrown', () => {
  const { bus, save } = makeSave({});
  for (const bad of [null, {}, { won: true }, { won: true, venueId: 'v' },
    { won: true, venueId: 'v', time: -1 }, { won: true, venueId: 'v', time: NaN }]) {
    assert.doesNotThrow(() => bus.emit('minigame:finished', bad));
  }
  assert.equal(save.bestTrialTime('v', null), null);
});

test('an injected trials system wins over the internal ledger', () => {
  const trials = recorder({ mine: true });
  const { bus, save } = makeSave({ trials });
  bus.emit('minigame:finished', { venueId: 'v', worldId: 'citadel', time: 40, won: true });
  save.save('test');
  assert.deepEqual(stored().trials, { mine: true },
    'the internal ledger overrode a real trials system');
});

test('no contests run means no trials key, not an empty object', () => {
  // A save is written every 30 seconds; an empty record in every one of them is
  // bytes and noise for a feature the player has not touched.
  const { save } = makeSave({});
  save.save('test');
  assert.equal(stored().trials, null);
});
