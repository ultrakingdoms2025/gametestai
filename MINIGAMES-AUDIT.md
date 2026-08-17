# Sports Minigames — build + verification state

Goal (user): tennis vs NPC / swim challenge / ski run at real venues; prompt on
approach; start/stop with quit mid-match; best-of-3 tennis; 10 CR on a win;
animations; then quests wired to them. Contests are ABSTRACTED (user-confirmed).

Test rig: `npm run dev` in BOTH root and `site/`; drive
`http://localhost:5173/game/?dev=1&autostart=1&world=sports` via Chrome MCP.
ALWAYS `await HARNESS.ready()` + assert `gameplayDriven === true`.
Systems: `window.GAME.minigames` (manager), `.minigameUI`, `.player.minigamePose`.

## Recon facts that shaped the design (all measured)

- Animation is FULLY PROCEDURAL — no clips/mixer/GLTF characters. 26-bone
  skeleton (`Humanoid.js`), poses computed per frame. New animation = 60-100
  lines of bone rotations (`Swim.js:415 set()` helper is the pattern).
  Late poses MUST go through `Player._installLatePose` or they are discarded.
- NOTHING in this game bounces; Rapier is in package.json but imported by
  nothing; physics is hand-written and kinematic. Tennis ball is therefore
  cosmetic-kinematic (parabola lerp), per the abstracted-contest decision.
- The player is DELIBERATELY immune to slope-sliding (`Player.js:851` comment).
  Ski run therefore rides the existing hoverboard mount (terrain-following
  suspension + snowboard stance pose already exist).
- No trigger/zone system existed; `COLLISION_LAYER.TRIGGER` is a dead constant.
  The framework adds venue descriptors following the `enterables` convention.
- Venues are REAL: regulation ITF tennis court + net at (112,26); 8-lane pool
  x32..60 z103..119 (swimming already worked there); 52m ski mound with 3
  collidable pistes at x=-96,-62,-32. Opponent NPCs already stand at each venue
  (Deborah Quint-Halloway / Tavius Okonkwo / Kjell Nordvik).

## FRAMEWORK + SWIM — BUILT AND VERIFIED IN BROWSER

Files: `src/minigames/MinigameManager.js`, `SwimChallenge.js`, `MinigamePose.js`,
`src/ui/MinigameUI.js`, `minigame.css`, venue list at `SportsWorld.js:8852`,
wiring in `main.js` (:280-286, :1345, :1399, :1414, :1574), HUD prompt branch
(:2473) + KeyE guard (:1773), 4th late-pose slot (`Player.js:1223`).
Tests: `scripts/tests/minigame-swim.test.mjs` — suite total 1304 passing.

**Browser-verified (12/14 lifecycle + 4/4 prompt + cold-load check):**
- E-prompt "Start the Lido Swim Challenge" appears on approach
  (300ms warm, 900ms cold — the one "failure" was my 1.2s test window racing a
  slow cold boot; not a product bug, confirmed by non-reproduction)
- KeyE (real synthetic keypress) starts the countdown
- countdown -> playing; clock starts only on first wall touch
- 2 lengths x 24m tracked; walking the deck is worth zero
- WIN -> exactly +10 credits (0 -> 10), `hud:notify` "won — +10 credits"
- `quest:activity {type:'minigame', target:'swim_challenge', won, place, score}`
  emitted on finish; verified it matches a QuestSystem step via default branch
- `minigame:finished` full result payload (splits, margin, rivalName Tavius)
- ABORT: returns to idle, pays NOTHING, emits NO quest event
- Zero `__HARNESS_ERRORS__` throughout

Known limitations (deliberate, flagged):
- Rival is a GHOST (paced split-time), not a swimming NPC — NPC ground-following
  cannot safely enter water; `_rivalDist` is the hook when NPC swimming exists.
- Quest matcher cannot express "WIN the game" vs "play it" — `won` is in the
  payload but `_matchesStepTarget` doesn't read it. Needs a QuestSystem
  addition when quests are wired (planned: a `minigame` candidates branch).
- Prompt holds its last value while a menu is open (same as interiors; kept).

