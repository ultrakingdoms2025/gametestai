import { buildMarketplaceAiImageUrl } from './marketplaceImages';

/* `'ships'` is the seventh, and it is added HERE AND IN `ALL_CATEGORIES`
 * (src/systems/Marketplace.js) or in neither.
 *
 * Half-done is the dangerous half: `normalizeCategory` in marketplaceDb.ts
 * THROWS on an unknown category, which is loud and fine, but
 * `Marketplace._readVendorCategories` in the game silently DROPS one it does
 * not recognise - so a counter authored as `vendorCategories: ['ships']` with
 * this list unchanged becomes a general trader stocking the whole catalogue
 * rather than an empty one. Filing ship hulls under `mounts` and ship liveries
 * under `cosmetic` would work and would be a lie in the UI tabs. */
export const MARKETPLACE_CATEGORIES = ['cosmetic', 'weapons', 'tools', 'health', 'spells', 'mounts', 'ships'] as const;
export type MarketplaceCategory = (typeof MARKETPLACE_CATEGORIES)[number];

/* Every world whose vendors have a catalogue. `normalizeWorld` throws on
 * anything not in here, and it is called from `rowToItem` for EVERY row in a
 * listing - so a `dock` row reaching the API before this changed would take
 * the whole marketplace down, not just its own row. */
export const MARKETPLACE_WORLDS = ['station', 'medieval', 'sports', 'citadel', 'race', 'dock'] as const;
export type MarketplaceWorld = (typeof MARKETPLACE_WORLDS)[number];

/* ---- Mount upgrades: shown in Esc -> Customise mount, applied by MountManager.grantPower ---- */

const UPGRADE_MOUNTS = [
  { id: 'dragon', label: 'Dragon', powers: ['power', 'strength', 'shield', 'fire'] },
  { id: 'eagle', label: 'Eagle', powers: ['power', 'strength', 'shield'] },
  { id: 'horse', label: 'Horse', powers: ['power', 'strength', 'shield'] },
  { id: 'hoverboard', label: 'Hoverboard', powers: ['power', 'strength', 'shield'] },
  { id: 'bicycle', label: 'Bicycle', powers: ['power', 'strength', 'shield'] },
] as const;

const POWER_META = {
  power: { name: 'Speed', blurb: 'top speed', color: '#b6ff5a', base: 300 },
  strength: { name: 'Acceleration', blurb: 'acceleration', color: '#ff8a5c', base: 260 },
  shield: { name: 'Armour', blurb: 'damage protection while riding', color: '#52e9ff', base: 280 },
  fire: { name: 'Fire', blurb: 'fireball damage while riding', color: '#ff6a3a', base: 340 },
} as const;

const TIER_ROMAN = ['I', 'II', 'III'] as const;
const TIER_MUL = [1, 2, 3.15] as const;
type UpgradeMountId = (typeof UPGRADE_MOUNTS)[number]['id'];
type UpgradePowerId = keyof typeof POWER_META;
// Template type over 5x4x3 = 60 ids; 12 (e.g. mount_eagle_fire_1) are never
// generated - harmless, normalizeAction() checks the runtime array, not the type.
export type MountUpgradeActionId = `mount_${UpgradeMountId}_${UpgradePowerId}_${1 | 2 | 3}`;

const MOUNT_UPGRADE_ACTIONS: ReadonlyArray<{ id: MountUpgradeActionId; label: string; description: string; effect: 'grant_mount_power' }> =
  UPGRADE_MOUNTS.flatMap((m) => m.powers.flatMap((p) => ([1, 2, 3] as const).map((tier) => ({
    id: `mount_${m.id}_${p}_${tier}` as MountUpgradeActionId,
    label: `${m.label} ${POWER_META[p].name} ${TIER_ROMAN[tier - 1]}`,
    description: `Permanently raises your ${m.label.toLowerCase()} ${POWER_META[p].blurb} (tier ${tier}).`,
    effect: 'grant_mount_power' as const,
  }))));

