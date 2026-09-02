import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getCurrentAccessState } from '@/lib/access';
import {
  clampCredits,
  feeLabel,
  quoteCredits,
  quoteEntry,
  quoteEntryWithCredits,
  type Quote,
} from '@/lib/pricing';
import { getStripe, siteOrigin, simulatedPurchasesAllowed, stripeConfigured } from '@/lib/stripe';
import { SIMULATED_SIGNATURE_PARAM, signSimulatedOrder } from '@/lib/simulatedOrder';
import { auth } from '@/lib/auth';
import { getUserById } from '@/lib/db';
import { findOrCreatePlayer } from '@/lib/playerDb';
import { SERVER_HOSTING_SKU, quoteServerHosting } from '@/lib/premium';

/**
 * Start a checkout.
 *
 * ## The price is never taken from the request
 *
 * The body carries an *intent* and a quantity, and nothing else. The amount is
 * quoted here, on the server, from the same pricing module the page rendered
 * from. A request that claims a total is ignored, because there is nowhere in
 * this handler that would read it.
 *
 * ## Simulated and live are the same flow
 *
 * With no `STRIPE_SECRET_KEY` this returns a URL into the local confirm page
 * instead of a Stripe Checkout URL. Everything either side of that — the quote,
 * the entitlement granted, the screens the customer sees — is identical, so
 * turning Stripe on is a key, not a rewrite.
 */

