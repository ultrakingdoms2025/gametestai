# Pause Menu Hub (Esc) — Design

**Date:** 2026-08-17
**Status:** Implemented 2026-08-17 (branch `feat/pause-menu-hub`; plan `docs/superpowers/plans/2026-08-17-pause-menu-hub.md` — see its "Spec deviations, declared" header for the twelve shipped deviations)
**Scope:** Replace the F-key sprawl with an Esc-driven pause menu that lists every system panel. One feature; the panels themselves are unchanged apart from their key bindings.

## 1. Problem

System functions live on F-keys (F1 help, F2 character, F3 diagnostics, F4 audio, F5 save, F6 keybinds, F7 race, F8 minigame quit, F9/F12 bug report, F10 mount, Shift+F9 load). Chrome owns several of them (F1 help, F3 find, F5 reload, F6 address bar, F10 menu bar, F11 fullscreen, F12 devtools — the last is un-preventable) and `preventDefault` only helps when the page has focus and the pointer state co-operates. Players hit F11 and get browser fullscreen, F12 and get devtools, F4/F5 and get nothing. The pause card ("STANDBY / click to resume") that appears whenever the pointer unlocks is a dead end.

## 2. Decisions

| Decision | Choice |
|---|---|
| Entry point | **Esc opens the hub.** The hub *is* the existing pause overlay (HUD `.pause`), upgraded from a STANDBY card to a menu. Esc is the one key the browser guarantees (it always exits pointer lock → overlay). |
| Esc while a panel is open | Closes the panel first (as today). If the panel was opened **from the hub**, closing returns to the hub; if opened from gameplay, closing relocks and resumes. |
| Hub on hub | Esc or Space resumes; Enter activates the focused item; ↑/↓ and W/S move; mouse hover/click. |
| Pause | Hub pauses the world exactly as STANDBY does today (`standby` gameplay block on unlock). Panels opened from the hub stay paused (their own blocks). |
| Function keys | **Only F1 (help) survives** as a direct shortcut. F2/F3/F4/F5/F6/F7/F8/F9/F10/F12/Shift+F9 listeners are removed; their functions are hub items. `Input.RESERVED_CODES` (today Escape/F1–F10/Tab) is extended to F11/F12 so all browser keys stay unbindable. Letter keys (I inventory, B market, J quests, M map/mount wheel, T chat, K unstuck, F dismount) unchanged. |
| Market | Not in the hub — it needs a vendor in range; stays on B. |
| Fullscreen | A hub toggle (`requestFullscreen`/`exitFullscreen`), so F11 is never needed. `Input` listens to `fullscreenchange` to keep keyboard lock in step. |
| Quit | Existing "Quit to menu" (navigate to site root) moves into the hub; "Reload" is dropped (Quit + re-enter covers it). |

## 3. Menu

Two groups, rendered as a vertical list in the existing clipped-corner card:

**Play** — Resume · Character · Mount (disabled with hint "Mount up first (M)" unless `mounts.mounted`) · Inventory · Quest board · Map (only when `mapActionOwner(world) === 'map'`) · Race panel (only when `race.ready || race.racing`) · Quit minigame (only when a minigame is running).

**System** — Help & controls · Audio · Keybinds · Fullscreen: On/Off · Diagnostics: On/Off · Save · Load · Report a bug · Quit to menu.

Items are data: `{ id, label: string|()=>string, hint?, enabled?: () => true|string (string = disabled reason), visible?: () => bool, run: () => void, keepOpen?: bool }`. `keepOpen` items (Save, Load, Fullscreen, Diagnostics) act in place and the hub stays up; the others hide the hub and open a panel.

## 4. Architecture

### 4.1 `src/ui/PauseMenu.js` + `src/ui/pause-menu.css` — new, DOM-only, game-agnostic

- `export class PauseMenuModel` — pure logic, no DOM: `setItems(groups)`, `visibleItems()`, `isEnabled(item)` (`enabled` absent → true; returns `true` or the reason string), `focus` index, `move(delta)` (wraps, skips disabled/hidden), `focusFirst()`, `activate()` (calls `run`, returns `!!item.keepOpen`), `labelOf(item)`.
- `export class PauseMenu` — wraps the model with DOM: `new PauseMenu({ root })` builds `div.pm-root` (groups of `button.pm-item` with label + optional hint; the card title and status line stay HUD-owned); `setItems`, `refresh()` (re-evaluates visible/enabled/label; sets `.off`, `.focus`, `title` = disabled reason), `move`, `activate`, `focusFirst`; hover focuses, click activates. `onActivate(item, keepOpen)` callback provided by the host so the host decides whether to hide.
- `export const PAUSE_MENU_IDS` — the §3 id list, used by the source test to check `main.js` covers every id.

