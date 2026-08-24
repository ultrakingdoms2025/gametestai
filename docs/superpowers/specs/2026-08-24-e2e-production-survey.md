# Phase 12 — Final production E2E · `e2e-production` · survey

**Date:** 2026-08-24 · **Branch:** `e2e-production` (worktree `agent-ae3d7d41c1597f8ba`) · not pushed, not merged.
**Tree surveyed:** `6c61e34` "Bundle: the race world, the relic ceiling, and the ninth art pass".
**Gates on that tree, run before anything else:** `npm test` **3279/3279 pass**,
`node scripts/contract-check.mjs` **129/129**, `npm run build` **exit 0**.

Roadmap §Phase 12. This is a survey, not a repair. Two live loop-blockers are reported
with root cause and are **deliberately left unfixed** — see §7 for why.

---

## 0. The one-paragraph answer

**The game is playable and the client is in good shape. The server half is not.**
Eighteen worlds were entered with real key events; all eighteen load, spawn a live
player, and answer movement, jump, sprint, crouch, camera, weapon and mount input with
**zero page errors in any world**. Against that, **two production API routes return HTTP
500 to every caller**, and one of them is the mission spine: `/api/game/quests`. No quest
can be loaded in production by anybody, signed in or out. The cause is a single missing
database column, and the code contains a comment — in a third module — that predicts this
exact failure and defends against it. Two modules with the same dependency did not get
that defence.

---

## 1. Method

**Real OS-level key events, not synthesised ones.** `scripts/playthrough.mjs` boots the
game in real Chrome and dispatches input through CDP `Input.dispatchKeyEvent`, which
enters Chrome's input pipeline at the same point a physical keypress does — `isTrusted`
is true and the game cannot tell the difference. `new KeyboardEvent()` from page script
would have exercised the listeners while bypassing focus, the keyboard-lock layer and
the browser's own claim on Ctrl and the F-keys.

The driver is a **server**, not a script: a cold boot settles in tens of seconds to
minutes (`Harness.settleBoot`, and the 95.9 s → 172.0 s trap recorded there), so one boot
has to serve many probes. `scripts/e2e-worlds.mjs` then walks all eighteen registered
worlds in a single session — which is also the only way to reach the acceptance
criterion's *repeated* entry/exit at all.

`HARNESS.setGameplayDriven(true)` is held on throughout. Without it the pointer-lock loss
every automated session suffers switches the whole gameplay update block off and silently
disables all LOD; every figure taken in that state is the LOD-disabled worst case.
`/status` reports `gameplayDriven` next to every reading rather than assuming it.

### What this survey got wrong first, and how it was caught

Recorded because it is the same shape as the failure this phase exists to prevent.

1. **The first probe set guessed the object model.** `GAME.weapons`, `GAME.weaponSystem`,
   `w.current.id` — every one read back `null`. A null from a wrong accessor and a null
   from a broken system are the same character on screen. Every accessor in
   `scripts/e2e-probe-lib.js` was subsequently read out of the live `window.GAME`.
   Two had already bitten: `WorldManager.ids` is a **getter** (calling it throws, which
   would have read as "no worlds registered"), and `MountSystem`'s `active` / `mounted` /
   `unlocked` are **prototype getters** that `Object.keys` does not list — reading
   `_active` reported `null` for a mount the player was sitting on.
2. **Two "the player cannot move" results were both false.** See §4.3. Both would have
   been reported as loop-blockers by a survey that stopped at the first measurement.

---

## 2. LOOP-BLOCKERS

### LB-1 — `/api/game/quests` returns HTTP 500 in production. No quest can ever load.

**What I did.** `GET https://www.aethernexus.games/api/game/quests?world=station`, and
again with no query string.

**What happened.**

```
status=500 bytes=0     (with ?world=station)
status=500 bytes=0     (no query string)
```

Empty body, no content-type. Reproduced on three consecutive requests and independently
by a second agent on both hostnames. `X-Matched-Path: /api/game/quests` confirms the
route matched and the handler threw.

**What should have happened.** HTTP 200 with the platform catalogue. The route handles
signed-out callers explicitly — `site/app/api/game/quests/route.ts:19-27`, comment
*"Signed out: the platform catalogue, exactly as before"* — returning
`{quests, engagements: [], player_id: null}`. **This is a regression, not a gate.**

