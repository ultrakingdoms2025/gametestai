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

---

## 7. What has landed, and one thing step 1 got wrong

**Step 1 — ledger and pricing.** Done (`3507188`, `5646e5b`). `creditPricing.ts`,
`creditLedger.ts`, and an integration suite against a real Postgres.

**A defect in step 1, found before it could ship.** `credit_events.player_id` was
declared `UUID NOT NULL REFERENCES players(id)`. Production's `players.id` is
**TEXT** (`admin/lib/db.ts:130`), holding UUID-shaped strings from `randomUUID()`.
Postgres refuses a UUID → TEXT foreign key outright:

```
foreign key constraint "credit_events_player_id_fkey" cannot be implemented
```

So `ensureCreditSchema` would have thrown on its first production call and the
ledger table could never have been created. Confirmed twice: by running the real
function against a prod-shaped `players` table, and by a read-only query against
production, which shows `players.id = text` and **no `credit_events` table**.

The reason the suite passed anyway is the part worth keeping: the test built its
own stand-in `players` with `id UUID`. It was not testing the ledger against
production's schema, it was testing it against a schema invented to suit it. That
is the same shape as the reach probes and the flight rig — *a gate that measures
something the system does not do reports confidence it has not earned.* The
stand-in now declares `id TEXT` and carries a comment saying why, so the next
person to widen it has to argue with production rather than with me.

**Step 2 — the marketplace purchase transaction.** Done.
`purchaseMarketplaceItem` prices from `marketplace_items.cost_buy` under a row
lock, debits a locked player row, decrements stock and writes the admin sale
record, all in ONE transaction. The client names an item; there is no field in
the request in which a price could be smuggled.

`spendCredits` was split into `debitInTransaction` plus a wrapper, because
Postgres has no nested `BEGIN` — an inner `COMMIT` would commit the outer
transaction — so anything that must be atomic with a debit has to share the
debit's transaction rather than call something that opens its own.

### Two things the tests only proved after being made to fail

Every test below passed on first run, which is not evidence. Each guarantee was
then re-checked by breaking the implementation:

1. **Removing the retry check** failed exactly one test — the one that says a
   retry is told `duplicate` rather than `insufficient`. The trap it guards is
   specific: the first attempt has already spent the credits, so a retry that is
   simply re-evaluated sees the reduced balance and reports failure for a
   purchase that succeeded, and the player sees an error for an item they own.

2. **Removing the player row lock changed nothing** — 15 tests, three runs, all
   green. The "cannot double-spend" test could not see it, because buying takes a
   `FOR UPDATE` lock on the ITEM row, and that serialises two buyers of the same
   item all by itself. The balance lock only matters when one player buys **two
   different items** at once, and nothing tested that. Added; it now fails 3 of 3
   with the lock removed and passes 3 of 3 with it restored.

   Worth stating plainly, because it nearly repeated the step-1 mistake one layer
   down: **a concurrency test can pass for a reason that has nothing to do with
   the lock it claims to be testing.** Mutating the code is what tells the
   difference; a green run does not.

### Still to do, unchanged

Steps 3–6 in section 5. Note that the opening `kind = 'migration'` row per player
(section 4) has not been written yet, and `credit_events` still does not exist on
production — the first call to `ensureCreditSchema` will create it.

---

## 8. Steps 3 and 4 — the client migrated, the hole closed

Shipped together, as section 4 requires.

### The choke point, and why not 22 edits

`Economy.add(amount, reason)` / `.spend(...)` is the funnel every credit change in
the game already passes through, and all three mutators emit exactly one event
from exactly one line (`Economy.js:160` — verified as the only emitter in the
tree). `CreditReporter` listens there. Nothing else changed at a call site.

That matters because **section 4's list of 13 sources was wrong: there are 22.**
It missed `ore` — the entire World 06 mining economy — plus `bounty`,
marketplace sell income, `relic-set`, and four separate `SpaceObjectives`
channels. Hand-migrating a list that was already incomplete is precisely how a
source silently stops paying.

Two gates now stand where the list used to:

