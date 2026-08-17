import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HUD } from '../../src/ui/HUD.js';
import { EventBus } from '../../src/core/EventBus.js';
import { PauseMenuModel, PAUSE_MENU_IDS } from '../../src/ui/PauseMenu.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The pause hub's return path, driven through the real HUD methods.
 *
 * A full `HUD` cannot be constructed headlessly, but every method under test
 * is on the prototype and touches only `_overlays`, `_hubReturn` and two
 * stubbed collaborators. That matters more than usual here: the bug class this
 * feature can produce is "a panel closes and the hub never comes back", which
 * no DOM or geometry test can see.
 *
 * Assertions are made AFTER a macrotask, because `_deferHubCheck` settles on a
 * microtask and `setTimeout` drains the whole microtask queue first.
 *
 * What these tests CANNOT see: keydown listener ordering. They drive the bus
 * directly, so the Help case below proves the `_helpOpen` flag is maintained -
 * not that HUD's Escape handlers ever get to read it while it is still true.
 * That depends on `HelpMenu` calling `stopImmediatePropagation` (Task 3 Step 6)
 * and on registration order in `main.js`, neither of which exists headlessly.
 * Task 7 Step 6 is the check that covers it.
 */
const settle = () => new Promise((r) => setTimeout(r, 0));

/**
 * A HUD with only the fields the overlay path touches.
 *
 * `pause.classList.contains('show')` is answered from `h.shown`, so the stub
 * agrees with itself: `_overlayOpen`'s hub-launch arm reads the card's real
 * state through the same channel the browser would.
 */
function stubHud() {
  const h = Object.create(HUD.prototype);
  h.bus = new EventBus();
  h._offs = [];
  h.el = null; // `_syncOverlaid` optional-chains it
  h._overlays = new Set();
  h._hubReturn = false;
  h._hubCheckPending = false;
  h._helpOpen = false;
  h._chatOpen = false;
  h._relock = 0;
  h._pendingFocus = -1;
  h.shown = null;
  h.relocks = 0;
  h.pause = { classList: { contains: (c) => c === 'show' && h.shown === true } };
  h.pauseMenu = { model: { focus: 0 }, focused: -1, focusIndex(i) { this.focused = i; return true; } };
  h.showPauseOverlay = (s) => { h.shown = !!s; };
  h._schedRelock = () => { h.relocks++; };
  h._wireOverlayEvents();
  return h;
}

/** Every panel the Set tracks, with the event pair it actually emits. */
const PANELS = [
  { id: 'character',   open: ['character:open', {}],   close: ['character:close', {}] },
  { id: 'mount-menu',  open: ['mount:menu:open', { mountId: 'horse' }], close: ['mount:menu:close', {}] },
  { id: 'inventory',   open: ['inventory:open', {}],   close: ['inventory:close', {}] },
  { id: 'quest-board', open: ['hud:block', { id: 'quest-board', block: true }], close: ['hud:block', { id: 'quest-board', block: false }] },
  { id: 'maze-map',    open: ['ui:modal', { id: 'maze-map', open: true }],      close: ['ui:modal', { id: 'maze-map', open: false }] },
  { id: 'race',        open: ['race:menu', { open: true }],     close: ['race:menu', { open: false }] },
  { id: 'minigame',    open: ['minigame:menu', { open: true }], close: ['minigame:menu', { open: false }] },
  { id: 'audio',       open: ['audio:menu', { open: true }],    close: ['audio:menu', { open: false }] },
  { id: 'keybinds',    open: ['keybinds:open', {}],   close: ['keybinds:close', {}] },
  { id: 'bug-report',  open: ['bug-report:open', {}], close: ['bug-report:close', {}] },
  // No hub row - B near a vendor is the only way in - but tracked all the same:
  // it owns the cursor, which is the whole contract. See the `_overlays` doc.
  { id: 'market',      open: ['market:open', {}],     close: ['market:close', {}] },
];

