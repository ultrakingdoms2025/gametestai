import { NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';

/**
 * Stripe webhook.
 *
 * ## What this can and cannot do without a database
 *
 * A webhook is a server-to-server POST from Stripe. There is no browser
 * attached to it and no session — so it **cannot set the entitlement cookie**,
 * because there is no response going to the customer to set it on. That is not
 * a limitation of this implementation; it is what a webhook is.
 *
 * So until entitlement lives in a database keyed on an account, this endpoint
 * cannot be the thing that grants. What it *can* do, and does:
 *
 *   - Verify that the payment really happened, signed by Stripe, independent of
 *     anything the browser claims.
 *   - Record it in the logs, so a customer who says they paid can be checked
 *     against something other than their word.
 *   - Be the single, already-correct place the database write goes when the
 *     accounts work lands. Signature verification is the fiddly part and it is
 *     done here now.
 *
 * The customer-facing fix for "paid, then closed the tab before the redirect"
 * is `/api/restore`, which uses Stripe itself as the store — the one durable
 * record that exists today. See the README.
 *
 * ## Raw body
 *
 * The signature covers the exact bytes Stripe sent, so the body must be read as
 * text and passed through untouched. Parsing it as JSON first and
 * re-serialising changes whitespace and key order, and the signature stops
 * matching for reasons that look like a Stripe bug and are not.
 */

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

  let event;
  try {
    event = stripe.webhooks.constructEvent(raw, signature, secret);
  } catch (e) {
    /* An unverifiable event is either a misconfigured secret or someone poking
     * the endpoint. Either way it is refused — never processed "just in case",
     * which would make the signature pointless. */
    console.error('[webhook] Signature verification failed:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Signature verification failed.' }, { status: 400 });
  }

  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object;
      if (session.payment_status === 'paid') {
        const meta = session.metadata ?? {};
        console.log(
          '[webhook] Paid:',
          JSON.stringify({
            session: session.id,
            email: session.customer_details?.email ?? null,
            amountTotal: session.amount_total,
            currency: session.currency,
            intent: meta.intent ?? null,
            credits: meta.credits ?? null,
          })
        );
        // TODO(accounts): this is the line that becomes the database write —
        // upsert the account by customer id, add the credits, set access, and
        // record the session id so the redirect path and this one cannot both
        // apply the same order.
      }
      break;
    }

    case 'checkout.session.expired':
      console.log('[webhook] Checkout expired:', event.data.object.id);
      break;

    case 'charge.refunded':
      // Recorded rather than acted on: revoking entitlement needs somewhere to
      // revoke it from, which is the same database this is all waiting for.
      console.log('[webhook] Refund:', event.data.object.id);
      break;

    default:
      break;
  }

  /* 200 quickly, always. Stripe retries anything that is not a 2xx, so
   * returning an error because *our* downstream had a problem turns one issue
   * into a retry storm. */
  return NextResponse.json({ received: true });
}
