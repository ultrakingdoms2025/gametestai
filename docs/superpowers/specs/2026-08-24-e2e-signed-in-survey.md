# Signed-in end-to-end survey — quests, credits, servers, marketplace, progress

**Date:** 2026-08-24
**Branch:** `worktree-agent-a7ba31b555dd6c8e8` (off `economy-authority`)
**Scope:** the surface Phase 12's production playthrough could not reach, because it had no credentials.

---

## 0. What this run does and does not prove

**Where it ran.** Locally. `site` served by `next dev` on `localhost:3100`, pointed at the
`aether_test` Postgres database via a generated, gitignored `site/.env.local`. Nothing in this
survey touched production, and no account was created on the production site.

**How the database was prepared.** `aether_test` had accumulated a patchwork of test stand-ins —
a `players` table with 10 of its 20 production columns, a `player_quest_engagements` with 10 of
17, no `step_states`, no `access_granted_at`. A survey run against that would have measured the
stand-ins, not the product. So the schema was dropped and rebuilt the way production was
bootstrapped: `admin/lib/db.ts` `initSchema()` first (the admin app owns the schema), then the
site's own `ensure*` functions as its own request paths call them. Quests were seeded with the
admin app's own `seedQuests()` — **78 quests / 398 steps**, the same numbers production reports.

**How each flow was driven.** The real UI, with real input, wherever a UI exists: register,
sign in, buy credits, `/play`, `/admin/servers` (create, invite, author quests / lore / items).
The HTTP API directly where there is no UI — which is most of it. Every result below says which.

**What a green result here means.** It means the **logic** works. It does **not** mean production
works. A local run against a rebuilt test database cannot catch a production-only schema or
configuration fault. That is exactly how `/api/game/quests` and `/api/marketplace/items` shipped
returning HTTP 500 to every caller: the `ALTER TABLE … ADD COLUMN IF NOT EXISTS server_id` lived
in a module the read path never called, and every local and CI run was green because something
else had happened to ensure the column first. §7 attacks that bug class head-on, because it is
the one thing this method structurally cannot observe by accident.

**What could not be tested at all.** §8.

---

## 1. Loop-blockers

Three, in the order they would stop a player.

| # | What stops | Where | Evidence |
|---|---|---|---|
| **L1** | A paid-up signed-in player cannot enter the game with a mouse. The `/play` mode-select panel renders entirely underneath the site header. | `site/app/globals.css:940` + `1806` | §2 |
| **L2** | A custom-server owner mints unlimited **platform** credits. Phase 7's "server credits cannot reach the platform economy" is breached — not through `serverCredits.ts`, which holds, but through the quest payout, which never reads `server_id`. | `site/lib/playerDb.ts:939-1011` | §3 |
| **L3** | A platform admin cannot durably suspend a server. Any owner PATCH that omits `status` reinstates it. Which means L2 cannot be contained by suspending the offending server. | `site/lib/customServers.ts:562-573` | §4 |
| **L4** | One owner-authored marketplace item with an unvalidated `game_action` takes `/api/marketplace/items` to a bodiless 500 for every member of that server — the 612 platform items included. Server-scoped and owner-recoverable, so a rung below the others. | `site/lib/serverContent.ts:490` vs `site/lib/marketplaceDb.ts:210-215` | §6 F8 |

L2 and L3 compose: the abuse is unlimited, and the tool built to stop it does not hold.

---

## 2. L1 — `/play` cannot be clicked

**Driven through the real UI.** Registered `survey-alpha` at `/register`, bought the $11.64
entry+100-credit bundle at `/store` (simulated mode), landed on `/play?welcome=1`, and tried to
click **Enter default mode**.

```
TimeoutError: ... attempting click action
  <div class="site-header">…</div> intercepts pointer events   (x14 retries)
```

Measured geometry, at an ordinary desktop viewport:

```
viewport      1316 x 933
button        x=291  y=19   w=147  h=33      ("Enter default mode")
site-header   x=0    y=0    w=1316 h=54      position: sticky, z-index: 200
document.elementFromPoint(button centre) -> DIV.site-header
document.documentElement.scrollHeight = 933   (nothing to scroll to)
```

**Root cause, exactly.** `PlayShell` reuses one class for two different jobs
(`site/components/PlayShell.tsx:28` and `:35`):

```css
/* site/app/globals.css:940 */
.play-shell { position: fixed; inset: 0; background: #000; }
/* site/app/globals.css:1806 */
.site-header { position: sticky; top: 0; z-index: 200; height: 54px; … }
```

