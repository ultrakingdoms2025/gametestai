# AETHER NEXUS — Landing Page Redesign ("Gateway Descent")

- **Date:** 2026-08-09
- **Status:** Draft for review
- **Author:** brainstormed with Mark
- **Target:** `site/` (Next.js 16 App Router marketing site), landing page only + supporting corrections

---

## 1. Context

`site/` is a full Next.js 16 (App Router, Turbopack, TypeScript, RSC) storefront for the browser game **Aether Nexus** — a first-person, 100%-procedural Three.js game bundled into `site/public/game/` and served at `/game/`. This spec covers **only the marketing landing page** (`site/app/page.tsx` and its showcase components) plus the correctness fixes needed so the marketing does not lie about the product.

### Current problems

1. **Wrong world count.** The game ships **6 worlds**; the site says **5** everywhere (hero `<title>`, ticker, `feat-stats-bar` = `['5','5','4','0 GB']`, `HomeWorldShowcase` `/05` numbering, CTA "Five worlds").
2. **Missing 6th world.** *The Verdant Coil* (`maze`) — a hedge maze that re-rolls its layout on every entry — is completely absent from the site.
3. **Wrong mount count.** Copy says **"Five mounts"** and lists 5; the game builds **6** (`hoverboard, dragon, car, horse, eagle, bicycle` — `src/mounts/MountManager.js` lines 576–583). Weapons **= 4** is correct (`Weapon`+`Fireball`+`Bow`+`Sword`, `src/player/Loadout.js`).
4. **Conflicting world names.** The medieval world is *Aldermoor Vale* (game), *Medieval Valley* (site), and *Ashfall Reach* (station portal label). Others drift too (*Aether Station* vs *Aether Nexus Station*; *Vellum Ridge* vs *Vellum Ridge Circuit*).
5. **No real game media.** World panels are 2D procedural `<canvas>` illustrations (`site/components/WorldCanvas.tsx` → `site/lib/painters.ts`). There are no screenshots or clips of any world in the repo.
6. **Stale in-game text.** `src/content/Lore.js` states "the Nexus has five worlds … four outbound portals" and has no `maze` entry; root `package.json` describes "three open worlds."

### Goal

A high-end, immersive gaming landing page that (a) corrects every count/name, (b) showcases all **6** worlds with high-fidelity live animation, and (c) converts new players through lore, motion, and graphics.

---

## 2. Design decisions (locked with stakeholder)

| Decision | Choice |
|---|---|
| World media | **Live WebGL panels** (real Three.js scenes), not video files or flat canvas |
| Panel fidelity | **Cinematic Diorama** — layered depth/parallax, atmospheric fog, dynamic lighting, one signature "living" motion per world |
| Page structure | **Gateway Descent** — one continuous cinematic scroll; each world full-viewport |
| Motion driver | **Scroll-scrubbed via GSAP ScrollTrigger** — camera + timelines scrub to scroll position |
| Lore source | **Live from `/api/lore`**, merged over a complete **baked fallback** (all 6 worlds) for robustness |
| Scope | **Landing page + metadata + in-game text fixes** (everything correct everywhere) |
| Canonical names | The **in-game display names** players actually see (table below) |

### Non-goals

- No redesign of storefront/checkout/account/admin/login pages.
- No changes to the game itself beyond stale text corrections (`Lore.js`, `package.json`).
- No real gameplay capture / video hosting.
- No migration of the existing `@vercel/postgres` lore backend (left as-is; only its ordering extended for `maze`).

---

## 3. Canonical world model (single source of truth)

Create `site/lib/worlds.ts` exporting one ordered array that **every** count, panel, stat, and metadata string derives from. This structurally prevents count drift (no more hardcoded `5`/`/05`/`['5','5','4']`).

```ts
export interface WorldDef {
  id: WorldId;            // canonical game id — also the lore scope key
  index: number;          // 1-based, for "0N / 06"
  name: string;           // canonical display name
  role: string;           // "Hub world", etc.
  kicker: string;         // short eyebrow
  copy: string;           // 1–2 sentence marketing line
  fact: string;           // one-line canonical fact (the "chip")
  accent: string;         // hex accent for lighting/UI
  loreScope: string;      // key into /api/lore entries (usually === id)
  scene: WorldSceneId;    // which diorama scene module renders it
}
export type WorldId = 'station'|'medieval'|'sports'|'citadel'|'race'|'maze';
```

