# Map editor stage 2 — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

Spec: `docs/superpowers/specs/2026-08-27-map-editor-graphical-design.md` (§4.1, §5, §6.3, §6.4, §7, §9, §10, §11, §12 item 2; where §14 disagrees with §1–§13, §14 wins). Understanding: `E:/markc/gametestai/gametestai/.probe/map-editor-stage2/understand.json` (owner decisions A–K in it are FINAL). Stage 1's record: the tail of `docs/superpowers/plans/2026-08-27-map-editor-stage1.md`.

**Goal:** Overlay schema v2 with a first-class `remove` that hides a named object AND drops its colliders by containment; `hidden` migrated on read; the overlay reaches `WorldManager._runBuild` through a provider so every world records `builtVersion`, reported beside `appliedVersion`, stored in a third `map_world_reports` column and shown in the editor; `planGrid` floor→ceil.

**Architecture:** Game side, the applier gains `_applyRemove` (containment against `Physics.colliderAabb`, 0.10 m tolerance, heightfield and `userData` exclusion, a 200-collider cap) and an overlay cache with `prefetch`/`lookup`; `_runBuild` awaits `ctx.overlayProvider` between `report(0)` and `ensureBuilt` with an 8 s ceiling behind the gate and 1500 ms otherwise, and no await at all when no provider is on ctx. Site side, `mapOverlaySchema.ts` becomes v2 (`Target = {name}|{id}`, `RemoveEntry`, `hidden`→`remove` on read, 1:1 with raw indices), `mapConflicts.ts` makes a removed target occupy nothing, the editor gets [Remove]/REMOVE rows/struck-through marks, and `built_version` is a third `ALTER TABLE … ADD COLUMN IF NOT EXISTS`. `LAYOUT_SCHEMA` does not move and the report carries no `schema`.

**Tech Stack:** Three.js game (ES modules, `node --test` + `node:assert/strict`); Next.js 16 + React 19 + TS 5.7 site (`vitest`, `environment: 'node'`, `lib/**/*.test.ts` only); Postgres via the existing `Db` helper; `scripts/frame-gaps.mjs` and `scripts/world-shot.mjs` for evidence.

**Worktree:** execute in a dedicated worktree off `main` (superpowers:using-git-worktrees). Node modules are junctioned — see the memory note on stale worktrees before creating one.

---

## Conventions every task follows

- **Tests first, red then green.** Node side: `node --test scripts/tests/<name>.test.mjs`; site: `cd site && npx vitest run lib/<name>.test.ts`. Each test file opens with a header comment stating THE CLAIM and why the test is not a stub (house style, see `scripts/tests/citadel-caves.test.mjs:19-33`). Assert against real `Physics`/real route handlers, never a builder's return value.
- **Never import another `*.test.mjs`** from a test — it registers that file's tests in your process.
- **Site tests are `*.test.ts` only** — `.test.tsx` is silently skipped and `passWithNoTests` hides it. Anything that touches the DOM lives in a component that is not unit-tested; every decision it makes is delegated to a pure module that is.
- **Commit style:** sentence-case plain English describing the visible effect, no type prefix; body is why-prose; trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and nothing else. After any game-side change that must ship to the site, a separate `Bundle: …` commit re-copies the built game (`cd site && node scripts/bundle-game.mjs`, then `git add site/public/game`).
- **Gates before a chunk is called done** (run the FULL command, read the exit code):
  - game: `npm test` (root), `node scripts/contract-check.mjs`, `npx vite build`
  - site: `cd site && npx tsc --noEmit`, `cd site && npx vitest run`, `cd site && npm run build:site-only`
  - perf (chunk 5): the cold frame-gaps after-run compared with the base taken in chunk 3's first task, within the noise floor
- **Commit in the worktree. Do not push, do not merge.**
- **Work in the executor's worktree:** `E:/markc/gametestai/wt-map-stage2`, branch `map-editor-stage2`, branched from `main@1e020b9`. Every command in this plan runs from that directory; `cd site` means `E:/markc/gametestai/wt-map-stage2/site`.
- **Record files live in the MAIN checkout's `E:/markc/gametestai/gametestai/.probe/map-editor-stage2/`.** `E:/markc/gametestai/gametestai/.probe/` is gitignored and PER WORKING TREE — the worktree has none, and nothing is copied into it — so every `E:/markc/gametestai/gametestai/.probe/…` path in this plan is written absolute to the main checkout: `counts.md` (baseline already recorded; append the count after every commit), `perf.md` (frame-gaps/world-shot numbers), `db-run.txt` (the local Postgres run), `progress.md`. The frame-gaps and world-shot `--out` directories go there too.
- **Every line number in this plan was read against `main@1e020b9`** — `ec1d28b` plus the four hotfix commits. Against `ec1d28b` the two hotfixes shift `src/systems/MapOverlay.js` by ~+8 lines in the constructor, ~+13 in `_onWorldChanged` and ~+35 after `_moveColliders`; `scripts/tests/map-overlay.test.mjs` by ~+170 (its word-pin test is now at `:666-679`). Anchors are given by SYMBOL first; a line is a hint, not a contract. Re-read the file before every edit.

## Starting point (read before Task 1.1)

- [ ] You are in `E:/markc/gametestai/wt-map-stage2` on `map-editor-stage2`. The orchestrator committed this plan on `main` and fast-forwarded this branch onto that commit, so `git log --oneline -6` must show, top to bottom:
  `<hash> Plan: map editor stage 2, five reviewed chunks` (HEAD)
  `1e020b9 Bundle: the visit-numbered late-document guard`
  `9b16768 A late overlay document is dropped by visit number, not by world identity, so a return visit cannot be applied on top of`
  `cfe1320 Bundle: the map overlay's collider leak and late-document fixes`
  `8afa2a2 The map overlay no longer leaves a moved collider in the next world, or applies a late document to the world you left`
  `ec1d28b The env example names ADMIN_EMAILS, which the map editor and its harness require`
  and `git ls-files docs/superpowers/plans/2026-08-28-map-editor-stage2.md` must print the path: the plan is TRACKED here, and Task 5.3 appends its execution record to this file and commits it on this branch. If either check fails, STOP and ask the orchestrator; do not copy the plan in, and do not branch from `map-overlay-leak-hotfix` yourself.
