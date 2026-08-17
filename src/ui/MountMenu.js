import './mount-menu.css';
import { skinsForMount } from '../systems/Cosmetics.js';
import { skinItemId } from '../systems/ItemDefs.js';
import { applyMountSkin } from '../systems/MountSkins.js';
import { STAT_META } from '../mounts/Livery.js';
import { PALETTES, statLine, skinState, SKIN_STATE_LABEL } from './MountMenuLogic.js';

/**
 * F10 - the mount panel.
 *
 * A structural twin of `CharacterMenu` (right-side drawer over the live third-
 * person view, capture-phase F10/Escape, text capture + pointer release while
 * open) but rendered *generically*: it reads the ridden mount's
 * `CUSTOM_SLOTS` / `STATS` and the skins catalogued for it, so a seventh mount
 * needs no menu code. It only opens while mounted. Mounting forces third person,
 * but `V` can flip back to first while riding, so the drawer forces third
 * person for the preview and restores the rider's choice on close, like F2.
 *
 * Skins: owned → apply; a copy in the bag/store → apply and consume (burned in
 * from then on); neither → point at the market. Upgrades are read-only pips.
 */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
const hexStr = (v) => `#${(v & 0xffffff).toString(16).padStart(6, '0')}`;
/** 6 bits a channel, like F2: material caches never evict. */
const quantise = (v) => v & 0xfcfcfc;

export class MountMenu {
  /**
   * @param {{ root:HTMLElement, bus?:any, input?:any, mounts:any, cosmetics?:any, inventory?:any, player?:any }} ctx
   */
  constructor({ root, bus, input, mounts, cosmetics, inventory, player }) {
    this.bus = bus ?? null;
    this.input = input ?? null;
    this.mounts = mounts;
    this.cosmetics = cosmetics ?? null;
    this.inventory = inventory ?? null;
    this.player = player ?? null;

    this._open = false;
    this._hadLock = false;
    this._prevCameraMode = null;
    this._mountId = null;
    this._slots = [];
    this._stats = [];
    /** @type {Array<() => void>} */
    this._syncers = [];
    this._liveryCache = null;
    this._pending = null;
    this._pendingRaf = 0;

    this.el = this._buildShell();
    root.appendChild(this.el);

    this._offs = [];
    if (bus) {
      const resync = () => { if (this._open) this._sync(); };
      this._offs.push(bus.on('mount:livery', resync));
      this._offs.push(bus.on('mount:powers', resync));
      this._offs.push(bus.on('cosmetic:unlocked', resync));
      this._offs.push(bus.on('inventory:changed', resync));
      // A forced dismount (world change, portal) has already restored the rider's
      // pre-mount camera; do not overwrite it with the riding mode we saved.
      this._offs.push(bus.on('mount:dismounted', () => { this._prevCameraMode = null; this.close(); }));
    }
    this._onKey = (e) => this._key(e);
    window.addEventListener('keydown', this._onKey, true);
  }

  get isOpen() { return this._open; }

  /* ---------------------------------------------------------------- */
  /* Build                                                             */
  /* ---------------------------------------------------------------- */

  _buildShell() {
    const wrap = el('div', 'mm-root');
    const panel = el('aside', 'mm-panel interactive');
    const head = el('header', 'mm-head');
    const titles = el('div', 'mm-titles');
    const kicker = el('div', 'mm-kicker', 'Mount');
    this._title = el('div', 'mm-title', 'MOUNT');
    titles.append(kicker, this._title);
    const close = el('button', 'mm-x');
    close.type = 'button';
    close.append(el('b', null, 'F10'), el('span', null, 'close'));
    close.addEventListener('click', () => this.close());
    head.append(titles, close);

    this._body = el('div', 'mm-body');

    const foot = el('footer', 'mm-foot');
    const reset = el('button', 'mm-btn ghost', 'Reset to factory');
    reset.type = 'button';
    reset.addEventListener('click', () => { if (this._mountId) this.mounts.resetLivery?.(this._mountId); });
    const hint = el('div', 'mm-hint');
    hint.innerHTML = 'Changes apply to the mount at once. <b>F5</b> saves them with the game.';
    foot.append(reset, hint);

    panel.append(head, this._body, foot);
    wrap.appendChild(panel);
    // A click inside the drawer must not re-lock the pointer or reach the world.
    panel.addEventListener('mousedown', (e) => e.stopPropagation());
    return wrap;
  }

