import { MOUNT_SKINS } from './Cosmetics.js';

/**
 * Item catalogue, pack prices and the procedural icon set.
 *
 * Everything the inventory, the loot tables and the marketplace know about an
 * item lives here so there is exactly one place to retune economy balance. The
 * icons are inline SVG built at call time rather than sprites, because §0
 * forbids external assets and an SVG stays crisp at any panel size.
 *
 * `stack` is the single most load-bearing number in the file: the active bag is
 * limited to 30 **slots**, and one slot holds one full stack. `bullet.stack`
 * is 60 precisely so a 60-round pack is one slot, not sixty.
 *
 * One extra item is generated per catalogued mount skin (`MOUNT_SKINS` in
 * `Cosmetics.js`) - see the loop after the `ITEMS` literal below - so a skin
 * bought at a merchant has a bag item to sit in until it is applied.
 */

/** @typedef {'ammo'|'consumable'|'trinket'|'currency'|'skin'} ItemKind */

/** Accent colours, shared by the UI panels and the world pickups. */
export const KIND_ACCENT = {
  ammo: '#52e9ff',
  consumable: '#b6ff5a',
  trinket: '#d46bff',
  currency: '#ffb44a',
  skin: '#ff9ad5',
};

/**
 * The catalogue. `value` is the *base* worth of one unit in credits; buy prices
 * come from `PACKS` and sell prices from `value * SELL_RATE`.
 *
 * @type {Record<string, {id:string, name:string, short:string, stack:number,
 *   icon:string, value:number, kind:ItemKind, virtual?:boolean, desc:string,
 *   skinId?:string, colors?:number[]}>}
 */
