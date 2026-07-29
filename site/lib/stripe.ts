import Stripe from 'stripe';

/**
 * Stripe, when it is configured.
 *
 * ## Simulated mode
 *
 * The brief is that the whole payment flow should be walkable now, with nothing
 * actually executing on Stripe, and that keys arrive later. So the presence of
 * `STRIPE_SECRET_KEY` is the switch: without it every checkout is simulated and
 * the customer walks the same screens against the same quote, and with it the
 * identical flow creates a real Checkout Session.
 *
 * The important part is that simulated mode is *not* a different code path
 * through the pricing. The quote, the line items and the total are computed by
 * the same functions either way, so the number on the simulated receipt is the
 * number Stripe will be handed the day the key is set. If the two were computed
 * separately, turning Stripe on would be the first time anyone found out they
 * disagreed.
 */

let client: Stripe | null = null;

export function stripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

/**
 * The Stripe client, or null when no key is set.
 *
 * Constructed lazily. Building it at module scope would throw on import in
 * every deployment that has not been given a key yet, which is every deployment
 * until the day they are added.
 */
export function getStripe(): Stripe | null {
  if (!stripeConfigured()) return null;
  if (!client) {
    client = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
      // Pinned. An account's default version can move under you, and a payment
      // integration silently changing shape is not a surprise anyone wants.
      apiVersion: '2025-01-27.acacia' as Stripe.LatestApiVersion,
      appInfo: { name: 'Aether Nexus', version: '1.0.0' },
    });
  }
  return client;
}

/** Absolute origin for redirect URLs, which Stripe requires. */
export function siteOrigin(req: Request): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  if (configured) return configured.replace(/\/+$/, '');
  // Vercel sets this on every deployment, including previews, so checkout
  // redirects land back on the deployment the customer actually started from
  // rather than on production.
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (vercel) return `https://${vercel}`;
  return new URL(req.url).origin;
}
