import { Client } from 'pg';
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
  await query(`CREATE INDEX IF NOT EXISTS marketplace_items_world_idx ON marketplace_items(world_name, is_active, sort_order, name)`);
  await query(`CREATE INDEX IF NOT EXISTS marketplace_items_category_idx ON marketplace_items(category, is_active, sort_order, name)`);
  await query(`CREATE INDEX IF NOT EXISTS marketplace_items_search_idx ON marketplace_items USING GIN (to_tsvector('simple', name || ' ' || description))`).catch(() => {});
  await syncMarketplaceSeedItems();
  await backfillMarketplaceImages();
  schemaEnsured = true;
}

async function syncMarketplaceSeedItems() {
  const seed = buildMarketplaceSeedItems();
  for (const item of seed) {
    await query(
      `INSERT INTO marketplace_items
        (source_key, name, description, category, image, game_action, action_config,
          quantity, cost_buy, cost_sell, world_name, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)
       ON CONFLICT (source_key) DO UPDATE
       SET name = EXCLUDED.name,
          description = EXCLUDED.description,
          category = EXCLUDED.category,
          image = EXCLUDED.image,
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
}

function buildFallbackImage(name: string, category: string, world: string): string {
  const label = (name || 'ITEM')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .slice(0, 12) || 'ITEM';
  const worldTag = (world || 'NEXUS')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, 3) || 'NX';
  const colorByCategory: Record<string, string> = {
    cosmetic: '#d46bff',
    weapons: '#52e9ff',
    tools: '#ffb44a',
    health: '#b6ff5a',
    spells: '#ff7d3c',
  };
  const fg = colorByCategory[category] ?? '#52e9ff';
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#0c1722"/>
          <stop offset="1" stop-color="#1c3144"/>
        </linearGradient>
      </defs>
      <rect width="128" height="128" rx="20" fill="url(#bg)"/>
      <rect x="14" y="14" width="100" height="100" rx="18" fill="none" stroke="${fg}" stroke-width="4"/>
      <text x="64" y="66" text-anchor="middle" font-size="20" font-family="Arial, sans-serif" font-weight="700" fill="${fg}">${label}</text>
      <text x="64" y="90" text-anchor="middle" font-size="12" font-family="Arial, sans-serif" font-weight="700" fill="#cfe6f2">${worldTag}</text>
    </svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

async function backfillMarketplaceImages() {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT id, name, category, world_name
     FROM marketplace_items
     WHERE COALESCE(TRIM(image), '') = ''`
  );

  for (const row of rows) {
    await query(
      `UPDATE marketplace_items
       SET image = $1, updated_at = NOW()
       WHERE id = $2`,
      [
        buildFallbackImage(
          String(row.name ?? 'ITEM'),
          String(row.category ?? 'tools'),
          String(row.world_name ?? 'nexus')
        ),
        String(row.id),
      ]
    );
  }
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

export async function listMarketplaceItems(filters: {
  search?: string;
  category?: string;
  world?: string;
  activeOnly?: boolean;
} = {}): Promise<MarketplaceItemRecord[]> {
  await ensureMarketplaceSchema();
  const clauses: string[] = [];
  const values: unknown[] = [];
  let i = 1;

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

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await query<Record<string, unknown>>(
    `SELECT id, source_key, name, description, category, image, game_action, action_config,
            quantity, cost_buy, cost_sell, world_name, is_active, sort_order, created_at, updated_at
     FROM marketplace_items
     ${where}
     ORDER BY sort_order ASC, name ASC, created_at ASC`,
    values
  );
  return rows.map(rowToItem);
}

export async function getMarketplaceItem(id: string): Promise<MarketplaceItemRecord | null> {
  await ensureMarketplaceSchema();
  const { rows } = await query<Record<string, unknown>>(
    `SELECT id, source_key, name, description, category, image, game_action, action_config,
            quantity, cost_buy, cost_sell, world_name, is_active, sort_order, created_at, updated_at
     FROM marketplace_items
     WHERE id = $1
     LIMIT 1`,
    [id]
  );
  return rows[0] ? rowToItem(rows[0]) : null;
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
      normalizeText(input.image, 2000),
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
     WHERE id = $14
     RETURNING id, source_key, name, description, category, image, game_action, action_config,
               quantity, cost_buy, cost_sell, world_name, is_active, sort_order, created_at, updated_at`,
    [
      normalizeText(next.name, 120),
      normalizeText(next.description, 2000),
      normalizeCategory(next.category),
      normalizeText(next.image, 2000),
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
     WHERE id = $1
     RETURNING id, source_key, name, description, category, image, game_action, action_config,
               quantity, cost_buy, cost_sell, world_name, is_active, sort_order, created_at, updated_at`,
    [id]
  );
  return rows[0] ? rowToItem(rows[0]) : null;
}
