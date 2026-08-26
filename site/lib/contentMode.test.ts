import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { flat } from './fakeDb';
import {
  ensureCustomServerSchema,
  createServer,
  getServer,
  updateServer,
  applyMembershipAction,
  selectServer,
  currentContentScope,
  listServersDirectory,
} from './customServers';
import { ensureCreditSchema, ensureOpeningBalance } from './creditLedger';
import { listMarketplaceItems, purchaseMarketplaceItem } from './marketplaceDb';
import { getLoreEntries } from './lore';

/**
 * PER-SERVER CONTENT MODE: `extend` IS TODAY, `replace` IS SERVER ROWS ONLY.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * An owner chooses how their server's content meets the default game:
 *
 *   - `extend` — the DEFAULT, and the migration value for every server that
 *     existed before the column did: platform content PLUS the owner's
 *     additions. The shipped behaviour, byte for byte.
 *   - `replace` — members see ONLY owner-authored content. The merge rule in
 *     each of the three read paths collapses to "server rows only".
 *
 * The scope pair `{serverId, mode}` is resolved ONCE, by
 * `currentContentScope`, and every read path takes the pair — so the quest
 * board, the catalogue, the purchase and the lore cannot disagree about what
 * mode a player is in. The purchase path in particular MUST agree with the
 * list, or a replace-mode player could buy an item they cannot see.
 *
 * ── What each half of this file proves ────────────────────────────────────
 *
 * The scrapes (always run, no database) pin what only the source shows:
 * the `extend` statements are the EXACT statements that shipped, the
 * `replace` statements state their narrower scope literally, the column is
 * ensured by the one module that reads it, an absent PATCH field never
 * coerces, and the completion path never consults the mode at all.
 *
 * The integration half (skips without POSTGRES_TEST_URL) drives the whole
 * story against a real Postgres: a member's resolved scope — not one the test
 * hands over — narrows all three reads on a flip, purchases agree with the
 * list in both modes, an in-flight engagement survives the flip, and an empty
 * replace-mode server is an empty board rather than an error. Both halves
 * exist for the reason every sibling suite records: the integration half
 * skips on machines with no database, and a gate that vanishes where it runs
 * is how defects have shipped from this repository before.
 */

const here = dirname(fileURLToPath(import.meta.url));

