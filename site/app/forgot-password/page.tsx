'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [pending, startTransition] = useTransition();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    startTransition(async () => {
      try {
        const res = await fetch('/api/auth/forgot-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setError(data.error ?? 'Something went wrong.');
          return;
        }
        setSent(true);
      } catch {
        setError('Something went wrong. Please try again.');
      }
    });
  }

  return (
    <main id="main" tabIndex={-1} className="auth-shell">
      <div className="auth-card">
        <Link href="/" className="auth-logo">AETHER NEXUS</Link>
        <h1 className="auth-heading">Reset password</h1>

        {sent ? (
          <div className="auth-success" role="status">
            If that email is registered, you&apos;ll receive a reset link shortly.
            Check your spam folder if it doesn&apos;t arrive within a few minutes.
          </div>
        ) : (
          <>
            {error ? <div className="auth-error" role="alert">{error}</div> : null}
            <p className="auth-desc">
              Enter your email and we&apos;ll send you a link to set a new password.
            </p>
            <form onSubmit={handleSubmit} className="auth-form">
              <label className="auth-label" htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                className="auth-input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                placeholder="you@example.com"
              />
              <button type="submit" className="btn btn-primary auth-submit" disabled={pending}>
                {pending ? 'Sending…' : 'Send reset link'}
              </button>
            </form>
          </>
        )}

        <p className="auth-footer">
          <Link href="/login" className="auth-link">Back to sign in</Link>
        </p>
      </div>
    </main>
  );
}
