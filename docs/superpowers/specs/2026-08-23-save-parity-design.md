# Phase 2 step 5 — Remote-save parity, Design

**Roadmap:** `docs/superpowers/specs/2026-08-21-implementation-brief-roadmap.md`, Phase 2.
**Predecessor:** `docs/superpowers/specs/2026-08-22-economy-authority-design.md`, section 5 item 5.
**Status:** design. No code yet.
**Blocks:** Phase 5 (mobile) item 5, "cross-device state".

---

## 1. What the plan said, and what is actually true

The predecessor says relics, viewpoints, objectives, trials, piloting, mining and character
"are localStorage-only today". Read as *not mirrored to the account*, that is accurate for all
seven. Read as *do not persist*, it is false for all seven, and planning from the second reading
would waste the whole step looking for missing `serialize()` methods.

**All seven are already in the `SaveGame` snapshot and restored on load.** Five have
`serialize`/`deserialize` pairs. Two do not, and both are worth knowing before any code is written:

- **Trials has no owning system.** `SaveGame` keeps the ledger itself, in `_trials`
  (`SaveGame.js:161`), populated off `minigame:finished`. `SaveGame` *supports* an injected
  `trials` system (`SaveGame.js:513`) but `main.js:509-530` never passes one, so the internal Map
  is always the authority. There is no third-party object to hang remote parity off.
- **Character has no serialize/deserialize.** The contract is a getter/setter pair on
  `PlayerAvatar`: `get characterConfig()` (`PlayerAvatar.js:499`) and `setCharacterConfig()`
  (`PlayerAvatar.js:519`).

So this step is not "add persistence". It is **"mirror what already persists, and decide which
copy wins."** The second half is the hard half, and it is the whole content of this document.

## 2. The hole, precisely

The entire remote surface is `buildRemotePayload` (`main.js:557-572`), which carries three things:

```js
state: { v: 1, at: Date.now(),
         inventory:  inventory?.serialize?.()  ?? null,
         mounts:     mounts?.serialize?.()     ?? null,
         cosmetics:  cosmetics?.serialize?.()  ?? null }
```

It is stored as one opaque JSON blob in `players.game_state` (`playerDb.ts:275`), capped at
200,000 characters, with **no validation of any kind** — `state/route.ts:61` passes `body.state`
straight through.

That much is known. What is not written down anywhere is that **those three fields are already
double-owned, and the collision already loses data**:

1. `hydrateAccountSession` applies the server's copy at boot (`main.js:890-918`), before the
   title card.
2. The player clicks CONTINUE, which runs `save.load()` (`main.js:2250`).
3. `_restoreInventory` / `_restoreMounts` / `_restoreCosmetics` overwrite what the server just
   supplied, from localStorage.

**localStorage silently wins.** The comment at `main.js:888-889` — "Server-saved inventory takes
precedence over whatever the fresh boot seeded" — is true only against the fresh boot seed, never
against a CONTINUE. So cross-device is already broken in the direction nobody would guess: play on
the phone, come back to the PC, and the PC's stale local copy overwrites the phone's progress and
then pushes itself to the server as the new truth.

**Adding seven more systems to that payload without fixing arbitration multiplies the loss
surface sevenfold.** The payload extension is the easy half of this step and must not ship first.

## 3. The failure mode to design against

Phase 2 named it and it has not changed: **the failure mode is loss, not theft.** But the shape
is different here, and worth being precise about.

Phase 2's risk was a credit source being missed during migration, so players silently stopped
being paid. This step's risk is **a device with stale state overwriting a device with fresh
state**. It is invisible at the moment it happens, it destroys exactly the thing the player spent
hours on, and — unlike a missed credit source — there is no ledger to reconstruct it from.

None of this is an anti-cheat problem. Relic counts and best times are not money, and the ceiling
stated in the predecessor's section 2 applies unchanged: the server cannot verify that gameplay
happened. This step is about **durability and convergence**, and should not borrow the ledger's
adversarial framing.

One exception, recorded because it changes a later decision: the predecessor's section 2
recommends leaderboards rank on "distinct relics found / worlds reached" and "best race and trial
times". Those are exactly the values this step moves server-side. Whatever shape they land in
becomes the substrate for that leaderboard, which is a second reason to store identities rather
than totals — a total cannot be audited, and a set can.

## 4. Design: merge where the data allows it, arbitrate only where it does not

Most of this data is **monotone**. A relic once found is found forever. A viewpoint once synced
stays synced. A mineral seam once worked out never refills. A best time only ever improves.

For monotone data there is a merge that **cannot lose**: union for sets, `min` for best times,
`max` for counters. It is commutative and idempotent, so it does not matter which device syncs
first, a replayed packet changes nothing, and **no clock is required**. That last property matters
more than it looks: device clocks disagree, and a last-write-wins scheme built on them loses data
whenever a phone's clock is a few minutes fast.