test('every hub-reachable panel joins the Set and hands the player back to the hub', async () => {
  // The test that catches a panel left outside the tracker - MazeMap and
  // MinigameUI both were, and closing either would strand the hub.
  for (const p of PANELS) {
    const h = stubHud();
    h.openFromHub(() => h.bus.emit(...p.open));
    await settle();
    assert.equal(h.shown, false, `${p.id}: hub still shown after opening`);
    assert.deepEqual([...h._overlays], [p.id], `${p.id}: not tracked`);
    assert.equal(h._hubReturn, true, `${p.id}: hub return not armed`);

    h.bus.emit(...p.close);
    await settle();
    assert.equal(h.shown, true, `${p.id}: hub did not come back`);
    assert.equal(h._overlays.size, 0, `${p.id}: id left in the Set`);
    assert.equal(h._hubReturn, false, `${p.id}: hub return not cleared`);
    assert.equal(h.relocks, 0, `${p.id}: relocked instead of returning to the hub`);
  }
  // The three old readers of the integer now read this getter.
  const fresh = stubHud();
  assert.equal(fresh.overlayCount, 0, 'overlayCount does not report an empty tracker as 0');
  fresh.bus.emit('audio:menu', { open: true });
  assert.equal(fresh.overlayCount, 1, 'overlayCount does not follow the Set');
});

test('a panel closed without the hub having opened it relocks, as today', async () => {
  const h = stubHud();
  h.bus.emit('character:open', {});
  await settle();
  h.bus.emit('character:close', {});
  await settle();
  assert.equal(h.shown, false);
  assert.equal(h.relocks, 1);
});

test('a hub item whose panel refuses to open puts the hub straight back', async () => {
  // QuestBoard's `_openGuard` and MazeMap outside a maze both do this.
  const h = stubHud();
  h.openFromHub(() => {});
  assert.equal(h.shown, false, 'hidden synchronously, before run()');
  await settle();
  assert.equal(h.shown, true);
  assert.equal(h._hubReturn, false);
  assert.equal(h.relocks, 0);
});

test('Help opens over the hub: no Set entry, hub stays visible', async () => {
  const h = stubHud();
  h.shown = true;
  h.openFromHub(() => h.bus.emit('help:open', {}), { overlay: false });
  await settle();
  assert.equal(h.shown, true, 'the hub was hidden for Help');
  assert.equal(h._overlays.size, 0, 'Help entered the Set - it keeps pointer lock and must not');
  assert.equal(h._helpOpen, true);
  assert.equal(h._hubReturn, false, 'Help armed a hub return it will never trigger');
  h.bus.emit('help:close', {});
  await settle();
  assert.equal(h._helpOpen, false);
  assert.equal(h.shown, true);
});

test('a same-tick close -> open hand-off is not read as "everything closed"', async () => {
  /* `RaceUI._showBoard` calls `closePanel()` then emits its own open in one
   * synchronous sequence (`RaceUI.js:745-749`, reached from `race:finished` at
   * `:254`); `MinigameUI` has the same shape at `:81-83`. Undeferred, that gap
   * drops the hub on top of the result board. */
  const h = stubHud();
  h.openFromHub(() => h.bus.emit('race:menu', { open: true }));
  await settle();
  assert.equal(h.shown, false);
  h.bus.emit('race:menu', { open: false });
  h.bus.emit('race:menu', { open: true });
  await settle();
  assert.equal(h.shown, false, 'the hub jumped in between two sheets of one panel');
  assert.equal(h._hubReturn, true, 'the hub return was spent on a hand-off');
  assert.equal(h.relocks, 0);
});

test('a duplicate open cannot latch the tracker above empty', async () => {
  /* `MinigameUI._showBoard` has no re-entry guard, so a repeated
   * `minigame:finished` emits `{open:true}` twice. An integer counter reached
   * 2, the single close took it to 1, and `showPauseOverlay` - which refuses
   * while the count is above zero - killed the hub for the session. */
  const h = stubHud();
  h.bus.emit('minigame:menu', { open: true });
  h.bus.emit('minigame:menu', { open: true });
  assert.equal(h._overlays.size, 1);
  h.bus.emit('minigame:menu', { open: false });
  await settle();
  assert.equal(h._overlays.size, 0);
  assert.equal(h.shown, false);
  assert.equal(h.relocks, 1);
});