`inset: 0` is right for the post-entry state, where the iframe fills the screen and the header
floating over it is intentional. In the *pre*-entry state the same rule pins the mode panel to
`y = 0`, under a 54px header with `z-index: 200`. The panel has `position: static` and no
`z-index`, so it loses. A player sees a black page.

**Not a dev-mode artifact.** `npm run build:site-only` succeeded and the emitted stylesheet
carries the identical rules, with no `/play` override:

```css
.play-shell{background:#000;position:fixed;inset:0}
.site-header{z-index:200;…;height:54px;…;position:sticky;top:0}
```

**Not absolute.** The button is still focusable, and `focus()` + <kbd>Enter</kbd> enters the game
normally — pointer-events do not block the keyboard. So a determined keyboard user gets in. Nothing
on the page tells them the button is there.

Screenshot: `img/2026-08-24-e2e-signed-in/play-entry-blocked.png` — a black page with the panel a
faint ghost behind the logo.

![/play, signed in and paid up: the mode panel is invisible under the header](img/2026-08-24-e2e-signed-in/play-entry-blocked.png)

**Limit of this evidence.** This reproduces against a local production build of *this tree*. I did
not check the deployed site, because the brief said not to point anything at production. An
anonymous GET of the live stylesheet would settle in seconds whether it is live right now; that is
worth doing and I deliberately did not do it.

---

## 3. L2 — an owner-authored quest pays platform credits

**This is the most important finding in the survey.**

Phase 7's separation is real where it was built. `serverCredits.ts` never names `players`,
`credit_balance`, `credit_events`, or imports `creditLedger` — and `serverCredits.test.ts:70-74`
asserts that as source text. Driven live, it holds (§5.4).

But quest rewards do not go through `serverCredits.ts`. They go through
`completeQuestEngagement` (`site/lib/playerDb.ts:939-1011`), which takes `(engagementId, playerId)`
and **never reads `server_id` at all** — not from the engagement row it selects, not from the
quest. It always credits `players.credit_balance`.

**Driven through the real UI and then the real API.**

1. `/admin/servers`, real form input: created **Survey Outpost**. (An entitlement stand-in was
   required first — see §8.)
2. `/admin/servers`, real form input: authored a quest **"Owner-minted jackpot"**, world `station`,
   reward `9999`. It is stamped correctly: `quest_number 1000001`, `server_id 0a1cdd58-…`.
3. `POST /api/game/server {"action":"select","serverId":"0a1cdd58-…"}` → 200.
4. `POST /api/game/quests {"action":"accept","questId":"da370e83-…"}` → 200.
5. `POST /api/game/quests {"action":"complete","engagementId":"587b601e-…"}`:

```json
{"ok":true,"creditsRewarded":9999,"creditsAwarded":9999,"creditBalance":510348,"alreadyCompleted":false}
```

Platform balance moved **+9,999**. `server_credit_balances` stayed empty.

**There is no ceiling and it is farmable.** `POST /api/servers/<id>/content` with
`{"kind":"quest","rewardCredits":1000000000,"repeatable":true}` returned **201** and stored it
verbatim. Two accept/complete pairs later:

```
players.credit_balance          2,000,510,348
credit_events   rows: 6   SUM(delta): 500,199
server_credit_balances          (no rows)
```

At the store's own price of $0.10 a credit that is nine figures of nominal value, from a
$5.46/month subscription and four HTTP requests. It stops only when `credit_balance` (INTEGER)
overflows.

**The engagement row knows.** It is stamped:

```
id 19c8f74c…  quest_id aedc7271…  status completed  credits_rewarded 1000000000  server_id 0a1cdd58…
```

So the scope is present in the very row the payout updates. The payout does not look at it.

**Which layers DO hold** — worth stating, because most of Phase 7 works:

- A **non-member** cannot touch it. Signed in as `survey-bravo` (no subscription, no membership),
  `POST accept` on the owner quest id → `404 {"ok":false,"reason":"quest_not_found"}`, and the
  quest is not in their catalogue. `acceptQuestEngagement` scopes correctly.
- A **non-owner** gets `404 Not found.` from `GET /api/servers/<id>`, `POST …/content`, and
  `POST …/members` for `invite` and `approve` alike. 404 rather than 403, so ids cannot be probed.
- The **paywall** holds: `POST /api/servers` with no entitlement →
  `402 {"reason":"no_entitlement"}`.

**But an invited member is enough.** `survey-bravo`, invited by the owner and approved, with a
platform balance of 0 and no subscription of their own:

```
member accepts    200 {"ok":true,"engagementId":"0a4bab85-…"}
member completes  200 {"ok":true,"creditsRewarded":1000000000,"creditBalance":1000000000}
bravo platform balance at end   1,000,000,000
```

