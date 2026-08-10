# AETHER NEXUS Landing Redesign — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the AETHER NEXUS marketing landing page as a scroll-scrubbed "Gateway Descent" through all **6** worlds rendered as live WebGL cinematic dioramas, correcting every stale count/name along the way.

**Architecture:** A single canonical world model (`lib/worlds.ts`) drives all counts, copy, and metadata so numbers can never drift again. Lore is resolved server-side (shared SQL query + baked fallback). The visual layer is one shared Three.js renderer behind the page; six self-contained scene modules render one-at-a-time, driven by a GSAP ScrollTrigger orchestrator. Reduced-motion / no-WebGL degrade to the existing static `painters.ts` art. Work is split into three chunks: **Chunk 1** (data + corrections) is independently shippable; **Chunks 2–3** add the diorama engine and the six scenes.

**Tech Stack:** Next.js 16 App Router (RSC), React 19, TypeScript 5.7, Three.js (`three`), GSAP + ScrollTrigger, Vitest (unit), `@vercel/postgres` (existing lore backend).

**Spec:** `docs/superpowers/specs/2026-08-09-aether-nexus-landing-redesign-design.md`

**Working directory:** all paths are relative to the repo root of the `landing-redesign` worktree (`E:/markc/gametestai/gametestai-landing-redesign`). Site code lives under `site/`.

**Skills to consult during execution:**
- @superpowers:test-driven-development — for every unit-testable task
- @vercel-plugin:nextjs — RSC vs client boundaries, dynamic rendering, `next/dynamic` (verify current APIs before writing component code)
- @vercel-plugin:react-best-practices — after editing TSX components
- @immersive-3d-web and/or @game-creator:threejs-game — diorama scene construction, disposal, perf
- Verify `three` and `gsap`/ScrollTrigger current APIs against their docs before Chunk 2 code.

---

## File Structure

**New (site/):**
| File | Responsibility |
|---|---|
| `site/lib/worlds.ts` | Canonical 6-world source of truth (`WORLDS`, `WorldDef`, `WorldId`), roster counts (`MOUNTS=6`, `WEAPONS=4`), and pure copy-derivation helpers (`heroTicker`, `statBar`, `worldSeq`). |
| `site/lib/worlds.test.ts` | Vitest unit tests for the SoT + derivation helpers. |
| `site/lib/lore.ts` | `ResolvedLore` type, shared `getLoreEntries()` SQL query, `FALLBACK_LORE`, `getLore()` merge (DI-testable). |
| `site/lib/lore.test.ts` | Vitest unit tests for merge/fallback/scope-mapping (no DB — injected query). |
| `site/components/diorama/types.ts` | `DioramaScene`, `SceneCtx`, `QualityTier` interfaces. |
| `site/components/diorama/DioramaCanvas.tsx` | Single shared renderer + rAF loop + scene registry + visibility/quality gating + disposal. Client. |
| `site/components/diorama/scenes/station.ts` … `verdantCoil.ts` (6) | One `DioramaScene` per world. |
| `site/components/diorama/quality.ts` | Device-heuristic → `QualityTier` + DPR cap (pure, small). |
| `site/hooks/useGatewayScroll.ts` | GSAP ScrollTrigger → `{ activeIndex, progress }`. Client. |
| `site/components/GatewayDescent.tsx` | Composes canvas + panels + scroll hook; owns reduced-motion / no-WebGL fallback. Client. |
| `site/components/WorldPanel.tsx` | Per-world DOM content (name, `0N / 06`, lore, fact chip, anchors). |
| `site/vitest.config.ts` | Vitest config (jsdom not required for these pure tests; node env). |

**Modified:**
| File | Change |
|---|---|
| `site/package.json` | Add deps `three`, `gsap`; dev deps `@types/three`, `vitest`; script `test`. |
| `site/app/page.tsx` | Derive counts/ticker/stats/CTA from `worlds.ts`; replace `HomeWorldShowcase` usage with `GatewayDescent`; pass `worlds`+`lore`. Preserve all auth/access/pricing logic verbatim. |
| `site/app/layout.tsx` | Metadata/OG/title: five→six. |
| `site/app/api/lore/route.ts` | Call shared `getLoreEntries()`; add `WHEN 'maze' THEN 6`. |
| `src/content/Lore.js` | "six worlds / five outbound portals"; add `maze` entry; add `maze` to `LORE_ORDER`. |
| `package.json` (root) | "three open worlds" → "six worlds". |
| `site/app/globals.css` | Additive styles for descent/panels/canvas (no token changes). |

`site/components/HomeWorldShowcase.tsx`, `WorldCanvas.tsx`, `lib/painters.ts` are retained — `painters.ts`/`WorldCanvas.tsx` are reused as the static fallback.

---

## Chunk 1: Foundation & Corrections

*Independently shippable: after this chunk the site tells the truth (6 worlds, 6 mounts, 4 weapons, correct names, correct metadata) even though the diorama engine is not built yet — `page.tsx` still renders the existing `HomeWorldShowcase` until Chunk 2 swaps it.*