**Root cause — measured, from the production runtime error log:**

```
error: column "server_id" does not exist
code: '42703'            routine: 'errorMissingColumn'
routes=/api/game/quests, /api/marketplace/items
lastDeployment=dpl_GQZnvH1H1YaAyhYe9H8LLzRTcM6g
```

`listActiveQuestsForWorld` (`site/lib/playerDb.ts:732-751`) selects `server_id` and
filters on it. The migration that adds that column —
`ALTER TABLE quests ADD COLUMN IF NOT EXISTS server_id TEXT` — exists in exactly one
place, `site/lib/leaderboard.ts:284`, inside *that module's* ensure function. The quests
route never calls it. `runQuestSchema()` in `playerDb.ts:602-609` adds `steps` and
`repeatable` and stops there.

**The comment that predicted this.** `site/lib/lore.ts:23` declares the same column for
its own table, and says why:

> Additive, and declared HERE as well as in `customServers.ts` because this function
> creates the table it reads and **must not depend on another module having run first**.
> Without it, a database where the custom-server schema has not been ensured answers the
> SELECT below with **"column server_id does not exist"**.

`/api/lore` returns 200 with real rows. It is the only route in the survey that declares
its own additive migration, and it is the only Postgres-backed route that works.

**Player impact.** The mission spine — 78 quests, 398 steps, six worlds — is unreachable
in production for every player. See LB-3 for what the player is shown instead.

---

### LB-2 — `/api/marketplace/items` returns HTTP 500 in production.

**What I did.** `GET https://www.aethernexus.games/api/marketplace/items`.

**What happened.** `status=500 bytes=0`. Same error group, same exception, same
deployment. (`/api/marketplace` is a genuine 404 — that route does not exist.)

**What should have happened.** 200 with the catalogue. `site/lib/marketplaceDb.ts`'s own
comment promises *"A signed-out caller … get[s] exactly today's catalogue"*.

**Root cause.** The same missing column. `ALTER TABLE marketplace_items ADD COLUMN IF NOT
EXISTS server_id TEXT` exists only in `site/lib/customServers.ts:361`, which this route
never calls.

**Player impact.** Materially softer than LB-1, and the difference is the whole point of
LB-3: the marketplace **has** a bundled offline catalogue and shows a visible notice
(`src/systems/Marketplace.js:311-323`, `MarketplaceUI.js:344` renders `mkt-offline`), so
a player still gets a shop, correctly labelled as offline. The quest board does not.

---

### LB-3 — The quest board cannot say "offline", so an unreachable service reads as "you have no quests".

This is what turns LB-1 from an outage into a silent one.

**What I did.** With the quest service unreachable, pressed **J** (real key event) in
`station` and read the panel.

**What happened.**

```
QUEST BOARD
AVAILABLE   IN PROGRESS   COMPLETED
No quests in this category.
Select a quest to view details.
Press J, E or ESC to close
```

Screenshot: `.probe/e2e/station/questboard-offline.png`. `__PROBE__.quests()` at the same
moment: `questCount: 0, offlineLogged: true`.

**What should have happened.** A notice that the quest service is unreachable — which is
what the code says it does. `QuestSystem._questsOffline()`
(`src/systems/QuestSystem.js:434-450`) emits `quests:changed` with `offline: true` and the
comment:

> And the board is told, so it can say "offline" rather than "empty" — **the same
> distinction the marketplace draws.**

**The board never reads it.** `src/ui/QuestBoard.js:89` is
`this.bus.on('quests:changed', () => this._refresh())` — the payload is dropped by an
arrow function that takes no argument, and `grep -n offline src/ui/QuestBoard.js` returns
**no matches at all**. The marketplace does draw the distinction; the quest board does
not, and no test covers it (`grep -rn offline scripts/tests/quest*.test.mjs` → nothing).

**Why it matters more than it looks.** "No quests in this category" is indistinguishable
from "you have completed everything". A player in production today is told, in the
game's own words, that there is nothing for them to do.

---

## 3. Production identity — is the deployed bundle the one I tested?

**Yes, proven by hash on six assets.** Production serves byte-for-byte what this tree
builds.

