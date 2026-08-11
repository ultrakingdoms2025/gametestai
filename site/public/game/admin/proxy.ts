import { NextRequest, NextResponse } from 'next/server';
import { getIronSession } from 'iron-session';
import type { SessionData } from '@/lib/session';

const SESSION_OPTS = {
  cookieName: 'an_admin_v1',
  password:   process.env.SESSION_SECRET ?? 'fallback-replace-me-32-chars-!!!',
  cookieOptions: { httpOnly: true, sameSite: 'strict' as const, secure: true },
};

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

  // Service API — use API key not session
  if (pathname.startsWith('/api/service')) return res;

  // Dashboard + admin API — require valid session
  if (pathname.startsWith('/dashboard') || pathname.startsWith('/api/')) {
    const session = await getIronSession<SessionData>(req, res, SESSION_OPTS);
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