test('a letter key that opens a panel over the hub is treated as picking the row', async () => {
  /* J, I, B and M keep their own listeners, so they never reach `openFromHub`.
   * Before this, the panel drew itself behind the card and the hub swallowed
   * its Escape. `market` is the case with no hub row at all. */
  for (const p of PANELS) {
    const h = stubHud();
    h.shown = true;                 // the hub is up
    h.pauseMenu.model.focus = 3;    // ...on the fourth row
    h.bus.emit(...p.open);
    assert.equal(h.shown, false, `${p.id}: the panel opened behind the hub`);
    assert.equal(h._hubReturn, true, `${p.id}: closing it would resume instead of returning`);
    await settle();
    assert.equal(h.shown, false, `${p.id}: the hub came back over the panel`);

    h.bus.emit(...p.close);
    await settle();
    assert.equal(h.shown, true, `${p.id}: the hub did not come back`);
    assert.equal(h.relocks, 0, `${p.id}: relocked instead of returning to the hub`);
    assert.equal(h.pauseMenu.focused, 3, `${p.id}: the highlight was not restored`);
  }
});

test('a second sheet opening over a hub-launched panel does not re-arm', () => {
  const h = stubHud();
  h.shown = true;
  h.openFromHub(() => h.bus.emit('race:menu', { open: true }));
  assert.equal(h.shown, false);
  h._pendingFocus = 7; // must survive: the arm ran once, at the hub
  h.bus.emit('minigame:menu', { open: true });
  assert.equal(h._pendingFocus, 7, 're-armed over an already hidden card');
});

test('starting a race or a contest spends the hub return instead of coming back', async () => {
  /* The panel that started it closes, which empties the Set. Without
   * `clearHubReturn` the pause card lands on top of the starting lights. */
  for (const started of ['race:countdown', 'race:started', 'minigame:countdown', 'minigame:started']) {
    const h = stubHud();
    h.shown = true;
    h.bus.emit('race:menu', { open: true });
    assert.equal(h._hubReturn, true);
    h.bus.emit(started, {});
    assert.equal(h._hubReturn, false, `${started}: hub return survived the start`);
    h.bus.emit('race:menu', { open: false });
    await settle();
    assert.equal(h.shown, false, `${started}: the hub landed on the starting lights`);
    assert.equal(h.relocks, 1, `${started}: play never resumed`);
  }
});

test('the real START order clears the hub return before the microtask reads it', async () => {
  /* The bug the `:started` subscription alone would not catch. `RaceUI`'s START
   * button runs `closePanel()` then `race.start()` in one synchronous turn, and
   * `start()` emits `race:countdown` (`RaceManager.js:506`) - `race:started`
   * only arrives when the lights go out, long after `_deferHubCheck` has
   * already decided. */
  const h = stubHud();
  h.shown = true;
  h.openFromHub(() => h.bus.emit('race:menu', { open: true }));
  await settle();
  h.bus.emit('race:menu', { open: false }); // closePanel()
  h.bus.emit('race:countdown', { count: 3 }); // race.start(), same turn
  await settle();
  assert.equal(h.shown, false, 'the hub came back over the starting lights');
  assert.equal(h.relocks, 1, 'play never resumed');
  h.bus.emit('race:started', {}); // seconds later; must change nothing
  await settle();
  assert.equal(h.shown, false);
});

/* ------------------------------------------------------------ keyboard -- */

/**
 * The two `window` keydown handlers, driven as prototype methods.
 *
 * Bound copies are installed in `_buildPause`, which needs a DOM; the logic
 * itself is on the prototype precisely so this test can reach it. What it still
 * cannot see is listener ORDER - see the note at the top of this file.
 */
function keyHud(over = {}) {
  const h = Object.create(HUD.prototype);
  h._overlays = new Set(over.overlays ?? []);
  h._helpOpen = !!over.helpOpen;
  h._chatOpen = !!over.chatOpen;
  h.shown = over.shown !== false;
  h.pause = { classList: { contains: (c) => c === 'show' && h.shown === true } };
  h.input = { locked: !!over.locked, textCaptured: !!over.textCaptured, exitLock: () => { h.exits++; } };
  h.exits = 0;
  h.moves = 0;
  h.activations = 0;
  h.locks = 0;
  h.pauseMenu = { move: () => { h.moves++; }, activate: () => { h.activations++; } };
  h._requestLock = () => { h.locks++; };
  return h;
}

const key = (code, extra = {}) => ({
  code, repeat: false, prevented: 0, stopped: 0,
  preventDefault() { this.prevented++; }, stopPropagation() { this.stopped++; }, ...extra,
});