### 4.2 `src/ui/HUD.js` — edits only

**Prerequisite — the overlay tracker becomes a `Set` of ids and the single contract.** Today `_overlayOpen/_overlayClose` (local closures inside `_wire()`, `HUD.js:~1197-1233`) keep an integer `_overlayCount` fed by `race:menu`, `hud:block`, `audio:menu`, `bug-report:*`, `character:*`, `inventory:*`, `keybinds:*`, `mount:menu:*` — but **not** by `ui:modal` (MazeMap; nothing listens to it today) or `minigame:menu` (MinigameUI). An integer cannot absorb a double-open (and `MinigameUI._showBoard` has no re-entry guard, so a second `minigame:finished` would leak +1 and — because `showPauseOverlay` refuses while the count is >0 — kill the hub for the session). Step one: replace the integer with `this._overlays = new Set()`; promote to prototype methods `_overlayOpen(id)`, `_overlayClose(id)`, `_schedRelock()`; map events to ids — `character`, `mount-menu`, `inventory`, `quest-board` (from `hud:block.id`), `maze-map` (from `ui:modal.id`), `race`, `minigame`, `audio`, `keybinds`, `bug-report`; `get overlayCount()` returns `this._overlays.size` for the three existing readers (`_syncOverlaid` `~:1208`, the `=== 0` branch of `_overlayClose` `~:1219`, `showPauseOverlay` `~:1580`). Idempotent by construction; a wrong or duplicate emit cannot latch. **Invariant:** an id is present iff that module has a cursor-owning sheet on screen. Per-module keying is safe today only because each multi-sheet module never stacks two sheets: `RaceUI._openStop` refuses unless `race.racing` (`:680`) and `_showBoard`'s only caller closes the stop sheet first (`:254`); `MinigameUI._openStop` guards `this._stopOpen || this._boardOpen` (`:211`). Relaxing any of those must come with per-sheet ids, or a close would produce a non-transient false-empty the microtask cannot repair. **Same-tick hand-offs:** `RaceUI._showBoard` calls `closePanel()` before emitting its own open (`RaceUI.js:745-749`; `race:finished` → `_closeStop(); _showBoard()` `:254`) and `MinigameUI` has the same shape (`:81-83`), so the Set is momentarily empty inside one synchronous sequence. The empty-Set transition in `_overlayClose` (and the post-`run()` check in `openFromHub`) is therefore **deferred one microtask** (`queueMicrotask`) and re-checks `this._overlays.size === 0` before acting — a close→open pair in the same tick never reads as "everything closed", and `_hubReturn` survives it. Key by event `.id` where the event carries one (`hud:block.id`, `ui:modal.id` — each has exactly one emitter today; keying on the id keeps a future second emitter from silently joining the pause contract).

