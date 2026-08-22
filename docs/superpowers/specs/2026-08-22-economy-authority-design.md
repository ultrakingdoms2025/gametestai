# Phase 2 — Economy Authority, Design

**Roadmap:** `docs/superpowers/specs/2026-08-21-implementation-brief-roadmap.md`, Phase 2 (decision D3).
**Status:** design. No code yet.
**Closes:** P2 — `POST /api/game/state` writes `SET credit_balance = $1` from the request body.

---

## 1. The hole, precisely

`site/app/api/game/state/route.ts:44-53` takes `credits` from the browser, checks only that it is
a finite non-negative number, and `site/lib/playerDb.ts:295-310` writes it. The client pushes this
every ~1.5 s and on `pagehide`. A player's balance is whatever their browser last said.

`site/lib/marketplaceDb.ts` has no purchase transaction at all — buying is client-side arithmetic
against a client-held wallet, and the server learns of it only through that same balance write,
plus a best-effort `game_trades` row that is a **record, not an authority**.

One path is already correct and is the template for everything below:
`completeQuestEngagement` (`playerDb.ts:764-789`) prices the reward server-side from
`quests.reward_credits`, applies it in a single data-modifying CTE guarded by
`WHERE status = 'in_progress'`, loses concurrent races safely, and returns the authoritative
balance so the client's next push cannot clobber the grant.

## 2. The ceiling, stated honestly

**The server cannot verify that gameplay happened.** There is no server-side simulation. Every
credit source is a client-side event — a hostile killed, loot picked up, a race finished, ore
mined, a relic found. A server asked "did this really happen?" has no way to answer.

So server authority here means four specific things, and *not* a fifth:

1. **The server owns the number.** The client never sends a balance.
2. **The server prices events.** The client says *what happened*; the amount comes from a
   server-side table the client cannot see or influence.
3. **The server bounds them.** Per-kind rate and per-session caps, so a forged event stream
   yields a trickle rather than a fortune.
4. **The server dedupes them.** An idempotency key per event, so a replayed or retried packet
   pays exactly once.

**Not: the server cannot make forgery impossible.** A determined attacker with a debugger can
still emit "I killed a hostile" repeatedly. Caps bound the yield and the audit log makes it
visible. Anyone claiming more than that for a client-simulated game is selling something.

### The corollary that changes decision D2

Brief §5.6 asks for a **"most weekly credits earned"** leaderboard. Under the model above credits
are *bounded* but still ultimately client-asserted — so ranking by credit total ranks whoever
forged most patiently.

**Recommendation: shared leaderboards must not rank credit totals.** Rank on what the server can
verify outright:

- **quests completed** — already server-authoritative, prerequisite-enforced, one-shot per
  `quests.repeatable`, and impossible to replay (the CTE sees to it)
- **distinct relics found / worlds reached** — identity-based, finite, non-repeatable
- **best race and trial times** — self-limiting, and a forged time is a visible outlier

This does not weaken the brief's intent, it serves it: §5.5 asks that rewards "not become easy to
farm or exploit", and a credit leaderboard is the most farmable board we could build. Recorded
because D2 put leaderboards across servers, which raises the stakes.

## 3. Design

### 3.1 The ledger

A `credit_events` table becomes the source of truth for every change to `players.credit_balance`.
`credit_balance` stays as the materialised total, so nothing that reads it today has to change.

```
credit_events
  id            UUID PK
  player_id     UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE
  event_key     TEXT NOT NULL          -- client-supplied idempotency key
  kind          TEXT NOT NULL          -- 'kill' | 'loot' | 'race' | 'minigame' | 'purchase' | ...
  detail        TEXT                   -- world id, item id; for audit, never for pricing
  delta         INTEGER NOT NULL       -- server-priced, negative for a spend
  balance_after INTEGER NOT NULL       -- so the ledger is self-checking
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  UNIQUE (player_id, event_key)        -- the idempotency guarantee, enforced by the database
```

The UNIQUE constraint is the whole dedup mechanism. Not a `Set` in a process, not a check-then-act
— a constraint, so two concurrent requests carrying the same key cannot both win.

