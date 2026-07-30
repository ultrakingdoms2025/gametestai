import { auth } from '@/lib/auth';
import { NextResponse } from 'next/server';

const PROTECTED = ['/play', '/checkout', '/store', '/account'];

export default auth((req) => {
  const { nextUrl } = req;
  const path = nextUrl.pathname;
  const session = req.auth;

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
