# Map editor stage 1 — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

Spec: `docs/superpowers/specs/2026-08-27-map-editor-graphical-design.md` (§12 stage 1 only).

**Goal:** The `/admin/map` editor draws a top-down map of any world from a layout the admin's own game reports (bounds, floorplan shapes, a layered physics-sampled ground grid), lets the admin select today's named objects by clicking the map or a dropdown, move them by dragging or typing (Y snapped to ground), place marketplace items by clicking, and warns before saving about underground/floating/overlapping placements — with the same checks enforced on the server.

**Architecture:** Stage 1 is purely additive on the game side — `MapOverlay` gains an `engine` and a `GroundSampler` that runs under a 2 ms/frame budget after the overlay is applied, then posts a second report carrying the layout. The site stores that layout in a new JSONB column, exposes it from the existing GET, validates every save through a pure `mapConflicts` module, and the editor becomes map-first with all geometry logic in pure modules (`mapLayout`, `mapProjection`, `mapEditorState`) so it is unit-testable without a DOM. Nothing in `src/worlds/` changes. No `{id}` targets, no `remove`, no registry — those are stages 2–5.

**Tech Stack:** Three.js game (ES modules, `node --test` + `node:assert/strict`, zero test framework by design); Next.js 16 App Router + React 19 + TS 5.7 site (`vitest`, `environment: 'node'`, includes only `lib/**/*.test.ts` and `components/**/*.test.ts`); Postgres via the existing `Db` helper; zero-dependency CDP harnesses in `scripts/`.

**Worktree:** execute in a dedicated worktree (superpowers:using-git-worktrees). Node modules are junctioned — see the memory note on stale worktrees before creating one.

---

## Conventions every task follows

- **Tests first, red then green.** Node side: `node --test scripts/tests/<name>.test.mjs`; site: `cd site && npx vitest run lib/<name>.test.ts`. Each test file opens with a header comment stating THE CLAIM and why the test is not a stub (house style, see `scripts/tests/citadel-caves.test.mjs:19-33`). Assert against real `Physics`/real route handlers, never a builder's return value.
- **Never import another `*.test.mjs`** from a test — it registers that file's tests in your process.
- **Site tests are `*.test.ts` only** — `.test.tsx` is silently skipped and `passWithNoTests` hides it. Anything that touches the DOM lives in a component that is not unit-tested; every decision it makes is delegated to a pure module that is.
- **Commit style:** sentence-case plain English describing the visible effect, no type prefix; body is why-prose; trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and nothing else. After any game-side change that must ship to the site, a separate `Bundle: …` commit re-copies the built game (`cd site && node scripts/bundle-game.mjs`).
- **Gates before a chunk is called done** (run the FULL command, read the exit code):
  - game: `npm test` (root, ~2 570 tests), `node scripts/contract-check.mjs`, `npm run build`
  - site: `cd site && npm test`, `cd site && npm run build:site-only`
  - perf (chunk 1): `node scripts/frame-gaps.mjs --out .probe/gaps/layout --layout-sample` on the production bundle; `summary.json.layoutSampled === true` and no new hitch frames vs `.probe/gaps/base`
- **Commit in the worktree. Do not push, do not merge.**

## File structure

| File | Responsibility | Chunk |
|---|---|---|
| `src/core/Config.js` (modify `applyUrlOverrides`) | parse `?layout=sample` | 1 |
| `src/systems/GroundSampler.js` (**new**, pure) | plan a grid from `bounds`, sample it against a `Physics` in time-budgeted slices, encode Int16 layers | 1 |
| `src/systems/MapOverlay.js` (modify) | accept `engine`/`forceLayout`, add `bounds`+`shapes` to every report, run the sampler after apply, post the layout report, emit `map-overlay:layout`, expose `layoutSampled` | 1 |
| `src/main.js` (modify line ~314) | pass `engine` and `forceLayout` | 1 |
| `scripts/frame-gaps.mjs` (modify) | `--layout-sample` flag → `&layout=sample`; `summary.json.layoutSampled` | 1 |
| `scripts/contract-check.mjs` (modify) | pin `GroundSampler` exports | 1 |
| `scripts/tests/ground-sampler.test.mjs`, `scripts/tests/map-overlay-layout.test.mjs` (**new**) | | 1 |
| `site/lib/mapLayout.ts` (**new**, pure) | layout types, limits, `decodeGround`, `groundAt`, `layersAt`, `validateLayout` | 2 |
| `site/lib/mapOverlay.ts` (modify) | `layout`/`layout_schema` columns, `recordWorldReport` stores a validated layout (keeps prior ground when none sent), `readWorldReport` returns `layout` + `reportedAt` | 2 |
| `site/app/api/admin/map/report/route.ts` (modify) | accept `layoutSchema`, `bounds`, `shapes`, `ground`; 413 over cap | 2 |
| `site/app/api/admin/map/[world]/route.ts` (modify GET) | return `layout`, `reportedAt` | 2 |
| `site/lib/mapLayout.test.ts`, `site/lib/mapOverlay.test.ts` (extend), `site/lib/mapAdminRoutes.test.ts` (extend) | | 2 |
| `site/lib/mapConflicts.ts` (**new**, pure) | the §9 rules for stage 1 | 3 |
| `site/app/api/admin/map/[world]/route.ts` (modify POST) | run `conflictsForDocument`; any `error` → 400, nothing written | 3 |
| `site/lib/mapConflicts.test.ts` (**new**), `site/lib/mapAdminRoutes.test.ts` (extend) | | 3 |
| `site/lib/mapProjection.ts` (**new**, pure) | world↔screen, pan/zoom about a point, hit-testing | 4 |
| `site/lib/mapEditorState.ts` (**new**, pure) | selection, move-with-snap (authored sink preserved), degrees↔radians, place-at, pending list rows, layout age text | 4 |
| `site/components/MapCanvas.tsx` (**new**, DOM) | draws layout + entries, pointer handling → callbacks; no decisions of its own | 5 |
| `site/components/MapSelectionPanel.tsx` (**new**) | dropdown, X/Y/Z/yaw°, snap toggle, layer picker, warnings, Move/Reset | 5 |
| `site/components/MapPendingList.tsx` (**new**) | pending rows with conflicts and undo | 6 |
| `site/components/MapEditorPanel.tsx` (rewrite) | state + fetches + save/revert; composes the three above | 6 |
| `site/lib/mapProjection.test.ts`, `site/lib/mapEditorState.test.ts` (**new**) | | 4 |
| `site/components/mapEditorStyles.ts` (**new**) | shared inline style constants (`clipPath: 'none'` on number inputs) | 5 |
| `site/scripts/map-editor-e2e.mjs` (**new**, zero-dep CDP) | logs in through the real form with `MAP_E2E_EMAIL`/`MAP_E2E_PASSWORD`, seeds a layout via the report route, drives the editor; exits 2 "SKIPPED — not a pass" without credentials | 7 |

## Shared interfaces (every chunk must match these exactly)

### Game → site report body (`POST /api/admin/map/report`)

Today's fields unchanged: `{ world, appliedVersion, objects, applied, unresolved }`. Stage 1 adds, all optional:

```ts
layoutSchema?: 1
bounds?: { min: {x,y,z}, max: {x,y,z} }          // world.bounds, metres
shapes?: LayoutShape[]                            // world.minimapShapes, as Minimap.js draws them
ground?: LayoutGround                             // present ONLY on the second (post-sampling) report
```

Two reports per world visit: the **immediate** one (as today + `layoutSchema`, `bounds`, `shapes`) and the **layout** one when sampling completes (same fields + `ground`). Server rule: `bounds`/`shapes` replace when present; `ground` replaces only when present and valid; a report with no layout fields leaves the stored layout untouched.

### `site/lib/mapLayout.ts`

```ts
import type { Vec3 } from './mapOverlaySchema';

export const LAYOUT_SCHEMA = 1;
export const NO_SAMPLE = -32768;                 // Int16 min = no surface in that layer
export const MAX_GRID_AXIS = 400;
export const MAX_LAYERS = 4;
export const MAX_SHAPES = 5000;
export const MAX_LAYOUT_BYTES = 4_000_000;

export interface LayoutBounds { min: Vec3; max: Vec3 }

export type LayoutShape =
  | { kind: 'rect'; x: number; z: number; w: number; d: number; rotation?: number; fill?: number | string; stroke?: number | string; width?: number }
  | { kind: 'circle'; x: number; z: number; r: number; fill?: number | string; stroke?: number | string; width?: number }
  | { kind: 'path'; points: [number, number][]; stroke?: number | string; width?: number; closed?: boolean };

export interface LayoutGround {
  originX: number; originZ: number;   // world x,z of cell (0,0)
  step: number;                       // metres between samples; = max(4, ceil(extent / 256))
  nx: number; nz: number;             // samples per axis; sample (i,j) is at (originX + i*step, originZ + j*step)
  layers: number;                     // ≤ 4; layer 0 is the TOPMOST surface
  heightsCm: string;                  // base64 of Int16 little-endian, length nx*nz*layers,
                                      // index = ((j * nx) + i) * layers + k; NO_SAMPLE pads; cm clamped to ±32767
}

export interface WorldLayout { schema: 1; bounds: LayoutBounds; shapes: LayoutShape[]; ground: LayoutGround | null }

export interface DecodedGround extends Omit<LayoutGround, 'heightsCm'> { heights: Int16Array }

export function decodeGround(g: LayoutGround): DecodedGround;              // throws on length mismatch
export function encodeHeights(h: Int16Array): string;                        // base64 LE (used by tests and the e2e seeder)
/** Nearest layer at or below `y`, chosen PER CORNER, then bilinear. A corner with no layer at/below takes its lowest; a corner with no layers is no sample → null. */
export function groundAt(g: DecodedGround | null, x: number, z: number, y: number): number | null;
/** All surfaces at the nearest sample to (x,z), top-down, metres — for the layer picker. */
export function layersAt(g: DecodedGround | null, x: number, z: number): number[];
/** Clamp/validate an untrusted layout; returns null when unusable. Never throws. */
export function validateLayout(input: unknown): WorldLayout | null;
export function validateGround(input: unknown): LayoutGround | null;
```

### `GET /api/admin/map/{world}` response

`{ world, overlay, versions, report, layout: WorldLayout | null, reportedAt: string | null }` — `report` unchanged (`{ appliedVersion, objects, applied, unresolved, reportedAt? }`).

### `site/lib/mapConflicts.ts`

```ts
import type { OverlayEntry } from './mapOverlaySchema';
import type { WorldLayout, DecodedGround } from './mapLayout';
import type { CatalogueObject } from './mapOverlay';

export type ConflictLevel = 'error' | 'warn';
export type ConflictCode = 'out-of-bounds' | 'stale-name' | 'duplicate-target' | 'underground' | 'floating' | 'no-ground' | 'overlap';
export interface Conflict { level: ConflictLevel; code: ConflictCode; detail: string; other?: string /* offending name/id */ }

export interface ConflictContext {
  layout: WorldLayout | null;
  ground: DecodedGround | null;        // decodeGround(layout.ground) once, by the caller
  objects: CatalogueObject[];          // report.objects
  placeFootprint?: (entry: PlaceEntry) => { w: number; d: number; h: number };   // default 1×1×1
}

export function conflictsFor(entry: OverlayEntry, index: number, document: OverlayEntry[], ctx: ConflictContext): Conflict[];
export function conflictsForDocument(document: OverlayEntry[], ctx: ConflictContext): Conflict[][];   // one array per entry, same order
export function hasErrors(all: Conflict[][]): boolean;
```

Stage-1 rules (from spec §9, with `{name}` targets as points):

| code | level | rule |
|---|---|---|
| `out-of-bounds` | error | layout present and x/z outside `bounds` ± 5 m (the ±20 000 limit is already the normaliser's) |
| `stale-name` | warn | move target name not in `objects[]` (only when `objects.length > 0`) |
| `duplicate-target` | warn | another entry in the document has the same move target name |
| `underground` | warn | bottom < `groundAt(x, z, y)` − 0.25; bottom = `position.y` for a move, `position.y` for a place |
| `floating` | warn | bottom > `groundAt(x, z, y)` + 1.5 |
| `no-ground` | warn | ground present and `groundAt` is null |
| `overlap` | warn | XZ distance to another occupied point < 1 m (named object not moved elsewhere by this document, or another entry); for a place, its footprint rect intersects; `other` names the offender |

With `layout === null` only `stale-name` and `duplicate-target` can fire. Save route: `hasErrors` → `400 { error: 'conflicts', rejected: [{ index, id, reason: code }] }` and nothing is written.

### Bus event and dev switch (game)

- `map-overlay:layout` emitted on the game bus when sampling for a world completes: `{ world, cells, layers, sampledMs }`.
- `mapOverlay.layoutSampled` — `true` after the current world's sampling completed (reset on `world:changed`). `frame-gaps.mjs` reads `GAME.mapOverlay.layoutSampled` into `summary.json`.
- `?layout=sample` → `applyUrlOverrides().layout === 'sample'` → `new MapOverlay({ …, forceLayout: true })`: sample even when `document.admin` is false, but **do not POST** (there is no admin session to accept it).

### `site/lib/mapEditorState.ts` (pure; the canvas and panels call these, never decide themselves)

```ts
export type Selected = { kind: 'object'; name: string } | { kind: 'entry'; key: string } | null;
export const degToRad = (d: number) => (d * Math.PI) / 180;   export const radToDeg = (r: number) => (r * 180) / Math.PI;
/** Y for a prop moved to (x,z): nearest layer at/below its current y, plus its current sink/lift (spec §8). */
export function snappedY(ground: DecodedGround | null, from: Vec3, toX: number, toZ: number): number | null;
export function layoutAgeText(reportedAt: string | null, now: Date): string;   // "reported 3 min ago" | "No layout yet — enter this world in game as admin"
```

## Chunks

1. **Game: sampler, layout report, perf gate**
2. **Site: layout storage and routes**
3. **Site: conflict detection and the save gate**
4. **Site: the map-first editor — pure modules** (`mapProjection.ts`, `mapEditorState.ts`)
5. **Site: the map canvas and selection panel** (`mapEditorStyles.ts`, `MapCanvas.tsx`, `MapSelectionPanel.tsx`)
6. **Site: pending list and the composed editor** (`MapPendingList.tsx`, `MapEditorPanel.tsx`)
7. **Site: editor end-to-end** (`map-editor-e2e.mjs`, manual checklist, gates)

Chunk 3 imports chunk 2's `mapLayout.ts`; chunks 4–7 execute in order 4 → 5 → 6 → 7 in one worktree and import 2, 3 and each other. Chunks 1 and 2 are independent and can be executed in parallel worktrees; the report body contract above is what joins them. Task numbers are per chunk except chunks 4–7, which number their tasks 1–8 continuously.


---

## Chunk 1: Game — sampler, layout report, perf gate

Skeleton: `.probe/map-editor-stage1/00-skeleton.md` (its shared interfaces are binding). Spec §7, §11, §12 stage 1.

**Load-bearing physics fact (verified, `src/physics/Physics.js:1500-1540`).** A ray whose origin is INSIDE a box collider returns `null` (`tmin` stays 0 → `if (tmin <= 0 …) return null`). So re-casting from `hit.y − 0.01` skips the slab just hit and finds the next surface down; peeling needs no per-collider bookkeeping.

**Rig facts.** `new Physics(bus)` needs no DOM harness; `addBox(cx, cy, cz, hx, hy, hz)` defaults to `layer: WORLD, solid: true`; a vertical `raycast` reads one broadphase column, origin y arbitrary. `Engine.onFrameUpdate(fn)` returns an unsubscribe; `fn(dt, elapsed)` runs only while not paused. `Config.js` has no module-scope DOM use, so `applyUrlOverrides` runs under Node with a stubbed `globalThis.location`.

### Task 1: GroundSampler — grid plan and Int16 packing

**Files:** Create `src/systems/GroundSampler.js`; Create `scripts/tests/ground-sampler.test.mjs`.

- [ ] **Step 1: Write the failing test**

```js
// scripts/tests/ground-sampler.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planGrid, createJob, encodeInt16Base64, NO_SAMPLE, MAX_LAYERS } from '../../src/systems/GroundSampler.js';

/**
 * THE GROUND GRID THE MAP EDITOR DRAWS AND VALIDATES AGAINST.
 *
 * THE CLAIM: from a world's bounds and a downward cast, the sampler produces a
 * grid whose step, extent and cell order are exactly what site/lib/mapLayout.ts
 * decodes (index ((j*nx)+i)*layers+k, layer 0 topmost, NO_SAMPLE padding, cm
 * clamped to ±32767, Int16 LE base64), in slices that stop when a time budget
 * is spent.
 *
 * Not a stub: the cast is a FUNCTION RETURNING KNOWN SURFACES, so every
 * assertion is arithmetic the site will index into; the decode is Node's
 * Buffer.readInt16LE, never the encoder's inverse, so a byte-order mistake
 * cannot cancel out. That the cast peels REAL colliders is map-overlay-layout.test.mjs's claim.
 */

/** Independent decoder: Node's Buffer, little-endian, none of the module's code. */
function decode(b64) {
  const buf = Buffer.from(b64, 'base64');
  const out = new Int16Array(buf.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}
const box = (x0, y0, z0, x1, y1, z1) => ({ min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 } });

test('the station (±744 m) plans a 6 m step and a 249×249 grid; a small world floors at 4 m', () => {
  assert.deepEqual(planGrid(box(-744, -6, -744, 744, 158, 744)),
    { originX: -744, originZ: -744, step: 6, nx: 249, nz: 249 });
  assert.deepEqual(planGrid(box(-40, -5, -40, 40, 30, 40)),
    { originX: -40, originZ: -40, step: 4, nx: 21, nz: 21 });
  assert.equal(planGrid(box(-450, 0, -450, 450, 100, 450)).nx, 226); // 900/256 → 4 m
  assert.equal(planGrid(null), null);
  assert.equal(planGrid(box(0, 0, 0, 0, 10, 0)), null, 'a degenerate box plans nothing');
});

test('Int16 little-endian base64 round-trips a hand-built array, extremes included', () => {
  const src = new Int16Array([0, 1, -1, 32767, -32768, 1234, -1234, 256]);
  const b64 = encodeInt16Base64(src);
  assert.match(b64, /^[A-Za-z0-9+/]+=*$/);
  assert.deepEqual([...decode(b64)], [...src]);
  // Byte order pinned by hand: 256 is 0x0100 → bytes 00 01 in LE.
  assert.deepEqual([...Buffer.from(encodeInt16Base64(new Int16Array([256])), 'base64')], [0x00, 0x01]);
});
```

- [ ] **Step 2: Run test to verify it fails**

`node --test scripts/tests/ground-sampler.test.mjs` → `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/src/systems/GroundSampler.js'`.

- [ ] **Step 3: Write minimal implementation** (whole module; `createJob` is a placeholder Task 2 replaces)

```js
// src/systems/GroundSampler.js
/**
 * The map editor's ground grid: where the floor is, every few metres, as the
 * physics sees it.
 *
 * PURE: no Three.js, no Physics import. A `cast(x, yTop, z, maxDrop) → y|null`
 * callback is handed in, so the arithmetic, the layering and the packing are
 * testable against known surfaces; MapOverlay owns the one line that touches
 * `Physics.raycast`.
 *
 * LAYERED, because roofs collide: the station dome is a collider, and one
 * downward cast would call it the hub's floor. Each cell keeps up to four hits
 * top-down, re-cast from a centimetre below the last - a ray that STARTS
 * INSIDE a box does not hit it (`Physics._raycastCollider`, `tmin <= 0`), so
 * the re-cast finds the next surface. Layer 0 is topmost; the rest NO_SAMPLE.
 *
 * RESUMABLE, because 62 000 cells do not fit in a frame: `run(budgetMs, now)`
 * samples until the budget is spent; MapOverlay ticks it every frame.
 *
 * Wire format (site/lib/mapLayout.ts decodes exactly this): heightsCm = base64
 * of Int16 LE, length nx*nz*layers, index ((j*nx)+i)*layers+k, sample (i,j)
 * at (originX+i*step, originZ+j*step).
 */

export const LAYOUT_SCHEMA = 1;
/** Int16 minimum: "no surface in this layer". */
export const NO_SAMPLE = -32768;
export const MAX_LAYERS = 4;
/** Never finer than 4 m, never more than ~256 samples an axis (spec §7). */
const MIN_STEP = 4;
const TARGET_CELLS = 256;
/** How far below a hit the next cast starts. */
const PEEL = 0.01;

/**
 * @param {{min:{x:number,z:number}, max:{x:number,z:number}}|null} bounds
 * @returns {{originX:number, originZ:number, step:number, nx:number, nz:number}|null}
 */
export function planGrid(bounds) {
  const min = bounds?.min;
  const max = bounds?.max;
  if (!min || !max) return null;
  const w = max.x - min.x;
  const d = max.z - min.z;
  if (!(w > 0) || !(d > 0)) return null;
  const step = Math.max(MIN_STEP, Math.ceil(Math.max(w, d) / TARGET_CELLS));
  return { originX: min.x, originZ: min.z, step, nx: Math.floor(w / step) + 1, nz: Math.floor(d / step) + 1 };
}

/**
 * Int16 → little-endian bytes → base64. Byte order written by hand, not read
 * off the typed array's buffer, so the wire format does not depend on the
 * machine; `btoa` not Buffer, so it runs in the browser.
 */
export function encodeInt16Base64(values) {
  const n = values.length;
  const bytes = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) {
    const v = values[i];
    bytes[i * 2] = v & 0xff;
    bytes[i * 2 + 1] = (v >> 8) & 0xff;
  }
  let s = '';
  // fromCharCode takes its arguments on the stack; 8 K at a time is safe everywhere.
  for (let i = 0; i < bytes.length; i += 0x2000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x2000));
  }
  return btoa(s);
}

const toCm = (metres) => Math.max(-32767, Math.min(32767, Math.round(metres * 100)));

export function createJob() {
  throw new Error('createJob: not implemented yet (Task 2)');
}
```

- [ ] **Step 4: Run test to verify it passes**

`node --test scripts/tests/ground-sampler.test.mjs` → `# pass 2`, `# fail 0`.

- [ ] **Step 5: Commit**

```
git add src/systems/GroundSampler.js scripts/tests/ground-sampler.test.mjs
git commit -m "The ground sampler plans a grid from a world's bounds and packs it as Int16" -m "The map editor needs a floor height every few metres of every world, and the only thing that knows where the floor is, is the physics in a running client. This is the pure half: a grid whose step never drops below 4 m and never exceeds ~256 samples an axis (6 m for the ±744 m station), and a little-endian Int16 base64 packing written byte by byte so the wire format does not depend on the machine that sampled it. The test decodes with Buffer, not with the encoder's inverse." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: GroundSampler — the budgeted, layered job

**Files:** Modify `src/systems/GroundSampler.js` (replace the `createJob` placeholder, last 3 lines); Modify `scripts/tests/ground-sampler.test.mjs` (append); Modify `scripts/contract-check.mjs` (`CONTRACT_V2`, after the MapOverlay entry at lines 964-968).

- [ ] **Step 1: Write the failing test** (append)

```js
/* A roof over x ≥ 0 at 20 m and a floor at 0 everywhere; the cast answers the
 * highest surface strictly below yTop and within maxDrop, like a real ray. */
const surfacesAt = (x) => (x >= 0 ? [20, 0] : [0]);
function fakeCast(x, yTop, z, maxDrop) {
  const below = surfacesAt(x).filter((h) => h < yTop && yTop - h <= maxDrop);
  return below.length ? Math.max(...below) : null;
}
const at = (g, h, i, j, k) => h[((j * g.nx) + i) * g.layers + k];
const PLAN = planGrid(box(-40, -5, -40, 40, 30, 40)); // 21×21, step 4, x = -40 + 4i

test('each cell holds its surfaces top-down in cm, NO_SAMPLE below the last, cell order (j*nx)+i', () => {
  const job = createJob(PLAN, fakeCast, { layers: 4, topY: 40, floorY: -25 });
  assert.equal(job.done, false);
  assert.equal(job.cells, 441);
  assert.equal(job.run(1e9, () => 0), true, 'an unbounded budget finishes in one run');
  assert.equal(job.done, true);
  const g = job.result();
  assert.deepEqual([g.originX, g.originZ, g.step, g.nx, g.nz, g.layers], [-40, -40, 4, 21, 21, 4]);
  const h = decode(g.heightsCm);
  assert.equal(h.length, 21 * 21 * 4);
  // (11,10): x = 4 under the roof, z = 0. (0,0): open floor. (20,20): the last cell.
  assert.deepEqual([0, 1, 2, 3].map((k) => at(g, h, 11, 10, k)), [2000, 0, NO_SAMPLE, NO_SAMPLE]);
  assert.deepEqual([0, 1, 2, 3].map((k) => at(g, h, 0, 0, k)), [0, NO_SAMPLE, NO_SAMPLE, NO_SAMPLE]);
  assert.deepEqual([0, 1].map((k) => at(g, h, 20, 20, k)), [2000, 0]);
});

test('a 400 m surface clamps to 32767 cm rather than wrapping', () => {
  const job = createJob(planGrid(box(0, 0, 0, 8, 500, 8)), () => 400, { layers: 1, topY: 510, floorY: -20 });
  job.run(1e9, () => 0);
  assert.deepEqual([...decode(job.result().heightsCm)], new Array(9).fill(32767));
});

test('the budget is a clock, not a count: budget 0 samples nothing; slices resume where they stopped', () => {
  let t = 0;
  const cast = (...a) => { t += 1; return fakeCast(...a); };   // one millisecond per cast
  const now = () => t;
  const job = createJob(PLAN, cast, { layers: 4, topY: 40, floorY: -25 });
  job.run(0, now);
  assert.equal(job.sampled, 0, 'nothing sampled with no budget');
  job.run(2, now);
  assert.ok(job.sampled >= 1 && job.sampled <= 2, `2 ms at 1 ms/cast is one cell, sampled ${job.sampled}`);
  assert.ok(job.progress > 0 && job.progress < 1);
  for (let runs = 0; !job.done && runs < 10000; runs++) job.run(2, now);
  assert.equal(job.done, true);
  assert.equal(job.sampled, 441);
  assert.equal(job.progress, 1);
  assert.equal(MAX_LAYERS, 4);
  // Same grid as the unbudgeted run: slicing changed when, never what.
  const whole = createJob(PLAN, fakeCast, { layers: 4, topY: 40, floorY: -25 });
  whole.run(1e9, () => 0);
  assert.deepEqual([...decode(job.result().heightsCm)], [...decode(whole.result().heightsCm)]);
});
```

- [ ] **Step 2: Run test to verify it fails**

`node --test scripts/tests/ground-sampler.test.mjs` → `# pass 2`, `# fail 3`, each `Error: createJob: not implemented yet (Task 2)`.

- [ ] **Step 3: Write minimal implementation** — replace the placeholder with:

```js
/**
 * A resumable sampling job over `plan`.
 * @param {{originX:number, originZ:number, step:number, nx:number, nz:number}} plan
 * @param {(x:number, yTop:number, z:number, maxDrop:number) => number|null} cast
 *   The first surface below `yTop` within `maxDrop`, or null.
 * @param {{layers?:number, topY?:number, floorY?:number}} [opts] `topY`: where
 *   each cell's first cast starts (bounds.max.y + 10 - the dome and a 260 m
 *   planet both sit above groundHeight's 200 m default); `floorY`: where it stops.
 */
export function createJob(plan, cast, { layers = MAX_LAYERS, topY = 200, floorY = -200 } = {}) {
  const { originX, originZ, step, nx, nz } = plan;
  const L = Math.max(1, Math.min(MAX_LAYERS, layers | 0));
  const total = nx * nz;
  const heights = new Int16Array(total * L).fill(NO_SAMPLE);
  let next = 0; // cell index j*nx + i; cells are sampled in wire order

  function sampleCell(i, j) {
    const x = originX + i * step;
    const z = originZ + j * step;
    const base = (j * nx + i) * L;
    let y = topY;
    for (let k = 0; k < L; k++) {
      const drop = y - floorY;
      if (!(drop > 0)) break;
      const h = cast(x, y, z, drop);
      if (typeof h !== 'number' || !Number.isFinite(h)) break;
      heights[base + k] = toCm(h);
      y = h - PEEL;
    }
  }

  return {
    plan,
    layers: L,
    cells: total,
    get done() { return next >= total; },
    get sampled() { return next; },
    get progress() { return total ? next / total : 1; },
    /** Sample until `budgetMs` of `now()` has elapsed; checked BEFORE each cell,
     *  so budget 0 samples nothing and a late frame overpays by at most one cell. */
    run(budgetMs, now) {
      const start = now();
      while (next < total && now() - start < budgetMs) {
        const i = next % nx;
        sampleCell(i, (next - i) / nx);
        next++;
      }
      return next >= total;
    },
    result() {
      return { originX, originZ, step, nx, nz, layers: L, heightsCm: encodeInt16Base64(heights) };
    },
  };
}
```

Then pin the module in `scripts/contract-check.mjs`, after the `src/systems/MapOverlay.js` entry (lines 964-968):
```js
  /* The editor's ground grid. Pure, reached only through MapOverlay, so a
   * renamed export would surface as "the editor never gets a layout" one admin
   * visit later rather than as a failed check here. */
  {
    file: 'src/systems/GroundSampler.js',
    exports: ['planGrid', 'createJob', 'encodeInt16Base64', 'NO_SAMPLE', 'MAX_LAYERS', 'LAYOUT_SCHEMA'],
  },
```

- [ ] **Step 4: Run test to verify it passes**

`node --test scripts/tests/ground-sampler.test.mjs` → `# pass 5`, `# fail 0`. `node scripts/contract-check.mjs` → `130/130 files present … All contracts satisfied.`, exit 0; rename `planGrid` → `planGridX` in the module, rerun → a missing-export line for `planGrid`, exit 1; rename back, rerun → exit 0.

- [ ] **Step 5: Commit**

```
git add src/systems/GroundSampler.js scripts/tests/ground-sampler.test.mjs scripts/contract-check.mjs
git commit -m "The ground sampler peels up to four surfaces per cell under a time budget" -m "One downward cast per cell would call the station's dome the floor of the whole hub, because the dome is a collider. Each cell now keeps up to four hits from the top down, re-cast from a centimetre below the last - a ray that starts inside a box does not hit that box, which is what makes the peel find the next surface and not the same one. The job is a clock, not a count: it samples until a millisecond budget is spent and resumes next frame, so 62 000 station cells never own a frame." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: MapOverlay takes `engine`/`forceLayout`; every report carries `bounds` and `shapes`

**Files:** Modify `src/systems/MapOverlay.js` (lines 1-3, 74, 111-127, 148-156, 199, 250-269); Create `scripts/tests/map-overlay-layout.test.mjs`.

- [ ] **Step 1: Write the failing test**

```js
// scripts/tests/map-overlay-layout.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

import { Physics } from '../../src/physics/Physics.js';
import { MapOverlay } from '../../src/systems/MapOverlay.js';
import { NO_SAMPLE } from '../../src/systems/GroundSampler.js';

/**
 * THE LAYOUT AN ADMIN'S OWN CLIENT REPORTS TO THE MAP EDITOR.
 *
 * THE CLAIM: entering a world as admin posts its bounds and floorplan shapes
 * at once, then samples the ground through the REAL Physics under a per-frame
 * budget and posts a second report whose layered grid has two surfaces under
 * a roof and one over open floor; leaving mid-sample sends nothing;
 * `?layout=sample` samples with no admin and never posts.
 *
 * Not a stub: the colliders are real `Physics.addBox` slabs and the cast is
 * `Physics.raycast`, so two-layers-under-the-roof is the real collider code's
 * peel (a ray starting inside a box misses it), not a fake's. The grid is
 * decoded with Buffer, never the game's encoder. Only bus, fetch and engine
 * are fakes, and each records what it was handed.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = async (p) => (await readFile(path.join(root, p), 'utf8')).replace(/\r\n/g, '\n');
const readCode = async (p) => (await read(p))
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

/* ---------------------------------------------------------------- rig -- */

function makeBus() {
  const handlers = new Map();
  const emitted = [];
  return {
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(fn);
      return () => handlers.get(name).delete(fn);
    },
    emit(name, payload) { emitted.push({ name, payload }); for (const fn of handlers.get(name) ?? []) fn(payload); },
    emitted,
  };
}

/** A named crate, a world box of ±40 m, and two floorplan shapes. */
function makeWorld(id = 'station') {
  const group = new THREE.Group();
  group.name = `world:${id}`;
  const crate = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
  crate.name = 'crate.alpha';
  crate.position.set(10, 0, 10);
  group.add(crate);
  group.updateMatrixWorld(true);
  const bounds = new THREE.Box3(new THREE.Vector3(-40, -5, -40), new THREE.Vector3(40, 30, 40));
  const minimapShapes = [{ kind: 'rect', x: 0, z: 0, w: 10, d: 10, fill: 0x2f2a1d },
    { kind: 'path', points: [[-40, -40], [40, 40]], stroke: 0xffffff, width: 2 }];
  return { id, group, crate, bounds, minimapShapes };
}

function makeFetch(overlay) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : null });
    if ((init?.method ?? 'GET') === 'GET') return { ok: true, status: 200, json: async () => overlay };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  fn.calls = calls;
  fn.posts = () => calls.filter((c) => c.method === 'POST');
  return fn;
}

function makeEngine() {
  const updaters = new Set();
  return { updaters, onFrameUpdate(fn) { updaters.add(fn); return () => updaters.delete(fn); },
    tick(dt = 1 / 60) { for (const fn of updaters) fn(dt, 0); } };
}

const doc = (entries, { version = 1, admin = false, world = 'station' } = {}) =>
  ({ world, schema: 1, version, entries, admin });

/**
 * A floor at y=0 across the world and a roof slab whose top is y=20 over
 * x ∈ [2, 42], so grid cell x=4 is under it and x=0 is not. `clockPerCast`
 * advances the injected clock per REAL raycast: a deterministic frame.
 */
function setup(overlay, { forceLayout = false, clockPerCast = 0 } = {}) {
  const bus = makeBus();
  const physics = new Physics(bus);
  physics.addBox(0, -1, 0, 100, 1, 100);
  physics.addBox(22, 19.5, 0, 20, 0.5, 100);
  let clock = 0;
  let casts = 0;
  const raycast = physics.raycast.bind(physics);
  physics.raycast = (...a) => { casts++; clock += clockPerCast; return raycast(...a); };
  const loot = { spawn: () => null, despawn: () => true };
  const fetchImpl = makeFetch(overlay);
  const engine = makeEngine();
  const world = makeWorld();
  const system = new MapOverlay({ bus, physics, loot, engine, fetch: fetchImpl, forceLayout, now: () => clock });
  return { bus, physics, fetchImpl, engine, world, system, casts: () => casts };
}

async function enter({ bus, system, world }) {
  bus.emit('world:changed', { id: world.id, world });
  await system.applying;
}

/** Tick frames until the current world's sampling completes, then await its POST. */
async function finish(rig) {
  for (let n = 0; n < 100000 && !rig.system.layoutSampled; n++) rig.engine.tick();
  return rig.system.sampling;
}

function decode(ground) {
  const buf = Buffer.from(ground.heightsCm, 'base64');
  const h = new Int16Array(buf.length / 2);
  for (let i = 0; i < h.length; i++) h[i] = buf.readInt16LE(i * 2);
  return h;
}
const at = (g, h, i, j, k) => h[((j * g.nx) + i) * g.layers + k];
const BOUNDS = { min: { x: -40, y: -5, z: -40 }, max: { x: 40, y: 30, z: 40 } };

/* ------------------------------------------------- the immediate report -- */

test('(a) the immediate admin report carries layoutSchema, bounds and shapes, and no ground', async () => {
  const rig = setup(doc([], { admin: true }));
  await enter(rig);
  const posts = rig.fetchImpl.posts();
  assert.equal(posts.length, 1, 'one POST before any frame has ticked');
  const body = posts[0].body;
  assert.equal(body.world, 'station');
  assert.equal(body.appliedVersion, 1);
  assert.equal(body.layoutSchema, 1);
  assert.deepEqual(body.bounds, BOUNDS);
  assert.deepEqual(body.shapes, rig.world.minimapShapes);
  assert.equal(body.ground, undefined);
  assert.ok(body.objects.some((o) => o.name === 'crate.alpha'));
});

test('a world with no bounds still reports, without a bounds field', async () => {
  const rig = setup(doc([], { admin: true }));
  delete rig.world.bounds;
  await enter(rig);
  const body = rig.fetchImpl.posts()[0].body;
  assert.equal(body.layoutSchema, 1);
  assert.equal('bounds' in body, false);
  assert.deepEqual(body.shapes, rig.world.minimapShapes);
});
```

- [ ] **Step 2: Run test to verify it fails**

`node --test scripts/tests/map-overlay-layout.test.mjs` → `# fail 2`; first: `AssertionError: Expected values to be strictly equal: undefined !== 1` (at `body.layoutSchema`).

- [ ] **Step 3: Write minimal implementation**

Lines 1-3 (the three imports) become:
```js
import * as THREE from 'three';
import { ITEMS } from './ItemDefs.js';
import { consumableItemFor } from './Marketplace.js';
import { COLLISION_LAYER } from '../physics/Physics.js';
import { planGrid, createJob, MAX_LAYERS, LAYOUT_SCHEMA } from './GroundSampler.js';
```

After line 74 `const _shift = new THREE.Matrix4();` add:
```js
/** The sampler's ray. Two scratch vectors, reused for every cast of every cell. */
const _rayOrigin = new THREE.Vector3();
const _rayDown = new THREE.Vector3();

/**
 * How much of a frame the ground sampler may take (spec §7). A clock, not a
 * ray count: a cell in a dense district costs more than one over open floor,
 * and the frame does not care which it was.
 */
const SAMPLE_BUDGET_MS = 2;
```

