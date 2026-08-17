# Pause Menu Hub (Esc) — Design

**Date:** 2026-08-17
**Status:** Approved in brainstorming; awaiting spec review
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
| Function keys | **Only F1 (help) survives** as a direct shortcut. F2/F3/F4/F5/F6/F7/F8/F9/F10/F12/Shift+F9 listeners are removed; their functions are hub items. `Input.RESERVED_CODES` keeps Escape/F1–F12/Tab unbindable (browser keys). Letter keys (I inventory, B market, J quests, M map/mount wheel, T chat, K unstuck, F dismount) unchanged. |
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
- `export class PauseMenu` — wraps the model with DOM: `new PauseMenu({ root })` builds `div.pm-root` (title "PAUSED", groups of `button.pm-item` with label + optional hint, footer "Esc resume · ↑↓ Enter · click"); `setItems`, `refresh()` (re-evaluates visible/enabled/label; sets `.off`, `.focus`, `title` = disabled reason), `move`, `activate`, `focusFirst`; hover focuses, click activates. `onActivate(item, keepOpen)` callback provided by the host so the host decides whether to hide.
- `export const PAUSE_MENU_IDS` — the §3 id list, used by the source test to check `main.js` covers every id.

### 4.2 `src/ui/HUD.js` — edits only

- `_buildPause`: `this.pauseMenu = new PauseMenu({ root: inner, onActivate: (item, keepOpen) => keepOpen ? this.pauseMenu.refresh() : this.openFromHub(item.run) })`; `pause-t` reads "PAUSED"; the old `pause-actions` (Reload/Quit buttons) and the `pause-hint` line are removed.
- `setPauseMenuItems(groups)` → `pauseMenu.setItems`.
- `showPauseOverlay(true)` also calls `pauseMenu.refresh()` + `focusFirst()`.
- `_onPauseKey`: Escape/Space → resume (unchanged); ArrowUp/ArrowDown/KeyW/KeyS → `pauseMenu.move(±1)`; Enter → `pauseMenu.activate()`. All `preventDefault` + `stopPropagation`.
- **Esc from gameplay under keyboard lock**: capture-phase window `keydown` — when `code === 'Escape' && input.locked && _overlayCount === 0 && !_chatOpen && !input.textCaptured` → `input.exitLock()`. (Without keyboard lock the browser already exits pointer lock on Esc; with it, Esc reaches the page and today does nothing.)
- Click-to-resume on the card background stays; menu buttons stop propagation.
- `openFromHub(run)`: `_hubReturn = true; showPauseOverlay(false); run();` then, if `_overlayCount === 0` (the panel refused/opened nothing) → `_hubReturn = false; showPauseOverlay(true)`.
- `_overlayClose`: when the count reaches 0 → if `_hubReturn` { `_hubReturn = false; showPauseOverlay(true)` } else `_schedRelock()` (today's behaviour). `_overlayOpen` unchanged.
- `input:lockchange {locked:true}` path (main.js calls `showPauseOverlay(false)`) also clears `_hubReturn` — a real relock always wins.
- The duplicate `HelpMenu` constructed in `HUD.js` (~`:422`) is removed; HUD's F1 affordance emits `help:toggle`-equivalent by calling the injected `helpMenu` (main.js sets `hud.helpMenu = helpMenu`), so exactly one HelpMenu exists.

### 4.3 `src/main.js`

- After all panels exist: `hud.setPauseMenuItems([...])` per §3, wired to `characterMenu.open()`, `mountMenu.open()` (enabled: `mounts.mounted ? true : 'Mount up first (M)'`), the inventory open path main.js already uses for `KeyI`, `questSystem.openBoard()`, `mazeMap.open()`, `raceUI.openPanel()`, `bus.emit('minigame:quitRequest')`, `helpMenu.open()`, `audioMenu.open()`, `keybindMenu.open()`, fullscreen toggle (`document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()`, label `Fullscreen: ${document.fullscreenElement ? 'On' : 'Off'}`), diagnostics toggle (the F3 body; label reflects `CONFIG.debug.showStats`), `save.saveAndBackup('menu')`, `save.loadAnywhere()`, `bugReport.open()`, quit (`window.location.href = origin + '/'`).
- Removes the F3 branch of the window listener (keeps `KeyI` if it shares the handler).
- Panels that open from the hub open while **unlocked** (the hub holds the cursor). `CharacterMenu`/`MountMenu`/`MazeMap`/`InventoryUI` relock only when they *had* the lock, so they return to the hub cleanly. `KeybindMenu.close()` relocks unconditionally today → capture `_hadLock` in `open()` and guard. `AudioMenu`/`BugReport`/`QuestBoard`/`RaceUI`/`MinigameUI` rely on HUD's `_schedRelock`, which §4.2 now routes back to the hub.

### 4.4 Key removals (each keeps its Esc-to-close)

`CharacterMenu` F2 · `MountMenu` F10 · `AudioMenu` F4 · `KeybindMenu` F6 · `BugReport` F9/F12 · `SaveGame` F5 & Shift+F9 (the `beforeunload` guard and Ctrl+F5 pass-through untouched) · `RaceUI` F7 · `MinigameUI` F8 · `main.js` F3. `HelpMenu` keeps F1.

### 4.5 `src/core/Input.js`

- `document.addEventListener('fullscreenchange', …)`: entering → `_lockKeyboard()` if pointer-locked; leaving → `_unlockKeyboard()`.
- `RESERVED_CODES` = `Escape, F1..F12, Tab` (adds F11, F12).

### 4.6 Discoverability text

Boot card (`HUD._patchBootCard`): every F-row except F1 replaced by one row `['Esc', 'Pause menu — character, mount, inventory, settings, save…']`. HelpMenu System group: `Esc — Pause menu (everything below is in it)`, `F1 — This panel`; the F2/F4/F5/F6/F7/F9/F10/F12/Shift+F9 rows go. `KeybindMenu.FIXED_KEYS`: `Esc — Pause menu`, `F1 — Help`, letter keys as today; note: "Fixed keys (Esc, F1 and the letter keys J I B M K) cannot be rebound; F2–F12 are left to the browser." `ChatClient` and `site/app/api/chat/route.ts` control text: "F2"/"F10" → "the Esc menu". Pause card footer: "Esc resume · ↑↓ Enter · click".

## 5. Edge cases

- Chat open: Esc goes to chat as today; hub never shows over chat (existing `_chatOpen` guard).
- Dev harness (`devGameplayDriven`): overlay suppression unchanged.
- Hub item whose panel refuses to open (QuestBoard `_openGuard`, Race panel guard) → `openFromHub`'s post-run check re-shows the hub.
- Panel opened from the hub, then the player relocks by another path (canvas click) → `input:lockchange locked` → overlay hidden and `_hubReturn` cleared.
- World change while the hub is up: panels close on `world:changing`; the hub follows lock state.
- Browser-driven fullscreen exit: `fullscreenchange` unlocks keyboard; hub shows via lockchange as usual; label refreshes on next `showPauseOverlay`.
- Load from the hub: `loadAnywhere()` may summon a mount / move the player; hub stays (keepOpen) and refreshes.

## 6. Tests

- `scripts/tests/pause-menu.test.mjs` (headless, `PauseMenuModel`): `enabled` returning a string disables with that reason; `visible:false` items skipped; `move()` wraps and skips disabled/hidden; `activate()` runs the item and returns `keepOpen`; label functions re-evaluate.
- HUD flow (`Object.create(HUD.prototype)` + minimal fields, `showPauseOverlay`/`_schedRelock` stubbed): `_overlayClose` to 0 with `_hubReturn` → re-show, no relock; without → relock; `openFromHub` whose `run` opens nothing → re-show.
- Source-text guards: (a) `PAUSE_MENU_IDS` ⊆ ids present in `main.js`'s item list (regex `id: '<id>'`); (b) no `code === 'F<n>'` / `['F<n>'` key checks for n ∈ 2..12 remain in `src/` outside `Input.RESERVED_CODES` and comments.
- Browser smoke: Esc from gameplay → hub; each item → its panel; Esc → back to hub; Resume → relocked; Save/Load toast; Fullscreen label toggles; on-foot Mount item disabled with tooltip; keyboard-only navigation.

## 7. Out of scope

Radial quick-menu (Tab-hold), gamepad input, an in-app title screen, changes to any panel's contents.
