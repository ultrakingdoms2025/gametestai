# AETHER NEXUS — Implementation Brief Roadmap

**Source:** "AetherNexus AI Coding Agent Implementation Brief" (7 pp), supplied 2026-08-21.
**Status (2026-08-23):** Phases 0-8 and 10-11 SHIPPED to main and production. Phase 9 is
four worlds of nine done and shipped (`station`, `medieval`, `citadel`, `dock`); `sports`,
`maze`, `space` and a cross-world `art-loot` branch are in flight; `race` and `planets` are
not started and need `VIEWS` entries in `src/dev/Harness.js`, which they do not yet have.
Phase 12 (production E2E) is deliberately last, so it tests the finished whole.

Eleven production deploys, each verified in LIVE BYTES rather than by assuming the push
landed - by fetching the hashed asset and comparing its hash to the local file, and by
grepping the live chunk for STRING LITERALS (symbols do not survive minification, and a
symbol search returns a confident false negative).

The four decisions in section 8 were taken 2026-08-22 and are folded into the phases below.

**This status line was itself stale for a whole session** - it read "Not started" while
eleven phases were live in production. That is the failure this repository has been bitten
by repeatedly: a planning document that is wrong in the direction of optimism, and later
work planned from it. Re-read the tree before you plan from this file.
**Basis:** four-agent recon of 2026-08-21 against `main` @ `86f3cdb`, clean tree. Every claim
below was read out of the tree or measured; none is assumed.

This document turns a 7-page brief into phases that can each be built on their own branch,
merged, deployed and verified. Each phase gets its own design spec and implementation plan
under `docs/superpowers/` when it starts — this file is the map, not the plans.

---

## 1. Read this first: four live production problems

Found while sizing the brief. None is in the brief. Three are live right now.

