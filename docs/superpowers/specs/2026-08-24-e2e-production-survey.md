# Phase 12 — Final production E2E · `e2e-production` · survey

**Date:** 2026-08-24 · **Branch:** `e2e-production` (worktree `agent-ae3d7d41c1597f8ba`) · not pushed, not merged.
**Tree surveyed:** `6c61e34` "Bundle: the race world, the relic ceiling, and the ninth art pass".
**Gates on that tree, run before anything else:** `npm test` **3279/3279 pass**,
`node scripts/contract-check.mjs` **129/129**, `npm run build` **exit 0**.
Re-run at the end of the branch (only new scripts and documents added): contract-check
**129/129**, build **exit 0**, and `npm test` — see §10, because it did not give the same
answer twice.

Roadmap §Phase 12. This is a survey, not a repair. Two live loop-blockers are reported
with root cause and are **deliberately left unfixed** — see §7 for why.

---

## 0. The one-paragraph answer

**The game is playable and the client is in good shape. The server half is not.**
Eighteen worlds were entered with real key events; all eighteen load, spawn a live
player, and answer movement, jump, sprint, crouch, camera, weapon and mount input with
**zero page errors across the entire session** — including a portal round trip on foot, a
mini-game played to a result that paid out, and a ship boarded, launched and flown to
space with the player's health and hold intact. Against that, **two production API routes
return HTTP 500 to every caller**, and one of them is the mission spine:
`/api/game/quests`. No quest can be loaded in production by anybody, signed in or out. The
cause is a single missing database column, and the code contains a comment — in a third
module — that predicts this exact failure and defends against it. Two modules with the
same dependency did not get that defence.

Phase 1's long-open acceptance criterion was **measured against the production bundle**
(byte-verified against what the live site serves) and **fails on four of its five events**;
see §6. The one it passes is first keybind use.

One control lies: at the station quest manager the HUD prompts **"E — Quest Board"** and E
does not open it, because a mini-game venue 33 m away has claimed the key and then declines
it (§2b). Seven of station's twelve talkable NPCs stand inside that radius. **J** still
works, which is why this is not filed as a blocker.

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

**The two side by side, both measured in a running game with the service down:**

| | quest board | marketplace |
|---|---|---|
| system flag | `questSystem._questsOfflineLogged: true` | `market.offline: true` |
| content shown | **0 quests** | **39 items**, with real prices (Rifle Round Pack 195, Arrow Bundle 169, Ember Core Cell 221) |
| what the player is told | *"No quests in this category."* | *"Trade network unreachable — showing the counter's standing stock. Prices are local."* |

**The board never reads it.** `src/ui/QuestBoard.js:89` is
`this.bus.on('quests:changed', () => this._refresh())` — the payload is dropped by an
arrow function that takes no argument, and `grep -n offline src/ui/QuestBoard.js` returns
**no matches at all**. The marketplace does draw the distinction; the quest board does
not, and no test covers it (`grep -rn offline scripts/tests/quest*.test.mjs` → nothing).

**Why it matters more than it looks.** "No quests in this category" is indistinguishable
from "you have completed everything". A player in production today is told, in the
game's own words, that there is nothing for them to do.

---

---

## 2b. A control that lies — E at the quest manager

Not a loop-blocker, because **J still works**. Filed immediately after the blockers because
"a control that lies" is on this phase's own list, and this is one, measured.

**What I did.** Stood in front of **Zara Vex**, the station quest manager, at
`(-22, 0, 14.5)`. The HUD prompt read:

> **E — Quest Board — Zara Vex**

Pressed **E** (real key event), and sampled every 25 ms for 2.5 seconds.

**What happened.** Nothing opened. `questBoard._open` stayed `false` across all 100
samples; chat never opened; the mini-game stayed `idle`. Two toasts fired instead:

> "The Concourse Round loads at the depot, 43 m away"
> "The Concourse Round is not available"

Pressing **J** at the same spot opened the board immediately — whose own footer reads
*"Press J, **E** or ESC to close"*.

