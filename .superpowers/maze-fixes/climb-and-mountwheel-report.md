# Maze-world fixes: sustained wall climbing and the mount wheel

## Bug 1 — `FreeClimb` was never gated

`Player.js` gates the one-shot ledge mantle (`climb.tryStart`, line ~657) and
`Parkour.fixedUpdate` (line ~564) on `allows(this._world, ...)`, but the
sustained wall-climb system, `FreeClimb`, had **two** ungated entry points
that let a player scale a maze hedge:

- **`freeClimb.fixedUpdate(dt, elapsed)`** (was line 571) — the block that
  drives an in-progress climb every frame and claims the movement step. Fixed
  by short-circuiting the whole `if` on `allows(this._world, 'climb') &&`, so
  the gate skips the block entirely rather than just the call (the block
  writes the capsule directly and returns early, so calling it partway
  through would still let the climb continue).
- **`freeClimb.tryAttach()`** (was line 682) — the entry point that actually
  *starts* a climb when the player holds jump into a wall. This one was not
  mentioned by line number in the task but is just as real a leak: gating
  only `fixedUpdate` would have let a player in the maze still grab a hedge
  and cling to it for one frame, and since the continuation call is gated the
  climb state (`_active = true`) would then be stranded with no way to
  update — a `poll`/`tryAttach` state stuck on with no `fixedUpdate` driving
  it, a good way to leave a player wedged with the wrong pose forever. Fixed
  the same way, `&&`-chained before the call.

Both now read:
```js
if (allows(this._world, 'climb') && this.freeClimb.fixedUpdate(dt, elapsed)) {
if (s.jump && s.forward > 0.2 && allows(this._world, 'climb') && this.freeClimb.tryAttach()) {
```

### Other `freeClimb` entry points checked (grep, not just line 571)

`grep -n freeClimb src/player/Player.js` turned up every call site:

| Line (post-fix) | Call | Gated? | Why |
|---|---|---|---|
| 183 | `new FreeClimb(...)` | n/a | construction |
| 227, 232 | `.cancel()` | n/a, always runs | exit path; already unconditional in the `mount:mounted` and `world:changing` handlers, which is correct — cancelling is always safe and is what actually clears an in-progress climb when the player steps into the maze |
| 436 | `get isFreeClimbing` → `.active` | n/a | read-only accessor |
| 441 | `get wallCandidate` → `.candidate` | not gated | `FreeClimb.candidate` is only set by `poll()`/`tryAttach()`, and nothing in `src/` currently reads `player.wallCandidate` (only the stale built bundle does) — a dead accessor today, so leaving it ungated has no observable effect. Flagging in case a future HUD prompt starts consuming it. |
| 574 | `.fixedUpdate()` | **gated** (this fix) | continues/claims an active climb |
| 682 | `.tryAttach()` | **gated** (this fix) | starts a climb |
| 689 | `.poll()` | not gated | Sets `.candidate` for a future HUD prompt only, does not move the player or start a climb. Deliberately left ungated to match the existing precedent one screen up: `this.climb.poll(false)` (the ledge-mantle prompt, line 667) is likewise never gated — only its `tryStart` counterpart is. Gating `tryAttach`/`fixedUpdate` alone is sufficient to stop the leak; gating `poll` too would be inconsistent with how the mantle system already treats its own `poll`. |
| 1053 | `.applyPose()` | n/a | draws whatever pose state exists; safe because `_active` can no longer become `true` in a forbidding world now that `tryAttach` is gated |

**Cancellation on entering a forbidding world**: already handled before this
fix. `WorldManager.build/activate` emits `world:changing` on every
transition (`src/worlds/WorldManager.js:306`), and `Player`'s handler for
that event (constructor, ~line 229) unconditionally calls
`this.swim.cancel(); this.climb.cancel(); this.freeClimb.cancel();` — this
already cancels any in-progress free climb the instant the player steps
through the portal into the maze, regardless of the destination world's
rules. No change needed there.

## Bug 2 — `MountWheel` opened regardless of world rules

`MountManager.summon()` already refuses to produce a mount
(`allows(this.worldManager?.active, 'mounts')`, `src/mounts/MountManager.js:347`),
but `MountWheel.open()` (`src/ui/MountWheel.js`) had no such check, so `KeyM`
still popped the radial dial up over an empty result — reads as broken.

