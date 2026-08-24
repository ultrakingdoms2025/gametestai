import { NextResponse } from 'next/server';
import { auditServerAction, openServerDb, requireOwnedServer, resolveActor } from '@/lib/serverRoutes';
import { listMembers, updateServer } from '@/lib/customServers';
import { listServerLore, listServerMarketplaceItems, listServerQuests } from '@/lib/serverContent';

export const dynamic = 'force-dynamic';

/** GET → one server, its members and everything its owner has authored. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
  const { id } = await params;

  const db = await openServerDb();
  try {
    const access = await requireOwnedServer(db, actor, id);
    if (!access.ok) return NextResponse.json({ error: 'Not found.' }, { status: access.status });

    return NextResponse.json({
      server: access.server,
      isOwner: access.isOwner,
      members: await listMembers(db, id),
      quests: await listServerQuests(db, id),
      lore: await listServerLore(db, id),
      items: await listServerMarketplaceItems(db, id, { activeOnly: false }),
    });
  } catch (err) {
    console.error('[servers] detail failed:', err);
    return NextResponse.json({ error: 'Could not read the server.' }, { status: 500 });
  } finally {
    await db.end().catch(() => {});
  }
}

/**
 * PATCH → rename, re-describe or suspend.
 *
 * Suspension is here rather than a delete because a server with members, a chat
 * log and a credit ledger is not a thing to remove on a click — and because a
 * platform admin suspending an abusive server should be reversible. A suspended
 * server serves nobody, including its owner (`canUseServer` says so), which is
 * what makes it a real sanction rather than a label.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
  const { id } = await params;

  let body: { name?: unknown; description?: unknown; status?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 });
  }

  const db = await openServerDb();
  try {
    const access = await requireOwnedServer(db, actor, id);
    if (!access.ok) return NextResponse.json({ error: 'Not found.' }, { status: access.status });

    /* Only a platform admin may suspend. An owner suspending their own server is
     * harmless, but an owner UN-suspending one a platform admin suspended is
     * not, and the two are the same verb — so the verb belongs to the platform. */
    const wantsStatus = body.status === 'suspended' || body.status === 'active';
    if (wantsStatus && !actor.platformAdmin) {
      return NextResponse.json(
        { error: 'Only a platform administrator can change a server\'s status.' },
        { status: 403 }
      );
    }

    const server = await updateServer(db, id, {
      ...(body.name === undefined ? {} : { name: String(body.name) }),
      ...(body.description === undefined ? {} : { description: String(body.description) }),
      ...(wantsStatus ? { status: body.status as 'active' | 'suspended' } : {}),
    });
    await auditServerAction(db, actor, 'server.update', `server:${id}`, {
      name: body.name ?? null,
      status: wantsStatus ? body.status : null,
    });
    return NextResponse.json({ server });
  } catch (err) {
    console.error('[servers] update failed:', err);
    return NextResponse.json({ error: 'Could not update the server.' }, { status: 500 });
  } finally {
    await db.end().catch(() => {});
  }
}