**What should have happened.** The prompt the HUD is drawing should be the thing E does.

**Cause, measured rather than reasoned.** At that spot:

```
hud._chatNpc          = "Zara Vex"  (isQuestManager: true)
hud._minigamePrompt   = "Start The Concourse Round"
hud._nearPortal       = null
guard passes          = false
distance to venue centre = 33.3 m   (venue prompt radius 64.8 m)
```

`HUD.js:2732` guards its E branch with `!this._minigamePrompt`, so the mini-game wins the
key — and then `MinigameManager.start()` declines, because the run loads at a depot 43 m
away. Meanwhile `PromptSlots` goes on drawing the quest-board prompt. **The HUD's prompt
renderer and the HUD's key handler disagree about who owns E.**

The guard's own comment explains the intent — *"The venue wins, because walking up to a
pool and being offered a match is the whole point"* — and that reasoning is right when the
player is **at** the venue. The problem is the radius it is applied over.

**Scope, counted in the live world.** Station has two venues with prompt radii of **84 m**
and **64.8 m**. Inside them stand **18 of the world's 68 NPCs — and 7 of its 12 talkable
ones**: Zara Vex, plus the lorekeepers for Vellum Ridge, Meridian Athletic Complex, The
Verdant Coil, Sunspire Citadel, Aldermoor Vale and Lodestar Yard. Those six lorekeepers are
the signposts to six other worlds.

The same over-wide radius is what produced the mini-game wart in §4.3: a venue that offers
"Start" from 64.8 m out but only starts from the depot. One radius, two symptoms.

*(A third "E does nothing" reading, at a citadel lorekeeper, turned out to be my own error —
the teleport had put the player on a portal pad and they had already travelled. E opened
that chat correctly. Recorded so the count above is not inflated.)*

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
| **Portals** | round trip on foot, both directions | §4.3 |
| **Ships / piloting** | board, door, lift-off, world change, transit drive | §4.3 |
| **Rewards** | a real payout arrived from a played contest | `economy._credits` 0 → 2, §4.3 |
| **Page errors** | **zero, across the entire session** | `window.__HARNESS_ERRORS__.length === 0` after 18 worlds, 2 portal traversals, a contest played to a result, and a flight to space |
| **Quests** | **cannot be tested end to end** | see §5 |
| **Custom servers** | **cannot be tested end to end** | see §5 |
| **Server-authoritative credits** | **not exercised** | `creditReporter.active: false` with no signed-in session; the 2 CR stayed local and nothing was queued (`_queue: []`, `_seq: 0`, `_dropped: 0`). Correct offline behaviour; says nothing about the server path. |

### 4.3 Flows played end to end, on the production bundle

Everything below was driven with real key events on the byte-verified production build.

**Portal round trip — station → race → station.** Walked into the `station->race` portal
holding **W**; world changed to `race`, player landed at `(-10.6, 0.8, 144.1)`. Pressed
**Esc** to clear the circuit sheet, held **S** back through `race->station`
(`ready: true`, `state: "online"`); world changed back to `station` at `(49.0, 2.8, 28.3)`.
**Health 100 the whole way.** A world a player can walk into and walk out of.

**Mini-game, start to payout — The Concourse Round (courier, station).**
Standing 52 m out, the HUD prompt read *"Start The Concourse Round"* and **E** did nothing.
The game **does** explain itself — two toasts fired: *"The Concourse Round loads at the
depot, 52 m away"* and *"The Concourse Round is not available"*. Moved to the depot
`(18, 0.13, 0)`; **E** then started it — `state: countdown`, 2.07 s. It ran, and finished
on its own timer with a real result object:

```json
{"gameId":"delivery_run","venueId":"station_concourse_round","kind":"courier",
 "won":false,"place":2,"total":2,"score":0,"scoreLabel":"0/3 parcels",
 "detail":"late to Rim Kiosk A","time":13.55,"credits":2,"worldId":"station"}
```

