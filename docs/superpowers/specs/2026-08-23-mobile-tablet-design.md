# Phase 5 — Mobile / tablet · design (items 1, 2, 4)

**Branch:** `mobile-tablet` (worktree). **Roadmap:** §Phase 5.
**Scope:** items **1** (break the pointer-lock dependency), **2** (a real touch scheme) and
**4** (a low-end renderer tier). **Item 3 — the responsive HUD/CSS rewrite — is deliberately
NOT in this branch**: it conflicts with Phase 4 over `hud.css` / `HUD.js`, and a Phase 4 agent
is live. Item 5 (cross-device state) belongs to Phase 2.

**File boundary honoured here:** `src/ui/hud.css` is not touched. `src/ui/HUD.js` is not
restructured. `src/main.js` gets four localised edits. Everything else this phase needs lives
in new files.

---

## 1. What is actually broken

Read out of the tree, not assumed:

| | Fact | Evidence |
|---|---|---|
| a | The boot tap calls `input.requestLock()`, which calls `canvas.requestPointerLock?.()`. On iOS Safari the method does not exist, so `p` is `undefined` and nothing rejects. | `src/main.js:2349`, `src/core/Input.js:200` |
| b | `HUD._requestLock` then arms `_lockWait = LOCK_CONFIRM_S`; when the confirmation never arrives `_lockRefused()` runs, which calls `showPauseOverlay(true)` and schedules `LOCK_TRIES` more attempts. | `src/ui/HUD.js:2340-2392` |
| c | `pointerlockchange` never fires, so `main.js`'s handler never runs and **`standby` is never added to `gameplayUiBlocks`**. The world simulates behind the card. | `src/main.js:2184-2191` |
| d | `.pause.show` is a full-screen element with a `mousedown` handler, so it owns pointer events over the canvas. | `src/ui/HUD.js:1293-1299` |
| e | There is no touch look, move, fire, jump or interact anywhere in `src/`. | repo-wide |

The single load-bearing sentence: **`standby` is derived from `input.locked`, and on a
touch device `input.locked` can never become true.**

## 2. The mechanism, and why it is not simply disabled

`standby` exists so the world cannot simulate behind a menu — a player who opens the
inventory must not be shot while reading it. Removing it, or special-casing it off for touch,
would trade one silent-simulation bug for another.

So the fix is **not** to weaken the block. It is to widen what counts as *engaged*:

> The pointer lock was never the requirement. It was a **proxy** for "the player has handed
> the canvas their input". A touch session hands the canvas its input by putting a thumb on
> an on-screen stick; that is the same fact, arriving through a different API.

`Input` therefore gains a second engagement source and `get locked()` becomes the **union**:

```
get locked() { return this._locked || this._touchEngaged; }
```

`this._locked` — the private field — keeps meaning *pointer lock*, and every place that must
mean pointer lock specifically (the `mousemove` handler, `requestPointerLock`,
`document.exitPointerLock`) keeps reading it. Everything that means *is the player playing*
reads the getter, which is what all thirteen existing call sites already do:

- `main.js:2056` `setGameplayBlocked('standby', … !input.locked)` — the block itself
- `HUD.js` ×5 — the retry loop's guards, so the PAUSED card and every retry stand down
- `menuFocusIn`, `CharacterMenu`, `KeybindMenu`, `MazeMap`, `MountMenu`, `ShipMenu`,
  `RaceUI` — "was the player playing before this panel opened", so the relock-on-close path
  works on touch with no change

**This is why the fix is one getter and not a rewrite.** Desktop behaviour is untouched:
`_touchEngaged` is only ever set on a device that has told us it is being touched, and
`pointerlockchange` still drives the desktop path exactly as before.

`requestLock()` and `exitLock()` become the two symmetric doors:

- `requestLock()` — in touch mode, engage touch (synchronously, no promise, no retry).
  Otherwise the existing pointer-lock + fullscreen + `navigator.keyboard.lock` path, byte
  for byte.
