import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { grant } from '@/lib/entitlement';
import { clampCredits } from '@/lib/pricing';
import { getStripe, siteOrigin, stripeConfigured } from '@/lib/stripe';

/**
 * Payment came back. Grant what was bought.
 *
 * ## Simulated mode is fenced off, not just defaulted off
 *
 * In test mode this endpoint grants an entitlement on the strength of a query
 * string, which means anyone who finds the URL can hand themselves ten thousand
 * credits. That is exactly what was asked for while there are no keys, and it is
 * fine while there is no money involved — but it must not survive the day the
 * keys arrive.
 *
 * So the check is not "prefer Stripe when available". It is: **if Stripe is
 * configured, `simulated=1` is refused outright.** Adding the secret key closes
 * the door in the same action that opens the real one, rather than leaving a
 * bypass alive behind a flag someone has to remember to flip.
 *
 * ## Live mode trusts the session, not the caller
 *
 * The browser is redirected here with a session id. What was bought and whether
 * it was paid for are read back from Stripe against that id — never from the
 * URL — so a hand-edited `credits=9999` changes nothing.
 *
 * A webhook is still the right way to do this for real. A customer who closes
 * the tab during the redirect has paid and not been granted, and only a webhook
 * catches that. See the README.
 */

export async function GET(req: Request) {
  const url = new URL(req.url);
  const origin = siteOrigin(req);
  const simulated = url.searchParams.get('simulated') === '1';
  const sessionId = url.searchParams.get('session_id');

  /* ---- simulated ------------------------------------------------------- */
  if (simulated) {
    if (stripeConfigured()) {
      // The bypass is dead the moment real payments are possible.
      return NextResponse.redirect(new URL('/?error=simulated-disabled', origin), 303);
    }
    const intent = url.searchParams.get('intent') ?? 'entry';
    const credits = intent === 'entry' ? 0 : clampCredits(url.searchParams.get('credits'));
    /* The order id minted at checkout. Falling back to a fresh one only covers
     * a hand-typed URL with no `order` on it; a real simulated purchase always
     * carries one, so replaying it settles nothing twice — the same property
     * the live path has, exercised by the same test. */
    const orderId = url.searchParams.get('order') || `sim_${randomUUID()}`;
    await grant({
      paid: intent !== 'credits' ? true : undefined,
      addCredits: credits,
      orderId,
    });
    return NextResponse.redirect(new URL('/play?welcome=1', origin), 303);
  }

  /* ---- live ------------------------------------------------------------ */
  if (!sessionId) {
    return NextResponse.redirect(new URL('/?error=no-session', origin), 303);
  }

  const stripe = getStripe();
  if (!stripe) {
    return NextResponse.redirect(new URL('/?error=not-configured', origin), 303);
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== 'paid') {
      return NextResponse.redirect(new URL('/?error=unpaid', origin), 303);
    }
    const meta = session.metadata ?? {};
    const intent = meta.intent ?? 'entry';
    const credits = intent === 'entry' ? 0 : clampCredits(meta.credits);
    /* Keyed on the session id, so this is safe to hit twice. It will be: the
     * customer can refresh the success page, come back to it from history, or
     * arrive here at the same moment the webhook is settling the same order. */
    const { applied } = await grant({
      paid: meta.grantsAccess === 'true' ? true : undefined,
      addCredits: credits,
      orderId: session.id,
    });
    if (!applied) console.log(`[confirm] Order ${session.id} was already settled; no double credit.`);
    return NextResponse.redirect(new URL('/play?welcome=1', origin), 303);
  } catch (e) {
    console.error('[confirm] Could not verify the Stripe session:', e);
    return NextResponse.redirect(new URL('/?error=verify-failed', origin), 303);
  }
}