| Asset | prod status | bytes | sha256 == `git cat-file blob HEAD:…` |
|---|---|---|---|
| `assets/index-BwKb403X.js` | 200 | 3,338,989 | `cd67bed6…4006d` ✅ |
| `assets/Harness-B8SLjNVg.js` | 200 | 27,987 | `e8c1a446…8d223` ✅ |
| `assets/three.core-Co-9pgkG.js` | 200 | 373,737 | `4826e6b3…7436b` ✅ |
| `assets/basis_transcoder-VXdx5NbI.wasm` | 200 | 527,333 | `6cf17dc8…7630a` ✅ |
| `assets/citadel/citadel.glb` | 200 | 41,068 | `25c2d9b1…bdfb8` ✅ |
| `assets/dock/sec-b1.glb` | 200 | 118,472 | `f78b4273…a81e2` ✅ |
| `assets/maze/hedge-candle.glb` | 200 | 8,416 | `133ebedf…89ab8` ✅ |

A fresh `npm run build` on this tree reproduces `index-BwKb403X.js` **byte-identically**
to the git blob and therefore to production. The build is also deterministic run-to-run
(two consecutive builds, identical sha256).

Live deployment `dpl_GQZnvH1H1YaAyhYe9H8LLzRTcM6g`, identical on
`aether-nexus-site.vercel.app` and `www.aethernexus.games`. Hashed assets are anonymously
fetchable (`Cache-Control: public, max-age=31536000, immutable`).

### A trap in the repo's own verification method

`/game/build.json` is **not** anonymously fetchable — it 307-redirects to
`https://aethernexus.games/` with a 15-byte `Redirecting...` body. So the commit stamp
cannot be read from production; identity has to be established by hashing assets, which
is what was done above.

**And the local comparison must not use the file on disk.** `core.autocrlf=true` with
`* text=auto` in `.gitattributes` means the checked-out JS is CRLF-expanded:

| | bytes | sha256 |
|---|---|---|
| `git cat-file blob HEAD:site/public/game/assets/index-BwKb403X.js` | 3,338,989 | `cd67bed6…` |
| the same path **on disk** in a Windows checkout | 3,347,077 | `56f679a7…` |

The 8,088-byte delta is exactly `lines − 1` (8,089 lines). Both files carry the **same
content-hashed filename**, so a comparison by name passes while a comparison by bytes
against the working copy fails — in the direction that reads as "the deploy is stale". The
roadmap records eleven deploys "verified in LIVE BYTES"; the correct local reference is
`git cat-file blob`, not the working tree. Binary assets are safe — `.gitattributes`
declares `*.glb`, `*.ktx2` and `*.wasm` as `binary` for exactly this reason.

---

## 4. Flow-by-flow results

### 4.1 The eighteen worlds

Every world was entered with `HARNESS.goto` (the same switch the portals drive), then
walked, jumped, weapon-swapped, mounted and Esc-menued with real key events.
Full data: `.probe/e2e/worlds/worlds.json`; screenshot per world in `.probe/e2e/worlds/`.