- [ ] Read BOTH hotfixes: `git show 8afa2a2` and `git show 9b16768`. Together they add `Physics.has(collider)` (`src/physics/Physics.js`, after `add`; +1 test in `scripts/tests/physics-remove.test.mjs`), `MapOverlay._detach(collider)` (returns `physics.remove(collider) === true` — "re-add only what `_activate` did not already re-add"), the rig helpers `solid(physics, world)` / `activate(rig, world, { settle })` / `registeredAs(physics, world)` in `scripts/tests/map-overlay.test.mjs`, and the late-document guard as it stands NOW: a per-visit counter `this._visit` (`MapOverlay.js:170`), bumped as the first line of `_restore()` (`:257`), captured `const visit = this._visit` before the first await in `_onWorldChanged` (`:203`), compared `if (visit !== this._visit) return;` after `await this._read(id)` (`:215`) and `visit === this._visit` on the `_startSampling` line (`:225`). The world object is NOT the token — a return visit A→B→A is the same cached object (9b16768's message). Nothing in this plan edits that guard; Task 3.3's cache write in `_read` runs on the same late continuation the guard drops, which is why that write is version-monotonic. Chunk 1 builds on `has`, `_detach` and the rig helpers. Neither hotfix adds a contract-check entry for Physics.js.
- [ ] `E:/markc/gametestai/gametestai/.probe/map-editor-stage2/counts.md` already records the baseline at `1e020b9`: game `npm test` **3503** (call it **N**; if you read a different number, write what you read and use that), contract-check `130/130`, site vitest `839` — and a NOTE that a full site run on this machine can show ~61 failures in `lib/contentMode.test.ts` / `lib/ownerServerFlow.test.ts` (`fixture server refused: quota`, `no_entitlement`) whenever something else is using the shared `POSTGRES_TEST_URL` database. Re-run `cd site && npx vitest run 2>&1 | tail -6` now; if that failure set appears, record it in `counts.md` as the baseline set. Every site gate below means: **the map-editor files (`lib/map*.test.ts`) all pass and the failure set is unchanged from baseline**; the `Tests <n> passed` figures are what a clean run prints. `site/.env.test.local` exists here, so the DB-gated `suite('mapOverlay (integration)')` block (17 `it`s) RUNS on this machine and is SKIPPED in CI — the CI count is 839 − 17 = 822 at baseline.
- [ ] `git status --short` must be clean.

## File structure

| File | Responsibility in stage 2 | Chunk |
|---|---|---|
| `src/physics/Physics.js` (modify) | `colliderAabb(collider, out)` — the world AABB the remove sweep contains against (box `|R|·h`, sphere, mesh `bounds`, heightfield footprint) | 1 |
| `src/systems/MapOverlay.js` (modify) | `_applyRemove`/`_collidersInside` (containment ± 0.10 m, heightfield + `userData` exclusion, cap 200 → `span`, undo restores `visible` only); `hidden:true` dispatched as a remove for one release; `OVERLAY_SCHEMA = 2` + log-once on a newer document; `_cache`/`lookup`/`prefetch`; `builtVersion` on the report and both POSTs; `{id}` reasons `pending-rebuild`/`id` | 1, 2, 3 |
| `scripts/tests/physics-collider-aabb.test.mjs` (**new**) | pins the AABB per collider type | 1 |
| `scripts/tests/map-overlay.test.mjs` (modify) | remove cases in the real-Physics rig; word pin tightened (decision J); cache cases; `{id}` cases | 1, 2, 3 |
| `scripts/contract-check.mjs` (modify) | Physics.js entry (chunk 1); MapOverlay methods += `prefetch`,`lookup`; World.js entry `fields: ['builtVersion']`; WorldManager methods += `_overlayVersion` | 1, 3 |
| `src/worlds/World.js` (modify) | `this.builtVersion = 0` declared; reset in `dispose()` | 3 |
| `src/worlds/WorldManager.js` (modify) | `_overlayVersion(world)` awaited in `_runBuild` between `report(0)` and `ensureBuilt`; absent-provider short-circuit; `OVERLAY_GATE_MS = 8000`, `OVERLAY_BACKGROUND_MS = 1500`; log once per world | 3 |
| `src/main.js` (modify, inside `boot()` only) | `worldManager.ctx.overlayProvider` gated on `accountStatePromise`; `mapOverlay.prefetch(startWorld)` before the entry build; the ctor line at `:314` and the `:1294` prefetch line byte-identical | 3 |
| `scripts/tests/map-overlay-provider.test.mjs` (**new**) | the build path through the REAL `WorldManager`: absent/resolved/rejected/timed-out/gated/portal-forced/volatile/WorldPrefetch cases; rAF count; textual pins for main.js and the constants | 3 |
| `scripts/tests/map-overlay-layout.test.mjs` (modify) | `builtVersion` on BOTH POSTs | 3 |
| `CONTRACTS.md` (modify) | `map-overlay:applied` payload += `builtVersion`; a provider-contract paragraph under the event table (it has no table a row could go in) | 3 |
| `site/lib/mapOverlaySchema.ts` (modify) | `MAP_OVERLAY_SCHEMA = 2`; `Target`, `RemoveEntry`, `MoveEntry.position: Vec3`; `readTarget` (`{id}` format ≤128); `hidden`→`remove` on read (decision A); `targetName`/`targetLabel` | 2 |
| `site/lib/mapOverlaySchema.test.ts`, `site/lib/mapOverlayRoundTrip.test.ts` (modify) | v2 cases; round-trip flipped to a remove through the real applier | 2 |
| `site/lib/mapOverlay.test.ts` (modify) | revert-writes-v2 proof on `fakeDb` (gap 7); `built_version` DDL/INSERT pins; integration column check | 2, 4 |
| `site/lib/mapConflicts.ts` (+ test) | removed occupies nothing; `lastAction` over move AND remove; cross-kind `duplicate-target`; `{id}`: bounds only | 2 |
| `site/lib/mapEditorState.ts` (+ test) | `PendingRow.kind` += `remove`; `actionEntryFor`, `removeFor`; `MarkKind` += `removed`, `MapMark.hidden` deleted; `unresolvedText`, `versionStatus` | 2, 4 |
| `site/components/MapEditorPanel.tsx`, `MapSelectionPanel.tsx`, `MapPendingList.tsx`, `MapCanvas.tsx`, `mapEditorStyles.ts` (modify) | Hide checkbox deleted; [Remove]; REMOVE row colour; struck-through mark, no drag; report card `Built version` line, two "behind" states, `pending-rebuild` label, `colliders: 0` warning | 2, 4 |
| `site/lib/mapOverlay.ts` (modify) | third ALTER `built_version`; `WorldReport.builtVersion`; INSERT `$8` + `SET built_version = EXCLUDED.built_version` (plain replace); `readWorldReport` | 4 |
| `site/app/api/admin/map/report/route.ts`, `site/app/api/admin/map/[world]/route.ts` (modify) | forward `builtVersion`; sixth field on the type-pinned GET literal | 4 |
| `site/app/api/game/map-overlay/route.ts` (unchanged) | the game GET already serves `schema: MAP_OVERLAY_SCHEMA` over migrated entries (gap 2); pinned in `mapAdminRoutes.test.ts`'s existing `GET /api/game/map-overlay` describe | 4 |
| `site/lib/mapAdminRoutes.test.ts` (modify) | explicit `builtVersion` assertions; six-field GET literal; the game GET's schema pin and its 503 | 4 |
| `site/scripts/map-editor-e2e.mjs` (modify) | seed carries `builtVersion: 0`; optional remove step | 4 |
| `src/systems/GroundSampler.js` + `scripts/tests/ground-sampler.test.mjs` (modify) | `planGrid` floor→ceil (header-carried nx/nz; no `LAYOUT_SCHEMA` bump) | 5 |
| spec §14, memory note | the stage-2 as-built block | 5 |

## Shared interfaces (every chunk must match these exactly)

### Overlay document v2 (`site/lib/mapOverlaySchema.ts`; the game reads the same shape)

```ts
export const MAP_OVERLAY_SCHEMA = 2;
export type Target = { name: string } | { id: string };          // {id}: `family@x,z[#n]`, family may be `ns:family`, ≤ 128 chars
export interface MoveEntry   { kind: 'move';   id: string; target: Target; position: Vec3; rotationY?: number }
export interface RemoveEntry { kind: 'remove'; id: string; target: Target }
export type OverlayEntry = MoveEntry | RemoveEntry | PlaceEntry;
export type RejectReason = 'kind' | 'target' | 'item' | 'position' | 'duplicate' | 'overflow';   // unchanged
export function targetName(t: Target): string | null;    // the name, or null for an {id}
export function targetLabel(t: Target): string;          // name or id, for rows and titles
```
Migration on read (decision A): a v1 `move` carrying `hidden` (truthy) becomes `{ kind: 'remove', id, target }` — its `position` and `rotationY` are DISCARDED; one raw entry → one entry or one reject, so `rejected[].index` stays a raw index. A `move` with a null/absent position rejects with `position`.

### Game applier reasons (`src/systems/MapOverlay.js`, `unresolved[].reason`)
`name` (no object of that name) · `span` (a `{name}` remove would drop more than 200 colliders; nothing hidden) · `pending-rebuild` (an `{id}` entry when `document.version > world.builtVersion`) · `id` (an `{id}` entry the build already saw — nothing resolves ids until stage 3) · `error` · `item` · `no-loot` · `position` · `pool` (unchanged).
`applied[].colliders` on a `{name}` remove is the number dropped; 0 means "hidden, but nothing dropped — it may still block" and the editor warns.

### Overlay provider (`src/worlds/WorldManager.js` ↔ `src/main.js`)
```js
worldManager.ctx.overlayProvider = (worldId) => Promise<{ version: number, entries: [], admin: boolean } | null>;
// _runBuild: world.builtVersion = await this._overlayVersion(world)  — between `await report(0, …)` and `await world.ensureBuilt(report)`
// no provider on ctx → 0, no await, no timer.  engine.running → race 1500 ms (OVERLAY_BACKGROUND_MS); else race 8000 ms (OVERLAY_GATE_MS).
// failure/timeout → 0, console.warn once per world id: `[WorldManager] overlay unavailable for "<id>": <why>; building without it`
```
`World.builtVersion` is declared `0` in the constructor, reset to `0` by `dispose()`, assigned on EVERY `_runBuild` (so a volatile rebuild refreshes it).

### Report body (`POST /api/admin/map/report`, both POSTs of a visit)
```
{ world, appliedVersion, builtVersion, objects, applied, unresolved, layoutSchema: 1, bounds?, shapes, ground? }
```
NO `schema` field. `LAYOUT_SCHEMA` stays 1. `builtVersion` is clamped `max(0, floor(Number(x) || 0))` by the store, replaced on every report (NOT under the layout CASE), returned by `readWorldReport`, forwarded by the route, and is the sixth field of the admin GET's `report` literal. Bus event `map-overlay:applied` gains `builtVersion`.

### Editor (`site/lib/mapEditorState.ts`)
```ts
export interface PendingRow { key; kind: 'move' | 'remove' | 'place'; label; summary; level; conflicts }   // remove: summary 'removed'
export function actionEntryFor(entries: Draft[], name: string): (Draft & (MoveEntry | RemoveEntry)) | undefined;  // LAST move-or-remove of a {name}
export function removeFor(entries: Draft[], name: string, mint: () => string): Draft[];   // one remove for the name; any move/remove of it replaced
export type MarkKind = 'object' | 'origin' | 'moved' | 'place' | 'free' | 'removed';       // `MapMark.hidden` is gone
export function unresolvedText(reason: string): string;   // 'pending-rebuild' → 'applies on next world load', 'span' → …, else the reason
export function versionStatus(applied: number, built: number, saved: number): { applied: string; built: string };
```

## Owner decisions and the ten critique gaps — where each lands

| Decision / gap | Resolution | Task |
|---|---|---|
| A (hidden-with-position) | every v1 hidden move → `remove`, position discarded; production had 0 rows | 2.1 |
| B (containment) | 0.10 m per axis; exclude `type === 'heightfield'` and `userData != null`; cap 200 → `span`; straddling trimesh chunk stays; editor warns on `colliders: 0` | 1.2, 1.3, 2.6 |
| C (column) | `built_version INTEGER NOT NULL DEFAULT 0`, third ALTER, clamp-never-refuse; local Postgres run is a manual gate | 4.1, 4.6 |
| D (`{id}`) | normaliser accepts; applier reports `pending-rebuild` when `document.version > world.builtVersion`, else `id`; `unresolved-target` deferred | 2.1, 3.5 |
| E (hotfix first) | done on main; remove undo re-registers nothing (`_activate` owns registration) | 1.2 |
| F (move + remove of one name) | last in document order wins; both warn `duplicate-target` | 2.2 |
| G (ceilings, signed-in) | 8000 ms behind the gate, 1500 ms background; provider gated on `accountStatePromise` | 3.2, 3.4 |
| H (evidence) | cold base BEFORE chunk 3 code, after-run in chunk 5, chain-warmed `--gate` | 3.0, 5.1 |
| I (scope) | + `planGrid` ceil; trimesh undersides / deck-edge Y / cdp.mjs / CI flag OUT | 5.2 |
| J (pins) | code-shaped patterns on comment-stripped source | 2.5 |
| K | `site/.env.example` already committed (`ec1d28b`) | — |
| Gap 1 deploy-order window | game keeps reading `hidden:true` as a remove for one release; game bundle ships INSIDE the site deploy (`bundle-game.mjs`), so the only window is a browser still running the previous bundle: removes are skipped until reload (R6). Order if ever split: game first | 1.2, 5.3 |
| Gap 2 game GET schema | serves the CONSTANT over `rowEntries`-migrated entries (the served entries are always the constant's shape); `readCurrentOverlay.schema` keeps the row's value as history; pinned by a new route test. A 401 (`!res.ok`) is silent in `_read`; only a thrown fetch warns | 4.4 |
| Gap 3 portal-forced builds | `_activate → build(id)` with `engine.running` gets the 1500 ms rule; the cache makes it 0 ms for any world already looked up (the maze after its first entry); tested through `activate()` | 3.2, 3.6 |
| Gap 4 WorldPrefetch/prepareWorld | the same 1500 ms rule; a stalled provider delays gateway readiness ≤ 1.5 s per world — tested through `WorldPrefetch.request`; `world-prefetch.test.mjs:176` pin re-run | 3.6 |
| Gap 5 signed-in signal | `accountStatePromise` (src/main.js:1154, the `/api/game/session` fetch started at module load); NOT `hydrateAccountSession()` (:1256, runs AFTER the entry build). The provider awaits it; `prefetch(startWorld)` is issued from its `.then` before `:1247` | 3.4 |
| Gap 6 fetch count | one cached lookup per BUILD plus one `no-store` `_read` per ENTRY (which refreshes the cache); `map-overlay.test.mjs` "one GET per entry" stands (rig has no provider); §14 records "one fetch per build plus one per entry" | 3.3, 5.3 |
| Gap 7 revert is a write | `revertOverlayTo` re-saves through `saveOverlayVersion`: a v1 hidden version reverts to a v2 document with `remove` entries — `fakeDb` INSERT pin | 2.1 |
| Gap 8 `solid`/`layer` | not consulted: anything untagged inside the box belongs to the object (mirrors `_moveColliders`); world-level volumes are excluded by `userData`, not by solidity | 1.2 |
| Gap 9 userData inventory | recorded in the test header and §14: PlanetWorld `:1165` `{planetFloor}`, `:1687`/`:1694` `{planetLiquidBarrier, barrierCap}`, `:1800` `{planetEdgeWall}`; Portals.js `:1140`/`:1159`/`:1174` `{portal}`; `src/ships/Piloting.js:2961` `{kind:'ship', shipId}`; `World.addSolid` (World.js:201-208, forward at `:206`) and SportsWorld's `_solid(mesh, opts)` (`SportsWorld.js:1858-1862`, forward at `:1860`) forward `opts.userData` but NO call site supplies one (`grep -rn "addSolid(.*userData\|_solid(.*userData" src` → 0) | 1.3 |
| Gap 10 citations | every line in this plan re-read; the map's wrong ones are not carried (`ShipModel.js:213-220` does not compute `|R|·h`; the spec's add* counts match the tree and are NOT "corrected") | — |

---

## Chunk 1: Game — the applier's `remove`

Spec §5, §6.3, decision B. Every commit in this chunk is made with `npm test`, `node scripts/contract-check.mjs` and `npx vite build` green (each task's last step names all three). Ends with a `Bundle:` commit.

**Facts you build on (verified).** `Physics.remove(c)` returns `false` when `c` is not registered (`src/physics/Physics.js`, `remove`, `if (at === undefined) return false;`). `Physics.has(c)` is the hotfix's O(1) membership question. `WorldManager._activate` does `this.physics.clear()` and re-adds `world.colliders` BEFORE it emits `world:changed` (`src/worlds/WorldManager.js:390-396`, `:438`), and returns early for the world that is already active (`:344`) — so a real `world:changed` is always a DIFFERENT world's, and every collider a world tracked is registered again by `_activate` on re-entry whatever this system removed. `_moveColliders` skips `type === 'heightfield'` and preserves `layer`/`solid`/`userData` (`src/systems/MapOverlay.js`, the `_moveColliders` doc block). `THREE.Box3.setFromObject` is the union of every descendant's box. Authored collider padding: medieval shells `+0.08` on X/Z (`src/worlds/MedievalWorld.js:7646-7647`); the spec's 5 cm finds 0 there, so the tolerance is 0.10 m.

### Task 1.1: `Physics.colliderAabb` and its contract entry

**Files:**
- Create: `scripts/tests/physics-collider-aabb.test.mjs`
- Modify: `src/physics/Physics.js` (after `has`, which the hotfix put after `add`)
- Modify: `scripts/contract-check.mjs` (after the `src/systems/Unstuck.js` entry, `:957`)

- [ ] **Step 1: Write the failing test**

```js
// scripts/tests/physics-collider-aabb.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Physics, Collider } from '../../src/physics/Physics.js';

/**
 * THE WORLD AABB OF A COLLIDER, PER TYPE.
 *
 * THE CLAIM: `Physics.colliderAabb` answers the axis-aligned world box of a
 * box (centre ± |R|·h, the expansion Unstuck._solidIndex inlines), a sphere
 * (centre ± r), a mesh chunk (its `bounds`) and a heightfield (its footprint
 * from minY to maxY), into a caller's Box3.
 *
 * Not a stub: every collider is registered through the real add* path and
 * the rotated case is checked against √2, which a centre-only answer or an
 * unrotated half-extent answer both get wrong.
 */

const r3 = (a) => a.map((n) => Math.round(n * 1000) / 1000);

test('an axis-aligned box is centre ± half-extents', () => {
  const p = new Physics(null);
  const b = p.colliderAabb(p.addBox(10, 2, -5, 1, 2, 3));
  assert.deepEqual(r3(b.min.toArray()), [9, 0, -8]);
  assert.deepEqual(r3(b.max.toArray()), [11, 4, -2]);
});

test('a unit box rotated 45° about Y widens to √2 on x and z and keeps y', () => {
  const p = new Physics(null);
  const c = p.addRotatedBox(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 1, 1), Math.PI / 4);
  const b = p.colliderAabb(c);
  assert.deepEqual(r3(b.min.toArray()), r3([-Math.SQRT2, -1, -Math.SQRT2]));
  assert.deepEqual(r3(b.max.toArray()), r3([Math.SQRT2, 1, Math.SQRT2]));
});

test('a sphere is centre ± radius', () => {
  const p = new Physics(null);
  const b = p.colliderAabb(p.add(new Collider('sphere', { center: new THREE.Vector3(1, 2, 3), radius: 0.5 })));
  assert.deepEqual(r3(b.min.toArray()), [0.5, 1.5, 2.5]);
  assert.deepEqual(r3(b.max.toArray()), [1.5, 2.5, 3.5]);
});

test('a mesh chunk is its bounds; a heightfield is its footprint between minY and maxY', () => {
  const p = new Physics(null);
  const mesh = p.colliderAabb(p.addTriangleSoup(new Float32Array([0, 0, 0, 2, 0, 0, 0, 3, 0])));
  assert.deepEqual(r3(mesh.min.toArray()), [0, 0, 0]);
  assert.deepEqual(r3(mesh.max.toArray()), [2, 3, 0]);
  const field = p.colliderAabb(p.addHeightfield({ heights: new Float32Array(4).fill(1), nx: 2, nz: 2, originX: 5, originZ: 7, stepX: 3 }));
  assert.deepEqual(r3(field.min.toArray()), [5, 1, 7]);
  assert.deepEqual(r3(field.max.toArray()), [8, 1, 10]);
});

test('writes into the box it is given and returns it; nothing gives an empty box', () => {
  const p = new Physics(null);
  const out = new THREE.Box3();
  assert.equal(p.colliderAabb(p.addBox(0, 0, 0, 1, 1, 1), out), out);
  assert.equal(out.isEmpty(), false);
  assert.equal(p.colliderAabb(null, out), out);
  assert.equal(out.isEmpty(), true);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test scripts/tests/physics-collider-aabb.test.mjs`
Expected: 5 failing, `TypeError: p.colliderAabb is not a function`.

- [ ] **Step 3: Implement `colliderAabb`** in `src/physics/Physics.js`, directly after the hotfix's `has(collider)` method:

```js
  /**
   * The world-space AABB of a collider, written into `out`.
   *
   * Nothing on a collider carried one before this except `mesh.bounds`: a box
   * is an OBB - half-extents plus a matrix - with only a bounding SPHERE for
   * the broadphase, and the |R|·h expansion that turns it into an axis box was
   * inlined in full in Unstuck._solidIndex and PlanetWorld._solidIndex (the
   * pad-return walkability index), and as a yaw-only cos/sin variant in the
   * citadel caves. MapOverlay's
   * remove sweep needs the exact box: "this collider's own AABB lies inside
   * that object's box" is the rule that stops a remove of a house taking the
   * fence post beside it.
   *
   * @param {Collider} collider
   * @param {THREE.Box3} [out]
   * @returns {THREE.Box3} `out`; EMPTY for null or an unknown type - and a
   *   caller that tests containment must check `isEmpty()` first, because
   *   three's `Box3.containsBox` holds an empty box inside every box
   */
  colliderAabb(collider, out = new THREE.Box3()) {
    out.makeEmpty();
    if (!collider) return out;
    if (collider.type === 'box') {
      const m = collider.matrix.elements;
      const h = collider.halfExtents;
      const ax = Math.abs(m[0]) * h.x + Math.abs(m[4]) * h.y + Math.abs(m[8]) * h.z;
      const ay = Math.abs(m[1]) * h.x + Math.abs(m[5]) * h.y + Math.abs(m[9]) * h.z;
      const az = Math.abs(m[2]) * h.x + Math.abs(m[6]) * h.y + Math.abs(m[10]) * h.z;
      out.min.set(m[12] - ax, m[13] - ay, m[14] - az);
      out.max.set(m[12] + ax, m[13] + ay, m[14] + az);
    } else if (collider.type === 'sphere') {
      const c = collider.center;
      const r = collider.radius;
      out.min.set(c.x - r, c.y - r, c.z - r);
      out.max.set(c.x + r, c.y + r, c.z + r);
    } else if (collider.type === 'mesh') {
      out.copy(collider.bounds);
    } else if (collider.type === 'heightfield') {
      out.min.set(collider.originX, collider.minY, collider.originZ);
      out.max.set(collider.originX + collider.sizeX, collider.maxY, collider.originZ + collider.sizeZ);
    }
    return out;
  }
```

- [ ] **Step 4: Run the test to see it pass**

Run: `node --test scripts/tests/physics-collider-aabb.test.mjs`
Expected: `# pass 5`.

- [ ] **Step 5: Add the Physics contract entry.** In `scripts/contract-check.mjs`, after the `src/systems/Unstuck.js` line (`:957`), insert:

```js
  /* The collision world. Registered now because the map overlay's remove sweep
   * reaches `has` and `colliderAabb` only at apply time - a renamed method
   * would surface as "the remove hid the mesh and left the wall" one admin
   * visit later, never as a failed check here. Takes the count 130 -> 131. */
  {
    file: 'src/physics/Physics.js',
    exports: ['Physics', 'Collider', 'COLLISION_LAYER'],
    methods: ['add', 'remove', 'has', 'clear', 'query', 'raycast', 'colliderAabb'],
  },
```

Run: `node scripts/contract-check.mjs | tail -3`
Expected: `contract-check: 131/131 files present`, a blank line, then the real last line `All contracts satisfied.`; exit 0.

- [ ] **Step 6: Gates, then commit**

Run: `npm test 2>&1 | tail -12` → `# pass N + 5`, `# fail 0`. Run: `npx vite build` → exit 0.

```bash
git add src/physics/Physics.js scripts/tests/physics-collider-aabb.test.mjs scripts/contract-check.mjs
git commit -m "A collider can say its world-space box

MapOverlay's remove has to decide which colliders belong to a named object,
and the rule that does not over-remove is containment of each collider's
OWN axis box inside the object's - never its centre. Boxes carried only a
bounding sphere and the |R|·h expansion was inlined in full in two systems
(a third carries a yaw-only variant), so Physics.colliderAabb states it
once, for every collider type. Pinned in contract-check with Physics.has,
which the hotfix added beside it.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 1.2: `_applyRemove` — hide the object, drop the colliders it contains

**Files:**
- Modify: `src/systems/MapOverlay.js` — scratch constants (after `const _shift`), `_applyDocument` dispatch, `_applyMove` (delete the `hidden` line), a new "Removing" section before "Placing"
- Test: `scripts/tests/map-overlay.test.mjs` — a new section after "Reverting", before "Placing"

The test rig already has (from the hotfix) `solid(physics, world)`, `activate(rig, world)` and `registeredAs(physics, world)`; use them for every registration assertion — plain `enter()` skips what `_activate` does, which is exactly why the leak was invisible.

- [ ] **Step 1: Write the failing tests** — add after the "Reverting" section of `scripts/tests/map-overlay.test.mjs`:

```js
/* ------------------------------------------------------------------ */
/* Removing                                                            */
/* ------------------------------------------------------------------ */

/**
 * A remove hides the object AND drops the colliders it CONTAINS - each
 * collider's own world AABB inside the object's box grown by 0.10 m, never
 * centre-in-box, which would take the fence post beside the house. Terrain
 * is excluded by type; a collider another system tagged with `userData` is
 * excluded by that tag. Collider `userData` in this tree (verified 2026-08-28):
 * src/worlds/PlanetWorld.js :1165 {planetFloor}, :1687/:1694
 * {planetLiquidBarrier, barrierCap}, :1800 {planetEdgeWall};
 * src/systems/Portals.js :1140/:1159/:1174 {portal}; src/ships/Piloting.js
 * :2961 {kind:'ship', shipId}. `World.addSolid` (World.js:206) and
 * SportsWorld's `_solid` (SportsWorld.js:1860) forward `opts.userData`, but
 * no call site supplies one - so today the tag means exactly "a volume
 * another system owns and rebuilds before the overlay applies", and a future
 * `addSolid(mesh, { userData })` or `_solid(mesh, { userData })` on a prop
 * would silently exempt that prop. `solid` and `layer` are NOT consulted: a
 * trigger inside a removed prop belongs to the prop, as `_moveColliders`
 * moves it.
 */

const removeBarn = { kind: 'remove', id: 'r1', target: { name: 'barn.main' } };

test('a remove hides the object and drops the collider inside it; the broadphase no longer answers with it', async () => {
  const rig = setup(doc([removeBarn], { admin: true }));
  const own = rig.physics.addBoxFromObject(rig.world.barn);
  const other = rig.physics.addBox(-100, 0, -100, 1, 1, 1);
  await enter(rig);

  assert.equal(rig.world.barn.visible, false);
  assert.equal(rig.physics.has(own), false, 'the barn collider is still registered');
  assert.equal(rig.physics.has(other), true);
  assert.ok(!rig.physics.query(rig.world.barn.position, 6).includes(own), 'the broadphase still lists the dropped collider');
  assert.equal(rig.physics.groundHeight(-30, 0, 12, 20), null, 'an invisible wall stands where the barn was');
  assert.deepEqual(rig.system.report.applied, [{ id: 'r1', ok: true, colliders: 1 }]);
});

test('a remove never drops the terrain heightfield, even one whose footprint lies inside the box', async () => {
  const rig = setup(doc([removeBarn], { admin: true }));
  // A 1 m field entirely inside the barn's 4 m box - a genuine candidate, so
  // the TYPE exclusion is what this test measures.
  const field = rig.physics.addHeightfield({ heights: new Float32Array(4).fill(0), nx: 2, nz: 2, originX: -30.5, originZ: -0.5, stepX: 1 });
  const box = new THREE.Box3().setFromObject(rig.world.barn).expandByScalar(0.1);
  assert.ok(box.containsBox(rig.physics.colliderAabb(field)), 'the field must be a candidate, or this test proves nothing');
  await enter(rig);
  assert.equal(rig.physics.heightfields.length, 1);
  assert.equal(rig.physics.has(field), true);
  assert.equal(rig.system.report.applied[0].colliders, 0);
});

test('the tolerance is 0.10 m per axis: an authored +0.08 overhang is dropped, +0.12 is not and reads colliders: 0', async () => {
  for (const [pad, dropped] of [[0.08, 1], [0.12, 0]]) {
    const rig = setup(doc([removeBarn], { admin: true }));
    const c = rig.physics.addBox(-30, 0, 0, 2 + pad, 2 + pad, 2 + pad);
    await enter(rig);
    assert.equal(rig.physics.has(c), dropped === 0, `pad ${pad}`);
    assert.equal(rig.system.report.applied[0].colliders, dropped, `pad ${pad}`);
    assert.equal(rig.world.barn.visible, false, 'hidden either way');
  }
});

test('a Group target drops the colliders of every child inside its union box', async () => {
  const rig = setup(doc([{ kind: 'remove', id: 'r2', target: { name: 'shed' } }], { admin: true }));
  const shed = new THREE.Group();
  shed.name = 'shed';
  const wall = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 4));
  const roof = new THREE.Mesh(new THREE.BoxGeometry(3, 0.5, 4));
  roof.position.y = 2;
  shed.add(wall, roof);
  shed.position.set(60, 0, 60);
  rig.world.group.add(shed);
  rig.world.group.updateMatrixWorld(true);
  const a = rig.physics.addBoxFromObject(wall);
  const b = rig.physics.addBoxFromObject(roof);
  await enter(rig);
  assert.equal(rig.physics.has(a), false);
  assert.equal(rig.physics.has(b), false);
  assert.equal(rig.system.report.applied[0].colliders, 2);
});

test('a mesh chunk straddling the box survives; one fully inside is dropped', async () => {
  const rig = setup(doc([removeBarn], { admin: true }));
  const inside = rig.physics.addTriangleSoup(new Float32Array([-31, 0, -1, -29, 0, -1, -30, 1, 1]));
  const straddling = rig.physics.addTriangleSoup(new Float32Array([-31, 0, -1, -20, 0, -1, -30, 1, 1]));
  await enter(rig);
  assert.equal(rig.physics.has(inside), false);
  assert.equal(rig.physics.has(straddling), true);
  assert.equal(rig.system.report.applied[0].colliders, 1);
});

test('a userData-tagged collider inside the box is left alone; an untagged non-solid one goes with the object', async () => {
  const rig = setup(doc([removeBarn], { admin: true }));
  const plinth = rig.physics.addBox(-30, 0, 0, 0.5, 0.5, 0.5, { userData: { portal: 'medieval' } });
  const trigger = rig.physics.addBox(-30, 1, 0, 0.5, 0.5, 0.5, { solid: false });
  await enter(rig);
  assert.equal(rig.physics.has(plinth), true, 'a portal plinth was dropped with the barn');
  assert.equal(rig.physics.has(trigger), false, 'a trigger inside the barn stayed behind');
  assert.equal(rig.system.report.applied[0].colliders, 1);
});

test('a remove that would drop more than 200 colliders is refused with reason span, and hides nothing', async () => {
  const rig = setup(doc([removeBarn], { admin: true }));
  for (let i = 0; i < 201; i++) {
    rig.physics.addBox(-31.5 + (i % 20) * 0.15, -1 + Math.floor(i / 20) * 0.2, 0, 0.05, 0.05, 0.05);
  }
  const before = rig.physics.colliders.length;
  await enter(rig);
  assert.equal(rig.world.barn.visible, true);
  assert.equal(rig.physics.colliders.length, before);
  assert.deepEqual(rig.system.report.unresolved, [{ id: 'r1', reason: 'span' }]);
  assert.deepEqual(rig.system.report.applied, []);
});

test('a v1 hidden move is applied as a remove for one release: hidden, colliders dropped, its position ignored', async () => {
  const rig = setup(doc([{ kind: 'move', id: 'h1', target: { name: 'barn.main' }, position: { x: 40, y: 3, z: -20 }, hidden: true }], { admin: true }));
  const own = rig.physics.addBoxFromObject(rig.world.barn);
  const authored = rig.world.barn.position.clone();
  await enter(rig);
  assert.equal(rig.world.barn.visible, false);
  assert.deepEqual(rig.world.barn.position.toArray(), authored.toArray(), 'the position of a hidden move is discarded (decision A)');
  assert.equal(rig.physics.has(own), false);
  assert.equal(rig.physics.groundHeight(40, -20, 12, 20), null, 'the collider was moved instead of dropped');
  assert.equal(rig.system.report.applied[0].colliders, 1);
});

test('re-entering after the remove was dropped from the document registers the collider once, where it was built', async () => {
  const rig = setup(doc([removeBarn]));
  const station = solid(rig.physics, rig.world);
  const [, barnCollider] = station.colliders;
  await activate(rig, station);
  assert.equal(rig.physics.has(barnCollider), false, 'precondition: the remove dropped it');

  rig.doc.entries = [];
  rig.doc.version = 2;
  await activate(rig, station);
  assert.equal(rig.world.barn.visible, true);
  assert.deepEqual(registeredAs(rig.physics, station), [0, 1], 'a collider is registered more than once, or is foreign');
});

test('leaving for another world after a remove plants nothing of the removed object in the world entered', async () => {
  const rig = setup(doc([removeBarn]));
  const station = solid(rig.physics, rig.world);
  const medieval = solid(rig.physics, makeWorld('medieval'));
  const [, barnCollider] = station.colliders;
  await activate(rig, station);
  await activate(rig, medieval);
  assert.equal(rig.world.barn.visible, true, 'the mesh is put back for the next visit');
  assert.deepEqual(registeredAs(rig.physics, medieval), [0, 1], 'the physics of the world entered holds something that is not its own');
  assert.equal(rig.physics.has(barnCollider), false);
});
```

- [ ] **Step 2: Run to see them fail**

Run: `node --test scripts/tests/map-overlay.test.mjs`
Expected: 9 of the 10 new tests fail (`barn.visible` still `true`, `has(own)` still `true`, `applied[0]` undefined). The tenth, `leaving for another world after a remove plants nothing of the removed object in the world entered`, passes red AND green: with nothing dispatched the barn stays visible and `activate(rig, medieval)` clears physics, so every assertion holds. It is kept as a guard on the SHAPE of the undo — an `add` from the undo turns it red — the same role 9b16768's message gives the two re-entry tests. Every pre-existing test still passes.

- [ ] **Step 3: Implement.** In `src/systems/MapOverlay.js`:

(a) after `const _shift = new THREE.Matrix4();` add:

```js
/**
 * How far past a removed object's box a collider may reach and still be its
 * own (spec §6.3 said 5 cm). Authored boxes overhang on purpose - medieval
 * shells by +0.08 m on X and Z - so 5 cm finds nothing on the worlds most
 * likely to be edited, hides the mesh, and leaves exactly the wall the
 * remove was meant to take. Owner decision B: 0.10 m per axis.
 */
const REMOVE_TOLERANCE = 0.10;
/**
 * More colliders than this inside one named object's box is a district, not a
 * prop: `Box3.setFromObject` on a station district Group or a planet's
 * `planet:prop:*` InstancedMesh is the union of everything in it. Refused with
 * reason `span` and nothing hidden (decision B), rather than taking the deck
 * and the floor with it until the next save.
 */
const MAX_REMOVE_COLLIDERS = 200;
const _padded = new THREE.Box3();
const _aabb = new THREE.Box3();
```

(b) in `_applyDocument`, replace the two-line dispatch with:

```js
        // `hidden: true` is v1's spelling of a remove. The site migrates it on
        // read (schema v2), but a client running this bundle against a v1
        // document - a rollback, or a page open across the deploy - must not
        // let hidden objects reappear. Read as a remove for one release.
        if (entry.kind === 'remove' || (entry.kind === 'move' && entry.hidden === true)) {
          this._applyRemove(world, entry, applied, unresolved);
        } else if (entry.kind === 'move') this._applyMove(world, entry, applied, unresolved);
        else if (entry.kind === 'place') this._applyPlace(world, entry, applied, unresolved);
```

(c) in `_applyMove`, delete the line `if (entry.hidden) target.visible = false;` (a move no longer hides; a hidden move never reaches here).

(d) add a "Removing" section between the moving section and "Placing":

```js
  /* ------------------------------------------------------------------ */
  /* Removing                                                            */
  /* ------------------------------------------------------------------ */

  _applyRemove(world, entry, applied, unresolved) {
    const name = entry?.target?.name;
    const target = typeof name === 'string' && name ? world.group.getObjectByName(name) : null;
    if (!target) {
      unresolved.push({ id: String(entry.id ?? ''), reason: 'name' });
      return;
    }

    // The box is taken from the object as the world built it, before anything
    // changes: it is what decides which colliders are this object's.
    target.updateWorldMatrix(true, false);
    _box.setFromObject(target);
    const dropping = this._collidersInside(_box);
    if (dropping === null) {
      unresolved.push({ id: String(entry.id ?? ''), reason: 'span' });
      return;
    }

    const originalVisible = target.visible;
    target.visible = false;
    for (const collider of dropping) this.physics.remove(collider);

    /* The undo puts the mesh back and puts NOTHING into physics. Registration
     * is WorldManager._activate's: it rebuilds the collision world from
     * `world.colliders` - on which the dropped colliders still sit - before
     * `world:changed` fires. So when this undo runs the collider is either
     * already back (a same-world re-entry) or in a physics that now belongs
     * to another world (a portal): the two cases `_detach` names for a move,
     * and in neither is an `add` from here right. The first would register
     * it twice; the second is the leak the hotfix removed. Known limit: a
     * `dispose()` on a LIVE world runs this undo on the same physics, so the
     * mesh comes back and its collider does not. Nothing calls `dispose()`
     * at runtime (main.js never does; it is teardown), so it is stated here
     * rather than handled. */
    this._undo.push(() => {
      target.visible = originalVisible;
    });
    applied.push({ id: String(entry.id ?? ''), ok: true, colliders: dropping.length });
  }

  /**
   * Every collider whose OWN world AABB lies inside `box` grown by
   * REMOVE_TOLERANCE, or null when there are more than MAX_REMOVE_COLLIDERS.
   *
   * Containment, never centre-in-box: the move heuristic's failure mode is
   * under-moving, which is safe; inverted for a remove it would be
   * over-removing - a fence post whose centre sits inside a house-sized box
   * vanishes with the house (spec §6.3). A trimesh chunk that straddles the
   * box stays (station's chunks are spatial cells, not objects).
   *
   * Excluded by TYPE: heightfields, the ground. Excluded by TAG: any collider
   * with a non-null `userData` - portal plinths, landed ship hulls, a planet's
   * floor, liquid barriers and edge walls - volumes other systems own and
   * rebuild before this applies. `layer` and `solid` are not consulted: a
   * trigger inside a removed prop belongs to the prop, exactly as
   * `_moveColliders` takes it along with the prop.
   */
  _collidersInside(box) {
    const physics = this.physics;
    if (!physics) return [];
    _padded.copy(box).expandByScalar(REMOVE_TOLERANCE);
    const inside = [];
    for (const collider of physics.colliders) {
      if (!collider || collider.type === 'heightfield' || collider.userData != null) continue;
      const aabb = physics.colliderAabb(collider, _aabb);
      // An empty box (a type colliderAabb does not know) is contained by
      // EVERY box in three's `containsBox`; it must never read as "inside".
      if (aabb.isEmpty() || !_padded.containsBox(aabb)) continue;
      inside.push(collider);
      if (inside.length > MAX_REMOVE_COLLIDERS) return null;
    }
    return inside;
  }
```

- [ ] **Step 4: Run the file, then the suite**

Run: `node --test scripts/tests/map-overlay.test.mjs`
Expected: all pass; the file's count is its previous count + 10. The pre-existing `hidden takes an object out of the world without touching world source` still passes (its hidden move now goes through `_applyRemove`; the barn has no collider in that test, `colliders: 0`).

Run: `npm test 2>&1 | tail -12`
Expected: `# pass N + 15` (5 from Task 1.1, 10 here), `# fail 0`. Run: `node scripts/contract-check.mjs` → `131/131`. Run: `npx vite build` → exit 0. Write the count to `counts.md`.

- [ ] **Step 5: Commit**

```bash
git add src/systems/MapOverlay.js scripts/tests/map-overlay.test.mjs
git commit -m "A remove hides a named object and drops the colliders inside it

Hiding an object left its colliders behind - the invisible wall the spec
opens with. A remove now takes the object's world box before anything
changes and drops every collider whose OWN axis box lies inside it grown by
0.10 m: containment, never centre-in-box, so the post beside the house
stays. Terrain is excluded by type, and anything another system tagged
with userData - portal plinths, ship hulls, planet floors and barriers -
by that tag. More than 200 inside one box is a district, refused with
reason span and nothing hidden.

The undo puts the mesh back and registers nothing: WorldManager._activate
rebuilds physics from world.colliders before world:changed, so the
collider is already back on a re-entry and belongs to another world after
a portal - the two cases the hotfix's _detach names, and neither takes an
add from here. A v1 hidden move is applied as a remove for one release so a
page open across the deploy never sees hidden objects reappear.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 1.3: Record the userData inventory and the Bundle

- [ ] **Step 1: Verify the inventory the test header claims** (gap 9), and paste the output into `E:/markc/gametestai/gametestai/.probe/map-editor-stage2/progress.md`:

```bash
grep -rn "userData: {" src --include=*.js | grep -v "^\s*\*" | grep -v "geo.userData\|mesh.userData\|\.userData\."
grep -rn "addSolid(.*userData\|_solid(.*userData" src ; echo "addSolid/_solid with userData: $?"
```
Expected: exactly the eight collider sites named in the test header (PlanetWorld ×4, Portals ×3, Piloting ×1); the second grep prints nothing and `1` (no match — `_solid` is SportsWorld's forwarder at `src/worlds/SportsWorld.js:1858-1862`, `addSolid` is `World.js:201-208`). If a NEW site appears, add it to the test header and to §14 in Task 5.3 — it is excluded from every remove.

- [ ] **Step 2: Gates** (no source changed since Task 1.2's gate; run all three anyway so the Bundle is cut from a proven tree)

Run: `npm test 2>&1 | tail -12` → `# pass N + 15`. Run: `node scripts/contract-check.mjs` → `131/131` … `All contracts satisfied.`. Run: `npx vite build` → exit 0.

- [ ] **Step 3: Bundle commit**

```bash
cd site && node scripts/bundle-game.mjs && cd ..
git add site/public/game
git commit -m "Bundle: the applier's remove and the collider box

The built game with MapOverlay's remove - hide plus containment collider
drop - and Physics.colliderAabb, re-copied into the site. Not re-measured:
nothing on the boot or the frame loop changed; the sweep runs once per
remove entry at apply time.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Chunk 2: Site + game — schema v2, migration, conflicts, editor

Spec §5, §9, decisions A, D (normaliser half), F, J; gaps 1, 7. The schema flip is ONE commit: Tasks 2.1–2.5 edit the tree without committing (the widened union breaks `tsc --noEmit` until every consumer is retyped), Task 2.5 runs every gate and commits once. Task 2.6 is the editor UI in its own commit; Task 2.7 the Bundle.

**Type facts you build on.** `Draft = OverlayEntry & { _key }` (`site/lib/mapEditorState.ts:62`) propagates the union into every editor module. `tsc` will flag `entry.position` on a union with `RemoveEntry`, `e.hidden`, and `e.item.name` in `pendingRows`' else-branch; it will NOT flag the runtime colour/label ternaries (`MapPendingList.tsx:64`, `MapSelectionPanel.tsx:181`, `:212`) — Tasks 2.4 and 2.6 list each one. `hitTest` returns the candidate object itself (`site/lib/mapProjection.ts:100-114`, `best = c`), so a `MapMark`'s `.mark` is readable off a hit.

### Task 2.1: `mapOverlaySchema.ts` v2 — types, `{id}` targets, `remove`, the migration; the revert proof

**Files:**
- Modify: `site/lib/mapOverlaySchema.ts` (`:34-35`, `:93-101`, `:121`, `:274-297`)
- Modify: `site/lib/mapOverlaySchema.test.ts` (`:157-163`, `:170-182`, `:271-276`, new cases)
- Modify: `site/lib/mapOverlayRoundTrip.test.ts` (`:64-69`, `:145-165`)
- Modify: `site/lib/mapOverlay.test.ts` (new `describe` after the `recordWorldReport — the SQL it emits` block)

- [ ] **Step 1: Write the failing schema tests.** In `site/lib/mapOverlaySchema.test.ts`, import `RemoveEntry` and `MoveEntry` types beside `OverlayEntry` and `targetName, targetLabel` beside `normaliseOverlayEntries`; DELETE the two `it`s at `:170-182` (`carries hidden through…`, `accepts a hidden-only move…`) and the stale comment at `:157-159` (`position` is `Vec3 | null`… — it is `Vec3` now); in the `MAP_OVERLAY_SCHEMA` `it` at `:272-275` add `expect(MAP_OVERLAY_SCHEMA).toBe(2);`; then add:

```ts
describe('schema v2: targets, remove, and what became of hidden', () => {
  const asMove = (e: OverlayEntry) => e as MoveEntry;
  const asRemove = (e: OverlayEntry) => e as RemoveEntry;

  it('migrates a v1 hidden move with no position to a remove of the same id and target', () => {
    const { entries, rejected } = normaliseOverlayEntries([move({ id: 'h1', position: undefined, hidden: true })]);
    expect(rejected).toEqual([]);
    expect(entries).toEqual([{ kind: 'remove', id: 'h1', target: { name: 'barn.roof' } }]);
  });

  it('migrates a v1 hidden move WITH a position to a remove, discarding the position and yaw (decision A), one raw entry to one entry', () => {
    const raw = [move({ id: 'h2', position: { x: 4, y: 0, z: 4 }, rotationY: 1, hidden: true }), move({ id: 'm2', target: { name: 'well' } })];
    const { entries, rejected } = normaliseOverlayEntries(raw);
    expect(rejected).toEqual([]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ kind: 'remove', id: 'h2', target: { name: 'barn.roof' } });
    expect(entries[1].id).toBe('m2');
    // the old coercion read any truthy flag as hidden; a stored 'yes' must migrate the same way
    expect(normaliseOverlayEntries([move({ hidden: 'yes' })]).entries[0].kind).toBe('remove');
  });

  it('rejects a move with a null position: hiding is a remove, and a move must say where', () => {
    const { entries, rejected } = normaliseOverlayEntries([move({ position: null })]);
    expect(entries).toEqual([]);
    expect(rejected).toEqual([{ index: 0, id: 'e1', reason: 'position' }]);
  });

  it('accepts a remove of a named target, and re-normalises it to itself', () => {
    const first = normaliseOverlayEntries([{ kind: 'remove', id: 'r1', target: { name: 'barn.roof' } }]);
    expect(first.rejected).toEqual([]);
    expect(first.entries).toEqual([{ kind: 'remove', id: 'r1', target: { name: 'barn.roof' } }]);
    expect(normaliseOverlayEntries(first.entries)).toEqual(first);
  });

  it('rejects a remove with no usable target', () => {
    for (const bad of [undefined, {}, { name: '' }, { name: 42 }, { name: 'x', id: 'a@1,2' }]) {
      const { entries, rejected } = normaliseOverlayEntries([{ kind: 'remove', id: 'r', target: bad }]);
      expect(entries, JSON.stringify(bad)).toEqual([]);
      expect(rejected[0].reason).toBe('target');
    }
  });

  it('accepts an {id} target in family@x,z[#n] form, namespaced or not, on a move and a remove', () => {
    const ids = ['medieval:house@12.3,-40.1', 'rock@5,-7#2', 'planet:prop:tree@0.0,0.0', 'crate_a-1.b@-100,100#12'];
    for (const id of ids) {
      const { entries, rejected } = normaliseOverlayEntries([move({ target: { id } }), { kind: 'remove', id: 'r', target: { id } }]);
      expect(rejected, id).toEqual([]);
      expect(asMove(entries[0]).target).toEqual({ id });
      expect(asRemove(entries[1]).target).toEqual({ id });
    }
  });

  it('rejects an {id} that is not in that form, over 128 chars, or beside a name', () => {
    // `${'a'.repeat(130)}@1,2#1` is 136 chars: past TARGET_ID_MAX however well-formed. (120 a's would be 126 and ACCEPTED.)
    const bad = ['house', 'house@x,z', 'house@1,2,3', 'house@1.25,2', `${'a'.repeat(130)}@1,2#1`, 7];
    for (const id of bad) {
      const { entries, rejected } = normaliseOverlayEntries([move({ target: { id } })]);
      expect(entries, String(id)).toEqual([]);
      expect(rejected[0].reason).toBe('target');
    }
    // The boundary itself: `@1,2#1` is 6 chars, so 122 a's make exactly 128 (accepted) and 123 make 129 (refused, not cut).
    const ofLength = (n: number) => `${'a'.repeat(n - 6)}@1,2#1`;
    expect(ofLength(128)).toHaveLength(128);
    expect(normaliseOverlayEntries([move({ target: { id: ofLength(128) } })]).rejected).toEqual([]);
    expect(normaliseOverlayEntries([move({ target: { id: ofLength(129) } })]).rejected[0].reason).toBe('target');
    expect(normaliseOverlayEntries([move({ target: { name: 'a', id: 'a@1,2' } })]).rejected[0].reason).toBe('target');
    expect(normaliseOverlayEntries([move({ target: {} })]).rejected[0].reason).toBe('target');
  });

  it('keeps a mixed document of name and id targets in order, 1:1 with what was sent', () => {
    const raw = [move({ id: 'a' }), move({ id: 'b', target: { id: 'rock@5,-7' } }), { kind: 'remove', id: 'c', target: { id: 'rock@5,-8' } }, place()];
    const { entries, rejected } = normaliseOverlayEntries(raw);
    expect(rejected).toEqual([]);
    expect(entries.map((e) => e.id)).toEqual(['a', 'b', 'c', 'e2']);
  });

  it('targetName and targetLabel read both target shapes', () => {
    expect(targetName({ name: 'barn' })).toBe('barn');
    expect(targetName({ id: 'rock@5,-7' })).toBeNull();
    expect(targetLabel({ name: 'barn' })).toBe('barn');
    expect(targetLabel({ id: 'rock@5,-7' })).toBe('rock@5,-7');
  });
});
```
The existing `it('rejects a move with no position…')` at `:80-84` stays and still passes. One existing line no longer typechecks under `Target` (`site/tsconfig.json` includes `**/*.ts`, so test files ARE type-checked): `:60` `expect(e.target.name).toBe('barn.roof');` → `expect(e.target).toEqual({ name: 'barn.roof' });`.

- [ ] **Step 2: Run to see them fail**

Run: `cd site && npx vitest run lib/mapOverlaySchema.test.ts`
Expected: the new `describe` fails (`targetName` is not exported; `MAP_OVERLAY_SCHEMA` is 1; hidden moves come back as moves), the rest passes.

- [ ] **Step 3: Implement.** In `site/lib/mapOverlaySchema.ts`:

(a) `:34-35` →
```ts
/** Bumped when the shape below changes in a way a reader must notice. 2: `remove` is a kind, a target may be an `{id}`, and `hidden` is read as a remove. */
export const MAP_OVERLAY_SCHEMA = 2;
```

(b) replace `MoveEntry` (`:93-101`) with:
```ts
/**
 * What an entry acts on: a named Object3D the applier resolves live, or a
 * registry id the BUILD resolves (stage 3; this stage accepts the shape so no
 * further bump is needed). Ids are `family@x,z[#n]` - the authored position at
 * 0.1 m, `#n` only when two props of one family share a spot - and the family
 * may carry a namespace, as medieval's `medieval:${key}` batch keys do.
 */
