# Esc Pause Menu Hub Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Esc opens a pause-menu hub reaching every system panel (character, mount, inventory, quests, map, race, minigame quit, help, audio, keybinds, fullscreen, diagnostics, save, load, bug report, quit), and every F-key except F1 stops being a game key — because Chrome owns F1/F3/F5/F6/F10/F11/F12 and the player was losing half of them to the browser.

**Architecture:** The existing HUD pause overlay (`.pause`, z 60) is upgraded from a STANDBY card to a menu. A new DOM-only `src/ui/PauseMenu.js` (pure `PauseMenuModel` + `PauseMenu` view + `PAUSE_MENU_IDS`) renders items `main.js` supplies as data. HUD's overlay counter becomes `this._overlays = new Set()` of panel ids — the single contract for "a cursor-owning sheet is up" — with `openFromHub`/`_hubReturn` returning the player to the hub when the panel they launched closes. `Input` gains a persisted `fullscreenPreferred` and exports its reserved-key list. Spec: `docs/superpowers/specs/2026-08-17-pause-menu-hub-design.md`.

**Tech Stack:** Vanilla JS ES modules + Three.js 0.185 (`src/`), `node --test` headless tests in `scripts/tests/*.test.mjs`, plain CSS loaded by module import or by `<link>` in `index.html`, Vite build.

**Conventions for every task**
- Run tests with `node --test scripts/tests/<file>.test.mjs` (single file) or `npm test` (all).
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Line refs were read off the working tree at plan time; re-grep if an earlier task moved them.
- `src/ui/HUD.js` **is** importable under Node (verified: `node -e "import('./src/ui/HUD.js')"` → OK; its transitive imports — `Config`, `Minimap`, `ChatBox`, `ChatClient`, `WeaponWheel`, `HelpMenu`, `WorldRules` — never touch `three` or the DOM at module scope). So the overlay logic stays **in `HUD.js`** and is tested via `Object.create(HUD.prototype)`; the fallback `src/ui/OverlayTracker.js` module is **not** created.

## Spec deviations, declared

1. **`PauseMenuModel.activate()` does not call `run()`.** Spec §4.1 says it does, and §4.2 wires `onActivate: (item, keepOpen) => keepOpen ? refresh() : this.openFromHub(item.run)` — together those run a non-`keepOpen` item **twice**. `openFromHub` cannot delegate the call away because it must hide the hub *before* the panel opens. So the model returns the focused enabled item (or `null`) and the host owns the single `run()`.
2. **`pause-menu.css` is `<link>`ed from `index.html`**, not imported by `PauseMenu.js`. The house pattern is a module importing its own CSS, but that makes it unloadable under Node and spec §6 needs a headless model test. `hud.css` — which owns the `.pause*` rules this file extends — is already loaded that way.
3. **`overlay:false` is item data, not an id special-case**, so HUD never has to know the string `'help'`.
4. **`_helpOpen` is set inside `_wireOverlayEvents()`**, not in the handlers at `HUD.js:1188`. Same subscriptions, moved so the hand-off test exercises the real handler.
5. **Spec §4.6's string list is incomplete.** Seven more player-visible strings advertise keys Task 6 removes: `CharacterMenu.js:379` and `MountMenu.js:102` (`<b>F5</b> saves them with the game.`), `ItemDefs.js:309` (`Mount menu (F10)`), `ItemUse.js:59` (`press F10`), `MarketplaceUI.js:384/446/448` (`Mount menu (F10)` / `Character menu (F2)`), `main.js:1755` (the boot card's own `<b>F4</b> Audio`, visible until the first HUD frame). Task 6 fixes all of them and adds `el('b', null, 'F7')` to guard (c)'s literal list, which §6 omits.
6. **Resume is a `keepOpen` item calling a new `hud.resume()`**, not `openFromHub(() => hud.showPauseOverlay(false))`. Spec §3 lists Resume as an ordinary Play item; routed through `openFromHub` it would arm `_hubReturn`, find the Set still empty one microtask later and re-show the card. And hiding the card without re-locking leaves `main.js`'s `standby` gameplay block on with `_relockCheck` waiting to raise the overlay again.
7. **`HelpMenu`'s Escape branch gains `stopImmediatePropagation()`** (Task 3 Step 6). Spec §4.2(b)/(c) assume HUD can read `_helpOpen` while it is still true, but HelpMenu registers first (`main.js:227` vs `:421`) and `close()` emits `help:close` synchronously, so both guards were dead on arrival.
8. **`RaceUI`'s Enter branch gains `if (!this.input?.locked) return;`** (Task 6 Step 3). Not in the spec. RaceUI also registers before the HUD, so with the hub up Enter started a race behind it and swallowed the hub's own Enter.
9. **Disabled items use `aria-disabled` + the `.off` class, not the `disabled` property.** Spec §4.1 asks for a `title` carrying the disabled reason; Firefox suppresses tooltips on disabled buttons, which would silently drop "Mount up first (M)" — the one string that explains the state. Every act-on-item path re-checks `isEnabled` already.
10. **`scripts/tests/race-f7.test.mjs:15-25` will fail** the moment RaceUI's F7 handler goes — it asserts `src.indexOf("e.code === 'F7'") > 0`. Not mentioned in the spec. Task 6 deletes that one test and renames the file `race-arming.test.mjs`; its other three tests are unrelated and kept verbatim.
11. **`M` is NOT added to `KeybindMenu.FIXED_KEYS`.** Review asked for it alongside J / I / B. Those three are genuinely fixed — each panel owns a private listener and there is no `BINDABLE` entry to rebind. `M` is the opposite: `BINDABLE` carries `{ action: 'map', code: 'KeyM' }` and `scripts/tests/maze-map-binding.test.mjs:13-17` asserts exactly that, with the reason in its own title ("the map action is bindable, so a contextual key can still be rebound"). Listing it as fixed would tell the player a key they *can* rebind cannot be, and `FIXED_KEYS` rows are documentation only — the row would not even make it true. The contextual half (M is the mount wheel where mounts are allowed, the map where they are not) is `mapActionOwner`'s job and is already tested.
12. **Four review fixes beyond the spec**, all in the hub's return path:
    - **`_overlayOpen` arms the hub return itself** when a panel appears over a shown card. J / I / B / M keep private listeners and never reach `openFromHub`, so pressing one over the hub drew the panel *behind* the card, which then ate its Escape. Treating the keystroke as picking the row is the same act from the player's side. `_onPauseKey` also gains `if (this._overlays.size > 0) return;` as a second line of defence.
    - **`RaceUI`'s Enter guard becomes `if (!this._panelOpen && !this.input?.locked) return;`** — refining deviation 8. `openPanel` exits pointer lock itself, so the bare lock test locked Enter out of the one panel whose job is starting races: START worked, Enter beside it did nothing. Safe because "panel open" and "hub up" are mutually exclusive — the hub refuses to show while the Set is non-empty, and `race:menu` holds `race` in the Set for exactly as long as the panel is up.
    - **`HUD.clearHubReturn()`, wired to the countdown *and* started events of both managers.** Starting a contest from a hub-launched panel closes that panel, emptying the Set with `_hubReturn` still armed — the pause card would land on top of the starting lights. Committing is not cancelling. Review named `race:started` / `minigame:started`; those alone do not work. `RaceUI.startBtn` calls `closePanel()` then `race.start()` in one synchronous turn, and only `race:countdown` (`RaceManager.js:506`) / `minigame:countdown` (`MinigameManager.js:290`) are emitted inside `start()` — `:started` waits for the lights to go out (`:671` / `:435`), seconds after `_deferHubCheck`'s microtask has already put the hub back. Both pairs are subscribed; a second clear costs nothing.
    - **`market:open` / `market:close` join the tracker as `'market'`.** It is the only cursor-owning sheet that was outside it (`MarketplaceUI:489` uses `menuFocusIn`, which exits lock and captures text) and it has no hub row, so it reaches the Set purely through the first fix above. The `_overlays` invariant docblock now says the contract is "a panel owns the cursor", not "the hub opened it".

---

## Task 1: HUD overlay Set, prototype methods, `_helpOpen`, `openFromHub`

**Files:**
- Modify: `src/ui/HUD.js:262` (fields), `:978-984` (`input:lockchange`), `:1186-1233` (help + overlay closures), `:1580` (`showPauseOverlay` guard)
- Modify: `scripts/tests/race-pace.test.mjs:517-519` (a comment that is now provably wrong)
- Test: `scripts/tests/pause-menu.test.mjs` (new)

- [ ] **Step 1: Write the failing test**

Create `scripts/tests/pause-menu.test.mjs`:

```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/tests/pause-menu.test.mjs`
Expected: FAIL — `h._wireOverlayEvents is not a function`.

- [ ] **Step 3: Replace the counter with the Set**

`src/ui/HUD.js:261-262` — replace:

