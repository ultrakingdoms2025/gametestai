import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import {
  RANKABLE,
  REFUSED,
  PLATFORM_WORLDS,
  RELIC_CEILING_PER_WORLD,
  rankableCategory,
  ensureLeaderboardSchema,
  readBoard,
  GLOBAL,
  type BoardScope,
} from './leaderboard';

/**
 * The leaderboard, and the two rules it exists to hold.
 *
 * ── Rule one: only content-capped sets rank (Phase 3 §9) ──────────────────
 *
 * The roadmap's Phase 11 offers "fastest races, highest survival wave, weekly
 * credits, rare collections". Phase 3 §9 — the phase explicitly tasked with
 * settling rankability — rules three of those four out, and this file pins the
 * refusal rather than the offer. A total or a time has no ceiling, so a forger's
 * advantage on one is unbounded; a set with a content cap bounds it, and the
 * board then ranks *completion*.
 *
 * ── Rule two: custom-server content never moves a global board (Phase 7) ──
 *
 * `custom_servers` does not exist yet, which is exactly why the tests below are
 * worth having now: they are written against the schema Phase 7 will create, so
 * there is no later edit to forget. The three hostile cases descend in strength:
 *
 *   1. hostile rows STAMPED with a server id      — the provenance partition
 *   2. hostile rows with the stamp FORGOTTEN      — the identity domain
 *   3. hostile rows forging PLATFORM identities   — the content ceiling
 *
 * Case 2 is the one that matters. It says the global board holds even when the
 * write-time stamp fails completely, because the board counts a manifest of
 * platform content and a forged identity is not in it. Case 3 is §9's "bounded,
 * survivable failure" written as a number.
 *
 * Isolation as `progressLedger.test.ts`: `aether_test`, a SEPARATE database,
 * with `beforeAll` refusing to run anywhere else. Skips when POSTGRES_TEST_URL
 * is absent so CI stays green without a database.
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

/* ---------------------------------------------------------------------- */
/* The rule, before any database                                           */
/* ---------------------------------------------------------------------- */

describe('what is rankable (Phase 3 §9, over the roadmap)', () => {
  it('refuses every unbounded measure the roadmap offered', () => {
    /* Phase 11 named "fastest races ... weekly credits". §9 rules both out and
     * §9 wins: it is the phase that was tasked with settling this. */
    for (const id of ['credits', 'weekly_credits', 'race', 'trial', 'kills', 'ore']) {
      expect(rankableCategory(id), `${id} must not be rankable`).toBeNull();
    }
  });

  it('says why each refusal was made, so the next reader does not re-litigate it', () => {
    for (const id of ['credits', 'race', 'trial', 'kills', 'ore']) {
      expect(REFUSED[id], `${id} needs a recorded reason`).toBeTruthy();
    }
  });

  it('ranks the sets §9 allows', () => {
    expect(rankableCategory('relics')).toBeTruthy();
    expect(rankableCategory('charters')).toBeTruthy();
    expect(rankableCategory('quests')).toBeTruthy();
  });

  it('gives every shipped category a ceiling fixed by content', () => {
    for (const [id, spec] of Object.entries(RANKABLE)) {
      if (spec.ceiling === null) continue; // declared, refused at read — see below
      // A number, or 'catalogue' for the ones counted live off a content table.
      if (spec.ceiling === 'catalogue') continue;
      expect(spec.ceiling, `${id} ceiling`).toBeGreaterThan(0);
    }
  });

  it('refuses a category whose maximum the server cannot state', async () => {
    /* §9 lists viewpoints and wings as rankable. The server does not hold their
     * rosters -- ProgressSync deliberately keeps them local -- so it cannot say
     * what "all of them" is, and a board with no ceiling is the unbounded thing
     * §9 refused. Declared here, refused at read, and it lights up the moment a
     * ceiling can be stated. */
    const spec = rankableCategory('viewpoints');
    expect(spec).toBeTruthy();
    expect(spec!.ceiling).toBeNull();
  });

  it('never ranks a number the client chose', () => {
    /* Every shipped category counts identities. None reads a value column: a
     * value is a number a device sent, and §9's refusal of times is exactly a
     * refusal to rank one. */
    for (const spec of Object.values(RANKABLE)) {
      expect(spec.source).not.toBe('values');
    }
  });
});

