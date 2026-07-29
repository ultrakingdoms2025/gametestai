'use client';

import { useState } from 'react';

type State =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'ok'; message: string; restored: boolean }
  | { kind: 'error'; message: string };

export default function RestoreForm({ disabled }: { disabled: boolean }) {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<State>({ kind: 'idle' });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState({ kind: 'busy' });
    try {
      const res = await fetch('/api/restore', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not check that address.');
      setState({ kind: 'ok', message: data.message, restored: !!data.restored });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Could not check that address.',
      });
    }
  }

  return (
    <form onSubmit={submit}>
      <label className="field" htmlFor="email">
        Email used at checkout
      </label>
      <div className="qty-row">
        <input
          id="email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(ev) => setEmail(ev.target.value)}
          disabled={disabled || state.kind === 'busy'}
          style={{
            flex: '1 1 240px',
            padding: '12px 14px',
            fontSize: '1rem',
            fontWeight: 500,
            color: '#eaf8ff',
            background: 'rgba(4, 8, 14, 0.8)',
            border: '1px solid var(--rule)',
            clipPath: 'var(--clip-sm)',
          }}
        />
      </div>

      <div className="actions" style={{ marginTop: 20 }}>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={disabled || state.kind === 'busy' || !email}
        >
          {state.kind === 'busy' ? 'Checking…' : 'Restore'}
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
        </p>
      ) : null}
    </form>
  );
}
