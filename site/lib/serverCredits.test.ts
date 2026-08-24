import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { makeFakeDb, flat } from './fakeDb';
import {
  SERVER_CREDIT_KINDS,
  serverCreditKind,
  earnServerCredits,
  spendServerCredits,
  serverBalance,
  serverBalancesFor,
} from './serverCredits';
import { ensureCustomServerSchema } from './customServers';

/**
 * Server credits (7f), and the one property that makes them safe:
 *
 *   > "server-scoped credits that cannot feed the global balance."
 *
 * Not "must not" — CANNOT. The tables are separate, no column joins them, and
 * nothing in `serverCredits.ts` writes `players.credit_balance` or inserts into
 * `credit_events`. A leak would not be a forgotten filter; it would be a
 * function nobody has written yet.
 *
 * The first two tests below are the load-bearing ones and neither needs a
 * database: one reads the module's whole source, one watches every statement it
 * actually issues. That combination is deliberate — the source scrape catches a
 * line no test happens to reach, and the recording client catches a write
 * smuggled in through a helper the scrape's regex does not recognise.
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

const SERVER = 'server-credits-test-a';
const OTHER = 'server-credits-test-b';

/* ---------------------------------------------------------------------- */
/* The separation, without a database                                      */
/* ---------------------------------------------------------------------- */

