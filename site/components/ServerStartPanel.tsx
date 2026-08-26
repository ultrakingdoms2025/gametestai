'use client';

import { useCallback, useEffect, useState, type CSSProperties } from 'react';

/**
 * The start panel's mode choice (7d): default mode, or a server from a dropdown.
 *
 * ── Why this is a gate in front of the game and not a menu inside it ──────
 *
 * Three art agents are working inside the world files while this ships, and the
 * in-game menus live there. More to the point, the choice has to be made BEFORE
 * the world builds: entry brings a server's quests and items "in addition to
 * defaults", and both are fetched during boot. A picker inside the running game
 * would mean tearing the catalogue down and rebuilding it mid-session.
 *
 * `/play` already gates the game behind an access check and a signed launch
 * cookie, so it is where a pre-boot choice belongs. The selection is stored
 * server-side, and every content route resolves it for itself — so nothing has
 * to be handed to the iframe and nothing in the browser can change it.
 *
 * ── Requesting, when a server is not yours ────────────────────────────────
 *
 * An unapproved server shows an "ask to join" button rather than being hidden.
 * A server nobody can find is a server nobody can request, and nothing about a
 * server's CONTENT is served here — only its name.
 *
 * ── Accepting an invitation, and why it needs its own control ─────────────
 *
 * The "ask to join" list is fed by `listJoinableServers`, which excludes any
 * server the player already has a non-removed row in. An `invited` row is such
 * a row — so the moment an owner invites somebody, the server LEAVES the list
 * the invitation could have been answered from, and the invited player was left
 * with a line of inert text reading "Waiting on: Name (invited)". The owner was
 * waiting on them; they were told they were waiting on the owner. Nobody could
 * move.
 *
 * The verb already existed: `request` on an `invited` row lands on `approved`
 * (`customServers.ts` TRANSITIONS), which is exactly "the player-side verb for
 * yes is the same verb as please, and the state the owner already set decides
 * which it means". So this is a button, not a new route and not a relaxed
 * exclusion — widening `listJoinableServers` would also let a `requested`
 * player re-ask and a `removed` player walk back in, and the state machine is
 * right as it stands.
 */

type ServerRow = { id: string; name: string; slug: string; description: string; status: string };
type Membership = ServerRow & { state: string };

type View = {
  current: string | null;
  memberships: Membership[];
  joinable: ServerRow[];
  credits: number | null;
};

const wrap: CSSProperties = {
  display: 'grid', gap: 14, padding: '18px 20px',
  borderBottom: '1px solid #12283a', background: 'rgba(4,12,20,0.86)',
};
const row: CSSProperties = { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' };
const btn: CSSProperties = {
  padding: '8px 16px', borderRadius: 6, border: '1px solid #2b5f80',
  background: '#0d2233', color: '#9fe4ff', cursor: 'pointer',
};
const select: CSSProperties = {
  padding: '8px 10px', borderRadius: 6, border: '1px solid #23415a',
  background: '#061019', color: '#dcecf7', minWidth: 220,
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(body?.error ?? `Request failed (${res.status})`));
  return body as T;
}

