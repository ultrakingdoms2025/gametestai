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

/**
 * Livery slots per hull. Five each; the fifth is what the hull is FOR.
 *
 * ── THE BASTION IS PRESENT, AND EMPTY, AND THAT IS THE FIX ────────────────
 * `ShipRegistry._knownSlot` returns TRUE for a hull with no table at all —
 * deliberately, so a hull committed before its tables keeps working. The
 * Bastion is not mid-migration: it is a hulk that sells nothing, for ever. It
 * was ABSENT here, so every slot was "known" for it, and `setLivery('bastion',
 * …)` merged the patch, stored it, emitted `ship:livery` and wrote it into the
 * save — while `_ships.get('bastion')` is undefined, so `applyCustomization`
 * was never called and not one pixel moved. Verified live in the yard:
 *
 *   setLivery('bastion', { hull: { color: '#ff00ff' } })
 *   -> serialize() === {"liveries":{"bastion":{"hull":{"color":16711935}}}, …}
 *   -> the Bastion's five material colours byte-identical to before
 *
 * That is precisely the "purchase consumed with nowhere to land" failure
 * `applyScheme` and `MountSkins.js:26-28` document, one hull over. An empty
 * FROZEN array is truthy, so `[].some(...)` is false and every slot is now
 * refused — in `setLivery` and in `deserialize`, which shares the same filter.
 */
