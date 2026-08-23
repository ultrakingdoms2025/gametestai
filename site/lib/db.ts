/**
 * Site database layer -- user accounts, password resets.
 * Uses raw pg (node-postgres) so any Postgres URL format works,
 * including Neon direct connection strings.
 */
import { Client } from 'pg';
import { hash, compare } from 'bcryptjs';
// `open` is aliased: unaliased it resolves to the DOM's window.open in this
// project's lib set, and the mistake typechecks.
import { seal, open as unseal } from './secretBox';

const BCRYPT_ROUNDS = 12;

function makeClient() {
  const connStr = process.env.POSTGRES_URL ?? '';
  // Neon (and most managed Postgres) requires SSL; add it unless already in the URL
  const ssl = connStr.includes('sslmode=disable') ? false : { rejectUnauthorized: false };
  return new Client({ connectionString: connStr, ssl });
}

async function query<T extends Record<string, unknown>>(
  text: string,
  values?: unknown[]
): Promise<{ rows: T[] }> {
  const client = makeClient();
  await client.connect();
  try {
    const result = await client.query(text, values);
    return { rows: result.rows as T[] };
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// Schema bootstrap
// ---------------------------------------------------------------------------

let schemaEnsured = false;

export async function ensureSchema() {
  if (schemaEnsured) return;
  await query(`
    CREATE TABLE IF NOT EXISTS site_users (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email         TEXT UNIQUE NOT NULL,
      email_verified TIMESTAMPTZ,
      password_hash TEXT,
      google_id     TEXT UNIQUE,
      totp_secret   TEXT,
      totp_enabled  BOOLEAN NOT NULL DEFAULT FALSE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS site_password_resets (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     UUID NOT NULL REFERENCES site_users(id) ON DELETE CASCADE,
      token_hash  TEXT NOT NULL,
      expires_at  TIMESTAMPTZ NOT NULL,
      used_at     TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS site_password_resets_user_idx
    ON site_password_resets(user_id)
  `);
  schemaEnsured = true;
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
  const { rows } = await query<SiteUser>(
    'SELECT * FROM site_users WHERE email = $1 LIMIT 1',
    [email.toLowerCase().trim()]
  );
  return rows[0] ?? null;
}

export async function getUserById(id: string): Promise<SiteUser | null> {
  await ensureSchema();
  const { rows } = await query<SiteUser>(
    'SELECT * FROM site_users WHERE id = $1 LIMIT 1',
    [id]
  );
  return rows[0] ?? null;
}

export async function getUserByGoogleId(googleId: string): Promise<SiteUser | null> {
  await ensureSchema();
  const { rows } = await query<SiteUser>(
    'SELECT * FROM site_users WHERE google_id = $1 LIMIT 1',
    [googleId]
  );
  return rows[0] ?? null;
}

export async function createUser(opts: {
  email: string;
  password?: string;
  googleId?: string;
}): Promise<SiteUser> {
  await ensureSchema();
  const passwordHash = opts.password ? await hash(opts.password, BCRYPT_ROUNDS) : null;
  const emailVerified = opts.googleId ? new Date().toISOString() : null;
  const { rows } = await query<SiteUser>(
    `INSERT INTO site_users (email, password_hash, google_id, email_verified)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [opts.email.toLowerCase().trim(), passwordHash, opts.googleId ?? null, emailVerified]
  );
  return rows[0];
}

export async function linkGoogleAccount(userId: string, googleId: string): Promise<void> {
  await query(
    `UPDATE site_users
     SET google_id = $1, email_verified = COALESCE(email_verified, now()), updated_at = now()
     WHERE id = $2`,
    [googleId, userId]
  );
}

export async function verifyPassword(user: SiteUser, password: string): Promise<boolean> {
  if (!user.password_hash) return false;
  return compare(password, user.password_hash);
}

export async function setPassword(userId: string, password: string): Promise<void> {
  const passwordHash = await hash(password, BCRYPT_ROUNDS);
  await query(
    'UPDATE site_users SET password_hash = $1, updated_at = now() WHERE id = $2',
    [passwordHash, userId]
  );
}

export async function updateUserEmail(userId: string, email: string): Promise<void> {
  await query(
    'UPDATE site_users SET email = $1, updated_at = now() WHERE id = $2',
    [email.toLowerCase().trim(), userId]
  );
}

/**
 * Store a TOTP secret, sealed.
 *
 * It used to go in as cleartext, next to columns the admin app encrypts and
 * describes as "encrypted at rest". A TOTP secret is worth more than the email
 * beside it: it IS the second factor, so anyone who reads the row can mint
 * valid codes for that account indefinitely. Read it back with `getTotpSecret`,
 * which also passes through the plaintext secrets written before this.
 */
export async function setTotpSecret(userId: string, secret: string | null, enabled = false): Promise<void> {
  await query(
    'UPDATE site_users SET totp_secret = $1, totp_enabled = $2, updated_at = now() WHERE id = $3',
    [seal(secret), enabled, userId]
  );
}

/**
 * The usable secret for a user, whether it was stored sealed or in the clear.
 *
 * Legacy plaintext is accepted rather than rejected: every secret written
 * before sealing existed is raw, and refusing those would lock every current
 * 2FA user out at their next sign-in. They re-seal on the next write.
 */
export function readTotpSecret(user: { totp_secret: string | null } | null): string | null {
  try {
    return unseal(user?.totp_secret ?? null);
  } catch (err) {
    console.error('[db] could not open a stored TOTP secret:', (err as Error)?.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Password reset tokens
// ---------------------------------------------------------------------------

export async function createPasswordReset(userId: string, tokenHash: string): Promise<void> {
  await query(
    'DELETE FROM site_password_resets WHERE user_id = $1 AND used_at IS NULL',
    [userId]
  );
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60).toISOString();
  await query(
    'INSERT INTO site_password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [userId, tokenHash, expiresAt]
  );
}

export async function consumePasswordReset(tokenHash: string): Promise<string | null> {
  const { rows } = await query<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM site_password_resets
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
     LIMIT 1`,
    [tokenHash]
  );
  if (!rows[0]) return null;
  await query(
    'UPDATE site_password_resets SET used_at = now() WHERE id = $1',
    [rows[0].id]
  );
  return rows[0].user_id;
}