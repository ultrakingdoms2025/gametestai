/**
 * Bridge between the site and the shared admin database.
 * Handles player creation/lookup, purchase recording, and audit log entries.
 * Uses raw pg (not @vercel/postgres) to support direct Neon connection strings.
 */
import { Client } from 'pg';
import { createCipheriv, createHmac, createHash, randomBytes, randomUUID } from 'node:crypto';

function makeClient() {
  const connStr = process.env.POSTGRES_URL ?? '';
  const ssl = connStr.includes('sslmode=disable') ? false : { rejectUnauthorized: false };
  return new Client({ connectionString: connStr, ssl });
}

async function pgQuery<T = Record<string, unknown>>(
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
// Schema helpers
// ---------------------------------------------------------------------------

let playerSchemaDone = false;

export async function ensurePlayerColumns() {
  if (playerSchemaDone) return;
  await pgQuery(`ALTER TABLE players ADD COLUMN IF NOT EXISTS site_user_id TEXT UNIQUE`);
  playerSchemaDone = true;
}

// ---------------------------------------------------------------------------
// Crypto helpers (mirror admin/lib/hmac.ts and admin/lib/encrypt.ts)
// ---------------------------------------------------------------------------

function sha256(input: string): string {
  return createHash('sha256').update(input.toLowerCase().trim()).digest('hex');
}

function hmacSign(data: string): string {
  const s = process.env.HMAC_SECRET;
  if (!s) return createHmac('sha256', 'fallback').update(data).digest('hex');
  return createHmac('sha256', s).update(data, 'utf8').digest('hex');
}

function encryptionKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error('ENCRYPTION_KEY env var is not set');
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('ENCRYPTION_KEY must decode to 32 bytes');
  return buf;
}