- `exitLock()` — releases *both*, so a panel that stands the player down stands them down on
  either device.

Both emit `input:lockchange`, which is the event `main.js` and `HUD` already listen to. No
new event has to be plumbed to un-block gameplay.

### Deciding "touch mode"

Two triggers, because two different families are broken in two different ways:

1. **Pointer lock is absent** (`typeof document.exitPointerLock !== 'function'`) — iOS
   Safari. Latched at construction.
2. **A `pointerdown` with `pointerType === 'touch'`** — Android Chrome *does* implement
   pointer lock, so detection-by-absence would leave it on the desktop path with no
   on-screen controls. Sensed on `window` in the capture phase, which is early enough that
   the boot card's own `click` handler already sees touch mode set.

A subsequent `pointerdown` with `pointerType === 'mouse'` leaves touch mode again, so a
tablet with a keyboard/trackpad attached mid-session goes back to pointer lock. The
transition emits `input:touchmode` so the on-screen layer can show and hide itself.

`navigator.keyboard.lock` and `requestFullscreen` are **not** attempted in touch mode: iOS
Safari implements neither on `documentElement`, and a rejected fullscreen promise on the
boot tap is exactly the swallowed-rejection shape this phase exists to remove.

## 3. The touch scheme (item 2)

New file `src/ui/TouchControls.js` + `src/ui/touch.css` (a new stylesheet — `hud.css` is off
limits this phase and this layer wants none of it).

**One rule governs the whole design: a touch control drives the game through the same input
path a key or a mouse button does.** No control reaches into a subsystem.

| Control | Path into the game |
|---|---|
| Look drag (right half of the screen) | `input.applyLook(dx, dy)` → `state.lookX/lookY`, the same accumulator `mousemove` writes and `consumeLook()` drains |
| Virtual stick (left) | `input.setMoveAxis(f, r)` → folded into `state.forward` / `state.right` by `_syncAxes` alongside the keys |
| Fire / Aim | `input.setPointerButton('fire'\|'aim', down)` → `state.fire` / `state.aim`, the flags `mousedown` sets |
| Every other verb | a **synthesised `KeyboardEvent`** dispatched on `window` |

The last row is the important one. The game reads keys through *two* channels — `Input`'s own
`keydown` listener (which feeds `pressed()`, `held()` and `_syncAxes`) and half a dozen
panels that bind their own capture-phase `keydown` because `Input` stops reporting while they
are open (`HelpMenu`, `MountWheel`, `MazeMap`, `KeybindMenu`, `ChatBox`). A touch button that
poked `Input._keys` directly would work for the first channel and be invisible to the second,
so `M` would open the mount wheel and then not be able to close it. Dispatching a real
`KeyboardEvent` feeds both, and feeds them through the *same* code a physical key does — which
is also the only version of this that a gate can honestly measure.

Buttons resolve through `input.codeFor(action)` where an action is rebindable, so a rebind
moves the touch button with it.

### The verb set

`HelpMenu.js` is the canonical list (~30 verbs). Covered, and why:

- **Always on screen** — stick (walk/strafe/throttle/roll), look pad, Fire, Aim, Jump,
  Crouch, Interact, Reload, Sprint, Pause. These are the verbs a player needs in the second
  they need them.
- **In a tray** (one tap to open, one to pick) — Inventory, Marketplace, Quest board, Chat,
  Map/mount wheel, Camera, Dismount, Transit drive, Airbrake, Unstuck, Help, weapons 1-4.
  These are all verbs a player chooses to use, not verbs that save them.
- **Not given a button** — nothing. `[` `]` minimap zoom and the abandon hold are in the tray
  and on the pinch/hold gestures respectively.

Sprint and Aim are **toggles** on touch and holds on desktop, because a thumb that must stay
down cannot also be on the stick. Crouch is a hold, because five systems read it as a
momentary action (dive, roll, wall-release, swim down, fly down) and a latched crouch is a
dive that never ends — the reason `Input` already refuses to make crouch a toggle.

