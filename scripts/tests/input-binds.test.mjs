import { test } from 'node:test';
import assert from 'node:assert/strict';
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
