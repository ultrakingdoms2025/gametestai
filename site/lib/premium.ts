import type { Client, PoolClient } from 'pg';
import { FEE_BPS, FEE_FIXED_CENTS, formatCents, grossUp } from './pricing';
import { stripeConfigured } from './stripe';

/**
 * The premium server-hosting SKU (7b), and the webhook that writes entitlement.
 *
 * ── This is the project's first recurring charge ──────────────────────────
 *
 * Everything sold before this is one-off: a $1 / 30-day access pass and credits
 * at $0.10 each, both `mode: 'payment'`. Hosting a custom server is not a
 * one-off — it is capacity that costs while it exists — so it is a subscription,
 * and a subscription brings three things the one-off flow has never had:
 *
 *   1. **A charge that recurs without a browser.** Nobody is redirected to
 *      `/api/confirm` on the second month, so the redirect path CANNOT be the
 *      thing that grants. Only the webhook can.
 *   2. **A state that changes without anyone buying anything.** `past_due`,
 *      `canceled`, a card expiring. Entitlement is therefore a row that Stripe
 *      keeps updating, not a fact recorded once at purchase.
 *   3. **Events that arrive out of order.** Stripe redelivers, and a redelivered
 *      `customer.subscription.deleted` landing after a fresh subscription would
 *      revoke something just paid for. Guarded below by subscription id, not by
 *      hoping.
 *
 * ── What Stripe TEST MODE does and does not demonstrate ───────────────────
 *
 * Demonstrated, genuinely and end to end, with test keys:
 *
 *   - Checkout session creation in `mode: 'subscription'` with a `recurring`
 *     price, which is a different API shape from every existing SKU and is the
 *     part most likely to be wrong.
 *   - Webhook signature verification against `STRIPE_WEBHOOK_SECRET` — the same
 *     code path, the same `constructEvent`, byte-identical behaviour to live.
 *   - The entitlement WRITE: a real row in `server_entitlements`, driven by a
 *     real signed event, which is what `createServer` reads.
 *   - Idempotency and ordering, exercisable on demand because the Stripe CLI can
 *     redeliver any event as often as you like — easier to test in test mode
 *     than in live.
 *   - Cancellation and `past_due`, via test cards that decline.
 *
 * NOT demonstrated, and it would be dishonest to imply otherwise:
 *
 *   - That money moves. No card is charged, no payout is made, no fee is taken.
 *     The fee arithmetic below is the same code the one-off SKUs already use, so
 *     it is not newly at risk, but it is not being verified against a real
 *     statement either.
 *   - Anything about the live account: tax registration, Stripe Radar rules,
 *     3-D Secure/SCA challenges on real European cards, or the account's actual
 *     processing rate — `FEE_BPS` is a configured default, not a measured one.
 *   - Renewal over real time. A month does not pass in a test. Stripe test
 *     clocks can simulate one and that is worth doing before live; it is not
 *     done here.
 *   - Disputes, refunds and involuntary churn, which are the events that
 *     actually decide whether an entitlement model is right.
 *
 * The switch is `STRIPE_SECRET_KEY`, exactly as it already is: a `sk_test_` key
 * exercises this whole path, and a `sk_live_` key changes nothing here.
 */

/** Any pg client — a plain Client in tests, a pooled one in a route. */
type Db = Client | PoolClient;

/* ---------------------------------------------------------------------- */
/* The SKU                                                                 */
/* ---------------------------------------------------------------------- */

/** What hosting one custom server is worth to the merchant, per month. */
export const SERVER_HOSTING_CENTS = 500;

/** How many servers one subscription entitles its owner to run. */
export const SERVERS_PER_SUBSCRIPTION = 1;

export const SERVER_HOSTING_SKU = 'server_hosting_monthly';

export interface SubscriptionQuote {
  netCents: number;
  feeCents: number;
  totalCents: number;
  interval: 'month';
  label: string;
  detail: string;
}

/**
 * The monthly charge, grossed up so the fee does not come out of the net.
 *
 * `grossUp` is `pricing.ts`'s, unchanged, so the number on this page is the
 * number Stripe is handed — which is the property that whole module exists for.
 * The gross-up is applied to the RECURRING amount, so it recurs with it.
 */
