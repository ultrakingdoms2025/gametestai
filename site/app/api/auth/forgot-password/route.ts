import { NextRequest, NextResponse } from 'next/server';
import { createHmac, randomBytes } from 'node:crypto';
import { getUserByEmail, createPasswordReset } from '@/lib/db';
import { sendPasswordResetEmail } from '@/lib/email';
import { appSecret } from '@/lib/appSecret';
import { RATE_LIMITS, clientIp, consumeRateLimit, tooManyRequests } from '@/lib/rateLimit';

/**
 * The reset token is stored as an HMAC, so the key is what makes a stolen
 * `site_password_resets` dump useless.
 *
 * It used to fall back to the string `'dev'`. With that key a leaked table is a
 * list of working reset tokens: hash a guess, match the row, take the account.
 * `appSecret()` refuses rather than falling back — see `lib/appSecret.ts`.
 */
function hashToken(token: string) {
  return createHmac('sha256', appSecret()).update(token).digest('hex');
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

    const normalized = email.toLowerCase().trim();

    /* A reset request SENDS MAIL to an address the caller names, so an
     * unlimited one is a way to have this domain deliver repeatedly to anybody
     * — which costs the recipient, our sending reputation, and eventually the
     * ability to deliver a real reset. Keyed on the address as well as the IP,
     * so a rotating source cannot keep mailing one victim. */
    const verdict = await consumeRateLimit(
      'auth:forgot',
      [
        { namespace: 'ip', value: clientIp(req) },
        { namespace: 'email', value: normalized },
      ],
      RATE_LIMITS.forgotPassword
    );
    if (!verdict.allowed) {
      /* The generic message, not "you have asked too often for THAT address" —
       * a differentiated 429 would put the enumeration oracle back that the
       * `{ ok: true }` below exists to remove. */
      return tooManyRequests(verdict, 'Too many requests. Try again shortly.');
    }

    const user = await getUserByEmail(normalized);

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