test('the hub keyboard stands down while a panel owns the screen', () => {
  for (const code of ['Enter', 'Space', 'ArrowDown']) {
    const h = keyHud({ overlays: ['inventory'] });
    HUD.prototype._onPauseKey.call(h, key(code));
    assert.equal(h.activations, 0, `${code}: activated a hub row behind a panel`);
    assert.equal(h.locks, 0, `${code}: resumed the game from behind a panel`);
    assert.equal(h.moves, 0, `${code}: moved the hub highlight behind a panel`);
  }
});

test('the hub keyboard stands down for Help, chat and captured text', () => {
  for (const over of [{ helpOpen: true }, { chatOpen: true }, { textCaptured: true }, { shown: false }]) {
    const h = keyHud(over);
    HUD.prototype._onPauseKey.call(h, key('Enter'));
    HUD.prototype._onPauseKey.call(h, key('Escape'));
    const why = Object.keys(over)[0];
    assert.equal(h.activations, 0, `${why}: Enter activated a row`);
    assert.equal(h.locks, 0, `${why}: Escape resumed the game`);
  }
});

test('the hub keyboard acts when nothing else owns it', () => {
  const h = keyHud();
  HUD.prototype._onPauseKey.call(h, key('ArrowDown'));
  HUD.prototype._onPauseKey.call(h, key('Enter'));
  HUD.prototype._onPauseKey.call(h, key('Escape'));
  assert.equal(h.moves, 1);
  assert.equal(h.activations, 1);
  assert.equal(h.locks, 1);
});

test('Escape under pointer lock exits it, but never on a key repeat', () => {
  /* Holding Escape is how browsers break keyboard lock; acting on each repeat
   * would exit and re-request in a loop. */
  const held = keyHud({ locked: true, shown: false });
  HUD.prototype._onLockEsc.call(held, key('Escape', { repeat: true }));
  assert.equal(held.exits, 0, 'a held Escape exited the lock');

  const tap = keyHud({ locked: true, shown: false });
  HUD.prototype._onLockEsc.call(tap, key('Escape'));
  assert.equal(tap.exits, 1, 'Escape under lock did not raise the hub');

  const busy = keyHud({ locked: true, shown: false, overlays: ['quest-board'] });
  HUD.prototype._onLockEsc.call(busy, key('Escape'));
  assert.equal(busy.exits, 0, 'Escape was taken from the panel that owns it');

  const unlocked = keyHud({ locked: false, shown: false });
  HUD.prototype._onLockEsc.call(unlocked, key('Escape'));
  assert.equal(unlocked.exits, 0, 'exited a lock that was not held');
});

/* -------------------------------------------------- showPauseOverlay -- */

/** The real `showPauseOverlay`, over a fake card and a counting menu. */
function cardHud(over = {}) {
  const h = Object.create(HUD.prototype);
  const classes = new Set(over.shown ? ['show'] : []);
  h._overlays = new Set(over.overlays ?? []);
  h._chatOpen = !!over.chatOpen;
  h._relockCheck = 9;
  h.refreshes = 0;
  h.firsts = 0;
  h.pause = {
    classList: {
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    },
  };
  h.isShown = () => classes.has('show');
  h.pauseMenu = { refresh: () => { h.refreshes++; }, focusFirst: () => { h.firsts++; } };
  return h;
}

test('showPauseOverlay refuses to raise the card over a panel or chat', () => {
  for (const over of [{ overlays: ['inventory'] }, { chatOpen: true }]) {
    const h = cardHud(over);
    h.showPauseOverlay(true);
    assert.equal(h.isShown(), false, `${Object.keys(over)[0]}: the hub covered a panel`);
    assert.equal(h.refreshes, 0);
  }
});

test('focusFirst runs only on the hidden->shown transition', () => {
  // `_lockRefused` and the `_relockCheck` fallback call this every 0.4 s while
  // a re-lock is retried; resetting the highlight under the player's hand
  // each time would make the list unusable on a slow relock.
  const h = cardHud();
  h.showPauseOverlay(true);
  assert.equal(h.isShown(), true);
  assert.deepEqual([h.refreshes, h.firsts], [1, 1]);
  h.showPauseOverlay(true);
  h.showPauseOverlay(true);
  assert.deepEqual([h.refreshes, h.firsts], [3, 1], 'focusFirst re-ran while already shown');
  h.showPauseOverlay(false);
  h.showPauseOverlay(true);
  assert.deepEqual([h.refreshes, h.firsts], [4, 2], 'focusFirst did not run on a fresh open');
});

