import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getUserById } from '@/lib/db';
import { findOrCreatePlayer } from '@/lib/playerDb';
import { getLoreEntries } from '@/lib/lore';
import { currentContentScope, type ContentScope } from '@/lib/serverRoutes';

export const dynamic = 'force-dynamic';

/**
 * The lore the game's keepers recite, in the scope the player is actually in.
 *
 * ── Why this route grew a session read ────────────────────────────────────
 *
 * It called the shared fetcher with no argument at all, and `lore.ts` answered
 * with the platform partition only. Owners could author lore — `/api/servers/[id]/content`
 * writes `server_lore_entries` — and no player could ever see a word of it: the
 * table was read by the admin panel and by nothing else. Authored content that
 * no player can reach is the shape this repository has paid for repeatedly, and
 * it was live here.
 *
 * ── The scope comes from the session, never from the request ──────────────
 *
 * Not a query parameter, and not a body field. `currentContentScope` re-checks
 * membership on every call, so a player removed between two requests drops back
 * to the platform lore on this very one — the same guarantee `/api/game/quests`
 * relies on for the quest catalogue. It resolves the PAIR — which server and
 * how its content merges — in one decision, so this route can never disagree
 * with the quest board or the marketplace about what mode the player is in.
 *
 * A signed-out caller resolves to null, which IS the platform partition, so the
 * anonymous response is byte-for-byte what it was before custom servers existed.
 */
async function loreScope(): Promise<ContentScope | null> {
  /* Null on ANY failure, which is the safe direction and the same one
   * `currentContentScope` documents for itself: null is the platform partition,
   * so a session or database hiccup shows a player the default lore rather than
   * failing their request or, worse, showing them somebody else's. */
  try {
    const session = await auth();
    if (!session?.user?.id) return null;
    const user = await getUserById(session.user.id);
    if (!user) return null;
    const playerId = await findOrCreatePlayer(session.user.id, user.email);
    return await currentContentScope(playerId);
  } catch (error) {
    console.error('[lore] could not resolve the player scope:', error);
    return null;
  }
}

export async function GET() {
  try {
    const scope = await loreScope();
    const rows = await getLoreEntries(scope?.serverId ?? null, scope?.mode ?? 'extend');
    /* Keyed by scope, last row wins. `lore.ts` orders the platform partition
     * first and the server's overlay second, so an owner's variant of a scope
     * replaces the platform text and every scope they did not author keeps it.
     * The merge rule lives in the ORDER BY, not here — and in `replace` mode
     * the fetcher serves the overlay alone, which is that rule collapsed to
     * "server rows only". */
    const entries = Object.fromEntries(rows.map(r => [r.scope, {
      scope: r.scope, title: r.title, sign_label: r.sign_label, body: r.body, updated_at: r.updated_at,
    }]));
    return NextResponse.json({
      entries,
      server_id: scope?.serverId ?? null,
      content_mode: scope?.mode ?? 'extend',
    });
  } catch (error) {
    console.error('[lore] failed to load lore entries:', error);
    return NextResponse.json({ error: 'Lore data unavailable.' }, { status: 503 });
  }
}
