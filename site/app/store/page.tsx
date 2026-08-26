import Link from 'next/link';
import CreditPicker from '@/components/CreditPicker';
import HostingSubscribeButton from '@/components/HostingSubscribeButton';
import { getCurrentAccessState } from '@/lib/access';
import { SERVER_HOSTING_SKU, quoteServerHosting } from '@/lib/premium';
import { stripeConfigured } from '@/lib/stripe';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Buy credits — AETHER NEXUS' };

export default async function Store() {
  const { hasAccess } = await getCurrentAccessState();
  /* Quoted on the server, from the same module the checkout route quotes from,
   * so the price on the button is the price that is charged. */
  const hosting = quoteServerHosting();

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

              This section used to describe the product and only link to that
              dashboard, on the reasoning that hosting had no simulated checkout
              and a Subscribe button here would land the customer on a 503. That
              reasoning died with the 503 (see `premium.ts`, "Simulated
              purchase"): the SKU is now buyable on the same switch as credits,
              so the store sells it like the store sells everything else.

              The button is the SAME component the dashboard uses, not a second
              one — see `HostingSubscribeButton` for why that matters. */}
          <section className="panel" style={{ marginTop: 34 }}>
            <h3>Host a custom server</h3>
            <p>
              Your own lore, quests and marketplace items, played by the people you
              invite. Everything earned inside one stays inside it: server credits are a
              separate balance that cannot reach your main one, and the shared
              leaderboards rank platform content only. Billed monthly, cancellable from
              your servers dashboard.
            </p>
            <p className="note" style={{ margin: '0 0 18px' }}>
              After you subscribe you land on your servers dashboard, which is where you
              name the server and invite the players you want in it.
            </p>
            {stripeConfigured() ? null : (
              <p style={{ color: '#ffdca6', fontSize: '0.86rem', margin: '0 0 18px' }}>
                <b>Test mode.</b> No card is taken and nothing reaches Stripe. You get a
                working subscription so the server can be set up and played, clearly
                marked as simulated in your dashboard and in our records, and it will be
                cleared when real billing goes live.
              </p>
            )}
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <HostingSubscribeButton
                intent={SERVER_HOSTING_SKU}
                detail={hosting.detail}
                callbackUrl="/store"
                className="btn btn-amber"
              />
              <Link href="/admin/servers" className="btn btn-ghost">
                Your servers
              </Link>
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}