| index | id | Canonical name | role | accent | fact |
|---|---|---|---|---|---|
| 1 | `station` | **Aether Nexus Station** | Hub world | `#52e9ff` | The gateway to all six worlds |
| 2 | `medieval` | **Aldermoor Vale** | Exploration | `#ffb347` | Walled town · castle · swimmable lakes |
| 3 | `sports` | **Meridian Athletic Grounds** | Skill | `#2ffb9a` | Pool · courts · skatepark · ski piste |
| 4 | `citadel` | **Sunspire Citadel** | Vertical | `#ffc46b` | 46 m climbable great tower |
| 5 | `race` | **Vellum Ridge** | Competition | `#ff5a3c` | 3 circuits · real F1 start procedure |
| 6 | `maze` | **The Verdant Coil** | Volatile | `#8fd67a` | Re-generates its layout every visit |

`copy` per world is taken from the true game lore (`src/content/Lore.js` `DEFAULT_LORE`; the maze from `src/worlds/MazeWorld.js`). Accents mirror the station portal colors in `src/worlds/StationWorld.js`.

---

## 4. Corrections matrix

| Where | Current | Fix |
|---|---|---|
| `app/layout.tsx` metadata `title` | "AETHER NEXUS — five worlds, one gateway" | "…six worlds, one gateway" |
| `app/layout.tsx` OG description | "Five worlds. One gateway…" | "Six worlds. One gateway…" |
| `page.tsx` hero ticker | `'Five worlds','Five mounts',…` | derived: `Six worlds, Six mounts, Four weapons,…` |
| `page.tsx` `feat-stats-bar` | `['5','5','4','0 GB']` | `[worlds.length, mounts=6, weapons=4, '0 GB']` |
| `page.tsx` FEATURES "Five mounts" | lists 5, omits bicycle | "Six mounts" + bicycle in copy |
| `page.tsx` CTA "One charge. Five worlds." | — | "One charge. Six worlds." |
| `WORLDS` array (moves to `lib/worlds.ts`) | 5 entries, name drift, scene keys `valley`/`circuit` | 6 entries, canonical names/ids |
| `HomeWorldShowcase` `/05`, "Five … environments" | hardcoded | derived from `worlds.length` |
| `src/content/Lore.js` "five worlds / four outbound portals"; no `maze` | — | "six worlds / five outbound portals"; add `maze` entry; add to `LORE_ORDER` |
| `src/app/api/lore/route.ts` CASE ordering | no `maze` | add `WHEN 'maze' THEN 6` |
| root `package.json` "three open worlds" | — | "six worlds" |

**Verification task during build:** re-confirm mount roster (expect 6) and weapon roster (expect 4) against `MountManager.js` / `Loadout.js` before finalizing copy, so a *new* wrong number is not introduced.

---

## 5. Architecture

### 5.1 Single-canvas diorama engine

Rendering 6 heavy WebGL scenes simultaneously would destroy performance. Instead:

- **One** `<canvas>` + **one** `THREE.WebGLRenderer`, `position: fixed`, full-viewport, behind the scrolling content (`DioramaCanvas.tsx`, a client component).
- Only the **active** world's scene is updated/rendered; neighbours are paused. During a cross-fade, at most two scenes render briefly.
- Each world is a **scene module** implementing a narrow interface:

```ts
export interface DioramaScene {
  id: WorldId;
  build(ctx: SceneCtx): void;      // create meshes/lights/camera rig (lazy, once)
  update(dt: number, progress: number, active: boolean): void; // progress 0..1 within panel
  setQuality(tier: QualityTier): void;
  dispose(): void;                 // free geometry/materials/textures
}
```

Modules live in `site/components/diorama/scenes/{station,aldermoorVale,meridian,sunspire,vellumRidge,verdantCoil}.ts`. Adding a 7th world = one new module + one row in `worlds.ts`. Each is independently testable (build/dispose leak checks; update determinism).

### 5.2 Scroll orchestrator

`useGatewayScroll()` hook + GSAP **ScrollTrigger**:

- Maps global scroll → `{ activeIndex, progress }`.
- Drives each panel's camera dolly/orbit and scene timelines via `progress`.
- Handles enter/exit cross-fades between adjacent worlds.
- Pins the hero portal ignition and the threshold CTA.
- Single shared `requestAnimationFrame` loop owned by `DioramaCanvas`; the hook publishes state, the canvas consumes it (no competing rAF loops).