export function ServerStartPanel({ onEnter }: { onEnter: () => void }) {
  const [view, setView] = useState<View | null>(null);
  const [choice, setChoice] = useState<string>('');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * @param prefer the server to leave selected in the dropdown, for the reload
   *   that follows an accepted invitation. Without it the reload resets the
   *   choice to `current` — still default mode — and a player who has just
   *   joined has to go and find their new server in the list themselves, which
   *   is most of the way back to the dead end this control exists to fix.
   */
  const load = useCallback(async (prefer?: string) => {
    try {
      const data = await api<View>('/api/game/server');
      setView(data);
      setChoice(prefer ?? data.current ?? '');
    } catch (e) {
      setNote((e as Error).message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (!view) {
    return (
      <div style={wrap}>
        <span style={{ color: '#7fa4bd' }}>{note ?? 'Checking your servers…'}</span>
      </div>
    );
  }

  const approved = view.memberships.filter((m) => m.state === 'approved' && m.status === 'active');
  /* Invitations the player can answer NOW: the owner has offered, the server is
   * running, and `request` from `invited` lands on `approved` in one call.
   * A suspended server is deliberately not offered — the transition would
   * succeed and `selectServer` would then refuse the entry, which is a button
   * that appears to work and does not. Those fall through to "waiting on". */
  const invitations = view.memberships.filter((m) => m.state === 'invited' && m.status === 'active');
  const pending = view.memberships.filter(
    (m) => m.state !== 'approved' && !invitations.includes(m)
  );
  const chosen = approved.find((m) => m.id === choice) ?? null;

  return (
    <div style={wrap}>
      <div style={row}>
        <label htmlFor="server-choice" style={{ color: '#7fa4bd', letterSpacing: '0.08em', fontSize: 12 }}>
          MODE
        </label>
        <select
          id="server-choice"
          style={select}
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
        >
          <option value="">Default — the platform worlds</option>
          {approved.map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>

        <button
          type="button"
          style={btn}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setNote(null);
            try {
              /* Stored server-side before the iframe loads, so the boot fetches
               * already resolve to the right scope. Not a query parameter: the
               * game is served from a cookie-gated static path and cannot be
               * handed state through its URL. */
              await api('/api/game/server', {
                method: 'POST',
                body: JSON.stringify({ action: 'select', serverId: choice || null }),
              });
              onEnter();
            } catch (e) {
              setNote((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Enter {chosen ? chosen.name : 'default mode'}
        </button>
      </div>

      {chosen && (
        <p style={{ margin: 0, color: '#9bb0c2', fontSize: 13 }}>
          {chosen.description || 'A custom server.'}{' '}
          Credits earned here are this server&rsquo;s own and stay separate from your
          main balance.
        </p>
      )}

      {invitations.length > 0 && (
        <div style={row}>
          <span style={{ color: '#7fa4bd', fontSize: 13 }}>
            You have been invited to join:
          </span>
          {invitations.map((m) => (
            <button
              key={m.id}
              type="button"
              style={{ ...btn, padding: '6px 12px' }}
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setNote(null);
                try {
                  /* The SAME verb the "ask to join" list fires. On an `invited`
                   * row the transition table reads it as "yes", so one call
                   * lands on `approved` — there is no accept endpoint to add
                   * and no owner round trip to wait for. */
                  await api('/api/game/server', {
                    method: 'POST',
                    body: JSON.stringify({ action: 'request', serverId: m.id }),
                  });
                  setNote(`Joined ${m.name}. Press Enter ${m.name} to play there.`);
                  await load(m.id);
                } catch (e) {
                  setNote((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Accept {m.name}
            </button>
          ))}
        </div>
      )}

      {pending.length > 0 && (
        <p style={{ margin: 0, color: '#7fa4bd', fontSize: 13 }}>
          Waiting on:{' '}
          {pending.map((m) => `${m.name} (${m.state})`).join(', ')}
        </p>
      )}

      {view.joinable.length > 0 && (
        <div style={row}>
          <span style={{ color: '#7fa4bd', fontSize: 13 }}>Ask to join:</span>
          {view.joinable.slice(0, 8).map((s) => (
            <button
              key={s.id}
              type="button"
              style={{ ...btn, padding: '6px 12px' }}
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setNote(null);
                try {
                  await api('/api/game/server', {
                    method: 'POST',
                    body: JSON.stringify({ action: 'request', serverId: s.id }),
                  });
                  setNote(`Asked to join ${s.name}. The owner has to approve it.`);
                  await load();
                } catch (e) {
                  setNote((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}

      {note && <p style={{ margin: 0, color: '#ffd9a0', fontSize: 13 }} role="status">{note}</p>}
    </div>
  );
}
