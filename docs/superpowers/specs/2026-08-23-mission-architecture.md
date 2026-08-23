# Phase 3 — Mission and progression architecture

**Roadmap:** `docs/superpowers/specs/2026-08-21-implementation-brief-roadmap.md`, Phase 3.
**Brief:** 4.1.1, which requires the architecture documented *before* implementation.
**Status:** design. Document only — no code, no deploy, per the phase definition.
**Implemented by:** Phase 4 (`mission-core`). Constrains Phase 7 (`custom-servers`) and Phase 10
(`retention-loops`).

---

## 0. Corrections to the premises this phase was written on

Verified against `main` at `391f105`. Four of the roadmap's own statements are now wrong, three
because this session changed them and one because it was always wrong.

| Roadmap says | Actually |
|---|---|
| "nine worlds plus ten planets" | **8 hand-authored worlds + 10 planets = 18 registered ids.** There are 9 `World` subclasses, but `PlanetWorld` *is* the ten planets. `src/content/Lore.js:195` already says eighteen. |
| "Remote save is a strict subset — relics, viewpoints, objectives, trials, piloting, mining, character are localStorage-only" | **Closed.** All seven merge cross-device (`site/lib/progressLedger.ts`). |
| "Trial personal bests are localStorage only" | **Closed.** They merge, `min` per venue. |
| "Copy `SpaceObjectives.js` — it persists by identity, not count, which is precisely the bug `Relics` has" | The `Relics` bug is **fixed**; it stores `foundIds`. Both are identity-keyed. Copy either. |
| "the eleven existing verbs" (§Phase 3 body) | Eleven is the count of **quest step verbs**. The player has **~30 mechanical verbs**. The roadmap's own §2 states this correctly and the Phase 3 body paraphrases it into an error. |
| "the progression spine — none of which exists today" | **No *vertical* spine.** Horizontal progression is substantial and load-bearing: two four-rung titled ladders, four set rewards, mount/ship power tiers, cosmetics, trial PBs. The spine must sit **above** these, not replace them. |

---

## 1. What the game is for

There is no answer today. A player arrives on a station with six gateways and is told nothing.
Everything is open from the first minute — `Portals.update` gates only on `wm.isBuilt(target)`
(`src/systems/Portals.js:3214`), which is a *load* gate, and `scheduleBackgroundBuilds`
(`src/main.js:1652`) opens all eighteen during idle time after the first frame. There is no quest,
item, level or credit requirement on any portal, world, viewpoint, trial or planet.

**Proposed objective: chart the Nexus.**

> The Nexus is a gateway network of eighteen worlds whose survey records were lost. You are the
> surveyor. Every world holds a **record** — its relics, its viewpoints, its trials, its seams, its
> wings — and completing a world's record restores that gateway's **charter**. Restore all eighteen
> and the network is whole again.

This is chosen over the alternatives for four reasons, each mechanical rather than thematic:

1. **It is made of what already exists.** Relics, viewpoints, `SpaceObjectives` ladders, mining and
   trials are all identity-keyed completion sets that already persist and already merge. A charter
   is a *name* for the union of them per world, not a new system.
2. **Its denominators are already learned, not written down.** `SpaceObjectives` derives its totals
   from what the live world publishes (`_learnElements`, `wingTotal`), which is why Phase 2 grew the
   wing set from 3 to 12 with no edits to the file. A charter must do the same: it is
   `what this world published` over `what this player holds`, so content added later counts
   automatically and no constant moves.
3. **It gives every place a distinct job** — §2.
4. **It converts the objective into the economy's missing drain** — §5.

**What it does not do:** it does not gate anything. Charters are a *record of* completion, not a key
to it. Gating the eighteen worlds behind each other would break the one thing the game currently
does well, which is that a new player can walk through any gateway and find something built.

## 2. What each place is for

Today six of the eight worlds are near-duplicates: relics + caches + a vendor + ten quests + hostiles
+ interiors. The differences that exist are real but unstated. This assigns each place one job it
alone does, and makes its record reflect that job.

