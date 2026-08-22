import { getIronSession, type IronSession, type SessionOptions } from 'iron-session';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

export interface SessionData {
  adminId:  string;
  username: string;
  loginAt:  number;  // Unix ms
}

function sessionOptions(): SessionOptions {
  const pw = process.env.SESSION_SECRET ?? '';
  if (pw.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  return {
    cookieName: 'an_admin_v1',
    password:   pw,
    cookieOptions: {
      secure:   process.env.NODE_ENV === 'production',
      httpOnly: true,
      sameSite: 'strict',
      maxAge:   60 * 60 * 8, // 8 hours
    },
  };
}

export async function getSession(): Promise<IronSession<SessionData>> {
  const store = await cookies();
  return getIronSession<SessionData>(store, sessionOptions());
}

export async function requireSession(): Promise<SessionData> {
  const session = await getSession();
  if (!session.adminId) throw new Error('Unauthenticated');
  return { adminId: session.adminId, username: session.username, loginAt: session.loginAt };
}

/**
 * The page-shaped guard: redirect to /login instead of throwing.
 *
 * `requireSession` is right for a route handler, where a throw becomes a 500 and
 * the caller is a script. On a page a throw is an error screen, so a dashboard
 * page should use this instead.
 *
 * It exists because four pages had no guard of their own and leaned entirely on
 * `proxy.ts` — among them the overview (player counts and purchase revenue), the
 * audit log, and the player list with its PII. Next 16 renamed middleware.ts to
 * proxy.ts partly because of CVE-2025-29927, a middleware auth bypass driven by
 * a request header: a proxy that is the only gate is one header away from being
 * no gate. The proxy stays as defence in depth; this is the gate.
 */
export async function requireAdminPage(): Promise<SessionData> {
  const session = await getSession();
  if (!session.adminId) redirect('/login');
  return { adminId: session.adminId, username: session.username, loginAt: session.loginAt };
}