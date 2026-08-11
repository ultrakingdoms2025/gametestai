/**
 * NPC conversation panel.
 *
 * Owns the scrollback, the text field and the streaming render. It does *not*
 * own pointer-lock or key routing — the HUD decides when a conversation opens
 * and hands control here, because lock state is a global concern.
 */

const MAX_MESSAGES = 60;

/** Deterministic 32-bit hash so an NPC always gets the same sigil and hue. */
function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function stamp() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export class ChatBox {
  /**
   * @param {{ root: HTMLElement, bus: any, input: any, client: any,
   *           worldManager: any, onClose?: Function }} ctx
   */
  constructor({ root, bus, input, client, worldManager, onClose }) {
    this.bus = bus;
    this.input = input;
    this.client = client;
    this.worldManager = worldManager;
    this._onClose = onClose;

    this._open = false;
    this._npc = null;
    this._busy = false;
    this._abort = null;
    this._streamNode = null;
    this._caret = null;
    this._typing = null;

    this._build(root);
  }

  get isOpen() {
    return this._open;
  }

  get npc() {
    return this._npc;
  }

  /* --------------------------------------------------------------- build -- */

  _build(root) {
    const box = el('div', 'chat interactive');

    const head = el('div', 'chat-head');
    this.sigil = document.createElement('canvas');
    this.sigil.className = 'chat-sigil';
    this.sigil.width = 80;
    this.sigil.height = 80;

    const id = el('div', 'chat-id');
    this.nameEl = el('div', 'chat-name', 'UNKNOWN');
    this.subEl = el('div', 'chat-sub', 'no signal');
    id.append(this.nameEl, this.subEl);

    this.badge = el('div', 'chat-badge', 'offline persona');
    this.badge.title = 'The AI backend is unreachable — replies are generated locally from this character’s persona.';

    const close = el('button', 'chat-close', 'ESC');
    close.type = 'button';
    close.addEventListener('click', () => this.close());

    head.append(this.sigil, id, this.badge, close);

    this.log = el('div', 'chat-log');

    const row = el('div', 'chat-inrow');
    row.append(el('span', 'chat-caretglyph', '›'));

    this.field = document.createElement('input');
    this.field.className = 'chat-input';
    this.field.type = 'text';
    this.field.maxLength = 240;
    this.field.autocomplete = 'off';
    this.field.spellcheck = false;
    this.field.placeholder = 'Say something…';

    this.sendBtn = el('button', 'chat-send', 'SEND');
    this.sendBtn.type = 'button';
    this.sendBtn.addEventListener('click', () => this._submit());

    row.append(this.field, this.sendBtn);

    const hint = el('div', 'chat-hint');
    hint.append(el('span', null, 'Enter — send'), el('span', null, 'Esc — close'));

    box.append(head, this.log, row, hint);
    root.appendChild(box);
    this.el = box;

    // The field owns Enter/Escape while focused.
    this.field.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        this._submit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    });
    // Window-level Escape so closing works even when the text field isn't
    // focused (e.g. the player clicked the chat log to scroll it).
    this._onWindowKey = (e) => {
      if (this._open && e.code === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    };
    window.addEventListener('keydown', this._onWindowKey, true);
    // Stop stray clicks inside the panel from re-requesting pointer lock.
    box.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  /* ---------------------------------------------------------------- open -- */

  open(npc) {
    if (this._open) return;
    this._open = true;
    this._npc = npc ?? null;
    this.el.classList.add('open');
    this._refreshHeader();

    const firstTime = npc && !this._greeted(npc);

    if (firstTime) {
      this._systemLine(`Channel open — ${npc.name ?? 'unknown contact'}`);
    }

    // Lorekeepers: immediately display the world lore text on first open
    // so the player sees the lore without having to ask for it.
    if (firstTime && npc?.isLorekeeper && npc.loreBody) {
      const speaker = (npc.name ?? 'LOREKEEPER').toUpperCase();
      if (npc.loreTitle) {
        this._row('sys', 'NEXUS', `— ${npc.loreTitle} —`);
      }
      this._row('npc', speaker, npc.loreBody);
      this._systemLine('Ask me anything about this world or the Nexus.');
    }

    this.field.value = '';
    this.field.disabled = false;
    this.sendBtn.disabled = false;
    // Focus after the transition starts so the caret does not jump the layout.
    requestAnimationFrame(() => this.field.focus({ preventScroll: true }));
    this._scroll();
    this.bus?.emit('chat:open', { npc: this._npc });
  }

  close() {
    if (!this._open) return;
    this._open = false;
    this.el.classList.remove('open');
    this.field.blur();
    this._abort?.abort();
    this._abort = null;
    this._finishStream();
    this.bus?.emit('chat:close');
    this._onClose?.();
  }

  /** Retarget an open conversation (e.g. the player walked to a different NPC). */
  setNpc(npc) {
    if (!npc || npc === this._npc) return;
    this._npc = npc;
    this._refreshHeader();
    this._systemLine(`Channel open — ${npc.name ?? 'unknown contact'}`);
  }

  _greeted(npc) {
    return (this.client?.history(npc.id)?.length ?? 0) > 0;
  }

  _refreshHeader() {
    const npc = this._npc;
    this.nameEl.textContent = (npc?.name ?? 'OPEN CHANNEL').toUpperCase();
    const world = this.worldManager?.active?.displayName ?? '';
    this.subEl.textContent = npc
      ? `${npc.type === 'hostile' ? 'hostile' : 'friendly'}${world ? ` • ${world}` : ''}`
      : 'broadcast';
    this._drawSigil(npc);
    this.el.classList.toggle('offline', !!this.client?.offline);
  }

  /* -------------------------------------------------------------- sigils -- */

  /** Procedural emblem: rings, a rotor polygon and the NPC's initials. */
  _drawSigil(npc) {
    const key = npc?.id != null ? String(npc.id) : npc?.name ?? 'anon';
    const ctx = this.sigil.getContext('2d');
    const S = this.sigil.width;
    ctx.clearRect(0, 0, S, S);

    const h = hashString(key);
    const hue = h % 360;
    const sides = 3 + (h % 5);
    const spin = ((h >> 5) % 360) * (Math.PI / 180);

    const bg = ctx.createLinearGradient(0, 0, S, S);
    bg.addColorStop(0, `hsl(${hue} 55% 18%)`);
    bg.addColorStop(1, `hsl(${(hue + 40) % 360} 45% 7%)`);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, S, S);

    // Faint hatching so the emblem is not a flat swatch.
    ctx.strokeStyle = `hsl(${hue} 60% 60% / 0.10)`;
    ctx.lineWidth = 1;
    for (let i = -S; i < S * 2; i += 7) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i - S, S);
      ctx.stroke();
    }

    const cx = S / 2;
    const cy = S / 2;
    ctx.strokeStyle = `hsl(${hue} 90% 68% / 0.75)`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, S * 0.36, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = `hsl(${(hue + 30) % 360} 95% 74% / 0.9)`;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (let i = 0; i < sides; i++) {
      const a = spin + (i / sides) * Math.PI * 2;
      const x = cx + Math.cos(a) * S * 0.27;
      const y = cy + Math.sin(a) * S * 0.27;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();

    const initials = (npc?.name ?? '??')
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0] ?? '')
      .join('')
      .toUpperCase();
    ctx.font = '700 26px "Chakra Petch", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(6,10,16,0.85)';
    ctx.fillText(initials, cx + 1, cy + 2);
    ctx.fillStyle = `hsl(${hue} 100% 88%)`;
    ctx.fillText(initials, cx, cy + 1);
  }

  /* ------------------------------------------------------------ messages -- */

  _row(kind, who, text) {
    const row = el('div', `chat-msg ${kind}`);
    const head = el('div', 'who');
    head.append(el('b', null, who), el('time', null, stamp()));
    const body = el('div', 'body', text ?? '');
    row.append(head, body);
    this.log.appendChild(row);
    while (this.log.childElementCount > MAX_MESSAGES) this.log.removeChild(this.log.firstChild);
    this._scroll();
    return body;
  }

  _systemLine(text) {
    this._row('sys', 'NEXUS', text);
  }

  _scroll() {
    // rAF so the newly appended node has been laid out.
    requestAnimationFrame(() => {
      this.log.scrollTop = this.log.scrollHeight;
    });
  }

  _showTyping() {
    if (this._typing) return;
    const t = el('div', 'chat-typing');
    t.append(el('i'), el('i'), el('i'));
    this.log.appendChild(t);
    this._typing = t;
    this._scroll();
  }

  _hideTyping() {
    this._typing?.remove();
    this._typing = null;
  }

  _finishStream() {
    this._hideTyping();
    this._caret?.remove();
    this._caret = null;
    this._streamNode = null;
  }

  /* ---------------------------------------------------------------- send -- */

  async _submit() {
    const text = this.field.value.trim();
    if (!text || this._busy) return;
    this.field.value = '';

    const npc = this._npc;
    this._row('me', 'YOU', text);
    this.bus?.emit('chat:player-message', { npc, text });

    this._busy = true;
    this.sendBtn.disabled = true;
    this._showTyping();

    this._abort?.abort();
    const ctrl = new AbortController();
    this._abort = ctrl;

    const speaker = (npc?.name ?? 'CONTACT').toUpperCase();
    let body = null;
    const world = this.worldManager?.active?.id;

    try {
      await this.client.send(npc, text, {
        world,
        signal: ctrl.signal,
        onToken: (tok) => {
          if (ctrl.signal.aborted) return;
          if (!body) {
            this._hideTyping();
            body = this._row('npc', speaker, '');
            this._streamNode = body;
            this._caret = el('span', 'chat-caret');
            body.appendChild(this._caret);
          }
          // Insert before the caret so it always trails the text.
          body.insertBefore(document.createTextNode(tok), this._caret);
          this._scroll();
        },
      });
    } catch (err) {
      if (err?.name !== 'AbortError') {
        this._hideTyping();
        this._systemLine('Signal lost mid-transmission.');
        this.bus?.emit('chat:error', { npc, message: err?.message ?? 'unknown' });
      }
    } finally {
      if (this._abort === ctrl) this._abort = null;
      this._finishStream();
      this._busy = false;
      this.sendBtn.disabled = false;
      this.el.classList.toggle('offline', !!this.client?.offline);
      if (this._open) this.field.focus({ preventScroll: true });
    }
  }

  dispose() {
    this._abort?.abort();
    window.removeEventListener('keydown', this._onWindowKey, true);
    this.el?.remove();
  }
}
