import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import {
  ACCESS_CODE_ALPHABET,
  ACCESS_CODE_BODY_LENGTH,
  ACCESS_WINDOW_DAYS,
  compSubscriptionId,
  formatAccessCode,
  hashAccessCode,
  isAccessCodeKind,
  mintAccessCode,
  normalizeAccessCode,
} from './accessCodeFormat';
import { ensureAccessCodeSchema, redeemAccessCode } from './accessCodes';
import { ensureCustomServerSchema } from './customServers';
import {
  entitlementPermitsHosting,
  expireLapsedSlots,
  readEntitlement,
  revokeSimulatedEntitlements,
  writeEntitlement,
} from './premium';

/**
 * Access codes.
 *
 * Three kinds of claim are made here, and they are separated because they are
 * settled by different means.
 *
 *   1. **The format**, which is arithmetic and runs everywhere.
 *   2. **The two duplicated files**, settled by reading both copies off disk.
 *      This is the gate that makes duplicating a module across two Next apps an
 *      acceptable thing to have done rather than a time bomb.
 *   3. **What redemption actually does to the database**, which needs a real
 *      Postgres and skips without one — the same arrangement `premium.test.ts`,
 *      `creditLedger.test.ts` and the rest already use.
 */

const here = dirname(fileURLToPath(import.meta.url));

