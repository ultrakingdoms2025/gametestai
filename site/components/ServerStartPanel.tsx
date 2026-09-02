'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';

/**
 * The launch choice (7d), as a centred two-step modal in front of the game.
 *
 * ── Why this is a gate in front of the game and not a menu inside it ──────
 *
 * The choice has to be made BEFORE the world builds: entry brings a server's
 * quests and items "in addition to defaults", and both are fetched during
 * boot. A picker inside the running game would mean tearing the catalogue
 * down and rebuilding it mid-session. `/play` already gates the game behind
 * an access check and a signed launch cookie, so it is where a pre-boot
 * choice belongs. The selection is stored server-side, and every content
 * route resolves it for itself — nothing is handed to the iframe and nothing
 * in the browser can change it.
 *
 * ── The two steps ─────────────────────────────────────────────────────────
 *
 * Step one is the question itself: general play, or a custom server. Step two
 * is the full directory — every ACTIVE server, with an approved-member count
 * and an online-now count from the presence window, and per row the ONE verb
 * the caller's own membership state permits:
 *
 *   approved  → an "Approved" badge and Enter
 *   invited   → Accept (see below)
 *   requested → "Request pending", nothing to press
 *   no row    → Ask to join
 *
 * The directory comes from `listServersDirectory`, which is deliberately NOT
 * `listJoinableServers` widened: that list excludes servers the caller has a
 * row in because it feeds "ask to join", and widening it would let a
 * `requested` player re-ask and a `removed` player walk straight back in.
 * Suspended servers are not listed at all — `canUseServer` refuses them, and
 * a row for one would be a door that appears to open and does not.
 *
 * ── Accepting an invitation ───────────────────────────────────────────────
 *
 * Accept fires the SAME `request` verb as "ask to join". On an `invited` row
 * the transition table reads it as "yes", so one call lands on `approved`
 * (`customServers.ts` TRANSITIONS) — the player-side verb for yes is the same
 * verb as please, and the state the owner already set decides which it means.
 * There is no accept endpoint and no owner round trip.
 */

type DirectoryRow = {
  id: string;
  name: string;
  slug: string;
  description: string;
  /** `replace` means owner-authored content ONLY — tagged "curated" below. */
  contentMode: 'extend' | 'replace';
  members: number;
  online: number;
  callerState: 'approved' | 'invited' | 'requested' | null;
};

type View = {
  current: string | null;
  directory: DirectoryRow[];
};

const gate: CSSProperties = {
  minHeight: 'calc(100vh - 140px)',
  display: 'grid',
  placeItems: 'center',
  padding: '32px 16px',
};
const modal: CSSProperties = {
  width: 'min(620px, 94vw)',
  border: '1px solid #1d3346',
  borderRadius: 12,
  background: 'rgba(6,14,22,0.96)',
  padding: 24,
  display: 'grid',
  gap: 16,
};
const btn: CSSProperties = {
  padding: '8px 16px', borderRadius: 6, border: '1px solid #2b5f80',
  background: '#0d2233', color: '#9fe4ff', cursor: 'pointer',
};
const bigChoice: CSSProperties = {
  ...btn,
  display: 'grid',
  gap: 4,
  padding: '18px 20px',
  textAlign: 'left',
  fontSize: 16,
};
const badge: CSSProperties = {
  padding: '2px 10px', borderRadius: 999, border: '1px solid #2b805f',
  color: '#7dffc8', fontSize: 12, letterSpacing: '0.06em',
};

/**
 * The status has to survive the throw.
 *
 * `/api/game/server` answers `401 {"error":"Not authenticated."}` on both its
 * verbs. Collapsing that into a bare message lost the one fact the UI needed to
 * behave differently, and the failure branch below then told a signed-out
 * player that "only the custom-server directory failed" and offered them a
 * General play button — which POSTs to the same route, takes the same 401, and
 * leaves every control on the screen disabled. A player who had merely been
 * signed out was locked out of the game with no route back in.
 */
class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(String(body?.error ?? `Request failed (${res.status})`), res.status);
  }
  return body as T;
}

/** A signed-out session, whichever dialect the route speaks it in. */
const isSignedOut = (e: unknown) =>
  e instanceof ApiError && (e.status === 401 || e.status === 403);