```js
    /** Count of blocking overlays currently open (quest board, race panel, etc.). */
    this._overlayCount = 0;
```
with:
```js
    /**
     * Ids of the cursor-owning panels currently on screen.
     *
     * A Set, not a counter: `MinigameUI._showBoard` has no re-entry guard, so a
     * repeated `minigame:finished` emitted `{open:true}` twice, an integer
     * latched above zero, and `showPauseOverlay` - which refuses while it is -
     * killed the pause hub for the rest of the session.
     *
     * Invariant: an id is present iff that module has a cursor-owning sheet on
     * screen. Per-MODULE keying is only safe because no multi-sheet module
     * stacks two of its own: `RaceUI._openStop` refuses unless `race.racing`
     * (`:680`) and `_showBoard`'s only caller closes the stop sheet first
     * (`:254`); `MinigameUI._openStop` guards on `_stopOpen || _boardOpen`
     * (`:211`). Relaxing either needs per-sheet ids here.
     * @type {Set<string>}
     */
    this._overlays = new Set();
    /** True while the hub launched the panel that is up, so its close returns there. */
    this._hubReturn = false;
    /** Collapses back-to-back empty-Set re-checks into one microtask. */
    this._hubCheckPending = false;
    /** HelpMenu keeps pointer lock, so it is deliberately outside `_overlays`. */
    this._helpOpen = false;
```

- [ ] **Step 4: Promote the closures to prototype methods**

`src/ui/HUD.js` — delete the `/* --- help --- */` block (`:1186-1189`) and the whole `/* --- overlay close → re-request pointer lock --- */` block through the last `this._on('mount:menu:close', …)` line (`:1191-1233`), leaving:

```js
    /* --- overlays, help, and the pause hub's return path ----------------- */
    this._wireOverlayEvents();
  }
```

Add these methods immediately after `_wire()` closes, before the `/* -------- v2 -- */` banner:

```js
  /* ==================================================================== */
  /* Overlay tracking and the pause hub's return path                     */
  /* ==================================================================== */

  /** How many cursor-owning panels are on screen. */
  get overlayCount() {
    return this._overlays.size;
  }

  /**
   * Mirror the tracker onto the HUD element so CSS can answer "is a
   * full-screen panel up". Only the objective tracker uses it: the quest board
   * states the same objective in full, so the compact copy showing through
   * underneath is noise, and the same holds for every overlay that covers the
   * vitals column.
   */
  _syncOverlaid() {
    this.el?.classList.toggle('overlaid', this._overlays.size > 0);
  }

  /**
   * Re-take the pointer shortly. The delay clears the browser's post-Escape
   * cooldown; `_relock` then drives it and falls back to the pause overlay.
   * Never fights chat, which handles its own.
   */
  _schedRelock() {
    if (!this._chatOpen) this._relock = Math.max(this._relock, 0.15);
  }

  _overlayOpen(id) {
    if (!id) return;
    this._overlays.add(id);
    this._syncOverlaid();
  }

  _overlayClose(id) {
    if (!id) return;
    this._overlays.delete(id);
    this._syncOverlaid();
    if (this._overlays.size === 0) this._deferHubCheck();
  }

  /**
   * Act on "nothing is open any more" - one microtask later, once.
   *
   * Deferred because two panels hand off inside a single synchronous sequence
   * (`RaceUI.js:745-749` via `:254`; `MinigameUI.js:81-83`), and read
   * synchronously that momentary gap looks like "everything closed" and would
   * drop the hub on top of a result board. `_hubCheckPending` collapses a
   * burst of closes into one check.
   *
   * Behaviour change, declared: `_schedRelock()` used to run on EVERY close; it
   * now runs only when the Set is still empty after the microtask.
   */
  _deferHubCheck() {
    if (this._hubCheckPending) return;
    this._hubCheckPending = true;
    queueMicrotask(() => {
      this._hubCheckPending = false;
      if (this._overlays.size > 0) return; // a same-tick hand-off; nothing closed
      if (this._hubReturn) {
        this._hubReturn = false;
        this.showPauseOverlay(true);
      } else {
        this.showPauseOverlay(false);
        this._schedRelock();
      }
    });
  }

  /**
   * Run a pause-hub item that opens a panel, and remember to come back.
   *
   * The hub hides BEFORE `run()`, so the panel is never drawn underneath it,
   * and the post-run check catches a panel that refused to open at all
   * (QuestBoard's `_openGuard`, MazeMap outside a maze, RaceUI without a
   * circuit) by putting the hub straight back.
   *
   * @param {() => void} run
   * @param {{overlay?: boolean}} [opts] `overlay:false` for HelpMenu, which
   *   keeps pointer lock, never joins `_overlays`, and sits over the hub.
   */
  openFromHub(run, { overlay = true } = {}) {
    if (typeof run !== 'function') return;
    if (!overlay) {
      run();
      return;
    }
    this._hubReturn = true;
    this.showPauseOverlay(false);
    try {
      run();
    } finally {
      this._deferHubCheck();
    }
  }

  /**
   * Map every panel's open/close event onto one id in `_overlays`. Keyed on the
   * event's own `.id` where it carries one (`hud:block`, `ui:modal`) - each has
   * exactly one emitter today, and keying on the id stops a future second
   * emitter silently joining the pause contract.
   */
  _wireOverlayEvents() {
    const o = (id) => this._overlayOpen(id);
    const c = (id) => this._overlayClose(id);
    this._on('race:menu',        ({ open })      => (open ? o('race') : c('race')));
    this._on('minigame:menu',    ({ open })      => (open ? o('minigame') : c('minigame')));
    this._on('hud:block',        ({ id, block }) => (block ? o(id) : c(id)));
    this._on('ui:modal',         ({ id, open })  => (open ? o(id) : c(id)));
    this._on('audio:menu',       ({ open })      => (open ? o('audio') : c('audio')));
    this._on('bug-report:open',  ()              => o('bug-report'));
    this._on('bug-report:close', ()              => c('bug-report'));
    this._on('character:open',   ()              => o('character'));
    this._on('character:close',  ()              => c('character'));
    this._on('inventory:open',   ()              => o('inventory'));
    this._on('inventory:close',  ()              => c('inventory'));
    this._on('keybinds:open',    ()              => o('keybinds'));
    this._on('keybinds:close',   ()              => c('keybinds'));
    this._on('mount:menu:open',  ()              => o('mount-menu'));
    this._on('mount:menu:close', ()              => c('mount-menu'));

    /* HelpMenu is deliberately NOT in the Set: it keeps pointer lock while open
     * (`HelpMenu.js:9-12`) so it can be read mid-play, and it sits at z 80 over
     * the hub's z 60. The flag is what stops `_onPauseKey` and the
     * Esc-under-lock handler acting on a keystroke Help has already claimed.
     * The chip is the affordance; dim it while the panel is up. */
    this._on('help:open',  () => { this._helpOpen = true;  this.el?.classList.add('helping'); });
    this._on('help:close', () => { this._helpOpen = false; this.el?.classList.remove('helping'); });
  }
```

- [ ] **Step 5: The two remaining readers**

`src/ui/HUD.js:1580` → `    if (show && this._overlays.size > 0) return; // a blocking UI overlay is open`

`src/ui/HUD.js:978-984`, the `input:lockchange` handler — add the clear inside the existing `if (locked)`:

```js
        this._setPauseBusy(false);
        /* A real relock always wins. Cleared here rather than inside
         * `showPauseOverlay(false)`, which `openFromHub` itself calls: a player
         * who clicked the canvas back into mouse-look while a hub-launched
         * panel was open does not want the hub afterwards. */
        this._hubReturn = false;
```

`grep -n "_overlayCount" src/ui/HUD.js` must return nothing.

Finally, correct a comment this task disproves. `scripts/tests/race-pace.test.mjs:517-519` reads:

```js
 * Textual, like the F7 and MountWheel gates and for the same reason: `HUD.js`
 * imports its stylesheet at module scope and cannot be loaded under Node. The
 * badge itself was verified in a browser.
```

It is not true and never was - `HUD.js` imports no stylesheet, and `pause-menu.test.mjs` now imports it under Node on every run. Left alone it is the kind of note that talks the next author out of a test they could have written. Replace with:

```js
 * Textual because the property is a DOM one: `_setMountPowers` writes a badge,
 * and asserting on the writing is what a headless test can honestly do. (`HUD.js`
 * itself imports fine under Node - `pause-menu.test.mjs` does exactly that - so
 * anything reachable on the prototype should be driven, not grepped.) The badge
 * itself was verified in a browser.
```

- [ ] **Step 6: Run tests** — `node --test scripts/tests/pause-menu.test.mjs` → PASS (6 tests). Then `npm test` → all green.

- [ ] **Step 7: Commit**

