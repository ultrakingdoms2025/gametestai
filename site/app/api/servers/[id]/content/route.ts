import { NextResponse } from 'next/server';
import { auditServerAction, openServerDb, requireOwnedServer, resolveActor } from '@/lib/serverRoutes';
import {
  createServerMarketplaceItem,
  createServerQuest,
  deleteServerLore,
  deleteServerQuest,
  listServerLore,
  listServerMarketplaceItems,
  listServerQuests,
  retireServerMarketplaceItem,
  updateServerMarketplaceItem,
  updateServerQuest,
  upsertServerLore,
} from '@/lib/serverContent';

export const dynamic = 'force-dynamic';

/**
 * Owner CRUD (7c) over an owner's own lore, quests and marketplace items.
 *
 * ── The server id comes from the URL, never from the body ─────────────────
 *
 * Every call below passes `id` — the path parameter this route has just checked
 * ownership of — as `serverContent`'s required second argument. There is no
 * field in any request body named `serverId`, and no branch here that reads one.
 *
 * That is the whole discharge of the residual `leaderboard.ts` handed to this
 * phase. A body-supplied stamp would be a stamp a client could omit or forge; a
 * path-supplied one has already been authorised by the time it is used, and
 * `serverContent` throws rather than writes if it is blank.
 *
 * ── One route, three kinds, on purpose ────────────────────────────────────
 *
 * Three separate routes would be three copies of the ownership check, and the
 * copy that drifts is the one nobody re-reads. The `kind` discriminates inside a
 * single authorised handler.
 */

type Kind = 'quest' | 'lore' | 'item';

const KINDS: Kind[] = ['quest', 'lore', 'item'];

function kindOf(raw: unknown): Kind | null {
  const k = String(raw ?? '');
  return (KINDS as string[]).includes(k) ? (k as Kind) : null;
}

