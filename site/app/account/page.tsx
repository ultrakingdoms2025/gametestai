'use client';

import { signOut } from 'next-auth/react';
import Link from 'next/link';
import { useState, useTransition, useEffect } from 'react';

export default function AccountPage() {
  const [totpEnabled, setTotpEnabled] = useState<boolean | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [setupMode, setSetupMode] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    fetch('/api/user/me').then((r) => r.json()).then((d) => {
      setTotpEnabled(d.totp_enabled ?? false);
    }).catch(() => {});
  }, []);

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
          <h2 className="auth-section-title">Password</h2>
          <Link href="/forgot-password" className="btn btn-ghost" style={{ display: 'inline-block', marginTop: 8 }}>
            Change password
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
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => signOut({ callbackUrl: '/' })}
          >
            Sign out
          </button>
        </section>

        <p className="auth-footer">
          <Link href="/" className="auth-link">← Back to game</Link>
        </p>
      </div>
    </main>
  );
}
