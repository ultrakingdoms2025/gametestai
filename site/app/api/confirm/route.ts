import { NextResponse } from 'next/server';
import { sendPurchaseConfirmationEmail } from '@/lib/email';
import { clampCredits } from '@/lib/pricing';
import { getStripe, siteOrigin, simulatedPurchasesAllowed, stripeConfigured } from '@/lib/stripe';
import { SIMULATED_SIGNATURE_PARAM, verifySimulatedOrder } from '@/lib/simulatedOrder';
import { auth } from '@/lib/auth';
import { findOrCreatePlayer, getPlayerStatus, recordSitePurchase } from '@/lib/playerDb';
import { SERVER_HOSTING_SKU, grantSimulatedHosting } from '@/lib/premium';
import { auditServerAction, openServerDb } from '@/lib/serverRoutes';

/**
 * Payment came back. Grant what was bought.
 *
 * ## Simulated mode is fenced off, not just defaulted off
 *
 * In test mode this endpoint grants an entitlement on the strength of a query
 * string, which means anyone who finds the URL can hand themselves ten thousand
 * credits.
 *
 * The original fence was `stripeConfigured()`: "if Stripe is configured,
 * `simulated=1` is refused outright". The argument was right and the fence was
 * not, because it reads the wrong way round. An empty `STRIPE_SECRET_KEY`
 * describes every deployment that has not been given keys yet — PRODUCTION
 * INCLUDED — so on the live site anyone signed in could GET
 * `/api/confirm?simulated=1&intent=credits&credits=10000&order=anything` and
 * grant themselves paid access plus ten thousand credits, again and again: the
 * order id was theirs to choose, so the replay guard was defeated by typing a
 * new one.
 *
 * Three things now stand in front of the simulated branch, and it takes all
 * three:
 *
 *   1. `stripeConfigured()` — unchanged. Adding the key still closes this door
 *      in the same action that opens the real one.
 *   2. `simulatedPurchasesAllowed()` — an explicit `ALLOW_SIMULATED_PURCHASE=1`
 *      opt-in that `VERCEL_ENV=production` cannot switch on at all. Absent
 *      means refused, so a deployment that has never heard of the variable
 *      fails closed rather than inheriting the bypass.
 *   3. A signature over the order's terms, minted by `/api/checkout`. The order
 *      id, the intent and the credit count are no longer the caller's to write,
 *      so the idempotency actually bounds a replay and `credits=` cannot be
 *      edited onto the end of a link. See `lib/simulatedOrder.ts`.
 *
 * Custom-server hosting comes through the same door on the same switches — see
 * `simulatedHostingGrant` below and the "Simulated purchase" section of
 * `premium.ts`.
 *
 * ## Live mode trusts the session, not the caller
 *
 * The browser is redirected here with a session id. What was bought and whether
 * it was paid for are read back from Stripe against that id — never from the
 * URL — so a hand-edited `credits=9999` changes nothing.
 *
 * WHOSE purchase it is is now checked too. `/api/checkout` stamps
 * `metadata.userId` on the session when the buyer was signed in, and a session
 * carrying one is refused for anybody else. Without that, a Stripe session id
 * is a bearer token for someone else's purchase.
 *
 * ## A GET that mutates, and what can and cannot be done about it
 *
 * Stripe redirects the browser here by top-level navigation from
 * checkout.stripe.com, so `Sec-Fetch-Site` on a legitimate live return is
 * `cross-site` and requiring same-origin would break the contract outright.
 * What IS required is that the request be a document navigation
 * (`Sec-Fetch-Dest: document`), which a real return always is and which refuses
 * the `<img src=…>` and `fetch()` shapes a CSRF actually uses. Browsers that
 * send no `Sec-Fetch-*` headers at all are allowed through rather than broken,
 * so this is a narrowing and not a gate.
 *
 * The gate proper is elsewhere and is stronger than a header check: the live
 * path grants only what Stripe says was paid for, only to the account that
 * bought it, once per session id — so the worst a forged live request achieves
 * is settling the victim's own purchase onto the victim's own account. The
 * simulated path, which is the one where a forged request would have been
 * worth something, carries a signature.
 *
 * ## A purchase must never be lost quietly
 *
 * `recordForUser` used to `return` when there was no signed-in user, swallow a
 * database failure in a `catch` that only logged, and let the route redirect to
 * `/play?welcome=1` regardless — so a customer who had been charged was shown a
 * welcome screen and given nothing, and nothing anywhere recorded that it had
 * happened. It now reports what went wrong, the route sends those customers to
 * `/order/failed` carrying the session id, and the failure is logged at error
 * level against that id so support can trace one from the other. The webhook is
 * the retry behind it — see `app/api/webhook/route.ts`.
 */

