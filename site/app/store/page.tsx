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
        </div>
      </section>
    </main>
  );
}
