import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

/**
 * A QUEST REWARD MUST LEAVE A ROW, AND THE CHAIN MUST STILL ADD UP.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DEFECT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 2 made `credit_events` the only place `players.credit_balance` moves,
 * and paired the balance with a ledger row on every payout path it touched.
 * `completeQuestEngagement` was not one of them: it flipped the engagement and
 * added `quests.reward_credits` to the balance in one CTE, with no
 * `INSERT INTO credit_events` in the function or in its only caller.
 *
 * Measured live by the signed-in survey (§6 F2), one ledger event, then a quest
 * completion, then another ledger event:
 *
 *   event_key                kind       delta  balance_after
 *   migration:d58bae0d-…     migration    +90             90
 *   survey-kill-1            kill          +5             95
 *   survey-kill-2            kill          +5            250   <- +155 on a +5
 *
 *   SELECT SUM(delta) FROM credit_events -> 100
 *   SELECT credit_balance FROM players   -> 250
 *
 * `balance_after` is underivable from a player's first quest completion onward,
 * which is every player. And `ensureOpeningBalance` absorbs the first one
 * silently — so on a BRAND-NEW ACCOUNT, the account a smoke test uses, the
 * ledger looks perfect.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT EACH HALF OF THIS FILE PROVES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The scrape (always runs, no database) pins the ATOMICITY: the engagement flip
 * and the credit are inside one `BEGIN`. The repair that suggests itself —
 * follow the CTE with an `applyCreditEvent` call — cannot be atomic, because
 * that function opens its own `BEGIN` and Postgres has no nested transactions;
 * a crash between the two leaves a quest completed and unpaid.
 *
 * The integration half (skips without `POSTGRES_TEST_URL`) pins the
 * DERIVABILITY, which is the property the survey measured and the only one that
 * would have caught this: reproduce its exact sequence and assert the chain adds
 * up. Neither half subsumes the other, and the scrape exists because 128 of this
 * repository's tests skip without a database and a gate that vanishes where it
 * runs is how the last incident shipped.
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

const read = (f: string) => readFileSync(join(here, f), 'utf8').replace(/\r\n/g, '\n');

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

/* Comments stripped before matching. Written after a sibling gate in this
 * branch failed on the FIXED tree because the comment explaining the fix quoted
 * the code it replaced. */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/* ---------------------------------------------------------------------- */
/* The scrape: one transaction, and the ledger owns the balance            */
/* ---------------------------------------------------------------------- */