```bash
git add src/ui/HUD.js scripts/tests/pause-menu.test.mjs scripts/tests/race-pace.test.mjs
git commit -m "HUD: overlay tracker becomes a Set of panel ids, with a hub return path

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: `src/ui/PauseMenu.js` + `src/ui/pause-menu.css`

**Files:**
- Create: `src/ui/PauseMenu.js`, `src/ui/pause-menu.css`
- Modify: `index.html:27`
- Test: `scripts/tests/pause-menu.test.mjs`

- [ ] **Step 1: Add the failing model tests**

Add `import { PauseMenuModel, PAUSE_MENU_IDS } from '../../src/ui/PauseMenu.js';` to the test's imports and append:

```js
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
```

- [ ] **Step 2: Run to verify it fails** — `node --test scripts/tests/pause-menu.test.mjs` → FAIL, `Cannot find module '.../src/ui/PauseMenu.js'`.

- [ ] **Step 3: Write the module**

Create `src/ui/PauseMenu.js`:

```js
/**
 * The Esc hub's list widget: a pure model plus a thin DOM view.
 *
 * Game-agnostic on purpose. It knows nothing about mounts, worlds or pointer
 * lock - `main.js` supplies items as data and the HUD owns the card, the
 * keyboard and the return-to-hub bookkeeping. Same split as
 * `MountMenuLogic`/`MountMenu`, for the same reason: the interesting rules
 * (visible, disabled and why, where the highlight goes) are testable under
 * Node and the DOM half has none.
 *
 * `pause-menu.css` is loaded by a `<link>` in `index.html` alongside `hud.css`
 * rather than imported here, so this file stays importable without a bundler.
 *
 * An item is:
 *   { id, label: string|(()=>string), hint?: string|(()=>string),
 *     enabled?: () => true|string, visible?: () => boolean, run: () => void,
 *     keepOpen?: boolean, overlay?: boolean }
 */

/**
 * Every id the hub is expected to carry, in menu order. The source guard in
 * `scripts/tests/pause-menu.test.mjs` checks `main.js` wires all of them - a
 * silently missing row is invisible at runtime, because a menu with one fewer
 * item still works perfectly.
 */
export const PAUSE_MENU_IDS = [
  'resume', 'character', 'mount', 'inventory', 'quests', 'map', 'race', 'minigame-quit',
  'help', 'audio', 'keybinds', 'fullscreen', 'diagnostics', 'save', 'load', 'bug-report', 'quit',
];

/** Resolve a `string | () => string` field. */
function textOf(v) {
  if (typeof v === 'function') return String(v() ?? '');
  return v == null ? '' : String(v);
}

/** Pure list logic. No DOM, no game references. */
export class PauseMenuModel {
  constructor() {
    /** @type {Array<{title?: string, items: Array<object>}>} */
    this._groups = [];
    /** Index into `visibleItems()`, not into any group. */
    this.focus = 0;
  }

  setItems(groups) {
    this._groups = Array.isArray(groups) ? groups : [];
    this.focus = 0;
  }

  get groups() {
    return this._groups;
  }

  /** Flattened, in menu order, with `visible:false` items dropped. */
  visibleItems() {
    const out = [];
    for (const g of this._groups) {
      for (const it of g?.items ?? []) {
        const vis = typeof it.visible === 'function' ? !!it.visible() : it.visible !== false;
        if (vis) out.push(it);
      }
    }
    return out;
  }

  /**
   * `true`, or the reason string the item gave. A bare `false` is normalised to
   * a reason so callers only ever see `true | string` - a tooltip reading
   * "false" is worse than a vague one.
   */
  isEnabled(item) {
    if (!item || item.enabled == null) return true;
    const r = typeof item.enabled === 'function' ? item.enabled() : item.enabled;
    if (r === true || r == null) return true;
    if (r === false) return 'Unavailable';
    return String(r);
  }

  labelOf(item) { return textOf(item?.label); }

  hintOf(item) { return textOf(item?.hint); }

  /** The item under the highlight, clamped if the list shrank under it. */
  focusedItem() {
    const items = this.visibleItems();
    if (items.length === 0) return null;
    if (this.focus >= items.length) this.focus = items.length - 1;
    if (this.focus < 0) this.focus = 0;
    return items[this.focus] ?? null;
  }

  /** Put the highlight on the first item that can actually be chosen. */
  focusFirst() {
    const items = this.visibleItems();
    this.focus = 0;
    for (let i = 0; i < items.length; i++) {
      if (this.isEnabled(items[i]) === true) { this.focus = i; return; }
    }
  }

  /**
   * Step the highlight, wrapping, skipping anything disabled or hidden.
   * @param {number} delta
   * @returns {object|null} the newly focused item
   */
  move(delta) {
    const items = this.visibleItems();
    const n = items.length;
    if (n === 0) return null;
    const step = delta < 0 ? -1 : 1;
    let i = this.focus;
    // At most one lap: a list where everything is disabled must not spin.
    for (let tries = 0; tries < n; tries++) {
      i = (i + step + n) % n;
      if (this.isEnabled(items[i]) === true) { this.focus = i; return items[i]; }
    }
    return this.focusedItem();
  }

  /**
   * Resolve what Enter/click should act on. Deliberately does NOT call `run`:
   * the host runs it, once, because hiding the hub has to happen before the
   * panel opens.
   * @returns {object|null}
   */
  activate() {
    const item = this.focusedItem();
    if (!item || this.isEnabled(item) !== true) return null;
    return item;
  }
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/** The model with a list of buttons attached. */
export class PauseMenu {
  /** @param {{root: HTMLElement, onActivate?: (item: object, keepOpen: boolean) => void}} ctx */
  constructor({ root, onActivate } = {}) {
    this.model = new PauseMenuModel();
    this.onActivate = onActivate ?? null;
    /** @type {Array<{item, btn, labelEl, hintEl}>} */
    this._rows = [];
    this.el = el('div', 'pm-root');
    root?.appendChild(this.el);
  }

  setItems(groups) {
    this.model.setItems(groups);
    this._build();
    this.refresh();
  }

  _build() {
    this.el.textContent = '';
    this._rows = [];
    for (const g of this.model.groups) {
      const sec = el('section', 'pm-group');
      if (g?.title) sec.appendChild(el('h3', 'pm-group-t', g.title));
      for (const item of g?.items ?? []) {
        const btn = el('button', 'pm-item');
        btn.type = 'button';
        btn.dataset.id = String(item.id ?? '');
        const labelEl = el('span', 'pm-label');
        const hintEl = el('span', 'pm-hint');
        btn.append(labelEl, hintEl);
        /* The card behind this resumes on a background mousedown, so every
         * button stops its own - otherwise choosing "Audio" would also relock. */
        btn.addEventListener('mousedown', (e) => e.stopPropagation());
        btn.addEventListener('mouseenter', () => this._focusItem(item));
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          // `aria-disabled` rows still receive clicks: never act on the
          // *focused* item when the *clicked* one is off.
          if (this.model.isEnabled(item) !== true) return;
          this._focusItem(item);
          this.activate();
        });
        sec.appendChild(btn);
        this._rows.push({ item, btn, labelEl, hintEl });
      }
      this.el.appendChild(sec);
    }
  }

  _focusItem(item) {
    const items = this.model.visibleItems();
    const i = items.indexOf(item);
    if (i < 0 || this.model.isEnabled(item) !== true) return;
    this.model.focus = i;
    this._paintFocus();
  }

  /** Re-read every item's visible / enabled / label. Cheap; call it freely. */
  refresh() {
    const shown = new Set(this.model.visibleItems());
    for (const r of this._rows) {
      const on = shown.has(r.item);
      r.btn.hidden = !on;
      if (!on) continue;
      r.labelEl.textContent = this.model.labelOf(r.item);
      const why = this.model.isEnabled(r.item);
      const off = why !== true;
      const hint = off ? String(why) : this.model.hintOf(r.item);
      r.btn.classList.toggle('off', off);
      /* `aria-disabled`, NOT the `disabled` property. Firefox suppresses the
       * native tooltip on a disabled button, and on a disabled item the tooltip
       * IS the feature - it carries the reason ("Mount up first (M)"). The
       * `.off` class does the visual work and every path that could act on the
       * item re-checks `isEnabled`: `_focusItem` refuses it, `move()` skips it,
       * and the click handler returns before activating. */
      r.btn.setAttribute('aria-disabled', off ? 'true' : 'false');
      r.btn.tabIndex = off ? -1 : 0;
      r.hintEl.textContent = hint;
      r.hintEl.hidden = !hint;
      // `title` too: the hint line is truncated on a narrow card.
      if (hint) r.btn.title = hint;
      else r.btn.removeAttribute('title');
    }
    /* A row that just went hidden or disabled must not keep the highlight -
     * Enter on it would do nothing and look broken. */
    const items = this.model.visibleItems();
    const focused = items[this.model.focus];
    if (!focused || this.model.isEnabled(focused) !== true) this.model.focusFirst();
    this._paintFocus();
  }

  _paintFocus() {
    const focused = this.model.focusedItem();
    for (const r of this._rows) r.btn.classList.toggle('focus', r.item === focused);
  }

  move(delta) { this.model.move(delta); this._paintFocus(); }

  focusFirst() { this.model.focusFirst(); this._paintFocus(); }

  /** Hand the chosen item to the host, which owns the single call to `run`. */
  activate() {
    const item = this.model.activate();
    if (!item) return;
    this.onActivate?.(item, !!item.keepOpen);
  }

  dispose() {
    this.el.remove();
    this._rows.length = 0;
  }
}
```

- [ ] **Step 4: Write the stylesheet**

Create `src/ui/pause-menu.css`:

```css
/* Pause hub list. Lives inside `.pause-in` (hud.css) and inherits the card's
   clipped corners, rules and palette variables - this file styles only the
   list, so the two never disagree about the frame around it. */

