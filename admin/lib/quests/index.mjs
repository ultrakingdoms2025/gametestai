/**
 * The one import surface for authored quest content.
 *
 * The six sibling modules are the ONLY source of seed quests. `admin/lib/db.ts`
 * imports `ALL_QUESTS` from here and writes it to the `quests` table; nothing
 * else may hold a second copy. The previous arrangement — a 100-line array
 * literal inside `db.ts` plus a near-identical duplicate in
 * `admin/scripts/seed-quests.ts` — is exactly how fifty quests drifted into
 * being 0-for-50 completable without anyone noticing (QUEST-AUDIT.md).
 *
 * Ordering here is world-by-world, not by quest number, so a diff of this file
 * reads as "which worlds are wired". `quest_number` is the DB key and is unique
 * across all six modules; the seeder does not care what order it sees them in.
 *
 *   station   n 1-10 (story), 101-110 (education), 201-203 (global)  = 23
 *   medieval  n 11-20                                                = 10
 *   sports    n 21-30                                                = 10
 *   citadel   n 31-40, 131-135                                       = 15
 *   race      n 41-50                                                = 10
 *   dock      n 51-60                                                = 10
 *                                                                     ── 78
 *
 * Every object is `{ n, world, line, title, credits, dur, pre, notes, steps }`
 * and every step is `{ order, label, type, target, count, world }`. `db.ts`
 * declares that shape as a TypeScript type and assigns this array to it, so a
 * module that drifts from it fails `tsc --noEmit` rather than failing silently
 * at seed time.
 */

import { STATION_QUESTS }  from './station.mjs';
import { MEDIEVAL_QUESTS } from './medieval.mjs';
import { SPORTS_QUESTS }   from './sports.mjs';
import { CITADEL_QUESTS }  from './citadel.mjs';
import { RACE_QUESTS }     from './race.mjs';
import { DOCK_QUESTS }     from './dock.mjs';

export { STATION_QUESTS, MEDIEVAL_QUESTS, SPORTS_QUESTS, CITADEL_QUESTS, RACE_QUESTS, DOCK_QUESTS };

/** Every authored quest, in world order. 73 quests. */
export const ALL_QUESTS = [
  ...STATION_QUESTS,
  ...MEDIEVAL_QUESTS,
  ...SPORTS_QUESTS,
  ...CITADEL_QUESTS,
  ...RACE_QUESTS,
  ...DOCK_QUESTS,
];

export default ALL_QUESTS;
