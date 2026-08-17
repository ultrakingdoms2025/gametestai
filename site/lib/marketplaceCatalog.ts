import { buildMarketplaceAiImageUrl } from './marketplaceImages';

export const MARKETPLACE_CATEGORIES = ['cosmetic', 'weapons', 'tools', 'health', 'spells', 'mounts'] as const;
export type MarketplaceCategory = (typeof MARKETPLACE_CATEGORIES)[number];

export const MARKETPLACE_WORLDS = ['station', 'medieval', 'sports', 'citadel', 'race'] as const;
export type MarketplaceWorld = (typeof MARKETPLACE_WORLDS)[number];

/* ---- Mount upgrades: shown in the F10 menu, applied by MountManager.grantPower ---- */

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
    description: 'Unlocks a limited-edition character colourway in the F2 customizer.',
    effect: 'unlock_cosmetic',
  },
  {
    id: 'cosmetic_vehicle_skin',
    label: 'Unlock vehicle skin',
    description: 'Grants a car skin item; apply it from the Mount menu (F10) while driving.',
    effect: 'grant_item',
  },
  {
    id: 'mount_skin',
    label: 'Mount skin',
    description: 'Grants a mount skin item; apply it from the Mount menu (F10) while riding.',
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
  description: `${s.desc} Apply from the Mount menu (F10) while riding; one use, then yours to keep.`,
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
  description: `${m.label} upgrade: ${POWER_META[p].blurb} tier ${tier}. Permanent, replaces a lower tier. See your tiers in the Mount menu (F10).`,
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
  {
    source_key: 'cosmetic_headgear_aurora',
    name: 'Aurora Racer Skin',
    description: 'Limited-edition character colourway — glacier teal with a cyan pulse. Equip in the F2 Character menu.',
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
    description: 'Limited-edition character colourway — blacked-out kit with cold blue trim. Equip in the F2 Character menu.',
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
    description: 'Limited-edition character colourway — scorched charcoal and molten orange. Equip in the F2 Character menu.',
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
    description: 'Limited-edition character colourway — deep jade with a gold edge. Equip in the F2 Character menu.',
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
    description: 'Limited-edition character colourway — twilight violet with a magenta spark. Equip in the F2 Character menu.',
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
    description: 'Limited-edition car livery — magenta body with cyan rims. Apply from the Mount menu (F10) while driving; one use, then yours to keep.',
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
    description: 'Limited-edition car livery — race red with gold alloys. Apply from the Mount menu (F10) while driving; one use, then yours to keep.',
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
    description: 'Limited-edition car livery — stealth black with chalk-white wheels. Apply from the Mount menu (F10) while driving; one use, then yours to keep.',
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
    description: 'Limited-edition car livery — venom green over black rims. Apply from the Mount menu (F10) while driving; one use, then yours to keep.',
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
    description: 'Limited-edition car livery — electric blue with silver alloys. Apply from the Mount menu (F10) while driving; one use, then yours to keep.',
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
      // Optional per-item world allowlist (currently unused; kept for future
      // world-specific stock).
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
