import { NextRequest, NextResponse } from 'next/server';
import { toDataURL } from 'qrcode';
import { auth } from '@/lib/auth';
import {
  countUnusedRecoveryCodes,
  generateRecoveryCodes,
  getUserById,
  promoteTotpSecret,
  readPendingTotpSecret,
  setPendingTotpSecret,
} from '@/lib/db';
import { verifyTotp, generateTotpSecret } from '@/lib/totp';

/**
 * Enrol a second factor.
 *
 * ── What this route was, and why a GET was the whole bug ──────────────────
 *
 * Enrolment used to be `GET`, and it wrote:
 *
 *     await setTotpSecret(session.user.id, secret, false);
 *
 * — a brand-new secret straight over the live one, with `totp_enabled = false`.
 * So merely LOADING this URL destroyed a working second factor. A GET is a
 * link, an image, a prefetch, a preview crawler; anything that persuaded a
 * signed-in victim's browser to fetch this path silently stripped their 2FA and
 * left the account on a password alone, with the account page still cheerfully
 * reporting that 2FA was on until the next reload.
 *
 * Three things changed, and they are separable:
 *
 *   1. **Enrolment is a POST.** State-changing verbs are not idempotent GETs,
 *      and a cross-origin POST cannot be provoked by a link or an `<img>`.
 *   2. **It writes to `totp_pending_secret`, never to `totp_secret`.** An
 *      enrolment that is started and abandoned now leaves the working factor
 *      untouched, because it never had permission to touch it. Only
 *      `promoteTotpSecret` — which runs after a code has verified — moves a
 *      secret into the live column.
 *   3. **An account that already has 2FA is refused outright.** Re-enrolling
 *      over a working factor is not something a legitimate flow needs and it is
 *      exactly what an attacker with a borrowed session would want. Turn it off
 *      first, which needs the password AND a current code.
 *
 * `GET` survives as a genuinely read-only status endpoint. That is deliberate
 * rather than tidy: the old vulnerable URL is still out there in browser
 * histories and bookmarks, and the safest thing it can now do is answer a
 * question.
 *
 * ── Recovery codes are issued here, once ──────────────────────────────────
 *
 * They come back from the confirm step and are never retrievable again — they
 * are stored as HMACs, so the server genuinely cannot show them a second time.
 * See `lib/db.ts`. Issuing them at confirm rather than at begin means an
 * abandoned enrolment does not leave live codes lying around for a secret
 * nobody adopted.
 */

/** Read-only. Tells the account page what to render; changes nothing. */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });

  const user = await getUserById(session.user.id);
  if (!user) return NextResponse.json({ error: 'User not found.' }, { status: 404 });

  return NextResponse.json({
    enabled: !!user.totp_enabled,
    enrolmentPending: !!user.totp_pending_secret,
    recoveryCodesRemaining: user.totp_enabled
      ? await countUnusedRecoveryCodes(user.id)
      : 0,
  });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });

  let body: { step?: unknown; code?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 });
  }

  const user = await getUserById(session.user.id);
  if (!user) return NextResponse.json({ error: 'User not found.' }, { status: 404 });

  /* Both steps refuse an account that already has a working factor. The check
   * is repeated per branch rather than hoisted so that neither can be reached
   * by adding a third step later and forgetting it. */
  const step = body.step === 'confirm' ? 'confirm' : body.step === 'begin' ? 'begin' : null;
  if (!step) {
    return NextResponse.json({ error: "step must be 'begin' or 'confirm'." }, { status: 400 });
  }

  if (step === 'begin') {
    if (user.totp_enabled) {
      /* Not an error the UI needs to dress up — but it must not be a silent
       * success either, because a silent success here is how the old route
       * cleared a factor it had no business touching. */
      return NextResponse.json(
        { error: 'Two-factor authentication is already enabled. Turn it off first.' },
        { status: 409 }
      );
    }
    /* AN ACCOUNT WITH NO PASSWORD CANNOT MEANINGFULLY HAVE A SECOND FACTOR.
     *
     * A Google-created account has `password_hash = NULL`, so the credentials
     * provider refuses it outright and Google is its only way in. `lib/auth.ts`
     * cannot enforce TOTP on an OAuth redirect — there is nowhere to type a
     * code — and it deliberately does NOT refuse Google for such an account,
     * because that would be a permanent lockout.
     *
     * Enrolling here would therefore produce exactly the failure this codebase
     * has already paid for once: an account page reporting a second factor that
     * no sign-in path checks. Better to refuse and say what to do about it. A
     * Google user can set a password through the ordinary forgot-password flow
     * and then enrol for real. */
    if (!user.password_hash) {
      return NextResponse.json(
        {
          error:
            'Set a password before enabling two-factor authentication. Google '
            + 'sign-in cannot ask for a code, so a second factor on an account '
            + 'with no password would not be enforced.',
        },
        { status: 409 }
      );
    }

    const secret = generateTotpSecret();
    const otpauth =
      `otpauth://totp/Aether%20Nexus:${encodeURIComponent(user.email)}`
      + `?secret=${secret}&issuer=Aether%20Nexus`;
    const qrDataUrl = await toDataURL(otpauth);

    /* The PENDING column. Nothing about the live factor moves until a code has
     * proved the phone and the server agree. */
    await setPendingTotpSecret(user.id, secret);
    return NextResponse.json({ secret, qrDataUrl });
  }

  // step === 'confirm'
  if (user.totp_enabled) {
    return NextResponse.json(
      { error: 'Two-factor authentication is already enabled.' },
      { status: 409 }
    );
  }

  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!code) return NextResponse.json({ error: 'Code is required.' }, { status: 400 });

  const pending = readPendingTotpSecret(user);
  if (!pending) return NextResponse.json({ error: 'Setup not started.' }, { status: 400 });
  if (!verifyTotp(pending, code)) {
    return NextResponse.json({ error: 'Invalid code. Try again.' }, { status: 400 });
  }

  /* Promote and issue the codes in one transaction — an account left with
   * `totp_enabled = true` and no recovery codes is one lost phone from a
   * permanent lockout, which is the state this whole change exists to remove. */
  const recoveryCodes = generateRecoveryCodes();
  await promoteTotpSecret(user.id, pending, recoveryCodes);

  return NextResponse.json({
    ok: true,
    /* Shown once. They are stored as HMACs, so this is genuinely the only time
     * they can be displayed — the UI must say so before the user navigates
     * away. */
    recoveryCodes,
  });
}
