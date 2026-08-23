import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Input } from '../../src/core/Input.js';
import { EventBus } from '../../src/core/EventBus.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** Comments are documentation, not calls. */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/**
 * Reaching a playable state without a pointer lock.
 *
 * ── The defect these gates exist for ──────────────────────────────────────
 *
 * On a phone the boot tap called `input.requestLock()`, which called
 * `canvas.requestPointerLock?.()`. iOS Safari does not implement the method,
 * so the optional call returned `undefined`, there was no promise to reject,
 * and nothing anywhere learned that the request had failed. `HUD._requestLock`
 * then waited for a confirmation that could not arrive, decided it had been
 * refused, put the PAUSED card up and retried four more times - and because
 * `pointerlockchange` never fired, `main.js` never added `standby` to
 * `gameplayUiBlocks`. **The world simulated behind a full-screen card that
 * owned pointer events**: the player was being shot at, drowning and falling
 * behind a menu they could not dismiss.
 *
 * The fix is NOT to stop blocking gameplay. `standby` is what stops the world
 * running behind a menu on every platform, and weakening it would trade one
 * silent-simulation bug for another. The fix is that pointer lock was only ever
 * a PROXY for "the player has handed the canvas their input", and a thumb on an
 * on-screen stick is the same fact arriving through a different API. So
 * `Input.locked` - which is what all thirteen call sites read - becomes the
 * union of the two engagement sources, while the private `_locked` keeps
 * meaning pointer lock for the handlers that genuinely mean pointer lock.
 *
 * These drive the REAL `Input` against a DOM shell rather than re-implementing
 * the wiring: the listeners are the ones `_bind()` registered, and the events
 * are dispatched into them.
 */

/** A recording EventTarget. Capture flag is ignored; nothing here depends on it. */
function target(extra = {}) {
  const map = new Map();
  return {
    ...extra,
    addEventListener(type, fn) {
      if (!map.has(type)) map.set(type, new Set());
      map.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      map.get(type)?.delete(fn);
    },
    /** @returns {number} how many listeners saw it */
    dispatch(type, ev = {}) {
      const set = map.get(type);
      if (!set) return 0;
      const e = { type, preventDefault() {}, stopPropagation() {}, ...ev };
      for (const fn of [...set]) fn(e);
      return set.size;
    },
    has(type) {
      return (map.get(type)?.size ?? 0) > 0;
    },
  };
}

/**
 * Build a real `Input` over a fake document.
 *
 * @param {{pointerLock?: boolean, fullscreen?: boolean}} opts
 *   `pointerLock: false` is the iOS Safari shape - the methods are simply
 *   absent, which is exactly why the failure was silent.
 */
function makeInput({ pointerLock = true, fullscreen = true } = {}) {
  const calls = { lock: 0, exit: 0, fullscreen: 0, keyboardLock: 0 };
  const canvas = target();
  if (pointerLock) canvas.requestPointerLock = () => { calls.lock++; };

  const documentElement = target();
  if (fullscreen) documentElement.requestFullscreen = () => { calls.fullscreen++; return Promise.resolve(); };

  const doc = target({
    documentElement,
    pointerLockElement: null,
    fullscreenElement: null,
  });
  if (pointerLock) doc.exitPointerLock = () => { calls.exit++; };

  const win = target();

  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
  };
  globalThis.window = win;
  globalThis.document = doc;

  const bus = new EventBus();
  const seen = [];
  bus.on('input:lockchange', (p) => seen.push({ type: 'lockchange', ...p }));
  bus.on('input:touchmode', (p) => seen.push({ type: 'touchmode', ...p }));

  const input = new Input(canvas, bus);

  const restore = () => {
    if (saved.window === undefined) delete globalThis.window;
    else globalThis.window = saved.window;
    if (saved.document === undefined) delete globalThis.document;
    else globalThis.document = saved.document;
  };

  return { input, bus, seen, calls, canvas, doc, win, restore };
}

/** Run `fn` with the shell installed, and always put the globals back. */
function withInput(opts, fn) {
  const ctx = makeInput(opts);
  try {
    return fn(ctx);
  } finally {
    ctx.restore();
  }
}

