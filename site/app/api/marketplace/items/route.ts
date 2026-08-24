import { NextRequest, NextResponse } from 'next/server';
import { listMarketplaceItems, ensureMarketplaceSchema } from '@/lib/marketplaceDb';
import { MARKETPLACE_ACTIONS, MARKETPLACE_CATEGORIES, MARKETPLACE_WORLDS } from '@/lib/marketplaceCatalog';
import { auth } from '@/lib/auth';
import { getUserById } from '@/lib/db';
import { findOrCreatePlayer } from '@/lib/playerDb';
import { currentServer } from '@/lib/serverRoutes';

export const dynamic = 'force-dynamic';

/**
 * The catalogue a player is shopping in.
 *
 * ── The scope is resolved here, not requested ─────────────────────────────
 *
 * There is no `?server=` parameter, deliberately. The scope comes from the
 * player's stored selection through `currentServer`, which re-checks membership
 * on every call — so a player removed from a server between two requests stops
 * seeing its items on the very next one, without anything having to remember to
 * clear a cache.
 *
 * A signed-out caller, and a signed-in caller in default mode, both get exactly
 * today's catalogue: `listMarketplaceItems` treats an absent `serverId` as the
 * platform partition rather than as "no filter". That is 7a's promise, and it is
 * a default rather than a check because a default cannot be forgotten.
 *
 * D2 is "that server's items IN ADDITION TO defaults", so a member sees both.
 */
export async function GET(request: NextRequest) {
  await ensureMarketplaceSchema();
  const params = request.nextUrl.searchParams;

  let serverId: string | null = null;
  const session = await auth();
  if (session?.user?.id) {
    const user = await getUserById(session.user.id);
    if (user) {
      const playerId = await findOrCreatePlayer(session.user.id, user.email);
      serverId = await currentServer(playerId);
    }
  }

  const items = await listMarketplaceItems({
    search: params.get('search') ?? undefined,
    category: params.get('category') ?? undefined,
    world: params.get('world') ?? undefined,
    activeOnly: true,
    serverId,
  });
  return NextResponse.json({
    items,
    server_id: serverId,
    categories: MARKETPLACE_CATEGORIES,
    worlds: MARKETPLACE_WORLDS,
    actions: MARKETPLACE_ACTIONS,
  });
}