| | Problem | Evidence | Why it matters |
|---|---|---|---|
| **P1** | **Marketplace admin is unauthenticated in production.** `requireMarketplaceAdmin()` returns `true` when the allowlist is empty as a "bootstrap-safe default", and neither `ADMIN_EMAILS` nor `MARKETPLACE_ADMIN_EMAILS` is set in production. | `site/lib/adminAccess.ts:23` | Any signed-in user can create, edit and delete catalogue items and set `cost_buy`/`cost_sell` — the economy's prices. Fix is one env var plus failing closed. |
| **P2** | **The client sets its own credit balance.** `POST /api/game/state` does `SET credit_balance = $1` from `body.credits` with only a `>= 0` check, every ~1.5 s. | `site/app/api/game/state/route.ts:44-53`, `site/lib/playerDb.ts:295-310` | Directly monetisable once payments are live. Blocks anti-farming (4.1.4), economy protection (5.5) and every credit leaderboard (5.6). |
| **P3** | **Payments are simulated in production.** `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are both empty. `/api/checkout` returns `/api/confirm?simulated=1`, which grants access and credits on a query string; `/api/webhook` returns 503 with a `TODO(accounts)` where the DB write belongs. | `site/lib/stripe.ts`, `site/app/api/confirm/route.ts` | Nothing has ever been charged. **Brief section 4.1.4's "premium access purchasable from the website" cannot exist until this is real.** |
| **P4** | **No CI, and the deployed game is a hand-committed artifact.** No `.github/workflows`. `bundle-game.mjs --if-available` exits 0 on any failure and keeps the previously committed bundle. | `site/scripts/bundle-game.mjs`; `git ls-files site/public/game` = 59 files | 2,570 tests, a vitest suite and `contract-check` never run on push, and a broken game build ships silently as a stale bundle. The commit history records this happening. |

Same family, lesser: `/api/service` is an unauthenticated bypass prefix in `admin/proxy.ts`
for a route that does not exist; `/api/health` publicly leaks env-var presence and the
database hostname; `admin/proxy.ts:7` falls back to a hardcoded session secret where
`admin/lib/session.ts` correctly throws; Postgres opens a new TCP connection **per query**
(one `/api/user/me` does 5+); two user tables (`site_users`, `players`) and two entitlement
stores (an `an_pass` cookie whose own docblock still says *"there is no database in this
project and no login"*, and `players.access_granted_at`) coexist and disagree.

**These become Phase 0** — not because the brief asked, but because several brief items are
unbuildable on top of them.

---

## 2. What already exists (and must not be rebuilt)

| # | Established fact | Evidence |
|---|---|---|
| 1 | **Mission machinery is built and hardened.** `QuestSystem.js` (1,119) tracks **eleven** step verbs — `visit collect talk interact kill defend race purchase customize survive minigame`. The server path is genuinely authoritative: reward re-read server-side, idempotent single-statement CTE, IDOR closed, `repeatable` enforced with a 409, prerequisites enforced with a `missing[]` list. | `src/systems/QuestSystem.js`, `site/lib/playerDb.ts:646-791` |
| 2 | **78 quests / 398 steps** exist across six worlds, with **zero dead-verb steps** and 64 of 78 carrying prerequisites. | `admin/lib/quests/*` |
| 3 | **Quest content is validated against the engine.** `quest-vocab.mjs` (2,369) derives the legal id vocabulary from the sources the game reads — including NPC **spawn-budget arithmetic**, not just declarations — after "0 of 50 seeded quests were completable". | `scripts/quest-vocab.mjs:1-56` |
| 4 | **Backend infrastructure is real.** next-auth v5 (Google + credentials + TOTP), Neon Postgres, an admin app with bcrypt + TOTP + iron-session and an **HMAC-chained tamper-evident audit log**, 505 seeded marketplace items, server-priced Stripe checkout. | `site/lib/auth.ts`, `admin/lib/db.ts` |
| 5 | **All art is procedural.** No rigs, clips or character meshes are loaded. Aim / fire / rest posing already exists via analytic two-bone IK. | `src/npc/Humanoid.js` (5,055), `src/npc/NPCAnimator.js:344,349,770` |
| 6 | **A proven authored-asset pipeline exists**, used twice: procedural `.glb` from a committed Node script, then `manifest.json`, then a lazy loader, then a byte-diff licence test. glTF materials are discarded; assets contribute geometry only. | `scripts/make-ship-glb.mjs`, `src/ships/ShipAssets.js` |
| 7 | **Six minigame kinds across 12 playable venues** (sports 4, citadel 7, dock 1), wired to quests. | `src/main.js:440-486`, `src/minigames/` |
| 8 | **NPC dialogue is a streaming LLM with an offline persona fallback**, so it visibly works with no API key. Quest clues ride as their own field, never folded into persona. | `src/ai/ChatClient.js` |
| 9 | **Production perf is already diagnosed.** Three keys its shader cache on light count, so every weapon / mount / world change invalidates ~390 programs; boot "warms" by playing the cartesian product. | `TODO-V4.md` items 2, 4, 5 |

### And what genuinely does not exist

| Gap | Detail | Brief item it blocks |
|---|---|---|
| **No XP, levels, reputation, mastery or faction** | Zero hits repo-wide; no such column in `players`. Progression today is horizontal: `SpaceObjectives.js` (2,051) paid tier ladders, relics, viewpoints, mount/ship tiers, cosmetics, trial PBs. | 5.5 entirely |
| **No realtime layer of any kind** | Zero WebSocket / presence / multiplayer code. "Chat" is single-player LLM NPC dialogue over SSE. Vercel functions cannot host a persistent socket. **Note: shared leaderboards do NOT need this** — they are periodic HTTP reads against Postgres. Only presence and live events would. | 4.1.4 player-to-player chat; 5.6 live events |
| **No onboarding** | Nothing runs once on first play. The de-facto tutorial is station quests 101-110, which need a login and live Postgres to appear at all. | 5.1 |
| **No dailies, weeklies, seasons or leaderboards** | Only an in-race live position board. Trial personal bests are **localStorage only**. | 5.2, 5.6 |
| **No touch input; the game cannot start on a phone** | Gameplay is gated on pointer lock, which iOS Safari does not implement. | 4.1.3 |
| **Remote save is a strict subset of local save** | Relics, viewpoints, objectives, trials, piloting, mining and character config are localStorage-only and do not cross devices. | 4.1.3 cross-device play |

### Two housekeeping findings

- **`Contracts.js` is unreachable content.** ~370 lines; `accept()`, `turnIn()`, `forNPC()`,
  `nearestGiver()` have zero callers. It tracks progress against `state === 'active'`, a state
  no code path can set, and `contracts:changed` has no listener. Either wire it into Phase 4 or
  delete it — but do not leave it as a model to copy, which is what `QUEST-AUDIT.md` calls it.
- **All three audit docs are materially stale.** They report 1,266-1,334 tests (actual **2,570**),
  63 quests (actual **78**), three minigames (actual **six kinds / 12 venues**), and several
  "open" items that are closed. Refresh or retire them in Phase 0; they are actively misleading.

**Scale:** 241 source files, 245,223 lines of game JS, 190 test files, **2,570 tests all green**,
114 contract files, nine worlds plus ten planets, 3.28 MB main JS chunk, 41 MB `dist`.

---

## 3. The two things the brief needs but does not name

**(a) Server authority over the economy.** The brief demands anti-farming (4.1.4), economy
protection (5.5) and credit leaderboards (5.6) without noticing that credits are a number the
client posts (P2). The quest reward path is already the correct shape — copy it outward rather
than invent something new. Promoted to Phase 2 by decision D3.

**(b) A stable perf baseline before art.** Section 4.1.7 wants "realistic and highest-quality
that remains performant" while 4.1.2 says production is already slower than local. Art first
would measure every world against a moving floor.

---

## 4. Phases

One branch per phase, off `main`, merged back before browser-testing anything dependent
(brief section 1). Sub-phases share a prefix and merge to their parent first.

| # | Phase | Branch | Depends on | Size | Deploys? |
|---|---|---|---|---|---|
| 0 | Security and production integrity | `prod-integrity` | — | M | yes |
| 1 | Production smoothness | `perf-production` | — | M | yes |
| 2 | Economy integrity (server authority) | `economy-authority` | 0 | M | yes |
| 3 | Mission and retention architecture — **design** | `mission-design` | — | S (doc) | no |
| 4 | Overarching objective, progression, onboarding | `mission-core` | 2, 3 | L | yes |
| 5 | Mobile, tablet, PC | `mobile-tablet` | 1, 2 | XL | yes |
| 6 | Station NPC realism | `station-npcs` | 1 | M | yes |
| 7 | Custom servers (premium) | `custom-servers` | 0, 2, P3 | L | yes |
| 8 | Backend map editor | `map-editor` | 7a | M | yes |
| 9 | Art and animation pass | `art-<world>` x9 | 1 | XL | yes, per world |
| 10 | Daily / weekly / seasonal | `retention-loops` | 2, 4 | L | yes |
| 11 | Mini-games, leaderboards and social | `minigames-social` | 2, 4 | L | yes |
| 12 | Final production E2E | `e2e-production` | all | M | verification only |

S is about 1 day, M 2-4 days, L 1-2 weeks, XL 2-4 weeks, at one focused agent per branch.
Phases 7 and 9 parallelise internally; most others do not.

Phase 7 dropped from XL to L once decision D2 ruled out shared live instances.

---

### Phase 0 — Security and production integrity · `prod-integrity`

**Not in the brief. Goes first (decision D1) because production is currently open and later
phases depend on it.**

1. **Close P1** — set the allowlist and make `adminAccess.ts:23` fail closed. A bootstrap
   default that *grants* access is the wrong direction.
2. **Close the `/api/service` bypass** in `admin/proxy.ts` (no route exists behind it).
3. **Make `admin/proxy.ts` throw on a missing `SESSION_SECRET`**, matching `admin/lib/session.ts`
   rather than silently using a public constant.
4. **Stop `/api/health` leaking** env-var presence and the DB hostname to anonymous callers.
5. **Add CI** (P4): run the 190 `node --test` files, the `site/` vitest suite, **and
   `node scripts/contract-check.mjs`, which is not part of `npm test`**, on every push.
   Make `bundle-game.mjs` fail the build rather than ship a stale bundle.
6. **Pooled Postgres connections** — per-query connect will not survive traffic.
7. Retire the stale `an_pass` entitlement cookie in favour of the DB path; plan the
   `site_users` / `players` consolidation (execute in Phase 2's migration window).
8. Refresh or retire `QUEST-AUDIT.md`, `INVENTORY-AUDIT.md`, `MINIGAMES-AUDIT.md`.

**Acceptance:** a non-allowlisted signed-in user cannot mutate the catalogue; CI is red on a
failing test and on a failed game build; `/api/health` says nothing useful to a stranger.

---

### Phase 1 — Production smoothness · `perf-production`

**Brief 4.1.2.**

> **REWRITTEN 2026-08-22 after recon. The original plan here was wrong.** It was
> written from `TODO-V4.md`, which is stale in the same way the three audit
> documents were: **items 2, 4 and 5 have already shipped.** `src/gfx/LightRig.js`
> (642 lines) implements the exact "make the light count constant" design — a
> fixed pool of 19 slots added once at boot, with every other light in the game
> demoted to a `visible = false` *source* copied into a slot per frame. The
> deployed bundle contains it (`rig:point`, `rig:dirShadow`, `RIG_BUDGET` all
> present). Do not rebuild it.
>
> Two corrections to my own earlier text, verified against three 0.185.1 source:
> `visible = false` on a light is **not** a safe toggle — `projectObject` returns
> at `WebGLRenderer.js:1833` before `pushLight`, so the count drops and every
> program recompiles. Nor is `castShadow`, which feeds `numDirLightShadows` into
> the cache key. **Only `intensity` is safe**; it merely multiplies a colour
> uniform (`WebGLLights.js:281,313,362,375,409`) and never gates inclusion.

The real causes are production-only, which is why local was always smoother.

1. **DONE — the per-asset auth gate.** `site/proxy.ts` matched every path under
   `/game`, so a cold first load ran a middleware function per file: a JWT decode
   plus an HMAC verify, 59 times. Vercel runs middleware *before* the cache, so
   the `immutable` headers in `next.config.ts` spared the second visit, never the
   first. Hashed artefacts are now excluded from the matcher. `lib/gatePaths.ts`,
   11 tests.
2. **DONE — 18 MB of sourcemaps.** Shipped in the bundle, publishing the whole
   source tree, against the intent already recorded in `042e753`. Removed;
   `bundle-game.mjs` now writes `build.json` (commit, time, files, bytes) so
   deploy verification has a better marker than grepping maps. Bundle 42 MB → 24 MB.
3. **OPEN — bundle splitting.** `src/worlds` is **49%** of the 3.28 MB index chunk
   and `vite.config.js` has no `manualChunks` at all. Splitting needs
   `worldManager.register` to accept a lazy factory, because all eight world
   classes are statically imported by `main.js`. Architectural, not a config tweak.
   **Re-measured 2026-08-24, after all nine Phase 9 art passes:** the index chunk is
   **3,305 KB** — essentially the 3.28 MB above, unmoved. Nine worlds gained authored
   hero geometry and the JS did not grow, because decision D4 ships every authored asset
   as a separate lazily-fetched `.glb` rather than bundling it. So the art phase did not
   make this item worse, and the 49% figure still stands.
4. **OPEN, latent — 61 world lights created visible.** `Caves.js:859` and
   `MazeChunks.js:393` create theirs `visible = false` with tests enforcing it, and
   say why: the frame between creation and `LightRig`'s next walk is a frame in
   which they count, and one such frame is a full recompile. 61 sites across 12
   world files do not. `claim()` on `world:changed` currently closes the window for
   build-time lights, so this is fragility rather than a live fault.
5. **OPEN — measure production.** The diagnosed cause was already fixed, so the
   remaining gap should be measured before more is spent on it. Production is
   cookie-gated, so this needs either an authenticated session or a local
   production build compared against the deployed one.

**Acceptance:** in **production**, no frame gap over 250 ms on first mount launch,
first weapon change per world, world entry, first keybind use, or repeated
entry/exit. Measured, not felt.

**Trap:** `HARNESS.ready()` must drive the real loop — an automated browser holds no pointer
lock, so NPC and world LOD never run and every figure reads as the LOD-disabled worst case
(`outstanding-work-aug-2026`). And `TODO-V4.md` should be read as history, not as a plan.

---

### Phase 2 — Economy integrity · `economy-authority`

**Closes P2. Scheduled now by decision D3.** Prerequisite for 5, 7f, 10 and 11.

1. Replace client-posted balances with **server-side grant and spend endpoints**. The client
   keeps a display mirror; the server owns the number.
2. **Transactional marketplace purchase** — debit and grant in one statement. There is no
   server purchase endpoint today; buying is client-side arithmetic against a client-held wallet.
3. **Extend the existing quest reward path outward.** It is already idempotent, IDOR-safe and
   atomic — the right shape, worth copying rather than replacing.
4. **Server-authoritative scores, not just credits.** Decision D2 puts leaderboards across
   servers, so every rankable number — race times, trial PBs, survival waves, weekly credits —
   must be server-recorded at the moment it is earned. Today trial PBs are localStorage only.
5. Replay and idempotency guards; extend the HMAC-chained `audit_log`.
6. **Bring remote save to parity with local save** — relics, viewpoints, objectives, trials,
   piloting, mining, character. Required for cross-device play, so Phase 5 depends on it.
7. **Migration for live players.** Balances are real. Additive schema only, following the
   `ADD COLUMN IF NOT EXISTS` discipline already in `admin/lib/db.ts`. Consolidate
   `site_users` / `players` in the same window.
8. Fix the known `Relics.serialize` defect: it persists a **count**, so a reload re-marks the
   first N relics in publication order.

**Acceptance:** a crafted request cannot change a balance or a score except through a
server-priced, server-recorded action; every existing balance survives unchanged; concurrent
requests cannot double-spend; a player's full progress follows them to a second device.

**Risk:** touches real accounts. Wants a staging database and a dry run against a production
snapshot before it ships.

---

### Phase 3 — Mission and retention architecture · `mission-design`

**Brief 4.1.1**, which explicitly requires documenting the architecture *before* implementation.
Document only; no code, no deploy.

Deliverable: `docs/superpowers/specs/<date>-mission-architecture.md` — the overarching
objective; what each of nine worlds and ten planets is *for*; the progression spine (level,
reputation, mount/weapon mastery, collection, season — **none of which exists today**); the
retention loop and where credits are spent; which of the eleven existing verbs each mission
type uses and which **new** verbs are needed; how section 5's mini-games feed the same economy;
and whether `Contracts.js` is revived or deleted.

It must also settle **which activities are rankable** — see the Phase 7 abuse note. That is a
design decision, and it belongs here rather than in the implementation.

Copy the shape of `SpaceObjectives.js` for any ladder: it persists **by identity, not count**,
which is precisely the bug `Relics` has.

**Acceptance (brief's own):** a new player can state unprompted what the game is for, what to do
next, why a world matters, and what they are working toward. That is a playtest question — the
design must name how it will be asked.

---

### Phase 4 — Overarching objective, progression, onboarding · `mission-core`

**Brief 4.1.1 implementation, 5.1 onboarding, 5.5 progression.**

Implement the Phase 3 spine, including the **genuinely new** layered progression (level,
reputation, mastery, faction rank, collection score). Author the opening sequence teaching
movement, interaction, combat, reward, mount, marketplace and the main objective; an early win
inside two minutes; one aspirational locked reward on display. Add any new step verbs, and
extend `quest-vocab.mjs` to cover them so new content keeps its correctness gate.

**Decide the login question.** Quests need auth plus Postgres plus the Next site to appear at
all, so today a signed-out first-run player gets no tutorial. Either onboarding works
signed-out (bundled content), or first-run pushes sign-in earlier. This is a product decision,
not a technical one.

**Acceptance:** a first-run player always has a next action; a visible reward lands before the
opening loop ends; every authored step passes the vocab gate.

---

### Phase 5 — Mobile, tablet, PC · `mobile-tablet`

**Brief 4.1.3. The phase the brief most understates — XL, not a CSS pass.**

Today, on a phone: the boot tap requests pointer lock, which iOS Safari does not implement; the
rejection is swallowed; the PAUSED card goes up and retries four times; and because
`pointerlockchange` never fires, the `standby` block is never added — so **the world simulates
behind a full-screen card that owns pointer events**. There is no touch look, move, fire, jump
or interact anywhere in `src/`.

1. **Break the pointer-lock dependency.** `requestLock`, the `standby` block, the PAUSED retry
   loop, fullscreen and `navigator.keyboard.lock` are one interlocked mechanism across
   `Input.js`, `HUD.js` and `main.js`. Touch must reach a playable state without weakening
   desktop standby behaviour, which exists to stop the game running behind a menu.
2. **A real touch scheme** — look drag (a `look` source that is not `movementX/Y`), virtual
   stick, action buttons, and a touch path for `MountWheel`'s delta-integrated aiming.
3. **A responsive HUD and menu layer.** `hud.css` is 4,721 lines with **875 hardcoded px and
   zero `rem`**, and no breakpoint below 1280 px. The weapon strip is ~731 px wide; the pause hub
   has a 444 px minimum and 30 px rows against a 44 px touch-target minimum; vitals and minimap
   overlap at 390 px. No `env(safe-area-inset-*)`, no `dvh`, no orientation handling, and a
   viewport meta that disables zoom without `viewport-fit=cover`.
4. **A low-end renderer tier.** Today: 4x MSAA, GTAO, bloom, light shafts, SMAA, 2048 shadows,
   2000 m far plane, a resolution scaler bottoming out at 0.8, and `setQuality()` with **no UI**.
   GTAO alone measures 373-828 draw calls, 40-46% of the frame — the obvious first drop. Add a
   Graphics section to the Esc hub.
5. **Cross-device state** — depends on Phase 2 item 6.

**Acceptance (brief's own):** movement, interaction, combat, mount usage, menu navigation,
marketplace, quest interaction and chat all work on phone and tablet layouts with no external
peripheral.

**Sequencing:** conflicts with Phase 4 over HUD files. Serialise, or land Phase 4's HUD surface
first and rebase.

---

### Phase 6 — Station NPC realism · `station-npcs`

**Brief 4.1.5.** References in `demopics/`: **4 files `g1`-`g4`** (attacking), **7 files
`n1`-`n7`** (fixed interactive — lore, quest givers, merchants, seated, standing).

Already built, do not rebuild: procedural `Humanoid` `SkinnedMesh`; analytic IK; `setAiming` /
`_poseAimArms` / bone-parented `weaponMount`; six NPC weapon models with per-model grip and
muzzle offsets; four hostile archetypes (`rifle`, `breaker`, `scout`, `lance`) on a real
PATROL to SUSPICIOUS to COMBAT to REPOSITION machine with LOS sensing and damage-proportional
telegraphs (the 26-point arrow takes nearly a second of visible draw; the 7-point sidearm
barely pauses).

The gap is **identity and fidelity**. The station carries three populations: a roster of
`Humanoid`s, ~180 rigid merged crowd instances in six draw calls, and cut-at-the-joints
instanced zone actors (11 draw calls each, no skinning). Making them read as the references is
authored geometry and materials — and may mean promoting the crowd and actor figures the player
gets close to.

Per decision D4 this is the **first proving ground for the hybrid art direction**: authored
`.glb` hero characters for the eleven referenced roles, procedural everything else.

**Acceptance:** the four attacker types visibly match their references and hold, aim and fire
convincingly; the seven fixed roles read as their roles; frame cost stays inside the Phase 1 budget.

**Method:** *never assess art by reading code — screenshot it.* Use `.probe/art-shots.mjs` with
before/after folders and per-frame luminance.

---

### Phase 7 — Custom servers (premium) · `custom-servers`

**Brief 4.1.4.** Decision D2: **per-owner content variants, with shared leaderboards.** No
shared live world instance, so no new runtime and no state sync — this stays multi-tenancy over
infrastructure that already exists. Still blocked on P3: nothing can be sold while payments are
simulated.

- **7a `custom-servers-schema`** — `custom_servers`, `server_members` (invited / requested /
  approved / removed), a server-scoped credit ledger; `server_id` added additively to `quests`,
  `lore_entries`, `marketplace_items`. Every existing read path scoped so a player with no server
  sees exactly today's global content.
- **7b `custom-servers-purchase`** — **requires P3 fixed first.** A premium SKU on the existing
  checkout, a real webhook that writes entitlement, and the first recurring-billing model in the
  project (today: a one-off $1 / 30-day pass and $0.10 credits, no subscriptions).
- **7c `custom-servers-admin`** — owner CRUD over *their own* lore, quests and marketplace items,
  reusing the existing dashboard; invite / approve / reject / remove; platform-admin visibility
  over all servers and user-created items.
- **7d `custom-servers-ingame`** — start-panel choice of default mode or a server from a
  dropdown; join request when unapproved; entry with that server's items *in addition to* defaults.
- **7e `custom-servers-chat`** — scoped chat: direct messages to selected active players and a
  server-wide shout. **No player-to-player chat exists;** `server/chat-server.js` is dev-only LLM
  NPC dialogue. With no shared instance the delivery can be polled HTTP against Postgres rather
  than sockets, which keeps it on Vercel.
- **7f `custom-servers-credits`** — server-scoped credits that cannot feed the global balance.
  Depends entirely on Phase 2.

#### The abuse vector D2 creates, and the rule that closes it

Owners author their own quests and marketplace items **and** leaderboards are shared. Left
alone, an owner mints rank by authoring a one-step quest that pays 10,000 credits, or listing an
item that sells for more than it costs. This is precisely what brief 4.1.4's "prevent credit
farming or backdoor reward abuse" clause is about.

**Rule: shared leaderboards rank platform-authored activity only.** Anything earned inside a
custom server accrues to that server's own ledger and its own per-server board, and never to a
global one. Enforced at write time by the score endpoint, not at read time by a filter — a
filter is a gate that can be forgotten, whereas a score that was never written globally cannot
leak. Pin it with a test that authors a hostile custom quest and asserts the global board does
not move.

**Acceptance (brief's own):** website purchase, backend setup, server creation, invites,
approval, in-game selection, server-specific content, chat and credits, working locally *and*
in production — plus the abuse test above.

---

### Phase 8 — Backend map editor · `map-editor`

**Brief 4.1.6.** Admin-only: move fixed objects, place new items from marketplace assets, save,
reload, confirm in game.

**Design constraint found in recon:** worlds are procedural code, some very large
(`MedievalWorld.js` 12,945 lines). An editor that rewrote world source would collide head-on
with Phase 9's art passes. It should edit a **placement overlay** — a saved, versioned set of
placed and moved instances applied after the world builds — keeping the editor and the art pass
on separate surfaces and making every change revertible.

**Acceptance:** an admin adjusts a map, places a marketplace item, saves, reloads and sees it in
game; non-admins cannot reach any of it.

---

### Phase 9 — Art and animation pass · `art-<world>` x9

**Brief 4.1.7**, explicitly *"one world at a time to reduce risk and allow focused testing"*.
Branches: `art-station`, `art-medieval`, `art-citadel`, `art-sports`, `art-race`, `art-maze`,
`art-dock`, `art-space`, `art-planets`.

**Decision D4: hybrid.** Authored `.glb` hero assets through the pipeline already proven twice
(the maze stair newel, four ship hulls); procedural systems for bulk content. Every authored
asset follows the established route — a committed generator script, a `manifest.json` entry with
licence and triangle count, a lazy loader, a byte-diff test, materials discarded and remapped to
the world's own cached material so the program key never moves.

The most parallelisable phase, and the one most likely to regress production frame time — hence
Phase 1 first, and a budget each world branch must hold.

Carry these measured findings in; re-deriving them costs days (`outstanding-work-aug-2026`):

- **Many meshes sharing a material is not automatically a batching opportunity.** In these worlds
  it is deliberate spatial partitioning so frustum culling has something to cull. **Do not port
  the maze's `BatchedMesh` machinery into static worlds.**
- Citadel is already merged-by-material (48 renderables, flat 168 draws / 1.25 M tris from every
  camera). Sports does not pay (112 materials for 334 meshes).
- **A downloaded CC0 set can ship a defective channel** — one bad roughness map declaring a
  mirror polish whited out an entire shaft through bloom. A near-constant channel betrays itself
  by file size. Tinting `material.color` cannot fix a specular blow-out, and scaling
  `material.roughness` up is impossible because three multiplies the scalar against the map.
- Don't build organic shapes from stacked boxes. Screenshot, never read, to judge.

**Acceptance, per world:** visibly improved art, smoother animation, consistent style, frame
cost inside the Phase 1 budget — verified in production before the next world starts.

---

### Phase 10 — Daily / weekly / seasonal · `retention-loops`

**Brief 5.2.** Dailies (patrols, bounties, deliveries, scans, hunts, short combats); weeklies
(world boss, faction challenge, leaderboard race, arena run, rare hunt); a seasonal track with
cosmetic and premium rewards.

**Hard prerequisite: Phase 2.** All of these pay out, and 5.5 requires they not be farmable.
None of the calendar machinery exists — the only recurring loop today is `Caches` restocking on
a per-session timer.

---

### Phase 11 — Mini-games, leaderboards and social · `minigames-social`

**Brief 5.3, 5.6.** Hover race circuits, target range, arena survival, drone hacking, treasure
scanner hunt, delivery run, parkour route, boss raid — each playable in 1-5 minutes, feeding the
same economy.

`MinigameManager` already supports six kinds across 12 venues and emits quest-visible events;
this extends a working framework.

**Leaderboards are feasible without a realtime layer** — fastest races, highest survival wave,
weekly credits, rare collections are all periodic reads over Postgres. They need Phase 2 item 4
(server-recorded scores) and the Phase 7 rule that only platform-authored activity ranks
globally. Factions fit the same shape.

**Live events** (hourly rifts, temporary merchants, station invasions, meteor drops) are the one
part of 5.6 that wants shared presence. Not scheduled; revisit if D2 is ever revised toward
shared instances.

**On 5.4 (new worlds):** the brief's own criterion says no new world until an existing one has
a complete onboarding, mission, reward and performance loop. With nine worlds and ten planets
shipped, **no new world is scheduled.** Phases 4 and 9 give the existing ones that loop first.

---

### Phase 12 — Final production E2E · `e2e-production`

**Brief section 3.** One full production pass over every activity, world and required flow:
missions, tasks, mini-games, rewards, custom-server flows, marketplace, movement, mounts,
weapons, NPC interaction, progression.

**Method, learned the hard way:** use a playthrough agent driving **real OS key events**. A
2,500-test suite missed four loop-blockers a real playthrough found in minutes — take-off
killing the player and deleting their hold, a rescue key that moved 3 cm while announcing
"Position reset", a planet that was a hologram, and a taught sprint-jump that cleared two barriers.

---

## 5. What can run in parallel

Safe concurrently (different files, different surfaces):

- **0 + 1** — server/infra versus client renderer.
- **1 + 2** — client renderer versus server/API.
- **2 + 3** — code versus document.
- **6 + 7** — station characters versus backend multi-tenancy.
- **9's world branches** — one per world, provided each holds the perf budget.

Must be serialised:

- **0 to 2 to 7f / 10 / 11** — everything that pays out.
- **P3 fixed to 7b** — nothing can be sold while payments are simulated.
- **2 to 5** — cross-device play needs remote-save parity.
- **2 to 11** — leaderboards need server-recorded scores.
- **3 to 7** — the rankable-activity rule is designed in Phase 3, enforced in Phase 7.
- **4 and 5** — both rewrite HUD surfaces.
- **1 to 9** — the art pass needs a fixed budget to hold.
- **7a to 8** — the editor writes through admin auth and scoping.

---

## 6. Per-phase discipline

1. Branch from current `main`. Consider a worktree — but note `core.autocrlf` has previously
   made a scrape green in a worktree and red in the checkout.
2. Design spec goes to `docs/superpowers/specs/`; implementation plan to
   `docs/superpowers/plans/`. Both before code, per house convention.
3. TDD. `npm test` (2,570 tests) **and `node scripts/contract-check.mjs` (114 files, not part of
   `npm test`)** green before merge. New behaviour gets a test that **fails first**.
4. **Every gate must measure something the game actually does.** This failure shape cost World 06
   nine separate times. A gate that reports confidence about the wrong thing is worse than no gate.
5. Merge to `main` before browser-testing anything dependent (brief section 1).
6. Client changes: rebuild the bundle, commit it to `site/public/game/`, push, and verify **at
   the tree level** — `/game/**` is cookie-gated by `site/proxy.ts`, so anonymous fetch can never
   confirm a deploy. Grep the committed bundle including `*.map` for lazy chunks, and match the
   deployment id.
7. Verify in **production**, not only locally. The brief is explicit that local is already the
   better case and therefore not the test.
8. Update the phase ledger; record dead ends so they are not retried.

---

## 7. Risks

| Risk | Phase | Mitigation |
|---|---|---|
| Economy migration corrupts live balances | 2 | Staging DB, dry run on a production snapshot, additive schema, reversible |
| **Custom-server owners farm the shared leaderboard** by authoring cheap high-paying quests or profitable items | 7 | Only platform-authored activity ranks globally, enforced at score-write time, not by a read filter. Pinned by a hostile-quest test |
| Premium cannot be sold | 7b | P3 first: real Stripe keys, a webhook that writes, and a subscription model that does not exist yet |
| Art pass regresses production frame time | 9 | Phase 1 fixes the budget; each world verified in production before the next starts |
| Authored assets bloat the bundle | 6, 9 | Hybrid means hero assets only; manifest records bytes and triangles per asset; lazy-loaded chunks; a missing file degrades to the procedural prefab |
| Mobile rewrite destabilises desktop | 5 | Touch is additive; desktop standby gating keeps its existing tests |
| Map editor collides with art passes | 8 | Editor writes a placement overlay, never world source |
| Parallel agents clobber each other | all | One branch per phase; never a broad kill filter; never `git checkout --` in a shared tree — both have destroyed sibling work here before |

---

## 8. Decisions taken (2026-08-22)

**D1 — Order: Phase 0 first, as proposed.** Full sequence 0, 1, 2, 3, then 4 / 6 / 7 in
parallel, then 5, 8, 9, 10, 11, 12. Security first because production is currently open; perf
second because it is diagnosed and cheap; economy third because five later phases depend on it.

**D2 — Custom servers: per-owner content variants, with shared leaderboards.** Owners get their
own lore, quests, marketplace items, scoped chat and separate credits; players enter
individually and do not share a world instance. No new runtime is required — leaderboards and
scoped chat are both HTTP against Postgres. **Consequence:** the rankable-activity rule in
Phase 7 is now load-bearing, and is designed in Phase 3.

**D3 — Economy authority: now, as Phase 2.** Closes P2 before more content is authored against
a client-authoritative wallet, and unblocks anti-farming, leaderboards, cross-device save and
server credits. Executed with a staging database and a dry run against a production snapshot.

**D4 — Art: hybrid.** Authored `.glb` hero assets through the pipeline already proven twice,
procedural systems for bulk content. Phase 6's station characters are the first proving ground;
Phase 9 applies it world by world.
