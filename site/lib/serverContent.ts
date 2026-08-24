import { randomUUID } from 'node:crypto';
import type { Client, PoolClient } from 'pg';

/**
 * Owner CRUD over an owner's OWN lore, quests and marketplace items — and the
 * one place in this phase where a security guarantee rests on a writer.
 *
 * ── The residual this file was created to discharge ───────────────────────
 *
 * `leaderboard.ts` closes the Phase 7 abuse vector by construction: a global
 * board enumerates the platform content manifest in its `FROM` clause, so a
 * forged world id is not a candidate and there is no filter to forget. It
 * recorded exactly one place where that argument does not reach:
 *
 *   > "A quest authored by an owner INTO A PLATFORM WORLD with `server_id` left
 *   > NULL is, by every column this table has, a platform quest. Phase 7c's
 *   > owner CRUD must stamp it."
 *
 * So the stamp is not a field on an input object that a caller passes and a
 * future caller forgets. It is the SECOND POSITIONAL ARGUMENT of every function
 * here, it is validated before any statement is issued, and it appears in the
 * `WHERE` of every read, update and delete. There is no call shape that writes
 * a NULL `server_id`, and there is no call shape that reaches a row whose
 * `server_id` is NULL — a platform row is unreachable because NULL matches no
 * equality, which is a property of SQL rather than of anyone's diligence.
 *
 * That second half matters as much as the first. An owner who could PATCH a
 * platform quest's `reward_credits` to 10,000 would not need to author anything
 * at all; the quest would already be in the manifest, already unstamped, and
 * already ranked.
 *
 * ── Why owner lore is a different table ───────────────────────────────────
 *
 * `lore_entries.scope` is a PRIMARY KEY and three live paths in
 * `admin/lib/db.ts` upsert against it with `ON CONFLICT (scope)`. Relaxing that
 * key to make room for per-server variants breaks all three, and the two apps
 * deploy independently, so there is no ordering that avoids a broken window.
 * `server_lore_entries` has no such window. `customServers.ts` records this at
 * length.
 *
 * ── Quest numbers ─────────────────────────────────────────────────────────
 *
 * `quests.quest_number` is `INTEGER UNIQUE NOT NULL` across the whole table, so
 * owner quests need numbers that cannot collide with an authored platform one.
 * They come from a sequence starting at 1,000,000, not from `MAX(quest_number)
 * + 1`: two owners authoring in the same second both read the same maximum, and
 * one of them loses to the UNIQUE constraint for no reason the owner can act on.
 * A sequence has no such race, which is the same argument the credit ledger
 * makes for letting the database settle idempotency.
 */

/** Any pg client — a plain Client in tests, a pooled one in a route. */
type Db = Client | PoolClient;

/**
 * Where owner quest numbers start.
 *
 * Above anything the platform will author: the seeded catalogue is in the low
 * hundreds and the admin editor allocates by hand.
 */
export const OWNER_QUEST_NUMBER_FLOOR = 1_000_000;

/**
 * The stamp, validated once, at the top of everything.
 *
 * Throws rather than returning a refusal because a missing server id is not a
 * condition a caller can recover from — it is a call that should not have been
 * written. A silent refusal here would be indistinguishable from "the row was
 * not found", which is precisely how a NULL stamp gets shipped.
 */
function requireServerId(serverId: string): string {
  const id = String(serverId ?? '').trim();
  if (!id) {
    throw new Error(
      'serverContent: a server id is required. Owner content must be stamped at write '
        + 'time — an unstamped quest in a platform world is a platform quest.'
    );
  }
  return id;
}

function text(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

function nonNegativeInt(value: unknown, fallback = 0): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.trunc(n));
}

/* ---------------------------------------------------------------------- */
/* Quests                                                                  */
/* ---------------------------------------------------------------------- */

export interface ServerQuestInput {
  world: string;
  title: string;
  questLine: string;
  rewardCredits: number;
  durationMinutes?: number | null;
  steps?: string | null;
  preSteps?: string | null;
  isActive?: boolean;
  repeatable?: boolean;
  updatedBy?: string | null;
}