### Task 1: Add dependencies & test runner

**Files:**
- Modify: `site/package.json`
- Create: `site/vitest.config.ts`

- [ ] **Step 1: Add dependencies**

Run (in `site/`):
```bash
cd site
npm install three gsap
npm install -D @types/three vitest
```
Expected: `three`, `gsap` in `dependencies`; `@types/three`, `vitest` in `devDependencies`. Confirm ScrollTrigger ships inside `gsap` (`gsap/ScrollTrigger`) — no separate package.

- [ ] **Step 2: Add test script**

In `site/package.json` `scripts`, add:
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 3: Create `site/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: Verify runner works**

Run: `cd site && npx vitest run`
Expected: exits 0 with "No test files found" (or runs 0 tests) — confirms vitest is installed and configured.

- [ ] **Step 5: Commit**

```bash
git add site/package.json site/package-lock.json site/vitest.config.ts
git commit -m "build(site): add three, gsap, and vitest"
```

---

### Task 2: Canonical world model + derivation helpers (TDD)

Use @superpowers:test-driven-development.

**Files:**
- Create: `site/lib/worlds.ts`, `site/lib/worlds.test.ts`

- [ ] **Step 1: Write failing tests** — `site/lib/worlds.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { WORLDS, MOUNTS, WEAPONS, heroTicker, statBar, worldSeq } from './worlds';

