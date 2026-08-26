import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import {
  SERVER_HOSTING_CENTS,
  SERVERS_PER_SUBSCRIPTION,
  quoteServerHosting,
  mapStripeStatus,
  entitlementPermitsHosting,
  readEntitlement,
  writeEntitlement,
  claimStripeEvent,
} from './premium';
import { grossUp } from './pricing';
import { ensureCustomServerSchema, createServer } from './customServers';

/**
 * The premium SKU (7b), in Stripe TEST MODE.
 *
 * What test mode does and does not demonstrate is written out in full in
 * `premium.ts`'s header, because it is a fact about the product rather than
 * about these tests and the next person to read it will be looking at the
 * module. In one line: everything except money moving.
 *
 * These tests cover the parts that are ours rather than Stripe's — the status
 * mapping, the entitlement write, its idempotency and its ordering guard — plus
 * two source scrapes over the routes, which is how the existing suite already
 * pins "there is no POST on the leaderboard".
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

describe('the subscription SKU', () => {
  it('is priced through the same gross-up as every other SKU', () => {
    const q = quoteServerHosting();
    expect(q.netCents).toBe(SERVER_HOSTING_CENTS);
    /* Not a second arithmetic. `pricing.ts` exists so the number the page shows
     * is the number Stripe is handed, and a subscription computing its own would
     * be the first time anyone found out the two disagree. */
    expect(q.totalCents).toBe(grossUp(SERVER_HOSTING_CENTS));
    expect(q.feeCents).toBe(q.totalCents - q.netCents);
    expect(q.interval).toBe('month');
  });

  it('grosses up the RECURRING amount, so the fee recurs with it', () => {
    /* A gross-up applied once to a first invoice and not to the rest is a slow
     * leak nobody notices for a year. Asserted against the quote the checkout
     * route actually binds. */
    const route = source('app', 'api', 'checkout', 'route.ts');
    expect(route).toContain('quoteServerHosting');
    expect(route).toMatch(/mode:\s*'subscription'/);
    expect(route).toMatch(/recurring:\s*\{\s*interval:\s*'month'\s*\}/);
    expect(route).toContain('totalCents');
  });

  it('sends the checkout back with something the webhook can attribute', () => {
    /* A subscription renews with no browser attached, so the webhook is the only
     * grant path — and it can only grant if the session carries the player. */
    const route = source('app', 'api', 'checkout', 'route.ts');
    expect(route).toContain('client_reference_id');
  });

  it('the webhook verifies the signature before it writes anything', () => {
    const hook = source('app', 'api', 'webhook', 'route.ts');
    /* The CALLS, not the import line — an `import { writeEntitlement }` at the
     * top of the file would otherwise make this test pass by accident whatever
     * the body did. */
    const verifyAt = hook.indexOf('webhooks.constructEvent(');
    const writeAt = hook.indexOf('await writeEntitlement(');
    expect(verifyAt).toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(-1);
    expect(verifyAt, 'signature verification must precede the write').toBeLessThan(writeAt);
    /* And it still refuses an unverifiable event outright rather than processing
     * it "just in case", which would make the signature decorative. */
    expect(hook).toMatch(/Signature verification failed/);
  });

  it('claims the Stripe event id before acting on it', () => {
    const hook = source('app', 'api', 'webhook', 'route.ts');
    /* Again the calls, for the same reason. Stripe retries anything that is not
     * a 2xx, so a second delivery must not be a second write. */
    expect(hook.indexOf('await claimStripeEvent('))
      .toBeLessThan(hook.indexOf('await writeEntitlement('));
  });
});

describe('mapping Stripe status onto entitlement', () => {
  it('treats a trial as active and an incomplete subscription as not', () => {
    expect(mapStripeStatus('active')).toBe('active');
    expect(mapStripeStatus('trialing')).toBe('active');
    /* `incomplete` means the first payment has NOT succeeded. Treating it as
     * active is how a subscription that never pays gets a month of hosting. */
    expect(mapStripeStatus('incomplete')).toBe('inactive');
    expect(mapStripeStatus('past_due')).toBe('past_due');
    expect(mapStripeStatus('unpaid')).toBe('past_due');
    expect(mapStripeStatus('canceled')).toBe('canceled');
    expect(mapStripeStatus('incomplete_expired')).toBe('canceled');
  });

  it('maps anything it has never heard of to inactive', () => {
    /* Fails closed. A status Stripe adds next year must not accidentally satisfy
     * `entitlementPermitsHosting`. */
    for (const unknown of ['', 'paused', 'whatever', undefined, null]) {
      expect(mapStripeStatus(unknown as string)).toBe('inactive');
    }
  });

  it('gives past_due a grace period, and cancellation none', () => {
    const base = {
      playerId: 'p', subscriptionId: 's', customerId: null,
      currentPeriodEnd: null, simulated: false,
    };
    expect(entitlementPermitsHosting({ ...base, status: 'active', maxServers: 1 })).toBe(true);
    /* Stripe retries a failed payment for days. Tearing down a running server on
     * the first decline punishes an expired card, not a non-payer. */
    expect(entitlementPermitsHosting({ ...base, status: 'past_due', maxServers: 1 })).toBe(true);
    expect(entitlementPermitsHosting({ ...base, status: 'canceled', maxServers: 0 })).toBe(false);
    expect(entitlementPermitsHosting({ ...base, status: 'inactive', maxServers: 0 })).toBe(false);
  });
});

