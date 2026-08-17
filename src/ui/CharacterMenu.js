import './character.css';
import {
  DEFAULT_CHARACTER,
  HAIR_STYLE_IDS,
  HEADGEAR_STYLES,
  HEADGEAR_LABELS,
  HEIGHT_RANGE,
  OUTFITS,
  SEX_PROFILES,
} from '../player/PlayerAvatar.js';
import { CHARACTER_SKINS } from '../systems/Cosmetics.js';

/**
 * F2 — the character panel.
 *
 * ## What this is, and what it deliberately is not
 *
 * Everything a player can change here already exists in `npc/Humanoid.js`:
 * `makeProportions` carries the shoulder/hip relationship, `SLOT` splits the
 * body mesh into six independently coloured material slots, `THEME_VARIANTS`
 * names the garments and the factory already accepts a skin tone, a hair style,
 * a hair colour and an eye colour. This file is a *menu over that*, and
 * `PlayerAvatar` owns the translation from the config here to the parameters
 * the factory wants. No character geometry is authored in this file, and none
 * should be: `Humanoid.js` is not ours to fork.
 *
 * ## The preview is the real body
 *
 * The obvious way to preview a character is a second `WebGLRenderer` in the
 * panel, and it is the wrong way here for a specific reason: a second GL
 * context has its own program cache, so every character shader would link a
 * second time — the exact several-second stall that TODO-V4 items 2, 4 and 5
 * are about. Rendering the same scene through a second camera needs hooks in
 * the engine and the post chain that this agent does not own.
 *
 * So the panel is a **side drawer**, not a modal: opening it pushes the camera
 * to third person, tells `PlayerAvatar` to hold the body visible with its arms
 * down and its weapon stowed, and turns it slowly on the spot. The player is
 * looking at the character they will actually be playing, lit by the world they
 * are actually standing in, and it costs nothing. The drawer sits on the right
 * because the third-person boom is offset to the player's right, which puts the
 * body on the left of frame.
 *
 * ## Why F2
 *
 * `C` is crouch. `F2` is free, is not a browser shortcut, and matches `F1`
 * (help), `F3` (diagnostics), `F5`/`F9` (save/load). The listener is on the
 * capture phase for the same reason `HelpMenu`'s is: `Input` stops reporting
 * while text capture is on — including the text capture this panel installs —
 * so polling `input.pressed()` would make the panel impossible to close.
 */

/* ------------------------------------------------------------------ */
/* Palettes                                                            */
/* ------------------------------------------------------------------ */

/**
 * Skin tones, copied from the ramp in `Humanoid.js`.
 *
 * These are not free-form for a reason recorded in that file: the ramp is
 * clamped at both ends so that no tone clips in sunlight and none falls below
 * ~0.06 linear, where ACES flattens a face into a silhouette. A colour picker
 * on skin would let a player choose a tone the lighting cannot render, so this
 * row is the whole option.
 */
const SKIN_TONES = [
  0xf0d6c0, 0xe6c5a8, 0xd9b18e, 0xcb9c78, 0xb98764,
  0xad7b56, 0x9a6949, 0x7d5339, 0x66412e, 0x926547,
];

const HAIR_COLORS = [
  0x1b1512, 0x2e2119, 0x4a3225, 0x6b4a2f, 0x8a6a3f,
  0xb99a63, 0xd8c08a, 0x7a7a7a, 0xbfbfbf, 0x6b2f1f,
];

const EYE_COLORS = [0x4a3a2a, 0x2f2a22, 0x3d5a6c, 0x4a6b45, 0x6b7f8f, 0x5a4630];

/**
 * Garment presets. Every one sits above the 0.045-linear floor the costume
 * palettes in `Humanoid.js` are built around — below that a character crushes to
 * a black cut-out against any background. The custom picker can go darker; the
 * presets are the guided path.
 */
const GARMENT_COLORS = [
  0x2f2b26, 0x33302b, 0x3a2e28, 0x2b2f33, 0x4e5f7a, 0x5f7268, 0x4a6b44, 0x6b4e35,
  0x8a6a42, 0x9a4433, 0xc9c2b4, 0xd2cec4, 0xf2f2f2, 0xe23b3b, 0x1f6fd0, 0x18a86b,
  0xf27b1f, 0x8f2fd0, 0xffd23b, 0x101418,
];

