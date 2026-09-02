'use client';

import Link from 'next/link';
import { useState, useTransition, useEffect, useCallback } from 'react';
import CopyableReference from '@/components/CopyableReference';
import SignOutButton from '@/components/SignOutButton';
import { SUPPORT_EMAIL } from '@/components/support';

/**
 * ── Why a zero is never shown until the fetch has actually answered ───────
 *
 * `fetch('/api/user/me').then(...).catch(() => {})` swallowed every failure,
 * and every field defaulted to the falsy value. A single dropped request
 * therefore rendered "Credits: 0", "No active token" and a 2FA section stuck on
 * "Loading…" — which is not a blip, it is the page telling a paying customer
 * their purchase is gone. The values now start as `null` and read as "—" until
 * something real arrives, and a failure says so and offers a retry.
 *
 * ── The 2FA section reads its own endpoint ────────────────────────────────
 *
 * `/api/auth/setup-2fa` GET is now a read-only status route, and it is the only
 * place that knows the three facts this section needs: whether the factor is
 * on, whether an enrolment was started and abandoned, and how many recovery
 * codes are left. `/api/user/me` carries `totp_enabled` too, and taking
 * "enabled" from one endpoint and "codes remaining" from another is how the two
 * drift into disagreeing on the same screen. One reader, one loader, one error
 * line — so a failure here cannot make the PROFILE above look broken either.
 *
 * ── Enrolment is two POSTs, and the second one is the only one that counts ─
 *
 * `begin` writes a PENDING secret and hands back a QR code; `confirm` proves a
 * code against it and only then promotes it. That is a security property of the
 * route (a GET used to wipe a working factor on page load), and it is also the
 * honest shape for a user: nothing about your account changes until you have
 * proved the phone works. The UI says so at each step rather than presenting
 * one opaque "Enable" that half-completes.
 */

type TwoFactor = {
  enabled: boolean;
  enrolmentPending: boolean;
  recoveryCodesRemaining: number;
};

