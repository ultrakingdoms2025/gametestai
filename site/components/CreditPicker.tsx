'use client';

import { useMemo, useState } from 'react';
import {
  CREDIT_PRICE_CENTS,
  ENTRY_CENTS,
  MAX_CREDITS,
  MIN_CREDITS,
  feeLabel,
  formatCents,
  quoteCredits,
  quoteEntryWithCredits,
} from '@/lib/pricing';

const PRESETS = [10, 50, 100, 500, 1000, 10000];

/**
 * The credit store.
 *
 * The receipt is computed here *and* recomputed on the server before a charge
 * is created, from the same module. That is not redundancy for its own sake:
 * the client copy exists so the total updates as you drag the slider without a
 * round trip, and the server copy exists because a number that arrived from a
 * browser is a suggestion. They agree because there is only one implementation
 * of the arithmetic.
 */
export default function CreditPicker({ needsEntry }: { needsEntry: boolean }) {
  const [credits, setCredits] = useState(100);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const quote = useMemo(
    () => (needsEntry ? quoteEntryWithCredits(credits) : quoteCredits(credits)),
    [credits, needsEntry]
  );

  /* Clamped on commit rather than on every keystroke: clamping while typing
     means clearing the field to type "500" rewrites it to "10" after the first
     character, and the box fights you. */
  const commit = (raw: string) => {
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n)) return setCredits(MIN_CREDITS);
    setCredits(Math.min(MAX_CREDITS, Math.max(MIN_CREDITS, n)));
  };

  async function buy() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ intent: needsEntry ? 'entry+credits' : 'credits', credits }),
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
    <div className="store-grid">
      <div className="panel">
        <h3>Buy credits</h3>
        <p>
          Credits are spent in-game on ammunition, equipment and anything a merchant
          will sell you. {formatCents(CREDIT_PRICE_CENTS)} each, {MIN_CREDITS} minimum.
        </p>

        <label className="field" htmlFor="credits">
          How many
        </label>
        <div className="qty-row">
          <input
            id="credits"
            type="number"
            inputMode="numeric"
            min={MIN_CREDITS}
            max={MAX_CREDITS}
            step={1}
            value={credits}
            onChange={(e) => setCredits(Number(e.target.value))}
            onBlur={(e) => commit(e.target.value)}
          />
        </div>

        <input
          type="range"
          aria-label="Credit quantity"
          min={MIN_CREDITS}
          max={MAX_CREDITS}
          step={10}
          value={credits}
          onChange={(e) => setCredits(Number(e.target.value))}
        />

        <div className="presets">
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              className="preset"
              aria-pressed={credits === p}
              onClick={() => setCredits(p)}
            >
              {p.toLocaleString('en-US')}
            </button>
          ))}
        </div>
      </div>

      <div className="panel">
        <h3>Order</h3>
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

        <div className="actions" style={{ marginTop: 22 }}>
          <button type="button" className="btn btn-amber" onClick={buy} disabled={busy}>
            {busy ? 'Starting…' : `Pay ${formatCents(quote.totalCents)}`}
          </button>
        </div>

        {error ? (
          <p className="note" style={{ color: 'var(--red)' }} role="alert">
            {error}
          </p>
        ) : null}

        <p className="note">
          {needsEntry
            ? `Includes ${formatCents(ENTRY_CENTS)} for game access, charged once. `
            : 'You already have game access. '}
          Credits are added to your account as soon as payment clears.
        </p>
      </div>
    </div>
  );
}
