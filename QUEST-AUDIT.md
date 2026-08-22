# Quest System Audit + Rebuild Plan

> ## ⚠️ SUPERSEDED — 2026-08-22
>
> Checked line by line against the tree during the implementation-brief recon.
> Its open items are closed and several of its counts are wrong, so reading it as
> current will send you to rebuild things that already exist.
>
> | This document says | The tree says |
> |---|---|
> | "REMAINING: medieval, citadel, sports, race" | All authored, plus dock. **78 quests / 398 steps**, zero dead-verb steps, 64 carrying prerequisites |
> | "wire the per-world quest modules into `admin/lib/db.ts`" | Done — `admin/lib/db.ts:19,553` |
> | "close the validator's spawn-budget blind spot" | Done — `scripts/quest-vocab.mjs:28-56` |
> | "DECISION NEEDED: repeatable" | Decided and enforced — `site/lib/playerDb.ts:646-653`, 409 `already_completed` |
> | "`DROP_TABLES` has no citadel entry" | Has citadel **and** dock |
> | "Item ids: 23 total" | **94** |
> | 1,266–1,334 tests | **2,570**, all green |
>
> It also holds `Contracts.js` up as "the model to copy". That file is
> unreachable: `accept()`, `turnIn()`, `forNPC()` and `nearestGiver()` have no
> callers anywhere, and it tracks progress against a state no code path can set.
>
> Current state: `docs/superpowers/specs/2026-08-21-implementation-brief-roadmap.md`, section 2.

## VERDICT (two independent agents converged)

**0 of 50 seeded quests are completable. ~6 of 184 steps can fire, and every one
sits inside a quest that also contains an untriggerable step.**

The seed data and the engine share NO vocabulary. Grepping the quest target
strings across the repo hits exactly two files: `admin/lib/db.ts` and
`admin/scripts/seed-quests.ts` — the seed and its copy. Nothing in `src/` has
ever heard of `relay_node`, `nightshade`, `grain_sack`, `guild_master`.

### The engine's REAL namespaces (the only things a quest may reference)

| Namespace | Source | Values |
|---|---|---|
| World ids | `static id` on World subclasses | station, medieval, sports, citadel, race, maze, survey |
| Item ids | `ITEMS` in `src/systems/ItemDefs.js` | credits, bullet, arrow, fireball_charge, medkit, speed_boost_25/50/75/100, loot_magnet_30s, portal_ping_30s, npc_pause_5s/10s/30s/60s, shield_5s, firepower_boost_25/50/75/100, alloy_scrap, nexus_shard, relic_coin (23 total) |
| Portal ids | `Portals.js:1111` | `${worldId}->${target}` e.g. `station->medieval` |
| Circuit ids | `RaceCircuits.js` | vellum, cinder, aurora |
| NPC roles | `ROLE` in `NPCRoles.js:16` | vendor, guard, loiterer, spectator, wanderer, lorekeeper, quest_manager |

Named NPCs that actually exist: Quest Managers Zara Vex (station), Edmund Marsh
(medieval), Petra Vance (sports), Aldric Storne (citadel), Kai Torres (race);
plus authored world casts (Bram Tallow, Wilda Sorrel, Rafiq the Keeper, Ines
Okonjo, Marisol Vance...). NPC ids are auto-generated `npc-N` — NOT stable.

### Root causes

- **A. Disjoint namespaces.** ~150 fictional target ids vs ~40 real ones. Intersection empty.
- **B. Five step types have NO emitter**: `stealth`(8), `investigate`(24), `deliver`(17),
  `escort`(3), `craft`(1) = 53 steps (29%). No crafting system, no delivery
  mechanic, no escort AI, no stealth meter exists.
- **C. The matcher is a LANDMINE** (`QuestSystem.js:363-366`): bidirectional
  substring, and `race:finished` pushes the bare integer `place`. So ANY race
  target containing "1" completes on a P1 finish (`100m_dash`,
  `qualifier_round1`, `vellum500_stint1`). False completions, not just misses.
