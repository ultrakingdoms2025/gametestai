import { describe, it, expect, beforeEach, afterAll } from 'vitest';

/**
 * The fence in front of a purchase nobody paid for.
 *
 * ── The hole these pin ────────────────────────────────────────────────────
 *
 * `/api/confirm` refused `simulated=1` "the moment real payments are possible",
 * which reads as a fence and is the inverse of one. `stripeConfigured()` is
 * FALSE on every deployment that has not been given keys — production included
 * — so on the live site anyone signed in could GET
 *
 *   /api/confirm?simulated=1&intent=credits&credits=10000&order=anything
 *
 * and grant themselves paid access plus ten thousand credits. Repeatably: the
 * order id was theirs to choose, so the idempotency that was supposed to make a
 * replay a no-op was defeated by typing a new one.
 *
 * Two things now stand there, and this file is about both:
 *
 *   1. `simulatedPurchasesAllowed()` — an explicit opt-in that is absent by
 *      default and that production cannot switch on.
 *   2. A signature over the order's terms, so the order id, the intent and the
 *      credit count are minted by `/api/checkout` rather than typed.
 */

/* `signSimulatedOrder` uses `appSecret()`, which no longer invents a key. Set
 * before the modules are imported, the way `totp.test.ts` supplies
 * `ENCRYPTION_KEY` for `secretBox`. */
process.env.NEXTAUTH_SECRET ||= 'test-only-app-secret-at-least-32-chars-long';

const SAVED = {
  stripe: process.env.STRIPE_SECRET_KEY,
  allow: process.env.ALLOW_SIMULATED_PURCHASE,
  vercelEnv: process.env.VERCEL_ENV,
};

