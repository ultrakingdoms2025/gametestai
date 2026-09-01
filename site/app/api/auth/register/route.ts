import { NextRequest, NextResponse } from 'next/server';
import { getUserByEmail, createUser } from '@/lib/db';
import { sendWelcomeEmail } from '@/lib/email';
import { isHandleAvailable, normalizeHandle, syncPlayerProfile } from '@/lib/playerDb';
import { RATE_LIMITS, clientIp, consumeRateLimit, tooManyRequests } from '@/lib/rateLimit';

/**
 * Create an account.
 *
 * ── It no longer says whether an address is already registered ────────────
 *
 * This used to answer `409 An account with that email already exists.`, which
 * is a membership oracle: anyone could ask this endpoint, one address at a
 * time, whether a given person has an account here. `forgot-password` right
 * next door has always been careful about exactly this — "Always respond ok to
 * prevent email enumeration" — and the two endpoints contradicted each other,
 * so the careful one bought nothing.
 *
 * It now answers the same `{ ok: true }` either way and creates nothing when
 * the address is taken.
 *
 * ── The cost of that, stated plainly ──────────────────────────────────────
 *
 * Someone who has forgotten they already have an account now sees a success
 * message and then cannot sign in with the password they just chose. The
 * standard remedy is to email the EXISTING address ("someone tried to register
 * with this address; sign in or reset your password"), which tells the real
 * owner and tells the prober nothing. That wants a template in `lib/email.ts`
 * and is the right follow-up; until it exists the ambiguity is on the login
 * page's "Forgot your password?" link.
 *
 * The HANDLE 409 below is deliberately kept. Handles are public — they are
 * printed on the leaderboard — so refusing a taken one discloses nothing that
 * is not already on a page, and a signup form has to be able to say "pick
 * another name".
 */
export async function POST(req: NextRequest) {
  try {
    const { email, password, handle } = await req.json();
    if (!email || !password || !handle || typeof email !== 'string' || typeof password !== 'string' || typeof handle !== 'string') {
      return NextResponse.json({ error: 'Email, handle, and password are required.' }, { status: 400 });
    }
    if (password.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters.' }, { status: 400 });
    }
    const normalizedHandle = normalizeHandle(handle);
    if (normalizedHandle.length < 3) {
      return NextResponse.json({ error: 'Handle must be at least 3 characters.' }, { status: 400 });
    }
    const normalized = email.toLowerCase().trim();

    /* Limited on the address AND on the submitted email, after the cheap
     * validation and before the first database read, so a script cannot use
     * this endpoint to walk a list of addresses at speed even though every
     * answer now looks the same. */
    const verdict = await consumeRateLimit(
      'auth:register',
      [
        { namespace: 'ip', value: clientIp(req) },
        { namespace: 'email', value: normalized },
      ],
      RATE_LIMITS.register
    );
    if (!verdict.allowed) {
      return tooManyRequests(verdict, 'Too many sign-up attempts. Try again shortly.');
    }

    const existing = await getUserByEmail(normalized);
    if (existing) {
      /* The same answer as the happy path. See the docblock: a 409 here made
       * `forgot-password`'s enumeration guard pointless. Logged so the pattern
       * is still visible to us, and nothing is written. */
      console.warn('[register] sign-up attempted for an address that already exists.');
      return NextResponse.json({ ok: true });
    }
    if (!(await isHandleAvailable(normalizedHandle))) {
      return NextResponse.json({ error: 'That handle is already in use.' }, { status: 409 });
    }
    const user = await createUser({ email: normalized, password });
    await syncPlayerProfile(user.id, normalized, {
      handle: normalizedHandle,
      fullName: normalizedHandle,
      overwrite: true,
    });
    try {
      await sendWelcomeEmail(normalized, normalizedHandle);
    } catch (err) {
      console.error('[register] Failed to send welcome email:', err);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[register]', err);
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 });
  }
}