export function quoteServerHosting(): SubscriptionQuote {
  const netCents = SERVER_HOSTING_CENTS;
  const totalCents = grossUp(netCents);
  return {
    netCents,
    feeCents: totalCents - netCents,
    totalCents,
    interval: 'month',
    label: 'Custom server hosting',
    detail: `${formatCents(totalCents)} per month — includes processing (${(FEE_BPS / 100).toFixed(1)}% + ${formatCents(FEE_FIXED_CENTS)})`,
  };
}

/* ---------------------------------------------------------------------- */
/* Entitlement                                                             */
/* ---------------------------------------------------------------------- */

/** What Stripe says about a subscription, mapped to what this app stores. */
export type EntitlementStatus = 'active' | 'past_due' | 'canceled' | 'inactive';

export interface Entitlement {
  playerId: string;
  status: EntitlementStatus;
  maxServers: number;
  subscriptionId: string | null;
  customerId: string | null;
  currentPeriodEnd: string | null;
  /**
   * Nobody paid for this one. See the "Simulated purchase" section below —
   * it is what tells an admin view, a revenue figure or a revocation sweep
   * that this row is a rehearsal rather than a customer.
   */
  simulated: boolean;
}

/**
 * Stripe's subscription statuses, mapped.
 *
 * `trialing` counts as active because a trial is an entitlement someone was
 * deliberately given. `incomplete` does not: the first payment has not
 * succeeded, and treating it as active is how a subscription that never pays
 * gets a month of hosting.
 */
export function mapStripeStatus(raw: string | null | undefined): EntitlementStatus {
  switch (String(raw ?? '')) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
    case 'incomplete_expired':
      return 'canceled';
    default:
      return 'inactive';
  }
}

/** The columns `toEntitlement` expects, in one place so every read agrees. */
const ENTITLEMENT_COLS =
  `player_id, status, max_servers, stripe_subscription_id, stripe_customer_id,
   current_period_end, simulated`;

function toEntitlement(row: Record<string, unknown>): Entitlement {
  /* The column already holds one of THIS module's four statuses — Stripe's
   * vocabulary is mapped on the way in, once, by `mapStripeStatus`. Read back
   * through a guard anyway: a row written by hand, or by a future version with a
   * fifth status, must degrade to `inactive` rather than to something
   * `entitlementPermitsHosting` accidentally accepts. */
  const stored = String(row.status ?? '');
  const KNOWN: readonly EntitlementStatus[] = ['active', 'past_due', 'canceled', 'inactive'];
  const subscriptionId =
    row.stripe_subscription_id == null ? null : String(row.stripe_subscription_id);
  const customerId = row.stripe_customer_id == null ? null : String(row.stripe_customer_id);
  return {
    playerId: String(row.player_id),
    status: (KNOWN as readonly string[]).includes(stored)
      ? (stored as EntitlementStatus)
      : 'inactive',
    maxServers: Number(row.max_servers ?? 0),
    subscriptionId,
    customerId,
    currentPeriodEnd: row.current_period_end == null ? null : String(row.current_period_end),
    /* Either mark is enough. The column is the queryable one, the id prefix is
     * the one that survives a restore from a dump taken before the column
     * existed — and a row carrying a `sim_` subscription id is pretend whatever
     * a boolean somewhere says, because no such subscription exists at Stripe. */
    simulated: row.simulated === true || isSimulatedId(subscriptionId) || isSimulatedId(customerId),
  };
}

export async function readEntitlement(db: Db, playerId: string): Promise<Entitlement> {
  const r = await db.query(
    `SELECT ${ENTITLEMENT_COLS} FROM server_entitlements WHERE player_id = $1`,
    [playerId]
  );
  const row = r.rows[0];
  if (!row) {
    return {
      playerId, status: 'inactive', maxServers: 0,
      subscriptionId: null, customerId: null, currentPeriodEnd: null, simulated: false,
    };
  }
  return toEntitlement(row as Record<string, unknown>);
}