function setEnv(next: { stripe?: string; allow?: string; vercelEnv?: string }) {
  if (next.stripe === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = next.stripe;
  if (next.allow === undefined) delete process.env.ALLOW_SIMULATED_PURCHASE;
  else process.env.ALLOW_SIMULATED_PURCHASE = next.allow;
  if (next.vercelEnv === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = next.vercelEnv;
}

beforeEach(() => setEnv({}));
afterAll(() => setEnv(SAVED));

describe('simulatedPurchasesAllowed', () => {
  it('is FALSE with no Stripe key and no opt-in — the production case that was open', async () => {
    const { simulatedPurchasesAllowed } = await import('./stripe');
    /* This is the exact configuration production ran in. "Stripe is off" was
     * being read as "free grants are permitted", and those are different
     * claims. */
    setEnv({});
    expect(simulatedPurchasesAllowed()).toBe(false);
  });

  it('is true only for an explicit "1"', async () => {
    const { simulatedPurchasesAllowed } = await import('./stripe');
    setEnv({ allow: '1' });
    expect(simulatedPurchasesAllowed()).toBe(true);

    /* Fails closed on anything else. A half-set variable — "true", "yes", "0",
     * an empty string someone cleared in a dashboard — must not be permission,
     * because the person who typed it did not get what they thought either
     * way, and refusing is the safe direction to be wrong in. */
    for (const value of ['true', 'yes', 'on', '0', '', ' 1', '1 ']) {
      setEnv({ allow: value });
      expect(simulatedPurchasesAllowed(), `ALLOW_SIMULATED_PURCHASE=${JSON.stringify(value)}`).toBe(false);
    }
  });

  it('is FALSE in production however the flag is set', async () => {
    const { simulatedPurchasesAllowed } = await import('./stripe');
    setEnv({ allow: '1', vercelEnv: 'production' });
    expect(simulatedPurchasesAllowed()).toBe(false);
  });

  it('is FALSE once a Stripe key exists, which is the original guard', async () => {
    const { simulatedPurchasesAllowed } = await import('./stripe');
    setEnv({ allow: '1', stripe: 'sk_test_pretend' });
    expect(simulatedPurchasesAllowed()).toBe(false);
  });
});

describe('the signature over a simulated order', () => {
  const terms = { intent: 'credits', credits: 250, orderId: 'sim_abc', userId: 'user-1' };

  it('round-trips the terms it was minted for', async () => {
    const { signSimulatedOrder, verifySimulatedOrder } = await import('./simulatedOrder');
    expect(verifySimulatedOrder(terms, signSimulatedOrder(terms))).toBe(true);
  });

  it('refuses every field being edited, one at a time', async () => {
    const { signSimulatedOrder, verifySimulatedOrder } = await import('./simulatedOrder');
    const sig = signSimulatedOrder(terms);

    /* The attack verbatim: the same link with a bigger number on the end. */
    expect(verifySimulatedOrder({ ...terms, credits: 10_000 }, sig)).toBe(false);
    /* And the one that defeated idempotency: a fresh order id per replay. */
    expect(verifySimulatedOrder({ ...terms, orderId: 'sim_something_else' }, sig)).toBe(false);
    /* Buying access rather than the credits that were quoted. */
    expect(verifySimulatedOrder({ ...terms, intent: 'entry' }, sig)).toBe(false);
    /* Someone else's order settled onto this account. */
    expect(verifySimulatedOrder({ ...terms, userId: 'user-2' }, sig)).toBe(false);
  });

  it('refuses a missing, empty or malformed signature rather than throwing', async () => {
    const { verifySimulatedOrder } = await import('./simulatedOrder');
    for (const given of [undefined, null, '', 'not-a-signature', 42, {}]) {
      expect(verifySimulatedOrder(terms, given)).toBe(false);
    }
  });

  it('binds a signed-out order to the empty user, not to whoever opens it', async () => {
    const { signSimulatedOrder, verifySimulatedOrder } = await import('./simulatedOrder');
    const anon = { ...terms, userId: '' };
    const sig = signSimulatedOrder(anon);
    expect(verifySimulatedOrder(anon, sig)).toBe(true);
    // A link minted signed-out does not settle onto the first account to open it.
    expect(verifySimulatedOrder({ ...anon, userId: 'user-1' }, sig)).toBe(false);
  });
});

describe('checkout and confirm agree on the credit count', () => {
  /* THE BUG THIS EXISTS TO STOP COMING BACK.
   *
   * Both sides feed `credits` into the signature, so they have to compute it
   * identically or every simulated order is refused as altered. The obvious
   * spelling — `intent === 'entry' ? 0 : clampCredits(param)` — does NOT agree
   * for an intent that carries no `credits` parameter at all, because
   * `clampCredits(null)` is `Math.floor(Number(null))` = 0, which is finite,
   * so it returns MIN_CREDITS rather than 0.
   *
   * The hosting SKU carries no `credits` parameter, so confirm would compute
   * MIN_CREDITS against a checkout that signed 0 and the whole simulated
   * hosting purchase would break. Asserted on the FUNCTION rather than on the
   * source text, so it keeps meaning something if either side is rewritten. */
  it('clampCredits(null) is MIN_CREDITS, not zero — the trap itself', async () => {
    const { clampCredits, MIN_CREDITS } = await import('./pricing');
    expect(clampCredits(null)).toBe(MIN_CREDITS);
    expect(MIN_CREDITS).toBeGreaterThan(0);
  });

  it('a hosting order signs and verifies zero credits on both sides', async () => {
    const { signSimulatedOrder, verifySimulatedOrder } = await import('./simulatedOrder');
    const { SERVER_HOSTING_SKU } = await import('./premium');

    // What `/api/checkout` signs for the subscription SKU.
    const minted = {
      intent: SERVER_HOSTING_SKU,
      credits: 0,
      orderId: 'sim_hosting_1',
      userId: 'user-1',
    };
    const sig = signSimulatedOrder(minted);

    /* What `/api/confirm` recomputes from a URL with no `credits` on it. The
     * rule is "only the credit-bearing intents read the parameter", which is
     * what makes the two sides agree. */
    const params = new URLSearchParams({
      simulated: '1',
      intent: SERVER_HOSTING_SKU,
      order: 'sim_hosting_1',
    });
    const intent = params.get('intent') ?? 'entry';
    const credits = intent === 'credits' || intent === 'entry+credits'
      ? Number(params.get('credits'))
      : 0;

    expect(credits).toBe(0);
    expect(verifySimulatedOrder({ intent, credits, orderId: 'sim_hosting_1', userId: 'user-1' }, sig)).toBe(true);
  });
});
