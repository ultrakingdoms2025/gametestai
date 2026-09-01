import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * THE SAVE SYSTEM'S THREE WAYS OF DESTROYING A SAVE, AND THE LADDER THAT WAS
 * NEVER THERE.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  1. `_fail` DEFAULTED TO DELETING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `_fail(message, err, { clear = true })`. Every call site on the read path
 * passed `{clear: false}` by hand; three did not, and each of those three is a
 * total-data-loss defect reachable by an ordinary player doing nothing wrong:
 *
 *   (a) a refused `localStorage.setItem` - a full quota, Safari private mode,
 *       storage switched off - responded by DELETING the last known-good save.
 *       A fact about the write, answered by destroying the read.
 *   (b) `if (data.version !== SAVE_SCHEMA) return _fail(...)`, with `clear`
 *       defaulting true. The moment `SAVE_SCHEMA` was incremented - a
 *       one-character edit, the ordinary way this file evolves - every
 *       returning player's save was deleted. And it happened while merely
 *       DRAWING THE TITLE CARD, because the card calls `savedAt()`, which
 *       reads. No player action was involved at any point.
 *   (c) the JSON parse failure on that same read path: one corrupt byte in
 *       localStorage and everything is gone, including the copy the player
 *       could otherwise have exported and handed to a later build.
 *
 * The `quiet` flag suppressed only the storage-read branch, so (b) and (c)
 * fired from `hasSave()` and `savedAt()` too.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  2. THERE WAS NO MIGRATION AT ALL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No `migrate`, no version ladder, nothing. The entire version handling in the
 * file was the equality in (b) - which is to say the only thing that would ever
 * have happened on a schema bump was the deletion. The payload has only grown,
 * so v1 → v2 has nothing to do TODAY; the point of building the ladder now is
 * that the first migration this game needs must not also be the commit that
 * invents the mechanism, written under pressure on the day the data is already
 * at risk.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  3. A HALF-LOADED GAME WAS SAVED OVER THE WHOLE ONE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `load()` returns false after applying the world and the position but before
 * the economy, inventory, loadout, mounts, relics and charters. `main.js`
 * treats that as non-fatal - correctly; a save that will not apply must still
 * let the player in - and goes straight on to emit `game:started`, which armed
 * `_started`. Thirty seconds later the autosave wrote the half-restored wreck
 * over the intact save it had just failed to read. The player's own progress
 * was the thing that destroyed it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  4. AND A WORLD THAT NO LONGER EXISTS PUT THE PLAYER INSIDE THE GROUND
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `_restoreWorld`'s unknown-world branch activated a fallback and returned
 * true. `load()` read that as success and teleported the player to the saved
 * x/y/z - a coordinate that means something only in the world it was recorded
 * in, and in any other world is underground, inside terrain, or in open sky.
 *
 * ── What is NOT reachable from here, said rather than implied ─────────────
 *
 * `SAVE_SCHEMA` is 1, so no genuinely old save exists to walk up the ladder
 * end to end through `_read`. `migrateSave` therefore takes its step registry
 * as a parameter, and the ladder is driven directly with fabricated rungs. What
 * that leaves unproven is the WIRING between a future `SAVE_MIGRATIONS` entry
 * and `_read` - which is covered by the two cases that ARE reachable: `_read`
 * refuses (without deleting) a version it cannot walk to, and accepts one it
 * can.
 */

/* ---------------------------------------------------------------------- */
/* Environment                                                             */
/* ---------------------------------------------------------------------- */

const store = new Map();
/** Set to a message to make every `setItem` throw, as a full quota does. */
let writeRefusal = null;

globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => {
    if (writeRefusal) throw new Error(writeRefusal);
    store.set(k, String(v));
  },
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

globalThis.window = globalThis.window ?? globalThis;
const listeners = new Map();
globalThis.window.addEventListener = (type, fn) => {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
};
globalThis.window.removeEventListener = (type, fn) => listeners.get(type)?.delete(fn);