> **CORRECTION, after Phase 4 implemented this.** The "Record is" column below
> contradicts §1 and §1 wins. §1 says a record is **learned from what a world
> publishes**; this column hand-writes one per world, which is exactly the
> constant that goes stale — the failure this repository records more than any
> other. Three rows were wrong on contact with the tree:
>
> - **Station.** "First trade, first mount, first gateway" implies a quick first
>   charter. The station publishes **110 relics**, so under the learn rule its
>   record is 110 relics plus its deeds, and the first charter is a long haul.
>   Phase 4 kept the learn rule. If a fast first charter is wanted it has to come
>   from somewhere other than redefining the record — a smaller opening deed set,
>   or the tutorial's own completion.
> - **The Coil.** "Centres reached" is persisted by nothing. Phase 4 made it a
>   deed off `maze:centre-found`, which is new persistence this document did not
>   describe.
> - **Dock and planets.** "Hulls flown" and "elements assayed" are not per-world
>   anywhere. Not built.
>
> Read the column below as **intent about what each place is FOR**, which still
> holds, and never as the record's definition. The definition is §1.

| Place | Its job | Record is |
|---|---|---|
| **Station** (hub, 744 m dome) | Arrival, orientation, the only place with all five shop categories | The onboarding record: first trade, first mount, first gateway |
| **Aldermoor Vale** (medieval, ±450 m) | Settlement and wildlife — the only world with beasts | Settlements visited, beasts, relics |
| **Meridian Grounds** (sports, ±200 m) | **Contest.** Four named rivals, four disciplines | The four rivals beaten |
| **Sunspire Citadel** (±450 m + regions) | **Verticality.** 109 relics, 10 viewpoints, 7 rooftop trials, free-climbing | Relics, viewpoints, seven trials |
| **Vellum Ridge** (race, ±660 m) | **Racing.** The only circuits in the game | Three circuits at three difficulties |
| **The Verdant Coil** (maze, volatile) | **Deprivation.** Weapons, mounts, climbing, parkour all off; one exit | Centres reached (repeatable, volatile) |
| **Lodestar Yard** (dock) | **The threshold.** Ships, the only route to space | Hulls flown, viewpoints, the butts |
| **Open Space** (~640 km) | **Command.** Flight, 12 encounter wings, the two ladders | Wings broken, bodies surveyed |
| **10 planets** | **Extraction.** Mine, stow, sell. No NPCs, no structures, no caches | Elements assayed, seams cut |

Two consequences worth stating plainly.

**The flight half of the game is outside the mission system entirely.** `SpaceObjectives` is the
best-built progression in the repo — two measured four-rung ladders with titles — and it is
invisible to a player who never boards a hull. Zero quests, zero vendors, zero quest managers exist
for `space` or any of the ten planets. The charter model fixes this by construction: space and the
planets contribute records like anywhere else.

**The planets are thin and should stay thin.** Land, walk, mine, stow, sell. No hostiles, no NPCs,
no structures. That is a *coherent* job — extraction — and the temptation in Phase 4 will be to
scatter quests over them. Resist it: ten planets each with a token quest is ten times the authoring
for one repeated experience. Their record is what they already produce.

## 3. The login cliff, which is the central constraint

**`QuestSystem` cannot function without a login and a live Postgres.** No quest can be accepted
(`QuestSystem.js:238`) or completed without `_playerId`; offline it degrades silently to an empty
board (`:426-442`). Every other progression system — `SpaceObjectives`, `Relics`, `Viewpoints`,
`Contracts`, minigames, races, mining — is pure local state over local events and works signed out.

So the game has two tiers whether or not anyone designed them, and a signed-out first-timer
currently has **nothing that any system acknowledges**. That is the same gap the roadmap records as
"no onboarding".

**The spine must sit on the local tier**, with the server as durability rather than as a
precondition. Concretely:

- A charter is computed from **local** identity sets and synced through `/api/game/progress`, which
  already merges without a clock and never subtracts.
- Quests *contribute* to a charter but are never *required* for one. A signed-out player can
  complete any world's record.
- Signing in is sold on **durability and cross-device**, which is now true and was not before this
  session, rather than on access to content.

## 4. The progression spine

Four layers. Only the first is new; the rest name and surface what exists.

