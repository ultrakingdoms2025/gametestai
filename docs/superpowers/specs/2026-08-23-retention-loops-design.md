# Phase 10 — Daily, weekly, seasonal · `retention-loops`

**Roadmap:** `2026-08-21-implementation-brief-roadmap.md`, Phase 10.
**Architecture:** `2026-08-23-mission-architecture.md` §5 and §6.
**Implements:** brief 5.2 (dailies, weeklies, a seasonal track), 5.5 (not farmable).

---

## 0. Corrections to §6, found on contact with the tree

§6 names two existing pieces and says the loop needs no new mechanism. One of
the two does not hold, and it does not hold for a reason that is measurable
rather than aesthetic.

### §6's `daily` credit kind cannot exist without paying credits

> "A `daily` kind with `maxEvents: 1, windowSeconds: 86400` is a **non-farmable
> daily enforced by the machinery that already bounds every other source**."

The cap mechanism is real and works exactly as described. What does not hold is
the route to it. The only way a client reaches `applyCreditEvent` is
`POST /api/game/credits`, whose body is `{ key, reason, delta }` and which runs
every item through `resolveReportedEvent(reason, delta)`
(`site/lib/creditPricing.ts`). That function's third statement is:

```ts
const d = Number(delta);
if (!Number.isInteger(d) || d === 0) return { ok: false, reason: 'invalid' };
```

**A zero-credit event cannot enter the ledger.** So a `daily` kind is only
reachable if the daily pays credits — and §5 measures the whole-game faucet at
over 250,000 CR against five `spend` call sites and says plainly that the
problem is a *sink* problem. A new source, however small and however well
capped, is the wrong direction on the one axis the phase before this one
measured.

Further: `creditReasons.test.ts` requires every entry in `REASON_KIND` to have a
matching `economy.add`/`spend` call site in `src/`. A kind with no emitter fails
the build. There is no way to add the machinery now and wire it later — it is
either paying or it is dead.

**Decision: the retention loop pays no credits at all.** §6's second piece is
recorded as evaluated and refused, in `creditPricing.ts`'s own prose, so the
next person does not re-propose it. What replaces it is in §3 below: the loop is
non-farmable *by construction* rather than by a clock, which is a stronger
guarantee than a cap and is the rule §9 already reached for leaderboards.

### §6's first piece holds, and understates itself

> "`Caches` … needs persistence past the session and a credit line."

The persistence half is not merely missing — its absence is an **open, unbounded
item faucet**. `Caches._onWorld` clears `this.sites` and `_stock`s every site
from scratch on `world:changed`. Step through a gateway and back and every cache
in the world you left is full again. The 210-second restock timer is decoration:
the real restock interval is however long it takes to walk through a portal
twice, and cache contents convert to credits through the marketplace under the
already-mapped `market` → `sell` reason.

So the credit line §5.2 asks for is not needed to make caches worth something.
Closing the portal-hop reset is worth more than any payout would be, and it is
the one change in this phase that moves the economy in the direction §5 measured.

---

## 1. What is built

Three things, in dependency order.

1. **`Caches` restock persists** past `world:changed` and past a reload, keyed by
   site **identity**, not by index.
2. **`Retention`** — the clock the game does not have. A daily task drawn from
   the player's incomplete records, a weekly that requires a different world, and
   a season that names a window and resets nothing.
3. **Two set kinds in `progressLedger.ts`** so both cross devices through the
   existing merge, which has no clock and never subtracts.

Everything else — HUD surface, leaderboards — is out of scope and stubbed at the
bus.

---

## 2. `Caches`: identity, and a timer that means something

### Site identity

A site is identified by `worldId/kind/x_z`, both coordinates rounded to whole
metres. Not by index into `this.sites`.

This is the `SpaceObjectives` / `Relics.foundIds` rule and it is here for the
same measured reason. `Relics.serialize` once wrote `{ found: { citadel: 17 } }`
and a reload marked the first seventeen sites in publication order — the tally
right, every marked thing wrong. Cache placement is seeded, but it is also
**probed against live physics**: `_findHigh` darts at a content box whose extent
depends on what the world built, and `_highAt` rejects candidates against real
colliders. Add a terrace beside a ledge and the dart budget spends differently
from that point on, so the site that was index 4 is now index 3. An index-keyed
emptied-set would mark the wrong cache.

Rounding to whole metres is deliberate: a site is a place, and two placements a
few centimetres apart from a float-precision difference are the same place.

### The emptied set

`_emptied: Map<siteId, readyAtEpochMs>`.

- `_onCollected` writes `id -> now + RESTOCK*1000` instead of only setting the
  in-memory `restock` counter.
- `_onWorld` consults it: a site whose deadline is still in the future is **not
  stocked**, and its live `restock` counter is set to the seconds remaining.
- `update` clears the entry when it restocks a site.
- Entries whose deadline has passed are dropped on load and on world entry, so
  the map cannot grow without bound. Its steady-state size is at most the number
  of sites in the worlds the player emptied in the last 210 seconds.

