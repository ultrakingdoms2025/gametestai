import type { NextRequest } from 'next/server';
import { handlers } from '@/lib/auth';
import { RATE_LIMITS, clientIp, consumeRateLimit, tooManyRequests } from '@/lib/rateLimit';

/**
 * NextAuth's own endpoints, with a limiter in front of the one that guesses.
 *
 * ── Why here and not in `proxy.ts` ────────────────────────────────────────
 *
 * The limit has to be keyed on the submitted EMAIL as well as on the address,
 * and the email is in the request body. A proxy that read it would have to
 * consume the body before the handler gets it, which is the reason
 * `admin/proxy.ts` could only ever limit by IP — and limiting by IP alone is
 * defeated by a botnet and punishes a shared NAT. Reading it here, from a
 * clone, keeps both keys and leaves the original body intact for NextAuth.
 *
 * ── Only the credentials callback ─────────────────────────────────────────
 *
 * `POST /api/auth/*` also covers signout, session and CSRF-token fetches, and
 * throttling those would break ordinary use for no benefit — none of them is a
 * guess at somebody's password. `/callback/credentials` is the one where a
 * success is an account.
 *
 * GET is passed straight through: nothing under it changes state.
 */

export const { GET } = handlers;

export async function POST(req: NextRequest) {
  if (new URL(req.url).pathname.endsWith('/callback/credentials')) {
    let identifier = '';
    try {
      /* A CLONE. Reading the body off `req` would leave NextAuth with a
       * consumed stream and every sign-in would fail — a limiter that breaks
       * the thing it protects. */
      const form = await req.clone().formData();
      identifier = String(form.get('email') ?? '').toLowerCase().trim();
    } catch {
      /* Not form-encoded, or already consumed. Fall back to the address alone
       * rather than skipping the limit: a caller who cannot be identified is
       * not a caller who should be exempt. */
    }

    const verdict = await consumeRateLimit(
      'auth:signin',
      [
        { namespace: 'ip', value: clientIp(req) },
        ...(identifier ? [{ namespace: 'email', value: identifier }] : []),
      ],
      RATE_LIMITS.signIn
    );
    if (!verdict.allowed) {
      return tooManyRequests(verdict, 'Too many sign-in attempts. Try again shortly.');
    }
  }

  return handlers.POST(req);
}