export interface ServerQuest {
  id: string;
  serverId: string;
  questNumber: number;
  world: string;
  questLine: string;
  title: string;
  rewardCredits: number;
  durationMinutes: number | null;
  steps: string | null;
  isActive: boolean;
  repeatable: boolean;
}

const QUEST_COLS =
  'id, server_id, quest_number, world, quest_line, title, reward_credits, '
  + 'duration_minutes, steps, is_active, repeatable';

function toQuest(row: Record<string, unknown>): ServerQuest {
  return {
    id: String(row.id),
    serverId: String(row.server_id ?? ''),
    questNumber: Number(row.quest_number ?? 0),
    world: String(row.world ?? ''),
    questLine: String(row.quest_line ?? ''),
    title: String(row.title ?? ''),
    rewardCredits: Number(row.reward_credits ?? 0),
    durationMinutes: row.duration_minutes == null ? null : Number(row.duration_minutes),
    steps: row.steps == null ? null : String(row.steps),
    isActive: row.is_active !== false,
    repeatable: row.repeatable === true,
  };
}

/**
 * Ensure the owner quest-number sequence exists.
 *
 * Not part of `ensureCustomServerSchema` because it is the only object here that
 * belongs to a table another app owns, and because it is cheap and idempotent.
 */
/**
 * Ensure the columns THIS module reads and writes exist.
 *
 * Every function here stamps and filters on `server_id`, on tables another app
 * owns. Phase 7 put those `ALTER`s wherever the column was introduced rather
 * than with the reads: `quests.server_id` only in `leaderboard.ts`, and
 * `marketplace_items.server_id` only in `customServers.ts` — which does NOT
 * cover `quests`. So this module depended on one of two unrelated modules
 * having run first.
 *
 * That dependency is not theoretical. In production it took
 * `/api/game/quests` and `/api/marketplace/items` to HTTP 500 for every
 * caller, signed in or out, with `column "server_id" does not exist` (42703).
 * `lore.ts` is the one module that ensured its own column, wrote down why —
 * "must not depend on another module having run first" — and is the one
 * Postgres-backed route that stayed up.
 *
 * Idempotent and additive, so it is safe on every call and on a database that
 * already has them.
 */
async function ensureServerContentColumns(db: Db): Promise<void> {
  await db.query(`ALTER TABLE quests ADD COLUMN IF NOT EXISTS server_id TEXT`).catch(() => {});
  await db
    .query(`ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS server_id TEXT`)
    .catch(() => {});
}

async function ensureQuestSequence(db: Db): Promise<void> {
  await db.query(
    `CREATE SEQUENCE IF NOT EXISTS server_quest_number_seq START ${OWNER_QUEST_NUMBER_FLOOR}`
  );
  /* A sequence created by an earlier, lower START (or by a hand edit) would
   * hand out numbers inside the platform band. Nudged forward rather than
   * recreated, which would lose whatever it has already issued. */
  await db.query(
    `SELECT setval('server_quest_number_seq', GREATEST(
       (SELECT last_value FROM server_quest_number_seq), ${OWNER_QUEST_NUMBER_FLOOR}))`
  ).catch(() => {});
}

/**
 * Author one quest for one server.
 *
 * `server_id` is bound from the required argument on the way in. It is not
 * defaulted, not read from `input`, and not patchable afterwards — `updateServerQuest`
 * has no branch that writes it.
 */
export async function createServerQuest(
  db: Db,
  serverId: string,
  input: ServerQuestInput
): Promise<ServerQuest> {
  const sid = requireServerId(serverId);
  await ensureServerContentColumns(db);
  await ensureQuestSequence(db);

  const next = await db.query(`SELECT nextval('server_quest_number_seq')::int AS n`);
  const questNumber = Number(next.rows[0]?.n ?? OWNER_QUEST_NUMBER_FLOOR);
  const id = randomUUID();

  const r = await db.query(
    `INSERT INTO quests
       (id, quest_number, world, quest_line, title, reward_credits, duration_minutes,
        pre_steps, steps, is_active, repeatable, updated_by, server_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING ${QUEST_COLS}`,
    [
      id,
      questNumber,
      text(input.world, 64).toLowerCase(),
      text(input.questLine, 120) || 'custom',
      text(input.title, 200),
      nonNegativeInt(input.rewardCredits),
      input.durationMinutes == null ? null : nonNegativeInt(input.durationMinutes),
      input.preSteps == null ? null : text(input.preSteps, 4000),
      input.steps == null ? null : text(input.steps, 20_000),
      input.isActive !== false,
      input.repeatable === true,
      input.updatedBy == null ? null : text(input.updatedBy, 200),
      sid,
    ]
  );
  return toQuest(r.rows[0] ?? { id, server_id: sid, quest_number: questNumber });
}

