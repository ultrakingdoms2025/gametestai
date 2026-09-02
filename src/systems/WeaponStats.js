/**
 * The single source of damage truth for every player weapon.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 * Damage used to live in four places: `CONFIG.weapon.machinegun` for the rifle,
 * a private `SPEC` literal inside `Bow.js` and another inside `Fireball.js`,
 * and a set of bare multipliers scattered through `Projectiles.js`. Retuning a
 * weapon therefore meant editing three files and hoping nothing else keyed off
 * the old number. Everything now resolves through `WEAPON_STATS`.
 *
 * ── The `reference` field, and why it is not a hack ─────────────────────────
 * `Bow.js`, `Fireball.js` and `Projectiles.js` are owned by other agents, so
 * they still compute a damage figure from their own internal charge curves and
 * hand it to `CombatSystem.applyNPCDamage`. Rather than let those numbers stand,
 * Combat rescales them onto this table: `reference` records what that module
 * produces at *full* charge with no headshot, so `amount / reference` recovers
 * the module's charge fraction exactly, and multiplying by `damage` republishes
 * it in this table's units. `legacyHeadshotMul` does the same job for the
 * precision bonus those modules bake in before we ever see the number.
 *
 * The result is that the charge curves those weapons spent review rounds
 * tuning are preserved to the last decimal, while the headline damage - the
 * number a designer actually wants to move - lives here and here only. When
 * those modules are eventually pointed at this table directly, delete
 * `reference`/`legacyHeadshotMul` and `normaliseDamage` becomes the identity.
 *
 * Units: damage is in NPC hit points (`CONFIG.npc.maxHealth` is 100), ranges in
 * metres, arcs in degrees, times in seconds.
 */

/**
 * @typedef {object} WeaponStat
 * @property {string} id            stable weapon id, matching `weapon.id`
 * @property {number} slot          1-based selection slot (also the number key)
 * @property {'hitscan'|'projectile'|'melee'} kind
 * @property {number} damage        headline damage: one body hit at full charge
 * @property {number} headshotMul   multiplier applied to a precision hit
 * @property {string|null} ammoItem inventory item id consumed, or null
 * @property {number} ammoPerShot   units of `ammoItem` consumed per shot
 * @property {number} range         effective reach in metres
 */

/** @type {Object<string, WeaponStat & Record<string, any>>} */
export const WEAPON_STATS = {
  machinegun: {
    id: 'machinegun',
    slot: 1,
    kind: 'hitscan',
    damage: 18,
    headshotMul: 2.5,
    ammoItem: 'bullet',
    ammoPerShot: 1,
    /** Rounds held in the receiver; the bag is the reserve behind it. */
    magazine: 40,
    /** Bag target for an admin resupply. Six magazines of suppressing fire. */
    resupplyTarget: 240,
    range: 300,
    /** Flat damage out to here, then eased down to `falloffFloor` at `range`. */
    falloffStart: 40,
    falloffFloor: 0.55,
    /** Combat already computes this weapon's damage itself, so no rescale. */
    reference: 18,
    legacyHeadshotMul: 2.5,
  },

  fireball: {
    id: 'fireball',
    slot: 2,
    kind: 'projectile',
    damage: 55,
    /**
     * A fireball is a blast, not a bullet: a "headshot" is only the direct
     * impact landing on the head, so the bonus stays modest.
     */
    headshotMul: 1.35,
    /**
     * Advisory. `ProjectileSystem` owns the live blast radius (it scales it
     * with charge, 2.4 m to 5.2 m); this is the value a designer should read
     * as "the fireball's radius" and the figure the HUD may quote.
     */
    aoeRadius: 4.5,
    ammoItem: 'fireball_charge',
    ammoPerShot: 1,
    /**
     * Stated, not derived. `Loadout.resupplyAll` used to size a grant as
     * `magazine * 6`, and the fireball has no magazine - so it fell to the
     * `?? 20` default and asked for 120 Ember Cores, ten times the starting
     * kit, filling the bag with charges and leaving no slots for loot.
     * A charge is a heavy, slow, area-denial shot; two dozen is a lot of them.
     */
    resupplyTarget: 24,
    range: 140,
    /** `Fireball.js` `damageMax` - i.e. its full-charge, no-headshot output. */
    reference: 118,
    legacyHeadshotMul: 1.35,
  },

  bow: {
    id: 'bow',
    slot: 3,
    kind: 'projectile',
    damage: 42,
    headshotMul: 2.0,
    ammoItem: 'arrow',
    ammoPerShot: 1,
    /** Arrows nocked and ready; the bag is the quiver behind them. */
    magazine: 12,
    /** Bag target for an admin resupply: six quivers. */
    resupplyTarget: 72,
    range: 220,
    /** `Bow.js` `damageMax` - its full-draw, no-headshot output. */
    reference: 102,
    /** `Projectiles.js` `_arrowHit` bakes this in before Combat sees it. */
    legacyHeadshotMul: 2.6,
  },

  sword: {
    id: 'sword',
    slot: 4,
    kind: 'melee',
    /** Highest single-hit damage in the game: two swings kill a 100 HP NPC. */
    damage: 65,
    /**
     * No precision bonus. A sword arc sweeps the whole silhouette, so a
     * "headshot" would only ever mean "the target was slightly taller".
     */
    headshotMul: 1.0,
    ammoItem: null,
    ammoPerShot: 0,
    /** Shortest reach in the game - a little past arm plus blade. */
    range: 2.6,
    /** Total sweep in degrees, centred on the aim direction. */
    arc: 100,
    /** Seconds for wind-up + arc + follow-through + recovery. */
    swingTime: 0.72,
    /** Damage window as a fraction of `swingTime`: the arc itself. */
    strikeStart: 0.24,
    strikeEnd: 0.52,
    /** Minimum gap between swings, so holding fire chains rather than spams. */
    cooldown: 0.1,
    /**
     * Vertical reach. The sweep is planar in XZ; this is how far above or
     * below the player's feet a target's feet may be and still be cut.
     */
    verticalReach: 2.0,
    reference: 65,
    legacyHeadshotMul: 1.0,
  },
};