function encryptMaybe(value: string | null | undefined): string | null {
  if (!value) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${ct.toString('hex')}:${tag.toString('hex')}`;
}

function auditHash(seq: number, actor: string, action: string, resource: string, prevHash: string): string {
  return hmacSign([seq, actor, action, resource, prevHash].join('|'));
}

// ---------------------------------------------------------------------------
// Player lookup / creation
// ---------------------------------------------------------------------------

export type PlayerStatus = {
  playerId: string;
  creditBalance: number;
  accessGrantedAt: Date | null;
  accessRevokedAt: Date | null;
  hasAccess: boolean;
  daysRemaining: number;
  handle: string | null;
  fullName: string | null;
  status: string | null;
};

const ACCESS_DAYS = 30;
const HANDLE_MAX = 32;

export function normalizeHandle(input: string): string {
  return input
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^A-Za-z0-9 _-]/g, '')
    .slice(0, HANDLE_MAX)
    .trim();
}

async function isHandleTaken(handle: string, excludePlayerId?: string): Promise<boolean> {
  const { rows } = await pgQuery<{ id: string }>(
    `SELECT id
     FROM players
     WHERE LOWER(handle) = LOWER($1)
       AND ($2::text IS NULL OR id <> $2)
     LIMIT 1`,
    [handle, excludePlayerId ?? null]
  );
  return !!rows[0];
}

async function resolveHandle(handle: string, excludePlayerId?: string, autoAdjust = false): Promise<string> {
  const normalized = normalizeHandle(handle);
  if (normalized.length < 3) throw new Error('Handle must be at least 3 characters.');
  if (!(await isHandleTaken(normalized, excludePlayerId))) return normalized;
  if (!autoAdjust) throw new Error('That handle is already in use.');

  const base = normalized.slice(0, HANDLE_MAX);
  for (let suffix = 2; suffix < 1000; suffix++) {
    const suffixText = `-${suffix}`;
    const candidate = `${base.slice(0, HANDLE_MAX - suffixText.length)}${suffixText}`;
    if (!(await isHandleTaken(candidate, excludePlayerId))) return candidate;
  }
  throw new Error('Could not generate a unique handle.');
}

export async function isHandleAvailable(handle: string, excludePlayerId?: string): Promise<boolean> {
  const normalized = normalizeHandle(handle);
  if (normalized.length < 3) return false;
  return !(await isHandleTaken(normalized, excludePlayerId));
}

export async function findOrCreatePlayer(siteUserId: string, email: string): Promise<string> {
  await ensurePlayerColumns();

  // 1. Look up by site_user_id
  const { rows: bySiteId } = await pgQuery<{ id: string }>(
    'SELECT id FROM players WHERE site_user_id = $1 LIMIT 1',
    [siteUserId]
  );
  if (bySiteId[0]) return bySiteId[0].id;

  // 2. Look up by email hash and link
  const emailHash = sha256(email);
  const { rows: byEmail } = await pgQuery<{ id: string }>(
    'SELECT id FROM players WHERE email_hash = $1 LIMIT 1',
    [emailHash]
  );
  if (byEmail[0]) {
    await pgQuery(
      'UPDATE players SET site_user_id = $1, updated_at = NOW() WHERE id = $2',
      [siteUserId, byEmail[0].id]
    );
    return byEmail[0].id;
  }

  // 3. Create new player record
  const id = randomUUID();
  await pgQuery(
    `INSERT INTO players (id, email_hash, site_user_id, auth_provider, status)
     VALUES ($1, $2, $3, 'site_oauth', 'active')`,
    [id, emailHash, siteUserId]
  );
  return id;
}

export async function getPlayerStatus(siteUserId: string): Promise<PlayerStatus | null> {
  const { rows } = await pgQuery<{
    id: string;
    credit_balance: number;
    access_granted_at: string | null;
    access_revoked_at: string | null;
    status: string | null;
    handle: string | null;
    full_name: string | null;
  }>(
    `SELECT id, credit_balance, access_granted_at, access_revoked_at, status, handle, full_name
     FROM players
     WHERE site_user_id = $1
     LIMIT 1`,
    [siteUserId]
  );
  if (!rows[0]) return null;

  const { id, credit_balance, access_granted_at, access_revoked_at, status, handle, full_name } = rows[0];
  const now = Date.now();
  let hasAccess = false;
  let daysRemaining = 0;

  if (access_granted_at && !access_revoked_at && String(status ?? '').toLowerCase() !== 'locked') {
    const grantedMs = new Date(access_granted_at).getTime();
    const expiryMs = grantedMs + ACCESS_DAYS * 24 * 60 * 60 * 1000;
    hasAccess = now < expiryMs;
    if (hasAccess) daysRemaining = Math.ceil((expiryMs - now) / (24 * 60 * 60 * 1000));
  }

  return {
    playerId: id,
    creditBalance: credit_balance,
    accessGrantedAt: access_granted_at ? new Date(access_granted_at) : null,
    accessRevokedAt: access_revoked_at ? new Date(access_revoked_at) : null,
    hasAccess,
    daysRemaining,
    handle,
    fullName: full_name,
    status,
  };
}

export async function syncPlayerProfile(
  siteUserId: string,
  email: string,
  opts: {
    handle?: string | null;
    fullName?: string | null;
    autoAdjustHandle?: boolean;
    overwrite?: boolean;
  } = {}
): Promise<string> {
  const playerId = await findOrCreatePlayer(siteUserId, email);
  const { rows } = await pgQuery<{ handle: string | null; full_name: string | null }>(
    'SELECT handle, full_name FROM players WHERE id = $1 LIMIT 1',
    [playerId]
  );
  const current = rows[0] ?? { handle: null, full_name: null };

  const fullName = opts.fullName?.trim() ? opts.fullName.trim().slice(0, 80) : null;
  const wantsHandle = typeof opts.handle === 'string';
  const resolvedHandle = wantsHandle
    ? await resolveHandle(opts.handle ?? '', playerId, opts.autoAdjustHandle === true)
    : null;

  await pgQuery(
    `UPDATE players
     SET email_hash = $1,
         email_enc = $2,
         handle = $3,
         full_name = $4,
         updated_at = NOW()
     WHERE id = $5`,
    [
      sha256(email),
      encryptMaybe(email),
      wantsHandle
        ? (opts.overwrite || !current.handle ? resolvedHandle : current.handle)
        : current.handle,
      fullName && (opts.overwrite || !current.full_name) ? fullName : current.full_name,
      playerId,
    ]
  );

  return playerId;
}

export async function setPlayerCreditBalance(siteUserId: string, credits: number): Promise<void> {
  await pgQuery(
    `UPDATE players
     SET credit_balance = $1, updated_at = NOW()
     WHERE site_user_id = $2`,
    [Math.max(0, Math.floor(credits)), siteUserId]
  );
}

// ---------------------------------------------------------------------------
// Purchase recording
// ---------------------------------------------------------------------------

export async function recordSitePurchase(opts: {
  playerId: string;
  type: 'access' | 'credits' | 'access+credits';
  amountCents: number;
  creditsAmount: number;
  orderId: string;
  actorEmail: string;
}): Promise<void> {
  const purchaseType = opts.type === 'access+credits' ? 'access' : opts.type;

  // Idempotent: skip if this orderId already recorded
  const { rows: existing } = await pgQuery<{ id: string }>(
    'SELECT id FROM purchases WHERE stripe_intent_enc = $1 LIMIT 1',
    [opts.orderId]
  );
  if (existing[0]) return;

  const purchaseId = randomUUID();
  await pgQuery(
    `INSERT INTO purchases (id, player_id, stripe_intent_enc, amount_cents, currency, type, credits_amount, status)
     VALUES ($1, $2, $3, $4, 'usd', $5, $6, 'completed')`,
    [
      purchaseId, opts.playerId, opts.orderId,
      opts.amountCents, purchaseType,
      opts.creditsAmount > 0 ? opts.creditsAmount : null,
    ]
  );

  // Grant access (30-day window from now)
  if (opts.type === 'access' || opts.type === 'access+credits') {
    await pgQuery(
      `UPDATE players
       SET access_granted_at = NOW(), access_revoked_at = NULL, updated_at = NOW()
       WHERE id = $1`,
      [opts.playerId]
    );
  }

  // Add credits to balance
  if (opts.creditsAmount > 0) {
    await pgQuery(
      `UPDATE players SET credit_balance = credit_balance + $1, updated_at = NOW() WHERE id = $2`,
      [opts.creditsAmount, opts.playerId]
    );
  }

  // Write audit entry
  const detail = JSON.stringify({
    type: opts.type,
    amountCents: opts.amountCents,
    creditsAmount: opts.creditsAmount || 0,
    orderId: opts.orderId,
  });
  await siteAudit(
    opts.actorEmail,
    opts.type === 'credits' ? 'purchase.credits' : 'purchase.access',
    `player:${opts.playerId}`,
    detail
  );
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export async function siteAudit(
  actor: string,
  action: string,
  resource: string,
  detail?: string
): Promise<void> {
  try {
    const id = randomUUID();
    const { rows: last } = await pgQuery<{ seq: string; entry_hash: string }>(
      'SELECT seq, entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1'
    );
    const prevHash = last[0]?.entry_hash ?? hmacSign('genesis');
    const prevSeq = Number(last[0]?.seq ?? 0);
    const hash = auditHash(prevSeq + 1, actor, action, resource, prevHash);

    await pgQuery(
      `INSERT INTO audit_log (id, prev_hash, entry_hash, actor, action, resource, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, prevHash, hash, actor, action, resource, detail ?? null]
    );
  } catch (err) {
    // Audit failures must never block the purchase flow
    console.error('[siteAudit] Failed to write audit entry:', err);
  }
}

// ---------------------------------------------------------------------------
// Player purchases list (for admin display)
// ---------------------------------------------------------------------------

export async function listPlayerPurchasesBySiteUser(siteUserId: string) {
  const { rows } = await pgQuery<{
    id: string;
    type: string;
    amount_cents: number;
    credits_amount: number | null;
    status: string;
    created_at: string;
  }>(
    `SELECT pu.id, pu.type, pu.amount_cents, pu.credits_amount, pu.status, pu.created_at
     FROM purchases pu
     JOIN players pl ON pl.id = pu.player_id
     WHERE pl.site_user_id = $1
     ORDER BY pu.created_at DESC`,
    [siteUserId]
  );
  return rows;
}