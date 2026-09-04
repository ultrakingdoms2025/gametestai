import {
  createLaunchCookieValue,
  launchCookieMaxAge,
  launchCookieName,
  launchCookieUserId,
} from '@/lib/gameLaunch';
import { isGameAssetPath, isGatedGamePath } from '@/lib/gatePaths';
import { NextResponse } from 'next/server';

/*
 * `/admin` is here as DEFENCE IN DEPTH, not as the gate.
 *
 * The gate is each admin page's own `requireMarketplaceAdmin()` and each admin
 * route's, because a proxy is one request header away from being no gate at all
 * — which is why Next 16 renamed `middleware.ts` to `proxy.ts` after
 * CVE-2025-29927, and why nine unguarded admin pages leaning on a proxy was a
 * production incident here. What this line adds is that an anonymous visitor
 * meets the login page instead of a rendered shell; a signed-in non-admin still
 * gets the page's own locked banner, and neither ever reaches the data.
 */
/**
 * Paths where an anonymous visitor is sent to log in first.
 *
 * DEFENCE IN DEPTH, exactly as the note above says - never the gate. The gate
 * is each page's and each route's own check, and this list must never be the
 * reason something is safe.
 *
 * It was lost in `83dd984`, which decoupled this file from NextAuth so the
 * proxy could answer without running session crypto on every matched request.
 * That decoupling is right and is kept; dropping the redirect with it was not
 * deliberate - the note above still described it, and
 * `lib/adminRouteGuards.test.ts` still asserted it, for five route families
 * that had quietly stopped redirecting.
 */
const PROTECTED = ['/play', '/checkout', '/store', '/account', '/admin'];

/**
 * Whether the request carries an Auth.js session cookie AT ALL.
 *
 * Presence, not validity, and that is the whole design. Verifying it here
 * would put session crypto back on every matched request - the cost `83dd984`
 * removed - to re-answer a question the page behind this is about to answer
 * properly anyway. A forged cookie buys nothing: it reaches a page whose own
 * `requireMarketplaceAdmin()` or `auth()` refuses it, which is precisely the
 * "one request header away from being no gate at all" failure this file's note
 * warns about. What the check DOES buy is that a visitor with no session at
 * all meets the login page with a `callbackUrl`, instead of a rendered shell
 * that then bounces them.
 *
 * Both Auth.js v5 cookie names, because the `__Secure-` prefix is used on
 * HTTPS and the bare name in local development.
 */
function hasSessionCookie(req: import('next/server').NextRequest): boolean {
  return Boolean(
    req.cookies.get('authjs.session-token')?.value ||
      req.cookies.get('__Secure-authjs.session-token')?.value
  );
}

export default async function proxy(req: import('next/server').NextRequest) {
  const { nextUrl } = req;
  const path = nextUrl.pathname;

  /* Hashed build artefacts leave immediately, before any crypto runs.
   *
   * The matcher below already stops the function being invoked for them, so in
   * production this branch should be unreachable. It stays because a matcher is
   * one edit away from being wrong, and the cost of being right twice here is a
   * string comparison. See `lib/gatePaths.ts` for what this trades away. */
  if (isGameAssetPath(path)) return NextResponse.next();

  if (isGatedGamePath(path)) {
    const launchCookie = req.cookies.get(launchCookieName())?.value;
    const userId = await launchCookieUserId(launchCookie);
    if (!userId) {
      return NextResponse.redirect(new URL('/', nextUrl.origin));
    }

    return NextResponse.next();
  }

  if (
    PROTECTED.some((p) => path === p || path.startsWith(p + '/')) &&
    !hasSessionCookie(req)
  ) {
    const loginUrl = new URL('/login', nextUrl.origin);
    loginUrl.searchParams.set('callbackUrl', nextUrl.href);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

/*
 * `game/assets` and `game/vendor` are excluded so the function is never invoked
 * for them at all — the runtime guard above only helps once you are already
 * paying for an invocation. Vercel runs middleware BEFORE the cache, so this is
 * the only place the per-asset cost can actually be removed.
 *
 * Next requires this to be a statically analysable literal, so it cannot import
 * GAME_ASSET_PREFIX. `lib/gatePaths.test.ts` pins the two together textually
 * instead, and fails if either drifts.
 */
export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|game/assets|game/vendor).*)'],
};
