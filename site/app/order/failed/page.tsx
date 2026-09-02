import Link from 'next/link';
import type { Metadata } from 'next';
import CopyableReference from '@/components/CopyableReference';
import { SUPPORT_EMAIL, supportMailto } from '@/components/support';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Payment received, access not set up — AETHER NEXUS',
  description:
    'Your payment reached Stripe but the access it buys was not written to your '
    + 'account. What happened, and what we do about it.',
  robots: { index: false, follow: false },
};

/**
 * The worst customer experience the audit found, given a page.
 *
 * ── What this page is for ─────────────────────────────────────────────────
 *
 * Money left the customer's card and the thing they bought did not arrive. That
 * is the one failure where silence is indistinguishable from theft, and until
 * now the code had nowhere to send them: `/api/confirm` could only redirect to
 * `/?error=...` on a page that read no parameters at all.
 *
 * ── The rules the copy follows ────────────────────────────────────────────
 *
 * 1. Say what happened, in the order it happened, using the words for the two
 *    different things: the PAYMENT succeeded, the PROVISIONING failed. A
 *    customer who cannot tell those apart cannot tell whether to buy again.
 * 2. Tell them not to buy again, explicitly, before offering any button. The
 *    instinct on a failed purchase is to retry, and here retrying is a second
 *    charge for the same thing.
 * 3. Offer the refund unprompted. Somebody who has been charged for nothing
 *    should not have to ask whether asking is allowed.
 * 4. No apology standing in for information. "Sorry for the inconvenience"
 *    where a reference number belongs is filler.
 *
 * ── `?code=` is the fifth rule, and it is the one that was missing ────────
 *
 * `/api/confirm` sends BOTH `ref` and `code`, and the two codes it can send
 * describe genuinely different situations that this page was flattening into
 * one:
 *
 *   - `not-signed-in` — the payment is real and there was no account to put it
 *     on. Nothing is broken. The customer can finish this themselves in about a
 *     minute by signing in and pressing Restore, and telling them to wait for
 *     support instead would be making them wait for nothing.
 *   - `provisioning-failed` — the payment is real, an account was identified,
 *     and the write failed. The customer can do nothing about that, and the
 *     honest thing is to say so, say what WE do about it (the webhook is the
 *     automatic retry), and not send them round a Restore loop that is going to
 *     hit the same broken write.
 *
 * An absent or unrecognised code falls back to the general copy — the page must
 * still work when it is reached from a bookmark, an old link, or a future code
 * this build has never heard of.
 *
 * ── Not indexed ───────────────────────────────────────────────────────────
 *
 * `robots: noindex` above: a page about a failed payment carrying a live
 * reference in its URL has no business in a search index.
 */

/** Kept in step with `ProvisionFailure` in `app/api/confirm/route.ts`. */
type FailureCode = 'not-signed-in' | 'provisioning-failed';

function isFailureCode(v: unknown): v is FailureCode {
  return v === 'not-signed-in' || v === 'provisioning-failed';
}

