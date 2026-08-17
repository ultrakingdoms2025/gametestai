/**
 * Seed the `quests` table from the authored content under `admin/lib/quests/`.
 *
 *   npx tsx scripts/seed-quests.ts
 *
 * Safe to re-run. It calls exactly the same code the admin dashboard runs on
 * every load of the quests page, so there is one seed path and one definition
 * of what "seeded" means.
 *
 * ── Why this file no longer holds any quest data ─────────────────────────────
 *
 * It used to carry its own copy of all fifty quests — the same titles and
 * rewards as `lib/db.ts`, but with no `steps` at all and an
 * `ON CONFLICT (quest_number) DO NOTHING`. Two consequences, both bad:
 *
 *   1. On a fresh database, whichever of the two ran first won. If it was this
 *      script, every quest landed with `steps = NULL` and DO NOTHING then kept
 *      `lib/db.ts` from ever filling them in — fifty quests with no objectives.
 *   2. It was the second of the two files that a grep for a quest target hit,
 *      and keeping two copies of the content in step was nobody's job. The audit
 *      found the copies had already diverged (QUEST-AUDIT.md).
 *
 * Content belongs in `lib/quests/*.mjs`, which is where the engine vocabulary is
 * documented and where `scripts/tests/quest-content.test.mjs` looks.
 *
 * Requires POSTGRES_URL in .env.local (same as the main admin app).
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
config();

import { seedQuests } from '../lib/db';

async function main() {
  console.log('\n=== Aether Nexus Quest Seeder ===\n');

  const { quests, steps } = await seedQuests();

  console.log(`  ✓ ${quests} quests / ${steps} steps upserted from lib/quests/`);
  console.log('\nAuthored content fields (title, reward, duration, prerequisites,');
  console.log('steps, notes) were refreshed. The operator-owned flags `is_active`');
  console.log('and `repeatable` were left exactly as they were.\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