| world | entry max gap (ms) | walk (m) | jump (m) | weapon swap | mount | minigames | portals | NPCs | page errors |
|---|---|---|---|---|---|---|---|---|---|
| station | 22.3 | 6.68 | 0.88 | ✅ fireball | ✅ hoverboard | 2 | 6 | 68 | 0 |
| medieval | **16375.1** | 3.14 | 0.88 | ✅ | ✅ | 0 | 1 | 55 | 0 |
| sports | 84.2 | 6.70 | 0.87 | ✅ | ✅ | 4 | 1 | 41 | 0 |
| citadel | **1076.0** | 6.86 | 0.88 | ✅ | ✅ | 7 | 1 | 58 | 0 |
| race | **2988.0** | 0 → 7.36 ¹ | 0 ¹ | ✅ | ✅ | 2 | 1 | — | 0 |
| maze | **2743.7** | 0 → 6.49 ² | 0 ² | ✅ | n/a ³ | 0 | 1 | — | 0 |
| dock | **5149.3** | 6.71 | 0.88 | ✅ | ✅ | 1 | 2 | — | 0 |
| space | **7296.4** | 6.62 | 0.80 | ✅ | n/a ³ | 0 | 1 | — | 0 |
| cinder | **3157.3** | 6.70 | 0.93 | ✅ | n/a ³ | 0 | 0 | 0 | 0 |
| tessera | 17.9 | 6.63 | 1.62 | ✅ | n/a ³ | 0 | 0 | 0 | 0 |
| sirocco | 19.0 | 6.62 | 0.90 | ✅ | n/a ³ | 0 | 0 | 0 | 0 |
| shoal | 27.0 | 6.70 | 0.89 | ✅ | n/a ³ | 0 | 0 | 0 | 0 |
| vitrine | 18.0 | 6.63 | 0.96 | ✅ | n/a ³ | 0 | 0 | 0 | 0 |
| verdigris | 18.5 | 6.64 | 0.87 | ✅ | n/a ³ | 0 | 0 | 0 | 0 |
| lathe | 18.6 | 7.10 | 1.57 | ✅ | n/a ³ | 0 | 0 | 0 | 0 |
| carnelian | 52.4 | 6.62 | 0.97 | ✅ | n/a ³ | 0 | 0 | 0 | 0 |
| sallow | 18.0 | 6.69 | 0.94 | ✅ | n/a ³ | 0 | 0 | 0 | 0 |
| cathedra | 18.2 | 6.62 | 1.01 | ✅ | n/a ³ | 0 | 0 | 0 | 0 |

¹ ² ³ see §4.3.

**All eighteen worlds entered successfully, spawned a live player at 100 health, and
raised zero page errors.** No world failed to build, and no `goto` landed in a world
other than the one asked for.

### 4.2 Systems

| flow | result | evidence |
|---|---|---|
| **Movement** | works in all four directions in every world | W/S/A/D each ≈5.4–7.1 m per 1.2–1.4 s hold |
| **Sprint** | works, 1.73× walk | 4.502 m walking vs 7.804 m sprinting over equal time |
| **Jump** | works | 0.80–1.62 m rise; higher on low-gravity planets, as designed |
| **Crouch** | works and restores | eye height 1.72 m → 0.97 m → 1.70 m on C down/up |
| **Weapons** | 4 weapons, cycling works | machinegun / fireball / bow / sword; Digit1–4 select, Digit5 no-ops (only 4 exist) |
| **Mounts** | 6 available, all unlocked, ride and dismount work | `summon()` → active, rode 8.0–15.7 m under W, **F** dismounts to `active: null` |
| **Esc pause hub** | opens and closes in all 18 worlds | max gap 18–30 ms |
| **Quest board (J)** | opens, renders, closes | but see LB-3 |
| **Mini-games** | 16 venues found across 5 worlds, prompts fire | station 2, sports 4, citadel 7, race 2, dock 1; `_near` and `_promptText` populate on approach |
| **NPCs** | 68 in station, 55 medieval, 58 citadel, 41 sports | `npcManager.npcs`; nearest-NPC approach + **E** exercised |
| **Marketplace** | offline catalogue + notice works | `Marketplace.js:311-323`, `mkt-offline` rendered |
| **Quests** | **cannot be tested end to end** | see §5 |
| **Custom servers** | **cannot be tested end to end** | see §5 |

### 4.3 Two "the player cannot move" results that were both wrong

Both are recorded because a survey that stopped at the first measurement would have
filed two loop-blockers that do not exist.

1. **`race` — walk 0 m, jump 0 m, `blocks: ["race"]`.** The race world auto-opens its
   circuit-selection sheet on entry (`VELLUM RIDGE CIRCUIT … Esc to close`), and that
   sheet correctly holds the gameplay block, exactly as any menu should. Pressing **Esc**
   for real cleared `blocks` to `[]` and the next W hold moved the player **7.36 m**.
   Not a defect. Screenshot `.probe/e2e/race-entry.png`.
2. **`maze` — walk 0 m, jump 0 m, `blocks: []`.** Re-entered and re-tested from the same
   spawn `(1260, 0, 60)`: W moved **6.49 m**, D and A strafed 2.05 m each. The zero
   coincides with the maze's **2,743.7 ms** stalled entry frame — the driver's keydown and
   keyup both landed inside one stalled frame, so the key was down for zero game time.
   Not a movement defect — but it *is* a real observation about that stall: a frame long
   enough to swallow a 1.4-second keypress will swallow a player's, too.

