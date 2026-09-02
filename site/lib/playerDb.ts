/**
 * Bridge between the site and the shared admin database.
 * Handles player creation/lookup, purchase recording, and audit log entries.
 * Uses raw pg (not @vercel/postgres) to support direct Neon connection strings.
 */
import { Client } from 'pg';
import { createCipheriv, createHmac, createHash, randomBytes, randomUUID } from 'node:crypto';
import { creditInTransaction, ensureCreditSchema, ensureOpeningBalance } from './creditLedger';
import { earnServerCredits } from './serverCredits';
import { checkGameState } from './gameStateShape';

function makeClient() {
  const connStr = process.env.POSTGRES_URL ?? '';
  const ssl = connStr.includes('sslmode=disable') ? false : { rejectUnauthorized: false };
  return new Client({ connectionString: connStr, ssl });
}

async function pgQuery<T = Record<string, unknown>>(
  text: string,
  values?: unknown[]
): Promise<{ rows: T[]; rowCount: number }> {
  const client = makeClient();
  await client.connect();
  try {
    const result = await client.query(text, values);
    // `rowCount` matters for conditional UPDATEs, where "matched nothing" is the
    // answer rather than an error - see `findOrCreatePlayer`.
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
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

/**
 * Throws when `HMAC_SECRET` is missing, exactly as `admin/lib/hmac.ts:5` does.
 *
 * This used to fall back to the literal string 'fallback', which is worse than
 * failing in a way that is easy to miss: the audit rows it signs are
 * well-formed and land in the same chained `audit_log` the admin app verifies.
 * `verifyAuditChain()` would then fail at the first site-written row and stay
 * failed for every row after it, and the reported cause would be tamper
 * detection rather than a missing environment variable.
 *
 * `siteAudit` already catches and logs, so a missing secret costs an audit row
 * and never a player's request.
 */
function hmacSign(data: string): string {
  const s = process.env.HMAC_SECRET;
  if (!s) throw new Error('HMAC_SECRET env var is not set');
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

/**
 * Is this email already spoken for by a DIFFERENT player row?
 *
 * `players.email_hash` is UNIQUE, and `site_users.email` is UNIQUE, and until
 * now only the second was checked before an email change. So a user could pick
 * an address that no site account held but that an admin-created player row
 * did: `updateUserEmail` committed against `site_users`, the follow-up UPDATE
 * against `players` raised 23505, the route 500'd, and the two tables were left
 * permanently disagreeing about that person's email - with no path back, since
 * the next attempt collides on the site table instead.
 *
 * Both uniqueness rules have to be checked before either is written.
 */
export async function isEmailClaimedByOtherPlayer(
  email: string,
  exceptPlayerId?: string | null
): Promise<boolean> {
  const { rows } = await pgQuery<{ id: string }>(
    `SELECT id FROM players
      WHERE email_hash = $1 AND ($2::text IS NULL OR id <> $2) LIMIT 1`,
    [sha256(email), exceptPlayerId ?? null]
  );
  return !!rows[0];
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
    /* Claim it ONLY if nobody holds it.
     *
     * This UPDATE used to be unconditional, and that was an account-transfer
     * bug with a one-field trigger. An admin edits a player's email in the
     * dashboard (`admin/lib/db.ts` rewrites `email_hash`/`email_enc`, and knows
     * nothing about `site_user_id`); the next time whoever really owns that
     * address signs in, step 1 misses, step 2 matches on the hash, and they
     * inherit the other player's credits, game_state, quest engagements and
     * purchase history. The original owner's next request misses both lookups
     * and mints them a fresh, empty player. No error, no audit trail, and
     * nothing afterwards can tell the two apart.
     *
     * `AND site_user_id IS NULL` in the statement rather than a SELECT first,
     * for the reason the credit ledger states: a check-then-act is two requests
     * away from both passing. */
    const claimed = await pgQuery(
      `UPDATE players SET site_user_id = $1, updated_at = NOW()
        WHERE id = $2 AND site_user_id IS NULL`,
      [siteUserId, byEmail[0].id]
    );
    if (claimed.rowCount === 1) return byEmail[0].id;

    /* Matched nothing: someone holds it. Us, if two of our own requests raced -
     * which is ordinary and must not be an error. */
    const { rows: held } = await pgQuery<{ id: string; site_user_id: string | null }>(
      'SELECT id, site_user_id FROM players WHERE id = $1',
      [byEmail[0].id]
    );
    if (held[0]?.site_user_id === siteUserId) return held[0].id;

    /* Someone else. There is no safe answer here: `email_hash` is UNIQUE, so a
     * second player cannot be minted for this address, and handing this one over
     * is the bug above. Refusing loudly costs this user the game until a human
     * looks; continuing costs the other user everything they have. */
    throw new Error(
      `player ${byEmail[0].id} is already linked to a different site user; `
        + 'refusing to reassign it. This usually means an admin edited an email '
        + 'to one that another account owns.'
    );
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
  const { rows } = await pgQuery<{
    handle: string | null;
    full_name: string | null;
    email_hash: string | null;
  }>(
    'SELECT handle, full_name, email_hash FROM players WHERE id = $1 LIMIT 1',
    [playerId]
  );
  const current = rows[0] ?? { handle: null, full_name: null, email_hash: null };

  /* The site's email is the login credential, so for a linked player it is the
   * identity and these columns mirror it. But this used to rewrite them on
   * EVERY call - and `auth.ts` calls it on every Google sign-in - so an admin
   * correcting a player's email in the dashboard watched the correction vanish
   * the next time that player signed in, with nothing anywhere saying why.
   *
   * Two changes. The columns are only written when they would actually change,
   * so an ordinary sign-in stops touching them at all. And when they DO diverge
   * on an existing row, the overwrite is recorded, because a silent revert of
   * someone's deliberate edit is the part that wasted their afternoon. */
  const emailHash = sha256(email);
  const emailDiverged = !!current.email_hash && current.email_hash !== emailHash;
  if (emailDiverged) {
    await siteAudit(
      'site:auth',
      'player.email_resynced',
      `player:${playerId}`,
      'the account email differed from the player record; the site copy won. '
        + 'An admin edit to a linked player\'s email does not persist - the login '
        + 'address is the identity.'
    );
  }

  const fullName = opts.fullName?.trim() ? opts.fullName.trim().slice(0, 80) : null;
  const wantsHandle = typeof opts.handle === 'string';
  const resolvedHandle = wantsHandle
    ? await resolveHandle(opts.handle ?? '', playerId, opts.autoAdjustHandle === true)
    : null;

  const writeEmail = current.email_hash !== emailHash;
  await pgQuery(
    `UPDATE players
     SET email_hash = COALESCE($1, email_hash),
         email_enc  = CASE WHEN $1::text IS NULL THEN email_enc ELSE $2 END,
         handle = $3,
         full_name = $4,
         updated_at = NOW()
     WHERE id = $5`,
    [
      writeEmail ? emailHash : null,
      writeEmail ? encryptMaybe(email) : null,
      wantsHandle
        ? (opts.overwrite || !current.handle ? resolvedHandle : current.handle)
        : current.handle,
      fullName && (opts.overwrite || !current.full_name) ? fullName : current.full_name,
      playerId,
    ]
  );

  return playerId;
}

/*
 * `setPlayerCreditBalance` used to live here: an exported "write this balance"
 * helper with no callers. It is gone rather than left, because the credit ledger
 * is now the only thing allowed to move `players.credit_balance`, and an
 * unused function that does exactly the forbidden thing is an invitation with a
 * docblock on it. Grant credits with `applyCreditEvent`.
 */

// ---------------------------------------------------------------------------
// Game state persistence (credits + inventory snapshot from the live game)
// ---------------------------------------------------------------------------

let gameStateSchemaDone = false;

async function ensureGameStateColumn(): Promise<void> {
  if (gameStateSchemaDone) return;
  await pgQuery(`ALTER TABLE players ADD COLUMN IF NOT EXISTS game_state TEXT`).catch(() => {});
  gameStateSchemaDone = true;
}

export async function getGameState(siteUserId: string): Promise<unknown | null> {
  await ensureGameStateColumn();
  const { rows } = await pgQuery<{ game_state: string | null }>(
    'SELECT game_state FROM players WHERE site_user_id = $1 LIMIT 1',
    [siteUserId]
  );
  const raw = rows[0]?.game_state;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export type SaveGameStateResult =
  | { ok: true; dropped: string[] }
  | { ok: false; reason: 'no_player' | 'invalid_shape'; detail?: string };

/**
 * Persist the inventory/mounts/cosmetics snapshot.
 *
 * It no longer takes a balance. This function used to write
 * `credit_balance = $1` from the browser's own number, which is the hole phase 2
 * exists to close: a player's balance was whatever their tab last claimed. The
 * balance now moves only through `credit_events`.
 *
 * And it no longer stores whatever arrived. The blob is validated against the
 * shape `src/main.js` actually builds, per-item quantities are bounded, and an
 * oversized save is REFUSED rather than `slice()`d — see `lib/gameStateShape.ts`
 * for what silently truncating JSON was doing to people's inventories.
 */
export async function saveGameState(
  siteUserId: string,
  state: unknown
): Promise<SaveGameStateResult> {
  await ensureGameStateColumn();

  /* `null` still means "leave whatever is stored alone" — the COALESCE below
   * has always meant that, and a client that omits `state` is pushing trades
   * rather than clearing a save. */
  if (state == null) {
    const { rows } = await pgQuery<{ id: string }>(
      `UPDATE players SET updated_at = NOW() WHERE site_user_id = $1 RETURNING id`,
      [siteUserId]
    );
    return rows[0] ? { ok: true, dropped: [] } : { ok: false, reason: 'no_player' };
  }

  const checked = checkGameState(state);
  if (!checked.ok) {
    return { ok: false, reason: 'invalid_shape', detail: checked.reason };
  }

  const { rows } = await pgQuery<{ id: string }>(
    `UPDATE players
     SET game_state = $1, updated_at = NOW()
     WHERE site_user_id = $2
     RETURNING id`,
    [JSON.stringify(checked.state), siteUserId]
  );
  return rows[0] ? { ok: true, dropped: checked.dropped } : { ok: false, reason: 'no_player' };
}

/**
 * Record an in-game merchant trade so it shows in the admin purchase history.
 * amount_cents is 0 (no real money changed hands); credits_amount carries the
 * credit delta (positive = credits spent buying, negative = credits earned selling).
 *
 * ── These rows are CLIENT-REPORTED, and now say so ────────────────────────
 *
 * Nothing on the server witnessed the trade: the browser says it happened, and
 * this writes a row into `purchases` -- the same table settled Stripe orders
 * land in, which the admin app reports from. Sitting there unmarked, an
 * unverified claim was indistinguishable from money that actually moved.
 *
 * `stripe_intent_enc` carries the marker, because it is the field that already
 * describes a row's provenance (a Stripe id for a real order, `game:buy:...`
 * for these) and adding a column to a table this app does not own is the
 * larger change. The prefix is a stable string so a reporting query can exclude
 * these rows with one `NOT LIKE`, and the caller bounds the figures before they
 * get here -- see `app/api/game/state/route.ts`.
 */
/**
 * What marks a `purchases` row as the client's word rather than a settled
 * payment. One string, exported, so the admin app's reporting and this writer
 * cannot drift: `WHERE stripe_intent_enc NOT LIKE 'client:%'` is the whole
 * exclusion.
 */
export const CLIENT_REPORTED_PREFIX = 'client:';

export async function recordGameTrade(opts: {
  siteUserId: string;
  kind: 'buy' | 'sell';
  itemName: string;
  credits: number;
  qty: number;
}): Promise<void> {
  const { rows } = await pgQuery<{ id: string }>(
    'SELECT id FROM players WHERE site_user_id = $1 LIMIT 1',
    [opts.siteUserId]
  );
  const playerId = rows[0]?.id;
  if (!playerId) return;

  await pgQuery(
    `INSERT INTO purchases (id, player_id, stripe_intent_enc, amount_cents, currency, type, credits_amount, status)
     VALUES ($1, $2, $3, 0, 'credits', $4, $5, 'completed')`,
    [
      randomUUID(),
      playerId,
      /* `client:` in front of the existing `game:` tag. Both halves matter: the
       * prefix is what reporting filters on, and the rest is what a human reads
       * when they are looking at one row and wondering what it was. */
      `${CLIENT_REPORTED_PREFIX}game:${opts.kind}:${opts.itemName.slice(0, 60)} x${Math.max(1, Math.floor(opts.qty))}`,
      opts.kind === 'buy' ? 'market_buy' : 'market_sell',
      Math.floor(opts.credits),
    ]
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
}): Promise<boolean> {
  const purchaseType = opts.type === 'access+credits' ? 'access' : opts.type;

  // Idempotent: skip if this orderId already recorded
  const { rows: existing } = await pgQuery<{ id: string }>(
    'SELECT id FROM purchases WHERE stripe_intent_enc = $1 LIMIT 1',
    [opts.orderId]
  );
  if (existing[0]) return false;

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

  /* Add credits to the balance AND record why, in one statement.
   *
   * `credit_events` is meant to be the source of truth for every change to
   * `players.credit_balance` -- that is what makes `balance_after` a chain
   * worth checking. A bare UPDATE here left the ledger with a hole exactly the
   * size of every Stripe purchase ever made, so every row after one had a
   * `balance_after` that could not be derived from the rows before it, and the
   * ledger's self-check became noise.
   *
   * One CTE rather than an UPDATE followed by an INSERT: the two must not be
   * able to come apart, because a balance that moved without a row is the
   * defect, and a row without the balance move is worse. `ON CONFLICT DO
   * NOTHING` on the order key makes a retried webhook a no-op, matching the
   * `if (existing[0]) return false` guard above rather than relying on it. */
  if (opts.creditsAmount > 0) {
    /* The ledger's own definition, not a copy of it here: two schema
     * declarations for one table drift, and the one that drifts is always the
     * copy nobody remembers exists. */
    const schemaClient = makeClient();
    await schemaClient.connect();
    try {
      await ensureCreditSchema(schemaClient);
    } finally {
      await schemaClient.end();
    }

    await pgQuery(
      `WITH moved AS (
         UPDATE players
            SET credit_balance = credit_balance + $1, updated_at = NOW()
          WHERE id = $2
          RETURNING id, credit_balance
       )
       INSERT INTO credit_events (player_id, event_key, kind, detail, delta, balance_after)
       SELECT id, $3, 'purchase', $4, $1, credit_balance FROM moved
       ON CONFLICT (player_id, event_key) DO NOTHING`,
      [
        opts.creditsAmount,
        opts.playerId,
        `stripe:${opts.orderId}`,
        `stripe ${opts.type} ${opts.amountCents}c`,
      ]
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

  return true;
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
// Quest system DB functions
// ---------------------------------------------------------------------------

let questSchemaPromise: Promise<void> | null = null;

/**
 * Idempotent, additive-only schema guard. Every statement here MUST be safe to
 * run repeatedly against production (CREATE ... IF NOT EXISTS / ADD COLUMN IF
 * NOT EXISTS). Never drop or rewrite existing data.
 */
function ensureQuestSchema(): Promise<void> {
  // Memoise the promise (not a bare boolean) so concurrent callers wait for the
  // DDL to finish instead of racing ahead of it and querying missing columns.
  if (!questSchemaPromise) questSchemaPromise = runQuestSchema();
  return questSchemaPromise;
}

async function runQuestSchema(): Promise<void> {
  // The quests table is seeded by admin; just ensure the columns this app reads
  // exist. `repeatable` defaults FALSE so any quest authored before the column
  // existed stays one-shot — the safe direction for the credit economy.
  await pgQuery(`ALTER TABLE quests ADD COLUMN IF NOT EXISTS steps TEXT`).catch(() => {});
  /* `server_id` is READ by `listActiveQuestsForWorld` (and every other quest
   * read, which all state their scope as `server_id IS NULL` for the platform
   * partition). Phase 7 added the column, but its only `ALTER` lived in
   * `leaderboard.ts` — a module this route never calls. So in production the
   * SELECT threw `column "server_id" does not exist` (42703) and
   * `/api/game/quests` answered 500 to every caller, signed in or out: 78
   * quests and 398 steps unreachable, for as long as nothing happened to have
   * called the leaderboard first.
   *
   * `lore.ts` predicted this exact failure in a comment and defended against
   * it — "must not depend on another module having run first" — which is why
   * `/api/lore` was the only Postgres-backed route still answering 200. An
   * ensure belongs with the READ that needs it, not with whichever module
   * happened to introduce the column. */
  await pgQuery(`ALTER TABLE quests ADD COLUMN IF NOT EXISTS server_id TEXT`).catch(() => {});
  /* And the ENGAGEMENT carries one too, which `completeQuestEngagement` now
   * reads to decide which economy a reward belongs to. Added in the same
   * commit as that read, because adding a read without its ensure is exactly
   * the fault that took /api/game/quests to 500 for every caller - and
   * `serverIdMigrations.test.ts` caught this one within a minute of being
   * widened from three tables to six. */
  await pgQuery(
    `ALTER TABLE player_quest_engagements ADD COLUMN IF NOT EXISTS server_id TEXT`
  ).catch(() => {});
  await pgQuery(
    `ALTER TABLE quests ADD COLUMN IF NOT EXISTS repeatable BOOLEAN NOT NULL DEFAULT FALSE`
  ).catch(() => {});
  await pgQuery(`
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
      step_states        TEXT,
      accepted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at       TIMESTAMPTZ,
      failed_at          TIMESTAMPTZ,
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
  await pgQuery(
    `ALTER TABLE player_quest_engagements ADD COLUMN IF NOT EXISTS step_states TEXT`
  ).catch(() => {});
  // quest_line is what pre_steps names, so it must live on the engagement for
  // cross-world prerequisite matching to survive a quest row being deleted.
  await pgQuery(
    `ALTER TABLE player_quest_engagements ADD COLUMN IF NOT EXISTS quest_line TEXT`
  ).catch(() => {});
  // Denormalised copy of quests.reward_credits so out-of-world engagements can
  // render (and complete) without the client resolving the quest object.
  // Deliberately NO default: pre-existing rows stay NULL so reads fall through
  // to the live quests row instead of being masked by a fabricated 0.
  await pgQuery(
    `ALTER TABLE player_quest_engagements ADD COLUMN IF NOT EXISTS reward_credits INTEGER`
  ).catch(() => {});
  await pgQuery(
    `CREATE INDEX IF NOT EXISTS pqe_player_idx ON player_quest_engagements(player_id, updated_at DESC)`
  ).catch(() => {});
}

/**
 * pre_steps / post_steps hold a JSON array of quest-LINE names. Older rows may
 * hold a comma/newline delimited string, so tolerate both (mirrors the parser
 * used by the admin quest editor).
 */
function parseQuestLineList(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item).trim()).filter(Boolean);
    }
  } catch { /* not JSON — fall through to delimited parsing */ }
  return value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
}

export type QuestRow = {
  id: string; quest_number: number; world: string; quest_line: string;
  title: string; reward_credits: number; duration_minutes: number | null;
  pre_steps: string | null; steps: string | null; is_active: boolean;
  repeatable: boolean;
  /** null for a platform quest; a server id for one an owner authored. */
  server_id: string | null;
};

/**
 * Authoritative quest lookup — never trust the client for these fields.
 *
 * `server_id` is now among them, and it is the most important one: it is what
 * `acceptQuestEngagement` copies onto the engagement, and the engagement stamp
 * is what decides which leaderboard a completion can reach. Read from the row
 * rather than from the request, so a client that wanted its custom-server
 * completion counted globally would have to edit a row it cannot write.
 */
export async function getQuestById(questId: string): Promise<QuestRow | null> {
  await ensureQuestSchema();
  const { rows } = await pgQuery<QuestRow>(
    `SELECT id, quest_number, world, quest_line, title, reward_credits,
            duration_minutes, pre_steps, steps, is_active, repeatable, server_id
     FROM quests WHERE id = $1 LIMIT 1`,
    [questId]
  );
  return rows[0] ?? null;
}

/**
 * Quest-line names in `preSteps` that this player has NOT completed, in ANY
 * world (that global scope is what makes cross-world gating possible).
 */
export async function findMissingPrerequisites(
  playerId: string,
  preSteps: unknown
): Promise<string[]> {
  const required = parseQuestLineList(preSteps);
  if (!required.length) return [];
  await ensureQuestSchema();
  // COALESCE so engagements accepted before quest_line existed still count via
  // their quest_id, without needing a data-rewriting backfill.
  const { rows } = await pgQuery<{ quest_line: string | null }>(
    `SELECT DISTINCT COALESCE(e.quest_line, q.quest_line) AS quest_line
     FROM player_quest_engagements e
     LEFT JOIN quests q ON q.id = e.quest_id
     WHERE e.player_id = $1 AND e.status = 'completed'`,
    [playerId]
  );
  const completed = new Set(
    rows.map((r) => (r.quest_line ?? '').trim().toLowerCase()).filter(Boolean)
  );
  return required.filter((line) => !completed.has(line.trim().toLowerCase()));
}

/**
 * The quests a world serves, in one content scope.
 *
 * `serverId` defaults to null, and null means the PLATFORM catalogue — not "no
 * filter". That default is 7a's promise: every caller written before custom
 * servers existed keeps seeing exactly today's content without being edited.
 *
 * A member of a custom server gets that server's quests IN ADDITION TO the
 * platform ones, which is decision D2 verbatim — the owner's catalogue is an
 * overlay, not a replacement.
 *
 * UNLESS the server's owner chose `replace` mode: then the merge collapses to
 * "server rows only" and the platform partition is not served at all. `mode`
 * defaults to `'extend'` for the same reason `serverId` defaults to null —
 * every caller written before modes existed keeps today's behaviour without
 * being edited — and it only narrows anything when a server was actually
 * resolved: replace-with-no-server has nothing to replace WITH, so it serves
 * the platform partition exactly as before. Both halves of the pair come from
 * ONE resolution (`currentContentScope`); this function never re-derives.
 */
export async function listActiveQuestsForWorld(
  world: string,
  serverId: string | null = null,
  mode: 'extend' | 'replace' = 'extend'
) {
  await ensureQuestSchema();
  const normalizedWorld = String(world ?? '').trim().toLowerCase();
  const scoped = String(serverId ?? '').trim() || null;
  type ActiveQuestRow = {
    id: string; quest_number: number; world: string; quest_line: string;
    title: string; reward_credits: number; duration_minutes: number | null;
    pre_steps: string | null; steps: string | null; is_active: boolean;
    server_id: string | null;
  };
  /* Two whole statements rather than one with a clever predicate, the trade
   * the purchase path already records: the scope clause is written out
   * LITERALLY in each so `contentScoping.test.ts` can read it out of the
   * source, and the `extend` statement is byte-identical to the one that
   * shipped — `contentMode.test.ts` pins that. */
  const { rows } = scoped && mode === 'replace'
    ? await pgQuery<ActiveQuestRow>(
        `SELECT id, quest_number, world, quest_line, title, reward_credits,
                duration_minutes, pre_steps, steps, is_active, server_id
         FROM quests
         WHERE is_active = TRUE AND LOWER(world) = $1
           AND server_id = COALESCE($2, '')
         ORDER BY quest_number ASC`,
        [normalizedWorld, scoped]
      )
    : await pgQuery<ActiveQuestRow>(
        `SELECT id, quest_number, world, quest_line, title, reward_credits,
                duration_minutes, pre_steps, steps, is_active, server_id
         FROM quests
         WHERE is_active = TRUE AND LOWER(world) = $1
           AND (server_id IS NULL OR server_id = COALESCE($2, ''))
         ORDER BY quest_number ASC`,
        [normalizedWorld, scoped]
      );
  return rows;
}

export async function getPlayerQuestEngagements(playerId: string) {
  await ensureQuestSchema();
  const { rows } = await pgQuery<{
    id: string; quest_id: string | null; quest_number: number; quest_title: string;
    world: string; duration_minutes: number | null; status: string;
    percent_complete: number; credits_rewarded: number; failure_reason: string | null;
    step_states: string | null; accepted_at: string; completed_at: string | null;
    failed_at: string | null; updated_at: string;
    quest_line: string | null; reward_credits: number; quest_steps: string | null;
  }>(
    // Denormalised quest fields are carried on the row so the client can render
    // engagements from OTHER worlds, where it cannot resolve the quest object.
    // COALESCE covers rows accepted before these columns existed.
    `SELECT e.id, e.quest_id, e.quest_number, e.quest_title, e.world, e.duration_minutes,
            e.status, e.percent_complete, e.credits_rewarded, e.failure_reason, e.step_states,
            e.accepted_at, e.completed_at, e.failed_at, e.updated_at,
            COALESCE(e.quest_line, q.quest_line)              AS quest_line,
            COALESCE(e.reward_credits, q.reward_credits, 0)   AS reward_credits,
            q.steps                                           AS quest_steps
     FROM player_quest_engagements e
     LEFT JOIN quests q ON q.id = e.quest_id
     WHERE e.player_id = $1
     ORDER BY e.updated_at DESC`,
    [playerId]
  );
  return rows;
}

export type AcceptQuestResult =
  | { ok: true; engagementId: string; existing: boolean }
  | { ok: false; reason: 'quest_not_found' }
  | { ok: false; reason: 'already_completed' }
  | { ok: false; reason: 'prerequisites'; missing: string[] };

/**
 * Accept a quest. Every stored field is read from the `quests` table, never
 * from the caller, and `pre_steps` is enforced before the row is written.
 * Idempotent: an existing in_progress engagement is returned untouched (and
 * without re-running the prerequisite check, so a quest accepted before a
 * prerequisite was authored stays playable).
 * A COMPLETED engagement blocks re-accept unless `quests.repeatable` is TRUE —
 * otherwise accept -> complete -> accept -> complete farms credits forever.
 */
export async function acceptQuestEngagement(
  playerId: string,
  questId: string,
  /**
   * The server this player is currently in, or null for default mode.
   *
   * Used for two different things, and they are worth separating:
   *
   *   - **Eligibility.** A quest an owner authored is only acceptable by
   *     somebody who is in that server. Checked below, before anything is
   *     written.
   *   - **Provenance.** A PLATFORM quest completed inside a custom server
   *     accrues to that server (D2 gives a member both catalogues), so when the
   *     quest row has no stamp the player's current server supplies one.
   *
   * Defaults to null so every existing caller keeps its behaviour exactly.
   */
  serverId: string | null = null,
  /**
   * The server's content mode, from the SAME `currentContentScope` resolution
   * that produced `serverId` — never re-derived here. In `replace` mode the
   * platform catalogue is not served to this player, and the accept path must
   * agree with the list: see the guard below. Defaults to `'extend'` so every
   * existing caller keeps its behaviour exactly.
   */
  mode: 'extend' | 'replace' = 'extend'
): Promise<AcceptQuestResult> {
  await ensureQuestSchema();
  const { rows: existing } = await pgQuery<{ id: string }>(
    `SELECT id FROM player_quest_engagements
     WHERE player_id = $1 AND quest_id = $2 AND status = 'in_progress' LIMIT 1`,
    [playerId, questId]
  );
  if (existing[0]) return { ok: true, engagementId: existing[0].id, existing: true };

  const quest = await getQuestById(questId);
  if (!quest) return { ok: false, reason: 'quest_not_found' };

  /* An owner's quest is only acceptable inside that owner's server. Reported as
   * `quest_not_found` rather than as a refusal, because to a player who is not
   * in that server it genuinely does not exist — and because a distinct refusal
   * would confirm the id, turning this endpoint into a way to enumerate other
   * people's content. */
  const scopedServer = String(serverId ?? '').trim() || null;
  if (quest.server_id && quest.server_id !== scopedServer) {
    return { ok: false, reason: 'quest_not_found' };
  }

  /* The mirror guard for `replace` mode: the platform partition is not served
   * to this player, so a platform quest id must answer exactly as a foreign
   * server's does — `quest_not_found`, the same non-confirming refusal. This
   * lives HERE, beside the eligibility check, so the accept path and the list
   * path (`listActiveQuestsForWorld` in replace mode) cannot disagree about
   * what exists: nothing is acceptable that the board would not show.
   *
   * ENGAGEMENTS ALREADY IN FLIGHT ARE DELIBERATELY UNTOUCHED. This guard runs
   * only for NEW accepts — the in_progress short-circuit above returns before
   * it, and `completeQuestEngagement` never consults the mode at all. The
   * engagement row is the contract: a player who accepted a platform quest
   * while the server extended keeps the completion (and the reward its stamp
   * already decides) after the owner flips to replace. Revoking work a player
   * was invited to start is not what a content-mode switch means, and an
   * owner who flips modes mid-quest should cost their members nothing. */
  if (mode === 'replace' && scopedServer && !quest.server_id) {
    return { ok: false, reason: 'quest_not_found' };
  }

  // One-shot quests may only ever pay out once. Checked AFTER the in_progress
  // lookup so an accept already in flight still returns its existing row.
  if (!quest.repeatable) {
    const { rows: done } = await pgQuery<{ id: string }>(
      `SELECT id FROM player_quest_engagements
       WHERE player_id = $1 AND quest_id = $2 AND status = 'completed' LIMIT 1`,
      [playerId, questId]
    );
    if (done[0]) return { ok: false, reason: 'already_completed' };
  }

  const missing = await findMissingPrerequisites(playerId, quest.pre_steps);
  if (missing.length) return { ok: false, reason: 'prerequisites', missing };

  const id = randomUUID();
  await pgQuery(
    /* `server_id` is copied from the QUEST ROW, which is the whole point.
     *
     * The engagement stamp is what decides which leaderboard a completion can
     * reach: `leaderboard.ts`'s quest board partitions on `e.server_id`, so a
     * completion inside a custom server accrues to that server and never to the
     * global board — Phase 7's rule verbatim, including for a PLATFORM quest
     * completed there, because D2 gives a member the platform catalogue in
     * addition to the owner's.
     *
     * Taken from `quest.server_id` and never from a request body: a client that
     * wanted its custom-server completion counted globally would have to change
     * a row it cannot write. */
    `INSERT INTO player_quest_engagements
       (id, player_id, quest_id, quest_number, quest_title, world, duration_minutes,
        status, quest_line, reward_credits, server_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'in_progress', $8, $9, $10)`,
    [
      id, playerId, quest.id, quest.quest_number, quest.title, quest.world,
      quest.duration_minutes, quest.quest_line, quest.reward_credits ?? 0,
      quest.server_id ?? serverId ?? null,
    ]
  );
  return { ok: true, engagementId: id, existing: false };
}

/** Ownership-scoped: an engagement id alone must not let a player write to another's row. */
export async function updateQuestStepStates(
  engagementId: string,
  playerId: string,
  stepStates: unknown,
  percentComplete: number
): Promise<void> {
  const pct = Number.isFinite(percentComplete)
    ? Math.min(100, Math.max(0, Math.round(percentComplete)))
    : 0;
  await pgQuery(
    `UPDATE player_quest_engagements
     SET step_states = $1, percent_complete = $2, updated_at = NOW()
     WHERE id = $3 AND player_id = $4`,
    [JSON.stringify(stepStates), pct, engagementId, playerId]
  );
}

export type CompleteQuestResult = {
  ok: boolean;
  alreadyCompleted: boolean;
  creditsAwarded: number;
  /** Authoritative post-grant balance, so the client can mirror instead of guess. */
  creditBalance: number | null;
  status: string | null;
  /**
   * Why a refusal was a refusal, when `ok` is false and it was not simply "no
   * such engagement". Added so the client can tell "you have not finished this"
   * from "that quest does not exist", which are the same 404 without it.
   */
  reason?: 'not_found' | 'wrong_status' | 'steps_incomplete' | 'capped';
};

/** One authored step, as `quests.steps` holds it. */
type AuthoredStep = { order?: unknown; count?: unknown; label?: unknown };
/** One step's progress, as `player_quest_engagements.step_states` holds it. */
type StepState = { done?: unknown; have?: unknown };

/**
 * Are every one of this quest's authored steps actually finished?
 *
 * ── The argument this replaces, and what changed under it ─────────────────
 *
 * There used to be a long comment here explaining that reading `step_states`
 * WOULD NOT HELP, on the grounds that `updateQuestStepStates` takes both the
 * states and the percentage straight from the request body, so requiring
 * complete steps would only move the forgery one request earlier: POST the
 * steps, then POST the completion.
 *
 * That is true, and it is still true, and the conclusion drawn from it was
 * wrong. "A determined forger can send two requests instead of one" is not an
 * argument for accepting one request; it is an argument that the SECOND request
 * is not the place the real fix lives. Meanwhile the absence had a cost that
 * the comment did not weigh: with no check at all, `status = 'in_progress'` was
 * the entire predicate, so a completion could be claimed for a quest whose
 * steps had never been touched by anything -- including by a client that never
 * ran the quest's world. Requiring the steps costs an honest player nothing,
 * because their client has already written them, and it means a forged
 * completion has to at least describe the work it is claiming to have done.
 *
 * ── What this is and is not ───────────────────────────────────────────────
 *
 * It is a CONSISTENCY check, not a proof of play, and it is worth being precise
 * about that so nobody mistakes it for one. The server still has no simulation.
 * What a real fix needs is server-OBSERVABLE evidence -- a purchase, a credit
 * event, a server-priced minigame result -- and the verbs with no server-side
 * trace (visit, talk, interact) cannot be verified without the server
 * witnessing them. That remains a design change and remains not done.
 *
 * ── The two cases that are deliberately allowed ───────────────────────────
 *
 *   - A quest with NO authored steps completes freely. `steps` is nullable and
 *     plenty of rows have never had one; refusing those would make every such
 *     quest permanently unfinishable, which is a far larger and far more
 *     visible fault than the one being closed.
 *   - An engagement whose quest ROW HAS GONE (deleted since acceptance, so the
 *     LEFT JOIN yields null) completes on its denormalised reward. There is
 *     nothing left to check it against, and the client cannot delete a quest
 *     row, so the case is an operator's action rather than an attack.
 */
export function questStepsSatisfied(
  stepsJson: string | null,
  stepStatesJson: string | null
): boolean {
  if (!stepsJson) return true;

  let steps: AuthoredStep[];
  try {
    const parsed = JSON.parse(stepsJson);
    if (!Array.isArray(parsed)) return true; // not a step list; nothing to check
    steps = parsed as AuthoredStep[];
  } catch {
    /* Unparseable authored steps are an authoring fault, not a player one.
     * Refusing here would make the quest unfinishable for everyone who had
     * already accepted it. */
    return true;
  }
  if (steps.length === 0) return true;

  let states: Record<string, StepState>;
  try {
    const parsed = stepStatesJson ? JSON.parse(stepStatesJson) : null;
    states = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, StepState>)
      : {};
  } catch {
    states = {};
  }

  for (const step of steps) {
    /* Keyed by `step.order` -- the same key `QuestSystem._parseSteps` and
     * `stepStates[step.order]` use on the client. Read as a string because JSON
     * object keys always are, whatever the authored `order` was. */
    const state = states[String(step.order)];
    if (!state || state.done !== true) return false;
    const count = Math.max(1, Number(step.count) || 1);
    const have = Number(state.have);
    if (!Number.isFinite(have) || have < count) return false;
  }
  return true;
}

async function readCreditBalance(playerId: string): Promise<number | null> {
  const { rows } = await pgQuery<{ credit_balance: number }>(
    `SELECT credit_balance FROM players WHERE id = $1 LIMIT 1`,
    [playerId]
  );
  return rows[0] ? Number(rows[0].credit_balance) : null;
}

/**
 * Complete a quest and pay the reward the SERVER decides.
 *
 * - The award is `quests.reward_credits` for the engagement's quest (falling
 *   back to the denormalised copy stored at accept time). No client input is
 *   consulted, so the amount cannot be forged.
 * - The status flip and the credit are ONE statement whose WHERE clause only
 *   matches `in_progress`, so a replayed or concurrent 'complete' pays nothing
 *   and cannot half-apply.
 * - The resulting balance is returned because /api/game/state SETs
 *   `credit_balance` from the client's mirror; a client left guessing would
 *   overwrite this grant on its next state push.
 */
/**
 * WHAT STOPS A QUEST BEING PAID WITHOUT BEING PLAYED.
 *
 * Three things now, where there used to be one.
 *
 *   1. `status = 'in_progress'` in the UPDATE predicate, so a replayed or
 *      concurrent completion pays once. This was always here.
 *   2. The reward is not client-settable. `acceptQuestEngagement` fetches the
 *      row with `getQuestById(questId)` and stores `quest.reward_credits` on
 *      the engagement; this function reads `q.reward_credits` or that stored
 *      copy. A forged completion pays the CATALOGUE price, never an arbitrary
 *      number. This was always here too.
 *   3. `questStepsSatisfied` -- every authored step present, `done: true`, and
 *      `have >= count`. NEW, and see that function for the argument it
 *      overturns and the exact limits of what it buys.
 *
 * ── And the cap is now applied, which it was not ──────────────────────────
 *
 * This call used to pass `ignoreCap: true`, with a comment arguing that
 * honouring `CAPS.quest` could only "mark a quest completed and pay zero for
 * it, which is the silent theft `creditPricing.ts` says a ceiling must never
 * cause". The objection was correct about the CONSEQUENCE and wrong about the
 * remedy: the answer is not to remove the ceiling, it is to not steal.
 *
 * So the cap is honoured, and a capped completion ROLLS BACK -- the engagement
 * stays `in_progress`, nothing is paid, and the caller is told `capped`. The
 * player loses nothing and can finish it when the window rolls over. Without
 * the cap, a REPEATABLE quest was an uncapped faucet: accept, complete, accept,
 * complete, at `reward_credits` a time, for as long as anyone cared to loop.
 *
 * 120 completions an hour is far above any honest session -- especially now
 * that every step has to be reported finished first -- so this should never
 * fire in real play. If it ever does, the log line below is the thing to read.
 */
export async function completeQuestEngagement(
  engagementId: string,
  playerId: string
): Promise<CompleteQuestResult> {
  await ensureQuestSchema();
  const { rows: found } = await pgQuery<{
    status: string;
    quest_reward: number | null;
    engagement_reward: number | null;
    credit_balance: number;
    server_id: string | null;
    quest_steps: string | null;
    step_states: string | null;
  }>(
    `SELECT e.status,
            q.reward_credits AS quest_reward,
            e.reward_credits AS engagement_reward,
            pl.credit_balance,
            e.server_id,
            q.steps        AS quest_steps,
            e.step_states  AS step_states
     FROM player_quest_engagements e
     JOIN players pl ON pl.id = e.player_id
     LEFT JOIN quests q ON q.id = e.quest_id
     WHERE e.id = $1 AND e.player_id = $2
     LIMIT 1`,
    [engagementId, playerId]
  );
  const engagement = found[0];
  if (!engagement) {
    return {
      ok: false, alreadyCompleted: false, creditsAwarded: 0,
      creditBalance: null, status: null, reason: 'not_found',
    };
  }
  const balanceBefore = Number(engagement.credit_balance);
  if (engagement.status === 'completed') {
    return {
      ok: true, alreadyCompleted: true, creditsAwarded: 0,
      creditBalance: balanceBefore, status: 'completed',
    };
  }
  if (engagement.status !== 'in_progress') {
    return {
      ok: false, alreadyCompleted: false, creditsAwarded: 0,
      creditBalance: balanceBefore, status: engagement.status, reason: 'wrong_status',
    };
  }

  /* THE WORK, BEFORE THE MONEY.
   *
   * Checked here rather than inside either branch below, because it applies to
   * both economies and because nothing should be flipped to 'completed' by a
   * request that has not said the quest was finished. See
   * `questStepsSatisfied` for what this does and does not prove. */
  if (!questStepsSatisfied(engagement.quest_steps, engagement.step_states)) {
    return {
      ok: false, alreadyCompleted: false, creditsAwarded: 0,
      creditBalance: balanceBefore, status: engagement.status, reason: 'steps_incomplete',
    };
  }

  const rawReward = Number(engagement.quest_reward ?? engagement.engagement_reward ?? 0);
  const reward = Number.isFinite(rawReward) ? Math.max(0, Math.trunc(rawReward)) : 0;

  /* A SERVER-SCOPED QUEST MUST NEVER TOUCH THE PLATFORM BALANCE.
   *
   * Phase 7 separated the two economies structurally, and the separation holds
   * everywhere it was built: `serverCredits.ts` never names `players` or
   * `credit_balance`. But quest rewards never went through that module. This
   * function took `(engagementId, playerId)` and never read `server_id` at all,
   * while the engagement row it updates is correctly stamped with one - so the
   * UPDATE below added an owner-authored reward to `players.credit_balance`.
   *
   * Driven live against a test database: an owner authored a quest at
   * `rewardCredits: 1000000000, repeatable: true`, and two request pairs later
   * `players.credit_balance` read 2,000,510,348 while `server_credit_balances`
   * stayed empty. AN INVITED MEMBER WITH NO SUBSCRIPTION DID THE SAME. The cost
   * of unlimited platform credits for everyone an owner invites was one
   * subscription.
   *
   * The destination was already designed and simply unwired:
   * `SERVER_CREDIT_KINDS.quest` caps one payout at 5,000 and its `why` names
   * this exact case - "the owner sets reward_credits; this bounds one payout,
   * not the owner's economy". `earnServerCredits` is idempotent on `eventKey`,
   * so the engagement id makes a replayed completion pay once. */
  if (engagement.server_id) {
    const client = makeClient();
    await client.connect();
    try {
      const { rows: done } = await client.query(
        `UPDATE player_quest_engagements
            SET status = 'completed', credits_rewarded = $1::int, percent_complete = 100,
                completed_at = NOW(), updated_at = NOW()
          WHERE id = $2 AND player_id = $3 AND status = 'in_progress'
          RETURNING id`,
        [reward, engagementId, playerId]
      );
      if (!done[0]) {
        return {
          ok: true, alreadyCompleted: true, creditsAwarded: 0,
          creditBalance: balanceBefore, status: 'completed',
        };
      }
      const paid = await earnServerCredits(client, engagement.server_id, playerId, {
        kind: 'quest', amount: reward, eventKey: `quest:${engagementId}`,
      });
      /* `creditBalance` stays the PLATFORM balance, unchanged and read before
       * this branch: that is the number this contract has always meant, and
       * quietly returning a server balance in its place would be the same
       * conflation this fix exists to remove. */
      return {
        ok: true, alreadyCompleted: false, creditsAwarded: paid.applied ? paid.delta : 0,
        creditBalance: balanceBefore, status: 'completed',
      };
    } finally {
      await client.end();
    }
  }

  /* A PLATFORM QUEST REWARD MUST LEAVE A LEDGER ROW.
   *
   * This was one data-modifying CTE: flip the engagement to 'completed' and add
   * the reward to `players.credit_balance`, atomically and with no
   * `credit_events` row anywhere in the function or in its only caller. Phase 2
   * paired the balance move with a ledger insert on every other payout path —
   * Stripe purchases and admin grants both do — and missed this one.
   *
   * Measured live against a real database: the ledger read 95 -> 250 on a +5
   * event, and `SUM(delta)` was 100 against a balance of 250. `balance_after`
   * becomes underivable from a player's FIRST quest completion onward, which is
   * every player. `ensureOpeningBalance` masks it on a brand-new account — the
   * account a smoke test uses — so it could have looked fine indefinitely.
   *
   * ── Why this is not "add an applyCreditEvent call after the CTE" ──────────
   *
   * `applyCreditEvent` opens its own `BEGIN`, and Postgres has no nested
   * transactions, so the flip and the credit would be two commits with a window
   * between them: crash there and the quest is completed and unpaid, with
   * nothing recording that it should have been. `creditInTransaction` is the
   * earn half without a transaction of its own, so both live in one.
   *
   * ── Idempotency: two guards that must agree, not fight ───────────────────
   *
   *   - the flip only matches `status = 'in_progress'`, so a replayed or
   *     concurrent completion flips nothing and pays nothing;
   *   - the ledger's `UNIQUE (player_id, event_key)` refuses a second row for
   *     `quest:<engagementId>`.
   *
   * They agree because a REPEATABLE quest gets a fresh engagement row per
   * acceptance (`acceptQuestEngagement` only reuses an `in_progress` one), so
   * the engagement id is unique per completion and the ledger key never
   * collides with a legitimate repeat. The server-scoped branch above already
   * keys `earnServerCredits` the same way.
   *
   * ── The cap is deliberately not applied ──────────────────────────────────
   *
   * `CAPS.quest` is 120/hour and is dead code today: `REASON_KIND.quest` is
   * 'refused', so no path ever reaches `applyCreditEvent` with this kind.
   * Honouring it here would ACTIVATE a rate limit nobody asked for, on the one
   * payout the client cannot inflate — the amount comes from `quests.reward_credits`
   * and the completion is gated by a row the client cannot write. Its only
   * possible effect is to mark a quest completed and pay zero for it, which is
   * the silent theft `creditPricing.ts` says a ceiling must never cause.
   */
  const client = makeClient();
  await client.connect();
  try {
    await ensureCreditSchema(client);
    /* Before the balance moves, or the ledger's first row for this player is a
     * number with no provenance and `SUM(delta)` disagrees with the balance for
     * the life of the account. */
    await ensureOpeningBalance(client, playerId);

    await client.query('BEGIN');
    try {
      const { rows: finished } = await client.query<{ id: string }>(
        `UPDATE player_quest_engagements
            SET status = 'completed', credits_rewarded = $1::int, percent_complete = 100,
                completed_at = NOW(), updated_at = NOW()
          WHERE id = $2 AND player_id = $3 AND status = 'in_progress'
          RETURNING id`,
        [reward, engagementId, playerId]
      );
      if (!finished[0]) {
        // Lost the race with a concurrent completion — that one paid, this one must not.
        await client.query('ROLLBACK');
        return {
          ok: true, alreadyCompleted: true, creditsAwarded: 0,
          creditBalance: await readCreditBalance(playerId), status: 'completed',
        };
      }

      const paid = await creditInTransaction(client, playerId, {
        kind: 'quest',
        detail: `quest:${engagementId}`,
        eventKey: `quest:${engagementId}`,
        amount: reward,
        /* NO `ignoreCap`. `CAPS.quest` is 120 an hour, which no honest session
         * reaches, and without it a repeatable quest was an unbounded faucet:
         * accept, complete, accept, complete, at `reward_credits` a turn. */
      });

      /* A CAPPED COMPLETION IS ROLLED BACK, NOT COMMITTED.
       *
       * This is the answer to the objection that used to justify `ignoreCap`:
       * that honouring the ceiling could only mark a quest completed and pay
       * zero for it, which is silent theft from the player. It would be -- if
       * the flip were committed. Rolling back instead leaves the engagement
       * `in_progress` and the balance untouched, so the player has lost
       * nothing and can complete it once the window rolls over.
       *
       * The zero row `creditInTransaction` wrote goes with the rollback, so
       * this log line is the only trace. That is a deliberate trade: an
       * audit row is worth less than not taking a reward away, and at 120 an
       * hour a genuine player will never see this. */
      if (paid.reason === 'capped') {
        await client.query('ROLLBACK');
        console.error(
          `[quests] quest reward capped for player ${playerId} on engagement `
          + `${engagementId}; completion rolled back and nothing paid.`
        );
        return {
          ok: false, alreadyCompleted: false, creditsAwarded: 0,
          creditBalance: balanceBefore, status: 'in_progress', reason: 'capped',
        };
      }

      /* COMMIT on every other outcome. The flip won, so this player completed
       * the quest; rolling that back would re-open a quest they have finished.
       * The remaining refusal is `duplicate` — the reward was already ledgered
       * — and the balance returned is authoritative either way. */
      await client.query('COMMIT');
      return {
        ok: true, alreadyCompleted: false,
        creditsAwarded: paid.applied ? paid.delta : 0,
        creditBalance: paid.balance,
        status: 'completed',
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  } finally {
    await client.end();
  }
}

/** Ownership-scoped for the same reason as updateQuestStepStates. */
export async function failQuestEngagement(
  engagementId: string,
  playerId: string,
  reason: string
): Promise<void> {
  await pgQuery(
    `UPDATE player_quest_engagements
     SET status = 'failed', failure_reason = $1, failed_at = NOW(), updated_at = NOW()
     WHERE id = $2 AND player_id = $3 AND status = 'in_progress'`,
    [reason, engagementId, playerId]
  );
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