describe('the platform world manifest', () => {
  it('holds the eighteen worlds the objective names', () => {
    expect(PLATFORM_WORLDS).toHaveLength(18);
    expect(new Set(PLATFORM_WORLDS).size).toBe(18);
  });

  it('matches the world ids the game actually registers', () => {
    /* The manifest is the counted domain, so it drifting is the one way this
     * board could quietly stop counting a real world. Checked against the
     * game's own registry rather than trusted.
     *
     * `Volcanic.js` publishes `id: 'cinder'`, so a filename-derived list would
     * have been wrong on the first planet in the file. That is the drift this
     * test exists for. */
    const root = join(here, '..', '..');
    const main = readFileSync(join(root, 'src', 'main.js'), 'utf8');
    const classes = [...main.matchAll(/worldManager\.register\((\w+)\)/g)].map((m) => m[1]);
    expect(classes.length).toBeGreaterThan(0);

    /* One `register()` call has no world file of its own: the planet loop,
     * handled below. Asserting there is EXACTLY one is what stops this test
     * quietly skipping a world the manifest is missing. */
    const named = classes.filter((c) => existsSync(join(root, 'src', 'worlds', `${c}.js`)));
    expect(classes.length - named.length).toBe(1);
    expect(main).toMatch(/of planetWorldClasses\(\)\) worldManager\.register\(/);

    const registered: string[] = [];
    for (const cls of named) {
      const src = readFileSync(join(root, 'src', 'worlds', `${cls}.js`), 'utf8');
      const id = /static id = '([^']+)'/.exec(src)?.[1];
      expect(id, `${cls} static id`).toBeTruthy();
      registered.push(id!);
    }

    const planetDir = join(root, 'src', 'worlds', 'planets');
    const index = readFileSync(join(planetDir, 'index.js'), 'utf8');
    const modules = [...index.matchAll(/^import \{ \w+ \} from '\.\/(\w+)\.js';$/gm)].map((m) => m[1]);
    expect(modules.length).toBeGreaterThan(0);
    for (const mod of modules) {
      const src = readFileSync(join(planetDir, `${mod}.js`), 'utf8');
      const id = /^\s*id: '([a-z_]+)',$/m.exec(src)?.[1];
      expect(id, `${mod} descriptor id`).toBeTruthy();
      registered.push(id!);
    }

    expect([...PLATFORM_WORLDS].sort()).toEqual(registered.sort());
    expect(readdirSync(planetDir).length).toBeGreaterThan(0);
  });
});

describe('the score endpoint', () => {
  it('has no way to submit a score', () => {
    /* §9: the endpoint derives from the identity sets the server already holds
     * "rather than accepting a submitted figure". A POST handler is the whole
     * hole, so its absence is asserted rather than assumed. */
    const route = readFileSync(
      join(here, '..', 'app', 'api', 'game', 'leaderboard', 'route.ts'),
      'utf8'
    );
    expect(route).toMatch(/export async function GET/);
    expect(route).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/);
  });
});

/* ---------------------------------------------------------------------- */
/* Against a real Postgres                                                 */
/* ---------------------------------------------------------------------- */

/**
 * Fixed and obviously synthetic. Never real players.
 *
 * ...0005, and the number matters: vitest runs test FILES in parallel against
 * one shared database. ...0001 is creditLedger's, ...0002 marketplacePurchase's,
 * ...0003 creditReport's, ...0004 progressLedger's. This suite needs three
 * players to have a board at all, so it also claims the ...0005xxxx block.
 */
const ME = '00000000-0000-4000-8000-000000000005';
const RIVAL = '00000000-0000-4000-8000-000000050001';
const THIRD = '00000000-0000-4000-8000-000000050002';
const PLAYERS = [ME, RIVAL, THIRD];

/** Quest rows this suite owns. Numbered high so no authored quest collides. */
const PLATFORM_QUEST = 'lb-test-platform-quest';
const HOSTILE_QUEST = 'lb-test-hostile-quest';

