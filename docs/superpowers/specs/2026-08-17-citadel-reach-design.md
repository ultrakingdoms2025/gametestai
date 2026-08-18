# Citadel: the Verbs, the Reasons and the Reach

**Date:** 2026-08-17
**Status:** design approved (four decisions taken, see §2)
**Worlds touched:** `citadel` primarily; Phase 1 improves all five.

---

## 1. Diagnosis

The brief was *"in citadel it is mainly running on roof tops … with no purpose"*, plus a request for
run/jump/roll with animations, and a world four or five times the size.

Reconnaissance (seven parallel readers, plus live browser measurement) found that Citadel is **not
short of content**. It is short of *consumers*, *signposting* and *a working difficulty curve*, and
three of its signature systems are outright broken. Every claim below was verified against the
running game or the source, not inferred.

### 1.1 The leap of faith kills you

`CitadelWorld._buildDressing` places a haystack under every viewpoint using `_groundAt(x, z)`, which
is `terrainH(hypot(x, z))` — pure terrain, blind to every structure ever built on top of it
(`CitadelWorld.js:1571`, `:1964`).

Measured against the assembled world:

| Haystack | Recorded `y` | Real walkable top | `Parkour._softLandingAt` credit |
|---|---|---|---|
| Great Tower | 16.4 | 20.0 | ✗ |
| Minaret 1 | 16.4 | 20.0 | ✗ |
| Minaret 2 | 16.4 | 32.0 | ✗ |
| Minaret 3 | 16.4 | 29.5 | ✗ |
| Minaret 4 | 16.4 | 30.6 | ✗ |
| Ramparts ×6 | 16.2 | 15.9 – 22.9 | 3 of 6 ✓ |

**3 of 11 haystacks work.** All five viewpoint haystacks are buried inside the inner-ward slab
(`addBox(0, 17, 0, 30, 3, 30)`, solid y 14→20) — the thatch is invisible, and its own collider sits
inside another solid. A jump from the Great Tower (67.6 m) lands on the ward roof at **45.8 m/s**
against `LETHAL_SPEED = 42`: **death from full health**, unless the player happens to press crouch.

The file's own header states the intent: *"Every fall has an answer. Haystacks sit under the high
traversal lines so a leap of faith is a route rather than a death."* It is a death.

### 1.2 The rooftop difficulty gradient does not exist

The header claims gaps widen toward the citadel (`:33-34`). In the geometry,
`count = max(8, round(τr / 15))` pins tangential centre spacing to 14.8–15.4 m at **every** one of
the seven rings, ring pitch is a constant 12.5 m, and mean footprint is 10.5 m. Tangential gaps are
≈4.5 m everywhere; radial ≈2.0 m.

A sprint jump clears **4.65 m**. Therefore **the entire rooftop network is traversable without ever
using the leap, the stamina bar or the climb.** The parkour set is decorative because no geometry
asks for it. The only gaps that exceed a sprint jump are accidents of `Batch` orientation: buildings
are placed at angle `a` but rotated `rotY = a`, so the footprint frame rotates as `−2a` relative to
the ring and edge-to-edge gaps swing with compass bearing (`:1119`).

### 1.3 The bridge to the perimeter is dead code

`_buildRopeBridges` (`:1514-1523`) explicitly intends *"one span from a minaret out to a wall tower,
so the network reaches the perimeter rather than looping only around the citadel."* The span
computes to 99.0 m and the next line rejects anything `> 90`, silently. Four 29.7 m minaret loops
ship, all inside r = 21. The 46 m great tower has no bridge at all.

### 1.4 Everything else that is built and unreachable

| Built | Why the player never meets it |
|---|---|
| 30 relics on authored rooftops, 3,600 CR | No marker of any kind; nothing consumes `relic:found`; `Minimap` is constructed with `{portals, caches, contracts}` only. **`Relics._found` is absent from `SaveGame._snapshot`** — progress resets every reload. |
| 10 quests / 59 steps | Behind `/api/game/quests` and a login (`QuestSystem.js:239`). Launched as the user launches it, the world contains **zero** authored objectives. |
| 5 named viewpoints | **Zero consumers** anywhere outside `CitadelWorld.js`. |
| Relic-coin economy | `DROP_TABLES` has no `citadel` row (`Loot.js:309`) → hostiles drop station bullets. |
| Regional price table (`ItemDefs.js:357-365`) | No NPC carries `vendorCategories`, so the buy side is shut. |
| 4 named NPCs with written personas | No `role`, no `signLines`, no `isQuestManager`. |
| 25 crowd NPCs | Wearing `ROLE_CAST.station` — `THEME_BY_WORLD` has no `citadel` entry. |
| Six parkour bus events | **Zero listeners.** No pose, no camera, no audio, no VFX. |

