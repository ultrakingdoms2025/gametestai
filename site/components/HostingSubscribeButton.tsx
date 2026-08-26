'use client';

import { useState, type CSSProperties } from 'react';

/**
 * The one control that buys custom-server hosting.
 *
 * ── Why this is a component and not two buttons ───────────────────────────
 *
 * There was one, inside `ServerAdminPanel`, on a dashboard nothing linked to —
 * so the only way to buy the product was to already know the URL. `/store`
 * described hosting in prose and sent the reader to that dashboard instead of
 * selling it, which is what the owner could not find.
 *
 * The fix is one control used in both places, not a second one written for the
 * store. Two buttons posting the same intent drift: one gets the 401 handling,
 * the other keeps the raw error, and the one that drifts is the one nobody
 * re-reads. The store and the panel differ only in skin, which is what
 * `className` and `style` are for.
 *
 * ── The intent string is a prop ───────────────────────────────────────────
 *
 * `SERVER_HOSTING_SKU` lives in `premium.ts`, which imports the Stripe SDK and
 * `pg` types. Importing it here would drag the server's payment module into the
 * browser bundle, so the SKU arrives as a prop from the server instead: the
 * store page passes the constant directly, and the panel passes `sku.intent`
 * from `/api/servers`. Neither hard-codes the string.
 */
export default function HostingSubscribeButton(props: {
  /** The SKU to buy — `SERVER_HOSTING_SKU`, supplied by the server. */
  intent: string;
  /** The price line, e.g. "$5.20 per month, per server — includes processing". */
  detail: string;
  /**
   * The verb on the button. Defaults to "Subscribe"; the servers dashboard
   * passes "Add another server" when the same checkout is buying an ADDITIONAL
   * slot — same control, same intent, same flow, different sentence, because
   * the price is per server and the button must say what this click buys.
   */
  caption?: string;
  /** Where to come back to after signing in, if the visitor is not signed in. */
  callbackUrl?: string;
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
}) {
  const {
    intent, detail, caption = 'Subscribe', callbackUrl = '/store', className, style, disabled,
  } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function subscribe() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ intent }),
      });
      /* Signing in is a step, not a failure. `/api/checkout` refuses this SKU
       * with a 401 before it mints anything, and telling a visitor "Sign in
       * first." next to a button that then does nothing is a dead end. */
      if (res.status === 401) {
        window.location.href = `/login?callbackUrl=${encodeURIComponent(callbackUrl)}`;
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) throw new Error(data.error || 'Could not start checkout.');
      window.location.href = data.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start checkout.');
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        className={className}
        style={style}
        disabled={busy || disabled}
        onClick={() => void subscribe()}
      >
        {busy ? 'Starting…' : `${caption} — ${detail}`}
      </button>
      {error ? (
        <p role="alert" style={{ color: '#ffb4b4', fontSize: '0.86rem', margin: '10px 0 0' }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
