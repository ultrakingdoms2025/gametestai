import * as THREE from 'three';
import './ship-menu.css';
import { SHIP_STAT_META, SHIP_CLASSES, shipSkinsFor } from '../ships/ShipStats.js';
import { SHIP_PALETTES, shipStatLine, schemeState, SCHEME_STATE_LABEL } from './ShipMenuLogic.js';

/**
 * The ship panel. Opened from the Esc pause hub while standing in a yard.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  A PARALLEL OF `MountMenu`, NOT A REUSE, AND THE PRECONDITION IS WHY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `MountMenu` gates on `mounts.mounted && mounts.active`: a mount is RIDDEN,
 * there is exactly one of it at a time, and dismounting closes the drawer. A
 * dock ship is SELECTED. There are three of them standing on cradles in a shed,
 * the player walks round them, and "which one am I looking at" is a choice the
 * panel has to offer rather than a fact it can read off the player. That is a
 * different lifecycle, a different open/close rule and a different header — and
 * it is why the drawer is a twin rather than a shared component.
 *
 * Everything that is NOT about that precondition is copied from `MountMenu`
 * line for line, including four traps that are each a bug somebody found in
 * play. They are marked TRAP where they appear:
 *
 *   1. **Pending-patch cancel on entity change** (`MountMenu.js:116-117`). A
 *      colour-picker write coalesced for the previous hull's slot ids must not
 *      land on this one once the body has been rebuilt out from under it.
 *   2. **The factory-swatch no-op** (`:189`). On an ORM-baked material `.color`
 *      is a white MULTIPLIER over the albedo map. Writing the swatch hex for a
 *      slot that is already at factory multiplies the map by itself and the
 *      part visibly darkens — the button that means "put it back" made it
 *      worse.
 *   3. **Re-entrant livery-cache save/restore** (`:320-326`). One deep copy per
 *      sync, not one per swatch — and saved and restored around the loop, so a
 *      syncer that triggers a nested `_sync()` through the bus cannot leave the
 *      cache pointing at the wrong livery when the outer call resumes.
 *   4. **The 140 ms deferred pointer relock** (`:367-372`). Browsers reject a
 *      lock request that follows an Escape-driven exit too closely, and an
 *      uncaught rejection surfaces as a console error mid-game.
 */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
const hexStr = (v) => `#${(v & 0xffffff).toString(16).padStart(6, '0')}`;
/** 6 bits a channel, like F2 and F10: material caches never evict. */
const quantise = (v) => v & 0xfcfcfc;

/* Module scratch. Nothing in the turntable allocates per frame. */
const _look = new THREE.Vector3();
const _right = new THREE.Vector3();