  /** (Re)build the body for the mount being ridden. */
  _buildFor(mount) {
    // A colour-picker write coalesced for the previous mount's slot ids must
    // not land on this one once the body is rebuilt out from under it.
    if (this._pendingRaf) { cancelAnimationFrame(this._pendingRaf); this._pendingRaf = 0; }
    this._pending = null;
    this._mountId = mount.id;
    const C = mount.constructor;
    this._slots = Array.isArray(C.CUSTOM_SLOTS) ? C.CUSTOM_SLOTS : [];
    this._stats = Array.isArray(C.STATS) ? C.STATS : [];
    this._syncers = [];
    this._body.textContent = '';
    this._title.textContent = mount.displayName || mount.id.toUpperCase();

    for (const slot of this._slots) {
      this._body.appendChild(this._section(slot.label, `mm-slot mm-slot-${slot.id}`, (host, sec) => {
        host.appendChild(this._swatches(slot));
        if (slot.finish) host.appendChild(this._finishChips(slot));
        this._syncers.push(() => {
          const f = this._slotFinish(slot);
          sec.dataset.value = `${hexStr(this._slotColor(slot))}${f ? ` · ${f}` : ''}`;
        });
      }));
    }

    const skins = skinsForMount(mount.id);
    if (skins.length) {
      this._body.appendChild(this._section('Signature skins', 'mm-skins', (host) => {
        host.appendChild(this._skinCards(skins));
      }));
    }

    if (this._stats.length) {
      this._body.appendChild(this._section('Upgrades', 'mm-upgrades', (host) => {
        for (const stat of this._stats) host.appendChild(this._statRow(stat));
      }));
    }
    this._sync();
  }

  _section(title, cls, fill) {
    const sec = el('section', `mm-sec ${cls}`);
    const h = el('h3', 'mm-sec-t');
    h.append(el('span', null, title));
    sec.appendChild(h);
    const host = el('div', 'mm-sec-b');
    sec.appendChild(host);
    fill(host, sec);
    return sec;
  }

  /** Livery snapshot for the ridden mount; cached for the duration of one `_sync()`. */
  _livery() {
    if (this._liveryCache) return this._liveryCache;
    return this.mounts.getLivery?.(this._mountId) ?? {};
  }
  _slotColor(slot) { const c = this._livery()[slot.id]?.color; return typeof c === 'number' ? c : slot.defaultColor; }
  _slotFinish(slot) { return this._livery()[slot.id]?.finish ?? null; }

  _swatches(slot) {
    const colors = PALETTES[slot.palette] ?? PALETTES.paint;
    const row = el('div', 'mm-sws');
    for (const c of colors) {
      const b = el('button', 'mm-sw');
      b.type = 'button';
      b.style.setProperty('--c', hexStr(c));
      b.title = hexStr(c);
      b.addEventListener('click', () => {
        /* Clicking the swatch that already IS the factory colour must do
         * nothing at all, not write its hex.
         *
         * `slot.defaultColor` is the swatch the palette draws for "factory",
         * but on an ORM-baked material the real `.color` is white and the
         * shade the player sees comes out of the map. Writing the swatch hex
         * multiplies that map by itself and the part visibly darkens - the
         * button that means "put it back" made it worse. An unset slot is
         * already at factory, so there is nothing to write. */
        if (c === slot.defaultColor && this._livery()[slot.id]?.color == null) return;
        this._setSlot(slot.id, { color: c });
      });
      row.appendChild(b);
      this._syncers.push(() => b.classList.toggle('on', this._slotColor(slot) === c));
    }
    const label = el('label', 'mm-pick');
    const input = el('input');
    input.type = 'color';
    input.setAttribute('aria-label', `Custom ${slot.label} colour`);
    input.addEventListener('input', () =>
      this._pick(slot.id, quantise(Number.parseInt(input.value.slice(1), 16) || 0)));
    label.append(input, el('i'));
    label.title = 'Custom colour';
    row.appendChild(label);
    this._syncers.push(() => {
      const hex = hexStr(this._slotColor(slot));
      if (document.activeElement !== input) input.value = hex;
      label.style.setProperty('--c', hex);
      label.classList.toggle('on', !colors.includes(this._slotColor(slot)));
    });
    return row;
  }

