import { CONFIG } from '../core/Config.js';

/**
 * Weapon selector strip + the procedural icon set the rest of the HUD shares.
 *
 * The strip is a bottom-centre row of three slots (machine gun / fireball /
 * bow). It is *driven*, never authoritative: `weapon:switched` moves the
 * highlight and `Loadout.weapons` refreshes the ammo readouts. Clicking a slot
 * only asks — the Loadout still decides.
 *
 * Every glyph in here is drawn as inline SVG from path data authored in a
 * 64x40 box, so there is no image asset anywhere in the chain and the icons
 * inherit the HUD's colour tokens through `currentColor`/CSS variables.
 *
 * It lives directly under `#ui-root` rather than inside `.hud` for one reason:
 * `.hud` opens a stacking context below the pause overlay, and the slots have
 * to stay clickable while the pointer is unlocked — which is the only time a
 * mouse click can reach the DOM at all.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Slots the HUD shows before `Loadout` exists, so the strip is never empty. */
const DEFAULT_SLOTS = [
  { id: 'machinegun', name: CONFIG.weapon.machinegun.name },
  { id: 'fireball', name: 'Ember Caster' },
  { id: 'bow', name: 'Recurve Bow' },
];

/**
 * Icon geometry. Each entry is `[tag, className, data]`; `data` is path data
 * for `path`, or `"cx cy r"` for `circle`. Authored facing right in a 64x40
 * viewBox so the whole set shares one optical weight.
 */
const ICONS = {
  machinegun: [
    ['path', 'gi-dim', 'M3 15h13v10H3z'],
    ['path', 'gi-dim', 'M3 25h6.5v3.5H3z'],
    ['path', 'gi-solid', 'M16 13.5h30v13H16z'],
    ['path', 'gi-line', 'M22.5 10.5h17.5v3H22.5z'],
    ['path', 'gi-solid', 'M46 17.5h12v5H46z'],
    ['path', 'gi-hot', 'M56.5 15.5h5.5v9h-5.5z'],
    ['path', 'gi-solid', 'M28 26.5h9.5l-3 11.5h-9.5z'],
    ['path', 'gi-solid', 'M16.5 26.5h6.5l-3.5 9h-7z'],
    ['path', 'gi-dim', 'M39.5 26.5h5v6.5h-5z'],
    ['circle', 'gi-hot', '20.5 19.5 1.7'],
  ],
  fireball: [
    ['path', 'gi-line', 'M27 12.5C18.5 9.5 12 6.5 3.5 3.5'],
    ['path', 'gi-line', 'M26.5 20H2'],
    ['path', 'gi-line', 'M27 27.5C18.5 30.5 12 33.5 3.5 36.5'],
    ['circle', 'gi-solid', '39 20 9.5'],
    ['circle', 'gi-hot', '39 20 5'],
    ['circle', 'gi-hot', '13.5 11 1.5'],
    ['circle', 'gi-hot', '10 28.5 1.3'],
  ],
  bow: [
    ['path', 'gi-line gi-thick', 'M47 3.5C58 12.5 58 27.5 47 36.5'],
    ['path', 'gi-line gi-thin', 'M47 3.5L31 20l16 16.5'],
    ['path', 'gi-solid', 'M22 19h32v2.2H22z'],
    ['path', 'gi-hot', 'M53.5 15L63 20l-9.5 5z'],
    ['path', 'gi-solid', 'M21.5 13.5L30 20l-8.5 6.5z'],
  ],
  hoverboard: [
    ['path', 'gi-solid', 'M8 17.5c6-4 42-4 48 0-6 4-42 4-48 0z'],
    ['path', 'gi-dim', 'M17 22h30v3.5H17z'],
    ['circle', 'gi-hot', '20 24 2.4'],
    ['circle', 'gi-hot', '44 24 2.4'],
    ['path', 'gi-line gi-thin', 'M2 30h16M6 34.5h14M2 11h11'],
  ],
  dragon: [
    ['path', 'gi-solid', 'M31 19C22 6.5 12.5 2 4 5c5 8 14 15 24 19z'],
    ['path', 'gi-solid', 'M33 19c9-12.5 18.5-17 27-14-5 8-14 15-24 19z'],
    ['path', 'gi-dim', 'M32 13.5c3 0 4 2.5 4 6.5l-2 12-2 6-2-6-2-12c0-4 1-6.5 4-6.5z'],
    ['path', 'gi-hot', 'M32 4.5c2.6 0 4.2 2 4.2 4.6S34.6 14 32 14s-4.2-2-4.2-4.9S29.4 4.5 32 4.5z'],
    ['circle', 'gi-dark', '30.2 9 0.95'],
    ['circle', 'gi-dark', '33.8 9 0.95'],
  ],
};