/* A `document` with the one field the visibility flush reads. The class
 * optional-chains through `globalThis.document`, so the four older test files
 * that stub only `window` keep working - this one needs the real thing. */
globalThis.document = {
  visibilityState: 'visible',
  addEventListener: (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
  },
  removeEventListener: (type, fn) => listeners.get(type)?.delete(fn),
};

const fire = (type, ev = {}) => {
  for (const fn of [...(listeners.get(type) ?? [])]) fn(ev);
};

const { SaveGame, SAVE_KEY, SAVE_SCHEMA, SAVE_MIGRATIONS, migrateSave } =
  await import('../../src/systems/SaveGame.js');

function makeBus() {
  const handlers = new Map();
  const seen = [];
  return {
    seen,
    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(fn);
      return () => handlers.get(type)?.delete(fn);
    },
    emit(type, payload) {
      seen.push([type, payload]);
      for (const fn of [...(handlers.get(type) ?? [])]) fn(payload);
    },
  };
}

/** A save deep into another world, exactly as a returning player would have. */
const PRIOR = {
  version: 1,
  at: 1_700_000_000_000,
  world: 'medieval',
  player: { x: 900, y: 40, z: -120, yaw: 1.2, health: 80, maxHealth: 100 },
  credits: 4200,
  relics: { found: { medieval: 26 }, paid: ['medieval:half'] },
  mining: { taken: ['seam-a', 'seam-b'], mined: 2, credits: 60 },
};

function rig({ world = 'medieval', ids = ['medieval'], economy, player, mounts } = {}) {
  store.clear();
  writeRefusal = null;
  listeners.clear();
  globalThis.document.visibilityState = 'visible';
  store.set(SAVE_KEY, JSON.stringify(PRIOR));

  const bus = makeBus();
  const teleports = [];
  const built = [];
  const save = new SaveGame({
    bus,
    player: player ?? {
      position: { x: 0, y: 2, z: 0 },
      yaw: 0,
      health: 100,
      maxHealth: 100,
      teleport: (v, yaw) => teleports.push({ x: v.x, y: v.y, z: v.z, yaw }),
    },
    worldManager: {
      active: { id: world },
      ids,
      build: async (id) => { built.push(['build', id]); },
      activate: async (id) => { built.push(['activate', id]); },
    },
    economy: economy ?? { credits: 0 },
    mounts,
  });
  save.disableAutosave();
  return { bus, save, teleports, built };
}

const rawStored = () => store.get(SAVE_KEY);
const stored = () => JSON.parse(store.get(SAVE_KEY));

/* ====================================================================== */
/* 1. A READ NEVER DELETES                                                 */
/* ====================================================================== */

test('a refused write leaves the save that is already on disk byte for byte', () => {
  const { save } = rig();
  const before = rawStored();

  writeRefusal = 'QuotaExceededError';
  assert.equal(save.save('manual'), false, 'a refused write must report failure');

  assert.equal(rawStored(), before,
    'a full quota deleted the save. A refused WRITE says nothing whatever about the '
    + 'bytes already stored - and they are the only copy of the session');
});

test('a corrupt save is refused, not deleted - the player can still export it', () => {
  const { save } = rig();
  store.set(SAVE_KEY, '{"version":1,"player":{"x":0,'); // truncated

  assert.equal(save.hasSave(), false, 'a truncated payload must not read as a save');
  assert.equal(save.savedAt(), null);
  assert.equal(rawStored(), '{"version":1,"player":{"x":0,',
    'one corrupt byte deleted everything. A file that will not parse today is a file '
    + 'a later build, or a hand repair, may still recover');
});

test('an edited save is refused, not deleted', () => {
  const { save } = rig();
  save.save('manual');                       // seals it
  const sealed = stored();
  sealed.credits = 999_999;
  store.set(SAVE_KEY, JSON.stringify(sealed));

  assert.equal(save.hasSave(), false, 'an edited save must not load');
  assert.equal(stored().credits, 999_999,
    'the edited save was destroyed. Refusing to trust it is the whole job; deleting it '
    + 'takes the player\'s only copy over a flipped byte');
});

