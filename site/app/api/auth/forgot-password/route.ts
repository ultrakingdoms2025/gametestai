import { NextRequest, NextResponse } from 'next/server';
import { createHmac, randomBytes } from 'node:crypto';
import { getUserByEmail, createPasswordReset } from '@/lib/db';
import { sendPasswordResetEmail } from '@/lib/email';

function hashToken(token: string) {
  return createHmac('sha256', process.env.NEXTAUTH_SECRET ?? 'dev').update(token).digest('hex');
}

function siteUrl() {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return 'http://localhost:3000';
}

export async function POST(req: NextRequest) {
  try {
    const { email } = await req.json();
    if (!email || typeof email !== 'string') {
      return NextResponse.json({ error: 'Email is required.' }, { status: 400 });
    }

    const user = await getUserByEmail(email.toLowerCase().trim());

    // Always respond ok to prevent email enumeration
    if (!user) {
      return NextResponse.json({ ok: true });
    }

    const token = randomBytes(32).toString('hex');
    const tokenHash = hashToken(token);
    await createPasswordReset(user.id, tokenHash);

    const resetUrl = `${siteUrl()}/reset-password?token=${token}`;
    await sendPasswordResetEmail(user.email, resetUrl);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[forgot-password]', err);
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 });
  }
}
