import { CONFIG } from '../core/Config.js';
import { Minimap } from './Minimap.js';
import { ChatBox } from './ChatBox.js';
import { ChatClient } from '../ai/ChatClient.js';

/**
 * The whole player-facing interface: crosshair, health, ammo, minimap, kill
 * feed, prompts, toasts, chat, debug readout, pause and world-transition wipe.
 *
 * Everything is DOM + one canvas. Style lives in `hud.css`; this file only ever
 * writes values that actually changed, because a HUD that dirties layout every
 * frame will cost more than the renderer it sits on top of.
 */

/* Module-scope scratch — the frame path must not allocate. */
const _dir = { x: 0, z: 0 };

const DMG_SLOTS = 5;
const DMG_LIFE = 1.5;
const KF_LIFE = 6.5;
const TOAST_LIFE = 3.6;
const RELOAD_ARC_C = 2 * Math.PI * 18;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function svg(tag, attrs) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Frame-rate independent exponential approach. */
const approach = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

export class HUD {
  /**
   * @param {{ bus:any, engine:any, input:any, root:HTMLElement, player:any,
   *           worldManager:any, npcManager:any, portals:any }} ctx
   */
  constructor({ bus, engine, input, root, player, worldManager, npcManager, portals }) {
    this.bus = bus;
    this.engine = engine;
    this.input = input;
    this.root = root;
    this.player = player;
    this.worldManager = worldManager;
    this.npcManager = npcManager;
    this.portals = portals;

    this._offs = [];
    this._live = false;

    /* -- health state ------------------------------------------------- */
    this._maxHealth = player?.maxHealth ?? CONFIG.player.maxHealth;
    this._health = this._maxHealth;
    this._shown = 1;
    this._ghost = 1;
    this._ghostHold = 0;
    this._regen = 0;
    this._flash = 0;
    this._vig = 0;
    this._vigWritten = -1;
    this._flashWritten = -1;
    this._dead = false;

    /* -- ammo state --------------------------------------------------- */
    this._ammo = -1;
    this._reserve = -1;
    this._magazine = 0;
    this._reloadT = 0;
    this._reloadDur = 0;
    this._pollT = 0;

    /* -- crosshair ---------------------------------------------------- */
    this._gap = 6;
    this._fireKick = 0;
    this._gapWritten = -1;

    /* -- prompts / interaction --------------------------------------- */
    this._chatNpc = null;
    this._nearPortal = null;
    this._promptKey = '';

    /* -- chat / lock -------------------------------------------------- */
    this._chatOpen = false;
    this._relock = 0;
    this._relockCheck = 0;

    /* -- transient lists ---------------------------------------------- */
    this._dmg = [];
    this._kf = [];
    this._toasts = [];
    this._debugT = 0;
    this._stats = { fps: 0, frameMs: 0, drawCalls: 0, triangles: 0 };

    this._build();
    this._wire();
  }

  /* ====================================================================== */
  /* Construction                                                           */
  /* ====================================================================== */

  _build() {
    const hud = el('div', 'hud');
    this.el = hud;

    hud.appendChild(el('div', 'hud-veil'));
    this.vignette = el('div', 'vignette');
    this.flashEl = el('div', 'flash');
    hud.append(this.vignette, this.flashEl);

    this._buildCrosshair(hud);
    this._buildHealth(hud);
    this._buildAmmo(hud);
    this._buildMinimap(hud);
    this._buildPrompt(hud);
    this._buildToasts(hud);
    this._buildDebug(hud);
    this._buildDeadCard(hud);

    this.root.appendChild(hud);

    this._buildWipe();
    this._buildPause();

    // Chat lives outside `.hud` so it is never dimmed by the HUD fade-in.
    this.client = new ChatClient(this.bus);
    this.chatBox = new ChatBox({
      root: this.root,
      bus: this.bus,
      input: this.input,
      client: this.client,
      worldManager: this.worldManager,
      onClose: () => this._onChatClosed(),
    });
  }

