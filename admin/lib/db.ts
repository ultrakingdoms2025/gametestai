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
      email_hash          TEXT UNIQUE,              -- sha256(lower(email))
      email_enc           TEXT,                     -- AES-256-GCM
      stripe_customer_enc TEXT,                     -- AES-256-GCM
      access_granted_at   TIMESTAMPTZ,
      access_revoked_at   TIMESTAMPTZ,
      credit_balance      INTEGER NOT NULL DEFAULT 0,
      notes               TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
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

// ── Players ────────────────────────────────────────────────────────────────

const PAGE_SIZE = 50;

export async function listPlayers(page = 0, search?: string) {
  const offset = page * PAGE_SIZE;
  if (search) {
    const h = sha256(search); // search by email hash
    const { rows } = await sql`
      SELECT id, email_hash, access_granted_at, access_revoked_at,
             credit_balance, notes, created_at, updated_at
      FROM   players
      WHERE  email_hash = ${h}
      ORDER  BY created_at DESC
      LIMIT  ${PAGE_SIZE} OFFSET ${offset}
    `;
    return rows;
  }
  const { rows } = await sql`
    SELECT id, email_hash, access_granted_at, access_revoked_at,
           credit_balance, notes, created_at, updated_at
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
    LIMIT  1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    ...row,
    email:              decryptMaybe(row.email_enc),
    stripe_customer_id: decryptMaybe(row.stripe_customer_enc),
  };
}

export async function findPlayerByEmail(email: string) {
  const h = sha256(email);
  const { rows } = await sql`
    SELECT id FROM players WHERE email_hash = ${h} LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function upsertPlayer(data: {
  id?:              string;
  email?:           string;
  stripeCustomerId?: string;
  accessGranted?:   boolean;
  creditDelta?:     number;
  notes?:           string;
}) {
  const id         = data.id ?? randomUUID();
  const emailHash  = data.email ? sha256(data.email) : null;
  const emailEnc   = encryptMaybe(data.email);
  const stripeEnc  = encryptMaybe(data.stripeCustomerId);
  const delta      = data.creditDelta ?? 0;

  const { rows } = await sql`
    INSERT INTO players
      (id, email_hash, email_enc, stripe_customer_enc, access_granted_at, credit_balance, notes)
    VALUES (
      ${id},
      ${emailHash},
      ${emailEnc},
      ${stripeEnc},
      ${data.accessGranted ? 'NOW()' : null},
      ${delta},
      ${data.notes ?? null}
    )
    ON CONFLICT (id) DO UPDATE SET
      email_hash          = COALESCE(EXCLUDED.email_hash,          players.email_hash),
      email_enc           = COALESCE(EXCLUDED.email_enc,           players.email_enc),
      stripe_customer_enc = COALESCE(EXCLUDED.stripe_customer_enc, players.stripe_customer_enc),
      access_granted_at   = CASE
        WHEN ${data.accessGranted === true}  AND players.access_granted_at IS NULL THEN NOW()
        ELSE players.access_granted_at
      END,
      access_revoked_at   = CASE
        WHEN ${data.accessGranted === false} THEN NOW()
        ELSE players.access_revoked_at
      END,
      credit_balance      = players.credit_balance + ${delta},
      notes               = COALESCE(${data.notes ?? null}, players.notes),
      updated_at          = NOW()
    RETURNING id
  `;
  return rows[0].id as string;
}

export async function revokeAccess(playerId: string) {
  await sql`
    UPDATE players
    SET    access_revoked_at = NOW(), updated_at = NOW()
    WHERE  id = ${playerId}
  `;
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