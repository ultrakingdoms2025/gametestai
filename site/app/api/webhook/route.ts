import { NextResponse } from 'next/server';
import { Client } from 'pg';
import type Stripe from 'stripe';
import { getStripe } from '@/lib/stripe';
import { ensureCustomServerSchema } from '@/lib/customServers';
import {
  claimStripeEvent,
  mapStripeStatus,
  writeEntitlement,
  type SubscriptionFact,
} from '@/lib/premium';
import { clampCredits } from '@/lib/pricing';
import { getUserById } from '@/lib/db';
import { findOrCreatePlayer, recordSitePurchase } from '@/lib/playerDb';

/**
 * Stripe webhook.
 *
 * ## What changed here, and why it had to
 *
 * This endpoint used to verify a signature, log, and stop — with a `TODO` where
 * the database write belonged. That was the honest thing to do while entitlement
 * was a cookie: a webhook is a server-to-server POST with no browser attached,
 * so it cannot set a cookie, and there was nowhere else to put the answer.
 *
 * A subscription removes the choice. Month two has no redirect, no browser and
 * no session — nobody visits `/api/confirm` when a card is charged in their
 * sleep — so the webhook is not merely the better grant path for hosting, it is
 * the ONLY one. And there is now somewhere to write: `server_entitlements`,
 * keyed on a player id that `client_reference_id` carries.
 *
 * The one-off SKUs are handled here too, and that is a change. They used to be
 * console.logged and nothing else, on the argument that their grant runs on the
 * redirect and a second writer would be one writer too many. The argument had a
 * hole in it: the redirect is the ONLY writer, so a customer who closed the tab,
 * lost signal, or hit a database error on the way back had paid and been given
 * nothing, and NOTHING ANYWHERE WOULD EVER TRY AGAIN. `/api/confirm` now says so
 * out loud instead of showing a welcome screen; this is the thing that retries.
 *
 * Two writers are safe here because `recordSitePurchase` is idempotent on the
 * order id and both writers use the SAME id — Stripe's `session.id`. The second
 * one in finds the `purchases` row already there and returns false without
 * touching the balance, and the credit half is additionally keyed
 * `stripe:<session.id>` under `credit_events`' `UNIQUE (player_id, event_key)`.
 * Whichever of the redirect and the webhook lands first, the other is a no-op.
 *
 * ## Three properties, in this order
 *
 * 1. **Verify before anything.** An unverifiable event is refused outright,
 *    never processed "just in case", which would make the signature decorative.
 * 2. **Claim the event id before acting.** Stripe retries anything that is not a
 *    2xx, so redelivery is ordinary operation. The claim is a UNIQUE constraint,
 *    not a Set in a process — two lambdas do not share a Set.
 * 3. **Refuse a stale revocation.** `writeEntitlement` will not let a redelivered
 *    cancellation for last month's subscription revoke this month's. That guard
 *    is in the library, under test, rather than here.
 *
 * ## 200 quickly, almost always
 *
 * Stripe retries a non-2xx, so answering with an error because OUR downstream
 * had a problem turns one issue into a retry storm. The single exception is a
 * database failure while writing entitlement: that IS a case where a retry is
 * the correct outcome, because the alternative is a paid subscription with no
 * entitlement and nothing left to trigger another attempt. The event claim is
 * released on that path so the retry is not swallowed as a duplicate.
 *
 * ## Raw body
 *
 * The signature covers the exact bytes Stripe sent, so the body is read as text
 * and passed through untouched. Parsing it as JSON and re-serialising changes
 * whitespace and key order, and the signature stops matching for reasons that
 * look like a Stripe bug and are not.
 */

export const dynamic = 'force-dynamic';

function makeClient() {
  const connStr = process.env.POSTGRES_URL ?? '';
  const ssl = connStr.includes('sslmode=disable') ? false : { rejectUnauthorized: false };
  return new Client({ connectionString: connStr, ssl });
}

/** Whatever Stripe hands back for a subscription reference, as an id. */
function idOf(ref: unknown): string | null {
  if (!ref) return null;
  if (typeof ref === 'string') return ref;
  const maybe = (ref as { id?: unknown }).id;
  return typeof maybe === 'string' ? maybe : null;
}

function isoFromUnix(seconds: unknown): string | null {
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
}

/**
 * The player a subscription belongs to.
 *
 * `metadata.playerId` first because it is on the SUBSCRIPTION, so it survives
 * into every renewal event; `client_reference_id` is only on the checkout
 * session, which exists once.
 */
function playerFrom(source: {
  metadata?: Stripe.Metadata | null;
  client_reference_id?: string | null;
}): string | null {
  const meta = source.metadata?.playerId;
  if (typeof meta === 'string' && meta) return meta;
  const ref = source.client_reference_id;
  return typeof ref === 'string' && ref ? ref : null;
}

