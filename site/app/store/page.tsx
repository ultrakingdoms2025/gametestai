import Link from 'next/link';
import CreditPicker from '@/components/CreditPicker';
import { getCurrentAccessState } from '@/lib/access';
import { readPass } from '@/lib/entitlement';
import { stripeConfigured } from '@/lib/stripe';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Buy credits — AETHER NEXUS' };

export default async function Store() {
  const { hasAccess } = await getCurrentAccessState();
  const pass = await readPass();

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

          {pass && pass.credits > 0 ? (
            <div className="banner" role="status" style={{ borderColor: 'rgba(82,233,255,0.4)', background: 'rgba(10,40,55,0.4)', color: '#cfe6f2' }}>
              <b>Waiting</b>
              <span>
                You have <strong>{pass.credits.toLocaleString('en-US')}</strong> credits
                bought and not yet collected. They are added to your balance the next time
                you enter the game.
              </span>
            </div>
          ) : null}

          <CreditPicker needsEntry={!hasAccess} />
        </div>
      </section>
    </main>
  );
}