const ACCENT_COLORS = [
  0x2fe0ff, 0x35d6ff, 0x3bffd2, 0x8fff5a, 0xa8ff3b,
  0xffe14a, 0xffae2b, 0xff9a2b, 0xff6a3a, 0xff3bd2,
];

const BUILDS = [
  { v: 0, label: 'Slim' },
  { v: 1, label: 'Average' },
  { v: 2, label: 'Heavy' },
];

const HAIR_LABELS = {
  short: 'Short',
  crop: 'Crop',
  buzz: 'Buzz',
  ponytail: 'Ponytail',
  bun: 'Bun',
  long: 'Long',
  bald: 'Bald',
};

/** Silhouettes for the two sex cards. Drawn, not downloaded — house rule. */
const FIGURE_SVG = {
  male:
    '<svg viewBox="0 0 24 40" aria-hidden="true"><circle cx="12" cy="5" r="3.6"/>' +
    '<path d="M12 9.4c-3.2 0-5.6 1.5-6.2 3.6L4.2 20l2.5.8 1.1-4.1V24l-1 14h3.1l1.4-11.6h1.4L14.1 38h3.1l-1-14v-7.3l1.1 4.1 2.5-.8-1.6-7c-.6-2.1-3-3.6-6.2-3.6z"/></svg>',
  female:
    '<svg viewBox="0 0 24 40" aria-hidden="true"><circle cx="12" cy="5" r="3.5"/>' +
    '<path d="M12 9.4c-2.7 0-4.7 1.4-5.3 3.4L5.2 19.4l2.4.9 1-3.3.4 5.6-2.4 6.6h3.1L8.9 38h2.6l.9-9.6h.9l.9 9.6h2.6l-.8-8.8h3.1l-2.4-6.6.4-5.6 1 3.3 2.4-.9-1.5-6.6c-.6-2-2.6-3.4-5.3-3.4z"/></svg>',
};

/* ------------------------------------------------------------------ */
/* DOM helpers                                                         */
/* ------------------------------------------------------------------ */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

const hexStr = (v) => `#${(v & 0xffffff).toString(16).padStart(6, '0')}`;

/**
 * Custom colours are quantised to 6 bits a channel.
 *
 * `CharacterAssets` caches a material per colour and never evicts, so dragging
 * a native colour picker across the spectrum would mint a material per pointer
 * event. Two bits off each channel is imperceptible and cuts the population
 * fourfold; the rAF throttle in `_pick` does the rest. Presets are applied
 * unquantised so their swatch still matches exactly.
 */
const quantise = (v) => v & 0xfcfcfc;

export class CharacterMenu {
  /**
   * @param {{ root:HTMLElement, bus?:any, input?:any, avatar:any, player?:any, cosmetics?:any }} ctx
   */
  constructor({ root, bus, input, avatar, player, cosmetics }) {
    this.bus = bus ?? null;
    this.input = input ?? null;
    this.avatar = avatar ?? null;
    this.player = player ?? avatar?.player ?? null;
    this.cosmetics = cosmetics ?? null;

    this._open = false;
    this._hadLock = false;
    this._prevCameraMode = null;
    /** Pending colour write, coalesced to one per frame. */
    this._pending = null;
    this._pendingRaf = 0;

    /** @type {typeof DEFAULT_CHARACTER} */
    this._cfg = { ...(this.avatar?.characterConfig ?? DEFAULT_CHARACTER) };

    /** Controls that need re-marking when the config changes. @type {Array<() => void>} */
    this._syncers = [];

    this.el = this._build();
    root.appendChild(this.el);

    /** @type {Array<() => void>} */
    this._offs = [];
    if (bus) {
      // Single source of truth: every change — ours, a save load, the console —
      // comes back through the avatar's event, so the panel can never drift out
      // of step with the body it is describing.
      this._offs.push(
        bus.on('character:changed', ({ config }) => {
          if (!config) return;
          this._cfg = { ...config };
          this._sync();
        })
      );
      // A skin bought at the merchant lights its card here without a reopen.
      this._offs.push(bus.on('cosmetic:unlocked', () => this._sync()));
    }

    this._onKey = (e) => this._key(e);
    window.addEventListener('keydown', this._onKey, true);

    this._sync();
  }

  get isOpen() {
    return this._open;
  }

  /* ================================================================== */
  /* Build                                                              */
  /* ================================================================== */