test('a version this build cannot read is refused, not deleted', () => {
  const { save, bus } = rig();
  /* A save from a NEWER build - the player rolled back, or ran an older tab.
   * There is no downgrade path and there never can be, so the only question is
   * whether the refusal also destroys it. It used to. */
  store.set(SAVE_KEY, JSON.stringify({ ...PRIOR, version: SAVE_SCHEMA + 5 }));

  assert.equal(save.hasSave(), false);
  assert.equal(save.savedAt(), null, 'the title card must not offer a continue it cannot honour');
  assert.equal(stored().version, SAVE_SCHEMA + 5, 'a future save was deleted by a read');
  assert.deepEqual(stored().relics, PRIOR.relics);
  assert.ok(bus.seen.some(([t]) => t === 'save:error'), 'the refusal was silent');
});

test('drawing the title card cannot destroy anything, whatever is stored', () => {
  /* The specific path that made the version case catastrophic: `savedAt()` is
   * called to render "Saved game found - 20 min ago", so a schema bump deleted
   * every returning player's save before they had touched a control. */
  for (const payload of [
    'not json at all',
    JSON.stringify({ version: 99, player: { x: 0, y: 0, z: 0 } }),
    JSON.stringify({ version: 1 }),                       // no player block
    JSON.stringify([1, 2, 3]),                            // not an object
    JSON.stringify({ version: 1, player: { x: 'NaN', y: 0, z: 0 } }),
  ]) {
    const { save } = rig();
    store.set(SAVE_KEY, payload);
    save.savedAt();
    save.hasSave();
    assert.equal(rawStored(), payload, `drawing the card destroyed ${payload.slice(0, 40)}`);
  }
});