- **D. `HUD.js:1650`**: `npc.id ?? npc.name ?? npc.role` — `npc.id` is ALWAYS
  truthy (`npc-N`), so name/role are unreachable dead code. Every talk/interact
  emits `npc-17`. No name- or role-based target can EVER match, by construction.
- **E. Sports races are impossible.** SportsWorld publishes no
  `trackPath`/`checkpoints`; `RaceManager._readTrack` returns null -> `arm()`
  bails. 20 sports race steps cannot work even with matching fixed.

### Bugs worse than the quests not working

1. **Rewards granted TWICE** — client `economy.add(credits)` (`QuestSystem.js:496`)
   AND server `UPDATE players SET credit_balance = credit_balance + $1`
   (`playerDb.ts:555-573`).
2. **Reward amount is client-supplied and forgeable.** `creditsRewarded` comes
   from the POST body; the server never re-reads `quests.reward_credits`.
   Live economy exploit.
3. **`pre_steps` enforced NOWHERE** — display-only at `QuestBoard.js:271`.
   Cross-world gating has no foundation.
4. `visit` double/triple counts (advanced at `QuestSystem.js:57`, `:166`, `:248`).
5. `_flushSync` skips non-`in_progress` (`:535`) -> final step-state write dropped.
   No `beforeunload` flush; up to 10s of progress lost on reload.
6. `player:identity` listener dead — emitter sends `{handle}`, listener wants `{playerId}`.
7. Cross-world engagements resolve `quest: null` -> permanently-stuck blank rows.
8. `survive` is semantically INVERTED — taking damage advances it.
9. `markStepDone` has zero callers; QuestBoard shows a static `'Auto'` label.
   A player who accepts a quest can never finish it by any means.
10. `admin/lib/db.ts:487` seeds a `world:'citadel'` step inside a medieval quest —
    only advances in citadel, but is only listed in medieval.

### The model to copy

`src/systems/Contracts.js` is a WORKING, event-grounded quest system. Its header
states the principle the seeded quests violate: *"each of which reuses a system
that already exists and needs no new verbs from the player."* Bounty (kill N),
supply (bring N of an item), survey (find a cache).

## AGREED PLAN (user decisions)

- **Approach: HYBRID** — fix the matching layer + add emitters, THEN rewrite all
  content against verbs the engine actually proves.
- **Station: 10 story + 10 education + 3 global = 23.** Other worlds stay at 10.
- **UX: quest hotkey + HUD objective tracker + quest-aware NPC clues.**
  (In-world markers explicitly NOT in scope.)

### Phase 1 — Engine / matching — DONE AND VERIFIED IN GAME
- [x] `HUD.js:1650-1681` emits full identity `{target, npc, id, name, role}`;
      `target` leads with NAME (what a quest author writes)
- [x] Matcher anchored: exact equality OR whole-token contiguous run
      (`_tokenRunMatch`). Bare-integer `place` replaced with `place_N`/`pN`.
- [x] `race:finished` + `race:lap` carry `circuitId`, `circuitName`, `raceType`
- [x] Server re-reads `quests.reward_credits`; client no longer sends it
- [x] Double grant removed — server authoritative, client mirrors the returned
      balance (could NOT just delete `economy.add`: `main.js:297` pushes
      `credits: economy.credits` to `/api/game/state` which SETs credit_balance,
      so a stale local balance would have wiped the grant within ~1.5s)
- [x] `pre_steps` enforced across ALL worlds on accept; 409 + `missing[]`
- [x] visit de-duplicated per world entry (`_visitEpoch`/`onceToken`);
      a FOURTH call site was found (`portal:entering`, naming a world not yet
      reached) and deleted
- [x] `_flushSync` allows the final completed write; `pagehide`/`beforeunload`/
      `visibilitychange` flush via `sendBeacon`

**Bugs found by the agents that were NOT in the brief (all fixed):**
- IDOR: `updateQuestStepStates`/`failQuestEngagement` keyed on engagement id
  only — any player could overwrite another player's progress. Now
  `AND player_id = $4`.