/* ---------------------------------------------------------------- model -- */

function model(over = {}) {
  const m = new PauseMenuModel();
  m.setItems([
    { title: 'Play', items: [
      { id: 'resume', label: 'Resume', run() {} },
      { id: 'mount', label: 'Mount', enabled: () => over.mountReason ?? true, run() {} },
      { id: 'map', label: 'Map', visible: () => !!over.mapVisible, run() {} },
    ] },
    { title: 'System', items: [
      { id: 'fullscreen', label: () => `Fullscreen: ${over.fs ? 'On' : 'Off'}`, keepOpen: true, run() {} },
      { id: 'quit', label: 'Quit to menu', run() {} },
    ] },
  ]);
  return m;
}

test('an `enabled` returning a string disables the item with that reason', () => {
  const m = model({ mountReason: 'Mount up first (M)' });
  assert.equal(m.isEnabled(m.visibleItems().find((i) => i.id === 'mount')), 'Mount up first (M)');
  assert.equal(m.isEnabled(m.visibleItems().find((i) => i.id === 'resume')), true,
    'an item with no `enabled` must be enabled');
});

test('visible:false items are skipped entirely', () => {
  assert.deepEqual(model().visibleItems().map((i) => i.id), ['resume', 'mount', 'fullscreen', 'quit']);
  assert.deepEqual(model({ mapVisible: true }).visibleItems().map((i) => i.id),
    ['resume', 'mount', 'map', 'fullscreen', 'quit']);
});

test('move() wraps and skips disabled and hidden items', () => {
  const m = model({ mountReason: 'Mount up first (M)' });
  m.focusFirst();
  assert.equal(m.focusedItem().id, 'resume');
  m.move(1);
  assert.equal(m.focusedItem().id, 'fullscreen', 'move() walked onto the disabled Mount item');
  m.move(1);
  assert.equal(m.focusedItem().id, 'quit');
  m.move(1);
  assert.equal(m.focusedItem().id, 'resume', 'move() did not wrap');
  m.move(-1);
  assert.equal(m.focusedItem().id, 'quit', 'move(-1) did not wrap backwards');
});

test('focusFirst lands on the first ENABLED item, not the first item', () => {
  const m = new PauseMenuModel();
  m.setItems([{ items: [
    { id: 'a', label: 'A', enabled: () => 'nope', run() {} },
    { id: 'b', label: 'B', run() {} },
  ] }]);
  m.focusFirst();
  assert.equal(m.focusedItem().id, 'b');
});

test('activate() returns the focused enabled item and never runs it', () => {
  // The host runs it, exactly once, because `openFromHub` has to hide the hub
  // BEFORE the panel opens. See the deviation note in the plan header.
  let ran = 0;
  const m = new PauseMenuModel();
  m.setItems([{ items: [
    { id: 'save', label: 'Save', keepOpen: true, run: () => { ran++; } },
    { id: 'off', label: 'Off', enabled: () => 'no', run: () => { ran++; } },
  ] }]);
  m.focusFirst();
  const picked = m.activate();
  assert.equal(picked?.id, 'save');
  assert.equal(picked.keepOpen, true);
  assert.equal(ran, 0, 'the model ran the item - the host would then run it a second time');
  m.focus = 1;
  assert.equal(m.activate(), null, 'a disabled item was activated');
});

test('label functions are re-evaluated, not cached', () => {
  const flags = { fs: false };
  const m = new PauseMenuModel();
  m.setItems([{ items: [{ id: 'fullscreen', label: () => `Fullscreen: ${flags.fs ? 'On' : 'Off'}`, run() {} }] }]);
  const item = m.visibleItems()[0];
  assert.equal(m.labelOf(item), 'Fullscreen: Off');
  flags.fs = true;
  assert.equal(m.labelOf(item), 'Fullscreen: On');
});

