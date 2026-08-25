import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
