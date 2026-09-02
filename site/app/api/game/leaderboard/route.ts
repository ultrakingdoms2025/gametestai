import { NextResponse } from 'next/server';
import { Client } from 'pg';
import { auth } from '@/lib/auth';
import { getUserById } from '@/lib/db';
import { findOrCreatePlayer } from '@/lib/playerDb';
import {
  ensureLeaderboardSchema,
  readBoard,
  openBoards,
  isServerOnlyBoard,
  formatRaceTime,
  REFUSED,
  GLOBAL,
  type BoardScope,
} from '@/lib/leaderboard';
import { canUseServer, currentServerId, ensureCustomServerSchema } from '@/lib/customServers';

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
 * ── The index is scope-aware, and the scope is resolved SERVER-SIDE ───────
 *
 * A member of a custom server is additionally offered that server's time boards
 * (`race_time.race.vellum.standard` and its eight siblings). Those ids appear in
 * the index only for a caller who is in a server, and `readBoard` refuses one
 * outside a server whether it was advertised or not.
 *
 * Which server is asked of `currentServerId` — the stored, membership-rechecked
 * selection — rather than taken from the query string, which is the same rule
 * `/api/game/chat` states: "a body-supplied scope would be a scope a client
 * could change". `?server=` remains available and remains membership-checked;
 * what it can no longer do is be the ONLY way to reach a scoped board, because
 * that would have meant every client needed a code change before a single
 * member could see one. `RecordsPanel` fetches each id the index gave it with no
 * scope of its own, and lands on the right board because the server already
 * knows where the player is.
 *
 * One consequence, stated: the index now costs one query where it used to cost
 * none. It buys the ability to add a scoped board without touching the game.
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

  const rawLimit = Number(url.searchParams.get('limit') ?? 25);
  const limit = Number.isFinite(rawLimit) ? rawLimit : 25;

  const user = await getUserById(session.user.id);
  if (!user) return NextResponse.json({ error: 'User not found.' }, { status: 404 });
  const playerId = await findOrCreatePlayer(session.user.id, user.email);

  /* The scope is stated or resolved, never taken on trust.
   *
   * `?server=` is membership-checked with `canUseServer` — the same function
   * content and chat ask, rather than a second opinion about what membership
   * means — and a server the caller is not in answers 404 rather than 403,
   * matching the server routes: a 403 would confirm the id exists.
   *
   * With no `?server=`, the caller's CURRENT server is resolved from the stored
   * selection. That resolution never widens a board: a global category keeps
   * `GLOBAL` below, and the resolved id is used only for the index and for a
   * category that has no global form at all.
   *
   * This still runs on its own short-lived client, released before the read
   * opens its own. Folding the two together would read better and would move
   * `canUseServer(check, requested, playerId)` out from under the gate in
   * `serverRouteGuards.test.ts`, which pins that call and the `scope`
   * assignment that follows it as an ORDER — the membership answer before the
   * scope is adopted. A tidier connection is not worth relocating a gate. */
  const requested = (url.searchParams.get('server') ?? '').trim();
  let scope: BoardScope = GLOBAL;
  let memberOf: string | null = null;
  {
    const check = makeClient();
    await check.connect();
    try {
      await ensureCustomServerSchema(check);
      if (requested) {
        if (!(await canUseServer(check, requested, playerId))) {
          return NextResponse.json({ error: 'No such leaderboard.' }, { status: 404 });
        }
        memberOf = requested;
      } else {
        memberOf = await currentServerId(check, playerId);
      }
    } finally {
      await check.end().catch(() => {});
    }
  }
  if (requested) scope = { serverId: requested };

  if (!category) {
    const indexScope: BoardScope = memberOf ? { serverId: memberOf } : GLOBAL;
    return NextResponse.json({
      boards: openBoards(indexScope).map((s) => ({ id: s.id, label: s.label, why: s.why })),
      refused: REFUSED,
      /* Named so a reader of the response can tell a board list that includes
       * scoped boards from one that does not, without guessing from the ids. */
      server: memberOf,
    });
  }

  /* A global category is read GLOBALLY unless the caller named a server. The
   * resolved `memberOf` deliberately does not silently scope `relics` to
   * whichever server the player happens to be in — that would change the
   * meaning of an existing board with no request from anyone. It scopes only a
   * board that has no other scope to be read in. */
  if (!requested && isServerOnlyBoard(category) && memberOf) scope = { serverId: memberOf };

  const client = makeClient();
  await client.connect();
  try {
    await ensureLeaderboardSchema(client);
    const out = await readBoard(client, category, scope, { limit, playerId });
    if (!out.ok) {
      const why = REFUSED[category];
      return NextResponse.json(
        {
          error: {
            no_ceiling: 'That set has no server-side ceiling, so it is not ranked.',
            server_only: 'That board only exists inside a custom server.',
            unknown_category: 'Unknown leaderboard.',
          }[out.reason],
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
      unit: board.unit,
      floor_ms: board.floorMs,
      entries: board.entries.map((e) => ({
        rank: e.rank,
        name: e.handle,
        /* A time goes on the wire ALREADY FORMATTED, with the raw integer
         * beside it. `RecordsPanel` renders `${e.score}` for whatever board the
         * index offered it, so an unformatted time board would read as a
         * six-digit millisecond count on the standings sheet. Formatting here
         * is what lets a scoped board appear in-game with no client change; a
         * client that wants to compute keeps `ms`. */
        score: board.unit === 'time' ? formatRaceTime(e.score) : e.score,
        ...(board.unit === 'time' ? { ms: e.score } : {}),
        self: e.self,
        ...(e.self ? { playerId: e.playerId } : {}),
      })),
    });
  } catch (err) {
    console.error('[game/leaderboard] read failed:', err);
    return NextResponse.json({ error: 'Could not read the leaderboard.' }, { status: 500 });
  } finally {
    await client.end().catch(() => {});
  }
}