### 1.5 Coverage

**0 Citadel test files.** Medieval has 14. There is no `parkour.test.mjs` either: leap, dive, roll
and the whole fall-damage model are untested. `Harness.VIEWS` has no `citadel` entry, and
`CitadelWorld.js` is absent from `contract-check.mjs`'s 75-entry list. Every world in this repo that
was successfully scaled had all three first.

### 1.6 The movement envelope

Computed from live config (`g = −22`, `jumpVelocity 6.4`, `sprintSpeed 8.2`) and confirmed against
the real integrator:

| Move | Horizontal | Vertical | Flat gap | Apex |
|---|---|---|---|---|
| Walk jump | 4.6 | 6.4 | **2.61 m** | 0.93 m |
| Sprint jump | 8.2 | 6.4 | **4.65 m** | 0.93 m |
| Leap (Sprint+Space) | 11.64 | 7.17 | **7.57 m** | 1.17 m |

Free-climb sustains **18.5 m** of continuous ascent on one stamina bar (`DRAIN_UP 5.4/s`). Fall
damage begins at 18 m/s = **7.79 m** of free fall; lethal at 42 m/s = **40.8 m** (the docstring's
"about 36" is wrong). A full bar affords **7 leaps**.

**These six numbers are the metric every rooftop gap, ledge band and objective placement in this
design is authored against.**

---

## 2. Decisions taken

1. **Region map, not a bigger town.** The existing Sunspire mesa stays *bit-identical* inside a
   protected box; the new ring is authored as distinct places. This is the technique the Medieval
   5× expansion proved and pinned.
2. **Objectives work both signed out and signed in.** A world-local core loop with local
   persistence, plus server quests layered on top.
3. **Full dodge roll** — the capsule shrinks, the camera drops, brief invulnerability, and it can
   pass under low obstacles.
4. **Three playable drops**, deployed and verified live in order.

---

## 3. Phase 1 — The Verbs

*Goal: every parkour verb is visible, audible, felt, and one new verb exists. Improves all five
worlds. Ships and deploys on its own.*

### 3.1 Wire the six dead events

`player:leap`, `player:dive`, `player:roll`, `player:softland`, `player:falldamage`,
`player:climb` currently have no listeners. Give each an owner:

- **Pose** — a new `Parkour.applyPose(dt, elapsed)` registered in `Player._installLatePose()`
  (`Player.js:1206-1227`; order is blend priority, later wins). Body follows `FreeClimb.applyPose`
  (`:475`) verbatim: `humanoid.bones` is a `Map<string, Bone>`, slerp to **absolute** eulers at
  `_poseWeight`, module-level scratch objects only. Envelope `w = sin(πt)^0.65` (`TennisPose.js:48`)
  so weight is zero at both ends — full weight from frame one is what makes an avatar twitch.
  The roll's somersault needs `humanoid.rig` body-space rotation; follow `MinigamePose._releaseRig`
  (`:263`) and the `SWIM_RIG_EPS` handover guard (`:41`). A late absolute slerp beats
  `PlayerAvatar._applyAirPose` (`:990`), which runs earlier and is additive.
- **Camera** — `Player._dipVel` takes an impulse from anywhere (`_land:1063`). Leap gets a small FOV
  kick, dive a pitch-down, roll a dip plus a **new** body-state camera-roll hook (none exists).
- **Audio** — `AudioDirector` already routes `player:footstep`, `player:landed`, `player:climb`
  (`:145-169`). Add leap grunt, dive wind, roll thump-and-scuff, hay whump.
- **VFX** — dust puff on roll and hard landing via the existing pool.

### 3.2 The ground roll (new verb)