So one $5.46 subscription mints unlimited platform credits for **everybody the owner invites**.

**Why the existing guard did not catch it.** The structural rule — `server_id` as the second
positional argument of every exported function in `serverContent.ts`, validated by
`requireServerId()` before any statement — is real and complete for that module. It governs
*authoring*. Nothing governs *payout*, because the payout lives in `playerDb.ts`, which predates
Phase 7 and takes no `serverId` argument at all.

**The destination the reward was meant to reach already exists, bounded, and has no caller.**
`SERVER_CREDIT_KINDS` (`serverCredits.ts:69`) has a `quest` kind with `perEventMax: 5_000` and this
rationale attached to it, which the API returns verbatim:

> "Quest reward — The owner sets reward_credits; this bounds one payout, not the owner's economy."

That is exactly this payout, priced and capped for exactly this reason. But `earnServerCredits` has
one caller in the whole repo — `app/api/game/server-credits/route.ts:90`, which the game client
never calls — and `spendServerCredits` has none at all. **The bounded destination was built and the
quest route was never pointed at it.** The fix direction is therefore already designed: when
`player_quest_engagements.server_id` is non-NULL, the completion belongs in
`earnServerCredits(db, serverId, playerId, {kind:'quest', …})`, where the 5,000 ceiling is waiting
for it, and never in `players.credit_balance`.

---

## 4. L3 — suspension is undone by a rename

`PATCH /api/servers/[id]` guards `status` properly (`route.ts:64-70`), and the comment states the
threat model precisely:

> "An owner suspending their own server is harmless, but an owner UN-suspending one a platform
> admin suspended is not, and the two are the same verb — so the verb belongs to the platform."

But `updateServer` writes `status` unconditionally (`site/lib/customServers.ts:562-573`):

```sql
UPDATE custom_servers
   SET name = $1, description = $2, status = $3, updated_at = NOW()
```
```ts
patch.status === 'suspended' ? 'suspended' : 'active',   // undefined -> 'active'
```

The route strips `status` from the patch when the actor is not a platform admin — so `patch.status`
arrives `undefined`, and the ternary resolves it to `'active'`.

**Driven live, as the owner (not a platform admin):**

```
start:                                {"status":"active"}
PATCH {status:"suspended"}       403  Only a platform administrator can change a server's status.
  db:                                 {"status":"active"}          <- guard works
(suspended out of band, as an admin)  {"status":"suspended"}
POST select                      403  {"reason":"not_a_member"}    <- suspension bites
PATCH {name:"Survey Outpost Renamed"}
                                 200
  db AFTER the rename:                {"status":"active"}          <- reinstated
```

One-line fix, and the shape is obvious:
`patch.status === undefined ? current.status : (patch.status === 'suspended' ? 'suspended' : 'active')`.
Not applied here — see §9.

---

## 5. Flow by flow

### 5.1 Register / sign in / account — **pass** (real UI)

`/register` form → account created, session established, header shows the handle. One
`site_users` row, one `players` row (`auth_provider site_oauth`, `status active`,
`handle survey-alpha`). Sign-out clears `authjs.session-token`; a signed-out
`GET /api/game/progress` answers `401 {"error":"Not authenticated."}`. Sign-in via
`/api/auth/csrf` + `/api/auth/callback/credentials` issues a working session.

### 5.2 Purchase → credits → ledger → access — **pass** (real UI)

`/store`, real click on **Pay $11.64** (simulated mode; no Stripe keys). Every downstream
artefact was written, and the ledger row is correct:

```
credit_events   stripe:sim_9060e2b3-…  kind purchase  delta +100  balance_after 350
players         credit_balance 350     access_granted_at set
purchases       type access  credits_amount 100  status completed
audit_log       survey-alpha@aether.test  purchase.access  player:d58bae0d-…
```

`balance_after` 350 = prior 250 + 100. **This is the Phase 2 fix working.** It is the contrast
that makes §6 a defect rather than a design.

### 5.3 Custom servers — **mixed**

Create / invite / approve / author all work through the real UI or the real routes; the ownership
and membership guards hold (§3). Two defects (§3, §4). Two gaps:

- **An invited player has no way to accept.** `ServerStartPanel` renders invited servers as
  "Waiting on: X (invited)" and `listJoinableServers` excludes them, so no button is drawn. The
  transition exists and works — `POST /api/game/server {"action":"request"}` on an `invited`
  membership returns `{"state":"approved"}` — but only from a hand-made request. **An invite
  cannot be accepted from the UI.**
