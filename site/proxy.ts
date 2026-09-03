import { auth } from '@/lib/auth';
import {
  createLaunchCookieValue,
  launchCookieMaxAge,
  launchCookieName,
  verifyLaunchCookieValue,
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
const PROTECTED = ['/play', '/checkout', '/store', '/account', '/admin'];

export default auth(async (req) => {
  const { nextUrl } = req;
  const path = nextUrl.pathname;
  const session = req.auth;

  /* Hashed build artefacts leave immediately, before any crypto runs.
   *
   * The matcher below already stops the function being invoked for them, so in
   * production this branch should be unreachable. It stays because a matcher is
   * one edit away from being wrong, and the cost of being right twice here is a
   * string comparison. See `lib/gatePaths.ts` for what this trades away. */
  if (isGameAssetPath(path)) return NextResponse.next();

  if (isGatedGamePath(path)) {
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.redirect(new URL('/', nextUrl.origin));
    }

    const launchCookie = req.cookies.get(launchCookieName())?.value;
    const ok = await verifyLaunchCookieValue(launchCookie, userId);
    if (!ok) {
      /* A valid session is enough to issue a fresh launch pass. The iframe can
       * otherwise lose the first Set-Cookie redirect and strand the player at
       * the public home page on the next request. */
      const res = NextResponse.redirect(new URL('/game/index.html', nextUrl.origin), 307);
      res.cookies.set(launchCookieName(), await createLaunchCookieValue(userId), {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: launchCookieMaxAge(),
      });
      return res;
    }

    return NextResponse.next();
  }

  const isProtected = PROTECTED.some((p) => path === p || path.startsWith(p + '/'));
  if (isProtected && !session) {
    const loginUrl = new URL('/login', nextUrl.origin);
    loginUrl.searchParams.set('callbackUrl', nextUrl.href);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
});

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