`economy._credits` went **0 → 2** and `_earned` **0 → 2**. The consolation payout arrived.
**A reward that actually arrives** — the loop closes. (The run was lost because the driver
stood still; that is the correct outcome for standing still.)
*Wart, not a blocker:* the prompt radius is 64.8 m while the start radius is much smaller,
so the HUD offers "Start" from where starting is impossible. The toast rescues it by naming
the place and the distance, which is why this is filed here and not in §2.

**Ship boarding, lift-off and the run to space — the flow this repo's memory flags.**
The recorded historical loop-blocker is *"take-off killing the player and deleting their
hold"*. It is fixed, and this is the play that shows it:

| step | real input | result |
|---|---|---|
| stand at Kestrel apron `(-60, 2, -143)` | — | prompt: **"F — Board the Kestrel"** |
| board | **F** | `shipId: "kestrel"`, `landed: true`, player at berth `(-68, 1.2, -143)` |
| open door | **E** | prompt flips to "Close door" |
| lift off | **Space** 2.5 s | y **1.2 → 193.52**, `landed: false`, `airborne: true` |
| run out | **W** 4 s | world changed **dock → space**, at `(-68, 60, -1197)` |
| transit drive | **Z** | `_transit: 1`, travelled 470 m to `z −1667` |

**Health 100 at every step. Inventory 3 items before and after. Credits 2 before and
after.** Take-off does not kill the player and does not delete the hold.

### 4.4 Two "the player cannot move" results that were both wrong

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

### 4.5 Known-open items, confirmed or not, in play

I was asked to confirm the `citadel` gate-spawn framing if I saw it. **Confirmed, and it
is worse in motion than the note describes.** Screenshot `.probe/e2e/citadel-gate-spawn.png`,
taken from the spawn eye with the HUD hidden:

- a palm **crown fills the entire right ~20% of the frame** as an out-of-focus green mass;
- a **second palm trunk stands centre-right**, directly across the sightline to the keep
  and the great tower — the two things this framing exists to show;
- the player's own avatar occupies the centre of the frame.

The rest of the world reads well from that spot — the souk rings, the merchants, the
cast and the architecture all render correctly — which is what makes the palms conspicuous
rather than incidental. The existing record of this defect is accurate; nothing new to add
beyond the confirmation and the picture.

The other known-open items (bundle splitting, the 61 world lights, race's drawn-only
marshal-post collision, inert `toneMapped`) were not re-investigated and are not
re-reported here.

---

## 5. What could not be tested, and why

| flow | why not |
|---|---|
| **Quest accept → steps → completion → reward** | The endpoint is 500 in production (LB-1) and needs a login + live Postgres locally, which this worktree has no credentials for. The client half was exercised: the board opens, renders and closes, and the offline path is reached. The **server-authoritative reward grant** — the idempotent CTE, the 409 on non-repeatable, the prerequisite `missing[]` — was **not** exercised end to end by this survey. |
| **Custom-server flows** | `/api/servers` is correctly gated (401 anonymous). Testing owner CRUD, membership and server-scoped content needs an authenticated owner account. Not attempted. |
| **Purchases / checkout** | Deliberately not attempted. No purchase was initiated at any point. |
| **Signed-in API surface** | `/api/game/state`, `/leaderboard`, `/map-overlay`, `/progress`, `/servers`, `/user/me` all return 401 anonymously — correct — but a 401 gate fires *before* the data path, so those are gate-passes, not end-to-end passes. **They share `playerDb.ts`'s raw-`pg` helper with the two routes that 500.** Whether they also fail for a signed-in user is **unverified**; §8 recommends it be checked first. |
| **Landing on a planet, and taking off from one** | **Not exercised.** The ten planets publish **zero portals** — by design, because the ship is the way in and out. Reaching one properly means flying from `space` to a body and landing, which needs sustained pointer-driven flight the driver could not hold. Note that `HARNESS.goto('cinder')` puts the player on the surface with `shipId: null` and no portal — *that state has no exit*, but it is not player-reachable: a player only arrives by landing, which leaves their ship parked. **The half of this flow that could be tested passed** (§4.3: board, lift off, reach space, transit drive, hold and health intact). The planet-side half is the single most valuable thing left to test, precisely because it is where this repo's memory records a loop-blocker before. |
| **Touch / mobile** | Out of scope for this pass; the driver's touch look path was used only as a pointer-lock fallback. |
| **Pointer-lock mouse look** | An automated browser could not hold a pointer lock, so aiming and free look were not exercised. Turning was done with `HARNESS.teleport`'s yaw argument, labelled as such wherever it was used. |

