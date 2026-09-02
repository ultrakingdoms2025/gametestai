import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import {
  SERVERS_PER_SUBSCRIPTION,
  entitlementPermitsHosting,
  grantSimulatedHosting,
  isSimulatedId,
  listSimulatedEntitlements,
  readEntitlement,
  revokeSimulatedEntitlements,
  simulatedCustomerId,
  simulatedSubscriptionId,
  writeEntitlement,
} from './premium';
import { ensureCustomServerSchema, createServer } from './customServers';

/**
 * Buying custom-server hosting with the payment simulated.
 *
 * The reasoning — who overruled the 503, what a simulated grant costs, and why
 * every pretend row carries two marks — is in `premium.ts` under "Simulated
 * purchase", because it is a fact about the product rather than about these
 * tests and the next person will be reading the module.
 *
 * These tests cover the two things that could hurt:
 *
 *   1. The bypass really does die when `STRIPE_SECRET_KEY` appears. Not "is
 *      preferred against", not "behind a flag" — refused.
 *   2. Every entitlement it writes is findable and revocable afterwards, and a
 *      real one is never caught in the sweep.
 *
 * plus the plain thing the owner asked for: that the product can be bought from
 * a page, and that buying it lands somewhere the next step is obvious.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** CRLF-normalised, because `core.autocrlf` is true in this repository. */
function source(...parts: string[]): string {
  return readFileSync(join(here, '..', ...parts), 'utf8').replace(/\r\n/g, '\n');
}

/** The body of one named function, so a scrape cannot pass on a sibling. */
function functionBody(src: string, signature: string): string {
  const at = src.indexOf(signature);
  expect(at, `${signature} not found`).toBeGreaterThan(-1);
  return src.slice(at);
}

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

/* ---------------------------------------------------------------------- */
/* The routes                                                              */
/* ---------------------------------------------------------------------- */

describe('the simulated hosting checkout', () => {
  it('no longer refuses the SKU merely because Stripe is unconfigured', () => {
    const fn = functionBody(
      source('app', 'api', 'checkout', 'route.ts'),
      'async function startServerHostingCheckout'
    );
    /* This used to assert `not.toMatch(/status:\s*503/)` — that no 503 appeared
     * anywhere in the function — standing in for "the SKU is not refused just
     * because there is no Stripe key".
     *
     * A 503 is back, for a DIFFERENT reason: the deployment has not set
     * `ALLOW_SIMULATED_PURCHASE=1`. "No Stripe key" describes production too,
     * and reading it as permission to hand out a free subscription is the hole
     * that was being closed. So the blanket assertion now measures the wrong
     * thing, and it is replaced by one that says what was actually meant: the
     * only refusal in here is the opt-in's, and the simulated mint follows it.
     *
     * The ORIGINAL 503 — "refuse to pretend at all" — is still gone, which is
     * what this test was protecting; its argument lives in the comment that
     * replaced it. */
    const optInAt = fn.indexOf('if (!simulatedPurchasesAllowed())');
    const refusalAt = fn.search(/status:\s*503/);
    const simulateAt = fn.indexOf("url.searchParams.set('simulated', '1')");

    expect(optInAt, 'the opt-in guard has been renamed or removed').toBeGreaterThan(-1);
    // Exactly one 503, and it belongs to the opt-in guard rather than standing
    // in front of the whole simulated path.
    expect(fn.match(/status:\s*503/g)?.length ?? 0).toBe(1);
    expect(refusalAt).toBeGreaterThan(optInAt);
    expect(simulateAt).toBeGreaterThan(refusalAt);
    expect(fn).toContain('SERVER_HOSTING_SKU');
  });

  it('mints the order id at checkout, so replaying the confirm link settles nothing twice', () => {
    const fn = functionBody(
      source('app', 'api', 'checkout', 'route.ts'),
      'async function startServerHostingCheckout'
    );
    /* The same property the one-off SKUs have, for the same reason: an id fixed
     * at confirm time makes every refresh a fresh purchase. */
    expect(fn).toContain('`sim_${randomUUID()}`');
  });

  it('reaches the simulated branch only when there is no Stripe client', () => {
    const fn = functionBody(
      source('app', 'api', 'checkout', 'route.ts'),
      'async function startServerHostingCheckout'
    );
    const guardAt = fn.indexOf('if (!stripe)');
    const simulateAt = fn.indexOf("searchParams.set('simulated'");
    expect(guardAt).toBeGreaterThan(-1);
    expect(simulateAt).toBeGreaterThan(guardAt);
  });

  it('leaves the live subscription path exactly as it was', () => {
    const fn = functionBody(
      source('app', 'api', 'checkout', 'route.ts'),
      'async function startServerHostingCheckout'
    );
    /* The parts a key turns on: subscription mode, the recurring price built
     * from `premium.ts`, and the attribution the webhook cannot renew without. */
    expect(fn).toMatch(/mode:\s*'subscription'/);
    expect(fn).toMatch(/recurring:\s*\{\s*interval:\s*'month'\s*\}/);
    expect(fn).toContain('client_reference_id');
    expect(fn).toContain('subscription_data');
  });

  it('refuses the simulated confirm outright once Stripe is configured', () => {
    const confirm = source('app', 'api', 'confirm', 'route.ts');
    const guardAt = confirm.indexOf('if (stripeConfigured())');
    const grantAt = confirm.indexOf('grantSimulatedHosting(');
    expect(guardAt).toBeGreaterThan(-1);
    expect(grantAt).toBeGreaterThan(-1);
    /* Not "prefer Stripe when available" — the bypass is dead the moment the
     * key exists, in the same action that opens the real door. */
    expect(guardAt, 'the stripeConfigured guard must precede the grant').toBeLessThan(grantAt);
    expect(confirm).toContain('simulated-disabled');
  });

  it('writes no purchase-ledger row for money that never moved', () => {
    const fn = functionBody(
      source('app', 'api', 'confirm', 'route.ts'),
      'async function simulatedHostingGrant'
    );
    /* A $5.20 line in the purchase ledger for a payment that did not happen is
     * exactly the revenue figure the simulated marking exists to protect. */
    expect(fn).not.toContain('recordSitePurchase');
    expect(fn).not.toContain('recordForUser');
  });
});