type Body = { intent?: unknown; credits?: unknown };

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'Malformed request.' }, { status: 400 });
  }

  const { hasAccess } = await getCurrentAccessState();

  /* Read once and used twice: to bind a live Stripe session to its buyer, and
   * to bind a simulated order's signature to the same person. Null for a
   * signed-out checkout, which is still allowed for the one-off SKUs. */
  const buyerId = (await auth())?.user?.id ?? null;

  const requested = String(body.intent ?? 'entry');

  /* ---- the subscription SKU ------------------------------------------- *
   *
   * Handled before the one-off branch and returning early, because almost
   * nothing below applies to it: there is no `hasAccess` substitution (hosting
   * is not access) and no credit quantity.
   *
   * It DOES have a simulated path now, on the same switch as every other SKU.
   * See `startServerHostingCheckout` for who decided that and what it costs.
   */
  if (requested === SERVER_HOSTING_SKU) {
    return startServerHostingCheckout(req);
  }
  // A customer who has already paid for access cannot be sold it again, whatever
  // the request says.
  const intent: 'entry' | 'credits' | 'entry+credits' =
    requested === 'credits' && hasAccess ? 'credits'
      : requested === 'credits' || requested === 'entry+credits'
        ? (hasAccess ? 'credits' : 'entry+credits')
        : hasAccess ? 'credits' : 'entry';

  const credits = intent === 'entry' ? 0 : clampCredits(body.credits);

  let quote: Quote;
  if (intent === 'entry') quote = quoteEntry();
  else if (intent === 'credits') quote = quoteCredits(credits);
  else quote = quoteEntryWithCredits(credits);

  if (quote.totalCents <= 0) {
    return NextResponse.json({ error: 'Nothing to buy.' }, { status: 400 });
  }

  const origin = siteOrigin(req);
  const grantsAccess = intent !== 'credits';

  /* ---- simulated ------------------------------------------------------- */
  if (!stripeConfigured()) {
    /* `!stripeConfigured()` says payments are impossible. It does NOT say free
     * grants are permitted, and treating the first as the second is what left
     * production with an open credit faucet — see the docblock on
     * `simulatedPurchasesAllowed` and the one on `/api/confirm`. A deployment
     * that has not opted in gets an honest refusal rather than a link that will
     * be refused at the far end anyway. */
    if (!simulatedPurchasesAllowed()) {
      return NextResponse.json(
        { error: 'Payments are not configured on this deployment.' },
        { status: 503 }
      );
    }
    const url = new URL('/api/confirm', origin);
    url.searchParams.set('simulated', '1');
    url.searchParams.set('intent', intent);
    url.searchParams.set('credits', String(credits));
    /* An order id, minted here and carried on the URL — the stand-in for
     * Stripe's session id.
     *
     * It matters that this is fixed at checkout rather than at confirm time:
     * replaying a confirm URL must be a no-op, exactly as it is live, or the
     * simulated flow is not a rehearsal of anything and the first time anyone
     * exercises idempotency is in production. Pressing Pay again starts a new
     * order and gets a new id, which is also what Stripe does. */
    const orderId = `sim_${randomUUID()}`;
    url.searchParams.set('order', orderId);
    /* And a signature over all of it, bound to the buyer. Minting the id here
     * only bounds a replay if the id is OURS: while the whole query string was
     * the caller's to write, "settle this under an order id I just invented"
     * was a URL anyone could type, and typing a fresh one defeated the guard
     * entirely. See `lib/simulatedOrder.ts`. */
    url.searchParams.set(
      SIMULATED_SIGNATURE_PARAM,
      signSimulatedOrder({ intent, credits, orderId, userId: buyerId ?? '' })
    );
    return NextResponse.json({ url: url.toString(), simulated: true });
  }

  /* ---- live ------------------------------------------------------------ */
  const stripe = getStripe();
  if (!stripe) {
    return NextResponse.json({ error: 'Payments are not configured.' }, { status: 500 });
  }

  try {
    /* One line item for the whole order, priced at the grossed-up total.
     *
     * Not one Stripe line per receipt line: the fee is a function of the order
     * as a whole, so splitting it across lines would either round it twice or
     * invent a line item called "fee" that the customer did not buy. The
     * description carries the breakdown instead, and the receipt on our own
     * page already itemised it. */
    const description = quote.lines.map((l) => l.label).join(' + ');
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      /* Always create a Customer, even though payment mode does not require
       * one. It is what makes `/api/restore` possible: without a Customer there
       * is nothing to look a purchase up *by* when someone closes the tab
       * before the redirect, and with no database of our own, Stripe's customer
       * record is the only durable trace the order leaves. */
      customer_creation: 'always',
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: quote.totalCents,
            product_data: {
              name: 'Aether Nexus',
              description: `${description} — includes ${feeLabel().toLowerCase()}`,
            },
          },
        },
      ],
      // Read back on return to work out what was bought. Stripe echoes it
      // verbatim, and it is on the session rather than in the URL so it cannot
      // be edited between leaving and coming back.
      metadata: {
        intent,
        credits: String(credits),
        grantsAccess: String(grantsAccess),
        /* WHOSE order this is. A Stripe session id is otherwise a bearer token
         * for the purchase it names: `/api/confirm` would settle it onto
         * whichever account happened to be signed in when the URL was opened.
         * Only set when the buyer was signed in — a signed-out checkout has no
         * account to bind to, and `/api/confirm` deliberately still accepts
         * those rather than turning an in-flight order into a lost one. */
        ...(buyerId ? { userId: buyerId } : {}),
      },
      success_url: `${origin}/api/confirm?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/${intent === 'credits' ? 'store' : ''}`,
    });

    if (!session.url) throw new Error('Stripe returned a session with no URL.');
    return NextResponse.json({ url: session.url, simulated: false });
  } catch (e) {
    console.error('[checkout] Stripe session creation failed:', e);
    return NextResponse.json(
      { error: 'Could not reach the payment provider. Nothing has been charged.' },
      { status: 502 }
    );
  }
}

/**
 * Start the recurring charge for custom-server hosting.
 *
 * ── Why `price_data.recurring` rather than a dashboard Price id ───────────
 *
 * A Price object created in the dashboard has a different id in test mode and in
 * live, so it becomes an environment variable — and an environment variable that
 * is wrong produces a checkout that is silently the wrong price. Building the
 * price inline means the amount comes from `premium.ts` in every environment,
 * which is the same argument `pricing.ts` makes about the one-off SKUs and the
 * reason simulated and live have never disagreed on a total here.
 *
 * ── `client_reference_id` is the whole attribution story ──────────────────
 *
 * A subscription renews with no browser attached, so `/api/confirm` cannot be
 * the thing that grants on month two. Only the webhook can — and the webhook has
 * no session, so the ONLY way it can tell whose entitlement to write is a value
 * carried on the Stripe objects themselves.
 *
 * Both places, deliberately: `client_reference_id` is echoed on the checkout
 * session, and `subscription_data.metadata` puts the same id on the SUBSCRIPTION,
 * so every later `customer.subscription.*` event carries it too. The checkout
 * session is long gone by the second month.
 */
