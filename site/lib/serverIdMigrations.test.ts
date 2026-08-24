import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * DOES EVERY MODULE THAT READS A COLUMN ALSO ENSURE IT EXISTS?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THIS FILE EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 7 added `server_id` to `quests`, `marketplace_items` and `lore_entries`
 * additively, and every shipped read path was updated to state its scope —
 * `WHERE server_id IS NULL` is the platform partition. That part was done well.
 *
 * The `ALTER TABLE ... ADD COLUMN IF NOT EXISTS server_id` was NOT put with the
 * reads. It went wherever the column was introduced:
 *
 *   quests            -> only in `leaderboard.ts`     (quests route never calls it)
 *   marketplace_items -> only in `customServers.ts`   (catalogue never calls it)
 *   lore_entries      -> in `lore.ts` itself          (the read that needs it)
 *
 * In production, the first two answered `column "server_id" does not exist`
 * (Postgres 42703) and `/api/game/quests` and `/api/marketplace/items` returned
 * **HTTP 500 to every caller, signed in or out** — 78 quests and 398 steps
 * unreachable — for as long as nothing happened to have called the leaderboard
 * or the custom-server schema first. `/api/lore` was the only Postgres-backed
 * route still answering 200, and it is the only one that ensured its own column.
 *
 * **`lore.ts` had already written the argument down**, verbatim:
 *
 *   "this function creates the table it reads and must not depend on another
 *    module having run first. Without it, a database where the custom-server
 *    schema has not been ensured answers the SELECT below with 'column
 *    server_id does not exist'."
 *
 * One module wrote the defence and the note explaining why. Two modules with the
 * same dependency did not get either. So this is not a test for a bug that was
 * fixed — it is a test for the rule that was already known and unevenly applied.
 *
 * Deliberately a source scrape rather than a database test: the failure is that
 * a module does not ensure something, and the only place that is visible without
 * a live Postgres is the source. A test needing a DB would SKIP in CI, and a
 * skipped test is what let this reach production in the first place — Phase 7's
 * own gates reported "273 passed / 128 skipped".
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** Tables that gained `server_id` in Phase 7, and how a read of them looks. */
/** One space between every token, so a scrape cannot be defeated by a line break. */
const flat = (s: string) => s.replace(new RegExp(String.fromCharCode(92) + "s+", "g"), " ").toUpperCase();

/** Tables that gained `server_id` in Phase 7. */
const GUARDED = ['quests', 'marketplace_items', 'lore_entries'] as const;

/** Does this module issue SQL against the table at all? */
const touches = (flatSrc: string, table: string) =>
  flatSrc.includes(` FROM ${table.toUpperCase()} `) ||
  flatSrc.includes(` FROM ${table.toUpperCase()}(`) ||
  flatSrc.includes(` UPDATE ${table.toUpperCase()} `) ||
  flatSrc.includes(` INTO ${table.toUpperCase()} `) ||
  flatSrc.includes(` INTO ${table.toUpperCase()}(`);

const source = (f: string) => readFileSync(join(HERE, f), 'utf8').replace(/\r\n/g, '\n');

const modules = readdirSync(HERE)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.startsWith('fake'));

describe('an additive column is ensured by the module that reads it', () => {
  it('finds the lib modules at all, so an empty scan cannot pass silently', () => {
    expect(modules.length).toBeGreaterThan(10);
  });

  for (const table of GUARDED) {
    const needle = `ALTER TABLE ${table.toUpperCase()} ADD COLUMN IF NOT EXISTS SERVER_ID`;

    for (const file of modules) {
      const src = source(file);
      if (!src.includes(`server_id`)) continue;
      const flatSrc = flat(src);
      if (!touches(flatSrc, table)) continue;

      it(`${file} ensures server_id on ${table}, because it reads it`, () => {
        expect(flatSrc.includes(needle),
          `${file} issues SQL against ${table} and references server_id, but never runs ` +
          `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS server_id. That is exactly how ` +
          `/api/game/quests and /api/marketplace/items returned 500 to every caller in ` +
          `production: the ensure lived in a module the read path never calls. Put the ` +
          `ensure with the read, as lore.ts does.`
        ).toBe(true);
      });
    }
  }
});
