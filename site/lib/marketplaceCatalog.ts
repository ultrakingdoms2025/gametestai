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
    image: makeIcon('RIFLE', '#52e9ff'),
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
    image: makeIcon('BOW', '#ffd25e'),
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
    image: makeIcon('EMBER', '#ff9b3c'),
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
    image: makeIcon('MED', '#b6ff5a'),
    game_action: 'heal_50' as MarketplaceActionId,
    action_config: { effect: 'restore_health', amount: 50 },
    quantity: null,
    cost_buy: 95,
    cost_sell: 36,
    pricing_kind: 'consumable' as const,
    sort_order: 40,
  },
] as const;

type PricingKind = 'ammo' | 'consumable';

export function buildMarketplaceSeedItems(): MarketplaceSeedItem[] {
  const out: MarketplaceSeedItem[] = [];
  for (const world of MARKETPLACE_WORLDS) {
    const multipliers = WORLD_PRICE_MULTIPLIERS[world];
    for (const item of BASE_ITEMS) {
      const buyMul = item.pricing_kind === 'ammo' ? multipliers.ammoBuy : multipliers.consumableBuy;
      const sellMul = item.pricing_kind === 'ammo' ? multipliers.ammoSell : multipliers.consumableSell;
      out.push({
        source_key: `${item.source_key}:${world}`,
        name: item.name,
        description: item.description,
        category: item.category,
        image: item.image,
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

function makeIcon(label: string, fg: string): string {
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
      <text x="64" y="73" text-anchor="middle" font-size="24" font-family="Arial, sans-serif" font-weight="700" fill="${fg}">${label}</text>
    </svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}
