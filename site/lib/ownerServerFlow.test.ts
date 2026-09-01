import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import {
  ensureCustomServerSchema,
  createServer,
  canUseServer,
  getServer,
  selectServer,
  currentContentScope,
  deleteServer,
  listServersOwnedBy,
  listServersForPlayer,
  listServersDirectory,
} from './customServers';
import { grantSimulatedHosting, readEntitlement } from './premium';
import { createServerQuest, listServerQuests } from './serverContent';
import { earnServerCredits, serverBalance } from './serverCredits';
import { listMarketplaceItems } from './marketplaceDb';
import { getLoreEntries } from './lore';

/**
 * THE OWNER'S OWN WALKTHROUGH, AS A TEST — CREATOR ROLE, NOT INVITEE.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The live bug report, verbatim: "i created a custom server and then joined
 * it, but the hud does not show i am in the custom server, my credits are the
 * global credits not the custom server credits, quests, lore, marketplace etc
 * are all global not from my custom server."
 *
 * Every prior integration test of this flow played a MEMBER — invited by an
 * owner fixture — and the owner's own path (create in /admin/servers → /play →
 * Enter → the game boots scoped) had no test walking it end to end. This file
 * is that walk, hop by hop, with the exact library calls each route makes:
 *
 *   create  → `createServer` (entitled through the simulated purchase, the
 *             same one the owner clicked)
 *   enter   → `selectServer` (what POST /api/game/server action:'select' calls)
 *   session → `currentContentScope` / `getServer` / `serverBalance` (what
 *             GET /api/game/session serves as `server` and `credits`)
 *   content → `listActiveQuestsForWorld` / `listMarketplaceItems` /
 *             `getLoreEntries`, each handed the same resolved pair
 *
 * Plus the delete lifecycle (C): soft delete, hidden everywhere, ledger rows
 * kept, slot freed immediately, create-after-delete with no new purchase.
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

/* Claimed in the cross-suite id register (see serverContent.test.ts). */
const OWNER = '00000000-0000-4000-8000-0000000c0001';
const WORLD = 'oflow-world';
const PLAT_QUEST = 'oflow-plat-quest';
const PLAT_ITEM = '00000000-0000-4000-8000-0000000c0011';
const OWN_ITEM_NAME = 'Oflow Founder Charm';
const PLAT_LORE = 'oflow-plat';
const OWN_LORE = 'oflow-own';
const ORDER_A = 'sim_00000000-0000-4000-8000-0000000c00aa';
const ORDER_B = 'sim_00000000-0000-4000-8000-0000000c00bb';

