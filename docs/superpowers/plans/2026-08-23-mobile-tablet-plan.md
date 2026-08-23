# Phase 5 — Mobile / tablet · implementation plan (items 1, 2, 4)

Design: `../specs/2026-08-23-mobile-tablet-design.md`.
Every task is red-first: write the gate, watch it fail for the stated reason, then build.

---

### Task 1 — Engagement without pointer lock (`src/core/Input.js`)

**Gate first** — `scripts/tests/touch-engage.test.mjs`:
- `requestLock()` on a canvas with no `requestPointerLock` emits nothing and leaves
  `locked` false. *(fails after the fix is written; before it, it is the assertion that
  documents the iOS shape — so it is written the other way round: assert the FIXED
  behaviour, watch it fail, then build.)*
- After the fix: touch mode → `requestLock()` → `input:lockchange {locked:true}` and
  `locked === true`, with `requestPointerLock` never called.
- `exitLock()` → `{locked:false}`.
- Desktop (pointer lock present, no touch seen) → `requestPointerLock` IS called and
  `locked` stays false until `pointerlockchange`. **This is the "does not weaken desktop"
  gate.**

**Build:**
1. `_touchEngaged`, `_touchMode`, `get locked()` as the union, `get touchMode()`.
2. `setTouchMode(on)` — emits `input:touchmode`; disengages on the way out.
3. `_setTouchEngaged(on)` — emits `input:lockchange`.
4. `requestLock()` — touch branch first; desktop branch unchanged.
5. `exitLock()` — releases both.
6. Window capture `pointerdown` sniffer; `pointerLockSupported()` at construction.

### Task 2 — Touch input surface (`src/core/Input.js`)

**Gate first** — same file:
- `applyLook(dx,dy)` accumulates into `state.lookX/lookY`, scaled by touch sensitivity, not
  gated on `_locked`, and emits `input:look`.
- `setMoveAxis(f,r)` survives a subsequent `_syncAxes()`.
- `setPointerButton('fire',true)` sets `state.fire`; `_resetAxes()` clears it.
- `setTextCapture(true)` / `setEnabled(false)` clear the touch axis too — otherwise a stick
  held when a panel opens walks the player through the menu.

**Build:** the four methods plus the `_touchF/_touchR` fold in `_syncAxes`.

### Task 3 — MountWheel touch path (`src/ui/MountWheel.js`)

**Gate first** — `scripts/tests/touch-mountwheel.test.mjs`: drive the real prototype with a
stubbed DOM shell; feed deltas through the bus; assert the selected sector. Fails today
because nothing subscribes to `input:look`.

**Build:** extract `_integrate(dx,dy)` from `_move(e)`; subscribe to `input:look`;
unsubscribe in `dispose`.

### Task 4 — The on-screen layer (`src/ui/TouchControls.js`, `src/ui/touch.css`)

**Gate first** — `scripts/tests/touch-controls.test.mjs`:
- The exported `TOUCH_ACTIONS` table's every `code` is either a `BINDABLE` shipped code or a
  code some `src/` file provably handles (source-scanned, like the existing
  "no UI string advertises a key the build no longer answers" gate). No dead buttons.
- Every verb group in `HelpMenu.GROUPS` that a phone player needs is represented.
- `_press` on a rebound action dispatches the **rebound** code.
- Held buttons emit down then up; tap buttons emit both.

**Build:** the table, the DOM, the stick maths, the look pad, the tray. Shows itself on
`input:touchmode`.

### Task 5 — Quality tiers (`src/gfx/QualityTier.js`)

**Gate first** — `scripts/tests/quality-tier.test.mjs`: tier table shape, `low` kills GTAO,
detection, persistence, and `applyTier` against a recording stub of the real
`PostFX.setQuality` / `Engine` / `renderer` surfaces.

**Build:** table, `detectTier`, `resolveTier`, `loadTierId`/`saveTierId`, `applyTier`,
`applyBootTier` (mutates `CONFIG.render` before `new Engine`).

### Task 6 — Wiring (`src/main.js`, `src/gfx/PostFX.js`, `src/ui/PauseMenu.js`)

`main.js`, four localised edits:
1. `applyBootTier()` immediately after `applyUrlOverrides()`, before `new Engine`.
2. `new TouchControls({...})` beside the other UI constructions.
3. `applyTier(...)` after `engine.postfx = createPostFX(engine)`.
4. one `graphics` row in the System group of `setPauseMenuItems`.

`PostFX.js`: `MSAA_SAMPLES` falls back to the resolved tier's `msaa` when `?msaa=` is absent.
`PauseMenu.js`: `'graphics'` joins `PAUSE_MENU_IDS`.

### Task 7 — Verification

`npm test`, `node scripts/contract-check.mjs`, `npm run build`; then Playwright on a **fresh
port** with iPhone emulation for the touch session and a desktop context for the pointer-lock
regression. Revert each fix in turn and confirm only its own gate goes red.
