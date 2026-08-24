import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { Client, PoolClient } from 'pg';

/**
 * The site's end of the admin app's tamper-evident audit log.
 *
 * `admin/lib/db.ts` keeps an HMAC chain over `audit_log`: every row's
 * `entry_hash` covers (seq | actor | action | resource | previous entry hash),
 * so editing, inserting or deleting any row breaks every hash after it and
 * `verifyAuditChain()` reports where. An admin moving buildings around a live
 * world is exactly the kind of action that belongs in it.
 *
 * The map editor lives in the site app — same reason the marketplace catalogue
 * manager does: it needs the catalogue, the player session and same-origin
 * access to the game. So the site appends to a chain the admin app owns, and
 * `auditChain.test.ts` imports `admin/lib/hmac.ts` DIRECTLY and asserts the two
 * produce identical digests. A silent fork here would show up in the dashboard
 * as "the log has been tampered with", which is a bad way to find out.
 *
 * ── One thing done differently from `admin/lib/db.ts`, on purpose ──────────
 *
 * The admin version hashes `MAX(seq) + 1` and then lets `BIGSERIAL` assign the
 * actual `seq`. Those two numbers agree only while nothing has ever consumed a
 * sequence value without committing a row — one rolled-back insert and the
 * sequence is permanently ahead of `MAX(seq)`, after which every row it writes
 * is hashed against a seq it does not have, and the chain reads as broken from
 * that point on forever.
 *
 * So this inserts first, takes the seq the database actually assigned, and then
 * writes the hash over that. The result is a chain `verifyAuditChain()`
 * accepts, computed from the number it will actually verify against.
 */

type Db = Client | PoolClient;

/**
 * Advisory-lock key for appends.
 *
 * Reading the previous hash and inserting the next row is a read-then-write; two
 * concurrent appends would otherwise chain off the same predecessor and one of
 * them would be wrong. An arbitrary constant — it only has to be the same one
 * on every appender.
 */
const AUDIT_LOCK = 0x41455448; // 'AETH'

function secret(): string {
  const s = process.env.HMAC_SECRET;
  if (!s) throw new Error('HMAC_SECRET env var is not set');
  return s;
}

/** HMAC-SHA256 hex digest. Identical to `admin/lib/hmac.ts`. */
export function sign(data: string): string {
  return createHmac('sha256', secret()).update(data, 'utf8').digest('hex');
}

/** SHA-256 of a lower-cased, trimmed value. Identical to `admin/lib/hmac.ts`. */
export function sha256(input: string): string {
  return createHash('sha256').update(input.toLowerCase().trim()).digest('hex');
}

/** HMAC over a single audit entry. Identical to `admin/lib/hmac.ts`. */
export function auditHash(
  seq: number,
  actor: string,
  action: string,
  resource: string,
  prevHash: string
): string {
  return sign([seq, actor, action, resource, prevHash].join('|'));
}

/**
 * The table, declared exactly as `admin/lib/db.ts` declares it.
 *
 * `CREATE TABLE IF NOT EXISTS`, so whichever app runs first wins and the other
 * is a no-op — the same arrangement `credit_events` already has between these
 * two apps.
 */
export async function ensureAuditSchema(db: Db): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id          TEXT   PRIMARY KEY,
      seq         BIGSERIAL UNIQUE NOT NULL,
      prev_hash   TEXT   NOT NULL,
      entry_hash  TEXT   NOT NULL,
      actor       TEXT   NOT NULL,
      action      TEXT   NOT NULL,
      resource    TEXT   NOT NULL,
      detail      TEXT,
      ip_hash     TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export interface AuditEntry {
  actor: string;
  action: string;
  resource: string;
  detail?: string | null;
  ip?: string | null;
}

export interface AuditResult {
  seq: number;
  prevHash: string;
  entryHash: string;
}

/**
 * Append one row to the chain.
 *
 * Runs in whatever transaction the caller already has, if any — which is the
 * useful case: an audit row that rolls back with the change it describes is
 * right, and one that survives a rolled-back change is a lie. The advisory lock
 * is session-scoped rather than transaction-scoped so it behaves the same
 * either way, and is always released.
 */
export async function appendAudit(db: Db, entry: AuditEntry): Promise<AuditResult> {
  await ensureAuditSchema(db);

  const actor = String(entry.actor ?? '').slice(0, 200);
  const action = String(entry.action ?? '').slice(0, 120);
  const resource = String(entry.resource ?? '').slice(0, 200);
  const detail = entry.detail ? String(entry.detail).slice(0, 4000) : null;
  const ipHash = entry.ip ? sha256(String(entry.ip)) : null;

  await db.query('SELECT pg_advisory_lock($1)', [AUDIT_LOCK]);
  try {
    const last = await db.query('SELECT entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1');
    const prevHash: string = last.rows[0]?.entry_hash ?? sign('genesis');

    const inserted = await db.query(
      `INSERT INTO audit_log (id, prev_hash, entry_hash, actor, action, resource, detail, ip_hash)
       VALUES ($1, $2, '', $3, $4, $5, $6, $7)
       RETURNING seq`,
      [randomUUID(), prevHash, actor, action, resource, detail, ipHash]
    );
    const seq = Number(inserted.rows[0].seq);
    const entryHash = auditHash(seq, actor, action, resource, prevHash);
    await db.query('UPDATE audit_log SET entry_hash = $1 WHERE seq = $2', [entryHash, seq]);

    return { seq, prevHash, entryHash };
  } finally {
    await db.query('SELECT pg_advisory_unlock($1)', [AUDIT_LOCK]).catch(() => {});
  }
}