suite('leaderboard (integration)', () => {
  let db: Client;

  /**
   * This suite's players' scores, and ONLY theirs.
   *
   * A board is global by definition, so it also ranks `progressLedger.test.ts`'s
   * fixture — which holds citadel relics of its own and rewrites them in its own
   * `beforeEach`. Vitest runs the two files in parallel against one database, so
   * an unfiltered assertion here is a coin toss that passes alone and fails in
   * the suite. Found exactly that way.
   */
  const scores = async (category: string, scope: BoardScope = GLOBAL) => {
    const out = await readBoard(db, category, scope, { limit: 100, playerId: ME });
    if (!out.ok) throw new Error(`refused: ${out.reason}`);
    return Object.fromEntries(
      out.board.entries.filter((e) => PLAYERS.includes(e.playerId)).map((e) => [e.playerId, e.score])
    );
  };

  const giveRelics = async (playerId: string, world: string, n: number, serverId: string | null = null) => {
    const keys = Array.from({ length: n }, (_, i) => `${world}-relic-${i}`);
    await db.query(
      `INSERT INTO player_progress_items (player_id, kind, scope, item_key, server_id)
       SELECT $1, 'relic', $2, k, $4 FROM unnest($3::text[]) AS k
       ON CONFLICT (player_id, kind, scope, item_key) DO NOTHING`,
      [playerId, world, keys, serverId]
    );
  };

  const giveCharters = async (playerId: string, worlds: string[], serverId: string | null = null) => {
    await db.query(
      `INSERT INTO player_progress_items (player_id, kind, scope, item_key, server_id)
       SELECT $1, 'charter', '', k, $3 FROM unnest($2::text[]) AS k
       ON CONFLICT (player_id, kind, scope, item_key) DO NOTHING`,
      [playerId, worlds, serverId]
    );
  };

  const completeQuest = async (playerId: string, questId: string, serverId: string | null = null) => {
    await db.query(
      `INSERT INTO player_quest_engagements
         (id, player_id, quest_id, quest_number, quest_title, world, status, server_id)
       VALUES ($1, $2, $3, 1, 'test', 'citadel', 'completed', $4)
       ON CONFLICT (id) DO NOTHING`,
      [`lb-test-eng-${playerId}-${questId}`, playerId, questId, serverId]
    );
  };

  beforeAll(async () => {
    db = new Client({ connectionString: URL_!, ssl: { rejectUnauthorized: false } });
    await db.connect();

    const which = await db.query('SELECT current_database() AS db');
    if (which.rows[0].db !== 'aether_test') {
      throw new Error(`refusing to run against "${which.rows[0].db}" — expected aether_test`);
    }

    // `id` TEXT, because production's is TEXT. See creditLedger.test.ts.
    await db.query(`
      CREATE TABLE IF NOT EXISTS players (
        id             TEXT PRIMARY KEY,
        handle         TEXT,
        credit_balance INTEGER NOT NULL DEFAULT 0,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS handle TEXT`);
    await db.query(`
      CREATE TABLE IF NOT EXISTS quests (
        id               TEXT PRIMARY KEY,
        quest_number     INTEGER UNIQUE NOT NULL,
        world            TEXT NOT NULL,
        quest_line       TEXT NOT NULL,
        title            TEXT NOT NULL,
        reward_credits   INTEGER NOT NULL DEFAULT 0,
        is_active        BOOLEAN NOT NULL DEFAULT TRUE,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS player_quest_engagements (
        id               TEXT PRIMARY KEY,
        player_id        TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        quest_id         TEXT REFERENCES quests(id) ON DELETE SET NULL,
        quest_number     INTEGER NOT NULL,
        quest_title      TEXT NOT NULL,
        world            TEXT NOT NULL,
        status           TEXT NOT NULL DEFAULT 'in_progress',
        credits_rewarded INTEGER NOT NULL DEFAULT 0,
        accepted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await ensureLeaderboardSchema(db);
  });

  afterAll(async () => {
    if (!db) return;
    await db.query(`DELETE FROM player_quest_engagements WHERE id LIKE 'lb-test-%'`);
    await db.query(`DELETE FROM quests WHERE id LIKE 'lb-test-%'`);
    await db.query('DELETE FROM player_progress_items WHERE player_id = ANY($1::text[])', [PLAYERS]);
    await db.query('DELETE FROM player_progress_values WHERE player_id = ANY($1::text[])', [PLAYERS]);
    /* The synthetic players stay. Other suites reference their ids from tables
     * with foreign keys; deleting one trips the key, which is teardown failing
     * rather than the board. */
    await db.end();
  });

  beforeEach(async () => {
    await db.query(`DELETE FROM player_quest_engagements WHERE id LIKE 'lb-test-%'`);
    await db.query(`DELETE FROM quests WHERE id LIKE 'lb-test-%'`);
    await db.query('DELETE FROM player_progress_items WHERE player_id = ANY($1::text[])', [PLAYERS]);
    await db.query('DELETE FROM player_progress_values WHERE player_id = ANY($1::text[])', [PLAYERS]);
    for (const id of PLAYERS) {
      await db.query(
        `INSERT INTO players (id, credit_balance) VALUES ($1, 0)
         ON CONFLICT (id) DO NOTHING`,
        [id]
      );
    }
    await db.query(
      `INSERT INTO quests (id, quest_number, world, quest_line, title, reward_credits, server_id)
       VALUES ($1, 990001, 'citadel', 'lb-test', 'A platform quest', 100, NULL)
       ON CONFLICT (id) DO NOTHING`,
      [PLATFORM_QUEST]
    );
  });

  /* ------------------------------------------------------------------ */
  /* The derivation                                                      */
  /* ------------------------------------------------------------------ */

  it('derives a relic score from the progress ledger, never from a submitted figure', async () => {
    await giveRelics(ME, 'citadel', 12);
    await giveRelics(RIVAL, 'citadel', 5);
    expect(await scores('relics')).toEqual({ [ME]: 12, [RIVAL]: 5 });
  });

  it('sums a world-scoped set across the manifest', async () => {
    await giveRelics(ME, 'citadel', 4);
    await giveRelics(ME, 'medieval', 3);
    expect((await scores('relics'))[ME]).toBe(7);
  });

  it('ranks, and tells the caller where they stand even outside the top slice', async () => {
    await giveRelics(RIVAL, 'citadel', 9);
    await giveRelics(THIRD, 'citadel', 8);
    await giveRelics(ME, 'citadel', 1);
    /* limit 1, so the slice is exactly the top-ranked player -- whoever that is
     * across the shared database. ME holds one relic and RIVAL nine, so ME is
     * never that player, and appearing anyway is the whole assertion. */
    const out = await readBoard(db, 'relics', GLOBAL, { limit: 1, playerId: ME });
    if (!out.ok) throw new Error(out.reason);
    expect(out.board.entries[0].rank).toBe(1);
    expect(out.board.entries.length).toBeLessThanOrEqual(2);
    const mine = out.board.entries.find((e) => e.self);
    expect(mine?.score).toBe(1);
    expect(mine?.rank).toBeGreaterThan(1);
  });

  it('counts charters as worlds, so its ceiling is the manifest itself', async () => {
    await giveCharters(ME, ['citadel', 'medieval', 'cinder']);
    const out = await readBoard(db, 'charters', GLOBAL, { limit: 10, playerId: ME });
    if (!out.ok) throw new Error(out.reason);
    expect(out.board.entries.find((e) => e.self)?.score).toBe(3);
    expect(out.board.ceiling).toBe(PLATFORM_WORLDS.length);
  });

  it('takes the quest ceiling from the platform catalogue, not from a constant', async () => {
    await completeQuest(ME, PLATFORM_QUEST);
    const out = await readBoard(db, 'quests', GLOBAL, { limit: 10, playerId: ME });
    if (!out.ok) throw new Error(out.reason);
    expect(out.board.entries.find((e) => e.self)?.score).toBe(1);
    expect(out.board.ceiling).toBeGreaterThanOrEqual(1);
  });

  it('refuses a category with no stated ceiling rather than ranking it', async () => {
    const out = await readBoard(db, 'viewpoints', GLOBAL, { limit: 10, playerId: ME });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('no_ceiling');
  });

  it('refuses an unknown category', async () => {
    const out = await readBoard(db, 'weekly_credits', GLOBAL, { limit: 10, playerId: ME });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('unknown_category');
  });

  /* ------------------------------------------------------------------ */
  /* The Phase 7 abuse vector, in three descending strengths              */
  /* ------------------------------------------------------------------ */

  it('1. a hostile custom server that stamps its writes does not move the global board', async () => {
    await giveRelics(ME, 'citadel', 3);
    const before = await scores('relics');

    // An owner authors a world of their own and hands out 500 relics in it.
    await giveRelics(ME, 'citadel', 500, 'hostile-server');
    await giveCharters(ME, [...PLATFORM_WORLDS], 'hostile-server');
    await db.query(
      `INSERT INTO quests (id, quest_number, world, quest_line, title, reward_credits, server_id)
       VALUES ($1, 990002, 'citadel', 'lb-test', 'One step, 10000 CR', 10000, 'hostile-server')`,
      [HOSTILE_QUEST]
    );
    await completeQuest(ME, HOSTILE_QUEST, 'hostile-server');

    expect(await scores('relics')).toEqual(before);
    expect(await scores('charters')).toEqual({});
    expect(await scores('quests')).toEqual({});
  });

  it("2. ..and does not move it even when the server stamp is forgotten entirely", async () => {
    /* The load-bearing case. If a future writer forgets `server_id`, the rows
     * are indistinguishable from platform progress by provenance -- and the
     * board still cannot see them, because it counts a MANIFEST of platform
     * content and a vanity world is not in it. There is no filter here to
     * forget: the manifest is the counted domain. */
    await giveRelics(ME, 'citadel', 3);
    const before = await scores('relics');

    await giveRelics(ME, 'owners-vanity-world', 500, null);
    await giveCharters(ME, ['owners-vanity-world', 'another-vanity-world'], null);
    await db.query(
      `INSERT INTO quests (id, quest_number, world, quest_line, title, reward_credits, server_id)
       VALUES ($1, 990003, 'owners-vanity-world', 'lb-test', 'One step, 10000 CR', 10000, 'hostile-server')`,
      [HOSTILE_QUEST]
    );
    await completeQuest(ME, HOSTILE_QUEST, null);

    expect(await scores('relics')).toEqual(before);
    expect(await scores('charters')).toEqual({});
    expect(await scores('quests')).toEqual({});
  });

  it('2a. a quest in a vanity world does not count even with BOTH stamps forgotten', async () => {
    /* The only case the world manifest covers alone, and the only quest case
     * that survives a total failure of every write-time stamp. Both `server_id`
     * columns are NULL here, so by provenance this quest is indistinguishable
     * from a platform one -- and it still cannot count, because its world is not
     * in the enumerated domain. */
    await db.query(
      `INSERT INTO quests (id, quest_number, world, quest_line, title, reward_credits, server_id)
       VALUES ($1, 990005, 'owners-vanity-world', 'lb-test', 'One step, 10000 CR', 10000, NULL)`,
      [HOSTILE_QUEST]
    );
    await completeQuest(ME, HOSTILE_QUEST, null);
    expect(await scores('quests')).toEqual({});
  });

  it("2b. an owner's quest in a PLATFORM world, stamp forgotten, still does not count", async () => {
    /* The narrow gap the world manifest cannot cover: an owner authors into
     * 'citadel' rather than a vanity world, and the engagement stamp is
     * forgotten. Only `quests.server_id` stands here, which is why it is a
     * guard in its own right and why Phase 7c's owner CRUD must set it. */
    await db.query(
      `INSERT INTO quests (id, quest_number, world, quest_line, title, reward_credits, server_id)
       VALUES ($1, 990004, 'citadel', 'lb-test', 'One step, 10000 CR', 10000, 'hostile-server')`,
      [HOSTILE_QUEST]
    );
    await completeQuest(ME, HOSTILE_QUEST, null);
    expect(await scores('quests')).toEqual({});
  });

  it('3. ..and forging platform identities is bounded by the content ceiling', async () => {
    /* §9's "bounded, survivable failure", as a number. An owner who mints relics
     * under a real world id with the stamp forgotten reaches the ceiling and
     * stops -- the same ceiling an honest completionist reaches. */
    await giveRelics(ME, 'citadel', 4000, null);
    expect((await scores('relics'))[ME]).toBe(RELIC_CEILING_PER_WORLD);

    await giveCharters(ME, [...PLATFORM_WORLDS, 'vanity-a', 'vanity-b'], null);
    expect((await scores('charters'))[ME]).toBe(PLATFORM_WORLDS.length);
  });

  it("a custom server's own board does move, so the scoping discriminates", async () => {
    /* Otherwise every assertion above would also pass against a board that was
     * simply broken. */
    await giveRelics(ME, 'citadel', 7, 'hostile-server');
    expect(await scores('relics', { serverId: 'hostile-server' })).toEqual({ [ME]: 7 });
    expect(await scores('relics', GLOBAL)).toEqual({});
  });

  it('a platform quest completed inside a custom server stays on that server', async () => {
    /* D2 gives a member the platform catalogue *in addition to* the owner's, so
     * the quest row is innocent and the engagement is where the provenance is. */
    await completeQuest(ME, PLATFORM_QUEST, 'hostile-server');
    expect(await scores('quests')).toEqual({});
    expect(await scores('quests', { serverId: 'hostile-server' })).toEqual({ [ME]: 1 });
  });
});