export const MARKETPLACE_ACTIONS = [
  {
    id: 'ammo_pack_rifle',
    label: 'Rifle ammo pack',
    description: 'Consumes one item and adds rifle rounds to the player bag.',
    effect: 'grant_ammo',
  },
  {
    id: 'ammo_pack_arrow',
    label: 'Arrow ammo pack',
    description: 'Consumes one item and adds arrows to the player bag.',
    effect: 'grant_ammo',
  },
  {
    id: 'ammo_pack_ember',
    label: 'Ember ammo pack',
    description: 'Consumes one item and adds ember charges to the player bag.',
    effect: 'grant_ammo',
  },
  /* ---- Lodestar Yard ---------------------------------------------------
   *
   * All three use the GENERIC effects `Marketplace._purchaseGrant` already
   * reads off `action_config` (`grant_ammo` / `grant_item`), which is the
   * documented way to skip step 7 of the nine-step item registration - the
   * `MARKETPLACE_CONSUMABLE_ITEMS` mapping whose recorded failure is a
   * prettier `source_key` resolving to nothing and every purchase returning
   * `unsupported` (Marketplace.js:605-613). Nothing here needs a bespoke
   * grant, so nothing here takes that risk. */
  {
    id: 'ammo_pack_laser',
    label: 'Laser cell rack',
    description: 'Consumes one item and adds laser cells to the player bag.',
    effect: 'grant_ammo',
  },
  {
    id: 'ship_part',
    label: 'Ship part',
    description: 'Consumes one item and adds a fitting-out part to the player bag.',
    effect: 'grant_item',
  },
  /* The shield recharge cell, on the generic `grant_item` path for exactly the
   * reason the three rows above it are: it is the documented way past step 7 of
   * the nine-step item registration - the `MARKETPLACE_CONSUMABLE_ITEMS`
   * mapping whose recorded failure is a `source_key` resolving to nothing and
   * every purchase returning `unsupported` (Marketplace.js:605-613). The cell
   * needs no bespoke grant: it is a bag item, and `ItemUse` is what turns it
   * into shield when the pilot is in a seat with room in the pool. */
  {
    id: 'shield_cell',
    label: 'Shield recharge cell',
    description: 'Consumes one item and adds a ship shield recharge cell to the player bag.',
    effect: 'grant_item',
  },
  {
    id: 'nav_chart',
    label: 'Navigation chart',
    description: 'Consumes one item and adds a navigation chart to the player bag.',
    effect: 'grant_item',
  },
  /* Refined Cinder ore, sold across a counter. `grant_item` for the same
   * reason the three rows above use a generic effect: it is the documented way
   * past step 7, the `MARKETPLACE_CONSUMABLE_ITEMS` mapping, whose failure mode
   * is a purchase that resolves to nothing and returns `unsupported`. */
  {
    id: 'refined_ore',
    label: 'Refined ore',
    description: 'Consumes one item and adds a worked piece of planetary ore to the player bag.',
    effect: 'grant_item',
  },
  /* Bag expansion rigs. ONE action id for all three rows, which is the same
   * shape `ship_part` and `refined_ore` already have: the action names the KIND
   * of thing being sold and `action_config.item_id` names which one, so adding
   * a fourth rung later is a `BASE_ITEMS` row and not a widening of the
   * `MarketplaceActionId` union.
   *
   * `grant_item`, the generic effect `Marketplace._purchaseGrant` already
   * reads, so this skips step 7 of the nine-step item registration - the
   * `MARKETPLACE_CONSUMABLE_ITEMS` mapping whose recorded failure is a
   * `source_key` resolving to nothing and every purchase returning
   * `unsupported` (Marketplace.js:605-613). Nothing here needs a bespoke
   * grant, so nothing here takes that risk. */
  {
    id: 'bag_expand',
    label: 'Bag expansion rig',
    description: 'Consumes one item and adds a bag expansion rig to the player bag; using the rig permanently enlarges the bag.',
    effect: 'grant_item',
  },
  {
    id: 'heal_25',
    label: 'Small heal',
    description: 'Consumes one item and restores 25 health.',
    effect: 'restore_health',
  },
  {
    id: 'heal_50',
    label: 'Standard heal',
    description: 'Consumes one item and restores 50 health.',
    effect: 'restore_health',
  },
  {
    id: 'heal_full',
    label: 'Full heal',
    description: 'Consumes one item and restores health to full.',
    effect: 'restore_health_full',
  },
  /* THE FOUR STAMINA ACTIONS, WHICH FINALLY HAVE ROWS BEHIND THEM.
   *
   * These ids were authored with the rest of the catalogue and sold nothing for
   * as long as they existed - the dead actions the old INVENTORY-AUDIT.md
   * flagged. `BASE_ITEMS` now carries four rows against them and `ItemUse`
   * implements the effect through `Stamina.setDrainScale`, so the union, the
   * `game_action` normaliser and the API validators were untouched by the work
   * that made them real: the ids were already legal, they simply pointed at
   * nothing.
   *
   * They resolve through `MARKETPLACE_CONSUMABLE_ITEMS` in
   * `src/systems/Marketplace.js` rather than through the generic `grant_item`
   * path the yard rows use, which is the same wiring the speed, stasis, shield
   * and firepower ladders have - and it carries the same rule, stated here
   * because breaking it is silent: THE `source_key` OF EACH ROW MUST BE THE
   * BARE MAPPING KEY. `consumableItemFor` probes the exact key and then retries
   * once with a trailing `:<world>` stripped, so a prettier `spell_` prefix
   * would resolve to nothing and every purchase would come back
   * `reason: 'unsupported'`. */
  {
    id: 'stamina_slowdown_25',
    label: 'Stamina drain -25%',
    description: 'Temporarily slows stamina loss by 25%.',
    effect: 'modify_stamina_drain',
  },
  {
    id: 'stamina_slowdown_50',
    label: 'Stamina drain -50%',
    description: 'Temporarily slows stamina loss by 50%.',
    effect: 'modify_stamina_drain',
  },
  {
    id: 'stamina_slowdown_75',
    label: 'Stamina drain -75%',
    description: 'Temporarily slows stamina loss by 75%.',
    effect: 'modify_stamina_drain',
  },
  {
    id: 'stamina_slowdown_100',
    label: 'Stamina drain off',
    description: 'Temporarily pauses stamina drain.',
    effect: 'modify_stamina_drain',
  },
  {
    id: 'firepower_boost_25',
    label: 'Firepower +25%',
    description: 'Temporarily boosts weapon damage by 25%.',
    effect: 'modify_firepower',
  },
  {
    id: 'firepower_boost_50',
    label: 'Firepower +50%',
    description: 'Temporarily boosts weapon damage by 50%.',
    effect: 'modify_firepower',
  },
  {
    id: 'firepower_boost_75',
    label: 'Firepower +75%',
    description: 'Temporarily boosts weapon damage by 75%.',
    effect: 'modify_firepower',
  },
  {
    id: 'firepower_boost_100',
    label: 'Firepower +100%',
    description: 'Temporarily doubles weapon damage.',
    effect: 'modify_firepower',
  },
  {
    id: 'speed_boost_25',
    label: 'Speed +25%',
    description: 'Temporarily boosts movement speed by 25%.',
    effect: 'modify_speed',
  },
  {
    id: 'speed_boost_50',
    label: 'Speed +50%',
    description: 'Temporarily boosts movement speed by 50%.',
    effect: 'modify_speed',
  },
  {
    id: 'speed_boost_75',
    label: 'Speed +75%',
    description: 'Temporarily boosts movement speed by 75%.',
    effect: 'modify_speed',
  },
  {
    id: 'speed_boost_100',
    label: 'Speed +100%',
    description: 'Temporarily doubles movement speed.',
    effect: 'modify_speed',
  },
  {
    id: 'npc_pause_5s',
    label: 'NPC freeze',
    description: 'Pauses nearby NPC movement for 5 seconds.',
    effect: 'pause_npcs',
  },
  {
    id: 'npc_pause_10s',
    label: 'NPC freeze +',
    description: 'Pauses nearby NPC movement for 10 seconds.',
    effect: 'pause_npcs',
  },
  {
    id: 'npc_pause_30s',
    label: 'NPC freeze ++',
    description: 'Pauses nearby NPC movement for 30 seconds.',
    effect: 'pause_npcs',
  },
  {
    id: 'npc_pause_60s',
    label: 'NPC freeze +++',
    description: 'Pauses nearby NPC movement for 60 seconds.',
    effect: 'pause_npcs',
  },
  {
    id: 'shield_5s',
    label: 'Shield 5s',
    description: 'Creates a short damage shield.',
    effect: 'shield',
  },
  /* The damage-reduction wards: the middle ground between `shield_5s` (total
   * immunity, five seconds) and nothing at all, which is the whole of what the
   * catalogue offered a player who wanted to take a hit.
   *
   * THREE IDS AND NOT ONE, unlike `bag_expand` which names a KIND and lets
   * `action_config.item_id` name the rung. The difference is the path: a rig is
   * a `grant_item` and reads its rung out of the config, whereas a ward is a
   * timed consumable resolved through `MARKETPLACE_CONSUMABLE_ITEMS` by
   * `source_key`, exactly as the four firepower rows it mirrors are - and that
   * mapping is keyed one entry per item. Same wiring as the ladder it is the
   * mirror of, so the two read as one decision in the shop and in the code.
   *
   * There is deliberately no fourth rung: 100% off is `shield_5s`. */
  {
    id: 'ward_20',
    label: 'Damage ward -20%',
    description: 'Temporarily reduces all damage taken by 20%.',
    effect: 'modify_damage_taken',
  },
  {
    id: 'ward_35',
    label: 'Damage ward -35%',
    description: 'Temporarily reduces all damage taken by 35%.',
    effect: 'modify_damage_taken',
  },
  {
    id: 'ward_50',
    label: 'Damage ward -50%',
    description: 'Temporarily halves all damage taken.',
    effect: 'modify_damage_taken',
  },
  {
    id: 'loot_magnet_30s',
    label: 'Loot magnet',
    description: 'Pulls nearby loot toward the player for 30 seconds.',
    effect: 'loot_magnet',
  },
  {
    id: 'portal_ping_30s',
    label: 'Portal ping',
    description: 'Highlights the nearest portal for 30 seconds.',
    effect: 'portal_ping',
  },
  {
    id: 'cosmetic_headgear',
    label: 'Unlock headgear',
    description: 'Unlocks a headgear cosmetic for future character customization.',
    effect: 'unlock_cosmetic',
  },
  {
    id: 'cosmetic_shirt',
    label: 'Unlock shirt',
    description: 'Unlocks a shirt cosmetic for future character customization.',
    effect: 'unlock_cosmetic',
  },
  {
    id: 'cosmetic_pants',
    label: 'Unlock pants',
    description: 'Unlocks a pants cosmetic for future character customization.',
    effect: 'unlock_cosmetic',
  },
  {
    id: 'cosmetic_char_skin',
    label: 'Unlock character skin',
    description: 'Unlocks a limited-edition character colourway from Esc → Character.',
    effect: 'unlock_cosmetic',
  },
  {
    id: 'cosmetic_vehicle_skin',
    label: 'Car skin',
    description: 'Grants a car skin item; apply it from Esc → Customise mount while driving.',
    effect: 'grant_item',
  },
  {
    id: 'mount_skin',
    label: 'Mount skin',
    description: 'Grants a mount skin item; apply it from Esc → Customise mount while riding.',
    effect: 'grant_item',
  },
  {
    id: 'mount_strength_1',
    label: 'Mount Strength I',
    description: 'Permanently sharpens your car acceleration (tier 1).',
    effect: 'grant_mount_power',
  },
  {
    id: 'mount_strength_2',
    label: 'Mount Strength II',
    description: 'Permanently sharpens your car acceleration (tier 2).',
    effect: 'grant_mount_power',
  },
  {
    id: 'mount_strength_3',
    label: 'Mount Strength III',
    description: 'Permanently sharpens your car acceleration (tier 3).',
    effect: 'grant_mount_power',
  },
  {
    id: 'mount_shield_1',
    label: 'Mount Shield I',
    description: 'Permanently reinforces your car against impacts (tier 1).',
    effect: 'grant_mount_power',
  },
  {
    id: 'mount_shield_2',
    label: 'Mount Shield II',
    description: 'Permanently reinforces your car against impacts (tier 2).',
    effect: 'grant_mount_power',
  },
  {
    id: 'mount_shield_3',
    label: 'Mount Shield III',
    description: 'Permanently reinforces your car against impacts (tier 3).',
    effect: 'grant_mount_power',
  },
  {
    id: 'mount_power_1',
    label: 'Mount Power I',
    description: 'Permanently raises your car top speed (tier 1).',
    effect: 'grant_mount_power',
  },
  {
    id: 'mount_power_2',
    label: 'Mount Power II',
    description: 'Permanently raises your car top speed (tier 2).',
    effect: 'grant_mount_power',
  },
  {
    id: 'mount_power_3',
    label: 'Mount Power III',
    description: 'Permanently raises your car top speed (tier 3).',
    effect: 'grant_mount_power',
  },
  ...MOUNT_UPGRADE_ACTIONS,
] as const;

export type MarketplaceActionId = (typeof MARKETPLACE_ACTIONS)[number]['id'];

export type MarketplaceSeedItem = {
  source_key: string;
  name: string;
  description: string;
  category: MarketplaceCategory;
  image: string;
  game_action: MarketplaceActionId;
  action_config: Record<string, unknown>;
  quantity: number | null;
  cost_buy: number;
  cost_sell: number;
  world_name: MarketplaceWorld;
  sort_order: number;
};

