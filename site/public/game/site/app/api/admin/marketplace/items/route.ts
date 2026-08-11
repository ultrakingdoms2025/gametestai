import { NextRequest, NextResponse } from 'next/server';
import { requireMarketplaceAdmin } from '@/lib/adminAccess';
import {
  createMarketplaceItem,
  ensureMarketplaceSchema,
  listMarketplaceItems,
  type MarketplaceItemInput,
} from '@/lib/marketplaceDb';
import { MARKETPLACE_ACTIONS, MARKETPLACE_CATEGORIES, MARKETPLACE_WORLDS } from '@/lib/marketplaceCatalog';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const admin = await requireMarketplaceAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  await ensureMarketplaceSchema();
  const params = request.nextUrl.searchParams;
  const items = await listMarketplaceItems({
    search: params.get('search') ?? undefined,
    category: params.get('category') ?? undefined,
    world: params.get('world') ?? undefined,
    activeOnly: params.get('activeOnly') === '1',
  });
  return NextResponse.json({
    items,
    categories: MARKETPLACE_CATEGORIES,
    worlds: MARKETPLACE_WORLDS,
    actions: MARKETPLACE_ACTIONS,
  });
}

export async function POST(request: NextRequest) {
  const admin = await requireMarketplaceAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  await ensureMarketplaceSchema();

  let body: Partial<MarketplaceItemInput>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    const item = await createMarketplaceItem({
      name: String(body.name ?? ''),
      description: String(body.description ?? ''),
      category: body.category as MarketplaceItemInput['category'],
      image: String(body.image ?? ''),
      game_action: body.game_action as MarketplaceItemInput['game_action'],
      action_config: body.action_config ?? {},
      quantity: body.quantity ?? null,
      cost_buy: Number(body.cost_buy ?? 0),
      cost_sell: Number(body.cost_sell ?? 0),
      world_name: body.world_name as MarketplaceItemInput['world_name'],
      is_active: body.is_active ?? true,
      sort_order: Number(body.sort_order ?? 0),
      source_key: body.source_key ?? null,
    });
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Create failed' }, { status: 400 });
  }
}
