import { NextRequest, NextResponse } from 'next/server';
import { createHmac } from 'node:crypto';
import { consumePasswordReset, setPassword } from '@/lib/db';

function hashToken(token: string) {
  return createHmac('sha256', process.env.NEXTAUTH_SECRET ?? 'dev').update(token).digest('hex');
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
