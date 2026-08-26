import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { flat } from './fakeDb';
import { getLoreEntries } from './lore';
import {
  ensureCustomServerSchema,
  createServer,
  applyMembershipAction,
  selectServer,
  currentServerId,
} from './customServers';
import { upsertServerLore } from './serverContent';
import { writeEntitlement } from './premium';

/**
 * Custom lore, from an owner's keyboard to a player's screen.
 *
 * ── The defect ────────────────────────────────────────────────────────────
 *
 * Owners could author lore and no player could ever read it. `/api/lore` called
 * `getLoreEntries()` with no scope; `lore.ts` answered `WHERE server_id IS NULL`;
 * and owner lore is not in that table at all — `serverContent.ts` writes
 * `server_lore_entries`, which was read by the admin panel and by nothing else.
 * No code path joined the two. Content that is authored, stored, and
 * unreachable: complete, correct, and invisible.
 *
 * ── What is proved here, and where ────────────────────────────────────────
 *
 * 1. **Against a real Postgres** (`suite`, skipped without POSTGRES_TEST_URL):
 *    a player is invited into a server, accepts, selects it, and the scope that
 *    `currentServerId` resolves for them — not a scope the test hands over —
 *    fetches that server's lore ON TOP OF the platform's. The same player in
 *    default mode gets the platform lore and NOTHING ELSE, and a member of a
 *    different server never sees the first server's rows.
 *
 * 2. **Against the source** (`describe`, always runs): the read states its
 *    scope, the default argument is the platform rather than "no filter", and
 *    the route resolves the scope from the session rather than from the request.
 *
 * Proof 2 exists because proof 1 skips on a machine with no database, and a
 * gate that measures nothing where it runs is worse than no gate at all — the
 * argument `serverContent.test.ts` already makes, and the failure shape this
 * repository has paid for more than once.
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

/* ---------------------------------------------------------------------- */
/* Proof 2: the scope is stated, and it comes from the session             */
/* ---------------------------------------------------------------------- */

describe('the lore read states its scope', () => {
  it('the platform partition still filters, and now unions the same way quests do', () => {
    const src = source('lib', 'lore.ts');
    const platform = src
      .split('`')
      .find((c) => c.includes('FROM lore_entries') && /\bSELECT\b/i.test(c));
    expect(platform, 'the platform SELECT').toBeTruthy();
    const sql = flat(platform!);
    expect(sql).toContain('server_id IS NULL');
    /* The literal union clause `playerDb.ts` and `marketplaceDb.ts` already use.
     * Spelled out rather than interpolated, so this test can read it — the
     * argument `contentScoping.test.ts` records for deleting the shared
     * constant somebody keeps wanting to introduce. */
    expect(sql).toContain("server_id = COALESCE($1, '')");
  });

  it('the owner overlay is scoped to one server and cannot be reached by a NULL', () => {
    const src = source('lib', 'lore.ts');
    const overlay = src
      .split('`')
      .find((c) => c.includes('FROM server_lore_entries') && /\bSELECT\b/i.test(c));
    expect(overlay, 'the overlay SELECT').toBeTruthy();
    const sql = flat(overlay!);
    expect(sql).toContain("server_id = COALESCE($1, '')");
    /* `COALESCE(NULL, '')` is `''`, and no row carries `''`, so default mode
     * cannot reach an owner's lore even if the union were issued for it. A
     * property of SQL rather than of anyone's diligence. */
    expect(sql).not.toContain('server_id IS NULL');
  });

  it('an omitted argument means the PLATFORM, never "no filter"', () => {
    /* The failure this guards is a signature where forgetting the argument
     * widens the read. Every caller written before custom servers existed —
     * `getLore`, and through it the public marketing page — passes nothing.
     * The mode argument earns the same rule: omitted means `'extend'`, the
     * shipped merge, never "whatever narrows". */
    const src = source('lib', 'lore.ts');
    expect(src).toMatch(/getLoreEntries: LoreFetcher = async \(serverId = null, mode = 'extend'\)/);
    expect(src).toMatch(/serverId\?: string \| null/);
  });

  it('the overlay sorts after the platform, which IS the merge rule', () => {
    /* Both consumers key by scope and keep the last row they see, so an owner's
     * variant of a scope wins and every scope they did not author keeps the
     * platform text. If the ordering ever flips, authored lore silently stops
     * appearing while every test that only counts rows still passes. */
    const src = source('lib', 'lore.ts');
    expect(flat(src)).toContain('ORDER BY scope_origin');
    expect(src).toMatch(/0 AS scope_origin\s*\n\s*FROM lore_entries/);
    expect(src).toMatch(/1 AS scope_origin\s*\n\s*FROM server_lore_entries/);
  });
});

