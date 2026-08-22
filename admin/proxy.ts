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

// In-memory rate limiter: IP → [timestamps]
const loginAttempts = new Map<string, number[]>();
const MAX_ATTEMPTS  = 5;
const WINDOW_MS     = 60_000; // 1 minute

function checkRateLimit(ip: string): boolean {
  const now  = Date.now();
  const hits = (loginAttempts.get(ip) ?? []).filter(t => now - t < WINDOW_MS);
  if (hits.length >= MAX_ATTEMPTS) return false;
  loginAttempts.set(ip, [...hits, now]);
  return true;
}

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

  // Rate-limit the login endpoint
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    if (!checkRateLimit(ip)) {
      return new NextResponse(JSON.stringify({ error: 'Too many login attempts' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
      });
    }
    return res;
  }

  // Public routes — no auth needed
  if (pathname.startsWith('/login') || pathname === '/') return res;

  // There used to be a `pathname.startsWith('/api/service')` branch here that
  // returned unauthenticated, on the reasoning that such routes would check an
  // API key themselves. No route was ever built under that prefix, so the branch
  // was an open door standing in front of nothing: the first file added there
  // would have been public the moment it landed. It is gone, and /api/service/*
  // now falls through to the session check below like any other API path.
  //
  // A genuine service-to-service route must verify SERVICE_API_KEY *here*, in a
  // constant-time comparison, before any handler runs — not by being skipped.

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