function sv(tag, attrs) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/**
 * Build one of the shared procedural glyphs.
 * @param {'machinegun'|'fireball'|'bow'|'hoverboard'|'dragon'} id
 * @returns {SVGSVGElement}
 */
export function makeIcon(id) {
  const spec = ICONS[id] ?? ICONS.machinegun;
  const root = sv('svg', { class: `gicon gicon-${id}`, viewBox: '0 0 64 40', focusable: 'false' });
  for (let i = 0; i < spec.length; i++) {
    const [tag, cls, data] = spec[i];
    if (tag === 'circle') {
      const p = data.split(' ');
      root.appendChild(sv('circle', { class: cls, cx: p[0], cy: p[1], r: p[2] }));
    } else {
      root.appendChild(sv('path', { class: cls, d: data }));
    }
  }
  return root;
}

export class WeaponWheel {
  /**
   * @param {{ root:HTMLElement, bus:any, onSelect:(id:string, index:number)=>void }} ctx
   */
  constructor({ root, bus, onSelect }) {
    this.bus = bus;
    this.onSelect = onSelect;
    this.activeIndex = 0;

    /** @type {Array<{id:string,name:string,el:HTMLElement,nameEl:HTMLElement,ammoEl:HTMLElement,resEl:HTMLElement,bar:HTMLElement,max:number,ammo:number,reserve:number,locked:boolean,pop:number}>} */
    this.slots = [];

    const strip = el('div', 'wstrip');
    strip.appendChild(el('div', 'wstrip-rule'));
    this.el = strip;
    root.appendChild(strip);

    this.setWeapons(DEFAULT_SLOTS, true);
    this.setActive(0, false);
  }

  /** Fade the strip in with the rest of the HUD. */
  setLive(live) {
    this.el.classList.toggle('is-live', !!live);
  }

  /** Hide while the player is dead, so the death card owns the screen. */
  setHidden(hidden) {
    this.el.classList.toggle('hidden', !!hidden);
  }

  /**
   * Rebuild the strip. Called once with defaults, then again the first time a
   * real `Loadout` shows up.
   * @param {Array<{id:string,name:string,ammo?:number,reserve?:number,magazine?:number}>} list
   * @param {boolean} [locked] mark non-machinegun slots as not yet online
   */
  setWeapons(list, locked = false) {
    if (!Array.isArray(list) || !list.length) return;
    const sig = list.map((w) => w?.id ?? '?').join('|');
    if (sig === this._sig) {
      this.syncAmmo(list);
      return;
    }
    this._sig = sig;

    for (const s of this.slots) s.el.remove();
    this.slots.length = 0;

    for (let i = 0; i < list.length; i++) {
      const w = list[i] ?? {};
      const id = w.id ?? `w${i}`;
      const slot = el('button', `wslot w-${id}`);
      slot.type = 'button';
      slot.dataset.index = String(i);
      slot.setAttribute('aria-label', `Select ${w.name ?? id}`);

      const key = el('span', 'wslot-key', String(i + 1));
      const ico = el('span', 'wslot-ico');
      ico.appendChild(makeIcon(id));

      const meta = el('span', 'wslot-meta');
      const nameEl = el('span', 'wslot-name', String(w.name ?? id).toUpperCase());
      const ammoRow = el('span', 'wslot-ammo');
      const ammoEl = el('b', null, '—');
      const resEl = el('i', null, '');
      ammoRow.append(ammoEl, resEl);
      meta.append(nameEl, ammoRow);

      const bar = el('span', 'wslot-bar');
      const barFill = el('i');
      bar.appendChild(barFill);

      slot.append(key, ico, meta, bar);
      slot.addEventListener('mousedown', (e) => {
        // Stop the pause overlay underneath from treating this as "resume".
        e.preventDefault();
        e.stopPropagation();
        this.onSelect?.(id, i);
      });

      this.el.appendChild(slot);
      this.slots.push({
        id,
        name: String(w.name ?? id),
        el: slot,
        nameEl,
        ammoEl,
        resEl,
        bar: barFill,
        max: Math.max(1, w.magazine ?? w.ammo ?? 1),
        ammo: -1,
        reserve: -1,
        barW: -1,
        locked: locked && id !== 'machinegun',
        pop: 0,
      });
      slot.classList.toggle('locked', locked && id !== 'machinegun');
    }

    this.syncAmmo(list);
    this.setActive(Math.min(this.activeIndex, this.slots.length - 1), false);
  }

