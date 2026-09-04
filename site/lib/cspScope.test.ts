/**
 * The game gets `'unsafe-eval'`. Nothing else does, and no response gets two
 * policies.
 *
 * The KTX2 transcoder is Emscripten output whose `embind` layer builds its
 * invokers with `new Function`, so it cannot initialise without
 * `'unsafe-eval'`. Granting that to the whole origin to serve one vendored
 * transcoder is what these tests exist to prevent, and the scoping only holds
 * while the two `source` patterns stay mutually exclusive: if `/game/…` ever
 * matches BOTH entries the browser intersects the two policies, the strict one
 * wins, and the transcoder silently stops working again.
 *
 * That failure is safe but invisible - it looks exactly like the bug that was
 * shipped for weeks - so it is pinned here rather than left to be rediscovered
 * from a player's console.
 */
import { describe, it, expect, vi } from 'vitest';

import config from '../next.config';

type HeaderRule = {
  source: string;
  headers: { key: string; value: string }[];
};

async function rules(): Promise<HeaderRule[]> {
  expect(config.headers, 'next.config must define headers()').toBeTypeOf('function');
  return (await config.headers!()) as unknown as HeaderRule[];
}

const cspOf = (r: HeaderRule) =>
  r.headers.find((h) => h.key === 'Content-Security-Policy')?.value ?? null;

describe('the CSP scope', () => {
  it('publishes exactly two CSP entries, one of them the game', async () => {
    const withCsp = (await rules()).filter((r) => cspOf(r) !== null);
    expect(withCsp).toHaveLength(2);

    const game = withCsp.find((r) => r.source.startsWith('/game/'));
    const site = withCsp.find((r) => !r.source.startsWith('/game/'));
    expect(game, 'a /game/ CSP entry must exist').toBeTruthy();
    expect(site, 'a site-wide CSP entry must exist').toBeTruthy();
    expect(cspOf(game!), 'the transcoder needs it').toContain("'unsafe-eval'");
  });

  it('IN PRODUCTION gives the game unsafe-eval and the site none', async () => {
    /* The interesting assertion only holds in a production build: `isDev` adds
     * `'unsafe-eval'` everywhere so `next dev`'s HMR pipeline works, which is
     * deliberate and is why this cannot simply be asserted against the module
     * as imported. Re-import under a production env to read the policy players
     * are actually served - that policy is the whole subject of this file. */
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const prod = (await import('../next.config')).default;
      const prodRules = (await prod.headers!()) as unknown as HeaderRule[];
      const withCsp = prodRules.filter((r) => cspOf(r) !== null);

      const game = withCsp.find((r) => r.source.startsWith('/game/'))!;
      const site = withCsp.find((r) => !r.source.startsWith('/game/'))!;

      expect(cspOf(game), 'the transcoder needs it').toContain("'unsafe-eval'");
      expect(
        cspOf(site),
        'the pages that hold a session or take money must never eval'
      ).not.toContain("'unsafe-eval'");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it('never lets one response collect both policies', async () => {
    const withCsp = (await rules()).filter((r) => cspOf(r) !== null);
    const site = withCsp.find((r) => !r.source.startsWith('/game/'))!;

    /* The site pattern is the half that has to do the excluding; the game
     * pattern is a plain prefix. Compile the source as the regex Next builds
     * from it and check the boundary directly. */
    const siteRe = new RegExp(`^${site.source}$`);

    for (const gamePath of [
      '/game/index.html',
      '/game/assets/index-abc123.js',
      '/game/vendor/basis/basis_transcoder.js',
    ]) {
      expect(
        siteRe.test(gamePath),
        `${gamePath} must be served the game policy ONLY`
      ).toBe(false);
    }

    for (const sitePath of ['/', '/store', '/checkout', '/account', '/admin', '/play']) {
      expect(
        siteRe.test(sitePath),
        `${sitePath} must keep the strict policy`
      ).toBe(true);
    }
  });

  it('does not weaken anything else for the game', async () => {
    /* Only the eval token may differ. A second policy that quietly dropped
     * frame-ancestors or object-src would be a much worse trade than the one
     * being made here, and it would be invisible. */
    const withCsp = (await rules()).filter((r) => cspOf(r) !== null);
    const game = cspOf(withCsp.find((r) => r.source.startsWith('/game/'))!)!;
    const site = cspOf(withCsp.find((r) => !r.source.startsWith('/game/'))!)!;

    const normalise = (csp: string) =>
      csp
        .split(';')
        .map((d) => d.trim().replace(" 'unsafe-eval'", '').replace("'unsafe-eval' ", ''))
        .filter(Boolean)
        .sort();

    expect(normalise(game)).toEqual(normalise(site));
  });

  it('keeps every non-CSP security header identical across both entries', async () => {
    const withCsp = (await rules()).filter((r) => cspOf(r) !== null);
    const strip = (r: HeaderRule) =>
      r.headers
        .filter((h) => h.key !== 'Content-Security-Policy')
        .map((h) => `${h.key}: ${h.value}`)
        .sort();

    const game = withCsp.find((r) => r.source.startsWith('/game/'))!;
    const site = withCsp.find((r) => !r.source.startsWith('/game/'))!;
    expect(strip(game)).toEqual(strip(site));
    expect(strip(game).length).toBeGreaterThan(3);
  });
});