  _build() {
    const wrap = el('div', 'ch-root');
    const panel = el('aside', 'ch-panel interactive');

    /* -- header ----------------------------------------------------- */
    const head = el('header', 'ch-head');
    const titles = el('div', 'ch-titles');
    titles.append(el('div', 'ch-kicker', 'Identity'), el('div', 'ch-title', 'CHARACTER'));
    const close = el('button', 'ch-x');
    close.type = 'button';
    close.append(el('b', null, 'F2'), el('span', null, 'close'));
    close.addEventListener('click', () => this.close());
    head.append(titles, close);

    /* -- scrolling body --------------------------------------------- */
    const body = el('div', 'ch-body');

    body.appendChild(this._sexSection());
    body.appendChild(
      this._section('Build', 'ch-build', (host, sec) => {
        host.appendChild(this._chips(BUILDS.map((b) => ({ v: b.v, label: b.label })), 'build'));
        const row = el('div', 'ch-slider');
        const input = el('input');
        input.type = 'range';
        input.min = String(Math.round(HEIGHT_RANGE.min * 100));
        input.max = String(Math.round(HEIGHT_RANGE.max * 100));
        input.step = '1';
        input.className = 'ch-range';
        input.setAttribute('aria-label', 'Height in centimetres');
        const out = el('b', 'ch-slider-val', '178 cm');
        input.addEventListener('input', () => this._set({ height: Number(input.value) / 100 }));
        row.append(el('span', 'ch-slider-l', 'Height'), input, out);
        host.appendChild(row);
        this._syncers.push(() => {
          const cm = Math.round(this._cfg.height * 100);
          if (document.activeElement !== input) input.value = String(cm);
          out.textContent = `${cm} cm`;
          sec.dataset.value = `${cm} cm`;
        });
      })
    );

    body.appendChild(
      this._section('Skin', 'ch-skin', (host, sec) => {
        host.appendChild(this._swatches(SKIN_TONES, 'skinTone', { custom: false }));
        this._syncers.push(() => {
          sec.dataset.value = '';
        });
      })
    );

    body.appendChild(
      this._section('Hair', 'ch-hair', (host, sec) => {
        host.appendChild(
          this._chips(HAIR_STYLE_IDS.map((id) => ({ v: id, label: HAIR_LABELS[id] ?? id })), 'hairStyle')
        );
        host.appendChild(this._swatches(HAIR_COLORS, 'hairColor', { custom: true }));
        this._syncers.push(() => {
          sec.dataset.value = HAIR_LABELS[this._cfg.hairStyle] ?? '';
        });
      })
    );

    /* Headgear sits directly after hair because that is the order the player
     * thinks in - it is worn over the top of it, and the two interact: a hood
     * hides most of a long style, so seeing them adjacent is the point. */
    body.appendChild(
      this._section('Headgear', 'ch-headgear', (host, sec) => {
        host.appendChild(
          this._chips(
            HEADGEAR_STYLES.map((id) => ({ v: id, label: HEADGEAR_LABELS[id] ?? id })),
            'headgear'
          )
        );
        this._syncers.push(() => {
          sec.dataset.value = HEADGEAR_LABELS[this._cfg.headgear] ?? '';
        });
      })
    );

    body.appendChild(
      this._section('Eyes', 'ch-eyes', (host) => {
        host.appendChild(this._swatches(EYE_COLORS, 'eyeColor', { custom: true }));
      })
    );

    body.appendChild(
      this._section('Face', 'ch-face', (host, sec) => {
        host.appendChild(
          this._chips([0, 1, 2, 3, 4, 5].map((i) => ({ v: i, label: String(i + 1) })), 'faceId', 'ch-chips-num')
        );
        this._syncers.push(() => {
          sec.dataset.value = `No. ${this._cfg.faceId + 1}`;
        });
      })
    );

    body.appendChild(
      this._section('Outfit', 'ch-outfit', (host, sec) => {
        host.appendChild(
          this._chips(
            Object.entries(OUTFITS).map(([id, o]) => ({ v: id, label: o.label })),
            'outfit'
          )
        );

    /* Trousers, chosen independently of the shirt.
     *
     * Right after Outfit, and labelled by what the garment actually is rather
     * than by the outfit it came from - a player picking legs does not care
     * that the tracksuit bottoms arrived with a tracksuit. */
    body.appendChild(
      this._section('Trousers', 'ch-legs', (host, sec) => {
        host.appendChild(
          this._chips(
            /* Labelled by the outfit, not by `legLabel`.
             *
             * legLabel says where that outfit's second colour lands - it reads
             * "Collar & yoke" on the one-piece suits, because those have no
             * separate trousers to colour. As chip text it produced two
             * identical "COLLAR & YOKE" entries and told the player nothing
             * about what they were picking. Here the choice is whose legs to
             * wear, so the answer is the garment's name. */
            Object.entries(OUTFITS).map(([id, o]) => ({ v: id, label: o.label })),
            'legs'
          )
        );
        this._syncers.push(() => {
          const o = OUTFITS[this._cfg.legs] ?? OUTFITS[this._cfg.outfit];
          sec.dataset.value = o?.label ?? '';
        });
      })
    );
        this._syncers.push(() => {
          sec.dataset.value = OUTFITS[this._cfg.outfit]?.label ?? '';
        });
      })
    );

    body.appendChild(
      this._section('Garment colours', 'ch-colors', (host) => {
        this._topLabel = el('div', 'ch-sub', 'Top');
        host.appendChild(this._topLabel);
        host.appendChild(this._swatches(GARMENT_COLORS, 'topColor', { custom: true }));
        this._legLabel = el('div', 'ch-sub', 'Trousers');
        host.appendChild(this._legLabel);
        host.appendChild(this._swatches(GARMENT_COLORS, 'legColor', { custom: true }));
        host.appendChild(el('div', 'ch-sub', 'Accent trim'));
        host.appendChild(this._swatches(ACCENT_COLORS, 'accentColor', { custom: true }));
        this._syncers.push(() => {
          const o = OUTFITS[this._cfg.outfit] ?? OUTFITS.flightsuit;
          this._topLabel.textContent = o.topLabel;
          this._legLabel.textContent = o.legLabel;
        });
      })
    );

    /* Signature skins - premium character colourways bought at a merchant. Owned
     * ones apply their preset; locked ones show a hint to buy in the market. */
    if (this.cosmetics) {
      body.appendChild(
        this._section('Signature skins', 'ch-skins', (host) => {
          host.appendChild(this._skinCards(CHARACTER_SKINS));
        })
      );
    }

    /* -- footer ----------------------------------------------------- */
    const foot = el('footer', 'ch-foot');
    const rand = el('button', 'ch-btn', 'Randomise');
    rand.type = 'button';
    rand.addEventListener('click', () => this._randomise());
    const reset = el('button', 'ch-btn ghost', 'Reset');
    reset.type = 'button';
    reset.addEventListener('click', () => this._set({ ...DEFAULT_CHARACTER }));
    const hint = el('div', 'ch-hint');
    hint.innerHTML = 'Changes apply to your body at once. <b>F5</b> saves them with the game.';
    foot.append(rand, reset, hint);

    panel.append(head, body, foot);
    wrap.appendChild(panel);

    // A click inside the drawer must not be read as a request to re-lock the
    // pointer, and must not fall through to the world behind it.
    panel.addEventListener('mousedown', (e) => e.stopPropagation());
    return wrap;
  }

