# Phase 2 step 6 — rewritten, and what it actually was

**Roadmap:** `docs/superpowers/specs/2026-08-21-implementation-brief-roadmap.md`, Phase 2.
**Supersedes:** step 6 as written, "`site_users` / `players` consolidation".
**Status:** shipped, except the two items in section 4.

---

## 1. The plan item did not name a defect

Step 6 asked for a consolidation of `site_users` into `players` and **nowhere stated a problem it
would fix**. Checked against the tree, the merge is also aimed at the wrong table:

- Every domain table already keys off `players(id)` — `credit_events`, `player_progress_items`,
  `player_progress_values`, `player_quest_engagements`, `purchases`. **None** keys off
  `site_users(id)`. `players` is already the domain identity.
- `site_users` is a thin credential table. **Two files** reference it by name; the admin app has
  zero references to it or to `site_user_id`.
- The id discipline is clean. All 23 API routes and all 11 `findOrCreatePlayer(session.user.id, …)`
  call sites were checked; not one passes a `players.id` where a `site_users.id` belongs or the
  reverse.

So the split was not causing confusion. It was hiding an unguarded write, and a merge would have
meant rewriting the whole auth layer to reach defects that a `WHERE` clause reaches.

**The real work was six defects, five of which are now closed.** None needed the consolidation.

## 2. What was actually wrong

| | Defect | Severity |
|---|---|---|
| **D3** | `findOrCreatePlayer` claimed a player row by email hash with no guard on `site_user_id`. An admin editing a player's email handed that player's credits, `game_state`, quests and purchase history to whoever owned the new address; the original owner got a fresh empty player. Silent, unlogged, unrecoverable. | **critical** |
| **2FA** | `authorize()` never read `totp_enabled` or `totp_secret` — `verifyTotp` was private to the setup route. The account page said "✓ 2FA is enabled on your account" and sign-in required a password only. | **critical** |
| **Ledger** | Stripe purchases and admin support grants moved `credit_balance` with a bare `UPDATE`, so `credit_events.balance_after` was underivable from that point on and the ledger's self-check reported the gap as corruption. | high |
| **D2** | `syncPlayerProfile` rewrote `email_hash`/`email_enc` on every call, and `auth.ts` calls it on every Google sign-in, so admin email corrections silently vanished. | medium |
| **D4** | The email-change path checked `site_users.email` for collisions but not `players.email_hash`, which is also UNIQUE. A collision committed one table, failed the other, and left them disagreeing permanently. | medium |
| **D8** | `/store` told anyone who had paid that their credits were "not yet collected" and would arrive "next time you enter the game". Already credited at checkout; `claimCredits()` had zero callers, so the cookie copy was never collected by anything. | medium |
| **D6/D7** | `site/.env.example` omitted `POSTGRES_URL`, `ENCRYPTION_KEY` and `HMAC_SECRET`, all required. `hmacSign` fell back to the literal string `'fallback'`, which signs well-formed rows into the admin's chained audit log and makes `verifyAuditChain()` report tampering. | medium |
| **D1** | `admin/lib/db.ts` claimed "all sensitive columns encrypted at rest" while `site_users.email` and `site_users.totp_secret` sat in cleartext in the same database. | see §4 |

## 3. The shape both critical defects shared

Neither was a hard bug. Both were **a control that reported success and did nothing**, and in both
cases the tests that existed could not have caught it:

- 2FA had a correct TOTP implementation. Every unit test of `verifyTotp` passes against the broken
  version, because the algorithm was never what was broken — the *call* was missing. Confirmed by
  deleting the enforcement again: only the scrape of `auth.ts` fails, all six algorithm tests stay
  green.
- The account-transfer bug is an atomicity property. A mock asserts what you already believed; only
  a real Postgres shows that `AND site_user_id IS NULL` inside the `UPDATE` is what makes it safe,
  rather than a `SELECT` and a decision.

So both fixes carry a scrape or an integration test alongside the unit tests, and every fix in this
document was verified by **removing it again and watching the intended case fail**. A gate that has
never failed has not been shown to measure anything.

## 4. Deliberately not done

**Encrypting `site_users.email`.** It is the login identity, looked up by value, with a UNIQUE
index. Encrypting it means adding a hash column, migrating every existing row, and changing
`getUserByEmail` — an auth-path migration where the failure mode is *nobody can sign in*. The
`totp_secret` half was done because it is not looked up by value and is worth more per row. The
docstring that overclaimed has been corrected, so nobody assessing risk is misled in the meantime.

**`players.site_user_id` TEXT → UUID with a real FK.** Recommended by the investigation, and the
argument is sound in principle: it turns silent orphaning into a database error. Not done, because
the value is now largely speculative and the risk is not. With D3 fixed, the reachable orphaning
path is closed; there is no `DELETE FROM site_users` anywhere in the repo, so nothing currently
creates orphans. Against that, `ALTER TYPE` is a rewrite of a column on a live table shared by two
apps, and `ensurePlayerColumns` runs it from the **request path** with no `catch` — a migration
that failed there would take every authenticated route down until someone intervened. If it is
wanted, it belongs in a deliberate migration window with the data validated first, not in a lazy
`ensure` helper.

**The round-trip tax.** Six routes call `getUserById` purely to fetch an email to hand to
`findOrCreatePlayer`, and `pgQuery` opens a new client per query — a `GET /api/game/session` costs
around eight connect/end cycles. This is the "`/api/user/me` does 5+ queries" complaint in the
roadmap, and the split is its cause. It is a performance problem, better answered by connection
pooling (already Phase 0 item 6) and one joined lookup than by a schema merge.

## 5. What remains of "consolidation"

After the above: the duplicate email storage (§4) and the round-trip tax (§4). Neither is
addressed by merging the tables — the first is "stop storing PII twice", the second is "stop
opening a connection per query". **Recommendation: strike step 6 as written.** If a merge is still
wanted once those two are done, it will be a much smaller job, and by then it will be clear whether
it buys anything at all.