/**
 * Claim a Stripe event id, or discover it has already been handled.
 *
 * `ON CONFLICT DO NOTHING` returning no row IS the duplicate signal. The same
 * argument the credit ledger makes: not a Set in a process, which two lambdas
 * do not share, and not a check-then-act, which two concurrent deliveries both
 * pass. Stripe retries anything that is not a 2xx, so redelivery is normal
 * operation rather than an edge case.
 */
export async function claimStripeEvent(
  db: Db,
  eventId: string,
  type: string
): Promise<boolean> {
  if (!eventId) return false;
  const r = await db.query(
    `INSERT INTO stripe_webhook_events (event_id, type) VALUES ($1, $2)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [eventId, type]
  );
  return !!r.rows[0];
}

export interface SubscriptionFact {
  playerId: string;
  subscriptionId: string;
  customerId: string | null;
  status: EntitlementStatus;
  /** ISO timestamp, or null when Stripe did not give one. */
  currentPeriodEnd: string | null;
  /**
   * Nobody paid. Only `grantSimulatedHosting` ever sets this — the webhook
   * omits it, which is what makes a real subscription CLEAR the flag on a
   * player who had a pretend one.
   */
  simulated?: boolean;
}

export type EntitlementWrite =
  | { applied: true; entitlement: Entitlement }
  | { applied: false; reason: 'stale_subscription' | 'invalid' };

/**
 * Write what Stripe says about one subscription.
 *
 * ── The ordering guard, which is the whole reason this is not one UPSERT ──
 *
 * Stripe redelivers. A `customer.subscription.deleted` for LAST month's
 * subscription can arrive after this month's `checkout.session.completed`, and a
 * naive upsert would then cancel an entitlement that has just been paid for.
 *
 * So a write that is not about the currently stored subscription is refused
 * UNLESS it would grant. Granting from an unknown subscription is safe — the
 * event was signed by Stripe and says somebody is paying — while revoking from
 * an unknown one is exactly the failure above.
 *
 * `max_servers` is set here and nowhere else. No route argument raises it, which
 * is what makes `createServer`'s quota check meaningful.
 */
export async function writeEntitlement(
  db: Db,
  fact: SubscriptionFact
): Promise<EntitlementWrite> {
  const playerId = String(fact?.playerId ?? '').trim();
  const subscriptionId = String(fact?.subscriptionId ?? '').trim();
  if (!playerId || !subscriptionId) return { applied: false, reason: 'invalid' };

  const current = await readEntitlement(db, playerId);
  const known = current.subscriptionId;
  const revoking = fact.status !== 'active';
  if (revoking && known && known !== subscriptionId) {
    /* A cancellation for a subscription this player has already replaced. It is
     * true, it is signed, and it is about the past. */
    return { applied: false, reason: 'stale_subscription' };
  }

  await db.query(
    `INSERT INTO server_entitlements
       (player_id, stripe_customer_id, stripe_subscription_id, status, current_period_end,
        max_servers, simulated, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (player_id) DO UPDATE SET
       stripe_customer_id     = COALESCE(EXCLUDED.stripe_customer_id, server_entitlements.stripe_customer_id),
       stripe_subscription_id = EXCLUDED.stripe_subscription_id,
       status                 = EXCLUDED.status,
       current_period_end     = EXCLUDED.current_period_end,
       max_servers            = EXCLUDED.max_servers,
       /* Assigned, never OR'd. A real signed Stripe event about this player
        * must be able to turn the flag OFF — otherwise the first customer who
        * tried the product before payments went live is mislabelled as
        * pretend forever, and the revocation sweep below would delete a
        * subscription somebody is paying for. */
       simulated              = EXCLUDED.simulated,
       updated_at             = NOW()`,
    [
      playerId,
      fact.customerId ?? null,
      subscriptionId,
      fact.status,
      fact.currentPeriodEnd ?? null,
      /* `past_due` keeps its allowance. Stripe retries a failed payment for
       * days, and tearing a running server down on the first decline punishes an
       * expired card rather than a non-payer — `entitlementPermitsHosting` says
       * the same thing and the two must not disagree. `canceled` and `inactive`
       * go to zero. */
      fact.status === 'active' || fact.status === 'past_due' ? SERVERS_PER_SUBSCRIPTION : 0,
      fact.simulated === true,
    ]
  );

  return { applied: true, entitlement: await readEntitlement(db, playerId) };
}

/**
 * Does this player's entitlement currently permit hosting?
 *
 * `past_due` deliberately still permits. Stripe retries a failed payment for
 * days, and tearing down a running server on the first decline punishes an
 * expired card rather than a non-payer. `canceled` does not permit, and
 * `createServer` reads this same row.
 */
export function entitlementPermitsHosting(e: Entitlement): boolean {
  return (e.status === 'active' || e.status === 'past_due') && e.maxServers > 0;
}

/* ---------------------------------------------------------------------- */
/* Simulated purchase                                                      */
/* ---------------------------------------------------------------------- */

/**
 * A hosting subscription nobody paid for.
 *
 * ── Who decided this, and what it replaced ────────────────────────────────
 *
 * `startServerHostingCheckout` used to answer 503 without a Stripe key, with a
 * comment refusing to pretend: simulating a subscription would mean faking the
 * entitlement write, which is the one thing worth exercising, and a `sk_test_`
 * key makes the real path free.
 *
 * The site owner overruled that on 25 August 2026, in these words: *"I dont see
 * option on webpage to purchase the custom server membership, or how they would
 * after purchase access backend to set up. For now someone purchasing we can
 * just skip the actual payment as with other options until I finish stripe
 * integration."* The argument the 503 made was about test coverage; the cost it
 * ignored was that the product could not be bought, or even set up, by anybody —
 * which is a worse thing to ship than an untested webhook.
 *
 * ── What it costs, so nobody rediscovers this in production ───────────────
 *
 *   - Nothing here exercises Stripe. Subscription-mode session creation, the
 *     signed webhook, `client_reference_id` attribution, redelivery and the
 *     ordering guard are still only reachable with a key. This is a shortcut
 *     around that path, not a rehearsal of it.
 *   - The entitlement it writes is REAL in every way that matters downstream:
 *     `entitlementPermitsHosting` accepts it and `createServer` builds on it. A
 *     stranger who finds the checkout endpoint can host a server for free.
 *
 * Two things contain that. The bypass is dead the moment `stripeConfigured()`
 * is true — checked here, in the library that does the writing, as well as in
 * the route, so there is no flag anyone has to remember to turn off. And every
 * row it writes is marked, twice.
 *
 * ── Marked twice, deliberately ────────────────────────────────────────────
 *
 *   1. `server_entitlements.simulated`, a real column. Exact, indexable, and
 *      the thing `listSimulatedEntitlements` and `revokeSimulatedEntitlements`
 *      key on. A column beats a `LIKE` for a sweep that must not miss a row.
 *   2. A `sim_` prefix on BOTH the subscription id and the customer id. This is
 *      the mark that shows up unbidden: it appears in any admin view that
 *      renders an id, and any attempt to reconcile it against Stripe fails
 *      loudly with "no such subscription" rather than quietly counting it as
 *      revenue. It also survives a restore from a dump taken before the column
 *      existed, which a boolean does not.
 *
 * Neither alone was enough. The column is invisible to a query that does not
 * know to ask for it, and defaults FALSE — so an admin view written next year
 * would show a pretend subscriber as a customer. The prefix is visible
 * everywhere but is only a convention. `toEntitlement` therefore treats EITHER
 * mark as decisive.
 *
 * No `recordSitePurchase` row is written for a simulated hosting purchase, and
 * that is the same argument: a $5.20 line in the purchase ledger for money that
 * never moved is exactly the revenue figure this section exists to protect.
 *
 * ── Revoking them, the day real payments start ────────────────────────────
 *
 * `revokeSimulatedEntitlements(db)` deletes every marked row and returns the
 * player ids it removed. Deletion rather than `status = 'canceled'`, because a
 * cancelled row is still a row in a churn figure and these were never customers.
 * Servers already created survive the sweep — they simply stop being creatable
 * or extendable until their owner subscribes for real, which is the honest end
 * state, and the audit trail of who was granted what is in the audit chain.
 */

/** What marks an id as belonging to a purchase that never happened. */
export const SIMULATED_PREFIX = 'sim_';

/** How long a simulated subscription claims to run before it would renew. */
export const SIMULATED_PERIOD_DAYS = 30;

export function isSimulatedId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(SIMULATED_PREFIX);
}

/**
 * The subscription id for a simulated order.
 *
 * Derived from the order id minted at checkout rather than freshly random, for
 * the reason `/api/confirm` gives about the one-off SKUs: replaying a confirm
 * URL must settle nothing twice. The same order produces the same subscription
 * id, so a replay is an upsert of identical values.
 */
export function simulatedSubscriptionId(orderId: string): string {
  return `${SIMULATED_PREFIX}sub_${String(orderId).replace(/^sim_/, '')}`;
}

/** The customer id for a simulated order — stable per player, and obvious. */
export function simulatedCustomerId(playerId: string): string {
  return `${SIMULATED_PREFIX}cus_${playerId}`;
}

/**
 * Both marks, as one SQL predicate, so the sweep and the listing cannot drift.
 *
 * `\_` because `_` is a LIKE wildcard, and `sim_` unescaped would also match a
 * hypothetical `simX...`.
 */
const SIMULATED_PREDICATE = `
  simulated = TRUE
  OR stripe_subscription_id LIKE 'sim\\_%'
  OR stripe_customer_id LIKE 'sim\\_%'`;

export type SimulatedGrant =
  | { granted: true; entitlement: Entitlement }
  | { granted: false; reason: 'stripe_configured' | 'invalid' };

/**
 * Grant hosting to someone who did not pay, while there is no way to pay.
 *
 * Refuses outright once `STRIPE_SECRET_KEY` exists. That check is here rather
 * than only in the route because this function is the thing that writes the
 * row: a second caller added later inherits the guard instead of having to
 * remember it.
 */
export async function grantSimulatedHosting(
  db: Db,
  input: { playerId: string; orderId: string; periodDays?: number }
): Promise<SimulatedGrant> {
  if (stripeConfigured()) return { granted: false, reason: 'stripe_configured' };

  const playerId = String(input?.playerId ?? '').trim();
  const orderId = String(input?.orderId ?? '').trim();
  if (!playerId || !orderId) return { granted: false, reason: 'invalid' };

  const days = input.periodDays ?? SIMULATED_PERIOD_DAYS;
  const written = await writeEntitlement(db, {
    playerId,
    subscriptionId: simulatedSubscriptionId(orderId),
    customerId: simulatedCustomerId(playerId),
    status: 'active',
    currentPeriodEnd: new Date(Date.now() + days * 86_400_000).toISOString(),
    simulated: true,
  });
  if (!written.applied) return { granted: false, reason: 'invalid' };
  return { granted: true, entitlement: written.entitlement };
}

/** Every entitlement nobody paid for. The list to work from before going live. */
export async function listSimulatedEntitlements(db: Db): Promise<Entitlement[]> {
  const r = await db.query(
    `SELECT ${ENTITLEMENT_COLS} FROM server_entitlements
      WHERE ${SIMULATED_PREDICATE}
      ORDER BY updated_at DESC`
  );
  return (r.rows as Record<string, unknown>[]).map(toEntitlement);
}

/**
 * Delete every simulated entitlement. Returns the player ids it removed.
 *
 * Safe to run with real customers in the table: the predicate cannot match a
 * row Stripe wrote, because a live write assigns `simulated = FALSE` and Stripe
 * ids begin `sub_` / `cus_`, never `sim_`.
 */
export async function revokeSimulatedEntitlements(db: Db): Promise<string[]> {
  const r = await db.query(
    `DELETE FROM server_entitlements WHERE ${SIMULATED_PREDICATE} RETURNING player_id`
  );
  return (r.rows as { player_id: unknown }[]).map((row) => String(row.player_id));
}