.pm-root {
  display: flex;
  flex-direction: column;
  gap: 18px;
  margin-top: 24px;
  text-align: left;
  min-width: 320px;
  /* Seventeen items plus two headings overflow a short window, and the card is
     centre-placed so the overflow is clipped at BOTH ends - Quit becomes
     unreachable with no indication it is there. Scroll the list, not the page. */
  max-height: 70vh;
  overflow-y: auto;
}

.pm-group { display: flex; flex-direction: column; gap: 2px; }

.pm-group-t {
  margin: 0 0 6px;
  padding-bottom: 5px;
  font-family: var(--f-ui);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: var(--txt-dim);
  border-bottom: 1px solid var(--rule-soft);
}

.pm-item {
  display: flex;
  align-items: baseline;
  gap: 10px;
  width: 100%;
  padding: 7px 12px;
  font-family: var(--f-ui);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-align: left;
  color: #d6ecf6;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 3px;
  cursor: pointer;
  /* Colour only. The hub draws over a backdrop-filter; animating geometry here
     would re-composite the blur every frame of the transition. */
  transition: background 0.12s linear, color 0.12s linear, border-color 0.12s linear;
}

.pm-item[hidden] { display: none; }
.pm-item .pm-label { flex: 0 0 auto; }

.pm-item .pm-hint {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.04em;
  color: var(--txt-dim);
  text-align: right;
}

.pm-item:hover:not(.off),
.pm-item.focus:not(.off) {
  background: rgba(82, 233, 255, 0.12);
  border-color: var(--rule);
  color: #eaf8ff;
}

.pm-item.focus:not(.off) { box-shadow: inset 2px 0 0 var(--cy); }

.pm-item.off { color: var(--txt-dim); opacity: 0.5; cursor: not-allowed; }
```

- [ ] **Step 5: Load it** — `index.html:27`, add directly under the existing link:

```html
    <link rel="stylesheet" href="/src/ui/pause-menu.css" />
```

- [ ] **Step 6: Run tests** — `node --test scripts/tests/pause-menu.test.mjs` → PASS (13 tests). Then `npm run build` → clean.

Vite concatenates every `<link>`ed stylesheet into one hashed chunk, so there is no `pause-menu-*.css` in `dist/` to look for. Check the rules landed instead:

```bash
grep -c pm-item dist/assets/index-*.css   # must be >= 1
```

- [ ] **Step 7: Commit**

```bash
git add src/ui/PauseMenu.js src/ui/pause-menu.css index.html scripts/tests/pause-menu.test.mjs
git commit -m "PauseMenu: pure list model plus a DOM view for the Esc hub

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: HUD hosts the hub

**Files:**
- Modify: `src/ui/HUD.js:6` (import), `:422` + `:2643` (delete duplicate HelpMenu), `:903-962` (`_buildPause`), `:1578-1582` (`showPauseOverlay`), `:1732` (`_setPauseBusy`), `:1759-1762` (`_updateInput` F5), plus new public methods
- Modify: `src/ui/HelpMenu.js:161-163` (Escape must stop the propagation chain — Step 6)
- Modify: `src/ui/hud.css:2533-2578` (delete `.pause-hint`, `.pause-actions`, `.pause-btn*`)
- Test: none new — Task 1's flow tests cover the return path; listener ordering is only observable in a browser, so Task 7 Step 6 is what proves Step 6 here works.

- [ ] **Step 1: Import and constant**

`src/ui/HUD.js:6` — replace `import { HelpMenu } from './HelpMenu.js';` with `import { PauseMenu } from './PauseMenu.js';`.

Add beside the other module constants (near `LOCK_CONFIRM_S`, `~:35`):

```js
/** Resting text of the pause card's status line. `_setPauseBusy` overwrites it. */
const PAUSE_SUB = 'Esc resume · ↑↓ Enter · click';
```

- [ ] **Step 2: Delete the duplicate HelpMenu**

Delete `src/ui/HUD.js:422` (`this.help = new HelpMenu({ root: this.root, bus: this.bus, input: this.input });`) and `:2643` (`this.help.dispose();`). Nothing ever opened this instance — the F1 chip (`_buildHelpChip`, `:667-672`) has no click handler, and `main.js:227` builds the HelpMenu the hub uses. Two live instances means two capture-phase F1 listeners and two `help:open` emits per press.

`grep -n "this\.help\b\|HelpMenu" src/ui/HUD.js` must return nothing.

- [ ] **Step 3: Rebuild the pause card**

`src/ui/HUD.js:903-962` — replace the whole of `_buildPause()`:

```js
  _buildPause() {
    const p = el('div', 'pause');
    const inner = el('div', 'pause-in');
    this.pauseSub = el('div', 'pause-s', PAUSE_SUB);

    inner.appendChild(el('div', 'pause-t', 'PAUSED'));

    /* The hub itself. Items arrive from main.js, which is the only file that
     * knows every panel; this class owns the card, the keyboard and the return
     * path and nothing else. The old Reload / Quit buttons and the F-key hint
     * line are gone: Quit is a menu item now, and Reload was Quit-and-re-enter
     * with a worse name. */
    this.pauseMenu = new PauseMenu({
      root: inner,
      onActivate: (item, keepOpen) => {
        if (keepOpen) {
          // Acts in place - Resume, Save, Load, Fullscreen, Diagnostics.
          item.run?.();
          /* Only if the card is still up. Resume is a keepOpen item whose whole
           * job is to hide it, and refreshing a hidden menu would re-read every
           * label and re-run `focusFirst` for nothing - and, worse, paint a
           * focus ring the player will see on the next open. */
          if (this.pause.classList.contains('show')) this.pauseMenu.refresh();
        } else {
          this.openFromHub(item.run, { overlay: item.overlay !== false });
        }
      },
    });

    inner.appendChild(this.pauseSub);
    p.appendChild(inner);

    p.addEventListener('mousedown', (e) => {
      // Only the card background resumes; the buttons stop their own.
      if (e.target !== p && e.target !== inner) return;
      e.preventDefault();
      this._requestLock();
    });
    this.root.appendChild(p);
    this.pause = p;

    /* Keyboard on the hub.
     *
     * Capture phase and on `window`, because `Input` has stopped reporting -
     * that is what being paused means - so `pressed()` cannot see these.
     * Escape resumes: it is the key that put the player in front of this card.
     * Enter now ACTIVATES rather than resumes (spec §2); Space is the second
     * resume key for anyone who was using Enter for that. */
    this._onPauseKey = (e) => {
      if (!this.pause.classList.contains('show')) return;
      if (this._chatOpen || this.input.textCaptured) return;
      /* Help sits ON TOP of the hub and owns its own Escape. Its capture
       * listener is registered first, so without this one keystroke would close
       * Help and resume the game underneath it in the same press. */
      if (this._helpOpen) return;
      const code = e.code;
      if (code === 'ArrowUp' || code === 'KeyW') {
        e.preventDefault(); e.stopPropagation();
        this.pauseMenu.move(-1);
        return;
      }
      if (code === 'ArrowDown' || code === 'KeyS') {
        e.preventDefault(); e.stopPropagation();
        this.pauseMenu.move(1);
        return;
      }
      if (code === 'Enter') {
        e.preventDefault(); e.stopPropagation();
        this.pauseMenu.activate();
        return;
      }
      if (code !== 'Space' && code !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      this._requestLock();
    };
    window.addEventListener('keydown', this._onPauseKey, true);

    /* Escape from gameplay, while the keyboard lock is held.
     *
     * Without `navigator.keyboard.lock` the browser exits pointer lock on
     * Escape by itself and `input:lockchange` raises the hub. WITH the lock -
     * every fullscreen session, i.e. the default - Escape is delivered to the
     * page instead and until now nothing acted on it, so the one key the hub is
     * built around did nothing for exactly the players who are most protected.
     *
     * Each condition is a panel that owns Escape already. `e.repeat` is ignored
     * because HOLDING Escape is how browsers break keyboard lock, and firing on
     * each repeat would exit and re-request in a loop. */
    this._onLockEsc = (e) => {
      if (e.code !== 'Escape' || e.repeat) return;
      if (!this.input?.locked) return;
      if (this._overlays.size > 0 || this._helpOpen) return;
      if (this._chatOpen || this.input.textCaptured) return;
      this.input.exitLock();
    };
    window.addEventListener('keydown', this._onLockEsc, true);
  }
```