  /** One titled block. `fill(host, section)` populates it. */
  _section(title, cls, fill) {
    const sec = el('section', `ch-sec ${cls}`);
    const h = el('h3', 'ch-sec-t');
    h.append(el('span', null, title));
    sec.appendChild(h);
    const host = el('div', 'ch-sec-b');
    sec.appendChild(host);
    fill(host, sec);
    return sec;
  }

  /** The two sex cards — the one control that changes the silhouette. */
  _sexSection() {
    const sec = el('section', 'ch-sec ch-sex');
    const h = el('h3', 'ch-sec-t');
    h.appendChild(el('span', null, 'Sex'));
    sec.appendChild(h);
    const host = el('div', 'ch-sec-b ch-sexrow');
    for (const [id, profile] of Object.entries(SEX_PROFILES)) {
      const card = el('button', 'ch-card');
      card.type = 'button';
      const fig = el('div', 'ch-fig');
      fig.innerHTML = FIGURE_SVG[id] ?? '';
      card.append(fig, el('b', null, profile.label));
      card.addEventListener('click', () => this._set({ sex: id }));
      host.appendChild(card);
      this._syncers.push(() => card.classList.toggle('on', this._cfg.sex === id));
    }
    sec.appendChild(host);
    return sec;
  }

  /**
   * A row of exclusive chips bound to one config field.
   * @param {Array<{v:any,label:string}>} options
   * @param {string} field
   */
  _chips(options, field, extra = '') {
    const row = el('div', `ch-chips ${extra}`);
    for (const o of options) {
      const b = el('button', 'ch-chip', o.label);
      b.type = 'button';
      b.addEventListener('click', () => this._set({ [field]: o.v }));
      row.appendChild(b);
      this._syncers.push(() => b.classList.toggle('on', this._cfg[field] === o.v));
    }
    return row;
  }