describe('server credits cannot reach the global balance', () => {
  it('never names the global money tables anywhere in its source', () => {
    /* `core.autocrlf` is true here, so normalise before matching: a scrape has
     * been green in a worktree and red in the checkout in this repository. */
    const src = readFileSync(join(here, 'serverCredits.ts'), 'utf8').replace(/\r\n/g, '\n');
    // Strip block comments: the header explains what it does NOT do, and naming
    // the forbidden tables in prose is the point of the header.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    /* Word-bounded, so `server_credit_events` and `server_credit_balances` — the
     * tables this module is SUPPOSED to write — do not trip their own guard.
     * `_` is a word character, so `\bcredit_events\b` cannot match inside
     * `server_credit_events`, which is exactly the discrimination wanted. */
    expect(code).not.toMatch(/\bcredit_events\b/);
    expect(code).not.toMatch(/\bcredit_balance\b/);
    expect(code).not.toMatch(/\bplayers\b/);
    /* And it does not reach the global ledger through the module that owns it. */
    expect(code).not.toMatch(/from ['"]\.\/creditLedger['"]/);
  });

  it('issues no statement against players or credit_events, even on a full earn', async () => {
    const db = makeFakeDb((sql) => {
      if (sql.includes('INSERT INTO server_credit_events')) return [{ id: 'e1' }];
      if (sql.includes('FROM server_credit_balances')) return [{ balance: 0 }];
      if (sql.includes('INSERT INTO server_credit_balances')) return [{ balance: 25 }];
      return undefined;
    });
    await earnServerCredits(db, SERVER, 'p1', { kind: 'quest', amount: 25, eventKey: 'k1' });
    await spendServerCredits(db, SERVER, 'p1', { cost: 5, eventKey: 'k2' });

    for (const q of db.log) {
      expect(flat(q.sql), q.sql).not.toMatch(/\bplayers\b/);
      expect(flat(q.sql), q.sql).not.toMatch(/\bcredit_events\b/);
    }
    expect(db.log.length).toBeGreaterThan(0);
  });

  it('scopes every statement it writes to one server', async () => {
    const db = makeFakeDb((sql) => {
      if (sql.includes('INSERT INTO server_credit_events')) return [{ id: 'e1' }];
      if (sql.includes('server_credit_balances')) return [{ balance: 10 }];
      return undefined;
    });
    await earnServerCredits(db, SERVER, 'p1', { kind: 'quest', amount: 10, eventKey: 'k1' });
    for (const q of db.log) {
      if (!/server_credit_/.test(q.sql)) continue;
      expect(flat(q.sql), q.sql).toMatch(/server_id/);
      expect(q.params, q.sql).toContain(SERVER);
    }
  });

  it('refuses a kind it does not recognise rather than inventing a price', async () => {
    const db = makeFakeDb();
    const out = await earnServerCredits(db, SERVER, 'p1', {
      /* Outside the table. The parameter is typed `... | string` on purpose:
       * this value arrives from an HTTP body, where the type system is not
       * present, so the refusal has to be a runtime lookup and the test has to
       * be able to send what a request can send. */
      kind: 'cheat',
      amount: 1_000_000,
      eventKey: 'k',
    });
    expect(out.applied).toBe(false);
    expect(out.reason).toBe('unknown_kind');
    expect(db.matching('INSERT INTO server_credit_events')).toHaveLength(0);
  });

  it('bounds a single earn, so one event cannot mint a fortune', async () => {
    const db = makeFakeDb();
    const out = await earnServerCredits(db, SERVER, 'p1', {
      kind: 'quest',
      amount: 10_000_000,
      eventKey: 'k',
    });
    expect(out.applied).toBe(false);
    expect(out.reason).toBe('too_large');
  });

  it('publishes a ceiling for every kind it accepts', () => {
    for (const id of Object.keys(SERVER_CREDIT_KINDS)) {
      expect(serverCreditKind(id)?.perEventMax, id).toBeGreaterThan(0);
    }
  });
});

/* ---------------------------------------------------------------------- */
/* Against a real Postgres                                                 */
/* ---------------------------------------------------------------------- */

/** ...0008. See serverContent.test.ts for the register of claimed ids. */
const OWNER = '00000000-0000-4000-8000-000000000008';
const PLAYER = '00000000-0000-4000-8000-000000080001';
const PLAYERS = [OWNER, PLAYER];

suite('server credits (integration)', () => {
  let db: Client;

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
    for (const id of PLAYERS) {
      await db.query(
        `INSERT INTO players (id, credit_balance) VALUES ($1, 500) ON CONFLICT (id) DO NOTHING`,
        [id]
      );
    }
    await ensureCustomServerSchema(db);
    for (const [id, slug] of [[SERVER, 'server-credits-a'], [OTHER, 'server-credits-b']]) {
      await db.query(
        `INSERT INTO custom_servers (id, owner_player_id, name, slug)
         VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
        [id, OWNER, slug, slug]
      );
    }
  });

  const cleanup = async () => {
    await db.query(`DELETE FROM server_credit_events WHERE server_id = ANY($1::text[])`, [
      [SERVER, OTHER],
    ]);
    await db.query(`DELETE FROM server_credit_balances WHERE server_id = ANY($1::text[])`, [
      [SERVER, OTHER],
    ]);
  };

  beforeEach(cleanup);

  afterAll(async () => {
    if (!db) return;
    await cleanup();
    await db.query(`DELETE FROM custom_servers WHERE id = ANY($1::text[])`, [[SERVER, OTHER]]);
    await db.end();
  });

  it('earns into the server ledger and leaves the global balance untouched', async () => {
    const before = await db.query('SELECT credit_balance FROM players WHERE id = $1', [PLAYER]);
    const out = await earnServerCredits(db, SERVER, PLAYER, {
      kind: 'quest', amount: 10_000, eventKey: 'e1',
    });
    expect(out.applied).toBe(false); // 10,000 is above the per-event ceiling
    const paid = await earnServerCredits(db, SERVER, PLAYER, {
      kind: 'quest', amount: 250, eventKey: 'e2',
    });
    expect(paid.applied).toBe(true);
    expect(paid.balance).toBe(250);
    expect(await serverBalance(db, SERVER, PLAYER)).toBe(250);

    const after = await db.query('SELECT credit_balance FROM players WHERE id = $1', [PLAYER]);
    expect(Number(after.rows[0].credit_balance)).toBe(Number(before.rows[0].credit_balance));
  });

  it('pays an event key once, however many times it arrives', async () => {
    await earnServerCredits(db, SERVER, PLAYER, { kind: 'quest', amount: 100, eventKey: 'dup' });
    const again = await earnServerCredits(db, SERVER, PLAYER, {
      kind: 'quest', amount: 100, eventKey: 'dup',
    });
    expect(again.applied).toBe(false);
    expect(again.reason).toBe('duplicate');
    expect(await serverBalance(db, SERVER, PLAYER)).toBe(100);
  });

  it('keeps a player\'s two servers apart, so one cannot fund the other', async () => {
    await earnServerCredits(db, SERVER, PLAYER, { kind: 'quest', amount: 100, eventKey: 'a' });
    /* The SAME event key in the other server is a different event, and its
     * balance starts at zero regardless of what the first holds. */
    await earnServerCredits(db, OTHER, PLAYER, { kind: 'quest', amount: 7, eventKey: 'a' });
    expect(await serverBalance(db, SERVER, PLAYER)).toBe(100);
    expect(await serverBalance(db, OTHER, PLAYER)).toBe(7);

    const spent = await spendServerCredits(db, OTHER, PLAYER, { cost: 50, eventKey: 's' });
    expect(spent.applied).toBe(false);
    expect(spent.reason).toBe('insufficient');
    expect(await serverBalance(db, SERVER, PLAYER)).toBe(100);
  });

  it('refuses to overdraw', async () => {
    await earnServerCredits(db, SERVER, PLAYER, { kind: 'quest', amount: 30, eventKey: 'a' });
    const out = await spendServerCredits(db, SERVER, PLAYER, { cost: 31, eventKey: 's' });
    expect(out.applied).toBe(false);
    expect(out.reason).toBe('insufficient');
    expect(await serverBalance(db, SERVER, PLAYER)).toBe(30);
  });

  it('reports every server balance a player holds, in one read', async () => {
    await earnServerCredits(db, SERVER, PLAYER, { kind: 'quest', amount: 11, eventKey: 'a' });
    await earnServerCredits(db, OTHER, PLAYER, { kind: 'quest', amount: 22, eventKey: 'b' });
    const all = await serverBalancesFor(db, PLAYER);
    expect(all[SERVER]).toBe(11);
    expect(all[OTHER]).toBe(22);
  });
});