export async function POST(req: Request) {
  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripe || !secret) {
    // Not an error worth alarming about: this endpoint exists before it is
    // wired up, and Stripe is not sending to it yet.
    return NextResponse.json({ error: 'Webhooks are not configured.' }, { status: 503 });
  }

  const signature = req.headers.get('stripe-signature');
  if (!signature) {
    return NextResponse.json({ error: 'Missing signature.' }, { status: 400 });
  }

  const raw = await req.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(raw, signature, secret);
  } catch (e) {
    /* An unverifiable event is either a misconfigured secret or someone poking
     * the endpoint. Either way it is refused — never processed "just in case". */
    console.error('[webhook] Signature verification failed:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Signature verification failed.' }, { status: 400 });
  }

  /* What, if anything, this event says about a subscription. Worked out before
   * any database connection is opened, so the overwhelmingly common case — an
   * event type this app does not care about — costs nothing. */
  const fact = await subscriptionFactFor(stripe, event);
  if (!fact) {
    /* Not a subscription. It may still be a paid one-off that the redirect
     * never got to settle, which is the case this branch exists for. */
    const oneOff = oneOffPurchaseFor(event);
    if (oneOff) return settleOneOff(oneOff);
    logUninteresting(event);
    return NextResponse.json({ received: true });
  }

  const db = makeClient();
  await db.connect();
  try {
    await ensureCustomServerSchema(db);

    const fresh = await claimStripeEvent(db, event.id, event.type);
    if (!fresh) {
      console.log(`[webhook] ${event.type} ${event.id} already handled; no second write.`);
      return NextResponse.json({ received: true, duplicate: true });
    }

    const result = await writeEntitlement(db, fact);
    if (!result.applied) {
      console.log(
        `[webhook] ${event.type} ${event.id} not applied: ${result.reason} `
          + `(subscription ${fact.subscriptionId})`
      );
    } else {
      console.log(
        `[webhook] entitlement for player ${fact.playerId} is now `
          + `${result.entitlement.status} (max ${result.entitlement.maxServers})`
      );
    }
    return NextResponse.json({ received: true });
  } catch (err) {
    /* The one case worth a non-2xx. A paid subscription with no entitlement row
     * has nothing left to trigger another attempt except Stripe's retry, so ask
     * for it — and release the claim first, or the retry is refused as a
     * duplicate of an attempt that wrote nothing. */
    console.error('[webhook] entitlement write failed; asking Stripe to retry:', err);
    await db
      .query('DELETE FROM stripe_webhook_events WHERE event_id = $1', [event.id])
      .catch(() => {});
    return NextResponse.json({ error: 'Could not record entitlement.' }, { status: 500 });
  } finally {
    await db.end().catch(() => {});
  }
}

/**
 * Translate one Stripe event into what this app stores, or null to ignore it.
 *
 * `checkout.session.completed` for a subscription needs one API call: the
 * session carries the subscription's id but not its status or period end, and
 * guessing "it completed, so it must be active" is how an `incomplete`
 * subscription gets a month of hosting.
 */
async function subscriptionFactFor(
  stripe: Stripe,
  event: Stripe.Event
): Promise<SubscriptionFact | null> {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode !== 'subscription') return null;
      const subscriptionId = idOf(session.subscription);
      const playerId = playerFrom(session);
      if (!subscriptionId || !playerId) {
        console.error('[webhook] subscription checkout with no player to attribute it to');
        return null;
      }
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      return {
        playerId,
        subscriptionId,
        customerId: idOf(session.customer),
        status: mapStripeStatus(sub.status),
        currentPeriodEnd: isoFromUnix(
          (sub as unknown as { current_period_end?: number }).current_period_end
        ),
      };
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const playerId = playerFrom(sub);
      if (!playerId) return null;
      return {
        playerId,
        subscriptionId: sub.id,
        customerId: idOf(sub.customer),
        /* A deleted subscription can still report `active` in its own payload —
         * the event type is what says it is gone. */
        status: event.type === 'customer.subscription.deleted'
          ? 'canceled'
          : mapStripeStatus(sub.status),
        currentPeriodEnd: isoFromUnix(
          (sub as unknown as { current_period_end?: number }).current_period_end
        ),
      };
    }

    default:
      return null;
  }
}

/** A paid, attributable one-off checkout, reduced to what provisioning needs. */
interface OneOffPurchase {
  sessionId: string;
  userId: string;
  intent: string;
  credits: number;
  amountCents: number;
}

/**
 * The one-off half of `subscriptionFactFor`: what this event says about a
 * purchase that is not a subscription, or null to leave it alone.
 *
 * Everything is read off the SESSION Stripe just signed for, never off a
 * request body — same rule the redirect path follows, and the reason a
 * hand-edited `credits=` has never been able to change a live grant.
 *
 * `metadata.userId` is required. It is stamped by `/api/checkout` for every
 * signed-in buyer, and without it there is no account to provision: a
 * signed-out checkout leaves nothing durable tying the payment to a person, so
 * guessing from `customer_details.email` would mean granting paid access on the
 * strength of an email address — which is precisely the mistake `/api/restore`
 * was making.
 */
