/**
 * Site database layer -- user accounts, password resets.
 * Uses raw pg (node-postgres) so any Postgres URL format works,
 * including Neon direct connection strings.
 */
import { Client } from 'pg';
import { createHmac, randomBytes } from 'node:crypto';
import { hash, compare } from 'bcryptjs';
import { appSecret } from './appSecret';
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

  /* Columns added to an existing table, the way `mapOverlay.ts` and
   * `customServers.ts` do it: `ADD COLUMN IF NOT EXISTS` with a DEFAULT, so
   * deploying this against a database that already has rows is a no-op rather
   * than a migration anybody has to run. */

  /* WHERE AN ENROLMENT IN PROGRESS LIVES.
   *
   * `totp_secret` used to be the only column, and enrolment wrote a brand-new
   * secret straight into it before the user had proved they could read a code.
   * Two consequences, and the second is the serious one:
   *
   *   - an abandoned setup left a secret nobody's phone had, so the account had
   *     a `totp_secret` that could never verify;
   *   - starting an enrolment SET `totp_enabled = false`, so merely reaching
   *     the endpoint stripped a working second factor off the account. Since it
   *     was a GET, that was a link.
   *
   * A pending secret is therefore kept apart from the live one and only
   * promoted by `promoteTotpSecret` once a code has verified against it. The
   * working secret is never touched by an enrolment that has not finished. */
  await query(`ALTER TABLE site_users ADD COLUMN IF NOT EXISTS totp_pending_secret TEXT`);

  /* THE TOKEN GENERATION, FOR INVALIDATION.
   *
   * Sessions are JWTs, which are self-contained by definition: nothing the
   * server does to a row can reach a token already in someone's cookie jar. So
   * a password reset, a 2FA enrolment and a 2FA removal all left every existing
   * session signed in -- including the attacker's, which is the session the
   * reset was performed to get rid of.
   *
   * The token carries this number; `lib/auth.ts` compares it on every session
   * read and refuses a mismatch. Bumping it is therefore "sign every device
   * out", and every credential change bumps it. */
  await query(`ALTER TABLE site_users ADD COLUMN IF NOT EXISTS session_epoch INTEGER NOT NULL DEFAULT 1`);

  /* RECOVERY CODES.
   *
   * Without these a lost phone was a permanent lockout, and the de-facto escape
   * was Google sign-in on the same address -- which is to say the escape hatch
   * was a 2FA bypass. See `lib/auth.ts`.
   *
   * Stored as an HMAC, never in the clear, for the same reason `totp_secret` is
   * sealed: a readable row is a working second factor for anyone who reads it.
   * A hash rather than the reversible seal, because nothing ever needs to
   * DISPLAY a code again -- they are shown once, at enrolment, and afterwards
   * only ever compared. */
  await query(`
    CREATE TABLE IF NOT EXISTS site_totp_recovery_codes (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    UUID NOT NULL REFERENCES site_users(id) ON DELETE CASCADE,
      code_hash  TEXT NOT NULL,
      used_at    TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  /* Single-use is enforced by `used_at IS NULL` in the consuming UPDATE, and
   * the UNIQUE index is what stops one code being enrolled twice for the same
   * account -- otherwise a duplicate would consume one row and leave the other
   * standing, which is a code that works twice. */
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS site_totp_recovery_codes_idx
      ON site_totp_recovery_codes(user_id, code_hash)
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
  /** An enrolment that has not yet proved itself. Never consulted at sign-in. */
  totp_pending_secret: string | null;
  /** Bumped by every credential change; pinned into the JWT. See `lib/auth.ts`. */
  session_epoch: number;
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

/**
 * Set a password, and sign every existing session out.
 *
 * The epoch bump is the whole point of the second column. A password reset that
 * leaves old JWTs valid does not evict anybody -- so the session an attacker is
 * holding survives the reset performed specifically to remove it, for as long
 * as the token lives. `lib/auth.ts` refuses a token whose epoch has moved.
 */
export async function setPassword(userId: string, password: string): Promise<void> {
  await ensureSchema();
  const passwordHash = await hash(password, BCRYPT_ROUNDS);
  await query(
    `UPDATE site_users
        SET password_hash = $1, session_epoch = session_epoch + 1, updated_at = now()
      WHERE id = $2`,
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
  await ensureSchema();
  /* Changing the second factor signs the other devices out, for the same reason
   * changing the password does: whoever is holding a session obtained with the
   * OLD factor should not keep it across the change. */
  await query(
    `UPDATE site_users
        SET totp_secret = $1, totp_enabled = $2, totp_pending_secret = NULL,
            session_epoch = session_epoch + 1, updated_at = now()
      WHERE id = $3`,
    [seal(secret), enabled, userId]
  );
}

/**
 * Park a new secret for an enrolment that has not been confirmed.
 *
 * Writes ONLY `totp_pending_secret`. Nothing about a working second factor
 * moves, which is the difference between this and what enrolment used to do --
 * see the column's comment in `ensureSchema`.
 */
export async function setPendingTotpSecret(userId: string, secret: string): Promise<void> {
  await ensureSchema();
  await query(
    'UPDATE site_users SET totp_pending_secret = $1, updated_at = now() WHERE id = $2',
    [seal(secret), userId]
  );
}

/** The in-progress enrolment's secret, unsealed, or null. */
export function readPendingTotpSecret(user: { totp_pending_secret: string | null } | null): string | null {
  try {
    return unseal(user?.totp_pending_secret ?? null);
  } catch (err) {
    console.error('[db] could not open a pending TOTP secret:', (err as Error)?.message);
    return null;
  }
}

/**
 * Promote a verified enrolment to the live second factor, and issue its
 * recovery codes, in ONE transaction.
 *
 * Atomic on purpose: an account that ends up with `totp_enabled = true` and no
 * recovery codes is one lost phone away from a permanent lockout, and that is
 * precisely the state a crash between two separate statements would leave.
 */
export async function promoteTotpSecret(
  userId: string,
  secret: string,
  recoveryCodes: string[]
): Promise<void> {
  await ensureSchema();
  const client = makeClient();
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE site_users
          SET totp_secret = $1, totp_enabled = TRUE, totp_pending_secret = NULL,
              session_epoch = session_epoch + 1, updated_at = now()
        WHERE id = $2`,
      [seal(secret), userId]
    );
    // A fresh enrolment starts with a fresh set; any survivor of an earlier one
    // would be a code for a secret that no longer exists.
    await client.query('DELETE FROM site_totp_recovery_codes WHERE user_id = $1', [userId]);
    for (const code of recoveryCodes) {
      await client.query(
        `INSERT INTO site_totp_recovery_codes (user_id, code_hash) VALUES ($1, $2)
         ON CONFLICT (user_id, code_hash) DO NOTHING`,
        [userId, hashRecoveryCode(code)]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

/**
 * Turn the second factor off completely, codes included.
 *
 * The codes go with it. Leaving them behind would mean a later re-enrolment
 * inherited codes minted against a secret that no longer exists, and -- worse
 * -- that the codes printed before 2FA was switched off would still be accepted
 * the moment it was switched back on.
 */
export async function clearTotp(userId: string): Promise<void> {
  await ensureSchema();
  await query(
    `UPDATE site_users
        SET totp_secret = NULL, totp_enabled = FALSE, totp_pending_secret = NULL,
            session_epoch = session_epoch + 1, updated_at = now()
      WHERE id = $1`,
    [userId]
  );
  await query('DELETE FROM site_totp_recovery_codes WHERE user_id = $1', [userId]);
}

// ---------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------

/** How many codes an enrolment issues. */
export const RECOVERY_CODE_COUNT = 8;

/* Crockford-ish base32 minus the characters people mis-copy: no I, L, O, U, 0
 * or 1. A recovery code is read off a screen and typed back months later, under
 * stress, by somebody who has just lost their phone. */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

/**
 * A code, as it is shown to the user: two groups of five.
 *
 * ~49 bits of entropy each. Guessing one is not a threat model that the rate
 * limiter in front of sign-in leaves open, but there is no reason to be mean
 * with random bytes.
 */
function newRecoveryCode(): string {
  const bytes = randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i++) {
    out += RECOVERY_ALPHABET[bytes[i] % RECOVERY_ALPHABET.length];
    if (i === 4) out += '-';
  }
  return out;
}

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, newRecoveryCode);
}

