/**
 * ChatPanel — the server's chat and roster, inside the game.
 *
 * ── The gap this closes ───────────────────────────────────────────────────
 *
 * `site/lib/serverChat.ts` has been a complete chat since Phase 7e: membership
 * checked on send AND on read, direct messages, a 400-character cap, cursor
 * paging, a rate limit. `site/lib/customServers.ts` has a live roster on a
 * 120-second presence window. `/api/game/chat` serves both.
 *
 * And `src/` never called it. Not once. The game was told who was online by
 * `/api/game/session` and rendered none of them, so the only chat a player
 * could reach was `ServerChatPanel.tsx` on the site shell — which names its own
 * cost in a comment: "a player in pointer lock has to release it to type. That
 * is a real friction and the fix is an in-game panel." This is that panel. It
 * is a client for an endpoint that already existed; it adds no route, no table
 * and no transport.
 *
 * ── WHAT THIS IS NOT, AND THE SENTENCE IS LOAD-BEARING ────────────────────
 *
 * There is no multiplayer netcode in this game and this panel does not imply
 * any. Nobody's avatar is streamed, nobody's position is sent, and two members
 * of the same server standing in the same world still cannot see each other —
 * `customServers.ts` states that plainly and nothing here changes it. What is
 * shared is a message log in Postgres and a list of who has polled recently.
 *
 * Everything is plain HTTP on an interval. A message arrives on the next poll,
 * which is up to `POLL_OPEN_MS` after it was sent, and the footer says so in
 * words rather than letting a player infer a liveness the transport cannot
 * deliver. Vercel functions cannot hold a socket, so this is not a compromise
 * against a better design that was available — it is the delivery mechanism the
 * architecture leaves, and for chat it is sufficient.
 *
 * ── Presence gets more honest as a side effect ────────────────────────────
 *
 * `touchPresence` fires on every chat GET, so before this file the "who is
 * online" list meant "who has the website open". A background heartbeat here
 * (`POLL_IDLE_MS`, comfortably inside the 120-second window) means it starts to
 * mean "who is in the game". That heartbeat is the ONLY reason the panel polls
 * while closed; it is not a notification system, and it stops permanently the
 * moment the server answers "you are signed out" or "you are in no server",
 * because a poll that can never carry anything is a request nobody should pay
 * for.
 *
 * ── Open/close discipline: copied from RecordsPanel, deliberately ─────────
 *
 * The order in `open()` is the one the pause-menu work paid for: `ui:modal`
 * FIRST so this panel is already in `HUD._overlays` when the lock release lands
 * `input:lockchange` and `showPauseOverlay` is asked for — it refuses while the
 * Set is non-empty — then the body class, then the lock.
 *
 * And it CLOSES ON A BUTTON, not only on Escape. `input.exitLock()` stands the
 * touch session down, which takes the whole touch tray with it including the
 * pause button; a panel reachable only by a key a phone does not have is a dead
 * end that needs a page reload to escape, and this repository has shipped that
 * dead end twice. `.chp-close` is a real on-screen control, sized for a thumb.
 */

import './chat-panel.css';

/** How often to poll while the panel is open. */
export const POLL_OPEN_MS = 6000;
/**
 * How often to poll while it is shut.
 *
 * Well inside `PRESENCE_WINDOW_SECONDS` (120) so a player who is in the game
 * reads as present without the window ever lapsing between beats, and slow
 * enough that a session costs about eighty requests an hour rather than six
 * hundred. It is a heartbeat, not a subscription.
 */
export const POLL_IDLE_MS = 45000;

/** Lines kept in the scrollback. The endpoint pages; this is the view's cap. */
const MAX_ROWS = 150;

/** Give up the background heartbeat after this many transport failures. */
const MAX_FAILS = 3;