3. **Mounts on the ten planets and in `space`/`maze` return `summon() === false`.** By
   design, not a defect: `PlanetWorld.js:872` sets `mounts: false` — *"Mounts off: a horse
   on a volcano is a joke the player did not make. The ship is the mount here."* The maze
   forbids mounts too, and `mapActionOwner` re-points **M** at the map there
   (`WorldRules.js:135`). `quests: false` on planets likewise explains their zero quests.

---

## 5. What could not be tested, and why

| flow | why not |
|---|---|
| **Quest accept → steps → completion → reward** | The endpoint is 500 in production (LB-1) and needs a login + live Postgres locally, which this worktree has no credentials for. The client half was exercised: the board opens, renders and closes, and the offline path is reached. The **server-authoritative reward grant** — the idempotent CTE, the 409 on non-repeatable, the prerequisite `missing[]` — was **not** exercised end to end by this survey. |
| **Custom-server flows** | `/api/servers` is correctly gated (401 anonymous). Testing owner CRUD, membership and server-scoped content needs an authenticated owner account. Not attempted. |
| **Purchases / checkout** | Deliberately not attempted. No purchase was initiated at any point. |
| **Signed-in API surface** | `/api/game/state`, `/leaderboard`, `/map-overlay`, `/progress`, `/servers`, `/user/me` all return 401 anonymously — correct — but a 401 gate fires *before* the data path, so those are gate-passes, not end-to-end passes. **They share `playerDb.ts`'s raw-`pg` helper with the two routes that 500.** Whether they also fail for a signed-in user is **unverified**; §8 recommends it be checked first. |
| **Touch / mobile** | Out of scope for this pass; the driver's touch look path was used only as a pointer-lock fallback. |

---

## 6. Phase 1's acceptance criterion

> in **production**, no frame gap over 250 ms on first mount launch, first weapon change
> per world, world entry, first keybind use, or repeated entry/exit. **Measured, not felt.**

*(§6.1 and §6.2 below.)*

---

## 7. Why the two loop-blockers were not fixed

The fix for LB-1 and LB-2 looks like two lines — add the missing `ALTER TABLE … ADD
COLUMN IF NOT EXISTS server_id TEXT` to `runQuestSchema()` and to the marketplace ensure.
It was still not taken, for three reasons:

1. **It cannot be proved from here.** The fault is in the *production database's* schema,
   not in this tree. A committed migration is not a fixed production; someone has to
   observe the endpoint return 200 afterwards, and this branch has no database credentials
   to check against.
2. **The blast radius is wider than the two routes measured.** Every raw-`pg` module
   shares the same pattern, and the right fix may be one ensure-step that all of them
   call rather than two more copies of the same ALTER. Choosing that is a design call for
   the branch that owns it.
3. The phase's own instruction: a branch that both surveys and repairs cannot say whether
   its own repairs were the right call.

`.probe/` output, `scripts/playthrough.mjs`, `scripts/e2e-sweep.mjs`,
`scripts/e2e-worlds.mjs` and `scripts/e2e-probe-lib.js` are the only things this branch
adds. No game or site source file was modified.

---

## 8. Recommended order of work

1. **LB-1 / LB-2** — the missing `server_id` column. Then re-check the six gated
   endpoints with a signed-in session **before** assuming they were fine.
2. **LB-3** — `QuestBoard` should read the `offline` flag its own upstream already sends.
   One line, plus the test that does not currently exist.
3. The entry-stall figures in §6.

---

## 9. Files added by this branch

| file | what it is |
|---|---|
| `scripts/playthrough.mjs` | the driver: real Chrome, real CDP key/mouse events, HTTP control surface, rAF gap sampler |
| `scripts/e2e-probe-lib.js` | page-side accessors, read out of the live `window.GAME` rather than guessed |
| `scripts/e2e-sweep.mjs` | the per-world battery of input probes |
| `scripts/e2e-worlds.mjs` | the eighteen-world pass and the repeated entry/exit rounds |
| `docs/superpowers/specs/2026-08-24-e2e-production-survey.md` | this document |