export interface ServerQuestPatch {
  world?: string;
  title?: string;
  questLine?: string;
  rewardCredits?: number;
  durationMinutes?: number | null;
  steps?: string | null;
  isActive?: boolean;
  repeatable?: boolean;
  updatedBy?: string | null;
}

/**
 * Patch a quest, if it belongs to this server.
 *
 * `AND server_id = $n` is what makes a platform quest unreachable: its
 * `server_id` is NULL, and `NULL = 'anything'` is NULL, which is not true. The
 * owner does not need to be trusted not to send a platform quest id.
 *
 * COALESCE per column so an absent field means "leave it", without a prior SELECT
 * for a concurrent write to race against.
 */
export async function updateServerQuest(
  db: Db,
  serverId: string,
  questId: string,
  patch: ServerQuestPatch
): Promise<ServerQuest | null> {
  const sid = requireServerId(serverId);
  await ensureServerContentColumns(db);
  const r = await db.query(
    `UPDATE quests SET
       world            = COALESCE($3, world),
       quest_line       = COALESCE($4, quest_line),
       title            = COALESCE($5, title),
       reward_credits   = COALESCE($6::int, reward_credits),
       duration_minutes = COALESCE($7::int, duration_minutes),
       steps            = COALESCE($8, steps),
       is_active        = COALESCE($9::boolean, is_active),
       repeatable       = COALESCE($10::boolean, repeatable),
       updated_by       = COALESCE($11, updated_by),
       updated_at       = NOW()
     WHERE id = $1 AND server_id = $2
     RETURNING ${QUEST_COLS}`,
    [
      questId,
      sid,
      patch.world === undefined ? null : text(patch.world, 64).toLowerCase(),
      patch.questLine === undefined ? null : text(patch.questLine, 120),
      patch.title === undefined ? null : text(patch.title, 200),
      patch.rewardCredits === undefined ? null : nonNegativeInt(patch.rewardCredits),
      patch.durationMinutes === undefined || patch.durationMinutes === null
        ? null
        : nonNegativeInt(patch.durationMinutes),
      patch.steps === undefined ? null : patch.steps,
      patch.isActive === undefined ? null : !!patch.isActive,
      patch.repeatable === undefined ? null : !!patch.repeatable,
      patch.updatedBy === undefined || patch.updatedBy === null
        ? null
        : text(patch.updatedBy, 200),
    ]
  );
  return r.rows[0] ? toQuest(r.rows[0]) : null;
}

/** Delete a quest, if it belongs to this server. `false` means it did not. */
export async function deleteServerQuest(
  db: Db,
  serverId: string,
  questId: string
): Promise<boolean> {
  const sid = requireServerId(serverId);
  await ensureServerContentColumns(db);
  const r = await db.query(`DELETE FROM quests WHERE id = $1 AND server_id = $2 RETURNING id`, [
    questId,
    sid,
  ]);
  return (r.rowCount ?? 0) > 0;
}

/** One server's quests. Never the platform catalogue. */
export async function listServerQuests(db: Db, serverId: string): Promise<ServerQuest[]> {
  const sid = requireServerId(serverId);
  await ensureServerContentColumns(db);
  const r = await db.query(
    `SELECT ${QUEST_COLS} FROM quests WHERE server_id = $1 ORDER BY quest_number`,
    [sid]
  );
  return r.rows.map(toQuest);
}

/* ---------------------------------------------------------------------- */
/* Lore                                                                    */
/* ---------------------------------------------------------------------- */

export interface ServerLoreInput {
  scope: string;
  title: string;
  signLabel?: string;
  body: string;
  updatedBy?: string | null;
}

export interface ServerLoreEntry {
  serverId: string;
  scope: string;
  title: string;
  signLabel: string;
  body: string;
}