---

## 6. Phase 1's acceptance criterion — **measured, and it fails on four of its five events**

> in **production**, no frame gap over 250 ms on first mount launch, first weapon change
> per world, world entry, first keybind use, or repeated entry/exit. **Measured, not felt.**

### 6.1 How "production" was reached

`/game` is cookie-gated, so a signed-in production session was not available. Instead the
**production bundle itself** was measured: `npm run build` on this tree produces
`index-BwKb403X.js` **byte-identical** to what `www.aethernexus.games` serves
(`sha256 cd67bed6…`), and so is the harness chunk that makes measurement possible
(`Harness-B8SLjNVg.js`, `sha256 e8c1a446…`, verified against the live fetch). That build
was served over `vite preview` — the server's own copy re-hashed to `cd67bed6…` before the
run — and driven with real key events.

So this is the **production artifact, on real hardware, under real input**. What it is not
is Vercel's CDN. That difference is download time, not frame pacing, and every figure below
is a `performance.now()` delta between consecutive rAF callbacks *after* boot.

Environment: headless Chrome, `ANGLE (NVIDIA, NVIDIA GeForce RTX 5080 (0x00002C02)
Direct3D11 vs_5_0 ps_5_0, D3D11)` — a real GPU, not SwiftShader.
`gameplayDriven: true` throughout.

**Evidence:** `docs/superpowers/specs/2026-08-24-e2e-frame-gaps.json` — every gap
distribution behind the tables below, for both the production bundle and the dev server,
so the numbers can be re-read rather than taken on trust. (`.probe/` holds the full state
dumps and the 36 screenshots, but this repo gitignores it as agent scratch — hence the
extract.)

### 6.2 The numbers

Worst single inter-frame gap, in milliseconds, per event per world:

| world | world entry | first weapon change | first mount launch | first keybind use |
|---|---|---|---|---|
| station | 75.0 | **674.5** | **686.0** | 97.5 |
| medieval | **12343.2** | **813.1** | **1977.7** | 191.8 |
| sports | 40.5 | 42.5 | **547.2** | 27.1 |
| citadel | 22.8 | 25.9 | 28.2 | 26.7 |
| race | **3877.6** | 21.9 | 21.5 | 28.3 |
| maze | **1511.7** | 21.3 | 53.2 | 21.7 |
| dock | **5929.0** | 31.9 | 38.4 | 24.3 |
| space | **5547.7** | 21.5 | 19.4 | 22.5 |
| cinder | 18.8 | 20.5 | 19.1 | 18.6 |
| tessera | 18.4 | 19.7 | 18.3 | 18.4 |
| sirocco | **619.1** | 19.1 | 18.3 | 18.1 |
| shoal | 18.0 | 19.1 | 20.5 | 18.4 |
| vitrine | 17.6 | 18.6 | 18.5 | 19.0 |
| verdigris | 22.0 | 19.6 | 42.1 | 19.7 |
| lathe | 18.1 | 20.0 | 18.8 | 18.1 |
| carnelian | 18.5 | 20.3 | 21.8 | 19.3 |
| sallow | 19.1 | 23.5 | 20.6 | 24.4 |
| cathedra | 18.0 | 18.7 | 19.2 | 130.9 |
| **over 250 ms** | **6 / 18** | **2 / 18** | **3 / 18** | **0 / 18** |

Repeated entry/exit, `station ⇄ medieval`, three consecutive rounds:

