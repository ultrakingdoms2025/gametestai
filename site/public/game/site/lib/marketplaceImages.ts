import type { MarketplaceCategory, MarketplaceWorld } from './marketplaceCatalog';

type MarketplaceImageInput = {
  name: string;
  description?: string;
  category: MarketplaceCategory;
  world: MarketplaceWorld;
  sourceKey?: string;
};

function cleanPromptText(value: string, max = 90): string {
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^a-zA-Z0-9 ,.'-]/g, '')
    .slice(0, max);
}

function hashSeed(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash || 1;
}

export function buildMarketplaceImagePrompt(input: MarketplaceImageInput): string {
  const name = cleanPromptText(input.name || 'Marketplace item', 70);
  const description = cleanPromptText(input.description || '', 120);
  const category = cleanPromptText(input.category, 40);
  const world = cleanPromptText(input.world, 40);
  const descriptionPart = description ? `, ${description}` : '';
  return `${name}${descriptionPart}, ${category} item for ${world} world, fantasy sci-fi game inventory icon, centered object, dramatic lighting, detailed digital art, transparent or dark neutral background, no text, no letters, no words, no watermark`;
}

export function buildMarketplaceAiImageUrl(input: MarketplaceImageInput): string {
  const prompt = buildMarketplaceImagePrompt(input);
  const seedSource = input.sourceKey || `${input.name}:${input.category}:${input.world}`;
  const seed = hashSeed(seedSource);
  const params = new URLSearchParams({
    model: 'flux',
    width: '512',
    height: '512',
    nologo: 'true',
    enhance: 'true',
    safe: 'true',
    seed: String(seed),
  });
  return `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params.toString()}`;
}

export function isLegacyTextImage(value: string): boolean {
  const raw = (value || '').trim().toLowerCase();
  return raw.startsWith('data:image/svg+xml');
}

