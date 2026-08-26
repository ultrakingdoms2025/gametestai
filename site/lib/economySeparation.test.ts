import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

/**
 * THE TWO ECONOMIES MUST NOT MEET, AND A SUSPENSION MUST STICK.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 7 separated platform credits from server credits STRUCTURALLY, and the
 * separation holds everywhere it was built: `serverCredits.ts` never names
 * `players` or `credit_balance`, and the guard was proved by ablation.
 *
 * **Quest rewards never went through that module.** `completeQuestEngagement`
 * took `(engagementId, playerId)` and never read `server_id` at all, while the
 * engagement row it updates is correctly stamped with one — so it added an
 * owner-authored reward straight to `players.credit_balance`.
 *
 * Driven live against a test database: an owner authored a quest at
 * `rewardCredits: 1000000000, repeatable: true`, and two request pairs later
 * `players.credit_balance` read **2,000,510,348** while `server_credit_balances`
 * stayed empty. **An invited member with no subscription did the same.** The
 * cost of unlimited platform credits for everyone an owner invites was one
 * subscription.
 *
 * And it could not be contained, because `updateServer` wrote `status`
 * unconditionally and coerced an omitted status to `'active'`: the route's 403
 * on a non-admin setting `status` is correct, but a non-admin owner sending
 * `{"name": "..."}` never asks, and un-suspended their own server.
 *
 * These are source scrapes for the same reason `serverIdMigrations.test.ts` is:
 * without `POSTGRES_TEST_URL` the integration suites SKIP — `site/ npm test`
 * reports 294 passed / **128 skipped** — and every integration test covering
 * this blast radius is in that 128. A gate that vanishes in CI is how the last
 * one of these reached production.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) => readFileSync(join(HERE, f), 'utf8').replace(/\r\n/g, '\n');

const playerDb = read('playerDb.ts');
const customServers = read('customServers.ts');

/** The body of one exported function, by brace matching. */
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

describe('a server-scoped quest cannot pay platform credits', () => {
  const fn = body(playerDb, 'completeQuestEngagement');

  it('reads server_id, because it cannot branch on what it never selected', () => {
    expect(fn.includes('server_id'),
      'completeQuestEngagement does not mention server_id. The engagement row carries one; ' +
      'ignoring it is what let an owner-authored reward reach players.credit_balance.'
    ).toBe(true);
  });

  /* CHANGED DELIBERATELY. Both this assertion and the last one in this block
   * used to look for the literal `SET credit_balance = credit_balance +`, which
   * was the platform payout's own CTE. That statement is gone: the platform
   * reward now moves through `creditInTransaction`, because moving the balance
   * with no `credit_events` row was a second defect on this same path — the
   * ledger read 95 -> 250 on a +5 event, and `SUM(delta)` was 100 against a
   * balance of 250.
   *
   * The property both tests were pinning is unchanged and is still pinned; only
   * the marker for "the platform payout" moved. The new marker is strictly
   * better as a marker: it is a function call this module has to import, not a
   * fragment of SQL that a reformat could break. */
  it('branches on it before touching the platform balance', () => {
    const branchAt = fn.indexOf('engagement.server_id');
    const payAt = fn.indexOf('creditInTransaction');
    expect(branchAt, 'no branch on the engagement server_id').toBeGreaterThan(-1);
    expect(payAt, 'the platform payout call moved — re-read this test').toBeGreaterThan(-1);
    expect(branchAt,
      'the server_id branch must come BEFORE the platform payout, or the payout happens anyway'
    ).toBeLessThan(payAt);
  });

  it('pays a server quest through the server ledger, at its own capped kind', () => {
    expect(fn.includes('earnServerCredits'),
      'a completed server quest must pay through earnServerCredits, which is idempotent on ' +
      'eventKey and capped per event by SERVER_CREDIT_KINDS.quest'
    ).toBe(true);
    expect(/kind:\s*'quest'/.test(fn), "the payout must use the 'quest' kind, whose cap exists for this").toBe(true);
  });

  it('still pays a platform quest, so the fix did not just delete the feature', () => {
    expect(fn.includes('creditInTransaction'),
      'the platform payout is gone entirely — a quest with no server must still pay'
    ).toBe(true);
    expect(/kind:\s*'quest'/.test(fn),
      "the platform payout must use the 'quest' kind, so the ledger row says what it was"
    ).toBe(true);
  });

  it('and does not move the balance itself any more — only the ledger may', () => {
    /* The new half of this defect, and the reason the marker above moved. The
     * ledger's docblock says it is "the only thing allowed to move
     * players.credit_balance"; this function was the exception, and the cost was
     * a `balance_after` column nobody could derive. */
    expect(fn.includes('SET credit_balance = credit_balance +'),
      'completeQuestEngagement is moving credit_balance directly again — that is the '
      + 'payout with no credit_events row, verbatim'
    ).toBe(false);
    expect(/UPDATE\s+players\b/i.test(fn),
      'completeQuestEngagement is issuing its own UPDATE against players'
    ).toBe(false);
  });
});

