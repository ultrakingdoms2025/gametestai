import { WORLD_MARKETS } from './ItemDefs.js';
import {
  SHIP_ORDER, SHIP_STATS, SHIP_POWER_TIERS, SHIP_STAT_META,
  shipPowerPrice, shipPowerSellPrice, shipPowerName,
} from '../ships/ShipStats.js';
import {
  WEAPON_ORDER, WEAPON_POWER_TIERS, WEAPON_TIER_STEP, WEAPON_LABEL,
  weaponPowerPrice, weaponPowerSellPrice, weaponPowerName,
} from './WeaponStats.js';

/**
 * THE SHOP THAT WORKS WITH THE SERVER DOWN.
 *
 * ===========================================================================
 *  THE DEFECT
 * ===========================================================================
 *
 * `Marketplace._loadCatalog` fetched `/api/marketplace/items` and, on failure,
 * set `_catalogError` and returned. There was no fallback of any kind. Driven
 * cold against a `vite`-only build - which is how this game is developed and
 * how the whole flight campaign was play-tested - pressing `B` at a vendor
 * opened **FITTING SHOP - LICENSED TRADE TERMINAL**, BUY tab, All categories,
 * and drew **NOT FOUND** in the same neutral style as an empty shop.
 *
 * So: every credit the player earns buys nothing. The kill ladder, the ore
 * ladder, the bounties and the survey prizes all pay into a currency with no
 * sink. And it takes the ship-stat upgrades down with it - `ShipMenuLogic`
 * tells the player "upgrade at the Fitting Shop" and the Fitting Shop is the
 * shop that says NOT FOUND.
 *
 * Lore already degrades to bundled defaults when its endpoint is down. The
 * shop did not degrade at all, which is the harder failure of the two to
 * notice, because an empty shop looks exactly like a shop with nothing in it.
 *
 * ===========================================================================
 *  WHY THIS IS A COPY, AND WHAT STOPS IT DRIFTING
 * ===========================================================================
 *
 * These rows are `BASE_ITEMS` from `site/lib/marketplaceCatalog.ts`, which is
 * server-side TypeScript the browser bundle cannot import. Two descriptions of
 * one catalogue is exactly the failure this project keeps writing down, so the
 * copy is not trusted to stay honest by being careful:
 *
 *   `scripts/tests/marketplace-offline.test.mjs` parses the TypeScript and
 *   asserts, row by row, that every field here matches - id, name, category,
 *   both prices, the pricing kind, the world allowlist and the whole
 *   `action_config`. A price edited on the server and not here is a red test,
 *   not a shop that quietly quotes last month's rate.
 *
 * The two GENERATED arrays in that file - `MOUNT_SKIN_ROWS` and the 60
 * `MOUNT_UPGRADE_ROWS` for the non-car mounts - are deliberately NOT copied.
 * They are a product of three tables and copying a product is how a copy rots.
 * Offline, a vendor stocks the 63 hand-authored rows, which includes every
 * yard row, all nine commissioned ship liveries, every consumable - the four
 * stamina draughts and three damage wards included - and all three bag
 * expansion rigs; the mount upgrade wall is the one thing that needs the API
 * up. `offlineCatalog` says so in its return value.
 *
 * ── WHY THE LIVERIES ARE HAND-AUTHORED AND THE MOUNT SKINS ARE NOT ────────
 * They are the same kind of row and they were built the other way round on
 * purpose. A mount skin is seeded into all six worlds, so a player with the
 * API down still has a shop full of other things; losing that wall costs them
 * a side dish. A ship livery is sold at ONE counter in ONE world - the Fitting
 * Shop that greeted this file's author with NOT FOUND - so leaving it out of
 * the bundle would have meant "unavailable offline" AND "unavailable at the
 * only place it exists". Nine literal rows, compared field by field against
 * the TypeScript by marketplace-offline.test.mjs, is the cheaper of the two
 * costs.
 *
 * ===========================================================================
 *  PRICING
 * ===========================================================================
 *
 * The server applies `WORLD_PRICE_MULTIPLIERS` per world at seed time, and
 * that table is required to match `WORLD_MARKETS` in `ItemDefs.js` exactly -
 * the TypeScript says so in a comment over `WORLD_PRICE_MULTIPLIERS.dock`. So
 * the offline builder applies the multipliers out of `WORLD_MARKETS`, which is
 * the game's own copy, rather than carrying a third one. Same arithmetic,
 * same rounding, same `Math.max(1, ...)` floor as `buildMarketplaceSeedItems`.
 */