Lines 111-127 (the constructor JSDoc, `constructor({ bus, physics, loot, fetch: fetchImpl, endpoint, reportEndpoint } = {}) {` and its first six assignments through `this._fetch = …`) become:
```js
  /**
   * @param {{ bus: import('../core/EventBus.js').EventBus, physics?: import('../physics/Physics.js').Physics,
   *   loot?: import('./Loot.js').LootSystem, engine?: { onFrameUpdate(fn: (dt:number) => void): () => void },
   *   forceLayout?: boolean, fetch?: typeof fetch, now?: () => number, endpoint?: string, reportEndpoint?: string }} ctx
   *   `engine` ticks the ground sampler; `forceLayout` (the `?layout=sample`
   *   dev switch) samples without an admin session and never posts; `now` is
   *   the sampler's clock, injectable so a test can own the frame.
   */
  constructor({ bus, physics, loot, engine, forceLayout, fetch: fetchImpl, now, endpoint, reportEndpoint } = {}) {
    this.bus = bus ?? null;
    this.physics = physics ?? null;
    this.loot = loot ?? null;
    this.forceLayout = forceLayout === true;
    this.endpoint = endpoint ?? READ_ENDPOINT;
    this.reportEndpoint = reportEndpoint ?? REPORT_ENDPOINT;
    this._fetch = fetchImpl ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    this._now = typeof now === 'function' ? now : () => performance.now();

    /** True once the CURRENT world's ground grid has been sampled; reset on `world:changed`. */
    this.layoutSampled = false;
    /** Resolves with the `map-overlay:layout` payload, or null if the world was left first. */
    this.sampling = Promise.resolve(null);
    /** The in-flight sampling job, or null. @see update */
    this._job = null;
```

Lines 148-156 (`/** @type {Array<() => void>} */ this._offs = []; if (bus) { … }`) get this appended after the closing `}` of `if (bus)`:
```js
    /* Once, for the life of the system - not per world. Idle when there is
     * no job; frame-gaps attributes it as `u:mapOverlay` because it is named
     * `update`. Not called while the engine is paused. */
    if (engine?.onFrameUpdate) this._offs.push(engine.onFrameUpdate((dt) => this.update(dt)));
```

Line 199 `    if (document.admin) await this._reportBack(report);` → `    if (document.admin) await this._reportBack(report, world);`

`_reportBack` (lines 250-269): the signature line 250 `  async _reportBack(report) {` → `  async _reportBack(report, world, ground = null) {`, and after line 261 `          unresolved: report.unresolved,` add:
```js
          // The layout fields every report carries, and - on the second
          // report of a visit only - the sampled ground.
          ...this._layoutFields(world),
          ...(ground ? { ground } : {}),
```
Then add after `_reportBack`:
```js
  /** `world.bounds` as plain JSON and `world.minimapShapes` as Minimap.js draws them. */
  _layoutFields(world) {
    const b = world?.bounds;
    const bounds = b?.min && b?.max
      ? { min: { x: b.min.x, y: b.min.y, z: b.min.z }, max: { x: b.max.x, y: b.max.y, z: b.max.z } }
      : null;
    return {
      layoutSchema: LAYOUT_SCHEMA,
      ...(bounds ? { bounds } : {}),
      shapes: Array.isArray(world?.minimapShapes) ? world.minimapShapes : [],
    };
  }

  /** Per rendered frame. Filled in by the next commit. */
  update() {}
```

- [ ] **Step 4: Run test to verify it passes**

`node --test scripts/tests/map-overlay-layout.test.mjs` → `# pass 2`, `# fail 0`. `node --test scripts/tests/map-overlay.test.mjs` → all pass (the admin-report test asserts keys, not their absence).

- [ ] **Step 5: Commit**

```
git add src/systems/MapOverlay.js scripts/tests/map-overlay-layout.test.mjs
git commit -m "The map overlay's report carries the world's bounds and floorplan shapes" -m "The editor is about to draw a map, and the only client that knows a world's extent and its minimap floorplan is the one that built it. Every report now carries them beside the catalogue, and the system takes the engine it will need to tick the ground sampler in the next commit. The report route ignores the new fields until the site side lands; sending them first is what lets the two halves ship independently." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: MapOverlay samples the ground after apply, posts the layout, drops the job on leaving

**Files:** Modify `src/systems/MapOverlay.js` (`_onWorldChanged` 172-176 and 195-200, `_restore` 220, the `update()` stub); Modify `scripts/tests/map-overlay-layout.test.mjs` (append); Modify `CONTRACTS.md` (event table, after line 84); Modify `scripts/contract-check.mjs` (the MapOverlay entry's `methods`).

- [ ] **Step 1: Write the failing test** (append)

```js
/* ---------------------------------------------------- the layout report -- */

test('(b) after sampling, a second POST carries a grid with two layers under the roof and one elsewhere', async () => {
  const rig = setup(doc([], { admin: true }));
  await enter(rig);
  const summary = await finish(rig);
  const posts = rig.fetchImpl.posts();
  assert.equal(posts.length, 2, 'immediate report, then the layout report');
  const body = posts[1].body;
  assert.equal(body.world, 'station');
  assert.equal(body.appliedVersion, 1);
  assert.equal(body.layoutSchema, 1);
  assert.deepEqual(body.bounds, BOUNDS);
  const g = body.ground;
  assert.deepEqual([g.originX, g.originZ, g.step, g.nx, g.nz, g.layers], [-40, -40, 4, 21, 21, 4]);
  const h = decode(g);
  assert.equal(h.length, 21 * 21 * 4);
  // x = 4, z = 0: roof top at 20 m, the floor at 0, then nothing. x = 0: the roof starts at 2.
  assert.deepEqual([0, 1, 2, 3].map((k) => at(g, h, 11, 10, k)), [2000, 0, NO_SAMPLE, NO_SAMPLE]);
  assert.deepEqual([0, 1].map((k) => at(g, h, 10, 10, k)), [0, NO_SAMPLE]);
  assert.deepEqual([0, 1].map((k) => at(g, h, 0, 0, k)), [0, NO_SAMPLE]);
  assert.equal(rig.system.layoutSampled, true);
  assert.deepEqual([summary.world, summary.cells, summary.layers], ['station', 441, 4]);
  const ev = rig.bus.emitted.find((e) => e.name === 'map-overlay:layout');
  assert.ok(ev, 'map-overlay:layout was emitted');
  assert.equal(ev.payload.cells, 441);
  assert.equal(typeof ev.payload.sampledMs, 'number');
});

test('(c) one frame samples about one cell at 1 ms per cast, and the job resumes on the next', async () => {
  const rig = setup(doc([], { admin: true }), { clockPerCast: 1 });
  await enter(rig);
  assert.equal(rig.casts(), 0, 'applying the overlay casts nothing');
  rig.engine.tick(0.016);
  assert.ok(rig.casts() >= 1 && rig.casts() <= 3, `one 2 ms frame cast ${rig.casts()} rays`);
  assert.equal(rig.system.layoutSampled, false);
  assert.equal(rig.fetchImpl.posts().length, 1, 'no layout POST mid-job');
  await finish(rig);
  assert.equal(rig.fetchImpl.posts().length, 2);
  assert.ok(rig.casts() >= 441 * 2, `every cell cast at least twice, got ${rig.casts()}`);
});

test('(d) leaving the world mid-job posts no layout for it, and the promise resolves null', async () => {
  const rig = setup(doc([], { admin: true }), { clockPerCast: 1 });
  await enter(rig);
  rig.engine.tick();
  rig.engine.tick();
  assert.equal(rig.system.layoutSampled, false, 'two frames is two cells of 441');
  const first = rig.system.sampling;
  // A portal (the GET answers the station document, not this world's: no new job), then enough frames
  // to FINISH the old job if alive - ticked BEFORE the await, so a broken cancel is red, never a hang.
  rig.bus.emit('world:changed', { id: 'elsewhere', world: makeWorld('elsewhere') });
  await rig.system.applying;
  for (let n = 0; n < 2000; n++) rig.engine.tick();
  assert.equal(await first, null, 'the abandoned job resolves null');
  assert.equal(rig.fetchImpl.posts().filter((p) => p.body.ground).length, 0, 'no layout POST for a world we left');
  assert.equal(rig.system.layoutSampled, false);
  assert.ok(rig.casts() < 441 * 2, 'the old job did not keep casting after we left');
});

test('(e) forceLayout samples without an admin, emits the event, and never posts', async () => {
  const rig = setup(doc([], { admin: false }), { forceLayout: true });
  await enter(rig);
  const summary = await finish(rig);
  assert.equal(rig.system.layoutSampled, true);
  assert.equal(summary.cells, 441);
  assert.ok(rig.bus.emitted.some((e) => e.name === 'map-overlay:layout'));
  assert.equal(rig.fetchImpl.posts().length, 0, 'no admin session, so nothing to accept a POST');
});

test('a player who is neither admin nor forcing the switch never casts a ray', async () => {
  const rig = setup(doc([], { admin: false }));
  await enter(rig);
  for (let n = 0; n < 50; n++) rig.engine.tick();
  assert.equal(rig.casts(), 0);
  assert.equal(await rig.system.sampling, null);
});

