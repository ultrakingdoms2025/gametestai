import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * EVERY admin surface names the guard. Not just this phase's.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 0 of this roadmap exists because nine admin pages shipped to production
 * with no guard on them. Every one of those was a file somebody wrote correctly
 * once and a file somebody added later without looking at it. The behavioural
 * tests in `mapAdminRoutes.test.ts` prove that THIS phase's handlers refuse a
 * non-admin — they cannot say anything about the handler added next month.
 *
 * This one can, because it enumerates the tree rather than a list. A new route
 * under `app/api/admin/**` that forgets the guard fails here on the commit that
 * adds it.
 *
 * ── The limit of a scrape, stated plainly ──────────────────────────────────
 *
 * Naming `requireMarketplaceAdmin` is not the same as CHECKING its answer. A
 * handler could call it and ignore the result. So this test is the net, not the
 * proof: it catches the omission that has actually happened here (a whole file
 * with no guard at all), while `mapAdminRoutes.test.ts` proves the answer is
 * acted on by calling the real handlers.
 *
 * ── CRLF ───────────────────────────────────────────────────────────────────
 *
 * Every read is normalised before anything is anchored to it. `core.autocrlf`
 * has made a source scrape green in a worktree and red in the checkout three
 * times in this repo.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, '..');

/** Next's HTTP method exports. A file may export any subset. */
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

const GUARD = 'requireMarketplaceAdmin';

function walk(dir: string, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function source(file: string): string {
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

/**
 * The body of an exported handler, by brace matching.
 *
 * The parameter list has to be skipped by PARENTHESIS depth first. Taking the
 * next `{` after the signature instead finds the brace inside
 * `{ params: Promise<{ world: string }> }` — a Next 16 dynamic-route signature —
 * and then "the body" is the destructured parameter, which contains no guard and
 * fails every correctly guarded route in the tree. That is what this function
 * did on its first run, and it is worth the extra loop to not be reading a
 * type annotation while believing it is a function body.
 *
 * Otherwise deliberately crude: it does not understand braces inside strings or
 * regexes, which would end a body early and make the test STRICTER, never
 * looser. A false failure here is a five-second read; a false pass is an open
 * admin route.
 */
function handlerBody(src: string, method: string): string | null {
  const signature = new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\s*\\(`);
  const at = src.search(signature);
  if (at < 0) return null;

  let i = src.indexOf('(', at);
  if (i < 0) return null;
  let parens = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') parens++;
    else if (src[i] === ')') {
      parens--;
      if (parens === 0) break;
    }
  }

  const open = src.indexOf('{', i);
  if (open < 0) return null;
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, j + 1);
    }
  }
  return src.slice(open);
}

const apiRoutes = walk(join(SITE, 'app', 'api', 'admin')).filter((f) => /route\.tsx?$/.test(f));
const adminPages = walk(join(SITE, 'app', 'admin')).filter((f) => /page\.tsx?$/.test(f));

describe('admin API routes', () => {
  it('finds the routes at all, so an empty walk cannot pass silently', () => {
    expect(apiRoutes.length).toBeGreaterThanOrEqual(3);
    expect(apiRoutes.some((f) => f.includes('map'))).toBe(true);
    expect(apiRoutes.some((f) => f.includes('marketplace'))).toBe(true);
  });

  for (const file of apiRoutes) {
    const rel = relative(SITE, file).replace(/\\/g, '/');
    const src = source(file);
    const exported = METHODS.filter((m) =>
      new RegExp(`export\\s+(?:async\\s+)?function\\s+${m}\\s*\\(`).test(src)
    );

    it(`${rel} exports at least one handler`, () => {
      expect(exported.length).toBeGreaterThan(0);
    });

    for (const method of exported) {
      it(`${rel} — ${method} names the admin guard`, () => {
        const body = handlerBody(src, method);
        expect(body).not.toBeNull();
        expect(body!).toContain(GUARD);
      });
    }
  }
});

describe('admin pages', () => {
  it('finds the pages at all', () => {
    expect(adminPages.length).toBeGreaterThanOrEqual(2);
  });

  for (const file of adminPages) {
    const rel = relative(SITE, file).replace(/\\/g, '/');
    it(`${rel} guards its render`, () => {
      expect(source(file)).toContain(GUARD);
    });
  }
});

/**
 * Defence in depth, and named as such.
 *
 * The page guard is the boundary — `proxy.ts` cannot be, because Next 16
 * renamed `middleware.ts` partly over CVE-2025-29927, a middleware auth bypass
 * driven by a request header. But an anonymous visitor to an admin URL should
 * meet the login page rather than a rendered shell with a banner in it, and the
 * proxy is the only thing that can do that before the page runs at all.
 */
describe('the proxy', () => {
  const proxy = source(join(SITE, 'proxy.ts'));

  it('sends an anonymous visitor to /admin to log in first', () => {
    const list = proxy.match(/const PROTECTED = \[([^\]]*)\]/);
    expect(list).not.toBeNull();
    expect(list![1]).toContain("'/admin'");
  });
});

describe('the game-facing overlay route', () => {
  const file = join(SITE, 'app', 'api', 'game', 'map-overlay', 'route.ts');

  it('requires a session before answering', () => {
    const body = handlerBody(source(file), 'GET');
    expect(body).not.toBeNull();
    expect(body!).toContain('await auth()');
    expect(body!).toContain('401');
  });

  it('never grants write access: it exports no mutating handler', () => {
    const src = source(file);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(handlerBody(src, method), method).toBeNull();
    }
  });
});
