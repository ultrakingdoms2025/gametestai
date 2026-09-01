import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getUserById } from '@/lib/db';
import { clampCredits } from '@/lib/pricing';
import { findOrCreatePlayer, recordSitePurchase } from '@/lib/playerDb';
import { getStripe, stripeConfigured } from '@/lib/stripe';
import { RATE_LIMITS, consumeRateLimit, tooManyRequests } from '@/lib/rateLimit';

/**
 * Recover a purchase that never reached this account.
 *
 * ## The problem this actually solves
 *
 * Provisioning happens on the return redirect from Stripe. A customer who pays
 * and then closes the tab — or loses signal, or has the redirect eaten by a
 * corporate proxy — has been charged and has nothing. The webhook is the
 * automatic retry for that (see `app/api/webhook/route.ts`); this is the manual
 * one, for the orders that predate it or that the webhook could not attribute.
 *
 * ## What this route used to be, and why it was three bugs at once
 *
 * It took an email address out of the POST body and granted on the strength of
 * it. That was:
 *
 *   1. **Unauthenticated.** An email address is a claim, not a credential, so
 *      anyone who knew the address a purchase was made with could pull that
 *      purchase onto themselves. The file said so, called it "an acceptable
 *      exposure", and said the fix was the account system rather than a better
 *      version of this. The account system has since been built — `auth()`,
 *      `site_users`, `players` — so the stated condition for deleting the
 *      unauthenticated form has been met.
 *   2. **A customer-enumeration oracle.** `404 No purchases found for that
 *      email address` versus a 200 told anybody who asked whether a given
 *      person had bought the game. It answers the same way for everyone now,
 *      because it only ever looks up the caller's own address.
 *   3. **Restoring nothing.** It wrote an `an_pass` cookie via
 *      `lib/entitlement.ts`, and NO ACCESS CHECK ANYWHERE READ THAT COOKIE:
 *      access is decided by `lib/access.ts` from the `players` table alone. So
 *      it reported "Restored game access" and the customer still could not
 *      play. It now calls `recordSitePurchase`, which is what actually grants
 *      access and credits, and is idempotent per order id — so a customer who
 *      presses it twice, or whose webhook lands in between, is granted once.
 *
 * ## The email is the session's, never the body's
 *
 * There is deliberately no body parameter left. A signed-in caller can only
 * restore what was bought under their own verified address, which is the whole
 * difference between this and what it replaces. An operator restoring on
 * someone else's behalf is an admin action and belongs in the admin app, with
 * an audit row, not on a public endpoint.
 */

const MAX_CUSTOMERS = 5;
const MAX_SESSIONS = 50;

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Sign in first.' }, { status: 401 });
  }

  /* One customer lookup plus a sessions listing per call, against Stripe's own
   * rate limits. Authenticated now, so the account is the key that matters;
   * this bounds a signed-in caller holding the button down and spending our
   * Stripe quota for everybody else. */
  const verdict = await consumeRateLimit(
    'restore',
    [{ namespace: 'user', value: session.user.id }],
    RATE_LIMITS.restore
  );
  if (!verdict.allowed) {
    return tooManyRequests(verdict, 'Too many restore attempts. Try again shortly.');
  }

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

  /* Read from the database rather than from the session token: the token is
   * whatever was minted at sign-in, and an address changed since then would
   * send us looking up the wrong customer. */
  const user = await getUserById(session.user.id);
  if (!user?.email) {
    return NextResponse.json({ error: 'User not found.' }, { status: 404 });
  }
  const email = user.email.toLowerCase().trim();

  try {
    const playerId = await findOrCreatePlayer(user.id, user.email);
    const customers = await stripe.customers.list({ email, limit: MAX_CUSTOMERS });

    let restoredAccess = false;
    let restoredCredits = 0;
    let alreadyHad = 0;

    for (const customer of customers.data) {
      const sessions = await stripe.checkout.sessions.list({
        customer: customer.id,
        limit: MAX_SESSIONS,
      });
      for (const paid of sessions.data) {
        if (paid.payment_status !== 'paid') continue;
        /* Subscriptions are not this route's business. Hosting entitlement is
         * written by the webhook from `customer.subscription.*` events and has
         * its own ordering guard; replaying one through the purchase ledger
         * would put a row in `purchases` for a recurring charge and grant
         * thirty days of GAME ACCESS for a server subscription. */
        if (paid.mode === 'subscription') continue;

        const meta = paid.metadata ?? {};
        const intent = typeof meta.intent === 'string' && meta.intent ? meta.intent : 'entry';
        const credits = intent === 'entry' ? 0 : clampCredits(meta.credits);
        const type: 'access' | 'credits' | 'access+credits' =
          intent === 'credits' ? 'credits'
          : intent === 'entry+credits' ? 'access+credits'
          : 'access';

        /* The same call, the same order id and the same idempotency the
         * redirect and the webhook use. Whichever of the three arrives first
         * grants; the other two find the row and report `false`. */
        const applied = await recordSitePurchase({
          playerId,
          type,
          amountCents: paid.amount_total ?? 0,
          creditsAmount: credits,
          orderId: paid.id,
          actorEmail: user.email,
        });
        if (applied) {
          if (type !== 'credits') restoredAccess = true;
          restoredCredits += credits;
        } else {
          alreadyHad++;
        }
      }
    }

    if (!restoredAccess && restoredCredits === 0) {
      /* One answer for "no such customer" and for "nothing outstanding". The
       * 404 that used to distinguish them told anyone who asked whether a
       * given address had ever bought the game. */
      return NextResponse.json({
        ok: true,
        restored: false,
        message: alreadyHad > 0
          ? 'Everything bought with your address is already on your account.'
          : 'No completed purchases are outstanding for your account.',
      });
    }

    return NextResponse.json({
      ok: true,
      restored: true,
      access: restoredAccess,
      credits: restoredCredits,
      message: `Restored${restoredAccess ? ' game access' : ''}`
        + `${restoredAccess && restoredCredits ? ' and' : ''}`
        + `${restoredCredits ? ` ${restoredCredits.toLocaleString('en-US')} credits` : ''}.`,
    });
  } catch (e) {
    console.error('[restore] lookup or provisioning failed:', e);
    return NextResponse.json(
      { error: 'Could not reach the payment provider. Nothing has changed.' },
      { status: 502 }
    );
  }
}