describe('a way to buy it, and somewhere to go afterwards', () => {
  it('the store starts a checkout rather than only describing the product', () => {
    const store = source('app', 'store', 'page.tsx');
    expect(store).toContain('HostingSubscribeButton');
    expect(store).toContain('quoteServerHosting');
  });

  it('the store and the dashboard share one control, not two', () => {
    const store = source('app', 'store', 'page.tsx');
    const panel = source('components', 'ServerAdminPanel.tsx');
    expect(panel).toContain('HostingSubscribeButton');
    /* One thing posts a hosting checkout. Two copies drift, and the copy that
     * drifts is the one nobody re-reads — the 401 handling would live in one of
     * them and the raw "Sign in first." in the other. */
    expect(store).not.toContain('/api/checkout');
    expect(panel).not.toContain('/api/checkout');
    expect(source('components', 'HostingSubscribeButton.tsx')).toContain("fetch('/api/checkout'");
  });

  it('neither page hard-codes the SKU string', () => {
    /* It arrives as a prop: from the constant on the server for the store, and
     * from `/api/servers`' `sku.intent` for the panel. */
    expect(source('app', 'store', 'page.tsx')).not.toContain('server_hosting_monthly');
    expect(source('components', 'ServerAdminPanel.tsx')).not.toContain('server_hosting_monthly');
    expect(source('app', 'api', 'servers', 'route.ts')).toContain('intent: SERVER_HOSTING_SKU');
  });

  it('both purchase paths land on the servers dashboard, flagged', () => {
    const checkout = source('app', 'api', 'checkout', 'route.ts');
    const confirm = source('app', 'api', 'confirm', 'route.ts');
    /* One landing url for live and simulated, so the "what now?" panel has one
     * trigger to read. `/play?welcome=1` is the same idea for the one-offs. */
    expect(checkout).toMatch(/success_url:.*\/admin\/servers\?subscribed=1/);
    expect(confirm).toContain("'/admin/servers?subscribed=1'");
  });

  it('the dashboard tells a new subscriber what to do next', () => {
    const page = source('app', 'admin', 'servers', 'page.tsx');
    const panel = source('components', 'ServerAdminPanel.tsx');
    expect(page).toContain("sp.subscribed === '1'");
    expect(page).toContain('justSubscribed');
    expect(panel).toContain('justSubscribed');
    /* The two steps the owner asked about: create the server, invite players. */
    expect(panel).toMatch(/Name your server/);
    expect(panel).toMatch(/Invite your players/);
  });

  it('never claims a payment was taken when none was', () => {
    const store = source('app', 'store', 'page.tsx');
    const panel = source('components', 'ServerAdminPanel.tsx');
    expect(store).toContain('No card is taken');
    /* And the state persists past the purchase screen: the dashboard reads the
     * flag off the entitlement itself rather than off a query parameter. */
    expect(panel).toContain('ent.simulated');
    expect(panel).toContain('No card was charged');
    expect(source('app', 'api', 'servers', 'route.ts')).toContain('simulated: entitlement.simulated');
  });
});

