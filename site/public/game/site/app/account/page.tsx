'use client';

import Link from 'next/link';
import { useState, useTransition, useEffect } from 'react';
import SignOutButton from '@/components/SignOutButton';

export default function AccountPage() {
  const [totpEnabled, setTotpEnabled] = useState<boolean | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [email, setEmail] = useState('');
  const [handle, setHandle] = useState('');
  const [fullName, setFullName] = useState('');
  const [credits, setCredits] = useState(0);
  const [hasAccess, setHasAccess] = useState(false);
  const [daysRemaining, setDaysRemaining] = useState(0);
  const [setupMode, setSetupMode] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    fetch('/api/user/me').then((r) => r.json()).then((d) => {
      setTotpEnabled(d.totp_enabled ?? false);
      setEmail(d.email ?? '');
      setHandle(d.handle ?? '');
      setFullName(d.full_name ?? '');
      setCredits(d.credits ?? 0);
      setHasAccess(d.has_access ?? false);
      setDaysRemaining(d.days_remaining ?? 0);
    }).catch(() => {});
  }, []);

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSuccess('');
    startTransition(async () => {
      const res = await fetch('/api/user/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, handle, full_name: fullName }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Could not update your profile.');
        return;
      }
      setEmail(data.email ?? '');
      setHandle(data.handle ?? '');
      setFullName(data.full_name ?? '');
      setCredits(data.credits ?? 0);
      setHasAccess(data.has_access ?? false);
      setDaysRemaining(data.days_remaining ?? 0);
      setSuccess('Profile updated.');
    });
  }

  async function startSetup() {
    setError(''); setSuccess('');
    startTransition(async () => {
      const res = await fetch('/api/auth/setup-2fa');
      const data = await res.json();
      if (!res.ok) { setError(data.error); return; }
      setQrDataUrl(data.qrDataUrl);
      setSetupMode(true);
    });
  }

  async function confirmSetup(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setSuccess('');
    startTransition(async () => {
      const res = await fetch('/api/auth/setup-2fa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: totpCode }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error); return; }
      setSetupMode(false); setTotpEnabled(true);
      setSuccess('Two-factor authentication is now enabled.');
    });
  }

  async function disable2fa() {
    setError(''); setSuccess('');
    startTransition(async () => {
      const res = await fetch('/api/auth/disable-2fa', { method: 'POST' });
      if (!res.ok) { setError('Failed to disable 2FA.'); return; }
      setTotpEnabled(false);
      setSuccess('Two-factor authentication disabled.');
    });
  }

  return (
    <main className="auth-shell">
      <div className="auth-card" style={{ maxWidth: 480 }}>
        <Link href="/" className="auth-logo">AETHER NEXUS</Link>
        <h1 className="auth-heading">Your account</h1>

        {error ? <div className="auth-error">{error}</div> : null}
        {success ? <div className="auth-success">{success}</div> : null}

        <section className="auth-section">
          <h2 className="auth-section-title">Profile</h2>
          <form onSubmit={saveProfile} className="auth-form">
            <label className="auth-label" htmlFor="handle">Handle</label>
            <input
              id="handle"
              className="auth-input"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              minLength={3}
              maxLength={32}
              autoComplete="nickname"
              required
            />
            <label className="auth-label" htmlFor="full_name">Display name</label>
            <input
              id="full_name"
              className="auth-input"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              maxLength={80}
              autoComplete="name"
              placeholder="Optional"
            />
            <label className="auth-label" htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              className="auth-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
            <button type="submit" className="btn btn-primary" disabled={pending}>
              {pending ? 'Saving…' : 'Save profile'}
            </button>
          </form>
          <p className="auth-desc" style={{ marginTop: 16 }}>
            Credits: <strong>{credits.toLocaleString()}</strong><br />
            Access: <strong>{hasAccess ? `${daysRemaining} day${daysRemaining === 1 ? '' : 's'} remaining` : 'No active token'}</strong>
          </p>
        </section>

        <section className="auth-section">
          <h2 className="auth-section-title">Password</h2>
          <Link href="/forgot-password" className="btn btn-ghost" style={{ display: 'inline-block', marginTop: 8 }}>
            Reset password
          </Link>
        </section>

        <section className="auth-section">
          <h2 className="auth-section-title">Two-factor authentication</h2>
          {totpEnabled === null ? (
            <p className="auth-desc">Loading…</p>
          ) : totpEnabled ? (
            <div>
              <p className="auth-desc" style={{ color: 'var(--clr-green, #4ade80)' }}>
                ✓ 2FA is enabled on your account.
              </p>
              <button className="btn btn-ghost" onClick={disable2fa} disabled={pending}>
                Disable 2FA
              </button>
            </div>
          ) : !setupMode ? (
            <div>
              <p className="auth-desc">Add an extra layer of security using an authenticator app.</p>
              <button className="btn btn-primary" onClick={startSetup} disabled={pending}>
                Enable 2FA
              </button>
            </div>
          ) : (
            <div>
              <p className="auth-desc">
                Scan this QR code with your authenticator app (e.g. Google Authenticator, Authy), then enter the 6-digit code to confirm.
              </p>
              {qrDataUrl && (
                <div style={{ margin: '16px 0', background: '#fff', padding: 12, borderRadius: 8, display: 'inline-block' }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={qrDataUrl} alt="2FA QR code" width={180} height={180} />
                </div>
              )}
              <form onSubmit={confirmSetup} className="auth-form">
                <label className="auth-label" htmlFor="totp_code">Verification code</label>
                <input
                  id="totp_code"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  className="auth-input"
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value)}
                  placeholder="000000"
                  required
                />
                <div style={{ display: 'flex', gap: 12 }}>
                  <button type="submit" className="btn btn-primary" disabled={pending}>Confirm</button>
                  <button type="button" className="btn btn-ghost" onClick={() => setSetupMode(false)}>Cancel</button>
                </div>
              </form>
            </div>
          )}
        </section>

        <section className="auth-section">
          <SignOutButton />
        </section>

        <p className="auth-footer">
          <Link href="/" className="auth-link">← Back to game</Link>
        </p>
      </div>
    </main>
  );
}
