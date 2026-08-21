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

  /* ==================================================================== *
   * CINDER ORE - what a mining run is actually carrying
   * ====================================================================
   *
   * Six elements, and the value here is quoted PER CUBIC METRE OF HOLD, not
   * per node and not per "one of them". That unit is not a flourish: a mineral
   * node on a planet is priced by `PlanetDescriptor` as `unitValue * hold`,
   * where `hold` is the volume `Piloting.stow` charges the ship for it, so one
   * bag unit, one cubic metre of cargo and one row of this table are all the
   * same quantity of rock. The alternative - a per-node price here and a
   * volume over in the descriptor - is two numbers for one fact, and the
   * project already knows which of the two goes stale.
   *
   * ── Where the ladder came from ────────────────────────────────────────
   * Not guessed. `scripts/tests/planet-minerals.test.mjs` floods Cinder's real
   * colliders from each landing pad, walks a nearest-neighbour tour of every
   * deposit of one element at `CONFIG.player.walkSpeed`, adds `MINE_TIME` a
   * node, and reports credits per minute. These six numbers are what make that
   * rate climb with the walk rather than in spite of it: tephra is underfoot
   * and pays least per minute, rheniite is 900 m out along a lava channel and
   * pays most.
   *
   * ── `kind` ────────────────────────────────────────────────────────────
   * Five of the six are `trinket`, which is what an ore IS to a vendor:
   * something bought by weight with no use in the hand. `ferrobasalt` is
   * `consumable` and that is a deliberate, load-bearing exception - see its
   * own note.
   *
   * ── What is NOT here, and why ─────────────────────────────────────────
   * No `WORLD_MARKETS.*.itemBuy` rows for the five cargo ores. Mined ore never
   * touches the bag: `Mining.mine` hands the node to `Piloting.stow` and
   * `Piloting._dock` sells the whole hold at face value the moment you land at
   * the yard, so a regional multiplier on tephra would be a number no
   * transaction in the game reads. A price signal that no price path consults
   * is the `MARKETPLACE_CONSUMABLE_ITEMS` defect wearing different clothes.
   * `ferrobasalt` DOES have one, because `ferrobasalt` is the one ore that
   * reaches a bag.
   */
  tephra: {
    id: 'tephra',
    name: 'Tephra Nodules',
    short: 'TEF',
    stack: 20,
    icon: 'ore',
    value: 6,
    kind: 'trinket',
    colors: [0x6b5a4a, 0x3a2f26],
    desc: 'Welded ash lumps off the plain. Bulky, brittle and barely worth the hold space it eats — but it is lying at your feet the moment the ramp comes down.',
  },
  sulfur: {
    id: 'sulfur',
    name: 'Sulfur Crust',
    short: 'SUL',
    stack: 20,
    icon: 'ore',
    value: 16,
    kind: 'trinket',
    colors: [0xd9c341, 0x6b5c12],
    desc: 'Yellow crust broken off a fumarole lip. Smells of the rift for days afterwards and no amount of scrubbing the hold shifts it.',
  },
  obsidian: {
    id: 'obsidian',
    name: 'Obsidian Glass',
    short: 'OBS',
    stack: 12,
    icon: 'ore',
    value: 34,
    kind: 'trinket',
    colors: [0x241533, 0x0d0a10],
    desc: 'Volcanic glass off the shelf, chilled too fast to grow a crystal. Takes an edge sharper than any blade a foundry can draw.',
  },
  /* FERRO-BASALT, and the one place in this table where `kind` is a decision.
   *
   * It is magnetite-bearing basalt: a lodestone. Clipped to a belt it drags
   * loose pickups in for half a minute and then bleeds its field off, which is
   * exactly `loot_magnet_30s` and is why `ItemUse` routes it there rather than
   * inventing an effect for it.
   *
   * `consumable` and NOT `trinket`, and that is not flavour. `InventoryUI.js`
   * gates the Use button on `def.kind === 'consumable' || def.kind === 'skin'`
   * (InventoryUI.js:331). A `trinket` with a live `ItemUse` case is an effect
   * with no button — implemented, registered, and unreachable, which is this
   * project's signature defect one size smaller. The kind is what the UI reads,
   * so the kind is what has to be true.
   *
   * It is still ore. It still mines into the hold as `ferrobasalt`, it is still
   * priced per cubic metre, and selling the rock is still the obvious thing to
   * do with it — a Vacuum Rune costs 165 at a counter and two cubic metres of
   * ferro-basalt fetch 104, so using one is giving up most of a rune's worth
   * for a rune. That is the point: it is the one ore with a decision attached.
   */
  ferrobasalt: {
    id: 'ferrobasalt',
    name: 'Ferro-Basalt',
    short: 'FRB',
    stack: 4,
    icon: 'ore',
    value: 52,
    kind: 'consumable',
    colors: [0x4d5866, 0x232a33],
    desc: 'Magnetite-heavy basalt out of the colonnade. Sells by the cubic metre — or clip one on and it pulls loose salvage to you for thirty seconds before the field bleeds off.',
  },
  rheniite: {
    id: 'rheniite',
    name: 'Rheniite',
    short: 'RHN',
    stack: 6,
    icon: 'crystal',
    value: 190,
    kind: 'trinket',
    colors: [0xb9a888, 0x4a3a20],
    desc: 'Rhenium disulfide, grown in flakes on the lip of a nine-hundred-degree vent and nowhere else. It condenses out of the gas; you cannot dig for it, you can only go where the gas goes.',
  },
  iridite: {
    id: 'iridite',
    name: 'Iridite',
    short: 'IRD',
    stack: 4,
    icon: 'crystal',
    value: 310,
    kind: 'trinket',
    colors: [0xff8a3a, 0x7a2408],
    desc: 'Iridium locked in impact melt, still warm from the floor of the Ash Throne. One cubic metre of it outbids a full Kestrel of ash.',
  },


  /* ==================================================================== *
   * PHASE 2 ORE - nine more planets, and the ladder that spans them
   * ====================================================================
   *
   * Same unit as the Cinder block above: `value` is CREDITS PER CUBIC METRE
   * OF HOLD. A node is priced by `PlanetDescriptor` as `unitValue * hold`,
   * and `hold` is the volume `Piloting.stow` charges for it, so one row here,
   * one cubic metre of cargo and one bag unit are all the same quantity.
   *
   * ── The one rule that spans planets ───────────────────────────────────
   * VALUE CLIMBS WITH THE LEG. An ore is a reason to fly somewhere; if the
   * ore 288 km out is worth what the ore 62 km out is worth, then the far
   * planets are scenery with a mining prompt on them. So the bands are
   * ordered by distance from the yard, and the four-rung ladder inside each
   * planet (which `definePlanet` enforces) does the local work:
   *
   *     planet      km    common      uncommon    rare    exotic
   *     Cinder      62    6, 16       34, 52      190     310   (above)
   *     Tessera     88    7           22          140     240
   *     Sirocco    118    8, 14       30, 46      175     285
   *     Shoal      142    10          36          200     340
   *     Vitrine    155    12, 20      44          215     380
   *     Verdigris  176    14          48, 62      240     430
   *     Carnelian  205    15          52          260     470
   *     Sallow     232    17          58, 74      290     520
   *     Cathedra   288    20          78          320     620
   *     Lathe      ~250   22          88          360     700
   *
   * Lathe is out of order on distance and dearest on value ON PURPOSE. It is
   * a shepherd moon parked outside Ceraunus's outer ring edge, so reaching it
   * means crossing a ring plane - the hardest arrival in the system, and the
   * reward has to say so.
   *
   * ── `stack` and `icon` are DERIVED, not chosen ────────────────────────
   * `stack` steps 20 / 12 / 6 / 4 at 25, 100 and 300 cr/m3, and `icon` turns
   * over from `ore` to `crystal` at 100. Forty-one hand-picked pairs would be
   * forty-one chances to make the dear ore the plentiful one by accident.
   *
   * ── Every one of these is `trinket`, and that is load-bearing ─────────
   * A cargo ore never reaches the bag: `Mining.mine` hands the node to
   * `Piloting.stow` and `Piloting._dock` sells the hold at face value. So a
   * cargo ore must have NO `ItemUse` case (a `consumable` with no case is a
   * Use button that returns `unsupported`), NO `BASE_ITEMS` row (the shop
   * would refund the mine) and NO `WORLD_MARKETS.*.itemBuy` multiplier (a
   * price signal no price path consults). `planet-minerals.test.mjs` asserts
   * all three, in both directions. `ferrobasalt` is the single deliberate
   * exception and it stays the only one.
   */
  /* ---- Tessera ---- */
  regolith: {
    id: 'regolith',
    name: 'Regolith Fines',
    short: 'REG',
    stack: 20,
    icon: 'ore',
    value: 7,
    kind: 'trinket',
    colors: [0x8a8781, 0x45433f],
    desc: "Powdered rock, ground for four billion years by nothing but micrometeorites. It packs like flour and it gets into everything, including the seals.",
  },
  anorthite: {
    id: 'anorthite',
    name: 'Anorthite',
    short: 'ANO',
    stack: 20,
    icon: 'ore',
    value: 22,
    kind: 'trinket',
    colors: [0xd8d4c6, 0x77736a],
    desc: "Pale highland feldspar off a crater rim. Cheap, clean and light — the one thing on Tessera that does not stain the gloves.",
  },
  sperrylite: {
    id: 'sperrylite',
    name: 'Sperrylite',
    short: 'SPR',
    stack: 6,
    icon: 'crystal',
    value: 140,
    kind: 'trinket',
    colors: [0xb6bcc4, 0x4b525c],
    desc: "Platinum arsenide in tin-bright cubes, shocked out of the bedrock by whatever dug the crater. A find, not a seam.",
  },
  helion: {
    id: 'helion',
    name: 'Helion Ice',
    short: 'HEL',
    stack: 6,
    icon: 'crystal',
    value: 240,
    kind: 'trinket',
    colors: [0xcfe8f2, 0x4a7f96],
    desc: "Helium-3 held in ice on a crater floor the sun has not touched since the crater was made. Carry it warm and you carry an empty flask.",
  },
  /* ---- Sirocco ---- */
  silica: {
    id: 'silica',
    name: 'Silica Sand',
    short: 'SIL',
    stack: 20,
    icon: 'ore',
    value: 8,
    kind: 'trinket',
    colors: [0xe2c78e, 0x8a7040],
    desc: "Wind-rounded quartz off the dune sea. Worth almost nothing and there is almost no end of it, which is the entire relationship.",
  },
  halite: {
    id: 'halite',
    name: 'Halite Slab',
    short: 'HAL',
    stack: 20,
    icon: 'ore',
    value: 14,
    kind: 'trinket',
    colors: [0xf0e6dc, 0x9a8c80],
    desc: "Rock salt cut out of a dry pan in plates the size of a door. It rings when you strike it and it dissolves if you are careless with the hold.",
  },
  selenite: {
    id: 'selenite',
    name: 'Selenite Rose',
    short: 'SEL',
    stack: 12,
    icon: 'ore',
    value: 30,
    kind: 'trinket',
    colors: [0xe8d8b0, 0x8d7a52],
    desc: "Gypsum grown into a bladed rosette under a salt crust. Beautiful, fragile, and it arrives at the yard as gravel if you fly badly.",
  },
  cassiterite: {
    id: 'cassiterite',
    name: 'Cassiterite',
    short: 'CAS',
    stack: 12,
    icon: 'ore',
    value: 46,
    kind: 'trinket',
    colors: [0x6b5a48, 0x2e2620],
    desc: "Tin oxide, panned out of a wadi floor by ten thousand years of flash floods that each lasted an hour.",
  },
  chalcanth: {
    id: 'chalcanth',
    name: 'Chalcanthite',
    short: 'CHA',
    stack: 6,
    icon: 'crystal',
    value: 175,
    kind: 'trinket',
    colors: [0x2f7ec4, 0x11395e],
    desc: "Copper sulfate in vivid blue blades, grown where a seep bleeds out of a canyon wall. It only forms where water has been, which on Sirocco is almost nowhere.",
  },
  fulgurite: {
    id: 'fulgurite',
    name: 'Fulgurite',
    short: 'FUL',
    stack: 6,
    icon: 'crystal',
    value: 285,
    kind: 'trinket',
    colors: [0x9c8a6e, 0xd8c9a0],
    desc: "A hollow glass tube of fused sand — the cast of a lightning strike, taken from the dune it died in. Every one is the shape of one instant.",
  },
  /* ---- Shoal ---- */
  brinesalt: {
    id: 'brinesalt',
    name: 'Brine Salt',
    short: 'BRN',
    stack: 20,
    icon: 'ore',
    value: 10,
    kind: 'trinket',
    colors: [0xe6eef0, 0x8fa2a8],
    desc: "Evaporite scraped off a tidal flat between islands. Coarse, grey and heavy with whatever else the sea left behind.",
  },
  nacre: {
    id: 'nacre',
    name: 'Nacre Plate',
    short: 'NAC',
    stack: 12,
    icon: 'ore',
    value: 36,
    kind: 'trinket',
    colors: [0xe8e4f0, 0x9c8fb8],
    desc: "Iridescent shell laid down in sheets on the shallow shelf by something that has been dead a long time. It throws a different colour at every angle.",
  },
  polymetal: {
    id: 'polymetal',
    name: 'Polymetallic Nodule',
    short: 'PLY',
    stack: 6,
    icon: 'crystal',
    value: 200,
    kind: 'trinket',
    colors: [0x3b3630, 0x16130f],
    desc: "A black potato of manganese, cobalt and nickel, grown one atom a century on the shelf floor. Nothing about it is quick.",
  },
  abyssite: {
    id: 'abyssite',
    name: 'Abyssite',
    short: 'ABY',
    stack: 4,
    icon: 'crystal',
    value: 340,
    kind: 'trinket',
    colors: [0x1a3a52, 0x63c8d8],
    desc: "Hydrothermal precipitate off the wall of the tidal chasm, still faintly warm and faintly luminous. Cut only where the sea is deepest and the ledge narrowest.",
  },
  /* ---- Vitrine ---- */
  rime: {
    id: 'rime',
    name: 'Rime Crust',
    short: 'RIM',
    stack: 20,
    icon: 'ore',
    value: 12,
    kind: 'trinket',
    colors: [0xdff0f7, 0x8fb2c4],
    desc: "Frost feathers scraped off the windward side of anything that stands up. Free, plentiful and it sublimes if the hold runs warm.",
  },
  clathrate: {
    id: 'clathrate',
    name: 'Clathrate Ice',
    short: 'CLA',
    stack: 20,
    icon: 'ore',
    value: 20,
    kind: 'trinket',
    colors: [0xbcdcec, 0x5d8aa4],
    desc: "Methane caged inside a lattice of water ice. It fizzes when it thaws and it burns while it melts, which never stops being unsettling.",
  },
  cryolite: {
    id: 'cryolite',
    name: 'Cryolite',
    short: 'CRY',
    stack: 12,
    icon: 'ore',
    value: 44,
    kind: 'trinket',
    colors: [0xeaf2f6, 0xa8bcc8],
    desc: "Sodium aluminium fluoride in colourless blocks that all but vanish in meltwater. Miners on Vitrine mark every load with dye for exactly that reason.",
  },
  azurine: {
    id: 'azurine',
    name: 'Azurine',
    short: 'AZR',
    stack: 6,
    icon: 'crystal',
    value: 215,
    kind: 'trinket',
    colors: [0x2f6fd0, 0x0e2a5e],
    desc: "Deep blue mineral ice out of a crevasse wall, laid down under a pressure nothing at the surface can reproduce. It fractures along planes you cannot see until it does.",
  },
  hyaline: {
    id: 'hyaline',
    name: 'Hyaline',
    short: 'HYA',
    stack: 4,
    icon: 'crystal',
    value: 380,
    kind: 'trinket',
    colors: [0xd6f4ff, 0x5fc8e8],
    desc: "Clear glacial glass from the roof of a subglacial vault, grown in still water in the dark. A flawless piece the size of a fist funds a month.",
  },
  /* ---- Verdigris ---- */
  humic: {
    id: 'humic',
    name: 'Humic Nodule',
    short: 'HUM',
    stack: 20,
    icon: 'ore',
    value: 14,
    kind: 'trinket',
    colors: [0x4a3f28, 0x231c11],
    desc: "Compressed forest floor, wrung into a lump by its own weight. It smells alive and it stains the hold a colour that never comes out.",
  },
  malachite: {
    id: 'malachite',
    name: 'Malachite',
    short: 'MAL',
    stack: 12,
    icon: 'ore',
    value: 48,
    kind: 'trinket',
    colors: [0x2f8a56, 0x14472b],
    desc: "Banded green copper carbonate out of a river gorge. The bands are growth rings of a sort, and the wide ones were wet centuries.",
  },
  resin: {
    id: 'resin',
    name: 'Amber Resin',
    short: 'RSN',
    stack: 12,
    icon: 'ore',
    value: 62,
    kind: 'trinket',
    colors: [0xd08a24, 0x6b3f08],
    desc: "Hardened sap in fist-sized gouts down a trunk. Warm to hold, light in the hand, and every third piece has something in it.",
  },
  sporecryst: {
    id: 'sporecryst',
    name: 'Spore Crystal',
    short: 'SPO',
    stack: 6,
    icon: 'crystal',
    value: 240,
    kind: 'trinket',
    colors: [0x7ad8a0, 0x1e5c3c],
    desc: "A mineral seeded and grown by something in the cave dark, faceted the way a crystal is and branched the way a fungus is. Nobody has settled which it is.",
  },
  verdite: {
    id: 'verdite',
    name: 'Verdite Heartwood',
    short: 'VRD',
    stack: 4,
    icon: 'crystal',
    value: 430,
    kind: 'trinket',
    colors: [0x1f6b4a, 0x86e8b0],
    desc: "Wood from the crown of a canopy mesa, mineralised in place and still standing. Cutting one is a day up and a day down, and there are not many left.",
  },
  /* ---- Carnelian ---- */
  ochre: {
    id: 'ochre',
    name: 'Ochre Earth',
    short: 'OCH',
    stack: 20,
    icon: 'ore',
    value: 15,
    kind: 'trinket',
    colors: [0xb85c28, 0x5e2b10],
    desc: "Iron-stained dust, red as a wound and fine as smoke. It is the whole surface of the planet and it is worth what that implies.",
  },
  hematite: {
    id: 'hematite',
    name: 'Hematite',
    short: 'HEM',
    stack: 12,
    icon: 'ore',
    value: 52,
    kind: 'trinket',
    colors: [0x6e4038, 0x2b1a16],
    desc: "Specular iron oxide in mirror-bright plates. Held to the light it is silver; held to the ground it is the same red as everything else.",
  },
  carnelite: {
    id: 'carnelite',
    name: 'Carnelite',
    short: 'CRN',
    stack: 6,
    icon: 'crystal',
    value: 260,
    kind: 'trinket',
    colors: [0xd4552a, 0x6e1c08],
    desc: "Banded orange chalcedony out of a gorge wall, lit from inside when the sun is low. The planet is named for it, not the other way round.",
  },
  monazite: {
    id: 'monazite',
    name: 'Monazite',
    short: 'MNZ',
    stack: 4,
    icon: 'crystal',
    value: 470,
    kind: 'trinket',
    colors: [0xc8a24a, 0x584010],
    desc: "Rare-earth phosphate off the floor of the deep gorge, faintly and permanently warm. Handled with tongs by anyone who intends to keep handling things.",
  },
  /* ---- Sallow ---- */
  brimstone: {
    id: 'brimstone',
    name: 'Brimstone',
    short: 'BRM',
    stack: 20,
    icon: 'ore',
    value: 17,
    kind: 'trinket',
    colors: [0xe0cc38, 0x6e6010],
    desc: "Native sulfur crusted round a vent in yellow cauliflower heads. It is everywhere on Sallow, and so is the smell of it.",
  },
  realgar: {
    id: 'realgar',
    name: 'Realgar',
    short: 'RLG',
    stack: 12,
    icon: 'ore',
    value: 58,
    kind: 'trinket',
    colors: [0xd4482c, 0x66180c],
    desc: "Arsenic sulfide in orange-red prisms. It turns to yellow powder in daylight over months, which is why the good pieces come out of shadow.",
  },
  orpiment: {
    id: 'orpiment',
    name: 'Orpiment',
    short: 'ORP',
    stack: 12,
    icon: 'ore',
    value: 74,
    kind: 'trinket',
    colors: [0xe8b820, 0x6e5208],
    desc: "Golden arsenic sulfide in sheaves that split like mica. Painters wanted it for two thousand years and it killed a good number of them.",
  },
  cinnabar: {
    id: 'cinnabar',
    name: 'Cinnabar',
    short: 'CIN',
    stack: 6,
    icon: 'crystal',
    value: 290,
    kind: 'trinket',
    colors: [0xc41c1c, 0x520606],
    desc: "Mercury sulfide, the most violent red there is. It beads liquid metal if you are careless with heat, and Sallow is not short of heat.",
  },
  stibnite: {
    id: 'stibnite',
    name: 'Stibnite',
    short: 'STB',
    stack: 4,
    icon: 'crystal',
    value: 520,
    kind: 'trinket',
    colors: [0xa8b0bc, 0x3a4048],
    desc: "Antimony sulfide in steel-grey needle sprays out of a fumarole throat. A good cluster is a metre of parallel blades and worth a hull plate a blade.",
  },
  /* ---- Cathedra ---- */
  quartzite: {
    id: 'quartzite',
    name: 'Quartzite',
    short: 'QTZ',
    stack: 20,
    icon: 'ore',
    value: 20,
    kind: 'trinket',
    colors: [0xd8d2c8, 0x87817a],
    desc: "Fractured white rock off a shattered plate. Hard, dull and abundant — the gravel the cathedral is built of.",
  },
  beryl: {
    id: 'beryl',
    name: 'Beryl',
    short: 'BER',
    stack: 12,
    icon: 'ore',
    value: 78,
    kind: 'trinket',
    colors: [0x63c8b0, 0x1e5a4e],
    desc: "Pale green hexagonal prisms grown in the seams between plates. Common enough here that nobody looks up when one comes in.",
  },
  spectrolite: {
    id: 'spectrolite',
    name: 'Spectrolite',
    short: 'SPC',
    stack: 4,
    icon: 'crystal',
    value: 320,
    kind: 'trinket',
    colors: [0x2a4a8c, 0x8ad4ff],
    desc: "Feldspar that throws a sheet of colour across the whole face when the light crosses it, and is grey stone from any other angle.",
  },
  lucent: {
    id: 'lucent',
    name: 'Lucent',
    short: 'LUC',
    stack: 4,
    icon: 'crystal',
    value: 620,
    kind: 'trinket',
    colors: [0xeef8ff, 0xa0d8ff],
    desc: "Grown in the vault where nothing has moved for an age, and it holds light — set one down in the dark and come back an hour later and it is still glowing.",
  },
  /* ---- Lathe ---- */
  rimefall: {
    id: 'rimefall',
    name: 'Rimefall Ice',
    short: 'RMF',
    stack: 20,
    icon: 'ore',
    value: 22,
    kind: 'trinket',
    colors: [0xe4f0f8, 0x93a8ba],
    desc: "Ring ice swept up by the moon it shepherds and dropped in drifts on the leading face. It falls slowly enough to watch.",
  },
  sider: {
    id: 'sider',
    name: 'Siderite Iron',
    short: 'SDR',
    stack: 12,
    icon: 'ore',
    value: 88,
    kind: 'trinket',
    colors: [0x7a7268, 0x2e2a26],
    desc: "Meteoric nickel-iron, etched inside with a crystal pattern that takes a million years of cooling to grow and cannot be faked.",
  },
  tychite: {
    id: 'tychite',
    name: 'Tychite',
    short: 'TYC',
    stack: 4,
    icon: 'crystal',
    value: 360,
    kind: 'trinket',
    colors: [0xa8e0d0, 0x2e6a5e],
    desc: "A carbonate that only grows where ring ice lands, melts under the pressure of its own arrival and freezes again. Lathe is the only address it has.",
  },
  aurichalc: {
    id: 'aurichalc',
    name: 'Aurichalc',
    short: 'AUR',
    stack: 4,
    icon: 'crystal',
    value: 700,
    kind: 'trinket',
    colors: [0xf0c040, 0x8a5c08],
    desc: "A gold-copper alloy nobody can account for, cut from the floor of the shepherd crater under a sky filled edge to edge with rings. The dearest cubic metre in the system, and the furthest.",
  },

  /* ---- Lodestar Yard ------------------------------------------------
   *
   * Three items, and every one of them is in a table something already rolls.
   * The rule this file learned the hard way is that an item declared here and
   * present in no drop, cache or stash table anywhere is unobtainable by
   * collecting IN EVERY WORLD, and `quest-content.test.mjs` will say so - so
   * `laser_cell`, `hull_plate` and `thruster_coil` are all in `DROP_TABLES`
   * and/or `CACHE_TABLES` for `dock`, and `hull_plate` and `thruster_coil`
   * are what `SUPPLY_WANTS.dock` asks for.
   *
   * `laser_cell` IS THE ODD ONE, AND THE OLD NOTE HERE PROMISED SOMETHING
   * THAT DID NOT HAPPEN. It said "the flight drop turns it into ammunition".
   * The flight drop shipped and it did not: `SpaceCombat` contains no
   * reference to ammo, inventory or `laser_cell` at all - the ship gun runs
   * off a self-recharging capacitor (`GUN.capacity` / `GUN.regen`), which is
   * a deliberate design and a good one, because a dry gun 60 km from the yard
   * is a walk home.
   *
   * That left an item described as "charged capacitor cells for a ship-mounted
   * laser" which no ship-mounted laser consumes, handed out 20 and 40 at a
   * time by the first two rungs of the KILL ladder - the two rungs most
   * players reach - as if it were combat resupply. A reward that reads as
   * ammunition for the gun you just used and is not is worse than no reward.
   *
   * Its real sinks, both of which are live: the Test-Fire Butts burn eight a
   * plate (`minigames/TestFire.js`), and the Fitter buys them at 0.75. The
   * description below says so. The stack stays 240 because a rack is 40 and
   * six racks to a slot is the same "one pack is one slot" rule the 60-round
   * rifle pack is sized by. */
  laser_cell: {
    id: 'laser_cell',
    name: 'Laser Cells',
    short: 'CEL',
    stack: 240,
    icon: 'cell',
    value: 4,
    kind: 'ammo',
    desc: 'Charged capacitor cells, cut and wound in this yard. Ship guns run off their own capacitors — these are for the Test-Fire Butts, and the Fitter buys them by the rack.',
  },
  hull_plate: {
    id: 'hull_plate',
    name: 'Hull Plate',
    short: 'PLT',
    stack: 20,
    icon: 'plate',
    value: 34,
    kind: 'trinket',
    desc: 'A cut and drilled section plate, stamped with its frame number. The yard makes these by the ton and still counts every one.',
  },
  thruster_coil: {
    id: 'thruster_coil',
    name: 'Thruster Coil',
    short: 'COL',
    stack: 10,
    icon: 'coil',
    value: 78,
    kind: 'trinket',
    desc: 'A wound field coil out of a courier drive. Worth more in a fitting shop than anywhere else in the Nexus.',
  },

  /* ---- The chart ----------------------------------------------------
   *
   * The fourth yard item, and the one that had to earn its place TWICE.
   *
   * It is the flight drop's planet seed, which is a reason to author it and
   * NOT a reason to sell it now: a buyable whose entire effect is in a drop
   * that does not exist is indistinguishable from a buyable that does
   * nothing, and that is the recorded `Dragon.js:2499` complaint one level
   * worse - there the tier at least banked. So it ships with a real effect
   * TODAY, and the effect is the one thing a chart honestly does: it puts a
   * vantage point on your map without your having to stand on it.
   *
   * `ItemUse` routes it to `Viewpoints.chartNearest()`, which reveals the
   * nearest UNSYNCHRONISED viewpoint's `REVEAL_R = 70` m district on the
   * minimap and pays nothing else. Reading a chart is not standing on the
   * crane cab: no `SYNC_CREDITS`, no coin, no fast-travel anchor, and the
   * viewpoint stays unsynchronised so the climb is still worth making.
   *
   * `consumable`, so `WORLD_MARKETS.dock.sell.consumable = 1.1` prices it -
   * the yard charges over the odds for a chart, which is right: it is the one
   * thing here nobody in the yard makes. */
  nav_chart: {
    id: 'nav_chart',
    name: 'Navigation Chart',
    short: 'CHT',
    stack: 5,
    icon: 'chart',
    value: 90,
    kind: 'consumable',
    desc: 'A rolled survey chart of one district, drawn from a height somebody else climbed to. Reading it marks that ground on your map; it does not put you on it.',
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

/** Bag-item `short` prefix per mount, so dropped skin pickups are distinguishable. */
export const MOUNT_ABBR = { car: 'CAR', dragon: 'DRG', eagle: 'EGL', horse: 'HRS', hoverboard: 'HVR', bicycle: 'BKE' };

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
    // Falls back to the mount id itself for a mount that has not yet earned
    // an entry in the abbreviation table, so a new mount's skins still get a
    // legible bag-item prefix instead of `undefined SKN`.
    short: `${MOUNT_ABBR[skin.mount] ?? skin.mount.slice(0, 3).toUpperCase()} SKN`,
    stack: 1,
    icon: 'skin',
    value: 200,
    kind: 'skin',
    skinId: skin.id,
    colors,
    desc: `${skin.blurb} Apply to your ${skin.mount} from the Esc menu → Customise mount, while riding; one use.`,
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
  dock: {
    label: 'Lodestar Yard',
    /* The inverse of the citadel, and for the same kind of reason stated the
     * other way round. Sunspire is cut off on a mesa and everything
     * manufactured arrives by mule, so manufactured goods are dear there and
     * antiquity is not. The yard is the only place in the Nexus that MAKES
     * things and it has no relic culture at all: plate and coil are swept up
     * off the floor here, and a crown coin is a curiosity somebody carried
     * through a gateway.
     *
     * `WORLD_PRICE_MULTIPLIERS.dock` in site/lib/marketplaceCatalog.ts is a
     * SECOND, INDEPENDENT copy of the four kind multipliers below and nothing
     * in the codebase enforces the correspondence - so it is asserted in
     * scripts/tests/dock-registration.test.mjs instead. */
    buy: { trinket: 0.85, ammo: 0.9, consumable: 0.95 },
    sell: { ammo: 0.8, consumable: 1.1 },
    /* `ferrobasalt` is the one Cinder ore that ever reaches a bag (the other
     * five are hold cargo and `Piloting._dock` sells them at face value, so a
     * multiplier on them would be read by nothing). The yard is where Cinder
     * ore is refined and it is the only counter in the Nexus that knows what
     * a lodestone is worth. */
    itemBuy: { alloy_scrap: 0.6, hull_plate: 0.7, thruster_coil: 0.75, relic_coin: 1.7, nexus_shard: 1.6, ferrobasalt: 1.35 },
    itemSell: { pack_laser_cell: 0.75 },
    note: 'A yard makes hull plate and coil by the ton and cannot get a relic for love nor money.',
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
  /* ---- Lodestar Yard --------------------------------------------------
   *
   * `pack_laser_cell` is the id `WORLD_MARKETS.dock.itemSell` already names,
   * and it is spelled the same in `BASE_ITEMS` (site/lib/marketplaceCatalog.ts)
   * so ONE string identifies the rack everywhere: the regional multiplier, the
   * catalogue row the counter actually serves, and the `purchase` vocabulary
   * `scripts/quest-vocab.mjs` builds out of this array. A pack id present in
   * `itemSell` and absent from here is a price adjustment on nothing.
   *
   * 40 cells, not a full 240-cell stack: one rack is one purchase decision and
   * six of them fill a slot, which is the same "one pack is one slot" rule the
   * 60-round rifle pack is sized by, applied to an item whose stack is four
   * racks deep. */
  {
    id: 'pack_laser_cell',
    itemId: 'laser_cell',
    qty: 40,
    price: 160,
    name: 'Laser Cell Rack',
    blurb: '40 cells — a quarter of a slot',
  },
  {
    id: 'pack_nav_chart',
    itemId: 'nav_chart',
    qty: 1,
    price: 220,
    name: 'Navigation Chart',
    blurb: '1 district, drawn from a height',
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
  /* ---- Cinder ore ----------------------------------------------------
   *
   * Two renderers for six elements, tinted from the item's own `colors` the
   * way `skin` already is. Six hand-drawn rocks would be six things to keep in
   * step with a palette that lives in the planet descriptor; two silhouettes
   * carry the distinction that matters at 32 px, which is bulk against
   * crystal - a lump you shovel versus a flake you pick off a vent. */
  ore: (g, a, def) => {
    const [c1 = 0x6b5a4a, c2 = 0x2a2118] = def?.colors ?? [];
    const hex = (c) => `#${(c & 0xffffff).toString(16).padStart(6, '0')}`;
    return `
    <defs><linearGradient id="${g}a" x1="0.1" y1="1" x2="0.8" y2="0">
      <stop offset="0" stop-color="${hex(c2)}"/><stop offset="1" stop-color="${hex(c1)}"/>
    </linearGradient></defs>
    <path d="M7 21 L10 11 L18 7 L26 12 L25 22 L16 27 Z" fill="url(#${g}a)" stroke="${a}" stroke-width="0.9" stroke-linejoin="round"/>
    <path d="M10 11 L17 16 L26 12 M17 16 L16 27" fill="none" stroke="#000" stroke-width="0.8" opacity="0.45"/>
    <path d="M12 13 l3 -1.5" stroke="#fff" stroke-width="0.9" opacity="0.35" stroke-linecap="round"/>`;
  },
  crystal: (g, a, def) => {
    const [c1 = 0xff8a3a, c2 = 0x5a2008] = def?.colors ?? [];
    const hex = (c) => `#${(c & 0xffffff).toString(16).padStart(6, '0')}`;
    return `
    <defs><linearGradient id="${g}a" x1="0" y1="1" x2="0.7" y2="0">
      <stop offset="0" stop-color="${hex(c2)}"/><stop offset="1" stop-color="${hex(c1)}"/>
    </linearGradient>
    <radialGradient id="${g}b" cx="50%" cy="60%" r="55%">
      <stop offset="0" stop-color="${hex(c1)}" stop-opacity="0.55"/>
      <stop offset="1" stop-color="${hex(c1)}" stop-opacity="0"/>
    </radialGradient></defs>
    <circle cx="16" cy="18" r="13" fill="url(#${g}b)"/>
    <path d="M16 3 L23 15 L19 28 L13 28 L9 15 Z" fill="url(#${g}a)" stroke="${a}" stroke-width="0.9" stroke-linejoin="round"/>
    <path d="M16 3 L16 28 M9 15 L23 15" stroke="#fff" stroke-width="0.7" opacity="0.45"/>
    <path d="M11 22 l4 -9" stroke="#fff" stroke-width="0.9" opacity="0.5" stroke-linecap="round"/>`;
  },
  /* ---- Lodestar Yard ------------------------------------------------ */
  cell: (g, a) => `
    <defs><linearGradient id="${g}a" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0" stop-color="#123844"/><stop offset="1" stop-color="#7fe8ff"/>
    </linearGradient></defs>
    <rect x="10" y="7" width="12" height="18" rx="2" fill="url(#${g}a)" stroke="${a}" stroke-width="1"/>
    <rect x="13.5" y="4.5" width="5" height="3" rx="1" fill="${a}"/>
    <g stroke="#eafcff" stroke-width="1" opacity="0.9">
      <path d="M12.5 12 h7"/><path d="M12.5 16 h7"/><path d="M12.5 20 h7"/>
    </g>`,
  plate: (g, a) => `
    <defs><linearGradient id="${g}a" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4a5560"/><stop offset="1" stop-color="#b8c6d4"/>
    </linearGradient></defs>
    <path d="M6 11 L16 6 L26 11 L26 21 L16 26 L6 21 Z" fill="url(#${g}a)" stroke="${a}" stroke-width="1"/>
    <g fill="${a}" opacity="0.9">
      <circle cx="10" cy="13" r="1.2"/><circle cx="22" cy="13" r="1.2"/>
      <circle cx="10" cy="19" r="1.2"/><circle cx="22" cy="19" r="1.2"/>
    </g>
    <path d="M6 11 L16 16 L26 11" stroke="#dceaf5" stroke-width="0.8" fill="none" opacity="0.6"/>`,
  coil: (g, a) => `
    <defs><linearGradient id="${g}a" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#5a3a1c"/><stop offset="1" stop-color="#e8b06a"/>
    </linearGradient></defs>
    <g stroke="url(#${g}a)" stroke-width="2.4" fill="none" stroke-linecap="round">
      <path d="M9 10 h14"/><path d="M9 14 h14"/><path d="M9 18 h14"/><path d="M9 22 h14"/>
    </g>
    <g stroke="${a}" stroke-width="1.1" fill="none">
      <path d="M9 8 v16"/><path d="M23 8 v16"/>
    </g>`,
  chart: (g, a) => `
    <defs><linearGradient id="${g}a" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#243a44"/><stop offset="1" stop-color="#5f8b98"/>
    </linearGradient></defs>
    <path d="M6 8 q5 -2 10 0 q5 2 10 0 v16 q-5 2 -10 0 q-5 -2 -10 0 z"
          fill="url(#${g}a)" stroke="${a}" stroke-width="1"/>
    <path d="M16 8 v16" stroke="${a}" stroke-width="0.8" opacity="0.7"/>
    <g stroke="#cfeaf5" stroke-width="0.8" fill="none" opacity="0.75">
      <path d="M8 13 q4 -1.5 7 1"/><path d="M17 18 q4 -1.5 7 1"/>
    </g>
    <circle cx="21" cy="12" r="1.6" fill="none" stroke="${a}" stroke-width="1"/>
    <path d="M21 10.4 v3.2 M19.4 12 h3.2" stroke="${a}" stroke-width="0.8"/>`,
  unknown: (g, a) => `
    <rect x="6" y="6" width="20" height="20" rx="3" fill="rgba(120,180,210,0.12)" stroke="${a}" stroke-width="1"/>
    <path d="M16 20 v-2 q3 -1 3 -3.5 a3 3 0 1 0 -6 0" fill="none" stroke="${a}" stroke-width="1.5"/>
    <circle cx="16" cy="23.5" r="1.2" fill="${a}"/>`,
};