### 5.3 Data flow

```
lib/worlds.ts (SoT) ─┬─► app/page.tsx (RSC): counts, ticker, stats, metadata
                     ├─► lib/lore.ts getLore() (server): fetch /api/lore
                     │        └─ merge over baked fallback, map scope→world
                     └─► <GatewayDescent worlds lore /> (client)
                              ├─ <DioramaCanvas> (one renderer, scene registry)
                              └─ <WorldPanel> ×6 (lore text, fact chip, scroll targets)
```

`page.tsx` stays an RSC (`force-dynamic`, already the case) and passes serializable `worlds` + resolved `lore` into the client `GatewayDescent`.

### 5.4 Lore wiring (live + fallback)

`site/lib/lore.ts`:

- `getLore()` server-side `fetch('/api/lore')` (or direct import of the query) → `{ entries }`.
- **Scope mapping:** API scopes are `station, medieval, sports, citadel, race` (+ `overall`); world ids match except there is **no `maze` row**. Map `world.loreScope` → entry.
- **Baked fallback** `FALLBACK_LORE: Record<WorldId, {title,body,fact}>` holds correct lore for **all 6** worlds (maze included), sourced from `Lore.js` / `MazeWorld.js`. Final lore = `apiEntry ?? fallback`. Guarantees a correct, complete page even on 503 / empty DB / local dev without Postgres.
- Also extend `route.ts` CASE with `WHEN 'maze' THEN 6` so a future maze row sorts correctly.

### 5.5 Component breakdown

| Component | Type | Responsibility |
|---|---|---|
| `lib/worlds.ts` | data | Canonical 6-world source of truth + counts |
| `lib/lore.ts` | server | Fetch + merge lore, scope mapping, fallback |
| `app/page.tsx` | RSC | Hero, derived counts/ticker/stats, compose sections |
| `app/layout.tsx` | RSC | Corrected metadata/OG/title |
| `components/GatewayDescent.tsx` | client | Orchestrates canvas + panels + scroll hook |
| `components/diorama/DioramaCanvas.tsx` | client | One renderer, scene registry, rAF loop, quality/visibility gating |
| `components/diorama/scenes/*.ts` | lib | Six `DioramaScene` modules |
| `components/WorldPanel.tsx` | client | Per-world lore text, fact chip, scroll anchors, accessible content |
| `hooks/useGatewayScroll.ts` | client | ScrollTrigger mapping → active/progress |
| `components/HomeWorldShowcase.tsx` | — | Replaced/retired by GatewayDescent (kept if reused elsewhere) |

---

## 6. Page sections (Gateway Descent)

1. **Arrival (hero).** Portal ring ignites on load; lockup `AETHER NEXUS`; deck; corrected ticker; primary CTA (`/checkout?intent=entry` or `/play` per access — preserve existing auth/access logic and pricing exactly). Scroll cue.
2. **The Descent.** Six full-viewport `WorldPanel`s over the fixed diorama canvas. Camera + scene animate on scroll; lore paragraph + fact chip fade in; panel numbered `0N / 06` (derived). Order = `worlds.ts` order (Station first as the hub/gateway framing).
3. **The Numbers.** Corrected stat bar (`6 worlds · 100% generated · 0 GB · ∞ maze layouts`) + the existing FEATURES grid with corrected copy ("Six mounts", bicycle added).
4. **Threshold (CTA band).** Portal re-ignites; "One charge. Six worlds."; existing CTA/pricing logic preserved.

Preserve the existing nav, `AccountDashboard`, Stripe test-mode banner, and footer, and all access/pricing behaviour — this is a visual/content redesign, not a commerce change.

---

## 7. Per-world scene briefs

Each diorama is stylized/procedural (on-brand with "generated in code"), not literal geometry import.