/* ---------------------------------------------------------------------- */
/* Against a real Postgres                                                 */
/* ---------------------------------------------------------------------- */

/**
 * ...0013 and ...0014. See serverContent.test.ts for the register of claimed
 * ids: vitest runs test FILES in parallel against one shared database, and a
 * collision has broken a sibling suite here before. Server names carry a
 * suite-unique prefix for the same reason — a slug is globally unique.
 */
const BUYER = '00000000-0000-4000-8000-000000000013';
const PAYING = '00000000-0000-4000-8000-000000000014';

suite('a simulated purchase (integration)', () => {
  let db: Client;
  let savedKey: string | undefined;
  let savedAllow: string | undefined;

  beforeAll(async () => {
    /* Every happy path here depends on there being no Stripe key. Saved and
     * removed rather than assumed, because `.env.local` carries the name and a
     * runner that loads env files would otherwise fail these for the right
     * reason at the wrong time. */
    savedKey = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;

    /* And on the opt-in, which is NEW and which is the point.
     *
     * `!stripeConfigured()` used to be the whole permission to grant a
     * subscription nobody paid for -- and that describes every deployment
     * without keys, production included. It is now an explicit
     * `ALLOW_SIMULATED_PURCHASE=1` that production cannot set. These tests
     * exercise the granting path, so they have to opt in like any other
     * caller; `refuses to grant without the explicit opt-in` below is the test
     * that this flag is load-bearing rather than decorative. */
    savedAllow = process.env.ALLOW_SIMULATED_PURCHASE;
    process.env.ALLOW_SIMULATED_PURCHASE = '1';

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
    for (const id of [BUYER, PAYING]) {
      await db.query(
        `INSERT INTO players (id, credit_balance) VALUES ($1, 0) ON CONFLICT (id) DO NOTHING`,
        [id]
      );
    }
    await ensureCustomServerSchema(db);
  });

  const reset = async () => {
    await db.query(`DELETE FROM custom_servers WHERE owner_player_id = ANY($1::text[])`, [
      [BUYER, PAYING],
    ]);
    await db.query(`DELETE FROM server_entitlements WHERE player_id = ANY($1::text[])`, [
      [BUYER, PAYING],
    ]);
  };
  beforeEach(reset);
  afterAll(async () => {
    if (savedKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = savedKey;
    if (savedAllow === undefined) delete process.env.ALLOW_SIMULATED_PURCHASE;
    else process.env.ALLOW_SIMULATED_PURCHASE = savedAllow;
    if (!db) return;
    await reset();
    await db.end();
  });

  const order = 'sim_00000000-0000-4000-8000-0000000013aa';

  it('is what makes a server creatable, exactly as a paid one would be', async () => {
    /* Before: no entitlement, no server. The SKU is not decoration — it gates
     * the feature, and a simulated purchase has to open the same gate or it has
     * not sold anything. */
    const before = await createServer(db, BUYER, { name: 'Simulated Too Early' });
    expect(before.ok).toBe(false);
    if (!before.ok) expect(before.reason).toBe('no_entitlement');

    const grant = await grantSimulatedHosting(db, { playerId: BUYER, orderId: order });
    expect(grant.granted).toBe(true);

    const ent = await readEntitlement(db, BUYER);
    expect(ent.status).toBe('active');
    expect(ent.maxServers).toBe(SERVERS_PER_SUBSCRIPTION);
    expect(entitlementPermitsHosting(ent)).toBe(true);

    const after = await createServer(db, BUYER, { name: 'Simulated Lodestar Annexe' });
    expect(after.ok).toBe(true);
  });

  it('marks the row twice, so it cannot be mistaken for a customer', async () => {
    await grantSimulatedHosting(db, { playerId: BUYER, orderId: order });
    const ent = await readEntitlement(db, BUYER);

    expect(ent.simulated).toBe(true);
    /* The mark that shows up unbidden: it appears in any view that renders an
     * id, and reconciling it against Stripe fails loudly rather than quietly
     * counting as revenue. */
    expect(isSimulatedId(ent.subscriptionId)).toBe(true);
    expect(isSimulatedId(ent.customerId)).toBe(true);
    expect(ent.subscriptionId).toBe(simulatedSubscriptionId(order));
    expect(ent.customerId).toBe(simulatedCustomerId(BUYER));

    /* And the column really is set, not just inferred from the prefix. */
    const raw = await db.query(
      `SELECT simulated FROM server_entitlements WHERE player_id = $1`, [BUYER]
    );
    expect(raw.rows[0].simulated).toBe(true);
  });

  it('is listed for revocation, and a paying customer is not', async () => {
    await grantSimulatedHosting(db, { playerId: BUYER, orderId: order });
    await writeEntitlement(db, {
      playerId: PAYING, subscriptionId: 'sub_sim_test_real', customerId: 'cus_sim_test_real',
      status: 'active', currentPeriodEnd: null,
    });

    const listed = await listSimulatedEntitlements(db);
    expect(listed.map((e) => e.playerId)).toContain(BUYER);
    expect(listed.map((e) => e.playerId)).not.toContain(PAYING);
    expect((await readEntitlement(db, PAYING)).simulated).toBe(false);
  });

  it('is revocable in one call, and the sweep spares the paying customer', async () => {
    await grantSimulatedHosting(db, { playerId: BUYER, orderId: order });
    await writeEntitlement(db, {
      playerId: PAYING, subscriptionId: 'sub_sim_test_real2', customerId: null,
      status: 'active', currentPeriodEnd: null,
    });

    const revoked = await revokeSimulatedEntitlements(db);
    expect(revoked).toContain(BUYER);
    expect(revoked).not.toContain(PAYING);

    /* Gone, not "canceled": these were never customers and a cancelled row is
     * still a row in a churn figure. */
    const after = await readEntitlement(db, BUYER);
    expect(after.status).toBe('inactive');
    expect(entitlementPermitsHosting(after)).toBe(false);
    const refused = await createServer(db, BUYER, { name: 'Simulated After Revocation' });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe('no_entitlement');

    expect(entitlementPermitsHosting(await readEntitlement(db, PAYING))).toBe(true);
  });

  it('settles nothing twice when the confirm link is replayed', async () => {
    await grantSimulatedHosting(db, { playerId: BUYER, orderId: order });
    const first = await readEntitlement(db, BUYER);
    await grantSimulatedHosting(db, { playerId: BUYER, orderId: order });
    const second = await readEntitlement(db, BUYER);

    expect(second.subscriptionId).toBe(first.subscriptionId);
    expect(second.maxServers).toBe(SERVERS_PER_SUBSCRIPTION);
    const rows = await db.query(
      `SELECT COUNT(*)::int AS n FROM server_entitlements WHERE player_id = $1`, [BUYER]
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it('buying hosting again adds a second slot, and replays add nothing', async () => {
    /* Pay-per-server, simulated: every checkout mints a fresh order id, every
     * order derives a distinct subscription id, and each distinct subscription
     * accumulates one slot through the SAME `writeEntitlement` the webhook
     * uses. Replaying either confirm link resurrects its own grant and adds
     * nothing — the property "settles nothing twice" pins for one order, held
     * here across two. */
    const orderB = 'sim_00000000-0000-4000-8000-0000000013bb';
    await grantSimulatedHosting(db, { playerId: BUYER, orderId: order });
    expect((await readEntitlement(db, BUYER)).maxServers).toBe(SERVERS_PER_SUBSCRIPTION);

    await grantSimulatedHosting(db, { playerId: BUYER, orderId: orderB });
    expect((await readEntitlement(db, BUYER)).maxServers).toBe(2 * SERVERS_PER_SUBSCRIPTION);

    await grantSimulatedHosting(db, { playerId: BUYER, orderId: order });
    await grantSimulatedHosting(db, { playerId: BUYER, orderId: orderB });
    expect((await readEntitlement(db, BUYER)).maxServers).toBe(2 * SERVERS_PER_SUBSCRIPTION);

    /* Two slots is two servers — the quota reads the accumulated allowance. */
    expect((await createServer(db, BUYER, { name: 'Simulated Slot One' })).ok).toBe(true);
    expect((await createServer(db, BUYER, { name: 'Simulated Slot Two' })).ok).toBe(true);
    const over = await createServer(db, BUYER, { name: 'Simulated Slot Three' });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toBe('quota');
  });

  it('refuses to grant without the explicit opt-in, even with no Stripe key', async () => {
    /* The hole this closes. `stripeConfigured()` returning false was being read
     * as permission to hand out a working entitlement, and that is the state of
     * every deployment that has not been given keys -- INCLUDING PRODUCTION. So
     * "no key" must not be sufficient on its own. */
    delete process.env.ALLOW_SIMULATED_PURCHASE;
    try {
      const order = `sim_${Date.now()}_optin`;
      const out = await grantSimulatedHosting(db, { playerId: BUYER, orderId: order });
      expect(out.granted).toBe(false);
      if (!out.granted) expect(out.reason).toBe('not_permitted');
      /* And no allowance was written, which is the part that would actually
       * hurt. `readEntitlement` synthesises an inactive record for a player
       * with no row rather than returning null, so the assertion is on what it
       * says, not on its absence. */
      const ent = await readEntitlement(db, BUYER);
      expect(ent?.status).not.toBe('active');
      expect(ent?.maxServers ?? 0).toBe(0);
    } finally {
      process.env.ALLOW_SIMULATED_PURCHASE = '1';
    }
  });

  it('is refused the moment STRIPE_SECRET_KEY exists, without a flag to remember', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_pretend_key_for_this_assertion';
    try {
      const out = await grantSimulatedHosting(db, { playerId: BUYER, orderId: order });
      expect(out.granted).toBe(false);
      if (!out.granted) expect(out.reason).toBe('stripe_configured');
      /* Refused, not merely deprioritised: nothing was written. */
      const ent = await readEntitlement(db, BUYER);
      expect(ent.status).toBe('inactive');
      expect(entitlementPermitsHosting(ent)).toBe(false);
    } finally {
      delete process.env.STRIPE_SECRET_KEY;
    }
  });

  it('lets a real subscription clear the pretend flag on the same player', async () => {
    /* The other half of the safety property. If a simulated row could not be
     * turned real, the first customer who tried the product before payments
     * went live would be swept as a fake — and the sweep would delete a
     * subscription somebody is paying for. */
    await grantSimulatedHosting(db, { playerId: BUYER, orderId: order });
    expect((await readEntitlement(db, BUYER)).simulated).toBe(true);

    const real = await writeEntitlement(db, {
      playerId: BUYER, subscriptionId: 'sub_sim_test_upgrade', customerId: 'cus_sim_test_upgrade',
      status: 'active', currentPeriodEnd: null,
    });
    expect(real.applied).toBe(true);

    const ent = await readEntitlement(db, BUYER);
    expect(ent.simulated).toBe(false);
    expect(entitlementPermitsHosting(ent)).toBe(true);
    expect((await listSimulatedEntitlements(db)).map((e) => e.playerId)).not.toContain(BUYER);
  });
});
