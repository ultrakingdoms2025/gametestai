import { NextResponse } from 'next/server';
import { getAccessStateForSession } from '@/lib/access';
import { auth } from '@/lib/auth';
import {
  createLaunchCookieValue,
  launchCookieMaxAge,
  launchCookieName,
} from '@/lib/gameLaunch';

export async function GET(req: Request) {
  const session = await auth();
  const { hasAccess } = await getAccessStateForSession(session);
  const userId = session?.user?.id;

  if (!userId) {
    return NextResponse.redirect(new URL('/login?callbackUrl=%2Fplay', req.url), 303);
  }

  if (!hasAccess) {
    return NextResponse.redirect(new URL('/checkout?intent=entry', req.url), 303);
  }

  const res = NextResponse.redirect(new URL('/game/index.html', req.url), 303);
  res.cookies.set(launchCookieName(), await createLaunchCookieValue(userId), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: launchCookieMaxAge(),
  });
  return res;
}