export default async function OrderFailed(props: {
  searchParams: Promise<{ [k: string]: string | string[] | undefined }>;
}) {
  const sp = await props.searchParams;
  const raw = typeof sp.ref === 'string' ? sp.ref : null;
  /* Bounded and character-limited before it is rendered or put in a mailto:
   * this value arrives on a URL, and a Stripe session id is `cs_` plus
   * alphanumerics and underscores. Anything else is not a reference. */
  const reference =
    raw && /^[A-Za-z0-9_-]{1,128}$/.test(raw) ? raw : null;

  /* Checked against the closed set rather than echoed. It arrives on a URL like
   * the reference does, and an unknown value is treated as no value. */
  const code: FailureCode | null = isFailureCode(sp.code) ? sp.code : null;

  const mailto = supportMailto(
    'Aether Nexus — paid, but access was not set up',
    (reference ? `My reference is ${reference}.\n\n` : '')
    + (code ? `The page said: ${code}.\n\n` : '')
    + 'I was charged and my access has not appeared.\n\n'
    + 'The email I paid with:\n'
    + 'Roughly when I paid:\n'
  );

  return (
    <main id="main" tabIndex={-1}>
      <section style={{ paddingTop: 56, borderBottom: 0 }}>
        <div className="wrap" style={{ maxWidth: 680 }}>
          <div className="head">
            <div className="eyebrow">
              <Link href="/" style={{ textDecoration: 'none' }}>
                ← Aether Nexus
              </Link>
            </div>
            <h1>Your payment went through. Your access did not.</h1>
            {code === 'not-signed-in' ? (
              <p>
                Two things happen when you buy: Stripe takes the payment, then we write
                the access onto your account. The first one worked. The second one had
                nowhere to go — <strong>you were not signed in when the payment came
                back</strong>, so there was no account to put the access on. Your payment
                is safe and nothing is broken; it just is not attached to anybody yet.
              </p>
            ) : code === 'provisioning-failed' ? (
              <p>
                Two things happen when you buy: Stripe takes the payment, then we write
                the access onto your account. The first one worked. The second one{' '}
                <strong>failed on our side</strong> — we know which account it was for and
                the write did not go through. That is our fault and not something you can
                fix from here.
              </p>
            ) : (
              <p>
                Two things happen when you buy: Stripe takes the payment, then we write
                the access onto your account. The first one worked. The second one
                failed, which is why there is nothing in the game yet.
              </p>
            )}
          </div>

          <div className="banner banner-error" role="alert">
            <b>Do not pay again</b>
            <div className="banner-body">
              <span>
                Buying a second time would be a second charge for the same thing. The
                payment you have already made is the one we will honour.
              </span>
            </div>
          </div>

          <div className="panel">
            {reference ? (
              <>
                <CopyableReference value={reference} />
                <p className="note" style={{ marginTop: 14 }}>
                  That is the id of your checkout with Stripe. We can find your payment
                  by it, which is the whole reason this page shows it to you.
                </p>
              </>
            ) : (
              <div className="ref-block">
                <span className="ref-label">No reference on this link</span>
                <p style={{ margin: 0, color: 'var(--txt-2)' }}>
                  This page was opened without one. Your payment still exists — Stripe
                  emails a receipt to the address you paid with, and the id on that
                  receipt does the same job. Send us the receipt itself if it is easier.
                </p>
              </div>
            )}

            <h2 style={{ marginTop: 26 }}>What happens next</h2>

            {code === 'not-signed-in' ? (
              /* The one recoverable case, so the self-service route comes FIRST
               * and support is the fallback rather than the other way round.
               * `/api/restore` looks the purchase up by the signed-in account's
               * own address, which is why step 1 has to name which address. */
              <>
                <p className="note" style={{ marginTop: 0 }}>
                  You can almost certainly finish this yourself, right now.
                </p>
                <ol style={{ color: 'var(--txt-2)', paddingLeft: 20, display: 'grid', gap: 8 }}>
                  <li>
                    Sign in — or create an account — using{' '}
                    <strong>the same email address you paid with</strong>. That address is
                    on the Stripe receipt in your inbox.
                  </li>
                  <li>
                    Open <Link href="/restore">Restore a purchase</Link> and press Restore.
                    It looks up completed payments made with your account&rsquo;s address
                    and puts them on your account. Nothing is granted twice.
                  </li>
                  <li>
                    If your account uses a different address from the receipt, Restore will
                    not find it — that one we have to settle by hand. Send us the reference
                    {reference ? ' above' : ''} and the address you paid with.
                  </li>
                </ol>
                <div className="actions" style={{ marginTop: 22 }}>
                  <Link className="btn btn-primary" href="/login?callbackUrl=%2Frestore">
                    Sign in and restore
                  </Link>
                  <a className="btn btn-ghost" href={mailto}>
                    Email support instead
                  </a>
                </div>
              </>
            ) : code === 'provisioning-failed' ? (
              /* Not recoverable by the customer. Restore would re-run the same
               * write that has just failed, so it is not offered as the first
               * move — being sent round a loop that cannot work is worse than
               * being told to wait. */
              <>
                <p className="note" style={{ marginTop: 0 }}>
                  There is a good chance this is already fixed: payments are settled a
                  second time from Stripe&rsquo;s own notification a few moments later, and
                  that retry does not depend on your browser.
                </p>
                <ol style={{ color: 'var(--txt-2)', paddingLeft: 20, display: 'grid', gap: 8 }}>
                  <li>
                    Check <Link href="/account">your account</Link> in a few minutes. If the
                    access is there, the retry worked and there is nothing left to do.
                  </li>
                  <li>
                    If it is still missing, send us the reference{reference ? ' above' : ''}{' '}
                    and the email address you paid with. We match it to the payment in
                    Stripe and write the access by hand.
                  </li>
                  <li>
                    If you would rather have the money back than the access, say so in the
                    same message and we will refund it in full. You do not need a reason.
                  </li>
                </ol>
                <div className="actions" style={{ marginTop: 22 }}>
                  <a className="btn btn-primary" href={mailto}>
                    Email support
                  </a>
                  <Link className="btn btn-ghost" href="/account">
                    Check your account
                  </Link>
                </div>
              </>
            ) : (
              <>
                <ol style={{ color: 'var(--txt-2)', paddingLeft: 20, display: 'grid', gap: 8 }}>
                  <li>
                    Send us the reference{reference ? ' above' : ''} and the email address you
                    paid with.
                  </li>
                  <li>
                    We match it to the payment in Stripe and put the access on your account by
                    hand. There is nothing else for you to do.
                  </li>
                  <li>
                    If you would rather have the money back than the access, say so in the same
                    message and we will refund it in full. You do not need a reason.
                  </li>
                </ol>
                <div className="actions" style={{ marginTop: 22 }}>
                  <a className="btn btn-primary" href={mailto}>
                    Email support
                  </a>
                  <Link className="btn btn-ghost" href="/account">
                    Check your account
                  </Link>
                </div>
              </>
            )}

            <p className="note">
              Support is <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. If your
              access appears on your own before we answer, the payment settled late and
              there is nothing left to fix — you can{' '}
              <Link href="/play">go straight in</Link>. A purchase that reached Stripe but
              never reached this browser can also be pulled back with{' '}
              <Link href="/restore">Restore a purchase</Link>.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