function oneOffPurchaseFor(event: Stripe.Event): OneOffPurchase | null {
  if (
    event.type !== 'checkout.session.completed'
    && event.type !== 'checkout.session.async_payment_succeeded'
  ) {
    return null;
  }
  const session = event.data.object as Stripe.Checkout.Session;
  if (session.mode === 'subscription') return null;
  if (session.payment_status !== 'paid') return null;

  const meta = session.metadata ?? {};
  const userId = typeof meta.userId === 'string' ? meta.userId.trim() : '';
  if (!userId) return null;

  const intent = typeof meta.intent === 'string' && meta.intent ? meta.intent : 'entry';
  return {
    sessionId: session.id,
    userId,
    intent,
    credits: intent === 'entry' ? 0 : clampCredits(meta.credits),
    amountCents: session.amount_total ?? 0,
  };
}

/**
 * Provision a one-off purchase, or ask Stripe to try again.
 *
 * ── Why this answers 500 on a database failure ────────────────────────────
 *
 * The same argument the entitlement path makes: a paid order with no
 * provisioning has nothing left to trigger another attempt except Stripe's
 * retry, so ask for one. Everywhere else this endpoint answers 200 quickly,
 * because turning our downstream problem into a retry storm helps nobody — but
 * "the customer paid and got nothing" is exactly the case retries are for.
 *
 * ── Why there is no `claimStripeEvent` around it ──────────────────────────
 *
 * There does not need to be. `recordSitePurchase` is idempotent on the order
 * id, and the order id here is Stripe's own `session.id` — the same one
 * `/api/confirm` uses — so a redelivery, a concurrent redirect and a retry all
 * collapse onto one row. Claiming the event as well would add a second,
 * weaker idempotency key that could disagree with the first: an event claimed
 * but not yet written would refuse the retry that was supposed to write it.
 */
async function settleOneOff(purchase: OneOffPurchase): Promise<NextResponse> {
  try {
    const user = await getUserById(purchase.userId);
    if (!user) {
      /* The account named on the session no longer exists. Retrying will not
       * make it exist, so this is a 200 with a loud line rather than a retry
       * loop; it needs a person, not another delivery. */
      console.error(
        `[webhook] paid one-off ${purchase.sessionId} names account `
        + `${purchase.userId}, which does not exist. NOT PROVISIONED.`
      );
      return NextResponse.json({ received: true, provisioned: false });
    }
    const playerId = await findOrCreatePlayer(user.id, user.email);
    const type: 'access' | 'credits' | 'access+credits' =
      purchase.intent === 'credits' ? 'credits'
      : purchase.intent === 'entry+credits' ? 'access+credits'
      : 'access';
    const recorded = await recordSitePurchase({
      playerId,
      type,
      amountCents: purchase.amountCents,
      creditsAmount: purchase.credits,
      orderId: purchase.sessionId,
      actorEmail: user.email,
    });
    console.log(
      `[webhook] one-off ${purchase.sessionId} (${type}): `
      + (recorded ? 'provisioned here.' : 'already settled by the redirect; no second grant.')
    );
    return NextResponse.json({ received: true, provisioned: recorded });
  } catch (err) {
    console.error(
      `[webhook] could not provision paid one-off ${purchase.sessionId}; `
      + 'asking Stripe to retry:',
      err
    );
    return NextResponse.json({ error: 'Could not record purchase.' }, { status: 500 });
  }
}

function logUninteresting(event: Stripe.Event): void {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.payment_status !== 'paid') break;
      const meta = session.metadata ?? {};
      /* Reached only when `oneOffPurchaseFor` declined it — a paid session with
       * no `userId` in its metadata, i.e. a checkout started while signed out.
       * There is no account to provision, so it is logged with everything
       * needed to settle it by hand and left. */
      console.log(
        '[webhook] Paid (one-off, unattributable):',
        JSON.stringify({
          session: session.id,
          email: session.customer_details?.email ?? null,
          amountTotal: session.amount_total,
          currency: session.currency,
          intent: meta.intent ?? null,
          credits: meta.credits ?? null,
        })
      );
      break;
    }

    case 'checkout.session.expired':
      console.log('[webhook] Checkout expired:', event.data.object.id);
      break;

    case 'invoice.payment_failed':
      /* Not acted on here. Stripe follows a failed invoice with a
       * `customer.subscription.updated` carrying `past_due`, and that event has
       * the subscription id and the metadata this app needs — an invoice does
       * not reliably carry the player. One writer, one path. */
      console.log('[webhook] Invoice payment failed:', event.data.object.id);
      break;

    case 'charge.refunded':
      console.log('[webhook] Refund:', event.data.object.id);
      break;

    default:
      break;
  }
}
