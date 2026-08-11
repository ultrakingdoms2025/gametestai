/**
 * Cosmetics wardrobe.
 *
 * A tiny ownership ledger for purchasable, *permanent* cosmetics — the kind a
 * player buys once from a merchant and then wears from the customizer. It holds
 * nothing visual itself: the customizer (F2) reads {@link CHARACTER_SKINS} and
 * {@link VEHICLE_SKINS} to draw the cards, and asks this store which ids the
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
 * vehicle skin is a car livery (paint/wheel). That keeps a "limited edition
 * skin" a data row here and in the catalog, with nothing to author in the
 * humanoid or car factories.
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
 * Limited-edition car liveries. `livery` maps onto MountManager.setLivery.
 * @type {Array<{id:string,name:string,blurb:string,livery:{paint:number,wheel:number}}>}
 */
export const VEHICLE_SKINS = [
  {
    id: 'car_neon',
    name: 'Neon Circuit',
    blurb: 'Magenta body, cyan rims.',
    livery: { paint: 0xff3bd2, wheel: 0x2fe0ff },
  },
  {
    id: 'car_inferno',
    name: 'Inferno',
    blurb: 'Race red with gold alloys.',
    livery: { paint: 0xc21f2f, wheel: 0xe0b23a },
  },
  {
    id: 'car_phantom',
    name: 'Phantom',
    blurb: 'Stealth black, chalk-white wheels.',
    livery: { paint: 0x0d0f12, wheel: 0xf2f4f6 },
  },
  {
    id: 'car_toxic',
    name: 'Toxic Surge',
    blurb: 'Venom green over black rims.',
    livery: { paint: 0x18a86b, wheel: 0x0d0f12 },
  },
  {
    id: 'car_azure',
    name: 'Azure Bolt',
    blurb: 'Electric blue, silver alloys.',
    livery: { paint: 0x1f6fd0, wheel: 0xd9dde2 },
  },
];

/** Fast lookups by id, so the customizer and market can resolve a skin cheaply. */
export const CHARACTER_SKINS_BY_ID = new Map(CHARACTER_SKINS.map((s) => [s.id, s]));
export const VEHICLE_SKINS_BY_ID = new Map(VEHICLE_SKINS.map((s) => [s.id, s]));

/** Every id the catalog is allowed to grant. Guards against typos in seed data. */
const KNOWN_SKIN_IDS = new Set([...CHARACTER_SKINS_BY_ID.keys(), ...VEHICLE_SKINS_BY_ID.keys()]);

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
