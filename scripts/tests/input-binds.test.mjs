import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Input, BINDABLE, RESERVED_CODES } from '../../src/core/Input.js';

/**
 * Persisted key bindings are read back from `localStorage`, and storage
 * outlives the build that wrote it. `setBinding` refuses to point an action at
 * a reserved key (Escape, F1-F10, Tab) because those are the game's own escape
 * hatches, but that guard only covers the write: an entry saved by an older
 * build with a narrower list - or hand-edited - came straight back on load and
 * took the key with it, leaving the player with an Escape that no longer closes
 * anything and no UI left to take it back. `_loadBinds` drops those entries.
 *
 * Driven through `Object.create` rather than `new Input(...)`: the constructor
 * binds DOM listeners, and none of that is involved in reading storage.
 */
const KEY = 'aether-nexus:binds:v1';

function loadWith(stored) {
  const raw = JSON.stringify(stored);
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: (k) => (k === KEY ? raw : null), setItem() {} },
    configurable: true,
    writable: true,
  });
  try {
    const i = Object.create(Input.prototype);
    i.state = {};
    i._keys = new Set();
    i._binds = new Map();
    i._bindsInverse = new Map();
    i.bus = null;
    i._loadBinds();
    return i._binds;
  } finally {
    if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
    else delete globalThis.localStorage;
  }
}

test('_loadBinds drops a persisted binding that points at a reserved key', () => {
  // 'jump' is a real BINDABLE row, so nothing here is rejected by the
  // table-validation pass that runs first.
  assert.ok(BINDABLE.some((d) => d.code === 'Space'), 'Space is no longer a BINDABLE row');
  for (const bad of ['Escape', 'F1', 'F5', 'F10', 'Tab']) {
    const binds = loadWith({ Space: bad });
    assert.equal(binds.get('Space'), undefined, `a stored '${bad}' binding survived the load`);
  }
});

test('_loadBinds still restores a legitimate rebind', () => {
  // The guard above must not be a blanket "ignore storage".
  const binds = loadWith({ Space: 'KeyB', KeyE: 'F3' });
  assert.equal(binds.get('Space'), 'KeyB');
  assert.equal(binds.get('KeyE'), undefined, 'F3 is reserved');
});

test('setBinding and _loadBinds enforce the same reserved list', () => {
  // Both read RESERVED_CODES; this pins them together from the outside so a
  // key added to one path cannot be forgotten on the other.
  for (const bad of ['Escape', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'Tab']) {
    const i = Object.create(Input.prototype);
    i.state = {};
    i._keys = new Set();
    i._binds = new Map();
    i._bindsInverse = new Map();
    i.bus = null;
    assert.equal(i.setBinding('Space', bad).ok, false, `setBinding accepted '${bad}'`);
    assert.equal(loadWith({ Space: bad }).get('Space'), undefined, `_loadBinds accepted '${bad}'`);
  }
});

const FS_KEY = 'aether:fullscreen';

/** Drive prototype methods against a fake storage, like `loadWith` above. */
function withStorage(store, fn) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    configurable: true,
    writable: true,
  });
  try { return fn(); } finally {
    if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
    else delete globalThis.localStorage;
  }
}

