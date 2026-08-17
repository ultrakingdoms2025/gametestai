/**
 * Bug report panel. Opened from the Esc pause hub; Esc closes it.
 *
 * Auto-populates world, player position and player handle from live state.
 * Submits a POST to /api/bug-report which emails the report to markc@cayc.io.
 *
 * Pattern follows AudioMenu / HelpMenu: owns its own keydown listener,
 * emits `bug-report:open` / `bug-report:close` bus events so main.js can
 * gate gameplay while the panel is open.
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

    // Pick up player identity when it is broadcast on boot
    this._offIdentity = bus?.on('player:identity', ({ handle }) => {
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

    // Reset form state
    this._textarea.value = '';
    this._setStatus('', '');
    this._submitBtn.disabled = false;

    this.el.classList.add('open');
    this.bus?.emit('bug-report:open');

    // Focus after the transition delay so it doesn't fight the game
    setTimeout(() => this._textarea.focus(), 80);
  }

  close() {
    if (!this._open) return;
    this._open = false;
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
        this._setStatus('Report sent — thank you!', 'ok');
        this._textarea.value = '';
        setTimeout(() => this.close(), 1800);
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
