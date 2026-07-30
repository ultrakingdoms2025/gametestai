export const MARKETPLACE_CATEGORIES = ['cosmetic', 'weapons', 'tools', 'health', 'spells'] as const;
export type MarketplaceCategory = (typeof MARKETPLACE_CATEGORIES)[number];

export const MARKETPLACE_WORLDS = ['station', 'medieval', 'sports', 'citadel', 'race'] as const;
export type MarketplaceWorld = (typeof MARKETPLACE_WORLDS)[number];

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

const BASE_ITEMS = [
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
    source_key: 'cosmetic_headgear_aurora',
    name: 'Aurora Headgear',
    description: 'Cosmetic unlock for a high-vis headgear set (reserved for F2 customizer).',
    category: 'cosmetic' as const,
    image_label: 'HEAD',
    image_color: '#d46bff',
    game_action: 'cosmetic_headgear' as MarketplaceActionId,
    action_config: { effect: 'unlock_cosmetic', slot: 'headgear', cosmetic_id: 'aurora-headgear' },
    quantity: null,
    cost_buy: 240,
    cost_sell: 96,
    pricing_kind: 'fixed' as const,
    sort_order: 200,
  },
  {
    source_key: 'cosmetic_shirt_trail',
    name: 'Trailrunner Shirt',
    description: 'Cosmetic unlock for a shirt style (reserved for F2 customizer).',
    category: 'cosmetic' as const,
    image_label: 'SHIRT',
    image_color: '#d46bff',
    game_action: 'cosmetic_shirt' as MarketplaceActionId,
    action_config: { effect: 'unlock_cosmetic', slot: 'shirt', cosmetic_id: 'trailrunner-shirt' },
    quantity: null,
    cost_buy: 300,
    cost_sell: 120,
    pricing_kind: 'fixed' as const,
    sort_order: 210,
  },
  {
    source_key: 'cosmetic_pants_glide',
    name: 'Glidepath Pants',
    description: 'Cosmetic unlock for a pants style (reserved for F2 customizer).',
    category: 'cosmetic' as const,
    image_label: 'PANTS',
    image_color: '#d46bff',
    game_action: 'cosmetic_pants' as MarketplaceActionId,
    action_config: { effect: 'unlock_cosmetic', slot: 'pants', cosmetic_id: 'glidepath-pants' },
    quantity: null,
    cost_buy: 280,
    cost_sell: 110,
    pricing_kind: 'fixed' as const,
    sort_order: 220,
  },
] as const;

type PricingKind = 'ammo' | 'consumable' | 'fixed';

export function buildMarketplaceSeedItems(): MarketplaceSeedItem[] {
  const out: MarketplaceSeedItem[] = [];
  for (const world of MARKETPLACE_WORLDS) {
    const multipliers = WORLD_PRICE_MULTIPLIERS[world];
    for (const item of BASE_ITEMS) {
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
        image: makeIcon(item.image_label, item.image_color, world.toUpperCase().slice(0, 3)),
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

function makeIcon(label: string, fg: string, worldTag: string): string {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#0c1722"/>
          <stop offset="1" stop-color="#1c3144"/>
        </linearGradient>
      </defs>
      <rect width="128" height="128" rx="20" fill="url(#bg)"/>
      <rect x="14" y="14" width="100" height="100" rx="18" fill="none" stroke="${fg}" stroke-width="4"/>
      <text x="64" y="66" text-anchor="middle" font-size="20" font-family="Arial, sans-serif" font-weight="700" fill="${fg}">${label}</text>
      <text x="64" y="90" text-anchor="middle" font-size="12" font-family="Arial, sans-serif" font-weight="700" fill="#cfe6f2">${worldTag}</text>
    </svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}