export const ITEMS = {
  credits: {
    id: 'credits',
    name: 'Credits',
    short: 'CR',
    // Virtual: credits never occupy a slot, they route straight to Economy.
    stack: Infinity,
    icon: 'credits',
    value: 1,
    kind: 'currency',
    virtual: true,
    desc: 'Universal Nexus scrip. Held by your account, not in your bag.',
  },
  bullet: {
    id: 'bullet',
    name: 'Rifle Rounds',
    short: 'RND',
    stack: 60,
    icon: 'bullet',
    value: 3,
    kind: 'ammo',
    desc: 'Caseless 6mm for the VK-7. One stack of 60 fills a single slot.',
  },
  arrow: {
    id: 'arrow',
    name: 'Broadhead Arrows',
    short: 'ARW',
    stack: 30,
    icon: 'arrow',
    value: 5,
    kind: 'ammo',
    desc: 'Fletched shafts with a hardened head. Recoverable, mostly.',
  },
  fireball_charge: {
    id: 'fireball_charge',
    name: 'Ember Cores',
    short: 'EMB',
    stack: 10,
    icon: 'ember',
    value: 15,
    kind: 'ammo',
    desc: 'Compressed pyro-cells that feed the gauntlet. Warm to the touch.',
  },
  medkit: {
    id: 'medkit',
    name: 'Field Medkit',
    short: 'MED',
    stack: 5,
    icon: 'medkit',
    value: 45,
    kind: 'consumable',
    desc: 'Sealed trauma pack. Restores health when used.',
  },
  speed_boost_25: {
    id: 'speed_boost_25',
    name: 'Fleetstep Spark',
    short: 'SPD',
    stack: 1,
    icon: 'speed',
    value: 32,
    kind: 'consumable',
    desc: 'Temporarily boosts movement speed by 25%.',
  },
  speed_boost_50: {
    id: 'speed_boost_50',
    name: 'Rushline Glyph',
    short: 'SPD',
    stack: 1,
    icon: 'speed',
    value: 48,
    kind: 'consumable',
    desc: 'Temporarily boosts movement speed by 50%.',
  },
  speed_boost_75: {
    id: 'speed_boost_75',
    name: 'Mach Surge Sigil',
    short: 'SPD',
    stack: 1,
    icon: 'speed',
    value: 68,
    kind: 'consumable',
    desc: 'Temporarily boosts movement speed by 75%.',
  },
  speed_boost_100: {
    id: 'speed_boost_100',
    name: 'Velocity Crown',
    short: 'SPD',
    stack: 1,
    icon: 'speed',
    value: 92,
    kind: 'consumable',
    desc: 'Temporarily doubles movement speed.',
  },
  loot_magnet_30s: {
    id: 'loot_magnet_30s',
    name: 'Vacuum Rune',
    short: 'LOOT',
    stack: 1,
    icon: 'magnet',
    value: 60,
    kind: 'consumable',
    desc: 'Pulls nearby loot toward you for 30 seconds.',
  },
  portal_ping_30s: {
    id: 'portal_ping_30s',
    name: 'Gatefinder Echo',
    short: 'PING',
    stack: 1,
    icon: 'portal',
    value: 56,
    kind: 'consumable',
    desc: 'Highlights the nearest portal for 30 seconds.',
  },
  npc_pause_5s: {
    id: 'npc_pause_5s',
    name: 'Stasis Rune',
    short: 'STAS',
    stack: 1,
    icon: 'time',
    value: 34,
    kind: 'consumable',
    desc: 'Pauses nearby NPC movement for 5 seconds.',
  },
  npc_pause_10s: {
    id: 'npc_pause_10s',
    name: 'Chrono Snare',
    short: 'STAS',
    stack: 1,
    icon: 'time',
    value: 48,
    kind: 'consumable',
    desc: 'Pauses nearby NPC movement for 10 seconds.',
  },
  npc_pause_30s: {
    id: 'npc_pause_30s',
    name: 'Time Lock Prism',
    short: 'STAS',
    stack: 1,
    icon: 'time',
    value: 78,
    kind: 'consumable',
    desc: 'Pauses nearby NPC movement for 30 seconds.',
  },
  npc_pause_60s: {
    id: 'npc_pause_60s',
    name: 'Temporal Vault Sigil',
    short: 'STAS',
    stack: 1,
    icon: 'time',
    value: 108,
    kind: 'consumable',
    desc: 'Pauses nearby NPC movement for 60 seconds.',
  },
  shield_5s: {
    id: 'shield_5s',
    name: 'Aegis Shard',
    short: 'SHLD',
    stack: 1,
    icon: 'shield',
    value: 72,
    kind: 'consumable',
    desc: 'Creates a short damage shield.',
  },
  firepower_boost_25: {
    id: 'firepower_boost_25',
    name: 'Firepower Sigil',
    short: 'POWR',
    stack: 1,
    icon: 'power',
    value: 44,
    kind: 'consumable',
    desc: 'Temporarily boosts weapon damage by 25%.',
  },
  firepower_boost_50: {
    id: 'firepower_boost_50',
    name: 'Firepower Talisman',
    short: 'POWR',
    stack: 1,
    icon: 'power',
    value: 60,
    kind: 'consumable',
    desc: 'Temporarily boosts weapon damage by 50%.',
  },
  firepower_boost_75: {
    id: 'firepower_boost_75',
    name: 'Firepower Seal',
    short: 'POWR',
    stack: 1,
    icon: 'power',
    value: 82,
    kind: 'consumable',
    desc: 'Temporarily boosts weapon damage by 75%.',
  },
  firepower_boost_100: {
    id: 'firepower_boost_100',
    name: 'Firepower Crown',
    short: 'POWR',
    stack: 1,
    icon: 'power',
    value: 112,
    kind: 'consumable',
    desc: 'Temporarily doubles weapon damage.',
  },
  alloy_scrap: {
    id: 'alloy_scrap',
    name: 'Alloy Scrap',
    short: 'SCR',
    stack: 20,
    icon: 'scrap',
    value: 12,
    kind: 'trinket',
    desc: 'Torn hull plate. Vendors buy it by weight and never ask where from.',
  },
  nexus_shard: {
    id: 'nexus_shard',
    name: 'Nexus Shard',
    short: 'SHD',
    stack: 10,
    icon: 'shard',
    value: 60,
    kind: 'trinket',
    desc: 'A splinter of portal glass. Hums faintly when a gate is near.',
  },
  relic_coin: {
    id: 'relic_coin',
    name: 'Old Crown Coin',
    short: 'CON',
    stack: 25,
    icon: 'coin',
    value: 24,
    kind: 'trinket',
    desc: 'Struck for a king three worlds ago. Still worth something here.',
  },
};

/** Bag item id for a mount skin id. */
export function skinItemId(skinId) {
  return `skin_${skinId}`;
}

/** Skin id for a bag item id, or null if the item is not a skin. */
export function skinIdFromItem(itemId) {
  if (typeof itemId !== 'string' || !itemId.startsWith('skin_')) return null;
  const def = ITEMS[itemId];
  return def && def.kind === 'skin' ? def.skinId : null;
}