Used the route the task suggested as cleanest: `mounts.worldManager?.active`,
already wired in (`MountWheel` receives `mounts`, which is the
`MountManager` instance, which already carries `.worldManager`). Added:

```js
import { allows } from '../worlds/WorldRules.js';
...
open() {
  if (this._open) return;
  if (!allows(this.mounts?.worldManager?.active, 'mounts')) return;
  this._open = true;
  ...
```

Gating inside `open()` itself (rather than only in the `KeyM` handler) covers
every call site, including the digit-key path and any future caller, with a
single line. `_key()`'s existing early returns and `e.preventDefault()`
behaviour are otherwise untouched — pressing `M` in the maze now hits
`open()`, which returns immediately with `_open` still `false`: no DOM class
toggle, no `mountwheel:open` bus emit, no console output.

## Regression check — the four pre-existing worlds

Every rule in `WorldRules.js` defaults to permitted
(`allows()` returns `true` when the flag is absent or `rules` is
missing/null), and station/medieval/sports/citadel/race do not set
`climb`, `parkour`, or `mounts` to `false` anywhere (only `MazeWorld`
does — confirmed by grep across `src/worlds/*.js`). So in every other world
`allows(this._world, 'climb')` and `allows(this.mounts?.worldManager?.active,
'mounts')` both evaluate `true` and the new `&&` conditions are no-ops:
identical control flow to before the fix. The full `npm test` suite
(87 tests, including `'MazeWorld declares itself volatile and forbids the
right things'` and the general per-world gate tests) passed clean, and
`npm run build` succeeded with the usual single large-chunk warning (present
before this change, unrelated to it).

## Tests added (`scripts/tests/rules-applied.test.mjs`)

Two new tests, following the file's existing "grep the stripped source for a
live `allows(...)` call" convention (these modules touch `document`/WebGL at
module scope and can't be imported under Node):

- **`Player gates sustained free-climbing (FreeClimb), not just the one-shot
  mantle`** — asserts both `allows(this._world, 'climb') &&
  this.freeClimb.fixedUpdate(` and `allows(this._world, 'climb') &&
  this.freeClimb.tryAttach()` appear in `src/player/Player.js`. Necessary
  because the pre-existing generic `GATES` loop entry `['src/player/Player.js',
  'climb']` only proves *some* `allows(..., 'climb')` call exists — and
  `climb.tryStart` already supplied one before `FreeClimb` was ever gated, so
  that loop would keep passing even with the leak back in place.
- **`MountWheel declines to open when the active world forbids mounts`** —
  asserts the `allows` import exists in `src/ui/MountWheel.js`, and that
  `open()`'s body contains `if (this._open) return; if
  (!allows(...,'mounts')) return; this._open = true;` in that order.

### Proof the tests go red (each real gate removed in turn, confirmed failing, restored with the exact line, not a blind `git checkout --`)

1. Removed `allows(this._world, 'climb') &&` from the `freeClimb.fixedUpdate`
   line → `node --test --test-name-pattern="free-climb" ...` failed:
   `pass 0 / fail 1`, assertion at test-file line 77 (the `fixedUpdate`
   regex). Restored.
2. Removed `allows(this._world, 'climb') &&` from the `freeClimb.tryAttach()`
   line only (fixedUpdate gate left in place) → same test failed again:
   `pass 0 / fail 1`, assertion at line 82 (the `tryAttach` regex) — proving
   the test independently exercises both entry points, not just one.
   Restored.
3. Removed the `if (!allows(...,'mounts')) return;` line from
   `MountWheel.open()` → `node --test --test-name-pattern="MountWheel
   declines" ...` failed: `pass 0 / fail 1`, assertion at line 101 (the
   `open()` shape regex). Restored.

After each restore, `git diff --stat` was checked to confirm only the three
intended files (`src/player/Player.js`, `src/ui/MountWheel.js`,
`scripts/tests/rules-applied.test.mjs`) carried changes, with no stray edits
left over from the red/green probing.

## Command output

- `npm test` → `# tests 87`, `# pass 87`, `# fail 0`.
- `node scripts/contract-check.mjs` → `contract-check: 42/42 files present` /
  `All contracts satisfied.`
- `npm run build` → `✓ built in 1.40s`, only the pre-existing "chunks larger
  than 500 kB" advisory (unrelated to this change, present on `main` before
  it too).