  /**
   * Refresh the per-slot readouts. Cheap enough to call a few times a second;
   * every write is guarded so an unchanged value never dirties layout.
   * @param {Array<{id:string,name?:string,ammo?:number,reserve?:number,magazine?:number}>} list
   */
  syncAmmo(list) {
    if (!Array.isArray(list)) return;
    for (let i = 0; i < list.length && i < this.slots.length; i++) {
      const w = list[i];
      const s = this.slots[i];
      if (!w || !s) continue;

      if (w.name && w.name !== s.name) {
        s.name = w.name;
        s.nameEl.textContent = String(w.name).toUpperCase();
      }
      const ammo = typeof w.ammo === 'number' ? Math.round(w.ammo) : null;
      // A real ammo count is the signal that the weapon actually exists now.
      if (s.locked && ammo != null) {
        s.locked = false;
        s.el.classList.remove('locked');
      }

      const reserve = typeof w.reserve === 'number' ? Math.round(w.reserve) : null;
      if (typeof w.magazine === 'number' && w.magazine > 0) s.max = w.magazine;
      else if (ammo != null && ammo > s.max) s.max = ammo;

      if (ammo != null && ammo !== s.ammo) {
        s.ammo = ammo;
        s.ammoEl.textContent = String(ammo);
        const f = Math.max(0, Math.min(1, ammo / Math.max(1, s.max)));
        const w100 = Math.round(f * 100);
        if (w100 !== s.barW) {
          s.barW = w100;
          s.bar.style.transform = `scaleX(${(f).toFixed(3)})`;
        }
        s.el.classList.toggle('low', f <= 0.2);
      }
      if (reserve != null && reserve !== s.reserve) {
        s.reserve = reserve;
        s.resEl.textContent = reserve > 0 ? `/${reserve}` : '';
      }
    }
  }

  /**
   * Move the highlight.
   * @param {number|string} which slot index or weapon id
   * @param {boolean} [animate] play the switch pop
   */
  setActive(which, animate = true) {
    let idx = typeof which === 'number' ? which : this.slots.findIndex((s) => s.id === which);
    if (idx < 0 || idx >= this.slots.length) idx = 0;
    const changed = idx !== this.activeIndex;
    this.activeIndex = idx;

    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      const on = i === idx;
      if (s.el.classList.contains('active') !== on) s.el.classList.toggle('active', on);
      if (on && animate && changed) {
        s.el.classList.remove('just');
        void s.el.offsetWidth; // restart the keyframe on a rapid re-switch
        s.el.classList.add('just');
        s.pop = 0.45;
      }
    }
    return this.slots[idx]?.id ?? null;
  }

  get activeId() {
    return this.slots[this.activeIndex]?.id ?? null;
  }

  update(dt) {
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s.pop > 0) {
        s.pop -= dt;
        if (s.pop <= 0) s.el.classList.remove('just');
      }
    }
  }

  dispose() {
    this.el.remove();
    this.slots.length = 0;
  }
}