**Charter rank (new, vertical).** Derived from worlds charted and ladder rungs cleared — never from
credits, kills or time. Derived, not accumulated: it is a pure function of identity sets, so it
cannot be farmed, cannot drift, and needs no column of its own beyond a materialised cache.

**Mastery (exists, unnamed).** Per-verb depth, already persisted: trial PBs per venue, ore cut per
element, wings per zone, kills per class. Needs surfacing, not building. Races are the gap — they
persist **nothing**, no PB ledger, no equivalent of `SaveGame._recordTrial`. Phase 4 must add one.

**Reputation (new, per-world).** Each world already has a named quest manager and a named cast.
Reputation is that world's record expressed as a relationship. It is the natural home for the
revived errands of §7 and costs no new content.

**Collection (exists, scattered).** Relics, viewpoints, cosmetics, mount and ship powers. Present,
persisted, and never shown in one place.

**Season (new, and the clock the game lacks).** §6.

**Explicitly rejected: XP from kills.** Hostiles respawn every 22 s (`Config.js:244`) and space
encounters rearm every 210 s. An XP bar fed by a respawning source is an idle game, and it is the
exact "farmable" outcome brief 5.5 forbids. Every layer above is bounded by content.

## 5. The economy: 22 faucets, 5 taps, no drain, no clock

Measured, not estimated:

| | |
|---|---|
| Whole-game faucet | **> 250,000 CR** |
| One clear of **one** world (citadel) | **≈ 39,000 CR** |
| Every permanent item in the catalogue, bought once | **≈ 43,180 CR** |

**One clear of one world out of eighteen buys 90% of everything permanent in the game.** There are
exactly **five** `spend` call sites in the tree. Credits have no decay, no upkeep, no risk; death is
free; ships are free; ammo is free because hostiles drop it every 22 s.

And the best sinks are given away: **four of the five character skins** are activity rewards
(`Relics.SET_COSMETIC`, `Viewpoints.SET_COSMETIC`, two `SpaceObjectives` tiers). That is good reward
design and a hole in the drain simultaneously.

This is a **sink problem**, decisively, and the fix must not be a tax. Upkeep, repair bills and
death costs would drain credits by making play worse.

**Proposal: the objective is the sink.** Restoring a gateway's charter costs credits, scaled to the
world. The thing you are working toward is the thing you spend on, so the drain deepens exactly as
income grows, and spending is a *choice to advance* rather than a fee for existing.

Supporting changes, in order of value:

1. **Charter restoration costs**, scaled per world — the deep sink, sized against §5's numbers in
   Phase 4 rather than guessed here.
2. **Caches pay credits and persist.** Six-plus sites per world, gated behind a real dive against an
   oxygen timer, restocking every 210 s, deterministic so players learn them — the best destination
   mechanic in the game, and it pays **zero credits** (`CACHE_TABLES`, `Caches.js:75-113`). Its
   restock is in-memory and dies on `world:changed`. Fixing both makes it the daily of §6.
3. **Separate the free cosmetics from the sold ones.** Set rewards should be items the shop never
   lists, so a reward stays a reward and the catalogue keeps its drain.
4. **Retire the dead tiers.** Mount upgrade tiers 1 and 2 (≈9,300 CR of catalogue) are unbuyable in
   practice — `preview()` refuses lower tiers once a higher one is owned, and any player can afford
   tier 3 immediately.

## 6. The retention loop

Nothing time-based exists: no daily, weekly, streak, season, login bonus or persistent restock. A
grep for all of them returns zero functional hits.

Two pieces are already built and unused for this:

- **`Caches` has the whole shape** — a timer, a destination, a restock, a per-world site list,
  deterministic placement. It needs persistence past the session and a credit line.
- **`creditPricing.ts` already fails closed** on unknown reasons, and its cap mechanism takes
  `maxEvents` over `windowSeconds`. A `daily` kind with `maxEvents: 1, windowSeconds: 86400` is a
  **non-farmable daily enforced by the same machinery that bounds every other source** — the
  "not farmable" requirement of brief 5.5 needs no new mechanism.

