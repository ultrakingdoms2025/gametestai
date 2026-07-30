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
import { computePlayerAccessSnapshot, grantedAtForRemainingDays } from './playerAccess';

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
  // ── STATION ──────────────────────────────────────────────────────────────
  { n:  1, world:'station',  line:'Signal Boost',        title:'Reactivate the beacon array on Deck 4',                                    credits:75,   dur:15,   pre:null, notes:'Simple — 15 min. Locate three relay nodes and power them on.',
    steps:[{order:1,label:'Locate all 3 relay nodes on Deck 4',type:'visit',target:'relay_node',count:3,world:'station'},{order:2,label:'Activate the beacon array control panel',type:'interact',target:'beacon_array',count:1,world:'station'}]},
  { n:  2, world:'station',  line:'Cargo Manifest',      title:'Verify and stamp 12 incoming freight containers',                          credits:100,  dur:30,   pre:null, notes:'Simple — 30 min. Scan barcodes and flag damaged goods.',
    steps:[{order:1,label:'Scan 12 freight container barcodes',type:'interact',target:'freight_container',count:12,world:'station'},{order:2,label:'Flag 3 damaged containers for inspection',type:'investigate',target:'damaged_container',count:3,world:'station'},{order:3,label:'Submit the completed manifest to the Cargo Office',type:'deliver',target:'cargo_office',count:1,world:'station'}]},
  { n:  3, world:'station',  line:'Dock Worker',         title:'Clear the blocked freight corridor and restore flow',                       credits:250,  dur:90,   pre:['Signal Boost'], notes:'Medium — 90 min. Requires Signal Boost (Q1) complete.',
    steps:[{order:1,label:'Collect 5 maintenance tools from the supply locker',type:'collect',target:'maintenance_tool',count:5,world:'station'},{order:2,label:'Clear debris from 4 corridor sections',type:'interact',target:'corridor_debris',count:4,world:'station'},{order:3,label:'Repair 2 freight conveyor systems',type:'interact',target:'conveyor_system',count:2,world:'station'}]},
  { n:  4, world:'station',  line:'Trade Route Scouting',title:'Chart three new trade corridors through the outer rings',                  credits:400,  dur:180,  pre:null, notes:'Medium — 3 hr. Involves travel to all outer docking bays.',
    steps:[{order:1,label:'Reach Outer Ring Bay A and log the corridor',type:'visit',target:'outer_ring_bay_a',count:1,world:'station'},{order:2,label:'Reach Outer Ring Bay B and log the corridor',type:'visit',target:'outer_ring_bay_b',count:1,world:'station'},{order:3,label:'Reach Outer Ring Bay C and log the corridor',type:'visit',target:'outer_ring_bay_c',count:1,world:'station'},{order:4,label:'Submit scouting report to the Trade Office',type:'deliver',target:'trade_office',count:1,world:'station'}]},
  { n:  5, world:'station',  line:'Lost Traveller',      title:'Locate and escort the missing envoy from Bay 9',                          credits:80,   dur:20,   pre:null, notes:'Simple — 20 min. Easy escort task.',
    steps:[{order:1,label:'Find the missing envoy in Bay 9',type:'investigate',target:'missing_envoy',count:1,world:'station'},{order:2,label:'Escort the envoy safely to the main concourse',type:'escort',target:'envoy',count:1,world:'station'}]},
  { n:  6, world:'station',  line:'Contraband Sweep',    title:'Search six cargo bays for smuggled aether crystals',                      credits:350,  dur:120,  pre:['Dock Worker'], notes:'Medium — 2 hr. Requires Dock Worker (Q3) complete.',
    steps:[{order:1,label:'Search 6 cargo bays for contraband',type:'investigate',target:'cargo_bay',count:6,world:'station'},{order:2,label:'Confiscate 3 hidden aether crystal caches',type:'collect',target:'aether_crystal_cache',count:3,world:'station'},{order:3,label:'File incident reports for each cargo bay searched',type:'interact',target:'incident_terminal',count:6,world:'station'},{order:4,label:'Hand all evidence to Security Command',type:'deliver',target:'security_command',count:1,world:'station'}]},
  { n:  7, world:'station',  line:'Nexus Cartographer',  title:'Produce a verified map of all five portal connections',                   credits:1000, dur:720,  pre:['Trade Route Scouting','Contraband Sweep'], notes:'Complex — 12 hr. Requires Q4 and Q6.',
    steps:[{order:1,label:'Survey Station portal connection and record data',type:'visit',target:'portal_station',count:1,world:'station'},{order:2,label:'Survey Medieval world portal connection',type:'visit',target:'portal_medieval',count:1,world:'medieval'},{order:3,label:'Survey Sports world portal connection',type:'visit',target:'portal_sports',count:1,world:'sports'},{order:4,label:'Survey Citadel portal connection',type:'visit',target:'portal_citadel',count:1,world:'citadel'},{order:5,label:'Compile and submit the verified map to the Nexus Archive',type:'deliver',target:'nexus_archive',count:1,world:'station'}]},
  { n:  8, world:'station',  line:'Station Saboteur',    title:'Identify and stop the faction planting power disruptors',                 credits:1500, dur:1440, pre:['Nexus Cartographer'], notes:'Complex — 1 day. Requires Q7. Stealth and combat sections.',
    steps:[{order:1,label:'Find 8 hidden power disruptors across the station',type:'investigate',target:'power_disruptor',count:8,world:'station'},{order:2,label:'Disable all disruptors without triggering an alarm',type:'interact',target:'power_disruptor',count:8,world:'station'},{order:3,label:'Shadow the sabotage contact to their safehouse',type:'stealth',target:'sabotage_contact',count:1,world:'station'},{order:4,label:'Capture the saboteur',type:'interact',target:'saboteur',count:1,world:'station'},{order:5,label:'Deliver the saboteur and evidence to Security Command',type:'deliver',target:'security_command',count:1,world:'station'}]},
  { n:  9, world:'station',  line:'The Aether Compact',  title:'Broker a trade agreement between three rival world factions',            credits:2500, dur:2880, pre:['Station Saboteur'], notes:'Epic — 2 days. Requires Q8. Multi-step diplomacy across worlds.',
    steps:[{order:1,label:'Meet with the Station faction leader',type:'talk',target:'station_faction_leader',count:1,world:'station'},{order:2,label:'Meet with the Medieval faction envoy',type:'talk',target:'medieval_faction_envoy',count:1,world:'medieval'},{order:3,label:'Meet with the Citadel faction ambassador',type:'talk',target:'citadel_faction_ambassador',count:1,world:'citadel'},{order:4,label:'Deliver signed agreements to all three faction offices',type:'deliver',target:'faction_office',count:3,world:'station'},{order:5,label:'Attend the Compact signing ceremony at the Nexus Archive',type:'visit',target:'nexus_archive_ceremony',count:1,world:'station'}]},
  { n: 10, world:'station',  line:'Nexus Council Envoy', title:'Represent the Station at the founding of the Nexus Council',            credits:5000, dur:5760, pre:['The Aether Compact'], notes:'Epic — 4 days. Requires Q9. Capstone quest for the Station questline.',
    steps:[{order:1,label:'Attend the pre-council summit at Aether Station',type:'visit',target:'summit_hall',count:1,world:'station'},{order:2,label:'Negotiate with 4 world delegates',type:'talk',target:'world_delegate',count:4,world:'station'},{order:3,label:'Defend the summit from a sabotage attempt',type:'defend',target:'summit_hall',count:1,world:'station'},{order:4,label:'Expose the faction behind the sabotage attempt',type:'investigate',target:'sabotage_evidence',count:1,world:'station'},{order:5,label:'Represent Station at the founding session of the Nexus Council',type:'visit',target:'nexus_council_chamber',count:1,world:'station'}]},
  // ── MEDIEVAL ─────────────────────────────────────────────────────────────
  { n: 11, world:'medieval', line:'Herb Gatherer',       title:'Collect nightshade, frostbloom, and ironroot from the vale',             credits:60,   dur:15,   pre:null, notes:'Simple — 15 min. Gathering task, no combat.',
    steps:[{order:1,label:'Collect 3 nightshade herbs from the northern meadow',type:'collect',target:'nightshade',count:3,world:'medieval'},{order:2,label:'Collect 3 frostbloom herbs near the stream bank',type:'collect',target:'frostbloom',count:3,world:'medieval'},{order:3,label:'Collect 3 ironroot clusters from the hillside',type:'collect',target:'ironroot',count:3,world:'medieval'}]},
  { n: 12, world:'medieval', line:'Mill Stone Delivery', title:"Carry the miller's replacement grindstone to the north mill",           credits:80,   dur:25,   pre:null, notes:'Simple — 25 min. Delivery with a heavy-load movement penalty.',
    steps:[{order:1,label:"Pick up the grindstone from the mason's yard",type:'collect',target:'grindstone',count:1,world:'medieval'},{order:2,label:'Carry the grindstone to the north mill',type:'deliver',target:'north_mill',count:1,world:'medieval'}]},
  { n: 13, world:'medieval', line:'Bandit Camp Scout',   title:'Locate the bandit camp east of Thornwall without being seen',           credits:220,  dur:90,   pre:null, notes:'Medium — 90 min. Stealth mission; detection causes failure.',
    steps:[{order:1,label:'Cross the Thornwall border without being detected',type:'stealth',target:'thornwall_border',count:1,world:'medieval'},{order:2,label:'Locate the bandit camp east of the ridge',type:'investigate',target:'bandit_camp',count:1,world:'medieval'},{order:3,label:'Return to Thornwall without raising the alarm',type:'stealth',target:'thornwall_gate',count:1,world:'medieval'}]},
  { n: 14, world:'medieval', line:"The Miller's Debt",   title:"Recover the miller's stolen grain and settle his debt to the guild",   credits:300,  dur:120,  pre:['Mill Stone Delivery'], notes:'Medium — 2 hr. Requires Q12. Investigation and retrieval.',
    steps:[{order:1,label:'Talk to the guild master about the debt',type:'talk',target:'guild_master',count:1,world:'medieval'},{order:2,label:'Follow 3 clue trails left by the thieves',type:'investigate',target:'grain_clue',count:3,world:'medieval'},{order:3,label:'Recover 8 stolen grain sacks from the thieves\' barn',type:'collect',target:'grain_sack',count:8,world:'medieval'},{order:4,label:'Return the grain to the guild storehouse',type:'deliver',target:'guild_storehouse',count:1,world:'medieval'}]},
  { n: 15, world:'medieval', line:'Village Healer',      title:'Prepare and administer remedies to the sick in three homesteads',      credits:100,  dur:30,   pre:['Herb Gatherer'], notes:'Simple — 30 min. Requires Q11. Crafting and NPC interaction.',
    steps:[{order:1,label:'Craft 3 herbal remedies at the healer\'s bench',type:'craft',target:'herbal_remedy',count:3,world:'medieval'},{order:2,label:'Administer remedy to the sick in 3 homesteads',type:'visit',target:'sick_homestead',count:3,world:'medieval'},{order:3,label:'Report back to the village healer',type:'talk',target:'village_healer',count:1,world:'medieval'}]},
  { n: 16, world:'medieval', line:"Knight's Errand",     title:"Escort the knight's sealed letter to Lord Greymere at the citadel gate", credits:450, dur:180, pre:['Bandit Camp Scout'], notes:'Medium — 3 hr. Requires Q13. Long escort across bandit territory.',
    steps:[{order:1,label:"Receive the sealed letter from the knight's steward",type:'collect',target:'sealed_letter',count:1,world:'medieval'},{order:2,label:'Escort the letter carrier through bandit territory',type:'escort',target:'letter_carrier',count:1,world:'medieval'},{order:3,label:'Deliver the sealed letter to Lord Greymere',type:'deliver',target:'lord_greymere',count:1,world:'citadel'}]},
  { n: 17, world:'medieval', line:'Siege of Thornwall',  title:'Hold the outer wall through three waves of bandit assault',            credits:900,  dur:720,  pre:["Knight's Errand"], notes:'Complex — 12 hr. Requires Q16. Timed defence with reinforcement phases.',
    steps:[{order:1,label:'Defend the outer wall through Wave 1 of the assault',type:'defend',target:'thornwall_outer',count:1,world:'medieval'},{order:2,label:'Defend through Wave 2 with reduced reinforcements',type:'defend',target:'thornwall_outer',count:1,world:'medieval'},{order:3,label:'Hold through the final Wave 3 siege push',type:'defend',target:'thornwall_outer',count:1,world:'medieval'},{order:4,label:'Report to the Captain after the assault is repelled',type:'talk',target:'wall_captain',count:1,world:'medieval'}]},
  { n: 18, world:'medieval', line:"The Witch's Bargain", title:'Negotiate with the forest witch to lift the plague on the vale',      credits:1200, dur:1440, pre:["The Miller's Debt",'Village Healer'], notes:'Complex — 1 day. Requires Q14 and Q15. Moral choices affect outcome.',
    steps:[{order:1,label:'Find the witch\'s clearing deep in Thornwood',type:'visit',target:'witch_clearing',count:1,world:'medieval'},{order:2,label:'Collect her 3 required offerings: moonpetal, ash bark, silver coin',type:'collect',target:'witch_offering',count:3,world:'medieval'},{order:3,label:'Deliver the offerings to the forest altar',type:'deliver',target:'forest_altar',count:1,world:'medieval'},{order:4,label:'Negotiate the terms of the bargain with the witch',type:'talk',target:'forest_witch',count:1,world:'medieval'},{order:5,label:'Complete the ritual to lift the plague from the vale',type:'interact',target:'plague_ritual',count:1,world:'medieval'}]},
  { n: 19, world:'medieval', line:'The Dark Tome',       title:'Recover and destroy the cursed tome hidden in the Thornwood ruins',   credits:3000, dur:4320, pre:['Siege of Thornwall',"The Witch's Bargain"], notes:'Epic — 3 days. Requires Q17 and Q18. Multi-dungeon crawl with boss.',
    steps:[{order:1,label:'Find the hidden entrance to the Thornwood ruins',type:'investigate',target:'ruins_entrance',count:1,world:'medieval'},{order:2,label:'Clear the ruins of 12 corrupted guardians',type:'kill',target:'corrupted_guardian',count:12,world:'medieval'},{order:3,label:'Solve the rune lock puzzle on the tome vault',type:'interact',target:'rune_lock',count:1,world:'medieval'},{order:4,label:'Retrieve the Dark Tome from the vault',type:'collect',target:'dark_tome',count:1,world:'medieval'},{order:5,label:'Destroy the tome at the sacred flame of the Vale',type:'interact',target:'sacred_flame',count:1,world:'medieval'}]},
  { n: 20, world:'medieval', line:'Crown of Aldermoor',  title:"Unite the vale's factions and crown the new ruler of Aldermoor",      credits:6000, dur:7200, pre:['The Dark Tome'], notes:"Epic — 5 days. Requires Q19. Capstone; permanent world-state change.",
    steps:[{order:1,label:"Gain the farmers' guild's support for the chosen ruler",type:'talk',target:'farmers_guild',count:1,world:'medieval'},{order:2,label:'Gain the merchant consortium\'s blessing',type:'talk',target:'merchant_consortium',count:1,world:'medieval'},{order:3,label:"Earn the soldiers' council's oath of loyalty",type:'talk',target:'soldiers_council',count:1,world:'medieval'},{order:4,label:'Protect the chosen ruler during the coronation ceremony',type:'defend',target:'coronation_ruler',count:1,world:'medieval'},{order:5,label:'Witness the crowning at Aldermoor Castle great hall',type:'visit',target:'aldermoor_castle',count:1,world:'medieval'}]},
  // ── SPORTS ───────────────────────────────────────────────────────────────
  { n: 21, world:'sports',   line:'First Sprint',        title:'Complete the 100 m dash within the qualifying time',                    credits:50,   dur:10,   pre:null, notes:'Simple — 10 min. Pure speed check.',
    steps:[{order:1,label:'Complete a warm-up sprint on the practice track',type:'race',target:'practice_sprint',count:1,world:'sports'},{order:2,label:'Post qualifying time in the official 100m dash',type:'race',target:'100m_dash',count:1,world:'sports'}]},
  { n: 22, world:'sports',   line:'Warm-Up Circuit',     title:'Finish three laps of the outer warm-up track without stopping',        credits:75,   dur:20,   pre:null, notes:'Simple — 20 min. Stamina check.',
    steps:[{order:1,label:'Complete 3 laps of the outer warm-up track without stopping',type:'race',target:'warmup_track',count:3,world:'sports'},{order:2,label:'Check in at the finish marshal booth',type:'visit',target:'finish_marshal',count:1,world:'sports'}]},
  { n: 23, world:'sports',   line:'Team Tryout',         title:'Pass the multi-discipline tryout for the Meridian Blaze team',         credits:200,  dur:60,   pre:['First Sprint'], notes:'Medium — 1 hr. Requires Q21. Sprint, obstacle, and accuracy sections.',
    steps:[{order:1,label:'Complete the sprint section of the tryout',type:'race',target:'tryout_sprint',count:1,world:'sports'},{order:2,label:'Complete the obstacle course section',type:'race',target:'tryout_obstacle',count:1,world:'sports'},{order:3,label:'Hit 10 accuracy targets in the shooting range section',type:'interact',target:'accuracy_target',count:10,world:'sports'}]},
  { n: 24, world:'sports',   line:'Track Marshal',       title:'Oversee and enforce the rules during the junior championship heats',   credits:250,  dur:90,   pre:null, notes:'Medium — 90 min. Observation and decision-making quest.',
    steps:[{order:1,label:'Monitor events from 4 marshal checkpoints',type:'visit',target:'marshal_checkpoint',count:4,world:'sports'},{order:2,label:'Identify 3 rule violations during the heats',type:'investigate',target:'rule_violation',count:3,world:'sports'},{order:3,label:'Issue official rulings for all violations',type:'interact',target:'marshal_terminal',count:3,world:'sports'}]},
  { n: 25, world:'sports',   line:'Equipment Cache',     title:'Locate the stolen team kit hidden across the grandstand complex',      credits:90,   dur:25,   pre:null, notes:'Simple — 25 min. Treasure-hunt style.',
    steps:[{order:1,label:'Find first kit item hidden in the grandstand seating',type:'investigate',target:'kit_item',count:1,world:'sports'},{order:2,label:'Find second kit item in the storage sub-level',type:'investigate',target:'kit_item',count:1,world:'sports'},{order:3,label:'Return all kit items to the team locker room',type:'deliver',target:'team_locker_room',count:1,world:'sports'}]},
  { n: 26, world:'sports',   line:'League Qualifier',    title:'Lead the Meridian Blaze through the regional league qualifier rounds', credits:500,  dur:180,  pre:['Team Tryout','Track Marshal'], notes:'Medium — 3 hr. Requires Q23 and Q24. Three competitive event rounds.',
    steps:[{order:1,label:'Win Round 1 — sprint heat event',type:'race',target:'qualifier_round1',count:1,world:'sports'},{order:2,label:'Win Round 2 — field event',type:'race',target:'qualifier_round2',count:1,world:'sports'},{order:3,label:'Win Round 3 — combined event',type:'race',target:'qualifier_round3',count:1,world:'sports'},{order:4,label:'Collect the league qualifier certificate from the officials desk',type:'visit',target:'officials_desk',count:1,world:'sports'}]},
  { n: 27, world:'sports',   line:'Championship Contender',title:'Win the full Meridian Athletic Championship tournament bracket',    credits:1200, dur:1440, pre:['League Qualifier'], notes:'Complex — 1 day. Requires Q26. Eight-match bracket, escalating difficulty.',
    steps:[{order:1,label:'Win 4 quarterfinal matches in the championship bracket',type:'race',target:'quarterfinal',count:4,world:'sports'},{order:2,label:'Win both semifinal matches',type:'race',target:'semifinal',count:2,world:'sports'},{order:3,label:'Win the championship final',type:'race',target:'championship_final',count:1,world:'sports'},{order:4,label:'Accept the championship medal at the award ceremony',type:'interact',target:'medal_ceremony',count:1,world:'sports'}]},
  { n: 28, world:'sports',   line:'Rival Team Sabotage', title:"Expose and stop the rival team's equipment tampering scheme",         credits:800,  dur:720,  pre:['Track Marshal'], notes:'Complex — 12 hr. Requires Q24. Investigation and confrontation.',
    steps:[{order:1,label:'Collect 3 pieces of tampering evidence from rival equipment',type:'investigate',target:'tampering_evidence',count:3,world:'sports'},{order:2,label:'Interview 4 witnesses with information about the scheme',type:'talk',target:'witness',count:4,world:'sports'},{order:3,label:'Identify the saboteur using accumulated evidence',type:'investigate',target:'saboteur_identity',count:1,world:'sports'},{order:4,label:'Report findings to the Athletic Committee',type:'deliver',target:'athletic_committee',count:1,world:'sports'}]},
  { n: 29, world:'sports',   line:'Grand Prix Champion', title:'Take the Meridian Grand Prix title across all disciplines',           credits:2200, dur:2880, pre:['Championship Contender','Rival Team Sabotage'], notes:'Epic — 2 days. Requires Q27 and Q28.',
    steps:[{order:1,label:'Win the track sprint discipline',type:'race',target:'grand_prix_sprint',count:1,world:'sports'},{order:2,label:'Win the obstacle endurance discipline',type:'race',target:'grand_prix_obstacle',count:1,world:'sports'},{order:3,label:'Win the field precision discipline',type:'race',target:'grand_prix_field',count:1,world:'sports'},{order:4,label:'Win the combined team relay discipline',type:'race',target:'grand_prix_relay',count:1,world:'sports'},{order:5,label:'Claim the Grand Prix trophy at the Meridian Ceremony',type:'visit',target:'grand_prix_ceremony',count:1,world:'sports'}]},
  { n: 30, world:'sports',   line:'Nexus Sports Hall of Fame',title:'Complete all Meridian disciplines with gold-tier records and be inducted', credits:4000, dur:4320, pre:['Grand Prix Champion'], notes:'Epic — 3 days. Requires Q29. Capstone; personal-record challenges.',
    steps:[{order:1,label:'Break the sprint discipline gold record',type:'race',target:'sprint_record',count:1,world:'sports'},{order:2,label:'Break the obstacle course gold record',type:'race',target:'obstacle_record',count:1,world:'sports'},{order:3,label:'Break the endurance track gold record',type:'race',target:'endurance_record',count:1,world:'sports'},{order:4,label:'Break the field discipline gold record',type:'race',target:'field_record',count:1,world:'sports'},{order:5,label:'Attend the Hall of Fame induction ceremony',type:'visit',target:'hall_of_fame',count:1,world:'sports'}]},
  // ── CITADEL ───────────────────────────────────────────────────────────────
  { n: 31, world:'citadel',  line:'Wall Watch',          title:'Complete an unbroken two-hour guard shift on the outer battlements',   credits:70,   dur:15,   pre:null, notes:'Simple — 15 min in-game. Observation and alertness challenge.',
    steps:[{order:1,label:'Report to the Watch Commander at the battlements',type:'visit',target:'watch_commander',count:1,world:'citadel'},{order:2,label:'Scan 6 approach zones during your shift without missing any',type:'investigate',target:'approach_zone',count:6,world:'citadel'}]},
  { n: 32, world:'citadel',  line:'Armory Inventory',    title:'Count, log, and report shortfalls in the citadel armoury',            credits:90,   dur:30,   pre:null, notes:'Simple — 30 min. Memory and attention-to-detail task.',
    steps:[{order:1,label:'Log weapons across 5 armoury racks',type:'investigate',target:'weapons_rack',count:5,world:'citadel'},{order:2,label:'Log armour across 3 storage sections',type:'investigate',target:'armour_store',count:3,world:'citadel'},{order:3,label:'Submit the shortfall report to the Armoury Master',type:'deliver',target:'armoury_master',count:1,world:'citadel'}]},
  { n: 33, world:'citadel',  line:'Patrol Route',        title:'Run the full perimeter patrol without triggering any alarm',           credits:200,  dur:90,   pre:['Wall Watch'], notes:'Medium — 90 min. Requires Q31. Stealth and route memorisation.',
    steps:[{order:1,label:'Complete the east perimeter section without triggering alarms',type:'stealth',target:'east_perimeter',count:1,world:'citadel'},{order:2,label:'Complete the west perimeter section without triggering alarms',type:'stealth',target:'west_perimeter',count:1,world:'citadel'},{order:3,label:'Clear the gate approach section without triggering alarms',type:'stealth',target:'gate_approach',count:1,world:'citadel'}]},
  { n: 34, world:'citadel',  line:'Desert Scouts',       title:'Survey the desert approaches and mark enemy troop positions',          credits:320,  dur:120,  pre:null, notes:'Medium — 2 hr. Exposed scouting, risk of detection.',
    steps:[{order:1,label:'Reach 3 desert vantage points without being engaged',type:'visit',target:'desert_vantage',count:3,world:'citadel'},{order:2,label:'Mark enemy troop positions from each vantage point',type:'investigate',target:'troop_position',count:3,world:'citadel'},{order:3,label:'Return scout data to the Command Post',type:'deliver',target:'command_post',count:1,world:'citadel'}]},
  { n: 35, world:'citadel',  line:'Fallen Gate',         title:'Repair the damaged main gate before the night guard change',           credits:75,   dur:20,   pre:null, notes:'Simple — 20 min. Timed repair puzzle.',
    steps:[{order:1,label:'Gather 5 repair materials from the supply cache',type:'collect',target:'repair_material',count:5,world:'citadel'},{order:2,label:'Repair the gate mechanism before time expires',type:'interact',target:'gate_mechanism',count:1,world:'citadel',time_limit_s:600}]},
  { n: 36, world:'citadel',  line:'Citadel Defender',    title:"Repel the desert raiders' probe attack on the east terraces",         credits:600,  dur:240,  pre:['Patrol Route','Desert Scouts'], notes:'Medium — 4 hr. Requires Q33 and Q34. Wave defence sequence.',
    steps:[{order:1,label:'Repel the first raider wave on the east terrace',type:'defend',target:'east_terrace',count:1,world:'citadel'},{order:2,label:'Repel the second larger raider wave',type:'defend',target:'east_terrace',count:1,world:'citadel'},{order:3,label:'Repel the final assault with heavy raiders',type:'defend',target:'east_terrace',count:1,world:'citadel'},{order:4,label:'Seal the breach in the east terrace wall',type:'interact',target:'terrace_breach',count:1,world:'citadel'}]},
  { n: 37, world:'citadel',  line:'The Siege Plan',      title:'Steal the enemy siege plans from their forward camp and return safely', credits:1400, dur:1440, pre:['Citadel Defender'], notes:'Complex — 1 day. Requires Q36. Deep infiltration behind enemy lines.',
    steps:[{order:1,label:'Infiltrate the enemy forward camp undetected',type:'stealth',target:'enemy_camp',count:1,world:'citadel'},{order:2,label:'Locate the enemy command tent',type:'investigate',target:'command_tent',count:1,world:'citadel'},{order:3,label:'Steal the siege plan documents',type:'collect',target:'siege_plans',count:1,world:'citadel'},{order:4,label:'Escape the camp without raising the alarm',type:'stealth',target:'camp_exit',count:1,world:'citadel'},{order:5,label:'Deliver the siege plans to the Citadel Commander',type:'deliver',target:'citadel_commander',count:1,world:'citadel'}]},
  { n: 38, world:'citadel',  line:'Assassin in the Keep',title:'Find and neutralise the assassin hiding inside the citadel walls',    credits:1000, dur:720,  pre:['Fallen Gate'], notes:'Complex — 12 hr. Requires Q35. Investigation, deduction, and combat.',
    steps:[{order:1,label:'Examine 4 suspicious locations inside the keep',type:'investigate',target:'suspicious_location',count:4,world:'citadel'},{order:2,label:'Question 5 guards and servants about unusual activity',type:'talk',target:'guard_servant',count:5,world:'citadel'},{order:3,label:'Find the hidden passage used by the assassin',type:'investigate',target:'hidden_passage',count:1,world:'citadel'},{order:4,label:"Recover the assassin's kit and written orders",type:'collect',target:'assassin_kit',count:1,world:'citadel'},{order:5,label:'Neutralise the assassin before they reach their target',type:'kill',target:'assassin',count:1,world:'citadel'}]},
  { n: 39, world:'citadel',  line:'The Desert War',      title:'Lead the combined defence and turn the full enemy offensive',          credits:3500, dur:4320, pre:['The Siege Plan','Assassin in the Keep'], notes:'Epic — 3 days. Requires Q37 and Q38. Large-scale battle campaign.',
    steps:[{order:1,label:'Hold the outer wall during the initial enemy push',type:'defend',target:'citadel_outer_wall',count:1,world:'citadel'},{order:2,label:'Destroy 5 enemy siege weapons before the gate is breached',type:'kill',target:'siege_weapon',count:5,world:'citadel'},{order:3,label:'Lead a counter-attack force to flank the enemy',type:'escort',target:'counter_attack_force',count:1,world:'citadel'},{order:4,label:'Reach and hold the enemy command post',type:'defend',target:'enemy_command_post',count:1,world:'citadel'},{order:5,label:'Accept the enemy commander\'s formal surrender',type:'interact',target:'enemy_commander',count:1,world:'citadel'}]},
  { n: 40, world:'citadel',  line:'Warlord of Sunspire', title:'Claim the title of Warlord and establish the Sunspire Pact',         credits:7000, dur:7200, pre:['The Desert War'], notes:'Epic — 5 days. Requires Q39. Capstone; player earns citadel leadership title.',
    steps:[{order:1,label:'Convene the chieftains of all 5 citadel clans',type:'talk',target:'clan_chieftain',count:5,world:'citadel'},{order:2,label:'Survive the traditional trial by combat',type:'defend',target:'combat_trial',count:1,world:'citadel'},{order:3,label:'Forge the Sunspire Pact treaty document',type:'interact',target:'pact_document',count:1,world:'citadel'},{order:4,label:'Deliver the Pact to the four clan elders for signing',type:'deliver',target:'clan_elder',count:4,world:'citadel'},{order:5,label:'Be proclaimed Warlord at the summit of Sunspire Tower',type:'visit',target:'sunspire_tower_summit',count:1,world:'citadel'}]},
  // ── RACE ─────────────────────────────────────────────────────────────────
  { n: 41, world:'race',     line:'First Lap',           title:'Complete one clean lap of the Vellum Ridge Circuit',                   credits:60,   dur:10,   pre:null, notes:'Simple — 10 min. No time pressure; familiarisation lap.',
    steps:[{order:1,label:'Complete one full clean lap of Vellum Ridge Circuit',type:'race',target:'vellum_lap',count:1,world:'race'},{order:2,label:'Check in at the finish line timing booth',type:'visit',target:'timing_booth',count:1,world:'race'}]},
  { n: 42, world:'race',     line:'Pit Crew Basics',     title:'Perform a full tyre-and-fuel stop in under the target time',          credits:80,   dur:20,   pre:null, notes:'Simple — 20 min. Timed button-sequence puzzle.',
    steps:[{order:1,label:'Practice the tyre change sequence 3 times',type:'interact',target:'tyre_change',count:3,world:'race'},{order:2,label:'Practice the fuel stop sequence 3 times',type:'interact',target:'fuel_stop',count:3,world:'race'},{order:3,label:'Execute a complete pit stop within the target time',type:'race',target:'full_pit_stop',count:1,world:'race',time_limit_s:180}]},
  { n: 43, world:'race',     line:'Time Trial',          title:'Post a qualifying time fast enough for the regional grid',             credits:200,  dur:60,   pre:['First Lap'], notes:'Medium — 1 hr. Requires Q41. Three timed attempts to beat the target.',
    steps:[{order:1,label:'Complete a practice lap to learn corner timings',type:'race',target:'practice_lap',count:1,world:'race'},{order:2,label:'Post a timed qualifying attempt (up to 3 chances)',type:'race',target:'qualifying_lap',count:1,world:'race'},{order:3,label:'Confirm qualifying time at the results board',type:'visit',target:'results_board',count:1,world:'race'}]},
  { n: 44, world:'race',     line:"Mechanic's Special",  title:"Diagnose and repair the car's hidden handling fault before the heat",  credits:280,  dur:90,   pre:['Pit Crew Basics'], notes:'Medium — 90 min. Requires Q42. Logic puzzle + test laps.',
    steps:[{order:1,label:'Diagnose the handling fault from 5 possible causes',type:'investigate',target:'handling_fault',count:1,world:'race'},{order:2,label:'Carry out the repair procedure',type:'interact',target:'car_repair',count:1,world:'race'},{order:3,label:'Complete 2 test laps to confirm the fix',type:'race',target:'test_lap',count:2,world:'race'}]},
  { n: 45, world:'race',     line:'Street Circuit Scout',title:'Walk and memorise the city block section of the circuit',             credits:85,   dur:25,   pre:null, notes:'Simple — 25 min. Exploration and waypoint marking.',
    steps:[{order:1,label:'Walk the city block section through 5 marked waypoints',type:'visit',target:'circuit_waypoint',count:5,world:'race'},{order:2,label:'Identify 3 danger zones on the street circuit',type:'investigate',target:'danger_zone',count:3,world:'race'},{order:3,label:'Log your notes at the track marshal station',type:'interact',target:'marshal_station',count:1,world:'race'}]},
  { n: 46, world:'race',     line:'Regional Heat',       title:'Win your regional heat against five AI rivals',                       credits:450,  dur:180,  pre:['Time Trial',"Mechanic's Special"], notes:'Medium — 3 hr. Requires Q43 and Q44. Full race with rival AI scaling.',
    steps:[{order:1,label:'Qualify in practice session (finish in top 6)',type:'race',target:'practice_session',count:1,world:'race'},{order:2,label:'Win Heat A against 5 AI rivals',type:'race',target:'heat_a',count:1,world:'race'},{order:3,label:'Win Heat B against 5 AI rivals',type:'race',target:'heat_b',count:1,world:'race'},{order:4,label:'Win the regional championship race',type:'race',target:'regional_championship',count:1,world:'race'}]},
  { n: 47, world:'race',     line:'Sabotaged Start',     title:'Discover who tampered with your car and clear your name before the race', credits:1100, dur:1440, pre:['Street Circuit Scout'], notes:'Complex — 1 day. Requires Q45. Investigation, alibi checks, confrontation.',
    steps:[{order:1,label:"Examine your car for tampering evidence",type:'investigate',target:'car_tampering',count:1,world:'race'},{order:2,label:'Interview 4 team members about access to the vehicle',type:'talk',target:'team_member',count:4,world:'race'},{order:3,label:'Find 3 pieces of physical evidence at the crime scene',type:'investigate',target:'physical_evidence',count:3,world:'race'},{order:4,label:'Confront the saboteur with your findings',type:'interact',target:'saboteur',count:1,world:'race'},{order:5,label:'Present evidence to the Race Stewards and clear your name',type:'deliver',target:'race_stewards',count:1,world:'race'}]},
  { n: 48, world:'race',     line:'Championship Round',  title:'Finish on the podium in the Vellum Ridge Championship round',         credits:900,  dur:720,  pre:['Regional Heat'], notes:'Complex — 12 hr. Requires Q46. Eight-rival race with full damage model.',
    steps:[{order:1,label:'Post a top-4 qualifying time in the championship session',type:'race',target:'champ_qualifying',count:1,world:'race'},{order:2,label:'Win your qualifying heat',type:'race',target:'champ_heat',count:1,world:'race'},{order:3,label:'Win the semifinal race',type:'race',target:'champ_semifinal',count:1,world:'race'},{order:4,label:'Finish on the podium in the Championship Round main race',type:'race',target:'champ_main_race',count:1,world:'race'}]},
  { n: 49, world:'race',     line:'The Vellum 500',      title:'Endure and win the 500-lap Vellum Ridge endurance race',              credits:2500, dur:2880, pre:['Sabotaged Start','Championship Round'], notes:'Epic — 2 days. Requires Q47 and Q48. Endurance with pit strategy.',
    steps:[{order:1,label:'Complete Stint 1 — laps 1–100 without major incidents',type:'race',target:'vellum500_stint1',count:1,world:'race'},{order:2,label:'Complete Stints 2 and 3 with fuel and tyre pit strategy',type:'race',target:'vellum500_stint2_3',count:2,world:'race'},{order:3,label:'Manage Stints 4 and 5 with fuel conservation mode',type:'race',target:'vellum500_stint4_5',count:2,world:'race'},{order:4,label:'Hold position in the final push against top 3 rivals',type:'defend',target:'final_laps_position',count:1,world:'race'},{order:5,label:'Cross the finish line in first place on lap 500',type:'race',target:'vellum500_finish',count:1,world:'race'}]},
  { n: 50, world:'race',     line:'Nexus Racing Legend', title:'Break the all-time circuit record and earn the Nexus Racing Legend title', credits:5000, dur:5760, pre:['The Vellum 500'], notes:'Epic — 4 days. Requires Q49. Capstone; personal-record across all layouts.',
    steps:[{order:1,label:'Break the circuit sprint record on the short layout',type:'race',target:'sprint_record_lap',count:1,world:'race'},{order:2,label:'Break the endurance circuit record on the full layout',type:'race',target:'endurance_record_lap',count:1,world:'race'},{order:3,label:'Set the all-time overall circuit time record',type:'race',target:'overall_record',count:1,world:'race'},{order:4,label:'Complete the untimed Legend ceremonial lap',type:'race',target:'legend_lap',count:1,world:'race'},{order:5,label:'Attend the Nexus Racing Legend title ceremony',type:'visit',target:'racing_legend_ceremony',count:1,world:'race'}]},
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
      steps            TEXT,
      notes            TEXT,
      is_active        BOOLEAN NOT NULL DEFAULT TRUE,
      updated_by       TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE quests ADD COLUMN IF NOT EXISTS steps TEXT`;
  for (const q of DEFAULT_QUESTS) {
    const preJson  = q.pre   ? JSON.stringify(q.pre)   : null;
    const stepsJson = q.steps ? JSON.stringify(q.steps) : null;
    await sql`
      INSERT INTO quests (id, quest_number, world, quest_line, title, reward_credits,
                          duration_minutes, pre_steps, post_steps, steps, notes, is_active, updated_by)
      VALUES (${randomUUID()}, ${q.n}, ${q.world}, ${q.line}, ${q.title}, ${q.credits},
              ${q.dur}, ${preJson}, ${null}, ${stepsJson}, ${q.notes}, true, 'seed')
      ON CONFLICT (quest_number) DO UPDATE
        SET steps      = EXCLUDED.steps,
            updated_at = NOW()
        WHERE quests.steps IS DISTINCT FROM EXCLUDED.steps
    `;
  }
}

export async function listQuests() {
  await _ensureQuestsSeeded();
  const { rows } = await sql`
    SELECT id, quest_number, world, quest_line, title, reward_credits, duration_minutes,
           pre_steps, post_steps, steps, notes, is_active, updated_by,
           created_at, updated_at
    FROM quests
    ORDER BY quest_number ASC, created_at ASC
  `;
  return rows;
}

export async function getQuestById(id: string) {
  const { rows } = await sql`
    SELECT id, quest_number, world, quest_line, title, reward_credits, duration_minutes,
           pre_steps, post_steps, steps, notes, is_active, updated_by,
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
  steps?: string | null;
  notes?: string | null;
  isActive?: boolean;
  updatedBy?: string;
}) {
  const id = randomUUID();
  await sql`
    INSERT INTO quests (
      id, quest_number, world, quest_line, title, reward_credits,
      duration_minutes, pre_steps, post_steps, steps, notes, is_active, updated_by
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
      ${data.steps ?? null},
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
  steps?: string | null;
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
        steps          = ${data.steps ?? null},
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

export async function resetPlayerQuestEngagement(engagementId: string) {
  await sql`
    DELETE FROM player_quest_engagements
    WHERE id = ${engagementId}
      AND status IN ('completed', 'in_progress')
  `;
}

export async function adjustCredits(playerId: string, delta: number) {
  await sql`
    UPDATE players
    SET    credit_balance = credit_balance + ${delta}, updated_at = NOW()
    WHERE  id = ${playerId}
  `;
}

export async function setPlayerAccessDays(playerId: string, daysRemaining: number) {
  const normalized = Math.max(0, Math.floor(daysRemaining));
  if (normalized === 0) {
    await sql`
      UPDATE players
      SET access_revoked_at = NOW(), updated_at = NOW()
      WHERE id = ${playerId}
    `;
    return;
  }

  const grantedAt = grantedAtForRemainingDays(normalized);
  await sql`
    UPDATE players
    SET access_granted_at = ${grantedAt.toISOString()},
        access_revoked_at = NULL,
        updated_at = NOW()
    WHERE id = ${playerId}
  `;
}

export async function countPlayers(): Promise<number> {
  const { rows } = await sql`SELECT COUNT(*) AS n FROM players`;
  return Number(rows[0]?.n ?? 0);
}

export async function countActivePlayers(): Promise<number> {
  const { rows } = await sql`
    SELECT status, access_granted_at, access_revoked_at
    FROM players
  `;
  return rows.filter((row) => {
    if (String(row.status ?? '').toLowerCase() === 'locked') return false;
    return computePlayerAccessSnapshot(row).hasActiveAccess;
  }).length;
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

export async function listPlayerPurchases(playerId: string) {
  const { rows } = await sql`
    SELECT id, player_id, amount_cents, currency, type, credits_amount, status, created_at
    FROM   purchases
    WHERE  player_id = ${playerId}
    ORDER  BY created_at DESC
  `;
  return rows;
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