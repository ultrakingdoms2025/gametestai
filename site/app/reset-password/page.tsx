'use client';

import Link from 'next/link';
import { useState, useTransition, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    startTransition(async () => {
      try {
        const res = await fetch('/api/auth/reset-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, password }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? 'Something went wrong.');
          return;
        }
        setDone(true);
        setTimeout(() => router.push('/login'), 2500);
      } catch {
        setError('Something went wrong. Please try again.');
      }
    });
  }

  if (!token) {
    return (
      <div className="auth-card">
        <Link href="/" className="auth-logo">AETHER NEXUS</Link>
        <div className="auth-error">Invalid reset link. Please request a new one.</div>
        <p className="auth-footer">
          <Link href="/forgot-password" className="auth-link">Request reset link</Link>
        </p>
      </div>
    );
  }

  return (
    <div className="auth-card">
      <Link href="/" className="auth-logo">AETHER NEXUS</Link>
      <h1 className="auth-heading">New password</h1>

      {done ? (
        <div className="auth-success">
          Password updated! Redirecting to sign inâ€¦
        </div>
      ) : (
        <>
          {error ? <div className="auth-error">{error}</div> : null}
          <form onSubmit={handleSubmit} className="auth-form">
            <label className="auth-label" htmlFor="password">New password</label>
            <input
              id="password"
              type="password"
              className="auth-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              placeholder="At least 8 characters"
            />
            <label className="auth-label" htmlFor="confirm">Confirm password</label>
            <input
              id="confirm"
              type="password"
              className="auth-input"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              autoComplete="new-password"
              placeholder="â€¢â€¢â€¢â€¢â€¢â€¢â€¢â€¢"
            />
            <button type="submit" className="btn btn-primary auth-submit" disabled={pending}>
              {pending ? 'Updatingâ€¦' : 'Set new password'}
            </button>
          </form>
        </>
      )}

      <p className="auth-footer">
        <Link href="/login" className="auth-link">Back to sign in</Link>
      </p>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <main className="auth-shell">
      <Suspense fallback={<div className="auth-card"><div className="auth-desc">Loadingâ€¦</div></div>}>
        <ResetPasswordForm />
      </Suspense>
    </main>
  );
}