  _buildCrosshair(hud) {
    const x = el('div', 'xhair');
    x.appendChild(el('div', 'xhair-dot'));
    this.blades = {};
    for (const dir of ['n', 's', 'w', 'e']) {
      const b = el('div', `xhair-blade ${dir === 'n' || dir === 's' ? 'v' : 'h'} ${dir}`);
      x.appendChild(b);
      this.blades[dir] = b;
    }
    hud.appendChild(x);

    this.hitmark = el('div', 'hitmark');
    for (let i = 0; i < 4; i++) this.hitmark.appendChild(el('i'));
    hud.appendChild(this.hitmark);

    const ring = el('div', 'dmg-ring');
    for (let i = 0; i < DMG_SLOTS; i++) {
      const a = el('div', 'dmg-arc');
      ring.appendChild(a);
      this._dmg.push({ el: a, life: 0, x: 0, z: 0, written: -1 });
    }
    hud.appendChild(ring);
  }

  _buildHealth(hud) {
    const p = el('div', 'panel health');
    const top = el('div', 'health-top');
    this.hpNum = el('div', 'health-num', '100');
    const meta = el('div', 'health-meta');
    meta.appendChild(el('div', 'panel-label', 'Integrity'));
    this.hpMax = el('div', 'health-max', `/ ${Math.round(this._maxHealth)}`);
    meta.appendChild(this.hpMax);
    top.append(this.hpNum, meta);

    const bar = el('div', 'health-bar');
    this.hpGhost = el('div', 'health-ghost');
    this.hpFill = el('div', 'health-fill');
    bar.append(this.hpGhost, this.hpFill, el('div', 'health-regen'), el('div', 'health-segments'), el('div', 'health-gloss'));

    const status = el('div', 'health-status');
    this.hpTag = el('div', 'health-tag', 'nominal');
    this.hpPct = el('div', 'health-tag', '100%');
    status.append(this.hpTag, this.hpPct);

    p.append(top, bar, status);
    hud.appendChild(p);
    this.healthPanel = p;
  }

  _buildAmmo(hud) {
    const p = el('div', 'panel ammo');
    this.ammoName = el('div', 'ammo-name', CONFIG.weapon.machinegun.name);

    const row = el('div', 'ammo-row');

    const arc = svg('svg', { class: 'ammo-arc', viewBox: '0 0 44 44' });
    arc.appendChild(svg('circle', { class: 'trk', cx: 22, cy: 22, r: 18 }));
    this.reloadArc = svg('circle', { class: 'val', cx: 22, cy: 22, r: 18 });
    this.reloadArc.setAttribute('stroke-dasharray', `0 ${RELOAD_ARC_C}`);
    arc.appendChild(this.reloadArc);
    const arcTxt = svg('text', { x: 22, y: 25 });
    arcTxt.textContent = 'RLD';
    arc.appendChild(arcTxt);

    const count = el('div', 'ammo-count');
    this.ammoCur = el('div', 'ammo-cur', '--');
    this.ammoRes = el('div', 'ammo-res', '--');
    count.append(this.ammoCur, el('div', 'ammo-sep', '/'), this.ammoRes);

    row.append(arc, count);

    this.pips = el('div', 'ammo-pips');
    p.append(this.ammoName, row, this.pips);
    hud.appendChild(p);
    this.ammoPanel = p;
  }

  _buildMinimap(hud) {
    const wrap = el('div', 'minimap');
    const canvas = document.createElement('canvas');
    wrap.appendChild(canvas);
    this.mapLabel = el('div', 'minimap-world', '');
    wrap.appendChild(this.mapLabel);
    hud.appendChild(wrap);

    this.minimap = new Minimap({
      canvas,
      player: this.player,
      worldManager: this.worldManager,
      npcManager: this.npcManager,
      portals: this.portals,
    });

    this.killfeed = el('div', 'killfeed');
    this.killfeed.style.top = `${30 + CONFIG.minimap.size + 18}px`;
    hud.appendChild(this.killfeed);
  }

  _buildPrompt(hud) {
    const p = el('div', 'prompt');
    this.promptKey = el('div', 'prompt-key', 'E');
    this.promptText = el('div', 'prompt-text');
    p.append(this.promptKey, this.promptText);
    hud.appendChild(p);
    this.prompt = p;
  }