/** One row per hand-authored `BASE_ITEMS` entry. Order is `sort_order`. */
export const OFFLINE_BASE_ITEMS = Object.freeze([
  {
    source_key: 'pack_bullets',
    name: 'Rifle Round Pack',
    description: '60 rifle rounds in one bag slot.',
    category: 'weapons',
    game_action: 'ammo_pack_rifle',
    action_config: { effect: 'grant_ammo', ammo_item: 'bullet', amount: 60 },
    quantity: null,
    cost_buy: 150,
    cost_sell: 72,
    pricing_kind: 'ammo',
    sort_order: 10,
    worlds: null,
  },
  {
    source_key: 'pack_arrows',
    name: 'Arrow Bundle',
    description: '30 broadhead arrows in one bag slot.',
    category: 'weapons',
    game_action: 'ammo_pack_arrow',
    action_config: { effect: 'grant_ammo', ammo_item: 'arrow', amount: 30 },
    quantity: null,
    cost_buy: 130,
    cost_sell: 60,
    pricing_kind: 'ammo',
    sort_order: 20,
    worlds: null,
  },
  {
    source_key: 'pack_embers',
    name: 'Ember Core Cell',
    description: '10 fireball charges in a sealed battery pack.',
    category: 'spells',
    game_action: 'ammo_pack_ember',
    action_config: { effect: 'grant_ammo', ammo_item: 'fireball_charge', amount: 10 },
    quantity: null,
    cost_buy: 170,
    cost_sell: 60,
    pricing_kind: 'ammo',
    sort_order: 30,
    worlds: null,
  },
  {
    source_key: 'pack_medkit',
    name: 'Trauma Twin-Pack',
    description: 'Two field medkits in one bag slot.',
    category: 'health',
    game_action: 'heal_50',
    action_config: { effect: 'restore_health', amount: 50 },
    quantity: null,
    cost_buy: 95,
    cost_sell: 36,
    pricing_kind: 'consumable',
    sort_order: 40,
    worlds: null,
  },
  {
    source_key: 'pack_laser_cell',
    name: 'Laser Cell Rack',
    description: '40 charged capacitor cells, racked. Ship ordnance, cut and wound in this yard.',
    category: 'weapons',
    game_action: 'ammo_pack_laser',
    action_config: { effect: 'grant_ammo', ammo_item: 'laser_cell', amount: 40 },
    quantity: null,
    cost_buy: 160,
    cost_sell: 64,
    pricing_kind: 'ammo',
    sort_order: 50,
    worlds: ['dock'],
  },
  {
    source_key: 'part_shield_cell',
    name: 'Shield Recharge Cell',
    description: 'A sealed capacitor bank wound for a deflector coil rather than a gun. Dumped into a flying ship it refills the absorption pool and unsticks the regulator a hit locks out.',
    category: 'ships',
    game_action: 'shield_cell',
    action_config: { effect: 'grant_item', item_id: 'shield_cell', amount: 1 },
    quantity: null,
    cost_buy: 240,
    cost_sell: 105,
    pricing_kind: 'consumable',
    sort_order: 51,
    worlds: ['dock'],
  },
  {
    source_key: 'part_hull_plate',
    name: 'Hull Plate',
    description: 'One cut and drilled section plate, stamped with its frame number. The unit the yard counts in.',
    category: 'ships',
    game_action: 'ship_part',
    action_config: { effect: 'grant_item', item_id: 'hull_plate', amount: 1 },
    quantity: null,
    cost_buy: 85,
    cost_sell: 34,
    pricing_kind: 'fixed',
    sort_order: 52,
    worlds: ['dock'],
  },
  {
    source_key: 'part_thruster_coil',
    name: 'Thruster Coil',
    description: 'A wound field coil out of a courier drive. The one fitting-out part nobody in this yard leaves lying about.',
    category: 'ships',
    game_action: 'ship_part',
    action_config: { effect: 'grant_item', item_id: 'thruster_coil', amount: 1 },
    quantity: null,
    cost_buy: 195,
    cost_sell: 78,
    pricing_kind: 'fixed',
    sort_order: 54,
    worlds: ['dock'],
  },
  {
    source_key: 'pack_nav_chart',
    name: 'Navigation Chart',
    description: 'A rolled survey chart of one district, drawn from a height somebody else climbed to. Marks that ground on your map; it does not put you on it.',
    category: 'tools',
    game_action: 'nav_chart',
    action_config: { effect: 'grant_item', item_id: 'nav_chart', amount: 1 },
    quantity: null,
    cost_buy: 220,
    cost_sell: 88,
    pricing_kind: 'consumable',
    sort_order: 56,
    worlds: ['citadel', 'dock'],
  },
  {
    source_key: 'ore_lodestone',
    name: 'Ferro-Basalt Lodestone',
    description: 'A belt-clipped slab of magnetite basalt off Cinder, trimmed and cased in the yard. Pulls loose salvage to you for twenty seconds, then the field bleeds off.',
    category: 'tools',
    game_action: 'refined_ore',
    action_config: { effect: 'grant_item', item_id: 'ferrobasalt', amount: 1 },
    quantity: null,
    cost_buy: 175,
    cost_sell: 70,
    pricing_kind: 'fixed',
    sort_order: 58,
    worlds: ['dock'],
  },
  /* ---- Commissioned ship liveries, all nine, bundled ------------------
   *
   * Hand-authored in `BASE_ITEMS` rather than generated the way
   * `MOUNT_SKIN_ROWS` is, and mirrored here, and the two facts are the same
   * decision. The generated mount-skin wall is deliberately NOT bundled (see
   * the header: copying a product of three tables is how a copy rots), and
   * the price of that is that mount skins cannot be bought with the API down.
   * Mount skins are seeded into all six worlds and are a side dish.
   *
   * A ship livery is sold at ONE counter in ONE world - the same Fitting Shop
   * that greeted this file's author with NOT FOUND - so "unavailable offline"
   * would have meant unavailable at the only place it exists. Nine literal
   * rows, checked field by field against the TypeScript by
   * marketplace-offline.test.mjs, is the cheaper of the two costs.
   */
  {
    source_key: 'shipskin_kestrel_kingfisher',
    name: 'Kingfisher Livery',
    description: 'Kestrel livery. Enamel blue over a white belly, copper shells. Ordered by a courier who was never once late. Goes on from Esc → Customise ship, in the yard; one use, then yours for good.',
    category: 'ships',
    game_action: 'ship_livery',
    action_config: { effect: 'grant_item', item_id: 'shipskin_kestrel_kingfisher' },
    quantity: null,
    cost_buy: 640,
    cost_sell: 256,
    pricing_kind: 'fixed',
    sort_order: 60,
    worlds: ['dock'],
  },
  {
    source_key: 'shipskin_kestrel_blackline',
    name: 'Blackline Livery',
    description: 'Kestrel livery. Six coats of black, flatted between each one, and a silver hairline laid by hand. Goes on from Esc → Customise ship, in the yard; one use, then yours for good.',
    category: 'ships',
    game_action: 'ship_livery',
    action_config: { effect: 'grant_item', item_id: 'shipskin_kestrel_blackline' },
    quantity: null,
    cost_buy: 700,
    cost_sell: 280,
    pricing_kind: 'fixed',
    sort_order: 61,
    worlds: ['dock'],
  },
  {
    source_key: 'shipskin_kestrel_solstice',
    name: 'Solstice Livery',
    description: 'Kestrel livery. Bone white and old gold, off a hull that flew the long side of the ring in daylight. Goes on from Esc → Customise ship, in the yard; one use, then yours for good.',
    category: 'ships',
    game_action: 'ship_livery',
    action_config: { effect: 'grant_item', item_id: 'shipskin_kestrel_solstice' },
    quantity: null,
    cost_buy: 760,
    cost_sell: 304,
    pricing_kind: 'fixed',
    sort_order: 62,
    worlds: ['dock'],
  },
  {
    source_key: 'shipskin_dray_brasshearth',
    name: 'Brass Hearth Livery',
    description: 'Dray livery. Dark bronze under polished brass. The tender an ore family kept for four generations. Goes on from Esc → Customise ship, in the yard; one use, then yours for good.',
    category: 'ships',
    game_action: 'ship_livery',
    action_config: { effect: 'grant_item', item_id: 'shipskin_dray_brasshearth' },
    quantity: null,
    cost_buy: 720,
    cost_sell: 288,
    pricing_kind: 'fixed',
    sort_order: 63,
    worlds: ['dock'],
  },
  {
    source_key: 'shipskin_dray_anthracite',
    name: 'Anthracite Livery',
    description: 'Dray livery. Graphite that eats the light, with an oxblood line. Nothing on this hull wants to be seen. Goes on from Esc → Customise ship, in the yard; one use, then yours for good.',
    category: 'ships',
    game_action: 'ship_livery',
    action_config: { effect: 'grant_item', item_id: 'shipskin_dray_anthracite' },
    quantity: null,
    cost_buy: 780,
    cost_sell: 312,
    pricing_kind: 'fixed',
    sort_order: 64,
    worlds: ['dock'],
  },
  {
    source_key: 'shipskin_dray_meridian',
    name: 'Meridian Livery',
    description: 'Dray livery. Deep blue with an ivory boot line, the way the survey tenders were finished before the war. Goes on from Esc → Customise ship, in the yard; one use, then yours for good.',
    category: 'ships',
    game_action: 'ship_livery',
    action_config: { effect: 'grant_item', item_id: 'shipskin_dray_meridian' },
    quantity: null,
    cost_buy: 840,
    cost_sell: 336,
    pricing_kind: 'fixed',
    sort_order: 65,
    worlds: ['dock'],
  },
  {
    source_key: 'shipskin_pike_cinnabar',
    name: 'Cinnabar Livery',
    description: 'Pike livery. Lacquer red over black ordnance, and chrome on the shrouds. Flown by somebody who wanted to be found. Goes on from Esc → Customise ship, in the yard; one use, then yours for good.',
    category: 'ships',
    game_action: 'ship_livery',
    action_config: { effect: 'grant_item', item_id: 'shipskin_pike_cinnabar' },
    quantity: null,
    cost_buy: 820,
    cost_sell: 328,
    pricing_kind: 'fixed',
    sort_order: 66,
    worlds: ['dock'],
  },
  {
    source_key: 'shipskin_pike_covert',
    name: 'Covert Livery',
    description: 'Pike livery. Dead green, dead grey, brass on the shrouds because brass does not flash. The opposite argument. Goes on from Esc → Customise ship, in the yard; one use, then yours for good.',
    category: 'ships',
    game_action: 'ship_livery',
    action_config: { effect: 'grant_item', item_id: 'shipskin_pike_covert' },
    quantity: null,
    cost_buy: 880,
    cost_sell: 352,
    pricing_kind: 'fixed',
    sort_order: 67,
    worlds: ['dock'],
  },
  {
    source_key: 'shipskin_pike_whitecap',
    name: 'Whitecap Livery',
    description: 'Pike livery. White to the waterline with a cobalt spine. The only Pike in the yard nobody has ever scratched. Goes on from Esc → Customise ship, in the yard; one use, then yours for good.',
    category: 'ships',
    game_action: 'ship_livery',
    action_config: { effect: 'grant_item', item_id: 'shipskin_pike_whitecap' },
    quantity: null,
    cost_buy: 940,
    cost_sell: 376,
    pricing_kind: 'fixed',
    sort_order: 68,
    worlds: ['dock'],
  },
  {
    source_key: 'spell_stasis_5s',
    name: 'Stasis Rune',
    description: 'Spell consumable that pauses nearby NPC movement for 5 seconds.',
    category: 'spells',
    game_action: 'npc_pause_5s',
    action_config: { effect: 'pause_npcs', seconds: 5, radius: 24 },
    quantity: null,
    cost_buy: 125,
    cost_sell: 55,
    pricing_kind: 'consumable',
    sort_order: 60,
    worlds: null,
  },
  {
    source_key: 'spell_stasis_10s',
    name: 'Chrono Snare',
    description: 'Spell consumable that pauses nearby NPC movement for 10 seconds.',
    category: 'spells',
    game_action: 'npc_pause_10s',
    action_config: { effect: 'pause_npcs', seconds: 10, radius: 26 },
    quantity: null,
    cost_buy: 190,
    cost_sell: 84,
    pricing_kind: 'consumable',
    sort_order: 70,
    worlds: null,
  },
  {
    source_key: 'spell_stasis_30s',
    name: 'Time Lock Prism',
    description: 'Spell consumable that pauses nearby NPC movement for 30 seconds.',
    category: 'spells',
    game_action: 'npc_pause_30s',
    action_config: { effect: 'pause_npcs', seconds: 30, radius: 28 },
    quantity: null,
    cost_buy: 360,
    cost_sell: 160,
    pricing_kind: 'consumable',
    sort_order: 80,
    worlds: null,
  },
  {
    source_key: 'spell_stasis_60s',
    name: 'Temporal Vault Sigil',
    description: 'Spell consumable that pauses nearby NPC movement for 60 seconds.',
    category: 'spells',
    game_action: 'npc_pause_60s',
    action_config: { effect: 'pause_npcs', seconds: 60, radius: 30 },
    quantity: null,
    cost_buy: 620,
    cost_sell: 275,
    pricing_kind: 'consumable',
    sort_order: 90,
    worlds: null,
  },
  {
    source_key: 'spell_velocity_25',
    name: 'Fleetstep Spark',
    description: 'Spell consumable that boosts movement speed by 25% for 30 seconds.',
    category: 'spells',
    game_action: 'speed_boost_25',
    action_config: { effect: 'modify_speed', percent: 25, seconds: 30 },
    quantity: null,
    cost_buy: 135,
    cost_sell: 60,
    pricing_kind: 'consumable',
    sort_order: 100,
    worlds: null,
  },
  {
    source_key: 'spell_velocity_50',
    name: 'Rushline Glyph',
    description: 'Spell consumable that boosts movement speed by 50% for 30 seconds.',
    category: 'spells',
    game_action: 'speed_boost_50',
    action_config: { effect: 'modify_speed', percent: 50, seconds: 30 },
    quantity: null,
    cost_buy: 195,
    cost_sell: 86,
    pricing_kind: 'consumable',
    sort_order: 110,
    worlds: null,
  },
  {
    source_key: 'spell_velocity_75',
    name: 'Mach Surge Sigil',
    description: 'Spell consumable that boosts movement speed by 75% for 30 seconds.',
    category: 'spells',
    game_action: 'speed_boost_75',
    action_config: { effect: 'modify_speed', percent: 75, seconds: 30 },
    quantity: null,
    cost_buy: 280,
    cost_sell: 124,
    pricing_kind: 'consumable',
    sort_order: 120,
    worlds: null,
  },
  {
    source_key: 'spell_velocity_100',
    name: 'Velocity Crown',
    description: 'Spell consumable that doubles movement speed for 30 seconds.',
    category: 'spells',
    game_action: 'speed_boost_100',
    action_config: { effect: 'modify_speed', percent: 100, seconds: 30 },
    quantity: null,
    cost_buy: 410,
    cost_sell: 184,
    pricing_kind: 'consumable',
    sort_order: 130,
    worlds: null,
  },
  {
    source_key: 'spell_loot_grab_30',
    name: 'Vacuum Rune',
    description: 'Spell consumable that pulls nearby loot toward you for 30 seconds.',
    category: 'spells',
    game_action: 'loot_magnet_30s',
    action_config: { effect: 'loot_magnet', seconds: 30, radius: 30 },
    quantity: null,
    cost_buy: 165,
    cost_sell: 72,
    pricing_kind: 'consumable',
    sort_order: 140,
    worlds: null,
  },
  {
    source_key: 'spell_portal_ping_30',
    name: 'Gatefinder Echo',
    description: 'Spell consumable that highlights the nearest portal for 30 seconds.',
    category: 'spells',
    game_action: 'portal_ping_30s',
    action_config: { effect: 'portal_ping', seconds: 30 },
    quantity: null,
    cost_buy: 155,
    cost_sell: 68,
    pricing_kind: 'consumable',
    sort_order: 150,
    worlds: null,
  },
  {
    source_key: 'shield_5s',
    name: 'Aegis Shard',
    description: 'Spell consumable that raises a damage shield for 5 seconds.',
    category: 'spells',
    game_action: 'shield_5s',
    action_config: { effect: 'shield', seconds: 5 },
    quantity: null,
    cost_buy: 210,
    cost_sell: 92,
    pricing_kind: 'consumable',
    sort_order: 160,
    worlds: null,
  },
  {
    source_key: 'firepower_boost_25',
    name: 'Firepower Sigil',
    description: 'Weapon consumable that boosts weapon damage by 25% for 30 seconds.',
    category: 'weapons',
    game_action: 'firepower_boost_25',
    action_config: { effect: 'modify_firepower', percent: 25, seconds: 30 },
    quantity: null,
    cost_buy: 150,
    cost_sell: 66,
    pricing_kind: 'consumable',
    sort_order: 170,
    worlds: null,
  },
  {
    source_key: 'firepower_boost_50',
    name: 'Firepower Talisman',
    description: 'Weapon consumable that boosts weapon damage by 50% for 30 seconds.',
    category: 'weapons',
    game_action: 'firepower_boost_50',
    action_config: { effect: 'modify_firepower', percent: 50, seconds: 30 },
    quantity: null,
    cost_buy: 215,
    cost_sell: 95,
    pricing_kind: 'consumable',
    sort_order: 171,
    worlds: null,
  },
  {
    source_key: 'firepower_boost_75',
    name: 'Firepower Seal',
    description: 'Weapon consumable that boosts weapon damage by 75% for 30 seconds.',
    category: 'weapons',
    game_action: 'firepower_boost_75',
    action_config: { effect: 'modify_firepower', percent: 75, seconds: 30 },
    quantity: null,
    cost_buy: 305,
    cost_sell: 134,
    pricing_kind: 'consumable',
    sort_order: 172,
    worlds: null,
  },
  {
    source_key: 'firepower_boost_100',
    name: 'Firepower Crown',
    description: 'Weapon consumable that doubles weapon damage for 30 seconds.',
    category: 'weapons',
    game_action: 'firepower_boost_100',
    action_config: { effect: 'modify_firepower', percent: 100, seconds: 30 },
    quantity: null,
    cost_buy: 445,
    cost_sell: 196,
    pricing_kind: 'consumable',
    sort_order: 173,
    worlds: null,
  },
  /* The three damage-reduction wards, the defensive mirror of the four rows
   * above. Bundled for a reason that is sharper than "every row is bundled":
   * these and the Aegis Shard are the only two things in the catalogue a player
   * can buy to survive a fight, and a build with the API down is exactly the
   * build the campaign is play-tested on. */
  {
    source_key: 'ward_20',
    name: 'Bulwark Ward',
    description: 'Spell consumable that reduces all damage taken by 20% for 30 seconds.',
    category: 'spells',
    game_action: 'ward_20',
    action_config: { effect: 'modify_damage_taken', percent: 20, seconds: 30 },
    quantity: null,
    cost_buy: 160,
    cost_sell: 70,
    pricing_kind: 'consumable',
    sort_order: 174,
    worlds: null,
  },
  {
    source_key: 'ward_35',
    name: 'Bastion Ward',
    description: 'Spell consumable that reduces all damage taken by 35% for 30 seconds.',
    category: 'spells',
    game_action: 'ward_35',
    action_config: { effect: 'modify_damage_taken', percent: 35, seconds: 30 },
    quantity: null,
    cost_buy: 245,
    cost_sell: 108,
    pricing_kind: 'consumable',
    sort_order: 175,
    worlds: null,
  },
  {
    source_key: 'ward_50',
    name: 'Adamant Ward',
    description: 'Spell consumable that halves all damage taken for 30 seconds.',
    category: 'spells',
    game_action: 'ward_50',
    action_config: { effect: 'modify_damage_taken', percent: 50, seconds: 30 },
    quantity: null,
    cost_buy: 360,
    cost_sell: 158,
    pricing_kind: 'consumable',
    sort_order: 176,
    worlds: null,
  },
  /* The four stamina draughts. `source_key` is the `stamina_slowdown_*` action
   * id and not the `stamina_draught_*` item id, which looks like a mistake and
   * is not: `Marketplace.consumableItemFor` maps one to the other, and the
   * catalogue key has to be the mapping key or the purchase resolves to nothing
   * and returns `unsupported`. @see MARKETPLACE_CONSUMABLE_ITEMS */
  {
    source_key: 'stamina_slowdown_25',
    name: 'Second Wind Draught',
    description: 'Field tonic that cuts the stamina cost of every exertion by 25% for 30 seconds.',
    category: 'health',
    game_action: 'stamina_slowdown_25',
    action_config: { effect: 'modify_stamina_drain', percent: 25, seconds: 30 },
    quantity: null,
    cost_buy: 120,
    cost_sell: 52,
    pricing_kind: 'consumable',
    sort_order: 190,
    worlds: null,
  },
  {
    source_key: 'stamina_slowdown_50',
    name: 'Longstride Draught',
    description: 'Field tonic that halves the stamina cost of every exertion for 30 seconds.',
    category: 'health',
    game_action: 'stamina_slowdown_50',
    action_config: { effect: 'modify_stamina_drain', percent: 50, seconds: 30 },
    quantity: null,
    cost_buy: 175,
    cost_sell: 77,
    pricing_kind: 'consumable',
    sort_order: 191,
    worlds: null,
  },
  {
    source_key: 'stamina_slowdown_75',
    name: 'Ironlung Draught',
    description: 'Field tonic that cuts the stamina cost of every exertion by 75% for 30 seconds.',
    category: 'health',
    game_action: 'stamina_slowdown_75',
    action_config: { effect: 'modify_stamina_drain', percent: 75, seconds: 30 },
    quantity: null,
    cost_buy: 250,
    cost_sell: 110,
    pricing_kind: 'consumable',
    sort_order: 192,
    worlds: null,
  },
  {
    source_key: 'stamina_slowdown_100',
    name: 'Wellspring Draught',
    description: 'Field tonic that stops stamina draining at all for 15 seconds. Half the window of the rungs below it, because nothing you do costs anything.',
    category: 'health',
    game_action: 'stamina_slowdown_100',
    action_config: { effect: 'modify_stamina_drain', percent: 100, seconds: 15 },
    quantity: null,
    cost_buy: 340,
    cost_sell: 150,
    pricing_kind: 'consumable',
    sort_order: 193,
    worlds: null,
  },
  /* The three bag expansion rigs. Bundled like every other hand-authored row,
   * and for a sharper reason than most: the one purchase a player makes to stop
   * their bag overflowing must not be the purchase that is missing when the API
   * is down and the bag is overflowing. `marketplace-offline.test.mjs` compares
   * every field below against the TypeScript. */
  {
    source_key: 'bag_expand_5',
    name: 'Stowage Webbing',
    description: 'A coil of load-bearing webbing and five clip points, lashed across the back of a pack. Hold it in your bag to fit it: +5 bag slots, permanently. No bag holds more than 60.',
    category: 'tools',
    game_action: 'bag_expand',
    action_config: { effect: 'grant_item', item_id: 'bag_expand_5', amount: 1 },
    quantity: null,
    cost_buy: 480,
    cost_sell: 192,
    pricing_kind: 'fixed',
    sort_order: 180,
    worlds: null,
  },
  {
    source_key: 'bag_expand_10',
    name: 'Expedition Harness',
    description: 'A frame harness with side panniers, cut for a long walk away from a counter. Hold it in your bag to fit it: +10 bag slots, permanently. No bag holds more than 60.',
    category: 'tools',
    game_action: 'bag_expand',
    action_config: { effect: 'grant_item', item_id: 'bag_expand_10', amount: 1 },
    quantity: null,
    cost_buy: 1150,
    cost_sell: 460,
    pricing_kind: 'fixed',
    sort_order: 181,
    worlds: null,
  },
  {
    source_key: 'bag_expand_15',
    name: 'Quartermaster Rig',
    description: "The rig a supply officer wears to carry a squad's worth of everything at once. Hold it in your bag to fit it: +15 bag slots, permanently. No bag holds more than 60.",
    category: 'tools',
    game_action: 'bag_expand',
    action_config: { effect: 'grant_item', item_id: 'bag_expand_15', amount: 1 },
    quantity: null,
    cost_buy: 2100,
    cost_sell: 840,
    pricing_kind: 'fixed',
    sort_order: 182,
    worlds: null,
  },
  {
    source_key: 'cosmetic_headgear_aurora',
    name: 'Aurora Racer Skin',
    description: 'Limited-edition character colourway — glacier teal with a cyan pulse. Equip from Esc → Character.',
    category: 'cosmetic',
    game_action: 'cosmetic_char_skin',
    action_config: { effect: 'unlock_cosmetic', kind: 'character', cosmetic_id: 'char_aurora' },
    quantity: null,
    cost_buy: 240,
    cost_sell: 96,
    pricing_kind: 'fixed',
    sort_order: 200,
    worlds: null,
  },
  {
    source_key: 'cosmetic_shirt_trail',
    name: 'Midnight Ops Skin',
    description: 'Limited-edition character colourway — blacked-out kit with cold blue trim. Equip from Esc → Character.',
    category: 'cosmetic',
    game_action: 'cosmetic_char_skin',
    action_config: { effect: 'unlock_cosmetic', kind: 'character', cosmetic_id: 'char_midnight' },
    quantity: null,
    cost_buy: 260,
    cost_sell: 104,
    pricing_kind: 'fixed',
    sort_order: 210,
    worlds: null,
  },
  {
    source_key: 'cosmetic_pants_glide',
    name: 'Ember Vanguard Skin',
    description: 'Limited-edition character colourway — scorched charcoal and molten orange. Equip from Esc → Character.',
    category: 'cosmetic',
    game_action: 'cosmetic_char_skin',
    action_config: { effect: 'unlock_cosmetic', kind: 'character', cosmetic_id: 'char_ember' },
    quantity: null,
    cost_buy: 280,
    cost_sell: 112,
    pricing_kind: 'fixed',
    sort_order: 220,
    worlds: null,
  },
  {
    source_key: 'cosmetic_skin_jade',
    name: 'Jade Sovereign Skin',
    description: 'Limited-edition character colourway — deep jade with a gold edge. Equip from Esc → Character.',
    category: 'cosmetic',
    game_action: 'cosmetic_char_skin',
    action_config: { effect: 'unlock_cosmetic', kind: 'character', cosmetic_id: 'char_jade' },
    quantity: null,
    cost_buy: 320,
    cost_sell: 128,
    pricing_kind: 'fixed',
    sort_order: 230,
    worlds: null,
  },
  {
    source_key: 'cosmetic_skin_violet',
    name: 'Violet Mirage Skin',
    description: 'Limited-edition character colourway — twilight violet with a magenta spark. Equip from Esc → Character.',
    category: 'cosmetic',
    game_action: 'cosmetic_char_skin',
    action_config: { effect: 'unlock_cosmetic', kind: 'character', cosmetic_id: 'char_violet' },
    quantity: null,
    cost_buy: 360,
    cost_sell: 144,
    pricing_kind: 'fixed',
    sort_order: 240,
    worlds: null,
  },
  {
    source_key: 'cosmetic_car_neon',
    name: 'Neon Circuit Livery',
    description: 'Limited-edition car livery — magenta body with cyan rims. Apply from Esc → Customise mount while driving; one use, then yours to keep.',
    category: 'mounts',
    game_action: 'cosmetic_vehicle_skin',
    action_config: { effect: 'grant_item', item_id: 'skin_car_neon' },
    quantity: null,
    cost_buy: 420,
    cost_sell: 168,
    pricing_kind: 'fixed',
    sort_order: 400,
    worlds: null,
  },
  {
    source_key: 'cosmetic_car_inferno',
    name: 'Inferno Livery',
    description: 'Limited-edition car livery — race red with gold alloys. Apply from Esc → Customise mount while driving; one use, then yours to keep.',
    category: 'mounts',
    game_action: 'cosmetic_vehicle_skin',
    action_config: { effect: 'grant_item', item_id: 'skin_car_inferno' },
    quantity: null,
    cost_buy: 460,
    cost_sell: 184,
    pricing_kind: 'fixed',
    sort_order: 410,
    worlds: null,
  },
  {
    source_key: 'cosmetic_car_phantom',
    name: 'Phantom Livery',
    description: 'Limited-edition car livery — stealth black with chalk-white wheels. Apply from Esc → Customise mount while driving; one use, then yours to keep.',
    category: 'mounts',
    game_action: 'cosmetic_vehicle_skin',
    action_config: { effect: 'grant_item', item_id: 'skin_car_phantom' },
    quantity: null,
    cost_buy: 500,
    cost_sell: 200,
    pricing_kind: 'fixed',
    sort_order: 420,
    worlds: null,
  },
  {
    source_key: 'cosmetic_car_toxic',
    name: 'Toxic Surge Livery',
    description: 'Limited-edition car livery — venom green over black rims. Apply from Esc → Customise mount while driving; one use, then yours to keep.',
    category: 'mounts',
    game_action: 'cosmetic_vehicle_skin',
    action_config: { effect: 'grant_item', item_id: 'skin_car_toxic' },
    quantity: null,
    cost_buy: 540,
    cost_sell: 216,
    pricing_kind: 'fixed',
    sort_order: 430,
    worlds: null,
  },
  {
    source_key: 'cosmetic_car_azure',
    name: 'Azure Bolt Livery',
    description: 'Limited-edition car livery — electric blue with silver alloys. Apply from Esc → Customise mount while driving; one use, then yours to keep.',
    category: 'mounts',
    game_action: 'cosmetic_vehicle_skin',
    action_config: { effect: 'grant_item', item_id: 'skin_car_azure' },
    quantity: null,
    cost_buy: 600,
    cost_sell: 240,
    pricing_kind: 'fixed',
    sort_order: 440,
    worlds: null,
  },
  {
    source_key: 'mount_strength_1',
    name: 'Mount Strength I',
    description: 'Car upgrade: sharper acceleration off the line. Permanent, stacks with higher tiers.',
    category: 'mounts',
    game_action: 'mount_strength_1',
    action_config: { effect: 'grant_mount_power', mount: 'car', power: 'strength', tier: 1 },
    quantity: null,
    cost_buy: 260,
    cost_sell: 104,
    pricing_kind: 'fixed',
    sort_order: 300,
    worlds: null,
  },
  {
    source_key: 'mount_strength_2',
    name: 'Mount Strength II',
    description: 'Car upgrade: even sharper acceleration. Permanent, replaces tier I.',
    category: 'mounts',
    game_action: 'mount_strength_2',
    action_config: { effect: 'grant_mount_power', mount: 'car', power: 'strength', tier: 2 },
    quantity: null,
    cost_buy: 460,
    cost_sell: 184,
    pricing_kind: 'fixed',
    sort_order: 301,
    worlds: null,
  },
  {
    source_key: 'mount_strength_3',
    name: 'Mount Strength III',
    description: 'Car upgrade: maximum acceleration. Permanent, replaces tier II.',
    category: 'mounts',
    game_action: 'mount_strength_3',
    action_config: { effect: 'grant_mount_power', mount: 'car', power: 'strength', tier: 3 },
    quantity: null,
    cost_buy: 720,
    cost_sell: 288,
    pricing_kind: 'fixed',
    sort_order: 302,
    worlds: null,
  },
  {
    source_key: 'mount_shield_1',
    name: 'Mount Shield I',
    description: 'Car upgrade: reinforced chassis softens impacts. Permanent, stacks with higher tiers.',
    category: 'mounts',
    game_action: 'mount_shield_1',
    action_config: { effect: 'grant_mount_power', mount: 'car', power: 'shield', tier: 1 },
    quantity: null,
    cost_buy: 280,
    cost_sell: 112,
    pricing_kind: 'fixed',
    sort_order: 310,
    worlds: null,
  },
  {
    source_key: 'mount_shield_2',
    name: 'Mount Shield II',
    description: 'Car upgrade: heavier plating. Permanent, replaces tier I.',
    category: 'mounts',
    game_action: 'mount_shield_2',
    action_config: { effect: 'grant_mount_power', mount: 'car', power: 'shield', tier: 2 },
    quantity: null,
    cost_buy: 500,
    cost_sell: 200,
    pricing_kind: 'fixed',
    sort_order: 311,
    worlds: null,
  },
  {
    source_key: 'mount_shield_3',
    name: 'Mount Shield III',
    description: 'Car upgrade: maximum protection. Permanent, replaces tier II.',
    category: 'mounts',
    game_action: 'mount_shield_3',
    action_config: { effect: 'grant_mount_power', mount: 'car', power: 'shield', tier: 3 },
    quantity: null,
    cost_buy: 780,
    cost_sell: 312,
    pricing_kind: 'fixed',
    sort_order: 312,
    worlds: null,
  },
  {
    source_key: 'mount_power_1',
    name: 'Mount Power I',
    description: 'Car upgrade: higher top speed. Permanent, stacks with higher tiers.',
    category: 'mounts',
    game_action: 'mount_power_1',
    action_config: { effect: 'grant_mount_power', mount: 'car', power: 'power', tier: 1 },
    quantity: null,
    cost_buy: 300,
    cost_sell: 120,
    pricing_kind: 'fixed',
    sort_order: 320,
    worlds: null,
  },
  {
    source_key: 'mount_power_2',
    name: 'Mount Power II',
    description: 'Car upgrade: even higher top speed. Permanent, replaces tier I.',
    category: 'mounts',
    game_action: 'mount_power_2',
    action_config: { effect: 'grant_mount_power', mount: 'car', power: 'power', tier: 2 },
    quantity: null,
    cost_buy: 520,
    cost_sell: 208,
    pricing_kind: 'fixed',
    sort_order: 321,
    worlds: null,
  },
  {
    source_key: 'mount_power_3',
    name: 'Mount Power III',
    description: 'Car upgrade: maximum top speed. Permanent, replaces tier II.',
    category: 'mounts',
    game_action: 'mount_power_3',
    action_config: { effect: 'grant_mount_power', mount: 'car', power: 'power', tier: 3 },
    quantity: null,
    cost_buy: 820,
    cost_sell: 328,
    pricing_kind: 'fixed',
    sort_order: 322,
    worlds: null,
  },].map(Object.freeze));