| round | worst gap | frames over 250 ms | five worst gaps (ms) |
|---|---|---|---|
| 1 | **5412.5** | 3 | 70.4, 75.1, 542.8, 866.6, 5412.5 |
| 2 | **1992.9** | 2 | 44.5, 47.6, 54.0, 926.6, 1992.9 |
| 3 | **1638.7** | 2 | 35.2, 48.2, 219.5, 634.1, 1638.7 |

### 6.3 Verdict, event by event

| criterion event | verdict |
|---|---|
| **first keybind use** | **PASS** — 0 of 18 worlds over 250 ms; worst 191.8 ms |
| **first weapon change per world** | **FAIL** — 674.5 ms and 813.1 ms |
| **first mount launch** | **FAIL** — up to 1977.7 ms |
| **world entry** | **FAIL** — 6 of 18 over; worst 12,343.2 ms |
| **repeated entry/exit** | **FAIL** — all three rounds over; improves 5412 → 1993 → 1639 ms but never clears |

### 6.4 The shape of it, which the criterion's wording misses

The criterion says "first weapon change **per world**". The data says the cost is **per
session, not per world**: weapon change is expensive in the first two worlds visited
(674.5 ms, 813.1 ms) and then costs 18–43 ms in the other sixteen. First mount launch is
the same — expensive in the first three (686, 1978, 547 ms), 18–53 ms thereafter.

That is the shader-cache behaviour this repo already has written down — three keys its
program cache on light count, so the first weapon and the first mount in a session pay for
program compilation and everything after them is a cache hit. **Anything that warms those
two program sets once during boot would move both of these events under the bar**, and
would leave world entry as the only real failure.

World entry is a different animal and is not a warm-up effect: `medieval` 12.3 s, `dock`
5.9 s, `space` 5.5 s are cold world *builds* blocking the main thread. `sports` is the
proof that it need not be so — it takes **30.5 seconds of wall time** to build and its
worst frame is **84.2 ms**, because it does the work without blocking the frame loop.
Whatever `sports` does, `medieval` does not.

### 6.5 One number worth a second look

`medieval`'s first weapon change is not a single spike: **15 frames over 250 ms** in that
window, with a median frame of **147.8 ms**. The criterion is written in terms of the worst
gap, and by that measure it is one failure — but a player experiences fifteen consecutive
bad frames, which is a second of unresponsiveness rather than one dropped frame. The same
window in the sixteen worlds after it has a median of ~19 ms.

### 6.6 A frame stall long enough to eat a keypress

`maze`'s entry stall swallowed a **1.4-second key hold** whole — keydown and keyup both
landed inside one stalled frame, so the game saw the key down for zero game time (§4.3).
That is not a measurement artefact to be waved away: a player pressing a key during
world entry gets exactly the same nothing.

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
   endpoints with a signed-in session **before** assuming they were fine: they share the
   same helper and a 401 gate fires before the data path, so none of them has been proved.
2. **LB-3** — `QuestBoard` should read the `offline` flag its own upstream already sends.
   One line, plus the test that does not currently exist. Worth doing *regardless* of
   LB-1: a quest service can be unreachable for reasons other than this bug, and the
   board will lie in exactly the same way every time.
3. **Warm the first weapon and the first mount during boot.** §6.4 shows both costs are
   per-session, not per-world; warming them once would move two of the criterion's five
   events under the bar for the price of a boot-time step this engine already does for
   other program sets.
4. **World entry.** `sports` builds for 30.5 s of wall time with an 84 ms worst frame;
   `medieval` blocks one frame for 12.3 s. The fix is whatever `sports` is already doing.

