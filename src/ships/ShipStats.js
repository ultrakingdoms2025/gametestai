/**
 * Ship customisation data — slots, stats, factory colours and schemes.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THIS IS A PARALLEL FILE AND NOT A WIDENING OF `mounts/Livery.js`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Livery.MOUNT_STATS` is six mount ids and it is not a lookup table — it is
 * the AUTHORITY `scripts/tests/mount-catalog.test.mjs:32-41` validates every
 * `grant_mount_power` marketplace row against. Add `kestrel` to it and a
 * catalogue row selling a mount power for a ship passes silently, which is the
 * whole class of defect that test exists to catch. So the ship ladder lives
 * here, and `MOUNT_STATS` is left alone.
 *
 * What DOES get imported from `mounts/Livery.js`, unchanged and directly:
 * `FINISH_PROPS`, `normColor`, `applyLivery`, `liveryMatches`, `cloneLivery`
 * and the `factoryOf` snapshot behind them. Five of its seven exports contain
 * no reference to the word "mount", take `(livery, slots, slotMats)`, and the
 * file imports nothing from three — so it stays headless-testable and there was
 * nothing to fork.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE FACTORY COLOURS ARE THE SWATCHES, NOT A COLOUR THAT LOOKS RIGHT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `SHIP_TINTS` is handed to `ShipKit.shipMaterials` as the clones' real
 * `.color`, AND it is what `SHIP_SLOTS[...].defaultColor` reads. That identity
 * is not decoration:
 *
 * - On an ORM-mapped material `.color` is a WHITE MULTIPLIER over the albedo
 *   map. Writing a swatch that is not the recorded factory value multiplies the
 *   map by itself and the part visibly darkens — the button that means "put it
 *   back" makes it worse. `MountMenu.js:189` guards it with
 *   `if (c === slot.defaultColor && livery[slot.id]?.color == null) return;`
 *   and that guard is only correct while `defaultColor` IS the factory value.
 * - `mount-menu.test.mjs:15-28` pins the other half: every `defaultColor` must
 *   be a member of its own palette, or the panel opens with the custom picker
 *   lit instead of a swatch for every player of that hull. `ship-menu.test.mjs`
 *   is the ship's copy of that rule.
 */

/** Menu order, and the order the yard's berths run down the keel line. */
export const SHIP_ORDER = Object.freeze(['kestrel', 'dray', 'pike']);

/**
 * The four hulls. `bastion` is here because the yard has one and the spec
 * boards read off this table; it carries no stats and no slots, because it is
 * a hulk with its ribs open to the air and nothing to fit out.
 */
export const SHIP_CLASSES = Object.freeze({
  kestrel: Object.freeze({
    id: 'kestrel', name: 'Kestrel', klass: 'courier', length: 14,
    blurb: 'Fast, fragile, cheap. Two crew days from anywhere on the ring.',
  }),
  dray: Object.freeze({
    id: 'dray', name: 'Dray', klass: 'ore tender', length: 28,
    blurb: 'Nine metres of hold and an engine room you can stand up in.',
  }),
  pike: Object.freeze({
    id: 'pike', name: 'Pike', klass: 'interceptor', length: 18,
    blurb: 'Guns, no room, no cargo. The gun bay is a crouch and it is meant to be.',
  }),
  bastion: Object.freeze({
    id: 'bastion', name: 'Bastion', klass: 'frigate hulk', length: 44,
    blurb: 'Never finished. Half her frames are still open to the shed.',
  }),
});

/**
 * Factory colours per hull.
 *
 * These differ per hull deliberately: the design rule for this world is that
 * the ships differ in silhouette, interior programme, stat ladder AND slot
 * palette, never only in colour — so a Kestrel out of the box is pale hull with
 * courier orange, and a Pike is gunmetal with a red flash.
 */
export const SHIP_TINTS = Object.freeze({
  kestrel: Object.freeze({ hull: 0xbcc6d2, trim: 0xd2762f, glass: 0x2c3f52, glow: 0x4fe3ff, accent: 0x8996a6 }),
  dray: Object.freeze({ hull: 0x8d97a4, trim: 0xc9a13c, glass: 0x35505f, glow: 0xffb347, accent: 0x6f7a88 }),
  pike: Object.freeze({ hull: 0x6f7d8c, trim: 0xc23a2f, glass: 0x24323f, glow: 0xff6a3a, accent: 0xb9c2cc }),
  bastion: Object.freeze({ hull: 0x7a6f63, trim: 0x8a5a2b, glass: 0x2a3540, glow: 0xff4b45, accent: 0x5f6874 }),
});