  _finishChips(slot) {
    const row = el('div', 'mm-chips mm-finish');
    for (const f of ['matt', 'gloss']) {
      const b = el('button', 'mm-chip', f === 'matt' ? 'Matt' : 'Gloss');
      b.type = 'button';
      b.addEventListener('click', () => this._setSlot(slot.id, { finish: this._slotFinish(slot) === f ? null : f }));
      row.appendChild(b);
      this._syncers.push(() => b.classList.toggle('on', this._slotFinish(slot) === f));
    }
    return row;
  }

  _skinCards(skins) {
    const grid = el('div', 'mm-skingrid');
    for (const skin of skins) {
      const card = el('button', 'mm-skincard');
      card.type = 'button';
      const dots = el('span', 'mm-skindots');
      for (const slot in skin.livery) {
        const dot = el('i', 'mm-skindot');
        dot.style.background = hexStr(skin.livery[slot].color);
        dots.appendChild(dot);
      }
      const text = el('span', 'mm-skintext');
      text.append(el('b', null, skin.name), el('small', null, skin.blurb));
      const lock = el('span', 'mm-skinlock');
      card.append(dots, text, lock);
      grid.appendChild(card);

      card.addEventListener('click', () => {
        const state = this._skinState(skin);
        if (state === 'locked') {
          this.bus?.emit('hud:notify', { text: `Buy the ${skin.name} skin at the market (B).`, tone: 'warn' });
          return;
        }
        const res = applyMountSkin({ mounts: this.mounts, cosmetics: this.cosmetics, inventory: this.inventory }, skin.id);
        if (!res.ok) this.bus?.emit('hud:notify', { text: 'That skin could not be applied.', tone: 'warn' });
        else if (res.consumed) this.bus?.emit('hud:notify', { text: `${skin.name} applied — it is yours to keep now.`, tone: 'info' });
        else if (state === 'equipped') this.bus?.emit('hud:notify', { text: 'Already wearing that skin', tone: 'info' });
        // With a bus, mount:livery/cosmetic:unlocked/inventory:changed drive the resync.
        if (!this.bus) this._sync();
      });

      this._syncers.push(() => {
        const state = this._skinState(skin);
        card.classList.toggle('locked', state === 'locked');
        card.classList.toggle('held', state === 'held');
        card.classList.toggle('on', state === 'equipped');
        lock.textContent = SKIN_STATE_LABEL[state];
      });
    }
    return grid;
  }

  _skinState(skin) {
    return skinState({
      skin,
      owned: !!this.cosmetics?.has?.(skin.id),
      held: this.inventory?.totalCount?.(skinItemId(skin.id)) ?? 0,
      livery: this._livery(),
    });
  }

  _statRow(stat) {
    const meta = STAT_META[stat] ?? { label: stat };
    const row = el('div', `mm-stat mm-stat-${stat}`);
    const label = el('span', 'mm-stat-l', meta.label);
    const pips = el('span', 'mm-pips');
    const pipEls = [1, 2, 3].map((t) => { const p = el('i', 'mm-pip'); p.title = `${meta.label} ${'I'.repeat(t)}`; pips.appendChild(p); return p; });
    const fx = el('span', 'mm-stat-fx');
    row.append(label, pips, fx);
    this._syncers.push(() => {
      const tier = Math.floor(Number(this.mounts.getPowers?.(this._mountId)?.[stat]) || 0);
      pipEls.forEach((p, i) => p.classList.toggle('on', i < tier));
      fx.textContent = statLine(stat, tier);
    });
    return row;
  }