### 3.2 Pricing lives on the server

A `CREDIT_PRICES` map in server code mirroring the values currently in the client
(`CREDITS_PER_KILL = 5`, `RACE_PRIZES = [10, 5, 2]`, minigame win 10, …). The client sends `kind`
and `detail`; never an amount. Where a source is genuinely variable (a loot stack), the server
prices from the item definition, not from the client's number.

### 3.3 Caps

Per `kind`, a ceiling per rolling window, evaluated in the same statement that inserts. Exceeding
it is not an error — the event is recorded with `delta = 0` and a reason, so the trail shows the
attempt rather than hiding it. Starting values want measuring against real play before they are
trusted: **a cap that fires during honest play is worse than no cap.**

### 3.4 Spending is the same mechanism

A marketplace purchase is a negative event priced from `marketplace_items.cost_buy`, applied in
one statement that debits and grants together, with `WHERE credit_balance >= cost` so it can
neither overdraw nor double-spend under concurrency. This is the half `marketplaceDb.ts` has
never had.

### 3.5 The client keeps a mirror, not a wallet

`Economy.js` keeps its local number for display and immediate feedback — a purchase that waits on
a round trip would feel broken. The server's returned balance is authoritative and overwrites the
mirror on every response, exactly as `QuestSystem.js:946` already does for quest rewards.

## 4. Migration, and the thing that must not go wrong

`players.credit_balance` already holds every live player's real balance. The ledger starts empty
and the materialised total is carried forward — **no balance is recomputed from history, because
there is no history.** One opening `kind = 'migration'` event per player records the starting
total so the ledger is self-consistent from that point on.

Additive schema only, following the `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`
discipline already in `admin/lib/db.ts`.

**The failure mode to design against is not theft, it is loss.** If a credit source is missed
during the client migration, players silently stop being paid for it — worse than the hole this
phase closes, because it is invisible and it makes people quit. So:

- every known credit source gets an event kind and a test **before** `/api/game/state` stops
  accepting `credits`
- those two changes ship together, never in separate deploys

### The 13 sources that must be covered

`Economy.js:194` kill · `Loot.js:729` pickup · `Inventory.js:437` credits item ·
`Contracts.js:236` turn-in (currently unreachable — see the roadmap) · `RaceManager.js:48` prizes ·
minigame win · `main.js:1988,1998` maze centre and token · `SpaceObjectives.js:1806` tier payouts ·
`Relics.js` pickup · `Viewpoints.js` `_setPaid` · `playerDb.ts:765` quest reward (already
server-side) · `AdminCheats.js:132` (must be **refused server-side**, not merely hidden) ·
Stripe purchase (`playerDb.ts:389`, already server-side).

## 5. Order of work

1. **Ledger and pricing, server-side only.** New table, new endpoint, priced, capped, deduped,
   fully tested. Changes nothing for the running game — purely additive.
2. **Marketplace purchase transaction.** Self-contained, and the highest-value single fix after
   the ledger.
3. **Client migration.** `Economy.js` and its callers emit events; the mirror follows the server.
4. **Close the hole.** `/api/game/state` stops accepting `credits`. Ships **with** step 3.
5. **Remote-save parity** — relics, viewpoints, objectives, trials, piloting, mining, character
   are localStorage-only today — plus the `Relics.serialize` count-not-identity defect.
6. **`site_users` / `players` consolidation**, in the same migration window.

Steps 1 and 2 are safe to ship alone. Steps 3 and 4 are one deploy. Step 5 is what makes
cross-device play work at all, and Phase 5 (mobile) depends on it.

## 6. Verification

- A crafted request cannot change a balance except through a server-priced action.
- The same `event_key` twice pays once — asserted against the database, not a mock.
- Concurrent purchases of one item with a balance covering only one cannot both succeed.
- Every existing balance survives the migration byte-identical.
- **A playthrough agent earns from each source and the ledger agrees with the HUD.** A unit test
  proves the endpoint; only a playthrough proves nothing stopped paying.