export const SHIP_SLOTS = Object.freeze({
  kestrel: slotsFor('kestrel'),
  dray: slotsFor('dray'),
  pike: slotsFor('pike'),
  bastion: Object.freeze([]),
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
  /* The stat half of the same defect, and the worse half, because this one is
   * wired to a till: `sellsPower('bastion', 'power')` returned TRUE, so the
   * marketplace would have taken the credits and `grantPower` would have
   * banked `{"bastion":{"power":3}}` into the save with no `Ship` to apply it
   * to. Measured in the yard before the fix. See the note on `SHIP_SLOTS`. */
  bastion: Object.freeze([]),
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
 * Ship liveries: presets over each hull's slots. Eighteen of them, in two
 * tiers, and the tier is a field on the row rather than a second table.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE NINE FREE SCHEMES STAYED FREE. THAT IS THE WHOLE SHAPE OF THIS FILE.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * This note used to say the schemes were painted rather than purchased because
 * the purchase path was "files this stage does not own" — a `BASE_ITEMS` row,
 * a `kind === 'shipskin'` dispatch in `ItemUse`, a `KNOWN_*` guard in the
 * cosmetics ledger. Every one of those now exists, so that reason is dead and
 * the note that gave it would be a confident explanation of a decision that
 * has been reversed, which is worse than no note at all.
 *
 * What did NOT happen is the obvious move: putting the existing nine behind
 * the till. They shipped free, players have them, and taking a thing away to
 * sell it back is a regression whatever the catalogue gains. So the nine are
 * untouched — same ids, same colours, same "Paint it" button — and NINE NEW
 * ones were authored beside them, three per hull, matching the free count
 * exactly so no hull's panel looks short-changed against another's.
 *
 * ── What makes a paid one worth paying for, stated as a rule ─────────────
 * A yard scheme is three tins off a shelf: the free nine each touch THREE
 * slots and leave the rest at factory. A commissioned livery is the whole
 * ship — all FIVE slots, canopy tint and nacelle shells included. That is a
 * rule and not a taste call, it is asserted in `ship-customizer.test.mjs`, and
 * it is legible in the panel without reading a price: a free card draws three
 * colour dots and a paid one draws five.
 *
 * ── `paid` and `cost`, and why the cost lives HERE ───────────────────────
 * `cost` is the counter price in credits, and it is on the game's own row
 * rather than only in `site/lib/marketplaceCatalog.ts`, because the item's
 * `value` in `ItemDefs` is derived from it. Two independently authored numbers
 * for one livery is how a 900 CR purchase comes to sell back for more than it
 * cost; one number with the catalogue checked against it cannot drift.
 *
 * The free nine carry NO `paid` and NO `cost`. Absence is the free state, so a
 * scheme authored without thinking about money is free by default — which is
 * the safe direction for the mistake to fall in.
 *
 * @type {ReadonlyArray<{id:string, ship:string, name:string, blurb:string,
 *   paid?:true, cost?:number,
 *   livery:Object<string,{color:number, finish?:'matt'|'gloss'}>}>}
 */
export const SHIP_SKINS = Object.freeze([
  /* ---- The yard's own, free, three slots each -------------------------- */
  { id: 'kestrel_courier', ship: 'kestrel', name: 'Ring Courier', blurb: 'Yard white, courier orange.', livery: { hull: { color: 0xe6e9ee, finish: 'gloss' }, trim: { color: 0xf27b1f, finish: 'gloss' }, thruster: { color: 0x4fe3ff } } },
  { id: 'kestrel_nightmail', ship: 'kestrel', name: 'Night Mail', blurb: 'Matt charcoal with a cold flash.', livery: { hull: { color: 0x2c2f36, finish: 'matt' }, trim: { color: 0xbcd8ff, finish: 'gloss' }, thruster: { color: 0xadefff } } },
  { id: 'kestrel_survey', ship: 'kestrel', name: 'Survey 06', blurb: 'The livery the site wore before it was a yard.', livery: { hull: { color: 0xb9c2cc, finish: 'matt' }, trim: { color: 0xc9a13c, finish: 'matt' }, accent: { color: 0x6f7a88, finish: 'matt' } } },
  { id: 'dray_orehauler', ship: 'dray', name: 'Ore Hauler', blurb: 'Dust ochre over a working hull.', livery: { hull: { color: 0x9a7b4f, finish: 'matt' }, trim: { color: 0xc9a13c, finish: 'matt' }, accent: { color: 0x5a3a24, finish: 'matt' } } },
  { id: 'dray_deepblack', ship: 'dray', name: 'Deep Black', blurb: 'Unlit hull, amber running gear.', livery: { hull: { color: 0x14181f, finish: 'matt' }, trim: { color: 0xffb347, finish: 'gloss' }, thruster: { color: 0xffb347 } } },
  { id: 'dray_saltline', ship: 'dray', name: 'Saltline', blurb: 'Sea green and brass, off the old tenders.', livery: { hull: { color: 0x2f5d52, finish: 'gloss' }, trim: { color: 0xc9a24a, finish: 'gloss' }, accent: { color: 0x8996a6, finish: 'gloss' } } },
  { id: 'pike_redflight', ship: 'pike', name: 'Red Flight', blurb: 'Gunmetal with a race-red spine.', livery: { hull: { color: 0x2a2e33, finish: 'gloss' }, trim: { color: 0xc21f2f, finish: 'gloss' }, thruster: { color: 0xff6a3a } } },
  { id: 'pike_splinter', ship: 'pike', name: 'Splinter', blurb: 'Pale grey, black ordnance.', livery: { hull: { color: 0xd9dde2, finish: 'matt' }, trim: { color: 0x0d0f12, finish: 'matt' }, accent: { color: 0x0d0f12, finish: 'matt' } } },
  { id: 'pike_venom', ship: 'pike', name: 'Venom', blurb: 'Acid green over black, and a green throat.', livery: { hull: { color: 0x18a86b, finish: 'gloss' }, trim: { color: 0x14181f, finish: 'matt' }, thruster: { color: 0xa8ff3b } } },

  /* ---- Commissioned, purchased, five slots each ------------------------
   *
   * Nine liveries a pilot ordered rather than nine the yard keeps in stock, so
   * every blurb names a person or a job and none of them says "yard". They are
   * priced by hull, not by how much anyone likes them: a Kestrel is fourteen
   * metres and a Pike is the hull people look at, so the courier is the cheap
   * commission and the interceptor is the dear one. The spread within a hull
   * is the labour — a hand-laid line costs more than a single flatted coat. */
  { id: 'kestrel_kingfisher', ship: 'kestrel', name: 'Kingfisher', paid: true, cost: 640, blurb: 'Enamel blue over a white belly, copper shells. Ordered by a courier who was never once late.', livery: { hull: { color: 0x1b4f7a, finish: 'gloss' }, trim: { color: 0xe8eef4, finish: 'gloss' }, canopy: { color: 0x1b2530 }, thruster: { color: 0x4fe3ff }, accent: { color: 0xb87333, finish: 'gloss' } } },
  { id: 'kestrel_blackline', ship: 'kestrel', name: 'Blackline', paid: true, cost: 700, blurb: 'Six coats of black, flatted between each one, and a silver hairline laid by hand.', livery: { hull: { color: 0x0d0f12, finish: 'gloss' }, trim: { color: 0xd9dde2, finish: 'gloss' }, canopy: { color: 0x203a3a }, thruster: { color: 0xffffff }, accent: { color: 0x2a2e33, finish: 'gloss' } } },
  { id: 'kestrel_solstice', ship: 'kestrel', name: 'Solstice', paid: true, cost: 760, blurb: 'Bone white and old gold, off a hull that flew the long side of the ring in daylight.', livery: { hull: { color: 0xf2f4f6, finish: 'gloss' }, trim: { color: 0xc9a24a, finish: 'gloss' }, canopy: { color: 0x5a4a1f }, thruster: { color: 0xffe14a }, accent: { color: 0x8a5a2b, finish: 'matt' } } },
  { id: 'dray_brasshearth', ship: 'dray', name: 'Brass Hearth', paid: true, cost: 720, blurb: 'Dark bronze under polished brass. The tender an ore family kept for four generations.', livery: { hull: { color: 0x4a3627, finish: 'gloss' }, trim: { color: 0xc9a24a, finish: 'gloss' }, canopy: { color: 0x2a3540 }, thruster: { color: 0xffb347 }, accent: { color: 0x8a5a2b, finish: 'gloss' } } },
  { id: 'dray_anthracite', ship: 'dray', name: 'Anthracite', paid: true, cost: 780, blurb: 'Graphite that eats the light, with an oxblood line. Nothing on this hull wants to be seen.', livery: { hull: { color: 0x1c1e22, finish: 'matt' }, trim: { color: 0x7a2a1a, finish: 'gloss' }, canopy: { color: 0x1b2530 }, thruster: { color: 0xff6a3a }, accent: { color: 0x3a4a5c, finish: 'matt' } } },
  { id: 'dray_meridian', ship: 'dray', name: 'Meridian', paid: true, cost: 840, blurb: 'Deep blue with an ivory boot line, the way the survey tenders were finished before the war.', livery: { hull: { color: 0x14315c, finish: 'gloss' }, trim: { color: 0xe6e6ea, finish: 'gloss' }, canopy: { color: 0x203a3a }, thruster: { color: 0xadefff }, accent: { color: 0xc9a24a, finish: 'gloss' } } },
  { id: 'pike_cinnabar', ship: 'pike', name: 'Cinnabar', paid: true, cost: 820, blurb: 'Lacquer red over black ordnance, and chrome on the shrouds. Flown by somebody who wanted to be found.', livery: { hull: { color: 0x8c1710, finish: 'gloss' }, trim: { color: 0x0d0f12, finish: 'gloss' }, canopy: { color: 0x24323f }, thruster: { color: 0xff2b2b }, accent: { color: 0xd9dde2, finish: 'gloss' } } },
  { id: 'pike_covert', ship: 'pike', name: 'Covert', paid: true, cost: 880, blurb: 'Dead green, dead grey, brass on the shrouds because brass does not flash. The opposite argument.', livery: { hull: { color: 0x1f3326, finish: 'matt' }, trim: { color: 0x2a2e33, finish: 'matt' }, canopy: { color: 0x203a3a }, thruster: { color: 0x3bffd2 }, accent: { color: 0xc9a24a, finish: 'gloss' } } },
  { id: 'pike_whitecap', ship: 'pike', name: 'Whitecap', paid: true, cost: 940, blurb: 'White to the waterline with a cobalt spine. The only Pike in the yard nobody has ever scratched.', livery: { hull: { color: 0xe6e9ee, finish: 'gloss' }, trim: { color: 0x1f6fd0, finish: 'gloss' }, canopy: { color: 0x1b2530 }, thruster: { color: 0x2fe0ff }, accent: { color: 0x3a4a5c, finish: 'gloss' } } },
]);

/** Fast lookup, the shape `MOUNT_SKINS_BY_ID` has. */
export const SHIP_SKINS_BY_ID = new Map(SHIP_SKINS.map((s) => [s.id, s]));

/**
 * Every ship-livery id a ledger is allowed to grant. Written next to the data
 * it guards, the way `Cosmetics.KNOWN_SKIN_IDS` is, and it is ALL EIGHTEEN
 * rather than only the paid nine.
 *
 * That is deliberate. The guard's job is to stop a typo in seed data from
 * poisoning the wardrobe, not to re-state the free/paid rule — that rule lives
 * in {@link isPaidShipSkin} and is enforced at the one place it matters, the
 * apply path. A row that tried to SELL a free scheme would resolve to
 * `shipskin_kestrel_courier`, and no such item is generated, so the item side
 * refuses it long before a ledger ever sees the id.
 */
export const KNOWN_SHIP_SKIN_IDS = new Set(SHIP_SKINS.map((s) => s.id));

/** Liveries for one hull, in catalogue order: the free ones first, then the paid. */
export function shipSkinsFor(shipId) {
  return SHIP_SKINS.filter((s) => s.ship === shipId);
}

/**
 * True for a livery that has to be bought before it can be worn.
 *
 * Takes a row OR an id, because the two callers genuinely have different
 * things in hand: the panel is iterating rows and `ItemUse` has parsed an id
 * off a bag item. A single predicate means there is one answer to "is this one
 * paid for", which is the question every guard in the apply path turns on.
 *
 * Reads `paid === true` and not `!!cost`, so a free scheme that one day grows
 * a display price does not silently become a purchase.
 *
 * @param {{paid?:boolean}|string|null|undefined} skinOrId
 * @returns {boolean}
 */
export function isPaidShipSkin(skinOrId) {
  const row = typeof skinOrId === 'string' ? SHIP_SKINS_BY_ID.get(skinOrId) : skinOrId;
  return row?.paid === true;
}

/** The paid liveries, in catalogue order. The set the shop and `ItemDefs` build from. */
export const PAID_SHIP_SKINS = Object.freeze(SHIP_SKINS.filter(isPaidShipSkin));

/** The bag-item id a purchasable ship livery carries. Stable since day one. */
export function shipSkinItemId(skinId) {
  return `shipskin_${skinId}`;
}

/**
 * The livery id a `shipskin_*` bag-item id stands for, or null.
 *
 * The inverse of {@link shipSkinItemId}, and it VALIDATES rather than merely
 * stripping the prefix: an id that survives the strip but names nothing in
 * {@link PAID_SHIP_SKINS} comes back null. That is what stops a stale save, a
 * renamed livery or a hand-typed cheat from handing `applyScheme` an id it
 * would refuse only after the bag had been charged for it.
 *
 * @param {unknown} itemId
 * @returns {string|null}
 */
export function shipSkinIdFromItem(itemId) {
  if (typeof itemId !== 'string' || !itemId.startsWith('shipskin_')) return null;
  const id = itemId.slice('shipskin_'.length);
  return isPaidShipSkin(id) ? id : null;
}