## SKI + TENNIS — BUILT AND VERIFIED IN BROWSER (all three games proven)

Built by a 2-builder + 1-integrator workflow. Integrator caught two spec bugs:
the `_minigameLock` placement would have left a locked NPC deaf to gunfire
(moved BELOW the FLEE dispatch), and TennisMatch's nav re-assert fought its own
flee override (module stands down while `npc.state === 'FLEE'`).

**TWO ENGINE BUGS found ONLY by browser verification (unit tests structurally
blind to both):**

1. **Tennis was unwinnable in the real game.** `TennisMatch._frame` read
   `input.pressed('KeyF')` — but that hook registers at MATCH START, so it runs
   after main.js's boot-registered frame callback, whose last act is
   `input.endFrame()` clearing the pressed set. `pressed()` was always false
   there BY CONSTRUCTION. Measured: 44 correctly-timed in-window presses across
   two matches, 0 returns, 0-8 points. The 18 unit tests passed because the
   bare harness has no engine hook and takes the fixed-tick poll path.
   FIX: new `Input.held(code)` (level-trigger, same rebind resolution,
   `Input.js` after `pressed`) + edge-detection in `_frame`
   (`TennisMatch.js`), + the test fake gained `held` to model reality.
   LESSON: registration ORDER vs `endFrame` is a real contract — any
   late-registered frame hook must never read `pressed()`.
2. **Programmatic `reset()` while the result card was up deadlocked gameplay
   forever.** The card's `minigame:menu {open:true}` block froze fixedUpdate,
   and the `minigame:started` that would close the card is emitted FROM
   fixedUpdate. Self-sealing. FIX: `reset()` emits `minigame:reset`;
   MinigameUI closes both sheets on it (idempotent, recursion-safe).

**TENNIS verified 9/9:** player WINS 2-0 (8 points, longest rally 14),
+10 credits exactly, `quest:activity` with `won:true`, Deborah locked during /
unlocked + patrol restored after, ball cleaned up, quit pays nothing,
post-reset countdown ticks (deadlock gone). Swing = F, one press per window;
spam is punished as a committed early whiff (anti-mash design, verified live —
a spamming autoplayer lost 0-8, a one-press-per-window player won 2-0).

**SKI verified 8/9 + payout re-proven:** auto-mounts the hoverboard, 10 gates
on the weaving piste, centreline-only descent misses gates (they alternate
offsets — real slalom), threading all gates -> passed 10/10, won, dismounts
cleanly, ghost-loss run pays nothing and still emits the quest event.
The one "failing" check (delta=130) was ENVIRONMENTAL INCOME — cache/relic
pickups swept during a 65 m/s descent. Controlled ledger re-run: exactly one
credit event `{delta:10, reason:'minigame'}`. Note: a player CAN moonlight as
a loot collector mid-run; accepted as charming, not fixed.

**Driving mounted runs from automation:** while mounted, the MOUNT owns
position — teleporting `player.position` snaps back. Drive
`G.mounts.active.position` instead. (Cost one wasted descent to learn.)

Full suite: **1333/1333.**

## QUEST WIRING — DONE, VERIFIED IN VIVO, SEEDED TO PRODUCTION

**A design flaw in MY prescribed candidate list was caught by the agent:**
pushing bare `tennis_match` beside `tennis_match_won` lets a LOSS complete a
"win" step through the bidirectional token-run matcher, and a bare `won` token
cross-completes other games' win steps. Corrected: the composite CARRIES the
identity; plainer spellings match THROUGH it. Candidates: always
`name`+`venueId`; on win `<gameId>_won`+`place_1`/`p1`/`first`; on loss
`<gameId>_lost`; bare `gameId` only when `won` is not boolean (legacy).
NEVER pair target `X` with `X_won` in one quest (subrun rule, in the header).

**In-vivo proof (real matches, real engagements, browser):**
- WIN 2-0 -> `tennis_match_won` done, `tennis_match` done,
  `swim_challenge_won` NOT done (3/3)