/* ------------------------------------------------------------ item 1 -- */

test('a canvas with no requestPointerLock still reaches an engaged state', () => {
  // The iOS Safari shape, whole: no `requestPointerLock`, no `exitPointerLock`,
  // and therefore no `pointerlockchange` ever. Before the fix this left
  // `locked` false for the life of the page, which is what let the world
  // simulate behind the PAUSED card.
  withInput({ pointerLock: false }, ({ input, seen }) => {
    assert.equal(input.touchMode, true, 'absent pointer lock did not select touch mode');
    input.requestLock();
    assert.equal(input.locked, true, 'requestLock() did not reach an engaged state');
    assert.deepEqual(
      seen.filter((e) => e.type === 'lockchange').map((e) => e.locked),
      [true],
      'main.js never heard the lockchange that clears the `standby` block'
    );
  });
});

test('a touch on a browser that DOES implement pointer lock still takes the touch path', () => {
  /* Android Chrome implements pointer lock, so detection-by-absence would leave
   * every Android player on the desktop path with no on-screen controls at all.
   * The first `pointerType: 'touch'` pointerdown is the second trigger. */
  withInput({}, ({ input, win, calls }) => {
    assert.equal(input.touchMode, false, 'touch mode latched before any touch');
    win.dispatch('pointerdown', { pointerType: 'touch' });
    assert.equal(input.touchMode, true, 'a touch pointerdown did not select touch mode');
    input.requestLock();
    assert.equal(input.locked, true);
    assert.equal(calls.lock, 0, 'touch mode still asked for a pointer lock');
  });
});

test('touch mode asks for neither fullscreen nor the keyboard lock', () => {
  /* Both are refused on iOS Safari, and a rejected fullscreen promise on the
   * boot tap is exactly the swallowed-rejection shape this phase removes. */
  withInput({ pointerLock: false }, ({ input, calls }) => {
    input.requestLock();
    assert.equal(calls.fullscreen, 0, 'touch mode requested fullscreen');
  });
});

test('standing down from a touch session puts the standby block back', () => {
  // Every panel calls `exitLock()` on open (see `menuFocusIn`). If it only
  // released a pointer lock, a touch player would keep playing behind the
  // inventory - the same defect, wearing the other hat.
  withInput({ pointerLock: false }, ({ input, seen }) => {
    input.requestLock();
    seen.length = 0;
    input.exitLock();
    assert.equal(input.locked, false, 'exitLock() left the touch session engaged');
    assert.deepEqual(
      seen.filter((e) => e.type === 'lockchange').map((e) => e.locked),
      [false]
    );
  });
});

test('the desktop pointer-lock path is not weakened', () => {
  /* The load-bearing regression gate. `standby` exists to stop the world
   * simulating behind a menu; on a mouse-and-keyboard session it must still be
   * pointer lock and nothing else that lifts it, and `requestLock` must still
   * go through the browser rather than declaring itself engaged. */
  withInput({}, ({ input, calls, doc, canvas, seen }) => {
    input.requestLock();
    assert.equal(calls.lock, 1, 'the desktop path stopped requesting a pointer lock');
    assert.equal(input.locked, false, 'the desktop path engaged without the browser agreeing');
    assert.equal(seen.length, 0, 'the desktop path emitted a lockchange the browser never confirmed');

    // Only the browser's own confirmation may engage a desktop session.
    doc.pointerLockElement = canvas;
    doc.dispatch('pointerlockchange');
    assert.equal(input.locked, true);
    assert.deepEqual(seen.map((e) => e.locked), [true]);

    doc.pointerLockElement = null;
    doc.dispatch('pointerlockchange');
    assert.equal(input.locked, false, 'losing the pointer lock left the session engaged');
  });
});

test('the desktop path still asks for fullscreen, so Ctrl+W stays claimed', () => {
  /* `navigator.keyboard.lock` is only granted in fullscreen, and it is the only
   * thing between a crouch-walking player and a closed window. The touch branch
   * must not have taken it away from the desktop one. */
  withInput({}, ({ input, calls }) => {
    input.requestLock();
    assert.equal(calls.fullscreen, 1, 'the desktop path stopped entering fullscreen');
  });
});