/* ---------------------------------------------------------------------- */
/* Against a real Postgres                                                 */
/* ---------------------------------------------------------------------- */

/** ...0010. See serverContent.test.ts for the register of claimed ids. */
/* Fixture server names carry a suite-unique prefix because a server SLUG is
 * globally unique and derived from the name, while `aether_test` is shared and
 * vitest runs test FILES in parallel. `customServers.test.ts` also wanted a
 * "Lodestar Annexe"; distinct player ids do not separate them, because the
 * clash is on the slug, not the owner. Whichever suite got there first won and
 * the other failed `slug_taken` — so the FAILURE MOVED BETWEEN SUITES from run
 * to run, which reads as flakiness rather than as a name collision. */
const OWNER = '00000000-0000-4000-8000-000000000010';

suite('entitlement (integration)', () => {
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
    await db.query(
      `INSERT INTO players (id, credit_balance) VALUES ($1, 0) ON CONFLICT (id) DO NOTHING`,
      [OWNER]
    );
    await ensureCustomServerSchema(db);
  });

  const reset = async () => {
    await db.query(`DELETE FROM custom_servers WHERE owner_player_id = $1`, [OWNER]);
    await db.query(`DELETE FROM server_entitlements WHERE player_id = $1`, [OWNER]);
    await db.query(`DELETE FROM stripe_webhook_events WHERE event_id LIKE 'evt_test_%'`);
  };
  beforeEach(reset);
  afterAll(async () => {
    if (!db) return;
    await reset();
    await db.end();
  });

  const fact = (over: Partial<Parameters<typeof writeEntitlement>[1]> = {}) => ({
    playerId: OWNER,
    subscriptionId: 'sub_test_1',
    customerId: 'cus_test_1',
    status: 'active' as const,
    currentPeriodEnd: null,
    ...over,
  });

  it('a signed subscription event is what makes a server creatable', async () => {
    /* Before: no entitlement, so no server. This is the whole point of 7b — the
     * SKU is not decoration, it gates the feature. */
    const before = await createServer(db, OWNER, { name: 'Premium Too Early' });
    expect(before.ok).toBe(false);
    if (!before.ok) expect(before.reason).toBe('no_entitlement');

    await writeEntitlement(db, fact());
    const after = await createServer(db, OWNER, { name: 'Premium Lodestar Annexe' });
    expect(after.ok).toBe(true);
  });

  it('one subscription entitles exactly its allowance and no more', async () => {
    await writeEntitlement(db, fact());
    expect((await readEntitlement(db, OWNER)).maxServers).toBe(SERVERS_PER_SUBSCRIPTION);
    for (let i = 0; i < SERVERS_PER_SUBSCRIPTION; i += 1) {
      expect((await createServer(db, OWNER, { name: `Premium Server ${i}` })).ok).toBe(true);
    }
    const over = await createServer(db, OWNER, { name: 'Premium One Too Many' });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toBe('quota');
  });

  it('handles a Stripe event once, however many times it is delivered', async () => {
    expect(await claimStripeEvent(db, 'evt_test_a', 'checkout.session.completed')).toBe(true);
    expect(await claimStripeEvent(db, 'evt_test_a', 'checkout.session.completed')).toBe(false);
  });

  it('a late cancellation takes only its own slot, never a newer subscription', async () => {
    /* The ordering hazard a one-off SKU never had — REVISED when slots became
     * quantity-accumulating. Stripe redelivers, and a `subscription.deleted`
     * for LAST month can land after this month's checkout. Under accumulation
     * each subscription funds its own slot, so the late cancellation releases
     * exactly the old subscription's slot and the new subscription keeps its
     * own — hosting continues, and the net allowance is identical whichever
     * order the two events arrive in. (This test used to assert the
     * cancellation was refused outright; the GUARANTEE it protected — a paid
     * subscription cannot be revoked by a stale event — is unchanged and still
     * asserted below.) */
    await writeEntitlement(db, fact({ subscriptionId: 'sub_old' }));
    await writeEntitlement(db, fact({ subscriptionId: 'sub_new' }));
    const both = await readEntitlement(db, OWNER);
    expect(both.subscriptionId).toBe('sub_new');
    expect(both.maxServers).toBe(2 * SERVERS_PER_SUBSCRIPTION);

    const late = await writeEntitlement(db, fact({ subscriptionId: 'sub_old', status: 'canceled' }));
    expect(late.applied).toBe(true);

    const still = await readEntitlement(db, OWNER);
    expect(still.status).toBe('active');
    expect(still.subscriptionId).toBe('sub_new');
    expect(still.maxServers).toBe(SERVERS_PER_SUBSCRIPTION);
    expect(entitlementPermitsHosting(still)).toBe(true);
  });

  it('refuses a cancellation for a subscription that never funded a slot', async () => {
    await writeEntitlement(db, fact({ subscriptionId: 'sub_new' }));
    const stale = await writeEntitlement(
      db,
      fact({ subscriptionId: 'sub_ghost', status: 'canceled' })
    );
    expect(stale.applied).toBe(false);
    if (!stale.applied) expect(stale.reason).toBe('stale_subscription');
    const still = await readEntitlement(db, OWNER);
    expect(still.status).toBe('active');
    expect(still.maxServers).toBe(SERVERS_PER_SUBSCRIPTION);
  });

  it('accumulates one slot per purchase, and replays add nothing', async () => {
    /* Pay-per-server: each distinct subscription is a purchase and adds a
     * slot; a renewal event for a subscription already counted adds nothing.
     * This is the same path the simulated grant uses, so the two cannot
     * diverge when Stripe goes live. */
    await writeEntitlement(db, fact({ subscriptionId: 'sub_slot_a' }));
    expect((await readEntitlement(db, OWNER)).maxServers).toBe(1);
    await writeEntitlement(db, fact({ subscriptionId: 'sub_slot_a' }));
    expect((await readEntitlement(db, OWNER)).maxServers).toBe(1);
    await writeEntitlement(db, fact({ subscriptionId: 'sub_slot_b' }));
    expect((await readEntitlement(db, OWNER)).maxServers).toBe(2);
    await writeEntitlement(db, fact({ subscriptionId: 'sub_slot_b', status: 'past_due' }));
    expect((await readEntitlement(db, OWNER)).maxServers).toBe(2);

    /* Two slots is two servers, and the quota still bites at the new edge. */
    expect((await createServer(db, OWNER, { name: 'Premium Slot Alpha' })).ok).toBe(true);
    expect((await createServer(db, OWNER, { name: 'Premium Slot Beta' })).ok).toBe(true);
    const over = await createServer(db, OWNER, { name: 'Premium Slot Gamma' });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toBe('quota');
  });

  it('does let the CURRENT subscription be cancelled', async () => {
    await writeEntitlement(db, fact({ subscriptionId: 'sub_new' }));
    const done = await writeEntitlement(db, fact({ subscriptionId: 'sub_new', status: 'canceled' }));
    expect(done.applied).toBe(true);
    const after = await readEntitlement(db, OWNER);
    expect(after.status).toBe('canceled');
    expect(after.maxServers).toBe(0);
    expect(entitlementPermitsHosting(after)).toBe(false);

    const refused = await createServer(db, OWNER, { name: 'Premium After Cancellation' });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe('no_entitlement');
  });

  it('keeps hosting through past_due, then stops at canceled', async () => {
    await writeEntitlement(db, fact());
    await writeEntitlement(db, fact({ status: 'past_due' }));
    expect(entitlementPermitsHosting(await readEntitlement(db, OWNER))).toBe(true);
    await writeEntitlement(db, fact({ status: 'canceled' }));
    expect(entitlementPermitsHosting(await readEntitlement(db, OWNER))).toBe(false);
  });

  it('refuses a fact with nothing to key on rather than writing a half row', async () => {
    const out = await writeEntitlement(db, fact({ subscriptionId: '' }));
    expect(out.applied).toBe(false);
    if (!out.applied) expect(out.reason).toBe('invalid');
    expect((await readEntitlement(db, OWNER)).status).toBe('inactive');
  });
});
