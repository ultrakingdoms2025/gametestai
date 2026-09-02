import Link from 'next/link';
import { redirect } from 'next/navigation';
import RestoreForm from '@/components/RestoreForm';
import { auth } from '@/lib/auth';
import { stripeConfigured } from '@/lib/stripe';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Restore a purchase — AETHER NEXUS',
  description:
    'Paid and never got in? Sign in and put the purchase back on your account.',
  alternates: { canonical: '/restore' },
};

/**
 * Recover a purchase that never landed.
 *
 * ── Why this page now requires a sign-in ──────────────────────────────────
 *
 * It used to tell the reader that "your access is held on this browser rather
 * than in an account", and that "accounts are coming; when they arrive this
 * page goes away". Accounts shipped. Every word of that paragraph became false
 * on the day they did, and it was the paragraph a customer read while trying to
 * work out where their money had gone.
 *
 * The restore itself now settles onto the signed-in account rather than onto a
 * cookie, so there has to BE a signed-in account before the form is worth
 * showing. A signed-out visitor is sent to sign in and brought straight back
 * rather than being given a form whose result would have nowhere to land.
 *
 * ── Why the email field is gone ───────────────────────────────────────────
 *
 * This page used to say the address you typed was the lookup key into Stripe,
 * and that it might legitimately differ from your account address. That was
 * true of the route it was written against. `/api/restore` now takes no body at
 * all — it reads the signed-in user's address from the database and searches
 * Stripe by that — so the field steered nothing and the paragraph explaining it
 * was instructing customers about a mechanism that no longer existed.
 *
 * The case it described is still real: a card can be used with a work address,
 * a partner's, an old one. It just cannot be solved here any more, because
 * granting on the strength of a typed address is exactly the unauthenticated
 * form that was removed. So the page names the address it WILL search and sends
 * the mismatch case to the one route that can settle it — a human, from the
 * receipt.
 */
export default async function Restore() {
  const session = await auth();
  if (!session?.user?.id) redirect('/login?callbackUrl=%2Frestore');

  return (
    <main id="main" tabIndex={-1}>
      <section style={{ paddingTop: 56, borderBottom: 0 }}>
        <div className="wrap" style={{ maxWidth: 620 }}>
          <div className="head">
            <div className="eyebrow">
              <Link href="/" style={{ textDecoration: 'none' }}>
                ← Aether Nexus
              </Link>
            </div>
            <h1>Restore a purchase</h1>
            <p>
              Paid and never got in? It happens when the tab closes before the payment
              finishes coming back. Every completed purchase made with{' '}
              <strong>{session.user.email ?? 'your account address'}</strong> — the account
              you are signed in to now — is put back onto it. There is nothing to fill in.
            </p>
          </div>

          {!stripeConfigured() ? (
            <div className="banner" role="status">
              <b>Test mode</b>
              <span>
                Checkout is simulated on this deployment, so there are no real payments
                to look up. This page starts working the moment Stripe keys are set.
              </span>
            </div>
          ) : null}

          <div className="panel">
            <RestoreForm disabled={!stripeConfigured()} accountEmail={session.user.email} />
            <p className="note">
              Anything already on this account is left alone rather than granted twice, so
              this is safe to press more than once.
            </p>
            <p className="note">
              <strong>Paid with a different email?</strong> A card is often used with a
              work address, a partner&rsquo;s, or an old one, and a purchase made under an
              address that is not this account&rsquo;s will not be found here — granting on
              the strength of a typed-in address is what this page deliberately stopped
              doing. That one we settle by hand:{' '}
              <Link href="/order/failed">start here</Link> with the receipt.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