/*
 * One bag item per mount skin. Bought at a merchant (`grant_item`), it sits in
 * the bag until applied from the Mount menu (F10) or the inventory Use button,
 * which consumes it and burns the skin into the Cosmetics ledger.
 */
for (const skin of MOUNT_SKINS) {
  const colors = Object.values(skin.livery).map((v) => v.color).filter((c) => typeof c === 'number');
  ITEMS[skinItemId(skin.id)] = {
    id: skinItemId(skin.id),
    name: `${skin.name} Skin`,
    short: 'SKN',
    stack: 1,
    icon: 'skin',
    value: 200,
    kind: 'skin',
    skinId: skin.id,
    colors,
    desc: `${skin.blurb} Apply to your ${skin.mount} from the Mount menu (F10) while riding; one use.`,
  };
}

/** Fraction of `value` a vendor pays when buying an item back off the player. */
export const SELL_RATE = 0.4;

/* ====================================================================== */
/* Regional markets                                                       */
/* ====================================================================== */

/**
 * What each world is short of, and what it is sick of the sight of.
 *
 * Three worlds connected by portals and a single flat price list gave the
 * gateways nothing to do: every vendor paid the same, so there was never a
 * reason to carry anything through one. These multipliers give each world an
 * economy with a direction - scrap is worthless in the station that sheds it
 * and valuable in a village with no foundry; a medieval crown coin is junk at
 * home and a curiosity two worlds away.
 *
 * `buy` scales what a vendor *pays* the player, `sell` scales what they
 * *charge*. Both are per item `kind`, so a new item inherits its region's
 * economy the moment it declares one.
 *
 * Kept deliberately tame - roughly +/-60% - because the point is to make one
 * destination better than another, not to make trading mandatory.
 */
export const WORLD_MARKETS = {
  station: {
    label: 'Aether Nexus Station',
    // A working port: ammunition is manufactured here, salvage is underfoot.
    buy: { trinket: 0.65, ammo: 0.8, consumable: 1.0 },
    sell: { ammo: 0.8, consumable: 1.1 },
    // Relics from the other worlds are curios here, and priced like it.
    itemBuy: { relic_coin: 1.7, nexus_shard: 1.45 },
    note: 'Foundry port — ammunition is cheap, salvage is worthless.',
  },
  medieval: {
    label: 'Aldermoor Vale',
    // No foundry and no cartridges: metal and manufactured goods are precious.
    buy: { trinket: 1.55, ammo: 1.15, consumable: 1.35 },
    sell: { ammo: 1.45, consumable: 1.3 },
    itemBuy: { alloy_scrap: 1.8, relic_coin: 0.55 },
    // Arrows are the local product, so they are the one cheap thing.
    itemSell: { pack_arrows: 0.6 },
    note: 'No foundry — scrap and medicine fetch a premium, arrows are local.',
  },
  citadel: {
    label: 'Sunspire Citadel',
    // A fortress cut off on a mesa: everything manufactured arrives by mule, and
    // the one thing it has in surplus is antiquity.
    buy: { trinket: 1.35, ammo: 1.3, consumable: 1.45 },
    sell: { ammo: 1.55, consumable: 1.4 },
    itemBuy: { alloy_scrap: 1.65, nexus_shard: 1.5, relic_coin: 0.5 },
    note: 'Cut off on the mesa — everything manufactured is dear, relics are not.',
  },
  sports: {
    label: 'Meridian Athletic Grounds',
    // Civilian, well supplied, and nobody here wants your hull plating.
    buy: { trinket: 0.9, ammo: 0.9, consumable: 0.7 },
    sell: { ammo: 1.05, consumable: 0.65 },
    itemBuy: { nexus_shard: 1.25 },
    note: 'Civilian grounds — medical supplies are cheap and plentiful.',
  },
  race: {
    label: 'Vellum Ridge Circuits',
    // A working paddock: everything is trucked in for the meeting and priced at
    // face value. Deliberately flat, so the circuit is neither the place to dump
    // cargo nor the place to stock up - it is where you go to race.
    buy: { trinket: 1.0, ammo: 1.0, consumable: 1.0 },
    sell: { ammo: 1.0, consumable: 1.0 },
    // Alloy has an obvious use in a garage, and there is nothing here that wants
    // a relic.
    itemBuy: { alloy_scrap: 1.3, relic_coin: 0.8 },
    note: 'Circuit paddock — everything trades at face value.',
  },
};

