import { NextRequest, NextResponse } from 'next/server';
import { createHmac } from 'node:crypto';
import { appSecret } from '@/lib/appSecret';
import { consumePasswordReset, setPassword } from '@/lib/db';

/**
 * Must hash IDENTICALLY to `forgot-password`, or no reset link ever matches.
 *
 * Both used `process.env.NEXTAUTH_SECRET ?? 'dev'`. With the variable unset,
 * every reset token in `site_password_resets` was an HMAC under the key `'dev'`
 * — so a leaked table is a list of working account takeovers, and the pair
 * agreed only because they were wrong in the same way. `appSecret()` refuses to
 * produce a key at all rather than falling back; see `lib/appSecret.ts`.
 */
function hashToken(token: string) {
  return createHmac('sha256', appSecret()).update(token).digest('hex');
}

export async function POST(req: NextRequest) {
  try {
    const { token, password } = await req.json();
    if (!token || !password || typeof token !== 'string' || typeof password !== 'string') {
      return NextResponse.json({ error: 'Token and password are required.' }, { status: 400 });
    }
    if (password.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters.' }, { status: 400 });
    }
    const tokenHash = hashToken(token);
    const userId = await consumePasswordReset(tokenHash);
    if (!userId) {
      return NextResponse.json({ error: 'This reset link is invalid or has expired.' }, { status: 400 });
    }
    await setPassword(userId, password);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[reset-password]', err);
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 });
  }
}