describe('the lore route resolves its scope server-side', () => {
  const route = source('app', 'api', 'lore', 'route.ts');

  it('reads the session and the stored selection, not the request', () => {
    expect(route).toContain('await auth()');
    /* `currentContentScope`, since the content-mode work: the same
     * membership-re-checking resolution as `currentServer`, now answering the
     * PAIR — which server and how it merges — in one decision. */
    expect(route).toContain('currentContentScope(playerId)');
    /* No query parameter, no body. A scope a caller can name is a scope a
     * caller can forge, and this route is fetched by a game client the player
     * controls. */
    expect(route).not.toContain('searchParams');
    expect(route).not.toContain('req.json');
    expect(route).not.toContain('request.json');
  });

  it('passes that scope into the fetcher rather than dropping it', () => {
    /* The whole defect was one call with no argument. Both halves of the pair
     * travel — dropping the mode would quietly serve a replace-mode member
     * the platform union. */
    expect(route).not.toContain('getLoreEntries()');
    expect(route).toContain("getLoreEntries(scope?.serverId ?? null, scope?.mode ?? 'extend')");
  });

  it('a signed-out caller is the platform partition, exactly as before', () => {
    expect(route).toMatch(/if \(!session\?\.user\?\.id\) return null;/);
  });
});

/* ---------------------------------------------------------------------- */
/* Proof 1: the union, end to end                                          */
/* ---------------------------------------------------------------------- */

const OWNER = 'lore-scope-owner';
const MEMBER = 'lore-scope-member';
const OUTSIDER = 'lore-scope-outsider';
const PLAYERS = [OWNER, MEMBER, OUTSIDER];

/** Distinct from every real scope, so a shared test database cannot collide. */
const SHARED_SCOPE = 'lorescope-shared';
const PLATFORM_ONLY_SCOPE = 'lorescope-platform';
const OWNER_ONLY_SCOPE = 'lorescope-owner';
const TEST_SCOPES = [SHARED_SCOPE, PLATFORM_ONLY_SCOPE, OWNER_ONLY_SCOPE];

/** What `/api/lore` builds from the rows: keyed by scope, last row wins. */
function asEntries(rows: Array<{ scope: string; title: string; body: string; sign_label: string }>) {
  return Object.fromEntries(
    rows.map((r) => [r.scope, { title: r.title, body: r.body, sign_label: r.sign_label }])
  );
}

