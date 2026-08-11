/**
 * Seed 50 starter quests — 10 per world.
 *
 *   npx tsx scripts/seed-quests.ts
 *
 * Safe to re-run: uses ON CONFLICT (quest_number) DO NOTHING so existing
 * quests are never overwritten.
 *
 * Requires POSTGRES_URL in .env.local (same as the main admin app).
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
config();

import { sql } from '../lib/sql';

// ── Quest definitions ──────────────────────────────────────────────────────
//
// Complexity tiers
//   Simple      5 – 30 min    |   50 – 150 credits
//   Medium     60 – 240 min   |  200 – 600 credits
//   Complex   720 – 1440 min  |  800 – 1500 credits   (12 h – 1 day)
//   Epic      2880 – 7200 min | 2000 – 7000 credits   (2 – 5 days)
//
// pre_steps / post_steps store a JSON array of quest-line strings that must
// be complete before / after this quest.

type QuestSeed = {
  quest_number: number;
  world: string;
  quest_line: string;
  title: string;
  reward_credits: number;
  duration_minutes: number;
  pre_steps: string[] | null;
  post_steps: string[] | null;
  notes: string;
};

const QUESTS: QuestSeed[] = [
  // ── STATION (quests 1-10) ────────────────────────────────────────────────
  {
    quest_number: 1,
    world: 'station',
    quest_line: 'Signal Boost',
    title: 'Reactivate the beacon array on Deck 4',
    reward_credits: 75,
    duration_minutes: 15,
    pre_steps: null,
    post_steps: null,
    notes: 'Simple — 15 min. Locate three relay nodes and power them on.',
  },
  {
    quest_number: 2,
    world: 'station',
    quest_line: 'Cargo Manifest',
    title: 'Verify and stamp 12 incoming freight containers',
    reward_credits: 100,
    duration_minutes: 30,
    pre_steps: null,
    post_steps: null,
    notes: 'Simple — 30 min. Scan barcodes and flag damaged goods.',
  },
  {
    quest_number: 3,
    world: 'station',
    quest_line: 'Dock Worker',
    title: 'Clear the blocked freight corridor and restore flow',
    reward_credits: 250,
    duration_minutes: 90,
    pre_steps: ['Signal Boost'],
    post_steps: null,
    notes: 'Medium — 90 min. Requires Signal Boost (Q1) complete.',
  },
  {
    quest_number: 4,
    world: 'station',
    quest_line: 'Trade Route Scouting',
    title: 'Chart three new trade corridors through the outer rings',
    reward_credits: 400,
    duration_minutes: 180,
    pre_steps: null,
    post_steps: null,
    notes: 'Medium — 3 hr. Involves travel to all outer docking bays.',
  },
  {
    quest_number: 5,
    world: 'station',
    quest_line: 'Lost Traveller',
    title: 'Locate and escort the missing envoy from Bay 9',
    reward_credits: 80,
    duration_minutes: 20,
    pre_steps: null,
    post_steps: null,
    notes: 'Simple — 20 min. Easy escort task.',
  },
  {
    quest_number: 6,
    world: 'station',
    quest_line: 'Contraband Sweep',
    title: 'Search six cargo bays for smuggled aether crystals',
    reward_credits: 350,
    duration_minutes: 120,
    pre_steps: ['Dock Worker'],
    post_steps: null,
    notes: 'Medium — 2 hr. Requires Dock Worker (Q3) complete.',
  },
  {
    quest_number: 7,
    world: 'station',
    quest_line: 'Nexus Cartographer',
    title: 'Produce a verified map of all five portal connections',
    reward_credits: 1000,
    duration_minutes: 720,
    pre_steps: ['Trade Route Scouting', 'Contraband Sweep'],
    post_steps: null,
    notes: 'Complex — 12 hr. Requires Q4 and Q6. Extensive multi-zone survey.',
  },
  {
    quest_number: 8,
    world: 'station',
    quest_line: 'Station Saboteur',
    title: 'Identify and stop the faction planting power disruptors',
    reward_credits: 1500,
    duration_minutes: 1440,
    pre_steps: ['Nexus Cartographer'],
    post_steps: null,
    notes: 'Complex — 1 day. Requires Q7. Stealth and combat sections.',
  },
  {
    quest_number: 9,
    world: 'station',
    quest_line: 'The Aether Compact',
    title: 'Broker a trade agreement between three rival world factions',
    reward_credits: 2500,
    duration_minutes: 2880,
    pre_steps: ['Station Saboteur'],
    post_steps: null,
    notes: 'Epic — 2 days. Requires Q8. Multi-step diplomacy across worlds.',
  },
  {
    quest_number: 10,
    world: 'station',
    quest_line: 'Nexus Council Envoy',
    title: 'Represent the Station at the founding of the Nexus Council',
    reward_credits: 5000,
    duration_minutes: 5760,
    pre_steps: ['The Aether Compact'],
    post_steps: null,
    notes: 'Epic — 4 days. Requires Q9. Capstone quest for the Station questline.',
  },

  // ── MEDIEVAL / ALDERMOOR VALE (quests 11-20) ────────────────────────────
  {
    quest_number: 11,
    world: 'medieval',
    quest_line: 'Herb Gatherer',
    title: 'Collect nightshade, frostbloom, and ironroot from the vale',
    reward_credits: 60,
    duration_minutes: 15,
    pre_steps: null,
    post_steps: null,
    notes: 'Simple — 15 min. Gathering task, no combat.',
  },
  {
    quest_number: 12,
    world: 'medieval',
    quest_line: 'Mill Stone Delivery',
    title: 'Carry the miller\'s replacement grindstone to the north mill',
    reward_credits: 80,
    duration_minutes: 25,
    pre_steps: null,
    post_steps: null,
    notes: 'Simple — 25 min. Delivery with a heavy-load movement penalty.',
  },
  {
    quest_number: 13,
    world: 'medieval',
    quest_line: 'Bandit Camp Scout',
    title: 'Locate the bandit camp east of Thornwall without being seen',
    reward_credits: 220,
    duration_minutes: 90,
    pre_steps: null,
    post_steps: null,
    notes: 'Medium — 90 min. Stealth mission; detection causes failure.',
  },
  {
    quest_number: 14,
    world: 'medieval',
    quest_line: 'The Miller\'s Debt',
    title: 'Recover the miller\'s stolen grain and settle his debt to the guild',
    reward_credits: 300,
    duration_minutes: 120,
    pre_steps: ['Mill Stone Delivery'],
    post_steps: null,
    notes: 'Medium — 2 hr. Requires Q12. Investigation and retrieval.',
  },
  {
    quest_number: 15,
    world: 'medieval',
    quest_line: 'Village Healer',
    title: 'Prepare and administer remedies to the sick in three homesteads',
    reward_credits: 100,
    duration_minutes: 30,
    pre_steps: ['Herb Gatherer'],
    post_steps: null,
    notes: 'Simple — 30 min. Requires Q11. Crafting and NPC interaction.',
  },
  {
    quest_number: 16,
    world: 'medieval',
    quest_line: 'Knight\'s Errand',
    title: 'Escort the knight\'s sealed letter to Lord Greymere at the citadel gate',
    reward_credits: 450,
    duration_minutes: 180,
    pre_steps: ['Bandit Camp Scout'],
    post_steps: null,
    notes: 'Medium — 3 hr. Requires Q13. Long escort across bandit territory.',
  },
  {
    quest_number: 17,
    world: 'medieval',
    quest_line: 'Siege of Thornwall',
    title: 'Hold the outer wall through three waves of bandit assault',
    reward_credits: 900,
    duration_minutes: 720,
    pre_steps: ['Knight\'s Errand'],
    post_steps: null,
    notes: 'Complex — 12 hr. Requires Q16. Timed defence with reinforcement phases.',
  },
  {
    quest_number: 18,
    world: 'medieval',
    quest_line: 'The Witch\'s Bargain',
    title: 'Negotiate with the forest witch to lift the plague on the vale',
    reward_credits: 1200,
    duration_minutes: 1440,
    pre_steps: ['The Miller\'s Debt', 'Village Healer'],
    post_steps: null,
    notes: 'Complex — 1 day. Requires Q14 and Q15. Moral choices affect outcome.',
  },
  {
    quest_number: 19,
    world: 'medieval',
    quest_line: 'The Dark Tome',
    title: 'Recover and destroy the cursed tome hidden in the Thornwood ruins',
    reward_credits: 3000,
    duration_minutes: 4320,
    pre_steps: ['Siege of Thornwall', 'The Witch\'s Bargain'],
    post_steps: null,
    notes: 'Epic — 3 days. Requires Q17 and Q18. Multi-dungeon crawl with boss.',
  },
  {
    quest_number: 20,
    world: 'medieval',
    quest_line: 'Crown of Aldermoor',
    title: 'Unite the vale\'s factions and crown the new ruler of Aldermoor',
    reward_credits: 6000,
    duration_minutes: 7200,
    pre_steps: ['The Dark Tome'],
    post_steps: null,
    notes: 'Epic — 5 days. Requires Q19. Capstone; permanent world-state change.',
  },

  // ── SPORTS / MERIDIAN ATHLETIC GROUNDS (quests 21-30) ───────────────────
  {
    quest_number: 21,
    world: 'sports',
    quest_line: 'First Sprint',
    title: 'Complete the 100 m dash within the qualifying time',
    reward_credits: 50,
    duration_minutes: 10,
    pre_steps: null,
    post_steps: null,
    notes: 'Simple — 10 min. Pure speed check.',
  },
  {
    quest_number: 22,
    world: 'sports',
    quest_line: 'Warm-Up Circuit',
    title: 'Finish three laps of the outer warm-up track without stopping',
    reward_credits: 75,
    duration_minutes: 20,
    pre_steps: null,
    post_steps: null,
    notes: 'Simple — 20 min. Stamina check.',
  },
  {
    quest_number: 23,
    world: 'sports',
    quest_line: 'Team Tryout',
    title: 'Pass the multi-discipline tryout for the Meridian Blaze team',
    reward_credits: 200,
    duration_minutes: 60,
    pre_steps: ['First Sprint'],
    post_steps: null,
    notes: 'Medium — 1 hr. Requires Q21. Sprint, obstacle, and accuracy sections.',
  },
  {
    quest_number: 24,
    world: 'sports',
    quest_line: 'Track Marshal',
    title: 'Oversee and enforce the rules during the junior championship heats',
    reward_credits: 250,
    duration_minutes: 90,
    pre_steps: null,
    post_steps: null,
    notes: 'Medium — 90 min. Observation and decision-making quest.',
  },
  {
    quest_number: 25,
    world: 'sports',
    quest_line: 'Equipment Cache',
    title: 'Locate the stolen team kit hidden across the grandstand complex',
    reward_credits: 90,
    duration_minutes: 25,
    pre_steps: null,
    post_steps: null,
    notes: 'Simple — 25 min. Treasure-hunt style.',
  },
  {
    quest_number: 26,
    world: 'sports',
    quest_line: 'League Qualifier',
    title: 'Lead the Meridian Blaze through the regional league qualifier rounds',
    reward_credits: 500,
    duration_minutes: 180,
    pre_steps: ['Team Tryout', 'Track Marshal'],
    post_steps: null,
    notes: 'Medium — 3 hr. Requires Q23 and Q24. Three competitive event rounds.',
  },
  {
    quest_number: 27,
    world: 'sports',
    quest_line: 'Championship Contender',
    title: 'Win the full Meridian Athletic Championship tournament bracket',
    reward_credits: 1200,
    duration_minutes: 1440,
    pre_steps: ['League Qualifier'],
    post_steps: null,
    notes: 'Complex — 1 day. Requires Q26. Eight-match bracket, escalating difficulty.',
  },
  {
    quest_number: 28,
    world: 'sports',
    quest_line: 'Rival Team Sabotage',
    title: 'Expose and stop the rival team\'s equipment tampering scheme',
    reward_credits: 800,
    duration_minutes: 720,
    pre_steps: ['Track Marshal'],
    post_steps: null,
    notes: 'Complex — 12 hr. Requires Q24. Investigation and confrontation.',
  },
  {
    quest_number: 29,
    world: 'sports',
    quest_line: 'Grand Prix Champion',
    title: 'Take the Meridian Grand Prix title across all disciplines',
    reward_credits: 2200,
    duration_minutes: 2880,
    pre_steps: ['Championship Contender', 'Rival Team Sabotage'],
    post_steps: null,
    notes: 'Epic — 2 days. Requires Q27 and Q28. Full multi-sport event series.',
  },
  {
    quest_number: 30,
    world: 'sports',
    quest_line: 'Nexus Sports Hall of Fame',
    title: 'Complete all Meridian disciplines with gold-tier records and be inducted',
    reward_credits: 4000,
    duration_minutes: 4320,
    pre_steps: ['Grand Prix Champion'],
    post_steps: null,
    notes: 'Epic — 3 days. Requires Q29. Capstone; personal-record challenges.',
  },

  // ── CITADEL / SUNSPIRE CITADEL (quests 31-40) ───────────────────────────
  {
    quest_number: 31,
    world: 'citadel',
    quest_line: 'Wall Watch',
    title: 'Complete an unbroken two-hour guard shift on the outer battlements',
    reward_credits: 70,
    duration_minutes: 15,
    pre_steps: null,
    post_steps: null,
    notes: 'Simple — 15 min in-game. Observation and alertness challenge.',
  },
  {
    quest_number: 32,
    world: 'citadel',
    quest_line: 'Armory Inventory',
    title: 'Count, log, and report shortfalls in the citadel armoury',
    reward_credits: 90,
    duration_minutes: 30,
    pre_steps: null,
    post_steps: null,
    notes: 'Simple — 30 min. Memory and attention-to-detail task.',
  },
  {
    quest_number: 33,
    world: 'citadel',
    quest_line: 'Patrol Route',
    title: 'Run the full perimeter patrol without triggering any alarm',
    reward_credits: 200,
    duration_minutes: 90,
    pre_steps: ['Wall Watch'],
    post_steps: null,
    notes: 'Medium — 90 min. Requires Q31. Stealth and route memorisation.',
  },
  {
    quest_number: 34,
    world: 'citadel',
    quest_line: 'Desert Scouts',
    title: 'Survey the desert approaches and mark enemy troop positions',
    reward_credits: 320,
    duration_minutes: 120,
    pre_steps: null,
    post_steps: null,
    notes: 'Medium — 2 hr. Exposed scouting, risk of detection.',
  },
  {
    quest_number: 35,
    world: 'citadel',
    quest_line: 'Fallen Gate',
    title: 'Repair the damaged main gate before the night guard change',
    reward_credits: 75,
    duration_minutes: 20,
    pre_steps: null,
    post_steps: null,
    notes: 'Simple — 20 min. Timed repair puzzle.',
  },
  {
    quest_number: 36,
    world: 'citadel',
    quest_line: 'Citadel Defender',
    title: 'Repel the desert raiders\' probe attack on the east terraces',
    reward_credits: 600,
    duration_minutes: 240,
    pre_steps: ['Patrol Route', 'Desert Scouts'],
    post_steps: null,
    notes: 'Medium — 4 hr. Requires Q33 and Q34. Wave defence sequence.',
  },
  {
    quest_number: 37,
    world: 'citadel',
    quest_line: 'The Siege Plan',
    title: 'Steal the enemy siege plans from their forward camp and return safely',
    reward_credits: 1400,
    duration_minutes: 1440,
    pre_steps: ['Citadel Defender'],
    post_steps: null,
    notes: 'Complex — 1 day. Requires Q36. Deep infiltration behind enemy lines.',
  },
  {
    quest_number: 38,
    world: 'citadel',
    quest_line: 'Assassin in the Keep',
    title: 'Find and neutralise the assassin hiding inside the citadel walls',
    reward_credits: 1000,
    duration_minutes: 720,
    pre_steps: ['Fallen Gate'],
    post_steps: null,
    notes: 'Complex — 12 hr. Requires Q35. Investigation, deduction, and combat.',
  },
  {
    quest_number: 39,
    world: 'citadel',
    quest_line: 'The Desert War',
    title: 'Lead the combined defence and turn the full enemy offensive',
    reward_credits: 3500,
    duration_minutes: 4320,
    pre_steps: ['The Siege Plan', 'Assassin in the Keep'],
    post_steps: null,
    notes: 'Epic — 3 days. Requires Q37 and Q38. Large-scale battle campaign.',
  },
  {
    quest_number: 40,
    world: 'citadel',
    quest_line: 'Warlord of Sunspire',
    title: 'Claim the title of Warlord and establish the Sunspire Pact',
    reward_credits: 7000,
    duration_minutes: 7200,
    pre_steps: ['The Desert War'],
    post_steps: null,
    notes: 'Epic — 5 days. Requires Q39. Capstone; player earns citadel leadership title.',
  },

  // ── RACE / VELLUM RIDGE CIRCUIT (quests 41-50) ──────────────────────────
  {
    quest_number: 41,
    world: 'race',
    quest_line: 'First Lap',
    title: 'Complete one clean lap of the Vellum Ridge Circuit',
    reward_credits: 60,
    duration_minutes: 10,
    pre_steps: null,
    post_steps: null,
    notes: 'Simple — 10 min. No time pressure; familiarisation lap.',
  },
  {
    quest_number: 42,
    world: 'race',
    quest_line: 'Pit Crew Basics',
    title: 'Perform a full tyre-and-fuel stop in under the target time',
    reward_credits: 80,
    duration_minutes: 20,
    pre_steps: null,
    post_steps: null,
    notes: 'Simple — 20 min. Timed button-sequence puzzle.',
  },
  {
    quest_number: 43,
    world: 'race',
    quest_line: 'Time Trial',
    title: 'Post a qualifying time fast enough for the regional grid',
    reward_credits: 200,
    duration_minutes: 60,
    pre_steps: ['First Lap'],
    post_steps: null,
    notes: 'Medium — 1 hr. Requires Q41. Three timed attempts to beat the target.',
  },
  {
    quest_number: 44,
    world: 'race',
    quest_line: 'Mechanic\'s Special',
    title: 'Diagnose and repair the car\'s hidden handling fault before the heat',
    reward_credits: 280,
    duration_minutes: 90,
    pre_steps: ['Pit Crew Basics'],
    post_steps: null,
    notes: 'Medium — 90 min. Requires Q42. Logic puzzle + test laps.',
  },
  {
    quest_number: 45,
    world: 'race',
    quest_line: 'Street Circuit Scout',
    title: 'Walk and memorise the city block section of the circuit',
    reward_credits: 85,
    duration_minutes: 25,
    pre_steps: null,
    post_steps: null,
    notes: 'Simple — 25 min. Exploration and waypoint marking.',
  },
  {
    quest_number: 46,
    world: 'race',
    quest_line: 'Regional Heat',
    title: 'Win your regional heat against five AI rivals',
    reward_credits: 450,
    duration_minutes: 180,
    pre_steps: ['Time Trial', 'Mechanic\'s Special'],
    post_steps: null,
    notes: 'Medium — 3 hr. Requires Q43 and Q44. Full race with rival AI scaling.',
  },
  {
    quest_number: 47,
    world: 'race',
    quest_line: 'Sabotaged Start',
    title: 'Discover who tampered with your car and clear your name before the race',
    reward_credits: 1100,
    duration_minutes: 1440,
    pre_steps: ['Street Circuit Scout'],
    post_steps: null,
    notes: 'Complex — 1 day. Requires Q45. Investigation, alibi checks, confrontation.',
  },
  {
    quest_number: 48,
    world: 'race',
    quest_line: 'Championship Round',
    title: 'Finish on the podium in the Vellum Ridge Championship round',
    reward_credits: 900,
    duration_minutes: 720,
    pre_steps: ['Regional Heat'],
    post_steps: null,
    notes: 'Complex — 12 hr. Requires Q46. Eight-rival race with full damage model.',
  },
  {
    quest_number: 49,
    world: 'race',
    quest_line: 'The Vellum 500',
    title: 'Endure and win the 500-lap Vellum Ridge endurance race',
    reward_credits: 2500,
    duration_minutes: 2880,
    pre_steps: ['Sabotaged Start', 'Championship Round'],
    post_steps: null,
    notes: 'Epic — 2 days. Requires Q47 and Q48. Endurance with pit strategy.',
  },
  {
    quest_number: 50,
    world: 'race',
    quest_line: 'Nexus Racing Legend',
    title: 'Break the all-time circuit record and earn the Nexus Racing Legend title',
    reward_credits: 5000,
    duration_minutes: 5760,
    pre_steps: ['The Vellum 500'],
    post_steps: null,
    notes: 'Epic — 4 days. Requires Q49. Capstone; personal-record across all layouts.',
  },
];

// ── Seed runner ────────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== Aether Nexus Quest Seeder ===\n');
  console.log(`Seeding ${QUESTS.length} quests…\n`);

  // Ensure the quests table exists.
  await sql`
    CREATE TABLE IF NOT EXISTS quests (
      id               TEXT PRIMARY KEY,
      quest_number     INTEGER UNIQUE NOT NULL,
      world            TEXT NOT NULL,
      quest_line       TEXT NOT NULL,
      title            TEXT NOT NULL,
      reward_credits   INTEGER NOT NULL DEFAULT 0,
      duration_minutes INTEGER,
      pre_steps        TEXT,
      post_steps       TEXT,
      notes            TEXT,
      is_active        BOOLEAN NOT NULL DEFAULT TRUE,
      updated_by       TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  let inserted = 0;
  let skipped = 0;

  for (const q of QUESTS) {
    const id = crypto.randomUUID();
    const preJson  = q.pre_steps  ? JSON.stringify(q.pre_steps)  : null;
    const postJson = q.post_steps ? JSON.stringify(q.post_steps) : null;

    const result = await sql`
      INSERT INTO quests (
        id, quest_number, world, quest_line, title,
        reward_credits, duration_minutes, pre_steps, post_steps, notes,
        is_active, updated_by
      )
      VALUES (
        ${id}, ${q.quest_number}, ${q.world}, ${q.quest_line}, ${q.title},
        ${q.reward_credits}, ${q.duration_minutes}, ${preJson}, ${postJson},
        ${q.notes}, true, 'seed-script'
      )
      ON CONFLICT (quest_number) DO NOTHING
    `;

    // postgres driver returns rowCount on INSERT
    const count = (result as unknown as { rowCount?: number }).rowCount ?? 0;
    if (count > 0) {
      console.log(`  ✓ Q${String(q.quest_number).padStart(2, '0')} [${q.world.padEnd(8)}] ${q.quest_line}`);
      inserted++;
    } else {
      console.log(`  – Q${String(q.quest_number).padStart(2, '0')} already exists, skipped`);
      skipped++;
    }
  }

  console.log(`\nDone. Inserted: ${inserted}  Skipped: ${skipped}\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
