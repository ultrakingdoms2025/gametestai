/**
 * The `reset` code word: the way out of anywhere.
 *
 * Asked for from play - "if i am lost in the maze i could type reset and get
 * back to station". The maze is the world that makes it necessary, because it
 * regenerates its layout on every entry, so a route a player remembers is worth
 * nothing and `K` (UnstuckSystem) only ever rescues WITHIN the current world.
 *
 * `AdminCheats` guards its `window.addEventListener` on `typeof window`, so it
 * constructs headlessly and the actions can be driven directly. The typed-key
 * path is exercised through `_handleKey` with a synthetic event, which is the
 * same shape `Input` would hand a browser keydown.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { AdminCheats } from '../../src/systems/AdminCheats.js';

/** Records what a fake world manager was asked to do. */
function stubWorld(activeId, { fail = false } = {}) {
  const calls = [];
  return {
    calls,
    active: activeId ? { id: activeId } : null,
    activate(id) {
      calls.push(id);
      return fail ? Promise.reject(new Error('build failed')) : Promise.resolve();
    },
  };
}

function stubBus() {
  const events = [];
  return { events, emit: (name, payload) => events.push({ name, payload }) };
}

test('reset is registered as a code word', () => {
  const cheats = new AdminCheats({ worldManager: stubWorld('maze') });
  assert.ok(cheats.codes.has('reset'), 'the reset code must exist');
  assert.equal(cheats.codes.get('reset').label, 'Return to Aether Station');
});

test('reset activates the station from another world', async () => {
  const wm = stubWorld('maze');
  const bus = stubBus();
  const cheats = new AdminCheats({ bus, worldManager: wm });

  const msg = cheats.codes.get('reset').run();

  assert.equal(wm.calls.length, 1, 'must ask for exactly one activation');
  assert.equal(wm.calls[0], 'station', 'must activate the station and no other world');
  assert.match(msg, /Return/i, 'must acknowledge the keystroke immediately');
  await Promise.resolve();
  await Promise.resolve();
});

test('reset does not re-activate when already on the station', () => {
  const wm = stubWorld('station');
  const cheats = new AdminCheats({ bus: stubBus(), worldManager: wm });

  const msg = cheats.codes.get('reset').run();

  assert.equal(wm.calls.length, 0, 'must not rebuild the world the player is standing in');
  assert.match(msg, /Already/i);
});

test('reset abandons a crossing still in flight before it leaves', () => {
  /* `Portals.enter` owns the player's input for the length of a transition and
   * only its own completion gives it back. A reset typed by somebody stranded
   * mid-crossing must not leave that owner behind - which is exactly the state
   * this whole rescue exists for. */
  let aborted = 0;
  const wm = stubWorld('maze');
  const cheats = new AdminCheats({
    bus: stubBus(),
    worldManager: wm,
    portals: { abortTransition: () => { aborted++; return true; } },
  });

  cheats.codes.get('reset').run();

  assert.equal(aborted, 1, 'must abort an in-flight crossing first');
  assert.equal(wm.calls[0], 'station');
});

test('reset reports rather than throws when the station cannot be reached', async () => {
  const wm = stubWorld('maze', { fail: true });
  const bus = stubBus();
  const cheats = new AdminCheats({ bus, worldManager: wm });

  assert.doesNotThrow(() => cheats.codes.get('reset').run());

  // Let the rejection handler run.
  await new Promise((r) => setTimeout(r, 0));
  const warned = bus.events.filter(
    (e) => e.name === 'hud:notify' && e.payload?.tone === 'warn'
  );
  assert.equal(warned.length, 1, 'a failed rescue must say so, not fail silently');
});

test('reset survives having no world manager at all', () => {
  const cheats = new AdminCheats({ bus: stubBus() });
  assert.doesNotThrow(() => {
    const msg = cheats.codes.get('reset').run();
    assert.match(msg, /Cannot reach/i);
  });
});

test('typing r-e-s-e-t fires it through the real key path', () => {
  const wm = stubWorld('maze');
  const cheats = new AdminCheats({ bus: stubBus(), worldManager: wm });

  for (const ch of 'reset') {
    cheats._handleKey({ code: `Key${ch.toUpperCase()}`, target: null });
  }

  assert.equal(wm.calls[0], 'station', 'the typed sequence must fire the code');
});

test('a mistyped prefix still fires on the next attempt', () => {
  /* The rolling buffer is the reason a code needs no clearing - the header says
   * "ammoammo" still fires on the second attempt, and a rescue code is the one
   * most likely to be typed in a hurry. */
  const wm = stubWorld('maze');
  const cheats = new AdminCheats({ bus: stubBus(), worldManager: wm });

  for (const ch of 'resereset') {
    cheats._handleKey({ code: `Key${ch.toUpperCase()}`, target: null });
  }

  assert.equal(wm.calls.length, 1, 'must fire exactly once, on the completed code');
  assert.equal(wm.calls[0], 'station');
});

test('reset does not fire while the chat box owns the keyboard', () => {
  const wm = stubWorld('maze');
  const cheats = new AdminCheats({
    bus: stubBus(),
    worldManager: wm,
    input: { textCaptured: true },
  });

  for (const ch of 'reset') {
    cheats._handleKey({ code: `Key${ch.toUpperCase()}`, target: null });
  }

  assert.equal(wm.calls.length, 0, 'typing "reset" in chat must not teleport the player');
});