/** The fifth slot's label, per hull. The four common ones are shared. */
const ACCENT_LABEL = Object.freeze({
  kestrel: 'Nacelle shells',
  dray: 'Hold gear',
  pike: 'Ordnance shrouds',
});

function slotsFor(id) {
  const t = SHIP_TINTS[id];
  return Object.freeze([
    Object.freeze({ id: 'hull', label: 'Hull plating', finish: true, defaultColor: t.hull, palette: 'shipHull' }),
    Object.freeze({ id: 'trim', label: 'Trim & stripes', finish: true, defaultColor: t.trim, palette: 'shipTrim' }),
    Object.freeze({ id: 'canopy', label: 'Canopy tint', finish: false, defaultColor: t.glass, palette: 'shipGlass' }),
    Object.freeze({ id: 'thruster', label: 'Thruster glow', finish: false, defaultColor: t.glow, palette: 'shipGlow' }),
    Object.freeze({ id: 'accent', label: ACCENT_LABEL[id], finish: true, defaultColor: t.accent, palette: 'shipAccent' }),
  ]);
}

/** Livery slots per hull. Five each; the fifth is what the hull is FOR. */
export const SHIP_SLOTS = Object.freeze({
  kestrel: slotsFor('kestrel'),
  dray: slotsFor('dray'),
  pike: slotsFor('pike'),
});

/**
 * The upgrade ladder each hull sells.
 *
 * `hold` is the fourth stat and the reason the Dray is not a Kestrel in a
 * different colour. It is also the only one with an effect in this drop —
 * `power`, `shield` and `fire` are banked, persisted, shown in the panel and
 * applied by the flight drop.
 *
 * ── And that is a recorded hazard, not a shrug ───────────────────────────
 * `Dragon.js:2470-2475` records that the dragon's `applyPowers` hook did not
 * exist for a while, so tiers were banked, persisted, re-emitted and applied to
 * nothing. The mitigation here is the same one: `Ship.applyPowers` ships in
 * this drop and writes `_powerMul / _accelMul / _shieldTier / _fireTier /
 * _holdCap` even though the flight model that reads them does not exist yet,
 * and every tier is surfaced with its effect line in the panel — because "a
 * purchase whose entire effect is a slightly earlier lap time is
 * indistinguishable from a purchase that did nothing".
 */
export const SHIP_STATS = Object.freeze({
  kestrel: Object.freeze(['power', 'shield', 'fire', 'hold']),
  dray: Object.freeze(['power', 'shield', 'fire', 'hold']),
  pike: Object.freeze(['power', 'shield', 'fire', 'hold']),
});

/** Per-tier effect. `unit` is UI copy and appears verbatim in the panel. */
export const SHIP_STAT_META = Object.freeze({
  power: Object.freeze({ label: 'Thrust', perTier: 12, unit: 'top speed' }),
  shield: Object.freeze({ label: 'Shields', perTier: 10, unit: 'less hull damage' }),
  fire: Object.freeze({ label: 'Firepower', perTier: 15, unit: 'laser damage' }),
  hold: Object.freeze({ label: 'Hold', perTier: 25, unit: 'mineral capacity' }),
});

/**
 * What each hull IS before a credit is spent — the stat bias the spec boards
 * paint and the reason a player picks one over another.
 */
export const SHIP_BASE_STATS = Object.freeze({
  kestrel: Object.freeze({ power: 3, shield: 1, fire: 1, hold: 1 }),
  dray: Object.freeze({ power: 1, shield: 3, fire: 1, hold: 4 }),
  pike: Object.freeze({ power: 2, shield: 2, fire: 4, hold: 0 }),
});

/** Cubic metres of hold at base tier 1. The Dray's four tiers are 40 m3. */
export const HOLD_PER_TIER = 10;

/**
 * Hold capacity, in cubic metres, for a hull at an owned upgrade tier.
 * Base bias plus purchased tiers, both on the same ladder.
 */
export function holdCapacity(shipId, tier = 0) {
  const base = SHIP_BASE_STATS[shipId]?.hold ?? 0;
  const t = Math.max(0, Math.floor(Number(tier) || 0));
  return (base + t) * HOLD_PER_TIER;
}