async function startServerHostingCheckout(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Sign in first.' }, { status: 401 });
  }
  const user = await getUserById(session.user.id);
  if (!user) return NextResponse.json({ error: 'User not found.' }, { status: 404 });
  const playerId = await findOrCreatePlayer(session.user.id, user.email);

  const quote = quoteServerHosting();
  const origin = siteOrigin(req);

  const stripe = getStripe();
  if (!stripe) {
    /* ---- simulated ---------------------------------------------------- *
     *
     * This branch used to be a 503 refusing to pretend, on the argument that a
     * simulated subscription would fake the entitlement write — the one thing
     * 7b exists to exercise — and that a `sk_test_` key makes the real path
     * free anyway.
     *
     * The site owner overruled that on 25 August 2026: *"For now someone
     * purchasing we can just skip the actual payment as with other options
     * until I finish stripe integration."* The 503's argument was about test
     * coverage; the cost it ignored was that the product could not be bought or
     * set up by anyone at all, which is worse than an untested webhook.
     *
     * What it costs is written out in full in `premium.ts` under "Simulated
     * purchase", along with how every pretend row is marked and revoked. In
     * one line: this exercises none of Stripe, and it hands out a working
     * entitlement to anyone who reaches this endpoint.
     *
     * The shape below is the one-off SKUs', unchanged — an order id minted HERE
     * and carried on the URL, so replaying the confirm link settles nothing
     * twice — and it dies on the same switch: `/api/confirm` refuses
     * `simulated=1` outright once `stripeConfigured()` is true. */
    if (!simulatedPurchasesAllowed()) {
      /* The opt-in the `stripeConfigured()` switch never was. What this branch
       * hands out is a WORKING SUBSCRIPTION to somebody who paid nothing, and
       * "Stripe has no key yet" describes production too. */
      return NextResponse.json(
        { error: 'Payments are not configured on this deployment.' },
        { status: 503 }
      );
    }
    const url = new URL('/api/confirm', origin);
    url.searchParams.set('simulated', '1');
    url.searchParams.set('intent', SERVER_HOSTING_SKU);
    const orderId = `sim_${randomUUID()}`;
    url.searchParams.set('order', orderId);
    /* Signed like every other simulated order, and bound to this player: this
     * SKU is the most valuable thing the branch grants, so it is the last one
     * that should be settleable from a hand-typed link. `credits` is 0 because
     * hosting buys none, and the confirm side computes the same 0 for a
     * non-'credits' intent. */
    url.searchParams.set(
      SIMULATED_SIGNATURE_PARAM,
      signSimulatedOrder({
        intent: SERVER_HOSTING_SKU,
        credits: 0,
        orderId,
        userId: session.user.id,
      })
    );
    return NextResponse.json({ url: url.toString(), simulated: true });
  }

  try {
    const checkout = await stripe.checkout.sessions.create({
      mode: 'subscription',
      client_reference_id: playerId,
      customer_email: user.email,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: quote.totalCents,
            recurring: { interval: 'month' },
            product_data: {
              name: 'Aether Nexus — custom server',
              description: quote.detail,
            },
          },
        },
      ],
      subscription_data: {
        metadata: { playerId, sku: SERVER_HOSTING_SKU },
      },
      metadata: { playerId, sku: SERVER_HOSTING_SKU },
      success_url: `${origin}/admin/servers?subscribed=1`,
      cancel_url: `${origin}/admin/servers`,
    });

    if (!checkout.url) throw new Error('Stripe returned a session with no URL.');
    return NextResponse.json({ url: checkout.url, simulated: false });
  } catch (e) {
    console.error('[checkout] Stripe subscription session failed:', e);
    return NextResponse.json(
      { error: 'Could not reach the payment provider. Nothing has been charged.' },
      { status: 502 }
    );
  }
}