**Wall clock, not play time.** A cache is a feature of the map, and a player who
comes back tomorrow should find it stocked. The hazard of a wall clock —
a browser whose date can be moved — buys the player nothing here: moving the
clock forward restocks caches, which is exactly what waiting 210 seconds already
does for free. The clock is not load-bearing for anything that is bounded.

### `consign(worldId)`

Clears every emptied entry for one world, so its caches restock at once. This is
the daily's material reward and the only thing `Retention` asks of `Caches`.
Returns the number of sites released, so the caller can say nothing when there
was nothing to release.

---

## 3. `Retention`: the loop, and why it is not farmable

### The task is drawn from incomplete records

`Charters.records()` already produces, per world, a list of columns with `have`
and `need` and a `known` flag. The daily's pool is every `(worldId, column)`
where the world is known, the record incomplete, and `have < need`. So the task
always points at something that advances the objective, which is §6's
requirement and the reason it is drawn rather than authored.

An **authored** daily table would be the `CHARTER_DEEDS` problem without
`CHARTER_DEEDS`' justification: a list of tasks in a file, going stale the day a
world grows a mast. There is no table in this system.

### The target is derived, and stable across a reload

```
target = min(need, (floor(have / step) + 1) * step)
```

`step` is 3 for the daily and 8 for the weekly. This is the piece that makes the
task survive a reload without persisting anything: with `have` unchanged the
same target comes back, and a partially-done task does not reset. It advances
only when the previous target is met.

### It is non-farmable *by construction*, not by a clock

Brief 5.5 requires that a daily not be farmable. §6 proposed to buy that with a
server-side rate cap. The cap cannot be reached (§0), so the guarantee comes from
somewhere better:

> **A daily can only be completed as often as a record column advances, and every
> record column is an identity set capped by content.**

Move the browser clock forward a hundred days and a hundred day-keys become
claimable — and each one still requires three relic ids, three viewpoint ids or
three seams that the player does not already hold. There are a finite number of
those in the game. A clock-fiddler arrives sooner at a ceiling everyone shares.

That is §9's rule — *rank only on sets whose maximum is fixed by content, never
on totals or times* — applied to a reward instead of to a leaderboard, and it is
a stronger property than a rate cap because it does not depend on a clock at all.

The streak number itself is farmable by a clock, and is therefore **derived,
never persisted, never paid for and never rankable**. It is a number on the
player's own screen, which is the correct place for a number that cannot be
defended.

### Rewards

| | |
|---|---|
| **Progress** | The task *is* a record column. Completing it advances a charter. This is the whole reward and it is deliberate. |
| **A consignment** | `Caches.consign(worldId)` on a completed daily or weekly: the caches you have already emptied in that world restock at once. Items, not credits. |
| **The season record** | Which worlds were charted inside which window. A permanent, growing set. |
| **Credits** | **None.** See §0. |

### Nothing expires

`_done` and `_season` are grow-only sets of ids. A missed day is a day absent
from a set, never a deletion. `progressLedger` never subtracts and neither does
this. A retention loop that deletes progress teaches people to stop playing.

### Persistence: identity, not count

```js
serialize() { return { done: ['daily/2026-08-23', 'weekly/2026-W34'],
                       season: ['2026-Q3/medieval'] }; }
```

Two sets of ids. No streak, no counts, no totals — every one of those is
recomputed on read from the two sets, which is the rule `Charters.serialize`
writes down and the defect `Relics.serialize` used to have.

---

## 4. Cross-device

Two set kinds in `site/lib/progressLedger.ts`:

- `retention`, unscoped: the period ids (`daily/YYYY-MM-DD`, `weekly/YYYY-Www`).
- `season`, scoped by season id: the world ids charted in that window.

Both are unions of ids, which is what the ledger merges without consulting a
clock. `ProgressSync` unions the server's answer into the local set rather than
replacing it — the rule the `onboarding` block already follows, and for the same
reason: a phone that has done three days must not un-do the five this desktop did.

Signed out, all of it still works. §3 of the mission architecture requires that.

---

## 5. What this deliberately does not do

- **No credits.** §0.
- **No HUD.** `src/ui/**` is owned by another agent this cycle. `Retention`
  emits `retention:changed` with everything a panel would draw, and nothing
  listens yet. Recorded as an outstanding hook.
- **No leaderboard.** §9 permits ranking worlds charted; that is Phase 11's
  endpoint and another agent's file.
- **No cosmetic prize.** §5.3 wants set rewards the shop never lists. A season
  cosmetic is the natural home for that and it needs the shop separation done
  first; doing half of it here would put a reward in a catalogue that still
  sells it.
- **No world-boss weekly, no faction challenge, no arena run.** Brief 5.2 lists
  those. None of them exists as content, and a weekly pointing at a thing
  nothing emits is the `QuestSystem` verb audit again — 0 of 50 quests
  completable. An emitter first.