/** Selection order: also the `1/2/3/4` key order and the HUD strip order. */
export const WEAPON_ORDER = ['machinegun', 'fireball', 'bow', 'sword'];

/* ====================================================================== */
/* Weapon tiers                                                           */
/* ====================================================================== */

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE ONE GEAR CLASS WITH NO GROWTH AXIS, AND WHY THE TIER GOES ON THE ROW
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A mount sells four fittings at three tiers across six mounts - 57 catalogue
 * rows. A hull sells four at three tiers. A weapon sold nothing at all: the
 * four numbers above are flat, permanent and identical on the first minute of
 * a save and the last. Combat is also NET-NEGATIVE on credits at those numbers
 * - six rifle rounds out of a 150-credit pack of 60 against a bounty that pays
 * a handful - so the one system with no way to get better was also the one
 * losing money.
 *
 * ── THE TIER MULTIPLIES AT THE PROPERTY, NOT AT ONE CALL SITE ─────────────
 *
 * `weaponDamage()` below is documented as the single choke point and it is
 * NOT one: `grep weaponDamage` over `src/` returns this file and nothing else.
 * What actually happens to a point of damage is three different things.
 *
 *   machinegun  `Combat._resolveNPCHit` computes `stats.damage * falloff *
 *               headshotMul` inline and passes `statsApplied: true`
 *   sword       `Sword.js` holds `const SPEC = WEAPON_STATS.sword` at module
 *               scope and reads `SPEC.damage` on every cut, `statsApplied` too
 *   fireball    `Projectiles.js` hands its own charge-curve figure to
 *   bow         `applyNPCDamage`, which rescales it through `normaliseDamage`
 *
 * Multiplying inside `weaponDamage()` alone would have shipped a purchase that
 * changes nothing for three weapons out of four - and `Combat.js`,
 * `Sword.js` and `Projectiles.js` are not this module's to edit. So the tier
 * is applied where all four paths already meet: the `damage` PROPERTY itself.
 * `WEAPON_STATS[id].damage` is an accessor over a private base, and every
 * reader above - inline arithmetic, module-scoped alias, `normaliseDamage`'s
 * `s.damage / ref` ratio and `weaponDamage` - gets the tiered number without
 * one line changing outside this file.
 *
 * This is not a new pattern in the codebase. `ItemDefs.js` holds an
 * `activeMarket` at module scope, set by `setMarketWorld`, and `buyMultiplier`
 * reads it - a price that changes under every caller when the player walks
 * through a gateway. This is that arrangement for damage.
 *
 * ── Why it cannot double-apply ────────────────────────────────────────────
 *
 * Exactly one read of `damage` happens per hit on every one of the four paths,
 * and `normaliseDamage`'s `reference` is a CONSTANT (the untiered figure the
 * source module produces), so `s.damage / ref` is `base * tier / ref` - the
 * tier appears once, in the numerator. The gate drives all four weapons at
 * every tier and asserts the ratio.
 *
 * ── The step, and what it is allowed to break ─────────────────────────────
 *
 * 10% a tier, compounding with nothing: x1.10, x1.20, x1.30. MULTIPLICATIVE on
 * top of the four authored numbers and never a re-tune of them, because the
 * header above records that those four were tuned against charge curves in
 * three other modules and `reference` exists to preserve them to the decimal.
 *
 * 10% is the ship's `shield` rung and half the mount ladder's usual step, and
 * it is deliberately the smallest number in either table. Damage is the one
 * stat that can delete content: `CONFIG.npc.maxHealth` is 100 and the beasts
 * carry 220. At tier III -
 *
 *   sword   65 -> 84.5   still two swings for a 100 HP NPC (it was two)
 *   fireball 55 -> 71.5  still two hits (it was two)
 *   machinegun 18 -> 23.4  six body shots become five; a headshot goes 45 ->
 *                          58.5, so two headshots kill where three did
 *   bow     42 -> 54.6   a full-draw headshot goes 84 -> 109, which is a
 *                        one-shot kill on a 100 HP NPC
 *
 * The bow crossing 100 is the only threshold the ladder actually moves, and it
 * is one the game ALREADY sells for 44 credits: `firepower_boost_25` is x1.25
 * for thirty seconds and has always put a full-draw bow headshot at 105. A
 * permanent x1.30 that costs 1,599 credits to reach is not a new capability,
 * it is the consumable's ceiling made permanent - and it still asks for a
 * full draw and a head.
 */
