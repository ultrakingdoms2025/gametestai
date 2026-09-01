'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';

/**
 * Scoped chat (7e): a shout to the server, or a direct message to one of the
 * players currently in it.
 *
 * ── Why it is here, beside the game, and not inside it ────────────────────
 *
 * Two reasons, and the second is the real one.
 *
 * The circumstantial one: `src/ui/` and the HUD are being worked on by other
 * agents in parallel, and a chat box wired into `HUD.js` would collide.
 *
 * The structural one: chat has no dependency on the running world at all. It is
 * HTTP against Postgres, on a poll, and every message is addressed by server and
 * player rather than by anything spatial — because decision D2 means two members
 * standing in the same world do not share an instance and cannot see each other.
 * A channel with no spatial component does not need to live in the renderer, and
 * putting it there would mean the game had to be running for a player to answer a
 * message.
 *
 * The honest cost, recorded rather than hidden: a player in pointer lock has to
 * release it to type. That is a real friction and the fix is an in-game panel,
 * which is a follow-up.
 *
 * ── The poll ──────────────────────────────────────────────────────────────
 *
 * `?since=` is the last id held. An idle poll is one indexed scan returning
 * nothing. The interval backs off when the tab is hidden, because a background
 * tab polling every three seconds is a serverless invocation every three seconds
 * for a player who is not reading.
 */

type Msg = {
  id: number; from: string | null; fromId: string;
  direct: boolean; mine: boolean; body: string; at: string;
};
type Active = { playerId: string; handle: string | null };
type Page = {
  serverId: string | null; messages: Msg[]; cursor: number;
  active: Active[]; max?: number;
};

const ACTIVE_MS = 4000;
const HIDDEN_MS = 30_000;
/** Keep the transcript bounded; this is a chat box, not an archive. */
const KEEP = 200;

const panel: CSSProperties = {
  position: 'fixed', right: 12, bottom: 12, width: 320, maxHeight: '60vh',
  display: 'grid', gridTemplateRows: 'auto 1fr auto', gap: 8,
  border: '1px solid #1d3346', borderRadius: 10, padding: 10,
  background: 'rgba(4,12,20,0.94)', color: '#dcecf7', zIndex: 40,
};
const btn: CSSProperties = {
  padding: '6px 12px', borderRadius: 6, border: '1px solid #2b5f80',
  background: '#0d2233', color: '#9fe4ff', cursor: 'pointer',
};
const field: CSSProperties = {
  flex: 1, minWidth: 0, padding: '6px 8px', borderRadius: 6,
  border: '1px solid #23415a', background: '#061019', color: '#dcecf7',
};

