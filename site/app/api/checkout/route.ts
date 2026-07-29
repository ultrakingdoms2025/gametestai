import { NextResponse } from 'next/server';
import { readPass } from '@/lib/entitlement';
import {
  clampCredits,
  feeLabel,
  quoteCredits,
  quoteEntry,
  quoteEntryWithCredits,
  type Quote,
} from '@/lib/pricing';
import { getStripe, siteOrigin, stripeConfigured } from '@/lib/stripe';

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

  const pass = await readPass();
  const alreadyPaid = !!pass?.paid;

  const requested = String(body.intent ?? 'entry');
  // A customer who has already paid for access cannot be sold it again, whatever
  // the request says.
  const intent: 'entry' | 'credits' | 'entry+credits' =
    requested === 'credits' && alreadyPaid ? 'credits'
      : requested === 'credits' || requested === 'entry+credits'
        ? (alreadyPaid ? 'credits' : 'entry+credits')
        : alreadyPaid ? 'credits' : 'entry';

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
    const url = new URL('/api/confirm', origin);
    url.searchParams.set('simulated', '1');
    url.searchParams.set('intent', intent);
    url.searchParams.set('credits', String(credits));
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
