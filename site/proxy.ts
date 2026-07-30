import { auth } from '@/lib/auth';
import { launchCookieName, verifyLaunchCookieValue } from '@/lib/gameLaunch';
import { NextResponse } from 'next/server';

const PROTECTED = ['/play', '/checkout', '/store', '/account'];

export default auth(async (req) => {
  const { nextUrl } = req;
  const path = nextUrl.pathname;
  const session = req.auth;

  const isGame = path === '/game' || path.startsWith('/game/');
  if (isGame) {
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

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
