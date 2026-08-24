# Phase 8 — Backend map editor · `map-editor`

Brief 4.1.6. Admin-only: move fixed objects, place new items from marketplace assets, save,
reload, confirm in game. Non-admins cannot reach any of it.

---

## 1. The constraint that shapes everything

> "Worlds are procedural code, some very large (`MedievalWorld.js` is 12,945 lines). An editor
> that rewrote world source would collide head-on with Phase 9's art passes. It should edit a
> **placement overlay** — a saved, versioned set of placed and moved instances applied after the
> world builds — keeping the editor and the art pass on separate surfaces and making every
> change revertible."

So: **no world file is written, ever.** Not by the editor, not by a migration, not by a script.
A Phase 9 art agent is editing `MedievalWorld.js` while this is being built, which is exactly the
collision the constraint exists to prevent.

The overlay is applied *after* `world:changed`, on top of whatever the world just built. If the
art pass moves a barn, the overlay's move of that barn either still resolves (same name) or is
reported unresolved — it never corrupts, and it is never load-bearing for the world to work.

---

## 2. Authorisation is the primary requirement

Phase 0 of this roadmap existed because **nine admin pages were unguarded in production** and the
marketplace admin allowlist defaulted to "allow everybody". This phase adds a surface that can
move buildings and place items in a live world. It is treated as an auth feature that happens to
have an editor attached, not an editor that happens to need auth.

Three layers, each of which alone denies:

1. **Every route handler under `site/app/api/admin/map/**` opens with
   `requireMarketplaceAdmin()` and returns 403 on null.** Same gate as the marketplace catalogue,
   which is the surface that already sets the buy/sell prices of the economy — the map editor is
   not a lower bar than that.
2. **The page** `site/app/admin/map` renders a locked banner, not the editor, for a non-admin.
   The panel it would render fetches from the same guarded routes anyway, so even a leaked page
   render yields nothing.
3. **The game's read endpoint** `/api/game/map-overlay` requires a signed-in session (the game is
   paywalled), and returns `admin: false` for everyone else. The client only *reports* its world
   catalogue back when the server said `admin: true` — and the report endpoint re-checks, because
   a client-side flag is a hint, never a permission.

The allowlist itself (`site/lib/adminAllowlist.ts`) fails closed on an unconfigured deployment,
reads the environment on every call, and is already pinned by 10 tests. This phase does not
weaken it and does not add a second way in.

**How it is proved.** `site/lib/mapAdminRoutes.test.ts` mocks `@/lib/auth` and `@/lib/db` and
calls the real exported handlers of every map route with (a) no session, (b) a signed-in user who
is not on the allowlist, (c) a signed-in user who is. Cases (a) and (b) must be 403 and must not
touch the database; (c) must get past the guard. A second test walks **every** file under
`site/app/api/admin/**` and asserts each exported HTTP handler names the guard — the static net
that would have caught the nine unguarded pages, extended to routes added after this phase.

---

## 3. The overlay

### 3.1 Storage: append-only versions

```
map_overlays(id, world_id, version, entries JSONB, author, note, created_at)
  UNIQUE (world_id, version)
```

Current overlay = highest version for that world. **Nothing is ever updated or deleted.** Saving
writes version N+1. Reverting to version K writes version N+1 whose entries are a *copy* of K's,
noting where they came from. That is what "revertible" has to mean if the audit chain is to be
worth anything: the record of what an admin did cannot be edited away by doing it again.

Conventions taken from `site/lib/creditLedger.ts`, each for its recorded reason:

- Additive `CREATE TABLE IF NOT EXISTS` only — no migration can strand a running deployment.
- `(db: Db, ...)` signatures so the route owns the connection and can share a transaction.
- The ensure is memoised as a **promise**, not a boolean: a boolean set before the awaited work
  finishes lets a second concurrent caller past a half-built schema.
- `world_id` is TEXT, and there is no foreign key to anything. Worlds are code, not rows.

### 3.2 Entry schema

Two kinds. Both carry a stable client-minted `id` so the UI can edit one without disturbing the
rest, and so the game can report per-entry outcomes.

```ts
{ kind: 'move',  id, target: { name }, position?: {x,y,z}, rotationY?, hidden? }
{ kind: 'place', id, item: { source_key, name }, position: {x,y,z}, rotationY?, quantity? }
```

`target.name` is the `Object3D.name` inside the world's group. It is the only identity a
procedural world offers that survives an art pass, and it is not guaranteed unique or even
present — so:

- The game resolves by name; **the first match wins and the count of matches is reported**.
- A `move` that resolves nothing is skipped and reported `unresolved`. It is never an error, and
  it never stops the rest of the overlay applying. An art pass that renames a mesh degrades to
  "that one move stopped happening", which the admin sees in the editor.

`position` on a `move` is **absolute world space, not a delta.** A delta compounds every time the
overlay is applied — which is once per world load — unless the applier is careful, and "careful"
is not a property you can see in a diff. Absolute is idempotent by construction.

