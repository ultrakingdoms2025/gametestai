import { applyLivery } from '../mounts/Livery.js';
import { SHIP_SLOTS, SHIP_STATS, SHIP_STAT_META, SHIP_BASE_STATS, holdCapacity } from './ShipStats.js';

/** How much one point of stat bias is worth. See `applyPowers`. */
export const BIAS_PER_POINT = 0.25;
/** Tiers the ladder sells, which is what the panel draws pips for. */
export const MAX_TIER = 3;

/**
 * A hull that exists in a world, as far as the customiser is concerned.
 *
 * The WORLD builds the geometry; this is the handle the panel and the registry
 * hold on to. It owns exactly two things — the cloned materials a livery
 * writes, and the multipliers an upgrade tier produces — and it deliberately
 * owns no geometry, no physics and no scene graph, so a hull can be tested
 * without a renderer and the yard can rebuild without the registry noticing.
 *
 * ── `applyPowers` ships now, and reads to nothing, ON PURPOSE ────────────
 * `Dragon.js:2470-2475` records the failure this avoids: the dragon's
 * `applyPowers` hook did not exist for a while, so tiers were banked,
 * persisted, re-emitted, and applied to nothing at all. Every number below is
 * computed and stored in this drop even though the six-degree flight model that
 * reads them is the next one — so when it lands, the wiring is already proved
 * and the only new thing is the physics.
 *
 * ── The two arithmetic lessons the flight drop must inherit ──────────────
 * Written here rather than in a design document, because this is the object the
 * flight model will reach for:
 *
 * 1. **A speed tier widens the turning radius** unless the falloff curve
 *    divides by the TIERED top speed *and* the turn rate, cap and gain are all
 *    multiplied by `powerMul`. Measured before the fix: eagle 29.5 -> 44.8 m
 *    (x1.52), hoverboard 11.6 -> 19.1 m (x1.65), horse 18.2 -> 24.8 m (x1.36).
 *    "It all saturates, so a tier is visually safe" was wrong twice.
 * 2. **On a drag-limited craft, Acceleration leaks into top speed** unless the
 *    NET is scaled: `speed += (thrust - drag) * accelMul * dt`, never
 *    `thrust * accelMul`. A six-degree arcade model with an assist is
 *    drag-limited by construction.
 */
export class Ship {
  /**
   * @param {object} o
   * @param {string} o.id      'kestrel' | 'dray' | 'pike'
   * @param {string} o.displayName
   * @param {Record<string, Array<any>>} o.slotMats from `ShipKit.shipMaterials`
   * @param {{x:number,y:number,z:number}} [o.position] the berth, for the panel
   * @param {string} [o.berth]
   */
  constructor({ id, displayName, slotMats, position = null, berth = '' }) {
    this.id = id;
    this.displayName = displayName ?? id;
    this.berth = berth;
    this.position = position;
    this._slotMats = slotMats ?? {};

    /** Multipliers the flight drop reads. See the class note. */
    this._powerMul = 1;
    this._accelMul = 1;
    this._shieldTier = 0;
    this._fireTier = 0;
    this._holdCap = holdCapacity(id, 0);
    /** The last bag applied, so a re-apply is idempotent and inspectable. */
    this._tiers = { power: 0, shield: 0, fire: 0, hold: 0 };
  }

  /** The slots this hull sells. Static data; the panel is generic over it. */
  get slots() { return SHIP_SLOTS[this.id] ?? []; }
  /** The stats this hull sells. */
  get stats() { return SHIP_STATS[this.id] ?? []; }
  /** What the hull is before a credit is spent. */
  get baseStats() { return SHIP_BASE_STATS[this.id] ?? {}; }

  /**
   * Write a livery onto this hull's cloned materials.
   *
   * `applyLivery` is imported from `mounts/Livery.js` unchanged: it takes
   * `(livery, slots, slotMats)`, writes uniforms only, never touches
   * `needsUpdate` (a mid-frame program link is the exact stall the station work
   * spent weeks removing) and remembers each material's factory look on the
   * material itself, so clearing a slot restores the RECORDED multipliers
   * rather than a guessed number.
   */
  applyCustomization(livery) {
    applyLivery(livery, this.slots, this._slotMats);
  }

  /**
   * Turn owned tiers into the numbers a flight model multiplies by.
   *
   * ── `BIAS_PER_POINT = 0.25`, and it is derived rather than chosen ────────
   * The ladder is three tiers of `SHIP_STAT_META.power.perTier = 12%`, so a
   * fully upgraded hull is `x1.36`. For the hull's own bias to survive that —
   * which is the whole reason the three ships are not each other in a different
   * colour — the gap between the fastest bias (Kestrel, 3) and the slowest
   * (Dray, 1) has to be at least that much:
   *
   *     (1 + 3k) / (1 + k) >= 1.36   =>   1.64k >= 0.36   =>   k >= 0.2195
   *
   * 0.25 clears it with a little room and lands somewhere worth landing: a Dray
   * with every thrust tier bought reaches 1.70 against a stock Kestrel's 1.75,
   * so you can buy an ore tender up to courier speed and no further. At the
   * 0.10 first written, two tiers were enough to make the Dray the faster ship,
   * and `ship-customizer.test.mjs` said so.
   */
  applyPowers(bag = {}) {
    const t = (k) => Math.max(0, Math.floor(Number(bag?.[k]) || 0));
    this._tiers = { power: t('power'), shield: t('shield'), fire: t('fire'), hold: t('hold') };
    const base = this.baseStats;
    this._powerMul = (1 + (base.power ?? 0) * BIAS_PER_POINT)
      * (1 + (this._tiers.power * SHIP_STAT_META.power.perTier) / 100);
    /* Acceleration rides with thrust on a ship: there is no separate
     * Acceleration stat in the ship ladder, so `accelMul` tracks `powerMul`.
     * It is a distinct field anyway, because the moment the flight model wants
     * them apart, the leak in lesson 2 above depends on which one it scales. */
    this._accelMul = this._powerMul;
    this._shieldTier = (base.shield ?? 0) + this._tiers.shield;
    this._fireTier = (base.fire ?? 0) + this._tiers.fire;
    this._holdCap = holdCapacity(this.id, this._tiers.hold);
  }

  /** Everything a HUD badge or a spec board wants, in one read. */
  snapshot() {
    return {
      id: this.id,
      name: this.displayName,
      berth: this.berth,
      powerMul: this._powerMul,
      accelMul: this._accelMul,
      shieldTier: this._shieldTier,
      fireTier: this._fireTier,
      holdCapacity: this._holdCap,
      tiers: { ...this._tiers },
    };
  }
}