export const WEAPON_POWER_TIERS = 3;

/** Fraction of base damage one tier adds. See the ladder note above. */
export const WEAPON_TIER_STEP = 0.10;

/** Roman numerals, the spelling every fitting ladder in the game uses. */
export const WEAPON_TIER_ROMAN = Object.freeze(['I', 'II', 'III']);

/**
 * Damage multiplier for an owned tier. `1` at tier 0, and at every number that
 * is not a tier - a save with `tier: 99` multiplies by 1, not by 10.9.
 * @param {number} tier
 * @returns {number}
 */
export function weaponTierMul(tier) {
  const t = Math.floor(Number(tier) || 0);
  if (t < 1 || t > WEAPON_POWER_TIERS) return 1;
  return 1 + WEAPON_TIER_STEP * t;
}

/**
 * Counter price of one weapon tier, in credits.
 *
 * `base * TIER_MUL[tier - 1]` with the server's own `[1, 2, 3.15]`, the shape
 * every mount row and every ship fitting is priced by - see
 * `SHIP_TIER_MUL` in `ships/ShipStats.js` for the note on why that copy is
 * scraped against the TypeScript rather than trusted.
 *
 * The four bases rank by what a tier BUYS. The sword is dearest because it is
 * the highest single-hit number in the game AND the only weapon that costs
 * nothing to fire; the machine gun is cheapest because 10% of 18 is under two
 * points and it burns a 150-credit pack of rounds getting there.
 */
const WEAPON_POWER_BASE = Object.freeze({
  machinegun: 240, bow: 260, fireball: 300, sword: 340,
});

/** @see SHIP_TIER_MUL - the same server constant, and the same reason for the copy. */
const WEAPON_TIER_MUL = Object.freeze([1, 2, 3.15]);

/**
 * @param {string} weaponId @param {number} tier
 * @returns {number} 0 for anything that is not a real weapon at a real tier
 */
export function weaponPowerPrice(weaponId, tier) {
  const base = WEAPON_POWER_BASE[weaponId];
  const t = Math.floor(Number(tier) || 0);
  if (!base || t < 1 || t > WEAPON_POWER_TIERS) return 0;
  return Math.round(base * WEAPON_TIER_MUL[t - 1]);
}

/** What a vendor pays to take one back. 0.4, the rate every mount upgrade uses. */
export function weaponPowerSellPrice(weaponId, tier) {
  return Math.round(weaponPowerPrice(weaponId, tier) * 0.4);
}

/** `Rifle Damage II`. The single speller, for a shop row and a toast alike. */
export function weaponPowerName(weaponId, tier) {
  const label = WEAPON_LABEL[weaponId] ?? weaponId;
  return `${label} Damage ${WEAPON_TIER_ROMAN[tier - 1] ?? tier}`;
}

/** Shop-facing weapon names. `machinegun` is sold as a rifle; nobody buys a "machinegun damage". */
export const WEAPON_LABEL = Object.freeze({
  machinegun: 'Rifle', fireball: 'Fireball', bow: 'Bow', sword: 'Sword',
});