/**
 * Compare and store form: uppercased, with everything that is not a code
 * character removed.
 *
 * So the dash, a stray space, and lower case all resolve to the same code. A
 * user who types what they were shown must not be told it is wrong because they
 * left the hyphen out.
 */
function normalizeRecoveryCode(raw: string): string {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Keyed hash, matching the pattern `forgot-password` already uses for reset
 * tokens: HMAC with the app secret rather than a bare digest, so the column is
 * useless to somebody holding a stolen dump and a rainbow table.
 */
export function hashRecoveryCode(raw: string): string {
  return createHmac('sha256', appSecret()).update(normalizeRecoveryCode(raw)).digest('hex');
}

/**
 * Spend one recovery code, or report that it was not one.
 *
 * ── Single use is the database's job, not a read-then-write ───────────────
 *
 * The UPDATE's own `used_at IS NULL` predicate is what makes a code
 * single-use: two sign-in attempts arriving together both pass a prior SELECT,
 * and only one can match this. `RETURNING` says which.
 *
 * A code is never compared as a string in this process either -- the hash is
 * the lookup key, so the comparison is the index's, and there is nothing here
 * for a timing attack to measure.
 */
export async function consumeRecoveryCode(userId: string, raw: string): Promise<boolean> {
  const normalized = normalizeRecoveryCode(raw);
  if (normalized.length < 8) return false;
  await ensureSchema();
  const { rows } = await query<{ id: string }>(
    `UPDATE site_totp_recovery_codes
        SET used_at = now()
      WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
      RETURNING id`,
    [userId, hashRecoveryCode(normalized)]
  );
  return !!rows[0];
}

/** How many codes are left, for the account page to warn on. */
export async function countUnusedRecoveryCodes(userId: string): Promise<number> {
  await ensureSchema();
  const { rows } = await query<{ n: string }>(
    `SELECT COUNT(*)::int AS n FROM site_totp_recovery_codes
      WHERE user_id = $1 AND used_at IS NULL`,
    [userId]
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Whether a string is SHAPED like a recovery code rather than a TOTP token.
 *
 * Used at sign-in to decide which check to run. A TOTP token is exactly six
 * digits; a recovery code is ten characters from an alphabet with no digits-only
 * spelling, so the two cannot be confused -- and `timingSafeEqual` is not needed
 * to tell them apart because the shape is not a secret.
 */
export function looksLikeRecoveryCode(raw: string): boolean {
  const normalized = normalizeRecoveryCode(raw);
  return normalized.length === 10 && !/^\d+$/.test(normalized);
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