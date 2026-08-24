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
site's own `ensure*` functions as its request paths call them. Quests were seeded with the admin
app's own `seedQuests()` — **78 quests / 398 steps**, the same numbers production reports.

**What a green result here means.** It means the **logic** works. It does **not** mean production
works. A local run against a rebuilt test database cannot catch a production-only schema or
configuration fault. That is exactly how `/api/game/quests` and `/api/marketplace/items` shipped
returning HTTP 500 to every caller: the `ALTER TABLE … ADD COLUMN IF NOT EXISTS server_id` lived
in a module the read path never called, and every local and CI run was green because something
else had happened to ensure the column first. Section 8 audits that bug class statically, because
it is the one thing this method structurally cannot observe.

**What could not be tested at all.** See section 9.

---

## 1. Loop-blockers

*(populated as the survey proceeds — see the final message for the settled list)*

---

## 2. Findings

### F1 — Quest completion is forgeable. Still true, proved live. (severity: high)

`completeQuestEngagement` (`site/lib/playerDb.ts:939-1011`) never reads `step_states`. The only
gate on payout is `status = 'in_progress'`. Two POSTs to the real route pay the full reward with
zero steps done.

Driven through the real HTTP surface from a signed-in browser session (there is no quest UI on the
site — see §7):

```
balance_before: 0

POST /api/game/quests {"action":"accept","questId":"3dd90c05-…-25767a71f185"}
  200 {"ok":true,"engagementId":"6a35b5f4-7dc1-4774-995b-db022ac6b828","existing":false}

POST /api/game/quests {"action":"complete","engagementId":"6a35b5f4-…"}
  200 {"ok":true,"creditsRewarded":90,"creditsAwarded":90,"creditBalance":90,"alreadyCompleted":false}

balance_after: 90
```

Quest 1 ("Get the concourse beacon array back on the air") has **two** steps. Neither was
attempted, and no `progress` action was ever sent. The row the server wrote:

```
player_quest_engagements
  status           = completed
  percent_complete = 100
  credits_rewarded = 90
  step_states      = NULL      <-- never written, never read
  completed_at     = set
```

`percent_complete = 100` is written by the completion statement itself
(`playerDb.ts:987`), so the engagement row does not even record that the quest was skipped.

This was already recorded (`src/systems/QuestSystem.js:342-344`, mission architecture §11) and is
**not fixed**. Per the brief it has not been fixed here either — reported, not patched.

### F2 — Quest rewards move `credit_balance` with no ledger row. (severity: high, NEW)

This is the Phase 2 defect — "credits moving with no ledger row, which makes `balance_after`
underivable" — still live on the quest payout path. Phase 2 fixed it for Stripe purchases
(`playerDb.ts:518-534`) and for admin grants (`admin/lib/db.ts:862-876`). Both now pair the balance
move with a `credit_events` insert in one statement. `completeQuestEngagement` does not:

```sql
-- site/lib/playerDb.ts:985-999 — the entire payout
WITH finished AS (
  UPDATE player_quest_engagements
     SET status = 'completed', credits_rewarded = $1::int, percent_complete = 100,
         completed_at = NOW(), updated_at = NOW()
   WHERE id = $2 AND player_id = $3 AND status = 'in_progress'
   RETURNING id, player_id
)
UPDATE players p
   SET credit_balance = credit_balance + $1::int, updated_at = NOW()
  FROM finished f
 WHERE p.id = f.player_id
 RETURNING f.id, p.credit_balance
```

There is no `INSERT INTO credit_events` in that function or in its only caller
(`app/api/game/quests/route.ts:132`).

**Proved live.** After F1's forged 90, the sequence below was driven through the real routes: one
ledger event (which triggers `ensureOpeningBalance`), then a second forged quest completion, then
another ledger event.

```
POST /api/game/credits {"events":[{"key":"survey-kill-1","reason":"kill","delta":5}]}
  200 {"balance":95, results:[{applied:true, delta:5, balance:95, reason:"ok"}]}

POST /api/game/quests  {"action":"accept","questId":"3527dc06-…"}   -> engagementId
POST /api/game/quests  {"action":"complete","engagementId":"…"}
  200 {"ok":true,"creditsRewarded":150,"creditBalance":245}

POST /api/game/credits {"events":[{"key":"survey-kill-2","reason":"kill","delta":5}]}
  200 {"balance":250, results:[{applied:true, delta:5, balance:250, reason:"ok"}]}
```

The ledger this leaves behind:

```
event_key                      kind       detail            delta  balance_after
migration:d58bae0d-…           migration  opening balance     +90             90
survey-kill-1                  kill       kill                 +5             95
survey-kill-2                  kill       kill                 +5            250   <-- +155 on a +5 event

SELECT SUM(delta) FROM credit_events  ->  100
SELECT credit_balance  FROM players   ->  250
```

Row 3's `balance_after` cannot be derived from row 2's `balance_after` plus row 3's `delta`
(95 + 5 = 100, not 250). The 150-credit quest reward is invisible to the chain. The ledger's
self-check becomes noise from a player's first quest completion onward — which is every player.

Note the masking: `ensureOpeningBalance` fires on a player's *first* `/api/game/credits` call and
writes a `migration` row for whatever the balance happens to be then. That absorbed the first
forged 90 silently. Only quest rewards earned *after* that first ledger event show up as a hole —
so the corruption is invisible in exactly the case (a brand-new player) that a smoke test checks.

`creditPricing.ts:305` maps the client-reported reason `quest` to `'refused'` *because*
`completeQuestEngagement` already paid it, so the ledger is deliberately blind to quest rewards.
The deliberate part is not paying twice; the accidental part is not recording it at all.