describe('the quest flip and the quest credit are one transaction', () => {
  const fn = codeOnly(body(read('playerDb.ts'), 'completeQuestEngagement'));

  it('pays the platform reward through the ledger, not with its own UPDATE', () => {
    expect(fn.includes('creditInTransaction'),
      'the platform payout does not go through the ledger — that is the defect verbatim'
    ).toBe(true);
    expect(fn.includes('SET credit_balance = credit_balance +'),
      'the CTE that moved the balance with no credit_events row is back'
    ).toBe(false);
  });

  it('opens the transaction BEFORE the flip and closes it after the credit', () => {
    /* Anchored on the BEGIN, not on the first flip in the function: the
     * server-scoped branch above has its own `SET status = 'completed'` and pays
     * through `earnServerCredits`, so a search from position zero finds THAT
     * one and this assertion would be measuring the wrong branch. */
    const begin = fn.indexOf("'BEGIN'");
    expect(begin, 'no BEGIN — the flip and the credit are separate commits').toBeGreaterThan(-1);
    const flip = fn.indexOf("SET status = 'completed'", begin);
    const credit = fn.indexOf('creditInTransaction', flip);
    const commit = fn.indexOf("'COMMIT'", credit);
    expect(flip, 'no engagement flip inside the transaction').toBeGreaterThan(begin);
    expect(credit, 'no credit inside the transaction').toBeGreaterThan(flip);
    expect(commit, 'nothing commits after the credit').toBeGreaterThan(credit);
  });

  it('does not call the self-transacting applyCreditEvent, which cannot nest', () => {
    /* THE PLAUSIBLE WRONG FIX. `applyCreditEvent` issues its own BEGIN/COMMIT;
     * calling it inside this function's transaction would COMMIT the outer one
     * early, and calling it after would leave a window where the quest is
     * completed and unpaid. The ledger's own docblock records the same argument
     * for why `debitInTransaction` exists. */
    expect(/\bapplyCreditEvent\s*\(/.test(fn),
      'completeQuestEngagement calls applyCreditEvent, which opens its own transaction'
    ).toBe(false);
  });

  it('opens the balance before it moves it', () => {
    /* Without this the ledger's first row for an existing player states a
     * balance it never accounted for, and SUM(delta) disagrees with the balance
     * for the life of the account — the same masking that hid this defect. */
    const open = fn.indexOf('ensureOpeningBalance');
    expect(open, 'no ensureOpeningBalance before the payout').toBeGreaterThan(-1);
    expect(open).toBeLessThan(fn.indexOf('creditInTransaction'));
  });

  it('keys the ledger row off the engagement, so a replay cannot pay twice', () => {
    expect(/eventKey:\s*`quest:\$\{engagementId\}`/.test(fn),
      'the ledger key is not the engagement id — UNIQUE (player_id, event_key) is '
      + 'what makes a replayed completion free'
    ).toBe(true);
  });
});

/* ---------------------------------------------------------------------- */
/* The consequence, against a real Postgres                                */
/* ---------------------------------------------------------------------- */

/* ...0011, and CHECKED against the register rather than guessed.
 *
 * This file first took ...0008, which `serverCredits.test.ts` already owns, and
 * `marketplaceBuyContract.test.ts` took ...0009, which `serverChat.test.ts`
 * owns — whose four tests then failed in the full run and passed alone, because
 * this suite's `afterAll` DELETEs its player and the FK cascaded their chat away.
 * Vitest runs these files in parallel against one shared database, and the
 * register is the grep:
 *
 *   grep -rhoE "00000000-0000-4000-8000-[0-9a-f]{12}" lib/*.test.ts | sort -u
 *
 * ...0001 creditLedger, ...0002 marketplacePurchase, ...0003 creditReport,
 * ...0004 progressLedger, ...0005 leaderboard, ...0006 customServers,
 * ...0007 serverContent, ...0008 serverCredits, ...0009 serverChat,
 * ...0010 premium, ...0011 THIS FILE, ...0012 marketplaceBuyContract. */
const PLAYER = '00000000-0000-4000-8000-000000000011';
const QUEST = 'quest-ledger-test-quest';
const QUEST_NUMBER = 987_654;
const REWARD = 150;

suite('a quest reward leaves a derivable ledger row (integration)', () => {
  let db: Client;
  let completeQuestEngagement: typeof import('./playerDb')['completeQuestEngagement'];
  let acceptQuestEngagement: typeof import('./playerDb')['acceptQuestEngagement'];
  let applyReportedEvent: typeof import('./creditLedger')['applyReportedEvent'];
  let ensureOpeningBalance: typeof import('./creditLedger')['ensureOpeningBalance'];

  const balance = async (): Promise<number> => {
    const r = await db.query('SELECT credit_balance FROM players WHERE id = $1', [PLAYER]);
    return Number(r.rows[0]?.credit_balance ?? -1);
  };
  const ledger = async () => {
    const r = await db.query<{ kind: string; delta: number; balance_after: number; event_key: string }>(
      `SELECT event_key, kind, delta, balance_after FROM credit_events
        WHERE player_id = $1 ORDER BY created_at, id`,
      [PLAYER]
    );
    return r.rows.map((x) => ({ ...x, delta: Number(x.delta), balance_after: Number(x.balance_after) }));
  };

  beforeAll(async () => {
    process.env.POSTGRES_URL = URL_!;
    ({ completeQuestEngagement, acceptQuestEngagement } = await import('./playerDb'));
    ({ applyReportedEvent, ensureOpeningBalance } = await import('./creditLedger'));

    db = new Client({ connectionString: URL_!, ssl: { rejectUnauthorized: false } });
    await db.connect();
    const which = await db.query('SELECT current_database() AS db');
    if (which.rows[0].db !== 'aether_test') {
      throw new Error(`refusing to run against "${which.rows[0].db}" — expected aether_test`);
    }

    /* Additive, never CREATE-and-assume: sibling suites in this shared database
     * create `players` and `quests` with their own narrower column sets and
     * whichever file runs first wins. `serverContent.test.ts` records the same
     * trap after being bitten by it. */
    await db.query(`
      CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY, credit_balance INTEGER NOT NULL DEFAULT 0,
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
  });

  afterAll(async () => {
    if (!db) return;
    await db.query('DELETE FROM player_quest_engagements WHERE player_id = $1', [PLAYER]).catch(() => {});
    await db.query('DELETE FROM credit_events WHERE player_id = $1', [PLAYER]).catch(() => {});
    await db.query('DELETE FROM players WHERE id = $1', [PLAYER]).catch(() => {});
    await db.query('DELETE FROM quests WHERE id = $1', [QUEST]).catch(() => {});
    await db.end();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM player_quest_engagements WHERE player_id = $1', [PLAYER]).catch(() => {});
    await db.query('DELETE FROM credit_events WHERE player_id = $1', [PLAYER]).catch(() => {});
    await db.query(
      `INSERT INTO players (id, credit_balance) VALUES ($1, 90)
       ON CONFLICT (id) DO UPDATE SET credit_balance = 90`,
      [PLAYER]
    );
    await db.query(
      `INSERT INTO quests (id, quest_number, world, quest_line, title, reward_credits,
                           is_active, repeatable, server_id)
       VALUES ($1, $2, 'station', 'ledger', 'The one that pays', $3, TRUE, TRUE, NULL)
       ON CONFLICT (id) DO UPDATE
         SET reward_credits = EXCLUDED.reward_credits, is_active = TRUE, repeatable = TRUE,
             server_id = NULL`,
      [QUEST, QUEST_NUMBER, REWARD]
    );
  });

  /** Every `balance_after` derivable from the row before it plus its own delta. */
  const assertChainAddsUp = async () => {
    const rows = await ledger();
    expect(rows.length, 'the ledger is empty — nothing to derive').toBeGreaterThan(0);
    let running = 0;
    for (const [i, row] of rows.entries()) {
      running += row.delta;
      expect(row.balance_after, `row ${i} (${row.event_key}) is not derivable`).toBe(running);
    }
    expect(running, 'SUM(delta) does not equal the balance').toBe(await balance());
  };

  const completeOnce = async () => {
    const accepted = await acceptQuestEngagement(PLAYER, QUEST, null);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error('accept refused');
    return { engagementId: accepted.engagementId, done: await completeQuestEngagement(accepted.engagementId, PLAYER) };
  };

  it('writes a quest row for the reward, and moves the balance by exactly it', async () => {
    await ensureOpeningBalance(db, PLAYER);
    const { done } = await completeOnce();
    expect(done.creditsAwarded).toBe(REWARD);
    expect(await balance()).toBe(90 + REWARD);
    expect(done.creditBalance).toBe(90 + REWARD);

    const rows = await ledger();
    const quest = rows.filter((r) => r.kind === 'quest');
    expect(quest.length, 'no credit_events row for the quest reward').toBe(1);
    expect(quest[0].delta).toBe(REWARD);
  });

  it("reproduces the survey's exact sequence, and the chain adds up", async () => {
    /* migration(+90) -> kill(+5) -> QUEST -> kill(+5). The survey read
     * 95 -> 250 across the last two rows and SUM(delta)=100 against a balance of
     * 250. Every row here must be derivable from the one before it. */
    await ensureOpeningBalance(db, PLAYER);
    await applyReportedEvent(db, PLAYER, { key: 'ql-kill-1', reason: 'kill', delta: 5 });
    await completeOnce();
    await applyReportedEvent(db, PLAYER, { key: 'ql-kill-2', reason: 'kill', delta: 5 });

    const rows = await ledger();
    expect(rows.map((r) => r.kind)).toEqual(['migration', 'kill', 'quest', 'kill']);
    expect(rows.map((r) => r.delta)).toEqual([90, 5, REWARD, 5]);
    expect(rows.map((r) => r.balance_after)).toEqual([90, 95, 95 + REWARD, 100 + REWARD]);
    await assertChainAddsUp();
  });

  it('holds on an account with NO opening row yet — the case that was masked', async () => {
    /* `ensureOpeningBalance` fires on a player's FIRST /api/game/credits call and
     * absorbs whatever the balance is by then. A quest completed BEFORE that
     * would have been swallowed into the opening row and looked fine. The quest
     * path now opens the balance itself. */
    expect(await ledger()).toEqual([]);
    await completeOnce();
    const rows = await ledger();
    expect(rows.map((r) => r.kind)).toEqual(['migration', 'quest']);
    expect(rows[0].delta).toBe(90);
    await assertChainAddsUp();
  });

  it('a replayed completion pays once and writes one row', async () => {
    await ensureOpeningBalance(db, PLAYER);
    const { engagementId } = await completeOnce();
    const again = await completeQuestEngagement(engagementId, PLAYER);
    expect(again.alreadyCompleted).toBe(true);
    expect(again.creditsAwarded).toBe(0);
    expect(await balance()).toBe(90 + REWARD);
    expect((await ledger()).filter((r) => r.kind === 'quest').length).toBe(1);
    await assertChainAddsUp();
  });

  it('a repeatable quest pays every time, so idempotency did not eat the feature', async () => {
    /* The two guards must AGREE. `status = 'in_progress'` stops a replay;
     * `UNIQUE (player_id, event_key)` stops a duplicate row. They only coexist
     * because a repeatable quest gets a FRESH engagement id per acceptance — if
     * the row were reused, the second completion would be refused as a duplicate
     * and pay nothing. */
    await ensureOpeningBalance(db, PLAYER);
    const first = await completeOnce();
    const second = await completeOnce();
    expect(first.engagementId).not.toBe(second.engagementId);
    expect(second.done.creditsAwarded).toBe(REWARD);
    expect(await balance()).toBe(90 + REWARD * 2);
    expect((await ledger()).filter((r) => r.kind === 'quest').length).toBe(2);
    await assertChainAddsUp();
  });

  it('does not stop paying at the dead 120/hour quest cap', async () => {
    /* `CAPS.quest` is unreachable today (`REASON_KIND.quest` is 'refused'), so
     * routing quests through the ledger would have ACTIVATED a rate limit nobody
     * asked for — on the one payout the client cannot inflate, whose only
     * possible effect is to mark a quest completed and pay zero for it. */
    await ensureOpeningBalance(db, PLAYER);
    await db.query(
      `INSERT INTO credit_events (player_id, event_key, kind, detail, delta, balance_after)
       SELECT $1, 'ql-cap-' || g, 'quest', 'filler', 0, 90 FROM generate_series(1, 200) g`,
      [PLAYER]
    );
    const { done } = await completeOnce();
    expect(done.creditsAwarded, 'the quest cap fired and silently paid nothing').toBe(REWARD);
    expect(await balance()).toBe(90 + REWARD);
  });
});
