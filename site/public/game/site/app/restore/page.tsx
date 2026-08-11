import Link from 'next/link';
import RestoreForm from '@/components/RestoreForm';
import { stripeConfigured } from '@/lib/stripe';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Restore a purchase — AETHER NEXUS' };

export default function Restore() {
  return (
    <main>
      <section style={{ paddingTop: 56, borderBottom: 0 }}>
        <div className="wrap" style={{ maxWidth: 620 }}>
          <div className="head">
            <div className="eyebrow">
              <Link href="/" style={{ textDecoration: 'none' }}>
                ← Aether Nexus
              </Link>
            </div>
            <h2>Restore a purchase</h2>
            <p>
              Paid and did not get in? It happens if the tab closes before you are sent
              back. Give the email you paid with and everything bought under it will be
              put back on this browser.
            </p>
          </div>

          {!stripeConfigured() ? (
            <div className="banner" role="status">
              <b>Test mode</b>
              <span>
                Checkout is simulated, so there are no real purchases to restore yet.
                This page starts working the moment Stripe keys are set.
              </span>
            </div>
          ) : null}

          <div className="panel">
            <RestoreForm disabled={!stripeConfigured()} />
            <p className="note">
              Your access is held on this browser rather than in an account, so it does
              not follow you to another device — this is how you move it. Accounts are
              coming; when they arrive this page goes away and signing in does the job.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
