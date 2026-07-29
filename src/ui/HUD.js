import { CONFIG } from '../core/Config.js';
import { Minimap } from './Minimap.js';
import { ChatBox } from './ChatBox.js';
import { ChatClient } from '../ai/ChatClient.js';
import { WeaponWheel, makeIcon } from './WeaponWheel.js';
import { HelpMenu } from './HelpMenu.js';

/**
 * The whole player-facing interface: crosshair, health, ammo, weapon selector,
 * charge meter, credits, mount readout, minimap, kill feed, prompts, toasts,
 * chat, debug readout, pause and world-transition wipe.
 *
 * Everything is DOM + one canvas. Style lives in `hud.css`; this file only ever
 * writes values that actually changed, because a HUD that dirties layout every
 * frame will cost more than the renderer it sits on top of.
 *
 * The v2 systems (Loadout, MountManager, UnstuckSystem, Economy) may not exist
 * at construction time — every read of them is optional-chained and every panel
 * has a sensible idle state, so the HUD degrades to exactly the v1 experience
 * when they are absent.
 */

/* Module-scope scratch — the frame path must not allocate. */
const _dir = { x: 0, z: 0 };

const DMG_SLOTS = 5;
const DMG_LIFE = 1.5;
const KF_LIFE = 6.5;
const TOAST_LIFE = 3.6;
const RELOAD_ARC_C = 2 * Math.PI * 18;

/* Charge ring around the crosshair: r=30 inside a 100x100 viewBox. */
const CHARGE_R = 30;
const CHARGE_C = 2 * Math.PI * CHARGE_R;
/** Charging weapons emit every frame; this is how long we wait before fading. */
const CHARGE_HOLD = 0.14;
const CAM_MODE_LIFE = 1.6;
const MOUNT_LABELS = { hoverboard: 'Hoverboard', dragon: 'Dragon', car: 'Ground Car' };
/** Boost meter fallback rates, used only when the mount exposes no charge. */
const BOOST_DRAIN = 0.34;
const BOOST_RECHARGE = 0.17;

/** How long the "what just hit you" readout and the dry-fire warning linger. */
const ATTACK_LIFE = 2.4;
const NOAMMO_LIFE = 1.15;

/**
 * Human names for the item ids the inventory agent emits. Unknown ids fall
 * through to the raw id rather than being dropped, so a new item type shows up
 * in the HUD the day it is added instead of silently going missing.
 */
const ITEM_LABELS = {
  bullet: 'bullets',
  arrow: 'arrows',
  fireball_charge: 'fireball charges',
  credits: 'credits',
  medkit: 'medkit',
};

/** Labels for the weapon ids hostiles report through `npc:attack`. */
const NPC_WEAPON_LABELS = {
  sidearm: 'sidearm',
  rifle: 'rifle',
  bow: 'bow',
  staff: 'staff',
  melee: 'melee',
};

/**
 * Slots the strip shows before a real `Loadout` appears. WeaponWheel's own
 * defaults predate the sword, so the HUD publishes the v3 set instead — the
 * Loadout still overwrites it the moment it exists.
 */
const DEFAULT_SLOTS = [
  { id: 'machinegun', name: CONFIG.weapon.machinegun.name },
  { id: 'fireball', name: 'Ember Caster' },
  { id: 'bow', name: 'Recurve Bow' },
  { id: 'sword', name: 'Arc Sabre' },
];

/**
 * Icons WeaponWheel does not ship (it is owned by another agent and predates
 * the sword and the car). Same 64x40 authoring box and the same `gi-*` classes
 * so they inherit the identical palette; drawn here and injected into the slot
 * or the mount badge after the wheel has built it.
 */
const EXTRA_ICONS = {
  sword: [
    ['path', 'gi-solid', 'M8 20 L40 15.4 L46 20 L40 24.6 Z'],
    ['path', 'gi-hot', 'M8 20 L40 18.6 L40 21.4 Z'],
    ['path', 'gi-dim', 'M45.5 12.5h3.6v15h-3.6z'],
    ['path', 'gi-solid', 'M49 17.6h8.5v4.8H49z'],
    ['circle', 'gi-hot', '59.6 20 2.4'],
    ['path', 'gi-line gi-thin', 'M50 25.5h6.5M50 14.5h6.5'],
  ],
  car: [
    ['path', 'gi-solid', 'M5 22h54v7H5z'],
    ['path', 'gi-dim', 'M14 12.5h30l8 9.5H9z'],
    ['path', 'gi-hot', 'M17 14.5h11v6H17zM31 14.5h11l4.5 6H31z'],
    ['circle', 'gi-solid', '18 29.5 5.2'],
    ['circle', 'gi-solid', '46 29.5 5.2'],
    ['circle', 'gi-dark', '18 29.5 2'],
    ['circle', 'gi-dark', '46 29.5 2'],
    ['path', 'gi-hot', 'M59 23.5h4v3h-4z'],
  ],
};

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

/**
 * Build one of the HUD-local glyphs (`sword`, `car`) in WeaponWheel's format.
 * Returns null for anything the wheel already knows, so callers can fall back.
 * @param {string} id
 * @returns {SVGSVGElement|null}
 */
function makeExtraIcon(id) {
  const spec = EXTRA_ICONS[id];
  if (!spec) return null;
  const root = svg('svg', { class: `gicon gicon-${id}`, viewBox: '0 0 64 40', focusable: 'false' });
  for (let i = 0; i < spec.length; i++) {
    const [tag, cls, data] = spec[i];
    if (tag === 'circle') {
      const p = data.split(' ');
      root.appendChild(svg('circle', { class: cls, cx: p[0], cy: p[1], r: p[2] }));
    } else {
      root.appendChild(svg('path', { class: cls, d: data }));
    }
  }
  return root;
}