/* ====================================================================== */
/* The two GENERATED ladders                                              */
/* ====================================================================== */

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  SHIP FITTINGS AND WEAPON TIERS: GENERATED, NOT COPIED, AND NOT IN
 *  `OFFLINE_BASE_ITEMS`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * These forty-eight rows are deliberately NOT members of `OFFLINE_BASE_ITEMS`,
 * and that placement is the whole of their design.
 *
 * `marketplace-offline.test.mjs` compares `OFFLINE_BASE_ITEMS` against the
 * hand-authored rows in `site/lib/marketplaceCatalog.ts` in BOTH directions -
 * a row here that is not there fails as loudly as one there that is not here.
 * That gate is right and must not be weakened, so a row that has no TypeScript
 * twin cannot go in that array. It goes here instead, exactly where the
 * TypeScript already puts its own two generated arrays (`MOUNT_SKIN_ROWS` and
 * the sixty `MOUNT_UPGRADE_ROWS`), which that same test skips for the same
 * reason: the scrape reads `source_key: '...'` literals and a product of three
 * tables has none.
 *
 * ── They are GENERATED FROM THE GAME'S OWN LADDERS ────────────────────────
 *
 * `SHIP_STATS` and `SHIP_STAT_META.base` for the thirty-six fittings - three
 * hulls, four stats, three tiers, because `ShipRegistry._powers` is keyed by
 * HULL and a fitting bought for a Kestrel is not on the Dray - and
 * `WEAPON_ORDER` with `weaponPowerPrice` for the twelve weapon tiers. Not a
 * second table, not a
 * copy of a price - the same functions the yard panel quotes from. That is the
 * `MarketplaceOffline` header's own rule ("copying a product is how a copy
 * rots") applied to a product this module can actually derive, because unlike
 * the mount wall the source tables are JavaScript in `src/`.
 *
 * A hull or a stat added to `SHIP_STATS` therefore arrives with its three rungs
 * priced and stocked. The Bastion has an EMPTY `SHIP_STATS` entry - it is a
 * hulk that sells nothing - so it generates nothing, which is `ShipRegistry`'s
 * `sellsPower` refusal expressed as an absence rather than as a row that would
 * have to be refused at the counter.
 *
 * ── THE HONEST LIMITATION, STATED HERE RATHER THAN DISCOVERED ─────────────
 *
 * `Marketplace._loadCatalog` uses this bundle ONLY when `/api/marketplace/items`
 * fails. So these forty-eight rows are on the shelf in a `vite`-only build -
 * which is how this game is developed and play-tested, and the exact build
 * whose empty Fitting Shop this file was written to fix - and NOT on the shelf
 * when the API is up. Closing that gap is forty-eight rows in
 * `site/lib/marketplaceCatalog.ts`, generated the same way from the same
 * numbers; the changelog for this work carries the patch.
 *
 * The yard's ship fittings have a second counter that does not depend on any of
 * this: `ShipMenu` sells all twelve directly, over `economy.spend` and
 * `ShipRegistry.grantPower`, in the Esc panel. So the ship half is reachable in
 * every build either way, and these rows are the shop's copy of an offer the
 * panel already makes.
 */
