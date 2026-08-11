import { getIronSession, type IronSession, type SessionOptions } from 'iron-session';
import { cookies } from 'next/headers';

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