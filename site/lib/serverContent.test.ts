import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { makeFakeDb, flat } from './fakeDb';
import {
  OWNER_QUEST_NUMBER_FLOOR,
  createServerQuest,
  updateServerQuest,
  deleteServerQuest,
  listServerQuests,
  upsertServerLore,
  listServerLore,
  createServerMarketplaceItem,
  updateServerMarketplaceItem,
  listServerMarketplaceItems,
} from './serverContent';
import { ensureCustomServerSchema } from './customServers';
import { ensureLeaderboardSchema, readBoard, GLOBAL } from './leaderboard';

/**
 * Owner CRUD, and the one residual `leaderboard.ts` handed to this phase.
 *
 * ── The residual, verbatim ────────────────────────────────────────────────
 *
 *   > "A quest authored by an owner INTO A PLATFORM WORLD with `server_id` left
 *   > NULL is, by every column this table has, a platform quest. Phase 7c's
 *   > owner CRUD must stamp it."
 *
 * Every other hostile case the board already survives without a writer's help:
 * a vanity world is not in the enumerated manifest, so a forged identity is not
 * a candidate at all. This one is different. `quests.server_id` is the ONLY
 * column that distinguishes an owner's citadel quest from a platform one, so
 * here — and only here — the guarantee rests on a writer.
 *
 * ── Proved twice, on purpose, and the second proof is the one that always runs ─
 *
 * 1. **Against a real Postgres** (`suite`, skipped without POSTGRES_TEST_URL):
 *    author a hostile quest paying 10,000 CR into 'citadel' THROUGH THE OWNER
 *    CRUD, complete it, and assert the global quest board does not move.
 *
 * 2. **Against a recording client** (`describe`, always runs): assert the SQL
 *    the owner CRUD emits binds a non-null `server_id`, that the function
 *    refuses a blank one, and that no owner-side UPDATE or DELETE can reach a
 *    row whose `server_id` is NULL.
 *
 * Proof 2 exists because proof 1 skips on any machine without a database, and a
 * gate that measures nothing where it runs is worse than no gate — the failure
 * shape this repository has paid for repeatedly. Proof 2 is not a weaker copy of
 * proof 1: it pins a different link in the chain. Proof 1 says a stamped quest
 * does not rank. Proof 2 says the stamp is not optional.
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

const SERVER = 'server-content-test-server';

/**
 * The value an INSERT actually binds to one named column.
 *
 * Reads the column list and the `VALUES ($1, $2, ...)` list positionally, so
 * "the statement stamps `server_id`" is checked against the stamp's own slot
 * rather than against the parameter array as a bag. A column bound to `NULL`
 * literally (rather than to a placeholder) comes back as `null`, which is the
 * answer that should fail.
 */
function boundTo(q: { sql: string; params: unknown[] }, column: string): unknown {
  const m = /INSERT INTO \w+\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i.exec(flat(q.sql));
  if (!m) throw new Error(`not an INSERT with a column list: ${flat(q.sql).slice(0, 90)}`);
  const cols = m[1].split(',').map((c) => c.trim());
  const vals = m[2].split(',').map((v) => v.trim());
  const at = cols.indexOf(column);
  if (at < 0) throw new Error(`no ${column} column in ${cols.join(', ')}`);
  const placeholder = /^\$(\d+)/.exec(vals[at] ?? '');
  if (!placeholder) return vals[at] === 'NULL' ? null : vals[at];
  return q.params[Number(placeholder[1]) - 1];
}

/* ---------------------------------------------------------------------- */
/* Proof 2: the stamp is not optional. No database.                        */
/* ---------------------------------------------------------------------- */