test('RESERVED_CODES is exported and covers every browser function key', () => {
  /* F11 is the browser's fullscreen key and F12 opens devtools un-preventably.
   * The hub owns fullscreen now, so neither is ever a game key - and a binding
   * pointed at F12 would be a key that half works, which is worse than one
   * that does not work at all. */
  for (const c of ['Escape', 'Tab', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12']) {
    assert.ok(RESERVED_CODES.includes(c), `${c} is not reserved`);
  }
});

test('setBinding and _loadBinds both refuse F11 and F12', () => {
  for (const bad of ['F11', 'F12']) {
    const i = Object.create(Input.prototype);
    i.state = {}; i._keys = new Set(); i._binds = new Map(); i._bindsInverse = new Map(); i.bus = null;
    assert.equal(i.setBinding('Space', bad).ok, false, `setBinding accepted '${bad}'`);
    assert.equal(loadWith({ Space: bad }).get('Space'), undefined, `_loadBinds accepted '${bad}'`);
  }
});

test('fullscreenPreferred defaults on, persists off, and reads back', () => {
  /* Default ON because keyboard lock - the only thing between a crouch-walking
   * player (Ctrl+W) and a closed window - is granted only in fullscreen. A
   * player who turns it off said so deliberately and must not have it silently
   * turned back on by the next resume. */
  const store = {};
  withStorage(store, () => {
    const i = Object.create(Input.prototype);
    assert.equal(i._loadFullscreenPref(), true, 'default is not On');
    i._fullscreenPreferred = true;
    i.fullscreenPreferred = false;
    assert.equal(i.fullscreenPreferred, false);
    assert.equal(store[FS_KEY], '0');
  });
  withStorage({ [FS_KEY]: '0' }, () => {
    assert.equal(Object.create(Input.prototype)._loadFullscreenPref(), false, 'a stored Off did not survive');
  });
  withStorage({ [FS_KEY]: '1' }, () => {
    assert.equal(Object.create(Input.prototype)._loadFullscreenPref(), true);
  });
});

test('requestLock only asks for fullscreen when the preference says so', async () => {
  /* The bug this prevents: `requestLock` re-entered fullscreen unconditionally
   * (`Input.js:168-176`), so "Fullscreen: Off" in the hub was undone by the
   * very next Resume. The sibling branch stays unconditional on purpose. */
  const saved = globalThis.document;
  const calls = { fs: 0, kb: 0 };
  globalThis.document = {
    fullscreenElement: null,
    documentElement: { requestFullscreen: () => { calls.fs++; return Promise.resolve(); } },
  };
  try {
    const i = Object.create(Input.prototype);
    i._locked = false;
    i.canvas = { requestPointerLock: () => undefined };
    i._lockKeyboard = () => { calls.kb++; };

    i._fullscreenPreferred = false;
    i.requestLock();
    assert.equal(calls.fs, 0, 'requestLock entered fullscreen against the preference');

    i._fullscreenPreferred = true;
    i.requestLock();
    assert.equal(calls.fs, 1);

    // Already fullscreen: keyboard lock is taken whatever the preference says.
    globalThis.document.fullscreenElement = {};
    i._fullscreenPreferred = false;
    i.requestLock();
    await Promise.resolve();
    assert.ok(calls.kb >= 1, 'an already-fullscreen player lost keyboard lock');
  } finally {
    if (saved === undefined) delete globalThis.document;
    else globalThis.document = saved;
  }
});

/* ------------------------------------------------------------------ */
/* Crouch is not a modifier                                            */
/* ------------------------------------------------------------------ */

/**
 * Ctrl was a second, hard-coded crouch binding for a long time, invisible to
 * the rebinding panel and impossible to remove. A player found it the way these
 * things are always found - by trying to use it: "ctrl does the same thing and
 * I think that might be making it hard to roll".
 *
 * They were right, and there were three separate faults behind it:
 *
 *   1. Crouch kills sprint (`Player._sprinting` is gated on `!_crouching`) and
 *      the ground dodge needs LEAP_MIN_SPEED to arm. Ctrl is a modifier, so it
 *      gets HELD; held from a standstill it pins you at `crouchSpeed` and the
 *      dodge can never fire. Tapping C works and holding Ctrl cannot.
 *   2. Ctrl+W closes the tab outside fullscreen. `preventDefault` covers only
 *      the scroll keys, and Keyboard Lock is in force only while
 *      `document.fullscreenElement` is set - and fullscreen is a *preference*
 *      the pause hub offers to turn off.
 *   3. Ctrl+Shift is the Windows input-method switcher, and Ctrl+Shift+W is
 *      exactly the dodge input. No web API can claim that combination.
 *
 * These pin the fix from both ends: the axis must ignore the modifier, and the
 * event path must never let a Ctrl-modified key reach the game at all.
 */

/** Drive `_syncAxes` over a synthetic key set, without touching the DOM. */
function axesFor(codes, binds = new Map()) {
  const inp = Object.create(Input.prototype);
  inp._keys = new Set(codes);
  inp._bindsInverse = binds;
  inp.state = {
    forward: 0, right: 0, jump: false, sprint: false, crouch: false,
    fire: false, aim: false, reload: false, interact: false,
    lookX: 0, lookY: 0, wheel: 0,
  };
  inp._syncAxes();
  return inp.state;
}

test('crouch ignores both Control keys', () => {
  assert.equal(axesFor(['ControlLeft']).crouch, false, 'ControlLeft must not crouch');
  assert.equal(axesFor(['ControlRight']).crouch, false, 'ControlRight must not crouch');
  assert.equal(axesFor(['ControlLeft', 'ControlRight']).crouch, false);
});

test('crouch is on C, and follows a rebind', () => {
  assert.equal(axesFor(['KeyC']).crouch, true, 'the shipped key must crouch');
  // `_bindsInverse` maps the shipped code to whatever the player chose.
  const rebound = new Map([['KeyC', 'KeyZ']]);
  assert.equal(axesFor(['KeyZ'], rebound).crouch, true, 'a rebind must crouch');
  assert.equal(axesFor(['KeyC'], rebound).crouch, false, 'the old key must stop crouching');
});

test('crouch does not kill the sprint input it is combined with', () => {
  // The dodge is sprint-then-tap, so the two must be readable in one frame.
  const s = axesFor(['KeyW', 'ShiftLeft', 'KeyC']);
  assert.equal(s.crouch, true);
  assert.equal(s.sprint, true);
  assert.equal(s.forward, 1);
});

test('a Ctrl-modified key never reaches the game', () => {
  // The guard lives in the `onKey` closure inside `_bind`, so this asserts the
  // source rather than the behaviour: there must be no allow-list carve-out
  // that lets a ctrlKey event through. Ctrl+W closing the tab while the game
  // also acted on the W is precisely the defect being pinned.
  const src = readFileSync(new URL('../../src/core/Input.js', import.meta.url), 'utf8');
  assert.match(
    src,
    /if \(e\.metaKey \|\| e\.altKey \|\| e\.ctrlKey\) return;/,
    'onKey must drop every modifier combination outright'
  );
  // Match the DECLARATION, not the name: the comment above it legitimately
  // narrates why the allow-list was removed, and this repo's extent gate makes
  // the same distinction by stripping comments before scanning for literals.
  assert.doesNotMatch(
    src,
    /const\s+CTRL_GAME_KEYS\s*=/,
    'the Ctrl allow-list must be gone, not merely unused'
  );
});

test('the Control keys are reserved, so the panel cannot bind an action to them', () => {
  for (const code of ['ControlLeft', 'ControlRight']) {
    assert.ok(RESERVED_CODES.includes(code), `${code} must be reserved`);
  }
  // And the write guard must honour it, or storage fills with dead bindings.
  const inp = Object.create(Input.prototype);
  inp._binds = new Map();
  inp._bindsInverse = new Map();
  inp._rebuildBinds = () => {};
  inp._saveBinds = () => {};
  const crouch = BINDABLE.find((b) => b.action === 'crouch');
  assert.equal(crouch.code, 'KeyC', 'crouch must ship on a non-modifier key');
  // `setBinding` reports a result object, not a bare boolean.
  assert.equal(inp.setBinding('KeyC', 'ControlLeft').ok, false, 'setBinding must refuse a modifier');
  assert.equal(inp._binds.size, 0, 'and must not have written the refused binding');
});
