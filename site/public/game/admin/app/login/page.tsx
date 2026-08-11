'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totp,     setTotp]     = useState('');
  const [error,    setError]    = useState('');
  const [loading,  setLoading]  = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ username, password, totp }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Login failed'); return; }
      router.push('/dashboard');
      router.refresh();
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-shell">
      <div className="login-box">
        <div className="login-logo">AETHER<span>NEXUS</span> · Admin</div>

        <form onSubmit={submit} autoComplete="off">
          <div className="form-row">
            <label className="form-label" htmlFor="u">Username</label>
            <input
              id="u" type="text" autoComplete="username"
              value={username} onChange={e => setUsername(e.target.value)}
              required
            />
          </div>

          <div className="form-row">
            <label className="form-label" htmlFor="p">Password</label>
            <input
              id="p" type="password" autoComplete="current-password"
              value={password} onChange={e => setPassword(e.target.value)}
              required
            />
          </div>

          <div className="form-row">
            <label className="form-label" htmlFor="t">Authenticator code</label>
            <input
              id="t" type="text" inputMode="numeric" pattern="\d{6}"
              maxLength={6} className="form-totp"
              placeholder="000000"
              value={totp} onChange={e => setTotp(e.target.value.replace(/\D/g,''))}
              required
            />
          </div>

          {error && <div className="form-error">{error}</div>}

          <button
            type="submit" className="btn btn-primary"
            style={{ width: '100%', marginTop: 24 }}
            disabled={loading}
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}