describe('the owner CRUD stamps every row it writes', () => {
  it('binds a non-null server_id when authoring a quest', async () => {
    const db = makeFakeDb((sql) => {
      if (sql.includes("nextval('server_quest_number_seq')")) return [{ n: 1000001 }];
      if (sql.startsWith('INSERT INTO quests')) return [{ id: 'q1', server_id: SERVER }];
      return undefined;
    });
    await createServerQuest(db, SERVER, {
      world: 'citadel', title: 'One step, 10000 CR', questLine: 'vanity',
      rewardCredits: 10_000, updatedBy: 'owner@example.com',
    });

    const insert = db.only('INSERT INTO quests');
    /* The VALUE bound to the `server_id` COLUMN, resolved through the column
     * list — not merely "the params contain the server id somewhere". A column
     * list that mentions `server_id` and binds NULL to it is exactly the defect
     * this test exists for, and `toContain(SERVER)` would pass through it if the
     * id happened to appear in another slot. */
    expect(boundTo(insert, 'server_id')).toBe(SERVER);
  });

  it('refuses to author a quest with no server id at all', async () => {
    const db = makeFakeDb();
    for (const bad of ['', '   ']) {
      await expect(createServerQuest(db, bad, {
        world: 'citadel', title: 'x', questLine: 'y', rewardCredits: 1,
      })).rejects.toThrow(/server id/i);
    }
    /* Nothing reached the database. A function that validates AFTER writing has
     * validated nothing. */
    expect(db.matching('INSERT INTO quests')).toHaveLength(0);
  });

  it('numbers owner quests above the platform band so they cannot collide', async () => {
    expect(OWNER_QUEST_NUMBER_FLOOR).toBeGreaterThan(100_000);
    const db = makeFakeDb((sql) => {
      if (sql.includes('nextval')) return [{ n: OWNER_QUEST_NUMBER_FLOOR }];
      if (sql.startsWith('INSERT INTO quests')) return [{ id: 'q1' }];
      return undefined;
    });
    await createServerQuest(db, SERVER, {
      world: 'citadel', title: 'x', questLine: 'y', rewardCredits: 1,
    });
    /* A sequence, not MAX()+1. Two owners authoring at the same moment both read
     * the same maximum and one of them loses to the UNIQUE constraint. */
    expect(db.matching('nextval').length).toBeGreaterThan(0);
    expect(db.matching('MAX(quest_number)')).toHaveLength(0);
  });

  it('cannot edit or delete a quest that is not its own server\'s', async () => {
    const db = makeFakeDb(() => []);
    await updateServerQuest(db, SERVER, 'some-quest', { rewardCredits: 10_000 });
    await deleteServerQuest(db, SERVER, 'some-quest');

    /* Every owner-side write carries `server_id = $n`, so a platform row —
     * whose `server_id` IS NULL, and NULL matches no equality — is out of reach
     * by construction rather than by a check the route remembers to make. */
    for (const q of [...db.matching('UPDATE quests'), ...db.matching('DELETE FROM quests')]) {
      expect(flat(q.sql), q.sql).toContain('server_id = $');
      expect(q.params).toContain(SERVER);
    }
    expect(db.matching('UPDATE quests').length + db.matching('DELETE FROM quests').length)
      .toBeGreaterThan(0);
  });

  it('reads only its own server\'s quests', async () => {
    const db = makeFakeDb(() => []);
    await listServerQuests(db, SERVER);
    const read = db.only('FROM quests');
    expect(flat(read.sql)).toContain('server_id = $');
    expect(read.params).toContain(SERVER);
  });

  it('stamps marketplace items the same way, and cannot reach a platform one', async () => {
    const db = makeFakeDb((sql) =>
      sql.startsWith('INSERT INTO marketplace_items') ? [{ id: 'i1' }] : []
    );
    await createServerMarketplaceItem(db, SERVER, {
      /* `ship_part`, not `grant_item`. This fixture said `grant_item`, which is
       * an `action_config.effect` and never an action `id` — so it was authoring
       * exactly the row that 500s the whole catalogue (`catalogueIntegrity.test.ts`),
       * and `createServerMarketplaceItem` now refuses it. The intent here is the
       * stamp, not the action, so it takes the real id whose effect IS
       * `grant_item`. Changed deliberately: this fixture asserted a write that
       * should never have been allowed. */
      name: 'A very profitable rock', description: 'd', category: 'tools',
      image: '', gameAction: 'ship_part', actionConfig: {}, quantity: null,
      costBuy: 1, costSell: 10_000, worldName: 'citadel', sortOrder: 0,
    });
    const insert = db.only('INSERT INTO marketplace_items');
    expect(boundTo(insert, 'server_id')).toBe(SERVER);
    /* And `source_key` is NOT the owner's to choose — see serverContent.ts. The
     * game derives grant ids from it, so an owner-chosen key is the platform's
     * whole grant namespace handed over. */
    expect(boundTo(insert, 'source_key')).toBeNull();

    db.clear();
    await updateServerMarketplaceItem(db, SERVER, '00000000-0000-4000-8000-000000000abc', {
      costSell: 99_999,
    });
    for (const q of db.matching('marketplace_items')) {
      if (!/UPDATE|SELECT/.test(q.sql)) continue;
      expect(flat(q.sql), q.sql).toContain('server_id = $');
    }
  });

  it('keys owner lore by server, so it can never overwrite platform lore', async () => {
    const db = makeFakeDb(() => []);
    await upsertServerLore(db, SERVER, {
      scope: 'citadel', title: 'Ours', signLabel: 'Keeper', body: 'b',
    });
    /* `lore_entries` is the platform table and this must never write to it —
     * see customServers.ts for why owner lore is a table of its own. */
    expect(db.matching('INSERT INTO lore_entries')).toHaveLength(0);
    expect(db.matching('UPDATE lore_entries')).toHaveLength(0);
    const insert = db.only('INSERT INTO server_lore_entries');
    expect(boundTo(insert, 'server_id')).toBe(SERVER);

    db.clear();
    await listServerLore(db, SERVER);
    expect(db.only('FROM server_lore_entries').params).toContain(SERVER);
  });

  it('never writes an owner row into the platform tables at all', () => {
    /* A source scrape, and it earns its place: the assertions above are about
     * the calls the tests happen to make, and this is about every line in the
     * file. `core.autocrlf` is true in this repository, so normalise first —
     * a scrape that has been green in a worktree and red in the checkout has
     * happened here before. */
    const src = readFileSync(join(here, 'serverContent.ts'), 'utf8').replace(/\r\n/g, '\n');
    const statements = src.match(/(INSERT INTO|UPDATE|DELETE FROM)\s+\w+/g) ?? [];
    expect(statements.length).toBeGreaterThan(0);
    for (const s of statements) {
      expect(s, `${s} writes a platform table`).not.toMatch(/\blore_entries\b/);
    }
    // And every quest/item write in the file mentions the stamp.
    for (const block of src.split(/`/).filter((b) => /INSERT INTO quests|UPDATE quests|DELETE FROM quests/.test(b))) {
      expect(block, block.slice(0, 80)).toContain('server_id');
    }
  });
});

/* ---------------------------------------------------------------------- */
/* Proof 1: the consequence, against a real Postgres                       */
/* ---------------------------------------------------------------------- */

/**
 * ...0007. ...0001 creditLedger, ...0002 marketplacePurchase, ...0003
 * creditReport, ...0004 progressLedger, ...0005 leaderboard, ...0006 is claimed
 * by this phase's `customServers.test.ts`. Vitest runs files in parallel against
 * one database and a collision has broken a sibling suite here before.
 */
const OWNER = '00000000-0000-4000-8000-000000000007';
const PLAYER = '00000000-0000-4000-8000-000000070001';
const PLAYERS = [OWNER, PLAYER];

suite('the hostile quest, end to end (integration)', () => {
  let db: Client;

  const questScores = async () => {
    const out = await readBoard(db, 'quests', GLOBAL, { limit: 100, playerId: PLAYER });
    if (!out.ok) throw new Error(`refused: ${out.reason}`);
    return Object.fromEntries(
      out.board.entries.filter((e) => PLAYERS.includes(e.playerId)).map((e) => [e.playerId, e.score])
    );
  };

  beforeAll(async () => {
    db = new Client({ connectionString: URL_!, ssl: { rejectUnauthorized: false } });
    await db.connect();
    const which = await db.query('SELECT current_database() AS db');
    if (which.rows[0].db !== 'aether_test') {
      throw new Error(`refusing to run against "${which.rows[0].db}" — expected aether_test`);
    }

    await db.query(`
      CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY, handle TEXT, credit_balance INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await db.query(`
      CREATE TABLE IF NOT EXISTS quests (
        id TEXT PRIMARY KEY, quest_number INTEGER UNIQUE NOT NULL, world TEXT NOT NULL,
        quest_line TEXT NOT NULL, title TEXT NOT NULL,
        reward_credits INTEGER NOT NULL DEFAULT 0, duration_minutes INTEGER,
        pre_steps TEXT, steps TEXT, is_active BOOLEAN NOT NULL DEFAULT TRUE,
        repeatable BOOLEAN NOT NULL DEFAULT FALSE, updated_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    /* Reconcile a `quests` table an EARLIER SUITE may already have created.
     *
     * `aether_test` is shared and PERSISTS between runs, so the CREATE above
     * is a silent no-op whenever another suite got there first —
     * `leaderboard.test.ts` writes a narrower `quests` with no
     * `duration_minutes`. The mismatch never surfaces at setup; it surfaces
     * far away as `column "duration_minutes" does not exist` on the first
     * INSERT, which is how a fixture collision reads as a Phase 7 bug.
     * Additive and idempotent — the same shape `admin/lib/db.ts` uses on the
     * real table, and the same reconciliation `leaderboard.test.ts` already
     * does for `players.handle`. */
    for (const col of [
      `duration_minutes INTEGER`,
      `pre_steps TEXT`,
      `steps TEXT`,
      `repeatable BOOLEAN NOT NULL DEFAULT FALSE`,
      `updated_by TEXT`,
      `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    ]) {
      await db.query(`ALTER TABLE quests ADD COLUMN IF NOT EXISTS ${col}`);
    }
    await db.query(`
      CREATE TABLE IF NOT EXISTS player_quest_engagements (
        id TEXT PRIMARY KEY,
        player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        quest_id TEXT REFERENCES quests(id) ON DELETE SET NULL,
        quest_number INTEGER NOT NULL, quest_title TEXT NOT NULL, world TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'in_progress',
        credits_rewarded INTEGER NOT NULL DEFAULT 0,
        accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
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
    await db.query(`
      CREATE TABLE IF NOT EXISTS lore_entries (
        scope TEXT PRIMARY KEY, title TEXT NOT NULL,
        sign_label TEXT NOT NULL DEFAULT 'Lorekeeper', body TEXT NOT NULL,
        updated_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);

    for (const id of PLAYERS) {
      await db.query(
        `INSERT INTO players (id, credit_balance) VALUES ($1, 0) ON CONFLICT (id) DO NOTHING`,
        [id]
      );
    }
    await ensureLeaderboardSchema(db);
    await ensureCustomServerSchema(db);
    await db.query(
      `INSERT INTO custom_servers (id, owner_player_id, name, slug)
       VALUES ($1, $2, 'Content test', 'server-content-test')
       ON CONFLICT (id) DO NOTHING`,
      [SERVER, OWNER]
    );
  });

  const cleanup = async () => {
    await db.query(`DELETE FROM player_quest_engagements WHERE id LIKE 'sc-test-%'`);
    await db.query(`DELETE FROM quests WHERE server_id = $1 OR id LIKE 'sc-test-%'`, [SERVER]);
    await db.query(`DELETE FROM marketplace_items WHERE server_id = $1`, [SERVER]);
    await db.query(`DELETE FROM server_lore_entries WHERE server_id = $1`, [SERVER]);
  };

  beforeEach(cleanup);

  afterAll(async () => {
    if (!db) return;
    await cleanup();
    await db.query(`DELETE FROM custom_servers WHERE id = $1`, [SERVER]);
    await db.end();
  });

  it('an owner quest paying 10,000 CR into a PLATFORM world does not move the global board', async () => {
    /* The residual, exactly as it was handed over. 'citadel' is a real platform
     * world, so the manifest enumeration cannot help here; the only thing
     * standing between this quest and the global board is that the owner CRUD
     * stamped it. */
    const created = await createServerQuest(db, SERVER, {
      world: 'citadel',
      title: 'Press E. Receive ten thousand credits.',
      questLine: 'vanity',
      rewardCredits: 10_000,
      updatedBy: 'owner@example.com',
    });
    expect(created.world).toBe('citadel');
    expect(created.rewardCredits).toBe(10_000);

    const stamp = await db.query('SELECT server_id FROM quests WHERE id = $1', [created.id]);
    expect(stamp.rows[0].server_id, 'the stamp IS the guarantee here').toBe(SERVER);

    const before = await questScores();

    await db.query(
      `INSERT INTO player_quest_engagements
         (id, player_id, quest_id, quest_number, quest_title, world, status, server_id)
       VALUES ('sc-test-eng', $1, $2, $3, $4, 'citadel', 'completed', $5)`,
      [PLAYER, created.id, created.questNumber, created.title, SERVER]
    );

    expect(await questScores()).toEqual(before);

    /* And the same completion with the ENGAGEMENT stamp forgotten, which is the
     * exact shape leaderboard.test.ts case 2b describes — proved here against a
     * quest this app's own CRUD authored rather than one the test hand-wrote. */
    await db.query(`UPDATE player_quest_engagements SET server_id = NULL WHERE id = 'sc-test-eng'`);
    expect(await questScores()).toEqual(before);
  });

  it('the same quest DOES rank on its own server\'s board, so the scoping discriminates', async () => {
    const created = await createServerQuest(db, SERVER, {
      world: 'citadel', title: 'Ours', questLine: 'vanity', rewardCredits: 10_000,
    });
    await db.query(
      `INSERT INTO player_quest_engagements
         (id, player_id, quest_id, quest_number, quest_title, world, status, server_id)
       VALUES ('sc-test-eng', $1, $2, $3, 'Ours', 'citadel', 'completed', $4)`,
      [PLAYER, created.id, created.questNumber, SERVER]
    );
    const out = await readBoard(db, 'quests', { serverId: SERVER }, { limit: 10, playerId: PLAYER });
    if (!out.ok) throw new Error(out.reason);
    expect(out.board.entries.find((e) => e.self)?.score).toBe(1);
  });

  it('an owner cannot reach a platform quest through its own CRUD', async () => {
    await db.query(
      `INSERT INTO quests (id, quest_number, world, quest_line, title, reward_credits, server_id)
       VALUES ('sc-test-platform', 991001, 'citadel', 'platform', 'A real quest', 50, NULL)`
    );
    const patched = await updateServerQuest(db, SERVER, 'sc-test-platform', {
      rewardCredits: 10_000,
    });
    expect(patched).toBeNull();
    const still = await db.query('SELECT reward_credits FROM quests WHERE id = $1', [
      'sc-test-platform',
    ]);
    expect(Number(still.rows[0].reward_credits)).toBe(50);

    expect(await deleteServerQuest(db, SERVER, 'sc-test-platform')).toBe(false);
    const alive = await db.query('SELECT 1 FROM quests WHERE id = $1', ['sc-test-platform']);
    expect(alive.rowCount).toBe(1);
  });

  it('lists only its own quests, so an owner never sees the platform catalogue as theirs', async () => {
    await db.query(
      `INSERT INTO quests (id, quest_number, world, quest_line, title, reward_credits, server_id)
       VALUES ('sc-test-platform', 991002, 'citadel', 'platform', 'A real quest', 50, NULL)`
    );
    await createServerQuest(db, SERVER, {
      world: 'citadel', title: 'Ours', questLine: 'vanity', rewardCredits: 5,
    });
    const mine = await listServerQuests(db, SERVER);
    expect(mine.map((q) => q.title)).toEqual(['Ours']);
  });

  it('owner lore does not displace the platform entry for the same scope', async () => {
    await db.query(
      `INSERT INTO lore_entries (scope, title, body) VALUES ('citadel', 'Platform', 'p')
       ON CONFLICT (scope) DO UPDATE SET title = 'Platform', body = 'p'`
    );
    await upsertServerLore(db, SERVER, {
      scope: 'citadel', title: 'Ours', signLabel: 'Keeper', body: 'o',
    });
    const platform = await db.query(`SELECT title FROM lore_entries WHERE scope = 'citadel'`);
    expect(platform.rows[0].title).toBe('Platform');
    const ours = await listServerLore(db, SERVER);
    expect(ours.find((l) => l.scope === 'citadel')?.title).toBe('Ours');
  });

  it('an owner marketplace item is invisible to the default catalogue', async () => {
    await createServerMarketplaceItem(db, SERVER, {
      // `ship_part` for the reason recorded on the fixture above.
      name: 'Infinite money rock', description: 'd', category: 'tools', image: '',
      gameAction: 'ship_part', actionConfig: {}, quantity: null,
      costBuy: 1, costSell: 10_000, worldName: 'citadel', sortOrder: 0,
    });
    const global = await db.query(
      `SELECT COUNT(*)::int AS n FROM marketplace_items
        WHERE server_id IS NULL AND name = 'Infinite money rock'`
    );
    expect(Number(global.rows[0].n)).toBe(0);
    expect((await listServerMarketplaceItems(db, SERVER)).map((i) => i.name))
      .toEqual(['Infinite money rock']);
  });
});
