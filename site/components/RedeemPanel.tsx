'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { ACCESS_CODE_PREFIX, normalizeAccessCode } from '@/lib/accessCodeFormat';

/**
 * The redeem form.
 *
 * ── Why the code is carried in `sessionStorage` and not in the URL ────────
 *
 * A grant belongs to an account, so somebody arriving from the login screen
 * with a code has to sign in before it can be applied — and something has to
 * hold the code across that round trip. The obvious choice, `?code=…` on the
 * callback URL, is the wrong one: a code is a bearer credential, and a bearer
 * credential in a query string is written into browser history, sent in the
 * `Referer` header to anything the next page loads, and logged by every proxy
 * and platform in between. `sessionStorage` never leaves the tab, dies with it,
 * and is not sent anywhere.
 *
 * ── Why the field is pre-filled but not auto-submitted ────────────────────
 *
 * Coming back from a sign-in to find the code already typed in is the whole
 * point of holding on to it. Submitting it for them is a step too far: if it
 * then fails — a withdrawn code, an account that already used it — the person
 * is looking at an error for an action they do not remember taking, on a page
 * they have just been redirected to. One click keeps the cause and the effect
 * next to each other.
 */

type Result =
  | { ok: true; kind: 'play' | 'server'; days: number; daysRemaining: number; label: string | null }
  | { ok: false; message: string };

const PENDING_KEY = 'an_pending_access_code';

export default function RedeemPanel({ signedIn }: { signedIn: boolean }) {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [pending, startTransition] = useTransition();

  /* Restore whatever was typed before the sign-in detour. Guarded, because
   * `sessionStorage` throws outright in some privacy modes rather than
   * returning null, and a redeem page that will not render is worse than one
   * that has forgotten a code the visitor can paste again. */
  useEffect(() => {
    try {
      const held = window.sessionStorage.getItem(PENDING_KEY);
      if (held) setCode(held);
    } catch {
      /* no stored code, and nothing to tell the visitor about it */
    }
  }, []);

  function remember(value: string) {
    try {
      window.sessionStorage.setItem(PENDING_KEY, value);
    } catch {
      /* Best effort. Losing it costs one re-type, not the redemption. */
    }
  }

  function forget() {
    try {
      window.sessionStorage.removeItem(PENDING_KEY);
    } catch {
      /* nothing to clean up */
    }
  }

  function handleSignIn(target: '/login' | '/register') {
    remember(code);
    router.push(`${target}?callbackUrl=${encodeURIComponent('/redeem')}`);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);

    if (!signedIn) {
      handleSignIn('/login');
      return;
    }

    startTransition(async () => {
      try {
        const res = await fetch('/api/redeem', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code }),
        });
        const body = await res.json();
        if (body?.ok) {
          forget();
          setResult({
            ok: true,
            kind: body.kind,
            days: body.days,
            daysRemaining: body.daysRemaining ?? 0,
            label: body.label ?? null,
          });
          /* The header, the account panel and the `/play` gate are all server
           * rendered from the row this just changed. Without a refresh the
           * visitor is told they have 30 days by a page that still believes
           * they have none. */
          router.refresh();
        } else {
          setResult({ ok: false, message: String(body?.message ?? 'That code could not be redeemed.') });
        }
      } catch {
        setResult({ ok: false, message: 'We could not reach the server. Please try again.' });
      }
    });
  }

  /* Client-side validation of SHAPE only, and only to enable the button. What a
   * code is worth is a server question; this just stops a request that cannot
   * possibly succeed and lets someone see they have mistyped before they find
   * out the slow way. */
  const looksLikeCode = normalizeAccessCode(code) !== null;

  if (result?.ok) {
    return (
      <div className="auth-card">
        <Link href="/" className="auth-logo">AETHER NEXUS</Link>
        <h1 className="auth-heading">Code accepted</h1>
        <div className="auth-success" role="status">
          {result.kind === 'play' ? (
            <>
              {result.days} days of access added
              {result.daysRemaining > result.days
                ? ` — you now have ${result.daysRemaining} days in total.`
                : '.'}
            </>
          ) : (
            <>Custom server hosting unlocked for {result.days} days.</>
          )}
        </div>
        {result.label ? <p className="auth-desc">{result.label}</p> : null}
        <div className="auth-form">
          {result.kind === 'play' ? (
            <Link href="/play" className="btn btn-primary auth-submit">Play now</Link>
          ) : (
            <Link href="/admin/servers" className="btn btn-primary auth-submit">Set up your server</Link>
          )}
        </div>
        <p className="auth-footer">
          <Link href="/account" className="auth-link">Go to your account</Link>
        </p>
      </div>
    );
  }

  return (
    <div className="auth-card">
      <Link href="/" className="auth-logo">AETHER NEXUS</Link>
      <h1 className="auth-heading">Play free with a code</h1>
      <p className="auth-desc">
        Enter the code you were given. It unlocks full access to every world for the
        period it was issued for — no card, no trial that turns into a charge.
      </p>

      {result && !result.ok ? <div className="auth-error" role="alert">{result.message}</div> : null}

      <form onSubmit={handleSubmit} className="auth-form">
        <label className="auth-label" htmlFor="code">Access code</label>
        <input
          id="code"
          name="code"
          className="auth-input"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={`${ACCESS_CODE_PREFIX}-XXXX-XXXX-XXXX`}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          required
        />

        <button
          type="submit"
          className="btn btn-primary auth-submit"
          disabled={pending || !looksLikeCode}
        >
          {pending ? 'Checking…' : signedIn ? 'Redeem code' : 'Continue'}
        </button>
      </form>

      {signedIn ? (
        <p className="auth-footer">
          <Link href="/account" className="auth-link">Back to your account</Link>
        </p>
      ) : (
        <>
          {/* Said plainly rather than discovered at the last step. Somebody who
              was handed a code is expecting to play, and finding out about an
              account only after typing the code reads like a bait and switch —
              even though the account is what the 30 days attach to. */}
          <p className="auth-desc" style={{ marginTop: 18 }}>
            Your code needs an account to live on — that is what keeps your progress,
            credits and access when you come back. Creating one takes a moment and
            costs nothing.
          </p>
          <div className="auth-row" style={{ justifyContent: 'space-between' }}>
            <button type="button" className="auth-link" onClick={() => handleSignIn('/register')}>
              Create an account
            </button>
            <button type="button" className="auth-link" onClick={() => handleSignIn('/login')}>
              I already have one
            </button>
          </div>
        </>
      )}
    </div>
  );
}