| System | Shape | Merge |
|---|---|---|
| relics found | **must become identities — see §5** | union |
| relics `paid` | set of milestone keys | union |
| viewpoints `worlds` / `charts` / `sets` | sets of authored ids | union |
| mining `taken` | set of node keys | union |
| mining `stats` | counters | derive from `taken`; `max` for what cannot be derived |
| objectives kills / survey / ore / elements | maps keyed by identity | union of keys, `max` per key |
| trials `best` | map of `worldId/venueId` → time | **`min`** per key |
| piloting | ship id, position, quaternion, hold | last-write-wins |
| character | appearance config | last-write-wins |
| player position / world / health | mutable | see §6 |

Only three rows need arbitration, and they are exactly the three where "the newer one" is the
right answer rather than a guess.

## 5. Relics is the blocker, not a side item

`Relics.serialize` (`Relics.js:405-411`) stores **one integer per world** — "you found 12 in
citadel" — plus a set of milestone receipt keys. `_applyFound` (`Relics.js:481-484`) then marks
the *first N sites in generation order* as taken, which within one session is the same set and
across a reload is not.

That is already a defect on a single device, and it is documented as a known limitation
(`Relics.js:452-479`) which explicitly rejects storing ids on the grounds that placement has no
stable ones. For a single device the author's reasoning holds: the count and the money round-trip
exactly, and only *which* thirty is wrong.

**Across devices a count is not merely imprecise, it is unmergeable.** Device A finds relics
{1, 3, 7}; device B finds {2, 4}. The union of identities is five relics. The maximum of the
counts is three. Two relics are destroyed, permanently, and the player is never told.

So relics cannot join the merge until it stores identities, and every other system in the table
above already does. **Fixing it is a prerequisite for this step, not an item within it.**

The id scheme must be **content-derived** rather than an index into the generated array, so that
it does not depend on generation order at all. The tradeoff has to be stated honestly rather than
sold: under a content change some stored ids will match nothing, and those relics become
re-findable. That is a *conservative* failure — the player re-collects a few — where today's
failure is silently marking the wrong set. It is better, not perfect.

### 5.1 The scheme, and the invariant that makes it work

A relic site is `{ pos, taken, phase }` (`Relics.js:318`) and **nothing else** — no index, no
district tag, no reference back to the roof or tower it came from. Authored provenance is
therefore not merely inconvenient, it does not exist; and it could never cover the **darted**
sites (`Relics.js:736`), which have no anchor by definition and which medieval and station both
have. Position is the only content-derived identity available.

The original docstring rejects ids because "a stored id set would silently mark the WRONG sites
after any content change". **That objection is answered by an invariant the file already
enforces.** `_tooClose` (`Relics.js:779-787`) is applied on *both* the authored deal and the dart
pass, so **no two sites in a world are within `MIN_APART` = 14 m of each other in XZ.**

Two consequences follow, and the second is the one that matters:

1. Any grid cell smaller than `14/√2 ≈ 9.9 m` holds at most one site, so a quantised position is
   collision-free at any sane resolution. Separation is XZ-only, so `y` is **not** needed for
   uniqueness and must not be matched on — a deck-height tweak would break the key for nothing.
2. **Matching must be nearest-neighbour within a tolerance, not string equality.** A key stored
   as a string flips whenever a position drifts across a cell boundary. Instead, decode the key
   back to a position and claim the nearest live site within `MATCH_R`. Choosing
   `MATCH_R = 6 < MIN_APART/2 = 7` makes the assignment **provably one-to-one**: no stored key can
   lie within 6 m of two sites, and no site can be claimed by two keys.

```
id = `${round(x*2)/2}:${round(z*2)/2}`        // 0.5 m quantisation, XZ only
```

`MATCH_R` gets a named constant beside `MIN_APART` with the `MIN_APART / 2` derivation written
down, so that a later reduction of `MIN_APART` breaks loudly rather than silently double-claiming.

Sub-6 m authoring drift keeps the identity. Larger drift drops that one relic back to un-found —
the conservative direction. Cost is ~1.5 KB per world and ~12k distance tests once per world
entry; both negligible.

### 5.2 Migration: additive field, no schema bump

`SAVE_SCHEMA` is 1 and `_validate` **rejects any other version** (`SaveGame.js:27, 1137`), so
bumping it would discard every existing save. It stays at 1; the change is additive inside the
`relics` slice, which `_validate` only requires to be a non-array object. The integrity seal
covers new fields automatically (`bodyOf`).

- **`serialize` writes both** `found` (the legacy count) and `foundIds` (the new authority), with
  the count *derived* from the id list so the two cannot disagree.
- **`deserialize` prefers `foundIds`, falls back to `found`.** The fallback is not optional —
  existing tests call `deserialize({ found: { citadel: 4 } })` directly.
