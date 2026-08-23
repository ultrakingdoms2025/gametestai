import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

/**
 * `findOrCreatePlayer` must never hand one person's account to another.
 *
 * ── The defect ────────────────────────────────────────────────────────────
 * Step 2 of the lookup claims a player row by email hash, and the UPDATE that
 * did the claiming had no WHERE guard on `site_user_id`. So a row already
 * belonging to somebody was reassigned to whoever turned up next with a
 * matching email.
 *
 * The trigger is one text field. `admin/` lets an operator edit a player's
 * email; that rewrites `email_hash` and knows nothing about `site_user_id`,
 * because the admin app has no reference to that column anywhere. The next
 * sign-in by the real owner of the new address inherits the other player's
 * credit balance, `game_state`, quest engagements and purchase history - and
 * the original owner, whose hash no longer matches, is quietly issued a fresh
 * empty player. Nothing errors. Nothing is logged. Afterwards there is no way
 * to tell which rows moved.
 *
 * ── Why a real database ───────────────────────────────────────────────────
 * The fix is `AND site_user_id IS NULL` inside the UPDATE, so the guarantee is
 * the statement's own atomicity rather than a SELECT followed by a decision.
 * A mock cannot demonstrate that, for the same reason `creditLedger.test.ts`
 * gives: two concurrent requests both pass a check-then-act.
 *
 * `POSTGRES_URL` is pointed at the test database before `playerDb` is imported,
 * because `makeClient` reads it per call.
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

const URL_ = testUrl();
const suite = URL_ ? describe : describe.skip;

/* Distinct from every other suite's fixtures. Vitest runs files in parallel
 * against this one database, so a shared id makes one file's cleanup another
 * file's flake - which has already happened once in this project. */
const SITE_A = '00000000-0000-4000-8000-0000000000a1';
const SITE_B = '00000000-0000-4000-8000-0000000000b1';
const EMAIL = 'link-test@example.invalid';