/**
 * Who owns which weapon's tiers.
 *
 * Shaped after `ShipRegistry`'s powers half, deliberately and down to the
 * method names, because every behaviour in that half is a bug somebody already
 * found in play:
 *
 * - **`sellsPower` is public.** A till has to be able to REFUSE rather than
 *   take the money and drop the grant on the floor.
 * - **a higher tier replaces a lower one.** `max(owned, tier)`, so a save that
 *   restores out of order cannot downgrade a weapon.
 * - **an unknown weapon is dropped silently**, never stored and never emitted,
 *   exactly as an unknown livery slot is - so a stale catalogue row naming a
 *   weapon that no longer exists cannot poison the save.
 *
 * ── Why there is a module singleton and not only a class ──────────────────
 *
 * `main.js` builds every other registry and hands it round, and this module
 * cannot be handed anything: it is imported by `Combat`, `Sword`, `HUD` and
 * `Loadout`, and the accessor on `damage` has to answer the same question for
 * all of them. A registry that had to be wired would be a feature inert until
 * a file this module does not own changed. So `WEAPON_POWERS` is the live one,
 * the class is exported for a test that wants an isolated ledger, and
 * `Loadout.serialize` round-trips the singleton - which is how a purchase
 * survives a reload without `SaveGame` growing a new field.
 */
export class WeaponRegistry {
  constructor({ bus = null } = {}) {
    this.bus = bus;
    /** @type {Object<string, number>} weapon id -> owned tier */
    this._powers = {};
  }

  /** True when this weapon has a tier ladder to sell at all. */
  sellsPower(weaponId) {
    return WEAPON_ORDER.includes(weaponId);
  }

  /** Owned tier for one weapon, 0 when none. */
  tierOf(weaponId) {
    return Math.max(0, Math.floor(Number(this._powers[weaponId]) || 0));
  }

  /** Damage multiplier in force for one weapon right now. */
  multiplier(weaponId) {
    return weaponTierMul(this.tierOf(weaponId));
  }

  /** A copy of the whole ledger. Copy, so a caller cannot write the tier bag. */
  getPowers() {
    return { ...this._powers };
  }

  /**
   * Grant a tier. A weapon with no ladder, or a tier off the ladder, is
   * dropped silently - never stored, never emitted.
   * @returns {boolean} true when the ledger actually moved
   */
  grantPower(weaponId, tier = 1) {
    if (!this.sellsPower(weaponId)) return false;
    const t = Math.floor(Number(tier) || 0);
    if (t < 1 || t > WEAPON_POWER_TIERS) return false;
    const now = this.tierOf(weaponId);
    if (t <= now) return false;
    this._powers[weaponId] = t;
    this.bus?.emit?.('weapon:powers', { weaponId, tier: t, powers: this.getPowers() });
    return true;
  }

  /** @returns {{powers:Object<string,number>}} */
  serialize() {
    return { powers: this.getPowers() };
  }

  /**
   * Restore from a save. Every row is re-accepted through `grantPower`, so a
   * hand-edited `{"sword": 99}` restores as nothing rather than as a x10.9
   * sword - the same discipline `Inventory.deserialize` applies to capacity.
   */
  deserialize(data) {
    const rows = data?.powers ?? data ?? null;
    if (!rows || typeof rows !== 'object') return;
    this._powers = {};
    for (const [id, tier] of Object.entries(rows)) this.grantPower(id, tier);
  }

  /** Back to stock. For a test, and for a fresh-run reset. */
  clear() {
    this._powers = {};
  }
}

/**
 * The ledger the `damage` accessor reads. See the note on the class.
 *
 * Constructed with no bus: `main.js` may assign `WEAPON_POWERS.bus = bus` to
 * get the `weapon:powers` event, and nothing depends on it having done so.
 */
export const WEAPON_POWERS = new WeaponRegistry();

/*
 * Turn every row's `damage` into an accessor over its authored base.
 *
 * Done in a loop over `WEAPON_ORDER` rather than by hand-writing four getters,
 * so a fifth weapon added to the table above gets its ladder for free rather
 * than being the one weapon the shop cannot upgrade - the failure mode this
 * whole block exists to end, one weapon smaller.
 *
 * The SETTER is not decoration. `damage` was a plain writable data property
 * for the life of this file; making it read-only would turn any existing
 * `stats.damage = n` into a silent no-op in sloppy mode and a throw in strict.
 * Nothing in `src/` does that today, and "nothing does it today" is not a
 * reason to remove the ability - so a write lands on the BASE, which is what
 * the writer meant, and the owned tier keeps multiplying it afterwards. A
 * setter that replaced the accessor with a plain value would have quietly
 * turned that weapon's whole ladder off, permanently, for the rest of the
 * session - a purchase that stops working because of an unrelated re-tune.
 *
 * `baseDamage` is a getter over the same closure and not a snapshot, for the
 * same reason: two copies of one number and the second one goes stale.
 */
