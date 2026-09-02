import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * WHAT THIS SUITE IS ALLOWED TO NOT COVER, AND WHY THE SHAPE CHANGED.
 *
 * Until September 2026 the include list was `['lib/**\/*.test.ts',
 * 'components/**\/*.test.ts']`, which excluded `app/**` in its entirety. That
 * is where every route handler lives — checkout, webhook, confirm, restore,
 * redeem, register, reset-password, setup-2fa — so the code that takes money
 * and issues credentials had no test that this config would have run even if
 * someone had written one. It also matched no `.tsx` at all, and there was not
 * one `.test.tsx` in the repository, which is exactly how a React batching bug
 * survived in `MarketplaceAdminPanel`: every success message it set was
 * clobbered in the same tick, and nothing could have caught that without
 * rendering the component.
 *
 * `passWithNoTests: true` is gone with it, from both projects. It was added
 * when this file ran before any test existed, and it long outlived that: with
 * it set, a typo in one of these globs is a suite that finds nothing, reports
 * success, and gates a deploy on having measured zero behaviour — the failure
 * shape this repository has paid for repeatedly.
 *
 * ── TWO PROJECTS, BECAUSE THE TWO HALVES RUN IN DIFFERENT PLACES ──────────
 * A single global `environment` would have to be wrong for one half. Route
 * handlers and `lib/` run on a SERVER: no `window`, no `document`. Testing
 * them under jsdom means testing a branch production never takes, and any
 * `typeof window === 'undefined'` guard — the standard way server-only code
 * protects itself — silently flips. React components are the opposite: they
 * need a DOM to render into at all.
 *
 * So the environment follows the file, via Vitest 4's `projects`. (Vitest's
 * old `environmentMatchGlobs` did this in one project; it was removed in
 * Vitest 4, and it is not coming back — `projects` is the replacement.)
 */
const SERVER_SIDE_TESTS = [
  'lib/**/*.test.ts',        // pure logic: pricing, ledgers, map schema, guards
  'components/**/*.test.ts', // scene leak/determinism tests — three.js, headless
  'app/**/*.test.ts',        // route handlers; server code, so NOT jsdom
];

const COMPONENT_TESTS = [
  'components/**/*.test.tsx',
  'app/**/*.test.tsx',
];

export default defineConfig({
  resolve: {
    alias: {
      '@': dirname, // mirror tsconfig's "@/*" -> "./*" so scene files can import via the same alias Next.js uses
    },
  },
  test: {
    /* Vitest's default exclude does not know about these two. `public/game` is
     * the built game bundle — hundreds of thousands of lines of emitted
     * JavaScript — and `.next` is build output that contains copies of the
     * app's own source. Scanning either is wasted work at best and collects a
     * stale duplicate of a real test at worst. */
    exclude: ['**/node_modules/**', '**/dist/**', '.next/**', 'public/game/**'],

    /* Thirty seconds, not Vitest's five. The ledger, quest and owner-flow
     * suites are not unit tests — they open a real connection to a remote Neon
     * branch, and a single case measures 1.5-3.8 s of round trips before it
     * asserts anything. Against a 5 s default that is not a slow test, it is a
     * COIN FLIP: the suite passes locally, then fails in CI on a cold pool or
     * a noisy link, and the failure names the test rather than the latency, so
     * it reads as a regression in code that did not change.
     *
     * A timeout is a deadlock fuse, not a performance budget. This one is set
     * where a genuinely hung query still fails the run in reasonable time,
     * while normal remote latency never does. Individual `{ timeout: n }`
     * overrides were spreading through the integration files one at a time;
     * this replaces that drift with one number that covers the class. */
    testTimeout: 30_000,

    projects: [
      {
        extends: true,
        test: {
          name: 'server',
          environment: 'node',
          include: SERVER_SIDE_TESTS,
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',

          /* `@testing-library/jest-dom/vitest` IS the setup — importing it
           * registers the DOM matchers (`toBeInTheDocument`, `toHaveValue`, …)
           * on Vitest's `expect`. Naming the package here rather than a local
           * setup file means a component test needs no boilerplate import to
           * get them, and there is no extra file to forget to update. */
          setupFiles: ['@testing-library/jest-dom/vitest'],

          /* Testing Library registers its own `afterEach(cleanup)` only when a
           * global `afterEach` exists. Without this, every component test
           * leaves its render mounted and the next one queries a document with
           * two copies of the component in it — which fails as
           * "found multiple elements", far away from the test that caused it. */
          globals: true,

          /* NO `passWithNoTests` HERE EITHER, and that is the point of the
           * project split rather than an accident of it. Both halves must find
           * files or the run fails, so a typo in either glob is a red build
           * instead of a green one that measured nothing. That costs something
           * real: delete the last `.test.tsx` in the repository and CI goes
           * red. Add a component test instead. */
          include: COMPONENT_TESTS,
        },
      },
    ],
  },
});