/** GET → everything this server's owner has authored. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
  const { id } = await params;

  const db = await openServerDb();
  try {
    const access = await requireOwnedServer(db, actor, id);
    if (!access.ok) return NextResponse.json({ error: 'Not found.' }, { status: access.status });
    return NextResponse.json({
      quests: await listServerQuests(db, id),
      lore: await listServerLore(db, id),
      items: await listServerMarketplaceItems(db, id, { activeOnly: false }),
    });
  } catch (err) {
    console.error('[servers/content] read failed:', err);
    return NextResponse.json({ error: 'Could not read content.' }, { status: 500 });
  } finally {
    await db.end().catch(() => {});
  }
}

/** POST → author a new quest, lore entry or marketplace item. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 });
  }
  const kind = kindOf(body.kind);
  if (!kind) return NextResponse.json({ error: 'Unknown content kind.' }, { status: 400 });

  const db = await openServerDb();
  try {
    const access = await requireOwnedServer(db, actor, id);
    if (!access.ok) return NextResponse.json({ error: 'Not found.' }, { status: access.status });

    if (kind === 'quest') {
      const quest = await createServerQuest(db, id, {
        world: String(body.world ?? ''),
        title: String(body.title ?? ''),
        questLine: String(body.questLine ?? 'custom'),
        rewardCredits: Number(body.rewardCredits ?? 0),
        durationMinutes: body.durationMinutes == null ? null : Number(body.durationMinutes),
        steps: body.steps == null ? null : String(body.steps),
        isActive: body.isActive !== false,
        repeatable: body.repeatable === true,
        updatedBy: actor.email,
      });
      await auditServerAction(db, actor, 'server.quest.create', `server:${id}`, {
        questId: quest.id,
        world: quest.world,
        rewardCredits: quest.rewardCredits,
      });
      return NextResponse.json({ quest }, { status: 201 });
    }

    if (kind === 'lore') {
      const entry = await upsertServerLore(db, id, {
        scope: String(body.scope ?? ''),
        title: String(body.title ?? ''),
        signLabel: body.signLabel == null ? undefined : String(body.signLabel),
        body: String(body.body ?? ''),
        updatedBy: actor.email,
      });
      await auditServerAction(db, actor, 'server.lore.upsert', `server:${id}`, {
        scope: entry.scope,
      });
      return NextResponse.json({ lore: entry }, { status: 201 });
    }

    const item = await createServerMarketplaceItem(db, id, {
      name: String(body.name ?? ''),
      description: String(body.description ?? ''),
      category: String(body.category ?? 'tools'),
      image: String(body.image ?? ''),
      gameAction: String(body.gameAction ?? ''),
      actionConfig: (body.actionConfig ?? {}) as Record<string, unknown>,
      quantity: body.quantity == null ? null : Number(body.quantity),
      costBuy: Number(body.costBuy ?? 0),
      costSell: Number(body.costSell ?? 0),
      worldName: String(body.worldName ?? ''),
      sortOrder: Number(body.sortOrder ?? 0),
      isActive: body.isActive !== false,
    });
    await auditServerAction(db, actor, 'server.item.create', `server:${id}`, {
      itemId: item.id,
      costBuy: item.costBuy,
      costSell: item.costSell,
    });
    return NextResponse.json({ item }, { status: 201 });
  } catch (err) {
    console.error('[servers/content] create failed:', err);
    return NextResponse.json({ error: 'Could not save that.' }, { status: 500 });
  } finally {
    await db.end().catch(() => {});
  }
}

/** PATCH → edit one of this server's own rows. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 });
  }
  const kind = kindOf(body.kind);
  if (!kind || kind === 'lore') {
    /* Lore has no PATCH: `upsertServerLore` is keyed on (server, scope), so POST
     * already edits. One writer per row rather than two that must agree. */
    return NextResponse.json({ error: 'Unknown content kind.' }, { status: 400 });
  }
  const targetId = String(body.id ?? '');
  if (!targetId) return NextResponse.json({ error: 'id is required.' }, { status: 400 });

  const db = await openServerDb();
  try {
    const access = await requireOwnedServer(db, actor, id);
    if (!access.ok) return NextResponse.json({ error: 'Not found.' }, { status: access.status });

    if (kind === 'quest') {
      const quest = await updateServerQuest(db, id, targetId, {
        ...(body.world === undefined ? {} : { world: String(body.world) }),
        ...(body.title === undefined ? {} : { title: String(body.title) }),
        ...(body.questLine === undefined ? {} : { questLine: String(body.questLine) }),
        ...(body.rewardCredits === undefined ? {} : { rewardCredits: Number(body.rewardCredits) }),
        ...(body.steps === undefined ? {} : { steps: body.steps == null ? null : String(body.steps) }),
        ...(body.isActive === undefined ? {} : { isActive: body.isActive === true }),
        ...(body.repeatable === undefined ? {} : { repeatable: body.repeatable === true }),
        updatedBy: actor.email,
      });
      /* Null means the row is not this server's — a platform quest, or another
       * owner's. Reported as 404 because to this owner it does not exist. */
      if (!quest) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
      await auditServerAction(db, actor, 'server.quest.update', `server:${id}`, {
        questId: quest.id,
        rewardCredits: quest.rewardCredits,
      });
      return NextResponse.json({ quest });
    }

    const item = await updateServerMarketplaceItem(db, id, targetId, {
      ...(body.name === undefined ? {} : { name: String(body.name) }),
      ...(body.description === undefined ? {} : { description: String(body.description) }),
      ...(body.category === undefined ? {} : { category: String(body.category) }),
      ...(body.image === undefined ? {} : { image: String(body.image) }),
      ...(body.gameAction === undefined ? {} : { gameAction: String(body.gameAction) }),
      ...(body.quantity === undefined ? {} : { quantity: body.quantity == null ? null : Number(body.quantity) }),
      ...(body.costBuy === undefined ? {} : { costBuy: Number(body.costBuy) }),
      ...(body.costSell === undefined ? {} : { costSell: Number(body.costSell) }),
      ...(body.worldName === undefined ? {} : { worldName: String(body.worldName) }),
      ...(body.isActive === undefined ? {} : { isActive: body.isActive === true }),
      ...(body.sortOrder === undefined ? {} : { sortOrder: Number(body.sortOrder) }),
    });
    if (!item) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
    await auditServerAction(db, actor, 'server.item.update', `server:${id}`, {
      itemId: item.id,
      costBuy: item.costBuy,
      costSell: item.costSell,
    });
    return NextResponse.json({ item });
  } catch (err) {
    console.error('[servers/content] update failed:', err);
    return NextResponse.json({ error: 'Could not save that.' }, { status: 500 });
  } finally {
    await db.end().catch(() => {});
  }
}

/**
 * DELETE → remove a quest or lore entry; retire an item.
 *
 * Items are retired rather than deleted, matching the platform catalogue: a
 * purchase record refers to an item id, and deleting the row would leave a sale
 * that cannot be explained.
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
  const { id } = await params;

  const url = new URL(req.url);
  const kind = kindOf(url.searchParams.get('kind'));
  const targetId = (url.searchParams.get('id') ?? '').trim();
  if (!kind || !targetId) {
    return NextResponse.json({ error: 'kind and id are required.' }, { status: 400 });
  }

  const db = await openServerDb();
  try {
    const access = await requireOwnedServer(db, actor, id);
    if (!access.ok) return NextResponse.json({ error: 'Not found.' }, { status: access.status });

    const removed =
      kind === 'quest' ? await deleteServerQuest(db, id, targetId)
      : kind === 'lore' ? await deleteServerLore(db, id, targetId)
      : await retireServerMarketplaceItem(db, id, targetId);

    if (!removed) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
    await auditServerAction(db, actor, `server.${kind}.delete`, `server:${id}`, { targetId });
    return NextResponse.json({ removed: true });
  } catch (err) {
    console.error('[servers/content] delete failed:', err);
    return NextResponse.json({ error: 'Could not remove that.' }, { status: 500 });
  } finally {
    await db.end().catch(() => {});
  }
}