- **Aether Nexus Station** — orbital ring + hub spire before a planet; slow orbital camera; drifting traffic lights; starfield parallax.
- **Aldermoor Vale** — timber-roof town + castle silhouette + lake plane with depth/reflection; drifting embers/pollen; warm amber dusk.
- **Meridian Athletic Grounds** — floodlit stadium bowl + track ribbons; sweeping stadium lights; faint crowd shimmer.
- **Sunspire Citadel** — cliff-top vertical town, rope bridges, the 46 m tower; heat-haze; sun-rake lighting climbing the tower on scroll.
- **Vellum Ridge** — elevated circuit ribbon through terrain + city blocks; **a car moving along the lap**; red-orange dusk.
- **The Verdant Coil** — aerial hedge-maze grid that **re-shuffles/rethreads** as you scroll (nods to its volatility); green mist; a lone lantern (the Keeper).

---

## 8. Performance budget

- Lazy-init WebGL after first paint / when hero nears viewport (dynamic import of Three + scenes; keep it out of the initial RSC payload).
- Pause rAF when `document.hidden` or the canvas is fully offscreen.
- Cap `devicePixelRatio` (≤ ~1.75); quality tiers via `setQuality()` chosen from device heuristics; only active (+ fading) scene renders.
- Dispose non-adjacent scenes' heavy resources if memory pressure; keep lightweight ones warm.
- Target: no CLS from the fixed canvas; interaction stays responsive; good LCP (hero text/portal is DOM/CSS, not gated on WebGL).

## 9. Accessibility & fallbacks

- **`prefers-reduced-motion`**: disable scrub/parallax; show a static representative frame per world (reuse existing `painters.ts` canvas art as the still) with normal scroll. Content fully readable.
- **No WebGL / init failure**: graceful fallback to `painters.ts` panels; page never blank.
- **SSR/no-JS**: all world names, lore, counts, and CTAs are real DOM from the RSC — the diorama is progressive enhancement. Semantic headings, `aria-label`s, keyboard-focusable CTAs preserved.
- Panels are readable as a normal document even with the canvas removed.

## 10. Brand

Reuse existing tokens verbatim from `site/app/globals.css`: Chakra Petch (display) + Rajdhani (body); cyan `#52e9ff` + amber `#ffb44a` on near-black `#04070d`; clipped/beveled corners; scanline overlay; portal-ring motif. New CSS is additive.

## 11. Files touched

**New:** `site/lib/worlds.ts`, `site/lib/lore.ts`, `site/components/GatewayDescent.tsx`, `site/components/WorldPanel.tsx`, `site/components/diorama/DioramaCanvas.tsx`, `site/components/diorama/scenes/*.ts` (6), `site/hooks/useGatewayScroll.ts`, additive CSS.

**Modified:** `site/app/page.tsx`, `site/app/layout.tsx` (metadata), `site/app/api/lore/route.ts` (maze ordering), `site/package.json` (add `gsap`, `three`; note `three` may already be bundled with the game but the site needs its own dep). **In-game text:** `src/content/Lore.js`, root `package.json`.

**Verify/consult during implementation (repo hook):** current Next.js 16 App Router + Vercel Functions + `three`/`gsap` docs for client-component boundaries, dynamic rendering of the lore route, and ScrollTrigger setup — do not rely on memorized APIs.

## 12. Testing

- **Unit:** `worlds.ts` counts (=6, mounts=6, weapons=4); `lib/lore.ts` merge (API present, API 503, missing `maze` → fallback; scope mapping).
- **Scene modules:** build→dispose leak check (no orphaned geometries/materials); `update` determinism at a fixed `progress`.
- **E2E (Playwright):** all 6 canonical names render; stat bar shows 6/6/4; no "Five"/"five worlds" string anywhere; reduced-motion path renders stills; CTA/access logic unchanged for signed-out vs access states.
- **Perf:** Lighthouse pass on Vercel preview; verify no CLS, acceptable LCP.

## 13. Risks / open questions

- **`three` on the site:** confirm whether to add `three` as a site dependency (recommended — the game's copy under `public/game` is a built bundle, not importable). Bundle-size watched via lazy import.
- **Lore API auth/runtime:** `/api/lore` is `force-dynamic` + Postgres; server-side fetch during RSC render is fine, but confirm base URL handling in server context (use direct query import rather than HTTP self-fetch if simpler/safer).
- **GSAP licensing:** ScrollTrigger is in GSAP's free tier as of writing — confirm before adding.
- **Scene art direction:** the six briefs are directional; exact look iterates against the live preview.

## 14. Out of scope

Storefront/checkout/account/admin, real gameplay capture, audio, the game engine itself (beyond stale-text fixes), and any pricing/auth behaviour changes.