- **`/admin/servers` has no navigation link.** Not in `SiteHeader`, not on `/account`. It is
  reachable only by typing the URL or by a Stripe `success_url`. A subscriber who closes that tab
  has no route back.

### 5.4 Server credits — **pass**, and the isolation is real

Driven as `survey-bravo`, an approved member, over the real route:

```
POST /api/game/server-credits {kind:'quest',amount:5000,eventKey:'survey-sc-1'}
  200 {"applied":true,"reason":"ok","delta":5000,"balance":5000,"serverId":"0a1cdd58-…"}
same key again
  200 {"applied":false,"reason":"duplicate","delta":0,"balance":5000}
amount 5001 (ceiling is 5000)
  200 {"applied":false,"reason":"too_large","delta":0,"balance":5000}

bravo platform balance before 0 -> after 0   (moved 0)
```

Idempotency by `event_key`, the per-event ceiling, and the ledger are all as designed, and not one
platform credit moved. The route accepts no `serverId` and no `playerId` from the body. **This
module is not where the leak is** — §3 is.

### 5.5 Progress sync — **pass**, one missing floor

Two independent cookie jars as two devices, real routes.

| Property | Result |
|---|---|
| Union for sets | device 2 adds `m4`; `m1,m2,m3` survive; `changed: 1` |
| GREATEST for `max` kinds | `kills` stays 1200 against a pushed 3; `tier` stays 4 against 1 |
| LEAST for `min` kinds | `trial` stays 45000 against a pushed 99000 |
| Survives sign-out → sign-in | yes, same device and a fresh one |
| Signed out | `401`, no read |
| Unknown kinds | `{"changed":0,"rejected":["also_fake","not_a_real_kind"]}` — nothing written |
| Opaque `game_state` | round-trips across sign-out/sign-in and across devices |

No device clock is consulted anywhere; nothing subtracts. **The merge rules are sound.**

The one gap — `min`-mode kinds have no lower bound (§6, F7).

### 5.6 Marketplace — **there is no purchase to test**, and the catalogue is brittle

`GET /api/marketplace/items` works and returns 612 items. That is the entire marketplace HTTP
surface for a player — there is no purchase route and no purchase UI (§6 F5).

The read is also brittle in a way the write side does not know about: one row with an
unrecognised `game_action` kills the whole list. An owner can plant one through the real content
route (F8), and the site's own test suite already plants six (F9).

### 5.7 Quests — **two defects**, §6 F1 and F2

There is no quest UI on the site at all; quests are game-client-only, so this flow was driven
through the HTTP API from the signed-in browser session.

### 5.8 The gated API surface, both ways

The brief's point exactly: a 401 for an anonymous caller is a **gate pass**, not an end-to-end
pass. Every gated route was exercised twice — once with no cookie, once as a real signed-in player
with a real body. Only the right-hand column is evidence the route works.

| Route | anonymous | signed in |
|---|---|---|
| `GET  /api/user/me` | 401 | 200 profile |
| `GET  /api/game/session` | 401 | 200 player_id, handle, credits, server_credits |
| `GET  /api/game/progress` | 401 | 200 merged state |
| `POST /api/game/progress` | 401 | 200 `{state, changed, rejected}` |
| `GET  /api/game/state` | 401 | 200 opaque blob |
| `POST /api/game/state` | 401 | 200 `{ok:true}` |
| `POST /api/game/credits` | 401 | 200 `{balance, results:[{applied:true,…}]}` |
| `GET  /api/game/quests` | **200** (open by design — platform catalogue, no engagements) | 200 + engagements + server_id |
| `POST /api/game/quests` | 401 | 404 `quest_not_found` for a bogus id (correct) |
| `GET  /api/game/server` | 401 | 200 current, memberships, joinable |
| `POST /api/game/server` | 401 | 200 heartbeat |
| `GET  /api/game/server-credits` | 401 | 200 balances, history, kinds |
| `POST /api/game/server-credits` | 401 | 200 `{applied:true, delta:10, balance:5010}` |
| `GET  /api/game/chat` | 401 | 200 messages, cursor, active players |
| `POST /api/game/chat` | 401 | 200 `{id:8}` — message stored and readable |
| `GET  /api/game/leaderboard` | 401 | 200 boards |
| `GET  /api/servers` | 401 | 200 owned, memberships, entitlement, sku |
| `POST /api/servers` | 401 | 402 `no_entitlement` (correct — paywall) |
| `GET  /api/marketplace/items` | 200 | 200, 612 items (open by design) |
| `GET  /api/lore` | 503 | 503 — F10 |