/**
 * What provisioning did. `code` is what support quotes back, and it is on the
 * URL the customer lands on as well as in the log line.
 */
type ProvisionFailure = 'not-signed-in' | 'provisioning-failed';
type Provisioned =
  | { ok: true; recorded: boolean }
  | { ok: false; code: ProvisionFailure };

export async function GET(req: Request) {
  const url = new URL(req.url);
  const origin = siteOrigin(req);
  const simulated = url.searchParams.get('simulated') === '1';
  const sessionId = url.searchParams.get('session_id');

  /* Not a gate — see the docblock. A legitimate arrival here is always a
   * top-level document navigation, whether Stripe redirected it or a simulated
   * checkout did; a sub-resource load never is. Absent headers pass, because an
   * old browser sending none is a customer, not an attacker. */
  const dest = req.headers.get('sec-fetch-dest');
  if (dest && dest !== 'document') {
    return NextResponse.json({ error: 'Not a navigation.' }, { status: 400 });
  }

  // Get logged-in user for audit trail
  const session = await auth();
  const userId = session?.user?.id;
  const userEmail = session?.user?.email;

  async function recordForUser(opts: {
    intent: string;
    credits: number;
    amountCents: number;
    orderId: string;
  }): Promise<Provisioned> {
    /* A purchase with nobody to attribute it to is a FAILURE, not a no-op. It
     * used to return here, and the caller then redirected to the welcome page:
     * the customer had paid, had no access, and no line anywhere said so. */
    if (!userId || !userEmail) {
      console.error(
        `[confirm] order ${opts.orderId} could not be provisioned: no signed-in `
        + 'account to attribute it to. The payment stands and the entitlement does not.'
      );
      return { ok: false, code: 'not-signed-in' };
    }
    let recorded: boolean;
    try {
      const playerId = await findOrCreatePlayer(userId, userEmail);
      const type: 'access' | 'credits' | 'access+credits' =
        opts.intent === 'credits' ? 'credits'
        : opts.intent === 'entry+credits' ? 'access+credits'
        : 'access';
      recorded = await recordSitePurchase({
        playerId,
        type,
        amountCents: opts.amountCents,
        creditsAmount: opts.credits,
        orderId: opts.orderId,
        actorEmail: userEmail,
      });
      if (recorded) {
        const player = await getPlayerStatus(userId);
        const handle = player?.handle ?? player?.fullName ?? userEmail.split('@')[0];
        /* The confirmation email is the one thing here allowed to fail without
         * failing the purchase: the entitlement is already written, and telling
         * a provisioned customer their order failed because a mail relay was
         * down would be the opposite of this fix. */
        try {
          await sendPurchaseConfirmationEmail({
            to: userEmail,
            handle,
            type,
            amountCents: opts.amountCents,
            creditsAmount: opts.credits,
            orderId: opts.orderId,
          });
        } catch (err) {
          console.error('[confirm] Failed to send purchase confirmation email:', err);
        }
      }
    } catch (err) {
      /* Was: `console.error` and fall through to the welcome page. The customer
       * has been charged and has nothing, so this is the one line support will
       * be searching for — it carries the order id, at error level. */
      console.error(
        `[confirm] PROVISIONING FAILED for order ${opts.orderId} `
        + `(account ${userId}): the payment stands and the entitlement does not.`,
        err
      );
      return { ok: false, code: 'provisioning-failed' };
    }
    return { ok: true, recorded };
  }

  /** Where a customer goes when they have paid and we could not deliver. */
  function failed(ref: string, code: ProvisionFailure) {
    const to = new URL('/order/failed', origin);
    to.searchParams.set('ref', ref);
    to.searchParams.set('code', code);
    return NextResponse.redirect(to, 303);
  }

  /* ---- simulated ------------------------------------------------------- */
  if (simulated) {
    if (stripeConfigured()) {
      // The bypass is dead the moment real payments are possible.
      return NextResponse.redirect(new URL('/?error=simulated-disabled', origin), 303);
    }
    if (!simulatedPurchasesAllowed()) {
      /* And dead by default everywhere else. `stripeConfigured()` above only
       * ever said "payments are possible"; it never said "free grants are
       * permitted here", and production was reading the first as the second. */
      console.error(
        '[confirm] refused a simulated settlement: ALLOW_SIMULATED_PURCHASE is not '
        + '1, or this is a production deployment.'
      );
      return NextResponse.redirect(new URL('/?error=simulated-not-enabled', origin), 303);
    }
    const intent = url.searchParams.get('intent') ?? 'entry';
    /* Only the credit-bearing intents read the parameter, and this must agree
     * EXACTLY with `/api/checkout`, because both numbers go into the signature.
     *
     * `intent === 'entry' ? 0 : clampCredits(...)` — the shape used here before
     * and still used on the live path — would not: `clampCredits(null)` is
     * `Math.floor(Number(null))` = 0, which is finite, so it returns
     * MIN_CREDITS rather than 0. The hosting SKU carries no `credits`
     * parameter at all, so confirm would compute MIN_CREDITS against a
     * checkout that signed 0, and every simulated hosting purchase would be
     * refused as altered. */
    const credits = intent === 'credits' || intent === 'entry+credits'
      ? clampCredits(url.searchParams.get('credits'))
      : 0;
    /* The order id minted at checkout. No fallback to a fresh one any more: a
     * hand-typed URL is exactly the case this is refusing, and minting an id
     * for one was what let a replay settle twice. */
    const orderId = url.searchParams.get('order') ?? '';

    /* The terms have to be the ones `/api/checkout` issued, to the account it
     * issued them to. Without this, every value above is the caller's to
     * choose and the replay guard guards an id they invented. */
    const signed = verifySimulatedOrder(
      { intent, credits, orderId, userId: userId ?? '' },
      url.searchParams.get(SIMULATED_SIGNATURE_PARAM)
    );
    if (!orderId || !signed) {
      console.error(`[confirm] refused an unsigned or altered simulated order: ${orderId || '(none)'}`);
      return NextResponse.redirect(new URL('/?error=simulated-unsigned', origin), 303);
    }

    /* ---- the subscription SKU ---------------------------------------- *
     *
     * Handled before the one-off grant and returning early, because nothing
     * below it applies: hosting is not game access and buys no credits, so
     * `recordSitePurchase` deliberately gets no row — a purchase-ledger line
     * for money that never moved is exactly the revenue figure the simulated
     * marking exists to protect.
     *
     * What it writes instead is an entitlement, marked as pretend on the way
     * in. `grantSimulatedHosting` re-checks BOTH switches after the guards at
     * the top of this branch have already refused. The duplication is on
     * purpose: the library is what writes the row, so a caller added later
     * inherits the guard instead of remembering it. */
    if (intent === SERVER_HOSTING_SKU) {
      return simulatedHostingGrant({ orderId, origin, userId, userEmail });
    }

    const out = await recordForUser({ intent, credits, amountCents: 0, orderId });
    if (!out.ok) return failed(orderId, out.code);
    if (!out.recorded) console.log(`[confirm] Order ${orderId} was already settled; no double credit.`);
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

  let stripeSession;
  try {
    stripeSession = await stripe.checkout.sessions.retrieve(sessionId);
  } catch (e) {
    console.error('[confirm] Could not verify the Stripe session:', e);
    return NextResponse.redirect(new URL('/?error=verify-failed', origin), 303);
  }

  if (stripeSession.payment_status !== 'paid') {
    return NextResponse.redirect(new URL('/?error=unpaid', origin), 303);
  }
  const meta = stripeSession.metadata ?? {};

  /* A session id is otherwise a bearer token for whoever's purchase it names.
   * Only sessions started while signed OUT carry no `userId`, and those are
   * left as they were rather than refused — refusing them would turn an old
   * in-flight checkout into a lost purchase, which is the defect above. */
  if (meta.userId && meta.userId !== userId) {
    console.error(
      `[confirm] refused session ${stripeSession.id}: it belongs to account `
      + `${meta.userId}, not to ${userId ?? '(signed out)'}.`
    );
    return NextResponse.redirect(new URL('/?error=wrong-account', origin), 303);
  }

  const intent = meta.intent ?? 'entry';
  const credits = intent === 'entry' ? 0 : clampCredits(meta.credits);
  /* Keyed on the session id, so this is safe to hit twice. It will be: the
   * customer can refresh the success page, come back to it from history, or
   * arrive here at the same moment the webhook is settling the same order. */
  const out = await recordForUser({
    intent,
    credits,
    amountCents: stripeSession.amount_total ?? 0,
    orderId: stripeSession.id,
  });
  if (!out.ok) return failed(stripeSession.id, out.code);
  if (!out.recorded) console.log(`[confirm] Order ${stripeSession.id} was already settled; no double credit.`);
  return NextResponse.redirect(new URL('/play?welcome=1', origin), 303);
}

/**
 * Settle a simulated hosting purchase, and land the customer where the next
 * step is obvious.
 *
 * ── Where it lands, and why not the home page ─────────────────────────────
 *
 * `/admin/servers?subscribed=1` — the SAME url the live `success_url` already
 * uses, so simulated and real end in one place and the "what now?" panel there
 * has one trigger to read. The one-off SKUs land on `/play?welcome=1` for the
 * same reason: the thing you just bought is one click from where you arrive.
 * Dropping a new subscriber on `/` and leaving them to guess at `/admin/servers`
 * is what the owner was complaining about.
 *
 * ── Signed out ────────────────────────────────────────────────────────────
 *
 * `/api/checkout` already refuses this SKU with a 401 before minting a URL, so
 * a session-less request here is a hand-typed link. It is sent to sign in and
 * back to the store rather than silently granting nothing, because an
 * entitlement has to belong to a player and there is no player.
 */
async function simulatedHostingGrant(opts: {
  orderId: string;
  origin: string;
  userId?: string;
  userEmail?: string | null;
}) {
  const { orderId, origin, userId, userEmail } = opts;
  if (!userId || !userEmail) {
    return NextResponse.redirect(
      new URL('/login?callbackUrl=%2Fstore', origin),
      303
    );
  }

  let db: Awaited<ReturnType<typeof openServerDb>> | null = null;
  try {
    db = await openServerDb();
    const playerId = await findOrCreatePlayer(userId, userEmail);
    const out = await grantSimulatedHosting(db, { playerId, orderId });
    if (!out.granted) {
      console.error(`[confirm] simulated hosting grant refused: ${out.reason}`);
      return NextResponse.redirect(
        new URL(`/admin/servers?error=${out.reason}`, origin),
        303
      );
    }
    /* Audited like any other administrative act. This is the trail that says
     * WHO was handed a subscription nobody paid for, which is the question
     * asked on the day the pretend rows are swept. Never fails the request. */
    await auditServerAction(
      db,
      { playerId, email: userEmail, platformAdmin: false },
      'entitlement.simulated_grant',
      `player:${playerId}`,
      { orderId, subscriptionId: out.entitlement.subscriptionId, sku: SERVER_HOSTING_SKU }
    );
    return NextResponse.redirect(new URL('/admin/servers?subscribed=1', origin), 303);
  } catch (err) {
    console.error('[confirm] Could not grant simulated hosting:', err);
    return NextResponse.redirect(new URL('/admin/servers?error=grant-failed', origin), 303);
  } finally {
    await db?.end().catch(() => {});
  }
}
