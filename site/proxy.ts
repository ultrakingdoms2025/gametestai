import { auth } from '@/lib/auth';
import { launchCookieName, verifyLaunchCookieValue } from '@/lib/gameLaunch';
import { isGameAssetPath, isGatedGamePath } from '@/lib/gatePaths';
import { NextResponse } from 'next/server';

const PROTECTED = ['/play', '/checkout', '/store', '/account'];

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
      return NextResponse.redirect(new URL('/', nextUrl.origin));
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
