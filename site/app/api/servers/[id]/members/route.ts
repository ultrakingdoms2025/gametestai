import { NextResponse } from 'next/server';
import { auditServerAction, openServerDb, requireOwnedServer, resolveActor } from '@/lib/serverRoutes';
import { applyMembershipAction, listMembers, type MemberAction } from '@/lib/customServers';
import { normalizeHandle } from '@/lib/playerDb';

export const dynamic = 'force-dynamic';

const OWNER_ACTIONS: MemberAction[] = ['invite', 'approve', 'reject', 'remove'];

/** GET → the roster. Owner and platform admin only; membership is not public. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
  const { id } = await params;

  const db = await openServerDb();
  try {
    const access = await requireOwnedServer(db, actor, id);
    if (!access.ok) return NextResponse.json({ error: 'Not found.' }, { status: access.status });
    return NextResponse.json({ members: await listMembers(db, id) });
  } catch (err) {
    console.error('[servers/members] list failed:', err);
    return NextResponse.json({ error: 'Could not read members.' }, { status: 500 });
  } finally {
    await db.end().catch(() => {});
  }
}

/**
 * POST → invite, approve, reject or remove.
 *
 * The owner side identifies a player by HANDLE, not by internal id. A player id
 * is an internal key that no owner has any way to know, and asking for one
 * would either make the feature unusable or push the id onto some other screen
 * where it does not belong. `players.handle` is the name players already have.
 *
 * Every authorisation decision — including "is this actor the owner" — is
 * `applyMembershipAction`'s, not this route's. It is passed the actor and told
 * whether they are a platform admin, and it decides. One rule, one
 * implementation; `requireOwnedServer` here is the cheap 404 for a server that
 * is not the caller's at all.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
  const { id } = await params;

  let body: { action?: unknown; handle?: unknown; playerId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 });
  }

  const action = String(body.action ?? '') as MemberAction;
  if (!OWNER_ACTIONS.includes(action)) {
    return NextResponse.json(
      {
        error:
          'Unknown action. A player asks to join through /api/game/server, not through this route.',
      },
      { status: 400 }
    );
  }

  const db = await openServerDb();
  try {
    const access = await requireOwnedServer(db, actor, id);
    if (!access.ok) return NextResponse.json({ error: 'Not found.' }, { status: access.status });

    const subject = await resolveSubject(db, body);
    if (!subject) {
      return NextResponse.json({ error: 'No player by that handle.' }, { status: 404 });
    }

    const out = await applyMembershipAction(db, {
      serverId: id,
      subjectPlayerId: subject,
      actorPlayerId: actor.playerId,
      action,
      platformAdmin: actor.platformAdmin,
    });
    if (!out.ok) {
      return NextResponse.json(
        {
          error: {
            not_found: 'That server no longer exists.',
            forbidden: 'That is not yours to do.',
            illegal_transition: 'That member is not in a state where this is possible.',
          }[out.reason],
          reason: out.reason,
        },
        { status: out.reason === 'not_found' ? 404 : 409 }
      );
    }

    if (out.changed) {
      await auditServerAction(db, actor, `server.member.${action}`, `server:${id}`, {
        subject,
        state: out.state,
      });
    }
    return NextResponse.json({ state: out.state, members: await listMembers(db, id) });
  } catch (err) {
    console.error('[servers/members] action failed:', err);
    return NextResponse.json({ error: 'Could not change that membership.' }, { status: 500 });
  } finally {
    await db.end().catch(() => {});
  }
}

/**
 * The player this action is about.
 *
 * A handle is matched case-insensitively after the same normalisation the
 * profile editor applies, so what an owner types is what a player sees on their
 * own account rather than a second dialect of the same name.
 */
async function resolveSubject(
  db: import('pg').Client,
  body: { handle?: unknown; playerId?: unknown }
): Promise<string | null> {
  const handle = normalizeHandle(String(body.handle ?? ''));
  if (handle) {
    const r = await db.query('SELECT id FROM players WHERE LOWER(handle) = LOWER($1) LIMIT 1', [
      handle,
    ]);
    return r.rows[0] ? String(r.rows[0].id) : null;
  }
  /* A raw player id is accepted for the platform admin's own tooling, and is
   * still checked to exist rather than trusted — a membership row for an id
   * that is not a player is a row nothing can ever clear. */
  const raw = String(body.playerId ?? '').trim();
  if (!raw) return null;
  const r = await db.query('SELECT id FROM players WHERE id = $1', [raw]);
  return r.rows[0] ? String(r.rows[0].id) : null;
}
