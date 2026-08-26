import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BINDABLE } from '../../src/core/Input.js';
import {
  TOUCH_ACTIONS,
  STICK_ACTIONS,
  touchCode,
  sendTouchAction,
} from '../../src/ui/TouchActions.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The on-screen control set.
 *
 * ── What these gates are for ──────────────────────────────────────────────
 *
 * A touch button is a promise: it shows a player a verb and says they can do
 * it. The failure this project keeps producing is content that is BUILT and not
 * REACHABLE - a world with an unreachable district, a quest with an unreachable
 * step - so the gate that matters here is not "does the button exist" but
 * "does the key it sends do anything, and is every verb the game has covered".
 *
 * Both directions are checked:
 *
 *   - no button sends a key nothing in `src/` handles (a lying button), and
 *   - no `BINDABLE` action is left with no way to perform it on a phone (a
 *     verb that is simply missing).
 *
 * The dispatch itself is driven for real: `sendTouchAction` is the function
 * `TouchControls` calls, and it is called here against a stub `window` with the
 * events it actually builds.
 */

/* ---------------------------------------------------------- the table -- */

test('every row has a shape the layer can render and dispatch', () => {
  const seen = new Set();
  for (const r of TOUCH_ACTIONS) {
    assert.ok(r.id, 'a row has no id');
    assert.ok(!seen.has(r.id), `duplicate row id '${r.id}'`);
    seen.add(r.id);
    assert.ok(r.label, `${r.id}: no label`);
    assert.ok(['hold', 'tap', 'toggle'].includes(r.kind), `${r.id}: bad kind '${r.kind}'`);
    assert.ok(['primary', 'left', 'tray'].includes(r.where), `${r.id}: bad placement '${r.where}'`);
    // Exactly one way of reaching the game.
    const routes = [r.action, r.code, r.button, r.special].filter(Boolean);
    assert.equal(routes.length, 1, `${r.id}: ${routes.length} routes into the game, want exactly 1`);
  }
});

test('an action row names a real BINDABLE action', () => {
  // Rebindable verbs go through the action, never through a literal, so a
  // rebind moves the touch button with it. A typo here would be a button that
  // resolves to nothing at all.
  const actions = new Set(BINDABLE.map((b) => b.action));
  for (const r of TOUCH_ACTIONS) {
    if (!r.action) continue;
    assert.ok(actions.has(r.action), `${r.id}: '${r.action}' is not a BINDABLE action`);
  }
});

/* ------------------------------------------------------- no dead keys -- */

/** Comments are documentation, not handlers. */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

async function srcText() {
  const parts = [];
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      // The touch layer itself is excluded: a button proving its own key works
      // by naming it is the circular gate this project has been bitten by.
      else if (p.endsWith('.js') && !p.endsWith('TouchActions.js') && !p.endsWith('TouchControls.js')) {
        parts.push(strip(await readFile(p, 'utf8')));
      }
    }
  };
  await walk(path.join(root, 'src'));
  return parts.join('\n');
}

test('no touch button sends a key nothing in the game answers', async () => {
  const src = await srcText();
  for (const r of TOUCH_ACTIONS) {
    if (!r.code) continue;
    assert.ok(
      src.includes(`'${r.code}'`),
      `${r.id}: sends '${r.code}', which no file outside the touch layer mentions`
    );
  }
});

/* ------------------------------------------------------ full coverage -- */

test('every rebindable verb is reachable without a keyboard', () => {
  /* The brief's acceptance is "movement, interaction, combat, mount usage, menu
   * navigation, marketplace, quest interaction and chat all work with no
   * external peripheral". `BINDABLE` is the canonical list of the verbs the
   * game binds keys to, so it is the list a phone has to cover - and it is the
   * list that GROWS, which is the point: a verb added later with no touch
   * button fails here rather than shipping unreachable. */
  const covered = new Set([
    ...STICK_ACTIONS,
    ...TOUCH_ACTIONS.map((r) => r.action).filter(Boolean),
  ]);
  const missing = BINDABLE.map((b) => b.action).filter((a) => !covered.has(a));
  assert.deepEqual(missing, [], `verbs with no touch control: ${missing.join(', ')}`);
});

test('firing, aiming and standing down have controls of their own', () => {
  // Not in BINDABLE - they are mouse buttons and a key the browser owns - so
  // the coverage gate above cannot see them, and all three are unusable on a
  // phone without a button.
  const ids = new Set(TOUCH_ACTIONS.map((r) => r.id));
  for (const id of ['fire', 'aim', 'pause']) assert.ok(ids.has(id), `no '${id}' control`);
  assert.equal(TOUCH_ACTIONS.find((r) => r.id === 'fire').button, 'fire');
  assert.equal(TOUCH_ACTIONS.find((r) => r.id === 'aim').button, 'aim');
});