> **CORRECTION, from implementing this. The `daily` credit kind above cannot exist.** The cap
> mechanism is real and works, but the only route into the ledger is `POST /api/game/credits` →
> `resolveReportedEvent`, whose third statement is
> `if (!Number.isInteger(d) || d === 0) return { ok: false, reason: 'invalid' }`. **A zero-credit
> event cannot enter.** So the kind exists only if the daily *pays* — and `creditReasons.test.ts`
> separately refuses any `REASON_KIND` entry with no `economy.add` emitter, so "declare it now,
> price it later" is not available either.
>
> The conclusion ("not farmable needs no new mechanism") survives; the mechanism named does not.
> Phase 10 got non-farmability structurally instead, and better: **a daily completes only when a
> record column advances, and every record column is a content-capped identity set.** Winding the
> browser clock forward a hundred days buys a hundred day keys and nothing else. That is §9's rule
> applied to a reward rather than to a board, and unlike a rate cap it holds offline with no server.
>
> **And this section understated its own first piece.** It calls the cache restock "in-memory and
> dies on `world:changed`" as though a feature were missing. It is an **open faucet**: `_onWorld`
> cleared the site list and re-stocked every cache from scratch, so stepping through a gateway and
> back refilled the world you left. The 210 s timer was decoration — the real restock interval was
> two portal transits, and the loot converts to credits through `market` → `sell`. Closing that is a
> faucet closed, not a feature added.

**Loop:** a daily charter task drawn from the player's *incomplete* records, so it always points at
something that advances the objective; a weekly that requires a different world; a season that
resets nothing and instead names a window in which records were completed. Nothing expires —
`progressLedger` never subtracts, and a retention loop that deletes progress teaches people to stop
playing.

## 7. Verbs, and `Contracts.js`

**Eleven quest step verbs over ~30 player verbs. The gap is the design space.** The eleven —
`visit collect talk interact kill defend race purchase customize survive minigame` — all fire, with
no dead verbs; five others (`stealth investigate deliver escort craft`) were deliberately removed
after an audit found 0 of 50 quests completable. Reintroducing any of them means writing an emitter
first, and that is the rule Phase 4 should keep.

Verbs with no mission representation: climb, free-climb, swim, dive, glide, mine, pilot, transit,
dock-and-sell. **Mining and piloting are the significant omissions** — they are the entire second
half of the game.

**`Contracts.js`: revive, reframed as errands.** 347 lines that generate two seeded jobs per world,
track them correctly, and draw a marker on the minimap over an NPC — while `accept()`, `turnIn()`,
`forNPC()` and `nearestGiver()` have **zero callers** and `contracts:changed` has **zero listeners**.
Progress is gated on `state === 'active'`, which only `accept()` can set. The player sees pins for
jobs that cannot be taken.

Revive rather than delete, for one reason that outweighs the rest: **it is the only offline,
login-free, repeatable objective loop in the game.** That is exactly what §3's login cliff and the
"no onboarding" gap need, and building it fresh costs more than wiring this up. It also makes the
named NPC cast ask for something, which nothing else does.

Reframed:
- Rename to **errands** so it sits unambiguously below quests.
- Wire accept/turn-in through the existing NPC chat branch (`HUD.js:2456-2470` already resolves the
  NPC and branches on `isQuestManager`).
- Add `serialize`/`deserialize` and register with `SaveGame` — **identity-keyed**. Accepted errands
  currently die on world change and reload; this is the only genuinely new work.
- **Re-tune rewards down hard.** 165–275 CR against a minigame's 10 is a 26× outlier that would
  distort §5 the moment it became reachable. Target: between minigames and quests.

## 8. Mini-games and the shared economy

Six kinds, twelve venues, all reachable, all paying 8–18 CR on a win and **zero on a loss**. They
already feed `quest:activity{type:'minigame'}` and already write a PB ledger through
`SaveGame._recordTrial`, which now merges cross-device.

Two changes, both small:

- **A loss should pay something.** Zero for a completed contest against a named rival teaches
  players not to enter. A participation floor below the win prize keeps the contest meaningful and
  the venue used.
- **Races need the PB ledger minigames already have.** Races persist nothing today. Without it, no
  race record can exist, and Vellum Ridge's whole job (§2) has nothing to record.

