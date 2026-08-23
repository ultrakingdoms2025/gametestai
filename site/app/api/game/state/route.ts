import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import {
  findOrCreatePlayer,
  getGameState,
  saveGameState,
  recordGameTrade,
} from '@/lib/playerDb';
import { getUserById } from '@/lib/db';

export const dynamic = 'force-dynamic';

/** GET → the last game state snapshot saved for this account. */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
  }
  const state = await getGameState(session.user.id);
  return NextResponse.json({ state });
}

/**
 * POST → persist the live game state.
 * Body: { state?: object, trades?: Array<{kind, itemName, credits, qty}> }
 *
 * ── The hole this route used to be ────────────────────────────────────────
 *
 * It took `credits` from the body and wrote it to `players.credit_balance` with
 * only a non-negative check, every ~1.5 s and on `pagehide`. A player's balance
 * was whatever their browser last said it was. That is closed: the balance moves
 * only through `credit_events`, via POST /api/game/credits, which prices what it
 * can and bounds what it cannot.
 *
 * A `credits` field in the body is now IGNORED rather than rejected. That is
 * deliberate: a browser holding a cached copy of the old bundle will keep
 * sending one for as long as its tab is open, and answering 400 would stop that
 * player's INVENTORY saving too — punishing them for our deploy timing. Ignoring
 * it costs nothing, because the field no longer reaches a write.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
  }

  let body: {
    state?: unknown;
    trades?: Array<{ kind?: unknown; itemName?: unknown; credits?: unknown; qty?: unknown }>;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  // Make sure the player row exists before writing to it.
  const user = await getUserById(session.user.id);
  if (user) await findOrCreatePlayer(session.user.id, user.email);

  const saved = await saveGameState(session.user.id, body.state ?? null);
  if (!saved) {
    return NextResponse.json({ error: 'Player profile not found.' }, { status: 404 });
  }

  // Record merchant trades for the admin purchase history (best-effort).
  if (Array.isArray(body.trades)) {
    for (const trade of body.trades.slice(0, 50)) {
      const kind = trade?.kind === 'sell' ? 'sell' : trade?.kind === 'buy' ? 'buy' : null;
      const tradeCredits = Number(trade?.credits);
      if (!kind || !Number.isFinite(tradeCredits)) continue;
      try {
        await recordGameTrade({
          siteUserId: session.user.id,
          kind,
          itemName: String(trade?.itemName ?? 'item'),
          credits: tradeCredits,
          qty: Number(trade?.qty) || 1,
        });
      } catch (err) {
        console.error('[game/state] trade record failed:', err);
      }
    }
  }

  return NextResponse.json({ ok: true });
}