suite('the owner walkthrough (integration)', () => {
  let db: Client;
  let previousUrl: string | undefined;
  let savedStripeKey: string | undefined;
  let savedAllowSimulated: string | undefined;

  beforeAll(async () => {
    savedStripeKey = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    /* `grantSimulatedHosting` now needs an explicit opt-in as well as the
     * absence of a Stripe key — "no key" describes production too. See
     * `lib/stripe.ts`'s `simulatedPurchasesAllowed`. This suite buys hosting in
     * order to test what an owner can do afterwards, so it opts in. */
    savedAllowSimulated = process.env.ALLOW_SIMULATED_PURCHASE;
    process.env.ALLOW_SIMULATED_PURCHASE = '1';

    db = new Client({ connectionString: URL_!, ssl: { rejectUnauthorized: false } });
    await db.connect();
    const which = await db.query('SELECT current_database() AS db');
    if (which.rows[0].db !== 'aether_test') {
      throw new Error(`refusing to run against "${which.rows[0].db}" — expected aether_test`);
    }

    /* The library functions the routes call open their OWN connections from
     * POSTGRES_URL — the point being to exercise the functions, not
     * re-implementations. Restored in afterAll. */
    previousUrl = process.env.POSTGRES_URL;
    process.env.POSTGRES_URL = URL_!;

    await db.query(`
      CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY, handle TEXT, credit_balance INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await db.query(
      `INSERT INTO players (id, handle, credit_balance) VALUES ($1, 'oflow-owner', 250)
       ON CONFLICT (id) DO UPDATE SET credit_balance = 250`,
      [OWNER]
    );
    /* Additive, never CREATE-and-assume: the database is shared with sibling
     * suites whose CREATEs carry narrower column sets — the same discipline
     * contentMode.test.ts records. */
    await db.query(`
      CREATE TABLE IF NOT EXISTS quests (
        id TEXT PRIMARY KEY, quest_number INTEGER UNIQUE NOT NULL, world TEXT NOT NULL,
        quest_line TEXT NOT NULL, title TEXT NOT NULL,
        reward_credits INTEGER NOT NULL DEFAULT 0, duration_minutes INTEGER,
        pre_steps TEXT, steps TEXT, is_active BOOLEAN NOT NULL DEFAULT TRUE,
        repeatable BOOLEAN NOT NULL DEFAULT FALSE, updated_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await db.query(`ALTER TABLE quests ADD COLUMN IF NOT EXISTS server_id TEXT`).catch(() => {});
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
      CREATE TABLE IF NOT EXISTS lore_entries (
        scope TEXT PRIMARY KEY, title TEXT NOT NULL,
        sign_label TEXT NOT NULL DEFAULT 'Lorekeeper', body TEXT NOT NULL,
        updated_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await db.query('ALTER TABLE lore_entries ADD COLUMN IF NOT EXISTS server_id TEXT').catch(() => {});
    await ensureCustomServerSchema(db);
    await wipe();
    /* Platform fixtures, loud on failure — a silently missing fixture reads as
     * a scoping bug three assertions later. */
    await db.query(
      `INSERT INTO quests (id, quest_number, world, quest_line, title, reward_credits,
                           is_active, repeatable, server_id)
       VALUES ($1, 977301, $2, 'oflow', 'Oflow platform errand', 75, TRUE, FALSE, NULL)
       ON CONFLICT (id) DO NOTHING`,
      [PLAT_QUEST, WORLD]
    );
    await db.query(
      `INSERT INTO marketplace_items
         (id, source_key, name, description, category, game_action, action_config,
          quantity, cost_buy, cost_sell, world_name, is_active, server_id)
       VALUES ($1, 'oflow-plat-item', 'Oflow Platform Lance', 'platform', 'tools', 'ship_part',
               '{}'::jsonb, NULL, 60, 6, 'station', TRUE, NULL)
       ON CONFLICT (id) DO NOTHING`,
      [PLAT_ITEM]
    );
    await db.query(
      `INSERT INTO lore_entries (scope, title, sign_label, body)
       VALUES ($1, 'Oflow platform lore', 'Lorekeeper', 'platform telling')
       ON CONFLICT (scope) DO NOTHING`,
      [PLAT_LORE]
    );
  }, 120_000);

  const wipe = async () => {
    await db.query('DELETE FROM player_quest_engagements WHERE player_id = $1', [OWNER]).catch(() => {});
    await db.query('DELETE FROM player_server_selection WHERE player_id = $1', [OWNER]).catch(() => {});
    await db.query('DELETE FROM custom_servers WHERE owner_player_id = $1', [OWNER]);
    await db.query('DELETE FROM server_entitlements WHERE player_id = $1', [OWNER]);
    await db.query('DELETE FROM credit_events WHERE player_id = $1', [OWNER]).catch(() => {});
    await db.query(`DELETE FROM quests WHERE quest_line = 'oflow' AND server_id IS NOT NULL`).catch(() => {});
    await db.query('DELETE FROM marketplace_items WHERE name = $1', [OWN_ITEM_NAME]).catch(() => {});
  };

  afterAll(async () => {
    if (savedStripeKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = savedStripeKey;
    if (savedAllowSimulated === undefined) delete process.env.ALLOW_SIMULATED_PURCHASE;
    else process.env.ALLOW_SIMULATED_PURCHASE = savedAllowSimulated;
    if (db) {
      await wipe().catch(() => {});
      await db.query('DELETE FROM quests WHERE id = $1', [PLAT_QUEST]).catch(() => {});
      await db.query('DELETE FROM marketplace_items WHERE id = $1::uuid', [PLAT_ITEM]).catch(() => {});
      await db.query('DELETE FROM lore_entries WHERE scope = $1', [PLAT_LORE]).catch(() => {});
      await db.end();
    }
    if (previousUrl === undefined) delete process.env.POSTGRES_URL;
    else process.env.POSTGRES_URL = previousUrl;
  });

  it('create → enter → scoped session, quests, lore, marketplace and credits — as the CREATOR', { timeout: 120_000 }, async () => {
    /* HOP 1 — the purchase and the create, exactly as the owner did them. */
    const bought = await grantSimulatedHosting(db, { playerId: OWNER, orderId: ORDER_A });
    expect(bought.granted).toBe(true);
    const made = await createServer(db, OWNER, {
      name: 'Oflow Founders Hall', description: 'the owner test walk',
    });
    expect(made.ok).toBe(true);
    if (!made.ok) throw new Error('create refused');
    const serverId = made.server.id;

    /* The creator is an approved member of their own server — the fact every
     * later hop depends on. */
    expect(await canUseServer(db, serverId, OWNER)).toBe(true);

    /* HOP 2 — the owner authors content (the panel's /content route calls). */
    const quest = await createServerQuest(db, serverId, {
      world: 'station', title: 'Founders errand', questLine: 'oflow', rewardCredits: 40,
    });
    expect((await listServerQuests(db, serverId)).map((q) => q.id)).toContain(quest.id);

    /* HOP 3 — Enter. What POST /api/game/server action:'select' stores. */
    const entered = await selectServer(db, OWNER, serverId);
    expect(entered).toEqual({ serverId, refused: false });

    /* HOP 4 — the resolver every scoped route calls. This is the read whose
     * silent failure produced the whole bug report; here it must SAY the
     * owner is in their server. */
    const scope = await currentContentScope(db, OWNER);
    expect(scope).toEqual({ serverId, mode: 'extend' });

    /* HOP 5 — the session facts: `server` (id + name for the HUD) and the
     * scoped `credits` (the server balance, not the platform 250). */
    const row = await getServer(db, serverId);
    expect(row && { id: row.id, name: row.name }).toEqual({
      id: serverId, name: 'Oflow Founders Hall',
    });
    expect(await serverBalance(db, serverId, OWNER)).toBe(0);

    /* HOP 6 — the content reads, each handed the SAME resolved pair the
     * routes hand them. The owner's quest is on the board; the platform world
     * board still carries the platform quest (extend mode = D2's union). */
    const { listActiveQuestsForWorld } = await import('./playerDb');
    const board = await listActiveQuestsForWorld('station', scope.serverId, scope.mode);
    expect(board.map((q) => q.id)).toContain(quest.id);
    const unscoped = await listActiveQuestsForWorld('station');
    expect(unscoped.map((q) => q.id)).not.toContain(quest.id);
    const platWorld = await listActiveQuestsForWorld(WORLD, scope.serverId, scope.mode);
    expect(platWorld.map((q) => q.id)).toContain(PLAT_QUEST);

    const { createServerMarketplaceItem } = await import('./serverContent');
    const item = await createServerMarketplaceItem(db, serverId, {
      name: OWN_ITEM_NAME, description: 'creator-authored', category: 'cosmetic',
      image: '', gameAction: 'cosmetic_headgear', actionConfig: {}, quantity: null,
      worldName: 'station', costBuy: 30, costSell: 3, sortOrder: 0,
    });
    const shop = await listMarketplaceItems({
      serverId: scope.serverId, contentMode: scope.mode, search: 'Oflow',
    });
    expect(shop.map((x) => x.id)).toContain(item.id);
    expect(shop.map((x) => x.id)).toContain(PLAT_ITEM);
    const publicShop = await listMarketplaceItems({ search: 'Oflow' });
    expect(publicShop.map((x) => x.id)).not.toContain(item.id);

    const { upsertServerLore } = await import('./serverContent');
    await upsertServerLore(db, serverId, {
      scope: OWN_LORE, title: 'Founders telling', signLabel: 'Founder', body: 'ours',
    });
    const lore = await getLoreEntries(scope.serverId, scope.mode);
    expect(lore.map((l) => l.scope)).toContain(OWN_LORE);
    expect(lore.map((l) => l.scope)).toContain(PLAT_LORE);
    const publicLore = await getLoreEntries();
    expect(publicLore.map((l) => l.scope)).not.toContain(OWN_LORE);

    /* HOP 7 — credits. A platform quest accepted WHILE SCOPED is stamped with
     * the server (provenance), so its reward accrues to the server ledger the
     * session now displays — display and accrual agree, which is decision B4
     * written down as an assertion. The platform balance does not move. */
    const { acceptQuestEngagement, completeQuestEngagement } = await import('./playerDb');
    const accepted = await acceptQuestEngagement(OWNER, PLAT_QUEST, scope.serverId, scope.mode);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error('accept refused');
    const stamped = await db.query(
      'SELECT server_id FROM player_quest_engagements WHERE id = $1', [accepted.engagementId]
    );
    expect(stamped.rows[0].server_id).toBe(serverId);

    const done = await completeQuestEngagement(accepted.engagementId, OWNER);
    expect(done.ok).toBe(true);
    expect(done.creditsAwarded).toBe(75);
    expect(await serverBalance(db, serverId, OWNER)).toBe(75);
    const plat = await db.query('SELECT credit_balance FROM players WHERE id = $1', [OWNER]);
    expect(Number(plat.rows[0].credit_balance)).toBe(250);
  });

  it('delete: hidden everywhere, ledger kept, slot freed, create-after-delete works', { timeout: 60_000 }, async () => {
    await wipe();
    await grantSimulatedHosting(db, { playerId: OWNER, orderId: ORDER_B });
    expect((await readEntitlement(db, OWNER)).maxServers).toBe(1);

    const made = await createServer(db, OWNER, { name: 'Oflow Doomed Hall' });
    expect(made.ok).toBe(true);
    if (!made.ok) throw new Error('create refused');
    const serverId = made.server.id;

    /* One slot means a second create is quota-refused while this one lives. */
    const blocked = await createServer(db, OWNER, { name: 'Oflow Second Hall' });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toBe('quota');

    /* The owner is playing in it, with a ledger balance, when they delete. */
    await selectServer(db, OWNER, serverId);
    await earnServerCredits(db, serverId, OWNER, {
      kind: 'grant', amount: 120, eventKey: 'oflow-del-fund',
    });

    const deleted = await deleteServer(db, serverId);
    expect(deleted?.status).toBe('deleted');

    /* Hidden from every surface a player can reach. */
    expect((await listServersOwnedBy(db, OWNER)).map((s) => s.id)).not.toContain(serverId);
    expect((await listServersForPlayer(db, OWNER)).map((s) => s.id)).not.toContain(serverId);
    expect((await listServersDirectory(db, OWNER)).map((s) => s.id)).not.toContain(serverId);
    expect(await canUseServer(db, serverId, OWNER)).toBe(false);

    /* The stored selection resolves to the platform scope, and the row itself
     * was cleared rather than left pointing at a ghost. */
    expect(await currentContentScope(db, OWNER)).toEqual({ serverId: null, mode: 'extend' });
    const sel = await db.query(
      'SELECT server_id FROM player_server_selection WHERE player_id = $1', [OWNER]
    );
    expect(sel.rows[0]?.server_id ?? null).toBeNull();

    /* Members' ledger rows are KEPT — history, not inventory. */
    const ledger = await db.query(
      'SELECT balance FROM server_credit_balances WHERE server_id = $1 AND player_id = $2',
      [serverId, OWNER]
    );
    expect(Number(ledger.rows[0]?.balance)).toBe(120);

    /* THE SLOT FREES IMMEDIATELY: same entitlement, no new purchase. */
    const again = await createServer(db, OWNER, { name: 'Oflow Risen Hall' });
    expect(again.ok).toBe(true);

    /* And a second delete answers like a server that is not there: the admin
     * surface treats deleted as not found (route-level 404 via
     * requireOwnedServer); the library call is a no-op that reports the state. */
    expect((await deleteServer(db, serverId))?.status).toBe('deleted');
  });
});

/* ------------------------------------------------------------------------ */
/* Reachability: the owner can CLICK their way through this flow            */
/* ------------------------------------------------------------------------ */

describe('the owner flow is reachable in the UI', () => {
  it('the admin panel offers "Enter this server", routed to /play', () => {
    const panel = source('components', 'ServerAdminPanel.tsx');
    expect(panel).toContain('Enter this server');
    expect(panel).toContain('href="/play"');
    /* And the target really exists — a link to a moved route fails here, not
     * in the owner's browser. */
    expect(existsSync(join(here, '..', 'app', 'play', 'page.tsx'))).toBe(true);
  });

  it('the admin panel has a Delete control gated by a typed confirmation', () => {
    const panel = source('components', 'ServerAdminPanel.tsx');
    expect(panel).toContain("method: 'DELETE'");
    expect(panel).toMatch(/TYPE THE SERVER/);
    /* The button stays disabled until the typed name matches, verbatim. */
    expect(panel).toContain("deleteConfirm.trim() !== detail.server.name");
  });

  it('the DELETE verb exists on the server route, owner-gated', () => {
    const route = source('app', 'api', 'servers', '[id]', 'route.ts');
    expect(route).toMatch(/export async function DELETE/);
    expect(route).toContain('requireOwnedServer');
    expect(route).toContain('deleteServer');
  });

  it('the panel shows slots used/owned and sells the next slot at quota', () => {
    const panel = source('components', 'ServerAdminPanel.tsx');
    expect(panel).toMatch(/of \$\{ent\.maxServers\}/);
    expect(panel).toContain('Add another server');
    /* Per-server pricing is stated by the quote itself, which both the store
     * and the panel render. */
    const premium = source('lib', 'premium.ts');
    expect(premium).toContain('per month, per server');
  });

  it('the session route serves the SERVER balance as `credits` when scoped', () => {
    const route = source('app', 'api', 'game', 'session', 'route.ts');
    expect(route).toMatch(/credits:\s*serverId\s*\?\s*serverCredits\s*\?\?\s*0\s*:\s*profile\.creditBalance/);
    /* Backward compatibility: both raw facts still ride along. */
    expect(route).toContain('platform_credits: profile.creditBalance');
    expect(route).toContain('server_credits: serverCredits');
  });
});
