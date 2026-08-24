import { NextResponse } from 'next/server';
import { openServerDb, resolveActor } from '@/lib/serverRoutes';
import { currentServerId, listActivePlayers, touchPresence } from '@/lib/customServers';
import { CHAT_BODY_MAX, readChat, sendChat } from '@/lib/serverChat';

export const dynamic = 'force-dynamic';

/**
 * Scoped chat (7e), polled.
 *
 * ── The scope is never taken from the request ─────────────────────────────
 *
 * Neither verb accepts a `serverId`. Both ask `currentServerId` — which
 * re-checks membership — for the server this player is actually in. A body-
 * supplied scope would be a scope a client could change, and the whole point of
 * a scoped channel is that it is not the client's to choose.
 *
 * A player in default mode has no chat at all, which is correct: there is no
 * global channel in this design, only server-scoped ones.
 *
 * ── Polling, and the cursor ───────────────────────────────────────────────
 *
 * `?since=` is the last id the client holds. The response carries the new
 * cursor, unchanged when nothing arrived, so an idle poll is one indexed scan
 * that returns nothing. The GET doubles as the presence heartbeat, because a
 * client that is polling for messages is by definition present and a separate
 * heartbeat would be a second request saying the same thing.
 */

export async function GET(req: Request) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });

  const url = new URL(req.url);
  const since = Number(url.searchParams.get('since') ?? 0);
  const limit = Number(url.searchParams.get('limit') ?? 50);

  const db = await openServerDb();
  try {
    const serverId = await currentServerId(db, actor.playerId);
    if (!serverId) {
      /* Default mode. Not an error — there is no global channel by design — so
       * the client gets an empty page and can render "no chat here". */
      return NextResponse.json({ serverId: null, messages: [], cursor: 0, active: [] });
    }

    await touchPresence(db, serverId, actor.playerId);
    const page = await readChat(db, serverId, actor.playerId, { sinceId: since, limit });
    if (page.forbidden) {
      return NextResponse.json({ serverId: null, messages: [], cursor: 0, active: [] });
    }

    return NextResponse.json({
      serverId,
      messages: page.messages.map((m) => ({
        id: m.id,
        from: m.fromHandle,
        /* The sender's internal id goes on the wire ONLY so the client can
         * address a reply, and only for a message this caller can already see.
         * The recipient's is reduced to a flag: whether a message was a DM is
         * something the reader needs; who else has an id is not. */
        fromId: m.from,
        direct: m.to !== null,
        mine: m.from === actor.playerId,
        body: m.body,
        at: m.createdAt,
      })),
      cursor: page.cursor,
      active: await listActivePlayers(db, serverId),
      max: CHAT_BODY_MAX,
    });
  } catch (err) {
    console.error('[game/chat] read failed:', err);
    return NextResponse.json({ error: 'Could not read chat.' }, { status: 500 });
  } finally {
    await db.end().catch(() => {});
  }
}

/** POST → a shout (`to` absent) or a direct message to one active player. */
export async function POST(req: Request) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });

  let body: { body?: unknown; to?: unknown };
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
        { error: 'Chat is scoped to a server. Enter one first.' },
        { status: 409 }
      );
    }

    const out = await sendChat(db, serverId, actor.playerId, {
      body: String(body.body ?? ''),
      toPlayerId: body.to == null ? null : String(body.to),
    });
    if (!out.ok) {
      return NextResponse.json(
        {
          error: {
            empty: 'Say something first.',
            forbidden: 'You are not in that server.',
            no_recipient: 'That player is not in this server.',
            too_fast: 'Slow down.',
          }[out.reason],
          reason: out.reason,
        },
        { status: out.reason === 'too_fast' ? 429 : out.reason === 'empty' ? 400 : 403 }
      );
    }
    return NextResponse.json({ id: out.id });
  } catch (err) {
    console.error('[game/chat] send failed:', err);
    return NextResponse.json({ error: 'Could not send that.' }, { status: 500 });
  } finally {
    await db.end().catch(() => {});
  }
}
