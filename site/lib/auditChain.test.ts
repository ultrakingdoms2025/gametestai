import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

// The ADMIN app's own implementation, imported directly. If the two ever
// disagree, `verifyAuditChain()` in the admin dashboard starts reporting the
// chain as broken at the first row the site wrote — and the person reading that
// screen would reasonably conclude someone had tampered with the log.
import { auditHash as adminAuditHash, sign as adminSign } from '../../admin/lib/hmac';

import { appendAudit, auditHash, ensureAuditSchema, sign } from './auditChain';

/**
 * The site's end of the tamper-evident audit log.
 *
 * `admin/lib/db.ts` keeps an HMAC chain over `audit_log`: each row's
 * `entry_hash` covers (seq | actor | action | resource | previous hash), so
 * editing, inserting or deleting any row breaks every hash after it. An admin
 * moving buildings around a live world is exactly the kind of action that
 * belongs in that log.
 *
 * The map editor lives in the site app (same reason the marketplace catalogue
 * manager does — it needs the catalogue, the player session and same-origin
 * access to the game), so the site has to be able to append to a chain the
 * admin app owns. That is only safe if the two agree byte for byte, which is
 * what the first test here checks against the admin app's real source.
 */

function testUrl(): string | null {
  if (process.env.POSTGRES_TEST_URL) return process.env.POSTGRES_TEST_URL;
  const here = dirname(fileURLToPath(import.meta.url));
  const envFile = join(here, '..', '.env.test.local');
  if (!existsSync(envFile)) return null;
  const line = readFileSync(envFile, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith('POSTGRES_TEST_URL='));
  if (!line) return null;
  return line.slice('POSTGRES_TEST_URL='.length).trim().replace(/^["']|["']$/g, '');
}

const SECRET = 'map-editor-test-secret-not-a-production-key';
process.env.HMAC_SECRET = SECRET;

describe('auditChain agrees with the admin app', () => {
  it('produces the same entry hash for the same inputs', () => {
    const cases: Array<[number, string, string, string, string]> = [
      [1, 'owner@example.com', 'map.overlay.save', 'world:medieval', adminSign('genesis')],
      [42, 'other@example.com', 'map.overlay.revert', 'world:station', 'a'.repeat(64)],
      [7, 'ünïcode@example.com', 'map.overlay.save', 'world:citadel', 'deadbeef'],
    ];
    for (const [seq, actor, action, resource, prev] of cases) {
      expect(auditHash(seq, actor, action, resource, prev)).toBe(
        adminAuditHash(seq, actor, action, resource, prev)
      );
    }
  });

  it('signs the genesis marker identically, so the first row of a fresh chain matches', () => {
    expect(sign('genesis')).toBe(adminSign('genesis'));
  });

  it('refuses to sign at all when no secret is configured', () => {
    const saved = process.env.HMAC_SECRET;
    delete process.env.HMAC_SECRET;
    try {
      expect(() => sign('anything')).toThrow();
    } finally {
      process.env.HMAC_SECRET = saved;
    }
  });
});

const URL_ = testUrl();
const suite = URL_ ? describe : describe.skip;

suite('appendAudit (integration)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client({ connectionString: URL_!, ssl: { rejectUnauthorized: false } });
    await db.connect();
    const which = await db.query('SELECT current_database() AS db');
    if (which.rows[0].db !== 'aether_test') {
      throw new Error(`refusing to run against "${which.rows[0].db}" — expected aether_test`);
    }
    await ensureAuditSchema(db);
  });

  afterAll(async () => {
    if (db) await db.end();
  });

  beforeEach(async () => {
    // A chain is only checkable from its own genesis, and deleting rows is what
    // breaks it — so the test database's log is emptied rather than filtered.
    await db.query('DELETE FROM audit_log');
  });

  it('writes a chain the ADMIN app can verify end to end', async () => {
    await appendAudit(db, {
      actor: 'owner@example.com',
      action: 'map.overlay.save',
      resource: 'world:medieval',
      detail: JSON.stringify({ version: 1, entries: 3 }),
      ip: '203.0.113.7',
    });
    await appendAudit(db, {
      actor: 'owner@example.com',
      action: 'map.overlay.revert',
      resource: 'world:medieval',
      detail: JSON.stringify({ version: 2, revertedTo: 1 }),
    });

    const { rows } = await db.query(
      'SELECT seq, actor, action, resource, prev_hash, entry_hash, detail, ip_hash FROM audit_log ORDER BY seq ASC'
    );
    expect(rows).toHaveLength(2);

    // Verified with the ADMIN app's hash function, exactly as
    // `verifyAuditChain()` does it.
    let prevHash = adminSign('genesis');
    for (const row of rows) {
      expect(row.prev_hash).toBe(prevHash);
      const expected = adminAuditHash(
        Number(row.seq),
        row.actor,
        row.action,
        row.resource,
        prevHash
      );
      expect(row.entry_hash).toBe(expected);
      prevHash = row.entry_hash;
    }

    expect(rows[0].ip_hash).toHaveLength(64);
    expect(rows[1].ip_hash).toBeNull();
  });

  it('breaks verification if a row is edited — which is the whole point', async () => {
    await appendAudit(db, { actor: 'a@x.com', action: 'map.overlay.save', resource: 'world:race' });
    await appendAudit(db, { actor: 'a@x.com', action: 'map.overlay.save', resource: 'world:race' });

    await db.query("UPDATE audit_log SET resource = 'world:dock' WHERE seq = (SELECT MIN(seq) FROM audit_log)");

    const { rows } = await db.query(
      'SELECT seq, actor, action, resource, entry_hash FROM audit_log ORDER BY seq ASC'
    );
    let prevHash = adminSign('genesis');
    let broken: number | null = null;
    for (const row of rows) {
      const expected = adminAuditHash(Number(row.seq), row.actor, row.action, row.resource, prevHash);
      if (expected !== row.entry_hash) {
        broken = Number(row.seq);
        break;
      }
      prevHash = row.entry_hash;
    }
    expect(broken).toBe(Number(rows[0].seq));
  });
});