test('a mouse pointerdown hands a tablet session back to pointer lock', () => {
  // A tablet with a keyboard and trackpad attached mid-session. Leaving it in
  // touch mode would leave the on-screen sticks over a game being played with
  // a mouse.
  withInput({}, ({ input, win, calls }) => {
    win.dispatch('pointerdown', { pointerType: 'touch' });
    input.requestLock();
    assert.equal(input.locked, true);

    win.dispatch('pointerdown', { pointerType: 'mouse' });
    assert.equal(input.touchMode, false, 'a mouse pointerdown did not leave touch mode');
    assert.equal(input.locked, false, 'leaving touch mode left a phantom engagement');
    input.requestLock();
    assert.equal(calls.lock, 1, 'the restored desktop session did not request a pointer lock');
  });
});

/* ------------------------------------------------------------ item 2 -- */

test('touch look feeds the same accumulator consumeLook() drains', () => {
  /* A `look` source that is NOT `movementX/Y`, and deliberately NOT gated on
   * `_locked`: on touch there is no pointer lock to gate it with, and the
   * mousemove handler's gate is what would otherwise swallow every drag. */
  withInput({ pointerLock: false }, ({ input, bus }) => {
    const looks = [];
    bus.on('input:look', (p) => looks.push(p));
    input.requestLock();
    input.applyLook(30, -12);
    input.applyLook(10, 2);
    const { dx, dy } = input.consumeLook();
    assert.ok(dx > 0 && dy < 0, `look did not accumulate: ${dx}, ${dy}`);
    assert.deepEqual(input.consumeLook(), { dx: 0, dy: 0 }, 'consumeLook did not clear');
    // The wheel integrates raw deltas of its own; it needs them unscaled.
    assert.deepEqual(looks, [{ dx: 30, dy: -12 }, { dx: 10, dy: 2 }]);
  });
});

test('the virtual stick survives a keyboard _syncAxes pass', () => {
  /* `_syncAxes()` rewrites `state.forward` and `state.right` on EVERY key
   * event, so a stick that merely wrote them would be zeroed by the next
   * button press. The axis is a second source that is folded in, not a value
   * that is assigned. */
  withInput({ pointerLock: false }, ({ input, win }) => {
    input.requestLock();
    input.setMoveAxis(0.8, -0.5);
    assert.ok(Math.abs(input.state.forward - 0.8) < 1e-6);
    assert.ok(Math.abs(input.state.right + 0.5) < 1e-6);

    // Any key event at all re-runs `_syncAxes`.
    win.dispatch('keydown', { code: 'KeyE' });
    assert.ok(Math.abs(input.state.forward - 0.8) < 1e-6, 'a keypress erased the stick');
    win.dispatch('keyup', { code: 'KeyE' });
    assert.ok(Math.abs(input.state.forward - 0.8) < 1e-6, 'a key release erased the stick');

    input.setMoveAxis(0, 0);
    assert.equal(input.state.forward, 0);
  });
});

test('the stick and the keyboard add rather than fight', () => {
  withInput({ pointerLock: false }, ({ input, win }) => {
    input.requestLock();
    win.dispatch('keydown', { code: 'KeyW' });
    assert.equal(input.state.forward, 1);
    input.setMoveAxis(-1, 0);
    // Opposed sources cancel, exactly as W and S do.
    assert.equal(input.state.forward, 0);
  });
});

test('a held stick does not walk the player through a menu', () => {
  /* `setTextCapture` and `setEnabled(false)` clear the keyboard, and they have
   * to clear the touch axis for the same reason: a thumb resting on the stick
   * when the inventory opens would otherwise keep pushing. */
  for (const stand of [
    (i) => i.setTextCapture(true),
    (i) => i.setEnabled(false),
  ]) {
    withInput({ pointerLock: false }, ({ input }) => {
      input.requestLock();
      input.setMoveAxis(1, 1);
      stand(input);
      assert.equal(input.state.forward, 0, 'the stick kept pushing while input was stood down');
      assert.equal(input.state.right, 0);
    });
  }
});

