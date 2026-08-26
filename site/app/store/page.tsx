import Link from 'next/link';
import CreditPicker from '@/components/CreditPicker';
import { getCurrentAccessState } from '@/lib/access';
import { stripeConfigured } from '@/lib/stripe';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Buy credits — AETHER NEXUS' };

export default async function Store() {
  const { hasAccess } = await getCurrentAccessState();

  return (
    <main>
      <section style={{ paddingTop: 56 }}>
        <div className="wrap">
          <div className="head">
            <div className="eyebrow">
              <Link href="/" style={{ textDecoration: 'none' }}>
                ← Aether Nexus
              </Link>
            </div>
            <h2>Credits</h2>
            <p>
              Spent in-game on ammunition, equipment and anything a merchant will sell
              you. You can also earn them: race podiums, hidden relics, contracts and
              loot all pay.
            </p>
          </div>

          {!stripeConfigured() ? (
            <div className="banner" role="status">
              <b>Test mode</b>
              <span>
                Checkout is simulated — the totals are real, but no card is taken and
                nothing reaches Stripe.
              </span>
            </div>
          ) : null}

          {/* A "Waiting — you have N credits bought and not yet collected, they
              are added the next time you enter the game" banner used to sit
              here, driven by the pass cookie. It was false in both halves: the
              purchase is credited to the account at checkout by
              `recordSitePurchase`, and the cookie copy was never collected by
              anything, because `claimCredits` had no callers. So it showed
              permanently to anyone who had ever paid, telling them credits they
              already held were still pending. */}

          <CreditPicker needsEntry={!hasAccess} />

          {/* ---- the other thing this site sells ---------------------------
              Credits and the 30-day pass were the only products named
              anywhere on the site. Custom-server hosting — the project's only
              recurring SKU — had its dashboard at `/admin/servers` and not one
              link to it, on this page or any other, so the only way to buy it
              was to already know the URL.

              This section describes the product and sends the reader to that
              dashboard. It does NOT start a checkout: the hosting SKU is a
              subscription with no simulated fallback, and a "Subscribe" button
              here would either duplicate the panel's own or land a customer on
              a 503 from a page that never explained what they were buying. The
              subscribe control stays where the entitlement it grants is
              visible. */}
          <section className="panel" style={{ marginTop: 34 }}>
            <h3>Host a custom server</h3>
            <p>
              Your own lore, quests and marketplace items, played by the people you
              invite. Everything earned inside one stays inside it: server credits are a
              separate balance that cannot reach your main one, and the shared
              leaderboards rank platform content only. Hosting is billed monthly, and
              you can set it up — or cancel it — from your servers dashboard.
            </p>
            {stripeConfigured() ? null : (
              <p style={{ color: '#ffdca6', fontSize: '0.86rem', margin: '0 0 22px' }}>
                Subscriptions are unavailable in this environment: unlike credits, hosting
                has no simulated checkout, so the dashboard will tell you Stripe is not
                configured rather than pretend to take a payment.
              </p>
            )}
            <Link href="/admin/servers" className="btn btn-ghost">
              Your servers
            </Link>
          </section>
        </div>
      </section>
    </main>
  );
}