- `ensureQuestSchema` set its memo flag BEFORE awaiting the DDL — concurrent
  callers could query columns that did not exist yet. Now memoises the promise.
- `race:lap` fires for EVERY entrant — a nine-car race credited nine laps to the
  player. Now guarded on `isPlayer`.
- Completion made idempotent via a single data-modifying CTE matching only
  `status='in_progress'` — replays/concurrent requests credit nothing.

**VERIFIED IN THE RUNNING GAME (browser, gameplayDriven=true):**
- Matcher 17/17: rejects the three named false completions
  (`100m_dash`, `qualifier_round1`, `vellum500_stint1` on a P1 finish) and a
  wrong-circuit target; accepts circuit id, `place_1`, `p1`, `first`, NPC name,
  NPC role, surname token, real item id, world visit.
- Full lifecycle 9/9: `loot:collected` x2 (real item id) advanced step 1, a WRONG
  item did not advance it, step completed at count, percent 0->50->100,
  NPC-name payload advanced step 2, quest marked `completed`,
  `quests:quest:complete` emitted. **First quest ever to complete in this game.**
- 1266/1266 unit tests still pass.

### STILL OPEN after Phase 1
- [ ] `accept` 409 `{reason:'prerequisites', missing:[]}` is swallowed by
      `QuestSystem.accept()` (`:145` throws on any non-OK) -> player sees a
      generic "Could not accept quest" instead of which prereqs are missing.
- [ ] `_onRaceFinished` does not check `dnf` — a circuit-targeted race step
      completes on a DID NOT FINISH.
- [ ] `survive` still semantically inverted (taking damage advances it).
- [ ] **DECISION NEEDED — completed quests can be re-accepted and re-paid**
      (accept->complete->accept->complete farms credits). Schema has no
      `repeatable` flag; blocking it silently makes all 50 quests one-shot.
      Recommendation: add `repeatable BOOLEAN NOT NULL DEFAULT FALSE`.
- [ ] Local dev cannot round-trip quests: `/api/game/quests` 404s because vite
      proxies `/api` to the chat server (8787). Content verification needs the
      Next site running on :3000, or direct injection as used above.

### Phase 2 — UX — DONE AND VERIFIED IN GAME
- [x] **J hotkey** opens/closes the board anywhere (fixed key, not rebindable —
      `Input` stops reporting while a panel holds the keyboard, which is exactly
      when you need to close it). Calls `openBoard()`, previously zero-callers.
- [x] **HUD objective tracker** `.panel.questtrack` — mounted as the last child
      of the `.vitals` column because EVERY corner is already occupied
      (credits/health/stamina TL, minimap+killfeed TR, ammo BR, help chip BL,
      prompt/mount BC, toasts TC). Renders via `textContent` (authored DB data).
- [x] **Quest-aware NPC clues** — `QuestSystem.summary()` (capped at 3 quests,
      same shape QuestBoard draws) threaded through ChatBox -> ChatClient as its
      OWN payload field (never via `persona`, truncated at 700 chars server-side).
      Both live prompt builders updated with clue-not-walkthrough instructions.
- [x] `accept` 409 now surfaces WHICH prerequisites are missing
- [x] DNF no longer completes a race step
- [x] `survive` RE-GROUNDED not removed (one count per 30s damage-free;
      `player:damaged` zeroes it). Removing it would have left a step type an
      author can write and no player can complete — the exact defect class
      behind "0 of 50 completable".

**Latent break the agent caught:** raising `MAX_TOKENS` to 400 would have pushed
chat bodies past `MAX_BODY_BYTES` (16 KiB); an oversized body is rejected as
`bad-request`, which `ChatClient` reads as a dead backend and **latches offline
for the whole session**. Raised to 64 KiB.

**VERIFIED IN GAME:** 10 real DB quests load; J opens board / ESC closes;
`summary()` returns the active quest with step detail; tracker shows
"Objective / title / step label / 0-3", updates to 1/3, quest completes at 3/3,
tracker hides when nothing is in progress. (Two earlier "failures" were a wrong
test selector matching the RACE ui `rc-tracks`, not a code fault — 7th selector
mistake of the session. Look the class up; never guess it.)

