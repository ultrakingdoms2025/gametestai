/**
 * Cosmetics wardrobe.
 *
 * A tiny ownership ledger for purchasable, *permanent* cosmetics — the kind a
 * player buys once from a merchant and then wears from the customizer. It holds
 * nothing visual itself: the customizer (F2) reads {@link CHARACTER_SKINS} and
 * {@link MOUNT_SKINS} to draw the cards, and asks this store which ids the
 * player owns so a locked card cannot be applied.
 *
 * Unlocks are ids, not items, so they are cheap to persist and never touch the
 * bag. `Marketplace` grants one on purchase (`cosmetic:buy` -> {@link unlock}),
 * and both save paths — the local `SaveGame` snapshot and the account state —
 * carry `serialize()`/`deserialize()` so a bought skin survives a reload on any
 * device, exactly like a mount livery.
 *
 * Skins are deliberately *presets over the existing customizer*, not new
 * geometry: a character skin is a garment colourway (top/leg/accent) and a
 * mount skin is a livery over that mount's colour slots (F10). That keeps a
 * "limited edition skin" a data row here and in the catalog, with nothing to
 * author in the humanoid or car factories.
 */

/**
 * Limited-edition character colourways. `preset` maps straight onto the avatar
 * character config fields the F2 menu already writes.
 * @type {Array<{id:string,name:string,blurb:string,preset:{topColor:number,legColor:number,accentColor:number}}>}
 */
export const CHARACTER_SKINS = [
  {
    id: 'char_aurora',
    name: 'Aurora Racer',
    blurb: 'Glacier teal with a cyan pulse.',
    preset: { topColor: 0x0e3b4a, legColor: 0xd2cec4, accentColor: 0x2fe0ff },
  },
  {
    id: 'char_midnight',
    name: 'Midnight Ops',
    blurb: 'Blacked-out kit, cold blue trim.',
    preset: { topColor: 0x14181c, legColor: 0x2c2f36, accentColor: 0x1f6fd0 },
  },
  {
    id: 'char_ember',
    name: 'Ember Vanguard',
    blurb: 'Scorched charcoal and molten orange.',
    preset: { topColor: 0x2a1613, legColor: 0x33302b, accentColor: 0xff6a3a },
  },
  {
    id: 'char_jade',
    name: 'Jade Sovereign',
    blurb: 'Deep jade with a gold edge.',
    preset: { topColor: 0x123a2a, legColor: 0x0f2a1f, accentColor: 0xffe14a },
  },
  {
    id: 'char_violet',
    name: 'Violet Mirage',
    blurb: 'Twilight violet, magenta spark.',
    preset: { topColor: 0x241033, legColor: 0x3a2e4a, accentColor: 0xff3bd2 },
  },
];

/**
 * Mount skins: presets over each mount's `CUSTOM_SLOTS` (see the mount class).
 * `livery` maps onto `MountManager.setLivery(mount, livery)`. The five car ids
 * predate F10 and are kept verbatim so old ledgers stay valid.
 * @type {Array<{id:string,mount:string,name:string,blurb:string,livery:Object<string,{color:number,finish?:'matt'|'gloss'}>}>}
 */
