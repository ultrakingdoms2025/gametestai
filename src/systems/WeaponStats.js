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
