/**
 * Bug report panel. Opened from the Esc pause hub; Esc closes it.
 *
 * Auto-populates world, player position and player handle from live state.
 * Submits a POST to /api/bug-report which emails the report to markc@cayc.io.
 *
 * Pattern follows AudioMenu / HelpMenu: owns its own keydown listener,
 * emits `bug-report:open` / `bug-report:close` bus events so main.js can
 * gate gameplay while the panel is open.
 *
 * ── /api/bug-report now needs a session, and a 401 is not a network error ──
 *
 * The endpoint used to be an unauthenticated mail relay; it now refuses a
 * request with no session, answering `401 {"error":"Sign in first."}`. This
 * client had one failure branch for every non-2xx status, so that refusal
 * surfaced as three words in a red status line with nothing to act on — and a
 * player who has just typed out a repro has no idea whether to retype it, wait,
 * or give up.
 *
 * A 401 gets its own handling for two reasons that are not the same reason:
 *
 *   1. It is the one failure the PLAYER can fix, so it has to carry the thing
 *      that fixes it — a sign-in link, opened in a NEW TAB, because this panel
 *      lives inside the game iframe and navigating it away would end the
 *      session the report is about.
 *   2. The description must survive it. `_submit` only clears the textarea on
 *      success, and the 401 path deliberately leaves the submit button enabled
 *      so pressing it again after signing in sends the same text.
 *
 * `player:identity` is the only signal main.js gives the UI about the account —
 * it fires from `hydrateAccountSession` once `/api/game/session` has answered
 * with a handle, which it always carries for a signed-in player. Its ABSENCE is
 * not proof of anything, though: the fetch has an eight-second fuse and this
 * panel can be opened before it lands. So it is used as a positive signal only,
 * and the definitive answer is the 401 itself.
 */