/** The wheel's glyph when it has one, ours otherwise. */
function iconFor(id) {
  return makeExtraIcon(id) ?? makeIcon(id);
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Frame-rate independent exponential approach. */
const approach = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

export class HUD {
  /**
   * @param {{ bus:any, engine:any, input:any, root:HTMLElement, player:any,
   *           worldManager:any, npcManager:any, portals:any }} ctx
   */
  constructor({ bus, engine, input, root, player, worldManager, npcManager, portals, caches, contracts }) {
    this.bus = bus;
    this.engine = engine;
    this.input = input;
    this.root = root;
    this.player = player;
    this.worldManager = worldManager;
    this.npcManager = npcManager;
    this.portals = portals;
    this.caches = caches ?? null;
    this.contracts = contracts ?? null;
    /** Reused by `_weapon()`; see the note there on why this is not a spread. */
    this._weaponView = {
      id: null, name: null, ammo: 0, reserve: 0, magazine: 0,
      ammoItem: null, isReloading: false, spread: undefined,
    };

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

    /* -- stamina state (v3) -------------------------------------------- */
    this._stamMax = CONFIG.player?.maxStamina ?? 100;
    this._stamina = this._stamMax;
    this._stamShown = 1;
    this._stamWritten = -1;
    this._stamPctText = -1;
    this._stamDrain = 0;

    /* -- ammo state --------------------------------------------------- */
    this._ammo = -1;
    this._reserve = -1;
    this._magazine = 0;
    this._reloadT = 0;
    this._reloadDur = 0;
    this._pollT = 0;
    this._bagText = -1;
    this._noAmmoT = 0;
    this._attackT = 0;

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

    /* -- v2: late-bound systems --------------------------------------- */
    this._att = {};
    this._loadout = null;
    this._mounts = null;
    this._unstuck = null;
    this._economy = null;
    this._sysPollT = 0;

    /* -- v2: weapons / charge ----------------------------------------- */
    this._weaponId = 'machinegun';
    this._charge = 0;
    this._chargeWritten = -1;
    this._chargeHold = 0;
    this._chargeFull = false;
    this._chargeShown = false;

    /* -- v2: credits --------------------------------------------------- */
    this._credits = 0;
    this._creditsShown = 0;
    this._creditsText = -1;
    this._creditFloats = [];

    /* -- v2: mounts ---------------------------------------------------- */
    this._mountId = null;
    this._boost = 1;
    this._boostActive = false;
    this._boostWritten = -1;

    /* -- v2: unstuck / camera / save ----------------------------------- */
    this._stuck = false;
    this._camModeT = 0;
    this._saveExpectT = 0;
    this._pipT = 0;
    this._bootPatched = false;
    this._bootBusyPatched = false;
    this._bootPctText = -1;

    /* -- v3: portal busy hold ------------------------------------------ */
    this._wipeHolding = false;

    this._build();
    this._wire();

    // The boot screen is created by main.js *after* the HUD, so patch its
    // control legend and busy state on the next microtask rather than reaching
    // for it now.
    queueMicrotask(() => {
      this._patchBootControls();
      this._patchBootBusy();
    });
  }

  /**
   * Bind the v2 systems once main.js has constructed them. Optional — if it is
   * never called the HUD picks the same objects up off `window.GAME`, so the
   * new panels work either way.
   * @param {{loadout?:any, mounts?:any, unstuck?:any, economy?:any,
   *          cameraRig?:any, save?:any, stamina?:any, inventory?:any}} systems
   */
  attach(systems = {}) {
    Object.assign(this._att, systems);
    this._sysPollT = 0;
    return this;
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
    this._buildCharge(hud);
    this._buildCamMode(hud);
    this._buildVitals(hud);
    this._buildAmmo(hud);
    this._buildMinimap(hud);
    this._buildMount(hud);
    this._buildPrompt(hud);
    this._buildStuck(hud);
    this._buildToasts(hud);
    this._buildDebug(hud);
    this._buildHelpChip(hud);
    this._buildDeadCard(hud);

    this.root.appendChild(hud);

    this._buildWipe();
    this._buildPause();

    // The selector sits outside `.hud` so its slots stay clickable above the
    // pause overlay — pointer lock swallows clicks, so the only moment a slot
    // can actually be pressed is while the cursor is free.
    this.wheel = new WeaponWheel({
      root: this.root,
      bus: this.bus,
      onSelect: (id, index) => this._requestWeapon(id, index),
    });
    // Publish the v3 slot list (the wheel's own defaults stop at the bow) and
    // then decorate any slot whose glyph the wheel does not own.
    this.wheel.setWeapons(DEFAULT_SLOTS, true);
    this._decorateSlots();

    this.help = new HelpMenu({ root: this.root, bus: this.bus, input: this.input });

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

    // v3 `npc:attack`: the arcs say *where* it came from, this says *what* it
    // was. Sits below the crosshair so both read as one answer to "what hit me".
    const at = el('div', 'attackline');
    this.attackWho = el('span', 'attack-who', '');
    this.attackWeapon = el('span', 'attack-weapon', '');
    this.attackDmg = el('span', 'attack-dmg', '');
    at.append(this.attackWho, this.attackWeapon, this.attackDmg);
    hud.appendChild(at);
    this.attackLine = at;
  }

  /**
   * Charge ring for the fireball and the bow. It orbits the crosshair just
   * outside the blades' maximum spread so it never fights them for the centre.
   */
  _buildCharge(hud) {
    const wrap = el('div', 'charge');
    const s = svg('svg', { class: 'charge-svg', viewBox: '0 0 100 100' });
    s.appendChild(svg('circle', { class: 'ctrk', cx: 50, cy: 50, r: CHARGE_R }));

    // Quarter ticks so the player can read "nearly there" without a number.
    for (const f of [0.25, 0.5, 0.75]) {
      const a = f * Math.PI * 2 - Math.PI / 2;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      s.appendChild(
        svg('line', {
          class: 'ctick',
          x1: (50 + c * (CHARGE_R - 4)).toFixed(2),
          y1: (50 + sn * (CHARGE_R - 4)).toFixed(2),
          x2: (50 + c * (CHARGE_R + 4)).toFixed(2),
          y2: (50 + sn * (CHARGE_R + 4)).toFixed(2),
        })
      );
    }

    this.chargeVal = svg('circle', { class: 'cval', cx: 50, cy: 50, r: CHARGE_R });
    this.chargeVal.setAttribute('stroke-dasharray', `0 ${CHARGE_C.toFixed(2)}`);
    s.appendChild(this.chargeVal);

    wrap.append(s, el('div', 'charge-flare'), el('div', 'charge-tag', 'RELEASE'));
    hud.appendChild(wrap);
    this.chargeEl = wrap;
  }

  /** Brief pill under the crosshair whenever CameraRig flips view mode. */
  _buildCamMode(hud) {
    const c = el('div', 'cammode');
    this.camModeText = el('span', null, 'FIRST PERSON');
    c.append(el('i', 'cammode-key', 'V'), this.camModeText);
    hud.appendChild(c);
    this.camMode = c;
  }

  /**
   * Top-left vitals stack: credits, then health, then stamina.
   *
   * v3 moves health out of the bottom-left corner. The three readouts a player
   * checks between fights now share one column and one reading order, and the
   * corner they vacated goes to the chat panel and the help affordance instead
   * of being fought over.
   *
   * They are laid out by the flex column rather than by three sets of absolute
   * coordinates, so the stack cannot drift apart when a panel's height changes.
   */
  _buildVitals(hud) {
    const col = el('div', 'vitals');
    hud.appendChild(col);
    this.vitals = col;
    this._buildCredits(col);
    this._buildHealth(col);
    this._buildStamina(col);
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

  /**
   * Stamina, directly under health. Driven by `stamina:changed` from the
   * movement agent, and polled from `GAME.stamina` so it self-heals if that
   * system is built after the HUD or an event is missed.
   *
   * It is deliberately slimmer than the health bar: it is a budget, not a life
   * total, and it must not compete with health for attention.
   */
  _buildStamina(hud) {
    const p = el('div', 'panel stamina');

    const top = el('div', 'stam-top');
    top.appendChild(el('div', 'panel-label', 'Stamina'));
    this.stamPct = el('div', 'stam-pct', '100%');
    top.appendChild(this.stamPct);

    const bar = el('div', 'stam-bar');
    this.stamFill = el('div', 'stam-fill');
    bar.append(this.stamFill, el('div', 'stam-ticks'), el('div', 'stam-gloss'));

    p.append(top, bar);
    hud.appendChild(p);
    this.staminaPanel = p;
  }

  /** Persistent "F1 Help" affordance in the corner health used to occupy. */
  _buildHelpChip(hud) {
    const c = el('div', 'helpchip');
    c.append(el('b', null, 'F1'), el('span', null, 'Help & controls'));
    hud.appendChild(c);
    this.helpChip = c;
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

    // v3: the reserve number is now the bag count, so name the source. When a
    // weapon needs no ammo at all (the sword) the row reads "melee" instead of
    // showing a meaningless zero.
    const bag = el('div', 'ammo-bag');
    this.ammoBagLabel = el('span', 'ammo-bag-l', 'BAG');
    this.ammoBagVal = el('span', 'ammo-bag-v', '—');
    bag.append(this.ammoBagLabel, this.ammoBagVal);
    this.ammoBag = bag;

    // Dry-fire warning. Lives in the ammo panel so the player's eye is sent to
    // the number that explains it, not to the middle of the screen.
    this.noAmmoTag = el('div', 'ammo-dry', 'NO AMMO — PRESS R');

    p.append(this.ammoName, row, this.pips, bag, this.noAmmoTag);
    hud.appendChild(p);
    this.ammoPanel = p;
  }

  /**
   * Credits ledger, top-left. Earning has to feel like something, so the value
   * counts up rather than snapping and each award throws a `+5` off the panel.
   */
  _buildCredits(hud) {
    const p = el('div', 'panel credits');

    const ico = svg('svg', { class: 'credits-ico', viewBox: '0 0 24 24' });
    ico.appendChild(svg('path', { class: 'ci-outer', d: 'M12 1.6 22.4 12 12 22.4 1.6 12z' }));
    ico.appendChild(svg('path', { class: 'ci-inner', d: 'M12 6.4 17.6 12 12 17.6 6.4 12z' }));
    ico.appendChild(svg('circle', { class: 'ci-core', cx: 12, cy: 12, r: 2.1 }));

    const body = el('div', 'credits-body');
    body.appendChild(el('div', 'panel-label', 'Credits'));
    this.creditsVal = el('div', 'credits-val', '0');
    body.appendChild(this.creditsVal);

    this.savePip = el('div', 'credits-pip');
    this.savePip.title = 'autosave';

    this.creditFloatWrap = el('div', 'credits-floats');

    p.append(ico, body, this.savePip, this.creditFloatWrap);
    hud.appendChild(p);
    this.creditsPanel = p;
  }

  /** Active mount, its boost reservoir, and the dismount affordance. */
  _buildMount(hud) {
    const p = el('div', 'panel mount');

    const head = el('div', 'mount-head');
    this.mountIco = el('div', 'mount-ico');
    this.mountIco.appendChild(makeIcon('hoverboard'));
    const names = el('div', 'mount-names');
    names.appendChild(el('div', 'panel-label', 'Mounted'));
    this.mountName = el('div', 'mount-name', '—');
    names.appendChild(this.mountName);
    head.append(this.mountIco, names);

    const bar = el('div', 'mount-boost');
    this.boostFill = el('i');
    bar.append(this.boostFill, el('u'));

    const foot = el('div', 'mount-foot');
    foot.append(el('span', 'mount-key', 'F'), el('span', 'mount-foot-t', 'Dismount'));
    this.boostTag = el('span', 'mount-tag', 'BOOST');
    foot.appendChild(this.boostTag);

    p.append(head, bar, foot);
    hud.appendChild(p);
    this.mountPanel = p;
  }

  /** `[K] Unstuck` affordance, shown only while UnstuckSystem reports trouble. */
  _buildStuck(hud) {
    const s = el('div', 'stuck');
    s.append(el('div', 'stuck-key', 'K'), el('div', 'stuck-text', 'Unstuck'));
    hud.appendChild(s);
    this.stuckEl = s;

    const ring = el('div', 'unstuck-fx');
    ring.appendChild(el('b', null, 'POSITION RESET'));
    hud.appendChild(ring);
    this.unstuckFx = ring;
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
      caches: this.caches,
      contracts: this.contracts,
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

  /**
   * World transition.
   *
   * v3 turns this from a timed animation into a *state*. Building a destination
   * world can take several seconds, and the old fixed-duration wipe finished
   * long before the world did, leaving the player staring at a frozen scene
   * with no evidence anything was happening. The overlay now closes, then holds
   * — indefinitely, with a CSS spinner — until `world:changed` says the world
   * is actually there.
   */
  _buildWipe() {
    const w = el('div', 'wipe');
    w.appendChild(el('div', 'wipe-bars'));
    w.appendChild(el('div', 'wipe-slab top'));
    w.appendChild(el('div', 'wipe-slab bot'));
    const label = el('div', 'wipe-label');
    this.wipeKicker = el('div', 'wipe-kicker', 'Traversing the Nexus');
    this.wipeName = el('div', 'wipe-name', '');

    const busy = el('div', 'wipe-busy');
    const spin = el('div', 'boot-spinner sm');
    spin.append(el('i', 'bs-ring r1'), el('i', 'bs-ring r2'), el('i', 'bs-ring r3'), el('i', 'bs-core'));
    this.wipeStage = el('div', 'wipe-stage', 'Generating world');
    busy.append(spin, this.wipeStage);
    this.wipePatience = el(
      'div',
      'wipe-patience',
      'This can take a moment — the world is being generated from scratch.'
    );

    label.append(this.wipeKicker, this.wipeName, busy, this.wipePatience);
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
      this.wheel.setHidden(true);
      this._endCharge(false);
      this._killRow(this._nameOf(killerId), 'YOU', 'on-player');
    });

    this._on('player:respawned', () => {
      this._dead = false;
      this.el.classList.remove('dead');
      this.wheel.setHidden(false);
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
      // The destination exists now — release the transition hold.
      this._endWipe();
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

    this._wireV2();
    this._wireV3();
  }

  /* ---------------------------------------------------------------- v3 -- */

  _wireV3() {
    /* --- stamina ------------------------------------------------------- */
    this._on('stamina:changed', ({ stamina, max }) => {
      if (typeof max === 'number' && max > 0 && max !== this._stamMax) this._stamMax = max;
      if (typeof stamina === 'number') {
        // Falling stamina is the only interesting case, so only that lights up.
        if (stamina < this._stamina - 0.01) this._stamDrain = 0.35;
        this._stamina = stamina;
      }
    });

    /* --- weapons: dry fire --------------------------------------------- */
    this._on('weapon:noammo', ({ id, itemId }) => {
      this._noAmmoT = NOAMMO_LIFE;
      this.ammoPanel.classList.add('dry');
      // Restart the shake even when the player is holding the trigger down.
      this.ammoPanel.classList.remove('dry-kick');
      void this.ammoPanel.offsetWidth;
      this.ammoPanel.classList.add('dry-kick');
      const what = ITEM_LABELS[itemId] ?? (itemId ? String(itemId) : 'ammunition');
      this.noAmmoTag.textContent = `OUT OF ${String(what).toUpperCase()}`;
      if (!this._noAmmoWarned || this._noAmmoWarned !== id) {
        this._noAmmoWarned = id;
        this.notify(`Out of ${what} — buy more at the marketplace (B)`, 'warn');
      }
    });

    /* --- what just hit me ---------------------------------------------- */
    this._on('npc:attack', ({ npc, weaponId, damage }) => {
      this.attackWho.textContent = String(npc?.name ?? 'HOSTILE').toUpperCase();
      this.attackWeapon.textContent = NPC_WEAPON_LABELS[weaponId] ?? String(weaponId ?? 'attack');
      this.attackDmg.textContent = damage != null ? `−${Math.round(damage)}` : '';
      this._attackT = ATTACK_LIFE;
      this.attackLine.classList.add('show');
      this.attackLine.classList.remove('kick');
      void this.attackLine.offsetWidth;
      this.attackLine.classList.add('kick');
    });

    /* --- loot / inventory ---------------------------------------------- */
    this._on('loot:collected', ({ itemId, qty }) => {
      const n = Math.max(1, Math.round(qty ?? 1));
      const name = ITEM_LABELS[itemId] ?? String(itemId ?? 'salvage');
      this.notify(`+${n} ${name}`, 'loot');
    });
    this._on('inventory:full', ({ itemId }) => {
      const name = ITEM_LABELS[itemId] ?? String(itemId ?? 'item');
      this.notify(`Bag full — ${name} left behind`, 'warn');
    });
    this._on('market:trade', ({ itemId, qty, kind }) => {
      const name = ITEM_LABELS[itemId] ?? String(itemId ?? 'goods');
      const n = Math.max(1, Math.round(qty ?? 1));
      this.notify(kind === 'sell' ? `Sold ${n} ${name}` : `Bought ${n} ${name}`, 'save');
    });

    /* --- help ----------------------------------------------------------- */
    // The chip is the affordance; dim it while the panel it advertises is open.
    this._on('help:open', () => this.el.classList.add('helping'));
    this._on('help:close', () => this.el.classList.remove('helping'));
  }

  /* ---------------------------------------------------------------- v2 -- */

  _wireV2() {
    /* --- weapons ------------------------------------------------------- */
    this._on('weapon:switched', ({ id, name, index }) => {
      this._weaponId = id ?? this._weaponId;
      this.wheel.setActive(typeof index === 'number' ? index : id, true);
      this.el.dataset.weapon = this._weaponId;
      this.wheel.el.dataset.weapon = this._weaponId;
      if (name) {
        this.ammoName.textContent = String(name);
        this._ammoNameText = name;
      }
      // Force the ammo panel to re-read; the new weapon's counts are unrelated.
      this._ammo = -1;
      this._reserve = -1;
      this._magazine = 0;
      this._pollT = 0;
      this.ammoPanel.classList.remove('reloading');
      this._reloadDur = 0;
      this.ammoPanel.classList.add('swap');
      clearTimeout(this._swapTimer);
      this._swapTimer = setTimeout(() => this.ammoPanel.classList.remove('swap'), 340);
      this._endCharge(false);
    });

    this._on('weapon:charging', ({ id, charge01 }) => {
      if (id && id !== this._weaponId) {
        this._weaponId = id;
        this.el.dataset.weapon = id;
      }
      this._setCharge(charge01);
    });

    /* --- credits ------------------------------------------------------- */
    this._on('credits:changed', ({ credits, delta }) => {
      if (typeof credits === 'number') this._credits = credits;
      if (delta) this._creditFloat(delta);
    });

    /* --- mounts -------------------------------------------------------- */
    this._on('mount:summoned', ({ id }) => {
      this.notify(`${MOUNT_LABELS[id] ?? id} materialising`, 'info');
    });
    this._on('mount:mounted', ({ id }) => this._setMount(id));
    // The v2 contract names this `mount:dismounted`; accept the brief's
    // `mount:dismissed` spelling too so a mismatch cannot strand the panel.
    this._on('mount:dismounted', () => this._setMount(null));
    this._on('mount:dismissed', () => this._setMount(null));
    this._on('mount:boost', ({ active }) => {
      this._boostActive = !!active;
      this.mountPanel.classList.toggle('boosting', this._boostActive);
    });

    /* --- save / load --------------------------------------------------- */
    this._on('save:written', () => {
      this._pulsePip();
      const manual = this._saveExpectT > 0;
      this._saveExpectT = 0;
      this.notify(manual ? 'Progress saved' : 'Autosaved', manual ? 'save' : 'quiet');
    });
    this._on('save:loaded', () => {
      this._pulsePip();
      this.notify('Progress restored', 'save');
    });
    this._on('save:error', ({ message }) => {
      this.notify(`Save failed — ${message ?? 'unknown fault'}`, 'error');
    });

    /* --- unstuck ------------------------------------------------------- */
    // The confirmation is the centre-screen shockwave, not a toast:
    // UnstuckSystem already raises its own `hud:notify`, and two messages for
    // one recovery reads as a bug.
    this._on('player:unstuck', () => {
      this._stuck = false;
      this.stuckEl.classList.remove('show');
      const fx = this.unstuckFx;
      fx.classList.remove('run');
      void fx.offsetWidth;
      fx.classList.add('run');
    });

    /* --- camera -------------------------------------------------------- */
    this._on('camera:mode', ({ mode }) => {
      this.camModeText.textContent = mode === 'third' ? 'THIRD PERSON' : 'FIRST PERSON';
      this.camMode.classList.toggle('third', mode === 'third');
      this.camMode.classList.add('show');
      this._camModeT = CAM_MODE_LIFE;
    });
  }

  /**
   * Give any slot the wheel could not draw a glyph one of ours. WeaponWheel is
   * owned by another agent and its icon table stops at the bow, so the sword
   * would otherwise wear the machine gun's silhouette.
   */
  _decorateSlots() {
    const slots = this.wheel?.slots;
    if (!slots) return;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (!EXTRA_ICONS[s.id]) continue;
      const ico = s.el.querySelector('.wslot-ico');
      if (!ico || ico.dataset.hudIcon === s.id) continue;
      ico.dataset.hudIcon = s.id;
      ico.textContent = '';
      ico.appendChild(makeExtraIcon(s.id));
    }
  }

  /** A slot was clicked — ask the Loadout, and announce it for anyone listening. */
  _requestWeapon(id, index) {
    this._loadout?.select?.(typeof index === 'number' ? index : id);
    this.bus.emit('weapon:select', { id, index });
  }

  /**
   * Rewrite the boot screen's control legend so the new keybinds are taught
   * before the player ever needs them. main.js owns that markup, so the HUD
   * patches it in place rather than asking for a wiring change.
   */
  _patchBootControls() {
    if (this._bootPatched) return;
    const list = this.root.querySelector('.boot-controls');
    if (!list) return;
    this._bootPatched = true;
    /* Kept current with what the game actually has.
     *
     * This list is the only controls reference a player sees before they are
     * in the world, and it had fallen a long way behind - no free-climbing, no
     * parkour, none of the mounts or systems added since. `F1` is called out
     * last and explicitly as the full reference, because this card can only
     * ever be a summary. */
    list.innerHTML = [
      ['WASD', 'Move'],
      ['Shift', 'Sprint / Boost'],
      ['Space', 'Jump / Swim'],
      ['Space', 'Hold at a wall to climb it'],
      ['Shift Space', 'Running leap'],
      ['Ctrl / C', 'Crouch'],
      ['Ctrl', 'Dive in air / roll on landing'],
      ['LMB', 'Fire / Charge'],
      ['RMB', 'Aim'],
      ['R', 'Reload'],
      ['1 2 3 4', 'Weapons'],
      ['Wheel', 'Cycle weapon'],
      ['V', 'First / third person'],
      ['M', 'Mount wheel'],
      ['F', 'Dismount'],
      ['Space / Ctrl', 'Fly up / down'],
      ['I', 'Inventory'],
      ['B', 'Marketplace'],
      ['K', 'Unstuck'],
      ['F2', 'Customise character'],
      ['F4', 'Audio options'],
      ['F5 / F9', 'Save / Load'],
      ['[ ]', 'Map zoom'],
      ['E', 'Talk / Pick up / Portal'],
      ['T', 'Chat'],
      ['Esc', 'Release cursor'],
      ['F1', 'Full controls, any time'],
    ]
      .map(([k, v]) => `<span><b>${k}</b> ${v}</span>`)
      .join('');
  }

  /* ====================================================================== */
  /* Boot busy state                                                        */
  /* ====================================================================== */

  /**
   * Turn main.js's progress bar into a real busy state.
   *
   * The user was seeing Chrome's "page unresponsive" dialog during boot, which
   * is what Chrome shows when the main thread stops answering — and a ~15 s
   * shader warmup does exactly that between yields. The fix is not to make the
   * page faster (the warmup is deliberate: see the 63 s first-bow stall) but to
   * make it *visibly alive*, because Chrome's heuristic and the player's
   * patience both key on the same thing.
   *
   * Everything added here animates in CSS on `transform`/`opacity` only, so the
   * compositor keeps it moving even while the main thread is inside a long
   * synchronous compile. **Nothing in this path may be driven from rAF.**
   *
   * main.js owns the boot markup, so this adopts the elements if they are
   * already there and creates them if they are not — the HUD works against
   * either version of main.js. Progress and stage name are mirrored from
   * `.boot-bar-fill`'s width and `.boot-status`'s text through a
   * MutationObserver, so `loader.setStatus(text, progress)` stays the only hook
   * main.js needs. `setBootStage()` is the direct route if it prefers one.
   */
  _patchBootBusy() {
    if (this._bootBusyPatched) return;
    const screen = this.root.querySelector('.boot-screen');
    if (!screen) return;
    this._bootBusyPatched = true;

    const inner = screen.querySelector('.boot-inner') ?? screen;
    const bar = inner.querySelector('.boot-bar');
    const status = inner.querySelector('.boot-status');

    let busy = inner.querySelector('.boot-busy');
    if (!busy) {
      busy = el('div', 'boot-busy');
      const spin = el('div', 'boot-spinner');
      // Three nested rings, each its own layer, each on a pure rotate — the
      // cheapest thing a compositor can keep animating without the main thread.
      spin.append(el('i', 'bs-ring r1'), el('i', 'bs-ring r2'), el('i', 'bs-ring r3'), el('i', 'bs-core'));
      const pct = el('div', 'boot-pct', '0%');
      busy.append(spin, pct);
      if (bar) inner.insertBefore(busy, bar);
      else inner.appendChild(busy);
    }
    this.bootBusy = busy;
    this.bootPct = busy.querySelector('.boot-pct');

    let patience = inner.querySelector('.boot-patience');
    if (!patience) {
      patience = el(
        'div',
        'boot-patience',
        'This can take a moment — the world is being generated from scratch, and every shader is compiled up front so nothing stutters later.'
      );
      if (status && status.nextSibling) inner.insertBefore(patience, status.nextSibling);
      else inner.appendChild(patience);
    }
    this.bootPatience = patience;

    screen.classList.add('busy');

    // Mirror main.js's writes. Observing costs nothing while nothing changes,
    // and it means the orchestrator does not have to call us at all.
    if (typeof MutationObserver === 'function' && (bar || status)) {
      const fill = bar?.querySelector('.boot-bar-fill') ?? null;
      const read = () => {
        if (fill) {
          const w = parseFloat(fill.style.width);
          if (Number.isFinite(w)) this._writeBootPct(w);
        }
      };
      const obs = new MutationObserver(read);
      if (fill) obs.observe(fill, { attributes: true, attributeFilter: ['style'] });
      this._bootObs = obs;
      read();
    }

    // The moment main.js hides the screen, stop pretending to be busy.
    if (typeof MutationObserver === 'function') {
      const done = new MutationObserver(() => {
        if (screen.classList.contains('boot-hide')) {
          screen.classList.remove('busy');
          this._bootObs?.disconnect();
          done.disconnect();
        }
      });
      done.observe(screen, { attributes: true, attributeFilter: ['class'] });
      this._bootHideObs = done;
    }
  }

  _writeBootPct(pct01to100) {
    const v = Math.max(0, Math.min(100, Math.round(pct01to100)));
    if (v === this._bootPctText || !this.bootPct) return;
    this._bootPctText = v;
    this.bootPct.textContent = `${v}%`;
    // At 100% the work is done and the screen is waiting on the player. A
    // spinner that keeps turning over "CLICK TO ENTER" would be a lie.
    if (v >= 100) this.bootBusy?.closest('.boot-screen')?.classList.remove('busy');
  }

  /**
   * Direct hook for main.js: report the stage the boot is in.
   * Equivalent to `loader.setStatus(text, progress)` — either works, and using
   * both is harmless.
   * @param {string} [text] stage name, e.g. "Generating medieval"
   * @param {number} [progress01] 0..1
   */
  setBootStage(text, progress01) {
    this._patchBootBusy();
    const screen = this.root.querySelector('.boot-screen');
    if (!screen) return;
    if (text) {
      const status = screen.querySelector('.boot-status');
      if (status && status.textContent !== text) status.textContent = text;
    }
    if (typeof progress01 === 'number') {
      this._writeBootPct(progress01 <= 1 ? progress01 * 100 : progress01);
      const fill = screen.querySelector('.boot-bar-fill');
      if (fill) fill.style.width = `${Math.round(Math.min(1, Math.max(0, progress01)) * 100)}%`;
    }
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
    this.wheel.setLive(true);
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
   * `save` / `error` / `quiet` are HUD-local additions for save feedback; the
   * `hud:notify` contract tones are unchanged.
   * @param {string} text
   * @param {'info'|'warn'|'kill'|'lore'|'save'|'error'|'quiet'} [tone]
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
    if (!this._bootPatched) this._patchBootControls();
    if (!this._bootBusyPatched) this._patchBootBusy();

    this._updateInput(dt);
    this._updateSystems(dt);
    this._updateHealth(dt, elapsed);
    this._updateStamina(dt);
    this._updateAmmo(dt);
    this._updateCrosshair(dt);
    this._updateCharge(dt);
    this._updateCredits(dt);
    this._updateMount(dt);
    this._updateDamageDirs(dt);
    this._updatePrompt();
    this._updateTransients(dt);
    this._updateDebug(dt);
    this.wheel.update(dt);
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

    // The wheel belongs to weapon switching now (CONTRACTS-V2 §1); minimap zoom
    // moved to the bracket keys. Deliberately no `consumeWheel()` here.
    if (this.input.pressed('BracketLeft')) this._zoomMap(1);
    if (this.input.pressed('BracketRight')) this._zoomMap(-1);

    // F5 is a save request; remember it briefly so the confirmation toast can
    // tell a deliberate save from a background autosave.
    if (this.input.pressed('F5')) this._saveExpectT = 1.4;
    if (this._saveExpectT > 0) this._saveExpectT -= dt;

    if (this.input.pressed('KeyT')) {
      this._openChat(this._chatNpc);
    } else if (this.input.pressed('KeyE') && this._chatNpc && !this._nearPortal) {
      this._openChat(this._chatNpc);
    }
  }

  /** `[` / `]`. Flashes the minimap rim so the change is felt, not just seen. */
  _zoomMap(dir) {
    this.minimap.zoom(dir);
    const m = this.mapLabel?.parentElement;
    if (!m) return;
    m.classList.remove('zoomed');
    void m.offsetWidth;
    m.classList.add('zoomed');
  }

  /* ====================================================================== */
  /* v2 systems                                                             */
  /* ====================================================================== */

  /**
   * Resolve the late-built systems a few times a second and pull the values
   * that have no event: per-weapon ammo, the live credit total, stuck state.
   */
  _updateSystems(dt) {
    if (this._camModeT > 0) {
      this._camModeT -= dt;
      if (this._camModeT <= 0) this.camMode.classList.remove('show');
    }
    if (this._pipT > 0) {
      this._pipT -= dt;
      if (this._pipT <= 0) this.savePip.classList.remove('on');
    }

    this._sysPollT -= dt;
    if (this._sysPollT > 0) return;
    this._sysPollT = 0.2;

    const g = typeof window !== 'undefined' ? window.GAME : null;
    this._loadout = this._att.loadout ?? g?.loadout ?? null;
    this._mounts = this._att.mounts ?? g?.mounts ?? null;
    this._unstuck = this._att.unstuck ?? g?.unstuck ?? null;
    this._economy = this._att.economy ?? g?.economy ?? null;

    this._stam = this._att.stamina ?? g?.stamina ?? null;
    this._inventory = this._att.inventory ?? g?.inventory ?? null;

    const list = this._loadout?.weapons;
    if (Array.isArray(list) && list.length) {
      this.wheel.setWeapons(list);
      this._decorateSlots();
    }

    const c = this._economy?.credits;
    if (typeof c === 'number' && c !== this._credits) this._credits = c;

    // `isStuck` is a cheap getter, but the prompt only needs polling cadence.
    const stuck = !!this._unstuck?.isStuck && !this._dead;
    if (stuck !== this._stuck) {
      this._stuck = stuck;
      this.stuckEl.classList.toggle('show', stuck);
    }

    // Mount state may have been established before the HUD was listening.
    const activeId = this._mounts?.mounted ? this._mounts?.active?.id ?? null : null;
    if (activeId !== undefined && activeId !== this._mountId && this._mounts) this._setMount(activeId);
  }

  /* -------------------------------------------------------------- charge -- */

  /**
   * Write the charge ring immediately — a charge meter that lerps toward the
   * value reads as input lag, which is exactly the wrong feeling for a weapon
   * the player is holding down.
   */
  _setCharge(v) {
    const c = clamp01(typeof v === 'number' ? v : 0);
    this._charge = c;
    this._chargeHold = CHARGE_HOLD;

    if (!this._chargeShown) {
      this._chargeShown = true;
      this.chargeEl.classList.add('show');
    }
    if (Math.abs(c - this._chargeWritten) > 0.004) {
      this._chargeWritten = c;
      this.chargeVal.setAttribute(
        'stroke-dasharray',
        `${(c * CHARGE_C).toFixed(2)} ${CHARGE_C.toFixed(2)}`
      );
    }
    const full = c >= 0.995;
    if (full !== this._chargeFull) {
      this._chargeFull = full;
      this.chargeEl.classList.toggle('full', full);
    }
  }

  /** Charging stopped. `released` plays the discharge flare. */
  _endCharge(released) {
    if (!this._chargeShown) return;
    this._chargeShown = false;
    this._chargeHold = 0;
    this._chargeFull = false;
    this.chargeEl.classList.remove('show', 'full');
    if (released) {
      this.chargeEl.classList.remove('fire');
      void this.chargeEl.offsetWidth;
      this.chargeEl.classList.add('fire');
    }
    this._charge = 0;
    this._chargeWritten = -1;
    this.chargeVal.setAttribute('stroke-dasharray', `0 ${CHARGE_C.toFixed(2)}`);
  }

  _updateCharge(dt) {
    if (this._chargeHold <= 0) return;
    this._chargeHold -= dt;
    // No `weapon:charging` for a couple of frames means the shot went out.
    if (this._chargeHold <= 0) this._endCharge(this._charge > 0.12);
  }

  /* ------------------------------------------------------------- credits -- */

  /** Floating `+5`. Pooled by removal on animation end, never per-frame. */
  _creditFloat(delta) {
    const sign = delta > 0 ? '+' : '';
    const f = el('div', `credit-float${delta < 0 ? ' neg' : ''}`, `${sign}${Math.round(delta)}`);
    // Scatter them slightly so a burst of kills does not stack into one blur.
    f.style.setProperty('--dx', `${(Math.random() * 22 - 11).toFixed(1)}px`);
    this.creditFloatWrap.appendChild(f);
    this._creditFloats.push({ el: f, life: 1.25 });
    while (this._creditFloats.length > 6) this._creditFloats.shift().el.remove();

    this.creditsPanel.classList.remove('bump');
    void this.creditsPanel.offsetWidth;
    this.creditsPanel.classList.add('bump');
  }

  _updateCredits(dt) {
    for (let i = this._creditFloats.length - 1; i >= 0; i--) {
      const f = this._creditFloats[i];
      f.life -= dt;
      if (f.life <= 0) {
        f.el.remove();
        this._creditFloats.splice(i, 1);
      }
    }

    if (this._creditsShown !== this._credits) {
      // Count up fast but visibly — the number itself is the reward.
      const diff = this._credits - this._creditsShown;
      const step = Math.max(1, Math.abs(diff) * 6 * dt);
      this._creditsShown =
        Math.abs(diff) <= step ? this._credits : this._creditsShown + Math.sign(diff) * step;
      const shown = Math.round(this._creditsShown);
      if (shown !== this._creditsText) {
        this._creditsText = shown;
        this.creditsVal.textContent = shown.toLocaleString('en-GB');
      }
    }
  }

  _pulsePip() {
    this.savePip.classList.remove('on');
    void this.savePip.offsetWidth;
    this.savePip.classList.add('on');
    this._pipT = 1.5;
  }

  /* -------------------------------------------------------------- mounts -- */

  _setMount(id) {
    if (id === this._mountId) return;
    this._mountId = id ?? null;
    const on = !!this._mountId;
    this.mountPanel.classList.toggle('show', on);
    this.el.classList.toggle('mounted', on);
    if (!on) {
      this._boostActive = false;
      this.mountPanel.classList.remove('boosting');
      return;
    }
    this.mountName.textContent = MOUNT_LABELS[this._mountId] ?? String(this._mountId).toUpperCase();
    this.mountIco.textContent = '';
    this.mountIco.appendChild(iconFor(this._mountId));
    this.mountPanel.dataset.mount = this._mountId;
    this.mountPanel.classList.remove('in');
    void this.mountPanel.offsetWidth;
    this.mountPanel.classList.add('in');
    this._boost = 1;
  }

  _updateMount(dt) {
    if (!this._mountId) return;

    // Prefer the mount's own reservoir; simulate a plausible one otherwise so
    // the meter is never a dead decoration.
    const live = this._mounts?.active;
    const reported = live?.boost01 ?? live?.boostCharge ?? live?.boost;
    if (typeof reported === 'number' && Number.isFinite(reported)) {
      this._boost = clamp01(reported);
    } else if (this._boostActive) {
      this._boost = Math.max(0, this._boost - BOOST_DRAIN * dt);
    } else {
      this._boost = Math.min(1, this._boost + BOOST_RECHARGE * dt);
    }

    const w = Math.round(this._boost * 200);
    if (w !== this._boostWritten) {
      this._boostWritten = w;
      this.boostFill.style.transform = `scaleX(${this._boost.toFixed(3)})`;
    }
    const empty = this._boost < 0.12;
    if (this.mountPanel.classList.contains('empty') !== empty) {
      this.mountPanel.classList.toggle('empty', empty);
    }
    const tag = empty ? 'RECHARGING' : this._boostActive ? 'BOOSTING' : 'BOOST';
    if (this._boostTagText !== tag) {
      this._boostTagText = tag;
      this.boostTag.textContent = tag;
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

  /* ------------------------------------------------------------ stamina -- */

  /**
   * Stamina reads exactly like health so the stack has one grammar, but it is
   * smoothed harder: it changes every frame while sprinting, and a bar that
   * tracks that literally is visual noise.
   */
  _updateStamina(dt) {
    // Poll as well as listen, so the bar is right even before the first event.
    const s = this._stam;
    if (s) {
      const live = typeof s.stamina === 'number' ? s.stamina : typeof s.value === 'number' ? s.value : null;
      const max = typeof s.max === 'number' ? s.max : typeof s.maxStamina === 'number' ? s.maxStamina : null;
      if (max && max > 0) this._stamMax = max;
      if (live != null) {
        if (live < this._stamina - 0.01) this._stamDrain = 0.35;
        this._stamina = live;
      }
    }

    const frac = clamp01(this._stamina / Math.max(1, this._stamMax));
    this._stamShown = approach(this._stamShown, frac, 16, dt);

    if (Math.abs(this._stamShown - this._stamWritten) > 0.002) {
      this._stamWritten = this._stamShown;
      this.stamFill.style.transform = `scaleX(${this._stamShown.toFixed(4)})`;
    }

    const pct = Math.round(this._stamShown * 100);
    if (pct !== this._stamPctText) {
      this._stamPctText = pct;
      this.stamPct.textContent = `${pct}%`;
    }

    this._stamDrain = Math.max(0, this._stamDrain - dt);
    const cls = this.staminaPanel.classList;
    const spent = frac < 0.3;
    const empty = frac <= 0.02;
    const draining = this._stamDrain > 0 && !empty;
    if (cls.contains('low') !== spent) cls.toggle('low', spent);
    if (cls.contains('empty') !== empty) cls.toggle('empty', empty);
    if (cls.contains('draining') !== draining) cls.toggle('draining', draining);
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

  /** The Loadout's active weapon when there is one, else the legacy slot. */
  /**
   * The active weapon, as the *loadout descriptor* rather than the instance.
   *
   * This distinction is the whole bug. A weapon instance reports its own
   * private `reserve`, and for anything that spends straight out of the bag -
   * the fireball - that private counter does not exist, so `Fireball.reserve`
   * is a hard-coded `0`. The panel therefore read zero charges no matter how
   * many were actually in the bag, and stayed at zero through a resupply.
   *
   * `Loadout.weapons` exists precisely to answer this: it resolves `reserve`
   * and `bagAmmo` from the inventory for every weapon that draws from it, and
   * reuses its objects so this is allocation-free at the 5 Hz it is polled.
   *
   * The instance is kept as the fallback for the pre-Loadout boot window and
   * for fields the descriptor does not carry.
   *
   * @returns {object|null}
   */
  _weapon() {
    const inst = this._loadout?.current ?? this.player?.weapon ?? null;
    const list = this._loadout?.weapons;
    if (inst && list) {
      const d = list.find((x) => x.active) ?? list.find((x) => x.id === inst.id);
      if (d) {
        // Copied into a reused object rather than spread: this is polled, and
        // Loadout reuses its descriptors specifically so the HUD allocates
        // nothing. `isReloading` is the instance's name for what the descriptor
        // calls `reloading`, bridged here rather than at every read site.
        const v = this._weaponView;
        v.id = d.id;
        v.name = d.name;
        v.ammo = d.ammo;
        v.reserve = d.reserve;
        v.magazine = d.magazine;
        v.ammoItem = d.ammoItem ?? null;
        v.isReloading = d.reloading === true;
        // Not on the descriptor, and the crosshair bloom reads it every frame -
        // taking it straight off the instance keeps that working.
        v.spread = inst.spread;
        return v;
      }
    }
    return inst;
  }

  /**
   * Reserve ammunition now lives in the inventory bag, so the panel names it.
   * The weapon's `reserve` already reports the bag count under the v3 contract;
   * asking the Inventory directly is the fallback for a weapon that has not
   * been converted yet, and `null` means "this weapon needs no ammunition".
   */
  _updateBagRow(w) {
    const ammoItem = w?.ammoItem ?? w?.ammoItemId ?? null;
    const melee = w && ammoItem === null && (w.magazine == null || w.magazine === 0);

    if (melee) {
      if (this._bagText !== 'melee') {
        this._bagText = 'melee';
        this.ammoBagLabel.textContent = 'MELEE';
        this.ammoBagVal.textContent = '∞';
      }
      this.ammoBag.classList.toggle('none', false);
      return;
    }

    let n = typeof w?.reserve === 'number' ? w.reserve : null;
    if (n == null && ammoItem && this._inventory?.bagCount) {
      try {
        n = this._inventory.bagCount(ammoItem);
      } catch {
        n = null;
      }
    }
    const label = ammoItem ? (ITEM_LABELS[ammoItem] ?? ammoItem).toUpperCase() : 'BAG';
    const text = n == null ? '—' : String(Math.max(0, Math.round(n)));
    const key = `${label}|${text}`;
    if (key !== this._bagText) {
      this._bagText = key;
      this.ammoBagLabel.textContent = label;
      this.ammoBagVal.textContent = text;
    }
    this.ammoBag.classList.toggle('none', n === 0);
  }

  _updateAmmo(dt) {
    // Poll the weapon so the HUD self-heals if an event is missed.
    this._pollT -= dt;
    const w = this._weapon();
    if (this._pollT <= 0) {
      this._pollT = 0.2;
      if (w) {
        /* A melee weapon has no magazine and no bag item, so every number the
         * panel can show it is zero - and "0 / 0" on a sword reads as *out of
         * ammo*, which is the one thing it can never be. The bag row already
         * said "MELEE ∞" for exactly this reason; the count above it was simply
         * missed. Same test as `_updateBagRow` uses, so the two can never
         * disagree about what a melee weapon is. */
        const melee = (w.ammoItem ?? null) === null && !(w.magazine > 0);
        if (melee !== this._meleeReadout) {
          this._meleeReadout = melee;
          this.ammoPanel.classList.toggle('melee', melee);
          if (melee) {
            // Force the next ranged selection to repaint: `_setAmmo` short
            // circuits on unchanged values, and the numbers behind the melee
            // readout are stale by definition.
            this._ammo = null;
            this._reserve = null;
            this.ammoCur.textContent = '∞';
            this._buildPips(0);
            this.ammoPanel.classList.remove('warn', 'low');
          }
        }
        if (!melee) {
          this._setAmmo(w.ammo, w.reserve, w.magazine);
        }
        if (w.name && w.name !== this._ammoNameText) {
          this._ammoNameText = w.name;
          this.ammoName.textContent = String(w.name);
        }
      }
      this._updateBagRow(w);
      if (w && !w.isReloading && this._reloadDur > 0) {
        this._reloadDur = 0;
        this.ammoPanel.classList.remove('reloading');
      }
    }

    if (this._noAmmoT > 0) {
      this._noAmmoT -= dt;
      if (this._noAmmoT <= 0) this.ammoPanel.classList.remove('dry', 'dry-kick');
    }
    if (this._attackT > 0) {
      this._attackT -= dt;
      if (this._attackT <= 0) this.attackLine.classList.remove('show', 'kick');
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
    const w = this._weapon();
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

  /**
   * Close the transition overlay and hold it. `_endWipe` reopens it once the
   * destination reports in.
   * @param {string} toId destination world id
   * @param {number} [duration] the portal system's own transition length
   */
  _runWipe(toId, duration) {
    const dur = Math.max(0.4, duration || CONFIG.portal.transitionDuration);
    const w = this.worldManager?.getWorld?.(toId);
    const name = (w?.displayName ?? toId ?? 'Unknown Anchor').toUpperCase();
    this.wipeName.textContent = name;
    this.wipeStage.textContent = this.worldManager?.isBuilt?.(toId)
      ? 'Anchoring the gateway'
      : 'Generating the world';
    this.wipe.style.setProperty('--wipe-dur', `${dur}s`);

    clearTimeout(this._wipeTimer);
    this.wipe.classList.remove('run', 'out');
    void this.wipe.offsetWidth; // restart the keyframes cleanly
    this.wipe.classList.add('run');
    this._wipeHolding = true;

    // Safety net: if `world:changed` never arrives the player must not be left
    // behind a black slab for ever.
    this._wipeTimer = setTimeout(() => this._endWipe(), 45000);
  }

  /** Open the slabs again. Idempotent — `world:changed` can arrive twice. */
  _endWipe() {
    if (!this._wipeHolding) return;
    this._wipeHolding = false;
    clearTimeout(this._wipeTimer);
    this.wipe.classList.remove('run');
    this.wipe.classList.add('out');
    this._wipeTimer = setTimeout(() => this.wipe.classList.remove('out'), 900);
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
    clearTimeout(this._swapTimer);
    this._bootObs?.disconnect();
    this._bootHideObs?.disconnect();
    this.minimap.dispose();
    this.chatBox.dispose();
    this.wheel.dispose();
    this.help.dispose();
    for (const f of this._creditFloats) f.el.remove();
    this._creditFloats.length = 0;
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