const SHIP_UPGRADE_ROWS = SHIP_ORDER.flatMap((ship) => (SHIP_STATS[ship] ?? []).flatMap(
  (stat) => Array.from({ length: SHIP_POWER_TIERS }, (_, i) => i + 1).map((tier) => ({
    source_key: `ship_${ship}_${stat}_${tier}`,
    name: shipPowerName(ship, stat, tier),
    description: `${shipPowerName(ship, stat, tier)}: +${(SHIP_STAT_META[stat]?.perTier ?? 0) * tier}%`
      + ` ${SHIP_STAT_META[stat]?.unit ?? stat}. Permanent, replaces the tier below.`
      + ' Fitted in the yard; see your tiers in Esc → Customise ship.',
    category: 'ships',
    game_action: `ship_${ship}_${stat}_${tier}`,
    action_config: { effect: 'grant_ship_power', ship, power: stat, tier },
    quantity: null,
    cost_buy: shipPowerPrice(stat, tier),
    cost_sell: shipPowerSellPrice(stat, tier),
    pricing_kind: 'fixed',
    /* 600 upward, clear of the hand-authored block's 10-440. The yard is the
     * only counter that stocks them (`worlds: ['dock']`, the pairing
     * `dock-economy.test.mjs` asserts over every `ships` row), so they sort
     * after everything a general vendor carries. */
    sort_order: 600 + SHIP_ORDER.indexOf(ship) * 20 + (SHIP_STATS[ship] ?? []).indexOf(stat) * 4 + tier,
    worlds: ['dock'],
  })),
));

