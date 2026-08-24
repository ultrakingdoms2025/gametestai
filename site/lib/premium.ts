import type { Client, PoolClient } from 'pg';
import { FEE_BPS, FEE_FIXED_CENTS, formatCents, grossUp } from './pricing';

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

export async function readEntitlement(db: Db, playerId: string): Promise<Entitlement> {
  const r = await db.query(
    `SELECT player_id, status, max_servers, stripe_subscription_id, stripe_customer_id,
            current_period_end
       FROM server_entitlements WHERE player_id = $1`,
    [playerId]
  );
  const row = r.rows[0];
  if (!row) {
    return {
      playerId, status: 'inactive', maxServers: 0,
      subscriptionId: null, customerId: null, currentPeriodEnd: null,
    };
  }
  /* The column already holds one of THIS module's four statuses — Stripe's
   * vocabulary is mapped on the way in, once, by `mapStripeStatus`. Read back
   * through a guard anyway: a row written by hand, or by a future version with a
   * fifth status, must degrade to `inactive` rather than to something
   * `entitlementPermitsHosting` accidentally accepts. */
  const stored = String(row.status ?? '');
  const KNOWN: readonly EntitlementStatus[] = ['active', 'past_due', 'canceled', 'inactive'];
  return {
    playerId: String(row.player_id),
    status: (KNOWN as readonly string[]).includes(stored)
      ? (stored as EntitlementStatus)
      : 'inactive',
    maxServers: Number(row.max_servers ?? 0),
    subscriptionId: row.stripe_subscription_id == null ? null : String(row.stripe_subscription_id),
    customerId: row.stripe_customer_id == null ? null : String(row.stripe_customer_id),
    currentPeriodEnd: row.current_period_end == null ? null : String(row.current_period_end),
  };
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
        max_servers, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (player_id) DO UPDATE SET
       stripe_customer_id     = COALESCE(EXCLUDED.stripe_customer_id, server_entitlements.stripe_customer_id),
       stripe_subscription_id = EXCLUDED.stripe_subscription_id,
       status                 = EXCLUDED.status,
       current_period_end     = EXCLUDED.current_period_end,
       max_servers            = EXCLUDED.max_servers,
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