describe('a suspended server stays suspended', () => {
  const fn = body(customServers, 'updateServer');

  it('treats an absent status as unchanged, like name and description', () => {
    expect(fn.includes('patch.status === undefined'),
      'updateServer coerces an omitted status. It read ' +
      "`patch.status === 'suspended' ? 'suspended' : 'active'`, so PATCH {\"name\":\"…\"} " +
      're-activated a suspended server — and suspension is how an abusive server is contained.'
    ).toBe(true);
    expect(/patch\.status === undefined[\s\S]{0,80}current\.status/.test(fn),
      'an absent status must fall back to the CURRENT status'
    ).toBe(true);
  });
});

/* ======================================================================== */
/* serverEconomyInvariant: THE FLIPPED RULE, HELD IN BOTH DIRECTIONS        */
/* ======================================================================== */

/**
 * The owner's explicit instruction reversed the original separation's shape:
 * the two economies still never MIX, but which one moves is now decided by
 * WHERE THE PLAYER IS STANDING.
 *
 *   - ON a server: every reported earn, every reported spend and every
 *     marketplace purchase moves the SERVER ledger. The platform balance must
 *     not move — not by a credit, not by a debit, not by a row.
 *   - OFF a server: the platform ledger moves exactly as it always has, and
 *     the server ledgers must not move.
 *
 * This is the invariant that once caught a 2-billion-credit mint, given the
 * same teeth in its new orientation. The integration half below is
 * ablation-grade on purpose: it does not merely compare balances (a leak that
 * nets to zero would pass a balance check), it asserts ROW-LEVEL absence —
 * the scoped event key exists in `server_credit_events` and in `credit_events`
 * NOT AT ALL, and the unscoped key the mirror image. A leak in either
 * direction is a row in the wrong table, and a row is what these queries see.
 *
 * The source half runs on every machine, database or not, because the
 * integration half skips without POSTGRES_TEST_URL and a gate that vanishes
 * in CI is how the last defect of this shape reached production.
 */

