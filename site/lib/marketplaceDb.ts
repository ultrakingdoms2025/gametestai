import { randomUUID } from 'node:crypto';
import { Client, type PoolClient } from 'pg';
import { debitInTransaction, ensureCreditSchema } from './creditLedger';
import {
  serverBalance,
  serverLedgerPriorEvent,
  spendServerCreditsInTransaction,
} from './serverCredits';
import {
  buildMarketplaceSeedItems,
  MARKETPLACE_ACTIONS,
  MARKETPLACE_CATEGORIES,
  MARKETPLACE_WORLDS,
  type MarketplaceActionId,
  type MarketplaceCategory,
  type MarketplaceItemRecord,
  type MarketplaceWorld,
} from './marketplaceCatalog';
import {
  ART_GENERATOR_HOST,
  buildMarketplaceAiImageUrl,
  fetchMarketplaceArtDataUri,
  isGeneratedArtUrl,
} from './marketplaceImages';

function makeClient() {
  const connStr = process.env.POSTGRES_URL ?? '';
  const ssl = connStr.includes('sslmode=disable') ? false : { rejectUnauthorized: false };
  return new Client({ connectionString: connStr, ssl });
}

async function query<T extends Record<string, unknown>>(
  text: string,
  values?: unknown[]
): Promise<{ rows: T[] }> {
  const client = makeClient();
  await client.connect();
  try {
    const result = await client.query(text, values);
    return { rows: result.rows as T[] };
  } finally {
    await client.end();
  }
}

let schemaEnsured = false;