In `dispose()`, beside the existing `_onPauseKey` removal:

```js
    if (this._onLockEsc) window.removeEventListener('keydown', this._onLockEsc, true);
    this.pauseMenu?.dispose();
```

- [ ] **Step 4: Public API and the two string changes**

Add to the `/* Public API */` block, next to `showPauseOverlay`:

```js
  /**
   * Install the pause hub's items. `main.js` owns the data (CONTRACTS-V3 §3.6)
   * because it is the only file that holds every panel.
   * @param {Array<{title?: string, items: Array<object>}>} groups
   */
  setPauseMenuItems(groups) {
    this.pauseMenu?.setItems(groups);
  }

  /**
   * The hub's Resume item. A real re-lock, not `showPauseOverlay(false)`.
   *
   * Hiding the card on its own leaves the pointer unlocked, so `main.js`'s
   * `input:lockchange` handler is still holding the `standby` gameplay block
   * and the `_relockCheck` fallback puts the overlay straight back up - the hub
   * visibly flashes off and on and the world never resumes. `_requestLock` is
   * the same path the background click and the Escape key already take,
   * including the retry budget for Chrome's post-Escape cooldown.
   */
  resume() {
    this._requestLock();
  }

  /**
   * The hub's Save item calls this before `saveAndBackup` so the confirmation
   * toast can tell a deliberate save from a background autosave. Replaces the
   * `pressed('F5')` sniff in `_updateInput`, which F5 no longer reaches.
   */
  expectSave() {
    this._saveExpectT = 1.4;
  }
```

Replace `showPauseOverlay` (`:1578-1582`):

```js
  showPauseOverlay(show) {
    if (show && this._chatOpen) return; // chat deliberately released the cursor
    if (show && this._overlays.size > 0) return; // a blocking UI overlay is open
    const was = this.pause.classList.contains('show');
    this.pause.classList.toggle('show', !!show);
    if (show) {
      this._relockCheck = 0;
      // Always: `mounts.mounted`, the world and the race state may all have
      // moved since the card was last up.
      this.pauseMenu?.refresh();
      /* focusFirst only on the hidden→shown transition. `_lockRefused` and the
       * `_relockCheck` fallback call this repeatedly while a re-lock is being
       * retried, and resetting the highlight under the player's hand every
       * 0.4 s would make the list unusable on a slow relock. */
      if (!was) this.pauseMenu?.focusFirst();
    }
  }
```

`src/ui/HUD.js:1732` → `    this.pauseSub.textContent = busy ? 'resuming…' : PAUSE_SUB;`

`src/ui/HUD.js:1759-1761` — delete the F5 sniff, keep the countdown:

```js
    // A deliberate save is announced by `expectSave()` (the hub's Save item);
    // this is only the countdown that lets the toast wording expire.
    if (this._saveExpectT > 0) this._saveExpectT -= dt;
```

- [ ] **Step 5: Drop the dead CSS**

`src/ui/hud.css:2533-2578` — delete `.pause-hint`, `.pause-actions`, `.pause-btn`, `.pause-btn:hover`, `.pause-btn-quit`, `.pause-btn-quit:hover` (everything between `@keyframes pause-blink` and the `DEBUG PANEL` banner). Keep `.pause`, `.pause.show`, `.pause-in`, `.pause-t`, `.pause-s`, `.pause-s.busy`, `@keyframes pause-blink`.

`grep -n "pause-hint\|pause-actions\|pause-btn" src/ui/hud.css src/ui/HUD.js` must return nothing.

- [ ] **Step 6: Make the `_helpOpen` guards actually reachable**

**Without this the two guards added in Step 3 are dead code.** Both read `this._helpOpen` — but `HelpMenu` registers its capture-phase listener in `main.js:227`, well before the HUD is constructed at `main.js:421`, so on one Escape press the browser runs HelpMenu's handler *first*. It calls `close()`, which emits `help:close` **synchronously** on the bus, which sets `this._helpOpen = false`. HUD's two handlers then run in the same event and see `false`: `_onPauseKey` resumes the game the player was only trying to get Help off the top of, and `_onLockEsc` exits pointer lock. Help closing and the game resuming on a single keystroke is precisely what the guards were written to prevent.

Registering first is also what makes the fix available: `stopImmediatePropagation` stops later listeners on the *same* element and phase, and HelpMenu is the earlier registration on `window`/capture.

`src/ui/HelpMenu.js:161-163` — old:

```js
      } else if (e.code === 'Escape' && this._open) {
        this.close();
      }
```

new:

```js
      } else if (e.code === 'Escape' && this._open) {
        /* This Escape is spent closing Help and nothing else.
         *
         * We register before the HUD does (main.js:227 vs :421), so its pause
         * handlers would otherwise run later in this same event - and by then
         * `close()` has already emitted `help:close`, clearing the `_helpOpen`
         * flag they guard on. The result was one keypress that closed Help AND
         * either resumed the game or dropped pointer lock. */
        e.preventDefault();
        e.stopImmediatePropagation();
        this.close();
      }
```

- [ ] **Step 7: Run tests** — `npm test && npm run build` → all green (`race-pace.test.mjs:521` reads `HUD.js` textually; confirm it still passes).

- [ ] **Step 8: Commit**

```bash
git add src/ui/HUD.js src/ui/HelpMenu.js src/ui/hud.css
git commit -m "HUD: the pause card becomes the Esc hub - PAUSED, a menu, and Esc under lock

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: `Input` — exported reserved keys, F11/F12, fullscreen as a preference

**Files:**
- Modify: `src/core/Input.js:71` (storage key), `:73-86` (`RESERVED_CODES` + its comment), `:120` (new field), accessors, `:168-176` (`requestLock`), `_bind()` (new listener)
- Test: `scripts/tests/input-binds.test.mjs` (extend)

- [ ] **Step 1: Add the failing tests**

Extend the import to `import { Input, BINDABLE, RESERVED_CODES } from '../../src/core/Input.js';`, extend the reserved loop at `:62` with `'F11', 'F12'`, and append:

```js
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
```

- [ ] **Step 2: Run to verify it fails** — `node --test scripts/tests/input-binds.test.mjs` → FAIL, `does not provide an export named 'RESERVED_CODES'`.

- [ ] **Step 3: Edit `Input`**

`src/core/Input.js:71` — add beside `BIND_STORAGE`: `const FS_STORAGE = 'aether:fullscreen';`

`:73-86` — export, extend, and correct the comment (the doc block is `:73-83`, the array `:84-86`):

```js
/**
 * Keys the game cannot give up without breaking its own escape hatches, plus
 * the ones the BROWSER will never really hand over.
 *
 * Since the Esc hub landed, F2-F10 are no longer game keys at all - but they
 * stay reserved, because Chrome answers most of them itself (F3 find, F5
 * reload, F6 address bar, F10 menu bar) and a binding pointed at one would work
 * only while the page happened to have focus. F11 (fullscreen, which the hub
 * owns as a preference) and F12 (devtools, un-preventable) are here for the
 * same reason. Exported so `KeybindMenu` and the pause-hub source guard check
 * against the one list rather than a copy.
 *
 * Enforced in BOTH directions: `setBinding` refuses to write one, and
 * `_loadBinds` drops one already in storage. A build that shipped a narrower
 * list, or a hand-edited entry, would otherwise leave the player with an Escape
 * that no longer closes anything and no way in the UI to take it back.
 */
export const RESERVED_CODES = [
  'Escape', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'Tab',
];
```

`:120` — after `this._textCaptured = false;` (`:119`):

```js
    /* Fullscreen is a preference now, not an unconditional side effect of
     * taking the pointer: `requestLock` re-entered it on every resume, so the
     * hub's "Fullscreen: Off" survived exactly until Resume was pressed.
     * Persisted, because someone who turned it off wants it off tomorrow.
     * Default true - `navigator.keyboard.lock`, the only thing between a
     * crouch-walking player (Ctrl+W) and a closed window, needs fullscreen. */
    this._fullscreenPreferred = this._loadFullscreenPref();
```

Add after `setTextCapture`:

```js
  /** Whether resuming should re-enter fullscreen. Persisted. */
  get fullscreenPreferred() {
    return this._fullscreenPreferred;
  }

  set fullscreenPreferred(on) {
    this._fullscreenPreferred = !!on;
    try {
      localStorage.setItem(FS_STORAGE, this._fullscreenPreferred ? '1' : '0');
    } catch { /* private mode; the session preference still applies */ }
  }

  /** @returns {boolean} stored preference, defaulting to on. */
  _loadFullscreenPref() {
    try {
      return localStorage.getItem(FS_STORAGE) !== '0';
    } catch {
      return true;
    }
  }