Run + crouch on the ground initiates a dodge roll. Distinct from the landing roll, which stays as
it is. Capsule shrinks (`setRollStance(t, dt)` modelled on `setClimbStance`, `Player.js:1170-1180`,
`_capsuleHeight` damped at rate 16), the separate eye-height spring (`:1616`) must be touched
explicitly or the camera will not drop, brief i-frames, and it can pass under low obstacles.

Input: no new binding. `KeyC` already reads *"Crouch / dive / roll"* and carries five meanings —
this is a sixth on the same key, disambiguated by grounded-and-moving.

### 3.3 Fix the five roll defects

1. **The momentum reward self-cancels** — `ROLL_SPEED 1.12` is shed in ~0.3 s because held crouch
   sets `wishSpeed = 2.2`. The roll must own its own speed floor for `ROLL_TIME`.
2. **`ROLL_MAX_DAMAGE = 32` is unreachable** — the real maximum is 100 × 0.28 = 28.
3. **The docstring's "stays armed after landing" is false** — the late path only reads *held* crouch
   on the landing step.
4. **A pre-armed roll runs at full 1.75 m capsule** unless crouch happens to still be held.
5. **`parkour.rolling` and `diveWeight` have zero readers.**

### 3.4 Tests — `scripts/tests/parkour.test.mjs` (does not exist today)

Drive the real `Player` under Node (`player-slope.test.mjs:212-268` template): the three jump
distances, the leap stamina gate, the roll damage curve, momentum retention *after* the fix, capsule
and eye-height during a ground roll, and an input-tape hash ratchet.

---

## 4. Phase 2 — The Reasons

*Goal: the existing 400 m world becomes worth playing. No extent change.*

### 4.1 Repairs first

- **`_groundAt` must ask the built world.** Replace the terrain-only function with a surface query
  against real physics, and re-place all 11 haystacks. Assert per haystack that the recorded `y` is
  within `(−3.5, +1.5]` of the real walkable top. This single fix restores the world's thesis.
- **The perimeter bridge.** Raise the span limit or re-pick the anchor so the network reaches the
  wall, as the comment always intended. Add a Great Tower span.
- **`DROP_TABLES.citadel`**, **`THEME_BY_WORLD.citadel`**, and `vendorCategories` on the named NPCs.

### 4.2 The difficulty gradient, made real

Re-author souk ring spacing so required budget rises inward: outer rings clearable by sprint jump
(<4.65 m), middle rings demanding the leap (4.65–7.57 m), inner rings demanding a leap plus a mantle
or a short climb. Pinned by invariant **R2** below, which fails on today's geometry.

### 4.3 Signposting and persistence

- Relic markers on the minimap and a HUD counter; consume `relic:found`.
- **Extend `SaveGame._snapshot`** to carry relics, viewpoints, trial times and contracts. It carries
  none of them today.

### 4.4 Viewpoint synchronisation

The five named viewpoints become gameplay: reach one → local map reveal, a fast-travel anchor, a
credit and cosmetic reward, and a "leap of faith" prompt with a hay that now works.

### 4.5 Rooftop time trials

Authored as `MinigameManager` venues — `world.minigameVenues = [{id, kind, label, centre, radius,
yTolerance, reward, requires, config, rival}]` plus `minigames.registerGame(kind, factory)`. Reuses:

- the swept ordered checkpoint validator (`RaceManager.js:1104-1166`) — anti-tunnel, anti-reverse,
  anti-shortcut, `yGate` rejects a bridge crossing over the line;
- `RaceRings` (`:148`) — the only in-world waypoint marker that exists, and nothing in it is
  dragon-specific but its call site;
- `GhostCompetitor` (`:111`) — a visible kinematic rival using the real run cycle with foot IK.

Bronze/silver/gold thresholds derived from measured route times, not guessed. Best times persist
locally; server-side alongside quest engagements for signed-in players.

### 4.6 Server quests

Author citadel quests against the new routes through the existing pipeline
(`admin/lib/quests/citadel.mjs` → `DEFAULT_QUESTS` → `_ensureQuestsSeeded`). Note that a quest can
only pay credits today (`QuestSystem._completeQuest:910`); item and cosmetic prizes need that
widened.