- deliberate pre-window early-swinger LOSES 0-2 -> `_won` NOT done,
  any-result done (3/3)
- NOTE the spam finding inverted post-fix: banner==window, so spam-during-
  banner now WINS (in-window presses). A true loss needs pre-window presses.

Validator derives the minigame vocabulary (games from `registerGame` calls
resolved against main.js imports; venues scraped; per-world: sports 15
candidates, all other worlds `[]`). `minigame` auto-classified UNGATED by the
gate derivation. `sports.mjs` reworked: n25 ski_slalom_won, n26
swim_challenge_won, n28 all three any-result, n29 tennis_match_won, n30
capstone all three `_won`. Tests 1334/1334, quest-content 24/24, 0 findings.

**SEEDED:** 63 quests / 352 steps upserted; production API serves 10 sports
quests with 9 minigame steps (6 win-only). Full chain live:
venue -> E -> play -> win -> quest advances -> server-authoritative reward.

## /loop MATRIX — ALL MEASURED (final iteration)

- [x] **Walk-up prompts, all three venues** — approach by continuous movement;
      tennis @step 22, ski label is "Meridian Downhill". Prompt HIDES within
      200ms of leaving (the DOM keeps stale text inside the hidden box — never
      assert on textContent without a visibility check; test bugs #11-#13 all
      did exactly that).
- [x] **Inventory powers during play** — speed boost measured in water:
      ratio 1.01 (NOT applying) -> judged an oversight (ground applies, air
      refuses WITH a comment, water had neither) -> `Swim.js` now multiplies by
      `player.speedMultiplier` -> re-measured ratio exactly **1.50**.
      First re-measure hit the pool WALL (7.5m of water, 7.6m displacement) —
      moved to the deep end for 24m of open water. Mount deliberately
      unaffected (ratio 1.01): vehicles have their own mount_power tier.
- [x] **Cross-game session** (swim abort -> ski abort mid-run -> tennis quit):
      no leaked blocks, dismount clean, zero slalom props or ball meshes left.
- [x] **Deborah after QUIT** — locked during, unlocked on abort, and in WANDER
      with desiredSpeed 1.5 / nav active / no residue; moved 14.7m in 20s.
      (An 8s watch window read 0.00m — she was mid-idle-beat. Watch >= 20s.)
- [x] **Reload mid-match** (mounted, playing): clean boot 6/6 — idle, no
      blocks, unmounted, no orphan props, prompt + fresh start work.
- [x] **The E-quit sheet** — a stray E at the venue mid-run opens the quit
      confirm BY DESIGN (comment at MinigameUI:73), which PAUSES the contest
      (block freezes fixedUpdate — correct for a modal). Escape resumes; the
      interrupted run then finished and WON. Reproduced deterministically.
      Automation note: after E-starting a game, any further E near the venue
      is a quit request — drive `start()` directly or expect the sheet.
- [x] **PRODUCTION QUEST n26 "Deep End Duty" COMPLETED VIA REAL PLAY, 100%**:
      E-talk Tavius -> 2 real medkit pickups -> swim challenge won (real E
      start; mid-way the quit sheet opened off a stray E edge, Escape resumed,
      still won) -> 2 Rogue Security Units killed via their real
      `applyDamage`/`die` path -> "Peaked cap" clicked in the real F2 wardrobe
      (`.ch-chip` exact-text; clicking the chip CONTAINER matches nothing) ->
      E-talk the gateway lorekeeper. Engagement `completed`, percent 100.
      (Server POST 401s without login — write-protection working as designed.)

Full suite: **1334/1334**. Loop STOPPED — matrix complete, fixes verified.

## AFTER BUILD — the /loop test matrix (user-specified)

Per game: animations visible · start · stop/quit · score correctness · credit
allocation (+10 win, 0 loss/quit) · INVENTORY POWERS during play (speed boost
while swimming/skiing — does it apply? should it? measure, then decide) ·
quest lines wired and completing. Plus: prompt via natural walk-up (no
teleport), Deborah's patrol restored after quit, no cross-game state leaks
(swim -> ski -> tennis in one session), reload mid-match behaviour.
