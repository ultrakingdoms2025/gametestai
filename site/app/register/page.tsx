'use client';

import { signIn } from 'next-auth/react';
import Link from 'next/link';
import { useState, useTransition, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';

function RegisterForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const callbackUrl = searchParams.get('callbackUrl') ?? '/';

  const [email, setEmail] = useState('');
  const [handle, setHandle] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
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
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, handle, password }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? 'Registration failed.');
          return;
        }
        // Auto sign in after registration
        const signInRes = await signIn('credentials', { email, password, redirect: false });
        if (signInRes?.error) {
          setError('Account created but sign-in failed. Please sign in manually.');
          router.push('/login');
        } else {
          router.push(callbackUrl);
        }
      } catch {
        setError('Something went wrong. Please try again.');
      }
    });
  }

  async function handleGoogle() {
    startTransition(async () => {
      await signIn('google', { callbackUrl });
    });
  }

  return (
    <div className="auth-card">
      <Link href="/" className="auth-logo">AETHER NEXUS</Link>
      <h1 className="auth-heading">Create account</h1>

      {error ? <div className="auth-error">{error}</div> : null}

      <button
        type="button"
        className="btn btn-google"
        onClick={handleGoogle}
        disabled={pending}
      >
        <GoogleIcon />
        Continue with Google
      </button>

      <div className="auth-divider"><span>or</span></div>

      <form onSubmit={handleSubmit} className="auth-form">
        <label className="auth-label" htmlFor="handle">Handle</label>
        <input
          id="handle"
          type="text"
          className="auth-input"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          required
          minLength={3}
          maxLength={32}
          autoComplete="nickname"
          placeholder="Your player handle"
        />

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

        <label className="auth-label" htmlFor="password">Password</label>
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
          {pending ? 'Creatingâ€¦' : 'Create account'}
        </button>
      </form>

      <p className="auth-footer">
        Already have an account?{' '}
        <Link href={`/login?callbackUrl=${encodeURIComponent(callbackUrl)}`} className="auth-link">
          Sign in
        </Link>
      </p>
    </div>
  );
}

export default function RegisterPage() {
  return (
    <main className="auth-shell">
      <Suspense fallback={<div className="auth-card"><div className="auth-desc">Loadingâ€¦</div></div>}>
        <RegisterForm />
      </Suspense>
    </main>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
      <path fill="none" d="M0 0h48v48H0z"/>
    </svg>
  );
}
