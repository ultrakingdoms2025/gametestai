import { NextRequest, NextResponse } from 'next/server';
import { getIronSession } from 'iron-session';
import type { SessionData } from '@/lib/session';

const SESSION_COOKIE = 'an_admin_v1';
const COOKIE_OPTIONS = { httpOnly: true, sameSite: 'strict' as const, secure: true };

/**
 * Iron-session needs at least 32 characters of secret.
 *
 * This used to read `process.env.SESSION_SECRET ?? 'fallback-replace-me-32-chars-!!!'`,
 * so a deployment missing the variable verified admin sessions against a constant
 * published in this repository — while `lib/session.ts`, reading the same variable,
 * correctly threw. Two files disagreeing about whether a secret is optional is the
 * bug; the middleware is brought into line with the library.
 *
 * It throws at the point of use rather than at module load, so a misconfigured
 * deployment fails closed on protected routes instead of taking the whole app
 * down, and the reason reaches the server log rather than a blank page.
 */
function sessionOptions() {
  const password = process.env.SESSION_SECRET;
  if (!password || password.length < 32) {
    throw new Error('SESSION_SECRET is missing or shorter than 32 characters');
  }
  return { cookieName: SESSION_COOKIE, password, cookieOptions: COOKIE_OPTIONS };
}

/*
 * There used to be a login rate limiter here: a module-level
 * `Map<string, number[]>` keyed on `x-forwarded-for`.split(',')[0]. It was the
 * only control in front of admin password + TOTP guessing, and it stopped
 * nobody. The Map lives in ONE serverless instance's memory, and Vercel runs
 * many instances concurrently and recycles them at will, so "five per minute"
 * was five per minute per lambda. Worse, the leftmost element of
 * `x-forwarded-for` is whatever the CLIENT wrote there, so varying one header
 * bought an unlimited supply of fresh buckets.
 *
 * The limit now lives in Postgres, where every instance sees the same counter,
 * and is keyed on the submitted USERNAME as well as on an address the caller
 * does not choose. That has to be in the route handler rather than here,
 * because the proxy cannot read the username without consuming the body — see
 * `lib/loginThrottle.ts` and `app/api/auth/login/route.ts`.
 */

const securityHeaders: Record<string, string> = {
  'X-Frame-Options':           'DENY',
  'X-Content-Type-Options':    'nosniff',
  'Referrer-Policy':           'same-origin',
  'Permissions-Policy':        'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none';",
};

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const res = NextResponse.next();

  // Apply security headers to all responses
  for (const [k, v] of Object.entries(securityHeaders)) res.headers.set(k, v);

  // The login endpoint throttles itself, in shared storage. See above.
  if (pathname === '/api/auth/login' && req.method === 'POST') return res;

  // Public routes — no auth needed
  if (pathname.startsWith('/login') || pathname === '/') return res;

  // There used to be a `pathname.startsWith('/api/service')` branch here that
  // returned unauthenticated, on the reasoning that such routes would check an
  // API key themselves. No route was ever built under that prefix, so the branch
  // was an open door standing in front of nothing: the first file added there
  // would have been public the moment it landed. It is gone, and /api/service/*
  // now falls through to the session check below like any other API path.
  //
  // A genuine service-to-service route must verify its own shared secret *here*,
  // in a constant-time comparison, before any handler runs — not by being
  // skipped. There is deliberately no such secret configured: `SERVICE_API_KEY`
  // used to be named here and in `.env.local.example`, was read by nothing, and
  // was byte-identical to the site's copy. An unused credential that three
  // environments share is a liability with no upside, so it is gone. Mint one
  // WITH the route that needs it, per environment.

  // Dashboard + admin API — require valid session.
  //
  // This is defence in depth, never the only gate. Next 16 renamed this file
  // from middleware.ts to proxy.ts partly because of CVE-2025-29927, a
  // middleware auth bypass driven by a request header; a proxy that is the sole
  // protection is one header away from being no protection. Every page under
  // /dashboard and every handler under /api must call requireSession() itself.
  if (pathname.startsWith('/dashboard') || pathname.startsWith('/api/')) {
    let session;
    try {
      session = await getIronSession<SessionData>(req, res, sessionOptions());
    } catch (err) {
      // A missing or too-short SESSION_SECRET lands here. Say nothing useful to
      // the caller; say exactly what is wrong in the log.
      console.error(
        '[admin/proxy] cannot verify sessions:',
        err instanceof Error ? err.message : String(err)
      );
      return new NextResponse(JSON.stringify({ error: 'Service unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (!session.adminId) {
      if (pathname.startsWith('/api/')) {
        return new NextResponse(JSON.stringify({ error: 'Unauthorised' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return NextResponse.redirect(new URL('/login', req.url));
    }
  }

  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};