**HelpMenu is deliberately not in the Set** — it keeps pointer lock while open (`HelpMenu.js:9-12`) so it can be read mid-play. HUD gains a `_helpOpen` boolean set from `help:open/close` (**new** — today those handlers only toggle the `helping` CSS class at `~:1188`). Rules: (a) the hub item for Help uses `openFromHub(run, { overlay: false })`, which runs `helpMenu.open()` **without hiding the hub** — Help (z 80) simply sits over the hub (z 60), and closing it leaves the hub visible; (b) `_onPauseKey` ignores keys while `_helpOpen` (Help's own Esc closes Help — otherwise Help's capture handler, registered earlier, closes it and HUD's would then resume in the same keystroke); (c) the Esc-under-lock handler also requires `!this._helpOpen`.

- `_buildPause`: `this.pauseMenu = new PauseMenu({ root: inner, onActivate: (item, keepOpen) => keepOpen ? this.pauseMenu.refresh() : this.openFromHub(item.run) })`; `pause-t` reads "PAUSED"; the old `pause-actions` (Reload/Quit buttons) and `pause-hint` line are removed together with their CSS (`hud.css` `.pause-hint/.pause-actions/.pause-btn*`). `.pause-s` (`pauseSub`) **stays** as the status line — default text "Esc resume · ↑↓ Enter · click"; `_setPauseBusy` keeps overwriting it with retry feedback. The PauseMenu component therefore renders no footer of its own.
- `setPauseMenuItems(groups)` → `pauseMenu.setItems`.
- `showPauseOverlay(true)`: `pauseMenu.refresh()` always; `focusFirst()` **only on the hidden→shown transition** (the `_lockRefused`/`_relockCheck` retry timers call `showPauseOverlay(true)` repeatedly and must not reset the player's focus).
- `_onPauseKey`: Escape/Space → resume (unchanged); ArrowUp/ArrowDown/KeyW/KeyS → `pauseMenu.move(±1)`; Enter → `pauseMenu.activate()`. All `preventDefault` + `stopPropagation`.
- **Esc from gameplay under keyboard lock**: capture-phase window `keydown` — when `code === 'Escape' && !e.repeat && input.locked && this._overlays.size === 0 && !this._helpOpen && !this._chatOpen && !input.textCaptured` → `input.exitLock()`. (Without keyboard lock the browser already exits pointer lock on Esc; with it, Esc reaches the page and today does nothing.)
- Click-to-resume on the card background stays; menu buttons stop propagation.
- `openFromHub(run, { overlay = true } = {})`: with `overlay:false` (Help) just `run()`; otherwise `_hubReturn = true; showPauseOverlay(false); run(); this._deferHubCheck();` — where `_deferHubCheck()` queues **one** microtask (guarded by a `_hubCheckPending` flag so back-to-back calls collapse) that re-checks `this._overlays.size === 0 && this._hubReturn` and, if so, `_hubReturn = false; showPauseOverlay(true)` (the panel refused/opened nothing).
- `_overlayClose(id)`: `this._overlays.delete(id); _syncOverlaid();` then, if the Set is now empty, `_deferHubCheck()` — the same single-microtask re-check: if still empty and `_hubReturn` → `_hubReturn = false; showPauseOverlay(true)`; if still empty and not `_hubReturn` → today's `showPauseOverlay(false)` + `_schedRelock()`; if no longer empty (a same-tick close→open hand-off) → nothing. **Behaviour change, declared:** `_schedRelock()` today runs synchronously on *every* close; it now runs only when the Set is empty after the microtask.
- `_hubReturn` is cleared in a HUD `input:lockchange` listener **guarded on `locked === true`** (not inside `showPauseOverlay(false)`, which `openFromHub` itself calls) — a real relock always wins.
- `_setPauseBusy(false)` hard-writes the status line today (`'click or press Space to resume'`, `~:1732`) — that string becomes "Esc resume · ↑↓ Enter · click"; the busy string is unchanged.
- `HUD._updateInput`'s `this.input.pressed('F5')` branch (`~:1761`, sets `_saveExpectT` for save-toast wording) is replaced by a public `expectSave()` that the hub's Save item calls before `saveAndBackup`.
- The duplicate `HelpMenu` constructed in `HUD.js` (`~:422`, disposed `~:2643`) is deleted — HUD never opens it (the F1 chip has no click handler); no injection needed.

### 4.3 `src/main.js`

- After all panels exist: `hud.setPauseMenuItems([...])` per §3, wired to `characterMenu.open()`, `mountMenu.open()` (enabled: `mounts.mounted ? true : 'Mount up first (M)'`), the inventory open path main.js already uses for `KeyI`, `questSystem.openBoard()`, `mazeMap.open()`, `raceUI.openPanel()`, `bus.emit('minigame:quitRequest')`, `helpMenu.open()`, `audioMenu.open()`, `keybindMenu.open()`, fullscreen toggle (`document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()`, label `Fullscreen: ${input.fullscreenPreferred ? 'On' : 'Off'}` (a preference, not a live readout)), diagnostics toggle (the F3 body; label reflects `CONFIG.debug.showStats`), `save.saveAndBackup('menu')`, `save.loadAnywhere()`, `bugReport.open()`, quit (`window.location.href = origin + '/'`).
- Removes the F3 branch of the window listener (keeps `KeyI` if it shares the handler).
- Panels that open from the hub open while **unlocked** (the hub holds the cursor). `CharacterMenu`/`MountMenu`/`MazeMap`/`InventoryUI` relock only when they *had* the lock, so they return to the hub cleanly. `KeybindMenu.close()` relocks unconditionally today → capture `_hadLock` in `open()` and guard. `AudioMenu`/`BugReport`/`QuestBoard`/`RaceUI` rely on HUD's `_schedRelock`; `MinigameUI`/`MazeMap` join the Set via §4.2's prerequisite — after which all of them route back to the hub through `_overlayClose`. `HelpMenu` is the exception (§4.2): it opens over the visible hub and never enters the Set.
- **Fullscreen preference.** `Input.requestLock()` unconditionally requests fullscreen today (`Input.js:168-176`), which would undo a "Fullscreen: Off" the moment the player resumes. Add `input.fullscreenPreferred` (default `true`, persisted in `localStorage['aether:fullscreen']`); `requestLock()` requests fullscreen only when it is true (its sibling `else if (document.fullscreenElement) this._lockKeyboard()` branch, `Input.js:174-176`, is kept unconditionally — a player who is fullscreen anyway still gets keyboard lock); the hub item flips it and calls `requestFullscreen`/`exitFullscreen` accordingly. Label reads the preference, not the DOM (`requestFullscreen` resolves asynchronously): `Fullscreen: ${input.fullscreenPreferred ? 'On' : 'Off'}`. **Trade-off, disclosed in the item hint**: `navigator.keyboard.lock()` only works in fullscreen, so "Off" hands Ctrl+W (crouch-walk!) back to the browser — hint (one string): "Applies when you resume. Off gives Ctrl+W back to the browser; the save prompt still guards it" (`SaveGame`'s `beforeunload` remains).

### 4.4 Key removals (each keeps its Esc-to-close)

`CharacterMenu` F2 · `MountMenu` F10 · `AudioMenu` F4 · `KeybindMenu` F6 · `BugReport` F9/F12 · `SaveGame` F5 & Shift+F9 (the `beforeunload` guard and Ctrl+F5 pass-through untouched) · `RaceUI` F7 · `MinigameUI` F8 · `main.js` F3. `HelpMenu` keeps F1.

### 4.5 `src/core/Input.js`

- `document.addEventListener('fullscreenchange', …)`: entering → `relockKeyboard()` (existing helper) if pointer-locked; leaving → `_unlockKeyboard()`.
- `RESERVED_CODES` (today `Escape, F1..F10, Tab`, module-private) → **exported** and extended with `F11`, `F12`.
- `fullscreenPreferred` getter/setter per §4.3.

### 4.6 Discoverability text

- Boot card (`HUD._patchBootControls`, `~:1368-1416`): every F-row except F1 replaced by one row `['Esc', 'Pause menu — character, mount, inventory, settings, save…']`.
- HelpMenu: System group → `Esc — Pause menu (everything below is in it)`, `F1 — This panel`; the F2/F4/F5/F6/F7/F9/F10/F12/Shift+F9 rows go. Camera group (`~:65-72`): `F3 — Diagnostics overlay` → "Diagnostics — in the Esc menu"; `Esc — Release the mouse cursor` → `Esc — Pause menu`.
- `KeybindMenu.FIXED_KEYS` array: `Esc — Pause menu`, `F1 — Help`, letter keys as today (add the missing `M`); the one prose note (`~:167`) reads "Fixed keys (Esc, F1 and the letter keys J I B M K) cannot be rebound; F2–F12 are left to the browser."
- In-panel key labels that would advertise dead keys: `CharacterMenu.js:~213` ("F2 close" → "Esc close"), `MountMenu.js:~91` ("F10 close" → "Esc close"), `AudioMenu.js:~79` ("F4 or Esc to close" → "Esc to close"), `RaceUI.js:~381-382` ("Close (F7 or Esc)" → "Close (Esc)") and `~:817` ("Enter, or F7 for options" → "Enter to start, Esc for options"), `MinigameUI.js:~126` ("E or F8 to quit" → "E or Esc to quit"), `BugReport.js:~80` ("(F9 / F12)" → "(Esc menu → Report a bug)"), `HUD.js:~834` diagnostics header `<i>F3</i>` → `<i>Esc menu</i>`.
- `src/ai/ChatClient.js:~360` and `site/app/api/chat/route.ts:~114` control text: "F2"/"F10" → "the Esc menu".
- Pause card status line (`.pause-s`): "Esc resume · ↑↓ Enter · click".

## 5. Edge cases

- Chat open: Esc goes to chat as today; hub never shows over chat (existing `_chatOpen` guard).
- Dev harness (`devGameplayDriven`): overlay suppression unchanged.
- Hub item whose panel refuses to open (QuestBoard `_openGuard`, Race panel guard) → `openFromHub`'s post-run check re-shows the hub.
- Panel opened from the hub, then the player relocks by another path (canvas click) → `input:lockchange locked` → overlay hidden and `_hubReturn` cleared.
- World change while the hub is up (portal reached with the menu open cannot happen — the world is paused; a load from the hub that changes world goes through `SaveGame`, which handles its own panels): the hub simply follows lock state.
- Help open during locked gameplay + Esc: HUD's Esc-under-lock handler requires `!_helpOpen`, so it is inert and Help's own Esc closes it; no hub. Help opened *from the hub* sits over the still-visible hub; closing it reveals the hub.
- Holding Esc (how browsers break keyboard lock): `e.repeat` is ignored by the HUD handler.
- Browser-driven fullscreen exit (Esc in some browsers exits fullscreen and pointer lock together): `fullscreenchange` unlocks keyboard; hub shows via lockchange as usual. The Fullscreen item is a **preference** (`fullscreenPreferred` is untouched by a browser-driven exit), so it may read "On" while windowed until the next resume re-enters fullscreen — accepted; the item hint's first sentence says so.
- Load from the hub: `loadAnywhere()` may summon a mount / move the player; hub stays (keepOpen) and refreshes.

## 6. Tests

- `scripts/tests/pause-menu.test.mjs` (headless, `PauseMenuModel`): `enabled` returning a string disables with that reason; `visible:false` items skipped; `move()` wraps and skips disabled/hidden; `activate()` runs the item and returns `keepOpen`; label functions re-evaluate.
- HUD flow (`Object.create(HUD.prototype)` + minimal fields, `showPauseOverlay`/`_schedRelock` stubbed — possible because the prerequisite promotes them to methods; await a microtask after each step): `_overlayClose` to 0 with `_hubReturn` → re-show, no relock; without → relock; `openFromHub` whose `run` opens nothing → re-show.
- **Hand-off test with a fake bus** (the one that would catch a panel outside the counter): a real `HUD` cannot be built headlessly, so a stub with the real `_overlayOpen/_overlayClose/openFromHub/_wireOverlayEvents` methods and a tiny EventBus replays each Set-tracked panel's *actual* open/close event pair (`character:open/close`, `mount:menu:open/close`, `inventory:open/close`, `hud:block {id:'quest-board'}`, `ui:modal {id:'maze-map'}`, `race:menu`, `minigame:menu`, `audio:menu`, `keybinds:open/close`, `bug-report:open/close`) and asserts (awaiting a microtask after each step): after `openFromHub` + open event the overlay is hidden and the Set has one id; after the close event the overlay is re-shown and `_schedRelock` was not called. Help case: `openFromHub(run, {overlay:false})` + `help:open` → hub still shown, Set empty, `_helpOpen` true; `help:close` → unchanged. Same-tick hand-off case: `race:menu {open:false}` immediately followed by `race:menu {open:true}` in one synchronous sequence → after the microtask the hub is still hidden and `_hubReturn` still true.
- Source-text guards (comments stripped before matching — `//…` and `/*…*/` removed): (a) `PAUSE_MENU_IDS` ⊆ ids present in `main.js`'s item list (regex `id: '<id>'`); (b) no `code === 'F<n>'`, `'F<n>'` inside a `[...]` key list, or `pressed('F<n>')` for n ∈ 2..12 remain in `src/` outside the exported `RESERVED_CODES` literal in `Input.js`; (c) none of these exact UI strings remain in `src/` or `site/app/api/chat/route.ts`: `el('b', null, 'F2')`, `el('b', null, 'F10')`, `el('b', null, 'F4')`, `F7 or Esc`, `F7 for options`, `F8 to quit`, `F9 / F12`, `el('i', null, 'F3')`, `F2 opens`, `F10 does`, and in `site/app/api/chat/route.ts`: `F2 customizes the character`, `F10 customizes the mount`.
- Latch assertion in the hand-off test: replay `minigame:menu {open:true}` twice then `{open:false}` once → the Set is empty and `showPauseOverlay(true)` shows (an integer counter would have latched).
- Browser smoke: Esc from gameplay → hub; each item → its panel; Esc → back to hub; Resume → relocked; Save/Load toast; Fullscreen label toggles; on-foot Mount item disabled with tooltip; keyboard-only navigation.

## 7. Out of scope

Radial quick-menu (Tab-hold), gamepad input, an in-app title screen, changes to any panel's contents.