test('the fire and aim buttons drive the flags the weapon actually reads', () => {
  withInput({ pointerLock: false }, ({ input }) => {
    input.requestLock();
    input.setPointerButton('fire', true);
    input.setPointerButton('aim', true);
    assert.equal(input.state.fire, true);
    assert.equal(input.state.aim, true);
    input.setPointerButton('fire', false);
    assert.equal(input.state.fire, false);
    // A stand-down clears them, like every other axis.
    input.setEnabled(false);
    assert.equal(input.state.aim, false);
  });
});

test('a synthesised keydown reaches pressed() under the REBOUND code', () => {
  /* The touch buttons dispatch real `KeyboardEvent`s rather than poking
   * `_keys`, because half the panels in the game bind their own capture-phase
   * `keydown` (they have to - `Input` stops reporting while they are open) and
   * would never see a private mutation. That also means a touch button is
   * rebindable for free, which this pins: the button must send the key the
   * player chose, and `pressed()` must still answer under the shipped code. */
  withInput({ pointerLock: false }, ({ input, win }) => {
    input.requestLock();
    input.setBinding('KeyE', 'KeyQ');
    win.dispatch('keydown', { code: input.codeFor('interact') });
    assert.equal(input.pressed('KeyE'), true, 'the rebound interact key did not register');
    assert.equal(input.state.interact, true);
  });
});

/* ------------------------------------------------ re-engaging a panel -- */

test('reengage() puts a touch player back in the world', () => {
  /* Six modules re-acquire the pointer after their panel closes, and every one
   * of them called `input.canvas.requestPointerLock()` DIRECTLY, bypassing
   * `Input` entirely. On a phone that method does not exist, so closing the
   * inventory left the player stood down with `standby` still held: the world
   * frozen, nothing on screen explaining it, and no way back in. Found in a
   * real touch session - none of the gates above could see it, because none of
   * them went through a panel. */
  withInput({ pointerLock: false }, ({ input, seen }) => {
    input.requestLock();
    input.exitLock();
    seen.length = 0;
    input.reengage();
    assert.equal(input.locked, true, 'reengage() left a touch player stood down');
    assert.deepEqual(seen.filter((e) => e.type === 'lockchange').map((e) => e.locked), [true]);
  });
});

test('reengage() leaves the desktop path exactly as it was', () => {
  withInput({}, ({ input, calls }) => {
    input.reengage();
    assert.equal(calls.lock, 1, 'the desktop path stopped asking the browser');
    assert.equal(input.locked, false, 'reengage() engaged without the browser agreeing');
  });
});

test('no panel asks the browser for a pointer lock behind Input\'s back', async () => {
  /* The gate for the defect above, and a source gate on purpose: five of the
   * six call sites live in modules that import a stylesheet and so cannot be
   * imported under Node at all. `HUD` is the one legitimate exception - it owns
   * the retry budget for Chrome's post-Escape cooldown and needs the raw call -
   * so it is required to carry the touch branch instead, or a phone gets the
   * four-attempt PAUSED loop this whole phase exists to remove. */
  const offenders = [];
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(p); continue; }
      if (!p.endsWith('.js')) continue;
      const rel = path.relative(root, p).replace(/\\/g, '/');
      if (rel === 'src/core/Input.js' || rel === 'src/ui/HUD.js') continue;
      if (strip(await readFile(p, 'utf8')).includes('requestPointerLock')) offenders.push(rel);
    }
  };
  await walk(path.join(root, 'src'));
  assert.deepEqual(offenders, [], `these bypass Input.reengage(): ${offenders.join(', ')}`);

  const hud = strip(await readFile(path.join(root, 'src/ui/HUD.js'), 'utf8'));
  const at = hud.indexOf('_requestLock(fresh');
  assert.ok(at > 0, 'HUD._requestLock is gone');
  const body = hud.slice(at, hud.indexOf('\n  }', at));
  assert.ok(
    body.includes('touchMode'),
    'HUD._requestLock has no touch branch, so a phone gets the four-attempt PAUSED retry loop'
  );
});