Reward scale across the game is badly stratified — minigame 8–18, race 2–10, quest 60–6,800,
errand 165–275, `SpaceObjectives` rung 150–3,000. Phase 4 should place every repeatable activity on
one scale before adding to it.

## 9. Which activities are rankable

Phase 7's decision D2 lets custom-server owners author their own quests *and* share leaderboards, so
without a rule an owner mints rank with a one-step quest paying 10,000 CR. The roadmap's rule —
*platform-authored activity only, enforced at write time* — is necessary and **not sufficient**.

**The finding that changes this decision.** `completeQuestEngagement` (`site/lib/playerDb.ts`) checks
`status = 'in_progress'` and pays from `quests.reward_credits`. It **never reads `step_states`**. A
client can accept a quest and immediately POST `complete` for the full reward. The economy design's
§2 recommended ranking on "quests completed — already server-authoritative … impossible to replay",
and that is true of *replay* and false of *forging the first completion*. Server-side step
verification does not fix it either, because the client also writes `step_states`.

**So the rule is sharper than "platform-authored":**

> **Rank only on sets whose maximum is fixed by content, never on totals or times.**

A forger can reach a content cap. So can an honest completionist. The board then ranks *completion*,
and a forger merely arrives sooner at a ceiling everyone shares. That is a bounded, survivable
failure. A total or a time has no ceiling, so a forger's advantage is unbounded — which is not.

> **CORRECTION, from implementing this.** The paragraph above is right about the rule and wrong
> about why. "A forger can reach a content cap" silently assumes a forger is limited to **real
> identities**. `/api/game/progress` assumes nothing of the sort — it accepts up to 4,000 arbitrary
> text keys per group. Count a player's rows and "distinct relics found" is exactly as unbounded as
> a credit total, and the whole bounded-failure argument evaporates.
>
> **The cap only binds if the counting mechanism enumerates a manifest and clamps.** A global board
> must not count what a player holds and then remove what does not belong; it must enumerate the
> platform content manifest in the `FROM` clause and ask which of those identities the player holds
> — `FROM unnest($worlds) AS w(id) JOIN player_progress_items p ON p.scope = w.id`. A forged id is
> not in the `FROM` clause, so there is no filter to forget. Then `LEAST(n, ceiling)` for the case
> where a forgery collides with a real identity, with ceilings **sourced** rather than invented
> (110 relics per world is `Relics.MAX_PER_WORLD` — the instanced mesh cannot draw a 111th).
>
> **Two of the five rankable rows below cannot be built server-side today.** "Elements assayed" and
> "wings broken" have no server-side denominator: `ProgressSync` keeps those rosters local
> deliberately, so a device on an older build cannot hand another a denominator its own world no
> longer has. "Bodies surveyed" is in the ledger as a **value** kind — a number the client chose —
> which sits badly under a rule whose other half refuses client numbers. Declared and refused rather
> than given an invented ceiling, because a board ranked on a maximum nobody measured is precisely
> the gate-that-measures-nothing failure this document keeps naming.

| Rankable | Why |
|---|---|
| Distinct relics found | Capped by content (109 in citadel), identity-keyed, server-verifiable against the manifest |
| Distinct viewpoints synced | Same |
| Wings broken / bodies surveyed / elements assayed | Same, identity-keyed by construction |
| Worlds charted | Capped at 18 |
| Quests completed | Capped at 78 — forgeable, but only up to the cap |

| Not rankable | Why |
|---|---|
| **Credit totals** | Bounded per event, unbounded in aggregate. The economy design reached this independently: a credit board ranks whoever forged most patiently |
| **Best times** (trials, races) | Client clock, unbounded improvement, and trial PBs are editable localStorage. A forged time is not merely early, it is unreachable |
| **Kills, ore cut, anything counted** | Respawning sources; unbounded |

Enforcement stays where Phase 7 put it — **at write time**, never a read filter, because a filter is
a gate that can be forgotten and a score never written globally cannot leak. Add: the score endpoint
derives from the identity sets in `player_progress_items`, which the server already holds, rather
than accepting a submitted figure.

## 10. How the acceptance question gets asked

The brief's acceptance is a playtest: *a new player can state unprompted what the game is for, what
to do next, why a world matters, and what they are working toward.* Naming the method is part of
this phase.

