'use client';

import { useState, type ReactNode } from 'react';

/**
 * A destructive server action behind a typed-name confirmation.
 *
 * ── Why a typed phrase and not a `confirm()` ────────────────────────────────
 *
 * Two actions in this console were one click from irreversible. "Delete quest"
 * removed an authored quest — its steps, its rewards, its place in a line —
 * with no step in between, and the codes page's claw-back ended access for
 * every redeemer of a code while its own file comment claimed the claw-back was
 * "a separate, counted, CONFIRMED action". The count was on the button; the
 * confirmation was not in the markup at all.
 *
 * A browser `confirm()` would be a dialog you dismiss by reflex, and it is not
 * available during a form submit in a server-action flow anyway. Typing the
 * thing's own name is the pattern `site/components/ServerAdminPanel.tsx` uses
 * for deleting a server, and it works because it cannot be satisfied by
 * muscle memory: the operator has to read what they are about to destroy in
 * order to name it.
 *
 * The button stays disabled until the phrase matches, so the guard is not a
 * warning that can be clicked past — it is the submit itself.
 *
 * The action arrives as a prop. Server actions are passed to client components
 * by reference, so the delete still runs on the server, still re-checks the
 * session, and still writes the audit row; only the confirmation is on the
 * client, which is the only place a keystroke exists.
 */
export default function ConfirmedAction({
  action,
  phrase,
  prompt,
  warning,
  submitLabel,
  children,
}: {
  /** The server action to run once the phrase is typed. */
  action: (formData: FormData) => void | Promise<void>;
  /** What the operator must type — the name of the thing being destroyed. */
  phrase: string;
  /** The label above the input, e.g. "Type the quest title to confirm". */
  prompt: string;
  /** What this action does and what it cannot undo. */
  warning: ReactNode;
  /** The button text. */
  submitLabel: string;
  /** Hidden inputs carrying the ids the action needs. */
  children?: ReactNode;
}) {
  const [typed, setTyped] = useState('');
  const armed = typed.trim() === phrase.trim();
  const inputId = `confirm-${phrase.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;

  return (
    <form action={action} style={{ display: 'grid', gap: 8, maxWidth: 460 }}>
      {children}
      <div style={{ fontSize: 12, color: 'var(--txt-2)' }}>{warning}</div>
      <label className="form-label" htmlFor={inputId}>{prompt}</label>
      <input
        id={inputId}
        autoComplete="off"
        placeholder={phrase}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
      />
      <div>
        <button type="submit" className="btn btn-danger" disabled={!armed}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
