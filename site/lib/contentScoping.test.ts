import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flat } from './fakeDb';

/**
 * 7a's other half: "every existing read path scoped so a player with no server
 * sees exactly today's global content".
 *
 * ── Why this is a source test and not a behaviour test ────────────────────
 *
 * The three read paths that matter — the marketplace catalogue, the lore
 * entries and the quest list — each open their own connection through a
 * module-private `query()` helper. There is no seam to inject a fake into
 * without restructuring three shipped modules, and restructuring a live
 * marketplace path to make a test easier is the wrong trade.
 *
 * What CAN be checked, on every machine and with no database, is the thing that
 * actually goes wrong: a read path that forgot its scope. So each statement is
 * read out of the source and asserted to carry one. That is a narrow claim, and
 * it is precisely the claim — the queries are static strings, so a statement
 * that contains the clause in the file contains it at runtime.
 *
 * ── A shared constant was tried here and removed ──────────────────────────
 *
 * The obvious tidiness is a `PLATFORM_SCOPE_CLAUSE` constant interpolated at
 * each site, so "is it scoped?" is one spelling rather than several. It does not
 * survive its own purpose: a clause behind `${aVariable}` is a clause this test
 * cannot read, and a test that cannot read the clause is back to trusting that
 * somebody remembered. So the clause is written out literally in every query,
 * this file is what enforces the one spelling, and the constant was deleted
 * rather than left as a module nothing calls.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** CRLF-normalised: `core.autocrlf` is true, and a scrape has been bitten here. */
function source(...parts: string[]): string {
  return readFileSync(join(here, '..', ...parts), 'utf8').replace(/\r\n/g, '\n');
}

/**
 * Every SELECT in a file that reads one table.
 *
 * ── The rule these are held to, and its one carve-out ─────────────────────
 *
 * A read over a scoped table must either FILTER by scope, or RETURN `server_id`
 * so that its caller has to decide. Both are safe; what is not safe is a read
 * that neither filters nor reports, because such a read hands a row to a caller
 * with no way to tell whose it is.
 *
 * The carve-out is not a loophole, it is a necessity: `getQuestById` cannot
 * filter, because `acceptQuestEngagement` has to read an owner's quest in order
 * to work out that this player may not accept it. A read that refused to return
 * it could not make that decision at all.
 */
function unscopedReadsOver(src: string, table: string): string[] {
  const out: string[] = [];
  for (const chunk of src.split('`')) {
    if (!chunk.includes(table)) continue;
    if (!/\bSELECT\b/i.test(chunk)) continue;
    const sql = flat(chunk);
    const filters = /server_id IS NULL|server_id = \$|server_id = COALESCE\(\$\d+/.test(sql);
    const reports = /SELECT[^;]*?\bserver_id\b[^;]*?\bFROM\b/i.test(sql);
    if (!filters && !reports) out.push(sql);
  }
  return out;
}

describe('every shipped read path states its scope', () => {
  it('the public marketplace catalogue', () => {
    const src = source('lib', 'marketplaceDb.ts');
    expect(src).toContain('FROM marketplace_items');
    expect(unscopedReadsOver(src, 'FROM marketplace_items')).toEqual([]);
  });

  it('the lore entries', () => {
    const src = source('lib', 'lore.ts');
    expect(src).toContain('FROM lore_entries');
    expect(unscopedReadsOver(src, 'FROM lore_entries')).toEqual([]);
  });

  it('the quest list a world serves', () => {
    const src = source('lib', 'playerDb.ts');
    expect(src).toContain('FROM quests');
    expect(unscopedReadsOver(src, 'FROM quests')).toEqual([]);
  });

  it('and the default is the platform, never "whatever was passed"', () => {
    /* The failure this guards is a signature like `listActiveQuestsForWorld(world,
     * serverId)` where an omitted argument means "no filter". An omitted
     * argument must mean the PLATFORM, so a caller that has not heard of custom
     * servers keeps seeing exactly today's content. */
    const src = source('lib', 'playerDb.ts');
    expect(src).toMatch(/serverId: string \| null = null/);
    const market = source('lib', 'marketplaceDb.ts');
    expect(market).toMatch(/serverId\?: string \| null/);
  });
});

describe('accepting a quest carries its provenance onto the engagement', () => {
  it('stamps the engagement from the QUEST row, never from the caller', () => {
    /* The engagement stamp is what decides which board a completion lands on.
     * Reading it from `quests.server_id` — a row the server owns — rather than
     * from a request body is what makes it unforgeable: a client that wanted its
     * custom-server completion to count globally would have to change a row it
     * cannot write. */
    const src = source('lib', 'playerDb.ts');
    const insert = src
      .split('`')
      .find((c) => c.includes('INSERT INTO player_quest_engagements') && c.includes('VALUES'));
    expect(insert, 'the accept INSERT').toBeTruthy();
    expect(flat(insert!)).toContain('server_id');
    expect(src).toContain('quest.server_id');
  });
});
