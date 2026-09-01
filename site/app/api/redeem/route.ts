import { NextResponse } from 'next/server';
import { auditServerAction, openServerDb, resolveActor } from '@/lib/serverRoutes';
import { REDEEM_MESSAGES, redeemAccessCode } from '@/lib/accessCodes';
import { getPlayerStatus } from '@/lib/playerDb';
import { auth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Redeem an access code.
 *
 * ── Why this needs a session, and the login page knows it ─────────────────
 *
 * A grant has to belong to somebody. Access is a pair of columns on a `players`
 * row and a comped server slot is an entitlement keyed on a player id, so there
 * is no version of this that hands 30 days to a browser. The login page's
 * "play free with a code" route therefore takes the code first and the account
 * second, holding the code client-side across the sign-in rather than putting it
 * in a URL — a bearer credential in a query string ends up in history, in
 * referrers and in access logs.
 *
 * ── No rate limiter, deliberately ─────────────────────────────────────────
 *
 * A code is 60 bits over an alphabet with no dictionary behind it, and the only
 * thing an attacker can do with this endpoint is guess one. At that width a
 * guessing run needs on the order of 10^18 requests for one hit, which is not
 * something a limiter is protecting against — it would be theatre in front of
 * arithmetic that has already won. What DOES matter is that every refusal costs
 * the same database round trips whether the code exists or not, which the
 * single hashed lookup gives for free.
 *
 * If codes are ever shortened, or minted from anything less than
 * `mintAccessCode`, this paragraph stops being true and a limiter becomes real
 * work rather than decoration.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { ok: false, reason: 'signed_out', message: 'Sign in first, then redeem your code.' },
      { status: 401 }
    );
  }

  let code = '';
  try {
    const body = await req.json();
    code = typeof body?.code === 'string' ? body.code : '';
  } catch {
    return NextResponse.json(
      { ok: false, reason: 'malformed', message: REDEEM_MESSAGES.malformed },
      { status: 400 }
    );
  }

  const actor = await resolveActor();
  if (!actor) {
    return NextResponse.json(
      { ok: false, reason: 'signed_out', message: 'Sign in first, then redeem your code.' },
      { status: 401 }
    );
  }

  let db: Awaited<ReturnType<typeof openServerDb>> | null = null;
  try {
    /* The custom-server schema, not just the code schema: a `server` code
     * writes an entitlement, and `writeEntitlement` needs `server_entitlements`
     * to exist. Ensuring it here rather than discovering it missing halfway
     * through a redemption is the same "works warm, 500s cold" lesson the rest
     * of these routes are built on. */
    db = await openServerDb();
    const outcome = await redeemAccessCode(db, { code, playerId: actor.playerId });

    if (!outcome.ok) {
      /* A refused redemption is audited too. "Somebody tried a withdrawn code
       * forty times" is exactly the shape of thing an operator wants to be able
       * to find after the fact, and it is invisible if only successes are
       * written down. */
      await auditServerAction(db, actor, 'access_code.refused', `player:${actor.playerId}`, {
        reason: outcome.reason,
      });
      return NextResponse.json(
        { ok: false, reason: outcome.reason, message: REDEEM_MESSAGES[outcome.reason] },
        { status: outcome.reason === 'grant_failed' ? 500 : 400 }
      );
    }

    await auditServerAction(db, actor, 'access_code.redeemed', `player:${actor.playerId}`, {
      kind: outcome.kind,
      days: outcome.days,
      label: outcome.label,
    });

    /* Read the resulting state back rather than computing what it ought to be.
     * The days a player ends up with depend on what they already had, and a
     * confirmation screen that says "30 days" to somebody who now has 42 is a
     * support ticket about the 12 that went missing. */
    const status = await getPlayerStatus(session.user.id);
    return NextResponse.json({
      ok: true,
      kind: outcome.kind,
      days: outcome.days,
      label: outcome.label,
      daysRemaining: status?.daysRemaining ?? 0,
    });
  } catch (err) {
    console.error('[redeem] Could not redeem an access code:', err);
    return NextResponse.json(
      { ok: false, reason: 'grant_failed', message: REDEEM_MESSAGES.grant_failed },
      { status: 500 }
    );
  } finally {
    await db?.end().catch(() => {});
  }
}
