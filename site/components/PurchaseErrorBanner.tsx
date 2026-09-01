import Link from 'next/link';
import { SUPPORT_EMAIL, supportMailto } from './support';

/**
 * The `?error=` codes, rendered.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * `/api/confirm` refuses in five different ways and every one of them redirects
 * to `/?error=<code>`; `simulatedHostingGrant` refuses in three more and sends
 * them to `/admin/servers?error=<code>`. Neither page read the parameter, so
 * every one of those eight failures rendered as an ordinary page load — a
 * customer who had just been through checkout was returned to the marketing
 * site with no explanation and no next step, which reads as "it worked" until
 * they try to play.
 *
 * ── What each entry has to carry ──────────────────────────────────────────
 *
 * A plain-language sentence about what happened, an explicit statement about
 * their money where money is in question, and one obvious next action. A code
 * this map does not know still renders — the unknown branch says so honestly
 * rather than swallowing the parameter, because an unrecognised code is itself
 * a fault worth showing.
 */

type Action = { label: string; href: string };
type Entry = {
  headline: string;
  /** What happened, in the customer's terms. */
  body: string;
  /** Built per render so the reference, when there is one, lands in the mailto. */
  actions: (ref: string | null) => Action[];
};

const supportAction = (subject: string, ref: string | null): Action => ({
  label: ref ? 'Contact support with this reference' : 'Contact support',
  href: supportMailto(
    subject,
    ref ? `My reference is ${ref}.\n\nWhat happened:\n` : 'What happened:\n'
  ),
});

const ENTRIES: Record<string, Entry> = {
  /* ---- /api/confirm, live path ---------------------------------------- */
  unpaid: {
    headline: 'Payment not completed',
    body:
      'Stripe has your checkout session but no completed payment on it, so nothing '
      + 'was charged and nothing was unlocked. Starting again is safe.',
    actions: (ref) => [
      { label: 'Try again', href: '/checkout?intent=entry' },
      supportAction('Aether Nexus - checkout showed as unpaid', ref),
    ],
  },
  'verify-failed': {
    headline: 'We could not confirm your payment',
    body:
      'The payment may well have gone through - we could not reach Stripe to check, '
      + 'so we have not unlocked anything yet. Do not pay a second time. Send us the '
      + 'reference below and we will settle it by hand.',
    actions: (ref) => [
      supportAction('Aether Nexus - payment taken but not confirmed', ref),
      { label: 'Restore a purchase', href: '/restore' },
    ],
  },
  'no-session': {
    headline: 'That confirmation link was incomplete',
    body:
      'The link had no checkout session on it, so there is nothing to look up. That is '
      + 'what a hand-typed or truncated confirmation URL looks like, and no payment has '
      + 'been affected either way.',
    actions: () => [
      { label: 'Try again', href: '/checkout?intent=entry' },
      { label: 'Restore a purchase', href: '/restore' },
    ],
  },
  'not-configured': {
    headline: 'Payments are not switched on here',
    body:
      'This deployment has no payment keys, so a live checkout cannot be confirmed. '
      + 'Nothing was charged. If you reached this after paying somewhere else, tell us '
      + 'about it - that is a fault at our end, not yours.',
    actions: (ref) => [supportAction('Aether Nexus - payments not configured', ref)],
  },
  'simulated-disabled': {
    headline: 'Test checkout is closed',
    body:
      'Live payments are configured on this deployment, which switches the simulated '
      + 'checkout off in the same action. Nothing was charged and nothing was granted. '
      + 'Buy through the real checkout instead.',
    actions: () => [{ label: 'Go to checkout', href: '/checkout?intent=entry' }],
  },

  /* ---- simulatedHostingGrant, /admin/servers --------------------------- */
  stripe_configured: {
    headline: 'Simulated hosting is no longer available',
    body:
      'Live payments are configured, so hosting can only be bought for real now. '
      + 'Nothing was charged and no subscription was created.',
    actions: () => [{ label: 'Back to the store', href: '/store' }],
  },
  invalid: {
    headline: 'That hosting purchase could not be applied',
    body:
      'The request was missing something it needed - an account, or an order id - so no '
      + 'subscription was created and nothing was charged. Starting again from the store '
      + 'usually clears it.',
    actions: (ref) => [
      { label: 'Back to the store', href: '/store' },
      supportAction('Aether Nexus - hosting purchase could not be applied', ref),
    ],
  },
  'grant-failed': {
    headline: 'Your hosting subscription was not set up',
    body:
      'We could not write the subscription. If a payment was taken it has not been '
      + 'matched to your account yet, so do not buy again. Send us the reference and we '
      + 'will finish it by hand.',
    actions: (ref) => [
      supportAction('Aether Nexus - hosting subscription not set up', ref),
      { label: 'Back to the store', href: '/store' },
    ],
  },
};

function Actions({ actions }: { actions: Action[] }) {
  return (
    <div className="banner-actions">
      {actions.map((a) =>
        a.href.startsWith('/') ? (
          <Link key={a.href} className="btn btn-ghost btn-sm" href={a.href}>{a.label}</Link>
        ) : (
          <a key={a.href} className="btn btn-ghost btn-sm" href={a.href}>{a.label}</a>
        )
      )}
    </div>
  );
}

/**
 * @param code the raw `?error=` value; anything falsy renders nothing.
 * @param reference an order or checkout-session id to quote back, when the page has one.
 */
export default function PurchaseErrorBanner({
  code,
  reference = null,
}: {
  code?: string | string[] | null;
  reference?: string | null;
}) {
  const raw = Array.isArray(code) ? code[0] : code;
  if (!raw) return null;

  const entry = ENTRIES[raw];
  const shown = raw.slice(0, 64);

  return (
    <div className="banner banner-error" role="alert">
      <b>Problem</b>
      <div className="banner-body">
        <strong className="banner-headline">
          {entry ? entry.headline : 'Something went wrong on the way back from checkout'}
        </strong>
        <span>
          {entry ? entry.body : (
            <>
              We do not recognise the reason it gave (<code>{shown}</code>), and nothing
              has been unlocked. Send us that code and we will tell you what happened to
              your payment.
            </>
          )}
        </span>
        {reference ? (
          <span className="banner-ref">
            Reference: <code>{reference}</code>
          </span>
        ) : null}
        <Actions
          actions={
            entry
              ? entry.actions(reference)
              : [
                  supportAction(`Aether Nexus - unrecognised error "${shown}"`, reference),
                  { label: 'Try again', href: '/checkout?intent=entry' },
                ]
          }
        />
        <span className="banner-fine">
          Or write to <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
        </span>
      </div>
    </div>
  );
}