/** Mirrors `CHAT_BODY_MAX` in `site/lib/serverChat.ts`; the server re-clamps. */
const BODY_MAX = 400;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/** `HH:MM` from the server's timestamp, or '' when it is unparseable. */
function stamp(at) {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export class ChatPanel {
  /**
   * @param {{ root: HTMLElement, bus?: any, input?: any,
   *           api?: string, fetchImpl?: typeof fetch,
   *           pollOpenMs?: number, pollIdleMs?: number,
   *           autoStart?: boolean }} ctx
   *   `api`, `fetchImpl` and the two intervals exist for the tests, which point
   *   the client at a real local HTTP server rather than stubbing the transport
   *   — the same arrangement `RecordsPanel` uses, cookie and all.
   */
  constructor({
    root, bus, input, api = '', fetchImpl,
    pollOpenMs = POLL_OPEN_MS, pollIdleMs = POLL_IDLE_MS, autoStart = true,
  } = {}) {
    this.root = root;
    this.bus = bus ?? null;
    this.input = input ?? null;
    this.api = api;
    this._fetch = fetchImpl ?? ((...a) => globalThis.fetch(...a));
    this._pollOpenMs = pollOpenMs;
    this._pollIdleMs = pollIdleMs;

    this._open = false;
    this._hadLock = false;

    /** @type {'idle'|'loading'|'signedout'|'noserver'|'offline'|'ready'} */
    this._state = 'idle';
    /** Last message id held. The server's cursor, never a timestamp. */
    this._cursor = 0;
    /** @type {Array<{id:number, from:string, fromId:string, direct:boolean, mine:boolean, body:string, at:string}>} */
    this._messages = [];
    /** @type {Array<{playerId:string, handle:string|null}>} */
    this._active = [];
    /** Current direct-message target, or null for a shout. */
    this._dm = null;
    /** Consecutive transport failures; see MAX_FAILS. */
    this._fails = 0;
    /** One in-flight poll at a time. A second would reorder the cursor. */
    this._polling = false;
    this._timer = null;
    this._sending = false;
    /**
     * Set by `dispose()`, checked by `_schedule`.
     *
     * A flag rather than relying on `dispose()` clearing `_timer`, because
     * clearing is not enough: `_poll()` re-arms the chain from its own
     * `finally`, so a `dispose()` that lands while a request is in flight
     * clears a timer that the settling request then puts straight back. The
     * panel is gone, its DOM is gone, and it polls for ever.
     *
     * Found by breaking the terminal-state guard on purpose to check that the
     * gate for it could fail: the mutation turned the test run into an infinite
     * poll against a closed server and the runner never exited. That was a
     * mutation, not the shipped path — but the leak it exposed is real on the
     * shipped path too, one `dispose()` during a poll away.
     */
    this._disposed = false;

    this._el = this._build();
    root?.appendChild(this._el);

    /* Window-level, capture phase — the same pattern and the same reason as
     * RecordsPanel's N and QuestBoard's J: `Input` stops reporting while a
     * panel owns the keyboard, which is exactly when the close key has to keep
     * working, so panel keys own their listeners and stay off `BINDABLE`.
     *
     * Y OPENS ONLY. It deliberately does not toggle: this panel captures text,
     * so a key that also closed it would close the panel every time somebody
     * typed the letter y into the message field. Closing is Escape or the
     * button, which is the pair a phone can reach. */
    this._onWindowKey = (e) => {
      if (e.code === 'Escape') {
        if (this._open) {
          e.preventDefault();
          e.stopPropagation();
          this.close();
        }
        return;
      }
      if (e.code !== 'KeyY' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (this._open || this.input?.textCaptured) return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      e.stopPropagation();
      this.open();
    };
    window.addEventListener('keydown', this._onWindowKey, true);

    /* The background heartbeat. Deferred off the boot path: the first poll is
     * one interval away rather than immediate, because boot already has a
     * session fetch, a map-overlay fetch and a multi-second surface warm
     * competing for the same connection, and a presence beat is the least
     * urgent thing in that queue. */
    if (autoStart) this._schedule(this._pollIdleMs);
  }

  get isOpen() { return this._open; }
  /** Exposed for the tests and for anything that wants to explain the state. */
  get state() { return this._state; }

  /* ------------------------------------------------------------------ */
  /* Open / close                                                        */
  /* ------------------------------------------------------------------ */

  open() {
    if (this._open) return;
    this._open = true;

    /* ORDER IS LOAD-BEARING, and it is RecordsPanel's order for RecordsPanel's
     * reason: `ui:modal` first, so this panel is already in `HUD._overlays`
     * when the lock release below lands `input:lockchange` and main.js asks for
     * the standby overlay — `showPauseOverlay` refuses while the Set is
     * non-empty. Emitted before the body class for the same reason: the class
     * only styles, the Set decides. */
    this.bus?.emit('ui:modal', { id: 'chat-panel', open: true });
    document.body.classList.add('chat-panel-open');
    this._hadLock = !!this.input?.locked;
    /* Text capture BEFORE the lock goes, so a WASD keystroke in the gap cannot
     * walk the player, and so `Input.pressed` reports nothing to the poll loop
     * while the field has focus. */
    this.input?.setTextCapture?.(true);
    this.input?.exitLock?.();

    this._el.classList.add('open');
    this._render();
    this._schedule(0);
    /* Focus after the class lands, so the browser scrolls a visible element
     * into view rather than a hidden one. `preventScroll` because the panel is
     * fixed and the page behind it must not move under the canvas. */
    setTimeout(() => { if (this._open) this.field?.focus({ preventScroll: true }); }, 0);
  }

  close() {
    if (!this._open) return;
    this._open = false;
    this._el.classList.remove('open');
    document.body.classList.remove('chat-panel-open');
    this.input?.setTextCapture?.(false);

    const hadLock = this._hadLock;
    this._hadLock = false;
    if (hadLock) {
      /* Delayed, and through `reengage()` — the pointer lock on a mouse
       * session, the touch session on a phone. Browsers refuse a lock request
       * that follows an Escape-driven exit too closely; every sibling panel
       * records the same 140 ms answer. */
      setTimeout(() => {
        const p = this.input?.reengage?.();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }, 140);
    }
    this.bus?.emit('ui:modal', { id: 'chat-panel', open: false });
    // Back to the heartbeat rate, or to nothing if the channel is closed to us.
    this._schedule(this._pollIdleMs);
  }

  toggle() {
    if (this._open) this.close();
    else this.open();
  }

  /** Present for symmetry with the other panels; this one is timer driven. */
  update() {}

  dispose() {
    /* The flag goes up FIRST, before `close()` — which calls `_schedule` on its
     * way out — so the shutdown cannot re-arm the thing it is shutting down. */
    this._disposed = true;
    this.close();
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    window.removeEventListener('keydown', this._onWindowKey, true);
    this._el.remove?.();
  }

  /* ------------------------------------------------------------------ */
  /* Build                                                               */
  /* ------------------------------------------------------------------ */

  _build() {
    const rootEl = el('div', 'chp-root');
    const panel = el('div', 'chp-panel');
    rootEl.appendChild(panel);

    const head = el('div', 'chp-header');
    head.appendChild(el('div', 'chp-title', 'SERVER CHANNEL'));
    this.scopeEl = el('div', 'chp-scope', '');
    head.appendChild(this.scopeEl);
    /* A real button, not only a key. See the header: `exitLock` takes the touch
     * tray with it, so Escape-only would be a dead end on a phone. */
    this.closeBtn = el('button', 'chp-close', '✕');
    this.closeBtn.type = 'button';
    this.closeBtn.title = 'Close [Esc]';
    this.closeBtn.setAttribute('aria-label', 'Close chat');
    this.closeBtn.addEventListener('click', () => this.close());
    head.appendChild(this.closeBtn);
    panel.appendChild(head);

    const body = el('div', 'chp-body');
    panel.appendChild(body);

    const main = el('div', 'chp-main');
    body.appendChild(main);
    this.logEl = el('div', 'chp-log');
    main.appendChild(this.logEl);

    const compose = el('form', 'chp-compose');
    compose.addEventListener('submit', (e) => { e.preventDefault(); this._send(); });
    this.toEl = el('button', 'chp-to', 'Everyone');
    this.toEl.type = 'button';
    this.toEl.title = 'Send to everyone in this server';
    this.toEl.addEventListener('click', () => { this._dm = null; this._renderCompose(); });
    compose.appendChild(this.toEl);
    this.field = el('input', 'chp-field');
    this.field.type = 'text';
    this.field.maxLength = BODY_MAX;
    this.field.placeholder = 'Say something…';
    this.field.setAttribute('aria-label', 'Message');
    /* Keystrokes stop here. `Input` is text-captured while the panel is open,
     * but the window-level Escape listener above is in the CAPTURE phase and
     * would otherwise never see a key the field swallowed — and every other
     * panel's window listener would see the ones it does not. */
    this.field.addEventListener('keydown', (e) => e.stopPropagation());
    compose.appendChild(this.field);
    this.sendBtn = el('button', 'chp-send', 'SEND');
    this.sendBtn.type = 'submit';
    compose.appendChild(this.sendBtn);
    main.appendChild(compose);

    this.noticeEl = el('div', 'chp-notice', '');
    main.appendChild(this.noticeEl);

    const side = el('div', 'chp-side');
    body.appendChild(side);
    side.appendChild(el('div', 'chp-sec-title', 'IN THE GAME'));
    this.rosterEl = el('div', 'chp-roster');
    side.appendChild(this.rosterEl);
    side.appendChild(el('div', 'chp-roster-note',
      'Seen in the last two minutes. Nobody is visible in the world — this game '
      + 'has no shared world instance, only a shared channel.'));

    panel.appendChild(el('div', 'chp-footer',
      `Messages arrive when this panel polls, about every ${Math.round(POLL_OPEN_MS / 1000)} seconds. `
      + 'Esc or ✕ to close.'));

    return rootEl;
  }

  /* ------------------------------------------------------------------ */
  /* Polling                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Arm the next poll, replacing any pending one.
   *
   * `setTimeout` chained from the completion of each poll rather than
   * `setInterval`: an interval fires on a schedule that knows nothing about
   * whether the last request came back, so a slow link stacks requests and the
   * cursor arrives out of order. `_polling` is the second half of that guard.
   *
   * A terminal state disarms permanently. There is no chat to poll for a player
   * who is signed out or in no server, and a request that can never carry
   * anything is one nobody should pay for.
   */
  _schedule(delay) {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    /* Nothing re-arms a disposed panel — not `close()`, and not the `finally`
     * of a request that was already in flight when it went. See `_disposed`. */
    if (this._disposed) return;
    if (this._state === 'signedout' || this._state === 'noserver') return;
    if (this._fails >= MAX_FAILS && !this._open) return;
    this._timer = setTimeout(() => { this._timer = null; this._poll(); }, Math.max(0, delay));
  }

  /** One GET. Also the presence heartbeat — the endpoint touches it on read. */
  async _poll() {
    if (this._polling) return;
    this._polling = true;
    if (this._state === 'idle') this._state = 'loading';
    try {
      const res = await this._fetch(
        `${this.api}/api/game/chat?since=${this._cursor}&limit=60`,
        { cache: 'no-store' },
      );
      if (res.status === 401 || res.status === 403) {
        this._state = 'signedout';
        return;
      }
      if (!res.ok) throw new Error(`http ${res.status}`);
      const page = await res.json();
      this._fails = 0;

      if (!page?.serverId) {
        /* Default mode. Not an error — there is no global channel by design —
         * and not a state to keep polling in. */
        this._state = 'noserver';
        this._active = [];
        return;
      }

      this._serverId = String(page.serverId);
      this._state = 'ready';
      this._active = Array.isArray(page.active) ? page.active : [];
      const arrived = Array.isArray(page.messages) ? page.messages : [];
      if (arrived.length) {
        this._messages = [...this._messages, ...arrived].slice(-MAX_ROWS);
      }
      /* The cursor moves only forward and only to what the server said. Taking
       * `max(local, server)` rather than assigning would paper over a server
       * that rewound, which is a bug worth seeing rather than surviving. */
      const cursor = Number(page.cursor);
      if (Number.isFinite(cursor) && cursor > 0) this._cursor = cursor;

      /* A DM target who has gone quiet cannot receive one: the send would be
       * refused with `no_recipient`. Drop the target rather than let the
       * compose row claim an address that no longer resolves. */
      if (this._dm && !this._active.some((a) => a.playerId === this._dm.id)) this._dm = null;
    } catch (err) {
      this._fails++;
      this._state = 'offline';
      this._why = err?.message ?? 'unreachable';
    } finally {
      this._polling = false;
      this._render();
      this._schedule(this._open ? this._pollOpenMs : this._pollIdleMs);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Sending                                                             */
  /* ------------------------------------------------------------------ */

  async _send() {
    if (this._sending) return;
    const body = String(this.field?.value ?? '').trim();
    if (!body) return;
    if (this._state !== 'ready') {
      this._notice(this._stateSentence());
      return;
    }

    this._sending = true;
    this.sendBtn.disabled = true;
    try {
      const res = await this._fetch(`${this.api}/api/game/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ body, to: this._dm?.id ?? null }),
      });
      if (res.status === 401 || res.status === 403) {
        /* 403 here is a membership answer, not an auth one — `sendChat` returns
         * `forbidden` when the caller has been removed between two polls. Both
         * mean this channel is closed to us now, and the honest thing is to say
         * so rather than to leave the field looking live. */
        this._state = res.status === 401 ? 'signedout' : 'noserver';
        this._notice(this._stateSentence());
        return;
      }
      const out = await res.json().catch(() => null);
      if (!res.ok) {
        this._notice(out?.error ?? `Could not send that (http ${res.status}).`);
        return;
      }
      this.field.value = '';
      this._notice('');
      // Pick the message up immediately rather than on the next tick of the
      // interval: the sender seeing their own line land is the one bit of this
      // channel that should not wait for a poll.
      this._schedule(0);
    } catch {
      this._notice('Could not reach the channel. Nothing was sent.');
    } finally {
      this._sending = false;
      this.sendBtn.disabled = false;
    }
  }

  _notice(text) {
    if (this.noticeEl) this.noticeEl.textContent = text ?? '';
  }

  /* ------------------------------------------------------------------ */
  /* Render                                                              */
  /* ------------------------------------------------------------------ */

  /** The one sentence that explains a non-ready state. Never a blank region. */
  _stateSentence() {
    switch (this._state) {
      case 'signedout':
        return 'Signed out — the channel is your server\'s, so it needs the account that '
          + 'is a member of it. Sign in on the site. Nothing else in the game is affected.';
      case 'noserver':
        return 'You are not in a custom server, and there is no global channel by design. '
          + 'Join or create one on the site and the channel opens here.';
      case 'offline':
        return `The channel did not answer (${this._why ?? 'unreachable'}). `
          + 'Everything else in the game is unaffected; it will try again.';
      case 'loading':
      case 'idle':
        return 'Opening the channel…';
      default:
        return '';
    }
  }

  _render() {
    if (!this._el) return;
    this._renderLog();
    this._renderRoster();
    this._renderCompose();
    if (this.scopeEl) {
      this.scopeEl.textContent = this._state === 'ready'
        ? `${this._active.length} in the game`
        : '';
    }
  }

  _renderLog() {
    const host = this.logEl;
    if (!host) return;
    host.textContent = '';

    if (this._state !== 'ready') {
      host.appendChild(el('div', 'chp-empty', this._stateSentence()));
      return;
    }
    if (!this._messages.length) {
      host.appendChild(el('div', 'chp-empty',
        'Nothing said yet. Anyone in this server sees what you type here.'));
      return;
    }

    for (const m of this._messages) {
      const row = el('div', 'chp-line');
      if (m.mine) row.classList.add('mine');
      if (m.direct) row.classList.add('direct');
      const time = stamp(m.at);
      if (time) row.appendChild(el('span', 'chp-time', time));
      row.appendChild(el('span', 'chp-from', m.mine ? 'you' : (m.from ?? 'unknown')));
      if (m.direct) row.appendChild(el('span', 'chp-dm-tag', 'DM'));
      row.appendChild(el('span', 'chp-body-text', m.body ?? ''));
      host.appendChild(row);
    }
    // Newest at the bottom, which is where a reader's eye already is.
    host.scrollTop = host.scrollHeight;
  }

  _renderRoster() {
    const host = this.rosterEl;
    if (!host) return;
    host.textContent = '';
    if (this._state !== 'ready') return;
    if (!this._active.length) {
      host.appendChild(el('div', 'chp-empty', 'Nobody else has checked in recently.'));
      return;
    }
    for (const a of this._active) {
      const name = a.handle ?? 'unknown';
      const row = el('button', 'chp-who', name);
      row.type = 'button';
      row.title = `Send a direct message to ${name}`;
      if (this._dm?.id === a.playerId) row.classList.add('selected');
      row.addEventListener('click', () => {
        this._dm = this._dm?.id === a.playerId ? null : { id: a.playerId, name };
        this._renderRoster();
        this._renderCompose();
        this.field?.focus({ preventScroll: true });
      });
      host.appendChild(row);
    }
  }

  _renderCompose() {
    if (!this.toEl || !this.field) return;
    this.toEl.textContent = this._dm ? `→ ${this._dm.name}` : 'Everyone';
    this.toEl.classList.toggle('dm', !!this._dm);
    this.toEl.title = this._dm
      ? `Direct message to ${this._dm.name} — click to send to everyone instead`
      : 'Send to everyone in this server';
    this.field.placeholder = this._dm ? `Message ${this._dm.name}…` : 'Say something…';
    const usable = this._state === 'ready';
    this.field.disabled = !usable;
    this.sendBtn.disabled = !usable || this._sending;
  }
}

export default ChatPanel;