function testUrl(): string | null {
  if (process.env.POSTGRES_TEST_URL) return process.env.POSTGRES_TEST_URL;
  const envFile = join(here, '..', '.env.test.local');
  if (!existsSync(envFile)) return null;
  const line = readFileSync(envFile, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith('POSTGRES_TEST_URL='));
  if (!line) return null;
  return line.slice('POSTGRES_TEST_URL='.length).trim().replace(/^["']|["']$/g, '');
}

const URL_ = testUrl();
const suite = URL_ ? describe : describe.skip;

/** CRLF-normalised: `core.autocrlf` is true in this repository. */
function source(...parts: string[]): string {
  return readFileSync(join(here, '..', ...parts), 'utf8').replace(/\r\n/g, '\n');
}

/** The body of one exported function, by brace matching (economySeparation's). */
function body(src: string, name: string): string {
  const at = src.indexOf(`export async function ${name}`);
  expect(at, `${name} not found`).toBeGreaterThan(-1);
  const open = src.indexOf('{', src.indexOf(')', at));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return src.slice(open);
}

/* Comments stripped before matching, so prose ABOUT the mode cannot satisfy
 * (or trip) a pin that is meant to read code. */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/* ---------------------------------------------------------------------- */
/* Scrape: extend mode is byte-identical to the statements that shipped    */
/* ---------------------------------------------------------------------- */

describe('extend mode is the shipped SQL, verbatim', () => {
  /* Each constant below is the whitespace-flattened statement copied from the
   * tree AT THE COMMIT BEFORE content modes existed. If an edit ever changes
   * the extend-mode read, this fails and the diff has to be argued for — the
   * promise "extend is byte-identical to pre-change behaviour" is a gate, not
   * a comment. */
  const PRE_CHANGE_QUEST_LIST =
    "SELECT id, quest_number, world, quest_line, title, reward_credits, " +
    "duration_minutes, pre_steps, steps, is_active, server_id " +
    "FROM quests " +
    "WHERE is_active = TRUE AND LOWER(world) = $1 " +
    "AND (server_id IS NULL OR server_id = COALESCE($2, '')) " +
    "ORDER BY quest_number ASC";

  const PRE_CHANGE_MARKET_LIST =
    "SELECT id, source_key, name, description, category, image, game_action, action_config, " +
    "quantity, cost_buy, cost_sell, world_name, is_active, sort_order, server_id, " +
    "created_at, updated_at " +
    "FROM marketplace_items " +
    "WHERE (server_id IS NULL OR server_id = COALESCE($1, '')) " +
    "${extra} " +
    "ORDER BY sort_order ASC, name ASC, created_at ASC";

  const PRE_CHANGE_BUY_BY_ID =
    "FROM marketplace_items WHERE id = $1 " +
    "AND (server_id IS NULL OR server_id = COALESCE($2, '')) FOR UPDATE";

  const PRE_CHANGE_BUY_BY_KEY =
    "FROM marketplace_items WHERE source_key = $1 " +
    "AND (server_id IS NULL OR server_id = COALESCE($2, '')) FOR UPDATE";

  it('the quest list still contains the shipped extend statement', () => {
    expect(flat(source('lib', 'playerDb.ts'))).toContain(PRE_CHANGE_QUEST_LIST);
  });

  it('the catalogue list still contains the shipped extend statement', () => {
    expect(flat(source('lib', 'marketplaceDb.ts'))).toContain(PRE_CHANGE_MARKET_LIST);
  });

  it('both purchase lookups still contain the shipped extend statements', () => {
    const src = flat(source('lib', 'marketplaceDb.ts'));
    expect(src).toContain(PRE_CHANGE_BUY_BY_ID);
    expect(src).toContain(PRE_CHANGE_BUY_BY_KEY);
  });

  it('the lore union arm is unchanged, and still what extend selects', () => {
    const src = source('lib', 'lore.ts');
    /* The platform SELECT and the overlay SELECT are pinned literally by
     * loreScoping.test.ts; what belongs to THIS file is the arm choice. */
    expect(flat(src)).toContain('${PLATFORM_LORE_SELECT} UNION ALL ${SERVER_LORE_SELECT}');
  });

  it('an omitted mode means extend, so pre-mode callers keep today, unedited', () => {
    /* The same failure contentScoping guards for serverId: a default that
     * NARROWS would change every caller that never heard of modes. */
    const playerDb = source('lib', 'playerDb.ts');
    expect(playerDb.match(/mode: 'extend' \| 'replace' = 'extend'/g) ?? []).toHaveLength(2);
    const market = source('lib', 'marketplaceDb.ts');
    expect(market.match(/contentMode\?: 'extend' \| 'replace'/g) ?? []).toHaveLength(2);
    const lore = source('lib', 'lore.ts');
    expect(lore).toMatch(/async \(serverId = null, mode = 'extend'\)/);
  });
});

/* ---------------------------------------------------------------------- */
/* Scrape: replace mode states its scope literally, in all three paths     */
/* ---------------------------------------------------------------------- */

describe('replace mode is server rows only, stated literally', () => {
  it('the quest list has a replace statement scoped to the server alone', () => {
    const src = flat(source('lib', 'playerDb.ts'));
    expect(src).toContain(
      "WHERE is_active = TRUE AND LOWER(world) = $1 AND server_id = COALESCE($2, '') ORDER BY quest_number ASC"
    );
  });

  it('the catalogue list and BOTH purchase lookups have replace statements', () => {
    const src = flat(source('lib', 'marketplaceDb.ts'));
    expect(src).toContain("FROM marketplace_items WHERE server_id = COALESCE($1, '') ${extra}");
    expect(src).toContain(
      "FROM marketplace_items WHERE id = $1 AND server_id = COALESCE($2, '') FOR UPDATE"
    );
    expect(src).toContain(
      "FROM marketplace_items WHERE source_key = $1 AND server_id = COALESCE($2, '') FOR UPDATE"
    );
  });

  it('the purchase branches on the SAME field the list branches on', () => {
    /* The agreement is structural: one resolved mode, read by both ends. A
     * list that replaced and a purchase that extended would let a player buy
     * what they cannot see; the reverse would show goods that refuse to sell. */
    const src = codeOnly(source('lib', 'marketplaceDb.ts'));
    expect(src).toContain("filters.contentMode === 'replace'");
    expect(src).toContain("request.contentMode === 'replace'");
  });

  it('the lore read serves the overlay ALONE in replace mode', () => {
    const src = codeOnly(source('lib', 'lore.ts'));
    expect(src).toMatch(/scoped && mode === 'replace'\s*\?\s*SERVER_LORE_SELECT/);
  });

  it('replace with no server resolved is the platform partition, everywhere', () => {
    /* There is nothing to replace WITH: the pair only ever narrows alongside a
     * resolved server, so a mangled mode with a null serverId cannot serve an
     * empty game to a default-mode player. */
    expect(codeOnly(source('lib', 'playerDb.ts'))).toMatch(/scoped && mode === 'replace'/);
    expect(codeOnly(source('lib', 'marketplaceDb.ts'))).toMatch(/scope && filters\.contentMode === 'replace'/);
    expect(codeOnly(source('lib', 'marketplaceDb.ts'))).toMatch(
      /request\.contentMode === 'replace' && scope !== null/
    );
    expect(codeOnly(source('lib', 'lore.ts'))).toMatch(/scoped && mode === 'replace'/);
  });
});

/* ---------------------------------------------------------------------- */
/* Scrape: the column is ensured where it is read                          */
/* ---------------------------------------------------------------------- */

describe('content_mode is ensured by the module that reads it', () => {
  /* The `server_id` production lesson, applied on day one instead of after
   * the outage: `serverIdMigrations.test.ts` exists because three modules
   * read a column only one of them ensured, and production answered 42703.
   * `custom_servers.content_mode` is read by exactly ONE module — the
   * quest/marketplace/lore paths take the resolved mode as an ARGUMENT, never
   * the column — and this sweep holds that at one: any module that grows a
   * read of the column must also grow the ensure. */
  const flatUpper = (s: string) => s.replace(/\s+/g, ' ').toUpperCase();
  const NEEDLE = "ALTER TABLE CUSTOM_SERVERS ADD COLUMN IF NOT EXISTS CONTENT_MODE";
  const touches = (f: string) =>
    f.includes(' FROM CUSTOM_SERVERS ') || f.includes(' UPDATE CUSTOM_SERVERS ') ||
    f.includes(' INTO CUSTOM_SERVERS ') || f.includes(' INTO CUSTOM_SERVERS(');

  const modules = readdirSync(here)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.startsWith('fake'));

  it('finds the lib modules at all, so an empty scan cannot pass silently', () => {
    expect(modules.length).toBeGreaterThan(10);
  });

  for (const file of modules) {
    const src = source('lib', file);
    if (!src.includes('content_mode')) continue;
    const f = flatUpper(src);
    if (!touches(f)) continue;
    it(`${file} ensures content_mode on custom_servers, because it reads it`, () => {
      expect(f.includes(NEEDLE),
        `${file} issues SQL against custom_servers and references content_mode, but never ` +
        `runs ALTER TABLE custom_servers ADD COLUMN IF NOT EXISTS content_mode. That is the ` +
        `exact shape that 500ed /api/game/quests in production: the ensure lived in a module ` +
        `the read path never called.`
      ).toBe(true);
    });
  }

  it('the ensure exists, defaults to extend, and is not silently skippable', () => {
    const src = source('lib', 'customServers.ts');
    expect(flatUpper(src)).toContain(`${NEEDLE} TEXT NOT NULL DEFAULT 'EXTEND'`);
    /* NOT `.catch(() => {})`: SERVER_COLS selects the column, so a swallowed
     * migration failure would surface as a 500 from every getServer instead
     * of an error that names the DDL. Same argument as `simulated`. */
    expect(src).not.toMatch(/content_mode[^`]*`\s*\)\s*\.catch\(\(\) => \{\}\)/);
    expect(src).toContain(
      "'id, owner_player_id, name, slug, description, status, content_mode, created_at'"
    );
  });

  it('an unrecognised stored value reads as extend, the direction that serves MORE', () => {
    const src = source('lib', 'customServers.ts');
    expect(src).toContain("row.content_mode === 'replace' ? 'replace' : 'extend'");
  });
});

/* ---------------------------------------------------------------------- */
/* Scrape: absent means unchanged, and only two values ever write          */
/* ---------------------------------------------------------------------- */

describe('the PATCH surface: absent means unchanged, invalid means 400', () => {
  it('updateServer treats an absent contentMode as unchanged, like status', () => {
    const fn = body(source('lib', 'customServers.ts'), 'updateServer');
    expect(fn.includes('patch.contentMode === undefined'),
      'updateServer coerces an omitted contentMode. The status lesson verbatim: a PATCH ' +
      '{"name": "..."} must not quietly hand a replace-mode community the platform back.'
    ).toBe(true);
    expect(/patch\.contentMode === undefined[\s\S]{0,120}current\.contentMode/.test(fn),
      'an absent contentMode must fall back to the CURRENT mode'
    ).toBe(true);
    expect(fn).toContain("patch.contentMode === 'replace' ? 'replace' : 'extend'");
  });

  it('the route refuses a present-but-invalid contentMode instead of coercing', () => {
    const src = source('app', 'api', 'servers', '[id]', 'route.ts');
    expect(src).toContain("body.contentMode === 'extend' || body.contentMode === 'replace'");
    expect(src).toContain("contentMode must be 'extend' or 'replace'.");
    /* And only a WANTED mode enters the patch at all — absent stays absent. */
    expect(src).toMatch(/wantsMode \? \{ contentMode/);
  });

  it('the owner panel PATCHes the mode alone, absent meaning unchanged', () => {
    const panel = source('components', 'ServerAdminPanel.tsx');
    expect(panel).toContain('JSON.stringify({ contentMode: opt.value })');
    expect(panel).toContain('radiogroup');
  });
});

/* ---------------------------------------------------------------------- */
/* Scrape: the scope is resolved once and travels as a pair                */
/* ---------------------------------------------------------------------- */

describe('one resolution, every read path takes the pair', () => {
  it('the quest route resolves the pair once per handler and passes both halves', () => {
    const src = source('app', 'api', 'game', 'quests', 'route.ts');
    expect(src).toContain('currentContentScope(playerId)');
    expect(src).toContain('listActiveQuestsForWorld(world, scope.serverId, scope.mode)');
    expect(src).toContain("acceptQuestEngagement(playerId, questId.trim(), scope.serverId, scope.mode)");
    expect(src).not.toContain('currentServer(');
  });

  it('the catalogue route passes the same pair into the list', () => {
    const src = source('app', 'api', 'marketplace', 'items', 'route.ts');
    expect(src).toContain('currentContentScope(playerId)');
    expect(src).toContain('serverId: scope.serverId');
    expect(src).toContain('contentMode: scope.mode');
  });

  it('the purchase route passes the same pair into the buy', () => {
    const src = source('app', 'api', 'game', 'credits', 'route.ts');
    expect(src).toContain('currentContentScope(playerId)');
    expect(src).toContain('serverId: scope.serverId');
    expect(src).toContain('contentMode: scope.mode');
  });

  it('no content route re-derives the mode from anything a client sent', () => {
    for (const parts of [
      ['app', 'api', 'game', 'quests', 'route.ts'],
      ['app', 'api', 'marketplace', 'items', 'route.ts'],
      ['app', 'api', 'game', 'credits', 'route.ts'],
      ['app', 'api', 'lore', 'route.ts'],
    ]) {
      const src = source(...parts);
      expect(src, parts.join('/')).not.toMatch(/body\.contentMode|body\.content_mode/);
      expect(src, parts.join('/')).not.toMatch(/searchParams\.get\(['"](content_mode|contentMode|mode)['"]\)/);
    }
  });
});

/* ---------------------------------------------------------------------- */
/* Scrape: the engagement row is the contract                              */
/* ---------------------------------------------------------------------- */

describe('an engagement outlives a mode flip', () => {
  it('completion never consults the mode — the engagement row is the contract', () => {
    /* THE DECISION, written down: a player who accepted a platform quest while
     * the server extended keeps the completion after the owner flips to
     * replace. The engagement row was written under rules the player was
     * invited to play by; its `server_id` stamp already decides where the
     * reward accrues; and an owner's later mode change revoking a member's
     * in-flight work would punish the member for the owner's edit. So the
     * completion path takes (engagementId, playerId) and NO mode — enforced
     * here so nobody "completes" the threading by adding one. */
    const fn = body(source('lib', 'playerDb.ts'), 'completeQuestEngagement');
    expect(fn).not.toContain('contentMode');
    expect(fn).not.toContain('content_mode');
  });

  it('the replace guard gates NEW accepts only, after the in-flight short-circuit', () => {
    const fn = codeOnly(body(source('lib', 'playerDb.ts'), 'acceptQuestEngagement'));
    const guardAt = fn.indexOf("mode === 'replace' && scopedServer && !quest.server_id");
    expect(guardAt, 'the replace accept-guard is missing').toBeGreaterThan(-1);
    const inFlightAt = fn.indexOf("'in_progress'");
    expect(inFlightAt, 'the in_progress short-circuit moved — re-read this test').toBeGreaterThan(-1);
    expect(inFlightAt,
      'the in-flight return must come BEFORE the replace guard, or a flip strands a resumed quest'
    ).toBeLessThan(guardAt);
    /* Refused as the SAME non-confirming answer a foreign server's id gets. */
    expect(fn.slice(guardAt, guardAt + 200)).toContain("'quest_not_found'");
  });
});

/* ---------------------------------------------------------------------- */
/* Scrape: the economies never heard of modes                              */
/* ---------------------------------------------------------------------- */

describe('content mode is orthogonal to the economy separation', () => {
  it('neither ledger module mentions the mode at all', () => {
    /* Server credits vs platform credits is decided by WHOSE row pays
     * (`engagement.server_id`, `quests.server_id`) — never by how the
     * catalogue merged when the player looked at it. The strongest form of
     * "mode changes nothing here" is that the ledgers cannot branch on a
     * thing they do not name. */
    for (const file of ['serverCredits.ts', 'creditLedger.ts']) {
      const src = source('lib', file);
      expect(src, file).not.toContain('contentMode');
      expect(src, file).not.toContain('content_mode');
    }
  });
});

/* ---------------------------------------------------------------------- */
/* Scrape: the directory is honest about replace-mode servers              */
/* ---------------------------------------------------------------------- */

describe('a joining player is told before entering, not after', () => {
  it('the directory serves the mode as a public fact', () => {
    const src = source('lib', 'customServers.ts');
    expect(flat(src)).toContain('SELECT s.id, s.name, s.slug, s.description, s.content_mode');
    expect(src).toContain('contentMode: ContentMode;');
  });

  it('the start panel tags replace-mode servers, one word', () => {
    const panel = source('components', 'ServerStartPanel.tsx');
    expect(panel).toContain("s.contentMode === 'replace'");
    expect(panel).toContain('curated');
  });
});

/* ---------------------------------------------------------------------- */
/* Integration: the whole story, against a real Postgres                   */
/* ---------------------------------------------------------------------- */

/* ...0b. Register of claimed id blocks: see questLedger.test.ts (...0001 to
 * ...0012 plus the ...000a block are taken; checked, not guessed). */
const OWNER = '00000000-0000-4000-8000-0000000b0001';
const MEMBER = '00000000-0000-4000-8000-0000000b0002';
const CURATOR = '00000000-0000-4000-8000-0000000b0003';
const PLAYERS = [OWNER, MEMBER, CURATOR];

/** A world string no other suite and no real content uses. */
const WORLD = 'cmodew';
const PLAT_QUEST = 'cmode-plat-quest';
const PLAT_QUEST_2 = 'cmode-plat-quest-2';
const SERVER_QUEST = 'cmode-server-quest';
const QUESTS = [PLAT_QUEST, PLAT_QUEST_2, SERVER_QUEST];

const PLAT_ITEM = '00000000-0000-4000-8000-0000000bf001';
const SERVER_ITEM = '00000000-0000-4000-8000-0000000bf002';
const ITEMS = [PLAT_ITEM, SERVER_ITEM];
const PLAT_KEY = 'cmode-plat-item';

const PLAT_LORE = 'cmode-plat';
const SHARED_LORE = 'cmode-shared';
const OWN_LORE = 'cmode-own';
const LORE_SCOPES_ = [PLAT_LORE, SHARED_LORE];

suite('content mode, end to end (integration)', () => {
  let db: Client;
  let previousUrl: string | undefined;
  let serverId: string;
  let emptyServerId: string;

  const platformBalance = async (playerId: string): Promise<number> => {
    const r = await db.query('SELECT credit_balance FROM players WHERE id = $1', [playerId]);
    return Number(r.rows[0]?.credit_balance ?? -1);
  };
  const serverBalanceOf = async (playerId: string): Promise<number> => {
    const r = await db.query(
      'SELECT balance FROM server_credit_balances WHERE server_id = $1 AND player_id = $2',
      [serverId, playerId]
    );
    return Number(r.rows[0]?.balance ?? 0);
  };

  beforeAll(async () => {
    db = new Client({ connectionString: URL_!, ssl: { rejectUnauthorized: false } });
    await db.connect();
    const which = await db.query('SELECT current_database() AS db');
    if (which.rows[0].db !== 'aether_test') {
      throw new Error(`refusing to run against "${which.rows[0].db}" — expected aether_test`);
    }

    /* The shipped read paths open their OWN connections from POSTGRES_URL —
     * which is the point: this suite exercises the functions the routes call,
     * not re-implementations of their queries. Restored in afterAll. */
    previousUrl = process.env.POSTGRES_URL;
    process.env.POSTGRES_URL = URL_!;

    /* Additive, never CREATE-and-assume: the database is shared with sibling
     * suites whose CREATEs carry narrower column sets, and whichever file
     * runs first wins. */
    await db.query(`
      CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY, handle TEXT, credit_balance INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    for (const col of ['updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()', 'handle TEXT']) {
      await db.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS ${col}`).catch(() => {});
    }
    await db.query(`
      CREATE TABLE IF NOT EXISTS quests (
        id TEXT PRIMARY KEY, quest_number INTEGER UNIQUE NOT NULL, world TEXT NOT NULL,
        quest_line TEXT NOT NULL, title TEXT NOT NULL,
        reward_credits INTEGER NOT NULL DEFAULT 0, duration_minutes INTEGER,
        pre_steps TEXT, steps TEXT, is_active BOOLEAN NOT NULL DEFAULT TRUE,
        repeatable BOOLEAN NOT NULL DEFAULT FALSE, updated_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    for (const col of [
      'duration_minutes INTEGER', 'pre_steps TEXT', 'steps TEXT',
      'repeatable BOOLEAN NOT NULL DEFAULT FALSE', 'updated_by TEXT',
      'updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()', 'server_id TEXT',
    ]) {
      await db.query(`ALTER TABLE quests ADD COLUMN IF NOT EXISTS ${col}`).catch(() => {});
    }
    await db.query(`
      CREATE TABLE IF NOT EXISTS marketplace_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), source_key TEXT UNIQUE,
        name TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL,
        image TEXT NOT NULL DEFAULT '', game_action TEXT NOT NULL,
        action_config JSONB NOT NULL DEFAULT '{}'::jsonb, quantity INTEGER,
        cost_buy INTEGER NOT NULL, cost_sell INTEGER NOT NULL, world_name TEXT NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE, sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await db.query('ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS server_id TEXT').catch(() => {});
    await db.query(`
      CREATE TABLE IF NOT EXISTS purchases (
        id TEXT PRIMARY KEY, player_id TEXT REFERENCES players(id),
        stripe_intent_enc TEXT, amount_cents INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'usd', type TEXT NOT NULL,
        credits_amount INTEGER, status TEXT NOT NULL DEFAULT 'completed',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await db.query(`
      CREATE TABLE IF NOT EXISTS lore_entries (
        scope TEXT PRIMARY KEY, title TEXT NOT NULL,
        sign_label TEXT NOT NULL DEFAULT 'Lorekeeper', body TEXT NOT NULL,
        updated_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await db.query('ALTER TABLE lore_entries ADD COLUMN IF NOT EXISTS server_id TEXT').catch(() => {});
    await ensureCreditSchema(db);
    await ensureCustomServerSchema(db);
  });

  const wipe = async () => {
    await db.query('DELETE FROM player_quest_engagements WHERE player_id = ANY($1::text[])', [PLAYERS]).catch(() => {});
    await db.query('DELETE FROM credit_events WHERE player_id = ANY($1::text[])', [PLAYERS]).catch(() => {});
    await db.query('DELETE FROM purchases WHERE player_id = ANY($1::text[])', [PLAYERS]).catch(() => {});
    await db.query('DELETE FROM quests WHERE id = ANY($1::text[])', [QUESTS]).catch(() => {});
    await db.query('DELETE FROM marketplace_items WHERE id = ANY($1::uuid[])', [ITEMS]).catch(() => {});
    await db.query('DELETE FROM lore_entries WHERE scope = ANY($1::text[])', [LORE_SCOPES_]).catch(() => {});
    await db.query('DELETE FROM player_server_selection WHERE player_id = ANY($1::text[])', [PLAYERS]).catch(() => {});
    /* Cascades server_members, server_lore_entries and the server ledger. */
    await db.query('DELETE FROM custom_servers WHERE owner_player_id = ANY($1::text[])', [PLAYERS]).catch(() => {});
    await db.query('DELETE FROM server_entitlements WHERE player_id = ANY($1::text[])', [PLAYERS]).catch(() => {});
  };

  beforeEach(async () => {
    await wipe();
    for (const id of PLAYERS) {
      await db.query(
        `INSERT INTO players (id, handle, credit_balance) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET credit_balance = EXCLUDED.credit_balance`,
        [id, `cm-${id.slice(-6)}`, id === MEMBER ? 5000 : 0]
      );
    }

    const { writeEntitlement } = await import('./premium');
    await writeEntitlement(db, {
      playerId: OWNER, subscriptionId: 'sub_cmode_owner', customerId: 'cus_cmode_owner',
      status: 'active', currentPeriodEnd: null,
    });
    const made = await createServer(db, OWNER, { name: 'Content Mode Hall' });
    if (!made.ok) throw new Error(`fixture server refused: ${made.reason}`);
    serverId = made.server.id;

    await writeEntitlement(db, {
      playerId: CURATOR, subscriptionId: 'sub_cmode_curator', customerId: null,
      status: 'active', currentPeriodEnd: null,
    });
    const empty = await createServer(db, CURATOR, { name: 'Content Mode Annexe' });
    if (!empty.ok) throw new Error(`fixture server refused: ${empty.reason}`);
    emptyServerId = empty.server.id;
    await updateServer(db, emptyServerId, { contentMode: 'replace' });

    /* MEMBER joins the hall: invited by the owner, accepts. */
    await applyMembershipAction(db, {
      serverId, subjectPlayerId: MEMBER, actorPlayerId: OWNER, action: 'invite',
    });
    await applyMembershipAction(db, {
      serverId, subjectPlayerId: MEMBER, actorPlayerId: MEMBER, action: 'request',
    });
    await selectServer(db, MEMBER, serverId);

    /* Two platform quests and one owner quest, in a world only this suite
     * names, so no parallel suite's rows can enter these boards. */
    await db.query(
      `INSERT INTO quests (id, quest_number, world, quest_line, title, reward_credits,
                           is_active, repeatable, server_id)
       VALUES ($1, 977101, $4, 'cmode', 'Platform errand', 50, TRUE, FALSE, NULL),
              ($2, 977102, $4, 'cmode', 'Second platform errand', 50, TRUE, FALSE, NULL),
              ($3, 977103, $4, 'cmode', 'The hall''s own errand', 50, TRUE, FALSE, $5)`,
      [PLAT_QUEST, PLAT_QUEST_2, SERVER_QUEST, WORLD, serverId]
    );

    /* One platform item (with a source_key, as every seeded row has) and one
     * owner item (source_key NULL, as `serverContent` writes them). Names
     * share a prefix so a `search` filter isolates them from the seed. */
    await db.query(
      `INSERT INTO marketplace_items
         (id, source_key, name, description, category, game_action, action_config,
          quantity, cost_buy, cost_sell, world_name, is_active, server_id)
       VALUES ($1, $3, 'Cmode Platform Lance', 'platform partition', 'tools', 'ship_part',
               '{}'::jsonb, NULL, 100, 10, 'station', TRUE, NULL),
              ($2, NULL, 'Cmode Hall Charm', 'owner authored', 'cosmetic', 'ship_part',
               '{}'::jsonb, NULL, 40, 4, 'station', TRUE, $4)`,
      [PLAT_ITEM, SERVER_ITEM, PLAT_KEY, serverId]
    );

    /* Lore: a platform-only scope, a scope both partitions hold (the owner's
     * variant must win the merge in extend mode and be ALL there is in
     * replace mode), and an owner-only scope. */
    await db.query(
      `INSERT INTO lore_entries (scope, title, sign_label, body)
       VALUES ($1, 'Platform only', 'Lorekeeper', 'platform text'),
              ($2, 'Platform shared', 'Lorekeeper', 'platform telling')`,
      [PLAT_LORE, SHARED_LORE]
    );
    await db.query(
      `INSERT INTO server_lore_entries (server_id, scope, title, sign_label, body)
       VALUES ($1, $2, 'Hall shared', 'Hall Warden', 'the hall re-tells it'),
              ($1, $3, 'Hall only', 'Hall Warden', 'nowhere else')`,
      [serverId, SHARED_LORE, OWN_LORE]
    );
  });

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.end();
    if (previousUrl === undefined) delete process.env.POSTGRES_URL;
    else process.env.POSTGRES_URL = previousUrl;
  });

  it('defaults: a fresh server extends, a legacy row extends, garbage extends', async () => {
    expect((await getServer(db, serverId))?.contentMode).toBe('extend');

    /* A "legacy" row: written the way every pre-column INSERT was, with no
     * content_mode at all. The column DEFAULT is the migration. */
    const legacy = 'cmode-legacy-row';
    await db.query(
      `INSERT INTO custom_servers (id, owner_player_id, name, slug)
       VALUES ($1, $2, 'Legacy Hall', 'cmode-legacy-hall')
       ON CONFLICT (slug) DO NOTHING`,
      [legacy, OWNER]
    );
    expect((await getServer(db, legacy))?.contentMode).toBe('extend');

    /* And a value no writer can produce reads as extend — the direction that
     * serves MORE of the default game, never less and never anyone else's. */
    await db.query(`UPDATE custom_servers SET content_mode = 'banana' WHERE id = $1`, [legacy]);
    expect((await getServer(db, legacy))?.contentMode).toBe('extend');
    await db.query('DELETE FROM custom_servers WHERE id = $1', [legacy]);
  });

  /* 60s, not the 5s default: the first `listMarketplaceItems` in this worker
   * runs `ensureMarketplaceSchema`, which seeds the 505-row platform
   * catalogue over one connection. A cold-start cost the route pays too. */
  it('extend mode: explicit and omitted arguments agree, and serve the D2 union', { timeout: 60_000 }, async () => {
    const scope = await currentContentScope(db, MEMBER);
    expect(scope).toEqual({ serverId, mode: 'extend' });

    const { listActiveQuestsForWorld } = await import('./playerDb');
    const omitted = await listActiveQuestsForWorld(WORLD, serverId);
    const explicit = await listActiveQuestsForWorld(WORLD, scope.serverId, scope.mode);
    expect(explicit.map((q) => q.id)).toEqual(omitted.map((q) => q.id));
    expect(explicit.map((q) => q.id)).toEqual([PLAT_QUEST, PLAT_QUEST_2, SERVER_QUEST]);

    const itemsOmitted = await listMarketplaceItems({ serverId, search: 'cmode' });
    const itemsExplicit = await listMarketplaceItems({
      serverId: scope.serverId, contentMode: scope.mode, search: 'cmode',
    });
    expect(itemsExplicit.map((x) => x.id).sort()).toEqual(itemsOmitted.map((x) => x.id).sort());
    expect(itemsExplicit.map((x) => x.id).sort()).toEqual([...ITEMS].sort());

    const loreOmitted = await getLoreEntries(serverId);
    const loreExplicit = await getLoreEntries(scope.serverId, scope.mode);
    expect(loreExplicit).toEqual(loreOmitted);
    const byScope = new Map(loreExplicit.map((r) => [r.scope, r]));
    expect(byScope.get(PLAT_LORE)?.title).toBe('Platform only');
    /* Last row wins in every consumer; the overlay sorts second. */
    expect(loreExplicit.filter((r) => r.scope === SHARED_LORE).at(-1)?.title).toBe('Hall shared');
  });

  it('replace mode: all three reads narrow to server rows, from the RESOLVED scope', { timeout: 60_000 }, async () => {
    await updateServer(db, serverId, { contentMode: 'replace' });
    /* The scope the member's next request would resolve — not one the test
     * hands over. The flip needs no re-selection and no cache to clear. */
    const scope = await currentContentScope(db, MEMBER);
    expect(scope).toEqual({ serverId, mode: 'replace' });

    const { listActiveQuestsForWorld } = await import('./playerDb');
    const quests = await listActiveQuestsForWorld(WORLD, scope.serverId, scope.mode);
    expect(quests.map((q) => q.id)).toEqual([SERVER_QUEST]);
    for (const q of quests) expect(q.server_id).toBe(serverId);

    const items = await listMarketplaceItems({
      serverId: scope.serverId, contentMode: scope.mode, search: 'cmode',
    });
    expect(items.map((x) => x.id)).toEqual([SERVER_ITEM]);
    /* The strong form, unfiltered: the whole catalogue answer is the server's
     * own single item — the 500-odd seeded platform rows, present in this
     * very database and served to this very player one flip ago, are gone. */
    const all = await listMarketplaceItems({ serverId: scope.serverId, contentMode: scope.mode });
    expect(all.map((x) => x.id)).toEqual([SERVER_ITEM]);

    const lore = await getLoreEntries(scope.serverId, scope.mode);
    expect(lore.map((r) => r.scope).sort()).toEqual([OWN_LORE, SHARED_LORE].sort());
    expect(lore.find((r) => r.scope === SHARED_LORE)?.title).toBe('Hall shared');
    expect(lore.some((r) => r.scope === PLAT_LORE)).toBe(false);
  });

  it('an empty replace-mode server is an empty board, not an error', { timeout: 60_000 }, async () => {
    await selectServer(db, CURATOR, emptyServerId);
    const scope = await currentContentScope(db, CURATOR);
    expect(scope).toEqual({ serverId: emptyServerId, mode: 'replace' });

    const { listActiveQuestsForWorld } = await import('./playerDb');
    /* Empty arrays, not throws: the client's quest board and shop already
     * render a shipped empty state for zero rows, and an owner who chose
     * replace before authoring anything has built exactly that. */
    await expect(listActiveQuestsForWorld(WORLD, scope.serverId, scope.mode)).resolves.toEqual([]);
    await expect(
      listMarketplaceItems({ serverId: scope.serverId, contentMode: scope.mode })
    ).resolves.toEqual([]);
    await expect(getLoreEntries(scope.serverId, scope.mode)).resolves.toEqual([]);
  });

  it('the purchase agrees with the list, in both modes, and debits the SERVER ledger while scoped', async () => {
    /* REWRITTEN DELIBERATELY when the economy invariant flipped, at the site
     * owner's explicit instruction: while a player is INSIDE a custom server,
     * every purchase — a platform item in extend mode included — debits the
     * SERVER ledger, and the platform balance must not move at all. This test
     * used to pin the opposite ("on the same platform ledger"); the agreement
     * between list and purchase is unchanged, and the money side now proves
     * the new rule. `serverEconomyInvariant` in economySeparation.test.ts
     * holds the invariant in both directions with ablation-grade row checks. */
    await ensureOpeningBalance(db, MEMBER);
    const start = await platformBalance(MEMBER);
    const platformEvents = async () => Number(
      (await db.query('SELECT COUNT(*)::int AS n FROM credit_events WHERE player_id = $1', [MEMBER])).rows[0].n
    );
    const eventsBefore = await platformEvents();

    /* The member's SERVER wallet, funded through the server ledger's own earn
     * path — the only faucet a scoped economy has. */
    const { earnServerCredits } = await import('./serverCredits');
    await earnServerCredits(db, serverId, MEMBER, {
      kind: 'grant', amount: 1000, eventKey: 'cmode-buy-fund', detail: 'test fund',
    });
    expect(await serverBalanceOf(MEMBER)).toBe(1000);

    /* Extend: both partitions are for sale, exactly as shipped. */
    let scope = await currentContentScope(db, MEMBER);
    const buyPlat = await purchaseMarketplaceItem(db, MEMBER, {
      itemId: PLAT_ITEM, eventKey: 'cmode-buy-plat-extend',
      serverId: scope.serverId, contentMode: scope.mode,
    });
    expect(buyPlat.applied).toBe(true);
    expect(buyPlat.cost).toBe(100);
    const buyOwn = await purchaseMarketplaceItem(db, MEMBER, {
      itemId: SERVER_ITEM, eventKey: 'cmode-buy-own-extend',
      serverId: scope.serverId, contentMode: scope.mode,
    });
    expect(buyOwn.applied).toBe(true);
    expect(buyOwn.cost).toBe(40);

    /* Replace: the platform item is not in the shop, so it is not for sale —
     * `not_found`, the same answer a cross-server id gets, by row id AND by
     * the source_key the offline platform catalogue would send. */
    await updateServer(db, serverId, { contentMode: 'replace' });
    scope = await currentContentScope(db, MEMBER);
    expect(scope.mode).toBe('replace');
    const refusedById = await purchaseMarketplaceItem(db, MEMBER, {
      itemId: PLAT_ITEM, eventKey: 'cmode-buy-plat-replace',
      serverId: scope.serverId, contentMode: scope.mode,
    });
    expect(refusedById.applied).toBe(false);
    expect(refusedById.reason).toBe('not_found');
    const refusedByKey = await purchaseMarketplaceItem(db, MEMBER, {
      itemId: PLAT_KEY, eventKey: 'cmode-buy-key-replace',
      serverId: scope.serverId, contentMode: scope.mode,
    });
    expect(refusedByKey.applied).toBe(false);
    expect(refusedByKey.reason).toBe('not_found');
    const stillSold = await purchaseMarketplaceItem(db, MEMBER, {
      itemId: SERVER_ITEM, eventKey: 'cmode-buy-own-replace',
      serverId: scope.serverId, contentMode: scope.mode,
    });
    expect(stillSold.applied).toBe(true);
    expect(stillSold.cost).toBe(40);
    /* The purchase result reports the SERVER balance, which the client
     * displays without knowing whose it is. */
    expect(stillSold.balance).toBe(1000 - 100 - 40 - 40);

    /* THE FLIPPED INVARIANT: every applied buy above debited the SERVER
     * ledger; the platform balance did not move and the platform ledger wrote
     * NO rows — refusals debited nothing anywhere. */
    expect(await serverBalanceOf(MEMBER)).toBe(1000 - 100 - 40 - 40);
    expect(await platformBalance(MEMBER)).toBe(start);
    expect(await platformEvents()).toBe(eventsBefore);
  });

  it('a mode flip honors the engagement in flight, and refuses only NEW platform accepts', async () => {
    const { acceptQuestEngagement, completeQuestEngagement } = await import('./playerDb');
    let scope = await currentContentScope(db, MEMBER);

    /* Accepted while the server extended: a platform quest, played inside the
     * server, so the engagement is stamped with the server (provenance — the
     * reward accrues to the server's own ledger, as shipped). */
    const accepted = await acceptQuestEngagement(MEMBER, PLAT_QUEST, scope.serverId, scope.mode);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error('accept refused');

    await updateServer(db, serverId, { contentMode: 'replace' });
    scope = await currentContentScope(db, MEMBER);
    expect(scope.mode).toBe('replace');

    /* THE DECISION: the engagement row is the contract. The completion still
     * lands, pays what the quest row said, and pays it where the stamp already
     * decided — the flip changed none of it. */
    const platformBefore = await platformBalance(MEMBER);
    const done = await completeQuestEngagement(accepted.engagementId, MEMBER);
    expect(done.ok).toBe(true);
    expect(done.alreadyCompleted).toBe(false);
    expect(done.creditsAwarded).toBe(50);
    expect(await serverBalanceOf(MEMBER)).toBe(50);
    expect(await platformBalance(MEMBER)).toBe(platformBefore);

    /* But a NEW platform accept is refused exactly as the board now shows it:
     * not found — while the server's own quest accepts as ever. */
    const refused = await acceptQuestEngagement(MEMBER, PLAT_QUEST_2, scope.serverId, scope.mode);
    expect(refused).toEqual({ ok: false, reason: 'quest_not_found' });
    const own = await acceptQuestEngagement(MEMBER, SERVER_QUEST, scope.serverId, scope.mode);
    expect(own.ok).toBe(true);
  });

  it('PATCH semantics: absent means unchanged, so a rename cannot hand the platform back', async () => {
    await updateServer(db, serverId, { contentMode: 'replace' });
    const renamed = await updateServer(db, serverId, { name: 'Content Mode Hall II' });
    expect(renamed?.name).toBe('Content Mode Hall II');
    expect(renamed?.contentMode).toBe('replace');
    const back = await updateServer(db, serverId, { contentMode: 'extend' });
    expect(back?.contentMode).toBe('extend');
  });

  it('the directory tells a joining player which servers are curated', async () => {
    const rows = await listServersDirectory(db, MEMBER);
    const hall = rows.find((r) => r.id === serverId);
    const annexe = rows.find((r) => r.id === emptyServerId);
    expect(hall?.contentMode).toBe('extend');
    expect(annexe?.contentMode).toBe('replace');
  });
});
