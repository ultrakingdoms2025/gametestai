import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import {
  clearTotp,
  consumeRecoveryCode,
  getUserById,
  looksLikeRecoveryCode,
  readTotpSecret,
  verifyPassword,
} from '@/lib/db';
import { verifyTotp } from '@/lib/totp';

/**
 * Turn the second factor off.
 *
 * ── What it used to be ────────────────────────────────────────────────────
 *
 *     export async function POST() {
 *       const session = await auth();
 *       if (!session?.user?.id) return 401;
 *       await setTotpSecret(session.user.id, null, false);
 *       return { ok: true };
 *     }
 *
 * A bare session, and the second factor was gone. That is the wrong bar for
 * this operation by exactly the amount 2FA is worth: the entire point of a
 * second factor is that a stolen session or a borrowed unlocked laptop is not
 * enough to act as you, and "remove the second factor" is the one request where
 * a stolen session must not be enough — it is the request that converts
 * temporary access into permanent access.
 *
 * So it now re-authenticates. Both factors, in the body, checked here:
 *
 *   - the **password**, because that is the knowledge factor and a borrowed
 *     session does not carry it;
 *   - a **current code**, because that is the possession factor and it is what
 *     is being switched off.
 *
 * ── A recovery code is accepted in place of the code ──────────────────────
 *
 * Deliberately, and it does not weaken this. Someone whose phone is in a river
 * has to be able to turn 2FA off, and the alternative to accepting a recovery
 * code here is a support ticket — which is a human being turning 2FA off on the
 * strength of a convincing email, which is a worse authentication factor than
 * the code. The recovery code is single-use and consumed by the attempt, so
 * this is not a bypass that can be replayed.
 *
 * ── The password is only required when there is one ───────────────────────
 *
 * A Google-created account has `password_hash = NULL`, so there is no password
 * to verify and demanding one would make 2FA permanent for that account. Those
 * callers must still present a code. It is not a downgrade in practice:
 * `lib/auth.ts` refuses Google sign-in for an account with 2FA enabled, so such
 * an account reached this page with a password anyway.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });

  let body: { password?: unknown; code?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 });
  }

  const password = typeof body.password === 'string' ? body.password : '';
  const code = typeof body.code === 'string' ? body.code.trim() : '';

  const user = await getUserById(session.user.id);
  if (!user) return NextResponse.json({ error: 'User not found.' }, { status: 404 });

  if (!user.totp_enabled) {
    // Nothing to remove. Idempotent rather than an error, so a double-click is
    // not a failure the user has to interpret.
    return NextResponse.json({ ok: true, alreadyDisabled: true });
  }

  /* One refusal for every wrong combination, so this cannot be used to work out
   * WHICH half was wrong — which would turn it into a password oracle for
   * anyone holding a session. */
  const refuse = () =>
    NextResponse.json(
      { error: 'That password or code was not right.' },
      { status: 401 }
    );

  if (user.password_hash) {
    if (!password) return refuse();
    if (!(await verifyPassword(user, password))) return refuse();
  }

  if (!code) return refuse();

  let secondFactorOk = false;
  if (looksLikeRecoveryCode(code)) {
    /* Consumed by the attempt whether or not the rest succeeds — a recovery
     * code that could be tried repeatedly is not single-use. Ordered after the
     * password check so a caller without the password cannot burn somebody
     * else's codes. */
    secondFactorOk = await consumeRecoveryCode(user.id, code);
  } else {
    const secret = readTotpSecret(user);
    secondFactorOk = !!secret && verifyTotp(secret, code);
  }
  if (!secondFactorOk) return refuse();

  /* Clears the secret, the pending secret and every remaining recovery code,
   * and bumps `session_epoch` so the other devices are signed out. */
  await clearTotp(user.id);
  return NextResponse.json({ ok: true });
}
