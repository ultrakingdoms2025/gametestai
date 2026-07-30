import { NextRequest, NextResponse } from 'next/server';
import { listMarketplaceItems, ensureMarketplaceSchema } from '@/lib/marketplaceDb';
import { MARKETPLACE_ACTIONS, MARKETPLACE_CATEGORIES, MARKETPLACE_WORLDS } from '@/lib/marketplaceCatalog';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  await ensureMarketplaceSchema();
  const params = request.nextUrl.searchParams;
  const items = await listMarketplaceItems({
    search: params.get('search') ?? undefined,
    category: params.get('category') ?? undefined,
    world: params.get('world') ?? undefined,
    activeOnly: true,
  });
  return NextResponse.json({
    items,
    categories: MARKETPLACE_CATEGORIES,
    worlds: MARKETPLACE_WORLDS,
    actions: MARKETPLACE_ACTIONS,
  });
}
