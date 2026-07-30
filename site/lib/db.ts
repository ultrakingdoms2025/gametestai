/**
 * Site database layer — user accounts, password resets.
 * Uses the same Neon Postgres connection as the admin via @vercel/postgres.
 */
import { sql } from '@vercel/postgres';
import { hash, compare } from 'bcryptjs';

const BCRYPT_ROUNDS = 12;

// ---------------------------------------------------------------------------
// Schema bootstrap
// ---------------------------------------------------------------------------

export async function ensureSchema() {
  await sql`
    CREATE TABLE IF NOT EXISTS site_users (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email       TEXT UNIQUE NOT NULL,
      email_verified TIMESTAMPTZ,
      password_hash TEXT,
      google_id   TEXT UNIQUE,
      totp_secret TEXT,
      totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS site_password_resets (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     UUID NOT NULL REFERENCES site_users(id) ON DELETE CASCADE,
      token_hash  TEXT NOT NULL,
      expires_at  TIMESTAMPTZ NOT NULL,
      used_at     TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS site_password_resets_user_idx
    ON site_password_resets(user_id)
  `;
}

// ---------------------------------------------------------------------------
// User CRUD
// ---------------------------------------------------------------------------

export type SiteUser = {
  id: string;
  email: string;
  email_verified: Date | null;
  password_hash: string | null;
  google_id: string | null;
  totp_secret: string | null;
  totp_enabled: boolean;
  created_at: Date;
  updated_at: Date;
};

export async function getUserByEmail(email: string): Promise<SiteUser | null> {
  await ensureSchema();
  const { rows } = await sql`
    SELECT * FROM site_users WHERE email = ${email.toLowerCase().trim()} LIMIT 1
  `;
  return (rows[0] as SiteUser) ?? null;
}

export async function getUserById(id: string): Promise<SiteUser | null> {
  await ensureSchema();
  const { rows } = await sql`
    SELECT * FROM site_users WHERE id = ${id} LIMIT 1
  `;
  return (rows[0] as SiteUser) ?? null;
}

export async function getUserByGoogleId(googleId: string): Promise<SiteUser | null> {
  await ensureSchema();
  const { rows } = await sql`
    SELECT * FROM site_users WHERE google_id = ${googleId} LIMIT 1
  `;
  return (rows[0] as SiteUser) ?? null;
}

export async function createUser(opts: {
  email: string;
  password?: string;
  googleId?: string;
}): Promise<SiteUser> {
  await ensureSchema();
  const passwordHash = opts.password ? await hash(opts.password, BCRYPT_ROUNDS) : null;
  const emailVerified = opts.googleId ? new Date() : null; // Google accounts are pre-verified
  const { rows } = await sql`
    INSERT INTO site_users (email, password_hash, google_id, email_verified)
    VALUES (
      ${opts.email.toLowerCase().trim()},
      ${passwordHash},
      ${opts.googleId ?? null},
      ${emailVerified?.toISOString() ?? null}
    )
    RETURNING *
  `;
  return rows[0] as SiteUser;
}

export async function linkGoogleAccount(userId: string, googleId: string): Promise<void> {
  await sql`
    UPDATE site_users
    SET google_id = ${googleId},
        email_verified = COALESCE(email_verified, now()),
        updated_at = now()
    WHERE id = ${userId}
  `;
}

export async function verifyPassword(user: SiteUser, password: string): Promise<boolean> {
  if (!user.password_hash) return false;
  return compare(password, user.password_hash);
}

export async function setPassword(userId: string, password: string): Promise<void> {
  const passwordHash = await hash(password, BCRYPT_ROUNDS);
  await sql`
    UPDATE site_users
    SET password_hash = ${passwordHash}, updated_at = now()
    WHERE id = ${userId}
  `;
}

export async function setTotpSecret(userId: string, secret: string | null, enabled = false): Promise<void> {
  await sql`
    UPDATE site_users
    SET totp_secret = ${secret}, totp_enabled = ${enabled}, updated_at = now()
    WHERE id = ${userId}
  `;
}

// ---------------------------------------------------------------------------
// Password reset tokens
// ---------------------------------------------------------------------------

export async function createPasswordReset(userId: string, tokenHash: string): Promise<void> {
  await sql`
    DELETE FROM site_password_resets WHERE user_id = ${userId} AND used_at IS NULL
  `;
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60); // 1 hour
  await sql`
    INSERT INTO site_password_resets (user_id, token_hash, expires_at)
    VALUES (${userId}, ${tokenHash}, ${expiresAt.toISOString()})
  `;
}

export async function consumePasswordReset(tokenHash: string): Promise<string | null> {
  const { rows } = await sql`
    SELECT id, user_id, expires_at, used_at
    FROM site_password_resets
    WHERE token_hash = ${tokenHash}
      AND used_at IS NULL
      AND expires_at > now()
    LIMIT 1
  `;
  if (!rows[0]) return null;
  await sql`
    UPDATE site_password_resets SET used_at = now() WHERE id = ${rows[0].id}
  `;
  return rows[0].user_id as string;
}