export type Target = { name: string } | { id: string };

export interface MoveEntry {
  kind: 'move';
  id: string;
  target: Target;
  /** Absolute world position. A move always says where; taking an object out of the world is a `remove`. */
  position: Vec3;
  rotationY?: number;
}

export interface RemoveEntry {
  kind: 'remove';
  id: string;
  target: Target;
}

/** A registry id may be this long (spec §5). A truncated id would be a DIFFERENT id, so an over-long one is refused, not cut. */
export const TARGET_ID_MAX = 128;
const TARGET_ID_RE = /^[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)*@-?\d+(?:\.\d)?,-?\d+(?:\.\d)?(?:#\d+)?$/;

export function targetName(t: Target): string | null {
  return 'name' in t ? t.name : null;
}

export function targetLabel(t: Target): string {
  return 'name' in t ? t.name : t.id;
}
```

(c) `:121` → `export type OverlayEntry = MoveEntry | RemoveEntry | PlaceEntry;`

(d) after `readName` add:
```ts
/** A `{name}` (trimmed, ≤ 200) or an `{id}` (exact, ≤ 128, in registry form); never both, never neither. */
function readTarget(raw: unknown): Target | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const hasName = r.name !== undefined;
  const hasId = r.id !== undefined;
  if (hasName === hasId) return null;
  if (hasName) {
    const name = readName(r.name, 200);
    return name ? { name } : null;
  }
  if (typeof r.id !== 'string') return null;
  const id = r.id.trim();
  if (!id || id.length > TARGET_ID_MAX || !TARGET_ID_RE.test(id)) return null;
  return { id };
}
```

(e) replace the `move` branch (`:274-297`) with the two branches below:
```ts
    if (r.kind === 'move') {
      const target = readTarget(r.target);
      if (!target) {
        rejected.push({ index, id, reason: 'target' });
        continue;
      }
      // v1 spelled "take this object out of the world" as a move with `hidden`.
      // That is a remove now, and it is migrated HERE, on read, so every stored
      // version, every revert and the game GET load it without a rewrite. Its
      // position - where v1 parked the object's colliders - is discarded: a
      // hidden object's position was never observable, and the colliders it
      // governed are now dropped by containment at the authored box (owner
      // decision A). One raw entry becomes one entry, so the save route's
      // `rejected[].index` walk stays a raw index.
      if (r.hidden !== undefined && Boolean(r.hidden)) {
        entries.push({ kind: 'remove', id, target });
        seen.add(id);
        continue;
      }
      const position = readVec3(r.position);
      if (position === null) {
        rejected.push({ index, id, reason: 'position' });
        continue;
      }
      const entry: MoveEntry = { kind: 'move', id, target, position };
      if (rotationY !== undefined) entry.rotationY = rotationY;
      entries.push(entry);
      seen.add(id);
      continue;
    }

    if (r.kind === 'remove') {
      const target = readTarget(r.target);
      if (!target) {
        rejected.push({ index, id, reason: 'target' });
        continue;
      }
      entries.push({ kind: 'remove', id, target });
      seen.add(id);
      continue;
    }
```

- [ ] **Step 4: Run the schema tests** — `cd site && npx vitest run lib/mapOverlaySchema.test.ts` → all pass (26 − 2 deleted + 9 added = **33**).

- [ ] **Step 5: Flip the round-trip test.** In `site/lib/mapOverlayRoundTrip.test.ts`: import `MAP_OVERLAY_SCHEMA` beside `normaliseOverlayEntries`; `served()` returns `schema: MAP_OVERLAY_SCHEMA`; replace the `it` at `:145-165` with:

```ts
  it('a v1 hidden move reaches the game as a remove: the object is hidden AND its collider leaves the physics', async () => {
    const document = served([{ kind: 'move', id: 'h1', target: { name: 'crate.alpha' }, hidden: true }]);
    expect(document.entries).toEqual([{ kind: 'remove', id: 'h1', target: { name: 'crate.alpha' } }]);

    const b = bus();
    const physics = new Physics(b);
    const w = world();
    const collider = physics.addBoxFromObject(w.crate);
    const system = new MapOverlay({
      bus: b,
      physics,
      loot: { spawn: () => null, despawn: () => true },
      fetch: (async () => ({ ok: true, status: 200, json: async () => document })) as unknown as typeof fetch,
    });
    b.emit('world:changed', { id: w.id, world: w });
    await system.applying;

    expect(w.crate.visible).toBe(false);
    expect(physics.has(collider)).toBe(false);
    expect(system.report.applied).toEqual([{ id: 'h1', ok: true, colliders: 1 }]);
    expect(system.report.unresolved).toEqual([]);
  });
```
Run: `cd site && npx vitest run lib/mapOverlayRoundTrip.test.ts` → 3 pass.

- [ ] **Step 6: The revert proof (gap 7).** `revertOverlayTo` re-saves through `saveOverlayVersion` (`site/lib/mapOverlay.ts:309-326`), which normalises and INSERTs under `MAP_OVERLAY_SCHEMA` (`:277-283`). The route tests mock the store, so only the store can prove it. In `site/lib/mapOverlay.test.ts`, import `MAP_OVERLAY_SCHEMA` from `./mapOverlaySchema` and add after the `recordWorldReport — the SQL it emits` describe:

```ts
/**
 * A revert is a WRITE under the current schema, not a read of the old one:
 * reverting to a version saved before v2 must land a v2 document. Proved on
 * the recording client so it runs on every machine.
 */
describe('revertOverlayTo — writes the migrated document', () => {
  it('reverting to a v1 version that hid an object inserts a schema-2 document holding a remove', async () => {
    const v1 = [{ kind: 'move', id: 'h1', target: { name: 'crate.a' }, position: { x: 4, y: 0, z: 4 }, hidden: true }, MOVE];
    const db = makeFakeDb((sql, params) => {
      if (sql.startsWith('SELECT entries FROM map_overlays')) return [{ entries: v1 }];
      if (sql.startsWith('INSERT INTO map_overlays')) {
        return [{ version: 3, schema: params[1], entries: JSON.parse(String(params[2])), author: params[3], note: params[4], created_at: '2026-08-28T00:00:00.000Z' }];
      }
      return undefined;
    });
    const saved = await revertOverlayTo(db, { worldId: 'test-overlay-sql', version: 1, author: 'owner@example.com' });
    const insert = db.only('INSERT INTO map_overlays');
    expect(insert.params[1]).toBe(MAP_OVERLAY_SCHEMA);
    expect(JSON.parse(String(insert.params[2]))).toEqual([{ kind: 'remove', id: 'h1', target: { name: 'crate.a' } }, MOVE]);
    expect(saved?.schema).toBe(2);
    expect(saved?.entries[0]).toEqual({ kind: 'remove', id: 'h1', target: { name: 'crate.a' } });
    expect(saved?.note).toBe('revert to version 1');
  });
});
```
Run: `cd site && npx vitest run lib/mapOverlay.test.ts` → the new `it` passes (+1). Do not commit.

### Task 2.2: `mapConflicts.ts` — a removed target occupies nothing

**Files:**
- Modify: `site/lib/mapConflicts.ts` (`:1`, `:25-44`, `:165`, `:238-287`, `:396-408`)
- Modify: `site/lib/mapConflicts.test.ts` (`:2`, `:23-25`, `:68-72`, `:80-105`, `:249-252`, `:319-325`)

- [ ] **Step 1: Write the failing tests.** In `site/lib/mapConflicts.test.ts`: add `RemoveEntry` to the type import and, under `move()`, a helper
```ts
function remove(over: Partial<RemoveEntry> = {}): RemoveEntry {
  return { kind: 'remove', id: 'r1', target: { name: 'barn.roof' }, ...over };
}
```
Replace `:68-72` with:
```ts
  it('gives a remove the name rules and nothing else, with or without a layout', () => {
    expect(codes(conflictsFor(remove(), 0, [remove()], ctx({ layout: layout(), objects: [crate] })))).toEqual(['stale-name']);
    expect(conflictsFor(remove(), 0, [remove()], ctx())).toEqual([]);
    const known = remove({ target: { name: 'crate' } });
    expect(conflictsFor(known, 0, [known], ctx({ layout: layout(), objects: [crate] }))).toEqual([]);
  });

  it('warns a move and a remove of one name as duplicate-target, each naming the other', () => {
    const doc = [move({ id: 'a', target: { name: 'crate' } }), remove({ id: 'b', target: { name: 'crate' } })];
    const all = conflictsForDocument(doc, ctx({ objects: [crate] }));
    expect(all[0]).toEqual([expect.objectContaining({ code: 'duplicate-target', other: 'b' })]);
    expect(all[1]).toEqual([expect.objectContaining({ code: 'duplicate-target', other: 'a' })]);
    expect(all[0][0].detail).toMatch(/also removes "crate"; the last one wins/);
    expect(all[1][0].detail).toMatch(/also moves "crate"; the last one wins/);
  });

  it('applies no name rule to an {id} target: nothing reports ids until stage 3', () => {
    const m = move({ target: { id: 'medieval:house@2.0,2.0' } });
    expect(conflictsFor(m, 0, [m], ctx({ objects: [crate] }))).toEqual([]);
  });
```
Replace the `occupancy` describe (`:80-105`) with:
```ts
describe('occupancy', () => {
  // The game's `_applyRemove` hides the object AND drops the colliders inside its box, so a removed object
  // occupies nothing - the reverse of stage 1's hidden, whose colliders stayed. The last action on a name
  // wins because the applier runs the document in order.
  const spot = { x: 50, y: 0, z: 50 };
  const world = () => ctx({ layout: layout(), objects: [crate] });

  it('a removed reported object occupies nothing: a placement where it stood is clear', () => {
    const gone = remove({ target: { name: 'crate' } });
    const onCrate = place({ position: crate.position });
    expect(conflictsForDocument([gone, onCrate], world()).map(codes)).toEqual([[], []]);
  });

  it('move then remove: the remove wins, both warn duplicate-target, and the object stands nowhere', () => {
    const moved = move({ id: 'a', target: { name: 'crate' }, position: spot });
    const gone = remove({ id: 'b', target: { name: 'crate' } });
    const beside = place({ position: spot });
    expect(conflictsForDocument([moved, gone, beside], world()).map(codes)).toEqual([['duplicate-target'], ['duplicate-target'], []]);
  });

  it('remove then move: the move wins and occupies its new spot', () => {
    const gone = remove({ id: 'a', target: { name: 'crate' } });
    const moved = move({ id: 'b', target: { name: 'crate' }, position: spot });
    const beside = place({ position: spot });
    const all = conflictsForDocument([gone, moved, beside], world());
    expect(all.map(codes)).toEqual([['duplicate-target'], ['duplicate-target', 'overlap'], ['overlap']]);
    expect(all[2][0].other).toBe('b');
  });
});
```
Replace `:249-252` with:
```ts
  it('an {id} move gets the bounds rule only: no ground verdict, no overlap', () => {
    const m = move({ target: { id: 'medieval:house@2.0,2.0' }, position: { x: 2, y: 1.7, z: 2 } });
    expect(conflictsFor(m, 0, [m], twoMetres())).toEqual([]);
    const far = move({ target: { id: 'medieval:house@2.0,2.0' }, position: { x: 300, y: 2, z: 2 } });
    expect(codes(conflictsFor(far, 0, [far], twoMetres()))).toEqual(['out-of-bounds']);
  });
```
Replace `:319-325` with:
```ts
  it('does not overlap a placement with an object the document removes', () => {
    const farCrate = { name: 'crate', position: { x: 10, y: 0, z: 10 } };
    const gone = remove({ id: 'r', target: { name: 'crate' } });
    expect(conflictsForDocument([gone, place({ position: at(10, 10) })], withLayout([farCrate]))).toEqual([[], []]);
  });
```
Two lines in the bucket-grid reference (`:515`, `:519`) stop typechecking under the widened union and must change too: `:515` → `const moved = new Set(entries.flatMap((e) => (e.kind === 'move' && 'name' in e.target ? [e.target.name] : [])));` and `:519` → `if (e.kind === 'remove') return;` (after which `e.position` narrows on the next line).

- [ ] **Step 2: Run** `cd site && npx vitest run lib/mapConflicts.test.ts` → the replaced/added cases fail (a remove has no `position` → the old `prepare` throws, or the verdicts differ).

- [ ] **Step 3: Implement.** In `site/lib/mapConflicts.ts`:

(a) `:1` → `import { round, targetName, type OverlayEntry, type PlaceEntry, type Vec3 } from './mapOverlaySchema';`

(b) replace the header paragraph `:25-44` (`── Occupancy is the layout composed with the document ──` … `only \`lastMove\` in \`prepare\` composes.`) with:
```ts
 * ── Occupancy is the layout composed with the document ─────────────────────
 *
 * A named object stands where the game reported it UNLESS this document acts
 * on it. The LAST action on a name wins, because the game applies a document
 * in order: a move puts the object, and its colliders, at the new spot only
 * (it can never "overlap" its own old position); a remove takes the object
 * out of the world AND drops the colliders inside its box (`_applyRemove` in
 * `src/systems/MapOverlay.js`, by containment), so a removed object occupies
 * NOTHING - the reverse of stage 1's `hidden`, whose colliders stayed. An
 * action superseded by a later one stands nowhere: not an occupant, no
 * ground or overlap rule (it already carries `duplicate-target`), but still
 * the bounds rule, so an out-of-bounds coordinate cannot slip through behind
 * a later entry. An `{id}` target names a build-time prop this stage has no
 * layout entry for: it is judged for bounds only and composes nothing until
 * stage 3 brings `props[]`. On the route path the normaliser keeps duplicate
 * targets exactly as sent (it de-duplicates ids, not targets); only
 * `lastAction` in `prepare` composes.
```

(c) `:165` → `interface Prepared { names: Set<string>; occupancy: Occupancy; lastAction: Map<string, number> }`

(d) replace `prepare` and `nameRules` (`:238-287`) with:
```ts
/** The reported names, and the occupancy of layout ∘ document (see the header). */
function prepare(document: OverlayEntry[], ctx: ConflictContext): Prepared {
  const names = new Set(ctx.objects.map((o) => o.name));
  const lastAction = new Map<string, number>();
  document.forEach((entry, index) => {
    if (entry.kind === 'place') return;
    const name = targetName(entry.target);
    if (name !== null) lastAction.set(name, index);
  });

  const occupancy: Occupancy = { byKey: new Map(), cells: new Map() };
  let order = 0;
  for (const obj of ctx.objects) {
    if (lastAction.has(obj.name)) continue;
    const at = placeable(obj.position.x, obj.position.z);
    if (!at) continue;
    addOccupant(occupancy, { key: `object:${obj.name}`, label: obj.name, order: order++, x: at.x, z: at.z, rect: null });
  }
  document.forEach((entry, index) => {
    if (entry.kind === 'remove') return;
    if (entry.kind === 'move') {
      const name = targetName(entry.target);
      if (name === null || lastAction.get(name) !== index) return;
    }
    const at = placeable(entry.position.x, entry.position.z);
    if (!at) return;
    const rect = entry.kind === 'place' ? footprintRect(entry, ctx) : null;
    addOccupant(occupancy, { key: entryKey(index), label: entry.id, order: order++, x: at.x, z: at.z, rect });
  });
  return { names, occupancy, lastAction };
}

function nameRules(entry: OverlayEntry, index: number, document: OverlayEntry[], prepared: Prepared, out: Conflict[]): void {
  if (entry.kind === 'place') return;
  const name = targetName(entry.target);
  if (name === null) return;
  // Both sides clamp a name to 200 chars (`recordWorldReport`, `readName(…, 200)`), so the comparison is consistent.
  if (prepared.names.size > 0 && !prepared.names.has(name)) {
    out.push(warn('stale-name', `"${name}" is not among the ${prepared.names.size} known names this world last reported`));
  }
  document.forEach((other, j) => {
    if (j === index || other.kind === 'place' || targetName(other.target) !== name) return;
    const verb = other.kind === 'remove' ? 'removes' : 'moves';
    out.push(warn('duplicate-target', `"${other.id}" also ${verb} "${name}"; the last one wins`, other.id));
  });
}
```

(e) replace `conflictsWith` (`:396-408`) with:
```ts
function conflictsWith(entry: OverlayEntry, index: number, document: OverlayEntry[], ctx: ConflictContext, prepared: Prepared): Conflict[] {
  const out: Conflict[] = [];
  nameRules(entry, index, document, prepared, out);
  if (entry.kind === 'remove' || !ctx.layout) return out;
  const pos = entry.position;
  if (boundsRule(pos, ctx.layout, out)) return out;
  if (entry.kind === 'move') {
    const name = targetName(entry.target);
    // An {id} move is judged for bounds only; a superseded move stands nowhere (see the header).
    if (name === null || prepared.lastAction.get(name) !== index) return out;
  }
  if (ctx.ground) groundRule(pos, ctx.ground, out);
  overlapRule(index, prepared.occupancy, out);
  return out;
}
```

