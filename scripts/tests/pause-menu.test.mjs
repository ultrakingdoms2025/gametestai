import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUD } from '../../src/ui/HUD.js';
import { EventBus } from '../../src/core/EventBus.js';

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
  h.shown = null;
  h.relocks = 0;
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