/** Market in force right now. Set by Marketplace on every world change. */
let activeMarket = null;
let activeMarketId = null;

/**
 * Point the price tables at a world. Passing an unknown id falls back to flat
 * pricing, so a new world trades at face value rather than throwing.
 * @param {string|null} worldId
 */
export function setMarketWorld(worldId) {
  activeMarketId = worldId ?? null;
  activeMarket = (worldId && WORLD_MARKETS[worldId]) || null;
}

/** @returns {string|null} */
export function marketWorldId() {
  return activeMarketId;
}

/** @returns {typeof WORLD_MARKETS[keyof typeof WORLD_MARKETS]|null} */
export function marketInfo() {
  return activeMarket;
}

/**
 * Multiplier on what a vendor pays for `id` in the active world.
 * @param {string} id
 * @returns {number}
 */
export function buyMultiplier(id) {
  if (!activeMarket) return 1;
  const def = ITEMS[id];
  if (!def) return 1;
  const perItem = activeMarket.itemBuy?.[id];
  if (perItem !== undefined) return perItem;
  return activeMarket.buy?.[def.kind] ?? 1;
}

/**
 * Multiplier on a pack's asking price in the active world.
 * @param {{id:string, itemId:string}} pack
 * @returns {number}
 */
export function sellMultiplier(pack) {
  if (!activeMarket || !pack) return 1;
  const perPack = activeMarket.itemSell?.[pack.id];
  if (perPack !== undefined) return perPack;
  const def = ITEMS[pack.itemId];
  return activeMarket.sell?.[def?.kind] ?? 1;
}

/**
 * Asking price for a pack here and now.
 * @param {{id:string, itemId:string, price:number}} pack
 * @returns {number}
 */
export function packPrice(pack) {
  if (!pack) return 0;
  return Math.max(1, Math.round(pack.price * sellMultiplier(pack)));
}

/**
 * How this world's price for `id` compares with the baseline, for the UI.
 * @param {string} id
 * @returns {{ mul:number, tone:'high'|'low'|'flat', label:string }}
 */
export function priceSignal(id) {
  const mul = buyMultiplier(id);
  if (mul >= 1.2) return { mul, tone: 'high', label: `in demand +${Math.round((mul - 1) * 100)}%` };
  if (mul <= 0.85) return { mul, tone: 'low', label: `glut ${Math.round((mul - 1) * 100)}%` };
  return { mul, tone: 'flat', label: '' };
}

/**
 * What a vendor sells. Quantities are deliberately whole stacks so the slot
 * arithmetic in the UI is obvious: one pack of 60 rounds is one bag slot.
 *
 * @type {Array<{id:string, itemId:string, qty:number, price:number, name:string, blurb:string}>}
 */
export const PACKS = [
  {
    id: 'pack_bullets',
    itemId: 'bullet',
    qty: 60,
    price: 150,
    name: 'Rifle Round Pack',
    blurb: '60 rounds — one bag slot',
  },
  {
    id: 'pack_arrows',
    itemId: 'arrow',
    qty: 30,
    price: 130,
    name: 'Arrow Bundle',
    blurb: '30 arrows — one bag slot',
  },
  {
    id: 'pack_embers',
    itemId: 'fireball_charge',
    qty: 10,
    price: 170,
    name: 'Ember Core Cell',
    blurb: '10 charges — one bag slot',
  },
  {
    id: 'pack_medkit',
    itemId: 'medkit',
    qty: 2,
    price: 95,
    name: 'Trauma Twin-Pack',
    blurb: '2 medkits',
  },
];

/** @param {string} id @returns {(typeof ITEMS)[keyof typeof ITEMS]|null} */
export function itemDef(id) {
  return ITEMS[id] ?? null;
}

/** Stack size for an id; unknown ids stack at 1 so they can never overflow a slot silently. */
export function stackSize(id) {
  const def = ITEMS[id];
  return def ? def.stack : 1;
}

/**
 * Slots consumed by `qty` of `id`. Virtual items (credits) are free.
 * @param {string} id
 * @param {number} qty
 * @returns {number}
 */
export function slotsFor(id, qty) {
  if (qty <= 0) return 0;
  const def = ITEMS[id];
  if (def?.virtual) return 0;
  const s = stackSize(id);
  return s === Infinity ? 1 : Math.ceil(qty / s);
}

