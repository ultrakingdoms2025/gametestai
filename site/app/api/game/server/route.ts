import { NextResponse } from 'next/server';
import { openServerDb, resolveActor } from '@/lib/serverRoutes';
import {
  applyMembershipAction,
  currentServerId,
  listActivePlayers,
  listJoinableServers,
  listServersDirectory,
  listServersForPlayer,
  selectServer,
  touchPresence,
} from '@/lib/customServers';
import { serverBalance } from '@/lib/serverCredits';

export const dynamic = 'force-dynamic';

/**
 * The start panel's server choice (7d), and the player side of membership.
 *
 * ── What a player is offered ──────────────────────────────────────────────
 *
 * Default mode, or a server from a dropdown. `memberships` is what they can
 * enter now; `joinable` is what they can ASK about. An unapproved server is not
 * hidden — a server nobody can find is a server nobody can request — but nothing
 * about its CONTENT is served here, only its name.
 *
 * ── Why the selection is stored server-side ───────────────────────────────
 *
 * It could be a signed cookie, like `an_game_launch`. It is a row instead,
 * because every content read has to answer "which scope?" and a cookie is not
 * available to the leaderboard route, the quest route or the chat poll without
 * each of them learning to parse it. One row, read by `currentServerId`, and
 * that function RE-CHECKS membership on every read — so a player removed
 * between two requests falls back to default mode rather than keeping the
 * catalogue they were last shown.
 */
export async function GET() {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });

  const db = await openServerDb();
  try {
    const current = await currentServerId(db, actor.playerId);
    return NextResponse.json({
      current,
      memberships: await listServersForPlayer(db, actor.playerId),
      joinable: await listJoinableServers(db, actor.playerId),
      /* The launch modal's step two: every ACTIVE server, with an approved
       * member count, an online-now count from the presence window, and the
       * caller's own standing so the UI can offer the one legal verb.
       * `memberships` and `joinable` stay as they are — they have other
       * consumers and `listJoinableServers`' exclusion rule is deliberate. */
      directory: await listServersDirectory(db, actor.playerId),
      credits: current ? await serverBalance(db, current, actor.playerId) : null,
      active: current ? await listActivePlayers(db, current) : [],
    });
  } catch (err) {
    console.error('[game/server] read failed:', err);
    return NextResponse.json({ error: 'Could not read servers.' }, { status: 500 });
  } finally {
    await db.end().catch(() => {});
  }
}

/**
 * POST → enter a server, return to default mode, ask to join, or heartbeat.
 *
 * `request` is the only membership verb a player holds, and it is here rather
 * than on the owner's route so that the two audiences never share an endpoint —
 * `applyMembershipAction` refuses a player acting on anyone but themselves, and
 * this route cannot even express the attempt because it always passes the
 * caller as both actor and subject.
 */
export async function POST(req: Request) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });

  let body: { action?: unknown; serverId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 });
  }

  const action = String(body.action ?? 'select');
  const requested = String(body.serverId ?? '').trim() || null;

  const db = await openServerDb();
  try {
    if (action === 'request') {
      if (!requested) return NextResponse.json({ error: 'serverId is required.' }, { status: 400 });
      const out = await applyMembershipAction(db, {
        serverId: requested,
        subjectPlayerId: actor.playerId,
        actorPlayerId: actor.playerId,
        action: 'request',
      });
      if (!out.ok) {
        return NextResponse.json(
          {
            error: out.reason === 'not_found'
              ? 'No such server.'
              : out.reason === 'illegal_transition'
                ? 'You are already in that server.'
                : 'That is not yours to do.',
            reason: out.reason,
          },
          { status: out.reason === 'not_found' ? 404 : 409 }
        );
      }
      return NextResponse.json({ state: out.state });
    }

    if (action === 'heartbeat') {
      /* Presence, so "selected active players" is answerable without a socket.
       * Re-derived rather than trusting the body: a heartbeat for a server the
       * player is not in would otherwise put them in its roster. */
      const current = await currentServerId(db, actor.playerId);
      if (current) await touchPresence(db, current, actor.playerId);
      return NextResponse.json({ current });
    }

    if (action !== 'select') {
      return NextResponse.json({ error: 'Unknown action.' }, { status: 400 });
    }

    const out = await selectServer(db, actor.playerId, requested);
    if (out.refused) {
      return NextResponse.json(
        {
          error: 'You are not approved for that server yet.',
          reason: 'not_a_member',
          current: out.serverId,
        },
        { status: 403 }
      );
    }
    if (out.serverId) await touchPresence(db, out.serverId, actor.playerId);
    return NextResponse.json({
      current: out.serverId,
      credits: out.serverId ? await serverBalance(db, out.serverId, actor.playerId) : null,
    });
  } catch (err) {
    console.error('[game/server] action failed:', err);
    return NextResponse.json({ error: 'Could not do that.' }, { status: 500 });
  } finally {
    await db.end().catch(() => {});
  }
}