  _buildToasts(hud) {
    this.toastWrap = el('div', 'toasts');
    hud.appendChild(this.toastWrap);
  }

  _buildDebug(hud) {
    const p = el('div', 'panel debug');
    const h = el('div', 'debug-h');
    h.append(el('b', null, 'DIAGNOSTICS'), el('i', null, 'F3'));
    const grid = el('dl', 'debug-grid');
    this.dbg = {};
    const rows = [
      ['fps', 'FPS'],
      ['ms', 'Frame'],
      ['calls', 'Draws'],
      ['tris', 'Tris'],
      ['pos', 'Pos'],
      ['world', 'World'],
      ['npc', 'NPCs'],
      ['ai', 'AI'],
    ];
    for (const [key, label] of rows) {
      grid.appendChild(el('dt', null, label));
      const dd = el('dd', null, '—');
      grid.appendChild(dd);
      this.dbg[key] = dd;
    }
    p.append(h, grid);
    hud.appendChild(p);
    this.debugPanel = p;
  }

  _buildDeadCard(hud) {
    const d = el('div', 'deadcard');
    const inner = el('div', 'deadcard-in');
    inner.append(el('div', 'deadcard-t', 'SIGNAL LOST'), el('div', 'deadcard-s', 'reinitialising carrier…'));
    d.appendChild(inner);
    hud.appendChild(d);
  }

  _buildWipe() {
    const w = el('div', 'wipe');
    w.appendChild(el('div', 'wipe-bars'));
    w.appendChild(el('div', 'wipe-slab top'));
    w.appendChild(el('div', 'wipe-slab bot'));
    const label = el('div', 'wipe-label');
    this.wipeKicker = el('div', 'wipe-kicker', 'Traversing the Nexus');
    this.wipeName = el('div', 'wipe-name', '');
    label.append(this.wipeKicker, this.wipeName);
    w.appendChild(label);
    w.appendChild(el('div', 'wipe-flash'));
    this.root.appendChild(w);
    this.wipe = w;
  }

