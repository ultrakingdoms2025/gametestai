# Phase 7 — Custom servers · `custom-servers` · ledger

**Date:** 2026-08-23 · **Branch:** `worktree-agent-a1fe93f0a3122ab5e` · not pushed, not merged.

Roadmap §Phase 7 (7a–7f), decision D2, mission architecture §9.

---

## 1. The residual, and how it was closed

`site/lib/leaderboard.ts` shipped earlier today and closed the Phase 7 abuse vector by
construction: a global board enumerates the platform content manifest in its `FROM` clause, so
a forged world id is not a candidate and there is no filter to forget. It recorded **one** place
where that argument does not reach:

> An owner quest authored **into a platform world** with `server_id` left NULL is, by every
> column that table has, a platform quest. **Phase 7c's owner CRUD must stamp it.**

Closed in `site/lib/serverContent.ts`. The stamp is the **second positional argument of every
function in the module**, validated before any statement is issued, and present in the `WHERE`
of every read, update and delete. There is no call shape that writes NULL and none that reaches
a row whose `server_id` is NULL — a platform row is unreachable because NULL matches no
equality, which is a property of SQL rather than of anyone's diligence.

The second half matters as much as the first. An owner who could `PATCH` a platform quest's
`reward_credits` to 10,000 would not need to author anything: the quest would already be in the
manifest, already unstamped, already ranked.

### How it was proved

Three layers, and the middle one is the one that runs everywhere:

1. **Executed against a real Postgres.** The hostile quest — 10,000 CR, authored into `citadel`
   through the owner CRUD — was run end to end and the global board did not move. Then the
   stamp was deleted from `createServerQuest` and the same scenario re-run: the board moved to
   `{ player: 1 }`. **The guard is load-bearing and the test measures the real thing.**
