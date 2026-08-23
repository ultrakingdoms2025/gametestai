import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * THE ACCOUNT SYNC DESTROYED THE SAVE IT WAS ABOUT TO LOAD.
 *
 * ── The defect ────────────────────────────────────────────────────────────
 * `SaveGame` has always had the guard for this: `_autoSave` refuses to write
 * while `_loading`, and refuses before `game:started`, because - in the words
 * of the comment that has sat on `_started` since it was introduced - writing
 * "a pristine spawn state over the save the player was about to load ... is
 * the single worst thing a save system can do."
 *
 * `main.js` reached past it. `schedulePersist` called the PUBLIC `save.save()`,
 * which not only skips both guards but sets `_started = true` on the way past,
 * permanently arming the autosave it had just bypassed.
 *
 * The trigger is not exotic; it is every returning signed-in player:
 *
 *   1. `boot()` awaits `hydrateAccountSession()`               (main.js:947)
 *   2. which applies the server balance, `economy.set(n, 'account-sync')`
 *   3. `Economy.set` emits `credits:changed` for any non-zero delta - and a
 *      freshly constructed `Economy` holds 0, so ANY stored balance qualifies
 *   4. `bus.on('credits:changed', ... schedulePersist)`        (main.js:2026)
 *   5. 750 ms later `save.save()` writes a snapshot of the boot state
 *
 * At step 5 the player is still on the title screen. The seven progress
 * systems - relics, viewpoints, objectives, trials, piloting, mining and the
 * character - have not been loaded, so they snapshot as null. The world is the
 * boot world and the player is at spawn. That is what lands on top of the real
 * save, and it is what CONTINUE then loads.
 *
 * ── Why a scrape as well as a behavioural test ────────────────────────────
 * The guard lives in `SaveGame` and is tested here directly. But the defect
 * was never in `SaveGame` - it was in a single call site choosing the wrong
 * method. A behavioural test that rebuilds the `main.js` wiring proves only
 * that the rebuilt wiring is sound; it would have passed happily while the
 * real `main.js` went on destroying saves. So the last two tests read
 * `main.js` itself and pin the call site.
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
const { Economy } = await import('../../src/systems/Economy.js');

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

/** The save a returning player already has on disk: deep into another world. */
const PRIOR_SAVE = {
  version: 1,
  at: 1_700_000_000_000,
  world: 'medieval',
  player: { x: 900, y: 40, z: -120, yaw: 1.2, health: 80, maxHealth: 100 },
  credits: 4200,
  relics: { found: { medieval: 26 }, paid: ['medieval:half'] },
  mining: { taken: ['seam-a', 'seam-b', 'seam-c'], mined: 3, credits: 90 },
};

function makeSave({ economy } = {}) {
  store.clear();
  store.set(SAVE_KEY, JSON.stringify(PRIOR_SAVE));
  const bus = makeBus();
  const save = new SaveGame({
    bus,
    player: { position: { x: 0, y: 2, z: 0 }, yaw: 0, health: 100, maxHealth: 100 },
    worldManager: { active: { id: 'citadel' }, ids: ['citadel'] },
    economy: economy ?? { credits: 0 },
  });
  save.disableAutosave();
  return { bus, save };
}

const stored = () => JSON.parse(store.get(SAVE_KEY));

/* ====================================================================== */
/* 1. The guard itself, reachable from outside                             */
/* ====================================================================== */

test('an unattended write before the player enters is refused', () => {
  const { save } = makeSave();

  assert.equal(save.autoSave('credits:account-sync'), false,
    'autoSave must refuse before game:started');
  assert.deepEqual(stored(), PRIOR_SAVE,
    'the save on disk must be untouched, byte for byte');
});

test('a refused unattended write does not arm the autosave', () => {
  const { save, bus } = makeSave();

  save.autoSave('credits:account-sync');
  // The bug: save() sets _started = true on its way past the guard, so a
  // second attempt would succeed even though the player never entered.
  assert.equal(save.autoSave('autosave'), false,
    'refusing once must not arm the next attempt');
  assert.deepEqual(stored(), PRIOR_SAVE);

  bus.emit('game:started');
  assert.equal(save.autoSave('autosave'), true,
    'once the player is in, the same call must write');
});

test('an explicit save is still honoured before the player enters', () => {
  const { save } = makeSave();
  // The pause hub's Save item is a deliberate player action, not an unattended
  // write, and must not be caught by this guard.
  assert.equal(save.save('menu'), true);
  assert.notDeepEqual(stored(), PRIOR_SAVE);
});

/* ====================================================================== */
/* 2. The scenario, with a real Economy                                    */
/* ====================================================================== */

test('the account balance arriving at boot leaves the prior save intact', async () => {
  store.clear();
  store.set(SAVE_KEY, JSON.stringify(PRIOR_SAVE));
  const bus = makeBus();
  const economy = new Economy({ bus });        // fresh boot holds 0 credits
  const save = new SaveGame({
    bus,
    player: { position: { x: 0, y: 2, z: 0 }, yaw: 0, health: 100, maxHealth: 100 },
    worldManager: { active: { id: 'citadel' }, ids: ['citadel'] },
    economy,
  });
  save.disableAutosave();

  // main.js:2026, wired exactly as the orchestrator wires it, but through the
  // guarded call this drop introduces.
  let persistTimer = null;
  const schedulePersist = (reason) => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => { persistTimer = null; save.autoSave(reason); }, 5);
  };
  bus.on('credits:changed', ({ reason }) => schedulePersist(`credits:${reason ?? 'change'}`));

  // main.js:877, hydrateAccountSession: the server's opening answer.
  economy.set(4200, 'account-sync');
  await new Promise((r) => setTimeout(r, 30));

  const after = stored();
  assert.equal(after.world, 'medieval', 'the saved world must survive the account sync');
  assert.deepEqual(after.relics, PRIOR_SAVE.relics, 'relics must survive the account sync');
  assert.deepEqual(after.mining, PRIOR_SAVE.mining, 'mining must survive the account sync');
});

/* ====================================================================== */
/* 3. The call site in main.js                                             */
/* ====================================================================== */

test('main.js routes background persists through the guarded write', () => {
  const src = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8');

  const start = src.indexOf('const schedulePersist');
  assert.ok(start > 0, 'schedulePersist must still exist in main.js');
  // The function body, up to the closing of its arrow.
  const body = src.slice(start, src.indexOf('};', start) + 2);

  assert.ok(/save\.autoSave\(/.test(body),
    'schedulePersist must persist through save.autoSave(), which honours the ' +
    '_started and _loading guards');
  assert.ok(!/save\.save\(/.test(body),
    'schedulePersist must NOT call save.save(): it bypasses both guards and ' +
    'arms the autosave, which is how a boot-time account sync came to ' +
    'overwrite the save the player was about to load');
});

test('the only raw save() calls in main.js are deliberate player actions', () => {
  const src = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8');
  const lines = src.split(/\r?\n/);

  /* `saveAndBackup` is the pause hub's Save item - a menu the player chose, so
   * it is allowed to write unguarded. Anything else reaching the raw write
   * from an event handler is the defect this file exists to prevent, and has
   * to be added here on purpose rather than by accident. */
  const offenders = [];
  lines.forEach((line, i) => {
    if (!/\bsave\.save\(/.test(line)) return;
    offenders.push(`${i + 1}: ${line.trim()}`);
  });

  assert.deepEqual(offenders, [],
    'an unguarded save.save() outside a deliberate player action:\n' + offenders.join('\n'));
});
