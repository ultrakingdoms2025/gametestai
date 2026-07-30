/**
 * Database layer — Vercel Postgres via @vercel/postgres.
 *
 * All sensitive columns (email, Stripe IDs) are encrypted at rest with
 * AES-256-GCM (see lib/encrypt.ts). Email is also stored as a SHA-256 hash
 * so lookups are possible without decrypting first.
 *
 * The audit_log table uses an HMAC chain: each row's entry_hash is a
 * HMAC over (seq | actor | action | resource | prev_entry_hash). Any
 * attempt to edit, insert, or delete a row will break the chain from
 * that point forward, which is detected by verifyAuditChain().
 */

import { sql } from './sql';
import { randomUUID } from 'node:crypto';
import { encrypt, decrypt, encryptMaybe, decryptMaybe } from './encrypt';
import { sha256, sign, auditHash } from './hmac';

const DEFAULT_LORE_ROWS = [
  {
    scope: 'overall',
    title: 'Aether Nexus Chronicle',
    sign_label: 'Lorekeeper',
    body:
      'The Aether Nexus is a chain of linked worlds held together by portals, trade, memory, and habit. ' +
      'Aether Station is the hub, the place where travellers are catalogued before they step through. ' +
      'Each world carries its own culture, but the portals make them part of one larger story.',
  },
  {
    scope: 'station',
    title: 'Station Lore',
    sign_label: 'Lorekeeper',
    body:
      'Aether Station is the orbital hub of the Nexus: a ring of concourses, plazas, gantries, and glass, ' +
      'built to receive travellers from every other world. It is the archive, the checkpoint, and the place where the next journey begins.',
  },
  {
    scope: 'medieval',
    title: 'Medieval Lore',
    sign_label: 'Lorekeeper',
    body:
      'Aldermoor Vale is an old-world valley of timber roofs, market squares, castle walls, and pilgrim roads. ' +
      'Its people still measure life by harvests, tolls, and the stories told beside the gatehouse fire.',
  },
  {
    scope: 'sports',
    title: 'Sports Lore',
    sign_label: 'Lorekeeper',
    body:
      'The Meridian Athletic Grounds are a bright training complex of courts, tracks, bowls, snow runs, and grandstands. ' +
      'Competition is culture here; every surface is built for practice, spectacle, and the pride of a clean run.',
  },
  {
    scope: 'citadel',
    title: 'Citadel Lore',
    sign_label: 'Lorekeeper',
    body:
      'Sunspire Citadel crowns a cliff above the desert, a vertical town of terraces, rope bridges, towers, and guarded gates. ' +
      'Its people value height, discipline, and the hard-earned safety of the walls that keep the sky at bay.',
  },
  {
    scope: 'race',
    title: 'Race Lore',
    sign_label: 'Lorekeeper',
    body:
      'Vellum Ridge Circuit is the Nexus at full speed: a mountain course that climbs, dives, and threads the city blocks before snapping back to the line. ' +
      'It is where drivers prove nerve, machine, and memory all at once.',
  },
] as const;

// ── Schema initialisation ──────────────────────────────────────────────────