const WEAPON_UPGRADE_ROWS = WEAPON_ORDER.flatMap(
  (weapon) => Array.from({ length: WEAPON_POWER_TIERS }, (_, i) => i + 1).map((tier) => ({
    source_key: `weapon_${weapon}_damage_${tier}`,
    name: weaponPowerName(weapon, tier),
    description: `${WEAPON_LABEL[weapon] ?? weapon} upgrade: +${Math.round(WEAPON_TIER_STEP * tier * 100)}%`
      + ' damage, permanently. Replaces the tier below it.',
    category: 'weapons',
    game_action: `weapon_${weapon}_damage_${tier}`,
    action_config: { effect: 'grant_weapon_power', weapon, tier },
    quantity: null,
    cost_buy: weaponPowerPrice(weapon, tier),
    cost_sell: weaponPowerSellPrice(weapon, tier),
    pricing_kind: 'fixed',
    /* 700 upward, after the ship block. `worlds: null` - a weapon tier is
     * carried on the player and not fitted to a hull, so any counter that
     * stocks `weapons` sells it, exactly as every ammunition pack is sold
     * everywhere. */
    sort_order: 700 + WEAPON_ORDER.indexOf(weapon) * 4 + tier,
    worlds: null,
  })),
);

/** Every generated row, in the order `offlineCatalog` appends them. */
export const OFFLINE_UPGRADE_ROWS = Object.freeze(
  [...SHIP_UPGRADE_ROWS, ...WEAPON_UPGRADE_ROWS].map(Object.freeze)
);