### MountWheel

`MountWheel._move` integrates `e.movementX/Y`, which is a pointer-lock-only quantity. It is
refactored to `_integrate(dx, dy)` with two feeders: the existing `mousemove`, and a new
`input:look` bus subscription that `applyLook` emits. The wheel's dead zone, clamp and sector
arithmetic are untouched — the drag *is* the same gesture, arriving as a different delta.

## 4. The low-end renderer tier (item 4)

New file `src/gfx/QualityTier.js` — pure, node-importable, no DOM at module scope.

Today's shipped settings and what `low` does to them:

| | high (today) | medium | low |
|---|---|---|---|
| Scene MSAA | 4× | 2× | **0** |
| GTAO | on | **off** | off |
| Light shafts | on | on | **off** |
| Bloom | on | on | **off** |
| SMAA | on | on | **off** |
| Film grain | on | on | off |
| Shadows | 2048 | 1024 | **off** |
| Far plane | 2000 m | 1400 m | **900 m** |
| Max pixel ratio | 2 | 1.5 | **1** |
| Resolution floor | 0.8 | 0.7 | **0.5** |

GTAO first, because it is measured at 373-828 draw calls and 40-46% of the frame. The
resolution floor is the second-largest lever and the note that raised it to 0.8
(`Engine._adaptResolution`) argues from MSAA quality — an argument that does not apply once
MSAA is 0, which is exactly what `low` does.

Two of these can only be applied **at boot**: MSAA lives on the composer's render target, and
`shadowMapSize` is compiled into the shadow map when the rig is built. The tier is therefore
resolved *before* `new Engine(...)` and `createPostFX(...)`, and a mid-session change says so
("takes effect on reload") rather than pretending. Everything else — the five PostFX passes,
pixel ratio, resolution floor, camera far plane, `shadowMap.enabled` — applies live.

Detection: `deviceMemory`, `hardwareConcurrency`, and coarse-pointer/touch. A stored player
choice always wins over detection. UI is one `keepOpen` row in the Esc hub's System group,
cycling low → medium → high → auto; that is data in `main.js`'s existing
`setPauseMenuItems` array and needs no HUD or CSS work, so the roadmap's "add a Graphics
section" lands here rather than in the rebase.

## 5. What this branch deliberately leaves for the HUD rebase

- **All of item 3.** 875 hardcoded px, no breakpoint under 1280, the 731 px weapon strip, the
  444 px pause card, `env(safe-area-inset-*)`, `dvh`, orientation, `viewport-fit=cover`.
- **The PAUSED card at phone width.** Touch now *reaches* it correctly (it goes up only when
  the player actually stands down, and gameplay is genuinely blocked behind it) but it is
  still a 444 px desktop card.
- **The touch layer's own responsive polish.** `touch.css` uses `dvh`, `env(safe-area-inset-*)`
  and 44 px minimum targets for its own controls, which is self-contained; it does not try to
  fix the HUD underneath it.

## 6. Gates

Every one of these fails before the change and passes after (verified by reverting the fix):

1. `input.locked` is false, and `input:lockchange` is never emitted, when `requestLock()`
   runs against a canvas with no `requestPointerLock` — i.e. the exact iOS shape. **This is
   the defect.**
2. `exitLock()` disengages touch and emits `lockchange {locked:false}` — the standby block
   goes back on when a panel opens.
3. `applyLook` accumulates into the same `state.lookX/lookY` `consumeLook()` drains, and is
   not gated on pointer lock.
4. `setMoveAxis` survives a keyboard `_syncAxes()` pass.
5. A synthesised `KeyboardEvent` for a rebound action reaches `pressed()` under the *rebound*
   code, not the shipped one.