function testUrl(): string | null {
  if (process.env.POSTGRES_TEST_URL) return process.env.POSTGRES_TEST_URL;
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

/** CRLF-normalised, because `core.autocrlf` is true in this repository. */
function source(...parts: string[]): string {
  return readFileSync(join(here, '..', ...parts), 'utf8').replace(/\r\n/g, '\n');
}

/* ---------------------------------------------------------------------- */
/* The format                                                              */
/* ---------------------------------------------------------------------- */

describe('the code format', () => {
  it('mints codes in the shape a human is given them', () => {
    for (let i = 0; i < 200; i++) {
      const code = mintAccessCode();
      expect(code).toMatch(/^AN-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
      expect(normalizeAccessCode(code)).toHaveLength(ACCESS_CODE_BODY_LENGTH);
    }
  });

  it('never mints a character the alphabet excludes', () => {
    /* I, L, O and U are out: three because they are what people mistype, and
     * `U` so a random string cannot spell something unfortunate. A mint that
     * emitted one would produce codes `normalizeAccessCode` silently rewrites
     * into a different code — which would hash to something no row holds. */
    for (let i = 0; i < 500; i++) {
      for (const ch of normalizeAccessCode(mintAccessCode())!) {
        expect(ACCESS_CODE_ALPHABET, `minted ${ch}`).toContain(ch);
      }
    }
  });

  it('reads back a code however a person types it', () => {
    const code = 'AN-7Q2K-4M8P-XR3T';
    const canonical = normalizeAccessCode(code);
    expect(canonical).toBe('7Q2K4M8PXR3T');
    for (const variant of [
      'an-7q2k-4m8p-xr3t',       // lower case
      '  AN 7Q2K 4M8P XR3T  ',   // spaces, padding
      '7Q2K4M8PXR3T',            // body only, no prefix
      'AN7Q2K4M8PXR3T',          // no separators
      'an_7q2k_4m8p_xr3t',       // underscores
    ]) {
      expect(normalizeAccessCode(variant), variant).toBe(canonical);
    }
  });

  it('folds the letters it refuses to mint, so a mistype still redeems', () => {
    // I and L read as 1, O reads as 0 — Crockford's rule, and the reason those
    // three are not in the alphabet in the first place. Somebody reading a code
    // off a printed card should not lose 30 days to a serif.
    expect(normalizeAccessCode('AN-I23L-4567-89AB')).toBe('1231456789AB');
    expect(normalizeAccessCode('AN-O123-4567-89AB')).toBe('0123456789AB');
  });

  it('does not eat two characters from a code whose body begins AN', () => {
    /* `A` and `N` are both in the alphabet, so one code in 1024 starts with the
     * prefix's own letters. Stripping a leading `AN` unconditionally would turn
     * each of those into a permanent "invalid code" for whoever was holding it.
     * The prefix comes off only when what is left is exactly a body. */
    const body = `AN${'2'.repeat(ACCESS_CODE_BODY_LENGTH - 2)}`;
    expect(normalizeAccessCode(body)).toBe(body);
    expect(normalizeAccessCode(formatAccessCode(body))).toBe(body);
  });

  it('refuses anything that is not a code', () => {
    for (const junk of ['', 'AN-', 'hello', '1234', null, undefined, 42, {},
      'AN-7Q2K-4M8P-XR3T-EXTRA']) {
      expect(normalizeAccessCode(junk as unknown), String(junk)).toBeNull();
      expect(hashAccessCode(junk as unknown), String(junk)).toBeNull();
    }
  });

  it('hashes stably, distinctly, and the same for every spelling of one code', () => {
    const code = mintAccessCode();
    expect(hashAccessCode(code)).toBe(hashAccessCode(code.toLowerCase().replace(/-/g, ' ')));
    expect(hashAccessCode(code)).not.toBe(hashAccessCode(mintAccessCode()));
    expect(hashAccessCode(code)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('domain-separates its digest from every other sha256 in the schema', async () => {
    /* `players.email_hash` is a bare `sha256(lower(email))`. If a code hashed
     * the same way, a value that appeared in both columns would mean two
     * different things and a lookup could be crossed between them. */
    const { createHash } = await import('node:crypto');
    const body = normalizeAccessCode(mintAccessCode())!;
    const bare = createHash('sha256').update(body).digest('hex');
    expect(hashAccessCode(body)).not.toBe(bare);
  });

  it('only knows the two kinds the product sells', () => {
    expect(isAccessCodeKind('play')).toBe(true);
    expect(isAccessCodeKind('server')).toBe(true);
    for (const junk of ['both', 'PLAY', '', null, undefined, 1]) {
      expect(isAccessCodeKind(junk), String(junk)).toBe(false);
    }
  });
});

/* ---------------------------------------------------------------------- */
/* The duplicated files                                                    */
/* ---------------------------------------------------------------------- */

describe('the two copies that must not drift', () => {
  it('the format module is byte-identical in both apps', () => {
    /* Two Next apps, two deployments, no shared package and no import that
     * reaches between them — so the file is duplicated on purpose. What makes
     * that acceptable is this assertion: the admin app mints a code and stores
     * its digest, the site app hashes what a player typed and looks the digest
     * up, and one changed character in either copy makes every issued code
     * unredeemable in a way that looks exactly like a customer mistyping. */
    const siteCopy = source('lib', 'accessCodeFormat.ts');
    const adminCopy = readFileSync(
      join(here, '..', '..', 'admin', 'lib', 'accessCodeFormat.ts'),
      'utf8'
    ).replace(/\r\n/g, '\n');
    expect(adminCopy).toBe(siteCopy);
  });

  it('both apps declare the same access-code schema', () => {
    /* `credit_events` already lives this way: canonical in one app, copied into
     * the other so neither can 500 on a database the other has never touched,
     * with a comment saying which is which. A copy without a gate is how two
     * declarations drift until one deployment is writing a column the other
     * does not have. */
    const siteDdl = ddl(source('lib', 'accessCodes.ts'));
    const adminDdl = ddl(
      readFileSync(join(here, '..', '..', 'admin', 'lib', 'accessCodes.ts'), 'utf8')
        .replace(/\r\n/g, '\n')
    );
    expect(siteDdl.length).toBeGreaterThan(0);
    expect(adminDdl).toEqual(siteDdl);
  });

  it('every reader of the access window agrees what 30 days means', () => {
    /* A code grants days by MOVING `access_granted_at`, because the window is
     * fixed and there is no expiry column. Three files hard-code that window —
     * this one, the site's status read and the admin's snapshot — and if they
     * ever disagree, a "30-day" code grants some other number of days and
     * nothing anywhere reports an error. */
    const fromPlayerDb = /const ACCESS_DAYS = (\d+)/.exec(source('lib', 'playerDb.ts'));
    const fromAdmin = /const ACCESS_WINDOW_DAYS = (\d+)/.exec(
      readFileSync(join(here, '..', '..', 'admin', 'lib', 'playerAccess.ts'), 'utf8')
    );
    expect(fromPlayerDb, 'playerDb.ts no longer declares ACCESS_DAYS').not.toBeNull();
    expect(fromAdmin, 'admin/playerAccess.ts no longer declares ACCESS_WINDOW_DAYS').not.toBeNull();
    expect(Number(fromPlayerDb![1])).toBe(ACCESS_WINDOW_DAYS);
    expect(Number(fromAdmin![1])).toBe(ACCESS_WINDOW_DAYS);
  });

  it('the redemption path never reads a code back out', () => {
    /* `code_enc` is the operator's decryptable copy, and it lives behind the
     * admin session and an audited reveal. The site app has no business
     * selecting it: a redemption only ever needs to match a digest, and a site
     * route that could read codes back would turn any bug that leaks a response
     * body into a leak of every unclaimed grant.
     *
     * Comments and the CREATE statements are stripped before the scrape. Both
     * files DISCUSS `code_enc`, and the canonical declaration necessarily
     * DECLARES it — the admin app has to have somewhere to write it. Neither is
     * a read. A gate that a truthful comment or the schema itself can fail is a
     * gate people satisfy by deleting the comment. */
    const siteReads = codeOnly(source('lib', 'accessCodes.ts'))
      .replace(/CREATE (?:TABLE|INDEX) IF NOT EXISTS[^`]*/g, '');
    expect(siteReads).not.toContain('code_enc');
    expect(codeOnly(source('app', 'api', 'redeem', 'route.ts'))).not.toContain('code_enc');
  });

  it('the redeem route refuses a caller with no session', () => {
    const route = source('app', 'api', 'redeem', 'route.ts');
    expect(route).toMatch(/status:\s*401/);
    expect(route).toContain('resolveActor');
  });
});

/**
 * The CREATE statements in a file, whitespace-flattened so that indentation
 * cannot fail the comparison.
 *
 * `[^`]*` runs to the end of the template literal the statement sits in, which
 * is what makes this work across two files that wrap their SQL differently —
 * one in `db.query(...)`, the other in a `sql` tagged template. The `(` filter
 * discards the prose mentions of "CREATE TABLE IF NOT EXISTS" in both headers:
 * those are a backtick pair with nothing between them and the closing tick, so
 * they match empty and carry no column list.
 */
function ddl(src: string): string[] {
  return (src.match(/CREATE (?:TABLE|INDEX) IF NOT EXISTS[^`]*/g) ?? [])
    .filter((statement) => statement.includes('('))
    .map((statement) => statement.replace(/\s+/g, ' ').trim())
    .sort();
}

/** Source with block and line comments removed, for scrapes about what the code DOES. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/* ---------------------------------------------------------------------- */
/* Against a real Postgres                                                 */
/* ---------------------------------------------------------------------- */

/**
 * ...0015-0017. See serverContent.test.ts for the register of claimed ids —
 * vitest runs test FILES in parallel against one database, and a collision
 * breaks a sibling suite rather than this one, which reads as flakiness.
 */
const REDEEMER = '00000000-0000-4000-8000-000000000015';
const OTHER = '00000000-0000-4000-8000-000000000016';
const LOCKED = '00000000-0000-4000-8000-000000000017';
const PLAYERS = [REDEEMER, OTHER, LOCKED];

const DAY_MS = 24 * 60 * 60 * 1000;

suite('redeeming a code (integration)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client({ connectionString: URL_!, ssl: { rejectUnauthorized: false } });
    await db.connect();
    const which = await db.query('SELECT current_database() AS db');
    if (which.rows[0].db !== 'aether_test') {
      throw new Error(`refusing to run against "${which.rows[0].db}" — expected aether_test`);
    }
    await db.query(`
      CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY, handle TEXT, credit_balance INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    /* The shared fixture table is minimal; access lives in columns the other
     * suites do not use. Additive, so running this file cannot change what a
     * sibling suite sees. */
    await db.query(`
      ALTER TABLE players
        ADD COLUMN IF NOT EXISTS access_granted_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS access_revoked_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS status TEXT,
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
    for (const id of PLAYERS) {
      await db.query(
        `INSERT INTO players (id, credit_balance) VALUES ($1, 0) ON CONFLICT (id) DO NOTHING`,
        [id]
      );
    }
    await db.query(`UPDATE players SET status = 'locked' WHERE id = $1`, [LOCKED]);
    await ensureCustomServerSchema(db);
    /* The code tables, built by the same function a cold route would call.
     * `redeemAccessCode` ensures them itself, but `beforeEach` deletes from
     * them before the first redemption has ever run. */
    await ensureAccessCodeSchema(db);
  });

  const reset = async () => {
    await db.query(`DELETE FROM access_code_redemptions WHERE player_id = ANY($1)`, [PLAYERS]);
    await db.query(`DELETE FROM access_codes WHERE created_by = 'accessCodes.test'`);
    await db.query(`DELETE FROM server_slot_grants WHERE player_id = ANY($1)`, [PLAYERS]);
    await db.query(`DELETE FROM server_entitlements WHERE player_id = ANY($1)`, [PLAYERS]);
    await db.query(
      `UPDATE players SET access_granted_at = NULL, access_revoked_at = NULL WHERE id = ANY($1)`,
      [PLAYERS]
    );
  };
  beforeEach(reset);
  afterAll(async () => {
    if (!db) return;
    await reset();
    await db.end();
  });

  /** A code row, minted the way the admin app mints one. */
  async function mint(over: {
    kind?: 'play' | 'server';
    days?: number;
    maxUses?: number;
    expiresAt?: string | null;
    revoked?: boolean;
  } = {}) {
    const code = mintAccessCode();
    const codeHash = hashAccessCode(code)!;
    await db.query(
      `INSERT INTO access_codes
         (code_hash, code_hint, kind, days, max_uses, created_by, expires_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, 'accessCodes.test', $6, $7)`,
      [
        codeHash,
        'AN-TEST-...',
        over.kind ?? 'play',
        over.days ?? 30,
        over.maxUses ?? 1,
        over.expiresAt ?? null,
        over.revoked ? new Date().toISOString() : null,
      ]
    );
    return { code, codeHash };
  }

  /**
   * Days of access remaining, by the rule every reader in the codebase uses —
   * but measured against the DATABASE's clock rather than this machine's.
   *
   * The obvious version subtracts `Date.now()` from a timestamp Postgres wrote
   * with `NOW()`, and it fails intermittently: the test database is a hosted
   * Neon instance whose clock is a second or two ahead of a laptop's, and the
   * ceiling in the real formula turns a two-second lead into a whole extra day.
   * "30" became "31" on some machines and not others, which is the exact shape
   * of a gate that gets marked flaky and then ignored. Asking Postgres for the
   * interval removes the second clock entirely, and the assertions compare a
   * fractional day so nothing is rounded before it is checked.
   */
  async function daysLeft(playerId: string): Promise<number> {
    const r = await db.query(
      `SELECT CASE
                WHEN access_granted_at IS NULL OR access_revoked_at IS NOT NULL THEN 0
                ELSE GREATEST(0, EXTRACT(EPOCH FROM
                       (access_granted_at + make_interval(days => $2::int) - NOW())) / 86400)
              END AS days
         FROM players WHERE id = $1`,
      [playerId, ACCESS_WINDOW_DAYS]
    );
    return Number(r.rows[0]?.days ?? 0);
  }

  async function usesOf(codeHash: string): Promise<number> {
    const r = await db.query(`SELECT uses FROM access_codes WHERE code_hash = $1`, [codeHash]);
    return Number(r.rows[0]?.uses ?? -1);
  }

  it('turns a code into the same 30 days a purchase buys', async () => {
    expect(await daysLeft(REDEEMER)).toBe(0);
    const { code, codeHash } = await mint({ days: 30 });

    const out = await redeemAccessCode(db, { code, playerId: REDEEMER });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.kind).toBe('play');
    expect(await daysLeft(REDEEMER)).toBeCloseTo(30, 3);
    expect(await usesOf(codeHash)).toBe(1);
  });

  it('adds to the time a player already has instead of replacing it', async () => {
    /* Somebody with 12 days left who is given a 30-day code should end on 42.
     * Setting `access_granted_at = NOW()` — the obvious implementation, and
     * what the purchase path does — would silently confiscate the 12 they had
     * already paid for. */
    await db.query(
      `UPDATE players SET access_granted_at = NOW() - make_interval(days => $2::int) WHERE id = $1`,
      [REDEEMER, ACCESS_WINDOW_DAYS - 12]
    );
    expect(await daysLeft(REDEEMER)).toBeCloseTo(12, 3);

    const { code } = await mint({ days: 30 });
    expect((await redeemAccessCode(db, { code, playerId: REDEEMER })).ok).toBe(true);
    expect(await daysLeft(REDEEMER)).toBeCloseTo(42, 3);
  });

  it('grants from today when the access a player had has already lapsed', async () => {
    await db.query(
      `UPDATE players SET access_granted_at = NOW() - make_interval(days => 90) WHERE id = $1`,
      [REDEEMER]
    );
    expect(await daysLeft(REDEEMER)).toBe(0);

    const { code } = await mint({ days: 7 });
    expect((await redeemAccessCode(db, { code, playerId: REDEEMER })).ok).toBe(true);
    expect(await daysLeft(REDEEMER)).toBeCloseTo(7, 3);
  });

  it('lifts a revoked flag rather than granting days nobody can use', async () => {
    await db.query(
      `UPDATE players SET access_granted_at = NOW(), access_revoked_at = NOW() WHERE id = $1`,
      [REDEEMER]
    );
    const { code } = await mint({ days: 30 });
    expect((await redeemAccessCode(db, { code, playerId: REDEEMER })).ok).toBe(true);
    expect(await daysLeft(REDEEMER)).toBeCloseTo(30, 3);
  });

  it('cannot be redeemed twice by the same account, and costs no use trying', async () => {
    const { code, codeHash } = await mint({ days: 30, maxUses: 5 });
    expect((await redeemAccessCode(db, { code, playerId: REDEEMER })).ok).toBe(true);
    expect(await usesOf(codeHash)).toBe(1);

    const again = await redeemAccessCode(db, { code, playerId: REDEEMER });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe('already_redeemed');
    /* The important half: the second attempt must not consume one of the five
     * uses. A shareable code that burns an allowance on double-clicks runs out
     * long before the people it was meant for get to it. */
    expect(await usesOf(codeHash)).toBe(1);
    expect(await daysLeft(REDEEMER)).toBeCloseTo(30, 3);
  });

  it('stops at its use limit', async () => {
    const { code, codeHash } = await mint({ days: 30, maxUses: 1 });
    expect((await redeemAccessCode(db, { code, playerId: REDEEMER })).ok).toBe(true);

    const second = await redeemAccessCode(db, { code, playerId: OTHER });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('exhausted');
    expect(await usesOf(codeHash)).toBe(1);
    expect(await daysLeft(OTHER)).toBe(0);
  });

  it('lets a multi-use code be shared until it runs out', async () => {
    const { code, codeHash } = await mint({ days: 30, maxUses: 2 });
    expect((await redeemAccessCode(db, { code, playerId: REDEEMER })).ok).toBe(true);
    expect((await redeemAccessCode(db, { code, playerId: OTHER })).ok).toBe(true);
    expect(await usesOf(codeHash)).toBe(2);
    expect(await daysLeft(REDEEMER)).toBeCloseTo(30, 3);
    expect(await daysLeft(OTHER)).toBeCloseTo(30, 3);
  });

  it('refuses a withdrawn code, an expired one, and one nobody minted', async () => {
    const withdrawn = await mint({ revoked: true });
    const lapsed = await mint({ expiresAt: new Date(Date.now() - DAY_MS).toISOString() });

    const a = await redeemAccessCode(db, { code: withdrawn.code, playerId: REDEEMER });
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.reason).toBe('revoked');

    const b = await redeemAccessCode(db, { code: lapsed.code, playerId: REDEEMER });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe('expired');

    const c = await redeemAccessCode(db, { code: mintAccessCode(), playerId: REDEEMER });
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.reason).toBe('not_found');

    const d = await redeemAccessCode(db, { code: 'not-a-code', playerId: REDEEMER });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe('malformed');

    expect(await daysLeft(REDEEMER)).toBe(0);
  });

  it('will not let a code lift a moderation lock', async () => {
    /* `locked` is a decision a human made about an account. A code is worth 30
     * days of access, not an appeal. */
    const { code, codeHash } = await mint({ days: 30 });
    const out = await redeemAccessCode(db, { code, playerId: LOCKED });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('player_locked');
    // and the whole attempt rolled back — no use spent, no redemption recorded
    expect(await usesOf(codeHash)).toBe(0);
    const rows = await db.query(
      `SELECT 1 FROM access_code_redemptions WHERE code_hash = $1`,
      [codeHash]
    );
    expect(rows.rows).toHaveLength(0);
  });

  /* ---- the server kind ------------------------------------------------ */

  it('a server code funds exactly one hosting slot', async () => {
    expect(entitlementPermitsHosting(await readEntitlement(db, REDEEMER))).toBe(false);

    const { code } = await mint({ kind: 'server', days: 30 });
    const out = await redeemAccessCode(db, { code, playerId: REDEEMER });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.kind).toBe('server');

    const ent = await readEntitlement(db, REDEEMER);
    expect(ent.maxServers).toBe(1);
    expect(entitlementPermitsHosting(ent)).toBe(true);
    expect(ent.subscriptionId).toMatch(/^comp_sub_/);
    /* NOT marked simulated. A simulated row is a rehearsal that gets swept
     * before payments go live; a comp is a decision that has to survive that
     * sweep. See the next test. */
    expect(ent.simulated).toBe(false);
  });

  it('a server code grants no game access, and a play code no hosting', async () => {
    const server = await mint({ kind: 'server', days: 30 });
    expect((await redeemAccessCode(db, { code: server.code, playerId: REDEEMER })).ok).toBe(true);
    expect(await daysLeft(REDEEMER)).toBe(0);

    const play = await mint({ kind: 'play', days: 30 });
    expect((await redeemAccessCode(db, { code: play.code, playerId: OTHER })).ok).toBe(true);
    expect((await readEntitlement(db, OTHER)).maxServers).toBe(0);
  });

  it('the pretend-purchase sweep does not touch a comped server', async () => {
    /* `revokeSimulatedEntitlements` is the "clean up the rehearsal before going
     * live" button. If a comp were marked simulated, pressing it would silently
     * cancel servers an operator had deliberately given away — and the audit
     * trail would say the sweep did it. */
    const { code } = await mint({ kind: 'server', days: 30 });
    expect((await redeemAccessCode(db, { code, playerId: REDEEMER })).ok).toBe(true);

    const swept = await revokeSimulatedEntitlements(db);
    expect(swept).not.toContain(REDEEMER);
    expect(entitlementPermitsHosting(await readEntitlement(db, REDEEMER))).toBe(true);
  });

  it('a comped slot stops funding a server when its days run out', async () => {
    const { code, codeHash } = await mint({ kind: 'server', days: 30 });
    expect((await redeemAccessCode(db, { code, playerId: REDEEMER })).ok).toBe(true);
    expect((await readEntitlement(db, REDEEMER)).maxServers).toBe(1);

    /* Nothing renews a comp and nothing will ever send an event about one, so
     * an entitlement that only expires when told to is an entitlement that
     * never expires. Wind the slot's date back and sweep. */
    await db.query(
      `UPDATE server_slot_grants SET expires_at = NOW() - make_interval(days => 1)
        WHERE player_id = $1 AND subscription_id = $2`,
      [REDEEMER, compSubscriptionId(codeHash)]
    );
    await expireLapsedSlots(db, REDEEMER);

    const after = await readEntitlement(db, REDEEMER);
    expect(after.maxServers).toBe(0);
    expect(entitlementPermitsHosting(after)).toBe(false);
  });

  it('a lapsing comp does not take a paid subscription down with it', async () => {
    /* The reason the expiry is on the SLOT and not on the entitlement row. A
     * customer who pays AND redeems a comp code has two slots; when the comp
     * runs out they should drop to one, not to none. Had the date been enforced
     * on `server_entitlements.current_period_end` — which holds whichever write
     * landed last — the lapsing gift would have cancelled the purchase. */
    await writeEntitlement(db, {
      playerId: REDEEMER,
      subscriptionId: 'sub_paid_accesscodes_test',
      customerId: 'cus_paid_accesscodes_test',
      status: 'active',
      currentPeriodEnd: null,
    });
    const { code, codeHash } = await mint({ kind: 'server', days: 30 });
    expect((await redeemAccessCode(db, { code, playerId: REDEEMER })).ok).toBe(true);
    expect((await readEntitlement(db, REDEEMER)).maxServers).toBe(2);

    await db.query(
      `UPDATE server_slot_grants SET expires_at = NOW() - make_interval(days => 1)
        WHERE player_id = $1 AND subscription_id = $2`,
      [REDEEMER, compSubscriptionId(codeHash)]
    );
    await expireLapsedSlots(db, REDEEMER);

    const after = await readEntitlement(db, REDEEMER);
    expect(after.maxServers).toBe(1);
    expect(entitlementPermitsHosting(after)).toBe(true);
  });

  it('does not expire a slot that has no date on it', async () => {
    /* Every subscription and every simulated grant carries a NULL `expires_at`,
     * and they must go on funding hosting exactly as before. A sweep that
     * treated NULL as "already lapsed" would cancel every paying customer the
     * first time somebody loaded the servers page. */
    await writeEntitlement(db, {
      playerId: OTHER,
      subscriptionId: 'sub_undated_accesscodes_test',
      customerId: 'cus_undated_accesscodes_test',
      status: 'active',
      currentPeriodEnd: null,
    });
    await expireLapsedSlots(db, OTHER);
    expect((await readEntitlement(db, OTHER)).maxServers).toBe(1);
  });

  it('re-redeeming a server code mints no second slot', async () => {
    /* The subscription id is derived from the code, so the same code upserts
     * one slot row. That is what makes the redemption path safe to retry after
     * a half-finished grant without auditing a free server into existence. */
    const { code } = await mint({ kind: 'server', days: 30, maxUses: 5 });
    expect((await redeemAccessCode(db, { code, playerId: REDEEMER })).ok).toBe(true);
    const again = await redeemAccessCode(db, { code, playerId: REDEEMER });
    expect(again.ok).toBe(false);
    expect((await readEntitlement(db, REDEEMER)).maxServers).toBe(1);
  });
});