/**
 * Yard schemes: livery presets over each hull's slots.
 *
 * ── Why these are painted rather than purchased in this drop ─────────────
 * The mount arrangement is 20 data rows for 20 skins, and the LAST of those
 * rows is a `BASE_ITEMS` entry in `site/lib/marketplaceCatalog.ts` plus a
 * `kind === 'shipskin'` dispatch in `ItemUse` plus a `KNOWN_*` guard in the
 * cosmetics ledger — files this stage does not own. A skin card that can never
 * be unlocked is the signature defect of this project rendered as a UI element:
 * built, visible, and unreachable.
 *
 * So in this drop they are what the yard would actually call them — schemes the
 * Paint & Rope counter stencils for nothing, applied straight from the panel.
 * {@link KNOWN_SHIP_SKIN_IDS} is exported ready for the ledger guard, and the
 * ids are stable, so wiring the purchase path later adds rows and changes no
 * data.
 */
export const SHIP_SKINS = Object.freeze([
  { id: 'kestrel_courier', ship: 'kestrel', name: 'Ring Courier', blurb: 'Yard white, courier orange.', livery: { hull: { color: 0xe6e9ee, finish: 'gloss' }, trim: { color: 0xf27b1f, finish: 'gloss' }, thruster: { color: 0x4fe3ff } } },
  { id: 'kestrel_nightmail', ship: 'kestrel', name: 'Night Mail', blurb: 'Matt charcoal with a cold flash.', livery: { hull: { color: 0x2c2f36, finish: 'matt' }, trim: { color: 0xbcd8ff, finish: 'gloss' }, thruster: { color: 0xadefff } } },
  { id: 'kestrel_survey', ship: 'kestrel', name: 'Survey 06', blurb: 'The livery the site wore before it was a yard.', livery: { hull: { color: 0xb9c2cc, finish: 'matt' }, trim: { color: 0xc9a13c, finish: 'matt' }, accent: { color: 0x6f7a88, finish: 'matt' } } },
  { id: 'dray_orehauler', ship: 'dray', name: 'Ore Hauler', blurb: 'Dust ochre over a working hull.', livery: { hull: { color: 0x9a7b4f, finish: 'matt' }, trim: { color: 0xc9a13c, finish: 'matt' }, accent: { color: 0x5a3a24, finish: 'matt' } } },
  { id: 'dray_deepblack', ship: 'dray', name: 'Deep Black', blurb: 'Unlit hull, amber running gear.', livery: { hull: { color: 0x14181f, finish: 'matt' }, trim: { color: 0xffb347, finish: 'gloss' }, thruster: { color: 0xffb347 } } },
  { id: 'dray_saltline', ship: 'dray', name: 'Saltline', blurb: 'Sea green and brass, off the old tenders.', livery: { hull: { color: 0x2f5d52, finish: 'gloss' }, trim: { color: 0xc9a24a, finish: 'gloss' }, accent: { color: 0x8996a6, finish: 'gloss' } } },
  { id: 'pike_redflight', ship: 'pike', name: 'Red Flight', blurb: 'Gunmetal with a race-red spine.', livery: { hull: { color: 0x2a2e33, finish: 'gloss' }, trim: { color: 0xc21f2f, finish: 'gloss' }, thruster: { color: 0xff6a3a } } },
  { id: 'pike_splinter', ship: 'pike', name: 'Splinter', blurb: 'Pale grey, black ordnance.', livery: { hull: { color: 0xd9dde2, finish: 'matt' }, trim: { color: 0x0d0f12, finish: 'matt' }, accent: { color: 0x0d0f12, finish: 'matt' } } },
  { id: 'pike_venom', ship: 'pike', name: 'Venom', blurb: 'Acid green over black, and a green throat.', livery: { hull: { color: 0x18a86b, finish: 'gloss' }, trim: { color: 0x14181f, finish: 'matt' }, thruster: { color: 0xa8ff3b } } },
]);

/** Fast lookup, the shape `MOUNT_SKINS_BY_ID` has. */
export const SHIP_SKINS_BY_ID = new Map(SHIP_SKINS.map((s) => [s.id, s]));

/**
 * Every ship-skin id a ledger is allowed to grant. Exported now so the guard is
 * written next to the data it guards, the way `Cosmetics.KNOWN_SKIN_IDS` is.
 */
export const KNOWN_SHIP_SKIN_IDS = new Set(SHIP_SKINS.map((s) => s.id));

/** Schemes for one hull, in catalogue order. */
export function shipSkinsFor(shipId) {
  return SHIP_SKINS.filter((s) => s.ship === shipId);
}

/** The bag-item id a purchasable ship skin WOULD carry. Stable from day one. */
export function shipSkinItemId(skinId) {
  return `shipskin_${skinId}`;
}