```

`:168-176` — gate the request:

```js
    const el = document.documentElement;
    if (this._fullscreenPreferred && !document.fullscreenElement && el.requestFullscreen) {
      Promise.resolve(el.requestFullscreen()).then(
        () => this._lockKeyboard(),
        () => {}
      );
    } else if (document.fullscreenElement) {
      /* Deliberately NOT gated on the preference: a player who is fullscreen
       * for their own reasons still gets Ctrl+W back. */
      this._lockKeyboard();
    }
```

In `_bind()`, beside the `pointerlockchange` listener (`~:328`):

```js
    /* Fullscreen can change without us asking: F11, the browser's own Escape,
     * an OS gesture, or the hub's toggle. Keyboard lock is only granted in
     * fullscreen, so it has to follow - otherwise leaving fullscreen keeps a
     * lock the browser already revoked, and re-entering leaves Ctrl+W live
     * while the player is still playing. */
    document.addEventListener('fullscreenchange', () => {
      if (document.fullscreenElement) {
        if (this._locked) this.relockKeyboard();
      } else {
        this._unlockKeyboard();
      }
    });
```

- [ ] **Step 4: Run tests** — `node --test scripts/tests/input-binds.test.mjs` → PASS. Then `npm test` → all green.

- [ ] **Step 5: Commit**

```bash
git add src/core/Input.js scripts/tests/input-binds.test.mjs
git commit -m "Input: export RESERVED_CODES with F11/F12, make fullscreen a stored preference

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: `main.js` wiring

**Files:**
- Modify: `src/main.js:9` (import), `:421` (after `hud`), `:1674-1682` (delete the F3 branch), `src/ui/KeybindMenu.js:242-262` (`_hadLock`)
- Test: covered by Task 6's source guard (a)

- [ ] **Step 1: Import `mapActionOwner`** — `src/main.js`, after the `WorldManager` import (`:9`):

```js
import { mapActionOwner } from './worlds/WorldRules.js';
```

- [ ] **Step 2: Install the items** — insert directly after `const hud = new HUD({…});` (`:421`):

```js
/* The Esc pause hub.
 *
 * Items are data because this is the only file that holds every panel; the HUD
 * owns the card, the keyboard and the return path and knows none of these
 * names. `keepOpen` items act in place and the hub stays up; everything else
 * goes through `hud.openFromHub`, which hides the hub, opens the panel and
 * brings the hub back when that panel closes. Ids are pinned by
 * `PAUSE_MENU_IDS` and checked against this list by a source test - a silently
 * missing row is invisible at runtime, because a menu with one fewer item still
 * works perfectly. */
hud.setPauseMenuItems([
  {
    title: 'Play',
    items: [
      /* `keepOpen` so it never goes through `openFromHub`: that would arm
       * `_hubReturn`, and the post-run check would find the Set still empty a
       * microtask later and put the hub straight back on. Resume is an act-in-
       * place item whose run happens to hide the card, and `hud.resume()` takes
       * the pointer lock back for real. */
      { id: 'resume', label: 'Resume', hint: 'Esc', keepOpen: true, run: () => hud.resume() },
      { id: 'character', label: 'Character', run: () => characterMenu.open() },
      {
        id: 'mount',
        label: 'Customise mount',
        // The panel refuses on foot and toasts; saying so up front is kinder.
        enabled: () => (mounts?.mounted ? true : 'Mount up first (M)'),
        run: () => mountMenu.open(),
      },
      /* `Inventory.open()` is synchronous ONLY once its panel exists. On the
       * very first call it kicks off a dynamic `import('../ui/InventoryUI.js')`
       * and returns (`Inventory.js:392-401` → `_mountUI` `:516-537`); the
       * `inventory:open` event then lands a promise tick later, well after
       * `_deferHubCheck`'s single microtask has already decided nothing opened
       * and put the hub back. That window is unreachable in practice - the
       * constructor calls `_mountUI()` eagerly at `Inventory.js:75`, long
       * before the player can click to enter, let alone press Esc. If the
       * eager mount is ever removed, this item needs `keepOpen: true` and its
       * own hide, or `openFromHub` needs an async-aware check. */
      { id: 'inventory', label: 'Inventory', hint: 'I', run: () => inventory.open() },
      { id: 'quests', label: 'Quest board', hint: 'J', run: () => questSystem.openBoard() },
      {
        id: 'map',
        label: 'Map',
        // M is the mount wheel everywhere else; `mapActionOwner` is the same
        // test MazeMap and MountWheel use to decide which of them owns the key.
        visible: () => mapActionOwner(worldManager.active) === 'map',
        run: () => mazeMap.open(),
      },
      {
        id: 'race',
        label: 'Race panel',
        visible: () => !!(race?.ready || race?.racing),
        run: () => raceUI.openPanel(),
      },
      {
        id: 'minigame-quit',
        label: 'Quit minigame',
        visible: () => !!minigames?.running,
        // Never a single keypress: the manager will not act on this itself,
        // MinigameUI raises its confirm sheet.
        run: () => bus.emit('minigame:quitRequest', {}),
      },
    ],
  },
  {
    title: 'System',
    items: [
      {
        id: 'help',
        label: 'Help & controls',
        hint: 'F1',
        // Help keeps pointer lock and sits OVER the hub (z 80 vs 60); closing
        // it reveals the hub again, so the hub must not hide for it.
        overlay: false,
        run: () => helpMenu.open(),
      },
      { id: 'audio', label: 'Audio', run: () => audioMenu.open() },
      { id: 'keybinds', label: 'Rebind keys', run: () => keybindMenu.open() },
      {
        id: 'fullscreen',
        // The PREFERENCE, not a live readout: `requestFullscreen` resolves
        // asynchronously and a browser-driven exit does not change what the
        // player asked for. The hint's first sentence says so.
        label: () => `Fullscreen: ${input.fullscreenPreferred ? 'On' : 'Off'}`,
        hint: 'Applies when you resume. Off gives Ctrl+W back to the browser; the save prompt still guards it',
        keepOpen: true,
        run: () => {
          const on = !input.fullscreenPreferred;
          input.fullscreenPreferred = on;
          try {
            if (on) document.documentElement.requestFullscreen?.()?.catch?.(() => {});
            else if (document.fullscreenElement) document.exitFullscreen?.()?.catch?.(() => {});
          } catch { /* refused; the preference still stands for the next resume */ }
        },
      },
      {
        id: 'diagnostics',
        label: () => `Diagnostics: ${CONFIG.debug.showStats ? 'On' : 'Off'}`,
        keepOpen: true,
        run: () => {
          CONFIG.debug.showStats = !CONFIG.debug.showStats;
          hud.setDebugVisible(CONFIG.debug.showStats);
        },
      },
      {
        id: 'save',
        label: 'Save',
        hint: 'Writes local storage and a backup file',
        keepOpen: true,
        run: () => {
          // Before the write: the toast reads this to tell a deliberate save
          // from a background autosave.
          hud.expectSave();
          save.saveAndBackup('menu');
        },
      },
      {
        id: 'load',
        label: 'Load',
        hint: 'Local save, or pick a backup file',
        // May summon a mount and move the player; the hub stays and refreshes.
        keepOpen: true,
        run: () => save.loadAnywhere(),
      },
      { id: 'bug-report', label: 'Report a bug', run: () => bugReport.open() },
      {
        id: 'quit',
        label: 'Quit to menu',
        hint: 'Back to the landing page',
        // The game runs at /play, so the site root is one level up.
        run: () => { window.location.href = `${window.location.origin}/`; },
      },
    ],
  },
]);
```

- [ ] **Step 3: Remove the F3 branch, keep `KeyI`** — `src/main.js:1674-1682`:

```js
// Diagnostics moved to the Esc hub; F3 is Chrome's find-in-page. KeyI stays -
// it is a letter key, and the hub's Inventory item is the second way in.
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyI' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
```

(the `if (e.code === 'F3') { … return; }` block goes; the rest of the `KeyI` body is unchanged.)

- [ ] **Step 4: `KeybindMenu` must not relock over the hub**

It is the only panel that relocks unconditionally on close, so opening it from the hub and closing it drops the player into mouse-look instead of the hub.

Constructor — add `this._hadLock = false;` beside the other fields.

`:242-250` (`open()`), after `this._open = true;`:

```js
    /* Only put the lock back if there was one. Opened from the Esc hub the
     * cursor is already free and the hub is waiting underneath, and grabbing
     * the pointer out from under a menu the player can still see is the same
     * bug `CharacterMenu.close` and `MazeMap.close` both record. */
    this._hadLock = !!this.input?.locked;
```

`:262` in `close()`:

```js
    if (this._hadLock) setTimeout(() => this.input?.requestLock?.(), 0);
    this._hadLock = false;
```