### LOCAL VERIFICATION RIG NOW WORKS
`vite.config.js` proxies `/api/game` -> `127.0.0.1:3000` (Next site) while
`/api` still goes to the chat server on 8787. `site/.env.local` holds pulled
production env (gitignored; site/ is now vercel-linked). Run `npm run dev` in
BOTH root and `site/`.
Quest POSTs return **401 without a login**, so local testing CANNOT write to
production player tables — reads only. This is a large part of why broken quest
data went unnoticed: in dev the quest board was always silently empty.

### Phase 3 — Content rewrite
- [ ] All 50 existing quests re-authored against real vocabulary
- [ ] Station +10 education (function keys, movement, mounts, weapons, NPC chat,
      merchant buy/sell, inventory, portals)
- [ ] Station +3 global multi-world mega-quests
- [ ] Cross-world prerequisites
- [ ] Step counts spread 1-10 (currently only 2-5)

### Phase 3 — STATION DONE (23 quests / 132 steps), 4 worlds remain

`admin/lib/quests/station.mjs` — 10 story (n 1-10), 10 education (n 101-110),
3 global (n 201-203). Steps-per-quest covers every value 1..10. Zero use of
investigate/deliver/escort/stealth/craft.

**THIRD ENGINE BUG FOUND AND FIXED: collect double-counted.**
`Loot.js` emitted BOTH `loot:collected` AND `quest:activity{type:'collect'}` for
one pickup, and QuestSystem subscribes to both — every real pickup advanced a
collect step by 2. Removed the redundant emit (`quest:activity` has exactly ONE
listener; `loot:collected` is canonical and has five other consumers).
VERIFIED in game: held 4->5, progress 0->1, one event. All 26 collect counts in
station.mjs were then halved — the content had been authored around the bug.
NOTE: stack `qty` is still ignored — `count` means NUMBER OF PICKUPS, so a cache
of 8 relic_coin advances a step by 1.

### THE BIG LESSON — "declared in source" != "spawns in game"

I told the content agents that Quartermaster Bex, Broker Sunil Rai, Deck Warden
Ilse and Warden Cato Reyes were valid station NPC targets. **They are not.**
`ROLE_CAST.station` names are only ever handed out by the crowd filler, and
StationWorld authors 42 civilians + 6 gateway lorekeepers against
`friendlyBudget = 50` (`StationWorld.js:10466`) — so `_populateHubs` gets just
TWO slots (`vendor`, `loiterer`). Every other cast name is unreachable ON THE
STATION. (The same names DO spawn in `race`, which has no cast of its own and
falls back to the station cast with budget to spare — which is why the earlier
inventory audit saw "Quartermaster Bex" standing in the race world.)
Also: **no station NPC has role `guard`** — every authored `role:` in
`StationWorld.js` and `station/zones/*.js` is `vendor` or `quest_manager`.

**I was also WRONG that `interact` only works on the 5 NPCManager quest
managers.** Worlds author their own; `NPCManager.js:742` honours
`isQuestManager: spec.isQuestManager === true`. The station has SIX:
Zara Vex, Dispatcher Ovie Kanu, Officer Doriane Kest, Meret Duhamel,
Purser Oleander Vance, Planner Imke Solberg. Zero interact->talk conversions
were needed.

**THE VALIDATOR HAS THIS SAME BLIND SPOT.** `scripts/quest-vocab.mjs` checks a
name is DECLARED in source, never that a body carrying it gets a spawn slot. It
still accepts `guard`, `spectator` and all four ROLE_CAST station names. This is
exactly the "verified BUILT, never verified REACHABLE" trap from the medieval
expansion — now living inside the tool built to prevent it. MUST BE CLOSED:
the vocabulary needs to be per-world AND spawn-budget aware.