export default function AccountPage() {
  const [email, setEmail] = useState('');
  const [handle, setHandle] = useState('');
  const [fullName, setFullName] = useState('');
  const [credits, setCredits] = useState<number | null>(null);
  const [hasAccess, setHasAccess] = useState<boolean | null>(null);
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const [daysRemaining, setDaysRemaining] = useState(0);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState('');
  const [pending, startTransition] = useTransition();

  /* ---- 2FA ------------------------------------------------------------- */
  const [twoFactor, setTwoFactor] = useState<TwoFactor | null>(null);
  const [twoFactorError, setTwoFactorError] = useState('');
  const [setupMode, setSetupMode] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [manualSecret, setManualSecret] = useState('');
  const [totpCode, setTotpCode] = useState('');
  /* Non-empty for exactly as long as the codes are on screen. They are stored
   * as HMACs, so this array is the only copy that will ever exist outside the
   * user's own notes — it is never written anywhere else and never re-fetched. */
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [codesAcknowledged, setCodesAcknowledged] = useState(false);
  const [disableMode, setDisableMode] = useState(false);
  const [disablePassword, setDisablePassword] = useState('');
  const [disableCode, setDisableCode] = useState('');

  const loadMe = useCallback(async () => {
    setLoadState('loading');
    setLoadError('');
    try {
      const res = await fetch('/api/user/me', { cache: 'no-store' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d?.error || `Request failed (${res.status})`);
      setEmail(d.email ?? '');
      setHandle(d.handle ?? '');
      setFullName(d.full_name ?? '');
      setCredits(typeof d.credits === 'number' ? d.credits : 0);
      setHasAccess(d.has_access ?? false);
      setDaysRemaining(d.days_remaining ?? 0);
      setHasPassword(d.has_password ?? null);
      setLoadState('ready');
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'The request did not come back.');
      setLoadState('error');
    }
  }, []);

  /* Deliberately touches neither `success` nor `error`: this runs immediately
   * after "Two-factor authentication is now enabled" is set, and a loader that
   * clears the page's messages on the way past would wipe the confirmation the
   * user just earned. */
  const loadTwoFactor = useCallback(async () => {
    setTwoFactorError('');
    try {
      const res = await fetch('/api/auth/setup-2fa', { cache: 'no-store' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d?.error || `Request failed (${res.status})`);
      setTwoFactor({
        enabled: !!d.enabled,
        enrolmentPending: !!d.enrolmentPending,
        recoveryCodesRemaining:
          typeof d.recoveryCodesRemaining === 'number' ? d.recoveryCodesRemaining : 0,
      });
    } catch (e) {
      setTwoFactor(null);
      setTwoFactorError(e instanceof Error ? e.message : 'The request did not come back.');
    }
  }, []);

  useEffect(() => { void loadMe(); }, [loadMe]);
  useEffect(() => { void loadTwoFactor(); }, [loadTwoFactor]);

  /* The browser's own "leave site?" prompt, for exactly as long as the codes
   * are on screen. The checkbox below stops somebody DISMISSING them by
   * accident; it does nothing about the reload, the back button or the closed
   * tab, which lose the same codes just as permanently. This is the only
   * unsaved state on this site that cannot be re-fetched. */
  useEffect(() => {
    if (recoveryCodes.length === 0) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Older engines ignore preventDefault and read this instead.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [recoveryCodes.length]);

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
      setCredits(typeof data.credits === 'number' ? data.credits : credits);
      setHasAccess(data.has_access ?? false);
      setDaysRemaining(data.days_remaining ?? 0);
      setLoadState('ready');
      setSuccess('Profile updated.');
    });
  }

  /**
   * Step one. Writes a PENDING secret server-side and returns the QR code and
   * the secret in text, which is the fallback for anyone whose authenticator
   * cannot use a camera. Nothing about the live factor moves here, and saying
   * so on screen is what makes "Cancel" safe to press.
   */
  async function beginSetup() {
    setError(''); setSuccess('');
    startTransition(async () => {
      const res = await fetch('/api/auth/setup-2fa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: 'begin' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        /* The 409s carry real instructions — "turn it off first", "set a
         * password first" — so the route's own words are shown rather than a
         * house message that would throw them away. */
        setError(data.error ?? 'Could not start setup.');
        void loadTwoFactor();
        return;
      }
      setQrDataUrl(data.qrDataUrl ?? '');
      setManualSecret(data.secret ?? '');
      setTotpCode('');
      setSetupMode(true);
    });
  }

  /** Step two. The code proves the phone, the server promotes the secret, and
   *  the recovery codes come back in the same response — once. */
  async function confirmSetup(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setSuccess('');
    startTransition(async () => {
      const res = await fetch('/api/auth/setup-2fa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: 'confirm', code: totpCode }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? 'Could not confirm that code.');
        return;
      }
      setSetupMode(false);
      setQrDataUrl('');
      setManualSecret('');
      setTotpCode('');
      /* Straight onto the screen, before anything else. If this array is lost
       * the codes are gone for good — the server keeps only their hashes — so
       * the acknowledgement gate below is the whole point of this branch. */
      const codes = Array.isArray(data.recoveryCodes) ? data.recoveryCodes : [];
      setRecoveryCodes(codes);
      setCodesAcknowledged(false);
      /* No codes in the response means an older deploy, or a shape that
       * changed. 2FA IS on either way — the route promoted the secret before it
       * answered — so the confirmation still has to be given, or the user is
       * left staring at an unchanged page wondering whether it worked. */
      if (codes.length === 0) setSuccess('Two-factor authentication is now enabled.');
      void loadTwoFactor();
    });
  }

  function dismissRecoveryCodes() {
    setRecoveryCodes([]);
    setCodesAcknowledged(false);
    setSuccess('Two-factor authentication is now enabled.');
  }

  /**
   * Turning it off re-authenticates: the password AND a current code, both in
   * the body, both checked server-side. A stolen session is exactly what a
   * second factor is for, so it must not be enough to remove one.
   */
  async function disable2fa(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setSuccess('');
    startTransition(async () => {
      const res = await fetch('/api/auth/disable-2fa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: disablePassword, code: disableCode }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        /* One refusal covers a wrong password AND a wrong code, on purpose —
         * the route will not say which, because saying which would make it a
         * password oracle for anyone holding a session. Do not dress it up. */
        setError(data.error ?? 'That password or code was not right.');
        return;
      }
      setDisableMode(false);
      setDisablePassword('');
      setDisableCode('');
      setSuccess(
        data.alreadyDisabled
          ? 'Two-factor authentication was already off.'
          : 'Two-factor authentication disabled. Your other devices have been signed out.'
      );
      void loadTwoFactor();
    });
  }

  return (
    <main id="main" tabIndex={-1} className="auth-shell">
      <div className="auth-card" style={{ maxWidth: 480 }}>
        <Link href="/" className="auth-logo">AETHER NEXUS</Link>
        <h1 className="auth-heading">Your account</h1>

        {error ? <div className="auth-error" role="alert">{error}</div> : null}
        {success ? <div className="auth-success" role="status">{success}</div> : null}

        {loadState === 'error' ? (
          <div className="auth-error" role="alert">
            <strong>We couldn&rsquo;t load your account.</strong>
            <br />
            {loadError} Nothing has changed — this is a read, so your credits, access
            and settings are all still exactly as they were.
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void loadMe()}>
                Retry
              </button>
              <a className="btn btn-ghost btn-sm" href={`mailto:${SUPPORT_EMAIL}`}>
                Contact support
              </a>
            </div>
          </div>
        ) : null}

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
          {/* A dash, not a zero. "Credits: 0" is a factual claim about the
              customer's money and this component has no business making it
              until the balance has actually been read back. */}
          <p className="auth-desc" style={{ marginTop: 16 }}>
            Credits:{' '}
            <strong>
              {credits === null
                ? (loadState === 'error' ? '— not loaded' : '—')
                : credits.toLocaleString()}
            </strong>
            <br />
            Access:{' '}
            <strong>
              {hasAccess === null
                ? (loadState === 'error' ? '— not loaded' : '—')
                : hasAccess
                  ? `${daysRemaining} day${daysRemaining === 1 ? '' : 's'} remaining`
                  : 'No active token'}
            </strong>
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

          {/* The codes take over the section while they are up. Everything else
              here is reachable again in a moment; these are not. */}
          {recoveryCodes.length > 0 ? (
            <div className="rc-panel" role="alert" aria-labelledby="rc-title">
              <h3 id="rc-title" className="rc-title">Save these recovery codes now</h3>
              <p className="rc-warn">
                <strong>This is the only time they will be shown.</strong> They are stored
                as one-way hashes, so nobody here can read them back to you — not support,
                not a password reset, not this page on your next visit.
              </p>
              <CopyableReference
                value={recoveryCodes.join('\n')}
                label={`Recovery codes (${recoveryCodes.length})`}
                buttonLabel="Copy all codes"
              >
                <ul className="rc-grid">
                  {recoveryCodes.map((c) => <li key={c}><code>{c}</code></li>)}
                </ul>
              </CopyableReference>
              <p className="rc-note">
                Each code works once, in place of the six-digit code, on the sign-in page
                and on this page. They are what gets you back in when the phone with your
                authenticator on it is lost, wiped or in a river.
              </p>
              <label className="rc-ack">
                <input
                  type="checkbox"
                  checked={codesAcknowledged}
                  onChange={(e) => setCodesAcknowledged(e.target.checked)}
                />
                <span>
                  I have saved these somewhere I can reach without my phone.
                </span>
              </label>
              <button
                type="button"
                className="btn btn-primary"
                onClick={dismissRecoveryCodes}
                disabled={!codesAcknowledged}
              >
                Done — hide the codes
              </button>
            </div>
          ) : twoFactorError ? (
            /* Not a permanent "Loading…": if the fetch failed it never
               resolves, and a spinner that never stops is a lie. */
            <div className="auth-desc" role="alert">
              We couldn&rsquo;t read your two-factor status. {twoFactorError} Nothing has
              changed — whatever was set is still set.
              <div style={{ marginTop: 10 }}>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void loadTwoFactor()}>
                  Retry
                </button>
              </div>
            </div>
          ) : twoFactor === null ? (
            <p className="auth-desc" role="status">Loading…</p>
          ) : twoFactor.enabled ? (
            <div>
              <p className="auth-desc" style={{ color: 'var(--clr-green, #4ade80)' }}>
                ✓ 2FA is enabled on your account.
              </p>
              <p className="auth-desc">
                Recovery codes left: <strong>{twoFactor.recoveryCodesRemaining}</strong>
                {twoFactor.recoveryCodesRemaining === 0 ? (
                  <>
                    {' '}— none. Turn 2FA off and back on to be issued a fresh set, while
                    you still have your authenticator to do it with.
                  </>
                ) : null}
              </p>
              {!disableMode ? (
                <button className="btn btn-ghost" onClick={() => { setDisableMode(true); setError(''); setSuccess(''); }} disabled={pending}>
                  Disable 2FA
                </button>
              ) : (
                <form onSubmit={disable2fa} className="auth-form">
                  <p className="auth-desc">
                    Turning it off needs your password and a current code. A borrowed
                    session is exactly what a second factor is for, so it is not enough on
                    its own to remove one.
                  </p>
                  {hasPassword === false ? (
                    <p className="auth-desc">
                      Your account signs in with Google and has no password, so the code
                      alone is asked for below.
                    </p>
                  ) : (
                    <>
                      <label className="auth-label" htmlFor="disable_password">Password</label>
                      <input
                        id="disable_password"
                        type="password"
                        className="auth-input"
                        value={disablePassword}
                        onChange={(e) => setDisablePassword(e.target.value)}
                        autoComplete="current-password"
                        required
                      />
                    </>
                  )}
                  <label className="auth-label" htmlFor="disable_code">
                    Authenticator code{' '}
                    <span className="auth-hint">(or one of your recovery codes)</span>
                  </label>
                  <input
                    id="disable_code"
                    type="text"
                    className="auth-input"
                    value={disableCode}
                    /* Six digits OR a ten-character recovery code with a dash —
                       so this must not strip to digits the way a TOTP-only field
                       would, which would silently eat the code somebody reaches
                       for precisely when they have lost their phone. */
                    onChange={(e) => setDisableCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 12))}
                    autoComplete="one-time-code"
                    placeholder="123456 or ABCDE-FGHJK"
                    required
                  />
                  <div style={{ display: 'flex', gap: 12 }}>
                    <button type="submit" className="btn btn-primary" disabled={pending}>
                      {pending ? 'Checking…' : 'Turn 2FA off'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => { setDisableMode(false); setDisablePassword(''); setDisableCode(''); }}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </div>
          ) : !setupMode ? (
            <div>
              <p className="auth-desc">Add an extra layer of security using an authenticator app.</p>
              {hasPassword === false ? (
                /* The route refuses this account with a 409 and explains why.
                 * Saying it here as well means the refusal is not something the
                 * user has to provoke to find out about. */
                <p className="auth-desc">
                  Your account signs in with Google and has no password. Google sign-in
                  cannot ask for a code, so a second factor here would not be enforced —{' '}
                  <Link href="/forgot-password" className="auth-link">set a password</Link>{' '}
                  first and this becomes available.
                </p>
              ) : (
                <>
                  {twoFactor.enrolmentPending ? (
                    <p className="auth-desc">
                      A setup was started and never confirmed. Nothing was changed by it;
                      starting again issues a new code to scan.
                    </p>
                  ) : null}
                  <button className="btn btn-primary" onClick={beginSetup} disabled={pending}>
                    {pending ? 'Starting…' : 'Enable 2FA'}
                  </button>
                </>
              )}
            </div>
          ) : (
            <div>
              <p className="auth-desc">
                <strong>Step 1 of 2.</strong> Scan this with your authenticator app (Google
                Authenticator, Authy, 1Password), then enter the six-digit code it shows.
                Nothing is switched on until that code checks out — cancelling here leaves
                your account exactly as it is now.
              </p>
              {qrDataUrl && (
                <div style={{ margin: '16px 0', background: '#fff', padding: 12, borderRadius: 8, display: 'inline-block' }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={qrDataUrl} alt="2FA QR code" width={180} height={180} />
                </div>
              )}
              {/* The same secret in text. A camera is not always available — a
                  desktop authenticator, a phone with no working camera, a
                  screen reader — and without this those users cannot enrol. */}
              {manualSecret ? (
                <CopyableReference
                  value={manualSecret}
                  label="Or enter this key by hand"
                  buttonLabel="Copy key"
                />
              ) : null}
              <form onSubmit={confirmSetup} className="auth-form">
                <label className="auth-label" htmlFor="totp_code">
                  <strong>Step 2 of 2.</strong> Verification code
                </label>
                <input
                  id="totp_code"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  className="auth-input"
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  autoComplete="one-time-code"
                  placeholder="000000"
                  required
                />
                <div style={{ display: 'flex', gap: 12 }}>
                  <button type="submit" className="btn btn-primary" disabled={pending}>
                    {pending ? 'Checking…' : 'Confirm and turn on'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => { setSetupMode(false); setQrDataUrl(''); setManualSecret(''); setTotpCode(''); }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          )}
        </section>

        {/* `/admin/servers` links "Back to your account" here; without this the
            round trip only went one way, and the account page named every other
            thing this site sells except the one recurring subscription. */}
        <section className="auth-section">
          <h2 className="auth-section-title">Custom servers</h2>
          <p style={{ color: 'var(--txt-2)', fontSize: '0.9rem', margin: '0 0 12px' }}>
            Your own lore, quests and marketplace items, played by the people you invite.
            Hosting is a monthly subscription; server credits stay separate from your main
            balance.
          </p>
          <Link href="/admin/servers" className="btn btn-ghost">Your servers</Link>
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