for (const id of WEAPON_ORDER) {
  const row = WEAPON_STATS[id];
  if (!row) continue;
  let base = row.damage;
  Object.defineProperty(row, 'damage', {
    get() { return base * WEAPON_POWERS.multiplier(id); },
    set(v) { const n = Number(v); if (Number.isFinite(n)) base = n; },
    enumerable: true,
    configurable: true,
  });
  /** The authored, untiered figure. Read by the gate; not part of the row's JSON. */
  Object.defineProperty(row, 'baseDamage', { get() { return base; }, enumerable: false, configurable: true });
}

/**
 * Inventory item id each weapon draws from, keyed by weapon id. `null` means
 * the weapon needs no ammunition.
 * @type {Object<string, string|null>}
 */
export const AMMO_ITEMS = Object.freeze(
  WEAPON_ORDER.reduce((acc, id) => {
    acc[id] = WEAPON_STATS[id].ammoItem;
    return acc;
  }, /** @type {Object<string, string|null>} */ ({}))
);

/**
 * Look up a weapon's stat block.
 * @param {string} id weapon id
 * @returns {WeaponStat & Record<string, any> | null}
 */
export function statsFor(id) {
  return WEAPON_STATS[id] ?? null;
}

/**
 * Inventory item a weapon consumes.
 * @param {string} id weapon id
 * @returns {string|null}
 */
export function ammoItemFor(id) {
  return WEAPON_STATS[id]?.ammoItem ?? null;
}

/**
 * Damage multiplier by distance for a hitscan weapon.
 *
 * Flat out to `falloffStart`, then eased to `falloffFloor` at maximum range.
 * The 0.6 exponent front-loads the loss so most of the drop happens over the
 * first hundred metres, which is where fights actually happen.
 *
 * @param {string} id weapon id
 * @param {number} distance metres from muzzle to target
 * @returns {number} 0..1
 */
export function falloffFor(id, distance) {
  const s = WEAPON_STATS[id];
  if (!s || !Number.isFinite(s.falloffStart)) return 1;
  if (distance <= s.falloffStart) return 1;
  const span = Math.max(1, s.range - s.falloffStart);
  const t = Math.min(1, (distance - s.falloffStart) / span);
  return 1 - (1 - s.falloffFloor) * Math.pow(t, 0.6);
}

/**
 * Final damage for one hit, computed entirely from this table.
 *
 * @param {string} id weapon id
 * @param {{isHeadshot?:boolean, distance?:number, charge?:number}} [opts]
 *   `charge` is 0..1 and scales linearly onto `damage`; omit it for weapons
 *   that do not charge.
 * @returns {number}
 */
export function weaponDamage(id, opts = {}) {
  const s = WEAPON_STATS[id];
  if (!s) return 0;
  let d = s.damage;
  if (Number.isFinite(opts.charge)) d *= Math.max(0, Math.min(1, opts.charge));
  if (Number.isFinite(opts.distance)) d *= falloffFor(id, opts.distance);
  if (opts.isHeadshot) d *= s.headshotMul;
  return d;
}

/**
 * Republish a damage figure produced by a module that does not yet read this
 * table (see the header). Idempotent for weapons whose `reference` already
 * equals their `damage`, so it is safe to route everything through it.
 *
 * @param {string} id weapon id
 * @param {number} amount the module's damage figure, multipliers included
 * @param {{isHeadshot?:boolean}} [opts]
 * @returns {number} the same hit expressed in this table's units
 */
export function normaliseDamage(id, amount, opts = {}) {
  const s = WEAPON_STATS[id];
  if (!s || !(amount > 0)) return amount;
  const ref = s.reference;
  if (!(ref > 0)) return amount;

  // Strip the precision bonus the source module baked in, rescale the body
  // damage, then re-apply this table's bonus. Doing it in that order is what
  // lets `headshotMul` be retuned here without touching the source module.
  const legacyHead = opts.isHeadshot ? (s.legacyHeadshotMul || 1) : 1;
  const base = amount / legacyHead;
  const scaled = base * (s.damage / ref);
  return opts.isHeadshot ? scaled * s.headshotMul : scaled;
}

export default WEAPON_STATS;