### 3.3 What a move actually moves

A world's visual objects and its colliders are *separate structures*: `Physics` stores baked
world-space geometry (`matrix` for boxes, a world-space `positions` array for meshes) with no
back-reference to the `Object3D` it came from. Moving a mesh and nothing else leaves an invisible
wall where the building used to be. That is the "gate that measures something the game does not
do" failure in its most literal form — a move that looks right in a screenshot and is wrong to
walk into.

So the applier moves the colliders too:

- Compute the object's world AABB **before** moving it.
- Every non-heightfield collider whose `center` lies inside that box moves by the same delta,
  via `physics.remove()` → translated copy → `physics.add()`. Both are public API and
  `remove()` shares `_gridRange` with insertion, so the broadphase stays consistent.
- **Heightfields are never moved.** Terrain is the ground; translating it is never what an admin
  meant by "move that crate", and it would take the whole world's floor with it.
- The number of colliders that came along is reported per entry, because "0 colliders moved" on
  a building is the signal that the heuristic missed and the admin needs to know.

Centre-inside-AABB is a heuristic and is documented as one. It is right for the props and
buildings an admin will move, and its failure mode is under-moving (an invisible wall stays),
never over-moving the world.

### 3.4 What a placement places

`Loot.spawn(position, contents, { persistent: true, snap: false })` — the exact mechanism
`Interiors` already uses for authored world caches, which is what a placed marketplace item is.
`persistent` exempts it from the fade timer and from recycling, so it is still there when the
player comes back, and `snap:false` honours the authored height.

`item.source_key` is resolved to an inventory item id by the **same** resolution the marketplace
purchase path uses (exact key first, then the key with its trailing `:<world>` stripped, then a
direct `ITEMS` lookup). An unresolvable key places nothing and is reported `unresolved` — a
placement that silently grants nothing is worse than one that visibly did not happen.

### 3.5 The loop closes: the game reports back

After applying, the client POSTs to `/api/admin/map/report` — **only if the server said it is an
admin, and the server re-checks** — with the world's named-object catalogue and a per-entry
outcome. Two things fall out:

- The editor's object picker offers **real object names from the running game** instead of asking
  an admin to guess at the internals of a 12,945-line file.
- The editor shows what actually happened: version applied, entries applied, colliders moved,
  and every unresolved entry by name. This is the acceptance criterion — "saves, reloads and sees
  it in game" — turned into something the editor can display rather than something a human has to
  swear to.

---

## 4. Where the UI lives, and why not in `admin/`

`admin/` is the Next app with the HMAC-chained `audit_log`. `site/` is where the game, the
marketplace catalogue, the credit ledger, the player session and the vitest gate live.

The editor goes in `site/app/admin/map`, and `admin/`'s dashboard gets a nav entry that links to
it — **which is the convention this repo already chose**: `admin/app/dashboard/marketplace/page.tsx`
is a guarded page whose entire content is a link to the site's `/admin/marketplace`, configured
by `NEXT_PUBLIC_MARKETPLACE_ADMIN_URL`. The map editor is the same shape for the same reasons: it
needs the marketplace catalogue, the player session and same-origin access to the game.

The audit trail still lands in the shared `audit_log`. `site/lib/auditChain.ts` appends to it
with the identical HMAC construction, and `site/lib/auditChain.test.ts` imports
`admin/lib/hmac.ts` directly and asserts the two produce byte-identical digests over the same
inputs — so a change to either side that would break `verifyAuditChain()` fails a test instead of
silently forking the chain.

Every save and every revert writes `map.overlay.save` / `map.overlay.revert` against
`resource: world:<id>` with the version and entry count in `detail`.

---

## 5. Non-goals, stated so they are not mistaken for oversights

- **No 3D editing viewport.** The editor is a form over an overlay document. A gizmo in a Next
  page would need the whole world built twice, in two engines, and would be the second place
  world geometry lives — which is the thing this phase exists to avoid.
- **No editing of world source, quests, NPCs or terrain.** Out of scope by construction.
- **No per-player overlays.** One overlay per world, global. Per-owner variants are Phase 7's
  problem and its rankable-activity rule has to come first.
- **No collider authoring.** A placed item is a pickup; it does not add collision.

---

## 6. Gates

| Gate | Before | After |
|---|---|---|
| `npm test` | 2804 | 2804 + new `scripts/tests/map-overlay.test.mjs` |
| `node scripts/contract-check.mjs` | 128/128 | 129/129 (`src/systems/MapOverlay.js` registered) |
| `npm run build` | green | green |
| `cd site && npm test` | 214 | 214 + overlay schema, storage, audit-chain, authorisation |
| `npm run build:site-only` | green | green |

Any test that scrapes source normalises CRLF (`.replace(/\r\n/g, '\n')`) before anchoring. That
defect has been paid for three times in this repo.