export function ServerStartPanel({ onEnter }: { onEnter: () => void }) {
  const [view, setView] = useState<View | null>(null);
  const [step, setStep] = useState<'choose' | 'servers'>('choose');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /* Told apart from "still loading" so the failure branch can offer a way
   * forward rather than a sentence. */
  const [loadError, setLoadError] = useState<string | null>(null);
  /* Told apart from every other load failure, because it is the only one where
   * "go straight in" is false and a sign-in link is the whole answer. */
  const [signedOut, setSignedOut] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const data = await api<View>('/api/game/server');
      setView(data);
      setSignedOut(false);
    } catch (e) {
      setSignedOut(isSignedOut(e));
      setLoadError((e as Error).message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /* Focus follows the step. The heading takes it (tabIndex -1) so a keyboard
   * or screen-reader user lands on "what this screen is" before the choices,
   * and Escape from the directory is the same "back" the button offers. */
  useEffect(() => { headingRef.current?.focus(); }, [step, view === null]);

  /**
   * Stored server-side before the iframe loads, so the boot fetches already
   * resolve to the right scope. Not a query parameter: the game is served
   * from a cookie-gated static path and cannot be handed state through its
   * URL.
   */
  const enter = async (serverId: string | null) => {
    setBusy(true);
    setNote(null);
    try {
      await api('/api/game/server', {
        method: 'POST',
        body: JSON.stringify({ action: 'select', serverId }),
      });
      onEnter();
    } catch (e) {
      /* A 401 here means the session went while the panel sat open. Drop back
       * to the signed-out screen rather than leaving the raw refusal as a note
       * beside buttons that will all refuse the same way — that screen is the
       * only place with a sign-in link on it. */
      if (isSignedOut(e)) {
        setSignedOut(true);
        setLoadError((e as Error).message);
        setView(null);
      } else {
        setNote((e as Error).message);
      }
      setBusy(false);
    }
  };

  /** `request`: "ask to join" on no row, "yes" on an invited row. */
  const request = async (row: DirectoryRow) => {
    setBusy(true);
    setNote(null);
    try {
      await api('/api/game/server', {
        method: 'POST',
        body: JSON.stringify({ action: 'request', serverId: row.id }),
      });
      setNote(row.callerState === 'invited'
        ? `Joined ${row.name}. You can enter it now.`
        : `Asked to join ${row.name}. The owner has to approve it.`);
      await load();
    } catch (e) {
      // Same reasoning as `enter` above. @see the signed-out branch below.
      if (isSignedOut(e)) {
        setSignedOut(true);
        setLoadError((e as Error).message);
        setView(null);
      } else {
        setNote((e as Error).message);
      }
    } finally {
      setBusy(false);
    }
  };

  /**
   * The directory could not be read.
   *
   * This used to render one line of raw error text inside a modal with no
   * buttons in it — no retry, no exit, nothing. A database blip on the custom
   * server directory therefore locked a paying player out of the game
   * ENTIRELY, and the galling part is that General play needs none of this
   * data: it posts `serverId: null` and boots the platform worlds. So the
   * first thing this branch offers is the door the failure never touched.
   *
   * ── Except when the failure IS the door ──────────────────────────────────
   *
   * That reasoning holds for a database blip and is false for a 401. General
   * play posts `action: 'select'` to the same route that just refused, so the
   * button below would refuse identically and leave `busy` true with every
   * control disabled — the lock-out this branch was written to prevent,
   * reached by the branch itself. A signed-out session gets its own screen: no
   * false reassurance, no button that cannot work, and the one link that fixes
   * it.
   */
  if (!view && loadError && signedOut) {
    return (
      <div style={gate}>
        <div style={modal} role="dialog" aria-modal="true" aria-labelledby="launch-title">
          <h2 id="launch-title" ref={headingRef} tabIndex={-1}
            style={{ margin: 0, fontSize: 20, outline: 'none' }}>
            You are signed out
          </h2>
          <p role="alert" style={{ margin: 0, color: '#ffb4b4', fontSize: 14 }}>
            ⚠ {loadError}
          </p>
          <p style={{ margin: 0, color: '#9bb0c2', fontSize: 13 }}>
            Your session has expired or been signed out elsewhere. This is not a fault and
            nothing has been lost — your access, credits and progress are on your account
            and will be exactly where you left them. Signing in again brings you straight
            back here.
          </p>
          <a style={{ ...bigChoice, textDecoration: 'none' }} href="/login?callbackUrl=%2Fplay">
            <b>Sign in and carry on</b>
            <span style={{ color: '#9bb0c2', fontSize: 13 }}>
              You will come back to this screen.
            </span>
          </a>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <a style={{ ...btn, textDecoration: 'none' }} href="/">Back to the site</a>
          </div>
        </div>
      </div>
    );
  }

  if (!view && loadError) {
    return (
      <div style={gate}>
        <div style={modal} role="dialog" aria-modal="true" aria-labelledby="launch-title">
          <h2 id="launch-title" ref={headingRef} tabIndex={-1}
            style={{ margin: 0, fontSize: 20, outline: 'none' }}>
            We could not load the server list
          </h2>
          <p role="alert" style={{ margin: 0, color: '#ffb4b4', fontSize: 14 }}>
            ⚠ {loadError}
          </p>
          <p style={{ margin: 0, color: '#9bb0c2', fontSize: 13 }}>
            Only the custom-server directory failed. General play does not use it, so
            you can go straight in — the platform worlds, quests and marketplace are all
            unaffected.
          </p>
          <button type="button" style={bigChoice} disabled={busy}
            onClick={() => void enter(null)}>
            <b>General play</b>
            <span style={{ color: '#9bb0c2', fontSize: 13 }}>
              The platform worlds, quests and marketplace — the default game.
            </span>
          </button>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" style={btn} disabled={busy} onClick={() => void load()}>
              Retry the server list
            </button>
            <a style={{ ...btn, textDecoration: 'none' }} href="/">Back to the site</a>
          </div>
          {note && <p style={{ margin: 0, color: '#ffd9a0', fontSize: 13 }} role="status">{note}</p>}
        </div>
      </div>
    );
  }

  if (!view) {
    return (
      <div style={gate}>
        <div style={modal} role="dialog" aria-modal="true" aria-label="Choose how to play">
          <span style={{ color: '#7fa4bd' }} role="status">{note ?? 'Checking your servers…'}</span>
        </div>
      </div>
    );
  }

  return (
    <div style={gate}>
      <div
        style={modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="launch-title"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && step === 'servers') {
            e.preventDefault();
            setStep('choose');
          }
        }}
      >
        {step === 'choose' ? (
          <>
            <h2 id="launch-title" ref={headingRef} tabIndex={-1}
              style={{ margin: 0, fontSize: 20, outline: 'none' }}>
              How do you want to play?
            </h2>
            <button type="button" style={bigChoice} disabled={busy}
              onClick={() => void enter(null)}>
              <b>General play</b>
              <span style={{ color: '#9bb0c2', fontSize: 13 }}>
                The platform worlds, quests and marketplace — the default game.
              </span>
            </button>
            <button type="button" style={bigChoice} disabled={busy}
              onClick={() => { setNote(null); setStep('servers'); }}>
              <b>Custom server</b>
              <span style={{ color: '#9bb0c2', fontSize: 13 }}>
                A hosted community with its own quests, items, chat and leaderboard.
                {view.directory.length
                  ? ` ${view.directory.length} server${view.directory.length === 1 ? '' : 's'} available.`
                  : ' None exist yet.'}
              </span>
            </button>
          </>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <button type="button" style={{ ...btn, padding: '6px 12px' }} disabled={busy}
                onClick={() => setStep('choose')} aria-label="Back to play choice">
                ← Back
              </button>
              <h2 id="launch-title" ref={headingRef} tabIndex={-1}
                style={{ margin: 0, fontSize: 20, outline: 'none' }}>
                Custom servers
              </h2>
            </div>

            {!view.directory.length && (
              <p style={{ margin: 0, color: '#7fa4bd' }}>
                No custom servers are running yet.
              </p>
            )}

            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }}>
              {view.directory.map((s) => (
                <li key={s.id}
                  style={{
                    border: '1px solid #16324a', borderRadius: 8, padding: '12px 14px',
                    display: 'grid', gap: 6,
                  }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <b style={{ fontSize: 15 }}>{s.name}</b>
                    <span style={{ color: '#6f8ea3', fontSize: 13 }}>
                      {s.members} member{s.members === 1 ? '' : 's'} · {s.online} online now
                    </span>
                    {/* One word of honest advertising: a replace-mode server
                        serves ONLY its owner's content, and a player who finds
                        that out after joining reads the missing platform
                        marketplace as an outage. The title carries the long
                        version for whoever hovers. */}
                    {s.contentMode === 'replace' && (
                      <span
                        style={{ ...badge, borderColor: '#80662b', color: '#ffd9a0' }}
                        title="Curated: this server replaces the default game with its owner's own quests, items and lore."
                      >
                        curated
                      </span>
                    )}
                    {s.callerState === 'approved' && <span style={badge}>Approved</span>}
                    {view.current === s.id && (
                      <span style={{ color: '#7fa4bd', fontSize: 12 }}>current</span>
                    )}
                  </div>
                  {s.description && (
                    <p style={{ margin: 0, color: '#9bb0c2', fontSize: 13 }}>{s.description}</p>
                  )}
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    {s.callerState === 'approved' && (
                      <button type="button" style={btn} disabled={busy}
                        onClick={() => void enter(s.id)}>
                        Enter {s.name}
                      </button>
                    )}
                    {s.callerState === 'invited' && (
                      <button type="button" style={btn} disabled={busy}
                        onClick={() => void request(s)}>
                        Accept invitation
                      </button>
                    )}
                    {s.callerState === 'requested' && (
                      <span style={{ color: '#ffd9a0', fontSize: 13 }}>
                        Request pending — the owner has to approve it.
                      </span>
                    )}
                    {s.callerState === null && (
                      <button type="button" style={btn} disabled={busy}
                        onClick={() => void request(s)}>
                        Ask to join
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>

            <p style={{ margin: 0, color: '#7fa4bd', fontSize: 12 }}>
              Credits earned in a custom server are that server&rsquo;s own and stay
              separate from your main balance.
            </p>
          </>
        )}

        {note && <p style={{ margin: 0, color: '#ffd9a0', fontSize: 13 }} role="status">{note}</p>}
      </div>
    </div>
  );
}
