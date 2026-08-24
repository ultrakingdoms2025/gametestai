import { NextResponse } from 'next/server';
import { auditServerAction, openServerDb, resolveActor } from '@/lib/serverRoutes';
import {
  createServer,
  listAllServers,
  listServersOwnedBy,
  listServersForPlayer,
  listJoinableServers,
} from '@/lib/customServers';
import { entitlementPermitsHosting, quoteServerHosting, readEntitlement } from '@/lib/premium';

export const dynamic = 'force-dynamic';

/**
 * GET → the servers this account can see, and whether it may make another.
 *
 * Four lists, and they are four because they answer four different questions:
 * what do I own, what am I a member of, what could I ask to join, and — for a
 * platform admin only — what exists. The last is 7c's "platform-admin
 * visibility over all servers", and it is the only unscoped read in the phase.
 */
export async function GET() {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });

  const db = await openServerDb();
  try {
    const entitlement = await readEntitlement(db, actor.playerId);
    const owned = await listServersOwnedBy(db, actor.playerId);
    return NextResponse.json({
      owned,
      memberships: await listServersForPlayer(db, actor.playerId),
      joinable: await listJoinableServers(db, actor.playerId),
      all: actor.platformAdmin ? await listAllServers(db) : null,
      platformAdmin: actor.platformAdmin,
      entitlement: {
        status: entitlement.status,
        maxServers: entitlement.maxServers,
        used: owned.length,
        canCreate: entitlementPermitsHosting(entitlement) && owned.length < entitlement.maxServers,
        currentPeriodEnd: entitlement.currentPeriodEnd,
      },
      sku: quoteServerHosting(),
    });
  } catch (err) {
    console.error('[servers] list failed:', err);
    return NextResponse.json({ error: 'Could not read servers.' }, { status: 500 });
  } finally {
    await db.end().catch(() => {});
  }
}

/**
 * POST → create a server.
 *
 * The entitlement is read inside `createServer` from `server_entitlements`,
 * which only the Stripe webhook writes. Nothing in this body can raise it — the
 * request names a NAME, and that is all it names. That is the same shape the
 * checkout route already uses for price: a client supplies an intent, never an
 * amount.
 */
export async function POST(req: Request) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });

  let body: { name?: unknown; description?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 });
  }

  const db = await openServerDb();
  try {
    const out = await createServer(db, actor.playerId, {
      name: String(body.name ?? ''),
      description: String(body.description ?? ''),
    });
    if (!out.ok) {
      const status = out.reason === 'no_entitlement' || out.reason === 'quota' ? 402 : 400;
      return NextResponse.json(
        {
          error: {
            no_entitlement: 'A hosting subscription is needed before a server can be created.',
            quota: 'That subscription is already hosting as many servers as it allows.',
            invalid_name: 'Give the server a name of at least three usable characters.',
            slug_taken: 'A server with a very similar name already exists.',
          }[out.reason],
          reason: out.reason,
        },
        { status }
      );
    }
    await auditServerAction(db, actor, 'server.create', `server:${out.server.id}`, {
      name: out.server.name,
      slug: out.server.slug,
    });
    return NextResponse.json({ server: out.server }, { status: 201 });
  } catch (err) {
    console.error('[servers] create failed:', err);
    return NextResponse.json({ error: 'Could not create the server.' }, { status: 500 });
  } finally {
    await db.end().catch(() => {});
  }
}