**Method.** Five testers who have never seen the game. Fifteen minutes unassisted from a cold boot,
signed out, no explanation beyond "play this". No questions during. Afterwards, exactly four, asked
verbatim and in this order, recorded before any discussion:

1. What is this game about?
2. What were you trying to do just now?
3. Pick a world you visited. Why does it matter?
4. What are you working toward?

**Scoring.** An answer passes only if it is *specific* — names a world, a record, a goal.
"Exploring" fails Q1; "charting the eighteen worlds" passes. "Wandering" fails Q2; "finding the last
two relics on the mesa" passes.

**Bar.** 4 of 5 on Q1 and Q4; 3 of 5 on Q2 and Q3. **Q1 below 3 of 5 means the objective has not
landed and Phase 4 is not done**, regardless of what shipped.

Run it on the **signed-out** path, because that is the first-run experience and because §3 makes it
the tier the spine sits on.

## 11. What this does not decide

- **Charter costs and thresholds.** Every number in §5 wants measuring against real play. The house
  rule from `SpaceObjectives.js:65` applies: *"a gold nobody can reach is the same defect as a relic
  nobody can find."* Measure, do not guess.
- **Whether records gate anything.** §1 says no. If Phase 4 disagrees, that is a design change and
  belongs in a revision here, not in an implementation choice.
- **Season length and what a season does.** Named as the missing clock; not specified.
- **The quest-completion forgery.** §9 routes around it for ranking, but the hole itself — a quest
  paying without its steps — is a Phase 4 item and should be recorded as one rather than left in
  this document.

## 12. Defects found while writing this

Found while surveying, and fixed immediately after this document landed rather
than deferred — see `scripts/tests/defect-sweep.test.mjs`, which pins six of the
eight. **Item 7 turned out not to be a defect at all.**

Every one of them was silent: a missing vendor answered "No vendor nearby", a
missing loot table fell back to another world's, a double-counted step simply
completed sooner than its own label promised. None produced an error, a warning
or a failing test.

1. ✅ **FIXED. Sports had no vendor, and its quests tell players to shop there.** `WORLD_MARKETS.sports`
   exists and `merchants` is on, but no NPC carries `role: 'vendor'` and no crowd name matches
   `VENDOR_WORDS`, so `Marketplace.open()` always answers "No vendor nearby" — while
   `admin/lib/quests/sports.mjs:355,357` instructs *"Press B to open the marketplace and buy the
   medkit twin-pack"*. Two quest steps are uncompletable. `RaceWorld.js:3251` records fixing exactly
   this by adding a vendor; sports never got the same fix.
2. ✅ **FIXED. `RaceWorld` caches paid from the station table.** A `race` row was added, and the fallback now warns instead of swallowing. `CACHE_TABLES` has no `race` row and
   `Caches.js:510` falls back silently, so Vellum Ridge caches drop station loot.
3. ✅ **FIXED. Gateway 01 was signed "Ashfall Reach"; the world is "Aldermoor Vale".** The sign atlas says it
   twice; the HUD toast, the lore, the quest manager's sign and the market label all say Aldermoor
   Vale. "Ashfall" is a Citadel region *and* a Cinder landing pad.
4. ✅ **FIXED (deleted). `markStepDone` validated no step type** (`QuestSystem.js:321`) — reachable via `?dev=1`, which
   the file itself says is not a security boundary.
5. ✅ **FENCED. Untargeted quest steps match everything** (`:722`), so `{type:'kill', count:5}` with no target
   completes on any five hostiles anywhere.
6. ✅ **FIXED. `defend` double-fired** — a killing blow advances it through both `npc:killed` and
   `npc:damaged`.
7. ❌ **NOT A DEFECT.** `survive` credits every in-progress engagement per tick, which is correct: `_onPlayerDamaged` resets the accumulator, steps are world-targeted, and one tick credits at most once. If you survive an unbroken minute, every quest that asked for an unbroken minute in that world has genuinely been satisfied. Reported as a bug by the survey; verified as working and left alone.
8. ✅ **FIXED. `admin/lib/quests/index.mjs` said 73 quests; there are 78** (citadel has 15, not 10).