  /* ---------------------------------------------------------------- */
  /* State                                                             */
  /* ---------------------------------------------------------------- */

  _setSlot(slotId, patch) {
    if (!this._mountId) return;
    this.mounts.setLivery?.(this._mountId, { [slotId]: patch });
    // With a bus, mount:livery drives the resync; without one, do it here.
    if (!this.bus) this._sync();
  }

  /** Coalesced colour-picker write: one uniform write per frame. */
  _pick(slotId, color) {
    this._pending = { ...(this._pending ?? {}), [slotId]: { color } };
    if (this._pendingRaf) return;
    this._pendingRaf = requestAnimationFrame(() => {
      this._pendingRaf = 0;
      const patch = this._pending;
      this._pending = null;
      if (patch && this._mountId) {
        this.mounts.setLivery?.(this._mountId, patch);
        // With a bus, mount:livery drives the resync; without one, do it here.
        if (!this.bus) this._sync();
      }
    });
  }

  _sync() {
    // One deep copy per sync, not one per swatch/chip/card. Saved/restored
    // re-entrantly so a syncer that itself triggers a nested _sync() (e.g. a
    // bus handler firing while this one is still running) cannot leave the
    // cache pointed at the wrong livery once the outer call resumes.
    const prev = this._liveryCache;
    this._liveryCache = this._mountId ? (this.mounts.getLivery?.(this._mountId) ?? {}) : {};
    try { for (const fn of this._syncers) fn(); } finally { this._liveryCache = prev; }
  }

  /* ---------------------------------------------------------------- */
  /* Open / close                                                      */
  /* ---------------------------------------------------------------- */

  open() {
    if (this._open) return;
    const mount = this.mounts?.mounted ? this.mounts.active : null;
    if (!mount) {
      this.bus?.emit('hud:notify', { text: 'Mount up first (M) to customise it', tone: 'warn' });
      return;
    }
    this._buildFor(mount);
    this._open = true;
    this._hadLock = !!this.input?.locked;
    this.input?.setTextCapture?.(true);
    this.input?.exitLock?.();
    document.body.classList.add('mm-open');
    // Third person is the preview; remember what the rider had so closing
    // puts them back rather than in a mode they did not choose.
    const rig = this.player?.cameraRig ?? null;
    this._prevCameraMode = rig?.mode ?? null;
    rig?.setMode?.('third');
    this.el.classList.add('open');
    this.bus?.emit('mount:menu:open', { mountId: mount.id });
  }

  close() {
    if (!this._open) return;
    this._open = false;
    this.el.classList.remove('open');
    document.body.classList.remove('mm-open');
    const rig = this.player?.cameraRig ?? null;
    if (rig && this._prevCameraMode && this._prevCameraMode !== rig.mode) rig.setMode?.(this._prevCameraMode);
    this._prevCameraMode = null;
    this.input?.setTextCapture?.(false);
    if (this._hadLock) {
      // Browsers reject a lock request that follows an Escape-driven exit too
      // closely, and an uncaught rejection surfaces as a console error mid-game.
      setTimeout(() => {
        try {
          const p = this.input?.canvas?.requestPointerLock?.();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch { /* the pause overlay is the fallback */ }
      }, 140);
    }
    this.bus?.emit('mount:menu:close', {});
  }

  toggle() { if (this._open) this.close(); else this.open(); }

  _key(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (e.code === 'F10') {
      // F10 is the browser's menu-bar key: claim it before the browser does.
      e.preventDefault();
      e.stopPropagation();
      if (!this._open && this.input?.textCaptured) return;
      this.toggle();
      return;
    }
    if (e.code === 'Escape' && this._open) {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  }

  update() {}

  dispose() {
    this.close();
    window.removeEventListener('keydown', this._onKey, true);
    for (const off of this._offs) { try { off(); } catch { /* cleared bus */ } }
    this._offs.length = 0;
    if (this._pendingRaf) cancelAnimationFrame(this._pendingRaf);
    this._pendingRaf = 0;
    this.el?.remove();
  }
}