2. **A recording client**, in `serverContent.test.ts`, asserts the value bound to the
   `server_id` COLUMN (resolved through the INSERT's own column list, not "the params contain
   the id somewhere"), that a blank server id throws before any statement is issued, and that
   every owner-side UPDATE and DELETE carries `server_id = $n`. No database needed, so it runs
   on every machine.
3. **A route-layer scrape**, in `serverRouteGuards.test.ts`, counts the `serverContent` calls in
   the content route and requires every one to bind `id` — the path parameter whose ownership
   the handler has already checked — so a ninth call added later cannot quietly pass something
   else.

Layer 2 exists because layer 1 skips wherever `POSTGRES_TEST_URL` is absent, and a gate that
measures nothing where it runs is worse than no gate.

---

## 2. Decisions taken, with the reasoning

### Owner lore gets its own table; `lore_entries` gets the column anyway

`lore_entries.scope` is a PRIMARY KEY, so per-server variants need it relaxed. Three live paths
in `admin/lib/db.ts` upsert with `ON CONFLICT (scope)`, which Postgres resolves against the
unique index on `scope` ALONE — relax the key and all three raise *"no unique or exclusion
constraint matching the ON CONFLICT specification"*. The two apps deploy independently, so
there is **no ordering of the two changes that avoids a broken window**: site-first breaks the
old admin code, admin-first breaks against the old index.

`server_lore_entries` has no such window. The `server_id` column is still added to
`lore_entries` and the platform read still states `WHERE server_id IS NULL`, for the same reason
`leaderboard.ts` stamped the progress tables before a writer existed: the read states its scope
now, while every row is NULL, so there is no later "and now add the filter" step to forget.

### Server credits are separate tables, not a column

"Cannot feed the global balance", not "must not". `server_credit_balances` and
`server_credit_events` have no column naming `players.credit_balance`, `serverCredits.ts` does
not import `creditLedger`, and it issues no statement against `players`. A leak would not be a
missing `WHERE`; it would be a function nobody has written.

### The selection is a row, not a cookie

Every content read has to answer "which scope?", and a cookie is not available to the
leaderboard route, the quest route or the chat poll without each learning to parse it.
`currentServerId` re-checks membership on every read, so a player removed between two requests
falls back to the platform catalogue on the very next one — enforcement at the read rather than
a cache somebody has to remember to clear.

### The owner dashboard is in `site/`, not `admin/`

`admin/` authenticates STAFF against its own session system. A server owner is an ordinary
player who has paid for hosting; gating owner CRUD there would mean giving every paying
customer a staff credential. `site/app/admin/` already hosts the marketplace and map panels.

The existing "every admin page names the guard" test was **widened rather than punctured**: a
page must require the staff allowlist **or** require a session and delegate every decision to
the routes it calls, and the second form is checked just as hard (it must call `auth()`, act on
the answer, and import no data module directly). A page with neither still fails, which is the
omission Phase 0 was written about.

### Chat is beside the game, not inside it

D2 removed the shared world instance, so two members standing in the same world do not see each
other and every message is addressed by server and player rather than by anything spatial. A
channel with no spatial component does not belong in the renderer, and putting it there would
mean the game had to be running for a player to answer a message. **The honest cost: a player
in pointer lock must release it to type.** An in-game panel is the follow-up.

---

## 3. Dead ends — do not retry

### A shared `PLATFORM_SCOPE_CLAUSE` constant

Written, used, and **deleted**. The tidy version interpolates one constant at each read site so
"is it scoped?" has one spelling. It does not survive its own purpose: the three read paths open
their own connections through module-private helpers, so the only thing a test can check is the
SQL in the file — and a clause behind `${aVariable}` is a clause the test cannot read. The
clause is written out literally in every query and `contentScoping.test.ts` is what enforces the
one spelling. The constant was removed rather than left as a module nothing calls.

### `MAX(quest_number) + 1` for owner quest numbers

`quests.quest_number` is `INTEGER UNIQUE NOT NULL` across the whole table. Two owners authoring
in the same second read the same maximum and one loses to the constraint for no reason they can
act on. A `SEQUENCE` starting at 1,000,000 has no such race. Pinned by a test that asserts
`nextval` is used and `MAX(quest_number)` is not.

### A raw control-character class in `cleanChatBody`

`/[\x00-\x1F]/` written literally puts invisible bytes in a source file, where they survive a
copy-paste as something else and defeated three separate editing attempts here. Replaced with an
explicit code-point loop that says what it does.

### `slugify` without dropping combining marks

`NFKD` splits an accented letter into a base letter and a combining mark. Without a
`\p{M}` strip the mark is simply a character outside `[a-z0-9]`, so it becomes a hyphen and
"Ünïcödé" slugs as `u-ni-co-de`. Caught by a test, not by reading.

---

## 4. Gates

| Gate | Result |
|---|---|
| `npm test` | 2958 / 2958 |
| `node scripts/contract-check.mjs` | 129 / 129 |
| `npm run build` | built |
| `cd site && npm test` | 273 passed, 128 skipped (was 298 total; 401 now) |
| `cd site && npm run build:site-only` | built, `/admin/servers` and 7 new routes present |
| `cd site && npx tsc --noEmit` | clean |
| `npm run test:layout` | OK, 6 viewports × 5 scenes |

---

## 5. What is left

- **Live Stripe keys.** Everything is exercised with `sk_test_`; `premium.ts`'s header states in
  full what test mode does and does not demonstrate. Renewal over real time (Stripe test clocks),
  disputes and involuntary churn are untested.
- **An in-game chat panel.** Today's is beside the iframe; pointer lock must be released to type.
- **The in-game marketplace and quest board** consume `/api/game/session`'s new `server_id` and
  `server_credits` fields only if a client reads them. The routes serve the scoped content; the
  world files were owned by other agents this run and were not touched.
- **The 128 skipped site tests** are the integration suites, which skip without
  `POSTGRES_TEST_URL`. They were executed once against an embedded Postgres during this phase
  (see §1) but that harness was temporary and is not committed.
