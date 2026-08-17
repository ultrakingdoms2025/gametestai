import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Input, BINDABLE } from '../../src/core/Input.js';

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
  for (const bad of ['Escape', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'Tab']) {
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