export const MOUNT_SKINS = [
  // Car (legacy ids)
  { id: 'car_neon', mount: 'car', name: 'Neon Circuit', blurb: 'Magenta body, cyan rims.', livery: { paint: { color: 0xff3bd2, finish: 'gloss' }, wheel: { color: 0x2fe0ff, finish: 'gloss' } } },
  { id: 'car_inferno', mount: 'car', name: 'Inferno', blurb: 'Race red with gold alloys.', livery: { paint: { color: 0xc21f2f, finish: 'gloss' }, wheel: { color: 0xe0b23a, finish: 'gloss' } } },
  { id: 'car_phantom', mount: 'car', name: 'Phantom', blurb: 'Stealth black, chalk-white wheels.', livery: { paint: { color: 0x0d0f12, finish: 'matt' }, wheel: { color: 0xf2f4f6, finish: 'gloss' } } },
  { id: 'car_toxic', mount: 'car', name: 'Toxic Surge', blurb: 'Venom green over black rims.', livery: { paint: { color: 0x18a86b, finish: 'gloss' }, wheel: { color: 0x0d0f12, finish: 'matt' } } },
  { id: 'car_azure', mount: 'car', name: 'Azure Bolt', blurb: 'Electric blue, silver alloys.', livery: { paint: { color: 0x1f6fd0, finish: 'gloss' }, wheel: { color: 0xd9dde2, finish: 'gloss' } } },
  // Dragon
  { id: 'dragon_obsidian', mount: 'dragon', name: 'Obsidian Ember', blurb: 'Black glass hide, blood-red tack.', livery: { hide: { color: 0x14161c, finish: 'gloss' }, saddle: { color: 0xc21f2f, finish: 'gloss' } } },
  { id: 'dragon_verdant', mount: 'dragon', name: 'Verdant Wyrm', blurb: 'Forest scale, worn tan leather.', livery: { hide: { color: 0x1f6b3a, finish: 'matt' }, saddle: { color: 0x8a6a42, finish: 'matt' } } },
  { id: 'dragon_frost', mount: 'dragon', name: 'Frostscale', blurb: 'Glacier hide, deep-blue harness.', livery: { hide: { color: 0xbfe6f2, finish: 'gloss' }, saddle: { color: 0x1f6fd0, finish: 'gloss' } } },
  // Eagle
  { id: 'eagle_golden', mount: 'eagle', name: 'Golden Talon', blurb: 'Burnished gold plumage, black harness.', livery: { plumage: { color: 0xc98a2b }, harness: { color: 0x2c2f36, finish: 'gloss' } } },
  { id: 'eagle_storm', mount: 'eagle', name: 'Storm Crest', blurb: 'Slate-blue feathers, silver straps.', livery: { plumage: { color: 0x3a4a5c }, harness: { color: 0xd9dde2, finish: 'gloss' } } },
  { id: 'eagle_ember', mount: 'eagle', name: 'Ember Wing', blurb: 'Scorched russet, gold harness.', livery: { plumage: { color: 0x7a2a1a }, harness: { color: 0xffd23b, finish: 'gloss' } } },
  // Horse
  { id: 'horse_midnight', mount: 'horse', name: 'Midnight Charger', blurb: 'Coal-black coat, white leather.', livery: { coat: { color: 0x141216 }, saddle: { color: 0xd9dde2, finish: 'gloss' } } },
  { id: 'horse_palomino', mount: 'horse', name: 'Palomino', blurb: 'Golden coat, oiled brown tack.', livery: { coat: { color: 0xd6b26a }, saddle: { color: 0x6b4e35, finish: 'matt' } } },
  { id: 'horse_royal', mount: 'horse', name: 'Royal Grey', blurb: 'Dapple white, violet saddle.', livery: { coat: { color: 0xe6e6ea }, saddle: { color: 0x6a2fd0, finish: 'gloss' } } },
  // Hoverboard
  { id: 'hover_neon', mount: 'hoverboard', name: 'Neon Drift', blurb: 'Gloss black deck, magenta underglow.', livery: { deck: { color: 0x14181f, finish: 'gloss' }, glow: { color: 0xff3bd2 } } },
  { id: 'hover_toxic', mount: 'hoverboard', name: 'Toxic Rail', blurb: 'Matt green deck, acid glow.', livery: { deck: { color: 0x18a86b, finish: 'matt' }, glow: { color: 0xa8ff3b } } },
  { id: 'hover_solar', mount: 'hoverboard', name: 'Solar Flare', blurb: 'Orange gloss deck, gold glow.', livery: { deck: { color: 0xf27b1f, finish: 'gloss' }, glow: { color: 0xffe14a } } },
  // Bicycle
  { id: 'bike_chrome', mount: 'bicycle', name: 'Chrome Courier', blurb: 'Polished frame, bright rims.', livery: { frame: { color: 0xd9dde2, finish: 'gloss' }, rims: { color: 0xb9c2cc, finish: 'gloss' } } },
  { id: 'bike_racing', mount: 'bicycle', name: 'Racing Red', blurb: 'Race red frame, black rims.', livery: { frame: { color: 0xc21f2f, finish: 'gloss' }, rims: { color: 0x0d0f12, finish: 'matt' } } },
  { id: 'bike_forest', mount: 'bicycle', name: 'Forest Ranger', blurb: 'Matt green frame, brass rims.', livery: { frame: { color: 0x2f4a2a, finish: 'matt' }, rims: { color: 0xc9a24a, finish: 'gloss' } } },
];

/** Fast lookups by id, so the customizer and market can resolve a skin cheaply. */
export const CHARACTER_SKINS_BY_ID = new Map(CHARACTER_SKINS.map((s) => [s.id, s]));
export const MOUNT_SKINS_BY_ID = new Map(MOUNT_SKINS.map((s) => [s.id, s]));

/** Skins for one mount id, in catalog order. */
export function skinsForMount(mountId) {
  return MOUNT_SKINS.filter((s) => s.mount === mountId);
}

/** Every id the catalog is allowed to grant. Guards against typos in seed data. */
const KNOWN_SKIN_IDS = new Set([...CHARACTER_SKINS_BY_ID.keys(), ...MOUNT_SKINS_BY_ID.keys()]);

export class Cosmetics {
  constructor({ bus } = {}) {
    this.bus = bus ?? null;
    /** @type {Set<string>} */
    this._unlocked = new Set();
  }

  /** True if the player owns this cosmetic id. */
  has(id) {
    return typeof id === 'string' && this._unlocked.has(id);
  }

  /** Owned ids as a plain array (persistence + UI). */
  list() {
    return [...this._unlocked];
  }

  /**
   * Grant a cosmetic. Ignores unknown ids so a bad catalog row cannot poison the
   * wardrobe, and is idempotent so a double-buy is harmless.
   * @param {string} id
   * @returns {boolean} true if this call added a new unlock
   */
  unlock(id) {
    if (typeof id !== 'string' || !id) return false;
    if (!KNOWN_SKIN_IDS.has(id)) return false;
    if (this._unlocked.has(id)) return false;
    this._unlocked.add(id);
    this.bus?.emit('cosmetic:unlocked', { id, unlocked: this.list() });
    return true;
  }

  /** @returns {{unlocked:string[]}} */
  serialize() {
    return { unlocked: this.list() };
  }

  /**
   * Restore owned ids from a save. Accepts either the wrapped `{unlocked:[...]}`
   * shape or a bare array, and emits a single refresh so the customizer relights
   * whatever the player already owns.
   * @param {{unlocked?:string[]}|string[]|null} data
   */
  deserialize(data) {
    if (!data) return false;
    const arr = Array.isArray(data) ? data : Array.isArray(data.unlocked) ? data.unlocked : null;
    if (!arr) return false;
    let changed = false;
    for (const id of arr) {
      if (typeof id === 'string' && KNOWN_SKIN_IDS.has(id) && !this._unlocked.has(id)) {
        this._unlocked.add(id);
        changed = true;
      }
    }
    if (changed) this.bus?.emit('cosmetic:unlocked', { id: null, unlocked: this.list() });
    return true;
  }
}