describe('canonical world model', () => {
  it('has exactly 6 worlds in order with unique ids and 1-based index', () => {
    expect(WORLDS).toHaveLength(6);
    expect(WORLDS.map(w => w.id)).toEqual(['station','medieval','sports','citadel','race','maze']);
    WORLDS.forEach((w, i) => expect(w.index).toBe(i + 1));
    expect(new Set(WORLDS.map(w => w.id)).size).toBe(6);
  });
  it('uses canonical in-game display names', () => {
    const byId = Object.fromEntries(WORLDS.map(w => [w.id, w.name]));
    expect(byId.medieval).toBe('Aldermoor Vale');
    expect(byId.race).toBe('Vellum Ridge');
    expect(byId.maze).toBe('The Verdant Coil');
    expect(byId.station).toBe('Aether Nexus Station');
  });
  it('every world has copy, fact, accent and a scene id equal to its id', () => {
    for (const w of WORLDS) {
      expect(w.copy.length).toBeGreaterThan(10);
      expect(w.fact.length).toBeGreaterThan(3);
      expect(w.accent).toMatch(/^#[0-9a-f]{6}$/i);
      expect(w.scene).toBe(w.id);
    }
  });
  it('roster counts are correct', () => {
    expect(MOUNTS).toBe(6);
    expect(WEAPONS).toBe(4);
  });
  it('derivation helpers reflect six and never say five', () => {
    const ticker = heroTicker();
    expect(ticker).toContain('Six worlds');
    expect(ticker).toContain('Six mounts');
    expect(ticker).toContain('Four weapons');
    expect(ticker.join(' ')).not.toMatch(/five/i);

    expect(statBar()).toEqual(['6', '6', '4', '0 GB']);
    expect(worldSeq(1)).toBe('01 / 06');
    expect(worldSeq(6)).toBe('06 / 06');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd site && npx vitest run lib/worlds.test.ts`
Expected: FAIL — cannot resolve `./worlds`.

- [ ] **Step 3: Implement `site/lib/worlds.ts`**

```ts
export type WorldId = 'station' | 'medieval' | 'sports' | 'citadel' | 'race' | 'maze';
export type WorldSceneId = WorldId;

export interface WorldDef {
  id: WorldId;
  index: number;        // 1-based
  name: string;         // canonical in-game display name
  role: string;
  kicker: string;
  copy: string;         // marketing line (from game lore)
  fact: string;         // the chip — marketing SoT, NOT prose lore
  accent: string;       // #rrggbb, mirrors station portal colors
  loreScope: string;    // key into /api/lore entries
  scene: WorldSceneId;
}

// Names = each world's in-game `static displayName`. Copy paraphrases src/content/Lore.js
// DEFAULT_LORE (maze from src/worlds/MazeWorld.js). Accents mirror StationWorld.js portals.
export const WORLDS: readonly WorldDef[] = [
  { id: 'station',  index: 1, name: 'Aether Nexus Station', role: 'Hub world',       kicker: 'Orbital',
    copy: 'A working habitat hanging before a planet — plaza, market, hydroponics and hangar bays. The archive, the checkpoint.',
    fact: 'The gateway to all six worlds', accent: '#52e9ff', loreScope: 'station', scene: 'station' },
  { id: 'medieval', index: 2, name: 'Aldermoor Vale',       role: 'Exploration world', kicker: 'Open country',
    copy: 'An old-world valley of timber roofs, market squares and castle walls. The water is swimmable and has real depth.',
    fact: 'Walled town · castle · swimmable lakes', accent: '#ffb347', loreScope: 'medieval', scene: 'medieval' },
  { id: 'sports',   index: 3, name: 'Meridian Athletic Grounds', role: 'Skill world', kicker: 'Floodlit',
    copy: 'A bright training complex of courts, tracks, bowls and snow runs under lights — with a seated crowd watching.',
    fact: 'Pool · courts · skatepark · ski piste', accent: '#2ffb9a', loreScope: 'sports', scene: 'sports' },
  { id: 'citadel',  index: 4, name: 'Sunspire Citadel',     role: 'Vertical world',    kicker: 'Desert mesa',
    copy: 'A cliff-top town built to be climbed: souk rooftops, rope bridges, minarets and a 46 m great tower.',
    fact: '46 m climbable great tower', accent: '#ffc46b', loreScope: 'citadel', scene: 'citadel' },
  { id: 'race',     index: 5, name: 'Vellum Ridge',         role: 'Competition world', kicker: 'Racing',
    copy: 'A 1,599 m lap over rough terrain and through city streets with a real F1 start procedure — three circuits in all.',
    fact: '3 circuits · real F1 start', accent: '#ff5a3c', loreScope: 'race', scene: 'race' },
  { id: 'maze',     index: 6, name: 'The Verdant Coil',     role: 'Volatile world',    kicker: 'Hedge maze',
    copy: 'A hedge maze that re-rolls its layout on every single entry. The maze that cannot be learned — that is the entire point.',
    fact: 'Re-generates its layout every visit', accent: '#8fd67a', loreScope: 'maze', scene: 'maze' },
] as const;

// Roster counts verified against src/mounts/MountManager.js (6) and src/player/Loadout.js (4).
export const MOUNTS = 6;
export const WEAPONS = 4;

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Hero ticker chips — derived so counts can never be hardcoded out of sync. */
export function heroTicker(): string[] {
  return [`${cap(WORLDS.length)} worlds`, `${cap(MOUNTS)} mounts`, `${cap(WEAPONS)} weapons`,
    'Zero downloads', '100% generated', 'Runs in a tab', 'No install'];
}
/** Stat bar values in [worlds, mounts, weapons, install] order. */
export function statBar(): string[] {
  return [String(WORLDS.length), String(MOUNTS), String(WEAPONS), '0 GB'];
}
export function worldSeq(index: number): string {
  return `${pad2(index)} / ${pad2(WORLDS.length)}`;
}

const WORDS = ['Zero','One','Two','Three','Four','Five','Six','Seven','Eight','Nine'];
function cap(n: number): string { return WORDS[n] ?? String(n); }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd site && npx vitest run lib/worlds.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add site/lib/worlds.ts site/lib/worlds.test.ts
git commit -m "feat(site): canonical 6-world model + derivation helpers"
```

---

### Task 3: Lore resolution — shared query, fallback, merge (TDD)

Use @superpowers:test-driven-development. `getLore()` takes an injectable fetcher so tests need no DB.

**Files:**
- Create: `site/lib/lore.ts`, `site/lib/lore.test.ts`
- Modify: `site/app/api/lore/route.ts`

- [ ] **Step 1: Write failing tests** — `site/lib/lore.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { getLore, FALLBACK_LORE, type LoreEntryRow } from './lore';

const rows = (r: Partial<LoreEntryRow>[]): LoreEntryRow[] =>
  r.map(x => ({ scope: 'station', title: 't', sign_label: 'Lorekeeper', body: 'b', ...x })) as LoreEntryRow[];

describe('getLore', () => {
  it('returns all 6 worlds even when the DB is empty', async () => {
    const lore = await getLore(async () => []);
    expect(Object.keys(lore).sort()).toEqual(['citadel','maze','medieval','race','sports','station']);
    // maze has no DB row ever → must come from fallback
    expect(lore.maze.body).toBe(FALLBACK_LORE.maze.body);
  });
  it('prefers DB entries over fallback, mapping scope→world', async () => {
    const lore = await getLore(async () => rows([{ scope: 'medieval', title: 'DB Vale', body: 'db body', sign_label: 'Reeve' }]));
    expect(lore.medieval.title).toBe('DB Vale');
    expect(lore.medieval.sign_label).toBe('Reeve');
    // untouched worlds still resolve from fallback
    expect(lore.citadel.body).toBe(FALLBACK_LORE.citadel.body);
  });
  it('falls back entirely when the fetcher throws (503/no Postgres)', async () => {
    const lore = await getLore(async () => { throw new Error('no db'); });
    for (const id of Object.keys(FALLBACK_LORE)) {
      expect(lore[id as keyof typeof FALLBACK_LORE].body).toBe(FALLBACK_LORE[id as keyof typeof FALLBACK_LORE].body);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd site && npx vitest run lib/lore.test.ts`
Expected: FAIL — cannot resolve `./lore`.

- [ ] **Step 3: Implement `site/lib/lore.ts`**

```ts
import { sql } from '@vercel/postgres';
import { WORLDS, type WorldId } from './worlds';

export interface ResolvedLore { title: string; body: string; sign_label: string; }
export interface LoreEntryRow { scope: string; title: string; sign_label: string; body: string; }

export type LoreFetcher = () => Promise<LoreEntryRow[]>;

/** Shared query used by BOTH the API route and server-side getLore — no HTTP self-fetch. */
export const getLoreEntries: LoreFetcher = async () => {
  await sql`
    CREATE TABLE IF NOT EXISTS lore_entries (
      scope TEXT PRIMARY KEY, title TEXT NOT NULL,
      sign_label TEXT NOT NULL DEFAULT 'Lorekeeper', body TEXT NOT NULL,
      updated_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  const { rows } = await sql`
    SELECT scope, title, sign_label, body FROM lore_entries
    ORDER BY CASE scope
      WHEN 'overall' THEN 0 WHEN 'station' THEN 1 WHEN 'medieval' THEN 2
      WHEN 'sports' THEN 3 WHEN 'citadel' THEN 4 WHEN 'race' THEN 5
      WHEN 'maze' THEN 6 ELSE 99 END, scope`;
  return rows as LoreEntryRow[];
};

// Prose fallback for ALL six worlds (maze has no DB row). Sourced from src/content/Lore.js
// DEFAULT_LORE and src/worlds/MazeWorld.js. Keep in sync with the in-game canon.
export const FALLBACK_LORE: Record<WorldId, ResolvedLore> = {
  station: { title: 'Aether Nexus Station', sign_label: 'Dockmaster',
    body: 'Orbital hub of the Nexus: a ring of concourses, plazas, gantries and glass. The archive. The checkpoint. Every gateway begins here.' },
  medieval: { title: 'Aldermoor Vale', sign_label: 'Reeve',
    body: 'An old-world valley of timber roofs, market squares, castle walls and pilgrim roads. The lakes are swimmable and have real depth.' },
  sports: { title: 'Meridian Athletic Grounds', sign_label: 'Groundskeeper',
    body: 'A bright training complex of courts, tracks, bowls, snow runs and grandstands — under lights, with a seated crowd.' },
  citadel: { title: 'Sunspire Citadel', sign_label: 'Gate Warden',
    body: 'A vertical town crowning a cliff above the desert: terraces, rope bridges, towers and guarded gates, up to a 46 m great tower.' },
  race: { title: 'Vellum Ridge', sign_label: 'Race Marshal',
    body: 'Three circuits over rough terrain and city streets — Vellum Ridge, Cinder Gorge and Aurora Rise — each run on a real F1 start.' },
  maze: { title: 'The Verdant Coil', sign_label: 'Keeper of the Verdant Coil',
    body: 'A hedge maze that re-rolls its layout on every entry. Its districts and levels never repeat. The maze that cannot be learned is the entire point.' },
};

/** Resolve prose lore for all six worlds: DB entry wins, else fallback; total failure → all fallback. */
export async function getLore(fetcher: LoreFetcher = getLoreEntries): Promise<Record<WorldId, ResolvedLore>> {
  let byScope = new Map<string, LoreEntryRow>();
  try {
    for (const row of await fetcher()) byScope.set(row.scope, row);
  } catch (e) {
    console.error('[lore] fetch failed, using fallback:', e);
  }
  const out = {} as Record<WorldId, ResolvedLore>;
  for (const w of WORLDS) {
    const db = byScope.get(w.loreScope);
    out[w.id] = db
      ? { title: db.title, body: db.body, sign_label: db.sign_label }
      : FALLBACK_LORE[w.id];
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd site && npx vitest run lib/lore.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Refactor the API route to use the shared query**

Modify `site/app/api/lore/route.ts` to keep its exact JSON contract but source rows from `getLoreEntries()`:

```ts
import { NextResponse } from 'next/server';
import { getLoreEntries } from '@/lib/lore';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const rows = await getLoreEntries();
    const entries = Object.fromEntries(rows.map(r => [r.scope, {
      scope: r.scope, title: r.title, sign_label: r.sign_label, body: r.body,
    }]));
    return NextResponse.json({ entries });
  } catch (error) {
    console.error('[lore] failed to load lore entries:', error);
    return NextResponse.json({ error: 'Lore data unavailable.' }, { status: 503 });
  }
}
```

- [ ] **Step 6: Verify build/type-check and route unchanged**

Run: `cd site && npx tsc --noEmit && npx vitest run lib/`
Expected: no type errors; all lib tests pass. (The route now shares the maze-aware ordering.)

- [ ] **Step 7: Commit**

```bash
git add site/lib/lore.ts site/lib/lore.test.ts site/app/api/lore/route.ts
git commit -m "feat(site): lore resolver with shared query, maze ordering, baked fallback"
```

---

### Task 4: Drive the current page + metadata from the SoT (corrections)

**Files:**
- Modify: `site/app/page.tsx`, `site/app/layout.tsx`

- [ ] **Step 1: Metadata** — in `site/app/layout.tsx`, change the title "…five worlds, one gateway" → "…six worlds, one gateway" and the OG description "Five worlds. One gateway…" → "Six worlds. One gateway…". Grep first to catch every occurrence:

Run: `cd site && grep -rni "five worlds\|five mounts\|five \| five" app/layout.tsx`

- [ ] **Step 2: Replace hardcoded counts in `page.tsx`** — import from the SoT and derive:

```tsx
import { WORLDS, MOUNTS, heroTicker, statBar } from '@/lib/worlds';
```
Then:
- Hero ticker: replace both hardcoded `['Five worlds', …]` arrays with `heroTicker()`.
- `feat-stats-bar`: replace `(['5','5','4','0 GB'] as string[])` with `statBar()`.
- FEATURES "Five mounts": rename to "Six mounts" and update copy to include the bicycle: "Hoverboard, dragon, ground car, horse, eagle and bicycle…".
- CTA band `<h2>`: "One charge.<br />Five worlds." → "One charge.<br />Six worlds.".
- Leave `HomeWorldShowcase worlds={WORLDS}` wiring for now (Chunk 2 swaps the component); but note the existing `WORLDS` local array in `page.tsx` is now replaced by the import — delete the local `const WORLDS = [...]` (5 entries) and the local `FEATURES` stays. Ensure `HomeWorldShowcase`'s expected props still match (it reads `scene`,`seed`,`name`,`copy`…). If `HomeWorldShowcase`/`WorldCanvas` require a `seed`/`scene` field the new `WorldDef` lacks, add a thin adapter inline: map `WORLDS` → the shape `HomeWorldShowcase` needs, using `w.scene` and a stable seed (e.g. `0x2100 + w.index`). This adapter is temporary and removed in Task 13.

- [ ] **Step 3: Preserve behavior** — do NOT touch the auth/access/pricing/`Link` logic, the Stripe test-mode banner, nav, `AccountDashboard`, or footer. This task only changes numbers and copy.

- [ ] **Step 4: Type-check + dev smoke**

Run: `cd site && npx tsc --noEmit`
Then: `cd site && npm run dev`, open the site, confirm hero ticker says "Six worlds/Six mounts", stat bar reads 6·6·4·0 GB, CTA says "Six worlds". Stop dev server.

- [ ] **Step 5: Commit**

```bash
git add site/app/page.tsx site/app/layout.tsx
git commit -m "fix(site): drive counts/metadata from canonical world model (five→six)"
```

---

### Task 5: Correct stale in-game text

**Files:**
- Modify: `src/content/Lore.js`, `package.json` (root)

- [ ] **Step 1: `src/content/Lore.js`** — read the file first. Fix line ~70 "the Nexus has five worlds … four outbound portals" → "six worlds … five outbound portals". Add a `maze` entry to `DEFAULT_LORE` (title "The Verdant Coil", body matching `FALLBACK_LORE.maze.body`) and add `'maze'` to `LORE_ORDER`. Match the file's existing object shape exactly.

- [ ] **Step 2: root `package.json`** — description "…spanning three open worlds" → "…spanning six worlds".

- [ ] **Step 3: Verify the game still parses** — run the game's existing lore/content checks if any (e.g. `npm run test` at root or the relevant `scripts/tests/*` for content). At minimum: `node -e "import('./src/content/Lore.js').then(()=>console.log('ok'))"` if it's ESM-importable, else lint.

- [ ] **Step 4: Commit**

```bash
git add src/content/Lore.js package.json
git commit -m "fix(game): correct world/portal counts and add maze lore"
```

---

### Task 6: Correctness guard test + chunk close

**Files:**
- Create: `site/lib/corrections.test.ts`

- [ ] **Step 1: Write a guard test** that asserts the derived marketing copy never regresses to "five":

```ts
import { describe, it, expect } from 'vitest';
import { heroTicker, statBar, WORLDS, MOUNTS, WEAPONS } from './worlds';

describe('no stale counts', () => {
  it('derived copy says six, not five', () => {
    expect(heroTicker().join(' ')).toMatch(/Six worlds/);
    expect(heroTicker().join(' ').toLowerCase()).not.toContain('five');
    expect(statBar()[0]).toBe('6');
  });
  it('roster matches the game', () => {
    expect(WORLDS).toHaveLength(6);
    expect(MOUNTS).toBe(6);
    expect(WEAPONS).toBe(4);
  });
});
```

- [ ] **Step 2: Run full unit suite**

Run: `cd site && npm test`
Expected: all tests pass (worlds, lore, corrections).

- [ ] **Step 3: Commit**

```bash
git add site/lib/corrections.test.ts
git commit -m "test(site): guard against stale world/mount counts"
```

**✅ Chunk 1 complete — the site is now factually correct and shippable.**

---

## Chunk 2: Diorama Engine Core (one world end-to-end)

*Goal: prove the whole pipeline — shared renderer, scene interface, scroll orchestration, fallbacks — with a single working world (Station) before scaling to six. Consult @immersive-3d-web / @game-creator:threejs-game and verify current `three` + `gsap/ScrollTrigger` APIs before writing.*

### Task 7: Scene contract types

**Files:** Create `site/components/diorama/types.ts`, `site/components/diorama/quality.ts`

- [ ] **Step 1** — `types.ts`:

```ts
import type * as THREE from 'three';

export type QualityTier = 'low' | 'medium' | 'high';

export interface SceneCtx {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  accent: THREE.Color;
  quality: QualityTier;
}

export interface DioramaScene {
  id: string;
  build(ctx: SceneCtx): void;              // lazy, once
  update(dt: number, progress: number, active: boolean): void; // progress 0..1
  setQuality(tier: QualityTier): void;
  dispose(): void;                         // free geometry/materials
}
```

- [ ] **Step 2** — `quality.ts` (pure): pick a tier + DPR cap from `navigator` heuristics.

```ts
import type { QualityTier } from './types';
export function pickQuality(): QualityTier {
  if (typeof navigator === 'undefined') return 'medium';
  const mem = (navigator as any).deviceMemory ?? 4;
  const cores = navigator.hardwareConcurrency ?? 4;
  if (mem <= 3 || cores <= 4) return 'low';
  if (mem >= 8 && cores >= 8) return 'high';
  return 'medium';
}
export const dprCap = (t: QualityTier) => (t === 'high' ? 1.75 : t === 'medium' ? 1.5 : 1.0);
```

- [ ] **Step 3: Type-check + commit**

Run: `cd site && npx tsc --noEmit`
```bash
git add site/components/diorama/types.ts site/components/diorama/quality.ts
git commit -m "feat(site): diorama scene contract + quality heuristics"
```

---

### Task 8: DioramaCanvas — shared renderer & scene registry

**Files:** Create `site/components/diorama/DioramaCanvas.tsx`

Responsibilities: one `WebGLRenderer` on a fixed full-viewport canvas; lazy dynamic-import of `three`; hold a registry of built scenes; a single rAF loop that updates+renders only the active (and cross-fading) scene; pause on `document.hidden`/offscreen; resize handling with capped DPR; dispose on unmount. Exposes an imperative handle (`setActive(index, progress)`) consumed by `GatewayDescent`.

- [ ] **Step 1: Implement the component.** Key contract (verify `three` APIs against docs first):
  - `'use client'`.
  - Props: `scenes: { id: string; accent: string; factory: () => DioramaScene }[]`, `onReady?: () => void`, and a `ref` handle `{ setActive(i: number, progress: number): void }`.
  - Lazy import: `const THREE = await import('three')` inside an effect; build renderer with `powerPreference: 'high-performance'`, `antialias: quality!=='low'`; set `renderer.setPixelRatio(Math.min(window.devicePixelRatio, dprCap(tier)))`.
  - Scenes are built lazily on first activation (call `build(ctx)` once, track built set); non-adjacent scenes may be `dispose()`d under memory pressure (keep active ±1 warm).
  - rAF loop: compute `dt`; if `document.hidden` skip; call `active.update(dt, progress, true)`; render. During a fade window, also update+render the outgoing scene into the same frame with opacity handled by the scene or a fade overlay.
  - Cleanup: cancel rAF, dispose all scenes, `renderer.dispose()`, remove canvas + listeners.

- [ ] **Step 2: Manual smoke** — temporarily render `<DioramaCanvas scenes={[]} />` in a scratch route or via the page; confirm a canvas mounts, no console errors, and it disposes cleanly on navigation. (No visible content yet.)

- [ ] **Step 3: Commit**

```bash
git add site/components/diorama/DioramaCanvas.tsx
git commit -m "feat(site): shared single-renderer diorama canvas + scene registry"
```

---

### Task 9: useGatewayScroll — ScrollTrigger orchestration

**Files:** Create `site/hooks/useGatewayScroll.ts`

- [ ] **Step 1: Implement** (`'use client'`; verify ScrollTrigger registration against gsap docs):
  - `gsap.registerPlugin(ScrollTrigger)` guarded to run once client-side.
  - Given N panel refs (or a container + count), create a ScrollTrigger spanning the descent; `onUpdate` computes `activeIndex` and within-panel `progress` (0..1) and calls a callback.
  - Return `{ activeIndex, progress }` via state for DOM, and also invoke a stable `onScrub(i, p)` for the canvas handle (avoid re-render per frame — push to canvas imperatively, setState only when `activeIndex` changes).
  - Clean up triggers on unmount; `ScrollTrigger.refresh()` on resize.
  - Respect `prefers-reduced-motion`: if set, do not create scrubbed triggers (caller renders static fallback).

- [ ] **Step 2: Commit**

```bash
git add site/hooks/useGatewayScroll.ts
git commit -m "feat(site): gsap ScrollTrigger gateway-descent orchestrator"
```

---

### Task 10: WorldPanel — per-world DOM content

**Files:** Create `site/components/WorldPanel.tsx`

- [ ] **Step 1: Implement** a presentational panel: full-viewport section, receives `world: WorldDef`, `lore: ResolvedLore`, and refs/anchors for the scroll trigger. Renders: `worldSeq(world.index)` ("0N / 06"), `world.kicker`, `world.name`, `lore.body` (prose), `world.fact` chip, and — on the last panel or a shared threshold — the existing CTA. Uses brand classes; accent via CSS var from `world.accent`. Fully readable as static DOM (progressive enhancement). Alternate left/right per `index` parity.

- [ ] **Step 2: Type-check + commit**

```bash
git add site/components/WorldPanel.tsx
git commit -m "feat(site): WorldPanel content component"
```

---

### Task 11: GatewayDescent — composition + fallbacks

**Files:** Create `site/components/GatewayDescent.tsx`; Modify `site/app/globals.css`

- [ ] **Step 1: Implement** (`'use client'`): props `worlds: WorldDef[]`, `lore: Record<WorldId, ResolvedLore>`.
  - Detect capability: `prefers-reduced-motion` (matchMedia) and WebGL support (try to get a context). Store in state after mount (SSR renders the static path first).
  - **Enhanced path:** render `<DioramaCanvas>` (fixed) + a stack of `<WorldPanel>`; wire `useGatewayScroll` to push `(activeIndex, progress)` into the canvas handle.
  - **Fallback path** (reduced-motion OR no WebGL OR not-yet-hydrated): render the same `<WorldPanel>` stack but with the existing static `WorldCanvas`/`painters.ts` art as each panel's backdrop instead of the shared canvas. No scroll scrubbing.
  - Both paths render identical text/lore/CTAs → SSR-complete, accessible, never blank.

- [ ] **Step 2: Styles** — add additive CSS to `globals.css` for `.gateway`, `.gw-canvas` (fixed, `z-index` behind content, `pointer-events:none`), `.gw-panel` (min-height:100svh, content max-width, accent var), fade layers. Reuse existing tokens/clip/scanline. Ensure no horizontal overflow and no CLS from the fixed canvas.

- [ ] **Step 3: Commit**

```bash
git add site/components/GatewayDescent.tsx site/app/globals.css
git commit -m "feat(site): GatewayDescent composition with reduced-motion/no-webgl fallback"
```

---

### Task 12: Station scene (first cinematic diorama)

**Files:** Create `site/components/diorama/scenes/station.ts`

- [ ] **Step 1: Implement** `createStationScene(): DioramaScene` per the contract. Station brief (from spec §7): orbital ring + hub spire before a planet; slow orbital camera on `progress`; drifting traffic lights; starfield parallax; fog; accent cyan. Use instanced/cheap geometry; build once; animate in `update` from `progress` + `dt`; free everything in `dispose`. Keep it procedural and on-brand ("generated in code"). This scene is the reference template for the other five.

- [ ] **Step 2: Register + manual verify** — in `GatewayDescent`, register the station factory; run `npm run dev`; scroll the first panel and confirm: the station diorama renders, camera moves with scroll, no console errors, disposes on navigate. Check reduced-motion (emulate) shows the static station painter instead.

- [ ] **Step 3: Commit**

```bash
git add site/components/diorama/scenes/station.ts site/components/GatewayDescent.tsx
git commit -m "feat(site): Station cinematic diorama scene"
```

---

### Task 13: Swap the page over to GatewayDescent

**Files:** Modify `site/app/page.tsx`

- [ ] **Step 1: Resolve lore server-side** — in the `Home` RSC, `const lore = await getLore();` and pass `worlds={WORLDS}` + `lore` into `<GatewayDescent>`, replacing the `<HomeWorldShowcase>` usage and removing the temporary adapter from Task 4. Keep everything else (hero, features, CTA band, footer) intact. Confirm `page.tsx` remains `force-dynamic`.

- [ ] **Step 2: Manual verify** — `npm run dev`: the page now descends through the Station panel (others may be placeholder until Chunk 3), counts still correct, CTAs/pricing unchanged for signed-out vs access states. Verify no hydration warnings.

- [ ] **Step 3: Type-check + commit**

```bash
cd site && npx tsc --noEmit
git add site/app/page.tsx
git commit -m "feat(site): render GatewayDescent on the landing page"
```

**✅ Chunk 2 complete — full pipeline proven with one world.**

---

## Chunk 3: Remaining Worlds, Polish & Verification

*Each scene task follows the Station template: build → signature motion → dispose → manual verify → commit. Art direction (spec §7) is directional; iterate against the live preview.*

### Tasks 14–18: The five remaining scenes

For each, create `site/components/diorama/scenes/<name>.ts`, register it, `npm run dev`, verify it renders + animates on its panel with no leaks, then commit.

- [ ] **Task 14 — `medieval.ts` (Aldermoor Vale):** timber-roof town + castle silhouette + reflective lake plane; drifting embers/pollen; warm amber dusk. Commit `feat(site): Aldermoor Vale diorama`.
- [ ] **Task 15 — `sports.ts` (Meridian Athletic Grounds):** floodlit stadium bowl + track ribbons; sweeping stadium lights; faint crowd shimmer; green accent. Commit `feat(site): Meridian diorama`.
- [ ] **Task 16 — `citadel.ts` (Sunspire Citadel):** cliff-top vertical town, rope bridges, the 46 m tower; heat-haze; sun-rake lighting climbing the tower on `progress`. Commit `feat(site): Sunspire Citadel diorama`.
- [ ] **Task 17 — `race.ts` (Vellum Ridge):** elevated circuit ribbon through terrain + city blocks; a car moving along the lap; red-orange dusk. Commit `feat(site): Vellum Ridge diorama`.
- [ ] **Task 18 — `verdantCoil.ts` (The Verdant Coil):** aerial hedge-maze grid that visibly re-shuffles/rethreads as `progress` advances (nods to volatility); green mist; a lone lantern (the Keeper). Commit `feat(site): Verdant Coil diorama`.

Each task's verify step: render its panel, confirm signature motion, scroll past to confirm the previous scene pauses/disposes and this one activates (only active renders), check FPS is smooth.

---

### Task 19: Hero ignition + threshold pinning

**Files:** Modify `site/components/GatewayDescent.tsx`, `site/app/page.tsx`, `globals.css`

- [ ] **Step 1** — Add the portal-ignition intro (hero portal ties into the shared canvas or a dedicated intro state) and the closing "Threshold" CTA pin ("One charge. Six worlds."). Ensure the hero's existing CTA/pricing logic is untouched; this is visual sequencing only.
- [ ] **Step 2: Manual verify** entry animation + threshold. Commit `feat(site): hero ignition and threshold sequencing`.

---

### Task 20: Performance pass

- [ ] **Step 1** — Enforce: only active(+fading) scene renders; DPR capped by tier; rAF paused on `document.hidden` and when the canvas is fully offscreen (IntersectionObserver); non-adjacent scenes disposed under memory pressure; lazy WebGL init after first paint so LCP is DOM-driven.
- [ ] **Step 2: Measure** — build (`cd site && npm run build`) and run a production `npm start`; Lighthouse (or Chrome DevTools MCP performance trace) on the landing page. Targets: no CLS from the fixed canvas, good LCP, smooth interaction. Record numbers in the commit message.
- [ ] **Step 3: Commit** `perf(site): active-only rendering, DPR cap, visibility gating`.

---

### Task 21: Accessibility pass

- [ ] **Step 1** — Verify: `prefers-reduced-motion` renders static painter stills with normal scroll and full text; no-WebGL fallback path renders; all six names/lore/CTAs present in SSR/no-JS DOM; headings semantic; CTAs keyboard-focusable; canvas is `aria-hidden` + `pointer-events:none`; the mute/audio and portal motifs don't trap focus.
- [ ] **Step 2: Manual verify** with reduced-motion emulation and JS disabled. Commit `a11y(site): reduced-motion + no-webgl + no-js parity`.

---

### Task 22: Final QA, full build, finish

- [ ] **Step 1: Full unit suite** — `cd site && npm test` (all pass).
- [ ] **Step 2: Type-check + production build** — `cd site && npx tsc --noEmit && npm run build:site-only` (clean).
- [ ] **Step 3: Manual QA checklist** — signed-out vs access-holder CTAs correct; Stripe test-mode banner intact; every world name correct; stat bar 6·6·4·0 GB; no "five"/"Five worlds" anywhere (`grep -rni "five worlds\|five mounts" site/app site/components site/lib` returns nothing); all six dioramas render and animate; reduced-motion + no-WebGL fallbacks OK; no console errors; no horizontal scroll on mobile widths.
- [ ] **Step 4: Commit + finish** — commit any final tweaks; then use @superpowers:finishing-a-development-branch to open the PR / merge decision for branch `landing-redesign`.

**✅ Chunk 3 complete — full Gateway Descent shipped.**

---

## Notes & Risks

- **`three` on the site:** the game copy under `public/game` is a built bundle, not importable — the site's own `three` dep is required (added Task 1). Watch bundle size via lazy dynamic import (Task 8).
- **GSAP/ScrollTrigger licensing:** confirm ScrollTrigger's current license tier before shipping (it has historically been in the free bundle).
- **Lore DB base URL:** solved by the shared `getLoreEntries()` query (no RSC self-fetch) — Task 3.
- **Scene art:** the six briefs are directional; expect live iteration. If a scene proves too heavy on `low` tier, reduce its geometry in `setQuality('low')`.
- **Concurrent repo activity:** all work stays in the `landing-redesign` worktree; do not switch branches in the shared `gametestai/` checkout.
- **`@vercel/postgres` is deprecated** (platform prefers `@neondatabase/serverless` + drizzle). We **intentionally keep it** — the lore table is pre-existing shared infrastructure and DB migration is an explicit spec non-goal. `getLoreEntries()` merely relocates the existing query verbatim; migrating storage is out of scope for this redesign and would affect the in-game lore admin the other session owns.
```
