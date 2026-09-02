'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * A reference the customer has to get out of the page intact.
 *
 * `/order/failed` is the screen a charged customer lands on when provisioning
 * broke, and the only thing on it that matters is the Stripe session id. That
 * id is long, mixed-case and easy to truncate by hand, so it gets a button —
 * and it stays selectable text as well, because a copy button that silently
 * fails (permissions, an insecure origin, an old browser) with nothing behind
 * it is worse than no button.
 *
 * The confirmation is `role="status"`, so a screen-reader user is told the copy
 * happened rather than being left to guess at a button that looks the same.
 *
 * ── Why it takes a label and children ─────────────────────────────────────
 *
 * The second caller is the 2FA recovery-code panel on `/account`, where the
 * same problem is sharper: eight codes shown exactly once, which the server
 * genuinely cannot reissue because it stores only their HMACs. That wants the
 * identical "copy it, and also leave it selectable" behaviour over a different
 * shape — a list rather than one id — so `children` overrides what is DRAWN
 * while `value` stays what is COPIED. Both props default to the `/order/failed`
 * wording, so that page is untouched by this.
 */
export default function CopyableReference({
  value,
  label = 'Your reference',
  buttonLabel = 'Copy reference',
  children,
}: {
  /** What lands on the clipboard. Newlines are fine — one code per line. */
  value: string;
  label?: string;
  buttonLabel?: string;
  /** Rendered in place of the default single-line `<code>`, if given. */
  children?: React.ReactNode;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  async function copy() {
    if (timer.current) clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
    timer.current = setTimeout(() => setState('idle'), 4000);
  }

  return (
    <div className="ref-block">
      <span className="ref-label">{label}</span>
      {children ?? <code className="ref-value">{value}</code>}
      <div className="ref-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy()}>
          {buttonLabel}
        </button>
        <span role="status" className="ref-status">
          {state === 'copied' ? 'Copied to your clipboard.' : null}
          {state === 'failed' ? 'Could not copy — select the text above instead.' : null}
        </span>
      </div>
    </div>
  );
}