6. `MountWheel` selects a sector from bus-delivered look deltas with no `movementX` anywhere.
7. `low` disables GTAO, and `applyTier` writes the flags `PostFX.setQuality` accepts.
8. Detection puts a 4-core / 4 GB coarse-pointer device on `low` and a desktop on `high`.
9. Every touch button's code resolves to a real `BINDABLE` action or a real handler — no
   button advertises a verb the build does not answer.

Plus the standing gates: `npm test` (2,628), `node scripts/contract-check.mjs` (114/114),
`npm run build`, and a Playwright device-emulation session on a fresh port proving a
touch-only boot reaches a playable state while the desktop pointer-lock path is unchanged.

---

## 7. Outcome — what the browser found that the code review did not

Three defects were found by playing a touch session, not by reading anything. All three are
recorded because each is the same shape: **a mechanism that is correct in isolation and
unreachable in place.**

**1. `#ui-root { pointer-events: none }` makes a `div` deaf.** hud.css opts `button`, `input`,
`textarea` and `.interactive` back in — nothing else. The look pad and the virtual stick are
divs, so they received nothing at all while every button worked perfectly. Measured: **37 of
45 probe points across the screen fell through to the document.** One declaration
(`pointer-events: auto` on `.touch-look`) fixed it. A touch layer whose buttons work and whose
look and move do not is exactly the failure that reads as "touch is broken", and it was one
line deep.

**2. A closed panel was eating taps across the whole viewport.** `.aud` hides itself with
`opacity: 0; pointer-events: none` — but an explicit `pointer-events: auto` on a descendant
beats an inherited `none` from its parent, so the audio panel's buttons stayed hit-testable at
z-index 84 over the entire screen. Under pointer lock this could never matter: a locked
pointer delivers nothing to the DOM. With a finger it does. Fixed with `visibility: hidden`,
which IS inherited and so reaches the subtree. **This bug class exists for every overlay that
hides by opacity, and only touch can see it.**

**3. Six modules re-acquired the pointer behind `Input`'s back.** `InventoryUI.menuFocusOut`,
`CharacterMenu`, `MountMenu`, `ShipMenu`, `MazeMap` and `HUD` each called
`canvas.requestPointerLock()` directly. On a phone that method does not exist, so closing any
of those panels left the player stood down with `standby` still held — **the world frozen,
nothing on screen to explain it, and no way back in.** None of the thirteen unit gates could
see it, because none of them went through a panel. `Input.reengage()` is now the one door and
a source gate refuses any other caller.

### The roadmap's description, checked against the tree

Accurate on every point that mattered: the swallowed rejection, the four-attempt retry, the
never-fired `pointerlockchange`, the missing `standby`, the full-screen card owning pointer
events, `setQuality()` with no UI, and GTAO as the obvious first drop. Two refinements:

- **"`requestLock`, the `standby` block, the PAUSED retry loop, fullscreen and
  `navigator.keyboard.lock` are one interlocked mechanism across `Input.js`, `HUD.js` and
  `main.js`."** True, but the seam is narrower than that reads. Thirteen call sites ask
  `input.locked`, every one means "is the player playing", and widening that one getter
  carried twelve of them for free. `HUD.js` needed fourteen lines; `main.js` needed none.
- **The roadmap does not mention the relock paths** (finding 3), which are the second half of
  item 1 and were the last thing still broken in a live session.

### Measured after

iPhone 13 emulation, real CDP touch events, fresh dev server: 27 controls on screen,
`gameplayUiBlocks` empty, no PAUSED card, a drag turning the view 0.85 rad, the stick walking
the player 4.77 m, fire holding and releasing, a tray panel opening, blocking gameplay and
handing the player back, and the menu button standing the player down into a genuinely frozen
world. Desktop in the same run: touch mode off, layer absent, `standby` still tracking the
pointer lock, 4x MSAA, GTAO on, 2000 m far plane.

Final gates: **2,683 tests green** (2,628 before, 55 added), **contract-check 119/119**,
`npm run build` clean.