> **CORRECTION (orchestrator, 2026-08-24).** This recommendation is superseded, and the
> text above it overstates the gap. `scripts/tests/piloting-return.test.mjs` already
> exercises the planet-side half **by flying**, with ablation on both directions, and all
> 30 of its cases pass on the surveyed tree. Its header states the brief this survey was
> quoting: *"A player who lands and cannot take off, or flies out and cannot find the dock,
> is stranded. Prove both with a driven test."*
>
> Specifically covered, and verified green while writing this note:
>
> - *the take-off on the card own keys leaves every pad, and costs the pilot nothing* —
>   every authored landing site on Cinder, including the 2% flood island reachable only by
>   ship. Ablation: the same climb with the engines cut.
> - *the yard can be flown home to from anywhere, on the nav readout alone* — twelve
>   bearings over the whole volume, flown on `navReport()` rather than the target
>   coordinates. Ablation: the same legs on a fixed heading.
> - *a save taken on a planet resumes on the planet, on foot, beside the ship* — which is
>   the specific case the paragraph above worried about, since a planet publishes no portal.
> - *dying on a planet brings the pilot home, not just the hull* — the strand case this
>   repository's memory records.
> - *a hull driven under the surface is set down, not lost inside the planet.*
>
> What the survey observed is still true and still worth having: the browser driver could
> not hold sustained pointer-driven flight, so this flow is untested **through the real
> input path**. That is a narrower and more accurate statement of the gap than "not
> exercised", and it is a driver limitation rather than a hole in the game.
>
> The `HARNESS.goto('cinder')` observation stands on its own merits — that state has no
> exit and is not player-reachable — and is worth keeping for whoever next drives a planet
> from the harness.
5. **Play a planet landing and take-off** (§5). It is the only required flow this survey
   could not reach, and it is the one with a loop-blocker in its history.
6. **The venue prompt radius** (§2b). One radius produces two symptoms: E stolen from 7 of
   station's 12 talkable NPCs, and a "Start" prompt offered from where starting is
   impossible. Separating the *prompt* radius from the *start* radius, or making the HUD's
   prompt renderer agree with its key handler, fixes both.

---

## 9. Files added by this branch

| file | what it is |
|---|---|
| `scripts/playthrough.mjs` | the driver: real Chrome, real CDP key/mouse events, HTTP control surface, rAF gap sampler |
| `scripts/e2e-probe-lib.js` | page-side accessors, read out of the live `window.GAME` rather than guessed |
| `scripts/e2e-sweep.mjs` | the per-world battery of input probes |
| `scripts/e2e-worlds.mjs` | the eighteen-world pass and the repeated entry/exit rounds |
| `docs/superpowers/specs/2026-08-24-e2e-production-survey.md` | this document |
| `docs/superpowers/specs/2026-08-24-e2e-frame-gaps.json` | the gap distributions behind §6, both runs, so the criterion can be re-read |
| `scripts/flake-hunt.mjs` | runs the suite N times and names every test that failed in any run (§10) |

Nothing under `src/`, `site/`, `admin/` or `scripts/tests/` was touched. `git diff --stat`
against the surveyed commit shows only the five files above.

---

## 10. The suite did not give the same answer twice

Eight runs of `npm test` on an unchanged tree (only new scripts and documents added):

| runs | result |
|---|---|
| **7** | `3279 pass, 0 fail` |
| **1** | `3263 pass, **2 fail**` |

The failing run is the one that mattered least and cost most: **its output had gone through
`tail -8`, so the two names were lost** — my own mistake, and the reason
`scripts/flake-hunt.mjs` now exists and keeps the full TAP of every run.

**Not reproduced in seven further attempts**, so this is an observation, not a diagnosis.
The one datum worth passing on is the circumstance: the failing run was the only one
executed **while the playthrough browser and the preview server were both running**, i.e.
under heavy CPU and GPU contention. The other seven had the machine largely to themselves.
That is consistent with two timing-sensitive tests, and it is consistent with several other
things; I did not confirm it.

**Why it is worth a line in this report at all.** This suite is the merge gate. A gate that
goes red twice in a thousand for no visible reason trains everyone who sees it red to run it
again rather than read it — and that habit is precisely how a real failure gets waved
through. The names are cheap to find (`node scripts/flake-hunt.mjs --runs 20` under load)
and expensive to keep not knowing.