export function ServerChatPanel() {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<Page | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [to, setTo] = useState('');
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const cursor = useRef(0);
  /* `/api/game/chat` answers 401 for a session that has gone. Swallowed like
   * any other non-2xx, that had two compounding effects: `page` was never set,
   * so `!page?.serverId` below unmounted the entire chat UI — the button
   * vanished from the corner with nothing said anywhere — and the poll went on
   * asking a route that would refuse it every three seconds for as long as the
   * tab stayed open. A refusal is not a blip: it will not clear on its own, so
   * it stops the loop and says so. The ref is what the running loop reads;
   * the state is what the render reads. */
  const [signedOut, setSignedOut] = useState(false);
  const signedOutRef = useRef(false);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/game/chat?since=${cursor.current}`);
      if (res.status === 401 || res.status === 403) {
        signedOutRef.current = true;
        setSignedOut(true);
        return;
      }
      if (!res.ok) return;
      signedOutRef.current = false;
      setSignedOut(false);
      const data = (await res.json()) as Page;
      setPage(data);
      if (data.messages.length) {
        cursor.current = data.cursor;
        setMessages((prev) => [...prev, ...data.messages].slice(-KEEP));
      }
    } catch {
      /* A failed poll is not worth telling the player about — the next one is
       * three seconds away and a transient network blip is not news. */
    }
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      await poll();
      if (stopped) return;
      /* Nothing reschedules after a refusal. Signing back in is a navigation,
       * which remounts this component and starts a fresh loop. */
      if (signedOutRef.current) return;
      timer = setTimeout(tick, document.hidden ? HIDDEN_MS : ACTIVE_MS);
    };
    void tick();
    /* Re-tick immediately when the tab comes back, so a player who was away for
     * ten minutes does not wait out the long interval before seeing anything. */
    const onVisible = () => {
      if (!document.hidden && timer) {
        clearTimeout(timer);
        void tick();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [poll]);

  /* No server, no chat. There is no global channel in this design, and rendering
   * an empty box in default mode would suggest otherwise. A player who was
   * never in a server sees nothing when the session goes either — they had no
   * chat to lose, and a sign-in prompt in the corner of a game they are playing
   * signed out is a question they cannot act on. */
  if (!page?.serverId) return null;

  /* Had a channel, lost the session. Deliberately still in the corner where the
   * chat button was, so it reads as "this thing you were using" rather than as
   * a new alert about the game. */
  if (signedOut) {
    return (
      <div
        role="status"
        style={{
          position: 'fixed', right: 12, bottom: 12, zIndex: 40, maxWidth: 260,
          padding: '10px 12px', borderRadius: 8, border: '1px solid #7a2b2b',
          background: '#1a0d10', color: '#ffc9cf', fontSize: 13, lineHeight: 1.5,
        }}
      >
        Chat has stopped — you are signed out. Your progress is safe.{' '}
        <a href="/login?callbackUrl=%2Fplay" style={{ color: '#9fe4ff' }}>
          Sign in again
        </a>{' '}
        to bring it back.
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        style={{ ...btn, position: 'fixed', right: 12, bottom: 12, zIndex: 40 }}
        onClick={() => setOpen(true)}
      >
        Chat{messages.length ? ` (${messages.length})` : ''}
      </button>
    );
  }

  const send = async () => {
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    setNote(null);
    try {
      const res = await fetch('/api/game/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body, to: to || null }),
      });
      const out = await res.json().catch(() => ({}));
      if (res.status === 401 || res.status === 403) {
        /* Same refusal as the poll's, reached from the other verb. Hand the
         * render to the signed-out notice rather than leaving "Not
         * authenticated." under an input that will refuse every line typed
         * into it. */
        signedOutRef.current = true;
        setSignedOut(true);
      } else if (!res.ok) setNote(String(out?.error ?? 'Could not send that.'));
      else await poll();
    } catch {
      setNote('Could not reach the server.');
    }
  };

  return (
    <section style={panel} aria-label="Server chat">
      <header style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <strong style={{ flex: 1, fontSize: 13 }}>Server chat</strong>
        <button type="button" style={{ ...btn, padding: '2px 8px' }} onClick={() => setOpen(false)}>
          Hide
        </button>
      </header>

      <div style={{ overflowY: 'auto', display: 'grid', gap: 4, alignContent: 'start', fontSize: 13 }}>
        {messages.map((m) => (
          <p key={m.id} style={{ margin: 0, color: m.direct ? '#ffd9a0' : '#dcecf7' }}>
            <button
              type="button"
              onClick={() => setTo(m.mine ? '' : m.fromId)}
              title={m.mine ? 'You' : `Direct message ${m.from ?? 'this player'}`}
              style={{
                background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                color: '#7fe7ff', font: 'inherit',
              }}
            >
              {m.mine ? 'you' : (m.from ?? 'someone')}
            </button>
            {m.direct ? ' (direct) ' : ' '}
            {m.body}
          </p>
        ))}
        {!messages.length && <p style={{ margin: 0, color: '#7fa4bd' }}>Nothing said yet.</p>}
      </div>

      <div style={{ display: 'grid', gap: 6 }}>
        <select
          value={to}
          onChange={(e) => setTo(e.target.value)}
          aria-label="Send to"
          style={{ ...field, flex: 'none' }}
        >
          <option value="">Everyone in this server</option>
          {/* Only players ACTIVE in this server right now, which is what 7e asks
              for: "direct messages to selected active players". The roster comes
              from `server_presence` joined to approved membership, so a removed
              member's stale heartbeat is not addressable. */}
          {page.active.map((a) => (
            <option key={a.playerId} value={a.playerId}>
              {a.handle ?? 'a player'}
            </option>
          ))}
        </select>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            style={field}
            value={draft}
            maxLength={page.max ?? 400}
            placeholder={to ? 'Direct message…' : 'Say something…'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button type="button" style={btn} onClick={() => void send()}>Send</button>
        </div>
        {note && <span style={{ color: '#ffb4b4', fontSize: 12 }} role="alert">{note}</span>}
      </div>
    </section>
  );
}