/**
 * Credits a vendor pays for `qty` of `id`, in the active world's market.
 * Always at least 1 per unit, so nothing is ever literally worthless.
 */
export function sellValue(id, qty = 1) {
  const def = ITEMS[id];
  if (!def || def.virtual) return 0;
  return Math.max(1, Math.round(def.value * SELL_RATE * buyMultiplier(id))) * qty;
}

/** Baseline unit price, ignoring where the player is standing. For comparisons. */
export function baseSellValue(id, qty = 1) {
  const def = ITEMS[id];
  if (!def || def.virtual) return 0;
  return Math.max(1, Math.round(def.value * SELL_RATE)) * qty;
}

/** @param {string} packId */
export function packDef(packId) {
  return PACKS.find((p) => p.id === packId) ?? null;
}

/* ====================================================================== */
/* Procedural icons                                                       */
/* ====================================================================== */

/** Gradient ids have to be unique per document, hence the counter. */
let _iconSeq = 0;

/**
 * Inline SVG markup for an item icon.
 *
 * Drawn from primitives on a 32x32 grid so every icon shares a silhouette
 * weight; the panels scale them with CSS rather than re-rendering.
 *
 * @param {string} id item id (or an icon key)
 * @param {number} [size=32]
 * @returns {string} SVG markup
 */
export function itemIconSVG(id, size = 32) {
  const key = ITEMS[id]?.icon ?? id;
  const accent = KIND_ACCENT[ITEMS[id]?.kind ?? 'ammo'] ?? '#52e9ff';
  const g = `ig${_iconSeq++}`;
  const body = ICONS[key]?.(g, accent, ITEMS[id]) ?? ICONS.unknown(g, accent);
  return `<svg class="inv-ico" viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true">${body}</svg>`;
}

/**
 * Each entry returns the SVG body for one icon. They take the unique gradient
 * prefix and the accent so a single definition serves every panel; the third
 * argument is the item's own catalogue entry, for an icon (like `skin`) whose
 * artwork depends on data the item carries rather than just its kind.
 * @type {Record<string, (g:string, a:string, def?:object) => string>}
 */