suite('findOrCreatePlayer account linking (integration)', () => {
  let db: Client;
  let findOrCreatePlayer: (siteUserId: string, email: string) => Promise<string>;
  let emailHash: string;

  beforeAll(async () => {
    process.env.POSTGRES_URL = URL_!;
    ({ findOrCreatePlayer } = await import('./playerDb'));
    const { createHash } = await import('node:crypto');
    emailHash = createHash('sha256').update(EMAIL.toLowerCase().trim()).digest('hex');

    db = new Client({ connectionString: URL_!, ssl: { rejectUnauthorized: false } });
    await db.connect();
    const which = await db.query('SELECT current_database() AS db');
    if (which.rows[0].db !== 'aether_test') {
      throw new Error(`refusing to run against "${which.rows[0].db}" — expected aether_test`);
    }

    /* The columns this path touches. Added rather than created, because other
     * suites in this database create `players` with their own narrower set and
     * whichever runs first wins. */
    await db.query(`
      CREATE TABLE IF NOT EXISTS players (
        id             TEXT PRIMARY KEY,
        credit_balance INTEGER NOT NULL DEFAULT 0,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    for (const col of [
      'email_hash TEXT', 'email_enc TEXT', 'site_user_id TEXT', 'auth_provider TEXT',
      'status TEXT', 'handle TEXT', 'full_name TEXT', 'updated_at TIMESTAMPTZ',
    ]) {
      await db.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS ${col}`);
    }
    await db.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS players_email_hash_uq ON players (email_hash)'
    );
  });

  afterAll(async () => {
    await db?.query('DELETE FROM players WHERE email_hash = $1', [emailHash]);
    await db?.end();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM players WHERE email_hash = $1', [emailHash]);
  });

  const linkOf = async (id: string) => {
    const r = await db.query('SELECT site_user_id FROM players WHERE id = $1', [id]);
    return r.rows[0]?.site_user_id ?? null;
  };

  it('claims an unlinked player row that matches the email', async () => {
    await db.query(
      `INSERT INTO players (id, email_hash, credit_balance) VALUES ('legacy-1', $1, 500)`,
      [emailHash]
    );

    const id = await findOrCreatePlayer(SITE_A, EMAIL);

    expect(id).toBe('legacy-1');
    expect(await linkOf('legacy-1')).toBe(SITE_A);
  });

  it('refuses to hand a linked player to a different site user', async () => {
    /* THE defect. Before the guard this returned 'owned-1' and site user B
     * walked off with A's 5,000 credits. */
    await db.query(
      `INSERT INTO players (id, email_hash, site_user_id, credit_balance)
       VALUES ('owned-1', $1, $2, 5000)`,
      [emailHash, SITE_A]
    );

    await expect(findOrCreatePlayer(SITE_B, EMAIL)).rejects.toThrow(/already linked/i);
    expect(await linkOf('owned-1')).toBe(SITE_A);
  });

  it('is idempotent for the user who already holds the row', async () => {
    /* Two of our own requests racing is ordinary and must not be an error. */
    await db.query(
      `INSERT INTO players (id, email_hash, site_user_id) VALUES ('mine-1', $1, $2)`,
      [emailHash, SITE_A]
    );

    expect(await findOrCreatePlayer(SITE_A, EMAIL)).toBe('mine-1');
  });

  it('creates a player when nothing matches', async () => {
    const id = await findOrCreatePlayer(SITE_A, EMAIL);
    expect(id).toBeTruthy();
    expect(await linkOf(id)).toBe(SITE_A);
  });

  it('an ordinary sign-in does not rewrite the identity columns', async () => {
    /* `syncPlayerProfile` rewrote email_hash/email_enc on EVERY call, and
     * `auth.ts` calls it on every Google sign-in. An admin correcting a
     * player's email watched the correction vanish at the player's next login,
     * with nothing anywhere explaining why. */
    const { syncPlayerProfile } = await import('./playerDb');
    await db.query(
      `INSERT INTO players (id, email_hash, site_user_id, email_enc)
       VALUES ('sync-1', $1, $2, 'sentinel-value')`,
      [emailHash, SITE_A]
    );

    await syncPlayerProfile(SITE_A, EMAIL, { handle: 'Somebody', overwrite: true });

    const r = await db.query('SELECT email_enc, handle FROM players WHERE id = $1', ['sync-1']);
    expect(r.rows[0].email_enc).toBe('sentinel-value',
    );
    expect(r.rows[0].handle).toBe('Somebody');
  });

  it('reports an email that is already on another player row', async () => {
    /* players.email_hash is UNIQUE as well as site_users.email, and only the
     * second used to be checked before an email change was committed. */
    const { isEmailClaimedByOtherPlayer } = await import('./playerDb');
    await db.query(
      `INSERT INTO players (id, email_hash) VALUES ('other-1', $1)`,
      [emailHash]
    );

    expect(await isEmailClaimedByOtherPlayer(EMAIL, 'someone-else')).toBe(true);
    expect(await isEmailClaimedByOtherPlayer(EMAIL, 'other-1')).toBe(false);
  });

  it('two concurrent first-time calls settle on one player, not two', async () => {
    /* The reason the guard is inside the UPDATE rather than a SELECT before it. */
    await db.query(
      `INSERT INTO players (id, email_hash, credit_balance) VALUES ('race-1', $1, 10)`,
      [emailHash]
    );

    const [a, b] = await Promise.all([
      findOrCreatePlayer(SITE_A, EMAIL),
      findOrCreatePlayer(SITE_A, EMAIL),
    ]);

    expect(a).toBe('race-1');
    expect(b).toBe('race-1');
    const count = await db.query('SELECT COUNT(*)::int AS n FROM players WHERE email_hash = $1', [
      emailHash,
    ]);
    expect(count.rows[0].n).toBe(1);
  });
});
