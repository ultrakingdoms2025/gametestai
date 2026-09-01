'use client';

import { useState } from 'react';

type State =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'ok'; message: string; restored: boolean }
  | { kind: 'error'; message: string; signedOut?: boolean };

/**
 * ── The email field is gone, because it had stopped meaning anything ──────
 *
 * This form used to collect an address and POST it as `{ email }`, and the page
 * around it explained that the address was "the lookup key into Stripe" and
 * might differ from the account address. That was true of the old route. It is
 * not true of this one: `/api/restore` is `export async function POST()` — it
 * takes no request argument at all, reads the signed-in user's address out of
 * the DATABASE, and looks Stripe up by that. The posted address was read by
 * nothing.
 *
 * A field that does not affect the result is worse than no field. It says "the
 * address you type decides what is found", so a customer who typed the receipt
 * address and got "no purchases outstanding" would conclude their receipt
 * address was wrong — when the actual reason is that their ACCOUNT address is
 * the one being searched, which is a different problem with a different fix.
 *
 * So the form now states what will be searched instead of asking for it. The
 * mismatch case — paid with one address, signed in under another — is real, and
 * it is handled by saying so in the copy and pointing at the one route that can
 * settle it, rather than by a box that pretends to.
 */
export default function RestoreForm({
  disabled,
  accountEmail,
}: {
  disabled: boolean;
  /** The address the lookup will actually use. Named so the customer can see
   *  at a glance whether it is the one on their receipt. */
  accountEmail?: string | null;
}) {
  const [state, setState] = useState<State>({ kind: 'idle' });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState({ kind: 'busy' });
    try {
      /* No body. The route parses none, and sending one would only re-create
       * the impression that this form's contents steer the result. */
      const res = await fetch('/api/restore', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setState({
          kind: 'error',
          message: data.error || 'Could not check your account.',
          /* A session that expired while this page sat open. Worth its own
           * branch: "Sign in first" with no way to do so is a dead end. */
          signedOut: res.status === 401,
        });
        return;
      }
      setState({ kind: 'ok', message: data.message, restored: !!data.restored });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Could not check your account.',
      });
    }
  }

  return (
    <form onSubmit={submit}>
      <p className="note" style={{ marginTop: 0 }}>
        This searches Stripe for completed payments made with{' '}
        <strong>{accountEmail ?? 'the address on your account'}</strong> — the address on
        the account you are signed in to — and puts anything outstanding onto it.
      </p>

      <div className="actions" style={{ marginTop: 20 }}>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={disabled || state.kind === 'busy'}
        >
          {state.kind === 'busy' ? 'Checking…' : 'Restore my purchases'}
        </button>
      </div>

      {state.kind === 'ok' ? (
        <p
          className="note"
          role="status"
          style={{ color: state.restored ? 'var(--lime)' : 'var(--txt-2)' }}
        >
          {state.message}
          {state.restored ? (
            <>
              {' '}
              <a href="/play">Enter the game →</a>
            </>
          ) : null}
        </p>
      ) : null}

      {state.kind === 'error' ? (
        <p className="note" role="alert" style={{ color: 'var(--red)' }}>
          {state.message}
          {state.signedOut ? (
            <>
              {' '}
              <a href="/login?callbackUrl=%2Frestore">Sign in again →</a>
            </>
          ) : null}
        </p>
      ) : null}
    </form>
  );
}