/**
 * The catalogue a vendor in `worldId` would be served, priced for that world.
 *
 * @param {string|null} worldId
 * @returns {Array<object>} rows in the same shape `/api/marketplace/items`
 *   returns: `id`, `source_key`, `name`, `description`, `category`, `image`,
 *   `game_action`, `action_config`, `quantity`, `cost_buy`, `cost_sell`,
 *   `sort_order`. `image` is the empty string - `MarketplaceUI._renderMktArt`
 *   already draws a styled SVG placeholder for a row with no art, which is the
 *   right answer when the art service is the thing that is down.
 */
export function offlineCatalog(worldId) {
  const market = WORLD_MARKETS[worldId] ?? null;
  if (!market) return [];
  const out = [];
  /* The generated ladders ride the SAME loop as the hand-authored rows, so
   * they get the same world filter, the same `:<world>` id suffix, the same
   * `Math.max(1, ...)` price floor and the same `offline: true` marking. A
   * second loop for them would be a second place for one of those five things
   * to be forgotten - and the one most easily forgotten is the id suffix,
   * which is what makes an offline purchase and an online one name the same
   * row. Both ladders price `fixed`, so the multipliers below are 1 for them. */
  for (const item of [...OFFLINE_BASE_ITEMS, ...OFFLINE_UPGRADE_ROWS]) {
    if (item.worlds && !item.worlds.includes(worldId)) continue;
    let buyMul = 1;
    let sellMul = 1;
    if (item.pricing_kind === 'ammo') {
      buyMul = market.buy.ammo;
      sellMul = market.sell.ammo;
    } else if (item.pricing_kind === 'consumable') {
      buyMul = market.buy.consumable;
      sellMul = market.sell.consumable;
    }
    out.push({
      /* `id` is what `buy()` looks a row up by and what the trade receipt
       * carries. `source_key:world` is exactly the key the seeder writes, so
       * an offline purchase and an online one name the same row - which
       * matters the moment the API comes back up mid-session. */
      id: `${item.source_key}:${worldId}`,
      source_key: item.source_key,
      name: item.name,
      description: item.description,
      category: item.category,
      image: '',
      game_action: item.game_action,
      action_config: item.action_config,
      quantity: item.quantity,
      cost_buy: Math.max(1, Math.round(item.cost_buy * buyMul)),
      cost_sell: Math.max(1, Math.round(item.cost_sell * sellMul)),
      sort_order: item.sort_order,
      /** Marks a row the API did not serve. The UI says so once, at the top. */
      offline: true,
    });
  }
  out.sort((a, b) => a.sort_order - b.sort_order);
  return out;
}