  _buildPause() {
    const p = el('div', 'pause');
    const inner = el('div', 'pause-in');
    inner.append(
      el('div', 'pause-t', 'STANDBY'),
      el('div', 'pause-s', 'click to resume'),
      el('div', 'pause-hint', 'Esc releases the cursor · F3 diagnostics · T opens comms')
    );
    p.appendChild(inner);
    p.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this._requestLock();
    });
    this.root.appendChild(p);
    this.pause = p;
  }

  /* ====================================================================== */
  /* Event wiring                                                           */
  /* ====================================================================== */

  _on(type, fn) {
    this._offs.push(this.bus.on(type, fn));
  }

  _wire() {
    this._on('game:started', () => this._goLive());

    this._on('player:damaged', ({ amount, health, maxHealth, sourcePosition }) => {
      if (maxHealth) this._setMaxHealth(maxHealth);
      this._health = health ?? this._health;
      this._flash = Math.min(1, this._flash + 0.35 + Math.min(0.45, (amount ?? 10) / 60));
      this._ghostHold = 0.5;
      this._regen = 0;
      if (sourcePosition) this._pushDamageDir(sourcePosition);
    });

    this._on('player:healed', ({ health, maxHealth }) => {
      if (maxHealth) this._setMaxHealth(maxHealth);
      if (health != null) this._health = health;
      this._regen = 0.9;
    });

    this._on('player:died', ({ killerId }) => {
      this._dead = true;
      this._health = 0;
      this.el.classList.add('dead');
      this._killRow(this._nameOf(killerId), 'YOU', 'on-player');
    });

    this._on('player:respawned', () => {
      this._dead = false;
      this.el.classList.remove('dead');
      this._health = this._maxHealth;
      this._shown = 1;
      this._ghost = 1;
      this._flash = 0;
      for (const d of this._dmg) d.life = 0;
      this.notify('Carrier restored', 'info');
    });

    this._on('weapon:ammo', ({ ammo, reserve, magazine }) => this._setAmmo(ammo, reserve, magazine));
    this._on('weapon:reload-start', ({ duration }) => {
      this._reloadDur = duration || CONFIG.weapon.machinegun.reloadTime;
      this._reloadT = 0;
      this.ammoPanel.classList.add('reloading');
    });
    this._on('weapon:reload-end', ({ ammo, reserve }) => {
      this._reloadDur = 0;
      this.ammoPanel.classList.remove('reloading');
      this._setAmmo(ammo, reserve, this._magazine);
    });
    this._on('weapon:fired', () => {
      this._fireKick = Math.min(9, this._fireKick + 3.2);
    });

    this._on('weapon:hit', ({ isNPC, isHeadshot }) => {
      if (isNPC) this._hit(isHeadshot ? 'crit' : '');
    });

    this._on('npc:killed', ({ npc, byPlayer }) => {
      if (byPlayer) {
        this._hit('kill');
        this._killRow('YOU', (npc?.name ?? 'HOSTILE').toUpperCase(), 'by-player');
        this.notify(`Eliminated ${npc?.name ?? 'hostile'}`, 'kill');
      } else {
        this._killRow('—', (npc?.name ?? 'HOSTILE').toUpperCase(), '');
      }
    });

    this._on('chat:available', (p) => {
      const npc = p?.npc ?? null;
      this._chatNpc = npc;
      this.minimap.chatNpcId = npc?.id ?? null;
      if (npc && this.chatBox.isOpen) this.chatBox.setNpc(npc);
    });

    this._on('portal:near', (p) => {
      this._nearPortal = p?.portal ?? null;
    });

    this._on('portal:entering', ({ to, duration }) => this._runWipe(to, duration));

    this._on('world:changed', ({ id, world }) => {
      this.minimap.setWorld(world);
      this.mapLabel.textContent = (world?.displayName ?? id ?? '').toUpperCase();
      this._nearPortal = null;
      this._chatNpc = null;
      this.minimap.chatNpcId = null;
      this.notify(`${world?.displayName ?? id} — anchor locked`, 'lore');
    });

    this._on('world:ready', ({ id }) => {
      const w = this.worldManager?.getWorld?.(id);
      this.notify(`${w?.displayName ?? id} online`, 'info');
    });

    this._on('engine:stats', (s) => {
      this._stats = s;
    });

    this._on('hud:notify', ({ text, tone }) => this.notify(text, tone));

    // `no-key` is the expected state for a clone with no API key — the chat
    // header's offline badge already communicates it. Anything else is worth a
    // single toast, but never a repeat.
    this._on('chat:error', ({ message }) => {
      if (message === 'no-key' || this._chatWarned) return;
      this._chatWarned = true;
      this.notify('Comms relay degraded — falling back to local personas', 'warn');
    });
  }

  /** Resolve a killer id to a display name via the NPC roster. */
  _nameOf(id) {
    if (id == null) return 'THE VOID';
    const list = this.npcManager?.npcs;
    if (list) {
      for (let i = 0; i < list.length; i++) {
        if (list[i]?.id === id) return String(list[i].name ?? id).toUpperCase();
      }
    }
    return String(id).toUpperCase();
  }

  _goLive() {
    if (this._live) return;
    this._live = true;
    this.el.classList.add('is-live');
    const w = this.worldManager?.active;
    if (w) {
      this.minimap.setWorld(w);
      this.mapLabel.textContent = (w.displayName ?? '').toUpperCase();
    }
  }

  /* ====================================================================== */
  /* Public API                                                             */
  /* ====================================================================== */

  /** True while the chat box owns the keyboard; main.js reads this on unlock. */
  get chatOpen() {
    return this._chatOpen;
  }

  showPauseOverlay(show) {
    if (show && this._chatOpen) return; // chat deliberately released the cursor
    this.pause.classList.toggle('show', !!show);
    if (show) this._relockCheck = 0;
  }

  setDebugVisible(show) {
    this.debugPanel.classList.toggle('show', !!show);
  }

  /**
   * Transient message.
   * @param {string} text
   * @param {'info'|'warn'|'kill'|'lore'} [tone]
   */
  notify(text, tone = 'info') {
    if (!text) return;
    const t = el('div', `toast ${tone}`, text);
    this.toastWrap.appendChild(t);
    this._toasts.push({ el: t, life: TOAST_LIFE });
    while (this._toasts.length > 5) {
      const old = this._toasts.shift();
      old.el.remove();
    }
  }

  /* ====================================================================== */
  /* Frame                                                                  */
  /* ====================================================================== */

  update(dt, elapsed) {
    // Failsafe: if the boot screen has gone but game:started never fired
    // (autostart harness, hot reload), bring the HUD up anyway.
    if (!this._live && elapsed > 1.5 && !this.root.querySelector('.boot-screen')) this._goLive();

    this._updateInput(dt);
    this._updateHealth(dt, elapsed);
    this._updateAmmo(dt);
    this._updateCrosshair(dt);
    this._updateDamageDirs(dt);
    this._updatePrompt();
    this._updateTransients(dt);
    this._updateDebug(dt);
    this.minimap.update(dt, elapsed);
  }

  /**
   * Re-acquire pointer lock without risking an unhandled promise rejection —
   * browsers reject the request if it follows an Escape-driven exit too closely,
   * and an uncaught rejection would surface as a console error mid-game.
   */
  _requestLock() {
    if (this.input.locked) return;
    const canvas = this.input.canvas;
    let p;
    try {
      p = canvas?.requestPointerLock?.();
    } catch {
      p = null;
    }
    if (p && typeof p.catch === 'function') {
      p.catch(() => {
        if (!this._chatOpen) this.showPauseOverlay(true);
      });
    }
  }

  _updateInput(dt) {
    if (this._relock > 0) {
      this._relock -= dt;
      if (this._relock <= 0) {
        this._requestLock();
        this._relockCheck = 0.9;
      }
    } else if (this._relockCheck > 0) {
      this._relockCheck -= dt;
      // Browsers can refuse a lock request that follows Escape too closely;
      // if it never arrived, fall back to the click-to-resume overlay.
      if (this._relockCheck <= 0 && !this.input.locked && !this._chatOpen) this.showPauseOverlay(true);
    }

    if (this._chatOpen) return;

    const wheel = this.input.consumeWheel();
    if (wheel) this.minimap.zoom(wheel);

    if (this.input.pressed('KeyT')) {
      this._openChat(this._chatNpc);
    } else if (this.input.pressed('KeyE') && this._chatNpc && !this._nearPortal) {
      this._openChat(this._chatNpc);
    }
  }

  /* ------------------------------------------------------------- health -- */

  _setMaxHealth(max) {
    if (!max || max === this._maxHealth) return;
    this._maxHealth = max;
    this.hpMax.textContent = `/ ${Math.round(max)}`;
  }

  _updateHealth(dt, elapsed) {
    // Poll as well as listen — events cover the deltas, the poll covers regen.
    const live = this.player?.health;
    if (typeof live === 'number') {
      if (live > this._health + 0.01) this._regen = Math.max(this._regen, 0.5);
      this._health = live;
      this._setMaxHealth(this.player.maxHealth);
    }

    const frac = clamp01(this._health / Math.max(1, this._maxHealth));
    this._shown = approach(this._shown, frac, 14, dt);

    if (this._shown >= this._ghost - 0.001) {
      this._ghost = this._shown;
      this._ghostHold = 0;
    } else if (this._ghostHold > 0) {
      this._ghostHold -= dt;
    } else {
      this._ghost = approach(this._ghost, this._shown, 3.2, dt);
    }

    this.hpFill.style.transform = `scaleX(${this._shown.toFixed(4)})`;
    this.hpGhost.style.transform = `scaleX(${this._ghost.toFixed(4)})`;

    const shownHp = Math.max(0, Math.round(this._shown * this._maxHealth));
    if (this._hpText !== shownHp) {
      this._hpText = shownHp;
      this.hpNum.textContent = String(shownHp);
    }

    const crit = frac < 0.35;
    const warn = !crit && frac < 0.62;
    const cls = this.healthPanel.classList;
    if (cls.contains('crit') !== crit) cls.toggle('crit', crit);
    if (cls.contains('warn') !== warn) cls.toggle('warn', warn);

    this._regen = Math.max(0, this._regen - dt);
    const regenOn = this._regen > 0 && !this._dead;
    if (cls.contains('regen') !== regenOn) cls.toggle('regen', regenOn);

    const tag = this._dead ? 'offline' : regenOn ? 'regenerating' : crit ? 'critical' : warn ? 'damaged' : 'nominal';
    if (this._hpTagText !== tag) {
      this._hpTagText = tag;
      this.hpTag.textContent = tag;
    }

    const pct = Math.round(this._shown * 100);
    if (this._hpPctText !== pct) {
      this._hpPctText = pct;
      this.hpPct.textContent = `${pct}%`;
    }

    // --- vignette + flash ------------------------------------------------
    this._flash = Math.max(0, this._flash - dt * 2.1);
    let vig = 0;
    if (crit) {
      const t = (0.35 - frac) / 0.35;
      // Two-beat heartbeat: a strong systolic thump followed by a softer one.
      const b = (elapsed * 1.15) % 1;
      const hb =
        Math.exp(-70 * (b - 0.04) * (b - 0.04)) + 0.62 * Math.exp(-70 * (b - 0.2) * (b - 0.2));
      vig = (0.2 + 0.5 * t) * (0.66 + 0.5 * hb);
    }
    if (this._dead) vig = Math.max(vig, 0.85);

    if (Math.abs(vig - this._vigWritten) > 0.004) {
      this._vigWritten = vig;
      this.vignette.style.opacity = vig.toFixed(3);
    }
    const fl = this._flash * 0.85;
    if (Math.abs(fl - this._flashWritten) > 0.004) {
      this._flashWritten = fl;
      this.flashEl.style.opacity = fl.toFixed(3);
    }
  }

  /* --------------------------------------------------------------- ammo -- */

  _setAmmo(ammo, reserve, magazine) {
    if (magazine && magazine !== this._magazine) {
      this._magazine = magazine;
      this._buildPips(magazine);
    }
    if (typeof ammo === 'number' && ammo !== this._ammo) {
      this._ammo = ammo;
      this.ammoCur.textContent = String(ammo);
      this._paintPips(ammo);
      const mag = this._magazine || CONFIG.weapon.machinegun.magazine;
      const f = ammo / Math.max(1, mag);
      this.ammoPanel.classList.toggle('warn', f <= 0.35 && f > 0.15);
      this.ammoPanel.classList.toggle('low', f <= 0.15);
    }
    if (typeof reserve === 'number' && reserve !== this._reserve) {
      this._reserve = reserve;
      this.ammoRes.textContent = String(reserve);
    }
  }

  _buildPips(magazine) {
    this.pips.textContent = '';
    this._pipEls = [];
    const n = Math.min(60, magazine);
    for (let i = 0; i < n; i++) {
      const p = el('i');
      this.pips.appendChild(p);
      this._pipEls.push(p);
    }
  }

  _paintPips(ammo) {
    if (!this._pipEls) return;
    const n = this._pipEls.length;
    const mag = this._magazine || n;
    const lit = Math.round((ammo / Math.max(1, mag)) * n);
    for (let i = 0; i < n; i++) {
      const spent = i >= lit;
      const p = this._pipEls[i];
      if (p._spent !== spent) {
        p._spent = spent;
        p.classList.toggle('spent', spent);
      }
    }
  }

  _updateAmmo(dt) {
    // Poll the weapon so the HUD self-heals if an event is missed.
    this._pollT -= dt;
    const w = this.player?.weapon;
    if (this._pollT <= 0) {
      this._pollT = 0.2;
      if (w) this._setAmmo(w.ammo, w.reserve, w.magazine);
      if (w && !w.isReloading && this._reloadDur > 0) {
        this._reloadDur = 0;
        this.ammoPanel.classList.remove('reloading');
      }
    }

    if (this._reloadDur > 0) {
      this._reloadT = Math.min(this._reloadDur, this._reloadT + dt);
      const p = clamp01(this._reloadT / this._reloadDur);
      this.reloadArc.setAttribute('stroke-dasharray', `${(p * RELOAD_ARC_C).toFixed(2)} ${RELOAD_ARC_C.toFixed(2)}`);
      if (p >= 1) {
        this._reloadDur = 0;
        this.ammoPanel.classList.remove('reloading');
      }
    }
  }

  /* ---------------------------------------------------------- crosshair -- */

  _updateCrosshair(dt) {
    this._fireKick = Math.max(0, this._fireKick - dt * 22);
    const w = this.player?.weapon;
    const cfg = CONFIG.weapon.machinegun;
    const spread = w?.spread ?? cfg.spreadBase;
    const t = clamp01((spread - cfg.spreadBase) / Math.max(0.0001, cfg.spreadMax - cfg.spreadBase));
    const aiming = !!this.input?.state?.aim;
    let gap = 5 + t * 24 + this._fireKick;
    if (aiming) gap *= 0.5;

    this._gap = approach(this._gap, gap, 26, dt);
    if (Math.abs(this._gap - this._gapWritten) > 0.15) {
      this._gapWritten = this._gap;
      const g = this._gap.toFixed(1);
      this.blades.n.style.transform = `translateY(-${g}px)`;
      this.blades.s.style.transform = `translateY(${g}px)`;
      this.blades.w.style.transform = `translateX(-${g}px)`;
      this.blades.e.style.transform = `translateX(${g}px)`;
    }
  }

  _hit(kind) {
    const h = this.hitmark;
    h.className = 'hitmark';
    // Force a reflow so the animation restarts on rapid consecutive hits.
    void h.offsetWidth;
    h.className = `hitmark fire${kind ? ` ${kind}` : ''}`;
  }

  /* ----------------------------------------------------- damage arrows -- */

  _pushDamageDir(src) {
    let slot = this._dmg[0];
    for (const d of this._dmg) {
      if (d.life <= 0) {
        slot = d;
        break;
      }
      if (d.life < slot.life) slot = d;
    }
    slot.life = DMG_LIFE;
    slot.x = src.x;
    slot.z = src.z;
  }

  _updateDamageDirs(dt) {
    const p = this.player?.position;
    const yaw = this.player?.yaw ?? 0;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);

    for (let i = 0; i < this._dmg.length; i++) {
      const d = this._dmg[i];
      if (d.life <= 0) {
        if (d.written !== 0) {
          d.written = 0;
          d.el.style.opacity = '0';
        }
        continue;
      }
      d.life -= dt;

      // Recomputed every frame so the arc tracks the threat as the player turns.
      _dir.x = d.x - (p?.x ?? 0);
      _dir.z = d.z - (p?.z ?? 0);
      const right = _dir.x * cos - _dir.z * sin;
      const fwd = -_dir.x * sin - _dir.z * cos;
      const deg = (Math.atan2(right, fwd) * 180) / Math.PI;

      const k = clamp01(d.life / DMG_LIFE);
      const alpha = k * k * 0.95;
      d.written = alpha;
      d.el.style.opacity = alpha.toFixed(3);
      d.el.style.transform = `rotate(${deg.toFixed(1)}deg) scale(${(0.86 + 0.22 * k).toFixed(3)})`;
    }
  }

  /* ------------------------------------------------------------- prompt -- */

  _updatePrompt() {
    let text = '';
    let portal = false;

    if (this._nearPortal) {
      const po = this._nearPortal;
      const dest = po.label || this.worldManager?.getWorld?.(po.target)?.displayName || po.target || 'the Nexus';
      text = `Enter portal to <b>${escapeHtml(String(dest))}</b>`;
      portal = true;
    } else if (this._chatNpc && !this._chatOpen) {
      text = `Talk to <b>${escapeHtml(String(this._chatNpc.name ?? 'stranger'))}</b>`;
    }

    const show = !!text && !this._chatOpen && !this._dead;
    if (text !== this._promptKey) {
      this._promptKey = text;
      if (text) this.promptText.innerHTML = text;
    }
    if (this.prompt.classList.contains('show') !== show) this.prompt.classList.toggle('show', show);
    if (this.prompt.classList.contains('portal') !== portal) this.prompt.classList.toggle('portal', portal);
  }

  /* --------------------------------------------------------- transients -- */

  _killRow(src, dst, cls) {
    const row = el('div', `kf-row${cls ? ` ${cls}` : ''}`);
    row.append(el('span', 'kf-src', src), el('span', 'kf-ico', '✖'), el('span', 'kf-dst', dst));
    this.killfeed.appendChild(row);
    this._kf.push({ el: row, life: KF_LIFE });
    while (this._kf.length > 5) {
      const old = this._kf.shift();
      old.el.remove();
    }
  }

  _updateTransients(dt) {
    for (let i = this._kf.length - 1; i >= 0; i--) {
      const k = this._kf[i];
      k.life -= dt;
      if (k.life <= 0.4 && !k.fading) {
        k.fading = true;
        k.el.classList.add('out');
      }
      if (k.life <= 0) {
        k.el.remove();
        this._kf.splice(i, 1);
      }
    }
    for (let i = this._toasts.length - 1; i >= 0; i--) {
      const t = this._toasts[i];
      t.life -= dt;
      if (t.life <= 0.4 && !t.fading) {
        t.fading = true;
        t.el.classList.add('out');
      }
      if (t.life <= 0) {
        t.el.remove();
        this._toasts.splice(i, 1);
      }
    }
  }

  /* -------------------------------------------------------------- debug -- */

  _updateDebug(dt) {
    if (!this.debugPanel.classList.contains('show')) return;
    this._debugT -= dt;
    if (this._debugT > 0) return;
    this._debugT = 0.12;

    const s = this._stats;
    const d = this.dbg;
    d.fps.textContent = String(s.fps ?? 0);
    d.fps.className = s.fps >= 55 ? 'good' : s.fps >= 35 ? 'mid' : 'bad';
    d.ms.textContent = `${(s.frameMs ?? 0).toFixed(2)} ms`;
    d.ms.className = s.frameMs <= 16.7 ? 'good' : s.frameMs <= 26 ? 'mid' : 'bad';
    d.calls.textContent = String(s.drawCalls ?? 0);
    d.calls.className = (s.drawCalls ?? 0) <= 900 ? 'good' : 'mid';
    d.tris.textContent = formatCount(s.triangles ?? 0);

    const p = this.player?.position;
    d.pos.textContent = p ? `${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}` : '—';
    d.world.textContent = this.worldManager?.active?.id ?? '—';

    const nm = this.npcManager;
    const h = nm?.hostiles?.length ?? 0;
    const f = nm?.friendlies?.length ?? 0;
    d.npc.textContent = `${h} hostile / ${f} friendly`;
    d.ai.textContent = this.client?.offline ? 'offline persona' : 'live';
    d.ai.className = this.client?.offline ? 'mid' : 'good';
  }

  /* ---------------------------------------------------------- transition */

  _runWipe(toId, duration) {
    const dur = Math.max(0.4, duration || CONFIG.portal.transitionDuration);
    const w = this.worldManager?.getWorld?.(toId);
    this.wipeName.textContent = (w?.displayName ?? toId ?? 'Unknown Anchor').toUpperCase();
    this.wipe.style.setProperty('--wipe-dur', `${dur}s`);
    this.wipe.classList.remove('run');
    void this.wipe.offsetWidth; // restart the animation cleanly
    this.wipe.classList.add('run');
    clearTimeout(this._wipeTimer);
    this._wipeTimer = setTimeout(() => this.wipe.classList.remove('run'), dur * 1000 + 60);
  }

  /* --------------------------------------------------------------- chat -- */

  _openChat(npc) {
    if (this._chatOpen) return;
    // Flag first: main.js reads `chatOpen` from the pointer-lock handler that
    // `exitLock()` is about to fire.
    this._chatOpen = true;
    this._relock = 0;
    this._relockCheck = 0;
    this.showPauseOverlay(false);
    this.el.classList.add('chatting');
    this.input.setTextCapture(true);
    this.chatBox.open(npc ?? this._chatNpc);
    this.input.exitLock();
  }

  _onChatClosed() {
    this._chatOpen = false;
    this.el.classList.remove('chatting');
    this.input.setTextCapture(false);
    this._relock = 0.12;
  }

  /* ======================================================================= */

  dispose() {
    for (const off of this._offs) off();
    this._offs.length = 0;
    clearTimeout(this._wipeTimer);
    this.minimap.dispose();
    this.chatBox.dispose();
    this.el.remove();
    this.wipe.remove();
    this.pause.remove();
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatCount(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
