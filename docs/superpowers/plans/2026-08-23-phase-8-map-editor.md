# Phase 8 implementation plan — `map-editor`

Design: `docs/superpowers/specs/2026-08-23-map-editor-design.md`.

File boundary for this branch: **`admin/**`, `site/**`, `src/systems/MapOverlay.js`, plus one
wiring line in `src/main.js` and one entry in `scripts/contract-check.mjs`.** No world file is
touched. `src/minigames/**`, `StationWorld.js`, `RaceWorld.js`, `DockWorld.js`,
`MedievalWorld.js` and `src/worlds/medieval/**` belong to other agents running right now.

Every step is red first, then green, then verified by removing the fix and watching only that
test fail.

## Step 1 — the entry schema (pure, no database)

`site/lib/mapOverlaySchema.ts` + `.test.ts`.

`normaliseOverlayEntries(raw)` → `{ entries, rejected }`. Rejects anything it cannot make sense
of rather than storing it: an unknown `kind`, a non-finite coordinate, a coordinate outside the
world bounds worlds actually use, a missing `target.name` on a move, a missing `source_key` on a
place, a duplicate `id`, more entries than the cap. Normalises ids, trims names, rounds
coordinates to millimetres, wraps `rotationY` into `[-π, π]`.

Red: every rejection case, and the round-trip that normalising twice changes nothing.

## Step 2 — storage

`site/lib/mapOverlay.ts` + `.test.ts` (integration, `POSTGRES_TEST_URL`, skips when absent).

`ensureMapOverlaySchema(db)` memoised as a promise; `readCurrentOverlay(db, worldId)`;
`listOverlayVersions(db, worldId)`; `saveOverlayVersion(db, {...})`; `revertOverlayTo(db, ...)`;
`recordWorldReport(db, ...)` / `readWorldReport(db, worldId)`.

World ids used by this suite are prefixed `test-overlay-` so no other suite can collide — the
same discipline as the reserved player ids (`...0001` creditLedger … `...0005` leaderboard).

Red: version starts at 1 and increments; concurrent saves cannot produce two version 2s;
revert copies forward rather than deleting; reading an unknown world gives version 0 and no
entries.

## Step 3 — the audit chain, shared with `admin/`

`site/lib/auditChain.ts` + `.test.ts`. Ports `sign`/`auditHash` and appends a chained row.
The test imports `admin/lib/hmac.ts` directly and asserts identical digests, so the two apps
cannot fork the chain silently.

## Step 4 — routes

- `site/app/api/admin/map/[world]/route.ts` — GET current + versions + catalogue; POST save or
  revert.
- `site/app/api/admin/map/report/route.ts` — POST the game's catalogue and apply-report.
- `site/app/api/game/map-overlay/route.ts` — GET for the game; session required; `admin` flag.

Red: `site/lib/mapAdminRoutes.test.ts` calls the real handlers with `@/lib/auth` and `@/lib/db`
mocked — no session → 403, signed-in non-allowlisted → 403, allowlisted → past the guard. And
`site/lib/adminRouteGuards.test.ts` walks every file under `site/app/api/admin/**` and asserts
each exported handler names `requireMarketplaceAdmin`.

## Step 5 — the game applier

`src/systems/MapOverlay.js` + `scripts/tests/map-overlay.test.mjs`. Injectable `fetch`, so the
tests drive it without a network. Subscribes to `world:changed`, applies, reverts on the way out,
reports back when the server said admin.

Red: move resolves by name and sets absolute position; box and mesh colliders inside the object's
prior AABB move with it; the heightfield does not; an unresolved name is reported, not thrown;
a placement calls `loot.spawn` persistent; an unresolvable `source_key` is reported; a malformed
document applies nothing and does not throw; leaving a world restores what was moved.

Plus a contract test asserting the kind and field names in `site/lib/mapOverlaySchema.ts` match
the game's constants — CRLF-normalised before anchoring.

## Step 6 — UI

`site/components/MapEditorPanel.tsx`, `site/app/admin/map/page.tsx`,
`admin/app/dashboard/map/page.tsx` + one nav entry in `admin/app/dashboard/layout.tsx`.

## Step 7 — gates

`npm test`, `node scripts/contract-check.mjs`, `npm run build`, `cd site && npm test`,
`npm run build:site-only`. Commit in the worktree. Do not push, do not merge.