  /**
   * A row of colour swatches plus an optional native picker for anything the
   * presets do not cover.
   * @param {number[]} colors
   * @param {string} field
   */
  _swatches(colors, field, { custom = true } = {}) {
    const row = el('div', 'ch-sws');
    for (const c of colors) {
      const b = el('button', 'ch-sw');
      b.type = 'button';
      b.style.setProperty('--c', hexStr(c));
      b.title = hexStr(c);
      b.addEventListener('click', () => this._set({ [field]: c }));
      row.appendChild(b);
      this._syncers.push(() => b.classList.toggle('on', this._cfg[field] === c));
    }
    if (custom) {
      const label = el('label', 'ch-pick');
      const input = el('input');
      input.type = 'color';
      input.setAttribute('aria-label', `Custom ${field} colour`);
      input.addEventListener('input', () =>
        this._pick(field, quantise(Number.parseInt(input.value.slice(1), 16) || 0))
      );
      label.append(input, el('i'));
      label.title = 'Custom colour';
      row.appendChild(label);
      this._syncers.push(() => {
        const hex = hexStr(this._cfg[field]);
        if (document.activeElement !== input) input.value = hex;
        label.style.setProperty('--c', hex);
        label.classList.toggle('on', !colors.includes(this._cfg[field]));
      });
    }
    return row;
  }

  /**
   * A grid of premium skin cards. Owned skins apply their preset on click and
   * light up when active; locked ones wear a padlock and point the player at the
   * merchant. Ownership is read live from the wardrobe so a purchase relights the
   * card through the `cosmetic:unlocked` sync without a rebuild.
   * @param {Array<{id:string,name:string,blurb:string,preset:object}>} skins
   */
  _skinCards(skins) {
    const grid = el('div', 'ch-skingrid');
    for (const skin of skins) {
      const card = el('button', 'ch-skincard');
      card.type = 'button';

      const dots = el('span', 'ch-skindots');
      const colors = [skin.preset?.topColor, skin.preset?.legColor, skin.preset?.accentColor];
      for (const c of colors) {
        if (typeof c !== 'number') continue;
        const dot = el('i', 'ch-skindot');
        dot.style.background = hexStr(c);
        dots.appendChild(dot);
      }

      const text = el('span', 'ch-skintext');
      text.append(el('b', null, skin.name), el('small', null, skin.blurb));

      const lock = el('span', 'ch-skinlock');
      card.append(dots, text, lock);
      grid.appendChild(card);

      card.addEventListener('click', () => {
        if (!this.cosmetics?.has?.(skin.id)) {
          this.bus?.emit('hud:notify', {
            text: `Buy the ${skin.name} at a merchant to unlock it.`,
            tone: 'warn',
          });
          return;
        }
        this._set({ ...skin.preset });
      });

      this._syncers.push(() => {
        const owned = !!this.cosmetics?.has?.(skin.id);
        const active = owned && this._cfg.topColor === skin.preset.topColor
          && this._cfg.legColor === skin.preset.legColor
          && this._cfg.accentColor === skin.preset.accentColor;
        card.classList.toggle('locked', !owned);
        card.classList.toggle('on', active);
        lock.textContent = owned ? (active ? 'Equipped' : 'Owned') : '🔒 Market';
      });
    }
    return grid;
  }

  /* ================================================================== */
  /* State                                                              */
  /* ================================================================== */

  /** Apply a patch to the live body. The bus round-trip refreshes the panel. */
  _set(patch) {
    if (!this.avatar?.setCharacterConfig) return;
    this._cfg = { ...this.avatar.setCharacterConfig(patch) };
    // The avatar emits `character:changed` synchronously and the handler above
    // syncs; call it directly too so the panel still tracks with no bus wired.
    if (!this.bus) this._sync();
  }

  /**
   * Colour-picker write, coalesced to one per animation frame.
   *
   * A native colour input fires `input` on every pointer move, and each distinct
   * colour mints (and permanently caches) a material. One write per frame keeps
   * that bounded without making the drag feel laggy.
   */
  _pick(field, value) {
    this._pending = { ...(this._pending ?? {}), [field]: value };
    if (this._pendingRaf) return;
    this._pendingRaf = requestAnimationFrame(() => {
      this._pendingRaf = 0;
      const patch = this._pending;
      this._pending = null;
      if (patch) this._set(patch);
    });
  }