### Other content defects found and fixed on station
- Q10 steps 1 and 10 both read `interact/Zara Vex/station`. `_advanceSteps`
  walks EVERY step per event, so one E press cleared both and the whole capstone
  between them could be skipped.
- Buying is gated by `vendorCategories` — bullet packs need a `weapons` vendor,
  medkits a `health` one. Selling is ungated (`Marketplace.sell` has no check).
- `DROP_TABLES` has no `citadel` entry and falls back to the station table, so
  citadel `relic_coin` comes from caches only.

### REMAINING
- [ ] medieval (10), citadel (10), sports (10), race (10)
- [ ] Close the validator's spawn-budget blind spot
- [ ] Wire the per-world quest modules into `admin/lib/db.ts`
- [ ] SPORTS: 19 race steps are impossible — SportsWorld publishes no
      `trackPath`, so `RaceManager._readTrack` returns null and `arm()` bails.
      Either author non-race objectives, or define a sports track. USER DECISION.

### Phase 4 — VERIFIED AGAINST PRODUCTION

Seeded production: **63 quests / 352 steps upserted** (`npx tsx admin/scripts/seed-quests.ts`).
Pre-seed safety check was clean: 0 stale operator rows, 0 in-progress
engagements (2 completed / 5 failed), `repeatable` column already applied.

Production DB now reads:
  station 23, medieval 10, sports 10, citadel 10, race 10  = 63
  352 steps | **0 dead-verb steps** (was 53) | 35 cross-world | 50 with prereqs
  10 education quests (101-110) | 3 global quests (201-203)

**PROVEN IN THE RUNNING GAME (6/6):** 23 production quests loaded from Postgres
through the new `/api/game` proxy; education and global sets present; then a REAL
production quest driven to completion:

  Quest #1 "Signal Boost" - "Get the concourse beacon array back on the air"
    step 1  interact: Zara Vex     x1  -> done
    step 2  collect: alloy_scrap   x2  -> done
    status: completed, percent 100, `quests:quest:complete` emitted

That same quest_number previously read `visit:relay_node` + `interact:beacon_array`
- both fiction, neither able to fire.

Full suite: **1289/1289** (was 1266; +23 quest-content tests).

### ENGINE BUGS FOUND AND FIXED THIS AUDIT
1. Quest reward forgeable (client-supplied `creditsRewarded`; server never read
   `quests.reward_credits`) - live economy exploit
2. Rewards granted TWICE (client `economy.add` + server UPDATE)
3. IDOR: `updateQuestStepStates`/`failQuestEngagement` keyed on engagement id
   only - any player could overwrite another player's progress
4. `ensureQuestSchema` set its memo flag BEFORE awaiting the DDL
5. collect double-counted (Loot emitted both `loot:collected` AND
   `quest:activity`) - every pickup counted twice
6. Bug #7: cross-world engagements resolved `quest: null` on reload and were
   permanently stuck - hit **40 of 63 quests** on ANY reload, not just globals
Plus: `race:lap` credited every entrant; DNF completed race steps; `survive`
inverted; visit triple-counted; `_flushSync` dropped the final write.

### STILL OPEN
- [ ] Local dev needs BOTH servers (`npm run dev` in root AND `site/`)
- [ ] If a `quests` row is ever DELETED, `quest_id` goes NULL and
      `quest_steps` is NULL, so that engagement is still stuck. Fix pattern:
      `ALTER TABLE player_quest_engagements ADD COLUMN IF NOT EXISTS steps TEXT`
      written at accept (mirrors `quest_line`/`reward_credits`).
- [ ] `purchase` validation checks only that a vendor role exists, not
      `vendorCategories` (bullets need a `weapons` vendor).
- [ ] Cache GEOMETRY is not modelled by the validator - a world's cache table is
      trusted even if its terrain yields no dive site. The one place it over-accepts.
- [ ] SportsWorld still publishes no `trackPath` - racing there remains
      impossible. Its 10 quests deliberately contain ZERO race steps.
- [ ] 25 marketplace rows (`admin/_mktseed.mjs`) from the inventory audit
