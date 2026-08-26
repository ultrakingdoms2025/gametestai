import { NextResponse } from 'next/server';
import { openServerDb, requireOwnedServer, resolveActor } from '@/lib/serverRoutes';
import { MEMBER_SEARCH_MIN_QUERY, searchInvitablePlayers } from '@/lib/customServers';

export const dynamic = 'force-dynamic';

/**
 * GET ?q= → players an owner could invite, matched on handle.
 *
 * Nested under `/members` so `requireOwnedServer` is the SAME gate the roster
 * already stands behind — one authorisation rule, not a second copy that
 * drifts.
 *
 * ── Privacy: this is a directory query over every player account ──────────
 *
 * The guardrails, written down because they are the design and not an
 * accident of it:
 *
 * 1. **Owner-gated.** Only the owner of this server (or a platform admin) can
 *    ask, and a non-owner gets the same 404 a nonexistent server gets — this
 *    route confirms nothing about other people's servers, let alone their
 *    players.
 * 2. **Minimum two characters** (`MEMBER_SEARCH_MIN_QUERY`), refused with a
 *    400 rather than answered broadly. A one-character query is not a search,
 *    it is an enumeration of the player base a page at a time.
 * 3. **Handle only, never email.** The match is on `players.handle` and the
 *    payload carries `playerId` and `handle` and nothing else. An email
 *    address is login identity; a handle is the name players already show each
 *    other. No branch of this route or of `searchInvitablePlayers` reads the
 *    email column, so there is nothing to redact.
 * 4. **Bounded** to ten rows, and players already on this roster in a live
 *    state are excluded — the result is "who could I invite", not a data set.
 *
 * The ownership check runs BEFORE the query-length check on purpose: a
 * non-owner probing with a short query learns "not found", not "your query was
 * too short for a server that exists".
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
  const { id } = await params;

  const q = (new URL(req.url).searchParams.get('q') ?? '').trim();

  const db = await openServerDb();
  try {
    const access = await requireOwnedServer(db, actor, id);
    if (!access.ok) return NextResponse.json({ error: 'Not found.' }, { status: access.status });

    if (q.length < MEMBER_SEARCH_MIN_QUERY) {
      return NextResponse.json(
        { error: `Type at least ${MEMBER_SEARCH_MIN_QUERY} characters to search.` },
        { status: 400 }
      );
    }

    return NextResponse.json({ players: await searchInvitablePlayers(db, id, q) });
  } catch (err) {
    console.error('[servers/members/search] search failed:', err);
    return NextResponse.json({ error: 'Could not search players.' }, { status: 500 });
  } finally {
    await db.end().catch(() => {});
  }
}