import './bug-report.css';

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export class BugReport {
  /**
   * @param {{ root: HTMLElement, bus: import('../core/Bus.js').Bus,
   *            input: object, player: object, worldManager: object }} opts
   */
  constructor({ root, bus, input, player, worldManager }) {
    this.bus          = bus;
    this.input        = input;
    this.player       = player;
    this.worldManager = worldManager;

    this._open       = false;
    this._submitting = false;

    this._handle = 'anonymous';
    this._worldLabel = '—';

    /* Positive-only. True once the account has answered; never set false,
     * because "we have not heard yet" and "signed out" look identical from
     * here and only one of them is worth telling the player about. */
    this._signedIn = false;
    /* Set by a 401 and kept for the rest of the session, so the notice is up
     * BEFORE the second report is typed rather than after it is thrown away. */
    this._signedOut = false;
    /* A description that was written, refused for want of a session, and then
     * closed. `open()` clears the textarea unconditionally, so without this the
     * notice's "nothing you have typed is lost" would be false the moment the
     * player pressed Esc to go and sign in. Only a REFUSED report is kept — an
     * abandoned one is abandoned. */
    this._draft = '';

    // Pick up player identity when it is broadcast on boot
    this._offIdentity = bus?.on('player:identity', ({ handle }) => {
      this._signedIn = true;
      this._signedOut = false;
      if (handle) this._handle = handle;
    });
    this._offWorld = bus?.on('world:changed', ({ world, id }) => {
      const next = world?.displayName || world?.name || world?.id || id || '—';
      this._worldLabel = String(next);
      if (this._worldVal) this._worldVal.textContent = this._worldLabel;
    });

    this._build(root);

    this._onKey = (e) => {
      const code = e.code || e.key;
      if (code === 'Escape' && this._open) {
        e.stopPropagation();
        this.close();
      }
    };
    window.addEventListener('keydown', this._onKey, true);
  }

  /* ================================================================== */
  /* Build DOM                                                           */
  /* ================================================================== */

  _build(root) {
    const wrap = el('div', 'br-root');

    const panel = el('div', 'br-panel');

    // Header
    const head = el('div', 'br-head');
    const title = el('div', 'br-title');
    title.append('⚑ Bug Report');
    const titleKey = el('span', 'br-title-key', '(Esc menu → Report a bug)');
    title.append(' ', titleKey);
    const closeBtn = el('button', 'br-close-btn', 'Close');
    closeBtn.addEventListener('click', () => this.close());
    head.append(title, closeBtn);

    // Context strip
    const ctx = el('div', 'br-context');

    const wf = el('div', 'br-ctx-field');
    wf.append(el('div', 'br-ctx-label', 'World'));
    this._worldVal = el('div', 'br-ctx-value', '—');
    wf.append(this._worldVal);

    const pf = el('div', 'br-ctx-field');
    pf.append(el('div', 'br-ctx-label', 'Position'));
    this._posVal = el('div', 'br-ctx-value', '—');
    pf.append(this._posVal);

    const hf = el('div', 'br-ctx-field');
    hf.append(el('div', 'br-ctx-label', 'Player'));
    this._handleVal = el('div', 'br-ctx-value', '—');
    hf.append(this._handleVal);

    ctx.append(wf, pf, hf);

    // Body
    const body = el('div', 'br-body');
    body.append(el('div', 'br-label', 'Describe the bug'));
    this._textarea = el('textarea', 'br-textarea');
    this._textarea.placeholder = 'What happened? What did you expect to happen? Include steps to reproduce if possible.';
    body.append(this._textarea);

    /* The signed-out notice. Styled inline rather than in `bug-report.css`
     * because it borrows the amber the panel already declares as `--br-amber`
     * and needs no state of its own beyond `display`. Hidden until a 401 says
     * otherwise — a warning shown to every player on every open would be wrong
     * for all but a handful of them. */
    this._authNotice = el('div', 'br-auth-notice');
    Object.assign(this._authNotice.style, {
      display: 'none',
      marginTop: '12px',
      padding: '10px 12px',
      border: '1px solid rgba(255,180,74,.55)',
      borderRadius: '4px',
      background: 'rgba(48,32,8,.5)',
      color: '#ffdca6',
      fontSize: '.85rem',
      lineHeight: '1.5',
    });
    this._authNotice.append(
      'Reports are filed against your account, so you have to be signed in — '
      + 'that way we can write back about what you found. Nothing you have typed '
      + 'is lost: sign in, come back to this tab, and press Submit Report again.'
    );
    const signInLink = document.createElement('a');
    /* A NEW TAB. This panel is inside the game iframe, and navigating it to a
     * sign-in page would take the running session — the one the bug is in —
     * with it. */
    signInLink.href = '/login?callbackUrl=%2Fplay';
    signInLink.target = '_blank';
    signInLink.rel = 'noopener noreferrer';
    signInLink.textContent = 'Sign in (opens a new tab) →';
    Object.assign(signInLink.style, {
      display: 'inline-block',
      marginTop: '8px',
      color: 'var(--br-cy)',
      textDecoration: 'underline',
    });
    this._authNotice.append(document.createElement('br'), signInLink);
    body.append(this._authNotice);

    // Footer
    const foot = el('div', 'br-foot');
    this._status = el('div', 'br-status', '');
    this._submitBtn = el('button', 'br-btn br-btn-submit', 'Submit Report');
    this._submitBtn.addEventListener('click', () => this._submit());
    const cancelBtn = el('button', 'br-btn br-btn-cancel', 'Cancel');
    cancelBtn.addEventListener('click', () => this.close());
    foot.append(this._status, cancelBtn, this._submitBtn);

    panel.append(head, ctx, body, foot);
    wrap.appendChild(panel);
    root.appendChild(wrap);

    // Prevent click-through to the game world
    panel.addEventListener('mousedown', (e) => e.stopPropagation());
    panel.addEventListener('click',     (e) => e.stopPropagation());

    this.el = wrap;
  }

  /* ================================================================== */
  /* State                                                               */
  /* ================================================================== */

  open() {
    if (this._open) return;
    this._open = true;
    this.input?.exitLock?.();

    // Snapshot current context
    const world = this._worldLabel
               || this.worldManager?.active?.displayName
               || this.worldManager?.activeWorld?.name
               || this.worldManager?.activeWorld?.displayName
               || this.worldManager?.currentWorld
               || '—';
    const pos = this.player?.position;
    const posStr = pos
      ? `${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}`
      : '—';

    this._worldVal.textContent  = world;
    this._posVal.textContent    = posStr;
    this._handleVal.textContent = this._handle;

    // Stash these for submission
    this._snapshotWorld  = world;
    this._snapshotPos    = posStr;
    this._snapshotHandle = this._handle;

    // Reset form state — restoring a refused draft if there is one. @see _draft
    this._textarea.value = this._draft;
    this._draft = '';
    this._setStatus('', '');
    this._submitBtn.disabled = false;
    /* Carried over from a previous refusal in the same session. Shown before
     * the description is typed rather than after it is submitted, which is the
     * whole value of remembering it. */
    this._setAuthNotice(this._signedOut);
    if (this._signedOut) {
      this._setStatus('Sign in to file a report.', 'err');
    }

    this.el.classList.add('open');
    this.bus?.emit('bug-report:open');

    // Focus after the transition delay so it doesn't fight the game
    setTimeout(() => this._textarea.focus(), 80);
  }

  close() {
    if (!this._open) return;
    this._open = false;
    /* Only what the server refused for want of a session. Going away to sign in
     * means pressing Esc, and losing the report to that is the failure this
     * whole branch exists to avoid. @see _draft */
    if (this._signedOut && this._textarea.value.trim()) this._draft = this._textarea.value;
    this.el.classList.remove('open');
    this.bus?.emit('bug-report:close');
  }

  toggle() {
    if (this._open) this.close();
    else this.open();
  }

  /** Called every frame from main.js so the panel can stay responsive.
   *  No per-frame work needed, but method kept for consistency. */
  update() {}

  dispose() {
    window.removeEventListener('keydown', this._onKey, true);
    this._offIdentity?.();
    this._offWorld?.();
    this.el.remove();
  }

  /* ================================================================== */
  /* Submit                                                              */
  /* ================================================================== */

  _setStatus(msg, type = '') {
    this._status.textContent = msg;
    this._status.className   = 'br-status' + (type ? ` ${type}` : '');
  }

  _setAuthNotice(show) {
    if (this._authNotice) this._authNotice.style.display = show ? 'block' : 'none';
  }

  async _submit() {
    const description = this._textarea.value.trim();
    if (!description) {
      this._setStatus('Please describe the bug before submitting.', 'err');
      this._textarea.focus();
      return;
    }

    this._submitting       = true;
    this._submitBtn.disabled = true;
    this._setStatus('Sending…', '');

    try {
      const res = await fetch('/api/bug-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          world:       this._snapshotWorld,
          position:    this._snapshotPos,
          handle:      this._snapshotHandle,
          description,
        }),
      });

      if (res.ok) {
        this._signedIn = true;
        this._signedOut = false;
        this._setAuthNotice(false);
        this._setStatus('Report sent — thank you!', 'ok');
        this._textarea.value = '';
        setTimeout(() => this.close(), 1800);
      } else if (res.status === 401) {
        /* The route's own text here is "Sign in first." — accurate and no use
         * on its own. The notice below it carries the link and the promise that
         * the description is still in the box, and the button stays enabled so
         * that promise is true. */
        this._signedOut = true;
        this._setAuthNotice(true);
        this._setStatus('You need to be signed in to file a report.', 'err');
        this._submitBtn.disabled = false;
      } else {
        const data = await res.json().catch(() => ({}));
        this._setStatus(data?.error ?? 'Submission failed. Please try again.', 'err');
        this._submitBtn.disabled = false;
      }
    } catch {
      this._setStatus('Network error. Please try again.', 'err');
      this._submitBtn.disabled = false;
    } finally {
      this._submitting = false;
    }
  }
}

export default BugReport;
