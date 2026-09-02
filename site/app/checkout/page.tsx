import Link from 'next/link';
import PayButton from '@/components/PayButton';
import { getCurrentAccessState } from '@/lib/access';
import {
  clampCredits,
  feeLabel,
  formatCents,
  quoteCredits,
  quoteEntry,
  quoteEntryWithCredits,
} from '@/lib/pricing';
import { stripeConfigured } from '@/lib/stripe';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Checkout — AETHER NEXUS',
  alternates: { canonical: '/checkout' },
  /* A checkout is a step, not a destination, and the totals on it depend on
   * query parameters. Nothing here belongs in a search index. */
  robots: { index: false, follow: true },
};

/**
 * The order confirmation.
 *
 * `searchParams` is awaited: in Next 16 it is a Promise, and synchronous access
 * was removed rather than deprecated. Reading it on the server also means the
 * page needs no `useSearchParams`, which would force the whole route into a
 * client-side bail-out behind a Suspense boundary for no gain.
 *
 * The quote is recomputed here from the URL rather than carried from the
 * previous page, and recomputed *again* in the route handler before a charge is
 * created. A total that travelled through a browser is a suggestion.
 */
export default async function Checkout(props: {
  searchParams: Promise<{ [k: string]: string | string[] | undefined }>;
}) {
  const sp = await props.searchParams;
  const intentRaw = typeof sp.intent === 'string' ? sp.intent : 'entry';
  const creditsRaw = typeof sp.credits === 'string' ? sp.credits : '0';

  const { hasAccess } = await getCurrentAccessState();

  const intent = intentRaw === 'credits' && hasAccess ? 'credits'
    : intentRaw === 'credits' || intentRaw === 'entry+credits'
      ? (hasAccess ? 'credits' : 'entry+credits')
      : hasAccess ? 'credits' : 'entry';

  const credits = intent === 'entry' ? 0 : clampCredits(creditsRaw);
  const quote = intent === 'entry'
    ? quoteEntry()
    : intent === 'credits'
      ? quoteCredits(credits)
      : quoteEntryWithCredits(credits);

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
            <h1>Checkout</h1>
          </div>

          {!stripeConfigured() ? (
            <div className="banner" role="status">
              <b>Test mode</b>
              <span>
                No card will be taken and nothing will be sent to Stripe. Confirming
                completes the flow exactly as a real payment would, so the screens after
                this are the real ones.
              </span>
            </div>
          ) : null}

          <div className="panel">
            <h2>Order</h2>
            <div className="receipt">
              {quote.lines.map((l) => (
                <div className="rline" key={l.label}>
                  <span>
                    {l.label}
                    {l.detail ? <em>{l.detail}</em> : null}
                  </span>
                  <span>{formatCents(l.cents)}</span>
                </div>
              ))}
              <div className="rline fee">
                <span>
                  {feeLabel()}
                  <em>Added so the listed prices are what reaches the developer</em>
                </span>
                <span>{formatCents(quote.feeCents)}</span>
              </div>
            </div>

            <div className="rtotal">
              <span>Total</span>
              <b>{formatCents(quote.totalCents)}</b>
            </div>

            <div className="actions" style={{ marginTop: 24 }}>
              <PayButton
                intent={intent}
                credits={credits}
                label={`Pay ${formatCents(quote.totalCents)}`}
              />
              <Link className="btn btn-ghost" href={intent === 'entry' ? '/' : '/store'}>
                Back
              </Link>
            </div>

            <p className="note">
              {intent === 'entry'
                ? 'Charge for a 30-day access token on your account.'
                : intent === 'credits'
                  ? 'Credits are added to your balance as soon as payment clears.'
                  : 'Includes a 30-day access token and your credits on one charge, so you pay the fixed processing fee once rather than twice.'}
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