---

## 5. Phase 3 — The Reach

*Goal: `HALF` 200 → 450 (5.06× area), the mesa untouched, the ring full of places.*

### 5.1 The protected core

Copy the Medieval technique exactly (`MedievalHeight.js:184-192, 502-520`): a clamping `smoothstep`
mask on **Chebyshev** distance so it is *exactly* zero inside the old playfield, every new term
multiplied by it, and each landform gated on the **exported** AABB rather than a copy. Bit-identity
proved by SHA-256 digest over a 1 m grid plus a 0.25 m band hugging the mesa shoulder, baselined
from the pre-expansion commit. `1e-17` fails the digest for reasons invisible in a screenshot — that
is the point.

### 5.2 The regions

| Region | Character | Traversal verb it teaches |
|---|---|---|
| **Sunspire mesa** (existing) | unchanged | the tutorial, now with real gaps |
| **The Undercliff** | terraced lower town down the shoulder | descent, drops, hay |
| **The Quarry & Deepworks** | benched pit, gantries, mine mouths | vertical *down*; first caves |
| **The Aqueduct** | elevated spine mesa → massif | long-line running, the leap |
| **Karst massif & the Eyrie** | mountain, monastery at altitude | sustained climb, stamina |
| **Ashfall** | ruined second citadel | broken geometry, improvisation |
| **Caravanserai** | dune outposts on the flats | mounts, rest, vendors |

The aqueduct is load-bearing design, not decoration: it makes a 900 m map crossable on foot as a
parkour route rather than a walk across sand.

### 5.3 Caves, cheaply

`Interiors` accepts **doorless** descriptors (`Treasures.js:556-606` is the precedent), streaming at
46 m and despawning at 64 m — that is the cave-mouth path on day one. `InteriorKit.buildTower` gives
box interiors with ≤0.45 m stair risers. Lighting is free: `LightRig` (`:62-80`) keeps `PointLight`s
`visible = false` and copies the twelve best into fixed slots each frame with a 6 Hz re-rank, so
**200 torches cost zero new shader programs**. Sealed-volume correctness is already a contract —
tag colliders `enclosed: true` and reuse `isEnclosureSound`.

### 5.4 The five hard constraints

- **C1 — `HALF` is decorative.** Every content radius is an absolute literal (wall 118, souk
  `34 + ring·12.5`, ward 30, spawn z 104, hostile ring 62, `fogFar` 520, `seg` 96). Publish
  `CITADEL_LAYOUT` mirroring `MEDIEVAL_LAYOUT` and **assert by source regex that the build consumes
  it** — publishing it is worth nothing if the build keeps a second copy. `fogFar` 520 against a
  1,273 m diagonal fogs the outer 60% solid; `Relics` would ask for 110 sites and dart into empty
  sand.
- **C2 — Geometry memory.** 28.59 MB today. `RoundedBoxGeometry` is **9×** a plain box (108 tris /
  14,256 B vs 12 / 1,584); `BEVEL_MIN = 0.55` is the switch. Naive ×5 = 143 MB with four other
  worlds resident. Budget **≤90 MB**.
- **C3 — Nothing culls.** 0 of 48 objects culled from every measured vantage; the shadow pass culls
  6 of 38. At 400 m a spatial split is a bad trade; at 5× it is decisive — DistanceLod alone takes
  846k→503k triangles at zero extra draw calls, a 100 m split alone 715k, **both together 278k**.
  `DistanceLod` is imported by Medieval, Race and Station and **not** by Citadel. Budget: max
  district bounding sphere **< 130 m**.
- **C4 — One collider owns the whole broadphase.** `CitadelWorld.js:942` adds a desert floor box
  whose `boundingRadius` is 452.6 m, putting it in **5,776 of 5,776** grid cells. At `HALF = 450`
  that becomes 28,900. Budget **≤20,000 colliders, ≤12,000 cells**.
- **C5 — The souk is one synchronous 192 ms block** and Citadel is a *background* build
  (`main.js:1219`), so at 5× that is ~960 ms dropped into a live gameplay frame. `report.slice`
  exists for exactly this and is never called. Budget **≤24 ms per slice**.