  /** Mark every control from the current config. Cheap: class writes only. */
  _sync() {
    for (const fn of this._syncers) fn();
  }

  _randomise() {
    const pick = (arr) => arr[(Math.random() * arr.length) | 0];
    const sex = Math.random() < 0.5 ? 'male' : 'female';
    const profile = SEX_PROFILES[sex];
    this._set({
      sex,
      build: (Math.random() * 3) | 0,
      height: Math.round((profile.height - 0.07 + Math.random() * 0.14) * 100) / 100,
      faceId: (Math.random() * 6) | 0,
      skinTone: pick(SKIN_TONES),
      hairStyle: pick(HAIR_STYLE_IDS),
      // Bare-headed most of the time. Randomising uniformly across seven
      // options would put a hat on six characters out of seven, which is a
      // costume party rather than a crowd.
      headgear: Math.random() < 0.45 ? pick(HEADGEAR_STYLES) : 'none',
      hairColor: pick(HAIR_COLORS),
      eyeColor: pick(EYE_COLORS),
      outfit: (() => { this._randTop = pick(Object.keys(OUTFITS)); return this._randTop; })(),
      // Matching most of the time: a randomiser that pairs a robe with sports
      // shorts three times in four is a gag generator, not a character.
      legs: Math.random() < 0.7 ? this._randTop : pick(Object.keys(OUTFITS)),
      topColor: pick(GARMENT_COLORS),
      legColor: pick(GARMENT_COLORS),
      accentColor: pick(ACCENT_COLORS),
    });
  }

  /* ================================================================== */
  /* Open / close                                                       */
  /* ================================================================== */

  open() {
    if (this._open) return;
    this._open = true;

    this._hadLock = !!this.input?.locked;
    this.input?.setTextCapture?.(true);
    this.input?.exitLock?.();
    document.body.classList.add('ch-menu-open');

    // Third person is the preview. Remember what the player had so closing the
    // panel puts them back where they were rather than in a mode they did not
    // choose.
    const rig = this.player?.cameraRig ?? this.avatar?.player?.cameraRig ?? null;
    this._prevCameraMode = rig?.mode ?? null;
    rig?.setMode?.('third');
    this.avatar?.setPreview?.(true);

    this.el.classList.add('open');
    this._sync();
    this.bus?.emit('character:open', {});
  }

  close() {
    if (!this._open) return;
    this._open = false;
    this.el.classList.remove('open');
    document.body.classList.remove('ch-menu-open');

    this.avatar?.setPreview?.(false);
    const rig = this.player?.cameraRig ?? this.avatar?.player?.cameraRig ?? null;
    if (rig && this._prevCameraMode && this._prevCameraMode !== rig.mode) {
      rig.setMode?.(this._prevCameraMode);
    }
    this._prevCameraMode = null;

    this.input?.setTextCapture?.(false);
    if (this._hadLock) {
      // Browsers reject a lock request that follows an Escape-driven exit too
      // closely, and an uncaught rejection surfaces as a console error mid-game.
      setTimeout(() => {
        try {
          const p = this.input?.canvas?.requestPointerLock?.();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch {
          /* the pause overlay is the fallback; never throw out of a menu close */
        }
      }, 140);
    }
    this.bus?.emit('character:close', {});
  }

  toggle() {
    if (this._open) this.close();
    else this.open();
  }

  _key(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (e.code === 'F2') {
      e.preventDefault();
      e.stopPropagation();
      // While the chat box owns the keyboard F2 is a character, not a key — but
      // once *this* panel is open the capture is ours, so it must still close.
      if (!this._open && this.input?.textCaptured) return;
      if (this._open) this.close();
      else this.open();
      return;
    }
    if (e.code === 'Escape' && this._open) {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  }

  /** Present for symmetry with the other UI modules; the panel is event driven. */
  update() {}

  dispose() {
    this.close();
    window.removeEventListener('keydown', this._onKey, true);
    for (const off of this._offs) {
      try {
        off();
      } catch {
        /* a bus that already cleared its handlers is not an error */
      }
    }
    this._offs.length = 0;
    if (this._pendingRaf) cancelAnimationFrame(this._pendingRaf);
    this._pendingRaf = 0;
    this.el?.remove();
  }
}