- **`_applyFound` becomes two-mode**, and it is the single seam: every player-visible quantity
  (`remaining`, `total`, `found`, `markers`, the HUD row, the milestones) derives from
  `sites[i].taken`, never from `_found`. With ids, nearest-match. With a legacy count only, keep
  today's exact `i < already` behaviour **and then immediately upgrade** — write those sites' ids
  into the ledger so the next `serialize` emits them. That upgrade is no more wrong than the
  restore already is; it just stops being wrong afterwards.
- **`_paid` is untouched** — already keyed `${worldId}:${milestone}`, already an identity set.

### 5.3 One behaviour fix the merge forces

`_payMilestones` is called only from `_collect` (`Relics.js:894`). After a union merge a world can
become complete **without a pickup** — device A holds relics 1-15, device B holds 16-30, the union
is the full set, and the set prize never pays because there is no next pickup to trigger it.

So `_payMilestones()` must also run from `_onWorld` after `_applyFound()`. `_claim`/`_paid` make
it idempotent, so "re-entering a completed world paid nothing" still holds. `Viewpoints.js:512-525`
records hitting exactly this case and handling it on world entry for the same reason.

### 5.4 Merge is not restore

`deserialize` REPLACES (`Relics.js:413-428`) and must keep doing so — a load has to be able to
take progress away. A merge must never take progress away. They are two entry points with
opposite rules, and the docstrings must say so, or the next reader will "fix" one into the other.

## 6. What should not sync, and why

Player position, active world and health are in the local snapshot and should **stay** there,
at least in this step. They are the most volatile values in the save and the least valuable to
carry: last-write-wins on position means signing in on a phone during a lunch break can teleport
a PC session that is mid-descent somewhere else. The cost of getting it wrong is high and the
benefit is a convenience.

Recorded as a deliberate exclusion so the next reader does not assume it was forgotten.

## 7. Storage

Two candidate shapes, and the choice follows from §4.

**(a) Extend the `players.game_state` blob.** Cheapest — no schema change. But the server cannot
merge an opaque blob; it can only store whichever one arrived last. That is precisely the failure
this step exists to remove, so it is rejected for the monotone data.

**(b) Normalised rows, where the union is a database constraint.** A set-shaped fact becomes a
row, and the merge becomes `INSERT ... ON CONFLICT DO NOTHING`. The union is then enforced by a
UNIQUE index rather than by application code — the same argument the credit ledger makes for its
idempotency (`creditLedger.ts:30-35`): "not a Set in a process, which would not survive two
lambdas, and not a check-then-act". It also makes the leaderboard queries of §3 expressible,
which a blob does not.

**Proposal: (b) for the set-shaped data, (a) for the last-write-wins remainder.** Piloting and
character are genuinely single-valued per player, do not merge, and gain nothing from
normalisation; they can ride in the existing blob with an explicit timestamp.

Conventions to follow, taken from `creditLedger.ts` and stated there with reasons:

- `player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE` — **TEXT, not UUID.**
  Production's `players.id` is TEXT (`admin/lib/db.ts:130`) and Postgres refuses a UUID→TEXT
  foreign key outright.
- Additive only: `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`, safe to re-run against
  production, never dropping or rewriting (`playerDb.ts:450-454`).
- Signature `(db: Db, ...)` so the route owns the connection and a batch runs on one of them.
- Memoise the `ensure` **promise**, not a boolean — a bare boolean lets concurrent callers race
  ahead of the DDL (`playerDb.ts:456-459`).

## 8. Order of work

1. **Relic identities**, with a migration from count-based saves. Local only; changes nothing
   remote. Ships alone and is verifiable alone.
2. **The merge, server-side**: schema, endpoint, union/min semantics, tested against a real
   Postgres in the `aether_test` database the ledger already established.
3. **The client sends and receives it**, and `hydrateAccountSession` / `save.load()` stop fighting
   — one arbitration point, not two.
4. **The remaining last-write-wins state** (piloting, character) with an explicit timestamp.

Steps 1 and 2 are independently shippable. Step 3 is the one that changes behaviour for existing
players and wants the most care.

## 9. Verification

- Two simulated devices, each finding a **disjoint** set of relics, converge to the union — not
  to whichever synced last. Asserted against the database, not a mock.
- The same payload applied twice changes nothing (idempotence).
- Applying device A then B gives the same result as B then A (commutativity). This is the property
  that makes the clock irrelevant, so it is the one worth asserting directly.
- A best time only ever decreases.
- **Every existing save survives.** A count-based relic save loads, and the player's number does
  not change.
- A signed-out player is unaffected end to end.
- **A playthrough agent with real key events** earns progress in each of the seven, reloads, and
  finds it intact. A unit test proves the merge; only a playthrough proves nothing stopped
  recording. This shape has cost World 06 nine separate times: *a gate that measures something the
  game does not do is worse than no gate.*