Terrain sampling is explicitly *not* a constraint: `citadelHeight` is one `hypot` and one
smoothstep, measured 14.0 ms at `HALF = 1000, seg = 480`.

---

## 6. The test regime

Prerequisites, all missing: a `citadel` entry in `Harness.VIEWS`, `CitadelWorld.js` in
`contract-check.mjs`, and any `scripts/tests/citadel-*.test.mjs` at all.

**The medieval lesson restated:** every existing test asks whether a thing was *built*; none asks
whether a player can *reach* it. A clearance suite cannot detect absence. **Every assertion below is
a floor, quoted as floor / achieved / ceiling, with the ceiling computed by ablation.**

On rooftops the edge that kills you is a **gap**, not a step, so the medieval probes are substituted:

- `surfaceAt` → **`deckAt(x, z)`** — highest collider top containing the point, with a headroom
  clause (a roof under an awning is not a landing).
- `worstStep` → **`arcClears(from, to, budget)`** — simulate the real integrator (`dt 1/60`,
  `g −22`, semi-implicit) at each of the three budgets and test both apex clearance over every
  intervening collider and landing inside the target deck with ≥0.4 m margin.
- the 15-bearing fan → a **takeoff fan**: perimeter samples every 1.0 m, launch heading ±60° in 10°
  steps. A gap crossable from exactly one point on one bearing is not a route.

| | Invariant |
|---|---|
| **R1** | The jump graph is **one connected component** containing spawn, every tower top and every viewpoint. |
| **R2** | The gap spectrum is a designed distribution — a floor on the share of edges requiring the leap and requiring a climb. *Fails on today's geometry.* |
| **R3** | Every landing is survivable, and every haystack actually catches — measured against real physics, **never** `_groundAt`. |
| **R4** | No roof edge is a silent death (`shoveOff`, inverted: falling is the mechanic, so every perimeter sample must resolve to a survivable outcome). |
| **R5** | Every climb face is legal (`\|n.y\| ≤ 0.5` within 0.97 m) and no tower needs more than 18.5 m of unbroken ascent. |
| **R6** | Every relic site, cache, collectible spot, quest target and trial venue is **a node in R1's component**. This is the assertion that would have caught the medieval defect class. |
| **R7** | A floor on the share of objectives that are genuinely elevated. A rooftop world whose objectives are all at street level is a ground world with roofs on it. |
| **R8** | Extent gate — forbidden-literal regex over `codeOnly()` source, and `CITADEL_LAYOUT` proven consumed. |
| **R9** | The old mesa is bit-identical (SHA-256 digest; masks exactly `0`, gating on the exported AABB proved by source regex). |
| **R10** | Approach gate for interiors and cave mouths. |
| **R11** | Budgets as assertions (§5.4), measured with `worldTriangles()` — `renderer.info` moved 10–13% between loads of an identical framing. |
| **R12** | The parkour unit gate (§3.4). |

**The browser loop.** Headless first, then Chrome DevTools MCP against
`?dev=1&autostart=1&world=citadel`. Non-negotiable order: add `citadel` framings to `Harness.VIEWS`
first; `await HARNESS.ready()` and confirm `stats().gameplayDriven === true` before reading any
number, or the pointer-lock standby block freezes `NPCManager._updateLOD` and everything measured is
the LOD-disabled worst case; confirm `rafStalls === 0` and `documentHidden === false`.

**The cheapest check is the one to run first: load a browser and look.** One browser session
invalidated four rounds of correct arithmetic during the medieval expansion.

---

## 7. Out of scope

- Porting the maze's `BatchedMesh` machinery into Citadel. Static worlds merge by material at build
  time and split by space; that is the better answer and the opposite of what the maze needed.
- Chunked streaming. Measured and refused at 900 m for Medieval; Citadel's terrain sampling is
  ~200× cheaper per sample.
- Re-litigating the engine choice.
- Wall-running, grappling hooks, and any fourth traversal verb. Three verbs plus a dodge is the set.

---

## 8. Deploy

Each phase ends the same way: `npm test` green, `cd site && npm run bundle-game`, commit the rebuilt
bundle, push. **The site serves a committed bundle from `site/public/game`** — a merge to `main`
without that rebuild ships nothing, which has already caught this project out once.
