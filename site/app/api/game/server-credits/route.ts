import { NextResponse } from 'next/server';
import { openServerDb, resolveActor } from '@/lib/serverRoutes';
import { currentServerId } from '@/lib/customServers';
import {
  SERVER_CREDIT_KINDS,
  earnServerCredits,
  serverBalance,
  serverCreditHistory,
  serverBalancesFor,
} from '@/lib/serverCredits';

export const dynamic = 'force-dynamic';

/**
 * Server-scoped credits (7f).
 *
 * ── The two things this endpoint deliberately cannot do ───────────────────
 *
 * It cannot move `players.credit_balance`, because `serverCredits.ts` has no
 * function that does and this route imports nothing else that touches money.
 * And it cannot be told an amount: an earn names a KIND and an idempotency key,
 * and the amount is bounded by the kind's ceiling. Between the two, the worst a
 * forged request achieves is one capped credit inside one custom server, which
 * is the owner's economy and reaches no global board — `leaderboard.ts` refuses
 * to rank credit totals at all, in any scope.
 *
 * ── The scope comes from the selection, not the body ──────────────────────
 *
 * Same rule as chat. A client that could name the server could name someone
 * else's.
 */

export async function GET() {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });

  const db = await openServerDb();
  try {
    const serverId = await currentServerId(db, actor.playerId);
    return NextResponse.json({
      serverId,
      /* Every server balance this player holds, not only the current one, so an
       * account page can show them without one request per server. They are
       * separate ledgers and this is the only place they appear together. */
      balances: await serverBalancesFor(db, actor.playerId),
      balance: serverId ? await serverBalance(db, serverId, actor.playerId) : null,
      history: serverId ? await serverCreditHistory(db, serverId, actor.playerId, 50) : [],
      kinds: Object.values(SERVER_CREDIT_KINDS).map((k) => ({
        id: k.id, label: k.label, perEventMax: k.perEventMax, why: k.why,
      })),
    });
  } catch (err) {
    console.error('[game/server-credits] read failed:', err);
    return NextResponse.json({ error: 'Could not read server credits.' }, { status: 500 });
  } finally {
    await db.end().catch(() => {});
  }
}

/**
 * POST → report one earn inside the current server.
 *
 * `amount` is read, and then bounded by the kind's `perEventMax`. That is a
 * weaker position than the global ledger's — `creditPricing` prices most of its
 * kinds server-side — and it is deliberate: a custom server's economy is the
 * owner's, so the number has to come from the owner's own content. What the
 * platform keeps is the ceiling.
 */
export async function POST(req: Request) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });

  let body: { kind?: unknown; amount?: unknown; eventKey?: unknown; detail?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 });
  }

  const db = await openServerDb();
  try {
    const serverId = await currentServerId(db, actor.playerId);
    if (!serverId) {
      return NextResponse.json(
        { error: 'Server credits exist inside a server. Enter one first.' },
        { status: 409 }
      );
    }

    const out = await earnServerCredits(db, serverId, actor.playerId, {
      kind: String(body.kind ?? ''),
      amount: Number(body.amount ?? 0),
      eventKey: String(body.eventKey ?? ''),
      detail: body.detail == null ? undefined : String(body.detail).slice(0, 200),
    });

    /* Answered with 200 whatever the outcome, like `/api/game/credits`: a
     * refused event is not a failed request the client should retry, it is an
     * answer. The authoritative balance comes back either way. */
    return NextResponse.json({
      applied: out.applied,
      reason: out.reason,
      delta: out.delta,
      balance: out.balance,
      serverId,
    });
  } catch (err) {
    console.error('[game/server-credits] earn failed:', err);
    return NextResponse.json({ error: 'Could not record that.' }, { status: 500 });
  } finally {
    await db.end().catch(() => {});
  }
}