export async function initSchema() {
  await sql`
    CREATE TABLE IF NOT EXISTS admin_users (
      id            TEXT PRIMARY KEY,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      totp_secret   TEXT NOT NULL,   -- encrypted with ENCRYPTION_KEY
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login    TIMESTAMPTZ
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS players (
      id                  TEXT PRIMARY KEY,
      full_name           TEXT,
      handle              TEXT UNIQUE,
      email_hash          TEXT UNIQUE,              -- sha256(lower(email))
      email_enc           TEXT,                     -- AES-256-GCM
      stripe_customer_enc TEXT,                     -- AES-256-GCM
      country             TEXT,
      password_hash       TEXT,
      auth_provider       TEXT NOT NULL DEFAULT 'password',
      oauth_provider      TEXT,
      oauth_key_enc       TEXT,
      status              TEXT NOT NULL DEFAULT 'active',
      access_granted_at   TIMESTAMPTZ,
      access_revoked_at   TIMESTAMPTZ,
      credit_balance      INTEGER NOT NULL DEFAULT 0,
      notes               TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    ALTER TABLE players
      ADD COLUMN IF NOT EXISTS full_name TEXT,
      ADD COLUMN IF NOT EXISTS handle TEXT,
      ADD COLUMN IF NOT EXISTS country TEXT,
      ADD COLUMN IF NOT EXISTS password_hash TEXT,
      ADD COLUMN IF NOT EXISTS auth_provider TEXT NOT NULL DEFAULT 'password',
      ADD COLUMN IF NOT EXISTS oauth_provider TEXT,
      ADD COLUMN IF NOT EXISTS oauth_key_enc TEXT,
      ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
  `;

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS players_handle_unique_idx
    ON players(handle)
    WHERE handle IS NOT NULL
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS quests (
      id             TEXT PRIMARY KEY,
      quest_number   INTEGER UNIQUE NOT NULL,
      world          TEXT NOT NULL,
      quest_line     TEXT NOT NULL,
      title          TEXT NOT NULL,
      reward_credits INTEGER NOT NULL DEFAULT 0,
      duration_minutes INTEGER,
      pre_steps      TEXT,
      post_steps     TEXT,
      notes          TEXT,
      is_active      BOOLEAN NOT NULL DEFAULT TRUE,
      updated_by     TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    ALTER TABLE quests
      ADD COLUMN IF NOT EXISTS duration_minutes INTEGER
  `;

  await sql`
      CREATE TABLE IF NOT EXISTS player_quest_engagements (
        id                 TEXT PRIMARY KEY,
        player_id          TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        quest_id           TEXT REFERENCES quests(id) ON DELETE SET NULL,
        quest_number       INTEGER NOT NULL,
        quest_title        TEXT NOT NULL,
        world              TEXT NOT NULL,
        duration_minutes   INTEGER,
        status             TEXT NOT NULL DEFAULT 'in_progress',
        percent_complete   INTEGER NOT NULL DEFAULT 0,
        credits_rewarded   INTEGER NOT NULL DEFAULT 0,
        failure_reason     TEXT,
        accepted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at       TIMESTAMPTZ,
        failed_at          TIMESTAMPTZ,
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
  `;

  await sql`
      CREATE INDEX IF NOT EXISTS player_quest_engagements_player_idx
      ON player_quest_engagements(player_id, updated_at DESC)
  `;

  await sql`
      CREATE TABLE IF NOT EXISTS purchases (
        id                    TEXT PRIMARY KEY,
        player_id             TEXT REFERENCES players(id),
        stripe_intent_enc     TEXT,                   -- AES-256-GCM
      amount_cents          INTEGER NOT NULL,
      currency              TEXT    NOT NULL DEFAULT 'usd',
      type                  TEXT    NOT NULL,        -- 'access' | 'credits'
      credits_amount        INTEGER,
      status                TEXT    NOT NULL DEFAULT 'completed',
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS audit_log (
      id          TEXT   PRIMARY KEY,
      seq         BIGSERIAL UNIQUE NOT NULL,
      prev_hash   TEXT   NOT NULL,
      entry_hash  TEXT   NOT NULL,
      actor       TEXT   NOT NULL,   -- admin username or 'system'
      action      TEXT   NOT NULL,   -- e.g. 'player.revoke_access'
      resource    TEXT   NOT NULL,   -- e.g. 'player:<id>'
      detail      TEXT,              -- JSON string, may be encrypted
      ip_hash     TEXT,              -- sha256(ip)
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS config (
      key         TEXT PRIMARY KEY,
      value_enc   TEXT NOT NULL,   -- AES-256-GCM
      description TEXT,
      updated_by  TEXT,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
  CREATE TABLE IF NOT EXISTS lore_entries (
    scope       TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    sign_label  TEXT NOT NULL DEFAULT 'Lorekeeper',
    body        TEXT NOT NULL,
    updated_by  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
  `;

  for (const entry of DEFAULT_LORE_ROWS) {
  await sql`
    INSERT INTO lore_entries (scope, title, sign_label, body)
    VALUES (${entry.scope}, ${entry.title}, ${entry.sign_label}, ${entry.body})
    ON CONFLICT (scope) DO NOTHING
  `;
  }
}

// ── Admin users ────────────────────────────────────────────────────────────

export async function findAdminByUsername(username: string) {
  const { rows } = await sql`
    SELECT id, username, password_hash, totp_secret
    FROM   admin_users
    WHERE  username = ${username}
    LIMIT  1
  `;
  return rows[0] ?? null;
}

export async function createAdminUser(
  username:     string,
  passwordHash: string,
  totpSecretEnc: string,
): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO admin_users (id, username, password_hash, totp_secret)
    VALUES (${id}, ${username}, ${passwordHash}, ${totpSecretEnc})
  `;
  return id;
}

export async function touchAdminLogin(id: string) {
  await sql`UPDATE admin_users SET last_login = NOW() WHERE id = ${id}`;
}

export async function getAdminById(id: string) {
  const { rows } = await sql`
    SELECT id, username, password_hash, totp_secret, created_at, last_login
    FROM admin_users
    WHERE id = ${id}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function updateAdminPassword(id: string, passwordHash: string) {
  await sql`
    UPDATE admin_users
    SET password_hash = ${passwordHash}
    WHERE id = ${id}
  `;
}

export async function updateAdminTotpSecret(id: string, totpSecretEnc: string) {
  await sql`
    UPDATE admin_users
    SET totp_secret = ${totpSecretEnc}
    WHERE id = ${id}
  `;
}

// ── Players ────────────────────────────────────────────────────────────────

const PAGE_SIZE = 50;

export async function listPlayers(page = 0, search?: string) {
  const offset = page * PAGE_SIZE;
  if (search) {
    const h = sha256(search.trim().toLowerCase()); // search by email hash
    const { rows } = await sql`
      SELECT id, full_name, handle, email_hash, country, status,
             access_granted_at, access_revoked_at, credit_balance,
             notes, created_at, updated_at
      FROM   players
      WHERE  email_hash = ${h}
      ORDER  BY created_at DESC
      LIMIT  ${PAGE_SIZE} OFFSET ${offset}
    `;
    return rows;
  }
  const { rows } = await sql`
    SELECT id, full_name, handle, email_hash, country, status,
           access_granted_at, access_revoked_at, credit_balance,
           notes, created_at, updated_at
    FROM   players
    ORDER  BY created_at DESC
    LIMIT  ${PAGE_SIZE} OFFSET ${offset}
  `;
  return rows;
}

export async function getPlayerById(id: string) {
  const { rows } = await sql`
    SELECT p.*, pu.amount_cents, pu.type, pu.created_at AS purchase_at
    FROM   players p
    LEFT   JOIN purchases pu ON pu.player_id = p.id
    WHERE  p.id = ${id}
    ORDER  BY pu.created_at DESC NULLS LAST
    LIMIT  1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    ...row,
    email:              decryptMaybe(row.email_enc),
    stripe_customer_id: decryptMaybe(row.stripe_customer_enc),
    oauth_key:          decryptMaybe(row.oauth_key_enc),
  };
}

export async function findPlayerByEmail(email: string) {
  const h = sha256(email.trim().toLowerCase());
  const { rows } = await sql`
    SELECT id FROM players WHERE email_hash = ${h} LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function createPlayer(data: {
  fullName?: string;
  handle?: string;
  email?: string;
  country?: string;
  passwordHash?: string;
  authProvider?: string;
  oauthProvider?: string;
  oauthKey?: string;
  notes?: string;
  status?: string;
}) {
  const id = randomUUID();
  const { rows } = await sql`
    INSERT INTO players (
      id, full_name, handle, email_hash, email_enc, country,
      password_hash, auth_provider, oauth_provider, oauth_key_enc,
      status, notes
    )
    VALUES (
      ${id},
      ${data.fullName ?? null},
      ${data.handle ?? null},
      ${data.email ? sha256(data.email.trim().toLowerCase()) : null},
      ${encryptMaybe(data.email)},
      ${data.country ?? null},
      ${data.passwordHash ?? null},
      ${data.authProvider ?? 'password'},
      ${data.oauthProvider ?? null},
      ${encryptMaybe(data.oauthKey)},
      ${data.status ?? 'active'},
      ${data.notes ?? null}
    )
    RETURNING id
  `;
  return rows[0].id as string;
}

export async function updatePlayer(id: string, data: {
  fullName?: string | null;
  handle?: string | null;
  email?: string | null;
  country?: string | null;
  passwordHash?: string | null;
  authProvider?: string | null;
  oauthProvider?: string | null;
  oauthKey?: string | null;
  notes?: string | null;
  status?: string | null;
}) {
  await sql`
    UPDATE players
    SET full_name      = COALESCE(${data.fullName ?? null}, full_name),
        handle         = COALESCE(${data.handle ?? null}, handle),
        email_hash     = CASE
          WHEN ${data.email != null} THEN ${data.email ? sha256(data.email.trim().toLowerCase()) : null}
          ELSE email_hash
        END,
        email_enc      = CASE
          WHEN ${data.email != null} THEN ${encryptMaybe(data.email)}
          ELSE email_enc
        END,
        country        = COALESCE(${data.country ?? null}, country),
        password_hash  = COALESCE(${data.passwordHash ?? null}, password_hash),
        auth_provider  = COALESCE(${data.authProvider ?? null}, auth_provider),
        oauth_provider = COALESCE(${data.oauthProvider ?? null}, oauth_provider),
        oauth_key_enc  = CASE
          WHEN ${data.oauthKey != null} THEN ${encryptMaybe(data.oauthKey)}
          ELSE oauth_key_enc
        END,
        status         = COALESCE(${data.status ?? null}, status),
        notes          = COALESCE(${data.notes ?? null}, notes),
        updated_at     = NOW()
    WHERE id = ${id}
  `;
}

export async function revokeAccess(playerId: string) {
  await sql`
    UPDATE players
    SET    access_revoked_at = NOW(), updated_at = NOW()
    WHERE  id = ${playerId}
  `;
}

export async function lockPlayer(playerId: string) {
  await sql`
    UPDATE players
    SET status = 'locked', access_revoked_at = NOW(), updated_at = NOW()
    WHERE id = ${playerId}
  `;
}

export async function unlockPlayer(playerId: string) {
  await sql`
    UPDATE players
    SET status = 'active',
        access_revoked_at = NULL,
        access_granted_at = COALESCE(access_granted_at, NOW()),
        updated_at = NOW()
    WHERE id = ${playerId}
  `;
}

// ── Quests ─────────────────────────────────────────────────────────────────

const DEFAULT_QUESTS = [
  // STATION
  { n: 1,  world: 'station',  line: 'Signal Boost',        title: 'Reactivate the beacon array on Deck 4',                               credits: 75,   dur: 15,   pre: null,                                        notes: 'Simple — 15 min. Locate three relay nodes and power them on.' },
  { n: 2,  world: 'station',  line: 'Cargo Manifest',       title: 'Verify and stamp 12 incoming freight containers',                      credits: 100,  dur: 30,   pre: null,                                        notes: 'Simple — 30 min. Scan barcodes and flag damaged goods.' },
  { n: 3,  world: 'station',  line: 'Dock Worker',          title: 'Clear the blocked freight corridor and restore flow',                  credits: 250,  dur: 90,   pre: ['Signal Boost'],                            notes: 'Medium — 90 min. Requires Signal Boost (Q1) complete.' },
  { n: 4,  world: 'station',  line: 'Trade Route Scouting', title: 'Chart three new trade corridors through the outer rings',             credits: 400,  dur: 180,  pre: null,                                        notes: 'Medium — 3 hr. Involves travel to all outer docking bays.' },
  { n: 5,  world: 'station',  line: 'Lost Traveller',       title: 'Locate and escort the missing envoy from Bay 9',                      credits: 80,   dur: 20,   pre: null,                                        notes: 'Simple — 20 min. Easy escort task.' },
  { n: 6,  world: 'station',  line: 'Contraband Sweep',     title: 'Search six cargo bays for smuggled aether crystals',                  credits: 350,  dur: 120,  pre: ['Dock Worker'],                             notes: 'Medium — 2 hr. Requires Dock Worker (Q3) complete.' },
  { n: 7,  world: 'station',  line: 'Nexus Cartographer',   title: 'Produce a verified map of all five portal connections',               credits: 1000, dur: 720,  pre: ['Trade Route Scouting','Contraband Sweep'], notes: 'Complex — 12 hr. Requires Q4 and Q6. Extensive multi-zone survey.' },
  { n: 8,  world: 'station',  line: 'Station Saboteur',     title: 'Identify and stop the faction planting power disruptors',             credits: 1500, dur: 1440, pre: ['Nexus Cartographer'],                     notes: 'Complex — 1 day. Requires Q7. Stealth and combat sections.' },
  { n: 9,  world: 'station',  line: 'The Aether Compact',   title: 'Broker a trade agreement between three rival world factions',        credits: 2500, dur: 2880, pre: ['Station Saboteur'],                       notes: 'Epic — 2 days. Requires Q8. Multi-step diplomacy across worlds.' },
  { n: 10, world: 'station',  line: 'Nexus Council Envoy',  title: 'Represent the Station at the founding of the Nexus Council',         credits: 5000, dur: 5760, pre: ['The Aether Compact'],                     notes: 'Epic — 4 days. Requires Q9. Capstone quest for the Station questline.' },
  // MEDIEVAL
  { n: 11, world: 'medieval', line: 'Herb Gatherer',        title: 'Collect nightshade, frostbloom, and ironroot from the vale',         credits: 60,   dur: 15,   pre: null,                                        notes: 'Simple — 15 min. Gathering task, no combat.' },
  { n: 12, world: 'medieval', line: 'Mill Stone Delivery',  title: "Carry the miller's replacement grindstone to the north mill",        credits: 80,   dur: 25,   pre: null,                                        notes: 'Simple — 25 min. Delivery with a heavy-load movement penalty.' },
  { n: 13, world: 'medieval', line: 'Bandit Camp Scout',    title: 'Locate the bandit camp east of Thornwall without being seen',        credits: 220,  dur: 90,   pre: null,                                        notes: 'Medium — 90 min. Stealth mission; detection causes failure.' },
  { n: 14, world: 'medieval', line: "The Miller's Debt",    title: "Recover the miller's stolen grain and settle his debt to the guild", credits: 300,  dur: 120,  pre: ['Mill Stone Delivery'],                     notes: 'Medium — 2 hr. Requires Q12. Investigation and retrieval.' },
  { n: 15, world: 'medieval', line: 'Village Healer',       title: 'Prepare and administer remedies to the sick in three homesteads',   credits: 100,  dur: 30,   pre: ['Herb Gatherer'],                           notes: 'Simple — 30 min. Requires Q11. Crafting and NPC interaction.' },
  { n: 16, world: 'medieval', line: "Knight's Errand",      title: "Escort the knight's sealed letter to Lord Greymere at the citadel gate", credits: 450, dur: 180, pre: ['Bandit Camp Scout'],                   notes: 'Medium — 3 hr. Requires Q13. Long escort across bandit territory.' },
  { n: 17, world: 'medieval', line: 'Siege of Thornwall',   title: 'Hold the outer wall through three waves of bandit assault',         credits: 900,  dur: 720,  pre: ["Knight's Errand"],                        notes: 'Complex — 12 hr. Requires Q16. Timed defence with reinforcement phases.' },
  { n: 18, world: 'medieval', line: "The Witch's Bargain",  title: 'Negotiate with the forest witch to lift the plague on the vale',    credits: 1200, dur: 1440, pre: ["The Miller's Debt",'Village Healer'],      notes: 'Complex — 1 day. Requires Q14 and Q15. Moral choices affect outcome.' },
  { n: 19, world: 'medieval', line: 'The Dark Tome',        title: 'Recover and destroy the cursed tome hidden in the Thornwood ruins', credits: 3000, dur: 4320, pre: ['Siege of Thornwall',"The Witch's Bargain"], notes: 'Epic — 3 days. Requires Q17 and Q18. Multi-dungeon crawl with boss.' },
  { n: 20, world: 'medieval', line: 'Crown of Aldermoor',   title: "Unite the vale's factions and crown the new ruler of Aldermoor",   credits: 6000, dur: 7200, pre: ['The Dark Tome'],                          notes: 'Epic — 5 days. Requires Q19. Capstone; permanent world-state change.' },
  // SPORTS
  { n: 21, world: 'sports',   line: 'First Sprint',          title: 'Complete the 100 m dash within the qualifying time',                credits: 50,   dur: 10,   pre: null,                                        notes: 'Simple — 10 min. Pure speed check.' },
  { n: 22, world: 'sports',   line: 'Warm-Up Circuit',       title: 'Finish three laps of the outer warm-up track without stopping',    credits: 75,   dur: 20,   pre: null,                                        notes: 'Simple — 20 min. Stamina check.' },
  { n: 23, world: 'sports',   line: 'Team Tryout',           title: 'Pass the multi-discipline tryout for the Meridian Blaze team',     credits: 200,  dur: 60,   pre: ['First Sprint'],                            notes: 'Medium — 1 hr. Requires Q21. Sprint, obstacle, and accuracy sections.' },
  { n: 24, world: 'sports',   line: 'Track Marshal',         title: 'Oversee and enforce the rules during the junior championship heats', credits: 250, dur: 90,   pre: null,                                        notes: 'Medium — 90 min. Observation and decision-making quest.' },
  { n: 25, world: 'sports',   line: 'Equipment Cache',       title: 'Locate the stolen team kit hidden across the grandstand complex',   credits: 90,   dur: 25,   pre: null,                                        notes: 'Simple — 25 min. Treasure-hunt style.' },
  { n: 26, world: 'sports',   line: 'League Qualifier',      title: 'Lead the Meridian Blaze through the regional league qualifier rounds', credits: 500, dur: 180, pre: ['Team Tryout','Track Marshal'],            notes: 'Medium — 3 hr. Requires Q23 and Q24. Three competitive event rounds.' },
  { n: 27, world: 'sports',   line: 'Championship Contender',title: 'Win the full Meridian Athletic Championship tournament bracket',    credits: 1200, dur: 1440, pre: ['League Qualifier'],                       notes: 'Complex — 1 day. Requires Q26. Eight-match bracket, escalating difficulty.' },
  { n: 28, world: 'sports',   line: 'Rival Team Sabotage',   title: "Expose and stop the rival team's equipment tampering scheme",      credits: 800,  dur: 720,  pre: ['Track Marshal'],                           notes: 'Complex — 12 hr. Requires Q24. Investigation and confrontation.' },
  { n: 29, world: 'sports',   line: 'Grand Prix Champion',   title: 'Take the Meridian Grand Prix title across all disciplines',        credits: 2200, dur: 2880, pre: ['Championship Contender','Rival Team Sabotage'], notes: 'Epic — 2 days. Requires Q27 and Q28. Full multi-sport event series.' },
  { n: 30, world: 'sports',   line: 'Nexus Sports Hall of Fame', title: 'Complete all Meridian disciplines with gold-tier records and be inducted', credits: 4000, dur: 4320, pre: ['Grand Prix Champion'],         notes: 'Epic — 3 days. Requires Q29. Capstone; personal-record challenges.' },
  // CITADEL
  { n: 31, world: 'citadel',  line: 'Wall Watch',            title: 'Complete an unbroken two-hour guard shift on the outer battlements', credits: 70,  dur: 15,   pre: null,                                        notes: 'Simple — 15 min in-game. Observation and alertness challenge.' },
  { n: 32, world: 'citadel',  line: 'Armory Inventory',      title: 'Count, log, and report shortfalls in the citadel armoury',         credits: 90,   dur: 30,   pre: null,                                        notes: 'Simple — 30 min. Memory and attention-to-detail task.' },
  { n: 33, world: 'citadel',  line: 'Patrol Route',          title: 'Run the full perimeter patrol without triggering any alarm',       credits: 200,  dur: 90,   pre: ['Wall Watch'],                              notes: 'Medium — 90 min. Requires Q31. Stealth and route memorisation.' },
  { n: 34, world: 'citadel',  line: 'Desert Scouts',         title: 'Survey the desert approaches and mark enemy troop positions',      credits: 320,  dur: 120,  pre: null,                                        notes: 'Medium — 2 hr. Exposed scouting, risk of detection.' },
  { n: 35, world: 'citadel',  line: 'Fallen Gate',           title: 'Repair the damaged main gate before the night guard change',       credits: 75,   dur: 20,   pre: null,                                        notes: 'Simple — 20 min. Timed repair puzzle.' },
  { n: 36, world: 'citadel',  line: 'Citadel Defender',      title: "Repel the desert raiders' probe attack on the east terraces",     credits: 600,  dur: 240,  pre: ['Patrol Route','Desert Scouts'],            notes: 'Medium — 4 hr. Requires Q33 and Q34. Wave defence sequence.' },
  { n: 37, world: 'citadel',  line: 'The Siege Plan',        title: 'Steal the enemy siege plans from their forward camp and return safely', credits: 1400, dur: 1440, pre: ['Citadel Defender'],                  notes: 'Complex — 1 day. Requires Q36. Deep infiltration behind enemy lines.' },
  { n: 38, world: 'citadel',  line: 'Assassin in the Keep',  title: 'Find and neutralise the assassin hiding inside the citadel walls', credits: 1000, dur: 720,  pre: ['Fallen Gate'],                            notes: 'Complex — 12 hr. Requires Q35. Investigation, deduction, and combat.' },
  { n: 39, world: 'citadel',  line: 'The Desert War',        title: 'Lead the combined defence and turn the full enemy offensive',      credits: 3500, dur: 4320, pre: ['The Siege Plan','Assassin in the Keep'],   notes: 'Epic — 3 days. Requires Q37 and Q38. Large-scale battle campaign.' },
  { n: 40, world: 'citadel',  line: 'Warlord of Sunspire',   title: 'Claim the title of Warlord and establish the Sunspire Pact',      credits: 7000, dur: 7200, pre: ['The Desert War'],                         notes: 'Epic — 5 days. Requires Q39. Capstone; player earns citadel leadership title.' },
  // RACE
  { n: 41, world: 'race',     line: 'First Lap',             title: 'Complete one clean lap of the Vellum Ridge Circuit',               credits: 60,   dur: 10,   pre: null,                                        notes: 'Simple — 10 min. No time pressure; familiarisation lap.' },
  { n: 42, world: 'race',     line: 'Pit Crew Basics',       title: 'Perform a full tyre-and-fuel stop in under the target time',       credits: 80,   dur: 20,   pre: null,                                        notes: 'Simple — 20 min. Timed button-sequence puzzle.' },
  { n: 43, world: 'race',     line: 'Time Trial',            title: 'Post a qualifying time fast enough for the regional grid',         credits: 200,  dur: 60,   pre: ['First Lap'],                               notes: 'Medium — 1 hr. Requires Q41. Three timed attempts to beat the target.' },
  { n: 44, world: 'race',     line: "Mechanic's Special",    title: "Diagnose and repair the car's hidden handling fault before the heat", credits: 280, dur: 90,  pre: ['Pit Crew Basics'],                        notes: 'Medium — 90 min. Requires Q42. Logic puzzle + test laps.' },
  { n: 45, world: 'race',     line: 'Street Circuit Scout',  title: 'Walk and memorise the city block section of the circuit',          credits: 85,   dur: 25,   pre: null,                                        notes: 'Simple — 25 min. Exploration and waypoint marking.' },
  { n: 46, world: 'race',     line: 'Regional Heat',         title: 'Win your regional heat against five AI rivals',                    credits: 450,  dur: 180,  pre: ['Time Trial',"Mechanic's Special"],         notes: 'Medium — 3 hr. Requires Q43 and Q44. Full race with rival AI scaling.' },
  { n: 47, world: 'race',     line: 'Sabotaged Start',       title: 'Discover who tampered with your car and clear your name before the race', credits: 1100, dur: 1440, pre: ['Street Circuit Scout'],            notes: 'Complex — 1 day. Requires Q45. Investigation, alibi checks, confrontation.' },
  { n: 48, world: 'race',     line: 'Championship Round',    title: 'Finish on the podium in the Vellum Ridge Championship round',      credits: 900,  dur: 720,  pre: ['Regional Heat'],                          notes: 'Complex — 12 hr. Requires Q46. Eight-rival race with full damage model.' },
  { n: 49, world: 'race',     line: 'The Vellum 500',        title: 'Endure and win the 500-lap Vellum Ridge endurance race',           credits: 2500, dur: 2880, pre: ['Sabotaged Start','Championship Round'],    notes: 'Epic — 2 days. Requires Q47 and Q48. Endurance with pit strategy.' },
  { n: 50, world: 'race',     line: 'Nexus Racing Legend',   title: 'Break the all-time circuit record and earn the Nexus Racing Legend title', credits: 5000, dur: 5760, pre: ['The Vellum 500'],               notes: 'Epic — 4 days. Requires Q49. Capstone; personal-record across all layouts.' },
] as const;

async function _ensureQuestsSeeded() {
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
  for (const q of DEFAULT_QUESTS) {
    const preJson = q.pre ? JSON.stringify(q.pre) : null;
    await sql`
      INSERT INTO quests (id, quest_number, world, quest_line, title, reward_credits,
                          duration_minutes, pre_steps, post_steps, notes, is_active, updated_by)
      VALUES (${randomUUID()}, ${q.n}, ${q.world}, ${q.line}, ${q.title}, ${q.credits},
              ${q.dur}, ${preJson}, ${null}, ${q.notes}, true, 'seed')
      ON CONFLICT (quest_number) DO NOTHING
    `;
  }
}

export async function listQuests() {
  await _ensureQuestsSeeded();
  const { rows } = await sql`
    SELECT id, quest_number, world, quest_line, title, reward_credits, duration_minutes,
           pre_steps, post_steps, notes, is_active, updated_by,
           created_at, updated_at
    FROM quests
    ORDER BY quest_number ASC, created_at ASC
  `;
  return rows;
}

export async function getQuestById(id: string) {
  const { rows } = await sql`
    SELECT id, quest_number, world, quest_line, title, reward_credits, duration_minutes,
           pre_steps, post_steps, notes, is_active, updated_by,
           created_at, updated_at
    FROM quests
    WHERE id = ${id}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function createQuest(data: {
  questNumber: number;
  world: string;
  questLine: string;
  title: string;
  rewardCredits?: number;
  durationMinutes?: number | null;
  preSteps?: string | null;
  postSteps?: string | null;
  notes?: string | null;
  isActive?: boolean;
  updatedBy?: string;
}) {
  const id = randomUUID();
  await sql`
    INSERT INTO quests (
      id, quest_number, world, quest_line, title, reward_credits,
      duration_minutes, pre_steps, post_steps, notes, is_active, updated_by
    )
    VALUES (
      ${id},
      ${data.questNumber},
      ${data.world},
      ${data.questLine},
      ${data.title},
      ${data.rewardCredits ?? 0},
      ${data.durationMinutes ?? null},
      ${data.preSteps ?? null},
      ${data.postSteps ?? null},
      ${data.notes ?? null},
      ${data.isActive ?? true},
      ${data.updatedBy ?? null}
    )
  `;
  return id;
}

export async function updateQuest(id: string, data: {
  questNumber: number;
  world: string;
  questLine: string;
  title: string;
  rewardCredits?: number;
  durationMinutes?: number | null;
  preSteps?: string | null;
  postSteps?: string | null;
  notes?: string | null;
  isActive?: boolean;
  updatedBy?: string;
}) {
  await sql`
    UPDATE quests
    SET quest_number   = ${data.questNumber},
        world          = ${data.world},
        quest_line     = ${data.questLine},
        title          = ${data.title},
        reward_credits = ${data.rewardCredits ?? 0},
        duration_minutes = ${data.durationMinutes ?? null},
        pre_steps      = ${data.preSteps ?? null},
        post_steps     = ${data.postSteps ?? null},
        notes          = ${data.notes ?? null},
        is_active      = ${data.isActive ?? true},
        updated_by     = ${data.updatedBy ?? null},
        updated_at     = NOW()
    WHERE id = ${id}
  `;
}

export async function deleteQuest(id: string) {
  await sql`DELETE FROM quests WHERE id = ${id}`;
}

export async function listPlayerQuestEngagements(playerId: string) {
  const { rows } = await sql`
    SELECT
      e.id, e.player_id, e.quest_id, e.quest_number, e.quest_title, e.world,
      e.duration_minutes, e.status, e.percent_complete, e.credits_rewarded,
      e.failure_reason, e.accepted_at, e.completed_at, e.failed_at, e.updated_at,
      q.reward_credits AS quest_reward_credits
    FROM player_quest_engagements e
    LEFT JOIN quests q ON q.id = e.quest_id
    WHERE e.player_id = ${playerId}
    ORDER BY e.updated_at DESC, e.accepted_at DESC
  `;
  return rows;
}

export async function adjustCredits(playerId: string, delta: number) {
  await sql`
    UPDATE players
    SET    credit_balance = credit_balance + ${delta}, updated_at = NOW()
    WHERE  id = ${playerId}
  `;
}

export async function countPlayers(): Promise<number> {
  const { rows } = await sql`SELECT COUNT(*) AS n FROM players`;
  return Number(rows[0]?.n ?? 0);
}

export async function countActivePlayers(): Promise<number> {
  const { rows } = await sql`
    SELECT COUNT(*) AS n FROM players
    WHERE access_granted_at IS NOT NULL AND access_revoked_at IS NULL
  `;
  return Number(rows[0]?.n ?? 0);
}

// ── Purchases ──────────────────────────────────────────────────────────────

export async function recordPurchase(data: {
  playerId:       string;
  stripeIntent:   string;
  amountCents:    number;
  currency:       string;
  type:           'access' | 'credits';
  creditsAmount?: number;
}) {
  const id         = randomUUID();
  const intentEnc  = encrypt(data.stripeIntent);
  await sql`
    INSERT INTO purchases
      (id, player_id, stripe_intent_enc, amount_cents, currency, type, credits_amount)
    VALUES (
      ${id}, ${data.playerId}, ${intentEnc},
      ${data.amountCents}, ${data.currency}, ${data.type},
      ${data.creditsAmount ?? null}
    )
    ON CONFLICT DO NOTHING
  `;
  return id;
}

export async function listPurchases(page = 0) {
  const offset = page * PAGE_SIZE;
  const { rows } = await sql`
    SELECT pu.id, pu.player_id, pu.amount_cents, pu.currency,
           pu.type, pu.credits_amount, pu.status, pu.created_at,
           pl.email_hash
    FROM   purchases pu
    LEFT   JOIN players pl ON pl.id = pu.player_id
    ORDER  BY pu.created_at DESC
    LIMIT  ${PAGE_SIZE} OFFSET ${offset}
  `;
  return rows;
}

export async function purchaseStats() {
  const { rows } = await sql`
    SELECT
      COUNT(*)                            AS total_count,
      COALESCE(SUM(amount_cents), 0)      AS total_cents,
      COUNT(*) FILTER (WHERE type = 'access')  AS access_count,
      COUNT(*) FILTER (WHERE type = 'credits') AS credits_count
    FROM purchases
    WHERE status = 'completed'
  `;
  return rows[0];
}

// ── Audit log ──────────────────────────────────────────────────────────────

export async function audit(
  actor:    string,
  action:   string,
  resource: string,
  detail?:  string,
  ip?:      string,
) {
  const id = randomUUID();
  // Fetch last entry for chain
  const { rows: last } = await sql`
    SELECT seq, entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1
  `;
  const prevHash = last[0]?.entry_hash ?? sign('genesis');
  const prevSeq  = Number(last[0]?.seq  ?? 0);
  const hash     = auditHash(prevSeq + 1, actor, action, resource, prevHash);
  const ipHash   = ip ? sha256(ip) : null;

  await sql`
    INSERT INTO audit_log (id, prev_hash, entry_hash, actor, action, resource, detail, ip_hash)
    VALUES (${id}, ${prevHash}, ${hash}, ${actor}, ${action}, ${resource},
            ${detail ?? null}, ${ipHash})
  `;
}

export async function listAudit(page = 0) {
  const offset = page * PAGE_SIZE;
  const { rows } = await sql`
    SELECT id, seq, actor, action, resource, detail, ip_hash, created_at
    FROM   audit_log
    ORDER  BY seq DESC
    LIMIT  ${PAGE_SIZE} OFFSET ${offset}
  `;
  return rows;
}

/**
 * Walk the entire chain and verify every HMAC.
 * Returns { valid: true } or { valid: false, brokenAt: seq }.
 */
export async function verifyAuditChain(): Promise<{ valid: boolean; brokenAt?: number }> {
  const { rows } = await sql`
    SELECT seq, actor, action, resource, prev_hash, entry_hash
    FROM   audit_log ORDER BY seq ASC
  `;
  let prevHash = sign('genesis');
  for (const row of rows) {
    const expected = auditHash(Number(row.seq), row.actor, row.action, row.resource, prevHash);
    if (expected !== row.entry_hash) {
      return { valid: false, brokenAt: Number(row.seq) };
    }
    prevHash = row.entry_hash;
  }
  return { valid: true };
}

// ── Config ─────────────────────────────────────────────────────────────────

export async function getConfig(key: string): Promise<string | null> {
  const { rows } = await sql`
    SELECT value_enc FROM config WHERE key = ${key} LIMIT 1
  `;
  return rows[0] ? decryptMaybe(rows[0].value_enc) : null;
}

export async function setConfig(
  key:         string,
  value:       string,
  updatedBy:   string,
  description?: string,
) {
  const enc = encrypt(value);
  await sql`
    INSERT INTO config (key, value_enc, description, updated_by)
    VALUES (${key}, ${enc}, ${description ?? null}, ${updatedBy})
    ON CONFLICT (key) DO UPDATE SET
      value_enc   = EXCLUDED.value_enc,
      description = COALESCE(EXCLUDED.description, config.description),
      updated_by  = EXCLUDED.updated_by,
      updated_at  = NOW()
  `;
}

export async function listConfigKeys() {
  const { rows } = await sql`
    SELECT key, description, updated_by, updated_at FROM config ORDER BY key
  `;
  return rows;
}

// ── Lore ────────────────────────────────────────────────────────────────────

export async function listLoreEntries() {
  // Create and seed the table on first access so the lore page never 500s
  // before the admin setup script has been run.
  await sql`
    CREATE TABLE IF NOT EXISTS lore_entries (
      scope       TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      sign_label  TEXT NOT NULL DEFAULT 'Lorekeeper',
      body        TEXT NOT NULL,
      updated_by  TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  for (const entry of DEFAULT_LORE_ROWS) {
    await sql`
      INSERT INTO lore_entries (scope, title, sign_label, body)
      VALUES (${entry.scope}, ${entry.title}, ${entry.sign_label}, ${entry.body})
      ON CONFLICT (scope) DO NOTHING
    `;
  }

  const { rows } = await sql`
    SELECT scope, title, sign_label, body, updated_by, created_at, updated_at
    FROM lore_entries
    ORDER BY CASE scope
      WHEN 'overall' THEN 0
      WHEN 'station' THEN 1
      WHEN 'medieval' THEN 2
      WHEN 'sports' THEN 3
      WHEN 'citadel' THEN 4
      WHEN 'race' THEN 5
      ELSE 99
    END, scope
  `;
  return rows;
}

export async function getLoreEntry(scope: string) {
  const { rows } = await sql`
    SELECT scope, title, sign_label, body, updated_by, created_at, updated_at
    FROM lore_entries
    WHERE scope = ${scope}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function upsertLoreEntry(data: {
  scope: string;
  title: string;
  signLabel?: string;
  body: string;
  updatedBy?: string;
}) {
  // Ensure the table exists before upserting.
  await sql`
    CREATE TABLE IF NOT EXISTS lore_entries (
      scope       TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      sign_label  TEXT NOT NULL DEFAULT 'Lorekeeper',
      body        TEXT NOT NULL,
      updated_by  TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    INSERT INTO lore_entries (scope, title, sign_label, body, updated_by)
    VALUES (${data.scope}, ${data.title}, ${data.signLabel ?? 'Lorekeeper'}, ${data.body}, ${data.updatedBy ?? null})
    ON CONFLICT (scope) DO UPDATE SET
      title      = EXCLUDED.title,
      sign_label = EXCLUDED.sign_label,
      body       = EXCLUDED.body,
      updated_by = EXCLUDED.updated_by,
      updated_at = NOW()
  `;
}