export async function ensureMarketplaceSchema() {
  if (schemaEnsured) return;
  await query(`
    CREATE TABLE IF NOT EXISTS marketplace_items (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      source_key    TEXT UNIQUE,
      name          TEXT NOT NULL,
      description   TEXT NOT NULL,
      category      TEXT NOT NULL,
      image         TEXT NOT NULL DEFAULT '',
      game_action   TEXT NOT NULL,
      action_config JSONB NOT NULL DEFAULT '{}'::jsonb,
      quantity      INTEGER,
      cost_buy      INTEGER NOT NULL,
      cost_sell     INTEGER NOT NULL,
      world_name    TEXT NOT NULL,
      is_active     BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order    INTEGER NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  /* `server_id` is READ by the catalogue queries below, which state their
   * scope as `server_id IS NULL` for the platform partition. Phase 7 added the
   * column, but its only `ALTER` lived in `customServers.ts` — a module this
   * route never calls. So in production the SELECT threw
   * `column "server_id" does not exist` (42703) and `/api/marketplace/items`
   * answered 500 to every caller, for as long as nothing happened to have
   * ensured the custom-server schema first.
   *
   * `lore.ts` predicted this exact failure in a comment and defended against
   * it — "must not depend on another module having run first" — which is why
   * `/api/lore` was the only Postgres-backed route still answering 200. An
   * ensure belongs with the READ that needs it, not with whichever module
   * happened to introduce the column. */
  await query(`ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS server_id TEXT`).catch(() => {});
  await query(`CREATE INDEX IF NOT EXISTS marketplace_items_world_idx ON marketplace_items(world_name, is_active, sort_order, name)`);
  await query(`CREATE INDEX IF NOT EXISTS marketplace_items_category_idx ON marketplace_items(category, is_active, sort_order, name)`);
  await query(`CREATE INDEX IF NOT EXISTS marketplace_items_search_idx ON marketplace_items USING GIN (to_tsvector('simple', name || ' ' || description))`).catch(() => {});
  await syncMarketplaceSeedItems();
  await backfillMarketplaceImages();
  schemaEnsured = true;
}

async function syncMarketplaceSeedItems() {
  const seed = buildMarketplaceSeedItems();
  // 505 rows on a cold-start path (ensureMarketplaceSchema): open ONE
  // connection and reuse it for every row, not one connection per row via
  // the module's query() helper (which connect()s and end()s each call).
  const client = makeClient();
  await client.connect();
  try {
    for (const item of seed) {
      await client.query(
        `INSERT INTO marketplace_items
          (source_key, name, description, category, image, game_action, action_config,
            quantity, cost_buy, cost_sell, world_name, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)
         ON CONFLICT (source_key) DO UPDATE
         SET name = EXCLUDED.name,
            description = EXCLUDED.description,
            category = EXCLUDED.category,
            -- BAKED ART SURVIVES A RESEED.
            --
            -- The seed carries an empty image by design (see
            -- marketplaceCatalog), and this sync runs on every cold start. A
            -- plain "image = EXCLUDED.image" would therefore erase every
            -- picture bakeMarketplaceArt had stored, on the next deploy,
            -- silently - so the catalogue would go back to placeholders and
            -- the bake would have to be re-run forever. Stored bytes win; a
            -- row with no art still takes whatever the seed offers.
            image = CASE
                      WHEN marketplace_items.image LIKE 'data:image/%'
                        AND marketplace_items.image NOT LIKE 'data:image/svg+xml%'
                      THEN marketplace_items.image
                      ELSE EXCLUDED.image
                    END,
            game_action = EXCLUDED.game_action,
            action_config = EXCLUDED.action_config,
            cost_buy = EXCLUDED.cost_buy,
            cost_sell = EXCLUDED.cost_sell,
            world_name = EXCLUDED.world_name,
            sort_order = EXCLUDED.sort_order,
            updated_at = NOW()`,
        [
         item.source_key,
         item.name,
          item.description,
          item.category,
          item.image,
          item.game_action,
          JSON.stringify(item.action_config),
          item.quantity,
          item.cost_buy,
          item.cost_sell,
          item.world_name,
          item.sort_order,
        ]
      );
    }
  } finally {
    await client.end();
  }
}

/**
 * Turn every un-baked platform row into a STORED image, one at a time.
 *
 * ── What this replaced ────────────────────────────────────────────────────
 *
 * `backfillMarketplaceImages` used to write `buildMarketplaceAiImageUrl(...)`
 * straight into `image`, so the column held a text-to-image RECIPE rather than
 * a picture. Every player opening a merchant then asked the generator to render
 * the whole catalogue: measured in a live session, 122 requests, 7 loaded, 115
 * refused. It looked like "the images load and then stop", it behaved
 * differently for every player and every visit, and it put a free public AI
 * service on the critical path of the store.
 *
 * ── Why it is not on the request path ─────────────────────────────────────
 *
 * The old backfill was cheap - it wrote strings - so it could live inside
 * `ensureMarketplaceSchema`. This is not: it makes one network call per row
 * against a generator that takes seconds to answer, so running it there would
 * turn a cold start into a timeout. `ensureMarketplaceSchema` now only clears
 * legacy placeholders, and baking is an explicit call
 * (`site/scripts/bake-marketplace-art.mjs`).
 *
 * ── Serial, deliberately ──────────────────────────────────────────────────
 *
 * Parallelism is what caused the original symptom. The generator rate-limits,
 * and 122 concurrent renders is precisely the shape it refuses. One at a time
 * with a pause between is slower to run once and is the only version that
 * finishes.
 *
 * A row that fails is LEFT ALONE - empty image, the placeholder the UI already
 * draws, retried next run. Never a recipe, never a half-answer.
 *
 * @returns counts, so a caller can report rather than guess
 */
export async function bakeMarketplaceArt({
  limit = 100000,
  pauseMs = 750,
  onProgress,
}: {
  limit?: number;
  pauseMs?: number;
  onProgress?: (done: number, total: number, name: string, ok: boolean) => void;
} = {}): Promise<{ total: number; baked: number; failed: number; items: number }> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT id, name, description, category, world_name
     FROM marketplace_items
     WHERE server_id IS NULL
       AND (COALESCE(TRIM(image), '') = ''
            OR image LIKE 'data:image/svg+xml%'
            OR image LIKE 'http%')
     ORDER BY sort_order, name
     LIMIT $1`,
    [limit]
  );

  /* ONE RENDER PER ITEM, NOT PER ROW.
   *
   * The catalogue carries every item once per world - measured, 790 rows over
   * 174 distinct items, so about four and a half rows share each picture. A
   * render takes ~37 s, so baking per ROW is an eight-hour job and baking per
   * ITEM is under two, for the same result: a Rifle Round Pack is the same
   * object whether it is sold on the station or in the vale, and giving it four
   * different pictures was never a feature, only a consequence of the seed
   * keying its prompt on the world.
   *
   * Grouped on name+category because that is what the prompt is actually built
   * from; the world contributes only a style word. The first row of a group
   * supplies the prompt and every row in it gets the same bytes. */
  const groups = new Map<string, { rows: Record<string, unknown>[] }>();
  for (const row of rows) {
    const key = `${String(row.name ?? '').toLowerCase()}|${String(row.category ?? '').toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, { rows: [] });
    groups.get(key)!.rows.push(row);
  }

  let baked = 0;
  let failed = 0;
  let done = 0;
  for (const { rows: group } of groups.values()) {
    const head = group[0];
    const category = String(head.category ?? 'tools').toLowerCase();
    const world = String(head.world_name ?? 'station').toLowerCase();
    const name = String(head.name ?? 'Marketplace item');
    const url = buildMarketplaceAiImageUrl({
      name,
      description: String(head.description ?? ''),
      category: (MARKETPLACE_CATEGORIES.includes(category as MarketplaceCategory)
        ? category
        : 'tools') as MarketplaceCategory,
      world: (MARKETPLACE_WORLDS.includes(world as MarketplaceWorld)
        ? world
        : 'station') as MarketplaceWorld,
      /* Keyed on the ITEM, not the row, so the seed is stable across worlds and
       * a re-bake of the same item reproduces the same picture. */
      sourceKey: `${name}:${category}`,
    });

    const dataUri = await fetchMarketplaceArtDataUri(url);
    if (dataUri) {
      /* Every row in the group in ONE statement - 790 individual UPDATEs each
       * opening its own connection is its own kind of slow. */
      await query(
        `UPDATE marketplace_items SET image = $1, updated_at = NOW() WHERE id = ANY($2::uuid[])`,
        [dataUri, group.map((r) => String(r.id))]
      );
      baked += group.length;
    } else {
      failed += group.length;
    }
    done += 1;
    onProgress?.(done, groups.size, `${name} (${group.length} rows)`, Boolean(dataUri));
    if (pauseMs > 0 && done < groups.size) {
      await new Promise((r) => setTimeout(r, pauseMs));
    }
  }
  return { total: rows.length, baked, failed, items: groups.size };
}

/**
 * Clear art that is not a stored picture, so the UI draws its placeholder.
 *
 * ── This used to WRITE the generator URL, and that was the defect ─────────
 *
 * It filled every empty `image` with `buildMarketplaceAiImageUrl(...)` - a
 * text-to-image recipe. The column then held instructions instead of a picture,
 * and every player's browser executed them on every merchant open: 122 renders
 * asked of a free public generator, of which 7 arrived and 115 were refused.
 *
 * Two things are wrong with doing it here and both are why the fetch moved out.
 * This runs inside `ensureMarketplaceSchema`, on the request path, where a
 * network call per row turns a cold start into a timeout. And a recipe is not
 * art: whatever writes this column must write bytes. Baking is now
 * `bakeMarketplaceArt`, run from `scripts/bake-marketplace-art.mjs`.
 *
 * What is left here is the cheap half, and it is still worth doing: a legacy
 * SVG text placeholder or a stored RECIPE is worse than nothing, because
 * `_renderMktArt` draws a proper category placeholder for an empty image and a
 * broken one for a URL that will not load. Emptying those is a string update,
 * no network, and it makes the catalogue honest until a bake runs.
 *
 * Platform rows only. An owner's item has owner-supplied art, and this must
 * never reach across and empty it.
 */
async function backfillMarketplaceImages() {
  await query(
    `UPDATE marketplace_items
        SET image = '', updated_at = NOW()
      WHERE server_id IS NULL
        AND (image LIKE 'data:image/svg+xml%'
             OR image LIKE $1)`,
    [`%${ART_GENERATOR_HOST}%`]
  );
}

export type MarketplaceItemInput = {
  name: string;
  description: string;
  category: MarketplaceCategory;
  image: string;
  game_action: MarketplaceActionId;
  action_config?: Record<string, unknown>;
  quantity: number | null;
  cost_buy: number;
  cost_sell: number;
  world_name: MarketplaceWorld;
  is_active: boolean;
  sort_order: number;
  source_key?: string | null;
};

type MarketplaceItemPatch = Partial<MarketplaceItemInput>;

function normalizeText(value: unknown, max = 2000) {
  return String(value ?? '').trim().slice(0, max);
}

function normalizeInteger(value: unknown, fallback: number, min = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.floor(n));
}

function normalizeNullableInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.floor(n));
}

function normalizeCategory(value: unknown): MarketplaceCategory {
  const v = String(value ?? '').trim().toLowerCase();
  if ((MARKETPLACE_CATEGORIES as readonly string[]).includes(v)) return v as MarketplaceCategory;
  throw new Error(`Invalid category: ${value}`);
}

function normalizeWorld(value: unknown): MarketplaceWorld {
  const v = String(value ?? '').trim().toLowerCase();
  if ((MARKETPLACE_WORLDS as readonly string[]).includes(v)) return v as MarketplaceWorld;
  throw new Error(`Invalid world: ${value}`);
}

function normalizeAction(value: unknown): MarketplaceActionId {
  const v = String(value ?? '').trim();
  const found = MARKETPLACE_ACTIONS.find((a) => a.id === v);
  if (found) return found.id;
  throw new Error(`Invalid game action: ${value}`);
}

function normalizeActionConfig(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  return value as Record<string, unknown>;
}

function normalizeImage(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  /* A GENERATOR RECIPE IS NOT ART, AND MUST NEVER REACH THIS COLUMN.
   *
   * `image` held `https://image.pollinations.ai/prompt/...` for the whole
   * catalogue, so opening a merchant asked that host to render 122 images on
   * the spot: 7 arrived, 115 were refused, and which ones differed per player
   * and per visit. Stored art is fetched once by `bakeMarketplaceArt` and kept
   * as bytes; anything still pointing at the generator is a recipe that was
   * written where a picture belongs. Refused at the boundary rather than
   * cleaned up afterwards, because the cleanup is what kept being forgotten. */
  if (isGeneratedArtUrl(raw)) {
    throw new Error(
      'Image must be a stored picture, not a generator URL — bake it first (see bakeMarketplaceArt).'
    );
  }
  if (/^https?:\/\//i.test(raw)) return raw.slice(0, 4000);
  if (raw.startsWith('data:image/')) return raw.slice(0, 2_000_000);
  throw new Error('Image must be an http(s) URL or data:image/* data URI.');
}

/**
 * ── ONE UNREADABLE ROW MUST NOT COST THE WHOLE CATALOGUE ───────────────────
 *
 * `rowToItem` throws on a `game_action`, `category` or `world_name` it does not
 * recognise, and `listMarketplaceItems` maps EVERY row through it — so one row
 * an owner authored with `gameAction: "totally_bogus"` answered
 * `GET /api/marketplace/items` with a bodiless 500 for every member of that
 * server, the 612 platform items included. Driven live through the real routes.
 *
 * The fix is at the write (`serverContent.ts` now validates against the same
 * constants this file reads with). This is containment for rows written BEFORE
 * that check existed, which exist in real databases: the site's own
 * `marketplacePurchase.test.ts` seeds six platform rows with
 * `game_action = 'grant_item'` — an `action_config.effect`, never an action id —
 * and never removes them.
 *
 * SKIPPED, not coerced. A `?? 'tools'` fallback would be worse than the 500 it
 * replaces: `game_action` is what the client turns into a GRANT, so a coerced
 * action hands the buyer something other than what the row says, silently and
 * for money. A row nobody can serve honestly is a row nobody should be sold.
 * The console line is the only trace, and it names the row so an owner or an
 * admin can delete it.
 */
export function parseMarketplaceRows(
  rows: Array<Record<string, unknown>>
): MarketplaceItemRecord[] {
  const out: MarketplaceItemRecord[] = [];
  for (const row of rows) {
    try {
      out.push(rowToItem(row));
    } catch (err) {
      console.warn(
        `[marketplace] skipping unreadable item ${String(row.id)} `
          + `(server_id=${row.server_id == null ? 'NULL' : String(row.server_id)}): `
          + `${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return out;
}

function rowToItem(row: Record<string, unknown>): MarketplaceItemRecord {
  return {
    id: String(row.id),
    source_key: row.source_key != null ? String(row.source_key) : null,
    name: String(row.name ?? ''),
    description: String(row.description ?? ''),
    category: normalizeCategory(row.category),
    image: String(row.image ?? ''),
    game_action: normalizeAction(row.game_action),
    action_config: normalizeActionConfig(row.action_config),
    quantity: row.quantity == null ? null : Number(row.quantity),
    cost_buy: Number(row.cost_buy ?? 0),
    cost_sell: Number(row.cost_sell ?? 0),
    world_name: normalizeWorld(row.world_name),
    is_active: Boolean(row.is_active),
    sort_order: Number(row.sort_order ?? 0),
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
  };
}

/**
 * The catalogue, for one content scope.
 *
 * `serverId` is optional and its ABSENCE means the platform partition, never
 * "everything". That default is the whole of 7a's promise here: every caller
 * written before custom servers existed keeps seeing exactly today's content,
 * without being edited, because omitting the argument selects the rows those
 * callers have always seen.
 *
 * A custom server's catalogue is its own items IN ADDITION TO the defaults
 * (decision D2), which is why `includePlatform` exists and defaults to true —
 * the owner's items are an overlay, not a replacement.
 */
export async function listMarketplaceItems(filters: {
  search?: string;
  category?: string;
  world?: string;
  activeOnly?: boolean;
  /** A server's items, in addition to the defaults. Absent means platform only. */
  serverId?: string | null;
  /**
   * The server's content mode, from the SAME `currentContentScope` resolution
   * that produced `serverId`. `'replace'` collapses the merge to "server rows
   * only" — no platform items at all. Absent means `'extend'`, which is
   * byte-for-byte the shipped behaviour, and it only narrows anything when a
   * server was actually resolved.
   */
  contentMode?: 'extend' | 'replace';
} = {}): Promise<MarketplaceItemRecord[]> {
  await ensureMarketplaceSchema();
  const clauses: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  /* The scope, first and unconditionally, written as a LITERAL clause rather
   * than assembled from a helper.
   *
   * That is not stylistic. These queries open their own connection through a
   * module-private helper, so there is no seam for a test to inject a fake
   * client into — the only thing `contentScoping.test.ts` can check is the SQL
   * in the file, and a clause hidden behind `${aVariable}` is a clause it cannot
   * see. A scope that a test can read is worth more here than a scope that is
   * DRY, because the failure being guarded against is a read path with no scope
   * at all.
   *
   * `COALESCE($n, '')` when the server id is null yields `server_id = ''`, which
   * matches nothing — every server id is a UUID — so a player in default mode
   * gets exactly the platform partition. With an id it is the platform IN
   * ADDITION TO that server, which is decision D2 verbatim. */
  const scope = String(filters.serverId ?? '').trim() || null;
  values.push(scope);
  i += 1;

  if (filters.activeOnly !== false) {
    clauses.push(`is_active = TRUE`);
  }
  if (filters.category) {
    clauses.push(`category = $${i++}`);
    values.push(normalizeCategory(filters.category));
  }
  if (filters.world) {
    clauses.push(`world_name = $${i++}`);
    values.push(normalizeWorld(filters.world));
  }
  if (filters.search) {
    const q = normalizeText(filters.search, 200);
    if (q) {
      clauses.push(`(name ILIKE $${i} OR description ILIKE $${i})`);
      values.push(`%${q}%`);
      i += 1;
    }
  }

  /* The scope is in the literal, and only the OPTIONAL filters are interpolated.
   * A scope hidden behind `${where}` is a scope no source test can see, and the
   * failure being guarded against is a read path with no scope at all.
   *
   * Two whole statements for the two modes, the same trade the purchase path
   * makes below: in `replace` mode the merge collapses to the server's own
   * rows, and the `extend` statement stays byte-identical to the one that
   * shipped — pinned by `contentMode.test.ts`, so "extend is unchanged" is a
   * fact a gate reads rather than a promise. */
  const extra = clauses.length ? `AND ${clauses.join(' AND ')}` : '';
  const { rows } = scope && filters.contentMode === 'replace'
    ? await query<Record<string, unknown>>(
        `SELECT id, source_key, name, description, category, image, game_action, action_config,
                quantity, cost_buy, cost_sell, world_name, is_active, sort_order, server_id,
                created_at, updated_at
         FROM marketplace_items
         WHERE server_id = COALESCE($1, '')
         ${extra}
         ORDER BY sort_order ASC, name ASC, created_at ASC`,
        values
      )
    : await query<Record<string, unknown>>(
        `SELECT id, source_key, name, description, category, image, game_action, action_config,
                quantity, cost_buy, cost_sell, world_name, is_active, sort_order, server_id,
                created_at, updated_at
         FROM marketplace_items
         WHERE (server_id IS NULL OR server_id = COALESCE($1, ''))
         ${extra}
         ORDER BY sort_order ASC, name ASC, created_at ASC`,
        values
      );
  /* `parseMarketplaceRows`, not `rows.map(rowToItem)`: one row this module
   * cannot parse used to throw out of here and 500 the catalogue for every
   * caller in scope. See that function for why a bad row is skipped and not
   * coerced. */
  return parseMarketplaceRows(rows);
}

/**
 * One item, in the platform partition.
 *
 * Scoped even though `id` is a primary key, because the callers are the platform
 * catalogue admin and the platform-scoped update below, and neither should be
 * able to reach an owner's item by pasting its id. The mirror image of
 * `serverContent.ts`'s guard, and for the same reason: an owner's item edited
 * through the platform CRUD is an owner's item the owner did not change.
 */
export async function getMarketplaceItem(id: string): Promise<MarketplaceItemRecord | null> {
  await ensureMarketplaceSchema();
  const { rows } = await query<Record<string, unknown>>(
    `SELECT id, source_key, name, description, category, image, game_action, action_config,
            quantity, cost_buy, cost_sell, world_name, is_active, sort_order, created_at, updated_at
     FROM marketplace_items
     WHERE id = $1 AND server_id IS NULL
     LIMIT 1`,
    [id]
  );
  return rows[0] ? rowToItem(rows[0]) : null;
}

/**
 * One item from any scope — for platform-admin oversight only (7c).
 *
 * Named so a call site says what it is doing. `getMarketplaceItem` is the one
 * every ordinary path should use; this exists because the roadmap asks for
 * "platform-admin visibility over all servers and user-created items", and
 * visibility is a different thing from the CRUD above.
 */
export async function getAnyMarketplaceItem(
  id: string
): Promise<(MarketplaceItemRecord & { server_id: string | null }) | null> {
  await ensureMarketplaceSchema();
  /* `server_id` is in the projection, and that is what earns this read its
   * missing WHERE. The rule `contentScoping.test.ts` enforces is that a read
   * over a scoped table either FILTERS by scope or RETURNS it — an unscoped read
   * that also hides the scope hands a row to a caller with no way to tell whose
   * it is, and that is the shape that goes wrong. */
  const { rows } = await query<Record<string, unknown>>(
    `SELECT id, source_key, name, description, category, image, game_action, action_config,
            quantity, cost_buy, cost_sell, world_name, is_active, sort_order,
            server_id, created_at, updated_at
     FROM marketplace_items
     WHERE id = $1
     LIMIT 1`,
    [id]
  );
  if (!rows[0]) return null;
  return {
    ...rowToItem(rows[0]),
    server_id: rows[0].server_id == null ? null : String(rows[0].server_id),
  };
}

export async function createMarketplaceItem(input: MarketplaceItemInput): Promise<MarketplaceItemRecord> {
  await ensureMarketplaceSchema();
  const { rows } = await query<Record<string, unknown>>(
    `INSERT INTO marketplace_items
       (name, description, category, image, game_action, action_config, quantity,
        cost_buy, cost_sell, world_name, is_active, sort_order, source_key)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id, source_key, name, description, category, image, game_action, action_config,
               quantity, cost_buy, cost_sell, world_name, is_active, sort_order, created_at, updated_at`,
    [
      normalizeText(input.name, 120),
      normalizeText(input.description, 2000),
      normalizeCategory(input.category),
      normalizeImage(input.image),
      normalizeAction(input.game_action),
      JSON.stringify(normalizeActionConfig(input.action_config)),
      input.quantity == null ? null : normalizeNullableInteger(input.quantity),
      normalizeInteger(input.cost_buy, 0),
      normalizeInteger(input.cost_sell, 0),
      normalizeWorld(input.world_name),
      !!input.is_active,
      normalizeInteger(input.sort_order, 0),
      input.source_key ? normalizeText(input.source_key, 120) : null,
    ]
  );
  return rowToItem(rows[0]);
}

export async function updateMarketplaceItem(id: string, patch: MarketplaceItemPatch): Promise<MarketplaceItemRecord | null> {
  await ensureMarketplaceSchema();
  const current = await getMarketplaceItem(id);
  if (!current) return null;

  const next = {
    name: patch.name ?? current.name,
    description: patch.description ?? current.description,
    category: patch.category ?? current.category,
    image: patch.image ?? current.image,
    game_action: patch.game_action ?? current.game_action,
    action_config: patch.action_config ?? current.action_config,
    quantity: patch.quantity === undefined ? current.quantity : patch.quantity,
    cost_buy: patch.cost_buy ?? current.cost_buy,
    cost_sell: patch.cost_sell ?? current.cost_sell,
    world_name: patch.world_name ?? current.world_name,
    is_active: patch.is_active ?? current.is_active,
    sort_order: patch.sort_order ?? current.sort_order,
    source_key: patch.source_key === undefined ? current.source_key : patch.source_key,
  };

  const { rows } = await query<Record<string, unknown>>(
    `UPDATE marketplace_items
     SET name = $1,
         description = $2,
         category = $3,
         image = $4,
         game_action = $5,
         action_config = $6::jsonb,
         quantity = $7,
         cost_buy = $8,
         cost_sell = $9,
         world_name = $10,
         is_active = $11,
         sort_order = $12,
         source_key = $13,
         updated_at = NOW()
     -- Platform-scoped, mirroring serverContent.ts. An owner's item has a
     -- non-NULL server_id, so it is out of reach of the platform CRUD by
     -- construction rather than by a check this route remembers to make.
     WHERE id = $14 AND server_id IS NULL
     RETURNING id, source_key, name, description, category, image, game_action, action_config,
               quantity, cost_buy, cost_sell, world_name, is_active, sort_order, created_at, updated_at`,
    [
      normalizeText(next.name, 120),
      normalizeText(next.description, 2000),
      normalizeCategory(next.category),
      normalizeImage(next.image),
      normalizeAction(next.game_action),
      JSON.stringify(normalizeActionConfig(next.action_config)),
      next.quantity == null ? null : normalizeNullableInteger(next.quantity),
      normalizeInteger(next.cost_buy, 0),
      normalizeInteger(next.cost_sell, 0),
      normalizeWorld(next.world_name),
      !!next.is_active,
      normalizeInteger(next.sort_order, 0),
      next.source_key ? normalizeText(next.source_key, 120) : null,
      id,
    ]
  );
  return rows[0] ? rowToItem(rows[0]) : null;
}

export async function removeMarketplaceItem(id: string): Promise<MarketplaceItemRecord | null> {
  await ensureMarketplaceSchema();
  const { rows } = await query<Record<string, unknown>>(
    `UPDATE marketplace_items
     SET is_active = FALSE, updated_at = NOW()
     WHERE id = $1 AND server_id IS NULL
     RETURNING id, source_key, name, description, category, image, game_action, action_config,
               quantity, cost_buy, cost_sell, world_name, is_active, sort_order, created_at, updated_at`,
    [id]
  );
  return rows[0] ? rowToItem(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Buying: the transaction this module has never had
// ---------------------------------------------------------------------------

/**
 * Why this exists.
 *
 * Buying was client-side arithmetic against a client-held wallet. The browser
 * decided the price, decided it could afford it, subtracted it, and the server
 * learned the result only through `POST /api/game/state`, which wrote whatever
 * balance the browser last claimed. There was no purchase transaction anywhere.
 *
 * Here the client names an ITEM, never a price. The cost is read from
 * `marketplace_items.cost_buy` under a row lock, the debit runs against a locked
 * player row, and the stock decrement shares that one transaction — so a sale
 * either happens completely or not at all.
 *
 * ── Lock ordering ──────────────────────────────────────────────────────────
 *
 * Item first, then player, on every path through this function. Two buyers of
 * one item queue on the item; one buyer of two items queues on the player.
 * Neither can form a cycle, because nothing here ever takes the player lock
 * before the item lock. `applyCreditEvent` takes only the player lock, so it
 * cannot close a cycle either.
 */

export type MarketplacePurchaseReason =
  | 'ok'
  | 'duplicate'
  | 'insufficient'
  | 'not_found'
  | 'inactive'
  | 'stock'
  | 'invalid';

export interface MarketplacePurchaseResult {
  applied: boolean;
  reason: MarketplacePurchaseReason;
  /** Authoritative balance after the call, whatever the outcome. */
  balance: number;
  /** What the SERVER charged. Zero unless a debit happened. */
  cost: number;
  /** Remaining stock, or null for an unlimited item. */
  stock: number | null;
  /** Enough for the client to apply the grant. Null when nothing was sold. */
  item: {
    id: string;
    source_key: string | null;
    name: string;
    game_action: string;
    action_config: Record<string, unknown>;
    world_name: string;
  } | null;
}

type PurchaseDb = Client | PoolClient;

/** marketplace_items.id is a UUID column: a malformed id must not reach it. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function balanceOf(db: PurchaseDb, playerId: string): Promise<number> {
  const r = await db.query('SELECT credit_balance FROM players WHERE id = $1', [playerId]);
  return Number(r.rows[0]?.credit_balance ?? 0);
}

/**
 * Buy one catalogue item, server-priced, inside one transaction.
 *
 * `eventKey` is the idempotency key. A retried or replayed request charges once
 * — and, importantly, a retry REPORTS THE ORIGINAL OUTCOME rather than being
 * re-evaluated. Re-evaluating a retry is a trap worth naming: the first attempt
 * has already spent the credits, so a naive second pass sees the reduced balance
 * and answers `insufficient`, telling the client a purchase failed that in fact
 * succeeded. The client would then show an error for an item the player owns.
 *
 * ── `itemId` is a REFERENCE: a row id, or a `source_key` ──────────────────
 *
 * Both, because the shop the player is looking at is not always the API's. When
 * `/api/marketplace/items` is unreachable the client falls back to the bundled
 * catalogue (`src/systems/MarketplaceOffline.js`), whose rows carry
 * `id = \`${source_key}:${world}\`` — which is exactly the key the seeder writes
 * into `marketplace_items.source_key`, deliberately, so "an offline purchase and
 * an online one name the same row". Accepting only the UUID would have made
 * every offline purchase unresolvable and therefore FREE, which is a new hole in
 * the act of closing one.
 *
 * `source_key` is UNIQUE and NULL on every owner-authored row, so a lookup by
 * key can only ever reach the platform partition — which is the only partition
 * the offline catalogue contains.
 */
export async function purchaseMarketplaceItem(
  db: PurchaseDb,
  playerId: string,
  request: {
    itemId: string;
    eventKey: string;
    serverId?: string | null;
    /**
     * The server's content mode, from the SAME `currentContentScope`
     * resolution that produced `serverId`. THE PURCHASE MUST AGREE WITH THE
     * LIST: in `replace` mode `listMarketplaceItems` serves the server's rows
     * only, so this path refuses a platform item id with `not_found` — the
     * same answer a cross-server id gets — or a replace-mode player could buy
     * an item they cannot see. Absent means `'extend'`: the shipped behaviour.
     */
    contentMode?: 'extend' | 'replace';
  }
): Promise<MarketplacePurchaseResult> {
  const { itemId, eventKey } = request;
  /* Which catalogue this buyer is shopping in. Absent means the platform one —
   * the same default `listMarketplaceItems` has, so a caller written before
   * custom servers existed buys exactly what it has always bought.
   *
   * This is load-bearing rather than tidy. Without it a player in default mode
   * could POST an owner's item id and buy it: the id is a UUID, but ids are not
   * secrets and the ONLY thing standing between an unscoped `WHERE id = $1` and
   * a cross-server purchase would be that nobody had guessed one.
   *
   * Written as a literal clause with a COALESCE rather than assembled from
   * a shared helper, for the reason `listMarketplaceItems` records: a
   * clause behind a `${variable}` is a clause the source test cannot read. */
  const scope = String(request.serverId ?? '').trim() || null;
  /* Only meaningful WITH a server resolved: replace-with-no-server has
   * nothing to replace with, so default mode buys from the platform partition
   * exactly as it always has. */
  const replaceOnly = request.contentMode === 'replace' && scope !== null;

  /* ── WHICH LEDGER THE MONEY MOVES ON ────────────────────────────────────
   *
   * A resolved server means the SERVER ledger, full stop — including a
   * platform item bought in extend mode. This flips the old "orthogonal
   * economies" behaviour BY DESIGN, at the owner's explicit instruction:
   * while a player is inside a custom server, the platform balance must never
   * move; while outside, the server ledgers must never move
   * (`economySeparation.test.ts` holds both directions). Pricing, the
   * stock decrement, replay reporting and the sale record are the SAME code
   * below for both ledgers — only these three seams differ, so the money side
   * cannot drift from the catalogue side. */
  const balanceNow = () =>
    scope ? serverBalance(db, scope, playerId) : balanceOf(db, playerId);

  const refuse = async (
    reason: MarketplacePurchaseReason
  ): Promise<MarketplacePurchaseResult> => ({
    applied: false,
    reason,
    balance: await balanceNow(),
    cost: 0,
    stock: null,
    item: null,
  });

  if (typeof eventKey !== 'string' || eventKey.length === 0 || eventKey.length > 200) {
    return refuse('invalid');
  }
  const ref = typeof itemId === 'string' ? itemId.trim() : '';
  if (ref.length === 0 || ref.length > 200) return refuse('not_found');
  /* Which column the reference names. Decided HERE rather than in the SQL,
   * because `id` is a UUID column and handing it a `source_key` raises
   * "invalid input syntax for type uuid" (22P02) — a 500 out of a route, for a
   * request that should simply not find anything. */
  const byRowId = UUID_RE.test(ref);

  await db.query('BEGIN');
  try {
    /* A replay answers with what happened the first time — checked against the
     * ledger the money actually moved on, so a scoped retry cannot be
     * re-evaluated against the platform's (untouched) history or vice versa. */
    const prior = scope
      ? await serverLedgerPriorEvent(db, scope, playerId, eventKey)
      : ((await db.query(
          'SELECT delta FROM credit_events WHERE player_id = $1 AND event_key = $2',
          [playerId, eventKey]
        )).rows[0] as { delta: unknown } | undefined ?? null);
    if (prior) {
      const balance = await balanceNow();
      await db.query('ROLLBACK');
      return {
        applied: false,
        reason: 'duplicate',
        balance,
        cost: Math.abs(Number(prior.delta)),
        stock: null,
        item: null,
      };
    }

    /* Whole statements rather than one with a clever predicate, and the
     * scope clause written out LITERALLY in each. `contentScoping.test.ts` reads
     * these strings out of the source — that is the only seam it has, because
     * this module opens its own connections — and a clause assembled from a
     * `${variable}` is a clause no source test can see. Duplication that a gate
     * can read beats a single statement it cannot.
     *
     * The `replace` pair narrows to the server's own rows, agreeing with the
     * list. Its `source_key` arm deserves a note: `source_key` is NULL on
     * every owner-authored row, so in replace mode a source-key reference —
     * which is how the OFFLINE fallback catalogue names items, and that
     * catalogue is the platform's — can match nothing and answers `not_found`.
     * That is correct, not incidental: the offline shop shows platform items,
     * and in replace mode the platform is not for sale. The `extend` pair is
     * byte-identical to the statements that shipped (`contentMode.test.ts`
     * pins it). */
    const found = replaceOnly
      ? (byRowId
        ? await db.query(
            `SELECT id, source_key, name, game_action, action_config, quantity, cost_buy,
                    is_active, world_name
               FROM marketplace_items
              WHERE id = $1
                AND server_id = COALESCE($2, '')
                FOR UPDATE`,
            [ref, scope]
          )
        : await db.query(
            `SELECT id, source_key, name, game_action, action_config, quantity, cost_buy,
                    is_active, world_name
               FROM marketplace_items
              WHERE source_key = $1
                AND server_id = COALESCE($2, '')
                FOR UPDATE`,
            [ref, scope]
          ))
      : (byRowId
        ? await db.query(
            `SELECT id, source_key, name, game_action, action_config, quantity, cost_buy,
                    is_active, world_name
               FROM marketplace_items
              WHERE id = $1
                AND (server_id IS NULL OR server_id = COALESCE($2, ''))
                FOR UPDATE`,
            [ref, scope]
          )
        : await db.query(
            `SELECT id, source_key, name, game_action, action_config, quantity, cost_buy,
                    is_active, world_name
               FROM marketplace_items
              WHERE source_key = $1
                AND (server_id IS NULL OR server_id = COALESCE($2, ''))
                FOR UPDATE`,
            [ref, scope]
          ));
    const row = found.rows[0];
    if (!row) {
      await db.query('ROLLBACK');
      return refuse('not_found');
    }

    const item = {
      id: String(row.id),
      source_key: row.source_key != null ? String(row.source_key) : null,
      name: String(row.name ?? ''),
      game_action: String(row.game_action ?? ''),
      action_config: (row.action_config ?? {}) as Record<string, unknown>,
      world_name: String(row.world_name ?? ''),
    };
    const stock = row.quantity == null ? null : Number(row.quantity);
    const cost = Number(row.cost_buy);

    if (!row.is_active) {
      await db.query('ROLLBACK');
      return { applied: false, reason: 'inactive', balance: await balanceNow(), cost: 0, stock, item };
    }
    // `credits` is a VIRTUAL item id: Inventory._addCredits turns it straight
    // into balance (Inventory.js:437). The client derives its grant id from
    // `source_key`, so an admin-authored row keyed 'credits' would be a machine
    // for turning cost_buy into an arbitrary payout -- and if the grant exceeded
    // the price, an unbounded one. Nothing legitimate sells credits for credits.
    if (item.source_key === 'credits') {
      await db.query('ROLLBACK');
      return { applied: false, reason: 'invalid', balance: await balanceNow(), cost: 0, stock, item };
    }
    if (!Number.isInteger(cost) || cost <= 0) {
      // A zero or negative price is a catalogue authoring error, not a gift: it
      // would hand out limited stock for nothing while skipping the balance
      // check entirely. No seed row is priced this way today.
      await db.query('ROLLBACK');
      return { applied: false, reason: 'invalid', balance: await balanceNow(), cost: 0, stock, item };
    }
    if (stock !== null && stock <= 0) {
      await db.query('ROLLBACK');
      return { applied: false, reason: 'stock', balance: await balanceNow(), cost: 0, stock, item };
    }

    const detail = `item:${item.source_key ?? item.id}`;
    /* The one seam where the two ledgers part company: same lock-check-insert
     * discipline on both sides (`spendServerCreditsInTransaction` is the
     * server-ledger mirror of `debitInTransaction`, by design). */
    const debit = scope
      ? await spendServerCreditsInTransaction(db, scope, playerId, { cost, detail, eventKey })
      : await debitInTransaction(db, playerId, { cost, detail, eventKey });
    if (!debit.applied) {
      await db.query('ROLLBACK');
      const reason: MarketplacePurchaseReason =
        debit.reason === 'insufficient'
          ? 'insufficient'
          : debit.reason === 'duplicate'
            ? 'duplicate'
            : 'invalid';
      return { applied: false, reason, balance: debit.balance, cost: 0, stock, item };
    }

    let remaining = stock;
    if (stock !== null) {
      const dec = await db.query(
        `UPDATE marketplace_items
            SET quantity = quantity - 1, updated_at = NOW()
          WHERE id = $1 AND quantity > 0
          RETURNING quantity`,
        // `item.id`, not the caller's reference: the reference may have been a
        // source_key, and this UPDATE is against the row that was LOCKED above.
        [item.id]
      );
      if (!dec.rows[0]) {
        // Unreachable while the row lock above is held. Left in because the
        // alternative to failing loudly here is selling stock that is not there.
        await db.query('ROLLBACK');
        return { applied: false, reason: 'stock', balance: debit.balance + cost, cost: 0, stock, item };
      }
      remaining = Number(dec.rows[0].quantity);
    }

    // The admin-visible sale record, in the SAME transaction as the money. It
    // used to be written from the client's `trades` array via /api/game/state,
    // best-effort, for a purchase the server had never authorised.
    // amount_cents is 0 because no real money moved.
    await db.query(
      `INSERT INTO purchases (id, player_id, stripe_intent_enc, amount_cents, currency,
                              type, credits_amount, status)
       VALUES ($1, $2, $3, 0, 'credits', 'market_buy', $4, 'completed')`,
      [randomUUID(), playerId, `game:buy:${item.name.slice(0, 60)} x1`, cost]
    );

    await db.query('COMMIT');
    return { applied: true, reason: 'ok', balance: debit.balance, cost, stock: remaining, item };
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/**
 * The same purchase, opening and closing its own connection — the idiom the rest
 * of this module uses. Ensures both schemas first, because a purchase touches
 * `marketplace_items` and `credit_events` together.
 */
export async function purchaseMarketplaceItemForPlayer(
  playerId: string,
  request: { itemId: string; eventKey: string }
): Promise<MarketplacePurchaseResult> {
  await ensureMarketplaceSchema();
  const client = makeClient();
  await client.connect();
  try {
    await ensureCreditSchema(client);
    return await purchaseMarketplaceItem(client, playerId, request);
  } finally {
    await client.end();
  }
}
