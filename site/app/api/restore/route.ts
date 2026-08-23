import { NextResponse } from 'next/server';
import { grant } from '@/lib/entitlement';
import { clampCredits } from '@/lib/pricing';
import { getStripe, stripeConfigured } from '@/lib/stripe';

/**
 * Recover a purchase that never reached this browser.
 *
 * ## The problem this actually solves
 *
 * Entitlement is granted on the return redirect from Stripe. A customer who
 * pays and then closes the tab — or loses signal, or has the redirect eaten by
 * a corporate proxy — has been charged and has nothing. A webhook is the usual
 * answer, and it cannot be the answer here: a webhook has no browser attached,
 * so there is nowhere for it to put the cookie.
 *
 * What it can be instead is a lookup. Stripe already holds the durable record
 * of every payment, so with no database of our own, Stripe *is* the database.
 * The customer proves which purchase is theirs by giving the email they paid
 * with, and everything paid under that email that has not already been settled
 * on this browser is granted.
 *
 * ## What this deliberately is not
 *
 * It is not authentication. An email address is a claim, not a credential, so
 * anyone who knows the email a purchase was made with can pull that purchase
 * onto their own browser. For a one-dollar unlock and a credit balance that is
 * an acceptable exposure; for anything that matters it is not, and the fix is
 * the account system rather than a better version of this. That is the point at
 * which this route should be deleted, not hardened.
 */

const MAX_CUSTOMERS = 5;
const MAX_SESSIONS = 50;

export async function POST(req: Request) {
  if (!stripeConfigured()) {
    return NextResponse.json(
      { error: 'There are no live purchases to restore — checkout is running in test mode.' },
      { status: 400 }
    );
  }

  const stripe = getStripe();
  if (!stripe) {
    return NextResponse.json({ error: 'Payments are not configured.' }, { status: 500 });
  }

  let email = '';
  try {
    const body = (await req.json()) as { email?: unknown };
    email = String(body.email ?? '').trim().toLowerCase();
  } catch {
    return NextResponse.json({ error: 'Malformed request.' }, { status: 400 });
  }

  // Deliberately loose. This is not validation of a person, only a guard
  // against sending obvious rubbish to Stripe.
  if (!email || email.length > 320 || !email.includes('@')) {
    return NextResponse.json({ error: 'Enter the email address you paid with.' }, { status: 400 });
  }

  try {
    const customers = await stripe.customers.list({ email, limit: MAX_CUSTOMERS });
    if (customers.data.length === 0) {
      return NextResponse.json({ error: 'No purchases found for that email address.' }, { status: 404 });
    }

    let grantedAccess = false;
    let grantedCredits = 0;
    let alreadyHad = 0;

    for (const customer of customers.data) {
      const sessions = await stripe.checkout.sessions.list({
        customer: customer.id,
        limit: MAX_SESSIONS,
      });
      for (const session of sessions.data) {
        if (session.payment_status !== 'paid') continue;
        const meta = session.metadata ?? {};
        const intent = meta.intent ?? 'entry';
        const credits = intent === 'entry' ? 0 : clampCredits(meta.credits);
        const { applied } = await grant({
          paid: meta.grantsAccess === 'true' ? true : undefined,
          orderId: session.id,
        });
        if (applied) {
          if (meta.grantsAccess === 'true') grantedAccess = true;
          grantedCredits += credits;
        } else {
          alreadyHad++;
        }
      }
    }

    if (!grantedAccess && grantedCredits === 0) {
      return NextResponse.json({
        ok: true,
        restored: false,
        message: alreadyHad > 0
          ? 'Everything bought with that address is already on this browser.'
          : 'No completed purchases found for that email address.',
      });
    }

    return NextResponse.json({
      ok: true,
      restored: true,
      access: grantedAccess,
      credits: grantedCredits,
      message: `Restored${grantedAccess ? ' game access' : ''}`
        + `${grantedAccess && grantedCredits ? ' and' : ''}`
        + `${grantedCredits ? ` ${grantedCredits.toLocaleString('en-US')} credits` : ''}.`,
    });
  } catch (e) {
    console.error('[restore] Stripe lookup failed:', e);
    return NextResponse.json(
      { error: 'Could not reach the payment provider. Nothing has changed.' },
      { status: 502 }
    );
  }
}