- [ ] **Step 5: Verify** — `npm test && npm run build` → all green. `grep -n "e.code === 'F3'" src/main.js` must return nothing.

- [ ] **Step 6: Commit**

```bash
git add src/main.js src/ui/KeybindMenu.js
git commit -m "main: wire the Esc hub's items; drop F3; KeybindMenu relocks only if it had the lock

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 6: F-key removals and the discoverability sweep

**Files:**
- Modify: `src/ui/CharacterMenu.js:14,44-50,213,379,655-672` · `src/ui/MountMenu.js:9,12,91,102,379-396` · `src/ui/AudioMenu.js:4,47-57,79` · `src/ui/KeybindMenu.js:37-53,167-170,212-217` · `src/ui/BugReport.js:2-5,53-64,80` · `src/systems/SaveGame.js:125-146` · `src/ui/RaceUI.js:144-190,181,381-382,817` · `src/ui/MinigameUI.js:51-56,57-68,126` · `src/ui/HelpMenu.js:65-72,100-118` · `src/ui/HUD.js:834,1391-1414` · `src/main.js:1755` · `src/systems/ItemDefs.js:309` · `src/systems/ItemUse.js:59` · `src/ui/MarketplaceUI.js:384,446,448` · `src/ai/ChatClient.js:360` · `site/app/api/chat/route.ts:114`
- Rename: `scripts/tests/race-f7.test.mjs` → `scripts/tests/race-arming.test.mjs`
- Test: `scripts/tests/pause-menu.test.mjs` (source guards)

- [ ] **Step 1: Add the failing source guards**

Add `import { readFile, readdir } from 'node:fs/promises'; import path from 'node:path'; import { fileURLToPath } from 'node:url';` and `const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');` to the test's header, then append:

```js
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
      assert.ok(!new RegExp(`code\\s*===\\s*'F${n}'`).test(src), `${rel}: still handles F${n}`);
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
```

- [ ] **Step 2: Run to verify it fails** — `node --test scripts/tests/pause-menu.test.mjs` → FAIL on all three source tests.

- [ ] **Step 3: Remove the listeners (each keeps its Escape)**

- `CharacterMenu.js:655-672` — in `_key(e)` delete the whole `if (e.code === 'F2') { … }` block; keep `Escape`. Delete the `## Why F2` doc section (`:44-50`) and change `:14` to `The character panel. Opened from the Esc pause hub.`
- `MountMenu.js:379-396` — delete the `if (e.code === 'F10') { … }` block; keep `Escape`. Same doc treatment at `:9` and `:12`.
- `AudioMenu.js:47-57` — the handler becomes:
  ```js
    this._onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === 'Escape' && this._open) this.close();
    };
  ```
  and `:4` becomes `Audio options. Opened from the Esc pause hub.`
- `KeybindMenu.js:212-217` — drop the `F6` branch, keep `Escape`.
- `BugReport.js:53-64` — in `_onKey` (`:53-63`, listener `:64`) drop the `F9 || F12` branch (`:55-58`), keep `Escape`; header (`:2-5`) → `Bug report panel. Opened from the Esc pause hub; Esc closes it.`
- `SaveGame.js:125-146` — delete `this._onKeyDown` (comment `:125-130`, handler `:131-145`) and its `window.addEventListener('keydown', this._onKeyDown, true);` at `:146`, plus the matching `removeEventListener` in `dispose()`. `saveAndBackup` (`:804`) and `loadAnywhere` (`:822`) are unchanged and are now called only from the hub. **`_onBeforeUnload` and its `_autoSave('unload')` stay untouched** — that is what still protects a Ctrl+W with fullscreen off.
- `RaceUI.js:144-190` — delete the `if (e.code === 'F7') { … }` block and the `/* F7, not F6 */` comment above it. Keep the `Escape` branch verbatim.

  **The `Enter` branch needs one new guard.** `RaceUI` registers its capture listener in `main.js:285`, before the HUD at `:421`, so on the circuit Enter now starts a race *from behind the open hub* — and the hub's own Enter (activate the focused item) never fires, because RaceUI called `preventDefault` and `closePanel` first. Pointer lock is the honest test for "the player is driving, not reading a menu": every hub-owning panel releases it. `RaceUI.js:181` — old:

  ```js
        if (this.input?.textCaptured) return;
        if (this._stopOpen || this._boardOpen || !this.race?.ready || this.race.state !== 'idle') return;
  ```

  new:

  ```js
        if (this.input?.textCaptured) return;
        /* Only while actually playing. We register before the HUD does
         * (main.js:285 vs :421), so with the Esc hub up this branch would run
         * first and start a race behind it - and swallow the Enter the hub
         * needed to activate the focused item. Every panel that owns the cursor
         * has released the lock, so this is the one test that covers all of
         * them without naming any. */
        if (!this.input?.locked) return;
        if (this._stopOpen || this._boardOpen || !this.race?.ready || this.race.state !== 'idle') return;
  ```
- `MinigameUI.js:57-68` — delete the `if (e.code === 'F8') { … }` block (`:59-63`); keep `Escape`. Rewrite the comment at `:51-56` to say the sheets are reached by E at the venue and by the hub's **Quit minigame** item.

- [ ] **Step 4: Rewrite the player-visible text**