Server chat is included and works end to end: `POST` stored message id 8, and `GET` returns it with
the active-player list, scoped to the caller's current server with no `serverId` accepted from the
body.

---

## 6. Findings

### F1 — Quest completion is forgeable. Still true. (high)

`completeQuestEngagement` never reads `step_states`; the only gate is `status = 'in_progress'`.
Quest 1 has **two** steps. Neither was attempted and no `progress` action was ever sent:

```
balance_before: 0
POST /api/game/quests {"action":"accept","questId":"3dd90c05-…"}     200 engagementId 6a35b5f4-…
POST /api/game/quests {"action":"complete","engagementId":"6a35b5f4-…"}
  200 {"ok":true,"creditsRewarded":90,"creditBalance":90,"alreadyCompleted":false}
balance_after: 90
```

The row the server wrote:

```
status completed   percent_complete 100   credits_rewarded 90   step_states NULL   completed_at set
```

`percent_complete = 100` is written by the completion statement itself (`playerDb.ts:987`), so the
row does not even record that the quest was skipped. Known
(`src/systems/QuestSystem.js:342-344`, mission architecture §11) and **not fixed**. Not fixed here
either, per the brief.

### F2 — Quest rewards move `credit_balance` with no ledger row. (high, new)

The Phase 2 defect, still live on the one payout path Phase 2 did not touch. Stripe purchases
(`playerDb.ts:518-534`) and admin grants (`admin/lib/db.ts:862-876`) now pair the balance move with
a `credit_events` insert in one statement. `completeQuestEngagement` does not — there is no
`INSERT INTO credit_events` in that function or in its only caller.

```sql
-- site/lib/playerDb.ts:985-999 — the entire payout
WITH finished AS (
  UPDATE player_quest_engagements SET status='completed', credits_rewarded=$1::int, … )
UPDATE players p SET credit_balance = credit_balance + $1::int, updated_at = NOW()
  FROM finished f WHERE p.id = f.player_id RETURNING f.id, p.credit_balance
```

**Proved live.** One ledger event (which triggers `ensureOpeningBalance`), then a forged quest
completion, then another ledger event:

```
event_key                kind       delta  balance_after
migration:d58bae0d-…     migration    +90             90
survey-kill-1            kill          +5             95
survey-kill-2            kill          +5            250     <-- +155 on a +5 event

SELECT SUM(delta) FROM credit_events -> 100
SELECT credit_balance FROM players   -> 250
```

Row 3's `balance_after` cannot be derived from row 2's plus row 3's `delta` (95 + 5 = 100, not
250). The 150-credit quest reward is invisible to the chain, and every `balance_after` after a
player's first quest completion is underivable — which is every player.

**Note the masking.** `ensureOpeningBalance` fires on a player's *first* `/api/game/credits` call
and writes a `migration` row for whatever the balance happens to be then. That absorbed the first
forged 90 silently. Only rewards earned *after* the first ledger event leave a visible hole — so
the corruption is invisible in exactly the case a smoke test checks: a brand-new account.

`creditPricing.ts:305` maps the client-reported reason `quest` to `'refused'` *because*
`completeQuestEngagement` already paid it. Not paying twice is deliberate; not recording it at all
is not.

### F3 — Owner-authored quests pay platform credits. (critical, new) — §3

### F4 — A suspended server is reinstated by any owner PATCH. (high, new) — §4

### F5 — There is no marketplace purchase, server-side. (high)

**The correct implementation exists and has no caller.** `purchaseMarketplaceItem`
(`site/lib/marketplaceDb.ts:565`) prices from `cost_buy`, locks the item row `FOR UPDATE`, debits
through `debitInTransaction` (so a `credit_events` row is written), decrements stock, writes a
`purchases` row, and does it all in one `BEGIN`/`COMMIT` with `ROLLBACK` on every refusal. It has
a full integration suite against a real Postgres. A repo-wide grep finds **zero** callers outside
that test:

```
lib/marketplaceDb.ts:565  export async function purchaseMarketplaceItem(
lib/marketplaceDb.ts:732  export async function purchaseMarketplaceItemForPlayer(
lib/marketplaceDb.ts:741      return await purchaseMarketplaceItem(client, playerId, request);
```

There is no `POST` route under `app/api/marketplace/**` — only `items/route.ts`, `GET` only. There
is no purchase UI. **The safe path was built, tested, and never wired up.**

What happens instead: the client does the arithmetic (`src/systems/Marketplace.js:527`
`this.economy.spend(cost, 'market')`, and `item.quantity = Math.max(0, item.quantity - 1)` on a
local array), and the only thing that reaches the server is an untyped spend on
`/api/game/credits`. The server never learns which item, never checks `cost_buy`, and never
decrements stock.