suite('custom lore reaches the player who is in that server (integration)', () => {
  let db: Client;
  let previousUrl: string | undefined;
  let serverId: string;
  let otherServerId: string;

  beforeAll(async () => {
    db = new Client({ connectionString: URL_!, ssl: { rejectUnauthorized: false } });
    await db.connect();
    const which = await db.query('SELECT current_database() AS db');
    if (which.rows[0].db !== 'aether_test') {
      throw new Error(`refusing to run against "${which.rows[0].db}" — expected aether_test`);
    }

    /* `getLoreEntries` opens its OWN connection from `POSTGRES_URL`, which is
     * the point: this suite exercises the shipped function rather than a
     * re-implementation of its query. Restored in afterAll. */
    previousUrl = process.env.POSTGRES_URL;
    process.env.POSTGRES_URL = URL_!;

    await db.query(`
      CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY, handle TEXT, credit_balance INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    for (const id of PLAYERS) {
      await db.query(
        `INSERT INTO players (id, handle, credit_balance) VALUES ($1, $2, 0)
         ON CONFLICT (id) DO NOTHING`,
        [id, `ls-${id.slice(-6)}`]
      );
    }
    await db.query(`
      CREATE TABLE IF NOT EXISTS lore_entries (
        scope TEXT PRIMARY KEY, title TEXT NOT NULL,
        sign_label TEXT NOT NULL DEFAULT 'Lorekeeper', body TEXT NOT NULL,
        updated_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await ensureCustomServerSchema(db);
  });

  const wipe = async () => {
    await db.query(`DELETE FROM lore_entries WHERE scope = ANY($1::text[])`, [TEST_SCOPES]);
    await db.query(`DELETE FROM player_server_selection WHERE player_id = ANY($1::text[])`, [PLAYERS]);
    await db.query(`DELETE FROM custom_servers WHERE owner_player_id = ANY($1::text[])`, [PLAYERS]);
    await db.query(`DELETE FROM server_entitlements WHERE player_id = ANY($1::text[])`, [PLAYERS]);
  };

  beforeEach(async () => {
    await wipe();

    /* Two platform rows. Every row in `lore_entries` is NULL-scoped today, and
     * these are written the same way the lore admin writes them. */
    await db.query(
      `INSERT INTO lore_entries (scope, title, sign_label, body)
       VALUES ($1, 'Platform shared', 'Lorekeeper', 'the platform text'),
              ($2, 'Platform only', 'Lorekeeper', 'only the platform has this')`,
      [SHARED_SCOPE, PLATFORM_ONLY_SCOPE]
    );

    await writeEntitlement(db, {
      playerId: OWNER, subscriptionId: 'sub_lore_scope', customerId: 'cus_lore_scope',
      status: 'active', currentPeriodEnd: null,
    });
    const made = await createServer(db, OWNER, { name: 'Lore Scope Hall' });
    if (!made.ok) throw new Error(`fixture server refused: ${made.reason}`);
    serverId = made.server.id;

    await writeEntitlement(db, {
      playerId: OUTSIDER, subscriptionId: 'sub_lore_scope_other', customerId: null,
      status: 'active', currentPeriodEnd: null,
    });
    const other = await createServer(db, OUTSIDER, { name: 'Lore Scope Annexe' });
    if (!other.ok) throw new Error(`fixture server refused: ${other.reason}`);
    otherServerId = other.server.id;

    /* Owner-authored lore, through the shipped CRUD. One scope the platform
     * also has (an override) and one it does not (pure addition). */
    await upsertServerLore(db, serverId, {
      scope: SHARED_SCOPE, title: 'Hall shared', signLabel: 'Hall Warden',
      body: 'the hall re-tells it', updatedBy: 'owner@example.com',
    });
    await upsertServerLore(db, serverId, {
      scope: OWNER_ONLY_SCOPE, title: 'Hall only', signLabel: 'Hall Warden',
      body: 'nowhere else', updatedBy: 'owner@example.com',
    });
  });

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.end();
    if (previousUrl === undefined) delete process.env.POSTGRES_URL;
    else process.env.POSTGRES_URL = previousUrl;
  });

  it('a default-mode player gets the platform lore and nothing else', async () => {
    /* The contamination this phase most carefully avoids elsewhere. `null` is
     * the platform partition, and it must stay exactly what it was before any
     * owner authored anything. */
    const entries = asEntries(await getLoreEntries(null));
    expect(entries[SHARED_SCOPE].title).toBe('Platform shared');
    expect(entries[PLATFORM_ONLY_SCOPE].title).toBe('Platform only');
    expect(entries[OWNER_ONLY_SCOPE]).toBeUndefined();
  });

  it('and so does a signed-out caller, who passes no argument at all', async () => {
    const entries = asEntries(await getLoreEntries());
    expect(entries[SHARED_SCOPE].title).toBe('Platform shared');
    expect(entries[OWNER_ONLY_SCOPE]).toBeUndefined();
  });

  it('an invited player who accepts then receives that server\'s lore IN ADDITION to the platform\'s', async () => {
    /* The whole journey, through the shipped verbs: the owner offers, the
     * player accepts with the same `request` the panel now fires, the player
     * selects the server, and the scope the ROUTE would resolve is read back
     * from `currentServerId` rather than assumed. */
    const invite = await applyMembershipAction(db, {
      serverId, subjectPlayerId: MEMBER, actorPlayerId: OWNER, action: 'invite',
    });
    expect(invite).toEqual({ ok: true, state: 'invited', changed: true });

    const accept = await applyMembershipAction(db, {
      serverId, subjectPlayerId: MEMBER, actorPlayerId: MEMBER, action: 'request',
    });
    expect(accept).toEqual({ ok: true, state: 'approved', changed: true });

    await selectServer(db, MEMBER, serverId);
    const scope = await currentServerId(db, MEMBER);
    expect(scope, 'the scope the lore route resolves for this player').toBe(serverId);

    const entries = asEntries(await getLoreEntries(scope));
    // Addition: a scope the platform has never had.
    expect(entries[OWNER_ONLY_SCOPE].body).toBe('nowhere else');
    expect(entries[OWNER_ONLY_SCOPE].sign_label).toBe('Hall Warden');
    // Override: the owner's variant of a scope the platform also serves.
    expect(entries[SHARED_SCOPE].title).toBe('Hall shared');
    expect(entries[SHARED_SCOPE].body).toBe('the hall re-tells it');
    // Inheritance: a platform scope the owner did not touch is untouched.
    expect(entries[PLATFORM_ONLY_SCOPE].title).toBe('Platform only');
  });

  it('a member of a DIFFERENT server never sees the first server\'s lore', async () => {
    await applyMembershipAction(db, {
      serverId: otherServerId, subjectPlayerId: MEMBER, actorPlayerId: OUTSIDER, action: 'invite',
    });
    await applyMembershipAction(db, {
      serverId: otherServerId, subjectPlayerId: MEMBER, actorPlayerId: MEMBER, action: 'request',
    });
    await selectServer(db, MEMBER, otherServerId);
    const scope = await currentServerId(db, MEMBER);
    expect(scope).toBe(otherServerId);

    const entries = asEntries(await getLoreEntries(scope));
    expect(entries[OWNER_ONLY_SCOPE]).toBeUndefined();
    expect(entries[SHARED_SCOPE].title).toBe('Platform shared');
  });

  it('a removed member drops back to the platform lore on the very next read', async () => {
    /* `currentServerId` re-checks membership, so a stored selection is not an
     * entitlement. This is the read path's half of that promise. */
    await applyMembershipAction(db, {
      serverId, subjectPlayerId: MEMBER, actorPlayerId: OWNER, action: 'invite',
    });
    await applyMembershipAction(db, {
      serverId, subjectPlayerId: MEMBER, actorPlayerId: MEMBER, action: 'request',
    });
    await selectServer(db, MEMBER, serverId);
    expect(asEntries(await getLoreEntries(await currentServerId(db, MEMBER)))[OWNER_ONLY_SCOPE])
      .toBeTruthy();

    await applyMembershipAction(db, {
      serverId, subjectPlayerId: MEMBER, actorPlayerId: OWNER, action: 'remove',
    });
    const scope = await currentServerId(db, MEMBER);
    expect(scope).toBeNull();
    expect(asEntries(await getLoreEntries(scope))[OWNER_ONLY_SCOPE]).toBeUndefined();
  });
});