describe('serverEconomyInvariant: the ledger switch exists in the source', () => {
  const marketplaceDb = read('marketplaceDb.ts');
  const creditsRoute = readFileSync(
    join(HERE, '..', 'app', 'api', 'game', 'credits', 'route.ts'), 'utf8'
  ).replace(/\r\n/g, '\n');

  it('a scoped purchase debits the server ledger, in one shared purchase path', () => {
    const fn = body(marketplaceDb, 'purchaseMarketplaceItem');
    expect(fn.includes('spendServerCreditsInTransaction'),
      'purchaseMarketplaceItem has no server-ledger debit seam').toBe(true);
    expect(/scope\s*\n?\s*\?\s*await spendServerCreditsInTransaction/.test(fn),
      'the debit must branch on the resolved scope').toBe(true);
    expect(fn.includes('debitInTransaction'),
      'the platform debit must survive for the unscoped path').toBe(true);
    /* And the replay check consults the ledger the money moved on. */
    expect(fn.includes('serverLedgerPriorEvent')).toBe(true);
  });

  it('the credits route applies scoped batches through the server-ledger mirror', () => {
    expect(creditsRoute.includes('applyReportedServerEvent'),
      'POST /api/game/credits never reaches the server ledger').toBe(true);
    expect(/scope\.serverId\s*\n?\s*\?/.test(creditsRoute),
      'the per-event ledger choice must branch on the resolved scope').toBe(true);
    expect(creditsRoute.includes('applyReportedEvent'),
      'the platform path must survive for unscoped play').toBe(true);
  });

  it('the platform ledger still cannot name the server tables', () => {
    /* The OFF-direction, structurally: `creditLedger.ts` moving a server
     * ledger would need code that does not exist. Same scrape shape as
     * serverCredits.test.ts, mirrored. */
    const creditLedger = read('creditLedger.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(creditLedger).not.toMatch(/\bserver_credit_events\b/);
    expect(creditLedger).not.toMatch(/\bserver_credit_balances\b/);
    expect(creditLedger).not.toMatch(/from ['"]\.\/serverCredits['"]/);
  });
});

/* ---- the invariant against a real database ----------------------------- */

function testUrl(): string | null {
  if (process.env.POSTGRES_TEST_URL) return process.env.POSTGRES_TEST_URL;
  const envFile = join(HERE, '..', '.env.test.local');
  if (!existsSync(envFile)) return null;
  const line = readFileSync(envFile, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith('POSTGRES_TEST_URL='));
  if (!line) return null;
  return line.slice('POSTGRES_TEST_URL='.length).trim().replace(/^["']|["']$/g, '');
}

const URL_ = testUrl();
const suite = URL_ ? describe : describe.skip;

/* Claimed in the cross-suite id register (see serverContent.test.ts). */
const ESEP_PLAYER = '00000000-0000-4000-8000-0000000d0001';
const ESEP_ITEM = '00000000-0000-4000-8000-0000000d0011';

suite('serverEconomyInvariant: both directions, ablation-grade (integration)', () => {
  let db: Client;
  let serverId: string;

  const platformBalance = async () => Number(
    (await db.query('SELECT credit_balance FROM players WHERE id = $1', [ESEP_PLAYER]))
      .rows[0]?.credit_balance ?? -1
  );
  const serverBal = async () => Number(
    (await db.query(
      'SELECT balance FROM server_credit_balances WHERE server_id = $1 AND player_id = $2',
      [serverId, ESEP_PLAYER]
    )).rows[0]?.balance ?? 0
  );
  /** How many rows a ledger holds for ONE event key — the ablation probe. */
  const platformRowsFor = async (key: string) => Number(
    (await db.query(
      'SELECT COUNT(*)::int AS n FROM credit_events WHERE player_id = $1 AND event_key = $2',
      [ESEP_PLAYER, key]
    )).rows[0].n
  );
  const serverRowsFor = async (key: string) => Number(
    (await db.query(
      'SELECT COUNT(*)::int AS n FROM server_credit_events WHERE player_id = $1 AND event_key = $2',
      [ESEP_PLAYER, key]
    )).rows[0].n
  );

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
    await db.query(
      `INSERT INTO players (id, handle, credit_balance) VALUES ($1, 'esep-player', 500)
       ON CONFLICT (id) DO UPDATE SET credit_balance = 500`,
      [ESEP_PLAYER]
    );
    const { ensureCustomServerSchema, createServer, selectServer } = await import('./customServers');
    const { ensureCreditSchema } = await import('./creditLedger');
    const { writeEntitlement } = await import('./premium');
    await ensureCustomServerSchema(db);
    await ensureCreditSchema(db);
    // A clean slate for this player, so the row-count probes read exactly
    // what THIS run wrote.
    await db.query('DELETE FROM player_server_selection WHERE player_id = $1', [ESEP_PLAYER]);
    await db.query('DELETE FROM custom_servers WHERE owner_player_id = $1', [ESEP_PLAYER]);
    await db.query('DELETE FROM server_entitlements WHERE player_id = $1', [ESEP_PLAYER]);
    await db.query('DELETE FROM credit_events WHERE player_id = $1', [ESEP_PLAYER]);
    await db.query(`
      CREATE TABLE IF NOT EXISTS purchases (
        id TEXT PRIMARY KEY, player_id TEXT REFERENCES players(id),
        stripe_intent_enc TEXT, amount_cents INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'usd', type TEXT NOT NULL,
        credits_amount INTEGER, status TEXT NOT NULL DEFAULT 'completed',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await db.query('DELETE FROM purchases WHERE player_id = $1', [ESEP_PLAYER]);
    await db.query('ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS server_id TEXT').catch(() => {});
    await db.query(
      `INSERT INTO marketplace_items
         (id, source_key, name, description, category, game_action, action_config,
          quantity, cost_buy, cost_sell, world_name, is_active, server_id)
       VALUES ($1, 'esep-plat-item', 'Esep Invariant Lance', 'platform', 'tools', 'ship_part',
               '{}'::jsonb, NULL, 60, 6, 'station', TRUE, NULL)
       ON CONFLICT (id) DO NOTHING`,
      [ESEP_ITEM]
    );

    await writeEntitlement(db, {
      playerId: ESEP_PLAYER, subscriptionId: 'sub_esep_invariant', customerId: null,
      status: 'active', currentPeriodEnd: null,
    });
    const made = await createServer(db, ESEP_PLAYER, { name: 'Esep Invariant Hall' });
    if (!made.ok) throw new Error(`fixture server refused: ${made.reason}`);
    serverId = made.server.id;
    await selectServer(db, ESEP_PLAYER, serverId);
  }, 120_000);

  afterAll(async () => {
    if (!db) return;
    await db.query('DELETE FROM player_server_selection WHERE player_id = $1', [ESEP_PLAYER]).catch(() => {});
    await db.query('DELETE FROM custom_servers WHERE owner_player_id = $1', [ESEP_PLAYER]).catch(() => {});
    await db.query('DELETE FROM server_entitlements WHERE player_id = $1', [ESEP_PLAYER]).catch(() => {});
    await db.query('DELETE FROM credit_events WHERE player_id = $1', [ESEP_PLAYER]).catch(() => {});
    await db.query('DELETE FROM purchases WHERE player_id = $1', [ESEP_PLAYER]).catch(() => {});
    await db.query('DELETE FROM marketplace_items WHERE id = $1::uuid', [ESEP_ITEM]).catch(() => {});
    await db.end();
  });

  it('ON a server: earns, spends and purchases move ONLY the server ledger', { timeout: 60_000 }, async () => {
    const { applyReportedServerEvent } = await import('./serverCreditReport');
    const { purchaseMarketplaceItem } = await import('./marketplaceDb');
    const platBefore = await platformBalance();

    /* A declared earn, a server-priced earn, two refusals, and a catalogue
     * purchase of a PLATFORM item — the scoped vocabulary end to end. */
    const earn = await applyReportedServerEvent(db, serverId, ESEP_PLAYER, {
      key: 'esep-scoped-ore', reason: 'ore', delta: 100,
    });
    expect(earn.applied).toBe(true);
    const kill = await applyReportedServerEvent(db, serverId, ESEP_PLAYER, {
      key: 'esep-scoped-kill', reason: 'kill', delta: 9_000,
    });
    expect(kill.applied).toBe(true);
    expect(kill.delta, 'a kill is server-priced at 5, scoped or not').toBe(5);
    const noItem = await applyReportedServerEvent(db, serverId, ESEP_PLAYER, {
      key: 'esep-scoped-noitem', reason: 'market', delta: -20,
    });
    // A marketplace debit with no item is refused scoped exactly as unscoped.
    expect(noItem.reason).toBe('unpriced_purchase');
    const cheat = await applyReportedServerEvent(db, serverId, ESEP_PLAYER, {
      key: 'esep-scoped-cheat', reason: 'cheat', delta: 10,
    });
    expect(cheat.reason).toBe('refused');

    const buy = await purchaseMarketplaceItem(db, ESEP_PLAYER, {
      itemId: ESEP_ITEM, eventKey: 'esep-scoped-buy',
      serverId, contentMode: 'extend',
    });
    expect(buy.applied).toBe(true);
    expect(buy.cost).toBe(60);
    /* The purchase reports the SERVER balance — the number the client shows. */
    expect(buy.balance).toBe(45);

    /* The server ledger moved: 100 + 5 - 60. */
    expect(await serverBal()).toBe(45);
    /* THE INVARIANT, ablation-grade: the platform balance did not move, and
     * the platform ledger holds NOT ONE ROW for any scoped key. */
    expect(await platformBalance()).toBe(platBefore);
    for (const key of ['esep-scoped-ore', 'esep-scoped-kill', 'esep-scoped-buy']) {
      expect(await platformRowsFor(key), `${key} leaked into credit_events`).toBe(0);
    }
    expect(await serverRowsFor('esep-scoped-ore')).toBe(1);
    expect(await serverRowsFor('esep-scoped-buy')).toBe(1);
  });

  it('OFF a server: the platform moves and the server ledgers hold still', { timeout: 60_000 }, async () => {
    const { applyReportedEvent } = await import('./creditLedger');
    const { purchaseMarketplaceItem } = await import('./marketplaceDb');
    const { selectServer } = await import('./customServers');
    await selectServer(db, ESEP_PLAYER, null); // leave the server
    const serverBefore = await serverBal();
    const platBefore = await platformBalance();

    const earn = await applyReportedEvent(db, ESEP_PLAYER, {
      key: 'esep-unscoped-ore', reason: 'ore', delta: 80,
    });
    expect(earn.applied).toBe(true);
    const buy = await purchaseMarketplaceItem(db, ESEP_PLAYER, {
      itemId: ESEP_ITEM, eventKey: 'esep-unscoped-buy',
    });
    expect(buy.applied).toBe(true);
    expect(buy.cost).toBe(60);

    expect(await platformBalance()).toBe(platBefore + 80 - 60);
    /* The mirror half: the server ledger did not move and holds NOT ONE ROW
     * for any unscoped key. */
    expect(await serverBal()).toBe(serverBefore);
    for (const key of ['esep-unscoped-ore', 'esep-unscoped-buy']) {
      expect(await serverRowsFor(key), `${key} leaked into server_credit_events`).toBe(0);
    }
    expect(await platformRowsFor('esep-unscoped-ore')).toBe(1);
    expect(await platformRowsFor('esep-unscoped-buy')).toBe(1);
  });
});