- [ ] **Step 4: Run** `cd site && npx vitest run lib/mapConflicts.test.ts` → all pass (48 − 5 replaced (`:68-72` one, `:80-105` two, `:249-252` one, `:319-325` one) + 8 added = **51**; count the file's `it(`s and write it down — the count is the source of truth). Do not commit.

### Task 2.3: `mapEditorState.ts` — rows, actions, marks for a remove

**Files:**
- Modify: `site/lib/mapEditorState.ts` (`:4`, `:41-49` header, `:126-166`, `:182-203`, `:235-272`, `:287-310`, `:326-365`)
- Modify: `site/lib/mapEditorState.test.ts` (`:169`, `:181`, `:188-191`, `:212-216`, `:275-317`, `:319-345`, `:374-401`, new cases)

- [ ] **Step 1: Write the failing tests.** In `site/lib/mapEditorState.test.ts`, import `actionEntryFor`, `removeFor`, `unresolvedText` from `./mapEditorState` and `targetLabel` from `./mapOverlaySchema`. Then:
  - `:209` (typechecks no longer under `Target`) → `expect(out.map((e) => (e.kind === 'move' ? targetLabel(e.target) : ''))).toEqual(['x', 'y']);`
  - `:169` → `{ _key: 'b', kind: 'remove', id: 'b', target: { name: 'station:crate' } },`
  - `:181` → `expect(rows[1]).toMatchObject({ key: 'b', kind: 'remove', label: 'station:crate', summary: 'removed', level: 'ok' });`
  - `:188-191` →
    ```ts
    it('a remove of an {id} target is labelled by the id', () => {
      const only: Draft[] = [{ _key: 'd', kind: 'remove', id: 'd', target: { id: 'medieval:house@1.0,2.0' } }];
      expect(pendingRows(only, [])[0]).toMatchObject({ kind: 'remove', label: 'medieval:house@1.0,2.0', summary: 'removed' });
    });
    ```
  - `:212-216` →
    ```ts
    it('Move here on a removed name replaces the remove with a move, under its key and id', () => {
      const gone: Draft[] = [{ _key: 'h', kind: 'remove', id: 'h', target: { name: 'q' } }];
      expect(upsertMoveFor(gone, 'q', { x: 1, y: 1, z: 1 }, undefined, mint)).toEqual([
        { _key: 'h', kind: 'move', id: 'h', target: { name: 'q' }, position: { x: 1, y: 1, z: 1 } },
      ]);
    });
    ```
  - after the `upsertMoveFor` describe, add:
    ```ts
    describe('removeFor and actionEntryFor', () => {
      const mv = (key: string, name: string): Draft => ({ _key: key, kind: 'move', id: key, target: { name }, position: { x: 1, y: 2, z: 3 } });
      const rm = (key: string, name: string): Draft => ({ _key: key, kind: 'remove', id: key, target: { name } });
      const pl: Draft = { _key: 'p', kind: 'place', id: 'p', item: { source_key: 's', name: 'S', config: {} }, position: { x: 4, y: 5, z: 6 }, quantity: 1 };

      it('appends one remove for a name nothing acts on, keyed as its id', () => {
        const out = removeFor([pl], 'x', mint);
        expect(out).toHaveLength(2);
        expect(out[1]).toMatchObject({ kind: 'remove', target: { name: 'x' } });
        expect(out[1]._key).toBe(out[1].id);
      });
      it('replaces the move of a name with a remove under the same key and id, leaving the rest alone', () => {
        expect(removeFor([mv('a', 'x'), pl, mv('b', 'y')], 'x', mint)).toEqual([rm('a', 'x'), pl, mv('b', 'y')]);
      });
      it('is a fixed point on a name already removed, and drops an earlier duplicate action on the name', () => {
        expect(removeFor([rm('a', 'x')], 'x', mint)).toEqual([rm('a', 'x')]);
        expect(removeFor([mv('a', 'x'), pl, mv('b', 'x')], 'x', mint)).toEqual([pl, rm('b', 'x')]);
      });
      it('actionEntryFor is the LAST move-or-remove of a name; moveEntryFor answers only when that action is a move', () => {
        const doc = [mv('a', 'x'), rm('b', 'x'), mv('c', 'y')];
        expect(actionEntryFor(doc, 'x')?._key).toBe('b');
        expect(moveEntryFor(doc, 'x')).toBeUndefined();
        expect(moveEntryFor(doc, 'y')?._key).toBe('c');
        expect(actionEntryFor(doc, 'z')).toBeUndefined();
      });
    });

    describe('unresolvedText', () => {
      it('names the version-lag and span states in words, and passes anything else through', () => {
        expect(unresolvedText('pending-rebuild')).toBe('applies on next world load');
        expect(unresolvedText('span')).toBe('refused — would drop more than 200 colliders; nothing hidden');
        expect(unresolvedText('id')).toBe('build-time target — nothing resolves ids until stage 3');
        expect(unresolvedText('name')).toBe('no object of that name in the world');
        expect(unresolvedText('error')).toBe('error');
      });
    });
    ```
  - in `selection helpers` (`:275-317`) add:
    ```ts
      it('a removed object selects as the remove, and is where the game reported it', () => {
        const gone: Draft[] = [entries[0], { _key: 'r', kind: 'remove', id: 'r', target: { name: 'o1' } }];
        expect(selectedEntry(gone, { kind: 'object', name: 'o1' })?._key).toBe('r');
        expect(selectedPosition(objects, gone, { kind: 'object', name: 'o1' })).toEqual({ x: 1, y: 2, z: 3 });
        expect(selectedPosition(objects, gone, { kind: 'entry', key: 'r' })).toBeNull();
      });
    ```
  - in `canonicalSelection` (`:319-345`) add `{ _key: 'r', kind: 'remove', id: 'r', target: { name: 'o1' } }` LAST in the `entries` fixture, and a case:
    ```ts
      it('a remove of a reported target is the object; a typed unreported name with only a remove is its entry', () => {
        expect(canonicalSelection(objects, entries, { kind: 'entry', key: 'r' })).toEqual({ kind: 'object', name: 'o1' });
        const typed: Draft[] = [{ _key: 'g', kind: 'remove', id: 'g', target: { name: 'ghost' } }];
        expect(canonicalSelection(objects, typed, { kind: 'object', name: 'ghost' })).toEqual({ kind: 'entry', key: 'g' });
      });
    ```
    (the existing `'m'` case still maps to the object: an entry key maps by that entry's own target.)
  - `hitCandidates and hoverInfoFor` (`:374-401`): `:378-379` → `{ _key: 'h', kind: 'remove', id: 'h', target: { name: 'o3' } },` and `{ _key: 'n', kind: 'remove', id: 'n', target: { name: 'nowhere' } },`; `:392-395` →
    ```ts
      it('an unmoved object is one mark; a removed object is one struck-through mark at its reported position', () => {
        expect(marks.filter((m) => m.key === 'o:o2')).toEqual([{ key: 'o:o2', x: 7, z: 8, r: 0, mark: 'object' }]);
        expect(marks.filter((m) => m.key === 'o:o3')).toEqual([{ key: 'o:o3', x: 9, z: 9, r: 0, mark: 'removed' }]);
      });
    ```
    `:396` title → `'a placement and a free-text move are entry marks; a remove is never one'`; the two `toBeUndefined()` lines stand (`marks.length` stays 6). Add to the hover cases: `expect(hoverInfoFor(objects, entries, 'o:o3')).toEqual({ label: 'o3 — removed', x: 9, y: 0, z: 9 });`

- [ ] **Step 2: Run** `cd site && npx vitest run lib/mapEditorState.test.ts` → fails (`removeFor`/`actionEntryFor`/`unresolvedText` missing; rows/marks differ).

- [ ] **Step 3: Implement** in `site/lib/mapEditorState.ts`:

(a) `:4` → `import { targetLabel, targetName, type GrantConfig, type MoveEntry, type OverlayEntry, type PlaceEntry, type RemoveEntry, type Vec3 } from './mapOverlaySchema';`

(b) in the header, replace the `── The last move wins ──` paragraph (`:41-49`) with:
```ts
 * ── The last action wins ───────────────────────────────────────────────────
 *
 * A saved document can carry two entries acting on one name (the normaliser
 * de-duplicates ids, not targets). The game applies a document in order, so
 * the LAST move-or-remove of a name is what the world shows, and
 * `mapConflicts.prepare` already composes it that way. Everything here that
 * resolves a name - `actionEntryFor`, and through it the selection, the
 * panel's fields, a drag's upsert, `removeFor` and the marks - reads the last
 * one too, so the map never draws a state the panel would not edit. A removed
 * object is drawn struck through where the game REPORTED it (a `{name}` has
 * no authored position) and cannot be dragged; Move here puts it back as a
 * move under the same key and id.
```

(c) `PendingRow.kind` → `'move' | 'remove' | 'place'`; replace `pendingRows` (`:140-157`) with:
```ts
export function pendingRows(entries: Draft[], conflicts: Conflict[][]): PendingRow[] {
  return entries.map((e, i) => {
    const own = conflicts[i] ?? [];
    if (e.kind === 'move') {
      const yaw = e.rotationY !== undefined ? ` yaw ${Math.round(radToDeg(e.rotationY))}°` : '';
      return { key: e._key, kind: 'move', label: targetLabel(e.target), summary: `→ ${vecText(e.position)}${yaw}`, level: rowLevel(own), conflicts: own };
    }
    if (e.kind === 'remove') {
      return { key: e._key, kind: 'remove', label: targetLabel(e.target), summary: 'removed', level: rowLevel(own), conflicts: own };
    }
    return { key: e._key, kind: 'place', label: `${e.item.name} ×${e.quantity}`, summary: `→ ${vecText(e.position)}`, level: rowLevel(own), conflicts: own };
  });
}
```

(d) replace `moveEntryFor` (`:159-166`) with:
```ts
/** The action that WINS for a name: the last move-or-remove of a `{name}` target in the document (see the header). */
export function actionEntryFor(entries: Draft[], name: string): (Draft & (MoveEntry | RemoveEntry)) | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind !== 'place' && targetName(e.target) === name) return e;
  }
  return undefined;
}

/** The move that wins for a name - only when the winning action IS a move. */
export function moveEntryFor(entries: Draft[], name: string): (Draft & MoveEntry) | undefined {
  const e = actionEntryFor(entries, name);
  return e?.kind === 'move' ? e : undefined;
}
```

(e) in `upsertMoveFor` (`:182-203`) replace `const existing = moveEntryFor(entries, name);` and its `if (existing)` block with:
```ts
  const existing = actionEntryFor(entries, name);
  if (existing) {
    // The winning entry becomes (or stays) the move, under its own key and id: Move here on a removed object puts it back.
    return entries.map((e) => {
      if (e !== existing) return e;
      const next: Draft & MoveEntry = { _key: existing._key, kind: 'move', id: existing.id, target: { name }, position: { ...position } };
      if (rotationY !== undefined) next.rotationY = rotationY;
      return next;
    });
  }
```
and after `upsertMoveFor` add:
```ts
/**
 * One remove for a name, whatever the document said about it before: the
 * winning action becomes the remove under its own key and id, and any earlier
 * action on the name is dropped so the document carries one word about it.
 * A fixed point on a name already removed. `mint` supplies the key for a name
 * nothing acted on.
 */
export function removeFor(entries: Draft[], name: string, mint: () => string): Draft[] {
  const existing = actionEntryFor(entries, name);
  const remove = (key: string, id: string): Draft & RemoveEntry => ({ _key: key, kind: 'remove', id, target: { name } });
  if (!existing) {
    const key = mint();
    return [...entries, remove(key, key)];
  }
  return entries
    .filter((e) => e === existing || e.kind === 'place' || targetName(e.target) !== name)
    .map((e) => (e === existing ? remove(existing._key, existing.id) : e));
}

/** What the report card says beside an unresolved id. The reasons are the game's (`src/systems/MapOverlay.js`); an unknown one is printed as it came. */
export function unresolvedText(reason: string): string {
  switch (reason) {
    case 'pending-rebuild': return 'applies on next world load';
    case 'span': return 'refused — would drop more than 200 colliders; nothing hidden';
    case 'id': return 'build-time target — nothing resolves ids until stage 3';
    case 'name': return 'no object of that name in the world';
    default: return reason;
  }
}
```

(f) `selectedEntry`: `if (selected.kind === 'object') return actionEntryFor(entries, selected.name);`. `selectedPosition`:
```ts
  if (selected.kind === 'entry') {
    const e = entries.find((d) => d._key === selected.key);
    return e && e.kind !== 'remove' ? e.position : null;
  }
  const act = actionEntryFor(entries, selected.name);
  if (act?.kind === 'move') return act.position;
  // Unmoved, or removed: where the game reported it.
  return objects.find((o) => o.name === selected.name)?.position ?? null;
```
`canonicalSelection`:
```ts
  if (sel.kind === 'entry') {
    const e = entries.find((d) => d._key === sel.key);
    if (e && e.kind !== 'place') {
      const name = targetName(e.target);
      if (name !== null && objects.some((o) => o.name === name)) return { kind: 'object', name };
    }
    return sel;
  }
  if (objects.some((o) => o.name === sel.name)) return sel;
  const act = actionEntryFor(entries, sel.name);
  return act ? { kind: 'entry', key: act._key } : sel;
```

(g) `MarkKind`: the first member's comment → `/** A reported object where the game reported it (no pending action). */`; append `| /** A removed object, struck through where the game reported it. */ 'removed'`. Delete `hidden?: boolean;` from `MapMark`.

(h) replace `hitCandidates` (`:326-348`) with:
```ts
export function hitCandidates(objects: Array<{ name: string; position: Vec3 }>, entries: Draft[]): MapMark[] {
  const out: MapMark[] = [];
  for (const o of objects) {
    const key = `o:${o.name}`;
    const act = actionEntryFor(entries, o.name);
    if (act?.kind === 'move') {
      out.push({ key, x: o.position.x, z: o.position.z, r: 0, mark: 'origin' });
      out.push({ key, x: act.position.x, z: act.position.z, r: 0, mark: 'moved', from: { x: o.position.x, z: o.position.z } });
    } else if (act?.kind === 'remove') {
      out.push({ key, x: o.position.x, z: o.position.z, r: 0, mark: 'removed' });
    } else {
      out.push({ key, x: o.position.x, z: o.position.z, r: 0, mark: 'object' });
    }
  }
  const reported = new Set(objects.map((o) => o.name));
  for (const e of entries) {
    if (e.kind === 'place') out.push({ key: `e:${e._key}`, x: e.position.x, z: e.position.z, r: 0, mark: 'place' });
    else if (e.kind === 'move') {
      const name = targetName(e.target);
      if (name === null || !reported.has(name)) out.push({ key: `e:${e._key}`, x: e.position.x, z: e.position.z, r: 0, mark: 'free' });
    }
    // A remove of an unreported name has no position and no mark; the pending list and the picker reach it.
  }
  return out;
}
```
(i) `hoverInfoFor`: the object branch → `const act = actionEntryFor(entries, sel.name); return { label: act?.kind === 'remove' ? \`${sel.name} — removed\` : sel.name, x: p.x, y: p.y, z: p.z };`; the entry label → `e.kind === 'place' ? \`${e.item.name} ×${e.quantity}\` : targetLabel(e.target)`.

- [ ] **Step 4: Run** `cd site && npx vitest run lib/mapEditorState.test.ts` → all pass (40 + 7 new = **47**: `removeFor and actionEntryFor` 4, `unresolvedText` 1, selection helpers 1, `canonicalSelection` 1; the `:188-191`, `:212-216` and `:392-395` edits are one-for-one replacements. Count and record). Do not commit.

### Task 2.4: Components — what the widened union forces (compile-only)

**Files:** `site/components/MapEditorPanel.tsx`, `MapSelectionPanel.tsx`, `MapCanvas.tsx`, `mapEditorStyles.ts`

No new behaviour beyond what `tsc` requires; the Remove UI is Task 2.6.

- [ ] **Step 1: `MapEditorPanel.tsx`.** Delete `setHidden` (`:375-385`) and the Hide checkbox block (`:581-598`, the `{selEntry?.kind === 'move' ? (…) : null}`). Import `actionEntryFor` beside `moveEntryFor`. In `moveSelection` (`:315`) → `return list.map((e) => (e._key === target.key && e.kind !== 'remove' ? ({ ...e, position } as Draft) : e));`. In `commitTransform`'s entry branch (`:330-338`) →
```ts
    edit((list) =>
      list.map((e) => {
        if (e._key !== sel.key) return e;
        if (e.kind === 'remove') {
          // Move here on a removed name puts it back as a move, under the same key and id.
          return { _key: e._key, kind: 'move', id: e.id, target: e.target, position, ...(rotationY !== undefined ? { rotationY } : {}) } as Draft;
        }
        const next = { ...e, position } as Draft;
        if (rotationY === undefined) delete (next as { rotationY?: number }).rotationY;
        else next.rotationY = rotationY;
        return next;
      })
    );
```
In `resetSelection` → `const act = actionEntryFor(entries, sel.name); if (act) removeEntry(act._key);`. In `commitTransform`'s OBJECT branch (`:325`) → `const key = actionEntryFor(entries, sel.name)?._key ?? newKey();` — for an unreported name whose winning action is a remove, `upsertMoveFor` replaces the remove under ITS key, and the `setSelectedRaw({ kind: 'entry', key })` two lines down must point at that key, not a freshly minted one nothing carries.

- [ ] **Step 2: `MapSelectionPanel.tsx`.** Import `targetLabel, type MoveEntry, type RemoveEntry` from `@/lib/mapOverlaySchema` (`targetName` arrives with its first use in Task 2.6). `:120` → `const rotation = entry && entry.kind !== 'remove' ? entry.rotationY : undefined;` (`RemoveEntry` has no `rotationY`). `freeMoves` (`:113-116`) →
```ts
  const freeActions = useMemo(
    () => entries.filter((e): e is Draft & (MoveEntry | RemoveEntry) => e.kind !== 'place' && !objectNames.has(targetLabel(e.target))),
    [entries, objectNames]
  );
```
and its optgroup (`:209-215`) → `freeMoves.length` / `freeMoves.map` become `freeActions.length` / `freeActions.map`, the label `"by name (not in the report)"`, the option text `{targetLabel(m.target)}{m.kind === 'remove' ? ' (removed)' : ''}`. The title (`:181`) →
```ts
  const removed = entry?.kind === 'remove';
  const title = !selected ? 'Nothing selected'
    : selected.kind === 'object' ? `${selected.name}${removed ? ' (removed)' : ''}`
    : entry?.kind === 'place' ? `${entry.item.name} ×${entry.quantity}`
    : entry ? `${targetLabel(entry.target)}${removed ? ' (removed)' : ''}` : 'entry';
```

- [ ] **Step 3: `MapCanvas.tsx`.** `:165` → `dot(ctx, p.sx, p.sy, isSel ? 4.5 : 3, C.object);` (no `m.hidden`). Add `case 'removed':` directly above `case 'object':` so it falls through (the drawing itself is Task 2.6).

- [ ] **Step 4: `mapEditorStyles.ts`** — after `placeColour`: `export const removeColour = '#ff7a90';`

- [ ] **Step 5: Typecheck** — `cd site && npx tsc --noEmit` → exit 0, no output. The sites named in Tasks 2.1–2.4 are the ones found by reading the tree at `1e020b9` (components AND `lib/**/*.test.ts`, which `site/tsconfig.json` includes); if `tsc` reports another, fix it the same way and note it in `progress.md`. Do not commit.

### Task 2.5: Game side of the schema flip — the schema number, the newer-document warning, the code-shaped pins — and the ONE commit

(The `hidden`-as-remove dispatch itself landed in Chunk 1, Task 1.2 Step 3(b); this task only stops the word pin from requiring the word `hidden`.)

**Files:**
- Modify: `src/systems/MapOverlay.js` (constants, ctor, `_read`)
- Modify: `scripts/tests/map-overlay.test.mjs` (the `hidden takes an object…` test at `:313-317`; the word-pin test `the entry kinds the editor writes are the entry kinds the game reads` at `:666-679`)

- [ ] **Step 1: Write the failing tests.** Replace `test('hidden takes an object out of the world without touching world source', …)` with:
```js
test('a remove takes an object out of the world without touching world source', async () => {
  const rig = setup(doc([{ kind: 'remove', id: 'r0', target: { name: 'barn.main' } }]));
  await enter(rig);
  assert.equal(rig.world.barn.visible, false);
});

test('a document newer than this build reads is said once, and still applied', async () => {
  const rig = setup({ ...doc([moveCrate]), schema: 3 });
  const warned = [];
  const warn = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    await enter(rig);
    await enter(rig);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(rig.world.crate.position.toArray(), [40, 3, -20]);
  assert.equal(warned.filter((w) => /\[map-overlay\] document schema 3 is newer than 2/.test(w)).length, 1, `${warned}`);
});
```
Replace the word-pin test (`the entry kinds the editor writes are the entry kinds the game reads`, `:666-679` at `1e020b9`) with — comments stripped, code-shaped patterns (decision J):
```js
/** Comments stripped, so a pin cannot be satisfied by prose about the thing. The two regexes map-overlay-layout.test.mjs uses. */
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

test('the entry kinds the editor writes are the kinds the game dispatches on, and both sides carry schema 2', () => {
  const schema = code('site/lib/mapOverlaySchema.ts');
  const system = code('src/systems/MapOverlay.js');
  for (const kind of ['move', 'remove', 'place']) {
    assert.match(schema, new RegExp(`kind: '${kind}'`), `schema never writes kind '${kind}'`);
    assert.match(system, new RegExp(`entry\\.kind === '${kind}'`), `MapOverlay.js never dispatches on kind '${kind}'`);
  }
  assert.match(schema, /^export const MAP_OVERLAY_SCHEMA = 2;/m, 'the site writes a schema number other than 2');
  assert.match(system, /^const OVERLAY_SCHEMA = 2;/m, 'the game reads a schema number other than the one the site writes');
  // Field names the applier indexes into, as CODE on both sides where a bare word could match anything
  // (`includes('id')` is true of every identifier with 'id' in it): a rename is a silent no-op at runtime.
  for (const [field, pattern, schemaPattern] of [
    ['position', /entry\.position\b/, /position: Vec3;/], ['rotationY', /entry\.rotationY\b/, /rotationY\?: number;/],
    ['quantity', /entry\.quantity\b/, /quantity: number;/], ['source_key', /source_key/, /source_key: string;/],
    ['name', /target\?\.name\b/, /\{ name: string \}/],
  ]) {
    assert.match(schema, schemaPattern, `schema no longer declares ${field} as code`);
    assert.match(system, pattern, `MapOverlay.js never reads ${field}`);
  }
});
```

- [ ] **Step 2: Run** `node --test scripts/tests/map-overlay.test.mjs` → the schema-warn test and the pin (`OVERLAY_SCHEMA`) fail.

- [ ] **Step 3: Implement** in `src/systems/MapOverlay.js`: after `const REPORT_ENDPOINT = …` add
```js
/** The document shape this build reads (site/lib/mapOverlaySchema.ts MAP_OVERLAY_SCHEMA); pinned across the boundary by map-overlay.test.mjs. */
const OVERLAY_SCHEMA = 2;
```
In the constructor, after `this.applying = null;`: `this._schemaWarned = false;`. In `_read`, after the `data.world !== worldId` check:
```js
      // Newer than this build reads. Every kind it knows still applies and the
      // rest is skipped (spec §5, the v1-client rule); said once a session.
      if (Number(data?.schema) > OVERLAY_SCHEMA && !this._schemaWarned) {
        this._schemaWarned = true;
        console.warn(`[map-overlay] document schema ${data.schema} is newer than ${OVERLAY_SCHEMA}; unknown entries are skipped`);
      }
```

- [ ] **Step 4: Every gate, then the one commit.**

Run, in order, and record the counts in `counts.md`:
- `node --test scripts/tests/map-overlay.test.mjs` → pass (+1 net: one replaced, one added).
- `npm test 2>&1 | tail -12` → `# pass N + 16`, `# fail 0`.
- `node scripts/contract-check.mjs` → `131/131`.
- `npx vite build` → exit 0 (`MapOverlay.js` changed).
- `cd site && npx tsc --noEmit` → exit 0.
- `cd site && npx vitest run 2>&1 | tail -6` → `Tests  857 passed` on a clean run (839 + schema 7 net + conflicts 3 net + editor state 7 + revert 1; round-trip's 3 unchanged) — or 857 minus the baseline failure set recorded in `counts.md`, with every `lib/map*.test.ts` file green; CI's number is 857 − 17 = 840.
- `cd site && npm run build:site-only` → exit 0.

```bash
git add site/lib/mapOverlaySchema.ts site/lib/mapOverlaySchema.test.ts site/lib/mapOverlayRoundTrip.test.ts site/lib/mapOverlay.test.ts \
  site/lib/mapConflicts.ts site/lib/mapConflicts.test.ts site/lib/mapEditorState.ts site/lib/mapEditorState.test.ts \
  site/components/MapEditorPanel.tsx site/components/MapSelectionPanel.tsx site/components/MapCanvas.tsx site/components/mapEditorStyles.ts \
  src/systems/MapOverlay.js scripts/tests/map-overlay.test.mjs
git commit -m "Overlay schema 2: remove is a kind, hidden is read as one, and a target may be an id

A move that hid an object left its colliders standing - the invisible wall
the spec opens with - and the editor's Hide checkbox was stage 1's stand-in
for a remove. The document now says remove. Every stored version and every
revert still loads: the normaliser migrates a v1 hidden move to a remove ON
READ, discarding the position v1 parked the colliders at (they are dropped
by containment now), one raw entry to one entry so the save route's index
walk stays sound - and a revert, which re-saves, writes the migrated
document under schema 2. A move must say where; position: null is refused.
Targets accept the registry id form the build will resolve in stage 3, so
no further bump is needed; nothing resolves an id yet.

The conflict engine reverses stage 1's rule: a removed object occupies
nothing, the last move-or-remove of a name wins, and a move and a remove of
one name warn each other. The editor's pure module gains removeFor and
actionEntryFor, a REMOVE row, and a struck-through mark at the reported
position; the Hide checkbox is gone. The game (whose applier has read a v1
hidden move as a remove since the previous commit, for one release) now
says once when a document is newer than it reads, and the cross-boundary
pin matches code on both sides, not comments.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 2.6: The editor UI — [Remove], REMOVE rows, the struck-through mark, the report card's reasons

**Files:** `site/components/MapSelectionPanel.tsx`, `MapEditorPanel.tsx`, `MapPendingList.tsx`, `MapCanvas.tsx`

There is no component test runner; every decision these edits make was pinned in Task 2.3. Each step names the pure function it calls.

- [ ] **Step 1: `MapSelectionPanel.tsx`.** Add `targetName` to the `@/lib/mapOverlaySchema` import (its first use is below). Add to `MapSelectionPanelProps`: `/** Remove the named object from the world: one remove entry replaces whatever the document said about it. */ onRemove: (name: string) => void;` and destructure it. Compute, after `title`:
```ts
  /* Which name [Remove] acts on: a selected object that is not already removed, or a free move's name. An {id}
   * target and a placement cannot be removed by name. */
  const removeName = !selected ? null
    : selected.kind === 'object' ? (removed ? null : selected.name)
    : entry?.kind === 'move' ? targetName(entry.target) : null;
```
In the button row (`:321-335`), after the Reset button:
```tsx
        {removeName !== null ? (
          <button className="btn btn-ghost btn-sm" type="button" data-e2e="remove" disabled={disabled} onClick={() => onRemove(removeName)}>
            Remove
          </button>
        ) : null}
```
Append to the footnote (`:336-338`): ` Remove hides the object in game and drops the colliders inside it; Move here on a removed object puts it back.`

- [ ] **Step 2: `MapEditorPanel.tsx`.** Import `removeFor`, `unresolvedText` from `@/lib/mapEditorState` and `targetName` from `@/lib/mapOverlaySchema`. After `resetSelection` add:
```ts
  function removeSelection(name: string) {
    edit((list) => removeFor(list, name, newKey));
  }
```
Pass `onRemove={removeSelection}` to `<MapSelectionPanel>`. In the report card: `<li key={u.id}>{u.id} — {unresolvedText(u.reason)}</li>`, and after the unresolved list add the `colliders: 0` warning (decision B):
```tsx
                {zeroDrops.length ? (
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: warnColour }}>
                    {zeroDrops.map((a) => (
                      <li key={a.id}>{a.id} — removed, but nothing dropped: this object may still block</li>
                    ))}
                  </ul>
                ) : null}
```
with, beside `objects`:
```ts
  /* A {name} remove the game applied with no colliders dropped is hidden but may still block (decision B). Matched by id
   * against the document on this page: what the game applied was a saved version, and the id is what both share. */
  const zeroDrops = useMemo(
    () => (report?.applied ?? []).filter((a) => (a.colliders ?? 0) === 0 && entries.some((e) => e.id === a.id && e.kind === 'remove' && targetName(e.target) !== null)),
    [report, entries]
  );
```

- [ ] **Step 3: `MapPendingList.tsx`.** Import `removeColour`; `:64` → `color: r.kind === 'move' ? moveColour : r.kind === 'remove' ? removeColour : placeColour`. (`r.kind.toUpperCase()` on `:65` already prints `REMOVE`.)

- [ ] **Step 4: `MapCanvas.tsx`.** Import `removeColour`; add `removed: removeColour,` to `C`. Replace the fall-through `case 'removed':` with:
```ts
    case 'removed': {
      dot(ctx, p.sx, p.sy, isSel ? 4.5 : 3, C.objectFaint);
      ctx.strokeStyle = C.removed;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(p.sx - 6, p.sy + 6);
      ctx.lineTo(p.sx + 6, p.sy - 6);
      ctx.stroke();
      if (isSel) ring(ctx, p.sx, p.sy, 9, C.selected);
      return;
    }
```
In `onPointerDown` (`:448`), a removed mark selects but never drags: `if (hit && hit.key === selectionKey(selected) && (hit as MapMark).mark !== 'removed') {`.

- [ ] **Step 5: Gates and commit.** `cd site && npx tsc --noEmit` → 0; `cd site && npx vitest run` → 857 on a clean run (unchanged; no pure module moved); `cd site && npm run build:site-only` → 0. The pure-module tests of Task 2.3 are the GATE; what follows is evidence, recorded in `progress.md`. It needs what `site/.env.example` names — `POSTGRES_URL` (a loopback database; the e2e harness refuses a shared one for the same reason), `HMAC_SECRET`, and `ADMIN_EMAILS` listing the account you sign in with through the real `/login` form. Start `cd site && npx next dev`, sign in, open `/admin/map`: pick a reported object → **Remove** → a `REMOVE` row appears, the mark is struck through, the title reads `(removed)`, the mark does not drag, **Move here** turns it back into a move under the same row, **Reset** deletes it; **Save** writes a version. Record what you saw; if the environment is absent write `manual check SKIPPED — no local DB/admin session` and say so in the hand-back.

```bash
git add site/components/MapSelectionPanel.tsx site/components/MapEditorPanel.tsx site/components/MapPendingList.tsx site/components/MapCanvas.tsx
git commit -m "The map editor removes an object with a button, and draws what it removed

A Remove button beside Reset replaces the Hide checkbox that stood in for
it: one remove entry for the name, whatever the document said about it
before, shown as a REMOVE row and a struck-through mark where the game
reported the object. A removed mark selects but does not drag; Move here on
it puts the object back as a move under the same row. The report card
prints the game's reasons in words - applies on next world load, refused
for span - and warns when a remove dropped no collider, because a hidden
object that still blocks is the defect this stage exists to end.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 2.7: Bundle

- [ ] `cd site && node scripts/bundle-game.mjs && cd .. && git add site/public/game` and commit:
```
Bundle: the applier reads schema 2

The built game with MapOverlay's remove dispatch, the hidden-as-remove
reading for one release and the schema warning, re-copied into the site so
the site's schema flip and the game that reads it ship in one deploy. Not
re-measured: nothing on the boot or the frame loop changed.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## Chunk 3: Game — the overlay reaches the build

Spec §4.1, §7 (`builtVersion`), §10; decisions D (applier half), G, H (the base); gaps 3, 4, 5, 6. The FIRST task measures; no code lands before it. Every commit in Tasks 3.2–3.5 runs `npm test`, contract-check and `npx vite build` before it is made; Task 3.6 runs them once more on the chunk's tip. Ends with a `Bundle:` commit.

**Facts you build on (verified).** `_runBuild` (`src/worlds/WorldManager.js:222-309`) redirects `world.physics`/`world.ctx.physics` to a scratch `Physics`, then `await report(0, …)` (`:291`) and `await world.ensureBuilt(report)` (`:292`) inside a `try/finally`; `report.slice` already keys on `this.engine?.running` (`:284`); the manager's `this.ctx` is the object `main.js` built (`:40`), while each world got a spread COPY (`:143`). `build()` disposes and rebuilds a volatile world that is not active (`:191-194`). `_activate` calls `this.build(id)` first (`:342`) — a portal into an unbuilt world is a build with `engine.running === true`. `WorldPrefetch.request` (`src/systems/WorldPrefetch.js:158-179`) runs `prepare(id)`, which is `prepareWorld` → `worldManager.build(id)` (`src/main.js:2306-2308`). `accountStatePromise` (`src/main.js:1154-1162`) is a module-load fetch of `/api/game/session` that resolves to the session JSON or `null` and never rejects; `hydrateAccountSession()` awaits it at `:1256`, AFTER the entry build at `:1247`. The game GET is 401 when signed out (`site/app/api/game/map-overlay/route.ts:38-40`); `_read` answers `null` on `!res.ok` without a warning and warns only on a thrown fetch. Textual pins that must keep passing: the ctor regex (`scripts/tests/map-overlay-layout.test.mjs:478-482`, the regex at `:480`) and the `scheduleBackgroundBuilds` line (`scripts/tests/world-prefetch.test.mjs:173-189`). Nothing in this chunk touches the `_visit` guard (9b16768), but Task 3.3 writes the cache inside `_read`, which runs on the SAME late continuation that guard drops — a slow first read answering an OLDER version can land after a return visit applied a newer one (9b16768's second test). The cache write is therefore version-monotonic, and Task 3.3 pins that on the 9b16768 rig.

### Task 3.0: The cold base, before any chunk-3 code (decision H, gap 1 of the perf record)

No code. Do this on the tree as it stands after Chunk 2's Bundle commit.

- [ ] **Step 1: Cold frame-gaps base, three runs**

Run: `node scripts/frame-gaps.mjs --serve prod --cold --entry station --worlds station --events keybind,weapon,mount,interaction,movement --repeat 3 --out E:/markc/gametestai/gametestai/.probe/gaps/stage2-base`
Expected: exit 0; `E:/markc/gametestai/gametestai/.probe/gaps/stage2-base/run-1.json` … `run-3.json` and `summary.json`; the console prints the spread.

- [ ] **Step 2: Record the numbers.** In `E:/markc/gametestai/gametestai/.probe/map-editor-stage2/perf.md` write, per run: the `boot` row's `worst`, `over`, `frames` from `summary.json`, and `warm.programs`; and the printed spread. These three runs ARE the noise floor the after-run in Task 5.1 is judged against — the header of `scripts/frame-gaps.mjs` (`:41-48`) records that this repository has read instrument noise as a regression twice.

- [ ] **Step 3: World-shot befores** (budgets: draws, programs, triangles per view)

Run, one per world: `node scripts/world-shot.mjs --world station --out E:/markc/gametestai/gametestai/.probe/shots/stage2-before/station`, then `--world medieval` and `--world carnelian` into their own directories. Paste each `report.json`'s per-view `drawCalls`, `worldTriangles` and `programs` (they live under `views.<name>`, `scripts/world-shot.mjs:267-272`; `rendererTriangles` is not a budget — it sums the shadow and GTAO passes and moves 10-13 % on its own) into `perf.md`.

- [ ] **Step 4: Chain-warmed gate base** (the `builtBefore` invariant, `scripts/frame-gaps.mjs:2697`): `node scripts/frame-gaps.mjs --serve prod --gate --entry station --worlds station,medieval,maze --events entry,repeat --out E:/markc/gametestai/gametestai/.probe/gaps/stage2-gate-base` → exit 0, every `entry:*` row `pass`. Record the rows.

### Task 3.1: `World.builtVersion`, the provider test rig, and the no-provider short-circuit

**Files:**
- Create: `scripts/tests/map-overlay-provider.test.mjs`
- Modify: `src/worlds/World.js` (constructor after `this.colliders = [];`, `:41`; `dispose()`, `:185-195`)
- Modify: `scripts/contract-check.mjs` (a World.js entry after the WorldManager entry, `:102-106`)

- [ ] **Step 1: Write the rig and the first two failing tests**

```js
// scripts/tests/map-overlay-provider.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

/**
 * THE OVERLAY REACHES THE BUILD, THROUGH THE REAL WorldManager.
 *
 * THE CLAIM (spec §4.1, owner decision G): `_runBuild` asks `ctx.overlayProvider`
 * for the world's document before the world builds and stores its version as
 * `world.builtVersion`; with nothing on ctx it awaits nothing and starts no
 * timer; in the player's frames it waits at most 1500 ms, behind the loading
 * gate at most 8000 ms; a failure or a timeout is a world built at 0, said
 * once. A portal forcing its destination, a WorldPrefetch preparation and a
 * volatile rebuild all go through the same seam, and the provider is read from
 * the MANAGER's ctx, never the per-world copy.
 *
 * Not a stub: every case builds a real World subclass through the real
 * WorldManager over a real Physics, and the timing cases wait on real timers
 * against a provider that really never answers. rAF is counted as
 * station-build-slicing counts it, because a frame handed back is the one
 * thing a "no await" claim can be measured by.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = async (p) => (await readFile(path.join(root, p), 'utf8')).replace(/\r\n/g, '\n');
const readCode = async (p) => (await read(p)).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const baseRaf = globalThis.requestAnimationFrame ?? ((cb) => setTimeout(() => cb(Date.now()), 0));
let rafCalls = 0;
globalThis.requestAnimationFrame = (cb) => { rafCalls++; return baseRaf(cb); };

const { EventBus } = await import('../../src/core/EventBus.js');
const { Physics } = await import('../../src/physics/Physics.js');
const { World } = await import('../../src/worlds/World.js');
const { WorldManager } = await import('../../src/worlds/WorldManager.js');
const { WorldPrefetch } = await import('../../src/systems/WorldPrefetch.js');

/** A world of one floor box. `volatile` opts in to the maze's rebuild-on-every-request rule. */
function worldClass(id, { volatile = false } = {}) {
  return class extends World {
    static id = id;
    static displayName = id;
    static volatile = volatile;
    async build() {
      this.track(this.physics.addBox(0, -0.5, 0, 20, 0.5, 20));
      this.playerSpawn.set(0, 1, 0);
    }
  };
}

function manager({ running = false, provider } = {}) {
  const bus = new EventBus();
  const physics = new Physics(bus);
  const engine = { running };
  const ctx = { scene: new THREE.Scene(), engine, physics, bus, materials: {} };
  if (provider) ctx.overlayProvider = provider;
  const wm = new WorldManager(ctx);
  return { wm, engine, bus, physics, ctx };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const never = () => new Promise(() => {});
const quietly = async (fn) => {
  const warned = [];
  const warn = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try { await fn(warned); } finally { console.warn = warn; }
  return warned;
};

test('a world declares builtVersion 0 before it is built, and dispose resets it', async () => {
  const { wm } = manager();
  wm.register(worldClass('fresh'));
  const world = wm.getWorld('fresh');
  assert.equal(world.builtVersion, 0);
  world.builtVersion = 9;
  world.dispose();
  assert.equal(world.builtVersion, 0);
});

test('no provider on ctx: the build waits on nothing, hands no frame back for it, and the world is built at 0', async () => {
  const { wm } = manager();
  wm.register(worldClass('none'));
  const before = rafCalls;
  const t = performance.now();
  const world = await wm.build('none');
  assert.equal(world.builtVersion, 0);
  // At most the coarse `report(1)` yield a slow machine can trip (>24 ms since report(0)); never a timer's worth.
  assert.ok(rafCalls - before <= 1, `a build with nothing to wait for handed ${rafCalls - before} frames back`);
  assert.ok(performance.now() - t < 200, 'a build with no provider waited on something');
});
```

- [ ] **Step 2: Run** `node --test scripts/tests/map-overlay-provider.test.mjs` → the first test fails (`builtVersion` is `undefined`), the second passes on the untouched manager (it is the guard that stays green through Task 3.2).

- [ ] **Step 3: Implement.** `src/worlds/World.js`, after `this.colliders = [];`:
```js
    /**
     * The overlay version this build consumed, 0 when none (spec §7). Written
     * by `WorldManager._runBuild` on EVERY build - a volatile rebuild refreshes
     * it - and read by MapOverlay into the report's `builtVersion`. One of the
     * two properties a world ever sees of the overlay; the other, `registry`,
     * arrives in stage 3.
     */
    this.builtVersion = 0;
```
and in `dispose()`, after `this._built = false;`: `this.builtVersion = 0;`.

In `scripts/contract-check.mjs`, after the WorldManager entry (`:102-106`):
```js
  /* The base world. Registered for `builtVersion`, which is not a method and
   * which the `methods` regex cannot see: WorldManager._runBuild writes it and
   * MapOverlay reads it into the report, and a rename is a report that says
   * "built at 0" for every world for ever. Takes the count 131 -> 132. */
  { file: 'src/worlds/World.js', exports: ['World'], fields: ['builtVersion'] },
```

- [ ] **Step 4: Run** the file → 2 pass; `node scripts/contract-check.mjs` → `132/132`. Do not commit yet (Task 3.2 completes the build path).

### Task 3.2: `_runBuild` asks the provider — ceilings, short-circuit, log once

**Files:**
- Modify: `src/worlds/WorldManager.js` (constants after `clamp01`, `:32`; constructor; `_runBuild` between `:291` and `:292`; two new methods after `_runBuild`)
- Test: `scripts/tests/map-overlay-provider.test.mjs`

- [ ] **Step 1: Write the failing tests** (append):

```js
test('a provider that answers {version: 7} leaves the world built at 7, asked once with the world id', async () => {
  const asked = [];
  const { wm } = manager({ provider: async (id) => { asked.push(id); return { version: 7, entries: [], admin: false }; } });
  wm.register(worldClass('seven'));
  assert.equal((await wm.build('seven')).builtVersion, 7);
  assert.deepEqual(asked, ['seven']);
  assert.equal((await wm.build('seven')).builtVersion, 7, 'a second build of a cached world is the same world');
  assert.deepEqual(asked, ['seven'], 'a cached world was built again');
});

test('a provider that rejects builds the world at 0 and says so once; a null answer (signed out) says nothing', async () => {
  const warned = await quietly(async () => {
    const { wm } = manager({ provider: async () => { throw new Error('offline'); } });
    wm.register(worldClass('down'));
    assert.equal((await wm.build('down')).builtVersion, 0);
    const quiet = manager({ provider: async () => null });
    quiet.wm.register(worldClass('anon'));
    assert.equal((await quiet.wm.build('anon')).builtVersion, 0);
  });
  assert.deepEqual(warned, ['[WorldManager] overlay unavailable for "down": offline; building without it']);
});

test("in the player's frames a provider that never answers costs a build at most 1500 ms, then 0", async () => {
  let took = 0;
  let world;
  const warned = await quietly(async () => {
    const { wm } = manager({ running: true, provider: never });
    wm.register(worldClass('bg'));
    const t = performance.now();
    world = await wm.build('bg');
    took = performance.now() - t;
  });
  assert.equal(world.builtVersion, 0);
  assert.ok(took >= 1400 && took < 4000, `waited ${took} ms`);
  assert.match(warned[0], /overlay unavailable for "bg": no answer within 1500 ms/);
});

test('behind the loading gate the build waits past 1500 ms for a slow answer, and takes it', async () => {
  const { wm } = manager({ running: false, provider: () => sleep(2200).then(() => ({ version: 5 })) });
  wm.register(worldClass('gated'));
  assert.equal((await wm.build('gated')).builtVersion, 5);
});

test('behind the gate the ceiling is 8 s, not for ever: a hanging provider cannot hold the boot', async () => {
  const src = await readCode('src/worlds/WorldManager.js');
  assert.match(src, /^const OVERLAY_GATE_MS = 8000;/m, 'the gate ceiling is not 8000 ms (owner decision G)');
  assert.match(src, /^const OVERLAY_BACKGROUND_MS = 1500;/m, 'the background race is not 1500 ms (spec §4.1)');
  let took = 0;
  let world;
  const warned = await quietly(async () => {
    const { wm } = manager({ running: false, provider: never });
    wm.overlayGateMs = 300; // the same fuse, shortened so the test does not wait 8 s
    wm.register(worldClass('hang'));
    const t = performance.now();
    world = await wm.build('hang');
    took = performance.now() - t;
  });
  assert.equal(world.builtVersion, 0);
  assert.ok(took >= 280, `resolved after ${took} ms`);
  assert.match(warned[0], /no answer within 300 ms/);
});

test("the provider is read from the manager's ctx, so one set after a world was constructed still reaches its build", async () => {
  const { wm, ctx } = manager();
  wm.register(worldClass('late'));
  wm.getWorld('late'); // its ctx copy was spread before any provider existed
  ctx.overlayProvider = async () => ({ version: 3 });
  assert.equal((await wm.build('late')).builtVersion, 3);
});
```

- [ ] **Step 2: Run** the file → the six new tests fail (`builtVersion` stays 0; no warning; no wait).

- [ ] **Step 3: Implement** in `src/worlds/WorldManager.js`:

(a) after `const clamp01 = …`:
```js
/**
 * How long a build waits for the overlay provider (spec §4.1, owner
 * decision G). Behind the loading gate (`engine.running` false) a wait costs
 * nothing visible and a cold serverless function needs seconds, so the
 * ceiling is generous but FINITE: a hanging fetch must not hold the boot for
 * ever, and it would fail frame-gaps as `timedOut` rather than as itself. In
 * the player's frames - a prefetch, or a portal forcing its destination - the
 * world is wanted now, and 1.5 s is the most a held gateway may wait for it.
 */
const OVERLAY_GATE_MS = 8000;
const OVERLAY_BACKGROUND_MS = 1500;
const OVERLAY_TIMED_OUT = Symbol('overlay timed out');
```

(b) in the constructor, after `this._active = null;`:
```js
    /** The provider ceilings, on the instance so a test can shorten one. */
    this.overlayGateMs = OVERLAY_GATE_MS;
    this.overlayBackgroundMs = OVERLAY_BACKGROUND_MS;
    /** Worlds whose overlay failure has been said. @type {Set<string>} */
    this._overlayWarned = new Set();
```

(c) in `_runBuild`, between `await report(0, …)` and `await world.ensureBuilt(report)`:
```js
      // The overlay, from whatever provides one (spec §4.1). Asked here, before
      // the world builds and inside the scratch-physics window, because stage
      // 3's primitives will consult it as they build; today only its version
      // is kept, on the world, for the report.
      world.builtVersion = await this._overlayVersion(world);
```

(d) after `_runBuild`:
```js
  /**
   * The overlay version this build consumes: what `ctx.overlayProvider`
   * answers for the world, or 0.
   *
   * Reads THE MANAGER'S ctx, not the world's: `getWorld` spreads a copy per
   * world, and main.js sets the provider on the shared object after the
   * worlds exist. No provider means no await and no timer - seven headless
   * suites build worlds through this class with nothing on ctx, and the
   * slicing test counts every frame a build hands back.
   *
   * A failure or a timeout is a world with no overlay, which is what every
   * world was before this existed: said once per world, and MapOverlay still
   * applies named-object entries live after the build.
   *
   * @param {import('./World.js').World} world
   * @returns {Promise<number>}
   */
  async _overlayVersion(world) {
    const provider = this.ctx?.overlayProvider;
    if (typeof provider !== 'function') return 0;
    const limit = this.engine?.running ? this.overlayBackgroundMs : this.overlayGateMs;
    let timer = null;
    try {
      const lookup = Promise.resolve().then(() => provider(world.id));
      const fuse = new Promise((resolve) => { timer = setTimeout(() => resolve(OVERLAY_TIMED_OUT), limit); });
      const doc = await Promise.race([lookup, fuse]);
      if (doc === OVERLAY_TIMED_OUT) {
        this._overlayUnavailable(world.id, `no answer within ${limit} ms`);
        return 0;
      }
      return Math.max(0, Math.floor(Number(doc?.version) || 0));
    } catch (err) {
      this._overlayUnavailable(world.id, err?.message ?? err);
      return 0;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  _overlayUnavailable(id, why) {
    if (this._overlayWarned.has(id)) return;
    this._overlayWarned.add(id);
    console.warn(`[WorldManager] overlay unavailable for "${id}": ${why}; building without it`);
  }
```

- [ ] **Step 4: Run** the file → 8 pass (≈ 6 s wall: the two timing cases). Then the suites that build through the real manager, so the short-circuit is proved where it matters: `node --test scripts/tests/station-build-slicing.test.mjs scripts/tests/world-crossing.test.mjs scripts/tests/world-warm-slicing.test.mjs` → all pass, unchanged counts. Then the chunk gates on this commit: `npm test 2>&1 | tail -12` → `# pass N + 24` (Chunks 1–2: 16; this file: 8), `# fail 0`; `node scripts/contract-check.mjs` → `132/132`; `npx vite build` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/worlds/World.js src/worlds/WorldManager.js scripts/tests/map-overlay-provider.test.mjs scripts/contract-check.mjs
git commit -m "A world build asks for its overlay, and records the version it built against

WorldManager._runBuild now awaits ctx.overlayProvider between the first
progress report and the build, and keeps the answer's version on the world
as builtVersion - the number that says which document a cached world
reflects, and the field the report needs before stage 3 gives the build
anything to do with the entries. With nothing on ctx there is no await and
no timer: the headless suites and the slicing test build exactly as before.
Behind the loading gate the wait is capped at 8 s, so a hanging fetch cannot
hold the boot; in the player's frames - a prefetch, a portal forcing its
destination - at 1.5 s. Either way a failure is a world built with no
overlay, said once per world, which is what every world was until now.

The provider is read from the manager's ctx and not the per-world copy,
because main.js sets it after the worlds exist; a test pins that.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 3.3: `MapOverlay.lookup` / `prefetch` — one cached fetch per build, refreshed by every entry (gap 6)

**Files:**
- Modify: `src/systems/MapOverlay.js` (constructor; `_read`; `dispose`; a new section before "Moving")
- Test: `scripts/tests/map-overlay.test.mjs` (a new section after "Fetching")

- [ ] **Step 1: Write the failing tests**

```js
/* ------------------------------------------------------------------ */
/* The document a build consults                                       */
/* ------------------------------------------------------------------ */

test('lookup fetches a world once and answers from the cache after that; an entry refreshes the cache', async () => {
  // A function overlay, so the second GET serves a NEW document object: `setup(doc(...))` hands one object out
  // by reference and `makeFetch` returns that same object, so mutating its `version` would pass the refresh
  // assertion below whether or not `_read` ever wrote the cache.
  let current = doc([moveCrate]);
  const rig = setup(() => current);
  const a = await rig.system.lookup('station');
  const b = await rig.system.lookup('station');
  assert.equal(a.version, 1);
  assert.equal(b, a);
  assert.equal(rig.fetchImpl.calls.length, 1);
  // The admin saved; the player enters. The entry's no-store read is what a volatile rebuild must see next.
  current = doc([moveCrate], { version: 2 });
  await enter(rig);
  assert.equal(rig.fetchImpl.calls.length, 2, 'an entry still reads afresh, once');
  assert.equal((await rig.system.lookup('station')).version, 2, 'a rebuild after a save would build against the stale document');
  assert.equal(rig.fetchImpl.calls.length, 2);
});

test('two lookups in flight share one GET, and prefetch is a lookup nobody awaits', async () => {
  const rig = setup(doc([]));
  rig.system.prefetch('station');
  const [a, b] = await Promise.all([rig.system.lookup('station'), rig.system.lookup('station')]);
  assert.equal(a, b);
  assert.equal(rig.fetchImpl.calls.length, 1);
});

test('a failed lookup answers null and caches nothing, so the next one asks again', async () => {
  const rig = setup(doc([]), { fail: true });
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await rig.system.lookup('station'), null);
    assert.equal(await rig.system.lookup('station'), null);
  } finally {
    console.warn = warn;
  }
  assert.equal(rig.fetchImpl.calls.length, 2);
});

test('a late read answering an OLDER version than the cache holds does not overwrite it: the cache is version-monotonic', async () => {
  // 9b16768's race, seen from the cache: the station's FIRST GET (v1) is held; the player portals away and back;
  // the return visit's GET (v2) answers at once and is cached; then v1 lands. The applier drops it by visit number,
  // but `_read` writes the cache BEFORE that guard runs - so the write itself must refuse to go backwards, or a
  // later build of this world (the maze's every entry) would consult v1 and report builtVersion 1 against an
  // applied v2, and every {id} entry would read pending-rebuild after a reload that changed nothing.
  let release;
  const held = new Promise((r) => { release = r; });
  let stationGets = 0;
  const v1 = doc([moveCrate], { version: 1 });
  const v2 = doc([{ ...moveCrate, position: { x: -50, y: 1, z: 8 } }], { version: 2 });
  const rig = setup(async (worldId) => {
    if (worldId !== 'station') return doc([], { world: worldId });
    if (++stationGets === 1) { await held; return v1; }
    return v2;
  });
  const station = solid(rig.physics, rig.world);
  const medieval = solid(rig.physics, makeWorld('medieval'));

  await activate(rig, station, { settle: false }); // GET #1 is held in flight
  await activate(rig, medieval);
  await activate(rig, station);
  assert.equal((await rig.system.lookup('station')).version, 2, 'precondition: the return visit cached v2');

  release();
  await new Promise((r) => setTimeout(r, 0)); // GET #1's continuation runs to its end

  assert.equal((await rig.system.lookup('station')).version, 2, 'the stale v1 overwrote v2 in the cache');
  assert.equal(rig.fetchImpl.calls.filter((c) => c.method === 'GET' && /world=station/.test(c.url)).length, 2, 'lookup did not answer from the cache');
});
```

- [ ] **Step 2: Run** the file → the four fail (`lookup is not a function`).

- [ ] **Step 3: Implement** in `src/systems/MapOverlay.js`:

(a) constructor, after `this._placed = [];`:
```js
    /**
     * Per-world documents for the BUILD (spec §4.1): filled by `lookup`,
     * refreshed by every post-build read. Per session and per world - it
     * cannot be keyed on a version the client has not fetched yet.
     * @type {Map<string, object>}
     */
    this._cache = new Map();
    /** Lookups in flight, so two callers for one world share one GET. @type {Map<string, Promise<object|null>>} */
    this._inflight = new Map();
```

(b) in `_read`, replace `return data && typeof data === 'object' ? data : null;` with:
```js
      if (!data || typeof data !== 'object') return null;
      // The document a later build of this world should consult (a volatile
      // rebuild after an in-session save). Version-monotonic: this runs on
      // the same late continuation `_onWorldChanged` drops by visit number,
      // and a slow first read can answer an OLDER version after a return
      // visit cached a newer one. Versions are append-only on the site (a
      // revert writes a new, higher one), so higher is always newer.
      const have = this._cache.get(worldId);
      if (!(Number(have?.version) > (Number(data.version) || 0))) this._cache.set(worldId, data);
      return data;
```

(c) a new section before `/* Moving */`:
```js
  /* ------------------------------------------------------------------ */
  /* The document a build consults                                       */
  /* ------------------------------------------------------------------ */

  /**
   * The world's document for `WorldManager._runBuild` (`ctx.overlayProvider`,
   * wired in main.js): the cached one, or one fetch shared by everyone asking.
   * A failure answers null and caches nothing, so the next build asks again.
   * One fetch per build plus one per entry (`_read`, which refreshes this) -
   * spec §6.4's "one cached fetch per world per session" as built.
   * @param {string} worldId
   * @returns {Promise<object|null>}
   */
  lookup(worldId) {
    const cached = this._cache.get(worldId);
    if (cached) return Promise.resolve(cached);
    let inflight = this._inflight.get(worldId);
    if (!inflight) {
      inflight = this._read(worldId).finally(() => this._inflight.delete(worldId));
      this._inflight.set(worldId, inflight);
    }
    return inflight;
  }

  /** Start a lookup so the entry world's fetch overlaps the loading gate (main.js, before the entry build). */
  prefetch(worldId) {
    void this.lookup(worldId).catch(() => null);
  }
```

(d) `dispose()`: after `this._restore();` add `this._cache.clear(); this._inflight.clear();`.

- [ ] **Step 4: Run** `node --test scripts/tests/map-overlay.test.mjs` → all pass (+4). The `asks the server for the overlay of the world that was just entered` case still sees exactly one GET: the rig has no provider, so an entry costs one read (gap 6: the count is one per BUILD plus one per ENTRY, and this rig builds nothing). Then `npm test 2>&1 | tail -12` → `# pass N + 28`, `# fail 0`; `node scripts/contract-check.mjs` → `132/132` (the MapOverlay entry gains `lookup`/`prefetch` in Task 3.6; nothing it pins today moved); `npx vite build` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/systems/MapOverlay.js scripts/tests/map-overlay.test.mjs
git commit -m "MapOverlay keeps a per-world document for the build, refreshed by every entry

The build path needs a document before the world exists and the applier
needs a fresh one after; lookup answers the first from a per-session cache
or one shared fetch, and the applier's no-store read on every entry writes
that cache, so a volatile rebuild after an in-session save builds against
what was saved rather than the document from boot. The write never goes
backwards: a slow first read can answer an older version after a return
visit cached a newer one (the race 9b16768 dropped at the applier), and a
build must not consult it. A failure caches nothing. prefetch is the same
lookup with nobody awaiting it, for the entry world to overlap the loading
gate.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 3.4: `main.js` — the provider on the manager's ctx, gated on the session, before the entry build (gap 5)

**Files:**
- Modify: `src/main.js` (inside `boot()`, between `const startWorld = …` at `:1242` and `loader.setStatus('Generating worlds', 0.3);` at `:1243`)
- Test: `scripts/tests/map-overlay-provider.test.mjs`

- [ ] **Step 1: Write the failing pin** (append to the provider test):

```js
test("main.js sets the provider on the manager's ctx, gated on the session, before the entry build, and prefetches the entry world", async () => {
  const src = await readCode('src/main.js');
  const boot = src.slice(src.indexOf('async function boot()'));
  const provider = boot.indexOf('worldManager.ctx.overlayProvider = (id) => accountStatePromise.then((account) => (account ? mapOverlay.lookup(id) : null));');
  const prefetch = boot.indexOf('accountStatePromise.then((account) => { if (account) mapOverlay.prefetch(startWorld); });');
  const build = boot.indexOf('await worldManager.build(startWorld');
  assert.ok(provider > 0, "the provider is not set on worldManager.ctx inside boot(), or is not gated on accountStatePromise - an anonymous boot would wait on a 401");
  assert.ok(prefetch > 0, 'the entry world is not prefetched, so its fetch no longer overlaps the loading gate');
  assert.ok(build > 0 && provider < build && prefetch < build, 'the provider or the prefetch lands after the entry build, which then builds at version 0');
  // Two lines other suites pin must not have moved with this edit.
  assert.match(src, /new MapOverlay\(\{ bus, physics, loot, engine, forceLayout: overrides\.layout === 'sample' \}\)/, 'the MapOverlay constructor line changed');
  assert.match(boot, /if \(overrides\.prefetch === 'all'\) scheduleBackgroundBuilds\(startWorld\);/, 'the eager-chain line changed');
});
```

- [ ] **Step 2: Run** → fails (`provider > 0` false).

- [ ] **Step 3: Implement.** In `src/main.js`, inside `boot()`, directly after `const startWorld = overrides.startWorld || 'station';`:

```js
    /* The overlay reaches the build (spec §4.1). The provider goes on the
     * manager's OWN ctx - the object the worlds were spread from, which is
     * why _runBuild reads this.ctx and never world.ctx - and is gated on the
     * session: /api/game/map-overlay is 401 for a player who is not signed
     * in, so an anonymous boot (the frame-gaps harness, a preview) waits only
     * on the session answer - a fetch started at module load and, by the
     * time materials.warmup has finished, long since resolved. A new await
     * the boot did not have before this, measured at zero cost.
     * `accountStatePromise` is that answer; `hydrateAccountSession` runs
     * AFTER the entry build and cannot be the gate. The prefetch is not
     * awaited - the build's own await joins it. */
    worldManager.ctx.overlayProvider = (id) => accountStatePromise.then((account) => (account ? mapOverlay.lookup(id) : null));
    accountStatePromise.then((account) => { if (account) mapOverlay.prefetch(startWorld); });
```

- [ ] **Step 4: Run** `node --test scripts/tests/map-overlay-provider.test.mjs scripts/tests/map-overlay-layout.test.mjs scripts/tests/world-prefetch.test.mjs` → all pass (the ctor regex and the `scheduleBackgroundBuilds` pin included). Then `npm test 2>&1 | tail -12` → `# pass N + 29`, `# fail 0`; `node scripts/contract-check.mjs` → `132/132`; `npx vite build` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/main.js scripts/tests/map-overlay-provider.test.mjs
git commit -m "The boot hands the overlay to every world build, for a signed-in player only

main.js sets worldManager.ctx.overlayProvider before the entry build and
prefetches the entry world's document so its fetch overlaps the loading
gate. Both are gated on accountStatePromise, the session answer started at
module load: the game's overlay GET is 401 when signed out, so an anonymous
boot - the frame-gaps harness, a preview - asks for nothing and builds at
version 0 without waiting. hydrateAccountSession could not be the gate; it
runs after the entry build.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 3.5: `builtVersion` on the report and both POSTs; `{id}` entries reported (decision D)

**Files:**
- Modify: `src/systems/MapOverlay.js` (`_onWorldChanged`'s no-document publish; `_applyDocument`; `_reportBack`)
- Test: `scripts/tests/map-overlay.test.mjs` (two cases + the word pin), `scripts/tests/map-overlay-layout.test.mjs` (one case)

- [ ] **Step 1: Write the failing tests.** In `map-overlay.test.mjs`, after the "Removing" section:

```js
/* ------------------------------------------------------------------ */
/* Build-time targets and the built version                           */
/* ------------------------------------------------------------------ */

test('an {id} entry is reported pending-rebuild when the document is newer than the build, else id; nothing is applied for it', async () => {
  const idMove = { kind: 'move', id: 'i1', target: { id: 'rock@5,-7' }, position: { x: 1, y: 1, z: 1 } };
  const idRemove = { kind: 'remove', id: 'i2', target: { id: 'rock@5,-8' } };
  const rig = setup(doc([idMove, idRemove, moveCrate], { version: 3 }));
  rig.world.builtVersion = 2;
  await enter(rig);
  assert.deepEqual(rig.system.report.unresolved, [{ id: 'i1', reason: 'pending-rebuild' }, { id: 'i2', reason: 'pending-rebuild' }]);
  assert.deepEqual(rig.world.crate.position.toArray(), [40, 3, -20], 'the named move beside them still applies');
  rig.world.builtVersion = 3;
  await enter(rig);
  assert.deepEqual(rig.system.report.unresolved, [{ id: 'i1', reason: 'id' }, { id: 'i2', reason: 'id' }]);
  assert.equal(rig.system.report.builtVersion, 3);
});

test('the report carries builtVersion beside appliedVersion - 0 for a world that has none - on the POST and the bus', async () => {
  const rig = setup(doc([moveCrate], { admin: true }));
  await enter(rig);
  assert.equal(rig.fetchImpl.calls.find((c) => c.method === 'POST').body.builtVersion, 0);
  assert.equal(rig.system.report.builtVersion, 0);
  rig.world.builtVersion = 4;
  await enter(rig);
  assert.equal(rig.fetchImpl.calls.filter((c) => c.method === 'POST').at(-1).body.builtVersion, 4);
  assert.equal(rig.bus.emitted.filter((e) => e.name === 'map-overlay:applied').at(-1).payload.builtVersion, 4);
});
```
In the word-pin test's field list add the triple `['id', /target\?\.id\b/, /\{ id: string \}/]` (the schema side as code too: `includes('id')` would be true of every identifier with `id` in it). In `map-overlay-layout.test.mjs`, after test (b):
```js
test('builtVersion rides on BOTH reports of a visit, and neither report carries a schema field', async () => {
  const rig = setup(doc([], { admin: true }));
  rig.world.builtVersion = 6;
  await enter(rig);
  await finish(rig);
  const posts = rig.fetchImpl.posts();
  assert.equal(posts.length, 2);
  assert.deepEqual(posts.map((p) => p.body.builtVersion), [6, 6]);
  assert.equal('schema' in posts[1].body, false, 'the report has no schema: the layout axis is layoutSchema and a bump there erases every stored grid');
  assert.equal(posts[1].body.layoutSchema, 1);
});
```

- [ ] **Step 2: Run** both files → the three new cases and the pin fail.

- [ ] **Step 3: Implement** in `src/systems/MapOverlay.js`:

(a) a helper after `_layoutFields`:
```js
  /** What the world's BUILD consumed (`WorldManager._runBuild`); 0 for a world built with no provider or before the field existed. */
  _builtVersion(world) {
    return Math.max(0, Math.floor(Number(world?.builtVersion) || 0));
  }
```
(b) `_onWorldChanged`'s no-document publish → `this._publish({ world: id, version: 0, builtVersion: this._builtVersion(world), applied: [], unresolved: [], objects: [] })`.

(c) `_applyDocument`: before the loop, `const version = Number(document.version) || 0; const builtVersion = this._builtVersion(world);`; inside the `try`, before the dispatch:
```js
        // An {id} target is a build-time prop. Nothing resolves one until stage
        // 3's registry, so it is reported and never applied: pending-rebuild
        // when the document is newer than the build (a reload could consume
        // it), else id - the honest word, not a label that promises a reload
        // will fix it (owner decision D).
        if ((entry.kind === 'move' || entry.kind === 'remove') && typeof entry?.target?.id === 'string') {
          unresolved.push({ id: String(entry.id ?? ''), reason: version > builtVersion ? 'pending-rebuild' : 'id' });
          continue;
        }
```
and the report object → `const report = { world: id, version, builtVersion, applied, unresolved, objects };`.

(d) `_reportBack` body: after `appliedVersion: report.version,` add `builtVersion: report.builtVersion ?? 0,`.

- [ ] **Step 4: Run** `node --test scripts/tests/map-overlay.test.mjs scripts/tests/map-overlay-layout.test.mjs` → all pass (+2, +1). Then `npm test 2>&1 | tail -12` → `# pass N + 32` (16 + provider 9 + cache 4 + these 3), `# fail 0`; `node scripts/contract-check.mjs` → `132/132`; `npx vite build` → exit 0. Update `CONTRACTS.md`: the `map-overlay:applied` row's payload → `` `{world, version, builtVersion, applied, unresolved, objects}` ``, and directly under the event table add:

```
**Overlay provider (map editor stage 2).** `main.js` sets `worldManager.ctx.overlayProvider = (worldId) => Promise<{version, entries, admin} | null>` on the manager's own ctx before the entry build, gated on the session. `WorldManager._runBuild` awaits it before `ensureBuilt` (no provider: no await; 8 s behind the loading gate, 1.5 s otherwise) and stores `world.builtVersion` (0 when none). The report POST carries `builtVersion` beside `appliedVersion`; it carries no `schema`.
```

- [ ] **Step 5: Commit**

```bash
git add src/systems/MapOverlay.js scripts/tests/map-overlay.test.mjs scripts/tests/map-overlay-layout.test.mjs CONTRACTS.md
git commit -m "The report says which version the world was built against, and names build-time targets honestly

Both reports of a visit carry builtVersion beside appliedVersion: a cached
world was built against whatever existed at build time, and the editor can
now tell "enter the world" from "reload it". An entry with an id target is
a build-time prop nothing resolves before stage 3, so it is reported and
never applied - pending-rebuild when the document is newer than the build,
id otherwise, rather than a label promising a reload that would change
nothing. The report carries no schema field: the layout axis is
layoutSchema, and moving it would erase every stored grid.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 3.6: The other callers of a build — a portal, a volatile rebuild, WorldPrefetch (gaps 3, 4)

**Files:** `scripts/tests/map-overlay-provider.test.mjs`, `scripts/contract-check.mjs` (`:102-106`, `:963-967`)

- [ ] **Step 1: Write the tests** (they should pass on the code from Tasks 3.2–3.3; they pin the decisions):

```js
test("a portal forcing an unbuilt destination in the player's frames gets the 1500 ms rule, and the crossing still completes", async () => {
  let took = 0;
  let there;
  await quietly(async () => {
    const { wm } = manager({ running: true, provider: never });
    wm.register(worldClass('here')).register(worldClass('there'));
    await wm.activate('here');
    const t = performance.now();
    there = await wm.activate('there'); // _activate -> build('there') -> _runBuild, engine.running true
    took = performance.now() - t;
  });
  assert.ok(took >= 1400 && took < 4000, `the crossing took ${took} ms`);
  assert.equal(there.builtVersion, 0);
  assert.equal(there.active, true);
});

test('a volatile world re-reads the provider on every request, and its builtVersion follows the answer', async () => {
  let version = 1;
  const asked = [];
  const { wm } = manager({ provider: async (id) => { asked.push(id); return { version }; } });
  wm.register(worldClass('mazelike', { volatile: true }));
  assert.equal((await wm.build('mazelike')).builtVersion, 1);
  version = 2;
  assert.equal((await wm.build('mazelike')).builtVersion, 2, 'the rebuilt world kept the version of the build it threw away');
  assert.equal(asked.length, 2);
});

test('a preparation started by WorldPrefetch waits on the provider like any background build, and no longer than the fuse', async () => {
  await quietly(async () => {
    let answer;
    const { wm } = manager({ running: true, provider: () => new Promise((r) => { answer = r; }) });
    wm.register(worldClass('near'));
    const gate = (target) => ({ portals: [{ target, position: { x: 5, y: 0, z: 0 } }], holdPreviews() {} });
    const pf = new WorldPrefetch({ portals: gate('near'), player: { position: { x: 0, y: 0, z: 0 } }, prepare: (id) => wm.build(id).then(() => undefined), isVolatile: (id) => wm.isVolatile(id) });
    pf.update();
    assert.equal(pf.isPrepared('near'), true, 'the poller did not start the world in range');
    setTimeout(() => answer({ version: 9 }), 200);
    await pf.started.get('near');
    assert.equal(wm.getWorld('near').builtVersion, 9);

    // A stalled provider holds the gateway for the fuse and no longer (memory: "gateways held until prepared").
    const stalled = manager({ running: true, provider: never });
    stalled.wm.register(worldClass('far'));
    const pf2 = new WorldPrefetch({ portals: gate('far'), player: { position: { x: 0, y: 0, z: 0 } }, prepare: (id) => stalled.wm.build(id).then(() => undefined) });
    const t = performance.now();
    pf2.update();
    await pf2.started.get('far');
    const took = performance.now() - t;
    assert.ok(took >= 1400 && took < 4000, `the preparation took ${took} ms`);
    assert.equal(stalled.wm.getWorld('far').builtVersion, 0);
  });
});
```
(`World.onActivate` sets `this.active = true` — verify at `src/worlds/World.js` around `:170-176` before relying on `there.active`; if the field is named differently, assert `wm.active === there` instead.)

- [ ] **Step 2: Run** the file → all pass (12 tests, ≈ 10 s). Run `node --test scripts/tests/world-prefetch.test.mjs` → unchanged, passes.

- [ ] **Step 3: Contract pins.** In `scripts/contract-check.mjs`: the WorldManager entry's `methods` → `['register', 'build', 'activate', '_overlayVersion']` (precedent: `Piloting._resolveSurfaceWorld`, `:896`); the MapOverlay entry's `methods` → `['dispose', 'update', 'lookup', 'prefetch']`. Run `node scripts/contract-check.mjs` → `132/132`.

- [ ] **Step 4: Gates.** `npm test 2>&1 | tail -12` → `# pass N + 16 + 12 + 4 + 2 + 1 = N + 35` (Chunks 1–2: 16; provider file: 12; cache: 4; `{id}`/report: 2; layout: 1), `# fail 0`. `npx vite build` → 0. Record in `counts.md`.

- [ ] **Step 5: Commit**

```bash
git add scripts/tests/map-overlay-provider.test.mjs scripts/contract-check.mjs
git commit -m "Every way a world gets built goes through the overlay seam, and the seam is pinned

A portal forcing its destination, a WorldPrefetch preparation and a
volatile rebuild all reach _runBuild in the player's frames, so all three
take the 1.5 s rule; the tests drive each through the real WorldManager
and the real poller, and the stalled case shows a held gateway waits for
the fuse and no longer. contract-check pins _overlayVersion and
MapOverlay.lookup/prefetch beside the entries main.js already relies on.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 3.7: Bundle

- [ ] `cd site && node scripts/bundle-game.mjs && cd .. && git add site/public/game` and commit:
```
Bundle: the build asks for its overlay

The built game with the provider seam in WorldManager._runBuild, the
session-gated wiring in main.js, MapOverlay's lookup cache and the
builtVersion on the report, re-copied into the site. Measured in chunk 5
against the cold base taken before this chunk, on the harness's anonymous
boot (the static server answers the session fetch 404, the provider
answers null): one new await on a fetch that resolved long before the
build began. A signed-in boot additionally waits on one overlay GET behind
the loading gate, bounded by OVERLAY_GATE_MS - a design claim the harness
cannot exercise, not a measurement.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## Chunk 4: Site — `built_version`, the report, the panel, the game GET pin

Spec §7 (storage), decision C; gap 2 (the game GET's schema, and that its 401 is silent in `_read` — `src/systems/MapOverlay.js:287` returns null on `!res.ok`, the warning is only in the catch). Site-only; no Bundle.

**Facts you build on (verified).** `map_world_reports` was created with six columns (`site/lib/mapOverlay.ts:151-160`) and gained `layout`/`layout_schema` by two `ALTER TABLE … ADD COLUMN IF NOT EXISTS` (`:163-170`); `ensureMapOverlaySchema` is memoised as a promise (`:125-179`) and `resetMapOverlaySchemaMemo` forgets it. The upsert (`:455-485`) binds seven params; `mapOverlay.test.ts` pins `params[5]` (the patch) and `params[6]` (the layout schema) — a new `$8` appended keeps both. `readWorldReport` (`:489-509`) nulls a layout below `LAYOUT_SCHEMA`. The report route whitelists body fields (`site/app/api/admin/map/report/route.ts:54-57`, `:80-89`). The admin GET's `report` literal is type-pinned so a new field is a compile error until the literal grows (`site/app/api/admin/map/[world]/route.ts:102-106`). `MapEditorPanel` compares only `appliedVersion` to `savedVersion` (`site/components/MapEditorPanel.tsx:647`). `site/.env.test.local` exists here, so `mapOverlay.test.ts`'s integration block RUNS on this machine against `aether_test` and is SKIPPED in CI.

### Task 4.1: The column, the upsert, the read

**Files:**
- Modify: `site/lib/mapOverlay.ts` (`:87-98`, `:167-170`, `:455-485`, `:489-509`)
- Modify: `site/lib/mapOverlay.test.ts` (`:61`, `:288-293`, new cases)

- [ ] **Step 1: Write the failing tests.** In `site/lib/mapOverlay.test.ts`: `PLAIN` (`:61`) → `{ appliedVersion: 1, builtVersion: 0, objects: [], applied: [], unresolved: [] }`; the three inline reports in the integration block that do NOT spread `PLAIN` — `:248-253`, `:258-266` and `:278-283` — each gain `builtVersion: 0,` after `appliedVersion` (test files are type-checked, and `builtVersion` becomes required in Step 3); the integration column check (`:292`) → `expect.arrayContaining(['layout', 'layout_schema', 'built_version'])`; in the integration suite add:
```ts
  it('stores builtVersion, reads it back, and replaces it on every report whatever the layout did', async () => {
    await recordWorldReport(db, WORLD, { ...PLAIN, builtVersion: 3, layoutSchema: 1, bounds: BOUNDS, shapes: [], ground: ground(100) });
    expect((await readWorldReport(db, WORLD))?.builtVersion).toBe(3);
    await recordWorldReport(db, WORLD, { ...PLAIN, builtVersion: 5 });
    const after = await readWorldReport(db, WORLD);
    expect(after?.builtVersion).toBe(5);
    // The layout merge is untouched by it: a layout-less second report keeps the ground the first one stored.
    expect(after?.layout?.ground).toEqual(ground(100));
  });
```
and, after the `recordWorldReport — the SQL it emits` describe, the everywhere-proofs:
```ts
/** The third column, and the SQL that carries it - pinned on the recording client because CI never runs the DDL. */
describe('built_version', () => {
  it('ensure adds built_version with ADD COLUMN IF NOT EXISTS and a default, after the layout columns', async () => {
    resetMapOverlaySchemaMemo();
    const db = makeFakeDb();
    await ensureMapOverlaySchema(db);
    expect(db.matching('ALTER TABLE map_world_reports').map((q) => flat(q.sql))).toEqual([
      "ALTER TABLE map_world_reports ADD COLUMN IF NOT EXISTS layout JSONB NOT NULL DEFAULT '{}'::jsonb",
      'ALTER TABLE map_world_reports ADD COLUMN IF NOT EXISTS layout_schema INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE map_world_reports ADD COLUMN IF NOT EXISTS built_version INTEGER NOT NULL DEFAULT 0',
    ]);
    resetMapOverlaySchemaMemo();
  });

  it('the upsert binds built_version as the eighth parameter, clamped, and replaces it outright - never under the layout CASE', async () => {
    const db = makeFakeDb();
    await recordWorldReport(db, 'test-overlay-sql', { ...PLAIN, builtVersion: 3.7 });
    const q = db.only('INSERT INTO map_world_reports');
    expect(flat(q.sql)).toContain('layout_schema, built_version, reported_at)');
    expect(flat(q.sql)).toContain('$7, $8, NOW())');
    expect(flat(q.sql)).toContain('built_version = EXCLUDED.built_version,');
    expect(q.params[7]).toBe(3);
    expect(q.params[6]).toBe(0);
    for (const [raw, clamped] of [[-1, 0], ['x', 0], [undefined, 0], [12, 12]] as const) {
      db.clear();
      await recordWorldReport(db, 'test-overlay-sql', { ...PLAIN, builtVersion: raw as unknown as number });
      expect(db.only('INSERT INTO map_world_reports').params[7], String(raw)).toBe(clamped);
    }
  });

  it('readWorldReport reads it back, and 0 for a row written before the column', async () => {
    const row = { applied_version: 2, objects: [], applied: [], unresolved: [], layout: {}, layout_schema: 0, reported_at: '2026-08-28T00:00:00.000Z' };
    const five = makeFakeDb((sql) => (sql.startsWith('SELECT applied_version') ? [{ ...row, built_version: 5 }] : undefined));
    expect((await readWorldReport(five, 'w'))?.builtVersion).toBe(5);
    const old = makeFakeDb((sql) => (sql.startsWith('SELECT applied_version') ? [row] : undefined));
    expect((await readWorldReport(old, 'w'))?.builtVersion).toBe(0);
  });
});
```

- [ ] **Step 2: Run** `cd site && npx vitest run lib/mapOverlay.test.ts` → the three fake-db cases and the new integration case fail, and so does the existing `adds the layout columns…` (its column check now names `built_version`) — five red here, where the DB block runs; four in CI, where it skips. (vitest does not typecheck, so the extra `builtVersion` keys are inert until Step 3 makes them required.)

- [ ] **Step 3: Implement** in `site/lib/mapOverlay.ts`:

(a) `WorldReport` (`:87-93`): add `/** The overlay version the world's BUILD consumed (spec §7); 0 when none. Stored beside `appliedVersion`, replaced on every report. */ builtVersion: number;` after `appliedVersion`.

(b) after the `layout_schema` ALTER (`:167-170`):
```ts
      // Stage 2: which version the world was BUILT against, beside which one it applied.
      await db.query(`
        ALTER TABLE map_world_reports
          ADD COLUMN IF NOT EXISTS built_version INTEGER NOT NULL DEFAULT 0
      `);
```
Update the ensure's doc comment (`:127`) to "add the layout and built_version columns".

(c) the upsert (`:455-485`): column list → `(world_id, applied_version, objects, applied, unresolved, layout, layout_schema, built_version, reported_at)`; VALUES → `($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, NOW())`; in the SET, before `reported_at = NOW()`:
```sql
           -- A report says what its build consumed; it does not merge. Plain replace, outside the layout CASE.
           built_version   = EXCLUDED.built_version,
```
and append the eighth parameter after the layout-schema one: `Math.max(0, Math.floor(Number(report.builtVersion) || 0)),`.

(d) `readWorldReport`: SELECT `…, layout, layout_schema, built_version, reported_at`; result adds `builtVersion: Number(row.built_version ?? 0),` after `appliedVersion`.

- [ ] **Step 4: Run** `cd site && npx vitest run lib/mapOverlay.test.ts` → all pass (+3 everywhere, +1 in the integration block on this machine). `cd site && npx tsc --noEmit` → reports exactly: the GET literal (`[world]/route.ts:103-106`, missing `builtVersion`) and the report route's `recordWorldReport` call (`report/route.ts:80-89`) — fixed in 4.3 and 4.2. Any report in `mapOverlay.test.ts` means an inline report from Step 1 was missed. Do not commit yet.

### Task 4.2: The report route forwards it

**Files:** `site/app/api/admin/map/report/route.ts` (`:54-57`, `:80-89`); `site/lib/mapAdminRoutes.test.ts` (in `POST /api/admin/map/report`)

- [ ] **Step 1: Failing test**
```ts
  it('forwards builtVersion to the store explicitly, and 0 when the game did not send one', async () => {
    signedInAs(ADMIN);
    await post({ ...REPORT, builtVersion: 4 });
    expect(store.recordWorldReport.mock.calls[0][2].builtVersion).toBe(4);
    await post(REPORT);
    expect(store.recordWorldReport.mock.calls[1][2].builtVersion).toBe(0);
  });
```
- [ ] **Step 2: Run** `cd site && npx vitest run lib/mapAdminRoutes.test.ts` → fails (`undefined`).
- [ ] **Step 3: Implement.** Body type: add `builtVersion?: unknown;` after `appliedVersion?: unknown;`. In the `recordWorldReport` call add `builtVersion: Number(body.builtVersion) || 0,` after `appliedVersion`. (Clamp-never-refuse: the store floors and clamps; an absent field is 0, which is what a pre-stage-2 game sends.)
- [ ] **Step 4: Run** → passes (+1).

### Task 4.3: The admin GET's sixth field

**Files:** `site/app/api/admin/map/[world]/route.ts` (`:98-107`); `site/lib/mapAdminRoutes.test.ts` (`:209-227`)

- [ ] **Step 1: Failing test.** In the `returns the stored layout and its age…` case, the `report` fixture gains `builtVersion: 1` and, after `expect(body.report).toEqual(report);`, add `expect(body.report.builtVersion).toBe(1);`. Update the comment above it: "…must see exactly the six fields it now reads (stage 2 added `builtVersion`)". Add a case:
```ts
  // The "row written before the column" half is proved at the store (Task 4.1's readWorldReport case); this proves the route forwards the number it was given.
  it('forwards builtVersion 0 from the store as 0, not undefined', async () => {
    signedInAs(ADMIN);
    store.readWorldReport.mockResolvedValue({ appliedVersion: 2, builtVersion: 0, objects: [], applied: [], unresolved: [], reportedAt: '2026-08-27T10:00:00.000Z', layout: null });
    const body = await (await get()).json();
    expect(body.report.builtVersion).toBe(0);
  });
```
- [ ] **Step 2: Run** → the first fails (`body.report.builtVersion` undefined; `toEqual` also fails on the missing key).
- [ ] **Step 3: Implement.** The literal → 
```ts
    // The annotation is load bearing: a SEVENTH field on this literal is a type error, not a wider `report`.
    const report: WorldReport | null = stored && {
      appliedVersion: stored.appliedVersion, builtVersion: stored.builtVersion, objects: stored.objects, applied: stored.applied,
      unresolved: stored.unresolved, reportedAt: stored.reportedAt,
    };
```
- [ ] **Step 4: Run** `cd site && npx vitest run lib/mapAdminRoutes.test.ts` → all pass (38 today — 35 `it(`s plus the three-row `it.each` at `:531` — + 1 in 4.2 + 1 here = **40**). `cd site && npx tsc --noEmit` → the panel's `WorldResponse.report` is `WorldReport | null` and compiles; if anything else reports, fix it here.

### Task 4.4: The game GET serves the constant over migrated entries (gap 2)

**Files:** `site/lib/mapAdminRoutes.test.ts` — the existing `describe('GET /api/game/map-overlay')` at `:602-637`, which already pins the 401 before the store, `admin: false` / `true`, and the 404. The route itself (`site/app/api/game/map-overlay/route.ts:53-59`) is unchanged: it already answers `schema: MAP_OVERLAY_SCHEMA` over `readCurrentOverlay`'s `rowEntries`-normalised entries; the two cases below make the decision permanent. (A separate file would restate the three cases that describe already holds.)

- [ ] **Step 1: Write the two cases** — append inside that describe, and add `import { MAP_OVERLAY_SCHEMA, normaliseOverlayEntries } from '@/lib/mapOverlaySchema';` at the top of the file (real modules; nothing mocks them):
```ts
  /**
   * `readCurrentOverlay` migrates every row on the way out (`rowEntries` → `normaliseOverlayEntries`), so the entries
   * the game receives are always the CURRENT schema's shape whatever the row was written under - and the number beside
   * them must say so. The row's own `schema` stays what it was, as history, on the admin read; the game never sees it.
   * Signed out is the 401 above, which the game's `_read` treats as "no overlay" without a word.
   */
  it('serves the CONSTANT schema over migrated entries: a v1 row holding a hidden move arrives as schema 2 with a remove', async () => {
    signedInAs('player@example.com');
    const entries = normaliseOverlayEntries([{ kind: 'move', id: 'h1', target: { name: 'crate' }, hidden: true }]).entries;
    store.readCurrentOverlay.mockResolvedValue({ worldId: 'station', version: 4, schema: 1, entries, author: null, note: null, createdAt: null });
    const body = await (await get()).json();
    expect(body).toEqual({ world: 'station', schema: 2, version: 4, entries: [{ kind: 'remove', id: 'h1', target: { name: 'crate' } }], admin: false });
    expect(MAP_OVERLAY_SCHEMA).toBe(2);
  });

  it('answers 503 when the store fails, so the world stays enterable with no overlay', async () => {
    signedInAs('player@example.com');
    store.readCurrentOverlay.mockRejectedValue(new Error('down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await get()).status).toBe(503);
    } finally {
      error.mockRestore();
    }
  });
```
- [ ] **Step 2: Run** `cd site && npx vitest run lib/mapAdminRoutes.test.ts` → all pass on the first run (40 + 2 = **42**; the route already does this — if a case fails, the route, not the test, is wrong). Record the count.

### Task 4.5: The panel's two "behind" states; the e2e seed

**Files:** `site/lib/mapEditorState.ts` (+ test); `site/components/MapEditorPanel.tsx` (`:643-660`); `site/scripts/map-editor-e2e.mjs` (`:278-296`, and after step 6)

- [ ] **Step 1: Failing test** (append to `mapEditorState.test.ts`, importing `versionStatus`):
```ts
describe('versionStatus', () => {
  it('tells "enter the world" (applied lags) from "reload the world" (built lags), and says when the page is behind', () => {
    expect(versionStatus(3, 3, 3)).toEqual({ applied: '(current)', built: '(current)' });
    expect(versionStatus(2, 2, 3)).toEqual({ applied: '(behind — enter the world in game)', built: '(behind — reload the world in game)' });
    expect(versionStatus(3, 2, 3)).toEqual({ applied: '(current)', built: '(behind — reload the world in game)' });
    expect(versionStatus(4, 4, 3)).toEqual({ applied: '(ahead of this page — reload the editor)', built: '(ahead of this page — reload the editor)' });
  });
});
```
- [ ] **Step 2: Implement** in `mapEditorState.ts` (after `unresolvedText`):
```ts
/**
 * The report card's two version lines. `applied` lags when the world was entered before the save (enter it again);
 * `built` lags when the world was BUILT before it - a cached world, which only a reload rebuilds (spec §7).
 */
export function versionStatus(applied: number, built: number, saved: number): { applied: string; built: string } {
  const word = (n: number, behind: string) => (n === saved ? '(current)' : n < saved ? behind : '(ahead of this page — reload the editor)');
  return { applied: word(applied, '(behind — enter the world in game)'), built: word(built, '(behind — reload the world in game)') };
}
```
Run `cd site && npx vitest run lib/mapEditorState.test.ts` → 48.

- [ ] **Step 3: The panel.** Import `versionStatus`. Replace the `Applied version` line (`:647`) with:
```tsx
                <div>Applied version <b>{report.appliedVersion}</b> {versionStatus(report.appliedVersion, report.builtVersion, savedVersion).applied}</div>
                <div>Built version <b>{report.builtVersion}</b> {versionStatus(report.appliedVersion, report.builtVersion, savedVersion).built}</div>
```
(There is no "layout: unavailable" banner state — spec §14 records that the site cannot tell it apart; the built line is what replaces it, gap 1 of §10 as built.)

- [ ] **Step 4: The e2e seed.** In `syntheticReport()` add `builtVersion: 0,` after `appliedVersion: 0,`. Then add step 7 after the save step (`:778`). Everything it calls is already in scope inside the same `try` block: `choose` (the dropdown, as step 3 does at `:722`), `clickSel`, `waitFor`, `evaluate`, `textOf`, `call`, `waitForSelector`, `q`, `shot`, `step`, `abortReason`, `msg` and `savedVersion` from step 6, and `worldSel` declared by step 2 at `:666`. The reload is step 2's own sequence (`:663-678`), repeated here:
```js
    /* ---- 7. remove a reported object, save, and see the REMOVE row survive a reload ---- */
    await choose('[data-e2e="object-select"]', 'o:e2e:post');
    await waitFor(async () => (await textOf('[data-e2e="sel-name"]'))?.includes('e2e:post'), { what: 'the selection panel to show e2e:post' });
    await clickSel('[data-e2e="remove"]');
    const removeRow = `[...document.querySelectorAll('[data-e2e="pending-row"]')].some(li => li.textContent.includes('e2e:post') && li.textContent.includes('REMOVE'))`;
    await waitFor(() => evaluate(removeRow), { what: 'a REMOVE row for e2e:post' });
    await waitFor(() => evaluate(`!${q('[data-e2e="save"]')}.disabled`), { what: 'Save to be enabled after the conflict pass' });
    await clickSel('[data-e2e="save"]');
    const msg2 = await waitFor(async () => {
      const m = await textOf('[data-e2e="message"]');
      /* Not step 6's message: save() clears it synchronously, but the poll must not read it for the frame it survives. */
      if (m?.startsWith('Saved version') && m !== msg) return m;
      if (m && !m.startsWith('Saved version')) { abortReason = `save refused: ${m}`; return false; }
      return null;
    }, { what: 'the second save message', timeout: 60000 });
    assert(Number(/Saved version (\d+)/.exec(msg2)[1]) === savedVersion + 1, `second save: ${msg2}`);
    /* The same reload-and-settle step 2 does: a new document has a new performance.timeOrigin. */
    const t1 = await evaluate('performance.timeOrigin');
    await call('Page.reload');
    await waitFor(async () => (await evaluate('performance.timeOrigin')) !== t1, { what: 'the reloaded document' });
    await waitForSelector(worldSel, 'the editor');
    if (WORLD !== 'station') {
      await waitFor(() => evaluate(`!${q(worldSel)}.disabled`), { what: 'the initial load to finish before switching world' });
      await choose(worldSel, WORLD);
      await waitFor(() => evaluate(`(() => { const el = ${q(worldSel)}; return el.value === ${JSON.stringify(WORLD)} && !el.disabled; })()`), { what: `the ${WORLD} load to finish` });
    }
    await waitFor(async () => /^Saved \(v\d+\)$/.test((await textOf('[data-e2e="save"]')) ?? ''), { what: 'the Save button to settle after the reload' });
    await waitFor(() => evaluate(removeRow), { what: 'the REMOVE row after a reload' });
    await shot('08-removed');
    step('removed', 'e2e:post removed, saved, and still removed after a reload');
```
This harness cannot run without `MAP_E2E_EMAIL`/`MAP_E2E_PASSWORD` (it exits 2, `SKIPPED — not a pass`); the credentialed run stays the owner's, as in stage 1. Run `node site/scripts/map-editor-e2e.mjs` once to see the skip and that the file still parses.

### Task 4.6: Gates, the local Postgres run (the manual gate), commit

- [ ] **Step 1: Site gates.** `cd site && npx tsc --noEmit` → 0. `cd site && npx vitest run 2>&1 | tail -6` → `Tests  866 passed` on a clean run (857 + `built_version` 3 + integration 1 + report route 1 + admin GET 1 + game GET 2 + versionStatus 1), or 866 minus the baseline failure set in `counts.md` with every `lib/map*.test.ts` green; CI's number is 866 − 18 = 848 (the 17 integration `it`s plus the new one skip there). `cd site && npm run build:site-only` → 0.

- [ ] **Step 2: The DB-gated block, for real (decision C).** CI never runs the DDL. Run `cd site && npx vitest run lib/mapOverlay.test.ts --reporter=verbose 2>&1 | tee E:/markc/gametestai/gametestai/.probe/map-editor-stage2/db-run.txt` (`--reporter=verbose` because the default reporter prints no test names; the `tee` target is the main checkout's `E:/markc/gametestai/gametestai/.probe/`, which the worktree does not have). The readable gate is the `Tests` line: it must read `32 passed (32)` with no `skipped` (28 today + 3 fake-db + 1 integration); where the database is absent it reads `15 passed | 17 skipped`, and a skip is NOT a pass. With verbose output, `adds the layout columns…` and `stores builtVersion…` must both be listed `✓`. If `aether_test` is unreachable, fix the connection (`site/.env.test.local`, `POSTGRES_TEST_URL`) and run again. Then read the columns back through the same `pg` the tests use — `psql` is not on this machine's PATH and `POSTGRES_TEST_URL` lives only in `site/.env.test.local`, which the test's `testUrl()` reads as a fallback. Run this through the Bash tool (Git Bash; the quoting is not PowerShell's) from `site/`, and append its table to the same `E:/markc/gametestai/gametestai/.probe/map-editor-stage2/db-run.txt`:
```bash
cd site && node -e '
const { Client } = require("pg");
const line = require("fs").readFileSync(".env.test.local", "utf8").split(/\r?\n/).find((l) => l.startsWith("POSTGRES_TEST_URL="));
const url = line.slice("POSTGRES_TEST_URL=".length).trim().replace(/^["\x27]|["\x27]$/g, "");
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
c.connect()
  .then(() => c.query("SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position", ["map_world_reports"]))
  .then((r) => { console.table(r.rows); return c.end(); });
'
```
Expected: nine rows, the last `built_version | integer | NO | 0` after `layout` and `layout_schema`. (On a machine that has `psql`, `psql "<url>" -c "\d map_world_reports"` shows the same.)

- [ ] **Step 3: Commit**
```bash
git add site/lib/mapOverlay.ts site/lib/mapOverlay.test.ts site/app/api/admin/map/report/route.ts "site/app/api/admin/map/[world]/route.ts" \
  site/lib/mapAdminRoutes.test.ts site/lib/mapEditorState.ts site/lib/mapEditorState.test.ts \
  site/components/MapEditorPanel.tsx site/scripts/map-editor-e2e.mjs
git commit -m "The editor stores and shows which version each world was built against

map_world_reports gains built_version by a third ADD COLUMN IF NOT EXISTS,
clamped and replaced on every report outside the layout merge, read back,
forwarded by the report route and served as the sixth field of the admin
read. The report card now has two lines: applied version, which lags when
the world was entered before a save, and built version, which lags when a
cached world was built before one and only a reload rebuilds it - the
distinction the old single "behind" could not draw. Two cases beside the
game read's existing tests pin that it serves the current schema number
over entries the store has already migrated, whatever schema the row was
written under, and answers 503 rather than a broken document.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Chunk 5: Evidence, `planGrid` ceil, the as-built record

Decision H (the after-run), decision I (`planGrid`), R22 (§14), the memory note. Task 5.1 lands no code; Task 5.2 is game code and ends with a Bundle; Task 5.3 is docs.

### Task 5.1: The after-run, judged against the base from Task 3.0

- [ ] **Step 1: Cold after-run, same machine, same flags**

Run: `node scripts/frame-gaps.mjs --serve prod --cold --entry station --worlds station --events keybind,weapon,mount,interaction,movement --repeat 3 --out E:/markc/gametestai/gametestai/.probe/gaps/stage2-after`
Expected: exit 0; `E:/markc/gametestai/gametestai/.probe/gaps/stage2-after/summary.json` plus `run-1.json`, `run-2.json`, `run-3.json`. Open each `run-N.json` and assert it has `"pageErrors": []` — `summary.json` does not carry that field (`scripts/frame-gaps.mjs:2854-2858` copies only `rows`, `warm`, `layoutSampled`, `layoutWaitMs`, `layoutWorld`, `layoutEvent`, `notes`), and the gate that would fail on one (`:2685-2687`) runs only with `--gate`, which THIS command does not pass (`--cold --gate` is a valid combination — `:2665-2675`, and CI's own baseline was recorded that way — and would fail on a page error for you; either add `--gate` or read each `run-N.json` by hand). An uncaught error from the provider path shows there and nowhere else in this run.

- [ ] **Step 2: Compare within the noise floor.** In `perf.md`, put the three after-run `boot` rows (`worst`, `over`, `frames`) and `warm.programs` beside the three base rows. The verdict is "within the floor" when each after-run value lies inside the RANGE the three base runs spanned (their min–max), and `warm.programs` moved by no more than frame-gaps' own counter-drift constant (`scripts/frame-gaps.mjs:2614`, `/** How far a counter may drift…`). This run measures the NO-overlay path only: `--serve prod` serves `dist/` statically (`:2816-2829`), so `/api/game/session` answers 404, `accountStatePromise` resolves `null` (`!res.ok`, no warning), and the provider answers `null` once it does — a NEW await on the boot path (`boot()` never awaited `accountStatePromise` before the entry build; `hydrateAccountSession` runs after `activate`), but one whose fetch started at module load and was answered long before `materials.warmup` finished, so the expected delta is zero. If the boot row moves, that await is the first suspect; nothing else on the boot path changed. Do not commit code on top of an unexplained delta.

- [ ] **Step 3: Chain-warmed gate after-run**: `node scripts/frame-gaps.mjs --serve prod --gate --entry station --worlds station,medieval,maze --events entry,repeat --out E:/markc/gametestai/gametestai/.probe/gaps/stage2-gate-after` → exit 0, every `entry:*` row `pass`, no `builtBefore: false`. The chain now builds all seventeen worlds through the provider seam, but this run produces — and the gate reads `builtBefore` on (`scripts/frame-gaps.mjs:2697`) — only the `entry:medieval` and `entry:maze` rows; station is the entry world. Record the rows beside Task 3.0's.

- [ ] **Step 4: The sampler still fits its frame** (the stage-1 gate, by hand): `node scripts/frame-gaps.mjs --serve prod --entry station --worlds station --events keybind --layout-sample --out E:/markc/gametestai/gametestai/.probe/gaps/stage2-layout` — NOT `--cold`: stage 1's `{ over 0 }` came from a chain-warmed run in which the harness asks `prefetch=all` and the seventeen-world chain competes with the sampler, and the platform-baseline comment at `scripts/frame-gaps.mjs:2596-2604` says cold and chain-warmed counters "must never be compared to each other". Expected: `summary.json` `runs[0].layoutSampled === true` and the `layout` row's `over` no higher than stage 1's `0`. Record it.

- [ ] **Step 5: World-shot budgets unchanged**: `node scripts/world-shot.mjs --world station --out E:/markc/gametestai/gametestai/.probe/shots/stage2-after/station --compare E:/markc/gametestai/gametestai/.probe/shots/stage2-before/station`, then medieval and carnelian → `diff.json` shows `drawCalls`, `worldTriangles` and `programs` unchanged per view (the diff keys are `KEYS` at `scripts/world-shot.mjs:867`; `rendererTriangles` is not a budget). The applier changed nothing a shot can see; a delta here is a wrong world photographed — the noise the phase-9 memory note records. Paste the diff tables into `perf.md`.

### Task 5.2: `planGrid` floor → ceil (decision I)

**Files:** `src/systems/GroundSampler.js` (`:56`); `scripts/tests/ground-sampler.test.mjs` (`:36-39`, a new case)

`nx`/`nz` are header-carried (`LayoutGround.nx/nz`, `site/lib/mapLayout.ts:33`), decoded from the header, and `validateGround` accepts up to `MAX_GRID_AXIS` (400) — so a one-sample-wider grid changes no schema and every stored grid still reads. With `floor`, up to `step − ε` of the far edge reads `no-ground` (stage-1 record).

- [ ] **Step 1: Failing test.** In `scripts/tests/ground-sampler.test.mjs`, the 1300 m case (`:38-39`) → `{ originX: -650, originZ: -650, step: 6, nx: 218, nz: 218 }` (1300/6 = 216.67 → ceil 217 + 1); and add a NEW test after the `planGrid` test so it reports on its own:
```js
test('the far edge of the world is inside the last cell, never past it', () => {
  // 10 m at a 4 m step is samples at 0, 4, 8, 12 (ceil), not 0, 4, 8 (floor), which left the strip from 8 to 10
  // reading no-ground. Exact multiples do not change: 80/4 is still 21, the station's 1488/6 still 249.
  assert.deepEqual(planGrid(box(0, 0, 0, 10, 5, 10)), { originX: 0, originZ: 0, step: 4, nx: 4, nz: 4 });
});
```
(The station `1488/6 = 248`, medieval `900/4 = 225`, and the layout rig's `80/4 = 20` are exact and keep `249`, `226`, `21`.)
- [ ] **Step 2: Run** `node --test scripts/tests/ground-sampler.test.mjs` → 2 failing tests: the existing `planGrid` test at its 1300 m case (actual `nx: 217`, expected 218; node:test stops that test at its first thrown assertion) and the new one (actual `{ nx: 3, nz: 3 }`).
- [ ] **Step 3: Implement.** `src/systems/GroundSampler.js:56` → `return { originX: min.x, originZ: min.z, step, nx: Math.ceil(w / step) + 1, nz: Math.ceil(d / step) + 1 };` and in the doc comment above `planGrid` add: `Samples run to the first multiple of `step` at or past the far edge, so no strip of the world reads no-ground for want of a sample.`
- [ ] **Step 4: Run** `node --test scripts/tests/ground-sampler.test.mjs scripts/tests/map-overlay-layout.test.mjs` → pass; `npm test 2>&1 | tail -12` → `# pass N + 36` (one new test), `# fail 0`; `node scripts/contract-check.mjs` → `132/132` (GroundSampler's entry pins exports only, `scripts/contract-check.mjs:971-974`); `npx vite build` → exit 0; `cd site && npx vitest run lib/mapLayoutContract.test.ts` → passes (`LAYOUT_SCHEMA` untouched).
- [ ] **Step 5: Commit, then Bundle**
```bash
git add src/systems/GroundSampler.js scripts/tests/ground-sampler.test.mjs
git commit -m "The ground grid reaches the far edge of the world

planGrid took the floor of extent over step, so up to one step short of the
far edge had no sample and read no-ground on the map. The ceiling puts the
last sample at or past the edge. nx and nz travel in the grid's own header,
so nothing about the wire format or LAYOUT_SCHEMA moves and every stored
grid still reads.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
cd site && node scripts/bundle-game.mjs && cd .. && git add site/public/game
git commit -m "Bundle: the ground grid's far edge

The built game with planGrid's ceiling, re-copied into the site. The
sampler's per-frame budget is unchanged; the grid is at most one sample
wider on each axis.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 5.3: Spec §14 stage-2 block, the memory note, the execution record

**Files:** `docs/superpowers/specs/2026-08-27-map-editor-graphical-design.md` (`:4`, after `:487`); the memory directory's stage-1 note (`map-editor-stage1-aug-2026.md` — as built, the stage-2 block was appended there, not to a new file) and `MEMORY.md` (one line); this plan (the tail)

- [ ] **Step 1: The status line** (`:4`) → `**Status:** Stages 1 and 2 built (§14 records where the tree departs from the sections above); stage 3 (`PropRegistry`, planets, dock) next.`

- [ ] **Step 2: Append to §14** — every departure, verified against the tree you just built (adjust any number that differs from what you measured):

```markdown
### Stage 2, 2026-08-28

Executed from `docs/superpowers/plans/2026-08-28-map-editor-stage2.md` on one branch of the merged tree, after the collider-leak/late-document hotfixes (`8afa2a2`, then `9b16768`; bundles `cfe1320`, `1e020b9`). Where the tree differs from §1–§13, the tree is right.

**§4.1 Provider.** `_runBuild` awaits `ctx.overlayProvider` between its first progress report and `ensureBuilt`, with an **8 s ceiling behind the loading gate** — not "no timeout": a hanging fetch must not hold the boot, and would fail frame-gaps as `timedOut` rather than as itself — and **1 500 ms otherwise**. "Otherwise" includes a portal forcing an unbuilt destination (`_activate → build`) and every `WorldPrefetch` preparation, so a stalled provider delays a gateway's readiness by at most 1.5 s per world. No provider on ctx: no await and no timer. The provider and the entry prefetch are gated on the session (`accountStatePromise`, the module-load `/api/game/session` answer); an anonymous boot — the harness, a preview — builds at `builtVersion 0`, and its only new wait is on that module-load session fetch, already resolved — measured at zero delta in chunk 5. Failure is said once per world. §6.4's "one cached fetch per world per session" is, as built, **one lookup per build plus one `no-store` read per entry**, and the entry's read refreshes the build cache so a volatile rebuild after an in-session save builds against the saved document.

**§5 Schema.** `hidden` migrates to `remove` on read for BOTH v1 shapes, the position discarded (production held 0 overlay rows when this was decided). A revert re-saves, so it writes the migrated document under schema 2. `{id}` targets are accepted (`family@x,z[#n]`, namespaced, ≤ 128, refused not truncated) and reported `unresolved: pending-rebuild` when `document.version > world.builtVersion`, else `id`; **`unresolved-target` is deferred to stage 3** with `props[]`, and an `{id}` entry is judged for bounds only. The game reads `hidden: true` as a remove **for one release** — the deploy window: the game bundle ships inside the site deploy, so the only window is a browser still running the previous bundle, which skips removes until it reloads (the §5 v1-client rule). The game GET serves the constant `MAP_OVERLAY_SCHEMA` over entries the store has already migrated; a row's own `schema` is history on the admin read only. The game warns once on a document newer than it reads.

**§6.3 Colliders.** Tolerance **0.10 m per axis**: authored medieval collider boxes overhang their walls by 4–8 cm (whole-mass boxes +0.08/+0.06 m, shell walls +0.04..0.06 m — understand.json's reading), so the spec's 5 cm would have missed the whole-mass ones; 0.10 m clears every authored overhang. Excluded by TYPE: heightfields. Excluded by TAG: any collider with non-null `userData` — the inventory at the time: PlanetWorld's floor, liquid barriers and edge walls, portal plinths, landed ship hulls; `World.addSolid` and SportsWorld's `_solid` forward `opts.userData` but no call site supplies one. `solid` and `layer` are not consulted (a trigger inside a removed prop belongs to it, as the mover already treats it). A trimesh chunk that straddles the box stays — residual walls on station after a remove are a stage-3 item. More than **200** colliders inside one box is refused with `unresolved: span` and nothing hidden. `applied[].colliders === 0` on a `{name}` remove is an editor **warning** ("removed, but nothing dropped"), not §6.3's "built in place" (a station/`{id}` rule for stage 3+). The remove undo re-registers nothing: `WorldManager._activate` rebuilds physics from `world.colliders` before `world:changed`, so on a re-entry the collider is already back and after a portal the physics belongs to another world. The `add*` counts in §6.3 are the tree's exactly.

**§7 Report and storage.** The report carries **no `schema`** and `LAYOUT_SCHEMA` stays 1 (a bump erases every stored grid through the upsert's CASE); `builtVersion` rides beside `appliedVersion` on both POSTs and on `map-overlay:applied`. `built_version` is the **third** `ALTER TABLE … ADD COLUMN IF NOT EXISTS` (the layout columns were the first two), clamped, replaced on every report outside the layout CASE. `planGrid` takes the ceiling, header-carried, no schema bump.

**§9 Conflicts.** A removed target **occupies nothing** — reversing stage 1's "hidden objects occupy", which was right for hidden. The last move-or-remove of a name wins; both warn `duplicate-target`; the normaliser keeps both (no target de-duplication; §9's "keeps the last" is stale).

**§10.** There is no "layout: unavailable" banner state; the report card's `Built version` line, with "behind — reload the world in game" beside `Applied version`'s "behind — enter the world in game", is what says a cached world is stale. A 401 on the game GET is silent; only a thrown fetch is logged.

**§12.** The stage-1 cross-world collider leak (R20) and the late-document continuation (R21) were hotfixed on main before stage 2 began — R21 twice: a world-identity guard (`8afa2a2`), then a per-visit counter (`9b16768`), because a return visit A→B→A is the SAME cached world object and the first visit's late document applied on top of the return visit's. The continuation token is the visit number, never the world object. Stage 2's build cache in `_read` is version-monotonic for the same reason.

**Out of scope, recorded for stage 3:** trimesh undersides as layers; deck-edge bilinear Y; a shared `scripts/harness/cdp.mjs`; CI `--layout-sample`; `unresolved-target`; residual station walls after a remove; a frame-gaps `--overlay-fixture` so the applied path can be measured (today only the no-overlay path is).
```

- [ ] **Step 3: The memory note.** Create `map-editor-stage2-aug-2026.md` in the memory directory with: the final commits (paste them); the counts from `counts.md`; the perf verdict from `perf.md`; and the lessons — **the remove undo re-registers nothing because `_activate` owns registration** (the "re-add only what `_activate` did not" rule from the hotfix, taken to its end); **migration on read is also migration on revert** (a revert is a write); **a pin on words is satisfied by a comment** (the word pin now matches code on comment-stripped source); **the gate ceiling** (8 s, because "no timeout" fails the wrong gate); **the signed-in gate must be the module-load session promise, not `hydrateAccountSession`** (which runs after the entry build); **`Box3.setFromObject` on a district Group is the district** (the 200 cap); **the continuation token is the visit number, never the world object** (`_visit`, bumped by `_restore` — 9b16768; and any cache written on that continuation must be version-monotonic). Add one line to `MEMORY.md` under the stage-1 entry: `- [Map editor stage 2 (Aug 2026)](map-editor-stage2-aug-2026.md) — schema 2, remove by containment, the overlay provider in the build; read before touching MapOverlay, `_runBuild`, or the map editor's conflicts.`

- [ ] **Step 4: The execution record.** Append to THIS plan — `docs/superpowers/plans/2026-08-28-map-editor-stage2.md` in the worktree, tracked there since the plan commit this branch was fast-forwarded onto — an `## Execution record (as built, 2026-08-28)` section in the shape of stage 1's: per chunk, where the tree departed from the task text and why; the final counts (`npm test` `N + 36`, contract-check `132/132`, vitest `866` here / `848` in CI); the perf verdict; the final commit hashes.

- [ ] **Step 5: Commit**
```bash
git add docs/superpowers/specs/2026-08-27-map-editor-graphical-design.md docs/superpowers/plans/2026-08-28-map-editor-stage2.md
git commit -m "Design: map editor stage 2 as built — spec amendments and the execution record

Every planning document in this repo has gone stale the moment it was
executed, so the spec's §14 gains the stage-2 block: the 8 s gate ceiling
and the 1.5 s rule for portals and prefetches, the session gate, one fetch
per build plus one per entry, hidden read as a remove for one release and
the deploy window that makes that necessary, the 0.10 m tolerance, the
userData exclusion and its inventory, the 200-collider cap, no schema on
the report, the third ALTER, a removed target occupying nothing, and what
stage 3 inherits. The plan gains its execution record.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Hand back.** Every gate green on the branch tip: `npm test` (`N + 36`), `node scripts/contract-check.mjs` (`132/132`), `npx vite build`, `cd site && npx tsc --noEmit`, `cd site && npx vitest run` (866 on a clean run here / 848 in CI; the baseline failure set, if any, unchanged), `cd site && npm run build:site-only`; `git status --short` clean; `git log --oneline main..HEAD` lists the commits of Chunks 1–5 in order and nothing else (the plan commit is on `main`, below the branch point, so it does not appear). Do not push, do not merge.

## Execution record (as built, 2026-08-28)

Executed with superpowers:subagent-driven-development on `map-editor-stage2` in `E:/markc/gametestai/wt-map-stage2` — a fresh implementer per task, then a spec review and a quality review per commit, each review's fixes folded into the next task's "prior" commit. The tracker, the counts, the perf record and the as-built delta live in the main checkout's `.probe/map-editor-stage2/` (gitignored; the tracker was rebuilt once from the agents' reports after a truncating write). The tree is the source of truth and the spec's §14 "Stage 2" block carries the prose; this section lists the commits, the review-driven corrections to the task text and the shared-interfaces block above, the counts chain, the Task 5.1 verdict, and what stage 3 inherits.

**Chunk 1 (game — the applier's `remove`).**
- `e470885` A collider can say its world-space box — `Physics.colliderAabb` + its contract entry; 3508 / 131.
- `5b51900` The collider box test can tell a rotation from its transpose — 1.1's review: a corner-oracle case, `stepZ`, the unknown-type pin (a yaw-only case with unit half-extents cannot tell `|R|·h` from its transpose; the swapped-element mutant proved the new case and only it).
- `8792e60` A remove hides a named object and drops the colliders inside it — `_applyRemove` / `_collidersInside`; 3519.
- `f69d091` The remove tests pin the cap's boundary and a return visit — the 200-at-the-cap case, A→B→A through the real manager; the `>` → `>=` mutant proven; 3521.
- `ac0ae80` Bundle: the applier's remove and the collider box (stamps f69d091).
Corrections: the sweep tests `isEmpty()` before `containsBox` (three holds an empty box inside every box, and `colliderAabb` answers an empty box for an unknown type); the sweep measured 19 ns per collider, so the plan's optional index was deferred; the sub-cap container remove — a terrain tile taking every building's colliders with only a count to show for it — had no rule in the plan and became the editor's `> 8` warning (`WIDE_REMOVE_COLLIDERS`, guessed); the owner is asked whether the applier should refuse instead.

**Chunk 2 (site + game — schema v2).**
- `9680c5b` Overlay schema 2: remove is a kind, hidden is read as one, and a target may be an id — Tasks 2.1–2.5 in ONE commit (14 files), carrying chunk 1's review: the decision-F pre-pass at the applier with a NEW reason `superseded`; five tsc narrowing sites the plan did not list; game 3526, site 857.
- `4425b36` The flip's tests cover the older side, and a cut name never splits a code point — the `>` → `!==` and `actionName` mutants proven; `readName` cuts by code point.
- `cc488c8` The map editor removes an object with a button, and draws what it removed — Task 2.6 plus the carries (`KIND_COLOUR`, `draggable: false` on the removed mark, `unresolvedText` wired into the report card, the lossy-remove hint, the picker label, the `> 8` warning); site 863.
- `23a476e` A cut string never splits a code point, at every site that cuts one — `cutCodePoints` at six sites (the flip had cut at one); the `a.ok` guard; a Map index and deferred entries; site 871.
- `a2ed2cd` Bundle: the applier reads schema 2 (stamps 23a476e; the game code is 9680c5b's).
Corrections to the shared-interfaces block: (1) the applier-reasons list lacks `superseded` — there are ten reasons, not nine; (2) decision F "last in document order wins" is enforced at the APPLIER by a per-name last-action pre-pass keyed in separate `id:`/`name:` spaces, not by in-order application (in-order let a remove win in both orders); (3) `unresolvedText('pending-rebuild')` is not "applies on next world load" but the hedged "newer than the world's build — reload; ids resolve from stage 3"; (4) an `{id}` and a `{name}` on one object cannot warn each other and `{id}` entries get the bounds rule only; (5) the seven `not.toMatch(lone)` assertions this chunk wrote on JSON text were vacuous (`JSON.stringify` escapes a lone surrogate) and were re-aimed in chunk 4.

**Chunk 3 (game — the overlay reaches the build).**
- `9fd86d0` A world build asks for its overlay, and records the version it built against — 3.1 + 3.2: `World.builtVersion`, `_overlayVersion` in `_runBuild`, the provider test rig through the real manager; contract 132; 3534.
- `3d7c276` The overlay warning is once per outage, and the loader names the wait; 3537.
- `71f00ff` MapOverlay keeps a per-world document for the build, refreshed by every entry — `lookup` / `prefetch` / `_cache`, carrying the session breaker, the 10 s abort and the shared `_admit`; 3545.
- `830ff4b` The overlay cache admits only documents, and a broken provider is asked again after a minute — the half-open breaker on an injectable clock; frozen documents; `dispose()` aborts; 3550.
- `3da1a43` The boot hands the overlay to every world build, for a signed-in player only — `main.js`, the prefetch BEFORE `materials.warmup`; 3551.
- `eade073` A failed overlay read still says so, and one probe at a time asks a broken provider — `versionOf` moved to the leaf `src/systems/overlayVersion.js` (contract 133); the probe re-stamps beside the check.
- `42645a5` The report says which version the world was built against, and names build-time targets honestly — `builtVersion` on both POSTs and the bus; `{id}` → `pending-rebuild` / `id`; 3555.
- `3079d2d` The report's builtVersion is pinned on the bus, and the contract names the breaker.
- `d214fd6` Every way a world gets built goes through the overlay seam, and the seam is pinned — portal / volatile / WorldPrefetch / chain cases through the real manager and the real poller (the portal case restructured for the breaker); 3559.
- `23165c2` A lost overlay read is said once per world, and the seam's timing pins leave room for a slow machine — the composed real-lookup case (#22); 3561.
- `06353f2` Bundle: the build asks for its overlay (stamps 23165c2).
Corrections to the shared-interfaces block: (1) "warn once per world id" is once per OUTAGE per world (`_overlayWarned`, cleared by any in-fuse answer and by `dispose()`); (2) "`engine.running` → race 1500 ms" gained the session breaker — after one background timeout, background builds skip the provider for 60 s, then exactly one probes, re-stamped from its own start; a gate timeout never opens it; (3) `_overlayVersion(world, report)` takes the progress relay and the loader says "Reading the map for …"; (4) the plan's "one cached lookup per build plus one `no-store` read per entry" stands, but the freshness wording is "the last document an entry fetched", not "what was saved"; (5) `LOOKUP_ABORT_MS` 10 s is pinned above the 8 s gate fuse; (6) the `main.js` prefetch line moved above `materials.warmup`; (7) contract-check is 133 files, not 132; (8) the timing cases assert bounds with a margin, never an equality — a 1500 ms fuse asserted to the millisecond fails on a slow machine.

**Chunk 4 (site — `built_version`).**
- `5dfd1bd` The editor names every reason the game can give, and a version can never overflow the column — the chunk-2/3 carries: the escape-matching regex and its self-check, `toWellFormed`, all ten labels with `pending-rebuild` hedged, the 2147483647 cap on `applied_version`; site 877.
- `4f30c8d` The editor stores and shows which version each world was built against — Tasks 4.1–4.6; `db-run.txt` 41/41 with the column present; site 887.
- `52b182f` The editor says a world was built with no overlay, not why, and every game reason is pinned to the game's source — the review's fixes: `versionStatus`'s third built state reworded (five zero paths, one line), `APPLIER_REASON_TEXT` + `mapReasonsContract.test.ts`, the null/NaN clamp rows, the e2e's version-line reads and its Save-label wait; site 889.
Corrections to the shared-interfaces block: `versionStatus` has a third built state ("built with no overlay") the signature did not describe; the route forwards `builtVersion` on both the typed body and the named call; both version columns clamp at the INTEGER ceiling as well as at 0.

**Chunk 5 (evidence, `planGrid`, this record).**
- `0eaf5d2` The ground grid reaches the far edge of the world — `planGrid` ceil on both axes, carrying `_readRefused` (a refused read said once per world for a 5xx only), the `_read` doc, and CONTRACTS.md "labels all ten"; 3563.
- `56d0068` Bundle: the ground grid reaches the far edge, and a refused overlay read is said (stamps 0eaf5d2).
- Task 5.1 ran with no commit (`perf.md`, the after-run section).
- This commit: §14's stage-2 block, this record, the memory note (outside the repo — the stage-2 block was appended to the stage-1 note `map-editor-stage1-aug-2026.md`, not the new file Task 5.3 named, and `MEMORY.md`'s stage-1 line was extended), and the reasons-contract extractor widened to both quote styles.
Corrections: the plan's "a 401 (`!res.ok`) is silent in `_read`; only a thrown fetch warns" gained the 5xx rule — a 500 or a 503 was silent end to end.

**Counts chain (`counts.md`), in git order.** Baseline `1e020b9`: game 3503, contract 130, site 839 (the first site run showed 55 DB-suite failures — a concurrent suite on the shared `POSTGRES_TEST_URL`, not the tree). Chunk 1 closed at `ac0ae80`: 3521 / 131 / 839. Chunk 2 closed at `a2ed2cd`: 3526 / 131 / 871. Chunk 3 closed at `06353f2`: 3561 / 133 / 871. Then `5dfd1bd` (chunk 4): 3561 / 133 / 877 → `4f30c8d` (chunk 4): 3561 / 133 / 887 → `0eaf5d2` (chunk 5's own commit): 3563 / 133 / 887 → `56d0068` (its bundle, no test moves) → `52b182f` (chunk 4's closing review commit): 3563 / 133 / 889 → `4ace9a8` (this record): 3563 / 133 / 889. Chunk 4's closing commit post-dates chunk 5's own, so a count read at a chunk boundary is not the count at that chunk's last SHA: `52b182f` already carries `0eaf5d2`'s two `planGrid` tests, and `0eaf5d2` predates the reasons-contract file. The plan's `N + k` arithmetic ended +24 game tests behind the tree (review-driven cases: +3 in chunk 1, +4 in chunk 2, +14 by 3.3, +21 by 3.6) and its site figures 866 / 848 read 887 / 869 before the reasons-contract file; CI's site number, without the 18 DB-gated cases, is 871. Every gate was green at every commit: `npm test`, `node scripts/contract-check.mjs`, `npx vite build`; `tsc --noEmit`, `vitest run` (serial, sole runner), `build:site-only`.

**Task 5.1 verdict.** After-run at `52b182f` against the chunk-3 base at `a2ed2cd`. Cold boot `over` 11 / 11 / 11 inside the base's 10–12; `worst` +2.6 ms over the base max on a 4.2 s frame whose base spread was 107 ms; `warm.programs` 142 on both; counters identical; `pageErrors` none; `[boot]` stamps inside the base spread. Gate passed 3/3 with `builtBefore: true` on both entries; the one `entry:medieval` +301 ms was a single-frame one-off that two re-runs did not reproduce. 36 world views Δ0 on triangles and terminal programs. The `layout` row (`--layout-sample`) reads `over` 1 / 2 / 1 against stage 1's 0 and is UNATTRIBUTED — the same 300–400 ms no-upload frame at ~46 s appears in sampler-free chain-warmed runs on both trees; the criterion has no measured floor on this tree; an alternating A/B is the way to settle it. The signed-in boot cost is reasoned, not measured (the harness has no session).

**Recorded for stage 3:** the composed real-lookup seam (`map-overlay-provider.test.mjs` #22, a real `MapOverlay.lookup` behind a real `WorldManager`) is now tested — extend it rather than mock around it; `{id}` actions are already keyed for last-wins in their own `id:` space — keep that key when ids resolve, and add the cross-kind rule for an `{id}` and a `{name}` naming one object; the cached document and its `entries` are frozen (shallow) — freeze-the-cached-document is the stage-3 contract, and no consumer may mutate what `_admit` handed out; the shared `scripts/harness/cdp.mjs`; trimesh undersides as layers; deck-edge bilinear Y; CI `--layout-sample`; the terrain-tile refusal question (decision B); the credentialed e2e (step 7 has never run in a browser); and, smaller: remove the `hidden` arm next release, the layout-row A/B, a signed-in title-card reading, a frame-gaps `--overlay-fixture`, `unresolved-target` with `props[]`, residual station walls after a remove.

Final commits: 26 commits `81fd9ec..52b182f` (`e470885` first), so the branch tip before this record is `52b182f` (game code `0eaf5d2`, bundled as `56d0068`); this record's commit `4ace9a8` is the 27th, and one polish commit (the whole-branch review's minors, with its comment-only bundle) follows it.