test('the controls a player needs in the moment are not buried in the tray', () => {
  /* A tray is one tap away, which is fine for "open the marketplace" and fatal
   * for "jump". This pins the split rather than leaving it to whoever edits the
   * table next. */
  const where = Object.fromEntries(TOUCH_ACTIONS.map((r) => [r.id, r.where]));
  for (const id of ['fire', 'aim', 'jump', 'crouch', 'interact', 'reload', 'sprint', 'pause']) {
    assert.ok(where[id] !== 'tray', `'${id}' is in the tray, where it cannot be reached in time`);
  }
});

/* ---------------------------------------------------------- dispatch -- */

/** A window that records what was dispatched into it. */
function stubWindow() {
  const events = [];
  return { events, dispatchEvent: (e) => { events.push(e); return true; } };
}

/** Node has no `KeyboardEvent`; install the minimum the layer constructs. */
function withKeyboardEvent(fn) {
  const saved = globalThis.KeyboardEvent;
  globalThis.KeyboardEvent = class {
    constructor(type, init = {}) {
      this.type = type;
      Object.assign(this, init);
    }
  };
  try {
    return fn();
  } finally {
    if (saved === undefined) delete globalThis.KeyboardEvent;
    else globalThis.KeyboardEvent = saved;
  }
}

/** Just enough `Input` for the dispatcher. */
function stubInput(binds = {}) {
  return {
    buttons: {},
    stoodDown: 0,
    codeFor: (action) => {
      const d = BINDABLE.find((b) => b.action === action);
      return d ? (binds[d.code] ?? d.code) : null;
    },
    setPointerButton(which, down) { this.buttons[which] = !!down; },
    exitLock() { this.stoodDown++; },
  };
}

test('a key row dispatches a real keydown on window, with the rebound code', () => {
  /* The touch layer sends `KeyboardEvent`s rather than poking `Input._keys`,
   * and that is not a shortcut: `Input`, `HelpMenu`, `MountWheel`, `MazeMap`,
   * `QuestBoard`, `Inventory`, `Marketplace` and `Unstuck` all bind their OWN
   * window `keydown` (they have to - `Input` stops reporting while they are
   * open), so a private mutation would open the mount wheel and then be unable
   * to close it. One event feeds every one of them, through the same code a
   * physical key does. */
  withKeyboardEvent(() => {
    const view = stubWindow();
    const input = stubInput({ KeyE: 'KeyQ' });
    const row = TOUCH_ACTIONS.find((r) => r.id === 'interact');
    sendTouchAction(row, true, { input, view });
    assert.equal(view.events[0].type, 'keydown');
    assert.equal(view.events[0].code, 'KeyQ', 'the button ignored the player rebind');
    assert.equal(view.events[0].bubbles, true, 'a non-bubbling event reaches no capture listener chain');
  });
});

test('a hold sends down and up; a tap sends both on the press', () => {
  withKeyboardEvent(() => {
    const input = stubInput();
    const hold = TOUCH_ACTIONS.find((r) => r.kind === 'hold' && r.action);
    const view = stubWindow();
    sendTouchAction(hold, true, { input, view });
    sendTouchAction(hold, false, { input, view });
    assert.deepEqual(view.events.map((e) => e.type), ['keydown', 'keyup']);

    const tap = TOUCH_ACTIONS.find((r) => r.kind === 'tap');
    const v2 = stubWindow();
    sendTouchAction(tap, true, { input, view: v2 });
    assert.deepEqual(
      v2.events.map((e) => e.type),
      ['keydown', 'keyup'],
      'a tap that never released would leave the key stuck down for the session'
    );
    // ...and the release must be a no-op, or the key goes down twice.
    sendTouchAction(tap, false, { input, view: v2 });
    assert.equal(v2.events.length, 2);
  });
});

test('fire and aim go to the flags, not to the keyboard', () => {
  withKeyboardEvent(() => {
    const input = stubInput();
    const view = stubWindow();
    sendTouchAction(TOUCH_ACTIONS.find((r) => r.id === 'fire'), true, { input, view });
    assert.equal(input.buttons.fire, true);
    assert.equal(view.events.length, 0, 'firing went through a synthetic key');
    sendTouchAction(TOUCH_ACTIONS.find((r) => r.id === 'fire'), false, { input, view });
    assert.equal(input.buttons.fire, false);
  });
});

test('the pause control stands the player down, which is what raises the block', () => {
  /* There is no Escape key on a phone. This button is the ONLY way a touch
   * player can reach the hub, and `exitLock()` is what puts `standby` back -
   * i.e. what stops the world simulating behind the card. A button that merely
   * showed the card would recreate the exact defect this phase closes. */
  withKeyboardEvent(() => {
    const input = stubInput();
    const view = stubWindow();
    sendTouchAction(TOUCH_ACTIONS.find((r) => r.id === 'pause'), true, { input, view });
    assert.equal(input.stoodDown, 1);
    assert.equal(view.events.length, 0);
  });
});

