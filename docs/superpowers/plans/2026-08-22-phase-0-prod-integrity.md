# Phase 0 — Security and Production Integrity Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four production problems found during the brief recon — an open marketplace admin, an unauthenticated middleware bypass, a hardcoded session-secret fallback and a leaky health endpoint — and stop shipping untested code and stale bundles.

**Architecture:** Four small, independent code changes plus one CI addition. The allowlist logic moves into a pure, dependency-free module (`site/lib/adminAllowlist.ts`) so it is testable under vitest without dragging in next-auth and `pg`; `adminAccess.ts` keeps its signature and delegates. `admin/proxy.ts` loses its `/api/service` bypass and gains a hard assertion on `SESSION_SECRET`. `/api/health` splits into a public liveness answer and a key-gated detail view. CI runs the three suites that already exist but never gate a push.

**Spec:** `docs/superpowers/specs/2026-08-21-implementation-brief-roadmap.md`, section "Phase 0".

**Tech Stack:** Next.js 16 App Router + TypeScript (`site/`, `admin/`), vitest (`site/`), `node --test` (game root), GitHub Actions.

**Conventions for every task**
- Site tests: `cd site && npx vitest run lib/<name>.test.ts`. Whole suite: `npx vitest run`.
- Game tests: `npm test` at the repo root. Contracts: `node scripts/contract-check.mjs`.
- `site/vitest.config.mts` includes only `lib/**/*.test.ts` and `components/**/*.test.ts` — a test outside those globs will silently not run.
- Commit messages end with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Line references were read off the working tree at plan time; re-grep if an earlier task moved them.

## Design decisions, declared

1. **Fail closed, and re-read env per call.** `adminAccess.ts:13-16` builds the allowlist at module scope, so it freezes at cold start and an env change needs a redeploy to take effect. The replacement reads `process.env` inside the check. Slightly more work per call, on a path that already makes two database round trips.
2. **An empty allowlist denies everyone, and says so in the server log only.** The client gets the same `null` it gets for any other denial — telling an anonymous caller "the allowlist is unconfigured" hands them a fact about the deployment. The operator gets a one-line `console.warn` naming the env var.
3. **The `/api/service` bypass is deleted, not repaired.** `admin/app/api/service/` does not exist, so nothing regresses. When a service route is genuinely built, it authenticates by key *inside* this middleware; a comment records that. Removing the branch makes `/api/service/*` fall through to the session check and answer 401.
4. **`SESSION_SECRET` throws rather than defaulting.** `admin/lib/session.ts` already throws on a missing secret; `admin/proxy.ts:7` silently substitutes `'fallback-replace-me-32-chars-!!!'`. Two files disagreeing about whether a secret is optional is the bug — the middleware is brought into line with the library.
5. **Health splits rather than closes.** A bare `{ status }` stays public so uptime monitors keep working; every diagnostic field moves behind `HEALTH_DETAIL_KEY`. Without that env var set, detail is unavailable to everyone — there is no bootstrap-open mode, which is the mistake this phase exists to correct.
6. **Postgres pooling is deferred to Phase 2**, not done here. It changes the shape of every query path in `site/lib/`, and Phase 2 already opens that surface for the economy migration. Doing it twice is worse than doing it once.
7. **The `an_pass` entitlement cookie retirement is deferred to Phase 2** for the same reason — it is entangled with the `site_users` / `players` consolidation Phase 2 must do anyway.

---

## Task 1: Marketplace allowlist fails closed

**Files:**
- Create: `site/lib/adminAllowlist.ts`
- Create: `site/lib/adminAllowlist.test.ts`
- Modify: `site/lib/adminAccess.ts:4-25`

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run it, confirm it fails** — `cd site && npx vitest run lib/adminAllowlist.test.ts`
- [ ] **Step 3: Create the pure module**
- [ ] **Step 4: Rewrite `adminAccess.ts` to delegate**
- [ ] **Step 5: Run the whole site suite** — `npx vitest run`
- [ ] **Step 6: Commit**

**Behaviour being pinned:**
- empty allowlist denies every email, including a signed-in one
- configured allowlist matches exactly, case-insensitively, whitespace-trimmed
- `null` / `undefined` / `''` deny
- `ADMIN_EMAILS` and `MARKETPLACE_ADMIN_EMAILS` are both honoured, and merge
- separators `,` `;` and newline all split
- a changed env var takes effect without a module reload

## Task 2: Remove the `/api/service` bypass and the session-secret fallback

**Files:**
- Modify: `admin/proxy.ts:5-9` (secret), `:56-57` (bypass)

- [ ] **Step 1: Delete the bypass branch**, leaving a comment naming the requirement for any future service route
- [ ] **Step 2: Replace the `??` fallback with a resolver that throws** when `SESSION_SECRET` is absent or under 32 characters
- [ ] **Step 3: Typecheck** — `cd admin && npx tsc --noEmit`
- [ ] **Step 4: Commit**

## Task 3: Health endpoint stops leaking

**Files:**
- Modify: `site/app/api/health/route.ts`

- [ ] **Step 1: Public GET returns `{ status }` only** — `ok` or `degraded`, no `checks` object
- [ ] **Step 2: Detail requires `x-health-key` matching `HEALTH_DETAIL_KEY`**, compared in constant time; an absent env var means detail is never available
- [ ] **Step 3: Redact what detail does return** — presence booleans, never values; no hostname; no row counts; error classes, not messages
- [ ] **Step 4: Typecheck and commit**

## Task 4: CI that actually gates

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Job runs on push and pull_request**
- [ ] **Step 2: Root game tests** — `npm ci && npm test` (190 files, ~2,570 tests, ~186 s)
- [ ] **Step 3: Contracts** — `node scripts/contract-check.mjs` (**not** part of `npm test`)
- [ ] **Step 4: Site tests** — `cd site && npm ci && npx vitest run`
- [ ] **Step 5: Build verification** — `npx vite build` must succeed
- [ ] **Step 6: Commit**

## Task 5: The bundler stops swallowing failures

**Files:**
- Modify: `site/scripts/bundle-game.mjs`

- [ ] **Step 1: Read the current `--if-available` semantics**
- [ ] **Step 2: Distinguish "the game source is absent" (legitimately skip) from "the build ran and failed" (exit non-zero)**
- [ ] **Step 3: Verify a forced failure exits non-zero**
- [ ] **Step 4: Commit**

## Task 6: Retire the stale audit documents

**Files:**
- Modify: `QUEST-AUDIT.md`, `INVENTORY-AUDIT.md`, `MINIGAMES-AUDIT.md`

- [ ] **Step 1: Add a superseded banner to each**, pointing at the roadmap's section 2 and listing the specific counts that are wrong (tests 1,266-1,334 to 2,570; quests 63 to 78; minigames 3 to 6 kinds / 12 venues)
- [ ] **Step 2: Commit**

---

## Out of scope, recorded so it is not lost

- **Postgres connection pooling** — every query in `site/lib/db.ts`, `playerDb.ts` and `marketplaceDb.ts` opens and closes its own TCP connection; one `/api/user/me` does five or more. Deferred to Phase 2, which reopens those files anyway.
- **`an_pass` entitlement cookie** — a signed cookie duplicating `players.access_granted_at`, whose own docblock still claims the project has no database and no login. Deferred to Phase 2's consolidation.
- **In-memory login rate limiting** (`admin/proxy.ts:12-22`) is per-lambda-instance and therefore close to useless on Vercel. Replacing it needs shared state; it is not a regression introduced here, and it is strictly better than nothing. Noted for a later hardening pass.
