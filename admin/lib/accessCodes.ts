import { randomUUID } from 'node:crypto';
import { sql } from './sql';
import { decryptMaybe, encrypt } from './encrypt';
import {
  ACCESS_WINDOW_DAYS,
  accessCodeHint,
  compSubscriptionId,
  hashAccessCode,
  mintAccessCode,
  normalizeAccessCode,
  type AccessCodeKind,
} from './accessCodeFormat';

/**
 * Access codes: the issuing half.
 *
 * An operator mints codes here and hands them out; players redeem them on the
 * site. A `play` code is worth the same 30 days the $1 pass buys; a `server`
 * code is worth one comped custom-server slot.
 *
 * ── The schema below is a COPY ────────────────────────────────────────────
 *
 * CANONICAL DEFINITION IS `site/lib/accessCodes.ts` (`ensureAccessCodeSchema`).
 * This declaration must stay identical to it, and exists only so that minting a
 * code cannot fail on a database where the site has not yet served a request.
 * Both use `CREATE TABLE IF NOT EXISTS`, so whichever app runs first wins and
 * the other is a no-op. `site/lib/accessCodes.test.ts` reads both files and
 * fails if the two declarations drift — the same arrangement `credit_events`
 * has, for the same reason.
 *
 * ── Two copies of the code, and what each is for ──────────────────────────
 *
 * `code_hash` is what redemption matches on: a domain-separated SHA-256, so the
 * table cannot be read for working codes. `code_enc` is the same code under
 * `ENCRYPTION_KEY`, kept so that an operator can re-read a code they minted
 * last week and hand it to somebody else — which is the entire point of a code
 * you print on a card. The pattern is `players.email_hash` beside
 * `players.email_enc`, deliberately: one column to look up by, one to show a
 * human who has authenticated well enough to be shown it.
 */

/* ---------------------------------------------------------------------- */
/* Schema                                                                  */
/* ---------------------------------------------------------------------- */

let schemaPromise: Promise<void> | null = null;

/**
 * Build the tables if they are not there.
 *
 * Memoised as a promise, not a boolean, so two concurrent requests on a cold
 * lambda wait rather than race, and a rejection clears the memo. Every read and
 * write in this module awaits it: `initSchema` only runs from the setup
 * scripts, so a deployment that has never been re-set-up would otherwise 500 on
 * the first visit to the codes page.
 */
