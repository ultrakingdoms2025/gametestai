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

export async function listQuests() {
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