| File:line | Old | New |
|---|---|---|
| `HUD.js:834` | `el('i', null, 'F3')` | `el('i', null, 'Esc menu')` |
| `HUD.js:1401-1408` | the rows `['F2'…]`, `['F10'…]`, `['F4'…]`, `['F6'…]`, `['F7'…]`, `['F5'…]`, `['Shift+F9'…]`, `['F9'…]` | one row `['Esc', 'Pause menu — character, mount, inventory, settings, save…']` |
| `HUD.js:1412` | `['Esc', 'Release cursor'],` | *(delete — the new Esc row replaces it)* |
| `main.js:1755` | `<span><b>F4</b> Audio</span><span><b>Esc</b> Release cursor</span>` | `<span><b>Esc</b> Pause menu</span>` |
| `HelpMenu.js:70` | `['F3', 'Diagnostics overlay'],` | `['—', 'Diagnostics — in the Esc menu'],` |
| `HelpMenu.js:71` | `['Esc', 'Release the mouse cursor'],` | `['Esc', 'Pause menu'],` |
| `HelpMenu.js:105-116` | the System group's `F1`/`F2`/`F10`/`F4`/`F6`/`F7`/`F5`/`F9`/`Shift+F9`/`F12` rows | `['Esc', 'Pause menu (everything below is in it)'],` then `['F1', 'This panel'],` |
| `HelpMenu.js:117` | `['Esc', 'Close this panel'],` | *(keep — Help's own Esc is real)* |
| `KeybindMenu.js:37-53` | the `F2`/`F3`/`F4`/`F5`/`F6`/`F7`/`F9`/`F10`/`Shift+F9` rows | `{ key: 'Esc', label: 'Pause menu — every panel is in it' },` and `{ key: 'F1', label: 'Help & controls' },`; **add the missing** `{ key: 'M', label: 'Mount wheel / maze map' },`; keep `J`, `I`, `B`, `K`, `1–4`, `Wheel` |
| `KeybindMenu.js:167-170` | `'Fixed keys (J, I, B, M, K, F1–F10 and Esc) cannot be rebound: …'` | `'Fixed keys (Esc, F1 and the letter keys J I B M K) cannot be rebound; F2–F12 are left to the browser.'` |
| `CharacterMenu.js:213` | `close.append(el('b', null, 'F2'), el('span', null, 'close'));` | `close.append(el('b', null, 'Esc'), el('span', null, 'close'));` |
| `CharacterMenu.js:379` | `'Changes apply to your body at once. <b>F5</b> saves them with the game.'` | `'Changes apply to your body at once. Save from the Esc menu to keep them.'` |
| `MountMenu.js:91` | `close.append(el('b', null, 'F10'), el('span', null, 'close'));` | `close.append(el('b', null, 'Esc'), el('span', null, 'close'));` |
| `MountMenu.js:102` | `'Changes apply to the mount at once. <b>F5</b> saves them with the game.'` | `'Changes apply to the mount at once. Save from the Esc menu to keep them.'` |
| `AudioMenu.js:79` | `close.append(el('b', null, 'F4'), el('span', null, 'or'), el('b', null, 'Esc'), el('span', null, 'to close'));` | `close.append(el('b', null, 'Esc'), el('span', null, 'to close'));` |
| `RaceUI.js:381-382` | `close.title = 'Close (F7 or Esc)';` and the `el('b', null, 'F7'), el('span', null, 'or'), …` append | `close.title = 'Close (Esc)';` and `close.append(el('b', null, 'Esc'), el('span', null, 'to close'), el('i', 'rc-close-x', '✕'));` |
| `RaceUI.js:817` | `… laps · Enter, or F7 for options` | `… laps · Enter to start, Esc menu for options` — “Esc” alone reads as “close”; the options are *in* the hub |
| `MinigameUI.js:126` | `el('div', 'mg-hint', 'E or F8 to quit')` | `el('div', 'mg-hint', 'E, or Esc menu, to quit')` — bare Esc closes the confirm sheet, it does not raise it |
| `BugReport.js:80` | `el('span', 'br-title-key', '(F9 / F12)')` | `el('span', 'br-title-key', '(Esc menu → Report a bug)')` |
| `ItemDefs.js:309` | `Apply to your ${skin.mount} from the Mount menu (F10) while riding; one use.` | `Apply to your ${skin.mount} from the Esc menu → Customise mount, while riding; one use.` |
| `ItemUse.js:59` | `` `Mount your ${skin.mount} and press F10 to apply this skin` `` | `` `Mount your ${skin.mount}, then Esc → Customise mount to apply this skin` `` |
| `MarketplaceUI.js:384,446` | `apply it from the Mount menu (F10) while riding` | `apply it from the Esc menu → Customise mount, while riding` |
| `MarketplaceUI.js:384,448` | `equip it in the Character menu (F2)` | `equip it from the Esc menu → Character` |
| `ChatClient.js:360` | `'Change your own look first — F2 opens that. F10 does the same for whatever you are riding.'` | `'Change your own look first — the Esc menu opens that, and the same menu customises whatever you are riding.'` |
| `route.ts:114` | `… F1 shows help; F2 customizes the character; F10 customizes the mount you are riding; F3 opens diagnostics; F4 opens audio; F5 saves; F6 rebinds; F7 opens the race panel; F9 reports a bug; I opens inventory; …` | `… F1 shows help; Esc opens the pause menu, which is where the character customizer, the mount customizer, diagnostics, audio, keybinds, save, load, the race panel, bug reports, fullscreen and quit all live; I opens inventory; …` |

- [ ] **Step 5: The pre-existing F7 test**

`scripts/tests/race-f7.test.mjs:15-25` asserts `src.indexOf("e.code === 'F7'") > 0` and fails the moment Step 3 lands. Delete that one test; the other three (world re-arming, the per-type setup footer, and the "documents F7 as circuit-only" scan, which now passes vacuously) are unrelated and stay verbatim. Rename so the file says what it guards, and drop the F7 paragraph from its header comment:

```bash
git mv scripts/tests/race-f7.test.mjs scripts/tests/race-arming.test.mjs
```

- [ ] **Step 6: Run tests** — `npm test && npm run build` → all green, and

```bash
grep -rn "code === 'F[2-9]'\|code === 'F1[0-2]'\|pressed('F[2-9]')" src/
```
must return nothing.

- [ ] **Step 7: Commit**

```bash
git add -A src scripts/tests site/app/api/chat/route.ts
git commit -m "Remove every F2-F12 hotkey and the text that advertised them

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 7: Browser smoke and docs

**Files:** `docs/superpowers/specs/2026-08-17-pause-menu-hub-design.md:4`, `CONTRACTS-V3.md:205-213` (§3.5) and `:215-232` (§3.6)

- [ ] **Step 1:** `npm run dev`, note the port, open `http://localhost:<port>/?dev=1`, click to enter. (Playwright MCP if available, otherwise by hand.)
- [ ] **Step 2: Entry and exit.** Esc from gameplay → card reads **PAUSED**, two groups, status line `Esc resume · ↑↓ Enter · click`. Esc again → relocked and playing; repeat with Space and with a background click. No Reload/Quit buttons, no F-key hint line. Then choose **Resume** with the mouse and again with Enter: the pointer must actually lock and the world must run — the card must not blink off and back on. In a short window (or with devtools docked) confirm the list scrolls and **Quit to menu** is reachable.
- [ ] **Step 3: Keyboard only.** ↑/↓ and W/S walk the highlight, wrap at both ends, and skip **Customise mount** on foot (tooltip "Mount up first (M)"). Enter opens the focused panel.
- [ ] **Step 4: Each item, then Esc.** Character, Customise mount (while riding), Inventory, Quest board, Audio, Rebind keys, Report a bug — each opens with the hub hidden; Esc closes it and **the hub comes back** (must not relock, must not resume). Resume from the hub → pointer locked.
- [ ] **Step 5: Conditional items.** In the hedge maze **Map** appears and opens the floorplan; elsewhere it is absent. In Vellum Ridge **Race panel** appears and opens; it goes on leaving. Start a minigame → **Quit minigame** appears, raises the confirm sheet, and cancelling returns to the hub.
- [ ] **Step 6: Listener ordering — the two fixes no headless test can see.** From the hub choose **Help & controls**: Help appears *over the still-visible hub*. Esc closes Help **only** — the hub must still be there and the world must still be paused; a second Esc resumes. During locked gameplay F1 → Help, then Esc → closes Help and does **not** open the hub and does **not** drop pointer lock. Then on the circuit, armed and idle, open the hub and press **Enter**: it must activate the focused hub item and must **not** start a race behind the card; close the hub, press Enter while playing, and the race must still start.
- [ ] **Step 7: keepOpen items.** **Save** → deliberate-save toast, hub stays. **Load** → restores, hub stays and refreshes. **Diagnostics** toggles the overlay and flips its label. **Fullscreen** flips label and window; with it Off, Resume must **not** re-enter fullscreen; reload the page and confirm the preference persisted; turn it back On.
- [ ] **Step 8: Escape under keyboard lock.** With Fullscreen On, Esc from gameplay raises the hub. **Hold** Esc two seconds: opens once, no flicker, no lock/unlock loop.
- [ ] **Step 9: Dead keys and text.** F2–F10 and Shift+F9 do nothing in game (the browser may answer); Ctrl+F5 still hard-reloads. The boot card, F1's panel and the keybind panel show the Esc row and no F2–F12 rows. T opens chat, Esc goes to chat with no hub behind it; ask the NPC how to customise a character and confirm the answer names the Esc menu. Zero new console errors across all six worlds. Note anything broken as a follow-up and fix it before finishing.
- [ ] **Step 10: Docs.**

Spec status line (`…-pause-menu-hub-design.md:4`) → `**Status:** Implemented 2026-08-17`, and append a "Shipped deviations" section listing the ten items from this plan's header.

`CONTRACTS-V3.md` §3.5 (`:211-212`) still routes players at a removed key. Old:

```
consumes a skin bag item and burns it into `Cosmetics`. `src/ui/MountMenu.js` (F10) is
generic over `CUSTOM_SLOTS`/`STATS`; F2 is character-only. Design:
```

New:

```
consumes a skin bag item and burns it into `Cosmetics`. `src/ui/MountMenu.js` is generic
over `CUSTOM_SLOTS`/`STATS` and opens from the Esc hub's **Customise mount** item (§3.6);
the hub's **Character** item is character-only. Design:
```

Also retitle the paragraph's lead: **Mount customisation (F10, added 2026-08-17)** → **Mount customisation (added 2026-08-17)** (`:205`).

`CONTRACTS-V3.md` §3.6 — append to the numbered list under `### 3.6 UX`:

```
5. **Esc pause hub.** `Esc` opens the HUD pause overlay as a menu; `F1` (help) is the only
   surviving function key and `Input.RESERVED_CODES` (exported, `Escape`/`F1`–`F12`/`Tab`)
   keeps the rest unbindable. `src/ui/PauseMenu.js` owns the list widget (pure
   `PauseMenuModel` + DOM `PauseMenu` + `PAUSE_MENU_IDS`); `src/ui/pause-menu.css` is
   `<link>`ed from `index.html` beside `hud.css`. **`main.js` owns the item data** — HUD
   knows no panel names. HUD owns `this._overlays`, a `Set` of panel ids fed by
   `race:menu`, `minigame:menu`, `hud:block.id`, `ui:modal.id`, `audio:menu`,
   `bug-report:*`, `character:*`, `inventory:*`, `keybinds:*`, `mount:menu:*`; an id is
   present iff that module has a cursor-owning sheet on screen, and any panel that takes
   the cursor **must** join it or the hub will not come back when it closes. `HelpMenu` is
   the one exception: it keeps pointer lock, stays out of the Set, and opens over the hub.
   `openFromHub` / `_hubReturn` / `_deferHubCheck` own the return path; the empty-Set
   transition is deferred one microtask so a same-tick close→open hand-off is not read as
   "everything closed". Fullscreen is a persisted `Input.fullscreenPreferred`
   (`localStorage['aether:fullscreen']`), honoured by `requestLock`.
```

- [ ] **Step 11: Verify** — `npm test && npm run build` → all green.

- [ ] **Step 12: Commit**

```bash
git add docs/superpowers/specs/2026-08-17-pause-menu-hub-design.md CONTRACTS-V3.md
git commit -m "Docs: Esc pause hub shipped; contracts note for the overlay Set and hub return

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