test('touchCode answers with the key a row will actually send', () => {
  const input = stubInput({ KeyF: 'KeyG' });
  assert.equal(touchCode(TOUCH_ACTIONS.find((r) => r.id === 'dismount'), input), 'KeyG');
  assert.equal(touchCode(TOUCH_ACTIONS.find((r) => r.id === 'fire'), input), null);
});

/* ------------------------------------------------------------ source -- */

test('TouchControls drives the game through TouchActions and Input, nothing else', async () => {
  /* The rule the whole layer is built on: a touch control reaches the game
   * through the same path a key or a mouse button does. A button that called
   * `mounts.summon()` or `hud.showPauseOverlay()` directly would work once and
   * then diverge from what the keyboard does the first time either changes. */
  const src = strip(await readFile(path.join(root, 'src/ui/TouchControls.js'), 'utf8'));
  assert.ok(src.includes("from './TouchActions.js'"), 'TouchControls does not use the shared table');
  for (const forbidden of ['mounts.', 'hud.', 'player.', 'worldManager.']) {
    assert.ok(!src.includes(forbidden), `TouchControls reaches into '${forbidden}' directly`);
  }
  // It must show and hide itself off the mode change, or it is a permanent
  // overlay on every desktop session.
  assert.ok(src.includes("'input:touchmode'"), 'TouchControls never learns the session is touch');
});

/* ------------------------------------------------------- discoverability -- */

/* The owner's report: "the navigation controls are hard to bring up". The
 * stick floated to wherever the thumb landed and was invisible until then, so
 * a phone showed eight buttons and no way to walk. It now RESTS somewhere a
 * player can see, labelled, and a one-line coach says which thumb does what.
 * Neither is visible in a Node test, so both are pinned at the source. */

test('the stick has a visible resting place and goes home on release', async () => {
  const css = (await readFile(path.join(root, 'src/ui/touch.css'), 'utf8')).replace(/\r\n/g, '\n');
  const rest = css.slice(css.indexOf('.touch-stick {'), css.indexOf('}', css.indexOf('.touch-stick {')));
  const opacity = rest.match(/opacity:\s*([\d.]+)/);
  assert.ok(opacity && Number(opacity[1]) > 0,
    'the resting stick is invisible again - a phone shows buttons and no way to move');
  assert.match(rest, /\bleft:\s*calc\(/, 'the resting stick has no home position');
  assert.match(rest, /\btop:\s*calc\(100%/, 'the resting stick is not anchored off the bottom of the layer');
  assert.match(css, /\.touch-stick-label/, 'the resting stick is no longer labelled');

  const src = strip(await readFile(path.join(root, 'src/ui/TouchControls.js'), 'utf8'));
  assert.match(src, /this\.stick\.style\.left = ''/,
    '_hideStick no longer clears the inline position, so the ring stays where the last thumb left it instead of going home');
  assert.match(src, /'touch-stick-label', 'MOVE'/, 'the ring lost its MOVE label');
});

test('a touch session is told which thumb does what, once', async () => {
  const src = strip(await readFile(path.join(root, 'src/ui/TouchControls.js'), 'utf8'));
  assert.match(src, /'touch-coach'/, 'TouchControls no longer builds the coach line');
  assert.match(src, /_setCoach\(true\)/, 'the coach line is never shown');
  assert.match(src, /_setCoach\(false\)/, 'the coach line is never taken down');
  assert.match(src, /this\._coached = true/, 'the coach line comes back on every re-engagement');
  const css = (await readFile(path.join(root, 'src/ui/touch.css'), 'utf8')).replace(/\r\n/g, '\n');
  assert.match(css, /\.touch-coach\.show\s*\{[^}]*opacity:\s*1/, 'the coach line has no shown state');
  assert.match(css, /\.touch-coach\s*\{[^}]*pointer-events:\s*none/, 'the coach line takes taps meant for the game');
});

test('a coarse primary pointer is a touch session from the first frame', async () => {
  /* Before this, Android latched touch mode on the first touch pointerdown -
   * which is the tap that enters the world - so everything on the title card
   * and the pause card was written for a mouse right up to that tap. */
  const src = strip(await readFile(path.join(root, 'src/core/Input.js'), 'utf8'));
  assert.match(src, /this\._touchMode = !Input\.pointerLockSupported\(\) \|\| Input\.coarsePointer\(\)/,
    'Input no longer latches touch mode off the coarse-pointer media query at construction');
  const hud = strip(await readFile(path.join(root, 'src/ui/HUD.js'), 'utf8'));
  assert.match(hud, /PAUSE_SUB_TOUCH/, 'the pause card still tells a phone to press Escape');
  assert.match(hud, /p\.addEventListener\('pointerdown'/, 'the pause card resumes on mousedown, which a tap only produces as a compatibility event');
  const main = strip(await readFile(path.join(root, 'src/main.js'), 'utf8'));
  assert.match(main, /const VERB = input\.touchMode \? 'TAP' : 'CLICK'/, 'the title card says CLICK to a phone');
});