export class ShipMenu {
  /**
   * @param {{ root:HTMLElement, bus?:any, input?:any, ships:any, player?:any,
   *           camera?:any, scene?:any }} ctx
   */
  constructor({ root, bus, input, ships, player, camera, scene }) {
    this.bus = bus ?? null;
    this.input = input ?? null;
    this.ships = ships;
    this.player = player ?? null;
    /* THE TURNTABLE, and why this panel needed a camera at all.
     *
     * The customiser is genuinely good - hull plating, trim, canopy tint,
     * thruster glow, nacelle shells, matt/gloss, yard schemes - and a tester
     * who used all of it wrote: "you cannot see it while you paint it. It
     * opens as a panel on the right quarter of the screen while you stand at
     * the ship's stern staring at a grey wall. No preview, no turntable, no
     * camera pull-back. You pick colours blind and the only confirmation is a
     * specular highlight on one panel."
     *
     * The hull is right there in the world and already lit, so the fix is not
     * a preview render - it is to point the camera at the thing being painted.
     * The panel takes the right 34% of the frame (`.sm-panel` in
     * ship-menu.css), so the hull is framed into the free two thirds on the
     * left rather than dead centre. */
    this.camera = camera ?? null;
    this.scene = scene ?? null;
    /** Saved camera pose, restored on close. Null while the menu is shut. */
    this._camSave = null;
    /** Orbit state while open: centre, radius, height, and the angle. */
    this._orbit = null;

    this._open = false;
    this._hadLock = false;
    this._shipId = null;
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
      this._offs.push(bus.on('ship:livery', resync));
      this._offs.push(bus.on('ship:powers', resync));
      /* A world change disposes the hulls this panel is holding materials for.
       * There is no `mount:dismounted` equivalent to lean on, so the world
       * event IS the close: leaving the yard through a gateway with the drawer
       * open would otherwise leave it writing uniforms into freed materials. */
      this._offs.push(bus.on('world:changed', () => this.close()));
    }
    this._onKey = (e) => this._key(e);
    window.addEventListener('keydown', this._onKey, true);
  }

  get isOpen() { return this._open; }

  /* ---------------------------------------------------------------- */
  /* Build                                                             */
  /* ---------------------------------------------------------------- */

  _buildShell() {
    const wrap = el('div', 'sm-root');
    const panel = el('aside', 'sm-panel interactive');
    const head = el('header', 'sm-head');
    const titles = el('div', 'sm-titles');
    this._kicker = el('div', 'sm-kicker', 'Berth');
    this._title = el('div', 'sm-title', 'SHIP');
    titles.append(this._kicker, this._title);
    const close = el('button', 'sm-x');
    close.type = 'button';
    close.append(el('b', null, 'Esc'), el('span', null, 'close'));
    close.addEventListener('click', () => this.close());
    head.append(titles, close);

    /* The hull picker. This is the whole difference from the mount panel: a
     * mount is the one you are sitting on, and a ship is one of the ones in
     * front of you. */
    this._tabs = el('nav', 'sm-tabs');

    this._body = el('div', 'sm-body');

    const foot = el('footer', 'sm-foot');
    const reset = el('button', 'sm-btn ghost', 'Back to yard grey');
    reset.type = 'button';
    reset.addEventListener('click', () => { if (this._shipId) this.ships.resetLivery?.(this._shipId); });
    const hint = el('div', 'sm-hint');
    hint.textContent = 'Colours go on at once. Save from the Esc menu to keep them.';
    foot.append(reset, hint);

    panel.append(head, this._tabs, this._body, foot);
    wrap.appendChild(panel);
    // A click inside the drawer must not re-lock the pointer or reach the world.
    panel.addEventListener('mousedown', (e) => e.stopPropagation());
    return wrap;
  }

  /** (Re)build the tab strip for whatever hulls this world has. */
  _buildTabs() {
    this._tabs.textContent = '';
    for (const ship of this.ships.hulls()) {
      const t = el('button', 'sm-tab');
      t.type = 'button';
      t.append(el('b', null, ship.displayName), el('small', null, `${ship.berth} · ${SHIP_CLASSES[ship.id]?.klass ?? ''}`));
      t.addEventListener('click', () => {
        if (this.ships.select(ship.id)) this._buildFor(this.ships.selected);
      });
      this._tabs.appendChild(t);
      this._tabSyncers.push(() => t.classList.toggle('on', this._shipId === ship.id));
    }
  }

  /** (Re)build the body for one hull. */
  _buildFor(ship) {
    /* TRAP 1. A colour-picker write coalesced for the previous hull's slot ids
     * must not land on this one once the body is rebuilt out from under it. */
    if (this._pendingRaf) { cancelAnimationFrame(this._pendingRaf); this._pendingRaf = 0; }
    this._pending = null;

    this._shipId = ship.id;
    this._slots = Array.isArray(ship.slots) ? ship.slots : [];
    this._stats = Array.isArray(ship.stats) ? ship.stats : [];
    this._syncers = [];
    this._tabSyncers = [];
    this._body.textContent = '';
    this._title.textContent = (ship.displayName || ship.id).toUpperCase();
    this._kicker.textContent = `${ship.berth} · ${SHIP_CLASSES[ship.id]?.klass ?? 'hull'}`;
    this._buildTabs();

    const blurb = el('p', 'sm-blurb', SHIP_CLASSES[ship.id]?.blurb ?? '');
    this._body.appendChild(blurb);

    for (const slot of this._slots) {
      this._body.appendChild(this._section(slot.label, `sm-slot sm-slot-${slot.id}`, (host, sec) => {
        host.appendChild(this._swatches(slot));
        if (slot.finish) host.appendChild(this._finishChips(slot));
        this._syncers.push(() => {
          const f = this._slotFinish(slot);
          sec.dataset.value = `${hexStr(this._slotColor(slot))}${f ? ` · ${f}` : ''}`;
        });
      }));
    }

    const schemes = shipSkinsFor(ship.id);
    if (schemes.length) {
      this._body.appendChild(this._section('Yard schemes', 'sm-schemes', (host) => {
        host.appendChild(this._schemeCards(schemes));
      }));
    }

    if (this._stats.length) {
      this._body.appendChild(this._section('Fitted out', 'sm-upgrades', (host) => {
        for (const stat of this._stats) host.appendChild(this._statRow(stat));
      }));
    }
    this._sync();
  }

  _section(title, cls, fill) {
    const sec = el('section', `sm-sec ${cls}`);
    const h = el('h3', 'sm-sec-t');
    h.append(el('span', null, title));
    sec.appendChild(h);
    const host = el('div', 'sm-sec-b');
    sec.appendChild(host);
    fill(host, sec);
    return sec;
  }

  /** Livery snapshot for the selected hull; cached for one `_sync()`. */
  _livery() {
    if (this._liveryCache) return this._liveryCache;
    return this.ships.getLivery?.(this._shipId) ?? {};
  }
  _slotColor(slot) { const c = this._livery()[slot.id]?.color; return typeof c === 'number' ? c : slot.defaultColor; }
  _slotFinish(slot) { return this._livery()[slot.id]?.finish ?? null; }

  _swatches(slot) {
    const colors = SHIP_PALETTES[slot.palette] ?? SHIP_PALETTES.shipHull;
    const row = el('div', 'sm-sws');
    for (const c of colors) {
      const b = el('button', 'sm-sw');
      b.type = 'button';
      b.style.setProperty('--c', hexStr(c));
      b.title = hexStr(c);
      b.addEventListener('click', () => {
        /* TRAP 2. Clicking the swatch that already IS the factory colour must
         * do nothing at all, not write its hex.
         *
         * `slot.defaultColor` is the swatch the palette draws for "factory",
         * and on these ORM-mapped materials the real `.color` multiplies the
         * albedo map. Writing the swatch hex over an unset slot multiplies that
         * map by itself and the part visibly darkens — the button that means
         * "put it back" makes it worse. An unset slot is already at factory, so
         * there is nothing to write. */
        if (c === slot.defaultColor && this._livery()[slot.id]?.color == null) return;
        this._setSlot(slot.id, { color: c });
      });
      row.appendChild(b);
      this._syncers.push(() => b.classList.toggle('on', this._slotColor(slot) === c));
    }
    const label = el('label', 'sm-pick');
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
    const row = el('div', 'sm-chips sm-finish');
    for (const f of ['matt', 'gloss']) {
      const b = el('button', 'sm-chip', f === 'matt' ? 'Matt' : 'Gloss');
      b.type = 'button';
      b.addEventListener('click', () => this._setSlot(slot.id, { finish: this._slotFinish(slot) === f ? null : f }));
      row.appendChild(b);
      this._syncers.push(() => b.classList.toggle('on', this._slotFinish(slot) === f));
    }
    return row;
  }

  _schemeCards(schemes) {
    const grid = el('div', 'sm-schemegrid');
    for (const scheme of schemes) {
      const card = el('button', 'sm-schemecard');
      card.type = 'button';
      const dots = el('span', 'sm-schemedots');
      for (const slot in scheme.livery) {
        const dot = el('i', 'sm-schemedot');
        dot.style.background = hexStr(scheme.livery[slot].color);
        dots.appendChild(dot);
      }
      const text = el('span', 'sm-schemetext');
      text.append(el('b', null, scheme.name), el('small', null, scheme.blurb));
      const tag = el('span', 'sm-schemetag');
      card.append(dots, text, tag);
      grid.appendChild(card);

      card.addEventListener('click', () => {
        const res = this.ships.applyScheme?.(this._shipId, scheme.id);
        if (!res?.ok) {
          this.bus?.emit('hud:notify', { text: 'That scheme is for another hull.', tone: 'warn' });
          return;
        }
        // With a bus, ship:livery drives the resync; without one, do it here.
        if (!this.bus) this._sync();
      });

      this._syncers.push(() => {
        const state = schemeState({ scheme, livery: this._livery() });
        card.classList.toggle('on', state === 'applied');
        tag.textContent = SCHEME_STATE_LABEL[state];
      });
    }
    return grid;
  }

  _statRow(stat) {
    const meta = SHIP_STAT_META[stat] ?? { label: stat };
    const row = el('div', `sm-stat sm-stat-${stat}`);
    const label = el('span', 'sm-stat-l', meta.label);
    const pips = el('span', 'sm-pips');
    const pipEls = [1, 2, 3].map((t) => {
      const p = el('i', 'sm-pip');
      p.title = `${meta.label} ${'I'.repeat(t)}`;
      pips.appendChild(p);
      return p;
    });
    const fx = el('span', 'sm-stat-fx');
    row.append(label, pips, fx);
    this._syncers.push(() => {
      const tier = Math.floor(Number(this.ships.getPowers?.(this._shipId)?.[stat]) || 0);
      pipEls.forEach((p, i) => p.classList.toggle('on', i < tier));
      fx.textContent = shipStatLine(this._shipId, stat, tier);
    });
    return row;
  }

  /* ---------------------------------------------------------------- */
  /* State                                                             */
  /* ---------------------------------------------------------------- */

  _setSlot(slotId, patch) {
    if (!this._shipId) return;
    this.ships.setLivery?.(this._shipId, { [slotId]: patch });
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
      if (patch && this._shipId) {
        this.ships.setLivery?.(this._shipId, patch);
        if (!this.bus) this._sync();
      }
    });
  }

  _sync() {
    /* TRAP 3. One deep copy per sync, not one per swatch/chip/card — saved and
     * restored re-entrantly, so a syncer that itself triggers a nested `_sync()`
     * (a bus handler firing while this one is still running) cannot leave the
     * cache pointed at the wrong livery once the outer call resumes. */
    const prev = this._liveryCache;
    this._liveryCache = this._shipId ? (this.ships.getLivery?.(this._shipId) ?? {}) : {};
    try {
      for (const fn of this._tabSyncers ?? []) fn();
      for (const fn of this._syncers) fn();
    } finally {
      this._liveryCache = prev;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Open / close                                                      */
  /* ---------------------------------------------------------------- */

  open() {
    if (this._open) return;
    const ship = this.ships?.selected ?? null;
    if (!ship) {
      this.bus?.emit('hud:notify', { text: 'There is no hull on a cradle here.', tone: 'warn' });
      return;
    }
    this._tabSyncers = [];
    this._buildFor(ship);
    this._open = true;
    this._hadLock = !!this.input?.locked;
    this.input?.setTextCapture?.(true);
    this.input?.exitLock?.();
    document.body.classList.add('sm-open');
    this.el.classList.add('open');
    this._frameHull(ship.id);
    this.bus?.emit('ship:menu:open', { shipId: ship.id });
  }

  close() {
    if (!this._open) return;
    this._open = false;
    this._releaseCamera();
    this.el.classList.remove('open');
    document.body.classList.remove('sm-open');
    this.input?.setTextCapture?.(false);
    if (this._hadLock) {
      /* TRAP 4. Browsers reject a lock request that follows an Escape-driven
       * exit too closely, and an uncaught rejection surfaces as a console error
       * mid-game. */
      setTimeout(() => {
        /* `reengage()` decides which engagement to re-take: the pointer lock
         * on a mouse session, the touch session on a phone. It used to be
         * `canvas.requestPointerLock()` here, which on a touch device does
         * nothing and left the player stood down with the world frozen behind
         * no card. @see core/Input.js `reengage` */
        const p = this.input?.reengage?.();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }, 140);
    }
    this.bus?.emit('ship:menu:close', {});
  }

  toggle() { if (this._open) this.close(); else this.open(); }

  _key(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (e.code === 'Escape' && this._open) {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  }

  /* ---------------------------------------------------------------- */
  /* The turntable                                                     */
  /* ---------------------------------------------------------------- */

  /**
   * Point the camera at the hull being painted.
   *
   * Reads the BUILT GROUP out of the live scene rather than a berth table:
   * `DockWorld` names each parked hull `yard:ship-<id>` and the box round it
   * is where the ship actually is, at whatever scale and pose it was built.
   * A framing derived from `YardPlan.BERTHS` would be a second description of
   * the same placement and would drift the first time a cradle moves.
   *
   * Silent no-op when there is no camera, no scene or no group: this is a
   * nicety on top of a panel that has to keep working, and a customiser that
   * refuses to open because a camera was not injected is a worse bug than the
   * one it is fixing.
   */
  _frameHull(shipId) {
    const cam = this.camera;
    const group = this.scene?.getObjectByName?.(`yard:ship-${shipId}`) ?? null;
    if (!cam || !group) return;

    const box = new THREE.Box3().setFromObject(group);
    if (box.isEmpty()) return;
    const centre = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.y, size.z);

    this._camSave = { pos: cam.position.clone(), quat: cam.quaternion.clone(), fov: cam.fov };

    /* Far enough that the whole hull fits the FREE part of the frame. The
     * panel covers the right 34%, so the usable width is 0.66 of it; the
     * distance is derived from the CAMERA'S OWN vertical FOV and then given
     * that margin, rather than picked by eye - so it is still right on a
     * different aspect ratio or a different hull.
     *
     * The FOV is READ and never written. `CameraRig` re-asserts `cam.fov`
     * every frame (it owns the zoom, the aim-down-sight pull and the mount
     * pull-back), so a value set here is overwritten before the next draw -
     * measured: this wrote 42 and the next frame read back 75, and the hull
     * was framed for a lens the camera was not using. Deriving from what the
     * rig is actually doing is both simpler and correct. */
    const fov = cam.fov || 75;
    const dist = (span * 0.62) / Math.tan((fov * Math.PI) / 360) / 0.66;

    this._orbit = {
      centre,
      /* Off the port bow to start, which is the three-quarter every ship in
       * every game is photographed from, and it is the angle that shows the
       * nose taper, the canopy and one engine at once. */
      angle: Math.PI * 0.62,
      radius: dist,
      height: centre.y + span * 0.30,
      /* One revolution in 48 s. Slow enough to read a colour against, fast
       * enough that the far side comes round while the player is still
       * choosing. */
      rate: (Math.PI * 2) / 48,
    };
  }

  /** Give the camera back to whatever was driving it. */
  _releaseCamera() {
    const cam = this.camera;
    const save = this._camSave;
    this._orbit = null;
    this._camSave = null;
    if (!cam || !save) return;
    cam.position.copy(save.pos);
    cam.quaternion.copy(save.quat);
    cam.fov = save.fov;
    cam.updateProjectionMatrix();
  }

  /**
   * Drive the turntable.
   *
   * Called from `main.js` AFTER the camera rig has placed the camera, which is
   * the only reason writing it here sticks - the rig would otherwise overwrite
   * this every frame. It is also outside the `uiPaused` gate, like every other
   * panel, so the hull keeps turning while the pause hub is up.
   *
   * Nothing is allocated: the orbit's `centre` is the only vector and it was
   * built once in `_frameHull`.
   */
  update(dt = 0) {
    const o = this._orbit;
    if (!this._open || !o || !this.camera) return;
    o.angle += o.rate * (Number.isFinite(dt) ? dt : 0);
    const cam = this.camera;
    cam.position.set(
      o.centre.x + Math.sin(o.angle) * o.radius,
      o.height,
      o.centre.z + Math.cos(o.angle) * o.radius,
    );
    /* Aimed a little to the RIGHT of the hull so the hull sits LEFT of centre,
     * clear of the panel. `.sm-panel` is `min(432px, 34vw)` on the right, so
     * the free centre of the frame is about 17% of the width to the left of
     * the true centre; a quarter of the orbit radius is that angle at this
     * distance and it holds as the hull turns. */
    _look.copy(o.centre);
    _right.set(Math.cos(o.angle), 0, -Math.sin(o.angle)).multiplyScalar(o.radius * 0.22);
    _look.add(_right);
    cam.lookAt(_look);
  }

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
