'use client';

import { useState } from 'react';

/**
 * Starts a checkout.
 *
 * Deliberately thin: it sends the *intent* and the quantity, never a price. The
 * server quotes the order itself, so a total edited in devtools changes nothing
 * except what this button says before it is pressed.
 */
export default function PayButton({
  intent,
  credits,
  label,
}: {
  intent: string;
  credits: number;
  label: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ intent, credits }),
      });
      const data = await res.json();
      if (!res.ok || !data.url) throw new Error(data.error || 'Could not start checkout.');
      window.location.href = data.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start checkout.');
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="btn btn-primary" onClick={go} disabled={busy}>
        {busy ? 'Starting…' : label}
      </button>
      {error ? (
        <span className="btn-note" style={{ color: 'var(--red)' }} role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}