Driven live, signed in:

```
POST /api/game/credits {"events":[{"key":"survey-buy-dragonfire","reason":"market","delta":-1}]}
  200 applied:true delta:-1        <- "bought" a 1,071-credit item for 1 credit
POST /api/game/credits {"events":[{"key":"survey-sell-nothing","reason":"market","delta":500000}]}
  200 applied:true delta:500000    <- sold nothing, for 500,000
POST … delta 500001
  200 applied:false reason:"too_large"
```

**Be fair about the second one.** `PER_EVENT_MAX.sell = 500_000` is a documented, reasoned bound
(`creditPricing.ts:344-367`) — the design says plainly that for declared kinds "the server is not
pricing the claim, it is BOUNDING it". So the 500,000 mint is *within* the design, not a
contradiction of it. What is worth stating is the number the design comment does not: the ceiling
is ~288x the largest legitimate stack (~1,736), the `sell` rate cap is 400/hour, and at $0.10 a
credit one request is worth $50,000. The catalogue currently has **0 of 612 items with limited
stock**, so the stock argument for a server-side purchase is theoretical today; the pricing one is
not.

### F6 — The ensure-order bug class, on the table its own regression test does not guard. (high)

`serverIdMigrations.test.ts` exists precisely for this shape, and its comment is one of the best
things in the repo. Its list is (`:56`):

```ts
const GUARDED = ['quests', 'marketplace_items', 'lore_entries'] as const;
```

Three tables gained `server_id` in Phase 7 and are **not** on it:
`player_quest_engagements`, `player_progress_items`, `player_progress_values`
(all ALTERed only in `site/lib/leaderboard.ts:270,271,286`).

`acceptQuestEngagement` INSERTs `server_id` into `player_quest_engagements`
(`playerDb.ts:878-887`), but `runQuestSchema()` — the function that exists to put the ensure with
the read, and whose comment narrates the original production 500 — does not ensure that column.
It survives only via an implicit four-hop chain: `route.ts:82` calls `currentServer()` →
`openServerDb()` → `ensureCustomServerSchema` → `ensureLeaderboardSchema` → the ALTER. And
`currentServer` swallows every error and returns `null` (`serverRoutes.ts:121-123`), so if that
chain ever fails, accept proceeds to the INSERT anyway.

**Reproduced.** Column dropped, then one accept of a quest the player had not taken:

```
server_id present: 0 (dropped before any request)
POST /api/game/quests {"action":"accept",…}   ->  500
body:                                             (empty)
```

Server log:

```
⨯ error: column "server_id" of relation "player_quest_engagements" does not exist
    at async pgQuery (lib\playerDb.ts:23:20)
    at async acceptQuestEngagement (lib\playerDb.ts:865:3)
    at async POST (app\api\game\quests\route.ts:83:20)
```

Note the **empty body**: `POST /api/game/quests` has no try/catch, so a Postgres fault is a bare
500 with nothing in it — the same silence that made the original incident hard to read.

I am not claiming production is missing this column today. I am claiming the property the
regression test was written to enforce is not enforced on this table, and that the failure is
still a bare 500.

### F7 — `min`-mode progress values have no floor. (low)

`trial` and `race` merge with `LEAST` and the only validation is `Number.isFinite` +
`Math.trunc` (`progressLedger.ts:358-368`). Driven live:

```
trial/station/venue-1 = 45000            (honest)
POST value -999999      ->  changed: 1,  state now -999999
POST value 45000        ->  changed: 0,  state still -999999
GET                     ->  trial.station["venue-1"] = -999999
```

Permanent and irrecoverable through any API, and served to every device on the next merge.

**Severity is low, deliberately.** Times never reach a leaderboard — `leaderboard.ts:4-25` rules
out ranking on totals or times outright, and names quest forgery as one of its reasons. So this
corrupts a player's own personal-best display and nothing else. A `value > 0` check on `min`-mode
kinds is the missing guard.

### F8 — One owner-authored item 500s the whole catalogue for that server. (high, new)

`createServerMarketplaceItem` stores `game_action` as free text —
`text(input.gameAction, 60)` (`serverContent.ts:490`) — with no check against the action table.
`rowToItem` **throws** on an unrecognised one (`marketplaceDb.ts:210-215`), and
`listMarketplaceItems` maps *every* row through it (`marketplaceDb.ts:328`). One bad row and the
whole list dies.

**Driven live through the real routes.** Owner authors one item; a second signed-in member of the
same server reads the catalogue:

```
--- baseline: GET /api/marketplace/items ---
  owner   -> 200 (612 items)
  member  -> 200 (612 items)
  anon    -> 200 (612 items)

--- owner authors ONE item with gameAction "totally_bogus" ---
  POST /api/servers/<id>/content -> 201  {"item":{"id":"84650a71-…","name":"Catalogue Bomb",…}}

--- after ---
  owner   -> 500  body: ""
  member  -> 500  body: ""
  anon    -> 200 (612 items)
```

Server log: `Error: Invalid game action: totally_bogus at normalizeAction (lib\marketplaceDb.ts:214:9)
→ rowToItem → listMarketplaceItems → GET (app\api\marketplace\items\route.ts:43:17)`.

**Blast radius.** Every member of that server loses the entire marketplace — the 612 platform items
included, not just the server's own. Anonymous and non-member callers are unaffected, because the
scope clause `server_id IS NULL OR server_id = $2` excludes the row from their query. So it is a
denial of service **inside one server**, not platform-wide.

**Recoverable.** `DELETE /api/servers/<id>/content?kind=item&id=<id>` → `{"removed":true}`, and both
callers went back to 200 (612 items). The owner can undo it — but only the owner, and only if they
work out what happened from an empty 500.

`category` and `world_name` have the same shape: written with `text(...).toLowerCase()`
(`serverContent.ts:488, 496`), read with `normalizeCategory` / `normalizeWorld`, which also throw.
The write path and the read path disagree about what the column may contain, and the read path is
the strict one.

### F9 — The site's own test suite leaves the marketplace 500ing. (medium, new)

`marketplacePurchase.test.ts:147` seeds six fixture rows with
`game_action = 'grant_item'` — which is an `action_config.effect` in the catalogue, never an action
`id` — and never removes them. They are `server_id IS NULL`, so they are platform rows.

Consequence, observed by accident during the closing sweep and then confirmed:

```
GET /api/marketplace/items    anonymous 500     signed in 500     (both with an empty body)
```

After deleting exactly those six rows, both went back to `200 (612 items)`. **Any database the
site suite has been run against serves a dead marketplace to every caller until someone removes
them.** The suite is green while the route it shares a table with is not.

This is the same family as F8 — the fixture is only able to do this because nothing validates
`game_action` on write — and it is a good argument for fixing F8 at the write side rather than
making the reader lenient.

### F10 — `/api/lore` is the one route that cannot take a direct connection string. (medium, new)

`site/lib/lore.ts:1` is the only module in `site/lib` that uses `@vercel/postgres`. Every other one
uses raw `pg`, and `playerDb.ts:4` says why in as many words:

> "Uses raw pg (not @vercel/postgres) to support direct Neon connection strings."

`@vercel/postgres` refuses a non-pooled string outright. With `POSTGRES_URL` set to a direct
connection string, `/api/lore` answers `503 {"error":"Lore data unavailable."}` to every caller
while every other Postgres-backed route is fine.

Isolated to the client, not the data or the schema — same URL, same table, two clients:

```
connection string is pooled (contains "-pooler"): false
raw pg              -> OK, 9 lore_entries rows readable
@vercel/postgres    -> FAILS: invalid_connection_string
```

`getLore` catches this and falls back to placeholder prose, which its own comment
(`lore.ts:17-23`) calls *"a silent, total content outage"* — every world showing fallback signage
with nothing in the response to say so.

**Caveat.** Production presumably uses a pooled Neon string, in which case this is dormant there,
and I could not check. It is a configuration fragility with one module out of step with a rule the
repo has already written down — and worth noting that `lore.ts` was the *one* route that survived
the Phase 7 incident, and is the *one* route that fails this.

### F11 — `POST /api/game/quests` has no error boundary. (low)

Every branch of the POST handler runs outside a try/catch (`route.ts:49-160`). Any database fault
becomes an uncaught 500 with an empty body. Demonstrated in F6. `GET /api/marketplace/items` has
the same shape — F8 and F9 both produced 500s with nothing in them.

---

## 7. The bug class this method cannot see by accident

Everything above is logic, verified against a database I rebuilt. The one failure mode a local run
structurally cannot catch is a production-only schema state. So it was audited directly rather
than hoped for:

- Every `ALTER TABLE … ADD COLUMN IF NOT EXISTS server_id` in `site/lib/**` was located, and
  matched against the module that reads the column. The three tables on the regression test's
  `GUARDED` list are correctly self-ensuring — `playerDb.ts:621`, `marketplaceDb.ts:73`,
  `lore.ts:23`. The three that are not on the list are not (F6).
- The reproduction in F6 is the same class, on a real HTTP route, with the real error.