const ICONS = {
  bullet: (g, a) => `
    <defs><linearGradient id="${g}a" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0" stop-color="#7a5a22"/><stop offset="1" stop-color="#ffd489"/>
    </linearGradient></defs>
    <g stroke="${a}" stroke-width="0.9" fill="url(#${g}a)">
      <path d="M11 22 h10 v-7 q0 -5 -5 -9 q-5 4 -5 9 z"/>
      <rect x="11" y="22" width="10" height="5" rx="1"/>
    </g>
    <path d="M11 24.5 h10" stroke="${a}" stroke-width="0.8" opacity="0.8"/>
    <path d="M14 13 q2 -4 4 0" stroke="#fff6e0" stroke-width="0.9" fill="none" opacity="0.75"/>`,
  arrow: (g, a) => `
    <defs><linearGradient id="${g}a" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#3a4a55"/><stop offset="1" stop-color="#cfe6f2"/>
    </linearGradient></defs>
    <path d="M8 24 L24 8" stroke="url(#${g}a)" stroke-width="2" stroke-linecap="round"/>
    <path d="M24 8 l-6 0.6 l1.4 1.4 l-1.6 3 l5.6 -3.2 z" fill="${a}" opacity="0.95"/>
    <path d="M22 6 l4 0 l0 4 l-3.2 -0.8 z" fill="#e8f7ff" stroke="${a}" stroke-width="0.7"/>
    <g stroke="${a}" stroke-width="1.3" opacity="0.85">
      <path d="M8.5 23.5 l3 -1.2"/><path d="M10 25 l1.2 -3"/>
    </g>`,
  ember: (g, a) => `
    <defs><radialGradient id="${g}a" cx="50%" cy="58%" r="55%">
      <stop offset="0" stop-color="#fff2d0"/><stop offset="0.45" stop-color="#ff9b3c"/>
      <stop offset="1" stop-color="#7a1f06"/>
    </radialGradient></defs>
    <circle cx="16" cy="17" r="8.5" fill="url(#${g}a)"/>
    <circle cx="16" cy="17" r="8.5" fill="none" stroke="#ff7d3c" stroke-width="0.9" opacity="0.9"/>
    <path d="M16 4 q4 5 1.6 8 q-1.4 1.8 -1.6 3 q-0.4 -1.6 -1.8 -3 Q11.6 9 16 4 z" fill="#ffb44a" opacity="0.92"/>
    <path d="M13 18 q3 -4 6 0 q-3 3 -6 0 z" fill="#fff6e0" opacity="0.5"/>`,
  medkit: (g, a) => `
    <defs><linearGradient id="${g}a" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1a2a20"/><stop offset="1" stop-color="#0b1610"/>
    </linearGradient></defs>
    <rect x="4.5" y="9.5" width="23" height="16" rx="2.4" fill="url(#${g}a)" stroke="${a}" stroke-width="1.1"/>
    <path d="M12 9.5 v-2 a2 2 0 0 1 2 -2 h4 a2 2 0 0 1 2 2 v2" fill="none" stroke="${a}" stroke-width="1.1"/>
    <path d="M14.4 13.6 h3.2 v3.2 h3.2 v3.2 h-3.2 v3.2 h-3.2 v-3.2 h-3.2 v-3.2 h3.2 z" fill="${a}"/>
    <path d="M4.5 21 h23" stroke="${a}" stroke-width="0.6" opacity="0.35"/>`,
  speed: (g, a) => `
    <defs><linearGradient id="${g}a" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#d9fbff"/><stop offset="1" stop-color="#2ea8ff"/>
    </linearGradient></defs>
    <path d="M6 19 C9 13, 14 10, 25 8 C21 12, 20 15, 20 17 C20 20, 21 23, 25 24 C16 26, 9 25, 6 19 Z" fill="url(#${g}a)" stroke="${a}" stroke-width="1"/>
    <path d="M10 16 h7" stroke="#f4fdff" stroke-width="1.3" stroke-linecap="round"/>
    <path d="M13 13 l4 3 l-4 3" fill="none" stroke="#f4fdff" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>`,
  magnet: (g, a) => `
    <defs><linearGradient id="${g}a" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f4fff3"/><stop offset="1" stop-color="#39c77c"/>
    </linearGradient></defs>
    <path d="M9 6 v11 a7 7 0 0 0 14 0 V6 h-4 v11 a3 3 0 0 1 -6 0 V6 z" fill="url(#${g}a)" stroke="${a}" stroke-width="1"/>
    <path d="M9 6 h4 M19 6 h4" stroke="#f4fff3" stroke-width="1.2" stroke-linecap="round"/>
    <circle cx="16" cy="24" r="1.5" fill="#f4fff3"/>`,
  portal: (g, a) => `
    <defs><radialGradient id="${g}a" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="#ffe8ff"/><stop offset="0.5" stop-color="#ba7bff"/><stop offset="1" stop-color="#391b67"/>
    </radialGradient></defs>
    <circle cx="16" cy="16" r="9.5" fill="url(#${g}a)" stroke="${a}" stroke-width="1"/>
    <circle cx="16" cy="16" r="5.6" fill="none" stroke="#f3e7ff" stroke-width="1.2" opacity="0.75"/>
    <path d="M16 6 v20 M6 16 h20" stroke="#f3e7ff" stroke-width="0.8" opacity="0.45"/>`,
  time: (g, a) => `
    <defs><linearGradient id="${g}a" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f0fbff"/><stop offset="1" stop-color="#89d6ff"/>
    </linearGradient></defs>
    <circle cx="16" cy="16" r="10" fill="url(#${g}a)" stroke="${a}" stroke-width="1"/>
    <path d="M16 9 v7 l4 2" fill="none" stroke="#0b1720" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M11 4 h10" stroke="#0b1720" stroke-width="1.2" stroke-linecap="round" opacity="0.9"/>
    <path d="M11 28 h10" stroke="#0b1720" stroke-width="1.2" stroke-linecap="round" opacity="0.9"/>`,
  shield: (g, a) => `
    <defs><linearGradient id="${g}a" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ebfdff"/><stop offset="1" stop-color="#7dd8ff"/>
    </linearGradient></defs>
    <path d="M16 4 L25 7 v8 c0 6 -4.4 9.8 -9 13 -4.6 -3.2 -9 -7 -9 -13 V7 z" fill="url(#${g}a)" stroke="${a}" stroke-width="1"/>
    <path d="M16 8 v16" stroke="#0b1720" stroke-width="1.1" opacity="0.55"/>
    <path d="M11 13 h10" stroke="#0b1720" stroke-width="1.1" opacity="0.55"/>`,
  power: (g, a) => `
    <defs><linearGradient id="${g}a" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fff3d8"/><stop offset="1" stop-color="#ff8f2e"/>
    </linearGradient></defs>
    <path d="M16 4 l3.5 6.5 L26 12 l-5 5 1.2 7 -6.2 -3.4 -6.2 3.4 1.2 -7 -5 -5 6.5 -1.5 z" fill="url(#${g}a)" stroke="${a}" stroke-width="0.9" stroke-linejoin="round"/>
    <circle cx="16" cy="16" r="2.1" fill="#fff7ea"/>`,
  credits: (g, a) => `
    <defs><linearGradient id="${g}a" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffe3b6"/><stop offset="1" stop-color="#b6741a"/>
    </linearGradient></defs>
    <path d="M16 3.5 L27 9.5 v13 L16 28.5 L5 22.5 v-13 z" fill="url(#${g}a)" stroke="${a}" stroke-width="1"/>
    <path d="M16 7.5 L23.5 11.6 v8.8 L16 24.5 L8.5 20.4 v-8.8 z" fill="none" stroke="#5a3a0d" stroke-width="0.8" opacity="0.7"/>
    <path d="M13.4 12.6 h5.2 M13.4 16 h5.2 M13.4 19.4 h5.2" stroke="#3d2708" stroke-width="1.4" stroke-linecap="round"/>`,
  scrap: (g, a) => `
    <defs><linearGradient id="${g}a" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#8fa6b4"/><stop offset="1" stop-color="#39505e"/>
    </linearGradient></defs>
    <path d="M6 20 L11 7 L24 9 L27 19 L18 26 z" fill="url(#${g}a)" stroke="${a}" stroke-width="0.9" stroke-linejoin="round"/>
    <path d="M11 7 L15 18 L27 19" fill="none" stroke="#0b1620" stroke-width="0.9" opacity="0.65"/>
    <circle cx="21.5" cy="13" r="1.5" fill="#0b1620" opacity="0.7"/>`,
  shard: (g, a) => `
    <defs><linearGradient id="${g}a" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f2d8ff"/><stop offset="0.5" stop-color="#c46bff"/>
      <stop offset="1" stop-color="#4a1a75"/>
    </linearGradient></defs>
    <path d="M16 2.5 L23 13 L18.5 29 L13 29 L9 13 z" fill="url(#${g}a)" stroke="${a}" stroke-width="0.9" stroke-linejoin="round"/>
    <path d="M16 2.5 L16 29 M9 13 L23 13" stroke="#f7e9ff" stroke-width="0.7" opacity="0.5"/>`,
  coin: (g, a) => `
    <defs><radialGradient id="${g}a" cx="38%" cy="34%" r="72%">
      <stop offset="0" stop-color="#ffeec4"/><stop offset="1" stop-color="#8a5c1c"/>
    </radialGradient></defs>
    <circle cx="16" cy="16" r="11" fill="url(#${g}a)" stroke="${a}" stroke-width="1"/>
    <circle cx="16" cy="16" r="8" fill="none" stroke="#5a3a0d" stroke-width="0.7" opacity="0.65"/>
    <path d="M11.5 18.5 l2 -6 l2.5 4 l2.5 -4 l2 6 z" fill="#4a2f08" opacity="0.85"/>`,
  skin: (g, a, def) => {
    const [c1 = 0x888888, c2 = c1] = def?.colors ?? [];
    const hex = (c) => `#${(c & 0xffffff).toString(16).padStart(6, '0')}`;
    return `
    <rect x="5" y="5" width="22" height="22" rx="4" fill="${hex(c1)}" stroke="${a}" stroke-width="1"/>
    <path d="M27 5 L27 27 L5 27 z" fill="${hex(c2)}" opacity="0.95"/>
    <path d="M9 22 q7 -9 14 -12" stroke="#ffffff" stroke-width="1.2" fill="none" opacity="0.55"/>`;
  },
  unknown: (g, a) => `
    <rect x="6" y="6" width="20" height="20" rx="3" fill="rgba(120,180,210,0.12)" stroke="${a}" stroke-width="1"/>
    <path d="M16 20 v-2 q3 -1 3 -3.5 a3 3 0 1 0 -6 0" fill="none" stroke="${a}" stroke-width="1.5"/>
    <circle cx="16" cy="23.5" r="1.2" fill="${a}"/>`,
};
