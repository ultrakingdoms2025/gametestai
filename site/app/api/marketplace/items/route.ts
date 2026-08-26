import { NextRequest, NextResponse } from 'next/server';
import { listMarketplaceItems, ensureMarketplaceSchema } from '@/lib/marketplaceDb';
import { MARKETPLACE_ACTIONS, MARKETPLACE_CATEGORIES, MARKETPLACE_WORLDS } from '@/lib/marketplaceCatalog';
import { auth } from '@/lib/auth';
import { getUserById } from '@/lib/db';
import { findOrCreatePlayer } from '@/lib/playerDb';
import { currentContentScope, type ContentScope } from '@/lib/serverRoutes';

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

  /* The pair — which server AND how it merges — from ONE resolution. A
   * signed-out caller keeps the platform scope, which is exactly today's
   * catalogue; a replace-mode member gets the server's rows only, matching
   * what the purchase path will agree to sell them. */
  let scope: ContentScope = { serverId: null, mode: 'extend' };
  const session = await auth();
  if (session?.user?.id) {
    const user = await getUserById(session.user.id);
    if (user) {
      const playerId = await findOrCreatePlayer(session.user.id, user.email);
      scope = await currentContentScope(playerId);
    }
  }

  const items = await listMarketplaceItems({
    search: params.get('search') ?? undefined,
    category: params.get('category') ?? undefined,
    world: params.get('world') ?? undefined,
    activeOnly: true,
    serverId: scope.serverId,
    contentMode: scope.mode,
  });
  return NextResponse.json({
    items,
    server_id: scope.serverId,
    content_mode: scope.mode,
    categories: MARKETPLACE_CATEGORIES,
    worlds: MARKETPLACE_WORLDS,
    actions: MARKETPLACE_ACTIONS,
  });
}