export function ensureAccessCodeSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS access_codes (
          code_hash    TEXT PRIMARY KEY,
          code_enc     TEXT,
          code_hint    TEXT NOT NULL,
          kind         TEXT NOT NULL,
          days         INTEGER NOT NULL,
          max_uses     INTEGER NOT NULL DEFAULT 1,
          uses         INTEGER NOT NULL DEFAULT 0,
          batch_id     TEXT,
          label        TEXT,
          created_by   TEXT NOT NULL,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at   TIMESTAMPTZ,
          revoked_at   TIMESTAMPTZ,
          revoked_by   TEXT
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS access_codes_created_idx
          ON access_codes (created_at DESC)
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS access_code_redemptions (
          code_hash      TEXT NOT NULL REFERENCES access_codes(code_hash) ON DELETE CASCADE,
          player_id      TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
          kind           TEXT NOT NULL,
          days           INTEGER NOT NULL,
          redeemed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          clawed_back_at TIMESTAMPTZ,
          PRIMARY KEY (code_hash, player_id)
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS access_code_redemptions_player_idx
          ON access_code_redemptions (player_id, redeemed_at DESC)
      `;
    })().catch((err) => {
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}

/* ---------------------------------------------------------------------- */
/* Minting                                                                 */
/* ---------------------------------------------------------------------- */

/** The ceilings on one mint, so a slipped keystroke cannot issue a million codes. */
export const MAX_BATCH = 200;
export const MAX_USES_PER_CODE = 10_000;
export const MAX_GRANT_DAYS = 3650;

export interface MintedCode {
  /** The full code, in the form a human is given it. Shown ONCE, at creation. */
  code: string;
  codeHash: string;
  hint: string;
}

export interface CreateCodesInput {
  kind: AccessCodeKind;
  days: number;
  /** How many people each code may be redeemed by. 1 for a hand-out code. */
  maxUses: number;
  /** How many distinct codes to mint in this batch. */
  quantity: number;
  label?: string | null;
  /** When the code stops being redeemable. Null for "never". */
  expiresAt?: string | null;
  createdBy: string;
}

/**
 * Mint a batch.
 *
 * Codes are inserted WITHOUT `ON CONFLICT DO NOTHING`. A digest collision at 60
 * bits is not going to happen, and if it somehow did, swallowing it would hand
 * the operator a printed code that redeems to somebody else's grant — an error
 * they can see is strictly better than a code that lies.
 *
 * The plaintext is returned to the caller and never stored in the clear. The
 * page shows the batch once, with a copy button; after that the operator reveals
 * codes one at a time through `revealAccessCode`, which is audited.
 */
export async function createAccessCodes(input: CreateCodesInput): Promise<{
  batchId: string;
  codes: MintedCode[];
}> {
  await ensureAccessCodeSchema();

  const days = clampInt(input.days, 1, MAX_GRANT_DAYS);
  const maxUses = clampInt(input.maxUses, 1, MAX_USES_PER_CODE);
  const quantity = clampInt(input.quantity, 1, MAX_BATCH);
  const label = input.label?.trim() ? input.label.trim().slice(0, 200) : null;
  const expiresAt = input.expiresAt?.trim() ? input.expiresAt.trim() : null;
  const batchId = randomUUID();

  const codes: MintedCode[] = [];
  for (let i = 0; i < quantity; i++) {
    const code = mintAccessCode();
    const codeHash = hashAccessCode(code);
    const body = normalizeAccessCode(code);
    /* Cannot happen: `mintAccessCode` builds from the same alphabet
     * `normalizeAccessCode` accepts. Checked anyway, because the alternative to
     * a thrown error here is a row with a null hash that no code can ever
     * match. */
    if (!codeHash || !body) throw new Error('minted a code the format module will not accept');

    await sql`
      INSERT INTO access_codes
        (code_hash, code_enc, code_hint, kind, days, max_uses, batch_id, label, created_by, expires_at)
      VALUES
        (${codeHash}, ${encrypt(code)}, ${accessCodeHint(body)}, ${input.kind}, ${days},
         ${maxUses}, ${batchId}, ${label}, ${input.createdBy}, ${expiresAt})
    `;
    codes.push({ code, codeHash, hint: accessCodeHint(body) });
  }

  return { batchId, codes };
}

function clampInt(value: unknown, min: number, max: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/* ---------------------------------------------------------------------- */
/* Reading                                                                 */
/* ---------------------------------------------------------------------- */

/* Type aliases rather than interfaces, because these are handed to `sql<T>` and
 * its constraint is `Record<string, any>`: a type alias picks up an implicit
 * index signature and satisfies it, an interface does not. */
export type AccessCodeRow = {
  code_hash: string;
  code_hint: string;
  kind: string;
  days: number;
  max_uses: number;
  uses: number;
  batch_id: string | null;
  label: string | null;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  redemptions: number;
  clawed_back: number;
};

const PAGE_SIZE = 50;

export async function listAccessCodes(page = 0): Promise<AccessCodeRow[]> {
  await ensureAccessCodeSchema();
  const offset = Math.max(0, Math.floor(page)) * PAGE_SIZE;
  const { rows } = await sql<AccessCodeRow>`
    SELECT c.code_hash, c.code_hint, c.kind, c.days, c.max_uses, c.uses,
           c.batch_id, c.label, c.created_by, c.created_at, c.expires_at,
           c.revoked_at, c.revoked_by,
           COALESCE(r.n, 0)::int  AS redemptions,
           COALESCE(r.cb, 0)::int AS clawed_back
      FROM access_codes c
      LEFT JOIN (
        SELECT code_hash,
               COUNT(*)                                        AS n,
               COUNT(*) FILTER (WHERE clawed_back_at IS NOT NULL) AS cb
          FROM access_code_redemptions
         GROUP BY code_hash
      ) r ON r.code_hash = c.code_hash
     ORDER BY c.created_at DESC
     LIMIT ${PAGE_SIZE} OFFSET ${offset}
  `;
  return rows;
}

export type RedemptionRow = {
  player_id: string;
  handle: string | null;
  email: string | null;
  kind: string;
  days: number;
  redeemed_at: string;
  clawed_back_at: string | null;
  has_active_access: boolean;
  paid_since: boolean;
};

/**
 * Who redeemed this code, and what has happened to them since.
 *
 * `paid_since` is the column the claw-back respects: it is true when the player
 * has a completed access purchase dated at or after their redemption, meaning
 * whatever access they hold now is something they bought rather than something
 * this code gave them. Taking that away would be destroying a customer's
 * property to undo a gift.
 */
export async function listRedemptions(codeHash: string): Promise<RedemptionRow[]> {
  await ensureAccessCodeSchema();
  const { rows } = await sql<RedemptionRow & { email_enc: string | null }>`
    SELECT r.player_id, r.kind, r.days, r.redeemed_at, r.clawed_back_at,
           p.handle, p.email_enc,
           (p.access_granted_at IS NOT NULL
             AND p.access_revoked_at IS NULL
             AND p.access_granted_at + make_interval(days => ${ACCESS_WINDOW_DAYS}::int) > NOW())
             AS has_active_access,
           EXISTS (
             SELECT 1 FROM purchases pu
              WHERE pu.player_id = r.player_id
                AND pu.type = 'access'
                AND pu.status = 'completed'
                AND pu.created_at >= r.redeemed_at
           ) AS paid_since
      FROM access_code_redemptions r
      JOIN players p ON p.id = r.player_id
     WHERE r.code_hash = ${codeHash}
     ORDER BY r.redeemed_at DESC
  `;
  return rows.map((row) => ({
    player_id: row.player_id,
    handle: row.handle,
    email: decryptMaybe(row.email_enc),
    kind: row.kind,
    days: row.days,
    redeemed_at: row.redeemed_at,
    clawed_back_at: row.clawed_back_at,
    has_active_access: row.has_active_access,
    paid_since: row.paid_since,
  }));
}

/**
 * The code itself, decrypted.
 *
 * Deliberately a separate call rather than a column on the listing: a page that
 * renders every live code in plaintext is a page whose screenshot is a giveaway.
 * The caller audits the reveal.
 */
export async function revealAccessCode(codeHash: string): Promise<string | null> {
  await ensureAccessCodeSchema();
  const { rows } = await sql<{ code_enc: string | null }>`
    SELECT code_enc FROM access_codes WHERE code_hash = ${codeHash} LIMIT 1
  `;
  return decryptMaybe(rows[0]?.code_enc);
}

/**
 * Every code in one batch, decrypted, for the "here is what you just minted"
 * panel and for printing a sheet of them later.
 *
 * Read back out of the database rather than passed through from
 * `createAccessCodes`, because the thing between them is a redirect: a server
 * action cannot hand 200 codes to the page it redirects to except through a
 * URL, and a URL is the one place these must never go. The round trip costs one
 * query and means the panel works just as well a week later.
 */
export async function listBatchCodes(batchId: string): Promise<Array<{ hint: string; code: string | null }>> {
  await ensureAccessCodeSchema();
  const { rows } = await sql<{ code_hint: string; code_enc: string | null }>`
    SELECT code_hint, code_enc
      FROM access_codes
     WHERE batch_id = ${batchId}
     ORDER BY created_at ASC, code_hash ASC
  `;
  return rows.map((row) => ({ hint: row.code_hint, code: decryptMaybe(row.code_enc) }));
}

/* ---------------------------------------------------------------------- */
/* Revoking                                                                */
/* ---------------------------------------------------------------------- */

/**
 * Stop this code being redeemable. Touches nobody who already used it.
 *
 * That separation is the whole design of the revoke button: withdrawing a code
 * that leaked and taking access away from the people who redeemed it before it
 * leaked are different decisions, and one of them is destructive. `clawBack`
 * below is the second, and it is a second click.
 *
 * Idempotent — a second revoke finds `revoked_at` already set and leaves the
 * original timestamp and actor alone, so the record says who withdrew it and
 * when, not who pressed the button most recently.
 */
export async function revokeAccessCode(codeHash: string, actor: string): Promise<boolean> {
  await ensureAccessCodeSchema();
  const { rows } = await sql<{ code_hash: string }>`
    UPDATE access_codes
       SET revoked_at = NOW(), revoked_by = ${actor}
     WHERE code_hash = ${codeHash} AND revoked_at IS NULL
     RETURNING code_hash
  `;
  return !!rows[0];
}

/** Put a withdrawn code back into service. */
export async function restoreAccessCode(codeHash: string): Promise<boolean> {
  await ensureAccessCodeSchema();
  const { rows } = await sql<{ code_hash: string }>`
    UPDATE access_codes
       SET revoked_at = NULL, revoked_by = NULL
     WHERE code_hash = ${codeHash} AND revoked_at IS NOT NULL
     RETURNING code_hash
  `;
  return !!rows[0];
}

export interface ClawBackResult {
  /** Players whose access this ended. */
  revoked: string[];
  /** Players skipped because they have paid since redeeming. */
  skippedPaid: string[];
  /** Comped hosting slots expired. */
  hostingExpired: number;
}

/**
 * Take back what this code gave, from everyone who has not since paid.
 *
 * ── The two grants come apart here ────────────────────────────────────────
 *
 * A `play` redemption is undone by revoking the player's access outright. There
 * is no way to subtract exactly 30 days: access is a single timestamp and a
 * fixed window, so the only honest options are "leave it" and "end it", and
 * ending it is what an operator pressing a claw-back button is asking for.
 *
 * A `server` redemption is undone by DATING the slot the comp funded rather
 * than deleting anything. `server_slot_grants.expires_at` is already the
 * mechanism a comp expires by, and `site/lib/premium.ts`'s `expireLapsedSlots`
 * re-materialises `max_servers` from the surviving slots at the two points that
 * gate hosting. Setting a date therefore reuses one aggregate, defined once, in
 * the app that owns entitlement — instead of this file growing its own copy of
 * the live-slot sum and drifting from it. The owner keeps any slot they pay for
 * and any other comp they hold; only this code's slot stops counting.
 *
 * ── Who is skipped ────────────────────────────────────────────────────────
 *
 * Anyone with a completed access purchase dated at or after their redemption.
 * They may well have redeemed the code AND paid; the access they hold now is
 * paid-for either way, and a claw-back that cancels a customer to undo a gift
 * is a refund nobody asked for. They are reported rather than silently ignored,
 * and their redemption row is left unmarked so a later claw-back re-evaluates
 * them rather than treating them as already handled.
 */
export async function clawBackAccessCode(codeHash: string): Promise<ClawBackResult> {
  await ensureAccessCodeSchema();

  const { rows: targets } = await sql<{ player_id: string; kind: string; paid_since: boolean }>`
    SELECT r.player_id, r.kind,
           EXISTS (
             SELECT 1 FROM purchases pu
              WHERE pu.player_id = r.player_id
                AND pu.type = 'access'
                AND pu.status = 'completed'
                AND pu.created_at >= r.redeemed_at
           ) AS paid_since
      FROM access_code_redemptions r
     WHERE r.code_hash = ${codeHash}
       AND r.clawed_back_at IS NULL
  `;

  const revoked: string[] = [];
  const skippedPaid: string[] = [];
  let hostingExpired = 0;

  for (const target of targets) {
    if (target.paid_since) {
      skippedPaid.push(target.player_id);
      continue;
    }

    if (target.kind === 'server') {
      const { rows } = await sql<{ player_id: string }>`
        UPDATE server_slot_grants
           SET expires_at = NOW()
         WHERE player_id = ${target.player_id}
           AND subscription_id = ${compSubscriptionId(codeHash)}
           AND revoked_at IS NULL
         RETURNING player_id
      `;
      hostingExpired += rows.length;
    } else {
      await sql`
        UPDATE players
           SET access_revoked_at = NOW(), updated_at = NOW()
         WHERE id = ${target.player_id}
      `;
    }

    await sql`
      UPDATE access_code_redemptions
         SET clawed_back_at = NOW()
       WHERE code_hash = ${codeHash} AND player_id = ${target.player_id}
    `;
    revoked.push(target.player_id);
  }

  return { revoked, skippedPaid, hostingExpired };
}

/** How many codes exist, live and withdrawn, for the overview counters. */
export async function accessCodeStats(): Promise<{
  total: number;
  live: number;
  redemptions: number;
}> {
  await ensureAccessCodeSchema();
  const { rows } = await sql<{ total: string; live: string; redemptions: string }>`
    SELECT
      (SELECT COUNT(*) FROM access_codes) AS total,
      (SELECT COUNT(*) FROM access_codes
        WHERE revoked_at IS NULL
          AND uses < max_uses
          AND (expires_at IS NULL OR expires_at > NOW())) AS live,
      (SELECT COUNT(*) FROM access_code_redemptions) AS redemptions
  `;
  return {
    total: Number(rows[0]?.total ?? 0),
    live: Number(rows[0]?.live ?? 0),
    redemptions: Number(rows[0]?.redemptions ?? 0),
  };
}