That is the honest boundary of this run: **green here means the logic works; it does not mean
production works.**

---

## 8. What could not be tested, and why

| Untested | Why |
|---|---|
| **The Stripe subscription leg for custom servers** | No Stripe keys are available locally. Both refusals were verified through the real routes: `POST /api/checkout {"intent":"server_hosting_monthly"}` → `503 "Server hosting needs Stripe configured"`, and `POST /api/webhook` with a bogus signature → `503 "Webhooks are not configured."`. To reach the rest of the flow I wrote the exact row `writeEntitlement` (`premium.ts:248-272`) writes for an `active` subscription with `SERVERS_PER_SUBSCRIPTION = 1`. **Everything downstream of that row is the product's own code; the signature verification, `claimStripeEvent` idempotency, and `subscriptionFactFor` are untested here.** |
| **A live Stripe card charge** | Out of scope by instruction, and no test keys present. The simulated path was exercised instead and is reported as simulated. |
| **Google OAuth sign-in** | No credentials configured. Email/password was used. |
| **2FA / TOTP, password reset e-mail** | Not in the brief's scope; no e-mail provider configured. |
| **In-game marketplace, quest board and step progression as a player** | The game is an iframe bundle; Phase 12 covered the client with real OS key events. This survey covered the server contract those UIs call. Note that F5 means the in-game marketplace has no server contract to cover. |
| **Whether the deployed production site has L1** | Deliberately not checked — the brief said not to point anything at production. It is a single anonymous stylesheet fetch and it should be done. |
| **Production schema drift** | Structurally impossible from here. §7. |

---

## 9. Nothing was fixed

Per the brief: reported, not patched. F4 is a genuine one-liner and F7 is close to one, but the
headline defect (F3) is not, and fixing two of eleven would have made the survey harder to read
rather than easier to act on. **No source file was modified** — the only two files this branch
changes are this document and one screenshot. Probe scripts live under gitignored `.probe/`
directories and are not committed.

### State the `aether_test` database was left in

It is a survey artefact, not a fixture, and it should be rebuilt before it is trusted:

- Schema rebuilt from `admin` `initSchema()` + the site's own ensures; **78 quests / 398 steps**
  seeded by the admin app's `seedQuests()`.
- Two synthetic accounts, `survey-alpha@aether.test` and `survey-bravo@aether.test`, with
  balances of 2,000,510,348 and 1,000,000,005 platform credits — the evidence for F3.
- One custom server, `Survey Outpost`, holding two owner quests including a repeatable
  1,000,000,000-credit one.
- One `server_entitlements` row written by hand as the Stripe stand-in (§8).
- The six `game_action='grant_item'` fixture rows from `marketplacePurchase.test.ts` were deleted
  so the F8 baseline was the product rather than my own test run (F9). Re-running the site suite
  puts them back.

`node admin/.probe/bootstrap.mts --drop` style rebuild — or simply running the suites again —
restores it. Nothing here ever touched any database but `aether_test`, and every script refuses
any other by name.

---

## 10. Gates — the tree surveyed was green

| Gate | Result |
|---|---|
| `npm test` (root, game suite) | **3301 pass / 0 fail / 0 skipped** |
| `node scripts/contract-check.mjs` | **129/129 files present. All contracts satisfied.** |
| `npm run build` (root) | **exit 0** |
| `site/ npx tsc --noEmit` | **exit 0, no output** |
| `site/ npm run build:site-only` | **exit 0** |
| `site/ npm test` | **422 pass / 0 fail** — *with the database attached* |

### One thing about the site gate that is worth more than the tick

Run as written, in a fresh checkout, `site/ npm test` reports:

```
Test Files  31 passed | 6 skipped (37)
     Tests  294 passed | 128 skipped (422)
```

**128 of 422 tests — 30% of the suite — skip silently** whenever `POSTGRES_TEST_URL` is absent,
which it is in any fresh worktree and in CI. Every integration test in the survey's blast radius is
in that set: `creditLedger`, `marketplacePurchase`, `serverContent`, `serverCredits`,
`customServers`, `progressLedger`, `playerLink`, `auditChain`, `leaderboard`.

`serverIdMigrations.test.ts` names this exact pattern as the reason the Phase 7 incident reached
production — *"Phase 7's own gates reported 273 passed / 128 skipped"* — and the same shape is
still what a default run reports today. Passing `POSTGRES_TEST_URL` explicitly (which is what the
422 above is) runs them all, and they all pass. **The tests are good; the default invocation hides
a third of them.** A gate that skips without saying so is the same failure mode as a gate that
measures something the product does not do.
