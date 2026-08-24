import { NextResponse } from 'next/server';
import { Client } from 'pg';
import { auth } from '@/lib/auth';
import { getUserById } from '@/lib/db';
import { findOrCreatePlayer } from '@/lib/playerDb';
import {
  ensureLeaderboardSchema,
  readBoard,
  openBoards,
  REFUSED,
  GLOBAL,
  type BoardScope,
} from '@/lib/leaderboard';
import { canUseServer, ensureCustomServerSchema } from '@/lib/customServers';

export const dynamic = 'force-dynamic';

function makeClient() {
  const connStr = process.env.POSTGRES_URL ?? '';
  const ssl = connStr.includes('sslmode=disable') ? false : { rejectUnauthorized: false };
  return new Client({ connectionString: connStr, ssl });
}

/**
 * GET → one leaderboard, derived from progress the server already holds.
 *
 * `?category=relics|charters|quests` and an optional `?limit=` and `?server=`.
 * With no category, answers the list of open boards and the recorded reasons
 * for every refusal.
 *
 * ── There is deliberately no POST ─────────────────────────────────────────
 *
 * Phase 3 §9: the endpoint "derives from the identity sets in
 * `player_progress_items`, which the server already holds, rather than accepting
 * a submitted figure." A submit handler is the entire hole — a client that can
 * post a score has already won — so there is none, and `leaderboard.test.ts`
 * asserts against this file's source that none reappears.
 *
 * ── Other players' ids do not go on the wire ──────────────────────────────
 *
 * Entries carry a rank, a handle and a score. `playerId` is returned only for
 * the caller's own row, because it is an internal key and a leaderboard is the
 * one endpoint that hands a list of other accounts to a stranger.
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
  }

  const url = new URL(req.url);
  const category = (url.searchParams.get('category') ?? '').trim();
  if (!category) {
    return NextResponse.json({
      boards: openBoards().map((s) => ({ id: s.id, label: s.label, why: s.why })),
      refused: REFUSED,
    });
  }

  const rawLimit = Number(url.searchParams.get('limit') ?? 25);
  const limit = Number.isFinite(rawLimit) ? rawLimit : 25;

  const user = await getUserById(session.user.id);
  if (!user) return NextResponse.json({ error: 'User not found.' }, { status: 404 });
  const playerId = await findOrCreatePlayer(session.user.id, user.email);

  /* The scope is stated, never inferred.
   *
   * `?server=` was accepted-and-refused here before `custom_servers` existed,
   * with the note that "a board nobody can be a member of is not one this route
   * will guess at". Membership can be checked now, so it is — and the check is
   * `canUseServer`, the same function content and chat ask, rather than a second
   * opinion about what membership means.
   *
   * A server the caller is not in answers 404 rather than 403, matching the
   * server routes: a 403 would confirm the id exists. */
  const requested = (url.searchParams.get('server') ?? '').trim();
  let scope: BoardScope = GLOBAL;
  if (requested) {
    const check = makeClient();
    await check.connect();
    try {
      await ensureCustomServerSchema(check);
      if (!(await canUseServer(check, requested, playerId))) {
        return NextResponse.json({ error: 'No such leaderboard.' }, { status: 404 });
      }
    } finally {
      await check.end().catch(() => {});
    }
    scope = { serverId: requested };
  }

  const client = makeClient();
  await client.connect();
  try {
    await ensureLeaderboardSchema(client);
    const out = await readBoard(client, category, scope, { limit, playerId });
    if (!out.ok) {
      const why = REFUSED[category];
      return NextResponse.json(
        {
          error: out.reason === 'no_ceiling'
            ? 'That set has no server-side ceiling, so it is not ranked.'
            : 'Unknown leaderboard.',
          reason: out.reason,
          ...(why ? { why } : {}),
        },
        { status: 404 }
      );
    }

    const { board } = out;
    return NextResponse.json({
      category: board.category,
      label: board.label,
      ceiling: board.ceiling,
      entries: board.entries.map((e) => ({
        rank: e.rank,
        name: e.handle,
        score: e.score,
        self: e.self,
        ...(e.self ? { playerId: e.playerId } : {}),
      })),
    });
  } catch (err) {
    console.error('[game/leaderboard] read failed:', err);
    return NextResponse.json({ error: 'Could not read the leaderboard.' }, { status: 500 });
  } finally {
    await client.end();
  }
}