test('no call site in SaveGame.js asks _fail to clear, and the default is false', () => {
  /* The rule, not the instance. `clear` stays a parameter because deleting the
   * save has to remain something a caller can say OUT LOUD if a reason ever
   * appears - what must never come back is a DEFAULT nobody typed. */
  const src = readFileSync(new URL('../../src/systems/SaveGame.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

  assert.ok(/_fail\(message, err, \{ clear = false \} = \{\}\)/.test(src),
    '_fail no longer defaults `clear` to false - the three critical read paths are open again');
  assert.ok(!/_fail\([^)]*clear:\s*true/.test(src),
    'a call site asks _fail to delete the save. That is a data-loss decision and needs '
    + 'a reason written next to it, not a quiet `true`');
});

/* ====================================================================== */
/* 2. THE VERSION LADDER                                                   */
/* ====================================================================== */

test('the ladder is registered by version and walks every rung in order', () => {
  const walked = [];
  const steps = {
    1: (s) => { walked.push(1); s.a = true; return s; },
    2: (s) => { walked.push(2); s.b = true; return s; },
    3: (s) => { walked.push(3); s.c = true; return s; },
  };
  const out = migrateSave({ version: 1, credits: 10 }, { to: 4, steps });

  assert.deepEqual(walked, [1, 2, 3], 'the ladder skipped or reordered a rung');
  assert.equal(out.version, 4, 'the walk did not end at the target version');
  assert.deepEqual([out.a, out.b, out.c], [true, true, true]);
  assert.equal(out.credits, 10, 'a field no step touched was lost');
});

test('a step that forgets its version stamp cannot loop or skip the ladder', () => {
  // The one field a step is not trusted with: forgetting it would spin the
  // walk for ever, and over-stamping would skip a rung.
  const out = migrateSave({ version: 1 }, { to: 3, steps: { 1: (s) => s, 2: (s) => s } });
  assert.equal(out.version, 3);
});

test('a missing rung, a throwing step and a future version all REFUSE rather than delete', () => {
  // null is "this build cannot read it". It is never a licence to destroy it -
  // the caller reports and leaves the bytes alone. @see _read
  assert.equal(migrateSave({ version: 1 }, { to: 3, steps: { 1: (s) => s } }), null,
    'a missing rung was walked past');
  assert.equal(migrateSave({ version: 1 }, { to: 2, steps: { 1: () => { throw new Error('bad'); } } }), null,
    'a throwing step did not refuse');
  assert.equal(migrateSave({ version: 1 }, { to: 2, steps: { 1: () => null } }), null,
    'a step that returned nothing was accepted');
  assert.equal(migrateSave({ version: 4 }, { to: 2, steps: {} }), null,
    'a save from a newer build was accepted - there is no downgrade path');
  for (const bad of [null, undefined, [1], 'x', { version: 0 }, { version: 'one' }]) {
    assert.equal(migrateSave(bad, { to: 2, steps: {} }), null, `accepted ${JSON.stringify(bad)}`);
  }
});

test('a step is handed a private copy, so it can never reach the caller\'s payload', () => {
  const original = { version: 1, credits: 10, nested: { relics: ['a'] } };
  const out = migrateSave(original, {
    to: 2,
    steps: { 1: (s) => { s.credits = 999; s.nested.relics.push('b'); return s; } },
  });
  assert.equal(out.credits, 999);
  assert.equal(original.credits, 10, 'a migration step mutated the stored payload');
  assert.deepEqual(original.nested.relics, ['a'], 'a step reached the caller through a nested object');
});

test('a migrated payload is re-sealed, because the tag described the old body', () => {
  const { save } = rig();
  save.save('manual');
  const sealed = stored();
  assert.equal(typeof sealed.integrity, 'string', 'the save is not sealed - the rig has drifted');

  const out = migrateSave(sealed, { to: 2, steps: { 1: (s) => { s.credits = 77; return s; } } });
  assert.notEqual(out.integrity, sealed.integrity,
    'the stale tag was carried forward. It describes bytes that no longer exist, so the '
    + 'next read would refuse the save as "edited" - a migration that bricks what it migrated');
  // A second pass at the same version is a no-op and must not re-seal again.
  assert.equal(migrateSave(out, { to: 2, steps: {} }), out);
});

test('an unsealed save stays unsealed through a migration', () => {
  // Every save written before the seal shipped has no tag, and inventing one
  // here would claim a provenance this build cannot vouch for.
  const out = migrateSave({ version: 1, credits: 1 }, { to: 2, steps: { 1: (s) => s } });
  assert.equal('integrity' in out, false);
});

test('SAVE_MIGRATIONS is frozen and keyed by the version each step upgrades FROM', () => {
  assert.ok(Object.isFrozen(SAVE_MIGRATIONS));
  for (const key of Object.keys(SAVE_MIGRATIONS)) {
    const n = Number(key);
    assert.ok(Number.isInteger(n) && n >= 1, `"${key}" is not a version number`);
    assert.ok(n < SAVE_SCHEMA, `a step is registered for ${n}, at or above the current schema`);
    assert.equal(typeof SAVE_MIGRATIONS[key], 'function');
  }
  // Every rung from 1 to the current schema has to exist, or the ladder has a
  // hole and a save at that version is unreadable.
  for (let v = 1; v < SAVE_SCHEMA; v++) {
    assert.equal(typeof SAVE_MIGRATIONS[v], 'function',
      `no migration registered for ${v} -> ${v + 1}: every save at version ${v} is unreadable`);
  }
});

/* ====================================================================== */
/* 3. A PARTIAL LOAD MUST NOT BE SAVED                                     */
/* ====================================================================== */

/** An economy that refuses to restore, which stops `load()` mid-way. */
const brokenEconomy = { credits: 0, set() { throw new Error('economy is out'); } };

test('a load that stops part way switches the autosave OFF and says so', async () => {
  const { save, bus } = rig({ economy: brokenEconomy });

  assert.equal(await save.load(), false, 'the partial load reported success');
  assert.ok(bus.seen.some(([t]) => t === 'save:partial'),
    'nothing told the HUD the save only partly loaded');
  assert.ok(
    bus.seen.some(([t, p]) => t === 'hud:notify' && /partly loaded/i.test(p?.text ?? '')),
    'the player was not told, in words, before anything could overwrite anything'
  );
  assert.equal(save.autosaveSeconds, 0, 'the autosave timer is still armed after a partial load');
});

test('game:started cannot re-arm the autosave after a partial load', async () => {
  /* THE EXACT SEQUENCE. `main.js` catches the false, calls the failure
   * non-fatal, and emits `game:started` on the next line - which is the line
   * that used to arm `_started` and hand the wreckage to the thirty-second
   * timer. */
  const { save, bus } = rig({ economy: brokenEconomy });
  await save.load();
  const before = rawStored();

  bus.emit('game:started');
  assert.equal(save.autoSave('autosave'), false,
    'game:started re-armed the autosave over a half-restored game');
  bus.emit('world:changed', { world: { id: 'station' } });
  assert.equal(rawStored(), before,
    'a world change wrote the half-restored state over the intact save');
});

test('an explicit save after a partial load is honoured, and re-arms nothing until it lands', async () => {
  const { save } = rig({ economy: brokenEconomy });
  await save.load();

  // The player's own decision to keep what they have. It succeeds, and because
  // the stored copy now IS the live one, the degradation is over.
  assert.equal(save.save('menu'), true);
  assert.equal(save.autoSave('autosave'), true, 'an explicit save did not re-arm unattended writes');
});

test('a refused explicit save does not arm the autosave on its way past', () => {
  /* `_started = true` used to be the FIRST line of `save()`, so a save that
   * then failed left unattended writes armed at a moment nothing had been
   * written. */
  const { save } = rig();
  writeRefusal = 'QuotaExceededError';
  assert.equal(save.save('menu'), false);
  writeRefusal = null;
  assert.equal(save.autoSave('autosave'), false,
    'a FAILED save armed the autosave - the flag is meant to mean "the stored copy is the live one"');
});

test('a clean load leaves the autosave running and nothing degraded', async () => {
  const { save, bus } = rig();
  assert.equal(await save.load(), true);
  bus.emit('game:started');
  assert.equal(save.autoSave('autosave'), true, 'a clean load left the autosave switched off');
});

/* ====================================================================== */
/* 4. A WORLD THAT IS GONE DOES NOT TAKE THE COORDINATES WITH IT           */
/* ====================================================================== */

test('a save naming a world this build no longer has does not restore the position', async () => {
  const { save, teleports, built, bus } = rig({ world: 'station', ids: ['station'] });
  // PRIOR names 'medieval', at (900, 40, -120). In 'station' that is inside
  // the ground, inside a wall, or in open sky over a smaller map.
  assert.equal(await save.load(), true, 'a substituted world must still be a playable load');

  assert.deepEqual(built, [['build', 'station'], ['activate', 'station']]);
  assert.deepEqual(teleports, [],
    'the player was teleported to a coordinate recorded in a different world');
  assert.ok(
    bus.seen.some(([t, p]) => t === 'hud:notify' && /no longer here/i.test(p?.text ?? '')),
    'the player was silently moved to another world'
  );
});

test('an exactly-resolved world still restores the stored position', async () => {
  // The other half: the guard must not cost every ordinary load its position.
  const { save, teleports } = rig({ world: 'station', ids: ['station', 'medieval'] });
  assert.equal(await save.load(), true);
  assert.deepEqual(teleports, [{ x: 900, y: 40, z: -120, yaw: 1.2 }]);
});

test('a world already active is exact, and the position goes back', async () => {
  const { save, teleports, built } = rig({ world: 'medieval', ids: ['medieval'] });
  assert.equal(await save.load(), true);
  assert.deepEqual(built, [], 'the active world was rebuilt for nothing');
  assert.deepEqual(teleports, [{ x: 900, y: 40, z: -120, yaw: 1.2 }]);
});

/* ====================================================================== */
/* 5. A PHONE FIRES pagehide AND visibilitychange, NOT beforeunload         */
/* ====================================================================== */

test('backgrounding a tab flushes the local save, on both events a phone sends', () => {
  /* iOS Safari and Android Chrome routinely evict a backgrounded tab without
   * ever firing `beforeunload` - documented behaviour, not a bug - so up to
   * thirty seconds of play was lost on every app switch. `main.js` already
   * flushed the REMOTE beacon on `pagehide` for exactly this reason; the LOCAL
   * save, which is all a signed-out player has, was never given the same
   * treatment. */
  for (const [type, prepare] of [
    ['pagehide', () => {}],
    ['visibilitychange', () => { globalThis.document.visibilityState = 'hidden'; }],
  ]) {
    const { save, bus } = rig();
    bus.emit('game:started');
    const before = rawStored();
    prepare();
    fire(type);
    assert.notEqual(rawStored(), before, `${type} did not flush the local save`);
    assert.equal(stored().world, 'medieval');
  }
});

test('a tab merely becoming visible again writes nothing', () => {
  const { save, bus } = rig();
  bus.emit('game:started');
  const before = rawStored();
  globalThis.document.visibilityState = 'visible';
  fire('visibilitychange');
  assert.equal(rawStored(), before, 'coming back to the tab wrote a save');
  void save;
});

test('backgrounding the title screen cannot overwrite the save behind it', () => {
  // The guard `beforeunload` already honoured, now on two more events: no
  // unattended write before the player has actually entered the world.
  const { save } = rig();
  const before = rawStored();
  fire('pagehide');
  globalThis.document.visibilityState = 'hidden';
  fire('visibilitychange');
  assert.equal(rawStored(), before,
    'backgrounding the boot screen wrote a pristine spawn state over the real save');
  void save;
});

/* ====================================================================== */
/* 6. THE MOUNT THAT WAS OUT COMES BACK                                    */
/* ====================================================================== */

test('a restored mount blob completes its deferred summon instead of dismounting', async () => {
  /* Quit mid-flight on the dragon, reload, stand on foot. Three breaks in one
   * path: `serialize` writes `active` inside the custom blob, `deserialize`
   * returned undefined so the caller fell through to the (undefined)
   * `snap.active` and DISMOUNTED, and the deferred `restorePending()` had no
   * caller anywhere in the codebase. */
  const calls = [];
  const mounts = {
    mounted: true,
    serialize: () => ({ unlocked: ['dragon'], active: 'dragon' }),
    deserialize: (d) => { calls.push(['deserialize', d.active]); return true; },
    restorePending: () => { calls.push(['restorePending']); },
    dismount: () => { calls.push(['dismount']); },
    summon: (id) => { calls.push(['summon', id]); },
  };
  const { save } = rig({ mounts });
  store.set(SAVE_KEY, JSON.stringify({
    ...PRIOR,
    mounts: { custom: { unlocked: ['dragon'], active: 'dragon' } },
  }));

  assert.equal(await save.load(), true);
  assert.deepEqual(calls, [['deserialize', 'dragon'], ['restorePending']],
    'the deferred summon was dropped, or the player was dismounted by their own load');
});

test('a pre-serialize save still restores its mount by id', async () => {
  // The older payload shape, which had no custom blob at all.
  const calls = [];
  const mounts = { mounted: false, summon: (id) => calls.push(id) };
  const { save } = rig({ mounts });
  store.set(SAVE_KEY, JSON.stringify({ ...PRIOR, mounts: { active: 'horse', mounted: true } }));
  assert.equal(await save.load(), true);
  assert.deepEqual(calls, ['horse']);
});