export async function upsertServerLore(
  db: Db,
  serverId: string,
  input: ServerLoreInput
): Promise<ServerLoreEntry> {
  const sid = requireServerId(serverId);
  const scope = text(input.scope, 64).toLowerCase();
  await db.query(
    `INSERT INTO server_lore_entries (server_id, scope, title, sign_label, body, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (server_id, scope) DO UPDATE SET
       title = EXCLUDED.title, sign_label = EXCLUDED.sign_label, body = EXCLUDED.body,
       updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [
      sid,
      scope,
      text(input.title, 200),
      text(input.signLabel ?? 'Lorekeeper', 80) || 'Lorekeeper',
      text(input.body, 20_000),
      input.updatedBy == null ? null : text(input.updatedBy, 200),
    ]
  );
  return {
    serverId: sid,
    scope,
    title: text(input.title, 200),
    signLabel: text(input.signLabel ?? 'Lorekeeper', 80) || 'Lorekeeper',
    body: text(input.body, 20_000),
  };
}

export async function listServerLore(db: Db, serverId: string): Promise<ServerLoreEntry[]> {
  const sid = requireServerId(serverId);
  const r = await db.query(
    `SELECT server_id, scope, title, sign_label, body
       FROM server_lore_entries WHERE server_id = $1 ORDER BY scope`,
    [sid]
  );
  return r.rows.map((row) => ({
    serverId: String(row.server_id),
    scope: String(row.scope),
    title: String(row.title ?? ''),
    signLabel: String(row.sign_label ?? 'Lorekeeper'),
    body: String(row.body ?? ''),
  }));
}

export async function deleteServerLore(
  db: Db,
  serverId: string,
  scope: string
): Promise<boolean> {
  const sid = requireServerId(serverId);
  const r = await db.query(
    `DELETE FROM server_lore_entries WHERE server_id = $1 AND scope = $2 RETURNING scope`,
    [sid, text(scope, 64).toLowerCase()]
  );
  return (r.rowCount ?? 0) > 0;
}

/* ---------------------------------------------------------------------- */
/* Marketplace items                                                       */
/* ---------------------------------------------------------------------- */

export interface ServerItemInput {
  name: string;
  description: string;
  category: string;
  image: string;
  gameAction: string;
  actionConfig: Record<string, unknown>;
  quantity: number | null;
  costBuy: number;
  costSell: number;
  worldName: string;
  sortOrder: number;
  isActive?: boolean;
}

export interface ServerItem {
  id: string;
  serverId: string;
  name: string;
  description: string;
  category: string;
  image: string;
  gameAction: string;
  actionConfig: Record<string, unknown>;
  quantity: number | null;
  costBuy: number;
  costSell: number;
  worldName: string;
  isActive: boolean;
  sortOrder: number;
}

const ITEM_COLS =
  'id, server_id, name, description, category, image, game_action, action_config, '
  + 'quantity, cost_buy, cost_sell, world_name, is_active, sort_order';

function toItem(row: Record<string, unknown>): ServerItem {
  return {
    id: String(row.id),
    serverId: String(row.server_id ?? ''),
    name: String(row.name ?? ''),
    description: String(row.description ?? ''),
    category: String(row.category ?? ''),
    image: String(row.image ?? ''),
    gameAction: String(row.game_action ?? ''),
    actionConfig: (row.action_config ?? {}) as Record<string, unknown>,
    quantity: row.quantity == null ? null : Number(row.quantity),
    costBuy: Number(row.cost_buy ?? 0),
    costSell: Number(row.cost_sell ?? 0),
    worldName: String(row.world_name ?? ''),
    isActive: row.is_active !== false,
    sortOrder: Number(row.sort_order ?? 0),
  };
}

/**
 * `source_key` is deliberately left NULL for owner items.
 *
 * It is the key the game derives a grant id from, and `marketplaceDb`'s purchase
 * path already refuses the one value that matters (`'credits'`, a virtual id
 * that turns `cost_buy` into an arbitrary payout). Letting an owner choose a
 * source key would hand them the whole namespace of grants the platform defines,
 * which is a different and larger version of the same hole.
 */
export async function createServerMarketplaceItem(
  db: Db,
  serverId: string,
  input: ServerItemInput
): Promise<ServerItem> {
  const sid = requireServerId(serverId);
  await ensureServerContentColumns(db);
  const id = randomUUID();
  const r = await db.query(
    `INSERT INTO marketplace_items
       (id, name, description, category, image, game_action, action_config, quantity,
        cost_buy, cost_sell, world_name, is_active, sort_order, source_key, server_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, NULL, $14)
     RETURNING ${ITEM_COLS}`,
    [
      id,
      text(input.name, 120),
      text(input.description, 2000),
      text(input.category, 40).toLowerCase(),
      text(input.image, 4000),
      text(input.gameAction, 60),
      JSON.stringify(input.actionConfig ?? {}),
      input.quantity == null ? null : nonNegativeInt(input.quantity),
      nonNegativeInt(input.costBuy),
      nonNegativeInt(input.costSell),
      text(input.worldName, 40).toLowerCase(),
      input.isActive !== false,
      nonNegativeInt(input.sortOrder),
      sid,
    ]
  );
  return toItem(r.rows[0] ?? { id, server_id: sid });
}

export async function updateServerMarketplaceItem(
  db: Db,
  serverId: string,
  itemId: string,
  patch: Partial<ServerItemInput>
): Promise<ServerItem | null> {
  const sid = requireServerId(serverId);
  await ensureServerContentColumns(db);
  const r = await db.query(
    `UPDATE marketplace_items SET
       name        = COALESCE($3, name),
       description = COALESCE($4, description),
       category    = COALESCE($5, category),
       image       = COALESCE($6, image),
       game_action = COALESCE($7, game_action),
       quantity    = COALESCE($8::int, quantity),
       cost_buy    = COALESCE($9::int, cost_buy),
       cost_sell   = COALESCE($10::int, cost_sell),
       world_name  = COALESCE($11, world_name),
       is_active   = COALESCE($12::boolean, is_active),
       sort_order  = COALESCE($13::int, sort_order),
       updated_at  = NOW()
     WHERE id = $1 AND server_id = $2
     RETURNING ${ITEM_COLS}`,
    [
      itemId,
      sid,
      patch.name === undefined ? null : text(patch.name, 120),
      patch.description === undefined ? null : text(patch.description, 2000),
      patch.category === undefined ? null : text(patch.category, 40).toLowerCase(),
      patch.image === undefined ? null : text(patch.image, 4000),
      patch.gameAction === undefined ? null : text(patch.gameAction, 60),
      patch.quantity === undefined || patch.quantity === null ? null : nonNegativeInt(patch.quantity),
      patch.costBuy === undefined ? null : nonNegativeInt(patch.costBuy),
      patch.costSell === undefined ? null : nonNegativeInt(patch.costSell),
      patch.worldName === undefined ? null : text(patch.worldName, 40).toLowerCase(),
      patch.isActive === undefined ? null : !!patch.isActive,
      patch.sortOrder === undefined ? null : nonNegativeInt(patch.sortOrder),
    ]
  );
  return r.rows[0] ? toItem(r.rows[0]) : null;
}

/** Retire an item. Soft, like the platform path, so a sale record still resolves. */
export async function retireServerMarketplaceItem(
  db: Db,
  serverId: string,
  itemId: string
): Promise<boolean> {
  const sid = requireServerId(serverId);
  await ensureServerContentColumns(db);
  const r = await db.query(
    `UPDATE marketplace_items SET is_active = FALSE, updated_at = NOW()
      WHERE id = $1 AND server_id = $2 RETURNING id`,
    [itemId, sid]
  );
  return (r.rowCount ?? 0) > 0;
}

export async function listServerMarketplaceItems(
  db: Db,
  serverId: string,
  opts: { activeOnly?: boolean } = {}
): Promise<ServerItem[]> {
  const sid = requireServerId(serverId);
  await ensureServerContentColumns(db);
  const r = await db.query(
    `SELECT ${ITEM_COLS} FROM marketplace_items
      WHERE server_id = $1 ${opts.activeOnly === false ? '' : 'AND is_active = TRUE'}
      ORDER BY sort_order, name`,
    [sid]
  );
  return r.rows.map(toItem);
}