export type MarketplaceItemRecord = {
  id: string;
  source_key: string | null;
  name: string;
  description: string;
  category: MarketplaceCategory;
  image: string;
  game_action: MarketplaceActionId;
  action_config: Record<string, unknown>;
  quantity: number | null;
  cost_buy: number;
  cost_sell: number;
  world_name: MarketplaceWorld;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

const WORLD_PRICE_MULTIPLIERS: Record<MarketplaceWorld, {
  ammoBuy: number;
  ammoSell: number;
  consumableBuy: number;
  consumableSell: number;
}> = {
  station: { ammoBuy: 0.8, ammoSell: 0.8, consumableBuy: 1.0, consumableSell: 1.1 },
  medieval: { ammoBuy: 1.15, ammoSell: 1.45, consumableBuy: 1.35, consumableSell: 1.3 },
  sports: { ammoBuy: 0.9, ammoSell: 1.05, consumableBuy: 0.7, consumableSell: 0.65 },
  citadel: { ammoBuy: 1.3, ammoSell: 1.55, consumableBuy: 1.45, consumableSell: 1.4 },
  race: { ammoBuy: 1.0, ammoSell: 1.0, consumableBuy: 1.0, consumableSell: 1.0 },
  /* MUST match `WORLD_MARKETS.dock` in src/systems/ItemDefs.js exactly:
   * `buy.ammo`, `sell.ammo`, `buy.consumable`, `sell.consumable`. This table
   * and that one are two independent copies of the same four numbers and
   * nothing in either codebase compares them, so the check lives in
   * scripts/tests/dock-registration.test.mjs. */
  dock: { ammoBuy: 0.9, ammoSell: 0.8, consumableBuy: 0.95, consumableSell: 1.1 },
};

type PricingKind = 'ammo' | 'consumable' | 'fixed';
type BaseSeedRow = {
  source_key: string; name: string; description: string; category: MarketplaceCategory;
  image_label: string; image_color: string; game_action: MarketplaceActionId;
  action_config: Record<string, unknown>; quantity: number | null; cost_buy: number; cost_sell: number;
  pricing_kind: PricingKind; sort_order: number; worlds?: readonly MarketplaceWorld[];
};

const MOUNT_SKIN_DEFS = [
  { key: 'dragon_obsidian', name: 'Obsidian Ember Hide', desc: 'Dragon skin — black glass hide, blood-red tack.', color: '#14161c', cost: 520 },
  { key: 'dragon_verdant', name: 'Verdant Wyrm Hide', desc: 'Dragon skin — forest scale, worn tan leather.', color: '#1f6b3a', cost: 480 },
  { key: 'dragon_frost', name: 'Frostscale Hide', desc: 'Dragon skin — glacier hide, deep-blue harness.', color: '#bfe6f2', cost: 560 },
  { key: 'eagle_golden', name: 'Golden Talon Plumage', desc: 'Eagle skin — burnished gold plumage, black harness.', color: '#c98a2b', cost: 460 },
  { key: 'eagle_storm', name: 'Storm Crest Plumage', desc: 'Eagle skin — slate-blue feathers, silver straps.', color: '#3a4a5c', cost: 440 },
  { key: 'eagle_ember', name: 'Ember Wing Plumage', desc: 'Eagle skin — scorched russet, gold harness.', color: '#7a2a1a', cost: 480 },
  { key: 'horse_midnight', name: 'Midnight Charger Coat', desc: 'Horse skin — coal-black coat, white leather.', color: '#141216', cost: 420 },
  { key: 'horse_palomino', name: 'Palomino Coat', desc: 'Horse skin — golden coat, oiled brown tack.', color: '#d6b26a', cost: 400 },
  { key: 'horse_royal', name: 'Royal Grey Coat', desc: 'Horse skin — dapple white, violet saddle.', color: '#e6e6ea', cost: 460 },
  { key: 'hover_neon', name: 'Neon Drift Deck', desc: 'Hoverboard skin — gloss black deck, magenta underglow.', color: '#ff3bd2', cost: 440 },
  { key: 'hover_toxic', name: 'Toxic Rail Deck', desc: 'Hoverboard skin — matt green deck, acid glow.', color: '#a8ff3b', cost: 420 },
  { key: 'hover_solar', name: 'Solar Flare Deck', desc: 'Hoverboard skin — orange gloss deck, gold glow.', color: '#f27b1f', cost: 460 },
  { key: 'bike_chrome', name: 'Chrome Courier Frame', desc: 'Bicycle skin — polished frame, bright rims.', color: '#d9dde2', cost: 360 },
  { key: 'bike_racing', name: 'Racing Red Frame', desc: 'Bicycle skin — race red frame, black rims.', color: '#c21f2f', cost: 380 },
  { key: 'bike_forest', name: 'Forest Ranger Frame', desc: 'Bicycle skin — matt green frame, brass rims.', color: '#2f4a2a', cost: 360 },
] as const;

const MOUNT_SKIN_ROWS: readonly BaseSeedRow[] = MOUNT_SKIN_DEFS.map((s, i) => ({
  source_key: `skin_${s.key}`,
  name: s.name,
  description: `${s.desc} Apply from Esc → Customise mount while riding; one use, then yours to keep.`,
  category: 'mounts',
  image_label: s.name.split(' ')[0].toUpperCase(),
  image_color: s.color,
  game_action: 'mount_skin',
  action_config: { effect: 'grant_item', item_id: `skin_${s.key}` },
  quantity: null,
  cost_buy: s.cost,
  cost_sell: Math.round(s.cost * 0.4),
  pricing_kind: 'fixed',
  sort_order: 450 + i,
}));

const MOUNT_UPGRADE_ROWS: readonly BaseSeedRow[] = UPGRADE_MOUNTS.flatMap((m, mi) => m.powers.flatMap((p, pi) => ([1, 2, 3] as const).map((tier) => ({
  source_key: `mount_${m.id}_${p}_${tier}`,
  name: `${m.label} ${POWER_META[p].name} ${TIER_ROMAN[tier - 1]}`,
  description: `${m.label} upgrade: ${POWER_META[p].blurb} tier ${tier}. Permanent, replaces a lower tier. See your tiers in Esc → Customise mount.`,
  category: 'mounts',
  image_label: `${POWER_META[p].name.slice(0, 3).toUpperCase()} ${TIER_ROMAN[tier - 1]}`,
  image_color: POWER_META[p].color,
  game_action: `mount_${m.id}_${p}_${tier}` as MountUpgradeActionId,
  action_config: { effect: 'grant_mount_power', mount: m.id, power: p, tier },
  quantity: null,
  cost_buy: Math.round(POWER_META[p].base * TIER_MUL[tier - 1]),
  cost_sell: Math.round(POWER_META[p].base * TIER_MUL[tier - 1] * 0.4),
  pricing_kind: 'fixed',
  sort_order: 330 + mi * 12 + pi * 3 + (tier - 1),
}))));

export const BASE_ITEMS: readonly BaseSeedRow[] = [
  {
    source_key: 'pack_bullets',
    name: 'Rifle Round Pack',
    description: '60 rifle rounds in one bag slot.',
    category: 'weapons' as const,
    image_label: 'RIFLE',
    image_color: '#52e9ff',
    game_action: 'ammo_pack_rifle' as MarketplaceActionId,
    action_config: { effect: 'grant_ammo', ammo_item: 'bullet', amount: 60 },
    quantity: null,
    cost_buy: 150,
    cost_sell: 72,
    pricing_kind: 'ammo' as const,
    sort_order: 10,
  },
  {
    source_key: 'pack_arrows',
    name: 'Arrow Bundle',
    description: '30 broadhead arrows in one bag slot.',
    category: 'weapons' as const,
    image_label: 'BOW',
    image_color: '#ffd25e',
    game_action: 'ammo_pack_arrow' as MarketplaceActionId,
    action_config: { effect: 'grant_ammo', ammo_item: 'arrow', amount: 30 },
    quantity: null,
    cost_buy: 130,
    cost_sell: 60,
    pricing_kind: 'ammo' as const,
    sort_order: 20,
  },
  {
    source_key: 'pack_embers',
    name: 'Ember Core Cell',
    description: '10 fireball charges in a sealed battery pack.',
    category: 'spells' as const,
    image_label: 'EMBER',
    image_color: '#ff9b3c',
    game_action: 'ammo_pack_ember' as MarketplaceActionId,
    action_config: { effect: 'grant_ammo', ammo_item: 'fireball_charge', amount: 10 },
    quantity: null,
    cost_buy: 170,
    cost_sell: 60,
    pricing_kind: 'ammo' as const,
    sort_order: 30,
  },
  {
    source_key: 'pack_medkit',
    name: 'Trauma Twin-Pack',
    description: 'Two field medkits in one bag slot.',
    category: 'health' as const,
    image_label: 'MED',
    image_color: '#b6ff5a',
    game_action: 'heal_50' as MarketplaceActionId,
    action_config: { effect: 'restore_health', amount: 50 },
    quantity: null,
    cost_buy: 95,
    cost_sell: 36,
    pricing_kind: 'consumable' as const,
    sort_order: 40,
  },

  /* ==================================================================== */
  /* Lodestar Yard                                                        */
  /* ==================================================================== */
  /*
   * Five rows, and every one of them carries a `worlds` allowlist - the first
   * use of a field that shipped with the comment "currently unused; kept for
   * future world-specific stock".
   *
   * ── Why an allowlist and not the usual six copies ────────────────────────
   * A `BASE_ITEMS` row without one is seeded into all six worlds, and four of
   * these five have nowhere to be bought outside the yard: `MARKETPLACE_WORLDS`
   * has one counter carrying the `ships` category in the entire Nexus (Suri
   * Vane, `DockWorld._publish`), and `Marketplace.refreshCatalog` filters the
   * open window by the standing vendor's `vendorCategories`. A `ships` row in
   * Aldermoor Vale is a row no NPC alive can show you - a catalogue entry that
   * is built and unreachable, which is this project's signature defect
   * expressed as five database rows.
   *
   * `pack_nav_chart` is allowed in TWO worlds and the second one is not a
   * guess: the chart's whole effect is `Viewpoints.chartNearest`, and
   * `Viewpoints` arms off `world.viewpoints`. Exactly two worlds publish that
   * array - Sunspire Citadel (five) and Lodestar Yard (three) - and the
   * citadel's Cosmetic counter already carries `tools`. In the other four the
   * chart would be a purchase `ItemUse._canApply` refuses to apply, which is
   * the good half of that failure (the unit is not consumed) attached to the
   * bad half (you paid for it).
   */
  {
    source_key: 'pack_laser_cell',
    name: 'Laser Cell Rack',
    description: '40 charged capacitor cells, racked. Ship ordnance, cut and wound in this yard.',
    category: 'weapons' as const,
    image_label: 'CELL',
    image_color: '#7fe8ff',
    game_action: 'ammo_pack_laser' as MarketplaceActionId,
    action_config: { effect: 'grant_ammo', ammo_item: 'laser_cell', amount: 40 },
    quantity: null,
    cost_buy: 160,
    cost_sell: 64,
    pricing_kind: 'ammo' as const,
    sort_order: 50,
    worlds: ['dock'] as const,
  },
  /* THE SHIELD RECHARGE CELL. The yard's fifth row, and space's second
   * consumable of any kind.
   *
   * `pack_laser_cell` directly above was the whole of what space sold, and it
   * is a gun. The ship's absorption pool takes every hit before the hull does
   * and cannot recover under fire - `SpaceCombat._playerHit` zeroes the idle
   * counter on every hit and `_regen` waits `SHIELD_DELAY` seconds of quiet a
   * live engagement never gives - so a pilot who wanted to spend credits on
   * staying alive had nothing to spend them on.
   *
   * `category: 'ships'` and `worlds: ['dock']`, and the two go together: the
   * whole Nexus has ONE counter carrying `ships` (Suri Vane, `DockWorld`), so a
   * `ships` row seeded anywhere else is a row no NPC alive can show you. That
   * pairing is asserted over every `ships` row in dock-economy.test.mjs.
   *
   * `pricing_kind: 'consumable'` rather than `fixed`, and this was checked
   * rather than assumed. The regional multipliers only bite where a row is
   * seeded into more than one world - that is the arbitrage the bag rigs are
   * `fixed` to prevent - and this one exists in exactly one, so `consumable`
   * produces a single price at the yard's own 0.95 and nothing to fly between.
   * What it buys is that the cell moves with the yard's consumable rate if
   * that rate is ever re-tuned, which is what a thing that gets consumed should
   * do. `pack_nav_chart` two rows down is the same call for the same reason. */
  {
    source_key: 'part_shield_cell',
    name: 'Shield Recharge Cell',
    description: 'A sealed capacitor bank wound for a deflector coil rather than a gun. Dumped into a flying ship it refills the absorption pool and unsticks the regulator a hit locks out.',
    category: 'ships' as const,
    image_label: 'SHCELL',
    image_color: '#6fd8f5',
    game_action: 'shield_cell' as MarketplaceActionId,
    action_config: { effect: 'grant_item', item_id: 'shield_cell', amount: 1 },
    quantity: null,
    cost_buy: 240,
    cost_sell: 105,
    pricing_kind: 'consumable' as const,
    sort_order: 51,
    worlds: ['dock'] as const,
  },
  {
    source_key: 'part_hull_plate',
    name: 'Hull Plate',
    description: 'One cut and drilled section plate, stamped with its frame number. The unit the yard counts in.',
    category: 'ships' as const,
    image_label: 'PLATE',
    image_color: '#b8c6d4',
    game_action: 'ship_part' as MarketplaceActionId,
    action_config: { effect: 'grant_item', item_id: 'hull_plate', amount: 1 },
    quantity: null,
    cost_buy: 85,
    cost_sell: 34,
    pricing_kind: 'fixed' as const,
    sort_order: 52,
    worlds: ['dock'] as const,
  },
  {
    source_key: 'part_thruster_coil',
    name: 'Thruster Coil',
    description: 'A wound field coil out of a courier drive. The one fitting-out part nobody in this yard leaves lying about.',
    category: 'ships' as const,
    image_label: 'COIL',
    image_color: '#e8b06a',
    game_action: 'ship_part' as MarketplaceActionId,
    action_config: { effect: 'grant_item', item_id: 'thruster_coil', amount: 1 },
    quantity: null,
    cost_buy: 195,
    cost_sell: 78,
    pricing_kind: 'fixed' as const,
    sort_order: 54,
    worlds: ['dock'] as const,
  },
  {
    source_key: 'pack_nav_chart',
    name: 'Navigation Chart',
    description: 'A rolled survey chart of one district, drawn from a height somebody else climbed to. Marks that ground on your map; it does not put you on it.',
    category: 'tools' as const,
    image_label: 'CHART',
    image_color: '#5f8b98',
    game_action: 'nav_chart' as MarketplaceActionId,
    action_config: { effect: 'grant_item', item_id: 'nav_chart', amount: 1 },
    quantity: null,
    cost_buy: 220,
    cost_sell: 88,
    pricing_kind: 'consumable' as const,
    sort_order: 56,
    worlds: ['citadel', 'dock'] as const,
  },

  /* ---- Cinder ore, over a yard counter ---------------------------------
   *
   * One row, and the restraint is the point. `BASE_ITEMS` is the BUY side: a
   * row here is a thing a vendor hands you for credits. Seeding the six Cinder
   * elements into it would let a player buy iridite off a counter without ever
   * flying to Cinder, which is not a catalogue entry, it is a refund on the
   * entire mining loop. The five cargo ores are therefore sold BY the player,
   * out of the ship's hold, and appear nowhere in this file.
   *
   * `ferrobasalt` is the exception because it is the one Cinder element that
   * has a use in the hand rather than a price by the tonne - `ItemUse` routes
   * it to the loot-magnet effect - and a finished, belt-clipped lodestone is a
   * manufactured article the yard is entitled to sell. 175 credits, which is
   * above both of the numbers it has to sit above: the 104 the raw two cubic
   * metres fetch out of the hold, and the 165 the purpose-built Vacuum Rune
   * costs - and the lodestone is the weaker of the two effects (20 s at 4.5 m
   * against 30 s at 5.5 m). So buying one is a convenience for a pilot who
   * never went to Cinder, and digging one out of the colonnade stays the cheap
   * way to have it. A shop row that undercut the mine would end the mine.
   *
   * `worlds: ['dock']`. Two independent reasons, and the row needs both:
   * `tools` is carried by a yard counter (the same one `pack_nav_chart` leans
   * on, asserted against `DockWorld` in dock-economy.test.mjs), and the yard is
   * the only place in the Nexus that refines Cinder ore at all. A row in a
   * world whose counters carry no `tools` is a purchase nobody can be shown.
   */
  {
    source_key: 'ore_lodestone',
    name: 'Ferro-Basalt Lodestone',
    description: 'A belt-clipped slab of magnetite basalt off Cinder, trimmed and cased in the yard. Pulls loose salvage to you for twenty seconds, then the field bleeds off.',
    category: 'tools' as const,
    image_label: 'LODE',
    image_color: '#4d5866',
    game_action: 'refined_ore' as MarketplaceActionId,
    action_config: { effect: 'grant_item', item_id: 'ferrobasalt', amount: 1 },
    quantity: null,
    cost_buy: 175,
    cost_sell: 70,
    pricing_kind: 'fixed' as const,
    sort_order: 58,
    worlds: ['dock'] as const,
  },

  {
    source_key: 'spell_stasis_5s',
    name: 'Stasis Rune',
    description: 'Spell consumable that pauses nearby NPC movement for 5 seconds.',
    category: 'spells' as const,
    image_label: 'PAUSE 5',
    image_color: '#ff7d3c',
    game_action: 'npc_pause_5s' as MarketplaceActionId,
    action_config: { effect: 'pause_npcs', seconds: 5, radius: 24 },
    quantity: null,
    cost_buy: 125,
    cost_sell: 55,
    pricing_kind: 'consumable' as const,
    sort_order: 60,
  },
  {
    source_key: 'spell_stasis_10s',
    name: 'Chrono Snare',
    description: 'Spell consumable that pauses nearby NPC movement for 10 seconds.',
    category: 'spells' as const,
    image_label: 'PAUSE 10',
    image_color: '#ff7d3c',
    game_action: 'npc_pause_10s' as MarketplaceActionId,
    action_config: { effect: 'pause_npcs', seconds: 10, radius: 26 },
    quantity: null,
    cost_buy: 190,
    cost_sell: 84,
    pricing_kind: 'consumable' as const,
    sort_order: 70,
  },
  {
    source_key: 'spell_stasis_30s',
    name: 'Time Lock Prism',
    description: 'Spell consumable that pauses nearby NPC movement for 30 seconds.',
    category: 'spells' as const,
    image_label: 'PAUSE 30',
    image_color: '#ff7d3c',
    game_action: 'npc_pause_30s' as MarketplaceActionId,
    action_config: { effect: 'pause_npcs', seconds: 30, radius: 28 },
    quantity: null,
    cost_buy: 360,
    cost_sell: 160,
    pricing_kind: 'consumable' as const,
    sort_order: 80,
  },
  {
    source_key: 'spell_stasis_60s',
    name: 'Temporal Vault Sigil',
    description: 'Spell consumable that pauses nearby NPC movement for 60 seconds.',
    category: 'spells' as const,
    image_label: 'PAUSE 60',
    image_color: '#ff7d3c',
    game_action: 'npc_pause_60s' as MarketplaceActionId,
    action_config: { effect: 'pause_npcs', seconds: 60, radius: 30 },
    quantity: null,
    cost_buy: 620,
    cost_sell: 275,
    pricing_kind: 'consumable' as const,
    sort_order: 90,
  },
  {
    source_key: 'spell_velocity_25',
    name: 'Fleetstep Spark',
    description: 'Spell consumable that boosts movement speed by 25% for 30 seconds.',
    category: 'spells' as const,
    image_label: 'SPD 25',
    image_color: '#4cc9ff',
    game_action: 'speed_boost_25' as MarketplaceActionId,
    action_config: { effect: 'modify_speed', percent: 25, seconds: 30 },
    quantity: null,
    cost_buy: 135,
    cost_sell: 60,
    pricing_kind: 'consumable' as const,
    sort_order: 100,
  },
  {
    source_key: 'spell_velocity_50',
    name: 'Rushline Glyph',
    description: 'Spell consumable that boosts movement speed by 50% for 30 seconds.',
    category: 'spells' as const,
    image_label: 'SPD 50',
    image_color: '#4cc9ff',
    game_action: 'speed_boost_50' as MarketplaceActionId,
    action_config: { effect: 'modify_speed', percent: 50, seconds: 30 },
    quantity: null,
    cost_buy: 195,
    cost_sell: 86,
    pricing_kind: 'consumable' as const,
    sort_order: 110,
  },
  {
    source_key: 'spell_velocity_75',
    name: 'Mach Surge Sigil',
    description: 'Spell consumable that boosts movement speed by 75% for 30 seconds.',
    category: 'spells' as const,
    image_label: 'SPD 75',
    image_color: '#4cc9ff',
    game_action: 'speed_boost_75' as MarketplaceActionId,
    action_config: { effect: 'modify_speed', percent: 75, seconds: 30 },
    quantity: null,
    cost_buy: 280,
    cost_sell: 124,
    pricing_kind: 'consumable' as const,
    sort_order: 120,
  },
  {
    source_key: 'spell_velocity_100',
    name: 'Velocity Crown',
    description: 'Spell consumable that doubles movement speed for 30 seconds.',
    category: 'spells' as const,
    image_label: 'SPD 100',
    image_color: '#4cc9ff',
    game_action: 'speed_boost_100' as MarketplaceActionId,
    action_config: { effect: 'modify_speed', percent: 100, seconds: 30 },
    quantity: null,
    cost_buy: 410,
    cost_sell: 184,
    pricing_kind: 'consumable' as const,
    sort_order: 130,
  },
  {
    source_key: 'spell_loot_grab_30',
    name: 'Vacuum Rune',
    description: 'Spell consumable that pulls nearby loot toward you for 30 seconds.',
    category: 'spells' as const,
    image_label: 'LOOT',
    image_color: '#7ce3a3',
    game_action: 'loot_magnet_30s' as MarketplaceActionId,
    action_config: { effect: 'loot_magnet', seconds: 30, radius: 30 },
    quantity: null,
    cost_buy: 165,
    cost_sell: 72,
    pricing_kind: 'consumable' as const,
    sort_order: 140,
  },
  {
    source_key: 'spell_portal_ping_30',
    name: 'Gatefinder Echo',
    description: 'Spell consumable that highlights the nearest portal for 30 seconds.',
    category: 'spells' as const,
    image_label: 'PING',
    image_color: '#b08bff',
    game_action: 'portal_ping_30s' as MarketplaceActionId,
    action_config: { effect: 'portal_ping', seconds: 30 },
    quantity: null,
    cost_buy: 155,
    cost_sell: 68,
    pricing_kind: 'consumable' as const,
    sort_order: 150,
  },
  /* The shield and firepower consumables.
   *
   * `ItemUse` has implemented all five for as long as `Marketplace`'s
   * `MARKETPLACE_CONSUMABLE_ITEMS` has mapped them, and no catalogue row ever
   * sold one - the effects existed and were unreachable. `source_key` here must
   * stay the bare mapping key: `consumableItemFor` probes the exact key and then
   * retries once with a trailing `:<world>` stripped, so a `spell_` prefix that
   * reads nicely next to the rows above would resolve to nothing and every
   * purchase would come back `reason: 'unsupported'`.
   */
  {
    source_key: 'shield_5s',
    name: 'Aegis Shard',
    description: 'Spell consumable that raises a damage shield for 5 seconds.',
    category: 'spells' as const,
    image_label: 'SHIELD',
    image_color: '#7dd8ff',
    game_action: 'shield_5s' as MarketplaceActionId,
    action_config: { effect: 'shield', seconds: 5 },
    quantity: null,
    cost_buy: 210,
    cost_sell: 92,
    pricing_kind: 'consumable' as const,
    sort_order: 160,
  },
  {
    source_key: 'firepower_boost_25',
    name: 'Firepower Sigil',
    description: 'Weapon consumable that boosts weapon damage by 25% for 30 seconds.',
    category: 'weapons' as const,
    image_label: 'PWR 25',
    image_color: '#ff8f2e',
    game_action: 'firepower_boost_25' as MarketplaceActionId,
    action_config: { effect: 'modify_firepower', percent: 25, seconds: 30 },
    quantity: null,
    cost_buy: 150,
    cost_sell: 66,
    pricing_kind: 'consumable' as const,
    sort_order: 170,
  },
  {
    source_key: 'firepower_boost_50',
    name: 'Firepower Talisman',
    description: 'Weapon consumable that boosts weapon damage by 50% for 30 seconds.',
    category: 'weapons' as const,
    image_label: 'PWR 50',
    image_color: '#ff8f2e',
    game_action: 'firepower_boost_50' as MarketplaceActionId,
    action_config: { effect: 'modify_firepower', percent: 50, seconds: 30 },
    quantity: null,
    cost_buy: 215,
    cost_sell: 95,
    pricing_kind: 'consumable' as const,
    sort_order: 171,
  },
  {
    source_key: 'firepower_boost_75',
    name: 'Firepower Seal',
    description: 'Weapon consumable that boosts weapon damage by 75% for 30 seconds.',
    category: 'weapons' as const,
    image_label: 'PWR 75',
    image_color: '#ff8f2e',
    game_action: 'firepower_boost_75' as MarketplaceActionId,
    action_config: { effect: 'modify_firepower', percent: 75, seconds: 30 },
    quantity: null,
    cost_buy: 305,
    cost_sell: 134,
    pricing_kind: 'consumable' as const,
    sort_order: 172,
  },
  {
    source_key: 'firepower_boost_100',
    name: 'Firepower Crown',
    description: 'Weapon consumable that doubles weapon damage for 30 seconds.',
    category: 'weapons' as const,
    image_label: 'PWR 100',
    image_color: '#ff8f2e',
    game_action: 'firepower_boost_100' as MarketplaceActionId,
    action_config: { effect: 'modify_firepower', percent: 100, seconds: 30 },
    quantity: null,
    cost_buy: 445,
    cost_sell: 196,
    pricing_kind: 'consumable' as const,
    sort_order: 173,
  },

  /* ==================================================================== */
  /* Damage-reduction wards                                               */
  /* ==================================================================== */
  /*
   * The defensive mirror of the four rows directly above, and they are placed
   * directly above deliberately: the shop's sort order is what a player reads
   * as "these go together", and the choice this family exists to offer is
   * exactly the choice between the sigil and the ward.
   *
   * ── THE GAP ─────────────────────────────────────────────────────────────
   * Four tiers of offence, four of mobility (`spell_velocity_*`), four of crowd
   * control (`spell_stasis_*`), and ONE defensive row - `shield_5s`, five
   * seconds of total immunity through `Player.grantIFrames`. Nothing between
   * nothing and invulnerable.
   *
   * ── THREE RUNGS, STOPPING AT HALF ───────────────────────────────────────
   * 20 / 35 / 50 per cent off, all 30 seconds, applied in `Player.applyDamage`
   * as a floored multiplier in the same shape as the mount Armour term already
   * there. There is no fourth rung because the fourth rung of a
   * damage-reduction ladder is 100% and `shield_5s` already sells it: a x0 ward
   * at six times the shard's duration would not be a rung, it would be the
   * shard deleted. Half is where a middle ground ends - exactly double
   * effective health - and `WARD_MUL_MIN` in `player/Player.js` is the hard
   * floor that stops a future rung, a save or a cheat going past it.
   *
   * The entry rung is 20 and not 25 because purchased mount Armour is 10% a
   * tier, and the cheapest ward has to be worth buying by a rider who already
   * owns some: the two compound.
   *
   * ── `spells`, LIKE THE SHARD, AND FOR THE SAME COUNTER ──────────────────
   * `shield_5s` is a `spells` row and this is the item a player buys INSTEAD of
   * it, so both have to be on the same shelf or the choice is not a choice.
   * That does mean the wards inherit the shard's reach: `spells` is carried in
   * the citadel, the vale and the yard, and station, sports and race declare
   * counters that do not stock it. That is the shard's existing footprint, not
   * a new restriction, and putting the wards anywhere else to widen it would
   * separate them from the row they are the alternative to.
   */
  {
    source_key: 'ward_20',
    name: 'Bulwark Ward',
    description: 'Spell consumable that reduces all damage taken by 20% for 30 seconds.',
    category: 'spells' as const,
    image_label: 'WARD 20',
    image_color: '#8ec2ea',
    game_action: 'ward_20' as MarketplaceActionId,
    action_config: { effect: 'modify_damage_taken', percent: 20, seconds: 30 },
    quantity: null,
    cost_buy: 160,
    cost_sell: 70,
    pricing_kind: 'consumable' as const,
    sort_order: 174,
  },
  {
    source_key: 'ward_35',
    name: 'Bastion Ward',
    description: 'Spell consumable that reduces all damage taken by 35% for 30 seconds.',
    category: 'spells' as const,
    image_label: 'WARD 35',
    image_color: '#8ec2ea',
    game_action: 'ward_35' as MarketplaceActionId,
    action_config: { effect: 'modify_damage_taken', percent: 35, seconds: 30 },
    quantity: null,
    cost_buy: 245,
    cost_sell: 108,
    pricing_kind: 'consumable' as const,
    sort_order: 175,
  },
  {
    source_key: 'ward_50',
    name: 'Adamant Ward',
    description: 'Spell consumable that halves all damage taken for 30 seconds.',
    category: 'spells' as const,
    image_label: 'WARD 50',
    image_color: '#8ec2ea',
    game_action: 'ward_50' as MarketplaceActionId,
    action_config: { effect: 'modify_damage_taken', percent: 50, seconds: 30 },
    quantity: null,
    cost_buy: 360,
    cost_sell: 158,
    pricing_kind: 'consumable' as const,
    sort_order: 176,
  },

  /* ==================================================================== */
  /* Stamina draughts                                                     */
  /* ==================================================================== */
  /*
   * Four rows against the one player resource that had nothing to buy for it.
   * Health has the Trauma Twin-Pack, all four weapons have ammunition, the bag
   * has three expansion rigs - and stamina, which gates the sprint, both
   * climbs, the mantle, the leap, the swim and the eagle's wingbeat, was sold
   * nothing at any counter in the Nexus.
   *
   * ── THE `source_key` IS THE MAPPING KEY, AND THAT IS NOT COSMETIC ───────
   * These four resolve through `MARKETPLACE_CONSUMABLE_ITEMS` in
   * `src/systems/Marketplace.js` the way every other timed ladder does, and
   * `consumableItemFor` probes the EXACT key before retrying without a trailing
   * `:<world>`. A prettier `spell_stamina_25` would resolve to nothing and every
   * purchase would return `reason: 'unsupported'` - the recorded step-7 failure
   * the shield and firepower rows carry the same warning about.
   *
   * ── `health`, AND THE ONE PLACE THAT COSTS SOMETHING ────────────────────
   * A draught is medicine, it lands beside the only other `health` row in the
   * file, and `health` is carried by counters in the station, the vale, the
   * citadel and the yard. Vellum Ridge is the exception - its single counter
   * carries `mounts` and `tools` - so a draught cannot be bought at the
   * circuit. That is the Trauma Twin-Pack's existing footprint exactly, not a
   * new hole, and filing medicine under `tools` to dodge it would be a lie
   * about what the item is in five worlds to fix one.
   *
   * ── THE PRICES, AND THE SHAPE OF THE TOP RUNG ──────────────────────────
   * 120 / 175 / 250 / 340, which sits just under the speed ladder's
   * 135 / 195 / 280 / 410 at every rung: a draught spends a resource down
   * rather than moving the player, and mobility is the more decisive purchase
   * of the two.
   *
   * The top rung is dearer per second than any of them, and deliberately: it
   * runs FIFTEEN seconds where the other three run thirty, because x0 does not
   * make exertion cheaper, it removes the resource. `ItemUse._effectFor` is
   * where that duration is derived (two full pools of unbroken sprint) and
   * where the alternative - arguing the top rung down to x0.1 - is rejected,
   * because the action id it is sold under is `stamina_slowdown_100`, whose
   * label above says "Stamina drain off".
   */
  {
    source_key: 'stamina_slowdown_25',
    name: 'Second Wind Draught',
    description: 'Field tonic that cuts the stamina cost of every exertion by 25% for 30 seconds.',
    category: 'health' as const,
    image_label: 'STAM 25',
    image_color: '#7cf0a8',
    game_action: 'stamina_slowdown_25' as MarketplaceActionId,
    action_config: { effect: 'modify_stamina_drain', percent: 25, seconds: 30 },
    quantity: null,
    cost_buy: 120,
    cost_sell: 52,
    pricing_kind: 'consumable' as const,
    sort_order: 190,
  },
  {
    source_key: 'stamina_slowdown_50',
    name: 'Longstride Draught',
    description: 'Field tonic that halves the stamina cost of every exertion for 30 seconds.',
    category: 'health' as const,
    image_label: 'STAM 50',
    image_color: '#7cf0a8',
    game_action: 'stamina_slowdown_50' as MarketplaceActionId,
    action_config: { effect: 'modify_stamina_drain', percent: 50, seconds: 30 },
    quantity: null,
    cost_buy: 175,
    cost_sell: 77,
    pricing_kind: 'consumable' as const,
    sort_order: 191,
  },
  {
    source_key: 'stamina_slowdown_75',
    name: 'Ironlung Draught',
    description: 'Field tonic that cuts the stamina cost of every exertion by 75% for 30 seconds.',
    category: 'health' as const,
    image_label: 'STAM 75',
    image_color: '#7cf0a8',
    game_action: 'stamina_slowdown_75' as MarketplaceActionId,
    action_config: { effect: 'modify_stamina_drain', percent: 75, seconds: 30 },
    quantity: null,
    cost_buy: 250,
    cost_sell: 110,
    pricing_kind: 'consumable' as const,
    sort_order: 192,
  },
  {
    source_key: 'stamina_slowdown_100',
    name: 'Wellspring Draught',
    description: 'Field tonic that stops stamina draining at all for 15 seconds. Half the window of the rungs below it, because nothing you do costs anything.',
    category: 'health' as const,
    image_label: 'STAM OFF',
    image_color: '#7cf0a8',
    game_action: 'stamina_slowdown_100' as MarketplaceActionId,
    action_config: { effect: 'modify_stamina_drain', percent: 100, seconds: 15 },
    quantity: null,
    cost_buy: 340,
    cost_sell: 150,
    pricing_kind: 'consumable' as const,
    sort_order: 193,
  },
  /* ==================================================================== */
  /* Bag expansion rigs                                                   */
  /* ==================================================================== */
  /*
   * Three rows that sell the one thing no other row in this file sells: the
   * SIZE OF THE BAG. Using one runs `Inventory.expandBag`, which raises the
   * bag's 30 starting slots towards a hard ceiling of 60.
   *
   * ── NO `worlds` ALLOWLIST, AND THAT IS CHECKED RATHER THAN ASSUMED ──────
   * The yard's five rows carry one because `ships` is stocked by exactly one
   * counter in the Nexus. `tools` is not like that: every medieval trade in
   * `TRADE` (Population.js) carries it, the citadel's Cosmetic counter carries
   * it, a yard counter carries it, and station, sports and race declare no
   * `vendorCategories` at all - which `Marketplace._readVendorCategories` reads
   * as a general trader stocking everything. So a `tools` row is reachable in
   * all six worlds, and restricting these would be inventing scarcity in a
   * thing that is not scarce: a rucksack.
   *
   * ── `pricing_kind: 'fixed'`, WHICH IS A BALANCE DECISION ────────────────
   * Not `consumable`. The regional consumable multipliers run from 0.7
   * (Meridian) to 1.45 (Sunspire), and a permanent, account-wide, irreversible
   * upgrade priced through them would mean the correct play is always to fly
   * to the athletics grounds and buy your entire bag at 30% off, once, forever.
   * Every other permanent grant in this file - liveries, mount upgrades, mount
   * skins - is `fixed` for exactly that reason, and these are more permanent
   * than any of them.
   *
   * ── THE PRICES, AND WHY THEY RISE FASTER THAN THE SLOTS ─────────────────
   * 480 / 1,150 / 2,100, which is 96, 115 and 140 credits a slot. Deliberately
   * super-linear: cost(15) is 2,100 against 3 x cost(5) = 1,440, so the big rig
   * is NOT a bulk discount.
   *
   * Two reasons, and the second is the load-bearing one.
   *
   * Slots are the most powerful thing in the catalogue. Everything else here is
   * consumed in thirty seconds or worn on a mount; a slot is carried for the
   * rest of the account's life and multiplies every ore run, every corpse and
   * every cache after it. Against `pack_medkit` at 95 and `mount_power_3` at
   * 820 - the dearest hand-authored row before these - the entry rung at 480 is
   * priced as a serious purchase and the top rung at 2,100 as the largest
   * single decision a player can make at a counter. Cheap capacity would end
   * the store, the drop tables' overflow rules and the whole reason
   * `inventory:full` exists.
   *
   * And a bulk DISCOUNT would collapse the ladder into one row. If two +15s
   * were the cheap route to 60 nobody would ever buy the other two, and the
   * request was explicitly for three items. What the big rigs sell instead is
   * time and bag space: one purchase, one three-second hold, and a stack size
   * (`ItemDefs.bagSlots` neighbours) sized so a full 30-slot upgrade always
   * fits in one bag slot whichever rung you buy. Six trips to a merchant is the
   * cheap way; two is the quick one. That is an honest trade, and it is the one
   * the player can see from the prices.
   *
   * `cost_sell` is 0.4 x `cost_buy`, the same ratio every `fixed` row uses, and
   * still an order of magnitude above what the game pays for the bag item
   * itself (`ItemDefs.value` x SELL_RATE = 48 / 116 / 210), so no buy-sell-buy
   * loop prints credits at any regional multiplier.
   */
  {
    source_key: 'bag_expand_5',
    name: 'Stowage Webbing',
    description: 'A coil of load-bearing webbing and five clip points, lashed across the back of a pack. Hold it in your bag to fit it: +5 bag slots, permanently. No bag holds more than 60.',
    category: 'tools' as const,
    image_label: 'WEB +5',
    image_color: '#7fa86a',
    game_action: 'bag_expand' as MarketplaceActionId,
    action_config: { effect: 'grant_item', item_id: 'bag_expand_5', amount: 1 },
    quantity: null,
    cost_buy: 480,
    cost_sell: 192,
    pricing_kind: 'fixed' as const,
    sort_order: 180,
  },
  {
    source_key: 'bag_expand_10',
    name: 'Expedition Harness',
    description: 'A frame harness with side panniers, cut for a long walk away from a counter. Hold it in your bag to fit it: +10 bag slots, permanently. No bag holds more than 60.',
    category: 'tools' as const,
    image_label: 'HRN +10',
    image_color: '#5f8f52',
    game_action: 'bag_expand' as MarketplaceActionId,
    action_config: { effect: 'grant_item', item_id: 'bag_expand_10', amount: 1 },
    quantity: null,
    cost_buy: 1150,
    cost_sell: 460,
    pricing_kind: 'fixed' as const,
    sort_order: 181,
  },
  {
    source_key: 'bag_expand_15',
    name: 'Quartermaster Rig',
    description: "The rig a supply officer wears to carry a squad's worth of everything at once. Hold it in your bag to fit it: +15 bag slots, permanently. No bag holds more than 60.",
    category: 'tools' as const,
    image_label: 'RIG +15',
    image_color: '#43703c',
    game_action: 'bag_expand' as MarketplaceActionId,
    action_config: { effect: 'grant_item', item_id: 'bag_expand_15', amount: 1 },
    quantity: null,
    cost_buy: 2100,
    cost_sell: 840,
    pricing_kind: 'fixed' as const,
    sort_order: 182,
  },

  {
    source_key: 'cosmetic_headgear_aurora',
    name: 'Aurora Racer Skin',
    description: 'Limited-edition character colourway — glacier teal with a cyan pulse. Equip from Esc → Character.',
    category: 'cosmetic' as const,
    image_label: 'AURORA',
    image_color: '#2fe0ff',
    game_action: 'cosmetic_char_skin' as MarketplaceActionId,
    action_config: { effect: 'unlock_cosmetic', kind: 'character', cosmetic_id: 'char_aurora' },
    quantity: null,
    cost_buy: 240,
    cost_sell: 96,
    pricing_kind: 'fixed' as const,
    sort_order: 200,
  },
  {
    source_key: 'cosmetic_shirt_trail',
    name: 'Midnight Ops Skin',
    description: 'Limited-edition character colourway — blacked-out kit with cold blue trim. Equip from Esc → Character.',
    category: 'cosmetic' as const,
    image_label: 'MIDNGHT',
    image_color: '#1f6fd0',
    game_action: 'cosmetic_char_skin' as MarketplaceActionId,
    action_config: { effect: 'unlock_cosmetic', kind: 'character', cosmetic_id: 'char_midnight' },
    quantity: null,
    cost_buy: 260,
    cost_sell: 104,
    pricing_kind: 'fixed' as const,
    sort_order: 210,
  },
  {
    source_key: 'cosmetic_pants_glide',
    name: 'Ember Vanguard Skin',
    description: 'Limited-edition character colourway — scorched charcoal and molten orange. Equip from Esc → Character.',
    category: 'cosmetic' as const,
    image_label: 'EMBER',
    image_color: '#ff6a3a',
    game_action: 'cosmetic_char_skin' as MarketplaceActionId,
    action_config: { effect: 'unlock_cosmetic', kind: 'character', cosmetic_id: 'char_ember' },
    quantity: null,
    cost_buy: 280,
    cost_sell: 112,
    pricing_kind: 'fixed' as const,
    sort_order: 220,
  },
  {
    source_key: 'cosmetic_skin_jade',
    name: 'Jade Sovereign Skin',
    description: 'Limited-edition character colourway — deep jade with a gold edge. Equip from Esc → Character.',
    category: 'cosmetic' as const,
    image_label: 'JADE',
    image_color: '#ffe14a',
    game_action: 'cosmetic_char_skin' as MarketplaceActionId,
    action_config: { effect: 'unlock_cosmetic', kind: 'character', cosmetic_id: 'char_jade' },
    quantity: null,
    cost_buy: 320,
    cost_sell: 128,
    pricing_kind: 'fixed' as const,
    sort_order: 230,
  },
  {
    source_key: 'cosmetic_skin_violet',
    name: 'Violet Mirage Skin',
    description: 'Limited-edition character colourway — twilight violet with a magenta spark. Equip from Esc → Character.',
    category: 'cosmetic' as const,
    image_label: 'VIOLET',
    image_color: '#ff3bd2',
    game_action: 'cosmetic_char_skin' as MarketplaceActionId,
    action_config: { effect: 'unlock_cosmetic', kind: 'character', cosmetic_id: 'char_violet' },
    quantity: null,
    cost_buy: 360,
    cost_sell: 144,
    pricing_kind: 'fixed' as const,
    sort_order: 240,
  },
  {
    source_key: 'cosmetic_car_neon',
    name: 'Neon Circuit Livery',
    description: 'Limited-edition car livery — magenta body with cyan rims. Apply from Esc → Customise mount while driving; one use, then yours to keep.',
    category: 'mounts' as const,
    image_label: 'NEON',
    image_color: '#ff3bd2',
    game_action: 'cosmetic_vehicle_skin' as MarketplaceActionId,
    action_config: { effect: 'grant_item', item_id: 'skin_car_neon' },
    quantity: null,
    cost_buy: 420,
    cost_sell: 168,
    pricing_kind: 'fixed' as const,
    sort_order: 400,
  },
  {
    source_key: 'cosmetic_car_inferno',
    name: 'Inferno Livery',
    description: 'Limited-edition car livery — race red with gold alloys. Apply from Esc → Customise mount while driving; one use, then yours to keep.',
    category: 'mounts' as const,
    image_label: 'INFERNO',
    image_color: '#c21f2f',
    game_action: 'cosmetic_vehicle_skin' as MarketplaceActionId,
    action_config: { effect: 'grant_item', item_id: 'skin_car_inferno' },
    quantity: null,
    cost_buy: 460,
    cost_sell: 184,
    pricing_kind: 'fixed' as const,
    sort_order: 410,
  },
  {
    source_key: 'cosmetic_car_phantom',
    name: 'Phantom Livery',
    description: 'Limited-edition car livery — stealth black with chalk-white wheels. Apply from Esc → Customise mount while driving; one use, then yours to keep.',
    category: 'mounts' as const,
    image_label: 'PHANTOM',
    image_color: '#0d0f12',
    game_action: 'cosmetic_vehicle_skin' as MarketplaceActionId,
    action_config: { effect: 'grant_item', item_id: 'skin_car_phantom' },
    quantity: null,
    cost_buy: 500,
    cost_sell: 200,
    pricing_kind: 'fixed' as const,
    sort_order: 420,
  },
  {
    source_key: 'cosmetic_car_toxic',
    name: 'Toxic Surge Livery',
    description: 'Limited-edition car livery — venom green over black rims. Apply from Esc → Customise mount while driving; one use, then yours to keep.',
    category: 'mounts' as const,
    image_label: 'TOXIC',
    image_color: '#18a86b',
    game_action: 'cosmetic_vehicle_skin' as MarketplaceActionId,
    action_config: { effect: 'grant_item', item_id: 'skin_car_toxic' },
    quantity: null,
    cost_buy: 540,
    cost_sell: 216,
    pricing_kind: 'fixed' as const,
    sort_order: 430,
  },
  {
    source_key: 'cosmetic_car_azure',
    name: 'Azure Bolt Livery',
    description: 'Limited-edition car livery — electric blue with silver alloys. Apply from Esc → Customise mount while driving; one use, then yours to keep.',
    category: 'mounts' as const,
    image_label: 'AZURE',
    image_color: '#1f6fd0',
    game_action: 'cosmetic_vehicle_skin' as MarketplaceActionId,
    action_config: { effect: 'grant_item', item_id: 'skin_car_azure' },
    quantity: null,
    cost_buy: 600,
    cost_sell: 240,
    pricing_kind: 'fixed' as const,
    sort_order: 440,
  },
  {
    source_key: 'mount_strength_1',
    name: 'Mount Strength I',
    description: 'Car upgrade: sharper acceleration off the line. Permanent, stacks with higher tiers.',
    category: 'mounts' as const,
    image_label: 'STR I',
    image_color: '#ff8a5c',
    game_action: 'mount_strength_1' as MarketplaceActionId,
    action_config: { effect: 'grant_mount_power', mount: 'car', power: 'strength', tier: 1 },
    quantity: null,
    cost_buy: 260,
    cost_sell: 104,
    pricing_kind: 'fixed' as const,
    sort_order: 300,
  },
  {
    source_key: 'mount_strength_2',
    name: 'Mount Strength II',
    description: 'Car upgrade: even sharper acceleration. Permanent, replaces tier I.',
    category: 'mounts' as const,
    image_label: 'STR II',
    image_color: '#ff8a5c',
    game_action: 'mount_strength_2' as MarketplaceActionId,
    action_config: { effect: 'grant_mount_power', mount: 'car', power: 'strength', tier: 2 },
    quantity: null,
    cost_buy: 460,
    cost_sell: 184,
    pricing_kind: 'fixed' as const,
    sort_order: 301,
  },
  {
    source_key: 'mount_strength_3',
    name: 'Mount Strength III',
    description: 'Car upgrade: maximum acceleration. Permanent, replaces tier II.',
    category: 'mounts' as const,
    image_label: 'STR III',
    image_color: '#ff8a5c',
    game_action: 'mount_strength_3' as MarketplaceActionId,
    action_config: { effect: 'grant_mount_power', mount: 'car', power: 'strength', tier: 3 },
    quantity: null,
    cost_buy: 720,
    cost_sell: 288,
    pricing_kind: 'fixed' as const,
    sort_order: 302,
  },
  {
    source_key: 'mount_shield_1',
    name: 'Mount Shield I',
    description: 'Car upgrade: reinforced chassis softens impacts. Permanent, stacks with higher tiers.',
    category: 'mounts' as const,
    image_label: 'SHLD I',
    image_color: '#5cc8ff',
    game_action: 'mount_shield_1' as MarketplaceActionId,
    action_config: { effect: 'grant_mount_power', mount: 'car', power: 'shield', tier: 1 },
    quantity: null,
    cost_buy: 280,
    cost_sell: 112,
    pricing_kind: 'fixed' as const,
    sort_order: 310,
  },
  {
    source_key: 'mount_shield_2',
    name: 'Mount Shield II',
    description: 'Car upgrade: heavier plating. Permanent, replaces tier I.',
    category: 'mounts' as const,
    image_label: 'SHLD II',
    image_color: '#5cc8ff',
    game_action: 'mount_shield_2' as MarketplaceActionId,
    action_config: { effect: 'grant_mount_power', mount: 'car', power: 'shield', tier: 2 },
    quantity: null,
    cost_buy: 500,
    cost_sell: 200,
    pricing_kind: 'fixed' as const,
    sort_order: 311,
  },
  {
    source_key: 'mount_shield_3',
    name: 'Mount Shield III',
    description: 'Car upgrade: maximum protection. Permanent, replaces tier II.',
    category: 'mounts' as const,
    image_label: 'SHLD III',
    image_color: '#5cc8ff',
    game_action: 'mount_shield_3' as MarketplaceActionId,
    action_config: { effect: 'grant_mount_power', mount: 'car', power: 'shield', tier: 3 },
    quantity: null,
    cost_buy: 780,
    cost_sell: 312,
    pricing_kind: 'fixed' as const,
    sort_order: 312,
  },
  {
    source_key: 'mount_power_1',
    name: 'Mount Power I',
    description: 'Car upgrade: higher top speed. Permanent, stacks with higher tiers.',
    category: 'mounts' as const,
    image_label: 'PWR I',
    image_color: '#b6ff5a',
    game_action: 'mount_power_1' as MarketplaceActionId,
    action_config: { effect: 'grant_mount_power', mount: 'car', power: 'power', tier: 1 },
    quantity: null,
    cost_buy: 300,
    cost_sell: 120,
    pricing_kind: 'fixed' as const,
    sort_order: 320,
  },
  {
    source_key: 'mount_power_2',
    name: 'Mount Power II',
    description: 'Car upgrade: even higher top speed. Permanent, replaces tier I.',
    category: 'mounts' as const,
    image_label: 'PWR II',
    image_color: '#b6ff5a',
    game_action: 'mount_power_2' as MarketplaceActionId,
    action_config: { effect: 'grant_mount_power', mount: 'car', power: 'power', tier: 2 },
    quantity: null,
    cost_buy: 520,
    cost_sell: 208,
    pricing_kind: 'fixed' as const,
    sort_order: 321,
  },
  {
    source_key: 'mount_power_3',
    name: 'Mount Power III',
    description: 'Car upgrade: maximum top speed. Permanent, replaces tier II.',
    category: 'mounts' as const,
    image_label: 'PWR III',
    image_color: '#b6ff5a',
    game_action: 'mount_power_3' as MarketplaceActionId,
    action_config: { effect: 'grant_mount_power', mount: 'car', power: 'power', tier: 3 },
    quantity: null,
    cost_buy: 820,
    cost_sell: 328,
    pricing_kind: 'fixed' as const,
    sort_order: 322,
  },
  ...MOUNT_SKIN_ROWS,
  ...MOUNT_UPGRADE_ROWS,
] as const;

export function buildMarketplaceSeedItems(): MarketplaceSeedItem[] {
  const out: MarketplaceSeedItem[] = [];
  for (const world of MARKETPLACE_WORLDS) {
    const multipliers = WORLD_PRICE_MULTIPLIERS[world];
    for (const item of BASE_ITEMS) {
      // Optional per-item world allowlist. Used: the yard's four ship-fitting
      // rows are stocked in 'dock' only.
      const allow = item.worlds;
      if (allow && !allow.includes(world)) continue;
      let buyMul = 1;
      let sellMul = 1;
      if (item.pricing_kind === 'ammo') {
        buyMul = multipliers.ammoBuy;
        sellMul = multipliers.ammoSell;
      } else if (item.pricing_kind === 'consumable') {
        buyMul = multipliers.consumableBuy;
        sellMul = multipliers.consumableSell;
      }
      out.push({
        source_key: `${item.source_key}:${world}`,
        name: item.name,
        description: item.description,
        category: item.category,
        image: buildMarketplaceAiImageUrl({
          name: item.name,
          description: item.description,
          category: item.category,
          world,
          sourceKey: `${item.source_key}:${world}`,
        }),
        game_action: item.game_action,
        action_config: item.action_config,
        quantity: item.quantity,
        cost_buy: Math.max(1, Math.round(item.cost_buy * buyMul)),
        cost_sell: Math.max(1, Math.round(item.cost_sell * sellMul)),
        world_name: world,
        sort_order: item.sort_order,
      });
    }
  }
  return out;
}