test('dispose drops the frame subscription and the job', async () => {
  const rig = setup(doc([], { admin: true }), { clockPerCast: 1 });
  await enter(rig);
  rig.engine.tick();
  assert.equal(rig.engine.updaters.size, 1);
  const pending = rig.system.sampling;
  rig.system.dispose();
  assert.equal(rig.engine.updaters.size, 0);
  assert.equal(await pending, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

`node --test scripts/tests/map-overlay-layout.test.mjs` → `# fail 3` — (b) `immediate report, then the layout report` (`1 !== 2`), (c) `one 2 ms frame cast 0 rays`, (e) `false !== true` at `layoutSampled`. (d), never-casts and dispose pass already: with no job the cancel path is a no-op on `Promise.resolve(null)`; Step 4's ablation is what proves (d) can go red.

- [ ] **Step 3: Write minimal implementation**

Lines 172-176 of `_onWorldChanged`:
```js
    const document = await this._read(id);
    if (!document) {
      this._publish({ world: id, version: 0, applied: [], unresolved: [], objects: [] });
      return;
    }
```
become:
```js
    const document = await this._read(id);
    const admin = document?.admin === true;
    if (!document) {
      this._publish({ world: id, version: 0, applied: [], unresolved: [], objects: [] });
    } else {
      await this._applyDocument(id, world, document, admin);
    }

    /* The ground is sampled AFTER the overlay is applied, so a moved building's
     * colliders are where the editor will draw them. Admin, or the dev switch;
     * and only if this is still the world we are in - both awaits above are
     * places a portal can land. */
    if ((admin || this.forceLayout) && this._world === world) this._startSampling(id, world, admin);
  }

  /** Apply the entries, publish, and report. Unchanged from before the sampler. */
  async _applyDocument(id, world, document, admin) {
```
The entry loop (lines 178-193) is untouched and now lives in `_applyDocument`; in lines 195 and 199 replace `document.admin` with `admin` (the old method's closing brace now closes `_applyDocument`).

In `_restore()`, before line 221 `    this._world = null;` add:
```js
    this._cancelSampling();
    this.layoutSampled = false;
```

Replace the `update() {}` stub with:
```js
  /* ------------------------------------------------------------------ */
  /* The ground grid                                                     */
  /* ------------------------------------------------------------------ */

  /** Start a job for `world`; `post`: to the editor (admin) or only the bus (dev switch). */
  _startSampling(id, world, post) {
    this._cancelSampling();
    const plan = this.physics ? planGrid(world.bounds) : null;
    if (!plan) return;
    const job = createJob(plan, (x, yTop, z, maxDrop) => this._castDown(x, yTop, z, maxDrop), {
      layers: MAX_LAYERS,
      // The dome and a 260 m planet are both above groundHeight's 200 m default.
      topY: world.bounds.max.y + 10,
      floorY: world.bounds.min.y - 20,
    });
    job.world = id;
    job.post = post;
    job.startedAt = this._now();
    this.sampling = new Promise((resolve) => { job.resolve = resolve; });
    this._job = job;
  }

  /** The one line that touches Physics: the first WORLD surface below (x, yTop, z). */
  _castDown(x, yTop, z, maxDrop) {
    const hit = this.physics.raycast(
      _rayOrigin.set(x, yTop, z), _rayDown.set(0, -1, 0), maxDrop, COLLISION_LAYER.WORLD
    );
    return hit ? hit.point.y : null;
  }

  /** Per rendered frame. Idle unless a job is in flight; then 2 ms of it. */
  update() {
    const job = this._job;
    if (!job) return;
    job.run(SAMPLE_BUDGET_MS, this._now);
    if (job.done) {
      this._job = null;
      this._finishSampling(job);
    }
  }

  async _finishSampling(job) {
    // ~660 KB of base64 for the station, then JSON.stringify in _reportBack, all in this
    // frame: a one-off 10-20 ms `u:mapOverlay` spike at completion is expected.
    const ground = job.result();
    const summary = {
      world: job.world, cells: job.cells, layers: job.layers, sampledMs: this._now() - job.startedAt,
    };
    this.layoutSampled = true;
    this.bus?.emit?.('map-overlay:layout', summary);
    if (job.post) await this._reportBack(this.report, this._world, ground);
    job.resolve?.(summary);
  }

  /** Drop the in-flight job, if any. Its promise resolves null; nothing is posted. */
  _cancelSampling() {
    const job = this._job;
    if (!job) return;
    this._job = null;
    job.resolve?.(null);
  }
```

In `scripts/contract-check.mjs`, the MapOverlay entry's `methods: ['dispose'],` → `methods: ['dispose', 'update'],` (frame-gaps attributes the tick by that name; a rename would silently drop the row). In `CONTRACTS.md`, after the row `| \`worlds:all-ready\` | — | main |` add:
```
| `map-overlay:applied` | `{world, version, applied, unresolved, objects}` | MapOverlay |
| `map-overlay:layout` | `{world, cells, layers, sampledMs}` | MapOverlay |
```

- [ ] **Step 4: Run test to verify it passes**

`node --test scripts/tests/map-overlay-layout.test.mjs` → `# pass 8`, `# fail 0`. `node --test scripts/tests/map-overlay.test.mjs` → all pass (no engine → no ticks; the cancel in `_restore` is a no-op). `node scripts/contract-check.mjs` → `All contracts satisfied.` Prove (d) can go red: comment out `this._cancelSampling();` in `_restore`, rerun → (d) fails at `the abandoned job resolves null` (the old job finishes inside the 2000 ticks and `first` resolves its summary; the ground-POST assertion would fail too). It cannot hang: the ticks run before the await. Restore it, rerun → green.

- [ ] **Step 5: Commit**

```
git add src/systems/MapOverlay.js scripts/tests/map-overlay-layout.test.mjs CONTRACTS.md scripts/contract-check.mjs
git commit -m "An admin's client samples the ground after the overlay is applied and posts the layout" -m "The editor validates placements against a floor it has never seen, so the admin's own game measures it: a layered grid cast through the real physics, two milliseconds a frame, started after the overlay is applied so a moved building's colliders are where the map will draw them. The second report of a visit carries the grid and the first does not, so a slow sample never delays the catalogue. A portal drops the job in flight and posts nothing - a half grid is worse than the last complete one. Under the dev switch the grid goes onto the bus and nowhere else, because there is no session to accept it." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `?layout=sample` and `frame-gaps.mjs --layout-sample`

**Files:** Modify `src/core/Config.js` (line 291, inside `applyUrlOverrides`); Modify `src/main.js` (line 314); Modify `scripts/frame-gaps.mjs` (parseArgs 80 and 104, HELP ~149, boot 1188, gateRun ~2595, URL 2695-2696, summary 2747-2757); Modify `scripts/tests/map-overlay-layout.test.mjs` (append). Node cannot run frame-gaps (it needs Chrome), so the script is gated by source-grep, as `world-prefetch.test.mjs` gates it.

- [ ] **Step 1: Write the failing test** (append)

```js
/* ------------------------------------------------------ the dev switch -- */

test('?layout=sample reaches applyUrlOverrides as layout: "sample", and its absence as null', async () => {
  const { applyUrlOverrides } = await import('../../src/core/Config.js');
  const saved = globalThis.location;
  try {
    globalThis.location = { search: '?dev=1&layout=sample' };
    assert.equal(applyUrlOverrides().layout, 'sample');
    globalThis.location = { search: '?dev=1' };
    assert.equal(applyUrlOverrides().layout, null);
  } finally {
    globalThis.location = saved;
  }
});

test('main.js hands the engine and the switch to MapOverlay', async () => {
  const main = await readCode('src/main.js');
  assert.match(main, /new MapOverlay\(\{ bus, physics, loot, engine, forceLayout: overrides\.layout === 'sample' \}\)/,
    'MapOverlay is constructed without the engine or the ?layout=sample switch');
});

test('frame-gaps can switch the sampler on, waits for it, records whether it finished, and gates on that', async () => {
  const fg = await readCode('scripts/frame-gaps.mjs');
  assert.match(fg, /a === '--layout-sample'/, 'no --layout-sample flag');
  assert.match(fg, /args\.layoutSample \? '&layout=sample' : ''/, 'the flag never reaches the page URL');
  assert.match(fg, /mapOverlay\?\.layoutSampled === true/, 'the run never asks the game whether sampling finished');
  assert.match(fg, /layoutSampled: run\.layoutSampled === true/, 'summary.json runs[] do not record layoutSampled');
  const gate = fg.slice(fg.indexOf('function gateRun'));
  assert.ok(/args\.layoutSample && run\.layoutSampled !== true/.test(gate),
    'the gate does not fail a --layout-sample run whose sampler never finished');
});
```

- [ ] **Step 2: Run test to verify it fails**

`node --test scripts/tests/map-overlay-layout.test.mjs` → `# fail 3`: `undefined !== 'sample'`, `MapOverlay is constructed without the engine…`, `no --layout-sample flag`.

- [ ] **Step 3: Write minimal implementation** — the switch, the wiring, then six frame-gaps edits.

`src/core/Config.js`, after line 291 `    quality: params.get('quality') || null,` add:
```js
    /* `sample`: run the map editor's ground sampler without an admin session
     * and discard the report. For frame-gaps, which has no session and would
     * otherwise measure a run in which the sampler never starts
     * (systems/MapOverlay.js). */
    layout: params.get('layout') || null,
```
`src/main.js` line 314 `const mapOverlay = new MapOverlay({ bus, physics, loot });` →
```js
const mapOverlay = new MapOverlay({ bus, physics, loot, engine, forceLayout: overrides.layout === 'sample' });
```

(i) parseArgs defaults, line 80 `    gl: false, listeners: false, frames: false, gate: false,` →
```js
    gl: false, listeners: false, frames: false, gate: false,
    layoutSample: false, layoutTimeoutMs: 60000,
```

(ii) parseArgs flags, after line 104 `    else if (a === '--gate') out.gate = true;` add:
```js
    /* The map editor's ground sampler is admin-only, and this harness has no
     * session. Without the switch every run measures a game in which the
     * sampler never starts - and reads as proof that it costs nothing. */
    else if (a === '--layout-sample') out.layoutSample = true;
    else if (a === '--layout-timeout') out.layoutTimeoutMs = Number(next());
```

(iii) HELP, after `                     What a player who does not wait actually gets.` add:
```
  --layout-sample    boot with &layout=sample so the map editor's ground sampler
                     runs on the entry world (admin-only otherwise; a harness has
                     no session). Waited for in its own "layout" phase; summary.json
                     records layoutSampled; with --gate an unfinished sampler fails.
  --layout-timeout <ms>  how long to wait for it (default 60000)
```

(iv) boot, after line 1188 `    out.events.boot = await closePhase('boot');` add:
```js
    /* --- layout ------------------------------------------------------ */
    /* Wait for the ground sampler INSIDE the measured window, in a phase of
     * its own: the `layout` row says what its frames cost, every later row
     * says whether it disturbed them. A timeout is recorded, never hidden. */
    if (args.layoutSample) {
      await mark('layout');
      const t0 = Date.now();
      try {
        await waitFor(() => evalIn('window.GAME?.mapOverlay?.layoutSampled === true'),
          { timeout: args.layoutTimeoutMs, every: 500, what: 'the ground sampler to finish the entry world' });
      } catch (err) {
        out.notes.push(`layout sampling did not finish in ${args.layoutTimeoutMs} ms: ${err.message}`);
      }
      out.layoutSampled = await evalIn('window.GAME?.mapOverlay?.layoutSampled === true');
      out.layoutWorld = await evalIn('window.GAME?.mapOverlay?.report?.world ?? null');
      out.layoutWaitMs = Date.now() - t0;
      out.events.layout = await closePhase('layout');
      console.log(`layout sampled: ${out.layoutSampled} (${out.layoutWorld}, waited ${out.layoutWaitMs} ms)`);
    } else {
      out.layoutSampled = false;
    }
```

(v) gateRun, after the block ending `` failures.push(`${run.pageErrors.length} uncaught page error(s), first: ${run.pageErrors[0]}`);\n  } `` add:
```js
  if (args.layoutSample && run.layoutSampled !== true) {
    failures.push('the ground sampler never finished on the entry world, so its per-frame cost was'
      + ' not inside the measured window - raise --layout-timeout, or find what stalled it');
  }
```
(No `worst`/`budget`/`blockedMs` in that string: `perf-warm-keys.test.mjs` scans every `failures.push` for the clock.)

(vi) URL, lines 2695-2696:
```js
  const qs = `?dev=1&autostart=1&quality=high&world=${encodeURIComponent(args.entryWorld)}`
    + (args.awaitReady ? '&prefetch=all' : '');
```
→
```js
  const qs = `?dev=1&autostart=1&quality=high&world=${encodeURIComponent(args.entryWorld)}`
    + (args.awaitReady ? '&prefetch=all' : '')
    + (args.layoutSample ? '&layout=sample' : '');
```
Line 2747 `      runs.push({ run: i, rows, warm: run.warm });` → `      runs.push({ run: i, rows, warm: run.warm, layoutSampled: run.layoutSampled === true, layoutWaitMs: run.layoutWaitMs ?? null });`
Lines 2753-2756 (`const summary = { serve: …, runs, ...(args.gate ? … : {}), };`) become:
```js
  const summary = {
    serve: args.serve, budget: args.budget, at: new Date().toISOString(), runs,
    /* True only when EVERY run finished sampling. A run that lost the sampler
     * must not be readable as one in which it cost nothing. */
    layoutSampled: args.layoutSample && runs.every((r) => r.layoutSampled === true),
    ...(args.gate ? { gate: gated, platform: platformKey() } : {}),
  };
```

- [ ] **Step 4: Run test to verify it passes**

`node --test scripts/tests/map-overlay-layout.test.mjs` → `# pass 11`, `# fail 0`. `node --test scripts/tests/perf-warm-keys.test.mjs scripts/tests/world-prefetch.test.mjs` → pass (no clock words in the new gate string; Config's `prefetch`/`quality` lines untouched). `node scripts/frame-gaps.mjs --help` prints the two new flags.

- [ ] **Step 5: Commit**

```
git add src/core/Config.js src/main.js scripts/frame-gaps.mjs scripts/tests/map-overlay-layout.test.mjs
git commit -m "frame-gaps measures a run in which the ground sampler actually runs" -m "Sampling is admin-only and the perf harness boots with no session, so every run so far would have measured a game in which the sampler never started, and the criterion would have passed on ground it never walked - the exact shape of gate this repo has paid for nine times. ?layout=sample samples and drops the report; frame-gaps --layout-sample boots with it, waits for the sampler in a phase of its own so its frames get a row, and writes layoutSampled into summary.json beside the numbers. Under --gate a sampler that never finished is a failure, not a quiet pass." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Gates, the perf measurement, and the `Bundle:` commit

**Files:** only `site/public/game/**`, written by the bundle script. Run every command in full and read the exit code before claiming anything.

- [ ] **Step 1: The Node gates**

```
npm test
node scripts/contract-check.mjs
npm run build
```
Expected: `npm test` ends around `# pass 2586` (2 570 + the 16 new), `# fail 0`; `All contracts satisfied.`; `vite build` ends `✓ built in …`, exit 0.

- [ ] **Step 2: A baseline, only if `.probe/gaps/base/summary.json` does not exist**

```
node scripts/frame-gaps.mjs --cold --entry station --worlds station --events keybind,weapon,mount,interaction,movement --out .probe/gaps/base
```
Expected: `wrote .probe/gaps/base/summary.json`. Same bundle, sampler off: its `layoutSampled: false` is correct and is the point.

- [ ] **Step 3: The measured run with the sampler on**

```
node scripts/frame-gaps.mjs --cold --entry station --worlds station --events keybind,weapon,mount,interaction,movement --layout-sample --out .probe/gaps/layout
node -p "const s=require('./.probe/gaps/layout/summary.json'); ['sampled '+s.layoutSampled+' waited '+s.runs[0].layoutWaitMs+' ms'].concat(s.runs[0].rows.map((r)=>r.event+' worst '+r.worst+' over '+r.over+' frames '+r.frames)).join(' | ')"
node -p "require('./.probe/gaps/base/summary.json').runs[0].rows.map((r)=>r.event+' worst '+r.worst+' over '+r.over+' frames '+r.frames).join(' | ')"
```
Expected console: `layout sampled: true (station, waited N ms)`, a `layout` row, `wrote .probe/gaps/layout/summary.json`. Read it honestly: `world:changed` for the entry world fires from `worldManager.activate` (main.js ~1252) BEFORE `engine.start()` (~1283) and nothing pauses the engine during boot, so on a desktop GPU the station can finish sampling entirely inside the `boot` phase — then `layoutWaitMs` is near zero, the `layout` row has ~0 `frames`, and "layout shows over 0" is measuring nothing. **Pass condition:** `layoutSampled` true, and no row present in both files got worse in `over` (frames > 250 ms) — with `boot` named explicitly: when `layoutWaitMs` is small, `boot` (base run vs layout run) is the row that judges the 2 ms budget; when it is large, the `layout` row is, and its `over` must be 0. If `layoutSampled` is false, do NOT shrink the assertion — read `notes` and `console` in `.probe/gaps/layout/run-<n>.json` and fix the stall (a paused engine, a null `physics`, a world with no `bounds`). If a row got worse, one cell is blowing the 2 ms budget on its own (a cell is atomic; lowering `SAMPLE_BUDGET_MS` cannot fix it) — find the slow cast with `--frames`.

- [ ] **Step 4: Bundle the game into the site**

```
cd site; node scripts/bundle-game.mjs; cd ..
git status --short site/public/game
```
Expected: the script lists the copied files; `git status` shows modified hashed assets and `site/public/game/build.json`.

- [ ] **Step 5: Commit the bundle**

```
git add site/public/game
git commit -m "Bundle: the ground sampler and the layout report" -m "The built game with MapOverlay's layout report, the ground sampler and the ?layout=sample switch, re-copied into the site so the editor's report route receives bounds, shapes and a ground grid from the next admin visit. Measured before bundling: frame-gaps --layout-sample on station, layoutSampled true, no new frames over 250 ms against .probe/gaps/base." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

Do not push. Do not merge. Chunk 2 consumes the report body this chunk sends; until it lands the report route drops `layoutSchema`/`bounds`/`shapes`/`ground`, which is the designed interim state.


---

## Chunk 2: Site — layout storage and routes

All paths under `site/`; run every command from `E:/markc/gametestai/gametestai/site` (`cd site` first). One file: `npx vitest run lib/<file>`; all: `npm test`. Nothing here touches `src/` or the bundle, so no `Bundle:` commit. Expected counts assume today's tree: `mapOverlay.test.ts` 9 integration tests, `mapAdminRoutes.test.ts` 22. Quoted line numbers are TODAY's; each insert shifts the ones after it — anchor on the quoted text, not the number.
- `lib/mapOverlay.test.ts` runs against a real Postgres named `aether_test`, via `POSTGRES_TEST_URL` in the environment or `site/.env.test.local` (present on the author's machine). Without it the integration `describe` is **skipped** and vitest prints `↓ … skipped`. **A skipped run is NOT a pass**; each step says how many must show as *passed*. The emitted-SQL tests in Task 4 use `lib/fakeDb.ts` and run everywhere, so the merge rule is gated with or without a database.
- `lib/mapAdminRoutes.test.ts` mocks `@/lib/mapOverlay` with a factory that enumerates exports by name. Anything a route newly imports comes from `@/lib/mapLayout` (real, unmocked) — never a new `@/lib/mapOverlay` export.

### Task 1: `mapLayout.ts` — constants, types and the Int16 codec

**Files:** Create `site/lib/mapLayout.ts`; Create `site/lib/mapLayout.test.ts`

- [ ] **Step 1: Write the failing test**

Create `site/lib/mapLayout.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { WORLD_COORD_LIMIT } from './mapOverlaySchema';
import {
  LAYOUT_SCHEMA, MAX_GRID_AXIS, MAX_LAYERS, MAX_SHAPES, NO_SAMPLE,
  decodeGround, encodeHeights,
  type LayoutGround,
} from './mapLayout';

/**
 * THE CLAIM: the arithmetic the editor and the save route share over a
 * world's reported layout is right at the edges — cell, roof, grid and byte —
 * because every conflict warning and snapped Y comes from it, and the game
 * never checks the answer. Not a stub: every case builds a real Int16 grid
 * through `encodeHeights` (the e2e seeder's function) and asserts a NUMBER a
 * hand calculation gives. The two-layer cases are the station dome, the one
 * shape a single-height lookup gets wrong by sixty metres.
 */

/** index = ((j * nx) + i) * layers + k — the wire order, so fixtures read that way. */
function grid(nx: number, nz: number, layers: number, cm: number[], step = 10): LayoutGround {
  if (cm.length !== nx * nz * layers) throw new Error('fixture size');
  return { originX: 0, originZ: 0, step, nx, nz, layers, heightsCm: encodeHeights(Int16Array.from(cm)) };
}

describe('the Int16 codec', () => {
  it('round-trips signed centimetres little-endian, pad included, under the pinned limits', () => {
    expect([LAYOUT_SCHEMA, NO_SAMPLE, MAX_GRID_AXIS, MAX_LAYERS, MAX_SHAPES]).toEqual([1, -32768, 400, 4, 5000]);
    const cm = [0, 150, -32768, 32767, -1, 12345];
    const g = decodeGround(grid(3, 2, 1, cm));
    expect(Array.from(g.heights)).toEqual(cm);
    expect([g.nx, g.nz, g.layers, g.step]).toEqual([3, 2, 1, 10]);
  });

  it('encodes 150 cm as the bytes 96 00, not 00 96', () => {
    expect(encodeHeights(Int16Array.from([150]))).toBe('lgA=');
  });

  it('throws when the bytes do not fit the grid, rather than reading past the end', () => {
    expect(() => decodeGround({ ...grid(2, 2, 1, [1, 2, 3, 4]), nx: 3 })).toThrow(/8 bytes/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

`cd site && npx vitest run lib/mapLayout.test.ts`
Expected: `Error: Failed to resolve import "./mapLayout" from "lib/mapLayout.test.ts". Does the file exist?` — `Test Files  1 failed (1)`.

- [ ] **Step 3: Write minimal implementation**

Create `site/lib/mapLayout.ts`:

```ts
import { WORLD_COORD_LIMIT, type Vec3 } from './mapOverlaySchema';

/**
 * The layout a world reports about itself, and the arithmetic over it.
 *
 * Imports one type and one limit, for `mapOverlaySchema.ts`'s reason: pure
 * functions over plain data, so the editor (browser), the save route (lambda)
 * and the tests (node) run the SAME code — hence `atob`/`btoa` over a
 * `DataView`, not `Buffer`; the editor decodes the grid to draw it. The grid is
 * LAYERED because roofs collide: the station dome is a collider above the deck,
 * and one "height at (x, z)" would put every deck placement sixty metres
 * underground. Each sample holds up to four surfaces, top down, as Int16
 * centimetres (±327 m covers every world); `NO_SAMPLE` is the Int16 minimum.
 */

export const LAYOUT_SCHEMA = 1;
export const NO_SAMPLE = -32768;                 // Int16 min = no surface in that layer
export const MAX_GRID_AXIS = 400;
export const MAX_LAYERS = 4;
export const MAX_SHAPES = 5000;
export const MAX_LAYOUT_BYTES = 4_000_000;

export interface LayoutBounds { min: Vec3; max: Vec3 }

export type LayoutShape =
  | { kind: 'rect'; x: number; z: number; w: number; d: number; rotation?: number; fill?: number | string; stroke?: number | string; width?: number }
  | { kind: 'circle'; x: number; z: number; r: number; fill?: number | string; stroke?: number | string; width?: number }
  | { kind: 'path'; points: [number, number][]; stroke?: number | string; width?: number; closed?: boolean };

export interface LayoutGround {
  originX: number; originZ: number;   // world x,z of cell (0,0)
  step: number;                       // metres between samples; = max(4, ceil(extent / 256))
  nx: number; nz: number;             // samples per axis; sample (i,j) is at (originX + i*step, originZ + j*step)
  layers: number;                     // ≤ 4; layer 0 is the TOPMOST surface
  heightsCm: string;                  // base64 of Int16 little-endian, length nx*nz*layers,
                                      // index = ((j * nx) + i) * layers + k; NO_SAMPLE pads; cm clamped to ±32767
}

export interface WorldLayout { schema: 1; bounds: LayoutBounds; shapes: LayoutShape[]; ground: LayoutGround | null }

export interface DecodedGround extends Omit<LayoutGround, 'heightsCm'> { heights: Int16Array }

const CM = 100;

/** base64 of little-endian Int16 — the exact bytes the game's sampler emits. */
export function encodeHeights(h: Int16Array): string {
  const bytes = new Uint8Array(h.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < h.length; i++) view.setInt16(i * 2, h[i], true);
  // `fromCharCode.apply` over a whole 1.3 MB grid blows the argument limit; 8 KB slices do not.
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x2000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x2000) as unknown as number[]);
  }
  return btoa(binary);
}

/** Throws on a length mismatch or bad base64: a grid that does not fit its own header is not a grid. */
export function decodeGround(g: LayoutGround): DecodedGround {
  const count = g.nx * g.nz * g.layers;
  const binary = atob(g.heightsCm);
  if (binary.length !== count * 2) {
    throw new Error(`heightsCm is ${binary.length} bytes; ${g.nx}×${g.nz}×${g.layers} Int16 needs ${count * 2}`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const heights = new Int16Array(count);
  for (let i = 0; i < count; i++) heights[i] = view.getInt16(i * 2, true);
  return { originX: g.originX, originZ: g.originZ, step: g.step, nx: g.nx, nz: g.nz, layers: g.layers, heights };
}
```

- [ ] **Step 4: Run test to verify it passes**

`cd site && npx vitest run lib/mapLayout.test.ts`
Expected: `✓ lib/mapLayout.test.ts (3 tests)`, `Tests  3 passed (3)`. (`WORLD_COORD_LIMIT` is used from Task 3; an unused import is not an error under vitest.)

- [ ] **Step 5: Commit**

```
git add site/lib/mapLayout.ts site/lib/mapLayout.test.ts
git commit -m "The site can decode the game's layered ground grid" -m "The game reports each world's ground as up to four Int16 centimetre surfaces per cell, base64 little-endian. The codec lives in a module that imports nothing but a type and a limit, and uses atob/btoa over a DataView rather than Buffer, because the editor decodes the same bytes in the browser to draw them. A grid whose bytes do not fit its header throws rather than reading past the end." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 2: `groundAt` (per-corner nearest-at-or-below, then bilinear) and `layersAt`

**Files:** Modify `site/lib/mapLayout.ts` (append at end); Modify `site/lib/mapLayout.test.ts` (import list + append)

- [ ] **Step 1: Write the failing test**

Add `groundAt, layersAt,` after `encodeHeights,` in the `./mapLayout` import of `site/lib/mapLayout.test.ts`, then append:

```ts
describe('groundAt', () => {
  // Two 10 m cells per axis; the floor rises 10 m across x. Corners (i,j): (0,0),(1,0),(0,1),(1,1).
  const slope = decodeGround(grid(2, 2, 1, [0, 1000, 0, 1000]));

  it('interpolates a flat single layer exactly', () => {
    expect(groundAt(slope, 5, 3, 50)).toBe(5);
    expect(groundAt(slope, 0, 0, 50)).toBe(0);
    expect(groundAt(slope, 10, 10, 50)).toBe(10);
    expect(groundAt(slope, 2.5, 7, 50)).toBe(2.5);
  });

  it('under a 20 m roof over a 0 m floor, y=1 reads the floor and y=25 reads the roof', () => {
    const dome = decodeGround(grid(2, 2, 2, [2000, 0, 2000, 0, 2000, 0, 2000, 0]));
    expect(groundAt(dome, 5, 5, 1)).toBe(0);
    expect(groundAt(dome, 5, 5, 25)).toBe(20);
    expect(groundAt(dome, 5, 5, 20)).toBe(20);   // "at or below" includes "at"
    // A corner with no layer at or below y takes its lowest: roof 20 m, floor 5 m, y = 1.
    const raised = decodeGround(grid(2, 2, 2, [2000, 500, 2000, 500, 2000, 500, 2000, 500]));
    expect(groundAt(raised, 5, 5, 1)).toBe(5);
  });

  it('a cell with a NO_SAMPLE corner is no sample, whatever its other corners hold', () => {
    expect(groundAt(decodeGround(grid(2, 2, 1, [0, 0, 0, NO_SAMPLE])), 5, 5, 50)).toBeNull();
    const edge = decodeGround(grid(2, 2, 2, [0, 0, 0, 0, 0, 0, NO_SAMPLE, NO_SAMPLE]));
    expect(groundAt(edge, 5, 5, 50)).toBeNull();
  });

  it('at a roof edge picks the layer PER CORNER — the case that separates this rule from per-cell layer k', () => {
    // Near corners: roof 20 m over floor 0; far corners: floor only. y = 1 → every corner picks 0. Per-cell "layer 1" is null (NO_SAMPLE far); per-cell "layer 0" is 10.
    const edge = decodeGround(grid(2, 2, 2, [2000, 0, 2000, 0, 0, NO_SAMPLE, 0, NO_SAMPLE]));
    expect(groundAt(edge, 5, 5, 1)).toBe(0);
    expect(groundAt(edge, 5, 5, 25)).toBe(10);   // above the roof: near corners roof, far corners floor, blended
  });

  it('is null outside the grid, for NaN, and without a grid; honours the origin', () => {
    expect(groundAt(slope, -0.01, 5, 50)).toBeNull();
    expect(groundAt(slope, 10.01, 5, 50)).toBeNull();
    expect(groundAt(slope, 5, 11, 50)).toBeNull();
    expect(groundAt(slope, NaN, 5, 50)).toBeNull();
    expect(groundAt(null, 5, 5, 50)).toBeNull();
    const moved = { ...slope, originX: -100, originZ: 40 };
    expect(groundAt(moved, -95, 45, 50)).toBe(5);
    expect(groundAt(moved, 5, 45, 50)).toBeNull();
  });
});

describe('layersAt', () => {
  const dome = decodeGround(grid(2, 2, 3, [2000, 0, NO_SAMPLE, 2000, 0, NO_SAMPLE, 500, NO_SAMPLE, NO_SAMPLE, NO_SAMPLE, NO_SAMPLE, NO_SAMPLE]));

  it('lists the surfaces at the nearest sample in metres, top first, pads removed', () => {
    expect(layersAt(dome, 1, 2)).toEqual([20, 0]);   // nearest sample is (0,0)
    expect(layersAt(dome, 3, 8)).toEqual([5]);       // (0,1)
    expect(layersAt(dome, 9, 9)).toEqual([]);        // (1,1): no surface
  });

  it('is empty outside the grid or without one', () => {
    expect(layersAt(dome, 16, 0)).toEqual([]);
    expect(layersAt(dome, -6, 0)).toEqual([]);
    expect(layersAt(null, 0, 0)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

`cd site && npx vitest run lib/mapLayout.test.ts`
Expected: `TypeError: groundAt is not a function` ×5 and `TypeError: layersAt is not a function` ×2 (Vitest 4 may print `__vi_import_0__.groundAt is not a function`; the count line is what matters): `Tests  7 failed | 3 passed (10)`.

- [ ] **Step 3: Write minimal implementation**

Append to `site/lib/mapLayout.ts`:

```ts
/** One corner, in cm: nearest layer at or below `yCm`; else its lowest ("underground" needs a surface to be under); else null. */
function cornerCm(g: DecodedGround, i: number, j: number, yCm: number): number | null {
  const base = (j * g.nx + i) * g.layers;
  let below: number | null = null;
  let lowest: number | null = null;
  for (let k = 0; k < g.layers; k++) {
    const h = g.heights[base + k];
    if (h === NO_SAMPLE) continue;
    if (lowest === null || h < lowest) lowest = h;
    if (h <= yCm && (below === null || h > below)) below = h;
  }
  return below ?? lowest;
}

/** Nearest layer at or below `y`, chosen PER CORNER, then bilinear. A corner with no layer at/below takes its lowest; a corner with no layers is no sample → null. */
export function groundAt(g: DecodedGround | null, x: number, z: number, y: number): number | null {
  if (!g || g.nx < 1 || g.nz < 1 || !(g.step > 0)) return null;
  const fx = (x - g.originX) / g.step;
  const fz = (z - g.originZ) / g.step;
  // A positive test, so NaN falls out here rather than inside an index.
  if (!(fx >= 0 && fz >= 0 && fx <= g.nx - 1 && fz <= g.nz - 1)) return null;
  const i0 = Math.min(Math.floor(fx), g.nx - 1);
  const j0 = Math.min(Math.floor(fz), g.nz - 1);
  const i1 = Math.min(i0 + 1, g.nx - 1);
  const j1 = Math.min(j0 + 1, g.nz - 1);
  const tx = fx - i0;
  const tz = fz - j0;
  const yCm = y * CM;
  const c00 = cornerCm(g, i0, j0, yCm);
  const c10 = cornerCm(g, i1, j0, yCm);
  const c01 = cornerCm(g, i0, j1, yCm);
  const c11 = cornerCm(g, i1, j1, yCm);
  if (c00 === null || c10 === null || c01 === null || c11 === null) return null;
  const near = c00 + (c10 - c00) * tx;
  const far = c01 + (c11 - c01) * tx;
  return (near + (far - near) * tz) / CM;
}

/** All surfaces at the nearest sample to (x,z), top-down, metres — for the layer picker. */
export function layersAt(g: DecodedGround | null, x: number, z: number): number[] {
  if (!g || g.nx < 1 || g.nz < 1 || !(g.step > 0)) return [];
  const i = Math.round((x - g.originX) / g.step);
  const j = Math.round((z - g.originZ) / g.step);
  if (!(i >= 0 && j >= 0 && i < g.nx && j < g.nz)) return [];
  const base = (j * g.nx + i) * g.layers;
  const out: number[] = [];
  for (let k = 0; k < g.layers; k++) {
    const h = g.heights[base + k];
    if (h !== NO_SAMPLE) out.push(h / CM);
  }
  return out.sort((a, b) => b - a);   // top-down is this function's promise, not the byte producer's
}
```

- [ ] **Step 4: Run test to verify it passes**

`cd site && npx vitest run lib/mapLayout.test.ts` — expected `Tests  10 passed (10)`.

- [ ] **Step 5: Commit**

```
git add site/lib/mapLayout.ts site/lib/mapLayout.test.ts
git commit -m "Ground height under a point picks the layer beneath it, corner by corner" -m "A single height per cell reports the station dome as the floor. groundAt chooses, for each of the four corners around (x, z), the nearest sampled surface at or below the candidate y, and only then interpolates — per corner, because at a roof edge the corners have different layer counts and layer k is not one surface across the cell. A corner with nothing beneath the point takes its lowest surface, so the answer is 'underground' rather than 'no ground'; a corner with no surface at all makes the cell no sample. layersAt lists what was actually sampled nearest a point, top first, for the layer picker — rounded, not blended, because a mix of roof and floor is not a place anything can stand." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 3: `validateGround` / `validateLayout` — clamp what a browser sent

**Files:** Modify `site/lib/mapLayout.ts` (append); Modify `site/lib/mapLayout.test.ts` (import + append)

- [ ] **Step 1: Write the failing test**

Add `validateGround, validateLayout,` to the `./mapLayout` import, then append:

```ts
const GOOD_GROUND = grid(3, 3, 1, new Array(9).fill(150));
const BOUNDS = { min: { x: -50, y: 0, z: -50 }, max: { x: 50, y: 20, z: 50 } };
const GOOD_LAYOUT = { layoutSchema: 1, bounds: BOUNDS, shapes: [{ kind: 'rect', x: 0, z: 0, w: 4, d: 4, fill: 0x224466 }], ground: GOOD_GROUND };

describe('validateGround', () => {
  it.each([
    ['nx over the cap', { ...GOOD_GROUND, nx: MAX_GRID_AXIS + 1 }],
    ['nz below one', { ...GOOD_GROUND, nz: 0 }],
    ['layers over the cap', { ...GOOD_GROUND, layers: MAX_LAYERS + 1 }],
    ['heights that do not fit the grid', { ...GOOD_GROUND, heightsCm: encodeHeights(new Int16Array(8)) }],
    ['heights that are not base64', { ...GOOD_GROUND, heightsCm: '***' }],
    ['a NaN origin', { ...GOOD_GROUND, originX: NaN }],
    ['an origin past the coordinate limit', { ...GOOD_GROUND, originZ: WORLD_COORD_LIMIT + 1 }],
    ['a zero step', { ...GOOD_GROUND, step: 0 }],
    ['not an object', 'ground'],
  ])('rejects %s', (_, input) => {
    expect(validateGround(input)).toBeNull();
  });

  it('keeps a well-formed grid byte for byte, coordinates rounded to millimetres', () => {
    expect(validateGround({ ...GOOD_GROUND, originX: 1.23456 })).toEqual({ ...GOOD_GROUND, originX: 1.235 });
  });
});

describe('validateLayout', () => {
  it.each([
    ['no bounds', { layoutSchema: 1, shapes: [] }],
    ['bounds with min above max', { layoutSchema: 1, bounds: { min: BOUNDS.max, max: BOUNDS.min } }],
    ['bounds with a NaN', { layoutSchema: 1, bounds: { min: { x: NaN, y: 0, z: 0 }, max: BOUNDS.max } }],
    ['a schema this reader does not know', { ...GOOD_LAYOUT, layoutSchema: 2 }],
    ['no schema at all', { bounds: BOUNDS }],
    ['garbage', 'layout'],
    ['null', null],
  ])('is null for %s', (_, input) => {
    expect(validateLayout(input)).toBeNull();
  });

  it('accepts a full layout under either schema key; keeps bounds when the ground is missing or unusable', () => {
    const a = validateLayout(GOOD_LAYOUT)!;
    expect(validateLayout({ ...GOOD_LAYOUT, layoutSchema: undefined, schema: 1 })).toEqual(a);
    expect(a).toMatchObject({ schema: 1, bounds: BOUNDS, ground: GOOD_GROUND });
    expect(validateLayout({ ...GOOD_LAYOUT, ground: undefined })!.ground).toBeNull();
    expect(validateLayout({ ...GOOD_LAYOUT, ground: { ...GOOD_GROUND, nx: 99 } })!.ground).toBeNull();
    expect(validateLayout({ ...GOOD_LAYOUT, shapes: 'no' })!.shapes).toEqual([]);
  });

  it('drops unknown kinds and bad coordinates, keeps numeric and string colours as sent, caps at MAX_SHAPES', () => {
    const l = validateLayout({
      ...GOOD_LAYOUT,
      shapes: [
        { kind: 'rect', x: 0, z: 0, w: 4, d: 4, fill: 0x224466, stroke: '#fff', width: 2, rotation: 0.5 },
        { kind: 'circle', x: 1, z: 1, r: 3, fill: 'rgba(0,0,0,.5)' },
        { kind: 'path', points: [[0, 0], [1, 1], [NaN, 2]], closed: true },
        { kind: 'triangle', x: 0, z: 0 },
        { kind: 'rect', x: 1e9, z: 0, w: 1, d: 1 },
        { kind: 'path', points: [[0, 0]] },
        'not a shape',
      ],
    })!;
    expect(l.shapes).toEqual([
      { kind: 'rect', x: 0, z: 0, w: 4, d: 4, rotation: 0.5, fill: 0x224466, stroke: '#fff', width: 2 },
      { kind: 'circle', x: 1, z: 1, r: 3, fill: 'rgba(0,0,0,.5)' },
      { kind: 'path', points: [[0, 0], [1, 1]], closed: true },
    ]);
    const many = Array.from({ length: MAX_SHAPES + 7 }, (_, i) => ({ kind: 'circle', x: i, z: 0, r: 1 }));
    expect(validateLayout({ ...GOOD_LAYOUT, shapes: many })!.shapes).toHaveLength(MAX_SHAPES);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

`cd site && npx vitest run lib/mapLayout.test.ts`
Expected: every new case fails with `TypeError: validateGround is not a function` / `validateLayout is not a function`; `Tests  19 failed | 10 passed (29)`.

- [ ] **Step 3: Write minimal implementation**

Append to `site/lib/mapLayout.ts`:

```ts
/** A finite coordinate inside the schema's ±WORLD_COORD_LIMIT, to the millimetre; else null. */
function coord(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || Math.abs(raw) > WORLD_COORD_LIMIT) return null;
  return Math.round(raw * 1000) / 1000;
}

function vec3(raw: unknown): Vec3 | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const x = coord(r.x), y = coord(r.y), z = coord(r.z);
  return x === null || y === null || z === null ? null : { x, y, z };
}

function integer(raw: unknown, min: number, max: number): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= min && raw <= max ? raw : null;
}

function finite(raw: unknown, places: number): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return Math.round(raw * 10 ** places) / 10 ** places;
}

/** Minimap colours arrive as a Three hex number or a CSS string; both are kept as sent. */
function colour(raw: unknown): number | string | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  return typeof raw === 'string' && raw.length > 0 && raw.length <= 32 ? raw : undefined;
}

type Style = { fill?: number | string; stroke?: number | string; width?: number };

function style(r: Record<string, unknown>): Style {
  const s: Style = {};
  const fill = colour(r.fill), stroke = colour(r.stroke), width = finite(r.width, 3);
  if (fill !== undefined) s.fill = fill;
  if (stroke !== undefined) s.stroke = stroke;
  if (width !== undefined && width >= 0) s.width = width;
  return s;
}

function validateShape(raw: unknown): LayoutShape | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const s = style(r);
  if (r.kind === 'rect') {
    const x = coord(r.x), z = coord(r.z), w = coord(r.w), d = coord(r.d);
    if (x === null || z === null || w === null || d === null) return null;
    const rotation = finite(r.rotation, 6);
    return { kind: 'rect', x, z, w, d, ...(rotation !== undefined ? { rotation } : {}), ...s };
  }
  if (r.kind === 'circle') {
    const x = coord(r.x), z = coord(r.z), rad = coord(r.r);
    if (x === null || z === null || rad === null) return null;
    return { kind: 'circle', x, z, r: rad, ...s };
  }
  if (r.kind === 'path' && Array.isArray(r.points)) {
    const points: [number, number][] = [];
    for (const p of r.points.slice(0, 4000)) {   // the longest minimap path today is a few hundred points
      const px = Array.isArray(p) ? coord(p[0]) : null;
      const pz = Array.isArray(p) ? coord(p[1]) : null;
      if (px !== null && pz !== null) points.push([px, pz]);   // one bad vertex does not lose the wall
    }
    if (points.length < 2) return null;
    return {
      kind: 'path',
      points,
      ...(s.stroke !== undefined ? { stroke: s.stroke } : {}),
      ...(s.width !== undefined ? { width: s.width } : {}),
      ...(r.closed === true ? { closed: true } : {}),
    };
  }
  return null;
}

export function validateBounds(raw: unknown): LayoutBounds | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const min = vec3(r.min), max = vec3(r.max);
  if (!min || !max || min.x > max.x || min.y > max.y || min.z > max.z) return null;
  return { min, max };
}

/** Unknown kinds and unusable shapes are dropped one at a time, never the whole list: a map with one bad wall is still a map. */
export function validateShapes(raw: unknown): LayoutShape[] {
  if (!Array.isArray(raw)) return [];
  const out: LayoutShape[] = [];
  for (const item of raw) {
    if (out.length >= MAX_SHAPES) break;
    const shape = validateShape(item);
    if (shape) out.push(shape);
  }
  return out;
}

const MAX_HEIGHTS_BASE64 = Math.ceil((MAX_GRID_AXIS * MAX_GRID_AXIS * MAX_LAYERS * 2) / 3) * 4;   // longest base64 a grid at the caps can be; longer is refused before decoding

export function validateGround(input: unknown): LayoutGround | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const r = input as Record<string, unknown>;
  const originX = coord(r.originX), originZ = coord(r.originZ);
  const step = typeof r.step === 'number' && r.step > 0 ? coord(r.step) : null;
  const nx = integer(r.nx, 1, MAX_GRID_AXIS), nz = integer(r.nz, 1, MAX_GRID_AXIS), layers = integer(r.layers, 1, MAX_LAYERS);
  if (originX === null || originZ === null || step === null || nx === null || nz === null || layers === null) return null;
  if (typeof r.heightsCm !== 'string' || r.heightsCm.length > MAX_HEIGHTS_BASE64) return null;
  const ground: LayoutGround = { originX, originZ, step, nx, nz, layers, heightsCm: r.heightsCm };
  try {
    decodeGround(ground);   // the only way to know the bytes fit the header is to look
  } catch {
    return null;
  }
  return ground;
}

/** Clamp/validate an untrusted layout; returns null when unusable. Never throws. Reads the wire key `layoutSchema` or the stored key `schema`. */
export function validateLayout(input: unknown): WorldLayout | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const r = input as Record<string, unknown>;
  if ((r.schema ?? r.layoutSchema) !== LAYOUT_SCHEMA) return null;
  const bounds = validateBounds(r.bounds);
  if (!bounds) return null;
  const ground = r.ground === undefined || r.ground === null ? null : validateGround(r.ground);
  return { schema: LAYOUT_SCHEMA, bounds, shapes: validateShapes(r.shapes), ground };
}
```

- [ ] **Step 4: Run test to verify it passes**

`cd site && npx vitest run lib/mapLayout.test.ts` — expected `Tests  29 passed (29)`.
`cd site && npx tsc --noEmit -p .` — expected: no output, exit 0 (clean today; the spread returns must satisfy the `LayoutShape` union under `strict`).

- [ ] **Step 5: Commit**

```
git add site/lib/mapLayout.ts site/lib/mapLayout.test.ts
git commit -m "An untrusted layout is clamped before anything trusts it" -m "The layout arrives from a browser, and an admin's browser is still a browser. Bounds and grid coordinates use the overlay schema's finite, ±20 000 m, millimetre rule; the grid is refused when an axis, the layer count or the byte length does not fit; shapes of an unknown kind or with a bad coordinate are dropped one at a time rather than losing the map. Colours stay as the minimap sent them, a Three hex number or a CSS string, because the editor draws with whichever it gets. Nothing here throws." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 4: The layout columns and the merge upsert

**Files:** Modify `site/lib/mapOverlay.ts` (after line 7; lines 29-30; after line 90; after line 137; lines 300-312; lines 341-376); Modify `site/lib/mapOverlay.test.ts` (line 11; after line 14; after line 57; inside `suite` after its last test; append at end)

- [ ] **Step 1: Write the failing test**

In `site/lib/mapOverlay.test.ts`: add `  resetMapOverlaySchemaMemo,` after line 11 (`  recordWorldReport,`); after line 14 (`} from './mapOverlay';`) add:

```ts
import { encodeHeights } from './mapLayout';
import { flat, makeFakeDb } from './fakeDb';
```

After `const OTHER = 'test-overlay-beta';` add:

```ts
const PLAIN = { appliedVersion: 1, objects: [], applied: [], unresolved: [] };
const BOUNDS = { min: { x: -20, y: 0, z: -20 }, max: { x: 20, y: 10, z: 20 } };
/** A 3×3 single-layer grid at 20 m, every cell at `cm`. */
function ground(cm: number) {
  return { originX: -20, originZ: -20, step: 20, nx: 3, nz: 3, layers: 1, heightsCm: encodeHeights(new Int16Array(9).fill(cm)) };
}
```

Inside `suite('mapOverlay (integration)', …)`, after its last `it(…)` (`caps a reported object catalogue…`), add:

```ts
  it('adds the layout columns to a table that already existed, and again without complaint', async () => {
    resetMapOverlaySchemaMemo(); await ensureMapOverlaySchema(db);
    resetMapOverlaySchemaMemo(); await ensureMapOverlaySchema(db);
    const cols = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'map_world_reports'`);
    expect(cols.rows.map((r) => r.column_name)).toEqual(expect.arrayContaining(['layout', 'layout_schema']));
  });

  it('reads layout null, with a fresh reportedAt, for a world whose reports never carried one', async () => {
    await recordWorldReport(db, WORLD, PLAIN);
    const stored = await readWorldReport(db, WORLD);
    expect(stored?.layout).toBeNull();
    expect(Date.now() - Date.parse(stored!.reportedAt)).toBeLessThan(60_000);
  });

  it('stores a layout and hands it back byte for byte', async () => {
    const shapes = [{ kind: 'rect', x: 0, z: 0, w: 4, d: 4, fill: 0x224466 }];
    await recordWorldReport(db, WORLD, { ...PLAIN, layoutSchema: 1, bounds: BOUNDS, shapes, ground: ground(150) });
    expect((await readWorldReport(db, WORLD))?.layout).toEqual({ schema: 1, bounds: BOUNDS, shapes, ground: ground(150) });
  });

  it('keeps the ground when a later report carries bounds and shapes but no ground', async () => {
    await recordWorldReport(db, WORLD, { ...PLAIN, layoutSchema: 1, bounds: BOUNDS, shapes: [], ground: ground(150) });
    const moved = { min: { x: -30, y: 0, z: -30 }, max: { x: 30, y: 10, z: 30 } };
    await recordWorldReport(db, WORLD, { ...PLAIN, appliedVersion: 2, layoutSchema: 1, bounds: moved, shapes: [{ kind: 'circle', x: 1, z: 1, r: 2 }] });
    const stored = await readWorldReport(db, WORLD);
    expect(stored?.appliedVersion).toBe(2);
    expect(stored?.layout?.bounds).toEqual(moved);
    expect(stored?.layout?.shapes).toHaveLength(1);
    expect(stored?.layout?.ground).toEqual(ground(150));
  });

  it('leaves the layout alone for a report with no layout fields, and keeps the prior ground over one that does not decode', async () => {
    await recordWorldReport(db, WORLD, { ...PLAIN, layoutSchema: 1, bounds: BOUNDS, shapes: [], ground: ground(150) });
    await recordWorldReport(db, WORLD, { ...PLAIN, appliedVersion: 3 });
    const stored = await readWorldReport(db, WORLD);
    expect(stored?.appliedVersion).toBe(3);
    expect(stored?.layout).toEqual({ schema: 1, bounds: BOUNDS, shapes: [], ground: ground(150) });
    await recordWorldReport(db, WORLD, { ...PLAIN, layoutSchema: 1, bounds: BOUNDS, shapes: [], ground: { ...ground(999), nx: 4 } });
    expect((await readWorldReport(db, WORLD))?.layout?.ground).toEqual(ground(150));
  });
```

Append at the end of the file, outside `suite`, so it runs with or without a database:

```ts
/**
 * The merge rule as EMITTED SQL, on every machine: one shallow jsonb `||` with a patch of the
 * keys that passed. The integration suite proves the consequence; this pins the statement where it cannot run.
 */
describe('recordWorldReport — the SQL it emits', () => {
  const patchOf = (db: ReturnType<typeof makeFakeDb>) => JSON.parse(String(db.only('INSERT INTO map_world_reports').params[5]));

  it('merges the patch over the stored layout rather than replacing it', async () => {
    const db = makeFakeDb();
    await recordWorldReport(db, 'test-overlay-sql', { ...PLAIN, layoutSchema: 1, bounds: BOUNDS, shapes: [] });
    const q = db.only('INSERT INTO map_world_reports');
    expect(flat(q.sql)).toContain('layout = map_world_reports.layout || EXCLUDED.layout');
    expect(flat(q.sql)).toContain('layout_schema = GREATEST(map_world_reports.layout_schema, EXCLUDED.layout_schema)');
    expect(patchOf(db)).toEqual({ schema: 1, bounds: BOUNDS, shapes: [] });
    expect(q.params[6]).toBe(1);
  });

  it('sends an empty patch and schema 0 for a report with no layout, or one under a schema it does not read', async () => {
    const db = makeFakeDb();
    await recordWorldReport(db, 'test-overlay-sql', PLAIN);
    expect(patchOf(db)).toEqual({});
    expect(db.only('INSERT INTO map_world_reports').params[6]).toBe(0);
    db.clear();
    await recordWorldReport(db, 'test-overlay-sql', { ...PLAIN, layoutSchema: 7, bounds: BOUNDS, shapes: [], ground: ground(150) });
    expect(patchOf(db)).toEqual({});
  });

  it('includes a ground only when it decodes, and keeps the bounds when it does not', async () => {
    const db = makeFakeDb();
    await recordWorldReport(db, 'test-overlay-sql', { ...PLAIN, layoutSchema: 1, bounds: BOUNDS, shapes: [], ground: { ...ground(1), nx: 4 } });
    expect(patchOf(db)).toEqual({ schema: 1, bounds: BOUNDS, shapes: [] });
    db.clear();
    await recordWorldReport(db, 'test-overlay-sql', { ...PLAIN, layoutSchema: 1, bounds: BOUNDS, shapes: [], ground: ground(150) });
    expect(patchOf(db).ground).toEqual(ground(150));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

`cd site && npx vitest run lib/mapOverlay.test.ts`
Expected with the database: `Tests  8 failed | 9 passed (17)` — the three SQL tests (the first on `to contain 'layout = map_world_reports.layout || EXCLUDED.layout'`, the others with `SyntaxError: "undefined" is not valid JSON`) and the five integration tests (`expected undefined to be null`, `expected undefined to deeply equal …`, and the columns case on `arrayContaining`). Without: `3 failed | 14 skipped`. On a database where an earlier run already added the columns, the columns case is green from the start — the migration is proven by the first run against a table without them.

- [ ] **Step 3: Write minimal implementation**

In `site/lib/mapOverlay.ts`, after line 7 (`} from './mapOverlaySchema';`) insert:

```ts
import { LAYOUT_SCHEMA, validateBounds, validateGround, validateLayout, validateShapes, type WorldLayout } from './mapLayout';
```

Replace lines 29-30 (` *   - Additive \`CREATE TABLE IF NOT EXISTS\` only. Whichever app runs first wins` / ` *     and the other is a no-op; no deployment is ever stranded mid-migration.`) with:

```ts
 *   - Additive DDL only: `CREATE TABLE IF NOT EXISTS`, and — since the layout
 *     columns — `ALTER TABLE … ADD COLUMN IF NOT EXISTS` with a DEFAULT, so a
 *     row written before the column reads as "no layout", never as NULL.
 *     Whichever app runs first wins and the other is a no-op.
```

After line 90 (the `}` closing `WorldReport`) insert:

```ts

/** Layout fields a report may carry, typed `unknown` because they are validated HERE, not in the route; a failed layout still records the catalogue and keeps the prior layout. */
export interface ReportedLayoutFields { layoutSchema?: unknown; bounds?: unknown; shapes?: unknown; ground?: unknown }

export interface StoredWorldReport extends WorldReport { reportedAt: string; layout: WorldLayout | null }
```

After line 137 (the `` `); `` closing the `CREATE TABLE IF NOT EXISTS map_world_reports` statement) insert:

```ts
      // These columns arrived after the table was live: ADD COLUMN IF NOT EXISTS
      // is the additive form, and the DEFAULTs let an old row read as "no layout yet".
      await db.query(`
        ALTER TABLE map_world_reports
          ADD COLUMN IF NOT EXISTS layout JSONB NOT NULL DEFAULT '{}'::jsonb
      `);
      await db.query(`
        ALTER TABLE map_world_reports
          ADD COLUMN IF NOT EXISTS layout_schema INTEGER NOT NULL DEFAULT 0
      `);
```

Replace lines 300-312 (the `Record what the running game found and did` comment through `await ensureMapOverlaySchema(db);`) with:

```ts
/**
 * Only the keys that arrived AND passed. `bounds`/`shapes` travel on every report, `ground`
 * only when sampling finished; jsonb `||` is shallow, so bounds without ground keeps
 * yesterday's ground, and nothing keeps everything.
 */
function layoutPatch(report: ReportedLayoutFields): Partial<WorldLayout> {
  const patch: Partial<WorldLayout> = {};
  if (report.layoutSchema !== LAYOUT_SCHEMA) return patch;
  const bounds = validateBounds(report.bounds);
  if (bounds) {
    patch.schema = LAYOUT_SCHEMA;
    patch.bounds = bounds;
    patch.shapes = validateShapes(report.shapes);
  }
  const ground = report.ground === undefined || report.ground === null ? null : validateGround(report.ground);
  if (ground) {
    patch.schema = LAYOUT_SCHEMA;
    patch.ground = ground;
  }
  // A valid ground under invalid bounds stores { schema, ground }: readWorldReport answers `layout: null` until bounds arrive, and the ground is already there when they do. Self-healing, not a bug.
  return patch;
}

/** Record what the running game found and did: one row per world, a cache of the last report, not a history (that is `map_overlays`). The layout is the one part that MERGES — see `layoutPatch`. */
export async function recordWorldReport(
  db: Db,
  worldId: string,
  report: WorldReport & ReportedLayoutFields
): Promise<void> {
  await ensureMapOverlaySchema(db);
```

The `objects`/`applied`/`unresolved` mapping that follows is unchanged. Replace the `await db.query(` upsert and `readWorldReport` (line 341 to the end of the file) with:

```ts
  const patch = layoutPatch(report);

  await db.query(
    `INSERT INTO map_world_reports
       (world_id, applied_version, objects, applied, unresolved, layout, layout_schema, reported_at)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7, NOW())
     ON CONFLICT (world_id) DO UPDATE
       SET applied_version = EXCLUDED.applied_version,
           objects         = EXCLUDED.objects,
           applied         = EXCLUDED.applied,
           unresolved      = EXCLUDED.unresolved,
           layout          = map_world_reports.layout || EXCLUDED.layout,
           layout_schema   = GREATEST(map_world_reports.layout_schema, EXCLUDED.layout_schema),
           reported_at     = NOW()`,
    [
      worldId,
      Math.max(0, Math.floor(Number(report.appliedVersion) || 0)),
      JSON.stringify(objects),
      JSON.stringify(applied),
      JSON.stringify(unresolved),
      JSON.stringify(patch),
      patch.schema === LAYOUT_SCHEMA ? LAYOUT_SCHEMA : 0,
    ]
  );
}

export async function readWorldReport(db: Db, worldId: string): Promise<StoredWorldReport | null> {
  await ensureMapOverlaySchema(db);
  const r = await db.query(
    `SELECT applied_version, objects, applied, unresolved, layout, layout_schema, reported_at
       FROM map_world_reports WHERE world_id = $1`,
    [worldId]
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    appliedVersion: Number(row.applied_version ?? 0),
    objects: Array.isArray(row.objects) ? (row.objects as CatalogueObject[]) : [],
    applied: Array.isArray(row.applied) ? (row.applied as AppliedOutcome[]) : [],
    unresolved: Array.isArray(row.unresolved) ? (row.unresolved as UnresolvedOutcome[]) : [],
    // Validated again on the way out, like `rowEntries`: a row edited in psql reaches the editor as "no layout", not a canvas crash.
    layout: Number(row.layout_schema ?? 0) >= LAYOUT_SCHEMA ? validateLayout(row.layout) : null,
    reportedAt: new Date(row.reported_at).toISOString(),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

`cd site && npx vitest run lib/mapOverlay.test.ts` — expected `Tests  17 passed (17)`. `14 skipped | 3 passed` is NOT a pass: the DDL never ran; set `POSTGRES_TEST_URL` and rerun.
`cd site && npx tsc --noEmit -p .` — expected: exit 0.

- [ ] **Step 5: Commit**

```
git add site/lib/mapOverlay.ts site/lib/mapOverlay.test.ts
git commit -m "World reports carry a layout, merged rather than replaced" -m "map_world_reports gains layout (JSONB) and layout_schema: the first ADD COLUMN IF NOT EXISTS statements in ensureMapOverlaySchema, in the same idempotent style as its CREATE TABLEs, and aether_test already held the table without them, so the integration suite's ensure is the migration path itself. A report's layout fields are validated in the store, and the keys that pass become a jsonb patch merged over the stored layout with ||. That shallow merge is the rule the game needs: bounds and shapes arrive on every visit, the ground only when sampling finishes, and a visit the admin leaves early — or a report whose grid is corrupt — must not erase the grid the last one produced. readWorldReport validates the stored layout again on the way out." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 5: The report route accepts a layout and refuses one over the cap

**Files:** Modify `site/app/api/admin/map/report/route.ts` (after line 4; lines 44-55; lines 67-72); Modify `site/lib/mapAdminRoutes.test.ts` (after line 1; after line 337; after line 365)

- [ ] **Step 1: Write the failing test**

In `site/lib/mapAdminRoutes.test.ts`, after line 1 add:

```ts
import { MAX_LAYOUT_BYTES, encodeHeights } from '@/lib/mapLayout';
```

Inside `describe('POST /api/admin/map/report', …)`, after the `REPORT` constant (its closing `};` is line 337) add:

```ts
  const LAYOUT = {
    layoutSchema: 1, bounds: { min: { x: -10, y: 0, z: -10 }, max: { x: 10, y: 5, z: 10 } }, shapes: [{ kind: 'rect', x: 0, z: 0, w: 4, d: 4 }],
    ground: { originX: -10, originZ: -10, step: 20, nx: 2, nz: 2, layers: 1, heightsCm: encodeHeights(new Int16Array(4)) },
  };
```

After that `describe`'s last test (`refuses a report about a world that does not exist`, ending line 365) add:

```ts
  it('hands the layout fields to the store untouched, for the store to validate', async () => {
    signedInAs(ADMIN);
    const res = await post({ ...REPORT, ...LAYOUT });
    expect(res.status).toBe(200);
    expect(store.recordWorldReport.mock.calls[0][2]).toMatchObject(LAYOUT);
  });

  it('refuses a report over the byte cap with 413 and never opens a connection; still 400 for non-JSON', async () => {
    signedInAs(ADMIN);
    const res = await post({ ...REPORT, ...LAYOUT, pad: 'x'.repeat(MAX_LAYOUT_BYTES) });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'Report too large' });
    const { POST } = await import('@/app/api/admin/map/report/route');
    const bad = await POST(new Request('http://localhost/api/admin/map/report', { method: 'POST', body: 'not json' }));
    expect(bad.status).toBe(400);
    expect(store.recordWorldReport).not.toHaveBeenCalled();
    expect(connections).toHaveLength(0);
  });

  it('refuses an anonymous client before reading a byte of the body', async () => {
    signedInAs(null);
    const text = vi.spyOn(Request.prototype, 'text');
    try {
      const res = await post({ ...REPORT, ...LAYOUT });
      expect(res.status).toBe(403);
      expect(text).not.toHaveBeenCalled();
      noDatabaseWasTouched();
    } finally {
      text.mockRestore();
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

`cd site && npx vitest run lib/mapAdminRoutes.test.ts`
Expected: `hands the layout fields…` fails (`expected { appliedVersion: 1, … } to match object { layoutSchema: 1, … }`); `refuses a report over the byte cap…` fails with `expected 200 to be 413`; the anonymous test already passes (today's route reads with `.json()`). `Tests  2 failed | 23 passed (25)`.

- [ ] **Step 3: Write minimal implementation**

In `site/app/api/admin/map/report/route.ts`, after line 4 (`import { isKnownOverlayWorld } …`) insert:

```ts
import { MAX_LAYOUT_BYTES } from '@/lib/mapLayout';
```

Replace lines 44-55 (from `  let body: {` through the `catch` block's closing `  }`) with:

```ts
  /* Checked twice: the declared length refuses an honest oversized client before a byte
   * is read; the bytes that arrived are checked again because the header is the client's
   * claim. `Buffer.byteLength` counts UTF-8 bytes (a Cyrillic name is not under-counted as
   * `text.length` would); this is a Node route. 4 MB sits under Vercel's 4.5 MB body limit. */
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_LAYOUT_BYTES) return NextResponse.json({ error: 'Report too large' }, { status: 413 });
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_LAYOUT_BYTES) return NextResponse.json({ error: 'Report too large' }, { status: 413 });

  let body: {
    world?: unknown; appliedVersion?: unknown; objects?: unknown; applied?: unknown; unresolved?: unknown;
    layoutSchema?: unknown; bounds?: unknown; shapes?: unknown; ground?: unknown;
  };
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
```

Then replace lines 67-72 (the `await recordWorldReport(db, world, {` call through its `});`) with:

```ts
    // The layout fields go through as-is for the same reason: the store, not
    // the route, decides what a usable grid is, and keeps the prior one if not.
    await recordWorldReport(db, world, {
      appliedVersion: Number(body.appliedVersion) || 0,
      objects: Array.isArray(body.objects) ? (body.objects as never[]) : [],
      applied: Array.isArray(body.applied) ? (body.applied as never[]) : [],
      unresolved: Array.isArray(body.unresolved) ? (body.unresolved as never[]) : [],
      layoutSchema: body.layoutSchema,
      bounds: body.bounds,
      shapes: body.shapes,
      ground: body.ground,
    });
```

- [ ] **Step 4: Run test to verify it passes**

`cd site && npx vitest run lib/mapAdminRoutes.test.ts` — expected `Tests  25 passed (25)`.

- [ ] **Step 5: Commit**

```
git add site/app/api/admin/map/report/route.ts site/lib/mapAdminRoutes.test.ts
git commit -m "The report route accepts a layout and refuses one over four megabytes" -m "The game's second report carries a ground grid of up to 700 KB base64, so the route now has a body cap where before request.json() was unbounded. The declared length is checked before a byte is read and the received bytes after, because the header is the client's claim. The admin gate still comes first: a refused caller's body is never read, and the test spies on Request.prototype to prove it. Layout fields pass through to the store unchanged; the store validates them and keeps the prior layout when they fail." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 6: The editor's read returns the layout and when it was reported

**Files:** Modify `site/app/api/admin/map/[world]/route.ts` (lines 66-71); Modify `site/lib/mapAdminRoutes.test.ts` (inside `describe('GET /api/admin/map/[world]', …)`, after its last test at line 196)

- [ ] **Step 1: Write the failing test**

Inside the GET `describe`, after `refuses a world the game does not have…`, add:

```ts
  it('returns layout null and reportedAt null for a world nobody has visited', async () => {
    signedInAs(ADMIN);
    const body = await (await get()).json();
    expect(body.report).toBeNull();
    expect(body.layout).toBeNull();
    expect(body.reportedAt).toBeNull();
  });

  it('returns the stored layout and its age from the one report read, beside an unchanged report', async () => {
    signedInAs(ADMIN);
    const layout = {
      schema: 1, bounds: { min: { x: -10, y: 0, z: -10 }, max: { x: 10, y: 5, z: 10 } }, shapes: [],
      ground: { originX: -10, originZ: -10, step: 20, nx: 2, nz: 2, layers: 1, heightsCm: encodeHeights(new Int16Array(4)) },
    };
    const report = { appliedVersion: 2, objects: [{ name: 'crate', position: { x: 0, y: 0, z: 0 } }], applied: [], unresolved: [], reportedAt: '2026-08-27T10:00:00.000Z' };
    store.readWorldReport.mockResolvedValue({ ...report, layout });
    const body = await (await get()).json();
    expect(body.layout).toEqual(layout);
    expect(body.reportedAt).toBe(report.reportedAt);
    expect(body.report).toEqual(report);
    expect(store.readWorldReport).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

`cd site && npx vitest run lib/mapAdminRoutes.test.ts`
Expected: `returns layout null…` fails with `expected undefined to be null`; `returns the stored layout…` fails with `expected undefined to deeply equal { schema: 1, … }`. `Tests  2 failed | 25 passed (27)`.

- [ ] **Step 3: Write minimal implementation**

In `site/app/api/admin/map/[world]/route.ts`, replace lines 66-71:

```ts
    const [overlay, versions, report] = await Promise.all([
      readCurrentOverlay(db, world),
      listOverlayVersions(db, world),
      readWorldReport(db, world),
    ]);
    return NextResponse.json({ world, overlay, versions, report });
```

with:

```ts
    const [overlay, versions, stored] = await Promise.all([
      readCurrentOverlay(db, world),
      listOverlayVersions(db, world),
      readWorldReport(db, world),
    ]);
    // One read serves both. `report` keeps its shape for the panel that already reads it; the layout
    // rides BESIDE it (a 700 KB grid is not catalogue), and `reportedAt` is lifted so the editor can show the map's age.
    const report = stored && {
      appliedVersion: stored.appliedVersion, objects: stored.objects, applied: stored.applied,
      unresolved: stored.unresolved, reportedAt: stored.reportedAt,
    };
    return NextResponse.json({ world, overlay, versions, report, layout: stored?.layout ?? null, reportedAt: stored?.reportedAt ?? null });
```

- [ ] **Step 4: Run test to verify it passes**

`cd site && npx vitest run lib/mapAdminRoutes.test.ts` — expected `Tests  27 passed (27)`.

- [ ] **Step 5: Commit**

```
git add "site/app/api/admin/map/[world]/route.ts" site/lib/mapAdminRoutes.test.ts
git commit -m "The editor's read returns the layout and when it was reported" -m "GET /api/admin/map/{world} now answers with layout and reportedAt beside overlay, versions and report, from the same single readWorldReport call — no second round trip. report keeps exactly its previous shape so the existing panel is untouched until chunk 4 replaces it; a world nobody has visited answers null for both new fields, which is the value the editor turns into 'No layout yet — enter this world in game as admin'." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 7: Gates

**Files:** none, unless a gate fails

- [ ] **Step 1: Full site suite**

`cd site && npm test`
Expected: no `failed`; exit 0. If the count line carries a `skipped` figure, `lib/mapOverlay.test.ts` did not reach Postgres and this chunk is NOT done — set `POSTGRES_TEST_URL` and rerun until that file reports `17 passed` with 0 skipped.

- [ ] **Step 2: Type-check and build**

`cd site && npx tsc --noEmit -p .` — expected: no output, exit 0.
`cd site && npm run build:site-only` — expected: `✓ Compiled successfully`, the route table lists `ƒ /api/admin/map/[world]` and `ƒ /api/admin/map/report`, exit 0.

- [ ] **Step 3: Confirm the tree; nothing further to commit**

`git status --short` — expected: empty. `git log --oneline -6` — expected: the six commits from Tasks 1-6, newest first, beginning `The editor's read returns the layout and when it was reported`. Do not push, do not merge. Chunk 3 imports `site/lib/mapLayout.ts` exactly as committed here.


---

## Chunk 3: Site — conflict detection and the save gate

**Depends on chunk 2.** Every task imports `site/lib/mapLayout.ts` (`groundAt`, `decodeGround`, `encodeHeights`, `NO_SAMPLE`, the `WorldLayout`/`DecodedGround` types) and the route reads the `WorldReport.layout` field chunk 2 adds to `readWorldReport`. At the time of writing neither exists in the tree. **If `site/lib/mapLayout.ts` is absent when this chunk starts, execute chunk 2 first** — Task 1's red run would otherwise fail for the wrong reason (`Failed to resolve import "./mapLayout"`), and a red for the wrong reason is not a red.

What this chunk delivers: `site/lib/mapConflicts.ts`, a pure module implementing the skeleton's stage-1 rule table (§9 with `{name}` targets as points), one rule per TDD slice; then the save route runs it and refuses any error-level result with `400 { error: 'conflicts', rejected }` and nothing written.

Two decisions the skeleton leaves open, taken here:

1. **`rejected[].index` is the index into the array the client SENT** — the coordinate the normaliser's own `rejected[].index` already uses. Conflicts run over normalised entries (position k there is not raw index k, the normaliser drops entries), so the route maps k back. Every raw index lands in exactly one of `entries` or `rejected`, which makes the mapping sound; a test pins it.
2. **Reverts bypass the gate.** `revertOverlayTo` re-saves an old version's entries; a version accepted once stays reachable even if a layout reported later would refuse it, or history becomes unreachable by accident. The gate is for NEW documents, the only place a fresh mistake can enter.

All commands run from `site/` unless stated.

---

### Task 1: `mapConflicts.ts` scaffold — `duplicate-target` and `stale-name`

**Files:**
- Create: `site/lib/mapConflicts.ts`
- Create: `site/lib/mapConflicts.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// site/lib/mapConflicts.test.ts
import { describe, it, expect } from 'vitest';
import type { MoveEntry, PlaceEntry } from './mapOverlaySchema';
import type { WorldLayout } from './mapLayout';
import { conflictsFor, conflictsForDocument, hasErrors, type Conflict, type ConflictContext } from './mapConflicts';

/**
 * What the map editor says is wrong with an entry — and what the save route
 * refuses.
 *
 * The page runs these rules live so the admin sees "underground" beside a row
 * before clicking Save; the route runs the SAME function and refuses on any
 * error. One module, two callers. So these cases are not about a UI: each is a
 * document the server will either write into a live world or send back, and
 * every assertion is on the exact code list, because "some warning fired" is
 * how a wrong rule hides behind a right one.
 *
 * Nothing here is stubbed. The ground cases build a real Int16 grid through
 * `encodeHeights` + `decodeGround` and go through the real `groundAt`, so a
 * regression in the grid arithmetic shows up here as well as in mapLayout's
 * own tests.
 */

function move(over: Partial<MoveEntry> = {}): MoveEntry {
  return { kind: 'move', id: 'm1', target: { name: 'barn.roof' }, position: { x: 2, y: 2, z: 2 }, ...over };
}

function place(over: Partial<PlaceEntry> = {}): PlaceEntry {
  const item = { source_key: 'pack_ammo:station', name: 'Ammo pack', config: {} };
  return { kind: 'place', id: 'p1', item, position: { x: 2, y: 2, z: 2 }, quantity: 1, ...over };
}

function layout(over: Partial<WorldLayout> = {}): WorldLayout {
  const bounds = { min: { x: -100, y: 0, z: -100 }, max: { x: 100, y: 50, z: 100 } };
  return { schema: 1, bounds, shapes: [], ground: null, ...over };
}

function ctx(over: Partial<ConflictContext> = {}): ConflictContext {
  return { layout: null, ground: null, objects: [], ...over };
}

const codes = (cs: Conflict[]) => cs.map((c) => c.code);
const crate = { name: 'crate', position: { x: 0, y: 0, z: 0 } };

describe('the name rules, which need no layout', () => {
  it('finds nothing wrong with a lone move in a world that has reported nothing', () => {
    expect(conflictsFor(move(), 0, [move()], ctx())).toEqual([]);
  });

  it('warns both entries when two moves aim at the same object, naming each other', () => {
    const doc = [move({ id: 'a' }), move({ id: 'b', position: { x: 50, y: 2, z: 50 } })];
    const all = conflictsForDocument(doc, ctx());
    expect(all).toHaveLength(2);
    expect(all[0]).toEqual([expect.objectContaining({ level: 'warn', code: 'duplicate-target', other: 'b' })]);
    expect(all[1]).toEqual([expect.objectContaining({ level: 'warn', code: 'duplicate-target', other: 'a' })]);
  });

  it('does not call a move and a place duplicates: a placement has no target', () => {
    expect(conflictsForDocument([move(), place()], ctx())).toEqual([[], []]);
  });

  it('warns about a target the world did not report, but only once the world has reported something', () => {
    expect(codes(conflictsFor(move(), 0, [move()], ctx({ objects: [] })))).toEqual([]);
    expect(codes(conflictsFor(move(), 0, [move()], ctx({ objects: [crate] })))).toEqual(['stale-name']);
    const known = move({ target: { name: 'crate' } });
    expect(codes(conflictsFor(known, 0, [known], ctx({ objects: [crate] })))).toEqual([]);
  });

  it('gives a hidden move, which has no position, the name rules and nothing else', () => {
    const hidden = move({ position: null, hidden: true });
    const found = conflictsFor(hidden, 0, [hidden], ctx({ layout: layout(), objects: [crate] }));
    expect(codes(found)).toEqual(['stale-name']);
  });

  it('lets a move a kilometre out through when there is no layout to measure against', () => {
    const far = move({ position: { x: 1000, y: 0, z: 1000 } });
    expect(conflictsFor(far, 0, [far], ctx())).toEqual([]);
  });
});

describe('hasErrors', () => {
  it('is true only when some entry carries an error', () => {
    const warn: Conflict = { level: 'warn', code: 'stale-name', detail: '' };
    const error: Conflict = { level: 'error', code: 'out-of-bounds', detail: '' };
    expect(hasErrors([])).toBe(false);
    expect(hasErrors([[warn], []])).toBe(false);
    expect(hasErrors([[], [warn, error]])).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd site && npx vitest run lib/mapConflicts.test.ts
```
Expected: `Error: Failed to resolve import "./mapConflicts" from "lib/mapConflicts.test.ts". Does the file exist?` — `Test Files  1 failed (1)`.

- [ ] **Step 3: Write minimal implementation**

```ts
// site/lib/mapConflicts.ts
import type { OverlayEntry, PlaceEntry, Vec3 } from './mapOverlaySchema';
import type { WorldLayout, DecodedGround } from './mapLayout';
import type { CatalogueObject } from './mapOverlay';

/**
 * What is wrong with a map entry, before it is saved.
 *
 * ── Why the page checks and the route checks again ─────────────────────────
 *
 * The editor runs these rules on every drag so the admin sees "underground"
 * beside the row before clicking Save. That is a courtesy — it makes the
 * editor pleasant — and nothing about a live world may rest on a courtesy.
 * The save route runs the SAME function over the SAME inputs and refuses on
 * any error-level result, so a client that skipped the check, a stale tab or
 * a replayed request cannot write what the page would have refused. One
 * module, two callers: the route is the boundary, the page is the preview.
 *
 * ── Why only `out-of-bounds` refuses ───────────────────────────────────────
 *
 * The rest are sometimes right on purpose — a lantern hangs in the air, a
 * cellar door sits under the ground, two crates touch — and the admin can see
 * the map where this module cannot. A position outside the world's own bounds
 * is never right on purpose, and saving it produces an object nobody can find.
 *
 * ── Occupancy is the layout composed with the document ─────────────────────
 *
 * A named object stands where the game reported it UNLESS this document moves
 * it (then it stands at the new position only) or hides it (then nowhere). So
 * a moved crate is tested where it now stands and can never "overlap" its own
 * old position. Every entry stands at its own position.
 *
 * ── Why `{name}` targets are points ─────────────────────────────────────────
 *
 * The reported catalogue carries a name and a position; a world AABB for two
 * thousand arbitrary groups on every report is not free. So a named object is
 * a point for the ground rules (bottom = `position.y`) and a 1 m disc for
 * overlap. A placement has a footprint from `placeFootprint`, 1 × 1 × 1 m by
 * default — symmetric, so `rotationY` cannot change it in stage 1; the rect is
 * rotated once a real per-item size table exists (stage 2+).
 *
 * Imports are pure code plus one erased type, so this runs in the browser and
 * in a unit test without `pg`. Nothing throws: a rule that cannot decide says
 * nothing.
 */

export type ConflictLevel = 'error' | 'warn';
export type ConflictCode =
  | 'out-of-bounds'
  | 'stale-name'
  | 'duplicate-target'
  | 'underground'
  | 'floating'
  | 'no-ground'
  | 'overlap';

export interface Conflict {
  level: ConflictLevel;
  code: ConflictCode;
  detail: string;
  /** The offending object name or entry id, for `duplicate-target` and `overlap`. */
  other?: string;
}

export interface ConflictContext {
  layout: WorldLayout | null;
  /** `decodeGround(layout.ground)`, done once by the caller. */
  ground: DecodedGround | null;
  /** `report.objects` — what the game last said stands in this world. */
  objects: CatalogueObject[];
  /** Footprint of a placed item in metres. Default 1 × 1 × 1. */
  placeFootprint?: (entry: PlaceEntry) => { w: number; d: number; h: number };
}

/** Metres past the reported bounds before a position is refused: props already lean over the edge. */
export const BOUNDS_MARGIN = 5;
/** A bottom this far under the ground is still "resting on it" — sunk props are authored that way. */
export const UNDERGROUND_TOLERANCE = 0.25;
/** A bottom this far above the ground is still "on it" — steps, plinths, a lifted pivot. */
export const FLOATING_TOLERANCE = 1.5;
/** XZ distance under which two points are the same spot. */
export const POINT_CLEARANCE = 1;
/** How far a footprint rect grows when tested against a point. */
const POINT_HALF = POINT_CLEARANCE / 2;
const DEFAULT_FOOTPRINT = { w: 1, d: 1, h: 1 };

interface Rect { minX: number; maxX: number; minZ: number; maxZ: number }
/** Something standing in the world: a reported object (point) or an entry (point or rect). */
interface Occupant { key: string; label: string; x: number; z: number; rect: Rect | null }
interface Prepared { names: Set<string>; occupants: Occupant[] }

const warn = (code: ConflictCode, detail: string, other?: string): Conflict =>
  ({ level: 'warn', code, detail, ...(other ? { other } : {}) });

const entryKey = (index: number): string => `entry:${index}`;

function footprintRect(entry: PlaceEntry, ctx: ConflictContext): Rect {
  const size = ctx.placeFootprint?.(entry) ?? DEFAULT_FOOTPRINT;
  const { x, z } = entry.position;
  return { minX: x - size.w / 2, maxX: x + size.w / 2, minZ: z - size.d / 2, maxZ: z + size.d / 2 };
}

/** The reported names, and the occupancy of layout ∘ document (see the header). */
function prepare(document: OverlayEntry[], ctx: ConflictContext): Prepared {
  const names = new Set(ctx.objects.map((o) => o.name));
  const touched = new Set<string>();
  for (const entry of document) if (entry.kind === 'move') touched.add(entry.target.name);

  const occupants: Occupant[] = [];
  for (const obj of ctx.objects) {
    if (touched.has(obj.name)) continue;
    occupants.push({ key: `object:${obj.name}`, label: obj.name, x: obj.position.x, z: obj.position.z, rect: null });
  }
  document.forEach((entry, index) => {
    if (!entry.position) return;
    const rect = entry.kind === 'place' ? footprintRect(entry, ctx) : null;
    occupants.push({ key: entryKey(index), label: entry.id, x: entry.position.x, z: entry.position.z, rect });
  });
  return { names, occupants };
}

function nameRules(entry: OverlayEntry, index: number, document: OverlayEntry[], prepared: Prepared, out: Conflict[]): void {
  if (entry.kind !== 'move') return;
  const name = entry.target.name;
  if (prepared.names.size > 0 && !prepared.names.has(name)) {
    out.push(warn('stale-name', `"${name}" is not among the ${prepared.names.size} objects this world last reported`));
  }
  document.forEach((other, j) => {
    if (j !== index && other.kind === 'move' && other.target.name === name) {
      out.push(warn('duplicate-target', `"${other.id}" also moves "${name}"; the last one wins`, other.id));
    }
  });
}

function conflictsWith(entry: OverlayEntry, index: number, document: OverlayEntry[], ctx: ConflictContext, prepared: Prepared): Conflict[] {
  const out: Conflict[] = [];
  nameRules(entry, index, document, prepared, out);
  return out;
}

/** Conflicts for one entry of `document` (which must contain it at `index`). */
export function conflictsFor(entry: OverlayEntry, index: number, document: OverlayEntry[], ctx: ConflictContext): Conflict[] {
  return conflictsWith(entry, index, document, ctx, prepare(document, ctx));
}

/** One conflict list per entry, in document order. */
export function conflictsForDocument(document: OverlayEntry[], ctx: ConflictContext): Conflict[][] {
  const prepared = prepare(document, ctx);
  return document.map((entry, index) => conflictsWith(entry, index, document, ctx, prepared));
}

export function hasErrors(all: Conflict[][]): boolean {
  return all.some((conflicts) => conflicts.some((c) => c.level === 'error'));
}
```

`Vec3` is first used in Task 2, `ctx` and `prepared.occupants` in Task 4; the scaffold carries the occupancy composition because the header documents it and Task 4 only adds the rule that reads it.

- [ ] **Step 4: Run test to verify it passes**

```
cd site && npx vitest run lib/mapConflicts.test.ts
```
Expected: ` ✓ lib/mapConflicts.test.ts (7 tests)` — `Test Files  1 passed (1)`, `Tests  7 passed (7)`.

- [ ] **Step 5: Commit**

```
git add site/lib/mapConflicts.ts site/lib/mapConflicts.test.ts
git commit -m "The map editor can tell when two entries move the same object, or name one the world never reported" -m "One pure module for what is wrong with an entry, used by the editor as a preview and by the save route as the boundary. This first slice is the two rules that need no layout: a duplicate target (v1 let two moves act on one object, last wins, so it is a warning and old versions stay saveable) and a target name absent from the world's reported catalogue (advisory, because the catalogue is capped and a world nobody has visited must still save free-text moves on day one). The occupancy composition, a named object standing where it was reported unless this document moves or hides it, is in place for the overlap rule that follows." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `out-of-bounds` — the one error

**Files:**
- Modify: `site/lib/mapConflicts.ts` (the `conflictsWith` body)
- Modify: `site/lib/mapConflicts.test.ts` (append)

- [ ] **Step 1: Write the failing test** — append to the end of `mapConflicts.test.ts`:

```ts
describe('out-of-bounds, the only error', () => {
  const bounded = () => ctx({ layout: layout() });

  it('accepts a position inside the bounds and within the 5 m margin', () => {
    for (const x of [0, 100, 104, -104]) {
      const m = move({ position: { x, y: 2, z: 0 } });
      expect(conflictsFor(m, 0, [m], bounded()), `x=${x}`).toEqual([]);
    }
  });

  it('refuses, as an error, a position past the margin on either axis, for moves and places', () => {
    const error = [expect.objectContaining({ level: 'error', code: 'out-of-bounds' })];
    for (const [x, z] of [[106, 0], [-106, 0], [0, 106], [0, -106]]) {
      const m = move({ position: { x, y: 2, z } });
      const p = place({ position: { x, y: 2, z } });
      expect(conflictsFor(m, 0, [m], bounded()), `move ${x},${z}`).toEqual(error);
      expect(conflictsFor(p, 0, [p], bounded()), `place ${x},${z}`).toEqual(error);
    }
  });

  it('names the axis in the detail, so the row says which number to fix', () => {
    const m = move({ position: { x: 2, y: 2, z: 300 } });
    expect(conflictsFor(m, 0, [m], bounded())[0].detail).toMatch(/^z = 300 /);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd site && npx vitest run lib/mapConflicts.test.ts
```
Expected: 2 failures — `AssertionError: expected [] to deeply equal [ ObjectContaining{…} ]` (move 106,0) and `TypeError: Cannot read properties of undefined (reading 'detail')`. `Tests  2 failed | 8 passed (10)`.

- [ ] **Step 3: Write minimal implementation** — in `mapConflicts.ts` replace

```ts
  const out: Conflict[] = [];
  nameRules(entry, index, document, prepared, out);
  return out;
}
```

with

```ts
  const out: Conflict[] = [];
  nameRules(entry, index, document, prepared, out);
  const pos = entry.position;
  if (!pos || !ctx.layout) return out;
  boundsRule(pos, ctx.layout, out);
  return out;
}
```

and insert directly above `function conflictsWith(`:

```ts
function boundsRule(pos: Vec3, layout: WorldLayout, out: Conflict[]): void {
  const { min, max } = layout.bounds;
  for (const [axis, value, lo, hi] of [['x', pos.x, min.x, max.x], ['z', pos.z, min.z, max.z]] as const) {
    if (value < lo - BOUNDS_MARGIN || value > hi + BOUNDS_MARGIN) {
      const detail = `${axis} = ${value} is outside the world's bounds (${lo} to ${hi}, ±${BOUNDS_MARGIN} m)`;
      out.push({ level: 'error', code: 'out-of-bounds', detail });
      return;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```
cd site && npx vitest run lib/mapConflicts.test.ts
```
Expected: `Tests  10 passed (10)`.

- [ ] **Step 5: Commit**

```
git add site/lib/mapConflicts.ts site/lib/mapConflicts.test.ts
git commit -m "A move outside the world's bounds is an error the editor can name" -m "The only rule that refuses rather than warns. Every other conflict is sometimes right on purpose and the admin can see the map; a position past the world's own reported bounds (plus five metres, because authored props already lean over the edge) is never right on purpose, and saving it produces an object nobody can find. The 20 000 m limit stays the normaliser's job; this is the per-world one, and it only exists once a layout has been reported." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `underground`, `floating`, `no-ground` through the real grid

**Files:**
- Modify: `site/lib/mapConflicts.ts` (import line; `conflictsWith` body)
- Modify: `site/lib/mapConflicts.test.ts` (import line; append)

- [ ] **Step 1: Write the failing test** — in `mapConflicts.test.ts` replace the line `import type { WorldLayout } from './mapLayout';` with

```ts
import { NO_SAMPLE, decodeGround, encodeHeights, type DecodedGround, type WorldLayout } from './mapLayout';
```

and append to the end of the file:

```ts
describe('the ground rules, through a real Int16 grid', () => {
  /** Four samples 4 m apart with origin (0,0): one cell covering x,z ∈ [0, 4], one layer. */
  function flatGround(heightCm: number): DecodedGround {
    const heightsCm = encodeHeights(Int16Array.from([heightCm, heightCm, heightCm, heightCm]));
    return decodeGround({ originX: 0, originZ: 0, step: 4, nx: 2, nz: 2, layers: 1, heightsCm });
  }
  const twoMetres = () => ctx({ layout: layout(), ground: flatGround(200) });

  it('accepts a bottom within the tolerances around the ground', () => {
    for (const y of [2, 1.8, 3.4]) {
      const m = move({ position: { x: 2, y, z: 2 } });
      expect(conflictsFor(m, 0, [m], twoMetres()), `y=${y}`).toEqual([]);
    }
  });

  it('warns underground when the bottom is more than 0.25 m below the ground, for moves and places', () => {
    const m = move({ position: { x: 2, y: 1.7, z: 2 } });
    const p = place({ position: { x: 2, y: 1.7, z: 2 } });
    expect(codes(conflictsFor(m, 0, [m], twoMetres()))).toEqual(['underground']);
    expect(codes(conflictsFor(p, 0, [p], twoMetres()))).toEqual(['underground']);
    expect(conflictsFor(m, 0, [m], twoMetres())[0].level).toBe('warn');
  });

  it('warns floating when the bottom is more than 1.5 m above the ground', () => {
    const m = move({ position: { x: 2, y: 3.6, z: 2 } });
    expect(codes(conflictsFor(m, 0, [m], twoMetres()))).toEqual(['floating']);
  });

  it('warns no-ground where the grid has no surface at all', () => {
    const m = move({ position: { x: 2, y: 2, z: 2 } });
    const c = ctx({ layout: layout(), ground: flatGround(NO_SAMPLE) });
    expect(codes(conflictsFor(m, 0, [m], c))).toEqual(['no-ground']);
  });

  it('says nothing about the ground when the layout has no grid yet', () => {
    const m = move({ position: { x: 2, y: -50, z: 2 } });
    expect(conflictsFor(m, 0, [m], ctx({ layout: layout(), ground: null }))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd site && npx vitest run lib/mapConflicts.test.ts
```
Expected: 3 failures — `AssertionError: expected [] to deeply equal [ 'underground' ]`, `… [ 'floating' ]`, `… [ 'no-ground' ]`. `Tests  3 failed | 12 passed (15)`.

- [ ] **Step 3: Write minimal implementation** — in `mapConflicts.ts` replace the line `import type { WorldLayout, DecodedGround } from './mapLayout';` with

```ts
import { groundAt, type DecodedGround, type WorldLayout } from './mapLayout';
```

Replace, inside `conflictsWith`,

```ts
  boundsRule(pos, ctx.layout, out);
  return out;
}
```

with

```ts
  boundsRule(pos, ctx.layout, out);
  if (ctx.ground) groundRule(pos, ctx.ground, out);
  return out;
}
```

and insert directly above `function conflictsWith(`:

```ts
const m = (n: number) => String(Math.round(n * 100) / 100);

/**
 * The bottom of a point entry is its `position.y`. `groundAt` picks the layer
 * at or below that y per corner, so under a dome this measures against the
 * deck, not the roof.
 */
function groundRule(pos: Vec3, ground: DecodedGround, out: Conflict[]): void {
  const g = groundAt(ground, pos.x, pos.z, pos.y);
  if (g === null) {
    out.push(warn('no-ground', `no surface under (${m(pos.x)}, ${m(pos.z)}) — water, a hole, or off the deck`));
  } else if (pos.y < g - UNDERGROUND_TOLERANCE) {
    out.push(warn('underground', `bottom at y = ${m(pos.y)} is ${m(g - pos.y)} m under the ground at ${m(g)}`));
  } else if (pos.y > g + FLOATING_TOLERANCE) {
    out.push(warn('floating', `bottom at y = ${m(pos.y)} is ${m(pos.y - g)} m above the ground at ${m(g)}`));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```
cd site && npx vitest run lib/mapConflicts.test.ts
```
Expected: `Tests  15 passed (15)`.

- [ ] **Step 5: Commit**

```
git add site/lib/mapConflicts.ts site/lib/mapConflicts.test.ts
git commit -m "The editor warns when a moved object would sit under or above the ground" -m "Three warnings from the sampled grid: a bottom more than a quarter metre under the surface, more than a metre and a half above it, or over a cell with no surface at all. All warnings, because every one is sometimes deliberate and the admin is looking at the map. The height comes from groundAt with the entry's own y, so at a roof edge or under a dome the rule measures against the surface the object would actually stand on. The tests build a real Int16 grid through encodeHeights and decodeGround rather than faking a sampler." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `overlap` — points, footprints, and the occupancy composition

**Files:**
- Modify: `site/lib/mapConflicts.ts` (`conflictsWith` body)
- Modify: `site/lib/mapConflicts.test.ts` (append)

- [ ] **Step 1: Write the failing test** — append to the end of `mapConflicts.test.ts`:

```ts
describe('overlap, against the layout composed with the document', () => {
  const withLayout = (objects: ConflictContext['objects'] = []) => ctx({ layout: layout(), objects });
  const at = (x: number, z: number) => ({ x, y: 2, z });
  // A second move needs its own target, or duplicate-target fires as well and
  // the exact-list assertions below would be testing two rules at once.
  const silo = { name: 'silo' };
  const overlapWith = (other: string) => expect.objectContaining({ level: 'warn', code: 'overlap', other });

  it('warns two points closer than a metre, naming each other, and not at exactly a metre', () => {
    const near = [move({ id: 'a', position: at(0, 0) }), move({ id: 'b', target: silo, position: at(0.5, 0) })];
    expect(conflictsForDocument(near, withLayout())).toEqual([[overlapWith('b')], [overlapWith('a')]]);
    const apart = [move({ id: 'a', position: at(0, 0) }), move({ id: 'b', target: silo, position: at(1, 0) })];
    expect(conflictsForDocument(apart, withLayout())).toEqual([[], []]);
  });

  it('does not look for overlaps when there is no layout', () => {
    const near = [move({ id: 'a', position: at(0, 0) }), move({ id: 'b', target: silo, position: at(0.5, 0) })];
    expect(conflictsForDocument(near, ctx())).toEqual([[], []]);
  });

  it('warns a move that lands on a reported object, naming the object', () => {
    const farCrate = { name: 'crate', position: { x: 10, y: 0, z: 10 } };
    const roof = { name: 'barn.roof', position: { x: 0, y: 0, z: 0 } };
    const m = move({ position: at(10.4, 10) });
    expect(conflictsFor(m, 0, [m], withLayout([farCrate, roof]))).toEqual([overlapWith('crate')]);
  });

  it('does not overlap a moved object with its own old position', () => {
    const roof = { name: 'barn.roof', position: { x: 2, y: 2, z: 2 } };
    const m = move({ position: at(2.3, 2) });
    expect(conflictsFor(m, 0, [m], withLayout([roof]))).toEqual([]);
  });

  it('treats an object the document hides as occupying nothing', () => {
    const farCrate = { name: 'crate', position: { x: 10, y: 0, z: 10 } };
    const hide = move({ id: 'h', target: { name: 'crate' }, position: null, hidden: true });
    expect(conflictsForDocument([hide, place({ position: at(10, 10) })], withLayout([farCrate]))).toEqual([[], []]);
  });

  it('tests a placement as a footprint: a point within half a metre of its rect overlaps', () => {
    const p = place({ position: at(2, 2) });
    const inside = move({ id: 'in', position: at(2.9, 2) });
    // 4 is past the grown rect (x < 3) and 1.1 m from `inside`, so the two points do not meet either.
    const outside = move({ id: 'out', target: silo, position: at(4, 2) });
    expect(conflictsForDocument([p, inside, outside], withLayout())).toEqual([[overlapWith('in')], [overlapWith('p1')], []]);
  });

  it('consults placeFootprint for the size', () => {
    const p = place({ position: at(2, 2) });
    const m = move({ position: at(4.4, 2) });
    expect(conflictsForDocument([p, m], withLayout())).toEqual([[], []]);
    const wide = { ...withLayout(), placeFootprint: () => ({ w: 4, d: 4, h: 1 }) };
    expect(codes(conflictsForDocument([p, m], wide)[1])).toEqual(['overlap']);
  });

  it('intersects two placement rects, and never conflicts an entry with itself', () => {
    const a = place({ id: 'a', position: at(2, 2) });
    expect(conflictsForDocument([a], withLayout())).toEqual([[]]);
    const touching = place({ id: 'b', position: at(2.8, 2) });
    expect(codes(conflictsForDocument([a, touching], withLayout())[0])).toEqual(['overlap']);
    const clear = place({ id: 'b', position: at(3.2, 2) });
    expect(conflictsForDocument([a, clear], withLayout())).toEqual([[], []]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd site && npx vitest run lib/mapConflicts.test.ts
```
Expected: 5 failures — `warns two points closer…`: `expected [ [], [] ] to deeply equal [ [ ObjectContaining{…} ], [ ObjectContaining{…} ] ]`; `warns a move that lands on a reported object…`: `expected [] to deeply equal [ ObjectContaining{…} ]`; `tests a placement as a footprint…`: `expected [ [], [], [] ] to deeply equal …`; `consults placeFootprint…` and `intersects two placement rects…`: `expected [] to deeply equal [ 'overlap' ]`. The three "does not" cases pass vacuously. `Tests  5 failed | 18 passed (23)`.

- [ ] **Step 3: Write minimal implementation** — in `mapConflicts.ts` replace, inside `conflictsWith`,

```ts
  if (ctx.ground) groundRule(pos, ctx.ground, out);
  return out;
}
```

with

```ts
  if (ctx.ground) groundRule(pos, ctx.ground, out);
  overlapRule(entry, index, pos, ctx, prepared.occupants, out);
  return out;
}
```

and insert directly above `function conflictsWith(`:

```ts
function rectsMeet(a: Rect, b: Rect): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
}

function pointInRect(x: number, z: number, r: Rect, grow: number): boolean {
  return x > r.minX - grow && x < r.maxX + grow && z > r.minZ - grow && z < r.maxZ + grow;
}

function occupantsMeet(a: Occupant, b: Occupant): boolean {
  if (a.rect && b.rect) return rectsMeet(a.rect, b.rect);
  if (a.rect) return pointInRect(b.x, b.z, a.rect, POINT_HALF);
  if (b.rect) return pointInRect(a.x, a.z, b.rect, POINT_HALF);
  return Math.hypot(a.x - b.x, a.z - b.z) < POINT_CLEARANCE;
}

/** An entry never meets itself: it is skipped by key, and a moved object's old position is not in `occupants` at all. */
function overlapRule(entry: OverlayEntry, index: number, pos: Vec3, ctx: ConflictContext, occupants: Occupant[], out: Conflict[]): void {
  const rect = entry.kind === 'place' ? footprintRect(entry, ctx) : null;
  const self: Occupant = { key: entryKey(index), label: entry.id, x: pos.x, z: pos.z, rect };
  for (const other of occupants) {
    if (other.key === self.key || !occupantsMeet(self, other)) continue;
    const how = self.rect || other.rect ? 'footprint meets' : `within ${POINT_CLEARANCE} m of`;
    out.push(warn('overlap', `${how} "${other.label}"`, other.label));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```
cd site && npx vitest run lib/mapConflicts.test.ts
```
Expected: `Tests  23 passed (23)`.

- [ ] **Step 5: Commit**

```
git add site/lib/mapConflicts.ts site/lib/mapConflicts.test.ts
git commit -m "The editor warns when two placements would stand in the same spot" -m "Overlap is tested against the layout composed with the document: a reported object stands where the game saw it unless this document moves it, in which case it stands at the new position only, and an object the document hides stands nowhere. That is what stops a moved crate from overlapping the place it came from. Named objects are points (the catalogue carries no bounds) and meet within a metre; placements are axis-aligned footprints, one metre square by default, grown by half a metre against a point. Rotation is left alone until a real per-item size table gives it something to rotate." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: The save gate in `POST /api/admin/map/[world]`

Line numbers below are for the tree AS CHUNK 2 LEAVES IT and are approximate — anchor on the quoted text. Chunk 2's Task 6 replaces `route.ts` lines 66-71 (6 lines) with 23, so the POST handler sits about 17 lines lower than in today's file; its Task 5 adds one import and three report tests, and its Task 6 two GET tests, to `mapAdminRoutes.test.ts`, so the POST describe sits about 26 lines lower.

**Files:**
- Modify: `site/app/api/admin/map/[world]/route.ts` (imports, lines 5-13; two helpers after line 52; POST between the revert block's closing `}` ≈ line 170 and `const saved` ≈ line 172)
- Modify: `site/lib/mapAdminRoutes.test.ts` (EDIT the existing line-2 import; five cases inside `describe('POST /api/admin/map/[world]'`, before its closing `});` ≈ line 343)

- [ ] **Step 1: Write the failing test** — in `mapAdminRoutes.test.ts`, chunk 2 already put this import on line 2:

```ts
import { MAX_LAYOUT_BYTES, encodeHeights } from '@/lib/mapLayout';
```

EDIT that line — do not add a second import from the same module, esbuild refuses the file for the duplicate `encodeHeights` binding and zero tests run — so it reads:

```ts
import { MAX_LAYOUT_BYTES, encodeHeights, type WorldLayout } from '@/lib/mapLayout';
```

(`@/lib/mapLayout` is real, not mocked: the gate must decode a stored grid for the warning case to mean anything.) Then insert the following directly after the `rejects a malformed body without reaching the store` case, before the `});` (≈ line 343) that closes the POST describe:

```ts
  /**
   * The conflict gate. The editor shows the same conflicts live, but the
   * editor is a courtesy; this route is the boundary. Only error-level
   * conflicts refuse, and a refusal writes nothing — no version, no audit row,
   * because the audit row records saves and there was no save.
   */
  const TINY: WorldLayout = {
    schema: 1,
    bounds: { min: { x: -10, y: 0, z: -10 }, max: { x: 10, y: 10, z: 10 } },
    shapes: [],
    ground: null,
  };
  /** Six by six samples 4 m apart from (−10, −10): a flat deck at y = 0 over the whole of TINY. */
  const FLAT_DECK = { originX: -10, originZ: -10, step: 4, nx: 6, nz: 6, layers: 1, heightsCm: encodeHeights(new Int16Array(36)) };
  function worldReports(layout: WorldLayout | null) {
    const objects = [{ name: 'crate', position: { x: 0, y: 0, z: 0 } }];
    store.readWorldReport.mockResolvedValue({ appliedVersion: 1, objects, applied: [], unresolved: [], layout, reportedAt: '2026-08-27T00:00:00.000Z' });
  }
  const crateTo = (x: number, y = 0, z = 0) => ({ kind: 'move', id: 'e1', target: { name: 'crate' }, position: { x, y, z } });

  it('refuses a move outside the world bounds and writes nothing, not even an audit row', async () => {
    signedInAs(ADMIN);
    worldReports(TINY);
    const res = await post({ entries: [crateTo(500)] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'conflicts', rejected: [{ index: 0, id: 'e1', reason: 'out-of-bounds' }] });
    expect(store.saveOverlayVersion).not.toHaveBeenCalled();
    expect(appendAudit).not.toHaveBeenCalled();
    expect(connections[0].statements).toContain('ROLLBACK');
    expect(connections[0].statements).not.toContain('COMMIT');
  });

  it("saves a document that only carries warnings: an underground move is the admin's call", async () => {
    signedInAs(ADMIN);
    worldReports({ ...TINY, ground: FLAT_DECK });
    // A grid that fails to decode is logged and skipped rather than refused, so
    // the spy is what proves the warning came from a decoded grid, not a skipped one.
    const err = vi.spyOn(console, 'error');
    try {
      const entries = [crateTo(0, -5, 0)];
      const res = await post({ entries });
      expect(res.status).toBe(200);
      expect(err).not.toHaveBeenCalled();
      expect(store.saveOverlayVersion).toHaveBeenCalledTimes(1);
      expect(store.saveOverlayVersion.mock.calls[0][1].entries).toEqual(entries);
      expect(appendAudit).toHaveBeenCalledTimes(1);
    } finally {
      err.mockRestore();
    }
  });

  it('saves free-text moves exactly as before when the world has no layout yet', async () => {
    signedInAs(ADMIN);
    store.readWorldReport.mockResolvedValue(null);
    const res = await post({ entries: [crateTo(500)] });
    expect(res.status).toBe(200);
    expect(store.saveOverlayVersion).toHaveBeenCalledTimes(1);
  });

  it("reports a rejected row by the index the client sent, not the normaliser's compacted one", async () => {
    signedInAs(ADMIN);
    worldReports(TINY);
    const res = await post({ entries: [{ kind: 'delete', id: 'junk' }, crateTo(500)] });
    expect(res.status).toBe(400);
    expect((await res.json()).rejected).toEqual([{ index: 1, id: 'e1', reason: 'out-of-bounds' }]);
  });

  it('does not run the gate on a revert: a version that was accepted once stays reachable', async () => {
    signedInAs(ADMIN);
    worldReports(TINY);
    const res = await post({ revertTo: 1 });
    expect(res.status).toBe(200);
    expect(store.readWorldReport).not.toHaveBeenCalled();
    expect(store.revertOverlayTo).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

```
cd site && npx vitest run lib/mapAdminRoutes.test.ts
```
Expected: 2 failures — `refuses a move outside the world bounds…` and `reports a rejected row by the index…`, both `AssertionError: expected 200 to be 400`. The other three new cases pass already: they describe behaviour that must NOT change. `Tests  2 failed | 30 passed (32)` (22 in today's file, 5 from chunk 2, 5 from this task).

- [ ] **Step 3: Write minimal implementation** — three edits to `site/app/api/admin/map/[world]/route.ts`.

(a) Lines 5-13 currently read:

```ts
import { isKnownOverlayWorld } from '@/lib/mapOverlaySchema';
import {
  ensureMapOverlaySchema,
  listOverlayVersions,
  readCurrentOverlay,
  readWorldReport,
  revertOverlayTo,
  saveOverlayVersion,
} from '@/lib/mapOverlay';
```

Replace line 5 and add two imports after line 13, so the block becomes:

```ts
import { isKnownOverlayWorld, normaliseOverlayEntries, type NormalisedOverlay } from '@/lib/mapOverlaySchema';
import {
  ensureMapOverlaySchema,
  listOverlayVersions,
  readCurrentOverlay,
  readWorldReport,
  revertOverlayTo,
  saveOverlayVersion,
} from '@/lib/mapOverlay';
import { conflictsForDocument, hasErrors, type Conflict, type ConflictCode } from '@/lib/mapConflicts';
import { decodeGround, type DecodedGround, type WorldLayout } from '@/lib/mapLayout';
```

(b) Insert after line 52 (the `}` closing `clientIp`), before `export async function GET(`:

```ts

/**
 * The stored ground grid, decoded for the conflict check — null when the
 * world has none, or when what is stored cannot be decoded. `validateLayout`
 * guards the write side, so an undecodable grid means the row was edited by
 * hand; that is no reason to make the world unsaveable. The ground rules are
 * warnings, and a warning that cannot be computed is simply not shown. The
 * bounds rule, the one that refuses, needs no grid.
 */
function groundFor(layout: WorldLayout | null): DecodedGround | null {
  if (!layout?.ground) return null;
  try {
    return decodeGround(layout.ground);
  } catch (err) {
    console.error('[admin/map] stored ground grid is undecodable; ground checks skipped:', err);
    return null;
  }
}

type Rejection = { index: number; id: string; reason: ConflictCode };

/**
 * Error-level conflicts as `rejected[]` rows, indexed into the array the
 * client SENT. The normaliser drops entries it cannot read, so position k in
 * its output is not raw index k; its own `rejected[].index` is a raw index and
 * the editor highlights rows by it, so these rows use the same coordinate and
 * one response never carries two meanings of "index". Every raw index lands in
 * exactly one of `entries` or `rejected`, which is what makes the walk sound.
 */
function conflictRejections(normalised: NormalisedOverlay, all: Conflict[][]): Rejection[] {
  const dropped = new Set(normalised.rejected.map((r) => r.index));
  const rawIndex: number[] = [];
  const total = normalised.entries.length + normalised.rejected.length;
  for (let i = 0; i < total; i++) if (!dropped.has(i)) rawIndex.push(i);

  const out: Rejection[] = [];
  all.forEach((conflicts, k) => {
    for (const c of conflicts) {
      if (c.level === 'error') out.push({ index: rawIndex[k], id: normalised.entries[k].id, reason: c.code });
    }
  });
  return out;
}
```

(c) In `POST`, the eight lines from the revert block's closing `}` (≈ line 170) currently read:

```ts
    }

    const saved = await saveOverlayVersion(db, {
      worldId: world,
      entries: body.entries,
      author: actor,
      note: typeof body.note === 'string' ? body.note : null,
    });
```

Insert the gate between the `}` closing the revert block (≈ line 170) and `const saved` (≈ line 172) — anchor on the text, the numbers are approximate — so the region becomes:

```ts
    }

    /* The conflict gate. The editor runs the same rules live and shows the
     * result before the admin clicks Save, but the editor is a courtesy: this
     * is the boundary, and a client that skipped the check (or a replayed
     * request) cannot write a document with an error-level conflict. Only
     * errors refuse; warnings are the admin's call and are saved as they are.
     * Refusing writes nothing — the audit row records saves, and there was no
     * save. Reverts bypass this on purpose (above): a version accepted once
     * stays reachable even after a later layout report would have refused it,
     * or history becomes unreachable by accident. `saveOverlayVersion`
     * normalises again below; the normaliser is a fixed point, and letting it
     * keep doing so leaves its `rejected` reporting exactly as it was. */
    const normalised = normaliseOverlayEntries(body.entries);
    const report = await readWorldReport(db, world);
    const layout = report?.layout ?? null;
    const conflicts = conflictsForDocument(normalised.entries, {
      layout,
      ground: groundFor(layout),
      objects: report?.objects ?? [],
    });
    if (hasErrors(conflicts)) {
      await db.query('ROLLBACK').catch(() => {});
      return NextResponse.json(
        { error: 'conflicts', rejected: conflictRejections(normalised, conflicts) },
        { status: 400 }
      );
    }

    const saved = await saveOverlayVersion(db, {
      worldId: world,
      entries: body.entries,
      author: actor,
      note: typeof body.note === 'string' ? body.note : null,
    });
```

Nothing else in the handler changes; `saveOverlayVersion` and `appendAudit` are reached only when the gate passes.

- [ ] **Step 4: Run test to verify it passes**

```
cd site && npx vitest run lib/mapConflicts.test.ts lib/mapAdminRoutes.test.ts
```
Expected: ` ✓ lib/mapConflicts.test.ts (23 tests)`, ` ✓ lib/mapAdminRoutes.test.ts (32 tests)` — `Test Files  2 passed (2)`, `Tests  55 passed (55)`.

- [ ] **Step 5: Commit**

```
git add "site/app/api/admin/map/[world]/route.ts" site/lib/mapAdminRoutes.test.ts
git commit -m "Saving the map refuses a document with an out-of-bounds move" -m "The route now runs the same conflict rules the editor shows live, over the world's last report and its stored layout, and answers 400 with rejected rows when any entry carries an error. Nothing is written on a refusal, no version and no audit row, since the audit row records saves. Warnings never block: an underground move saves as before, and a world with no layout yet saves free-text moves exactly as it did on day one. Rejected rows are indexed into the array the client sent, the same coordinate the normaliser already uses, so the editor can highlight the right row. Reverts skip the gate so a version that was accepted once stays reachable." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Gates

**Files:** none, unless a gate fails.

- [ ] **Step 1: The two suites this chunk owns** — `cd site && npx vitest run lib/mapConflicts.test.ts lib/mapAdminRoutes.test.ts`. Expected: `Test Files  2 passed (2)`, `Tests  55 passed (55)`, exit code 0.

- [ ] **Step 2: The whole site suite** — `cd site && npm test`. Expected: every file green, exit code 0. Read the exit code, not the scrollback.

- [ ] **Step 3: The site build, which is also the type-check** — `cd site && npm run build:site-only`. Expected: `✓ Compiled successfully`, a route table including `ƒ /api/admin/map/[world]`, exit code 0. The likely type error is `Property 'layout' does not exist on type 'WorldReport'` — that means chunk 2 is not merged into this worktree; merge it, do not stub the field.

- [ ] **Step 4: Red-green of the gate itself** — Task 5 committed the route, so the tree is clean and a stash would hold nothing. Check out the route as chunk 2 left it (one commit back) while keeping the new tests, and watch only those two go red:

```
git checkout HEAD~1 -- "site/app/api/admin/map/[world]/route.ts"
cd site && npx vitest run lib/mapAdminRoutes.test.ts
```
Expected: `Tests  2 failed | 30 passed (32)` — exactly the two `expected 200 to be 400` failures from Task 5 Step 2 and nothing else. Restore and confirm:

```
git checkout HEAD -- "site/app/api/admin/map/[world]/route.ts"
cd site && npx vitest run lib/mapAdminRoutes.test.ts
```
Expected: `Tests  32 passed (32)`, exit code 0, and `git status --short` empty.

- [ ] **Step 5: Commit** — nothing to commit if Steps 1-4 passed; the tree is what Task 5 committed. If a gate needed a fix, commit it alone with an effect line naming what the gate caught, the same body style and trailer as above. Do not push, do not merge.


---

## Chunk 4: Site — the map-first editor

**Executes after chunks 2 and 3.** The two modules here import, from `site/lib/mapLayout.ts` (chunk 2), only `groundAt`, `NO_SAMPLE`, the `DecodedGround` and `LayoutBounds` types, and — in the test — `encodeHeights`/`decodeGround`; from `site/lib/mapConflicts.ts` (chunk 3) only the `Conflict` type; all exactly as the skeleton's *Shared interfaces* define them. Chunks 5–7 consume the rest (`layersAt`, `conflictsForDocument`, `hasErrors`, the GET's `layout`/`reportedAt`). Nothing here re-implements any of that; if an import below does not resolve, chunk 2 or 3 has not landed in this worktree.

**What this chunk builds.** Two pure modules that make every geometric and editorial decision (`mapProjection.ts`, `mapEditorState.ts`), each red-green tested under the site vitest (node environment, no DOM). The canvas and the selection panel are **chunk 5** (`chunk-5.md`); the pending list and the `MapEditorPanel.tsx` rewrite that composes them are **chunk 6** (`chunk-6.md`); the CDP end-to-end harness, the manual checklist and the gates are **chunk 7** (`chunk-7.md`). The split is by the ≤ 1000-line budget only — chunks 4 → 5 → 6 → 7 execute in order, in one worktree.

**Constraints from the briefs, restated so nobody re-discovers them:**
- Site tests are `*.test.ts` only, `environment: 'node'`, no jsdom, no testing-library, no Playwright. Components cannot be unit-tested; anything that decides goes in a pure module and is tested there. A `.test.tsx` is silently skipped and `passWithNoTests` hides it.
- Styling is inline `CSSProperties` + the global `btn btn-ghost | btn-primary | btn-sm` classes + `.banner`. The global `input[type='number']` rule sets `clip-path: var(--clip-sm)` and `font-size: 1.25rem`; every number input here sets `clipPath: 'none'` inline (the existing `coord` style overrides font and padding but not clip-path).
- Canvas sizing is `fit()` from `site/lib/painters.ts`: it sets the bitmap to the CSS box × DPR and `setTransform(dpr)`, so **all drawing and hit-testing is in CSS px**; pointer positions are `e.clientX - rect.left`.
- Typecheck: `cd site && npx tsc --noEmit -p .` (the project has no `typecheck` script; `tsconfig.json` already includes `**/*.ts(x)` and `.next/types`). Build: `cd site && npm run build:site-only`.
- Commits: sentence-case effect line, why-prose body, trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and nothing else. Commit in the worktree; do not push.

---

### Task 1: `site/lib/mapProjection.ts` — world ↔ screen, pan/zoom, hit-testing

**Files:**
- Create: `site/lib/mapProjection.ts`
- Test: `site/lib/mapProjection.test.ts`

**The convention, fixed here and nowhere else:** `sx = ox + x·scale`, `sy = oy + z·scale`. Screen y grows as world z grows, so −Z is the top of the canvas — north = −Z = up, the same orientation `Minimap.js` gives a player facing north ("forward maps to screen-up"), with no mirrored axis. A rect's corners use the minimap's own formula (`Minimap.js:276-292`).

- [ ] **Step 1: Write the failing test**

```ts
// site/lib/mapProjection.test.ts
/**
 * THE CLAIM: the editor's map is a faithful, invertible picture of world XZ.
 *
 * Not a stub because every case is a NUMBER the canvas will actually use:
 * a 200×100 m world fitted into 400×400 px lands at exactly 1.76 px/m with
 * 24 px padding, zooming about a cursor leaves the metre under it where it
 * was to within 1e-9, and a hit 9 px from a dot with 8 px tolerance is a miss.
 * If `createView` silently flipped an axis, the north test fails; if
 * `zoomAt` zoomed about the origin instead of the cursor, the fixed-point
 * test fails by tens of pixels.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_SCALE,
  MIN_SCALE,
  createView,
  cssColour,
  hitTest,
  pan,
  rectCorners,
  resizeView,
  toScreen,
  toWorld,
  zoomAt,
} from './mapProjection';

const bounds = { min: { x: -100, y: 0, z: -50 }, max: { x: 100, y: 10, z: 50 } };

describe('createView', () => {
  it('fits the bounds into the canvas with padding, preserving aspect', () => {
    const v = createView(bounds, 400, 400, 24);
    // inner box is 352×352; world is 200×100 → limited by x: 352/200 = 1.76
    expect(v.scale).toBeCloseTo(1.76, 10);
    // the world's centre (0,0) sits at the canvas centre
    expect(toScreen(v, 0, 0)).toEqual({ sx: 200, sy: 200 });
    // the west edge lands exactly on the padding line
    expect(toScreen(v, -100, 0).sx).toBeCloseTo(24, 10);
    expect(v.w).toBe(400);
    expect(v.h).toBe(400);
  });

  it('puts north (−Z) at the top: a point further north has a smaller screen y', () => {
    const v = createView(bounds, 400, 400);
    expect(toScreen(v, 0, -40).sy).toBeLessThan(toScreen(v, 0, 40).sy);
    // and east (+X) is to the right
    expect(toScreen(v, 40, 0).sx).toBeGreaterThan(toScreen(v, -40, 0).sx);
  });

  it('falls back to a ±100 m square when a world has no bounds yet', () => {
    const v = createView(null, 300, 300, 0);
    expect(v.scale).toBeCloseTo(1.5, 10);
    expect(toScreen(v, -100, -100)).toEqual({ sx: 0, sy: 0 });
  });

  it('never produces a degenerate scale', () => {
    const flat = { min: { x: 5, y: 0, z: 5 }, max: { x: 5, y: 0, z: 5 } };
    const v = createView(flat, 100, 100);
    expect(v.scale).toBeLessThanOrEqual(MAX_SCALE);
    expect(v.scale).toBeGreaterThanOrEqual(MIN_SCALE);
    expect(Number.isFinite(v.ox)).toBe(true);
  });
});

describe('toScreen / toWorld', () => {
  it('round-trips', () => {
    const v = createView(bounds, 640, 480);
    for (const [x, z] of [[0, 0], [-99.5, 49.25], [12.3, -40.1]]) {
      const s = toScreen(v, x, z);
      const w = toWorld(v, s.sx, s.sy);
      expect(w.x).toBeCloseTo(x, 9);
      expect(w.z).toBeCloseTo(z, 9);
    }
  });
});

describe('zoomAt', () => {
  it('keeps the world point under the cursor fixed', () => {
    const v = createView(bounds, 640, 480);
    const cursor = { sx: 500, sy: 100 };
    const before = toWorld(v, cursor.sx, cursor.sy);
    const z1 = zoomAt(v, cursor.sx, cursor.sy, 2);
    const after = toWorld(z1, cursor.sx, cursor.sy);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.z).toBeCloseTo(before.z, 9);
    expect(z1.scale).toBeCloseTo(v.scale * 2, 10);
    // and a point elsewhere moved away from the cursor
    const far = toScreen(z1, before.x + 10, before.z);
    expect(far.sx - cursor.sx).toBeCloseTo(10 * z1.scale, 9);
  });

  it('clamps the scale', () => {
    const v = createView(bounds, 640, 480);
    expect(zoomAt(v, 0, 0, 1e9).scale).toBe(MAX_SCALE);
    expect(zoomAt(v, 0, 0, 1e-9).scale).toBe(MIN_SCALE);
  });
});

describe('pan and resize', () => {
  it('pan shifts every point by the same screen delta', () => {
    const v = createView(bounds, 640, 480);
    const p = pan(v, 30, -12);
    const a = toScreen(v, 7, 9);
    const b = toScreen(p, 7, 9);
    expect(b.sx - a.sx).toBe(30);
    expect(b.sy - a.sy).toBe(-12);
  });

  it('resize keeps the world point at the canvas centre at the new centre', () => {
    const v = pan(createView(bounds, 640, 480), 55, 20);
    const centreBefore = toWorld(v, 320, 240);
    const r = resizeView(v, 800, 300);
    const centreAfter = toWorld(r, 400, 150);
    expect(centreAfter.x).toBeCloseTo(centreBefore.x, 9);
    expect(centreAfter.z).toBeCloseTo(centreBefore.z, 9);
    expect(r.scale).toBe(v.scale);
  });
});

describe('hitTest', () => {
  const v = createView(bounds, 400, 400, 24); // 1.76 px/m
  const cands = [
    { key: 'a', x: 0, z: 0 },
    { key: 'b', x: 10, z: 0 },          // 17.6 px east of a
    { key: 'big', x: 0, z: 30, r: 5 },  // 5 m radius → 8.8 px reach on top of tolerance
  ];
  it('returns the nearest candidate within tolerance', () => {
    const s = toScreen(v, 3, 0); // 5.28 px from a, 12.32 px from b
    expect(hitTest(v, cands, s.sx, s.sy, 8)?.key).toBe('a');
  });
  it('is the NEAREST, not the first listed, when two are in reach', () => {
    const s = toScreen(v, 7, 0); // 12.32 px from a (listed first), 5.28 px from b
    expect(hitTest(v, cands, s.sx, s.sy, 20)?.key).toBe('b');
  });
  it('misses when nothing is within tolerance', () => {
    const s = toScreen(v, 5, 0); // 8.8 px from both a and b
    expect(hitTest(v, cands, s.sx, s.sy, 8)).toBeNull();
  });
  it('adds a candidate radius, in metres, to the tolerance', () => {
    const s = toScreen(v, 6, 30); // 10.56 px from big's centre; reach = 8 + 8.8
    expect(hitTest(v, cands, s.sx, s.sy, 8)?.key).toBe('big');
  });
  it('returns null for an empty list', () => {
    expect(hitTest(v, [], 0, 0, 8)).toBeNull();
  });
});

describe('rectCorners', () => {
  it('matches Minimap.js: px = x + lx·cos − lz·sin, pz = z + lx·sin + lz·cos', () => {
    const c = rectCorners({ x: 10, z: 20, w: 4, d: 2, rotation: Math.PI / 2 });
    // local (−2,−1) rotated 90°: (1, −2) → (11, 18)
    expect(c[0][0]).toBeCloseTo(11, 9);
    expect(c[0][1]).toBeCloseTo(18, 9);
    expect(c).toHaveLength(4);
  });
  it('is the plain axis-aligned box with no rotation', () => {
    expect(rectCorners({ x: 0, z: 0, w: 4, d: 2 })).toEqual([[-2, -1], [2, -1], [2, 1], [-2, 1]]);
  });
});

describe('cssColour', () => {
  it('turns a numeric colour into a six-digit hex string', () => {
    expect(cssColour(0x0000ff, 'x')).toBe('#0000ff');
    expect(cssColour(0x52e9ff, 'x')).toBe('#52e9ff');
  });
  it('passes strings through and falls back otherwise', () => {
    expect(cssColour('rgba(1,2,3,0.5)', 'x')).toBe('rgba(1,2,3,0.5)');
    expect(cssColour(undefined, 'x')).toBe('x');
    expect(cssColour('', 'x')).toBe('x');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd site && npx vitest run lib/mapProjection.test.ts
```
Expected: `Error: Cannot find module './mapProjection' imported from …/site/lib/mapProjection.test.ts` (Vitest 4's wording), `Test Files  1 failed (1)`, exit code 1.

- [ ] **Step 3: Write minimal implementation**

```ts
// site/lib/mapProjection.ts
import type { LayoutBounds } from './mapLayout';

/**
 * World ↔ screen for the map editor's canvas. Pure: no DOM, no canvas.
 *
 * ── The convention, stated once ────────────────────────────────────────────
 *
 *     sx = ox + x · scale
 *     sy = oy + z · scale
 *
 * Screen y grows as world z grows, so −Z is the TOP of the map: north = −Z
 * = up. That is the orientation `Minimap.js` gives a player facing north
 * ("forward maps to screen-up"), with no mirrored axis, so a floorplan here
 * looks like the in-game minimap and a rect's corners can be projected with
 * the minimap's own formula (`rectCorners`).
 *
 * ── Why a view is a value ──────────────────────────────────────────────────
 *
 * `zoomAt`, `pan` and `resizeView` return a new view instead of mutating
 * one. The canvas keeps the current view in a ref and replaces it; the tests
 * compare two views without a fixture; and nothing can be half-updated when
 * a pointer event arrives mid-draw.
 */

export interface MapView {
  /** Screen px per metre. */
  scale: number;
  /** Screen x of world x = 0. */
  ox: number;
  /** Screen y of world z = 0. */
  oy: number;
  /** Canvas CSS size the view was built for. */
  w: number;
  h: number;
}

export const MIN_SCALE = 0.02;
export const MAX_SCALE = 400;
/** Half-extent, metres, used until a world has reported its bounds. */
const FALLBACK_EXTENT = 100;

function clampScale(s: number): number {
  if (!Number.isFinite(s) || s <= 0) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

/** Fit `bounds` (or a ±100 m square) into w×h with `padPx` clear on every side, aspect preserved, centred. */
export function createView(bounds: LayoutBounds | null, w: number, h: number, padPx = 24): MapView {
  const minX = bounds ? bounds.min.x : -FALLBACK_EXTENT;
  const maxX = bounds ? bounds.max.x : FALLBACK_EXTENT;
  const minZ = bounds ? bounds.min.z : -FALLBACK_EXTENT;
  const maxZ = bounds ? bounds.max.z : FALLBACK_EXTENT;
  const ex = Math.max(1e-6, maxX - minX);
  const ez = Math.max(1e-6, maxZ - minZ);
  const iw = Math.max(1, w - padPx * 2);
  const ih = Math.max(1, h - padPx * 2);
  const scale = clampScale(Math.min(iw / ex, ih / ez));
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  return { scale, ox: w / 2 - cx * scale, oy: h / 2 - cz * scale, w, h };
}

export function toScreen(view: MapView, x: number, z: number): { sx: number; sy: number } {
  return { sx: view.ox + x * view.scale, sy: view.oy + z * view.scale };
}

export function toWorld(view: MapView, sx: number, sy: number): { x: number; z: number } {
  return { x: (sx - view.ox) / view.scale, z: (sy - view.oy) / view.scale };
}

/** Zoom by `factor` about screen point (sx, sy); the world point under it does not move. */
export function zoomAt(view: MapView, sx: number, sy: number, factor: number): MapView {
  const scale = clampScale(view.scale * factor);
  const k = scale / view.scale;
  return { ...view, scale, ox: sx - (sx - view.ox) * k, oy: sy - (sy - view.oy) * k };
}

export function pan(view: MapView, dx: number, dy: number): MapView {
  return { ...view, ox: view.ox + dx, oy: view.oy + dy };
}

/** The canvas changed size: keep the same scale and the same world point at the centre. */
export function resizeView(view: MapView, w: number, h: number): MapView {
  const c = toWorld(view, view.w / 2, view.h / 2);
  return { ...view, w, h, ox: w / 2 - c.x * view.scale, oy: h / 2 - c.z * view.scale };
}

export interface HitCandidate {
  key: string;
  x: number;
  z: number;
  /** Optional radius in METRES, added to the pixel tolerance after scaling. */
  r?: number;
}

/** Nearest candidate whose screen distance is within `tolPx` (+ its scaled radius), or null. */
export function hitTest(
  view: MapView,
  candidates: HitCandidate[],
  sx: number,
  sy: number,
  tolPx: number
): HitCandidate | null {
  let best: HitCandidate | null = null;
  let bestD = Infinity;
  for (const c of candidates) {
    const p = toScreen(view, c.x, c.z);
    const d = Math.hypot(p.sx - sx, p.sy - sy);
    const reach = tolPx + (c.r ?? 0) * view.scale;
    if (d <= reach && d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

/** The four world-space corners of a (possibly rotated) rect, in `Minimap.js` order and formula. */
export function rectCorners(s: { x: number; z: number; w: number; d: number; rotation?: number }): [number, number][] {
  const hw = (s.w ?? 1) * 0.5;
  const hd = (s.d ?? 1) * 0.5;
  const rot = s.rotation ?? 0;
  const cs = Math.cos(rot);
  const sn = Math.sin(rot);
  const local: [number, number][] = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
  return local.map(([lx, lz]) => [s.x + lx * cs - lz * sn, s.z + lx * sn + lz * cs]);
}

/** A layout colour (Three numeric or CSS string) as a canvas fill/stroke string. */
export function cssColour(c: number | string | undefined, fallback: string): string {
  if (typeof c === 'number' && Number.isFinite(c)) return `#${(c & 0xffffff).toString(16).padStart(6, '0')}`;
  if (typeof c === 'string' && c) return c;
  return fallback;
}
```

- [ ] **Step 4: Run test to verify it passes**

```
cd site && npx vitest run lib/mapProjection.test.ts
```
Expected: `Test Files  1 passed (1)`, `Tests  18 passed (18)`, exit code 0.

- [ ] **Step 5: Commit**

```
git add site/lib/mapProjection.ts site/lib/mapProjection.test.ts
git commit -m "The map editor can project a world onto a canvas" -m "A pure world-to-screen module, so the canvas component decides nothing. The convention is fixed here once: screen y grows with world z, so north (−Z) is up, matching the in-game minimap with the player facing north and reusing its rect-corner formula. Zoom is about the cursor, and the test pins the metre under it to 1e-9 so a zoom-about-origin regression cannot pass." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---
### Task 2: `site/lib/mapEditorState.ts` — selection, snap, pending rows, layout age

**Files:**
- Create: `site/lib/mapEditorState.ts`
- Test: `site/lib/mapEditorState.test.ts`

This module owns every decision the three components and the panel would otherwise make: what Y a moved prop gets, what a pending row says, which entry a selection maps to, how a move entry is upserted (one per target name — "select an object and move it" edits the existing entry rather than adding a second). The `Draft`/`_key` pattern moves here from `MapEditorPanel.tsx` so the components can share it.

- [ ] **Step 1: Write the failing test**

```ts
// site/lib/mapEditorState.test.ts
/**
 * THE CLAIM: the editor's snapping, row text, selection mapping and move
 * upsert are exactly what spec §8 says, computed against real `groundAt`.
 *
 * Not a stub because the ground is a real `DecodedGround` (a 3×3 grid whose
 * top surface is a plane rising 1 m per 4 m in x) and `snappedY` is checked
 * against the closed-form answer on that plane, sink included: a prop
 * authored 0.5 m ABOVE its ground stays 0.5 m above the ground it is dragged
 * to. Null handling is asserted on a NO_SAMPLE grid, not on a mocked
 * `groundAt`. Row text is asserted character-for-character because the e2e
 * harness in chunk 7 greps for it.
 */
import { describe, expect, it } from 'vitest';
import { NO_SAMPLE, decodeGround, encodeHeights, type DecodedGround } from './mapLayout';
import type { Conflict } from './mapConflicts';
import {
  NO_LAYOUT_TEXT,
  degToRad,
  fmt,
  layoutAgeText,
  moveEntryFor,
  pendingRows,
  placeAt,
  radToDeg,
  rowLevel,
  selectedEntry,
  selectedPosition,
  selectionFromKey,
  selectionKey,
  snappedY,
  upsertMoveFor,
  type Draft,
} from './mapEditorState';

/**
 * 3×3 samples, step 4, one layer, heights in cm = 100·i (a plane rising east),
 * pushed through chunk 2's encode → decode so the bytes the game would send
 * are what `snappedY` reads, not a hand-built typed array.
 */
function slope(): DecodedGround {
  const nx = 3, nz = 3, layers = 1;
  const heights = new Int16Array(nx * nz * layers);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) heights[(j * nx + i) * layers] = 100 * i;
  return decodeGround({ originX: 0, originZ: 0, step: 4, nx, nz, layers, heightsCm: encodeHeights(heights) });
}

let n = 0;
const mint = () => `k${++n}`;

describe('degrees and radians', () => {
  it('90° is π/2 and the pair round-trips', () => {
    expect(degToRad(90)).toBeCloseTo(Math.PI / 2, 12);
    expect(radToDeg(Math.PI / 2)).toBeCloseTo(90, 12);
    expect(radToDeg(degToRad(37.5))).toBeCloseTo(37.5, 12);
  });
});

describe('snappedY', () => {
  it('is the ground at the destination plus the authored sink or lift', () => {
    const g = slope();
    // at x=0 the ground is 0 m; the prop sits at y=0.5 → lift 0.5
    expect(snappedY(g, { x: 0, y: 0.5, z: 0 }, 4, 0)).toBeCloseTo(1.5, 9); // ground at x=4 is 1 m
    // a half-buried rock stays half-buried
    expect(snappedY(g, { x: 4, y: 0.6, z: 4 }, 8, 4)).toBeCloseTo(1.6, 9);
  });
  it('is bilinear between samples', () => {
    expect(snappedY(slope(), { x: 0, y: 0, z: 0 }, 2, 2)).toBeCloseTo(0.5, 9);
  });
  it('is null without ground, and null when either end has no sample', () => {
    expect(snappedY(null, { x: 0, y: 0, z: 0 }, 1, 1)).toBeNull();
    const g = slope();
    g.heights.fill(NO_SAMPLE);
    expect(snappedY(g, { x: 0, y: 0, z: 0 }, 4, 0)).toBeNull();
  });
});

describe('layoutAgeText', () => {
  const now = new Date('2026-08-27T12:00:00Z');
  it('reads as the spec banner', () => {
    expect(layoutAgeText(null, now)).toBe(NO_LAYOUT_TEXT);
    expect(NO_LAYOUT_TEXT).toBe('No layout yet — enter this world in game as admin');
    expect(layoutAgeText('2026-08-27T11:59:30Z', now)).toBe('reported just now');
    expect(layoutAgeText('2026-08-27T11:57:00Z', now)).toBe('reported 3 min ago');
    expect(layoutAgeText('2026-08-27T10:00:00Z', now)).toBe('reported 2 h ago');
    expect(layoutAgeText('2026-08-24T12:00:00Z', now)).toBe('reported 3 d ago');
  });
  it('treats an unparsable stamp as no layout', () => {
    expect(layoutAgeText('yesterday', now)).toBe(NO_LAYOUT_TEXT);
  });
});

describe('fmt', () => {
  it('prints one decimal, the way the mock does', () => {
    expect(fmt(12.3)).toBe('12.3');
    expect(fmt(-40.1)).toBe('-40.1');
    expect(fmt(3)).toBe('3.0');
    expect(fmt(3.25)).toBe('3.3');
  });
});

describe('rowLevel and pendingRows', () => {
  const warn: Conflict = { level: 'warn', code: 'underground', detail: 'bottom 1.2 m below ground' };
  const err: Conflict = { level: 'error', code: 'out-of-bounds', detail: 'x 900 outside bounds' };
  const entries: Draft[] = [
    { _key: 'a', kind: 'move', id: 'a', target: { name: 'medieval:house' }, position: { x: 12.3, y: 3.2, z: -40.1 }, rotationY: Math.PI / 2 },
    { _key: 'b', kind: 'move', id: 'b', target: { name: 'station:crate' }, position: null, hidden: true },
    { _key: 'c', kind: 'place', id: 'c', item: { source_key: 'loot', name: 'Loot Crate', config: {} }, position: { x: 1, y: 2, z: 3 }, quantity: 2 },
  ];
  it('the worst conflict sets the level', () => {
    expect(rowLevel([])).toBe('ok');
    expect(rowLevel([warn])).toBe('warn');
    expect(rowLevel([warn, err])).toBe('error');
  });
  it('rows carry the exact text the list and the e2e harness read', () => {
    const rows = pendingRows(entries, [[warn], [], [err, warn]]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ key: 'a', kind: 'move', label: 'medieval:house', summary: '→ (12.3, 3.2, -40.1) yaw 90°', level: 'warn' });
    expect(rows[1]).toMatchObject({ key: 'b', kind: 'move', label: 'station:crate', summary: 'hidden', level: 'ok' });
    expect(rows[2]).toMatchObject({ key: 'c', kind: 'place', label: 'Loot Crate ×2', summary: '→ (1.0, 2.0, 3.0)', level: 'error' });
    expect(rows[2].conflicts).toEqual([err, warn]);
  });
  it('tolerates a conflicts array shorter than the document', () => {
    expect(pendingRows(entries, [])[2].level).toBe('ok');
  });
  it('a hidden move that also has a position says both', () => {
    const only: Draft[] = [{ _key: 'd', kind: 'move', id: 'd', target: { name: 'x' }, position: { x: 1, y: 2, z: 3 }, hidden: true }];
    expect(pendingRows(only, [])[0].summary).toBe('→ (1.0, 2.0, 3.0) (hidden)');
  });
});

describe('upsertMoveFor', () => {
  it('adds one move entry for a name, then updates that same entry', () => {
    const one = upsertMoveFor([], 'a:b', { x: 1, y: 2, z: 3 }, undefined, mint);
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ kind: 'move', target: { name: 'a:b' }, position: { x: 1, y: 2, z: 3 } });
    expect(one[0].rotationY).toBeUndefined();
    const two = upsertMoveFor(one, 'a:b', { x: 9, y: 8, z: 7 }, 1.5, mint);
    expect(two).toHaveLength(1);
    expect(two[0]._key).toBe(one[0]._key);
    expect(two[0].id).toBe(one[0].id);
    expect(two[0]).toMatchObject({ position: { x: 9, y: 8, z: 7 }, rotationY: 1.5 });
  });
  it('leaves other entries and their order alone', () => {
    const base = upsertMoveFor(upsertMoveFor([], 'x', { x: 0, y: 0, z: 0 }, undefined, mint), 'y', { x: 1, y: 1, z: 1 }, undefined, mint);
    const out = upsertMoveFor(base, 'x', { x: 5, y: 5, z: 5 }, undefined, mint);
    expect(out.map((e) => (e.kind === 'move' ? e.target.name : ''))).toEqual(['x', 'y']);
    expect(out[1]).toBe(base[1]);
  });
  it('a hidden move keeps its hidden flag when it is given a position', () => {
    const hidden: Draft[] = [{ _key: 'h', kind: 'move', id: 'h', target: { name: 'q' }, position: null, hidden: true }];
    const out = upsertMoveFor(hidden, 'q', { x: 1, y: 1, z: 1 }, undefined, mint);
    expect(out[0]).toMatchObject({ hidden: true, position: { x: 1, y: 1, z: 1 } });
  });
  it("rotationY undefined CLEARS an existing rotation; a caller passes the entry's own to keep it", () => {
    const turned = upsertMoveFor([], 'r', { x: 0, y: 0, z: 0 }, 1.5, mint);
    expect(upsertMoveFor(turned, 'r', { x: 1, y: 0, z: 0 }, undefined, mint)[0].rotationY).toBeUndefined();
    expect(upsertMoveFor(turned, 'r', { x: 1, y: 0, z: 0 }, turned[0].rotationY, mint)[0].rotationY).toBe(1.5);
  });
});

describe('placeAt', () => {
  it('builds a place draft with a copied config and quantity 1', () => {
    const config = { effect: 'heal', amount: 5 };
    const d = placeAt({ source_key: 'loot', name: 'Loot Crate', config }, 1, 2, 3, mint);
    expect(d).toMatchObject({ kind: 'place', item: { source_key: 'loot', name: 'Loot Crate' }, position: { x: 1, y: 2, z: 3 }, quantity: 1 });
    expect(d.item.config).toEqual(config);
    expect(d.item.config).not.toBe(config);
    expect(d._key).toBe(d.id);
  });
});

describe('selection helpers', () => {
  const objects = [{ name: 'o1', position: { x: 1, y: 2, z: 3 } }];
  const entries: Draft[] = [
    { _key: 'm', kind: 'move', id: 'm', target: { name: 'o1' }, position: { x: 10, y: 2, z: 30 } },
    { _key: 'p', kind: 'place', id: 'p', item: { source_key: 's', name: 'S', config: {} }, position: { x: 4, y: 5, z: 6 }, quantity: 1 },
  ];
  it('moveEntryFor finds the move by target name', () => {
    expect(moveEntryFor(entries, 'o1')?._key).toBe('m');
    expect(moveEntryFor(entries, 'nope')).toBeUndefined();
  });
  it('selectedEntry maps an object to its pending move and an entry to itself', () => {
    expect(selectedEntry(entries, { kind: 'object', name: 'o1' })?._key).toBe('m');
    expect(selectedEntry(entries, { kind: 'entry', key: 'p' })?._key).toBe('p');
    expect(selectedEntry(entries, null)).toBeUndefined();
  });
  it('selectedPosition is the pending position when moved, else the reported one', () => {
    expect(selectedPosition(objects, entries, { kind: 'object', name: 'o1' })).toEqual({ x: 10, y: 2, z: 30 });
    expect(selectedPosition(objects, [], { kind: 'object', name: 'o1' })).toEqual({ x: 1, y: 2, z: 3 });
    expect(selectedPosition(objects, entries, { kind: 'entry', key: 'p' })).toEqual({ x: 4, y: 5, z: 6 });
    expect(selectedPosition(objects, entries, { kind: 'object', name: 'unknown' })).toBeNull();
  });
});

describe('selectionKey / selectionFromKey', () => {
  it('round-trips both kinds — the one string the canvas, the picker and the pending list share', () => {
    const o = { kind: 'object', name: 'medieval:house' } as const;
    const e = { kind: 'entry', key: 'k7' } as const;
    expect(selectionKey(o)).toBe('o:medieval:house');
    expect(selectionKey(e)).toBe('e:k7');
    expect(selectionFromKey('o:medieval:house')).toEqual(o);
    expect(selectionFromKey('e:k7')).toEqual(e);
  });
  it('nothing selected has no key, and a name with colons in it survives', () => {
    expect(selectionKey(null)).toBeNull();
    expect(selectionFromKey('o:a:b:c')).toEqual({ kind: 'object', name: 'a:b:c' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd site && npx vitest run lib/mapEditorState.test.ts
```
Expected: `Error: Cannot find module './mapEditorState' imported from …/site/lib/mapEditorState.test.ts`, `Test Files  1 failed (1)`, exit code 1.

- [ ] **Step 3: Write minimal implementation**

```ts
// site/lib/mapEditorState.ts
import { groundAt, type DecodedGround } from './mapLayout';
import type { Conflict } from './mapConflicts';
import type { GrantConfig, MoveEntry, OverlayEntry, PlaceEntry, Vec3 } from './mapOverlaySchema';

/**
 * Every decision the map editor's DOM takes, as pure functions.
 *
 * ── Why the components decide nothing ──────────────────────────────────────
 *
 * The site's vitest runs with `environment: 'node'` and no DOM library, so a
 * component cannot be unit-tested here. Rather than add a DOM to the test
 * run, the canvas and panels are kept to drawing and forwarding events, and
 * everything they would have decided — what Y a dragged prop gets, what a
 * pending row says, which entry a selection maps to — lives here and is
 * tested against the real `groundAt`.
 *
 * ── The snap rule (spec §8) ────────────────────────────────────────────────
 *
 *     snappedY = ground(toX, toZ, y) + (y − ground(fromX, fromZ, y))
 *
 * The nearest surface at or below the prop's CURRENT y, plus its authored
 * sink or lift. A crate dragged across the station hub stays on the deck
 * rather than jumping onto the dome, and a rock authored half-buried stays
 * half-buried instead of popping up and then tripping `underground`.
 */

export type Selected = { kind: 'object'; name: string } | { kind: 'entry'; key: string } | null;

/** An overlay entry in the editor: the document's entry plus a stable React key that is never sent. */
export type Draft = OverlayEntry & { _key: string };

export const degToRad = (d: number): number => (d * Math.PI) / 180;
export const radToDeg = (r: number): number => (r * 180) / Math.PI;

export const NO_LAYOUT_TEXT = 'No layout yet — enter this world in game as admin';

/** One decimal, as the spec's mock prints coordinates. */
export function fmt(n: number): string {
  return (Math.round(n * 10) / 10).toFixed(1);
}

export function snappedY(ground: DecodedGround | null, from: Vec3, toX: number, toZ: number): number | null {
  if (!ground) return null;
  const there = groundAt(ground, toX, toZ, from.y);
  const here = groundAt(ground, from.x, from.z, from.y);
  if (there === null || here === null) return null;
  return there + (from.y - here);
}

export function layoutAgeText(reportedAt: string | null, now: Date): string {
  if (!reportedAt) return NO_LAYOUT_TEXT;
  const t = Date.parse(reportedAt);
  if (!Number.isFinite(t)) return NO_LAYOUT_TEXT;
  const s = Math.max(0, Math.floor((now.getTime() - t) / 1000));
  if (s < 60) return 'reported just now';
  if (s < 3600) return `reported ${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `reported ${Math.floor(s / 3600)} h ago`;
  return `reported ${Math.floor(s / 86400)} d ago`;
}

export type RowLevel = 'ok' | 'warn' | 'error';

export function rowLevel(conflicts: Conflict[]): RowLevel {
  let level: RowLevel = 'ok';
  for (const c of conflicts) {
    if (c.level === 'error') return 'error';
    level = 'warn';
  }
  return level;
}

export interface PendingRow {
  key: string;
  kind: 'move' | 'place';
  label: string;
  summary: string;
  level: RowLevel;
  conflicts: Conflict[];
}

function vecText(p: Vec3): string {
  return `(${fmt(p.x)}, ${fmt(p.y)}, ${fmt(p.z)})`;
}

/** Display rows for the pending list; `conflicts[i]` belongs to `entries[i]`. */
export function pendingRows(entries: Draft[], conflicts: Conflict[][]): PendingRow[] {
  return entries.map((e, i) => {
    const own = conflicts[i] ?? [];
    if (e.kind === 'move') {
      const yaw = e.rotationY !== undefined ? ` yaw ${Math.round(radToDeg(e.rotationY))}°` : '';
      const summary = e.position ? `→ ${vecText(e.position)}${yaw}${e.hidden ? ' (hidden)' : ''}` : 'hidden';
      return { key: e._key, kind: 'move', label: e.target.name, summary, level: rowLevel(own), conflicts: own };
    }
    return {
      key: e._key,
      kind: 'place',
      label: `${e.item.name} ×${e.quantity}`,
      summary: `→ ${vecText(e.position)}`,
      level: rowLevel(own),
      conflicts: own,
    };
  });
}

export function moveEntryFor(entries: Draft[], name: string): (Draft & MoveEntry) | undefined {
  return entries.find((e): e is Draft & MoveEntry => e.kind === 'move' && e.target.name === name);
}

/**
 * One move entry per target name. Editing an existing one updates it in
 * place (same `_key`, same `id`, same position in the document); a new one
 * is appended. `mint` supplies the key/id so the function stays pure.
 *
 * `rotationY: undefined` CLEARS an existing rotation — the argument is the
 * whole new transform, not a patch. A caller that means "keep it" passes
 * the entry's own value (the panel's drag passes `mv?.rotationY`).
 */
export function upsertMoveFor(
  entries: Draft[],
  name: string,
  position: Vec3,
  rotationY: number | undefined,
  mint: () => string
): Draft[] {
  const existing = moveEntryFor(entries, name);
  if (existing) {
    return entries.map((e) => {
      if (e !== existing) return e;
      const next: Draft & MoveEntry = { ...existing, position };
      if (rotationY === undefined) delete next.rotationY;
      else next.rotationY = rotationY;
      return next;
    });
  }
  const key = mint();
  const entry: Draft & MoveEntry = { _key: key, kind: 'move', id: key, target: { name }, position };
  if (rotationY !== undefined) entry.rotationY = rotationY;
  return [...entries, entry];
}

/** A place draft for a catalogue item at a point. The config is COPIED (see `mapOverlaySchema.ts`). */
export function placeAt(
  item: { source_key: string; name: string; config: GrantConfig },
  x: number,
  y: number,
  z: number,
  mint: () => string
): Draft & PlaceEntry {
  const key = mint();
  return {
    _key: key,
    kind: 'place',
    id: key,
    item: { source_key: item.source_key, name: item.name, config: { ...item.config } },
    position: { x, y, z },
    quantity: 1,
  };
}

/** The document entry a selection edits: an object's pending move, or the entry itself. */
export function selectedEntry(entries: Draft[], selected: Selected): Draft | undefined {
  if (!selected) return undefined;
  if (selected.kind === 'object') return moveEntryFor(entries, selected.name);
  return entries.find((e) => e._key === selected.key);
}

/** Where the selection currently is: its pending position if moved, else what the game reported. */
export function selectedPosition(
  objects: Array<{ name: string; position: Vec3 }>,
  entries: Draft[],
  selected: Selected
): Vec3 | null {
  if (!selected) return null;
  if (selected.kind === 'entry') return entries.find((e) => e._key === selected.key)?.position ?? null;
  const mv = moveEntryFor(entries, selected.name);
  if (mv?.position) return mv.position;
  return objects.find((o) => o.name === selected.name)?.position ?? null;
}

/** The one string the canvas, the picker and the pending list use to name a selection: `o:<name>` or `e:<key>`. */
export function selectionKey(sel: Selected): string | null {
  if (!sel) return null;
  return sel.kind === 'object' ? `o:${sel.name}` : `e:${sel.key}`;
}

/** Inverse of `selectionKey` for a non-empty key; a caller maps `''` to `null` itself. */
export function selectionFromKey(key: string): NonNullable<Selected> {
  return key.startsWith('o:') ? { kind: 'object', name: key.slice(2) } : { kind: 'entry', key: key.slice(2) };
}
```

- [ ] **Step 4: Run test to verify it passes**

```
cd site && npx vitest run lib/mapEditorState.test.ts
```
Expected: `Test Files  1 passed (1)`, `Tests  21 passed (21)`, exit code 0. If the `bilinear` case fails, chunk 2's `groundAt` is not bilinear as the skeleton specifies — fix chunk 2, not this test.

- [ ] **Step 5: Commit**

```
git add site/lib/mapEditorState.ts site/lib/mapEditorState.test.ts
git commit -m "The map editor's snapping and pending-row decisions live in a pure module" -m "The site's vitest has no DOM, so a component cannot be tested; instead every decision the canvas and panels would make is a function here, tested against the real groundAt on a real decoded grid. The snap rule keeps a prop's authored sink or lift, so a half-buried rock dragged elsewhere stays half-buried rather than surfacing and then warning underground. A move entry is upserted per target name so selecting and moving an object edits its existing entry." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---


---

## Chunk 5: Site — the map canvas and selection panel

**Executes after chunk 4** (which provides `site/lib/mapProjection.ts` and `site/lib/mapEditorState.ts`) and therefore after chunks 2 and 3 (`mapLayout.ts`, `mapConflicts.ts`). It consumes those interfaces exactly as the skeleton's *Shared interfaces* define them.

**What this chunk builds.** The shared inline-style module (`mapEditorStyles.ts`), the canvas that draws the layout and forwards pointer events (`MapCanvas.tsx`), and the selection panel (`MapSelectionPanel.tsx`). Neither component decides anything — projection, hit-testing, snapping and row text come from chunk 4's tested modules. The pending list and the `MapEditorPanel.tsx` rewrite are **chunk 6**; the end-to-end harness, the manual checklist and the gates are **chunk 7**. Task numbering continues from chunk 4.

**Constraints (unchanged from chunk 4):** components cannot be unit-tested (`environment: 'node'`, no DOM); inline `CSSProperties` + `btn btn-ghost | btn-primary | btn-sm` + `.banner`; every number input sets `clipPath: 'none'` (via the shared `coord` style); canvas sizing is `fit()` from `painters.ts` so all drawing and hit-testing is in CSS px; typecheck is `cd site && npx tsc --noEmit -p .`; build is `cd site && npm run build:site-only`; commits are sentence-case effect lines with why-prose bodies and the single `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer; commit in the worktree, do not push.

---

### Task 3: `site/components/MapCanvas.tsx` — draw the layout, forward pointer events

**Files:**
- Create: `site/components/mapEditorStyles.ts` (the inline style constants lifted out of `MapEditorPanel.tsx:74-94` so three components share them)
- Create: `site/components/MapCanvas.tsx`
- No unit test (DOM). Verified by typecheck here (Step 3), the site build in Task 4 Step 3, and the manual checklist + e2e harness in chunk 7.

Draw order, fixed: background → ground cells lightly (skipped when `nx·nz > 70 000`: a 400×400 grid is 160 000 `fillRect`s per frame and dragging stuttered at that size; above the cap the floorplan alone is the map, and the ground still drives snapping) → floorplan shapes over them (rect via `rectCorners`, circle, path; numeric colours through `cssColour`), so a filled floorplan is never tinted by the grid → bounds outline → objects as dots (`#52e9ff`) → place entries as diamonds (`#ffb44a`) → pending moves as accent rings with a dashed line from the reported position → the selection's white ring → hover label. Pointer: click → `hitTest` → `onSelect`; press-and-drag on the already-selected mark → `onDrag(... 'move')` then `'end'`; wheel → `zoomAt` about the cursor; middle button, space-drag, or dragging on empty ground → pan; click on empty ground → `onPlaceAt` only in `placeMode`, else deselect. `window.__mapView` is exposed outside production so the e2e harness can project a world point to a pixel with the same maths.

- [ ] **Step 1: Write the shared styles**

```ts
// site/components/mapEditorStyles.ts
import type { CSSProperties } from 'react';

/**
 * Inline styles shared by the map editor's components.
 *
 * The site has no `.card` or `.input` class; panels are styled inline, and
 * these are the constants `MapEditorPanel.tsx` carried before the map-first
 * rewrite, lifted so the canvas, selection panel and pending list agree.
 *
 * `clipPath: 'none'` on `coord` is load-bearing. `globals.css` gives every
 * `input[type='number']` `clip-path: var(--clip-sm)` and a 1.25 rem display
 * font for the store's quantity fields; a coordinate box with notched corners
 * next to plain text boxes looks like a different control, and the old panel
 * overrode font and padding but not the clip.
 */

export const card: CSSProperties = {
  border: '1px solid rgba(82, 233, 255, 0.2)',
  borderRadius: '16px',
  background: 'rgba(7, 16, 24, 0.72)',
  padding: '16px',
  boxShadow: '0 18px 50px rgba(0,0,0,0.28)',
};

export const input: CSSProperties = {
  width: '100%',
  borderRadius: '10px',
  border: '1px solid rgba(140, 176, 200, 0.25)',
  background: 'rgba(4, 10, 15, 0.88)',
  color: 'inherit',
  padding: '8px 10px',
  font: 'inherit',
};

export const label: CSSProperties = { display: 'grid', gap: '5px', fontSize: '12px', color: '#cfe6f2' };

export const coord: CSSProperties = { ...input, padding: '6px 8px', fontSize: '13px', clipPath: 'none' };

export const dim = '#8ea6b8';
export const subtle = '#7f97a8';
export const statusColour = '#9bd6ea';
export const okColour = '#b6ff5a';
export const warnColour = '#ffb44a';
export const errorColour = '#ff5566';
export const moveColour = '#52e9ff';
export const placeColour = '#ffb44a';
```

- [ ] **Step 2: Write the canvas component**

```tsx
// site/components/MapCanvas.tsx
'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { fit } from '@/lib/painters';
import { NO_SAMPLE, type DecodedGround, type WorldLayout } from '@/lib/mapLayout';
import type { CatalogueObject } from '@/lib/mapOverlay';
import type { MoveEntry } from '@/lib/mapOverlaySchema';
import {
  createView,
  cssColour,
  hitTest,
  pan,
  rectCorners,
  resizeView,
  toScreen,
  toWorld,
  zoomAt,
  type HitCandidate,
  type MapView,
} from '@/lib/mapProjection';
import { fmt, selectedPosition, selectionFromKey, selectionKey, type Draft, type Selected } from '@/lib/mapEditorState';
import { moveColour, okColour, placeColour } from './mapEditorStyles';

/**
 * The top-down map. Draws, and forwards pointer events. Decides nothing.
 *
 * ── What it draws, and from where ──────────────────────────────────────────
 *
 * The floorplan is the world's `minimapShapes` as the game reported them,
 * projected through `mapProjection.ts` with the minimap's own rect-corner
 * formula, so this map and the in-game minimap agree on every wall. The
 * ground grid is drawn lightly under the marks so a dome, a deck and a hole
 * read as different tones; it is skipped above `GROUND_CELL_CAP` cells
 * because a 160 000-rect frame stuttered under drag, and the grid still
 * drives snapping whether or not it is drawn.
 *
 * ── Why the view lives in a ref ────────────────────────────────────────────
 *
 * Pan and zoom happen on every pointer move. Putting the view in React state
 * would re-render the whole editor per pixel of drag; a ref plus a redraw
 * tick redraws only this canvas. The view is a value (`mapProjection.ts`),
 * so the ref is replaced, never mutated.
 *
 * ── Everything happens in CSS pixels ───────────────────────────────────────
 *
 * `fit()` sets the bitmap to the CSS box × DPR and applies the DPR as the
 * transform, so drawing and hit-testing both use `getBoundingClientRect`
 * coordinates and never see the device pixel ratio.
 */

export interface HoverInfo {
  label: string;
  x: number;
  y: number | null;
  z: number;
}

export interface MapCanvasProps {
  layout: WorldLayout | null;
  ground: DecodedGround | null;
  objects: CatalogueObject[];
  entries: Draft[];
  selected: Selected;
  /** A marketplace item is armed: a click on empty ground places it. */
  placeMode: boolean;
  onSelect: (sel: Selected) => void;
  onDrag: (target: NonNullable<Selected>, x: number, z: number, phase: 'move' | 'end') => void;
  onPlaceAt: (x: number, z: number) => void;
  onHover?: (info: HoverInfo | null) => void;
}

const HIT_TOL_PX = 8;
const DRAG_THRESHOLD_PX = 3;
const HEIGHT_PX = 520;
/** Above this many samples the ground layer is not painted (see the header). */
export const GROUND_CELL_CAP = 70_000;

const C = {
  bg: '#050b12',
  bounds: 'rgba(82, 233, 255, 0.35)',
  shape: 'rgba(96, 150, 180, 0.35)',
  object: moveColour,
  objectFaint: 'rgba(82, 233, 255, 0.35)',
  place: placeColour,
  pending: okColour,
  selected: '#ffffff',
  text: '#cfe6f2',
};

const EDITABLE = 'input, textarea, select, [contenteditable="true"]';

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, colour: string) {
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function ring(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, colour: string) {
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
}

function diamond(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, colour: string) {
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
  ctx.fill();
}

type Gesture =
  | { mode: 'pan'; lastX: number; lastY: number }
  | { mode: 'drag'; target: NonNullable<Selected>; startX: number; startY: number; moved: boolean }
  | { mode: 'click'; hit: HitCandidate | null; startX: number; startY: number; lastX: number; lastY: number; moved: boolean };

export default function MapCanvas(props: MapCanvasProps) {
  const { layout, ground, objects, entries, selected, placeMode, onSelect, onDrag, onPlaceAt, onHover } = props;
  const ref = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<MapView | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const spaceRef = useRef(false);
  /* Whether the pointer is over the canvas: Space is only swallowed then. */
  const hoveredRef = useRef(false);
  const [tick, setTick] = useState(0);
  const [hover, setHover] = useState<{ sx: number; sy: number; info: HoverInfo } | null>(null);
  const redraw = useCallback(() => setTick((t) => t + 1), []);

  const objectByName = useMemo(() => new Map(objects.map((o) => [o.name, o])), [objects]);

  /* One name → pending-move lookup per `entries` change, shared by the hit
   * candidates and the draw. A per-object `find` over the document, twice a
   * frame, is a million steps per drag frame at 2 000 objects × 500 entries. */
  const moveByName = useMemo(() => {
    const m = new Map<string, Draft & MoveEntry>();
    for (const e of entries) if (e.kind === 'move') m.set(e.target.name, e);
    return m;
  }, [entries]);

  /* Hit candidates: every reported object (at its reported AND pending
   * position, both selecting the object), every placement, and every move
   * whose target the game did not report (a free-text move). */
  const candidates = useMemo<HitCandidate[]>(() => {
    const out: HitCandidate[] = [];
    for (const o of objects) {
      out.push({ key: `o:${o.name}`, x: o.position.x, z: o.position.z, r: 0.5 });
      const mv = moveByName.get(o.name);
      if (mv?.position) out.push({ key: `o:${o.name}`, x: mv.position.x, z: mv.position.z, r: 0.5 });
    }
    for (const e of entries) {
      if (e.kind === 'place') out.push({ key: `e:${e._key}`, x: e.position.x, z: e.position.z, r: 0.5 });
      else if (e.position && !objectByName.has(e.target.name)) {
        out.push({ key: `e:${e._key}`, x: e.position.x, z: e.position.z, r: 0.5 });
      }
    }
    return out;
  }, [objects, entries, objectByName, moveByName]);

  const groundRange = useMemo(() => {
    if (!ground || ground.nx * ground.nz > GROUND_CELL_CAP) return null;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < ground.heights.length; i += ground.layers) {
      const h = ground.heights[i];
      if (h === NO_SAMPLE) continue;
      if (h < min) min = h;
      if (h > max) max = h;
    }
    return min === Infinity ? null : { min, max: Math.max(max, min + 1) };
  }, [ground]);

  const describe = useCallback(
    (hit: HitCandidate): HoverInfo => {
      if (hit.key.startsWith('o:')) {
        const name = hit.key.slice(2);
        const p = selectedPosition(objects, entries, { kind: 'object', name });
        return { label: name, x: hit.x, y: p?.y ?? null, z: hit.z };
      }
      const e = entries.find((d) => d._key === hit.key.slice(2));
      const labelText = e ? (e.kind === 'place' ? `${e.item.name} ×${e.quantity}` : e.target.name) : 'entry';
      return { label: labelText, x: hit.x, y: e?.position?.y ?? null, z: hit.z };
    },
    [objects, entries]
  );

  /* A new layout is a new world or fresh bounds: refit. */
  useEffect(() => {
    viewRef.current = null;
    redraw();
  }, [layout, redraw]);

  /* The map pans to a selection that is off-canvas — once per selection
   * change, never per drag frame (a drag keeps the selection). */
  const selectedKey = selectionKey(selected);
  useEffect(() => {
    const v = viewRef.current;
    const p = selectedPosition(objects, entries, selected);
    if (!v || !p) return;
    const s = toScreen(v, p.x, p.z);
    const inset = 20;
    if (s.sx < inset || s.sy < inset || s.sx > v.w - inset || s.sy > v.h - inset) {
      viewRef.current = pan(v, v.w / 2 - s.sx, v.h / 2 - s.sy);
      redraw();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  /* Wheel must preventDefault, and React registers `onWheel` passive, so it
   * is a native listener. Space is tracked for space-drag panning and is
   * swallowed only while the pointer is over the canvas and the key did not
   * land in a text field, so the page neither scrolls nor loses a typed space. */
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const onWheel = (e: WheelEvent) => {
      const v = viewRef.current;
      if (!v) return;
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      viewRef.current = zoomAt(v, e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
      redraw();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      spaceRef.current = e.type === 'keydown';
      const target = e.target as HTMLElement | null;
      if (hoveredRef.current && !target?.closest(EDITABLE)) e.preventDefault();
    };
    let timer: ReturnType<typeof setTimeout>;
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(redraw, 160);
    };
    cv.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      clearTimeout(timer);
      cv.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, [redraw]);

  /* The draw. */
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const size = fit(cv);
    if (!size) return;
    const { ctx, w, h } = size;
    let view = viewRef.current;
    if (!view) view = createView(layout?.bounds ?? null, w, h);
    else if (view.w !== w || view.h !== h) view = resizeView(view, w, h);
    viewRef.current = view;
    if (process.env.NODE_ENV !== 'production') {
      (window as unknown as { __mapView?: MapView }).__mapView = view;
    }

    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);

    /* Ground first, under the floorplan: a filled shape must not be tinted
     * by the grid, and the bounds dashes must stay visible over both. */
    if (ground && groundRange) {
      const { originX, originZ, step, nx, nz, layers, heights } = ground;
      const cell = step * view.scale + 0.5;
      const span = groundRange.max - groundRange.min;
      for (let j = 0; j < nz; j++) {
        for (let i = 0; i < nx; i++) {
          const hcm = heights[(j * nx + i) * layers];
          if (hcm === NO_SAMPLE) continue;
          const s = toScreen(view, originX + i * step, originZ + j * step);
          if (s.sx > w || s.sy > h || s.sx + cell < 0 || s.sy + cell < 0) continue;
          const t = (hcm - groundRange.min) / span;
          ctx.fillStyle = `rgba(120, 170, 200, ${(0.05 + 0.25 * t).toFixed(3)})`;
          ctx.fillRect(s.sx, s.sy, cell, cell);
        }
      }
    }

    if (layout) {
      for (const s of layout.shapes) {
        ctx.beginPath();
        if (s.kind === 'rect') {
          const corners = rectCorners(s);
          for (let k = 0; k < 4; k++) {
            const p = toScreen(view, corners[k][0], corners[k][1]);
            if (k === 0) ctx.moveTo(p.sx, p.sy);
            else ctx.lineTo(p.sx, p.sy);
          }
          ctx.closePath();
        } else if (s.kind === 'circle') {
          const p = toScreen(view, s.x, s.z);
          ctx.arc(p.sx, p.sy, Math.max(0.2, s.r) * view.scale, 0, Math.PI * 2);
        } else {
          if (s.points.length < 2) continue;
          for (let k = 0; k < s.points.length; k++) {
            const p = toScreen(view, s.points[k][0], s.points[k][1]);
            if (k === 0) ctx.moveTo(p.sx, p.sy);
            else ctx.lineTo(p.sx, p.sy);
          }
          if (s.closed) ctx.closePath();
        }
        const fill = s.kind === 'path' ? '' : cssColour(s.fill, '');
        const stroke = cssColour(s.stroke, '');
        if (fill) {
          ctx.fillStyle = fill;
          ctx.fill();
        }
        if (stroke) {
          ctx.strokeStyle = stroke;
          ctx.lineWidth = Math.max(0.5, (s.width ?? 0.65) * view.scale);
          ctx.stroke();
        }
        if (!fill && !stroke) {
          ctx.fillStyle = C.shape;
          ctx.fill();
        }
      }
      const a = toScreen(view, layout.bounds.min.x, layout.bounds.min.z);
      const b = toScreen(view, layout.bounds.max.x, layout.bounds.max.z);
      ctx.strokeStyle = C.bounds;
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(a.sx, a.sy, b.sx - a.sx, b.sy - a.sy);
      ctx.setLineDash([]);
    }

    const sKey = selectionKey(selected);
    for (const o of objects) {
      const mv = moveByName.get(o.name);
      const isSel = sKey === `o:${o.name}`;
      const p = toScreen(view, o.position.x, o.position.z);
      if (mv?.position) {
        const q = toScreen(view, mv.position.x, mv.position.z);
        ctx.strokeStyle = C.pending;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(p.sx, p.sy);
        ctx.lineTo(q.sx, q.sy);
        ctx.stroke();
        ctx.setLineDash([]);
        dot(ctx, p.sx, p.sy, 2.5, C.objectFaint);
        ring(ctx, q.sx, q.sy, isSel ? 7 : 5, C.pending);
        if (isSel) ring(ctx, q.sx, q.sy, 10, C.selected);
      } else {
        dot(ctx, p.sx, p.sy, isSel ? 4.5 : 3, mv?.hidden ? C.objectFaint : C.object);
        if (isSel) ring(ctx, p.sx, p.sy, 9, C.selected);
      }
    }
    for (const e of entries) {
      const isSel = sKey === `e:${e._key}`;
      if (e.kind === 'place') {
        const p = toScreen(view, e.position.x, e.position.z);
        diamond(ctx, p.sx, p.sy, isSel ? 7 : 5, C.place);
        if (isSel) ring(ctx, p.sx, p.sy, 11, C.selected);
      } else if (e.position && !objectByName.has(e.target.name)) {
        const p = toScreen(view, e.position.x, e.position.z);
        ring(ctx, p.sx, p.sy, isSel ? 7 : 5, C.pending);
        if (isSel) ring(ctx, p.sx, p.sy, 10, C.selected);
      }
    }

    ctx.fillStyle = C.text;
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText('N ↑ (−Z)', 8, 14);
    ctx.fillText(`${view.scale >= 1 ? fmt(view.scale) + ' px/m' : fmt(1 / view.scale) + ' m/px'}`, 8, h - 8);
    if (placeMode) ctx.fillText('click empty ground to place', 8, 30);

    if (hover) {
      const text = `${hover.info.label}  (${fmt(hover.info.x)}, ${hover.info.y === null ? '?' : fmt(hover.info.y)}, ${fmt(hover.info.z)})`;
      const tw = ctx.measureText(text).width + 10;
      const tx = Math.min(hover.sx + 12, w - tw - 4);
      const ty = Math.max(hover.sy - 22, 4);
      ctx.fillStyle = 'rgba(4, 10, 15, 0.9)';
      ctx.fillRect(tx, ty, tw, 18);
      ctx.fillStyle = C.text;
      ctx.fillText(text, tx + 5, ty + 13);
    }
  }, [layout, ground, groundRange, objects, entries, selected, placeMode, hover, tick, objectByName, moveByName]);

  const local = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  };

  function onPointerDown(e: ReactPointerEvent<HTMLCanvasElement>) {
    const view = viewRef.current;
    if (!view) return;
    /* Only the primary and middle buttons start a gesture; a right-click
     * must not capture the pointer. Any gesture clears the hover label so it
     * is not left painted at a stale spot while the map moves under it. */
    if (e.button !== 0 && e.button !== 1) return;
    const { sx, sy } = local(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    setHover(null);
    onHover?.(null);
    if (e.button === 1 || spaceRef.current) {
      gestureRef.current = { mode: 'pan', lastX: sx, lastY: sy };
      return;
    }
    const hit = hitTest(view, candidates, sx, sy, HIT_TOL_PX);
    if (hit && hit.key === selectionKey(selected)) {
      gestureRef.current = { mode: 'drag', target: selectionFromKey(hit.key), startX: sx, startY: sy, moved: false };
      return;
    }
    gestureRef.current = { mode: 'click', hit, startX: sx, startY: sy, lastX: sx, lastY: sy, moved: false };
  }

  function onPointerMove(e: ReactPointerEvent<HTMLCanvasElement>) {
    const view = viewRef.current;
    if (!view) return;
    const { sx, sy } = local(e);
    const g = gestureRef.current;
    if (!g) {
      const hit = hitTest(view, candidates, sx, sy, HIT_TOL_PX);
      const info = hit ? describe(hit) : null;
      setHover(info ? { sx, sy, info } : null);
      onHover?.(info);
      return;
    }
    if (g.mode === 'pan') {
      viewRef.current = pan(view, sx - g.lastX, sy - g.lastY);
      g.lastX = sx;
      g.lastY = sy;
      redraw();
      return;
    }
    if (g.mode === 'drag') {
      if (!g.moved && Math.hypot(sx - g.startX, sy - g.startY) < DRAG_THRESHOLD_PX) return;
      g.moved = true;
      const p = toWorld(view, sx, sy);
      onDrag(g.target, p.x, p.z, 'move');
      return;
    }
    if (!g.moved && Math.hypot(sx - g.startX, sy - g.startY) < DRAG_THRESHOLD_PX) return;
    g.moved = true;
    if (!g.hit) {
      viewRef.current = pan(view, sx - g.lastX, sy - g.lastY);
      redraw();
    }
    g.lastX = sx;
    g.lastY = sy;
  }

  function onPointerUp(e: ReactPointerEvent<HTMLCanvasElement>) {
    const view = viewRef.current;
    const g = gestureRef.current;
    gestureRef.current = null;
    if (!view || !g) return;
    const { sx, sy } = local(e);
    if (g.mode === 'drag') {
      if (g.moved) {
        const p = toWorld(view, sx, sy);
        onDrag(g.target, p.x, p.z, 'end');
      }
      return;
    }
    if (g.mode === 'click' && !g.moved) {
      if (g.hit) onSelect(selectionFromKey(g.hit.key));
      else if (placeMode) {
        const p = toWorld(view, sx, sy);
        onPlaceAt(p.x, p.z);
      } else onSelect(null);
    }
  }

  function onPointerEnter() {
    hoveredRef.current = true;
  }

  function onPointerLeave() {
    hoveredRef.current = false;
    setHover(null);
    onHover?.(null);
  }

  return (
    <canvas
      ref={ref}
      data-e2e="map-canvas"
      role="img"
      aria-label={`Top-down map: ${objects.length} named objects, ${entries.length} overlay entries. Use the object picker to select by keyboard.`}
      style={{
        width: '100%',
        height: HEIGHT_PX,
        display: 'block',
        borderRadius: 12,
        background: C.bg,
        touchAction: 'none',
        cursor: placeMode ? 'crosshair' : 'grab',
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      /* Windows Chrome/Edge start autoscroll on a middle MOUSE down unless
       * that event (not the pointer event) is default-prevented. */
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault();
      }}
      onAuxClick={(e) => e.preventDefault()}
    />
  );
}
```

- [ ] **Step 3: Typecheck**

```
cd site && npx tsc --noEmit -p .
```
Expected: no output, exit code 0. (The component is not imported anywhere yet — that is Task 6; tsc still checks it because `tsconfig.json` includes `**/*.tsx`.)

- [ ] **Step 4: Manual verification (deferred)**

Nothing renders until Task 6 composes the panel. The checks for this component are in chunk 7 manual checklist, items 3–9 (floorplan orientation, hover label, click-select, drag, wheel zoom about the cursor, space-drag pan, place mode).

- [ ] **Step 5: Commit**

```
git add site/components/mapEditorStyles.ts site/components/MapCanvas.tsx
git commit -m "The map editor has a canvas that draws a world's layout and takes clicks" -m "A drawing component with no decisions of its own: projection, hit-testing and snapping come from the pure modules, and every pointer gesture becomes a callback the panel interprets. The view lives in a ref so a drag redraws one canvas rather than re-rendering the editor per pixel. The ground grid is painted only under 70 000 cells because a 400-square grid stuttered under drag; it still drives snapping either way." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---
### Task 4: `site/components/MapSelectionPanel.tsx` — pick, type, snap, layer, commit

**Files:**
- Create: `site/components/MapSelectionPanel.tsx`
- No unit test (DOM). Every value it shows comes from `mapEditorState.ts` / `mapLayout.ts`, which are tested.

The dropdown is a `<select>` grouped by the token before the first `:` in the name (`medieval:house` → group `medieval`; names without a colon go under `other`), with a second optgroup for placements and a third for moves whose target the game has not reported. A free-text field beneath (`<input list>`, Enter to select) keeps the day-one path for a world with no report — the free-text move the old panel allowed. X/Y/Z/yaw° fields; "snap Y to ground" (default on) recomputes Y through `snappedY` whenever X or Z is typed; a layer `<select>` appears only when `layersAt` finds more than one surface under the typed X/Z; the ground readout's `✓ on surface` / `⚠ underground|floating|no-ground` is computed from the **typed** Y against chunk 3's `UNDERGROUND_TOLERANCE` (0.25) and `FLOATING_TOLERANCE` (1.5) so it warns before **Move here**, while the conflict list beneath is the committed entry's; if chunk 3 landed without exporting those two constants, add the exports there rather than re-typing the numbers here. Selection ↔ `<option value>` uses chunk 4's `selectionKey`/`selectionFromKey`, the same pair the canvas uses. Buttons: **Move here** (commits the typed transform), **Reset** (drops an object's pending move), **Remove entry** (for a selected placement or free move). This task also carries the site build (Step 3), the first point at which the chunk's components are all present.

- [ ] **Step 1: Write the component**

```tsx
// site/components/MapSelectionPanel.tsx
'use client';

import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { groundAt, layersAt, type DecodedGround } from '@/lib/mapLayout';
import { FLOATING_TOLERANCE, UNDERGROUND_TOLERANCE, type Conflict } from '@/lib/mapConflicts';
import type { CatalogueObject } from '@/lib/mapOverlay';
import type { PlaceEntry, Vec3 } from '@/lib/mapOverlaySchema';
import {
  degToRad,
  fmt,
  radToDeg,
  selectedEntry,
  selectedPosition,
  selectionFromKey,
  selectionKey,
  snappedY,
  type Draft,
  type Selected,
} from '@/lib/mapEditorState';
import { coord, dim, errorColour, input, label, okColour, subtle, warnColour } from './mapEditorStyles';

/**
 * The selection panel: the keyboard path into the map, and the typed path
 * for a move.
 *
 * ── Why a `<select>` and not only the canvas ───────────────────────────────
 *
 * A prop can be two pixels wide at a zoom that shows the whole world, and a
 * screen reader cannot click a canvas at all. The dropdown reaches every
 * object the game reported, grouped by family so a world with 1 800 names
 * is a list of twenty groups. Both routes set the same `selected`.
 *
 * ── Why the fields re-sync from props ──────────────────────────────────────
 *
 * A drag on the map changes the entry underneath this panel; the fields
 * follow it so what is typed and what is drawn never disagree. The sync key
 * includes the position so a drag updates the boxes, and the selection so
 * picking another object clears them.
 */

export interface MapSelectionPanelProps {
  objects: CatalogueObject[];
  entries: Draft[];
  selected: Selected;
  ground: DecodedGround | null;
  /** Conflicts for the entry the selection maps to (empty when there is no entry yet). */
  conflicts: Conflict[];
  disabled: boolean;
  onSelect: (sel: Selected) => void;
  onCommit: (sel: NonNullable<Selected>, position: Vec3, rotationY: number | undefined) => void;
  onReset: (sel: NonNullable<Selected>) => void;
  onRemoveEntry: (key: string) => void;
}

type Form = { x: string; y: string; z: string; yaw: string };

function num(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function groupOf(name: string): string {
  const i = name.indexOf(':');
  return i > 0 ? name.slice(0, i) : 'other';
}

type GroundStatus = 'ok' | 'underground' | 'floating' | 'no-ground';

export default function MapSelectionPanel(props: MapSelectionPanelProps) {
  const { objects, entries, selected, ground, conflicts, disabled, onSelect, onCommit, onReset, onRemoveEntry } = props;

  const objectNames = useMemo(() => new Set(objects.map((o) => o.name)), [objects]);
  const groups = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const o of objects) {
      const g = groupOf(o.name);
      const list = m.get(g);
      if (list) list.push(o.name);
      else m.set(g, [o.name]);
    }
    return [...m.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([g, names]) => [g, names.sort((a, b) => a.localeCompare(b))] as const);
  }, [objects]);
  const places = useMemo(() => entries.filter((e): e is Draft & PlaceEntry => e.kind === 'place'), [entries]);
  const freeMoves = useMemo(
    () => entries.filter((e) => e.kind === 'move' && !objectNames.has(e.target.name)),
    [entries, objectNames]
  );

  const entry = selectedEntry(entries, selected);
  const current = selectedPosition(objects, entries, selected);
  const rotation = entry?.rotationY;

  const [form, setForm] = useState<Form>({ x: '0', y: '0', z: '0', yaw: '' });
  const [snap, setSnap] = useState(true);
  const [typed, setTyped] = useState('');

  const syncKey = `${selectionKey(selected) ?? ''}|${current?.x}|${current?.y}|${current?.z}|${rotation}`;
  useEffect(() => {
    setForm({
      x: current ? String(current.x) : '0',
      y: current ? String(current.y) : '0',
      z: current ? String(current.z) : '0',
      yaw: rotation !== undefined ? String(Math.round(radToDeg(rotation) * 10) / 10) : '',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncKey]);

  function setAxis(axis: 'x' | 'z', value: string) {
    setForm((f) => {
      const next = { ...f, [axis]: value };
      if (snap && current) {
        const y = snappedY(ground, current, num(next.x), num(next.z));
        if (y !== null) next.y = String(Math.round(y * 1000) / 1000);
      }
      return next;
    });
  }

  const fx = num(form.x);
  const fy = num(form.y);
  const fz = num(form.z);
  const groundHere = selected ? groundAt(ground, fx, fz, fy) : null;
  const layers = selected ? layersAt(ground, fx, fz) : [];
  /* From the TYPED Y, not the committed entry, so the warning shows before
   * Move here; the tolerances are chunk 3's, so this line and the save route
   * cannot disagree about where "on surface" ends. */
  const typedStatus: GroundStatus | null =
    !selected || !ground
      ? null
      : groundHere === null
        ? 'no-ground'
        : fy < groundHere - UNDERGROUND_TOLERANCE
          ? 'underground'
          : fy > groundHere + FLOATING_TOLERANCE
            ? 'floating'
            : 'ok';

  function commit() {
    if (!selected) return;
    const yaw = form.yaw.trim() === '' ? undefined : degToRad(num(form.yaw));
    onCommit(selected, { x: fx, y: fy, z: fz }, yaw);
  }

  function onTypedKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const name = typed.trim();
    if (name) onSelect({ kind: 'object', name });
  }

  const title = !selected ? 'Nothing selected' : selected.kind === 'object' ? selected.name : entry?.kind === 'place' ? `${entry.item.name} ×${entry.quantity}` : entry?.kind === 'move' ? entry.target.name : 'entry';

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <label style={label}>
        Object
        <select
          style={input}
          data-e2e="object-select"
          value={selectionKey(selected) ?? ''}
          disabled={disabled}
          onChange={(e) => onSelect(e.target.value ? selectionFromKey(e.target.value) : null)}
        >
          <option value="">— pick an object —</option>
          {groups.map(([g, names]) => (
            <optgroup key={g} label={g}>
              {names.map((n) => (
                <option key={n} value={`o:${n}`}>{n}</option>
              ))}
            </optgroup>
          ))}
          {places.length ? (
            <optgroup label="placements">
              {places.map((p) => (
                <option key={p._key} value={`e:${p._key}`}>{p.item.name} ×{p.quantity}</option>
              ))}
            </optgroup>
          ) : null}
          {freeMoves.length ? (
            <optgroup label="moves by name (not in the report)">
              {freeMoves.map((m) => (
                <option key={m._key} value={`e:${m._key}`}>{m.kind === 'move' ? m.target.name : ''}</option>
              ))}
            </optgroup>
          ) : null}
        </select>
      </label>
      <label style={label}>
        Or type a name and press Enter
        <input
          style={input}
          data-e2e="object-typed"
          list="map-editor-objects"
          value={typed}
          disabled={disabled}
          placeholder="e.g. barn.main"
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={onTypedKey}
        />
      </label>
      <datalist id="map-editor-objects">
        {objects.map((o) => (
          <option key={o.name} value={o.name} />
        ))}
      </datalist>

      <div data-e2e="sel-name" style={{ fontSize: 13, color: '#cfe6f2', wordBreak: 'break-all' }}>
        <b>{title}</b>
        {selected?.kind === 'object' && !objectNames.has(selected.name) ? (
          <span style={{ color: warnColour }}> — not in the game's report</span>
        ) : null}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
        <label style={label}>
          X
          <input style={coord} data-e2e="sel-x" type="number" step="0.1" value={form.x} disabled={!selected || disabled} onChange={(e) => setAxis('x', e.target.value)} />
        </label>
        <label style={label}>
          Y
          <input style={coord} data-e2e="sel-y" type="number" step="0.1" value={form.y} disabled={!selected || disabled} onChange={(e) => setForm((f) => ({ ...f, y: e.target.value }))} />
        </label>
        <label style={label}>
          Z
          <input style={coord} data-e2e="sel-z" type="number" step="0.1" value={form.z} disabled={!selected || disabled} onChange={(e) => setAxis('z', e.target.value)} />
        </label>
        <label style={label}>
          Yaw °
          <input style={coord} data-e2e="sel-yaw" type="number" step="1" value={form.yaw} disabled={!selected || disabled} placeholder="—" onChange={(e) => setForm((f) => ({ ...f, yaw: e.target.value }))} />
        </label>
      </div>

      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: '#cfe6f2' }}>
        <input type="checkbox" data-e2e="snap" checked={snap} onChange={(e) => setSnap(e.target.checked)} />
        snap Y to ground (keeps the object's authored sink or lift)
      </label>

      {layers.length > 1 ? (
        <label style={label}>
          Layer at this X/Z
          <select
            style={input}
            data-e2e="layer-select"
            value=""
            disabled={disabled}
            onChange={(e) => {
              const h = Number(e.target.value);
              if (Number.isFinite(h)) setForm((f) => ({ ...f, y: String(h) }));
            }}
          >
            <option value="">— choose a surface for Y —</option>
            {layers.map((h, i) => (
              <option key={`${i}-${h}`} value={String(h)}>{i === 0 ? 'Top' : `Layer ${i}`} {fmt(h)} m</option>
            ))}
          </select>
        </label>
      ) : null}

      <div data-e2e="sel-ground" style={{ fontSize: 12, color: dim }}>
        {!selected
          ? 'Pick an object on the map or in the list.'
          : !ground
            ? 'No ground grid for this world yet.'
            : groundHere === null
              ? 'No ground sample here.'
              : `Ground here: ${fmt(groundHere)} m`}
        {typedStatus ? (
          <span data-e2e="sel-ground-status" style={{ color: typedStatus === 'ok' ? okColour : warnColour }}>
            {typedStatus === 'ok' ? '  ✓ on surface' : `  ⚠ ${typedStatus}`}
          </span>
        ) : null}
      </div>

      {conflicts.length ? (
        <ul data-e2e="sel-conflicts" style={{ margin: 0, paddingLeft: 18, fontSize: 12, display: 'grid', gap: 3 }}>
          {conflicts.map((c, i) => (
            <li key={`${c.code}-${i}`} style={{ color: c.level === 'error' ? errorColour : warnColour }}>
              {c.level === 'error' ? '⛔' : '⚠'} {c.code} — {c.detail}{c.other ? ` (${c.other})` : ''}
            </li>
          ))}
        </ul>
      ) : null}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn btn-primary btn-sm" type="button" data-e2e="move-here" disabled={!selected || disabled} onClick={commit}>
          Move here
        </button>
        {selected?.kind === 'object' && entry ? (
          <button className="btn btn-ghost btn-sm" type="button" data-e2e="reset" disabled={disabled} onClick={() => onReset(selected)}>
            Reset
          </button>
        ) : null}
        {selected?.kind === 'entry' ? (
          <button className="btn btn-ghost btn-sm" type="button" data-e2e="remove-entry" disabled={disabled} onClick={() => onRemoveEntry(selected.key)}>
            Remove entry
          </button>
        ) : null}
      </div>
      <p style={{ margin: 0, fontSize: 11, color: subtle }}>
        Yaw is stored in radians; this field is degrees. Drag the mark on the map to move without typing.
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```
cd site && npx tsc --noEmit -p .
```
Expected: no output, exit code 0. If `FLOATING_TOLERANCE`/`UNDERGROUND_TOLERANCE` are not exported from `@/lib/mapConflicts`, export them from chunk 3's module (they are its 1.5 and 0.25) — do not inline the numbers here.

- [ ] **Step 3: Build**

```
cd site && npm run build:site-only
```
Expected: `✓ Compiled successfully`, the route table still lists `ƒ /admin/map`, exit code 0. Nothing imports the new components yet (that is chunk 6), so this proves they compile under Next's client-component rules — `'use client'` first, no server-only import — before the panel depends on them.

- [ ] **Step 4: Manual verification (deferred)** — chunk 7 checklist items 10–16 (grouped dropdown, typed name, snap recompute, layer picker on a two-layer cell, ground readout warning from the typed Y, Move here / Reset / Remove entry).

- [ ] **Step 5: Commit**

```
git add site/components/MapSelectionPanel.tsx
git commit -m "The map editor's selection panel edits one chosen object" -m "The keyboard route into the map and the typed route for a move. A select grouped by name family reaches props too small to click; typing X or Z recomputes Y through the tested snap rule; a layer picker appears only where the ground grid has more than one surface, so a rooftop placement is one choice rather than a guess. The fields re-sync from the entry so a drag on the canvas and the numbers here never disagree." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---


---

## Chunk 6: Site — pending list and the composed editor

**Executes after chunk 5** (`MapCanvas.tsx`, `MapSelectionPanel.tsx`, `mapEditorStyles.ts`) and therefore after chunks 2–4. It consumes the skeleton's *Shared interfaces* and chunk 4's `mapEditorState.ts` exactly as defined.

**What this chunk builds.** The pending list (`MapPendingList.tsx`) and the `MapEditorPanel.tsx` rewrite that composes it with the canvas and the selection panel — keeping today's save/revert/versions/marketplace behaviours (quoted in Task 6) and adding the layout banner, live conflicts, drag-to-move with snapped Y, click-to-place, and the `400 { error: 'conflicts' }` handling. After Task 6 the editor renders end to end; the harness, the manual checklist and the gates are **chunk 7**. Task numbering continues from chunk 5.

**Constraints (unchanged):** components cannot be unit-tested; every decision is delegated to the pure modules; inline `CSSProperties` + `btn btn-ghost | btn-primary | btn-sm` + `.banner`; typecheck `cd site && npx tsc --noEmit -p .`; build `cd site && npm run build:site-only`; sentence-case commit lines, why-prose bodies, the single `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer; commit in the worktree, do not push.

---

### Task 5: `site/components/MapPendingList.tsx` — every change, its warnings, and undo

**Files:**
- Create: `site/components/MapPendingList.tsx`
- No unit test (DOM). Row text and level come from `pendingRows` (tested in Task 2).

Rows render `pendingRows()` output. `[undo]` removes the entry (the panel owns the list). Warnings are inline on the row; a row rejected by the save route is outlined red. The Save button is **not** here — it stays in the panel (Task 6), disabled while `hasErrors(conflicts)`.

- [ ] **Step 1: Write the component**

```tsx
// site/components/MapPendingList.tsx
'use client';

import type { PendingRow } from '@/lib/mapEditorState';
import { dim, errorColour, moveColour, okColour, placeColour, warnColour } from './mapEditorStyles';

/**
 * The pending list: what this version will say, one row per entry.
 *
 * Rows are the document in order, not only "changes made this session":
 * an overlay saved last week is still a set of moves the game applies on
 * every load, and hiding it would make the map lie about why a crate is
 * where it is. Each row is the entry's text from `pendingRows`, its worst
 * conflict level, and an undo that removes it from the document.
 */

export interface MapPendingListProps {
  rows: PendingRow[];
  selectedKey: string | null;
  /** Keys the save route rejected (`400 { error: 'conflicts', rejected }`), outlined until the next edit. */
  rejectedKeys: ReadonlySet<string>;
  disabled: boolean;
  onSelect: (key: string) => void;
  onUndo: (key: string) => void;
}

const LEVEL = {
  ok: { icon: '✓', colour: okColour },
  warn: { icon: '⚠', colour: warnColour },
  error: { icon: '⛔', colour: errorColour },
} as const;

export default function MapPendingList({ rows, selectedKey, rejectedKeys, disabled, onSelect, onUndo }: MapPendingListProps) {
  if (!rows.length) {
    return (
      <p data-e2e="pending-empty" style={{ margin: 0, color: dim, fontSize: 13 }}>
        No entries. The world is exactly as its code builds it.
      </p>
    );
  }
  return (
    <ul data-e2e="pending-list" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
      {rows.map((r) => {
        const lv = LEVEL[r.level];
        const isSel = r.key === selectedKey;
        const rejected = rejectedKeys.has(r.key);
        return (
          <li
            key={r.key}
            data-e2e="pending-row"
            data-level={r.level}
            data-rejected={rejected ? 'true' : undefined}
            style={{
              display: 'grid',
              gridTemplateColumns: '58px minmax(0, 1fr) auto auto',
              gap: 10,
              alignItems: 'center',
              padding: '8px 10px',
              borderRadius: 10,
              fontSize: 12,
              background: isSel ? 'rgba(82, 233, 255, 0.08)' : 'rgba(0,0,0,0.16)',
              border: rejected ? `1px solid ${errorColour}` : isSel ? '1px solid rgba(82, 233, 255, 0.4)' : '1px solid rgba(255,255,255,0.06)',
            }}
          >
            <b style={{ color: r.kind === 'move' ? moveColour : placeColour, letterSpacing: '0.12em', fontSize: 11 }}>
              {r.kind.toUpperCase()}
            </b>
            <button
              type="button"
              data-e2e="pending-select"
              onClick={() => onSelect(r.key)}
              style={{ all: 'unset', cursor: 'pointer', color: '#cfe6f2', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              title={`${r.label} ${r.summary}`}
            >
              <span data-e2e="pending-label">{r.label}</span>
              <span style={{ color: dim }}> {r.summary}</span>
            </button>
            <span data-e2e="pending-status" style={{ color: lv.colour, whiteSpace: 'nowrap' }} title={r.conflicts.map((c) => c.detail).join('\n')}>
              {lv.icon}{r.conflicts.length ? ` ${r.conflicts.map((c) => c.code).join(', ')}` : ''}
              {rejected ? ' · rejected by save' : ''}
            </span>
            <button className="btn btn-ghost btn-sm" type="button" data-e2e="pending-undo" disabled={disabled} onClick={() => onUndo(r.key)}>
              undo
            </button>
          </li>
        );
      })}
    </ul>
  );
}
```

- [ ] **Step 2: Typecheck**

```
cd site && npx tsc --noEmit -p .
```
Expected: no output, exit code 0.

- [ ] **Step 3: Manual verification (deferred)** — chunk 7 checklist items 17–18 (row text matches the selection; undo removes the entry and clears its mark) and item 21 (a save rejected against a newer layout outlines the row red with `· rejected by save`, then shows its real `⛔` once the panel refreshes the layout).

- [ ] **Step 4: Commit**

```
git add site/components/MapPendingList.tsx
git commit -m "The map editor lists every pending change with its warnings" -m "One row per document entry, in document order, with the worst conflict level beside it and an undo that removes the entry. Rows are the whole document rather than this session's edits because a move saved last week is still applied on every load, and a map that hid it would not explain where a crate went." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---
### Task 6: `site/components/MapEditorPanel.tsx` — rewrite: map-first, composing the three components

**Files:**
- Modify: `site/components/MapEditorPanel.tsx` (whole file replaced; 500 lines today)
- No unit test (DOM). Verified by typecheck, `build:site-only`, the manual checklist and the e2e harness (chunk 7).

**What is kept, verbatim in behaviour, from today's panel** (quoted so a reviewer can diff intent, not only text):
- State names and the `Draft`/`_key` pattern: `withKeys`/`stripKeys` "add/remove `_key` around fetches"; `_key` is never sent.
- Load: `fetch(\`/api/admin/map/${which}\`, { cache: 'no-store' })` → sets `entries`, `savedVersion`, `versions`, `report`, clears `dirty` and `note`. Now also sets `layout` and `reportedAt` from the same response (chunk 2).
- Catalogue: `fetch(\`/api/admin/marketplace/items?activeOnly=1&search=\`)`, "filters `i.world_name === which`, falls back to all" with its comment about planets.
- Save: `POST /api/admin/map/${world}` body `{ entries: stripKeys(entries), note: note || null }`; on success the message is exactly `Saved version ${v}. Reload the world in game to see it.` or the `…entr(y was|ies were) rejected: …` form; then `await load(world)`. **New:** a `400 { error: 'conflicts', rejected }` (chunk 3) is not thrown. It can only mean the page's layout is older than the server's (the client ran the same check and passed), so the handler outlines the rejected rows, re-GETs the world and replaces ONLY `layout`, `reportedAt`, `report` and `versions` — never `entries` or `dirty`, the unsaved edits are the point — so the rows show their real `⛔`, Save disables, and the message reads `Not saved: the server found N error(s) (…) against a newer layout — layout refreshed, fix the outlined rows.` Chunk 7 item 21 exercises exactly this path.
- Revert: `confirm(...)` with the same wording, `POST { revertTo: version }`, same success message, `load(world)`.
- Place: `addPlace(item)` semantics — `source_key: item.source_key ?? item.id`, config **copied** from `action_config`, `quantity: 1` — now via `placeAt()` at a clicked point instead of `0,0,0`.
- The "What the game reports" card (its "floorplan and ground grid will fill in here" copy is true only once chunk 1's game-side layout report ships in the same deploy — chunk 7 P2 checks it), the "Version history" card with its append-only note, the `hidden` checkbox for a move and the quantity field for a placement.
- Button classes `btn btn-ghost` / `btn btn-primary` on every button today's panel has (the revert button keeps `btn btn-ghost` exactly); the `Saved (v${savedVersion})` / `Save new version` / `Working…` labels. New buttons this rewrite adds (Cancel placement) use `btn btn-ghost btn-sm`.

**Drag and typing must agree.** A drag's every `'move'` frame snaps from `dragFromRef` — the position captured before the first drag edit — not from the previous frame's snapped output. Re-deriving the lift each frame climbs a layer at a dome edge (a lift larger than the gap re-anchors to the layer above) and loses the lift after crossing a `NO_SAMPLE` cell; anchoring once makes a drag produce exactly what typing the same X/Z would. Conflicts are recomputed from a `useDeferredValue` of `entries`, so a drag frame under load does not pay 2 000 × 500 distance tests before it paints — keyed by `_key` (never by index, so an undone row cannot lend its conflicts to its neighbour), and with Save disabled and labelled `Checking…` for the window in which the deferred document is behind the live one, because `dirty` flips in the urgent render and Save must never be judged on stale conflicts. The 400 message says "layout refreshed" only when the re-GET succeeded; otherwise "could not refresh the layout; reload the world."

**Removed:** the per-entry `<article>` forms (the map + selection panel replace them), `addMove` at `0,0,0` (the free-text field in the selection panel replaces it), the per-entry "applied in game" line (the report card keeps the unresolved list).

- [ ] **Step 1: Replace the file**

```tsx
// site/components/MapEditorPanel.tsx
'use client';

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { OVERLAY_WORLDS, type GrantConfig, type OverlayEntry, type OverlayWorld, type Vec3 } from '@/lib/mapOverlaySchema';
import type { MarketplaceItemRecord } from '@/lib/marketplaceCatalog';
import type { CatalogueObject, OverlayVersionRow, WorldReport } from '@/lib/mapOverlay';
import { decodeGround, layersAt, type DecodedGround, type WorldLayout } from '@/lib/mapLayout';
import { conflictsForDocument, hasErrors, type Conflict } from '@/lib/mapConflicts';
import {
  layoutAgeText,
  moveEntryFor,
  pendingRows,
  placeAt,
  selectedEntry,
  selectedPosition,
  snappedY,
  upsertMoveFor,
  type Draft,
  type Selected,
} from '@/lib/mapEditorState';
import MapCanvas from './MapCanvas';
import MapPendingList from './MapPendingList';
import MapSelectionPanel from './MapSelectionPanel';
import { card, coord, dim, input, label, statusColour, subtle } from './mapEditorStyles';

/**
 * The map editor.
 *
 * ── What it edits, and what it deliberately is not ─────────────────────────
 *
 * A map over a placement overlay — a versioned document of moved and placed
 * instances the game applies AFTER a world has finished building. The map is
 * a top-down drawing of what the admin's own game reported (bounds, floorplan
 * shapes, a physics-sampled ground grid), not a second copy of the world: a
 * 3D viewport here would need the whole procedural world built again in a
 * second engine, which is exactly the "two places world geometry lives"
 * problem the overlay exists to avoid.
 *
 * ── Where the names and the ground come from ───────────────────────────────
 *
 * From the running game. Nothing on the server knows what `MedievalWorld.js`
 * built; an admin's client posts the world's named objects and its layout
 * back after it applies the overlay. Until a world has been visited by an
 * admin the map is an empty ±100 m square, the picker is empty, and a move
 * can still be typed by name — honest about what is known.
 *
 * ── Decisions live elsewhere ───────────────────────────────────────────────
 *
 * This component owns state and fetches. What a drag does to Y, what a row
 * says, what conflicts an entry has — `mapEditorState.ts`, `mapConflicts.ts`
 * — are pure and tested. The save route runs the same `conflictsForDocument`;
 * a client that skipped it could not save an invalid document.
 */

function newKey(): string {
  return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function withKeys(entries: OverlayEntry[]): Draft[] {
  return entries.map((e) => ({ ...e, _key: newKey() }) as Draft);
}

function stripKeys(entries: Draft[]): OverlayEntry[] {
  return entries.map(({ _key: _unused, ...rest }) => rest as OverlayEntry);
}

function num(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

interface SaveRejection {
  index: number;
  id: string | null;
  reason: string;
}

export function MapEditorPanel() {
  const [world, setWorld] = useState<OverlayWorld>('station');
  const [entries, setEntries] = useState<Draft[]>([]);
  const [savedVersion, setSavedVersion] = useState(0);
  const [versions, setVersions] = useState<OverlayVersionRow[]>([]);
  const [report, setReport] = useState<WorldReport | null>(null);
  const [layout, setLayout] = useState<WorldLayout | null>(null);
  const [reportedAt, setReportedAt] = useState<string | null>(null);
  const [catalogue, setCatalogue] = useState<MarketplaceItemRecord[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState<Selected>(null);
  const [placeItem, setPlaceItem] = useState<MarketplaceItemRecord | null>(null);
  const [rejectedKeys, setRejectedKeys] = useState<ReadonlySet<string>>(() => new Set());
  /* Set after mount so the server render and the first client render agree
   * (a clock read during render is a hydration mismatch waiting to happen). */
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  const load = useCallback(async (which: OverlayWorld) => {
    setBusy(true);
    setMessage('');
    try {
      const res = await fetch(`/api/admin/map/${which}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Could not load the overlay.');
      setEntries(withKeys(data.overlay.entries ?? []));
      setSavedVersion(data.overlay.version ?? 0);
      setVersions(data.versions ?? []);
      setReport(data.report ?? null);
      setLayout(data.layout ?? null);
      setReportedAt(data.reportedAt ?? null);
      setDirty(false);
      setNote('');
      setSelected(null);
      setPlaceItem(null);
      setRejectedKeys(new Set());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not load the overlay.');
    } finally {
      setBusy(false);
    }
  }, []);

  const loadCatalogue = useCallback(async (which: OverlayWorld) => {
    try {
      // The catalogue is per-world for the six worlds that have shops. Every
      // other world gets the whole list: an admin placing a crate on a planet
      // is not restricted to what a vendor there would sell.
      const res = await fetch(`/api/admin/marketplace/items?activeOnly=1&search=`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      const items: MarketplaceItemRecord[] = data.items ?? [];
      const forWorld = items.filter((i) => i.world_name === which);
      setCatalogue(forWorld.length ? forWorld : items);
    } catch {
      setCatalogue([]);
    }
  }, []);

  useEffect(() => {
    void load(world);
    void loadCatalogue(world);
  }, [world, load, loadCatalogue]);

  const ground = useMemo<DecodedGround | null>(() => {
    if (!layout?.ground) return null;
    try {
      return decodeGround(layout.ground);
    } catch {
      return null;
    }
  }, [layout]);

  const objects = useMemo<CatalogueObject[]>(() => report?.objects ?? [], [report]);

  /* Conflicts follow a DEFERRED view of the document: a drag frame paints
   * first and the O(entries × objects) check runs when React has a moment.
   * Two consequences, handled explicitly:
   *   - conflicts are keyed by `_key`, never by index, so a row removed by
   *     undo cannot inherit its neighbour's old conflicts for a frame;
   *   - rows may show a stale ⚠ for a frame, but Save may NOT be judged on
   *     stale conflicts: `checking` is true whenever the deferred document
   *     is behind the live one, and Save is disabled for exactly that window. */
  const deferredEntries = useDeferredValue(entries);
  const conflicts = useMemo<Conflict[][]>(
    () => conflictsForDocument(stripKeys(deferredEntries), { layout, ground, objects }),
    [deferredEntries, layout, ground, objects]
  );
  const conflictByKey = useMemo(
    () => new Map(deferredEntries.map((e, i) => [e._key, conflicts[i] ?? []])),
    [deferredEntries, conflicts]
  );
  const rows = useMemo(
    () => pendingRows(entries, entries.map((e) => conflictByKey.get(e._key) ?? [])),
    [entries, conflictByKey]
  );
  const blocked = hasErrors(conflicts);
  const checking = deferredEntries !== entries;

  const selEntry = selectedEntry(entries, selected);
  const selConflicts = selEntry ? (conflictByKey.get(selEntry._key) ?? []) : [];

  /* Every edit goes through here: the document changes, the version is dirty,
   * and the server's last rejection no longer applies to these rows. A drag's
   * intermediate frames pass `commit = false` so dirtiness lands once, on release. */
  const edit = useCallback((fn: (list: Draft[]) => Draft[], commit = true) => {
    setEntries(fn);
    if (commit) {
      setDirty(true);
      setRejectedKeys(new Set());
    }
  }, []);

  /* Where the current drag started. Captured on the FIRST 'move' frame —
   * the entry's or object's position before any drag edit — and used as
   * `from` for every frame including 'end', then cleared. Snapping from the
   * previous frame's output instead re-derives the lift each frame: at a
   * dome edge a lift larger than the gap re-anchors to the layer above and
   * climbs, and a NO_SAMPLE cell crossed and left loses the lift entirely. */
  const dragFromRef = useRef<Vec3 | null>(null);

  function moveSelection(target: NonNullable<Selected>, x: number, z: number, phase: 'move' | 'end') {
    if (!dragFromRef.current) {
      dragFromRef.current = selectedPosition(objects, entries, target) ?? { x, y: 0, z };
    }
    const from = dragFromRef.current;
    const y = snappedY(ground, from, x, z) ?? from.y;
    edit((list) => {
      if (target.kind === 'object') {
        const mv = moveEntryFor(list, target.name);
        return upsertMoveFor(list, target.name, { x, y, z }, mv?.rotationY, newKey);
      }
      return list.map((e) => (e._key === target.key && e.position ? ({ ...e, position: { x, y, z } } as Draft) : e));
    }, phase === 'end');
    if (phase === 'end') dragFromRef.current = null;
  }

  function commitTransform(sel: NonNullable<Selected>, position: Vec3, rotationY: number | undefined) {
    edit((list) => {
      if (sel.kind === 'object') return upsertMoveFor(list, sel.name, position, rotationY, newKey);
      return list.map((e) => {
        if (e._key !== sel.key) return e;
        const next = { ...e, position } as Draft;
        if (rotationY === undefined) delete (next as { rotationY?: number }).rotationY;
        else next.rotationY = rotationY;
        return next;
      });
    });
  }

  function removeEntry(key: string) {
    edit((list) => list.filter((e) => e._key !== key));
    if (selected?.kind === 'entry' && selected.key === key) setSelected(null);
  }

  function resetSelection(sel: NonNullable<Selected>) {
    if (sel.kind !== 'object') return;
    const mv = moveEntryFor(entries, sel.name);
    if (mv) removeEntry(mv._key);
  }

  function placeHere(x: number, z: number) {
    if (!placeItem) return;
    // Y from the LOWEST layer under the click (spec §8); the layer picker in
    // the selection panel is how a rooftop placement is chosen deliberately.
    const surfaces = layersAt(ground, x, z);
    const y = surfaces.length ? surfaces[surfaces.length - 1] : 0;
    const draft = placeAt(
      {
        source_key: placeItem.source_key ?? placeItem.id,
        name: placeItem.name,
        // Copied, not referenced: what this crate contains is a decision taken
        // now, and re-authoring the catalogue row later must not change it.
        config: (placeItem.action_config ?? {}) as GrantConfig,
      },
      x,
      y,
      z,
      newKey
    );
    edit((list) => [...list, draft]);
    setSelected({ kind: 'entry', key: draft._key });
    setPlaceItem(null);
  }

  function setHidden(key: string, hidden: boolean) {
    edit((list) =>
      list.map((e) => {
        if (e._key !== key || e.kind !== 'move') return e;
        const next = { ...e } as Draft & { hidden?: true };
        if (hidden) next.hidden = true;
        else delete next.hidden;
        return next;
      })
    );
  }

  function setQuantity(key: string, value: string) {
    const quantity = Math.max(1, Math.min(99, Math.floor(num(value)) || 1));
    edit((list) => list.map((e) => (e._key === key && e.kind === 'place' ? ({ ...e, quantity } as Draft) : e)));
  }

  function selectRow(key: string) {
    const e = entries.find((d) => d._key === key);
    if (!e) return;
    if (e.kind === 'move' && objects.some((o) => o.name === e.target.name)) setSelected({ kind: 'object', name: e.target.name });
    else setSelected({ kind: 'entry', key });
  }

  async function save() {
    setBusy(true);
    setMessage('');
    try {
      const res = await fetch(`/api/admin/map/${world}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entries: stripKeys(entries), note: note || null }),
      });
      const data = await res.json();
      if (res.status === 400 && data?.error === 'conflicts' && Array.isArray(data.rejected)) {
        const rejected = data.rejected as SaveRejection[];
        const keys = new Set<string>();
        for (const r of rejected) {
          const e = entries[r.index];
          if (e) keys.add(e._key);
        }
        setRejectedKeys(keys);
        /* A 400 here means the page's layout is older than the server's —
         * the client ran the same check and passed. Refresh what the server
         * sees (layout, report, versions) but NOT the entries: the unsaved
         * edits are the point, and against the fresh layout the rows now
         * show their real ⛔ and Save disables itself. */
        let refreshed = false;
        try {
          const fresh = await fetch(`/api/admin/map/${world}`, { cache: 'no-store' });
          if (fresh.ok) {
            const cur = await fresh.json();
            setLayout(cur.layout ?? null);
            setReportedAt(cur.reportedAt ?? null);
            setReport(cur.report ?? null);
            setVersions(cur.versions ?? []);
            refreshed = true;
          }
        } catch {
          /* reported in the message below */
        }
        const reasons = [...new Set(rejected.map((r) => r.reason))].join(', ');
        const found = `Not saved: the server found ${rejected.length} error${rejected.length === 1 ? '' : 's'} (${reasons})`;
        setMessage(
          refreshed
            ? `${found} against a newer layout — layout refreshed, fix the outlined rows.`
            : `${found} — could not refresh the layout; reload the world.`
        );
        return;
      }
      if (!res.ok) throw new Error(data?.error || 'Save failed.');
      const rejected = data.overlay?.rejected ?? [];
      setMessage(
        rejected.length
          ? `Saved version ${data.overlay.version}. ${rejected.length} entr${rejected.length === 1 ? 'y was' : 'ies were'} rejected: ${rejected.map((r: { reason: string }) => r.reason).join(', ')}.`
          : `Saved version ${data.overlay.version}. Reload the world in game to see it.`
      );
      await load(world);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Save failed.');
    } finally {
      setBusy(false);
    }
  }

  async function revert(version: number) {
    if (!confirm(`Revert ${world} to version ${version}? This writes a new version holding those entries; nothing is deleted.`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/map/${world}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revertTo: version }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Revert failed.');
      setMessage(`Reverted to version ${version}, saved as version ${data.overlay.version}.`);
      await load(world);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Revert failed.');
    } finally {
      setBusy(false);
    }
  }

  const groundSummary = ground
    ? `${ground.nx}×${ground.nz} ground samples, ${ground.layers} layer${ground.layers === 1 ? '' : 's'}`
    : 'no ground grid yet';

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="banner" role="status" data-e2e="layout-banner" style={{ marginBottom: 0, alignItems: 'center' }}>
        <b>Layout</b>
        <span data-e2e="layout-age">{now ? layoutAgeText(reportedAt, now) : '…'}</span>
        {layout ? (
          <span style={{ color: dim }}>
            · {layout.shapes.length} shape{layout.shapes.length === 1 ? '' : 's'} · {groundSummary}
          </span>
        ) : null}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.35fr 1fr', gap: 20, alignItems: 'start' }}>
        <section style={card}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end', marginBottom: 14 }}>
            <label style={label}>
              World
              <select
                style={input}
                data-e2e="world-select"
                value={world}
                onChange={(e) => setWorld(e.target.value as OverlayWorld)}
                disabled={busy}
              >
                {OVERLAY_WORLDS.map((w) => (
                  <option key={w} value={w}>{w}</option>
                ))}
              </select>
            </label>
            <button
              className="btn btn-primary"
              type="button"
              data-e2e="save"
              onClick={() => void save()}
              disabled={busy || !dirty || blocked || checking}
              title={blocked ? 'An error-level conflict must be fixed before this version can be saved.' : undefined}
            >
              {busy ? 'Working…' : !dirty ? `Saved (v${savedVersion})` : checking ? 'Checking…' : blocked ? 'Fix errors to save' : 'Save new version'}
            </button>
          </div>

          <MapCanvas
            layout={layout}
            ground={ground}
            objects={objects}
            entries={entries}
            selected={selected}
            placeMode={placeItem !== null}
            onSelect={setSelected}
            onDrag={moveSelection}
            onPlaceAt={placeHere}
          />
          <p style={{ margin: '8px 0 14px', fontSize: 11, color: subtle }}>
            Click a mark to select it; drag a selected mark to move it; wheel to zoom about the cursor; drag empty
            ground, the middle button or hold Space to pan. North is up (−Z).
            {placeItem ? (
              <>
                {' '}<b style={{ color: '#ffb44a' }}>Placing {placeItem.name}</b> — click empty ground.{' '}
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPlaceItem(null)}>Cancel</button>
              </>
            ) : null}
          </p>

          <h2 style={{ margin: '0 0 8px', fontSize: 15 }}>Pending changes (this version)</h2>
          <MapPendingList
            rows={rows}
            selectedKey={selEntry?._key ?? null}
            rejectedKeys={rejectedKeys}
            disabled={busy}
            onSelect={selectRow}
            onUndo={removeEntry}
          />

          <label style={{ ...label, margin: '14px 0 0' }}>
            Note (optional — shown in the version history and the audit log)
            <input style={input} data-e2e="note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="what changed and why" />
          </label>

          {message ? (
            <p data-e2e="message" style={{ margin: '14px 0 0', color: statusColour, fontSize: 13 }} role="status">{message}</p>
          ) : null}
        </section>

        <div style={{ display: 'grid', gap: 20 }}>
          <section style={card}>
            <h2 style={{ margin: '0 0 10px', fontSize: 15 }}>Selection</h2>
            <MapSelectionPanel
              objects={objects}
              entries={entries}
              selected={selected}
              ground={ground}
              conflicts={selConflicts}
              disabled={busy}
              onSelect={setSelected}
              onCommit={commitTransform}
              onReset={resetSelection}
              onRemoveEntry={removeEntry}
            />
            {selEntry?.kind === 'move' ? (
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: '#cfe6f2', marginTop: 10 }}>
                <input
                  type="checkbox"
                  data-e2e="hidden"
                  checked={Boolean(selEntry.hidden)}
                  disabled={busy}
                  onChange={(e) => setHidden(selEntry._key, e.target.checked)}
                />
                Hide this object instead of only moving it
              </label>
            ) : null}
            {selEntry?.kind === 'place' ? (
              <label style={{ ...label, maxWidth: 160, marginTop: 10 }}>
                Quantity
                <input
                  style={coord}
                  data-e2e="quantity"
                  type="number"
                  min={1}
                  max={99}
                  value={selEntry.quantity}
                  disabled={busy}
                  onChange={(e) => setQuantity(selEntry._key, e.target.value)}
                />
              </label>
            ) : null}
          </section>

          <section style={card}>
            <h2 style={{ margin: '0 0 10px', fontSize: 15 }}>Place a marketplace item</h2>
            <p style={{ margin: '0 0 10px', color: dim, fontSize: 12 }}>
              Choose an item, then click empty ground on the map. Y is the lowest surface under the click; pick
              another layer in the selection panel for a rooftop.
            </p>
            <div style={{ display: 'grid', gap: 8, maxHeight: 320, overflowY: 'auto' }}>
              {catalogue.length === 0 ? (
                <p style={{ margin: 0, color: dim, fontSize: 13 }}>No catalogue items loaded.</p>
              ) : null}
              {catalogue.slice(0, 200).map((item) => (
                <button
                  key={item.id}
                  className={`btn ${placeItem?.id === item.id ? 'btn-primary' : 'btn-ghost'}`}
                  type="button"
                  data-e2e="catalogue-item"
                  style={{ justifyContent: 'flex-start', textAlign: 'left' }}
                  disabled={busy}
                  onClick={() => setPlaceItem((cur) => (cur?.id === item.id ? null : item))}
                >
                  {item.name} <span style={{ color: subtle }}>· {item.category}</span>
                </button>
              ))}
            </div>
          </section>

          <section style={card}>
            <h2 style={{ margin: '0 0 10px', fontSize: 15 }}>What the game reports</h2>
            {report ? (
              <div style={{ display: 'grid', gap: 6, fontSize: 13, color: '#cfe6f2' }}>
                <div>Applied version <b>{report.appliedVersion}</b> {report.appliedVersion === savedVersion ? '(current)' : '(behind — reload the world in game)'}</div>
                <div>{report.objects.length} named objects seen in this world</div>
                <div>{report.applied.length} entries applied, {report.unresolved.length} unresolved</div>
                {report.reportedAt ? (
                  <div style={{ color: dim }}>reported {new Date(report.reportedAt).toLocaleString()}</div>
                ) : null}
                {report.unresolved.length ? (
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: '#ffb08a' }}>
                    {report.unresolved.map((u) => (
                      <li key={u.id}>{u.id} — {u.reason}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : (
              <p style={{ margin: 0, color: dim, fontSize: 13 }}>
                No report yet. Enter <b>{world}</b> in game while signed in as an administrator and the
                object list, floorplan and ground grid will fill in here.
              </p>
            )}
          </section>

          <section style={card}>
            <h2 style={{ margin: '0 0 10px', fontSize: 15 }}>Version history</h2>
            <p style={{ margin: '0 0 10px', color: dim, fontSize: 12 }}>
              Append-only. Reverting writes a new version holding the old entries; nothing is deleted,
              and every save is in the admin audit log.
            </p>
            <div style={{ display: 'grid', gap: 8 }} data-e2e="versions">
              {versions.map((v) => (
                <div
                  key={v.version}
                  data-e2e="version-row"
                  style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between', fontSize: 12 }}
                >
                  <span>
                    <b>v{v.version}</b> · {v.entryCount} entries · {v.author}
                    {v.note ? ` · ${v.note}` : ''}
                  </span>
                  <button
                    className="btn btn-ghost"
                    type="button"
                    disabled={busy || v.version === savedVersion}
                    onClick={() => void revert(v.version)}
                  >
                    Revert to this
                  </button>
                </div>
              ))}
              {versions.length === 0 ? (
                <p style={{ margin: 0, color: dim, fontSize: 13 }}>Nothing saved for this world yet.</p>
              ) : null}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```
cd site && npx tsc --noEmit -p .
```
Expected: no output, exit code 0. A likely first failure: `OverlayVersionRow`/`WorldReport` not exported from `@/lib/mapOverlay` — they are (`mapOverlay.ts:46-90`); if chunk 2 renamed them, import the names it exports. `import type` from `mapOverlay.ts` is erased by `isolatedModules`, so `pg` is not pulled into the client bundle — confirm in Step 3.

- [ ] **Step 3: Build**

```
cd site && npm run build:site-only
```
Expected: `✓ Compiled successfully`, the route table lists `ƒ /admin/map`, exit code 0. If the build complains that `pg` cannot resolve `fs`/`net` for a client chunk, a value import from `@/lib/mapOverlay` slipped in — every import from it must be `import type`.

- [ ] **Step 4: Manual verification** — run the site locally and walk chunk 7 checklist items 1–21 end to end (21 is the stale-layout `400` path, the only way that handler fires). At minimum before committing: `/admin/map` renders with the banner, a world with a report draws its floorplan, selecting via the dropdown highlights a mark, dragging it adds a pending row, Save is disabled until something changes.

- [ ] **Step 5: Commit**

```
git add site/components/MapEditorPanel.tsx
git commit -m "The map editor is map-first" -m "The per-entry forms are replaced by a top-down map, a selection panel and a pending list. The map is drawn from what the admin's own game reported — bounds, floorplan shapes and a physics-sampled ground grid — so nothing on the server has to know what a world builds. Save, revert, versions and the marketplace picker behave as before, with one addition: a save the server refuses for an error-level conflict comes back as outlined rows instead of a thrown message, because the route runs the same conflict check the editor does." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---


---

## Chunk 7: Site — editor end-to-end

**Executes after chunk 6** (the composed editor), and therefore after chunks 1–5. Chunk 1's game-side layout report is what makes the "enter the world as admin" checklist items real; without it the banner can only ever read `No layout yet …`.

**What this chunk builds.** A zero-dependency CDP harness (`site/scripts/map-editor-e2e.mjs`) that signs in through the real form, seeds a synthetic layout through the real report route, drives the real editor and asserts the pending row, the `underground` warning and the version increment; the manual verification checklist for localhost and production; and the gates that close stage 1's site work. Task numbering continues from chunk 6.

**Constraints:** no Playwright, no new dependencies — Node 22's global `WebSocket` and Chromium from `%LOCALAPPDATA%/ms-playwright` (or Chrome/Edge), the same pattern as `scripts/hud-viewport-probe.mjs`; `next` is launched through `process.execPath` + `site/node_modules/next/dist/bin/next` because Windows cannot spawn a `.cmd` without a shell; `.probe/` is gitignored, so screenshots are evidence to be cited in the final report, not committed. A run without credentials exits 2 and is **not** a pass.

---

### Task 7: `site/scripts/map-editor-e2e.mjs` — sign in, seed a layout, drive the editor, save

**Files:**
- Create: `site/scripts/map-editor-e2e.mjs` (zero dependencies; Node 22 `WebSocket` + CDP; Chromium from `%LOCALAPPDATA%/ms-playwright`, exactly as `scripts/hud-viewport-probe.mjs:139-220`)
- Output: `.probe/map-editor-e2e/{01-login,02-editor,03-clicked,04-selected,05-dragged,06-underground,07-saved}.png` + `report.json` (`.probe/` is gitignored)

**What it proves:** with real credentials, through the real `/login` form (`#email`, `#password`, optional `#code`, `form.auth-form button[type=submit]`; the page calls `signIn('credentials', { redirect: false })` then `router.push(callbackUrl)`), the real report route accepts a synthetic layout, the editor's banner reads `reported just now`, a CDP click on the seeded object's footprint selects it (spec §11: "click a footprint, assert the selection panel"), a click on empty ground deselects, the dropdown selects it again, a CDP mouse drag on the canvas adds a pending row, typing Y below the floor produces an `underground` warning, and Save increments the version. An admin with 2FA enabled passes the current code in `MAP_E2E_CODE` (a 30 s window — generate it just before the run). Without `MAP_E2E_EMAIL`/`MAP_E2E_PASSWORD` it prints `SKIPPED (no MAP_E2E_EMAIL/MAP_E2E_PASSWORD) — this is NOT a pass` and exits 2 — a gate that measured nothing must not read as green.

**It writes to the database `site/.env.local` points at** (a report row for the chosen world, and one overlay version). Run it against a development database. The seeded report replaces that world's real one until an admin next enters the world in game.

- [ ] **Step 1: Write the harness**

```js
// site/scripts/map-editor-e2e.mjs
/**
 * THE MAP EDITOR, END TO END.
 *
 *   node site/scripts/map-editor-e2e.mjs [--url http://127.0.0.1:3000] [--world station] [--keep] [--verbose]
 *   env: MAP_E2E_EMAIL, MAP_E2E_PASSWORD   (an address listed in ADMIN_EMAILS / MARKETPLACE_ADMIN_EMAILS)
 *        MAP_E2E_CODE                       (optional: the current authenticator code, for a 2FA-enabled admin)
 *
 * ── Why a browser ────────────────────────────────────────────────────────
 *
 * The site's vitest has no DOM. Every decision in the editor is a pure,
 * tested function, but "an admin can sign in, pick a crate, drag it, read
 * the warning and save" is a claim about a page, and only a page can prove
 * it. This drives real Chrome over the DevTools Protocol against a real
 * `next dev` on a fresh port, through the real sign-in form, the real report
 * route and the real editor. Nothing is mocked.
 *
 * ── A skip is not a pass ─────────────────────────────────────────────────
 *
 * Without credentials there is nothing to measure. The script says so on
 * stderr and exits 2, so a CI step that ran it with no secrets cannot be
 * read as green. (This repository has paid nine times for gates that passed
 * against nothing.)
 *
 * ── It writes to the configured database ─────────────────────────────────
 *
 * The report route stores the synthetic layout for `--world` and Save writes
 * an overlay version, both in whatever POSTGRES_URL the site's env points at.
 * Point it at a development database.
 *
 * ── Zero dependencies, on purpose ────────────────────────────────────────
 *
 * Same reasoning as scripts/hud-viewport-probe.mjs: Node 22 ships a global
 * WebSocket, which is all CDP needs, and a browser-automation library is a
 * second thing to rot. Chromium is Playwright's pinned build if present,
 * else Chrome/Edge.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer as createSocketServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.resolve(here, '..');
const root = path.resolve(site, '..');
const outDir = path.join(root, '.probe', 'map-editor-e2e');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const EMAIL = process.env.MAP_E2E_EMAIL;
const PASSWORD = process.env.MAP_E2E_PASSWORD;
if (!EMAIL || !PASSWORD) {
  console.error('SKIPPED (no MAP_E2E_EMAIL/MAP_E2E_PASSWORD) — this is NOT a pass');
  process.exit(2);
}
const CODE = process.env.MAP_E2E_CODE ?? '';

/* Set when a child process dies or refuses to start. Every `waitFor` then
 * throws at once instead of polling out its timeout, so the failure reaches
 * `finally` — which kills the other child and writes report.json — rather
 * than an unhandled 'error' event killing this process with next dev
 * orphaned on its port. */
let abortReason = null;
const childFailed = (what) => (e) => {
  if (!abortReason) abortReason = `${what}: ${e instanceof Error ? e.message : `exit code ${e}`}`;
};

const WORLD = arg('--world') ?? 'station';
/* Two named objects on a flat floor at y = 0. The crate sits 0.4 m up:
 * inside the ±0.25/+1.5 m band, so it starts with no ground warning. */
const CRATE = { name: 'e2e:crate', position: { x: 10, y: 0.4, z: -20 } };
const POST = { name: 'e2e:post', position: { x: -30, y: 0, z: 40 } };

/* ====================================================================== */
/* The synthetic layout                                                   */
/* ====================================================================== */

/** Int16 → base64, little-endian, the encoding `mapLayout.ts` decodes. */
function encodeHeightsCm(int16) {
  const buf = Buffer.alloc(int16.length * 2);
  for (let i = 0; i < int16.length; i++) buf.writeInt16LE(int16[i], i * 2);
  return buf.toString('base64');
}

function syntheticReport() {
  const nx = 51;
  const nz = 51;
  const heights = new Int16Array(nx * nz); // every sample 0 cm: a flat floor at y = 0
  return {
    world: WORLD,
    appliedVersion: 0,
    objects: [CRATE, POST],
    applied: [],
    unresolved: [],
    layoutSchema: 1,
    bounds: { min: { x: -100, y: -5, z: -100 }, max: { x: 100, y: 60, z: 100 } },
    shapes: [
      { kind: 'rect', x: 0, z: 0, w: 80, d: 60, fill: 0x2a4a66 },
      { kind: 'circle', x: 40, z: -40, r: 8, stroke: '#52e9ff', width: 0.5 },
    ],
    ground: { originX: -100, originZ: -100, step: 4, nx, nz, layers: 1, heightsCm: encodeHeightsCm(heights) },
  };
}

/* ====================================================================== */
/* Browser discovery (scripts/hud-viewport-probe.mjs)                     */
/* ====================================================================== */

function browserCandidates() {
  const home = os.homedir();
  const out = [];
  if (process.env.CHROME_PATH) out.push(process.env.CHROME_PATH);
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const ms = path.join(local, 'ms-playwright');
    if (existsSync(ms)) {
      for (const dir of ['chromium-1223', 'chromium-1217']) {
        out.push(path.join(ms, dir, 'chrome-win64', 'chrome.exe'));
      }
    }
    out.push(path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    out.push(path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    out.push(path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    out.push(path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    out.push(path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  } else if (process.platform === 'darwin') {
    out.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    out.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    out.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium');
    const ms = path.join(home, '.cache', 'ms-playwright');
    if (existsSync(ms)) {
      for (const dir of ['chromium-1223', 'chromium-1217']) {
        out.push(path.join(ms, dir, 'chrome-linux', 'chrome'));
      }
    }
  }
  return out.filter((p) => existsSync(p));
}

/* ====================================================================== */
/* A CDP client, in about forty lines                                     */
/* ====================================================================== */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error(`cannot reach ${url}`)), { once: true });
    });
    return new CDP(ws);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  close() { try { this.ws.close(); } catch { /* already gone */ } }
}

/* ====================================================================== */
/* Small helpers                                                          */
/* ====================================================================== */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = createSocketServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(fn, { timeout = 45000, every = 150, what = 'condition' } = {}) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    if (abortReason) throw new Error(abortReason);
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { last = e; }
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

/** Kill a process and everything it spawned (`next dev` forks its server). */
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  }
}

/* ====================================================================== */
/* The dev server                                                         */
/* ====================================================================== */

async function startNext() {
  const port = await freePort();
  /* The bin script through `process.execPath`, not `npx`/`next.cmd`: Node
   * refuses to spawn a `.cmd` without a shell on Windows, and a worktree's
   * junctioned node_modules resolves the same file. */
  const bin = path.join(site, 'node_modules', 'next', 'dist', 'bin', 'next');
  if (!existsSync(bin)) throw new Error(`no next binary at ${bin} — run npm install in site/`);
  const child = spawn(process.execPath, [bin, 'dev', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: site,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BROWSER: 'none' },
    detached: process.platform !== 'win32',
  });
  const log = [];
  const keep = (d) => { log.push(String(d)); if (flag('--verbose')) process.stdout.write(d); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  let ready = false;
  child.on('error', childFailed('next dev failed to start'));
  child.on('exit', (code) => { if (!ready) childFailed('next dev exited before it was listening')(code); });
  const url = `http://127.0.0.1:${port}`;
  await waitFor(async () => (await fetch(`${url}/login`)).ok, { timeout: 180000, every: 500, what: `next dev at ${url}` })
    .catch((e) => { throw new Error(`${e.message}\n--- next dev output ---\n${log.join('').slice(-4000)}`); });
  ready = true;
  return { url, child };
}

/* ====================================================================== */
/* Main                                                                   */
/* ====================================================================== */

async function main() {
  const chrome = browserCandidates()[0];
  if (!chrome) {
    console.error('NO BROWSER FOUND — this harness measured nothing. Set CHROME_PATH or install Chrome / Chromium.');
    return 1;
  }
  console.log(`browser: ${chrome}`);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const report = { base: arg('--url') ?? null, world: WORLD, steps: [], screenshots: [] };
  const pageLog = [];
  const userDir = path.join(os.tmpdir(), `an-map-e2e-${process.pid}`);
  let server = null;
  let browser = null;
  let client;
  const step = (name, detail) => { report.steps.push({ name, detail, at: new Date().toISOString() }); console.log(`  ${name}${detail ? ` — ${detail}` : ''}`); };

  /* Both children are started INSIDE the try: a Chrome that fails to launch
   * (a stale ms-playwright build, a locked --user-data-dir) must still reach
   * `finally`, which kills next dev and writes the report. */
  try {
    if (!report.base) {
      server = await startNext();
      report.base = server.url;
    }
    const base = report.base.replace(/\/$/, '');
    console.log(`site: ${base}`);

    const cdpPort = await freePort();
    browser = spawn(chrome, [
      '--headless=new',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${userDir}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu',
      '--hide-scrollbars', '--mute-audio', '--disable-extensions',
      '--force-device-scale-factor=1',
      '--window-size=1500,1100',
      'about:blank',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    browser.on('error', childFailed('chrome failed to launch'));
    browser.on('exit', (code) => { if (!client) childFailed('chrome exited before devtools came up')(code); });
    browser.stderr.on('data', () => { /* chrome is noisy on stderr */ });

    const version = await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
      return r.ok ? r.json() : null;
    }, { what: `chrome devtools on ${cdpPort}` });
    client = await CDP.connect(version.webSocketDebuggerUrl);
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
    const call = (m, p) => client.send(m, p, sessionId);
    await call('Page.enable');
    await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1100, deviceScaleFactor: 1, mobile: false });
    client.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Runtime.consoleAPICalled') {
        pageLog.push(`${msg.params.type}: ${(msg.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ')}`);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        pageLog.push(`exception: ${d.exception?.description ?? d.text}`);
      }
    });

    /* ---- page helpers ------------------------------------------------ */
    const evaluate = async (expression, awaitPromise = false) => {
      const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
      if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result?.value;
    };
    const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
    const waitForSelector = (sel, what) => waitFor(() => evaluate(`!!${q(sel)}`), { what: what ?? sel });
    const textOf = (sel) => evaluate(`${q(sel)}?.textContent ?? null`);
    const valueOf = (sel) => evaluate(`${q(sel)}?.value ?? null`);
    const rectOf = (sel) => evaluate(`(() => { const r = ${q(sel)}?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, w: r.width, h: r.height } : null; })()`);
    const mouse = (type, x, y, extra = {}) => call('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra });
    const clickSel = async (sel) => {
      await evaluate(`${q(sel)}?.scrollIntoView({ block: 'center' })`);
      const r = await rectOf(sel);
      assert(r, `no element for ${sel}`);
      await mouse('mouseMoved', r.x, r.y);
      await mouse('mousePressed', r.x, r.y);
      await mouse('mouseReleased', r.x, r.y);
    };
    /* Text through Chrome's input pipeline (`Input.insertText`), so React's
     * controlled inputs see a real edit, not a property write. */
    const typeInto = async (sel, text) => {
      await evaluate(`(() => { const el = ${q(sel)}; el.scrollIntoView({ block: 'center' }); el.focus(); el.select(); })()`);
      await call('Input.insertText', { text });
      const got = await valueOf(sel);
      assert(got === text, `typed ${JSON.stringify(text)} into ${sel} but it reads ${JSON.stringify(got)}`);
    };
    /* A <select> has no typed path: set through the native setter and fire
     * the change event React listens for. */
    const choose = async (sel, value) => {
      const got = await evaluate(`(() => { const el = ${q(sel)}; const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('change', { bubbles: true })); return el.value; })()`);
      assert(got === value, `could not choose ${value} in ${sel} (options: ${await evaluate(`[...${q(sel)}.options].map(o => o.value).join(', ')`)})`);
    };
    const shot = async (name) => {
      const s = await call('Page.captureScreenshot', { format: 'png' });
      const file = path.join(outDir, `${name}.png`);
      await writeFile(file, Buffer.from(s.data, 'base64'));
      report.screenshots.push(path.relative(root, file));
    };

    /* ---- 1. sign in through the real form ------------------------------ */
    await call('Page.navigate', { url: `${base}/login?callbackUrl=${encodeURIComponent('/admin/map')}` });
    await waitForSelector('#email', 'the sign-in form');
    await typeInto('#email', EMAIL);
    await typeInto('#password', PASSWORD);
    if (CODE) await typeInto('#code', CODE);
    await shot('01-login');
    await clickSel('form.auth-form button[type="submit"]');
    /* The locked render has no <h1> — only `.banner > b` — so wait for EITHER
     * the editor or the lock, and let the assert below name the real problem
     * (a signed-in non-admin) instead of a 90 s timeout. */
    await waitFor(async () => {
      const err = await textOf('.auth-error');
      if (err) { abortReason = `sign-in refused: ${err}`; return false; }
      return evaluate(`location.pathname === '/admin/map' && (!!document.querySelector('h1') || document.body.innerText.includes('Map editor locked'))`);
    }, { what: 'the editor (or the lock banner) after sign-in', timeout: 90000 });
    assert(!(await evaluate(`document.body.innerText.includes('Map editor locked')`)),
      `${EMAIL} signed in but is not an admin (ADMIN_EMAILS / MARKETPLACE_ADMIN_EMAILS)`);
    step('signed in', EMAIL);

    /* ---- 2. seed the layout through the real report route ------------- */
    const body = JSON.stringify(syntheticReport());
    const seeded = await evaluate(`fetch('/api/admin/map/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ${JSON.stringify(body)} }).then(async (r) => ({ status: r.status, text: await r.text() }))`, true);
    assert(seeded.status === 200, `report route answered ${seeded.status}: ${seeded.text}`);
    step('seeded layout', `${WORLD}, ${body.length} bytes`);

    /* `Page.reload` returns before the navigation; the OLD document keeps
     * answering selectors for a moment, so a world with a prior report would
     * show its stale age and `choose()` would fire on a page being torn down.
     * A new document has a new performance.timeOrigin: wait for that first. */
    const t0 = await evaluate('performance.timeOrigin');
    await call('Page.reload');
    await waitFor(async () => (await evaluate('performance.timeOrigin')) !== t0, { what: 'the reloaded document' });
    await waitForSelector('[data-e2e="world-select"]', 'the editor');
    if (WORLD !== 'station') await choose('[data-e2e="world-select"]', WORLD);
    await waitFor(async () => (await textOf('[data-e2e="layout-age"]'))?.startsWith('reported'), { what: 'the layout banner to read "reported …"' });
    const age = await textOf('[data-e2e="layout-age"]');
    assert(age === 'reported just now', `banner reads ${JSON.stringify(age)}`);
    assert((await textOf('[data-e2e="layout-banner"]')).includes('2 shapes'), 'banner counts the two seeded shapes');
    await waitFor(() => evaluate(`[...(${q('[data-e2e="object-select"]')}?.options ?? [])].some(o => o.value === 'o:e2e:crate')`), { what: 'the seeded object in the picker' });
    const saveLabel = await waitFor(async () => { const t = await textOf('[data-e2e="save"]'); return /Saved \(v\d+\)/.test(t ?? '') ? t : null; }, { what: 'the Save button to settle on "Saved (vN)"' });
    const versionBefore = Number(/Saved \(v(\d+)\)/.exec(saveLabel ?? '')?.[1] ?? NaN);
    assert(Number.isInteger(versionBefore), `save button reads ${JSON.stringify(saveLabel)}, expected "Saved (vN)"`);
    await shot('02-editor');
    step('editor loaded', `${age}; version ${versionBefore}`);

    /* ---- 3. click the footprint, deselect, then the dropdown ----------- */
    const canvas = await rectOf('[data-e2e="map-canvas"]');
    assert(canvas, 'the map canvas is on the page');
    let view = await evaluate('window.__mapView ?? null');
    if (!view) {
      /* Production strips __mapView. Reproduce createView(bounds, w, h, 24)
       * for an UNTOUCHED view: the bounds are ±100 in both axes. */
      const iw = canvas.w - 48, ih = canvas.h - 48;
      const scale = Math.min(iw / 200, ih / 200);
      view = { scale, ox: canvas.w / 2, oy: canvas.h / 2 };
      step('note', 'no window.__mapView (production build) — projecting with createView maths');
    }
    /* World (x, z) → page pixel, the canvas's own convention: sx = ox + x·scale, sy = oy + z·scale. */
    const at = (x, z) => ({ x: canvas.left + view.ox + x * view.scale, y: canvas.top + view.oy + z * view.scale });
    const click = async (p) => {
      await mouse('mouseMoved', p.x, p.y);
      await mouse('mousePressed', p.x, p.y);
      await mouse('mouseReleased', p.x, p.y);
    };
    const crate = at(CRATE.position.x, CRATE.position.z);
    await click(crate);
    await waitFor(async () => (await textOf('[data-e2e="sel-name"]'))?.includes('e2e:crate'), { what: 'a click on the footprint to select e2e:crate' });
    await shot('03-clicked');
    step('clicked', 'e2e:crate selected from the canvas');
    await click(at(-80, 80)); // inside the bounds, nothing there, no item armed → deselect
    await waitFor(async () => (await textOf('[data-e2e="sel-name"]'))?.includes('Nothing selected'), { what: 'a click on empty ground to deselect' });
    await choose('[data-e2e="object-select"]', 'o:e2e:crate');
    await waitFor(async () => (await textOf('[data-e2e="sel-name"]'))?.includes('e2e:crate'), { what: 'the selection panel to show e2e:crate' });
    assert((await valueOf('[data-e2e="sel-x"]')) === '10', 'X shows the reported 10');
    assert((await valueOf('[data-e2e="sel-z"]')) === '-20', 'Z shows the reported -20');
    await shot('04-selected');
    step('selected', 'e2e:crate via the dropdown');

    /* ---- 4. drag on the canvas ----------------------------------------- */
    const sx = crate.x;
    const sy = crate.y;
    await mouse('mouseMoved', sx, sy);
    await mouse('mousePressed', sx, sy);
    for (let i = 1; i <= 8; i++) await mouse('mouseMoved', sx + i * 8, sy + i * 4, { buttons: 1 });
    await mouse('mouseReleased', sx + 64, sy + 32);
    await waitFor(() => evaluate(`[...document.querySelectorAll('[data-e2e="pending-row"]')].some(li => li.textContent.includes('e2e:crate'))`), { what: 'a pending row for e2e:crate' });
    const rowText = await evaluate(`[...document.querySelectorAll('[data-e2e="pending-row"]')].find(li => li.textContent.includes('e2e:crate')).textContent`);
    assert(rowText.includes('→ ('), `row reads ${JSON.stringify(rowText)}`);
    const draggedX = Number(await valueOf('[data-e2e="sel-x"]'));
    const expectedX = CRATE.position.x + 64 / view.scale;
    assert(Math.abs(draggedX - expectedX) < 0.5, `drag moved X to ${draggedX}, expected ≈ ${expectedX.toFixed(2)}`);
    await shot('05-dragged');
    step('dragged', `row: ${rowText.trim()}`);

    /* ---- 5. type Y below the floor → underground ----------------------- */
    await typeInto('[data-e2e="sel-y"]', '-3');
    await clickSel('[data-e2e="move-here"]');
    await waitFor(() => evaluate(`(${q('[data-e2e="sel-conflicts"]')}?.textContent ?? '').includes('underground')`), { what: 'an underground warning in the selection panel' });
    const status = await evaluate(`[...document.querySelectorAll('[data-e2e="pending-row"]')].find(li => li.textContent.includes('e2e:crate')).querySelector('[data-e2e="pending-status"]').textContent`);
    assert(status.includes('underground'), `pending row status reads ${JSON.stringify(status)}`);
    /* Not a synchronous assert: Save reads `Checking…` (disabled) until the
     * deferred conflict pass catches up; a warning must leave it ENABLED once it has. */
    await waitFor(() => evaluate(`!${q('[data-e2e="save"]')}.disabled`), { what: 'Save to be enabled — a warning is not an error' });
    await shot('06-underground');
    step('underground warned', status.trim());

    /* ---- 6. fix Y, save, version increments ---------------------------- */
    await typeInto('[data-e2e="sel-y"]', '0.4');
    await clickSel('[data-e2e="move-here"]');
    await waitFor(() => evaluate(`!(${q('[data-e2e="sel-conflicts"]')}?.textContent ?? '').includes('underground')`), { what: 'the warning to clear' });
    await waitFor(() => evaluate(`!${q('[data-e2e="save"]')}.disabled`), { what: 'Save to be enabled after the conflict pass' });
    await clickSel('[data-e2e="save"]');
    await waitFor(async () => (await textOf('[data-e2e="message"]'))?.startsWith('Saved version'), { what: 'the save message', timeout: 60000 });
    const msg = await textOf('[data-e2e="message"]');
    const savedVersion = Number(/Saved version (\d+)/.exec(msg)[1]);
    assert(savedVersion === versionBefore + 1, `saved version ${savedVersion}, expected ${versionBefore + 1}`);
    await waitFor(async () => (await textOf('[data-e2e="save"]')) === `Saved (v${savedVersion})`, { what: 'the save button to show the new version' });
    assert(await evaluate(`[...document.querySelectorAll('[data-e2e="version-row"]')].some(r => r.textContent.includes('v${savedVersion}'))`), 'the version list shows the new version');
    await shot('07-saved');
    step('saved', msg);
  } catch (e) {
    report.failure = abortReason ?? e.message;
    report.pageConsole = pageLog;
    console.error(`\nFAILED: ${report.failure}\n--- page console ---\n${pageLog.join('\n') || '(silent)'}`);
  } finally {
    client?.close();
    browser?.kill();
    if (server) killTree(server.child);
    if (!flag('--keep')) await rm(userDir, { recursive: true, force: true }).catch(() => {});
    await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  }

  if (report.failure) {
    console.error(`screenshots + report: ${path.relative(root, outDir)}`);
    return 1;
  }
  console.log(`\nMAP EDITOR E2E OK — ${report.steps.length} steps, ${report.screenshots.length} screenshots in ${path.relative(root, outDir)}`);
  return 0;
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run it without credentials — it must refuse**

```
node site/scripts/map-editor-e2e.mjs
```
Expected stderr: `SKIPPED (no MAP_E2E_EMAIL/MAP_E2E_PASSWORD) — this is NOT a pass`; exit code 2 (`echo $LASTEXITCODE` in PowerShell → `2`).

- [ ] **Step 3: Run it with credentials**

PowerShell (an admin account on the development database `site/.env.local` points at):
```
$env:MAP_E2E_EMAIL='admin@example.com'; $env:MAP_E2E_PASSWORD='…'; node site/scripts/map-editor-e2e.mjs
```
Expected stdout (times vary):
```
browser: C:\Users\…\ms-playwright\chromium-1223\chrome-win64\chrome.exe
site: http://127.0.0.1:5xxxx
  signed in — admin@example.com
  seeded layout — station, 7xxx bytes
  editor loaded — reported just now; version N
  clicked — e2e:crate selected from the canvas
  selected — e2e:crate via the dropdown
  dragged — row: MOVEe2e:crate → (…) ✓undo
  underground warned — ⚠ underground
  saved — Saved version N+1. Reload the world in game to see it.

MAP EDITOR E2E OK — 8 steps, 7 screenshots in .probe\map-editor-e2e
```
(`MOVEe2e:crate → (…) ✓undo` is the row's real `textContent` — the `<li>`'s spans run together with no separators. It is not a typo to fix in the harness or the component.)

Exit code 0. Open the seven PNGs and look: `02-editor` shows the blue 80×60 rect and the cyan circle at the upper right (x=40, z=−40 is north-east — above and right of centre), `03-clicked` shows the white selection ring on the crate's dot with the panel naming it, `05-dragged` shows the dashed line and green ring, `06-underground` shows the amber `⚠ underground` in both the panel and the row.

If step 4 fails with `drag moved X to 10`, the pointer landed off the mark: the harness computes the pixel from `window.__mapView`, so check that the canvas has not been panned by the selection-centring effect (it only pans when the mark is within 20 px of an edge — the seeded crate is not) and that `--force-device-scale-factor=1` is still in the Chrome args.

- [ ] **Step 4: Commit**

```
git add site/scripts/map-editor-e2e.mjs
git commit -m "An end-to-end harness drives the map editor through the real sign-in" -m "The site's unit tests have no DOM, so the claim that an admin can sign in, pick an object, drag it, read the warning and save is proved here, against real Chrome over CDP, the real login form, the real report route and the real editor on a fresh next dev port. Without credentials it exits 2 and says the skip is not a pass, because a gate that measured nothing must not read as green." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---
### Task 8: Manual verification checklist and gates

**Files:** none created. This task is the evidence step for Tasks 3–7; record its results in the final report (paths of the seven screenshots, the `report.json` step list, the exact gate outputs).

- [ ] **Step 1: Local checklist** — `cd site && npm run dev`, sign in at `http://localhost:3000/login` as an `ADMIN_EMAILS` address, open `/admin/map`. Tick each line only when the exact thing described is on screen.

1. The page renders with the amber **Layout** banner at the top. For a world nobody has entered since chunk 1 shipped, it reads `No layout yet — enter this world in game as admin`. The canvas is a dark ±100 m square with `N ↑ (−Z)` top-left and a scale readout bottom-left.
2. Enter that world in the game (`/play`, then the gateway) signed in as the same admin. The console prints the chunk 1 line for the layout report (`map-overlay:layout` with `cells`, `layers`, `sampledMs`). Back on `/admin/map`, reload: the banner reads `reported just now`, then `reported 1 min ago` a minute later without a reload (the 30 s timer), and the trailing summary says `N shapes · nx×nz ground samples, K layer(s)`.
3. The floorplan is oriented like the in-game minimap with the player facing north: a landmark you know lies at −Z from spawn is drawn ABOVE spawn. The dashed cyan rectangle is the world's bounds. Ground cells shade lighter where higher (skipped, by design, when the banner's `nx×nz` exceeds 70 000 — note which case you are seeing).
4. Hover a cyan dot: a label appears beside the cursor with the object's name and `(x, y, z)`; it disappears when the pointer leaves.
5. Click a dot: it gains a white ring; the Selection panel shows its name in bold, X/Y/Z filled from the report, yaw empty, `Ground here: N m ✓ on surface`.
6. Press on the selected dot and drag: a green ring follows the pointer with a dashed line back to the cyan origin dot; a row appears under **Pending changes** as `MOVE <name> → (x, y, z)`; X and Z in the panel update live; Y tracks the ground (compare with `Ground here` — the difference stays equal to the prop's original lift). Under a sustained drag on a large document the row's `⚠`/`✓` and the Save button (`Checking…`) legitimately lag to the first pause — conflicts are computed from a deferred copy of the document — while the panel's `sel-ground-status` line stays live; do not log that lag as a defect.
7. Wheel over a corner of the floorplan: the corner under the cursor stays under the cursor while the map scales.
8. Drag on empty ground, or middle-drag, or hold Space and drag: the map pans. A plain click on empty ground with no item armed clears the selection.
9. Click a marketplace item on the right: the button turns cyan, the hint says `Placing <name> — click empty ground`, the cursor is a crosshair. Click empty ground: an amber diamond appears, selected, with a `PLACE <name> ×1` row; its Y equals the LOWEST surface at that spot (under the station dome: the deck, not the roof). `Cancel` disarms without placing.
10. The object dropdown is grouped (`<optgroup>`) by the token before `:`; picking an object that is off-screen recentres the map on it.
11. Type a name that is not in the report into the free-text field and press Enter: the panel shows it with `— not in the game's report`; **Move here** adds a `MOVE` row flagged `⚠ stale-name`.
12. Snap: with the checkbox on, change X by typing — Y changes to the new ground plus the same lift. Untick it, change X again — Y stays.
13. Layer picker: select a point under a two-layer cell (station: under the dome). `Layer at this X/Z` appears with `Top <roof> m` and `Layer 1 <deck> m`; choosing `Top` writes the roof height into Y. At a single-layer cell the picker is absent.
14. Type Y = −3 and **Move here**: the ground line shows `⚠ underground`, the conflict list says `⚠ underground — …`, the pending row's status says `⚠ underground`, and **Save new version** stays ENABLED (a warning is not an error).
15. Type X = 99999 and **Move here**: the row shows `⛔ out-of-bounds` and the save button reads `Fix errors to save`, disabled. Put X back: it re-enables.
16. **Reset** on a moved object removes its row and its green ring; the dot is back at the reported spot. **Remove entry** on a selected placement deletes the diamond and the row.
17. The pending row's numbers match the selection panel's, one decimal, and clicking a row's text selects that entry on the map.
18. `undo` on a row removes it and its mark. Server-side gate: in DevTools console run `fetch('/api/admin/map/<world>', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entries: [{ kind: 'move', id: 'x', target: { name: 'anything' }, position: { x: 99999, y: 0, z: 0 } }] }) }).then(r => r.json()).then(console.log)` → `{ error: 'conflicts', rejected: [{ index: 0, id: 'x', reason: 'out-of-bounds' }] }` and the version list does not grow.
19. With one clean move pending, add a note and **Save new version**: the message reads `Saved version N. Reload the world in game to see it.`; the version list gains `vN · 1 entries · <you> · <note>`; the button reads `Saved (vN)`. Re-enter the world in game: the object is at its new position; back in the editor after a reload, **What the game reports** says `Applied version N (current)`.
20. **Revert to this** on an older version: the confirm text is unchanged; a new version is written; the map redraws from the reverted entries (the moved object's green ring is gone).
21. Stale-layout rejection — the only way the panel's `400 { error: 'conflicts' }` path fires, because the client blocks the same errors against the layout it holds. With the editor open on a world that HAS a layout, and without reloading the page, re-POST that world's report with tighter bounds from the DevTools console: `const cur = await (await fetch('/api/admin/map/<world>')).json(); await fetch('/api/admin/map/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ world: '<world>', appliedVersion: cur.report.appliedVersion, objects: cur.report.objects, applied: [], unresolved: [], layoutSchema: 1, bounds: { min: { x: -5, y: -5, z: -5 }, max: { x: 5, y: 60, z: 5 } }, shapes: cur.layout.shapes }) }).then(r => r.status)` → `200` (the server keeps the stored ground: no `ground` was sent). Now drag the object that ALREADY carries the pending move from item 6 to x ≈ 50 (use that one so the count below reads exactly 1; any other pending move outside ±5 m adds to it): the row still shows `✓` (the page's layout is the old one) and Save is enabled. Click **Save new version**: the message reads `Not saved: the server found 1 error (out-of-bounds) against a newer layout — layout refreshed, fix the outlined rows.`; the row is outlined red with `· rejected by save`; the banner flips to `reported just now` with the new bounds; the same row now shows `⛔ out-of-bounds`; the save button reads `Fix errors to save`, disabled; the version list has NOT grown. The canvas has re-fitted to the new ±5 m bounds, so that object is now off-canvas: re-pick it in the dropdown (which recentres the map) and drag it back inside ±5 m, or type X = 0 and click **Move here**: the outline clears, Save re-enables. Restore the real layout afterwards by re-entering the world in game as admin.

- [ ] **Step 2: Production checklist** — after the deploy that carries chunks 1–7 (a `Bundle:` commit for chunk 1's game change precedes it; this chunk is site-only and needs none).

P1. `https://<production host>/admin/map` as an admin: the banner shows the age from the production database (`No layout yet …` for every world until P2).
P2. Enter one world in the production game as admin; return to the editor and reload: `reported just now`, shapes and ground counts present, floorplan drawn.
P3. In a quiet world, select one object, drag it a few metres, save. Re-enter the world in game and see it moved. Then **Revert to this** on the previous version and confirm the object is back on the next world load.
P4. Signed out: `/admin/map` shows the `Map editor locked` banner. Anonymous: `curl -s -o NUL -w "%{http_code}" https://<production host>/api/admin/map/station` prints `403`.

- [ ] **Step 3: Gates** — run the FULL commands, read the exit codes, then claim.

```
cd site && npm test
```
Expected: every file passes; the count now includes `lib/mapProjection.test.ts (18 tests)` and `lib/mapEditorState.test.ts (21 tests)` alongside chunk 2's and 3's; exit 0.

```
cd site && npx tsc --noEmit -p .
```
Expected: no output, exit 0.

```
cd site && npm run build:site-only
```
Expected: `✓ Compiled successfully`, `ƒ /admin/map` in the route table, exit 0.

```
$env:MAP_E2E_EMAIL='<admin>'; $env:MAP_E2E_PASSWORD='<password>'; node site/scripts/map-editor-e2e.mjs
```
Expected: `MAP EDITOR E2E OK — 8 steps, 7 screenshots in .probe\map-editor-e2e`, exit 0. A run without credentials exits 2 and **does not satisfy this gate**. Record `.probe/map-editor-e2e/report.json`'s `steps` and the seven screenshot paths in the final report (the directory is gitignored, so the report is the only place they survive).

- [ ] **Step 4: Confirm the worktree is clean and the chunk's commits are in place**

```
git status --short
git log --format=%s -8
```
Expected: `git status` prints nothing; the log shows, newest first:
```
An end-to-end harness drives the map editor through the real sign-in
The map editor is map-first
The map editor lists every pending change with its warnings
The map editor's selection panel edits one chosen object
The map editor has a canvas that draws a world's layout and takes clicks
The map editor's snapping and pending-row decisions live in a pure module
The map editor can project a world onto a canvas
Saving the map refuses a document with an out-of-bounds move
```
Do not push, do not merge.

## Execution record (as built, 2026-08-27)

Executed with superpowers:subagent-driven-development — fresh implementer per task, spec review, then quality review, fixes folded into the next task's prior commit. Task-level "as executed" blocks and the full tracker live in `.probe/map-editor-stage1/` (gitignored). The tree is the source of truth; this section lists where it departs from the task text above.

**Chunk 1 (game, `map-editor-game`).** `h >= y → break` in the peel lost the floor at an exact 1 cm gap (6.5 % of station's columns) → skip-and-re-cast with `MAX_SKIPS 4`; PEEL stays 0.01; resolution documented as ~2 cm. `planGrid` keeps `floor(w/step)+1` (up to `step − ε` of the far edge reads `no-ground`; `ceil` is a stage-2 one-liner). MapOverlay: `now` passed wrapped; a throwing `cast` abandons the job and logs once; `_reportBack` warns on `!res.ok` and on a body whose `layout` is not `stored`; `job.report` snapshots the world. Perf: cold `--entry station` boot over-budget frames 12 (control) → 11 (sampler on); `layout` row `{ over 0 }`; frame-gaps `--layout-sample` reports `summary.layoutSampled` honestly (at least one run, right world, sampler finished). Gates: `npm test` 3494, contract-check 130/130, build. Known pre-existing defect left alone: the old `_onWorldChanged` continuation can apply to the previous world after a rapid portal (only sampling is world-guarded).

**Chunk 2 (site).** `Math.round(y*100)` in `groundAt`; `validateGround` rejects negative/fractional/oversized headers before decoding; jsonb `||` merge with a three-way schema CASE; the route refuses 403 → 413 (declared, then measured) → 400 → 404 before touching the DB; an invalid layout keeps the prior and reports `layout: 'kept-prior'` with warnings.

**Chunk 3 (site).** Hidden objects occupy (reversed a Task-1 review). Last move wins (corrected an earlier note). Integer-mm compares replaced float tolerances (the panel and server disagreed at −0.17 on 0.08 m ground). The occupant loop terminates on `Number.isSafeInteger(mm(x))`, not finiteness (`mm(1e20)` is finite and `cx++` stops past 2^53). Bucket grid measured 1.4 ms vs 5.8 ms pairwise.

**Chunks 4–6 (site).** Pixel marks hit-test with `r: 0` (the plan's `r: 0.5` scaled with zoom); `fit()` guarded so a redraw never resets the backing store; `pointercancel` cannot place; focus ring kept by styling property-by-property; `authoredLift`; `canonicalSelection` on a superseded row selects the object; `groundStatus`/`groundVerdict` shared by panel and route; `placementY` pure. Composed panel: `load(which, { keepMessage })` (the old panel's success message was erased in the same React batch), `loadSeq` against stale responses, full document reset on a failed load, Escape cancels place, canvas inert while busy, status paragraph always mounted, Hide checkbox disabled on a hide-only entry.

**Chunk 7 (site).** The harness is the task text plus: `Page.navigate` `errorText` fails fast; secrets compared by length only; ws close/error rejects every pending call (a dead Chrome aborts in ~7 s, next dev killed); a refused save short-circuits with the page's message; SIGINT → shared cleanup promise → exit 130 with `report.json`; loopback-only seeding unless `--allow-shared-db`; 2FA needs `--url`. Prerequisites: `POSTGRES_URL`, `HMAC_SECRET`, `ADMIN_EMAILS`. The credentialed run is the owner's.

**Whole-branch review.** Contract verified identical on both sides; both branches sit on main's tip and `git merge-tree` is clean in every order; deploy order is safe either way. A contract-pin test (`site/lib/mapLayoutContract.test.ts`) asserts `LAYOUT_SCHEMA` and the layer cap agree across `src/` and `site/lib` — it skips with a message until both branches share a tree, then goes live.

**Out of scope, recorded for stage 2:** trimesh undersides as layers; deck-edge bilinear Y (a crate dragged across a 4 m edge cell reads ~1.3 m mid-air and `floating` cannot fire); `planGrid` ceil; a shared `scripts/harness/cdp.mjs` for the two CDP harnesses; the `_onWorldChanged` continuation guard; `built_version` (spec §7) deferred; the CI `--layout-sample` decision.

Final commits: game `4184de1` (code `0b1a8fa`); site `a1ae62e`.
