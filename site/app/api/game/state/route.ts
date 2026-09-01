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
  if (!saved.ok) {
    if (saved.reason === 'no_player') {
      return NextResponse.json({ error: 'Player profile not found.' }, { status: 404 });
    }
    /* REFUSED, not truncated. The old code `slice()`d the JSON at 200,000
     * characters, which cuts mid-token and stores an unparseable fragment --
     * so the next read threw, returned null, and the player's whole save was
     * gone with no error anywhere. Saying no is the only outcome that leaves
     * the previous good save standing. */
    console.error(`[game/state] refused a malformed save: ${saved.detail}`);
    return NextResponse.json(
      { error: 'That save was rejected.', detail: saved.detail },
      { status: 400 }
    );
  }
  if (saved.dropped.length) {
    console.warn(`[game/state] dropped unknown state keys: ${saved.dropped.join(', ')}`);
  }

  /* Record merchant trades for the admin purchase history (best-effort).
   *
   * ── These rows are the CLIENT's word and are marked as such ─────────────
   *
   * `recordGameTrade` writes into `purchases`, the table the admin app reports
   * revenue and activity from, and nothing here witnessed the trade. Two things
   * follow, and both were missing.
   *
   * The numbers were unbounded: `Number.isFinite` accepts `-1e15` and `1e15`
   * alike, so a signed-in caller could write any figure at all into the admin's
   * reporting table -- including negatives, which subtract from whatever
   * aggregate reads the column. They are bounded below.
   *
   * And the rows were indistinguishable from settled Stripe purchases once
   * written. They now carry an explicit marker so reporting can exclude them;
   * see `recordGameTrade`. */
  if (Array.isArray(body.trades)) {
    for (const trade of body.trades.slice(0, 50)) {
      const kind = trade?.kind === 'sell' ? 'sell' : trade?.kind === 'buy' ? 'buy' : null;
      if (!kind) continue;

      /* 0 < n <= 1,000,000. The upper bound is far above any single trade the
       * shipped catalogue can produce and the lower bound is what stops a
       * negative "sale" being written into a revenue column. A trade outside
       * the range is DROPPED rather than clamped: clamping would put a wrong
       * number in the ledger and leave no sign that it was wrong. */
      const tradeCredits = Number(trade?.credits);
      if (!Number.isFinite(tradeCredits) || tradeCredits <= 0 || tradeCredits > 1_000_000) {
        console.warn('[game/state] dropped a trade with an out-of-range credit figure.');
        continue;
      }
      const qty = Number(trade?.qty);
      if (!Number.isFinite(qty) || qty < 1 || qty > 999) {
        console.warn('[game/state] dropped a trade with an out-of-range quantity.');
        continue;
      }

      try {
        await recordGameTrade({
          siteUserId: session.user.id,
          kind,
          itemName: String(trade?.itemName ?? 'item'),
          credits: tradeCredits,
          qty: Math.floor(qty),
        });
      } catch (err) {
        console.error('[game/state] trade record failed:', err);
      }
    }
  }

  return NextResponse.json({ ok: true });
}