- **`creditReasons.test.ts` scrapes `src/`** for every reason tag reaching
  `add`/`spend` and fails if one is missing from `REASON_KIND`. Dynamic reasons
  (`SpaceObjectives._payTier`'s `channel`) must be enumerated by hand in the test,
  so adding one forces a visit. It also flags a mapped reason that nothing emits
   — which is how the `kill` grant was found hiding as `this.add()` INSIDE
  `Economy`, invisible to a scrape looking for `economy.add`.
- **A constant-drift test** reads `CREDITS_PER_KILL`, `VALUE`, `SET_CREDITS`,
  `SYNC_CREDITS`, `MAZE_CENTRE_VALUE` and `MAZE_TOKEN_VALUE` out of the game and
  asserts the server prices them identically.

### The flat price table was wrong on four of five rows

Step 1's prices were written from memory of what the client does rather than
measured from it, and every error was in the direction that looks like theft:

| kind | step 1 said | the game actually pays |
|---|---|---|
| relic | 15 | 120, and 500 for a set |
| viewpoint | 10 | 150 |
| maze | 25 | 100 centre, 6 token |
| objective | 20 | 225 – 3,000 by tier |

Worse, `race` and `minigame` were priced from a `detail` field — a placing, or
`'won'` — that a reported event does not carry. Both would have paid **zero**,
for every player, silently.

So the model is now explicit about its two halves:

- **Priced** (client's number discarded): `kill` 5, `relic` 120/500,
  `viewpoint` 150, `maze` 100/6. All constants, all pinned to source by the drift
  test.
- **Declared and bounded** (client's number honoured, with a per-event ceiling
  and a rate cap): `ore`, `sell`, `contract`, `bounty`, `loot`, `race`,
  `minigame`, `objective`, and every spend. The ceilings sit far above the
  measured maximum of each — an over-ceiling event is refused and recorded, never
  truncated, because truncation pays a wrong number and leaves no trace.

This is weaker than pricing everything and is not dressed up as more. Pricing
`ore` properly means porting the ore tables and having the client report a cargo
manifest instead of a total. Worth doing; not this change.

### `quest` is refused, because it is already paid

`completeQuestEngagement` prices a quest server-side and grants it; the client
then mirrors the returned balance. Honouring a reported `quest` would pay twice.

### Filtering on the operation, not the tag

`QuestSystem` writes that authoritative balance with `economy.set(next, 'quest')`
— the same tag it uses for a reward `add`. A reporter that blocklisted tags would
have reported a player's entire net worth as freshly earned credits the first
time a quest completed. `Economy._emit` now carries `op`, and only `add` and
`spend` are reported. A blocklist of reasons was the first implementation, and it
was wrong.

### Durability, and why replays are free

The queue is written to localStorage on every change and is deliberately NOT
cleared by the `pagehide` beacon, which cannot confirm delivery. The next boot
re-sends it; `UNIQUE (player_id, event_key)` refuses whatever already landed.
Losing a duplicate is free, losing an earning is not.

The mirror only adopts the server's balance once the queue has drained. Mid-flush
the local number is legitimately ahead, and adopting there would visibly take
credits off the HUD and hand them back a second later.

### The hole

`POST /api/game/state` no longer reads `credits`, and `saveGameState` no longer
takes one. `setPlayerCreditBalance` — exported, and with no callers — is deleted
rather than left, because an unused function that does exactly the forbidden
thing is an invitation with a docblock on it.

A `credits` field in the body is **ignored, not rejected**: a browser holding a
cached copy of the old bundle keeps sending one until its tab closes, and a 400
would stop that player's inventory saving too.

### Also closed: buying credits with credits

`credits` is a virtual item id that `Inventory._addCredits` turns straight into
balance. An admin-authored catalogue row keyed `source_key: 'credits'` would have
converted `cost_buy` into an arbitrary payout. The purchase transaction refuses
that id outright.

### Known gap, recorded rather than fixed

`admin/lib/db.ts:791` adjusts `credit_balance` directly for support grants. That
bypasses the ledger, so a player's `balance_after` chain is wrong from the first
adjustment onward. The fix is one insert; it is in a third app with no test suite
and was left out of this change deliberately rather than done unverified.