test('PAUSE_MENU_IDS is the whole spec §3 list, with no duplicates', () => {
  assert.equal(new Set(PAUSE_MENU_IDS).size, PAUSE_MENU_IDS.length);
  for (const id of ['resume', 'character', 'mount', 'inventory', 'quests', 'map', 'race',
    'minigame-quit', 'help', 'audio', 'keybinds', 'fullscreen', 'diagnostics', 'save',
    'load', 'bug-report', 'quit']) {
    assert.ok(PAUSE_MENU_IDS.includes(id), id);
  }
});

/* ------------------------------------------------------------ source -- */

/** Comments are documentation, not UI. Strip them before matching. */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

async function srcFiles() {
  const out = [];
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (p.endsWith('.js')) out.push(p);
    }
  };
  await walk(path.join(root, 'src'));
  return out;
}

test('main.js wires every id PAUSE_MENU_IDS promises', async () => {
  const src = strip(await readFile(path.join(root, 'src/main.js'), 'utf8'));
  const at = src.indexOf('hud.setPauseMenuItems(');
  assert.ok(at > 0, 'main.js never calls setPauseMenuItems');
  const list = src.slice(at, src.indexOf('\n]);', at));
  for (const id of PAUSE_MENU_IDS) {
    assert.ok(list.includes(`id: '${id}'`), `the hub has no '${id}' item`);
  }
});

test('no F2-F12 key handler survives anywhere in src/', async () => {
  /* The whole point of the feature: Chrome owns most of these and only answers
   * them when the page happens to have focus, so a handler here is a key that
   * works about half the time. F1 (help) is the one exception; the exported
   * RESERVED_CODES literal is data, not a handler. */
  for (const f of await srcFiles()) {
    let src = strip(await readFile(f, 'utf8'));
    if (f.endsWith(path.join('core', 'Input.js'))) {
      src = src.replace(/export const RESERVED_CODES = \[[\s\S]*?\];/, '');
    }
    const rel = path.relative(root, f);
    assert.ok(!src.includes("'Shift+F9'"), `${rel}: still lists Shift+F9`);
    for (let n = 2; n <= 12; n++) {
      /* `[!=]==` because a guard is a handler too: `if (e.code !== 'F8') return`
       * is exactly the shape the `===` pattern walks past. `e.key` because it
       * is the other spelling of the same test - `code` is the physical key,
       * `key` the produced value, and for F-keys they are the same string. */
      assert.ok(!new RegExp(`code\\s*[!=]==\\s*'F${n}'`).test(src), `${rel}: still handles F${n}`);
      assert.ok(!new RegExp(`e\\.key\\s*===\\s*'F${n}'`).test(src), `${rel}: still handles F${n} by key`);
      assert.ok(!new RegExp(`pressed\\(\\s*'F${n}'\\s*\\)`).test(src), `${rel}: still polls F${n}`);
      assert.ok(!new RegExp(`\\[[^\\]\\n]*'F${n}'`).test(src), `${rel}: still lists F${n} in a key array`);
      // KeybindMenu's FIXED_KEYS rows are objects, not bare array entries, so
      // the bracket pattern above walks straight past them.
      assert.ok(!new RegExp(`key:\\s*'F${n}'`).test(src), `${rel}: still lists F${n} in a FIXED_KEYS row`);
    }
  }
});

test('no UI string advertises a key the build no longer answers', async () => {
  const DEAD = [
    "el('b', null, 'F2')", "el('b', null, 'F10')", "el('b', null, 'F4')", "el('b', null, 'F7')",
    "el('i', null, 'F3')",
    'F7 or Esc', 'F7 for options', 'F8 to quit', 'F9 / F12', 'F2 opens', 'F10 does',
    '<b>F5</b> saves', 'Mount menu (F10)', 'press F10', 'Character menu (F2)', '<b>F4</b> Audio',
  ];
  const files = [...await srcFiles(), path.join(root, 'site/app/api/chat/route.ts')];
  for (const f of files) {
    const src = strip(await readFile(f, 'utf8'));
    for (const s of DEAD) {
      assert.ok(!src.includes(s), `${path.relative(root, f)} still says "${s}"`);
    }
  }
  const route = await readFile(path.join(root, 'site/app/api/chat/route.ts'), 'utf8');
  for (const s of ['F2 customizes the character', 'F10 customizes the mount']) {
    assert.ok(!route.includes(s), `chat route still says "${s}"`);
  }
});
