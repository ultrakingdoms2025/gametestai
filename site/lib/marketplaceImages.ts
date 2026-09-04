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

/** The generator's host. Used to recognise a recipe stored where art belongs. */
export const ART_GENERATOR_HOST = 'image.pollinations.ai';

/**
 * Pixels asked of the generator.
 *
 * The art cell draws at 72 CSS px (`.mkt-art`), so 512 was between 3x and 7x
 * more than any screen shows and every one of those bytes was paid for on the
 * way into the database. 256 still covers a 2x display with room over.
 */
export const MARKETPLACE_ART_SIZE = 256;

/**
 * The URL that GENERATES an item's art. This is a recipe, not a picture.
 *
 * Storing one of these in `marketplace_items.image` is what put a text-to-image
 * request on the critical path of the store: every player opening a merchant
 * asked this host to run Flux 122 times, and it rate-limited them - measured in
 * a live session, 7 of 122 images loaded and 115 failed. Fetch it ONCE with
 * `fetchMarketplaceArtDataUri` and store the result; see `bakeMarketplaceArt`.
 */
export function buildMarketplaceAiImageUrl(
  input: MarketplaceImageInput,
  { size = MARKETPLACE_ART_SIZE }: { size?: number } = {}
): string {
  const prompt = buildMarketplaceImagePrompt(input);
  const seedSource = input.sourceKey || `${input.name}:${input.category}:${input.world}`;
  const seed = hashSeed(seedSource);
  const params = new URLSearchParams({
    model: 'flux',
    width: String(size),
    height: String(size),
    nologo: 'true',
    enhance: 'true',
    safe: 'true',
    seed: String(seed),
  });
  return `https://${ART_GENERATOR_HOST}/prompt/${encodeURIComponent(prompt)}?${params.toString()}`;
}

/**
 * Is this value a generator recipe rather than a stored picture?
 *
 * The guard that keeps the defect from coming back: nothing may write one of
 * these into the `image` column, and `marketplaceDb` asserts it on the way in.
 */
export function isGeneratedArtUrl(value: string): boolean {
  const raw = (value || '').trim().toLowerCase();
  if (!raw.startsWith('http')) return false;
  try {
    return new URL(raw).host === ART_GENERATOR_HOST;
  } catch {
    return false;
  }
}

/** Ceiling on a single stored image. `normalizeImage` accepts 2 MB of TEXT. */
export const MAX_ART_BYTES = 400_000;

/**
 * Fetch a generated image once and return it as a `data:` URI.
 *
 * Everything here is a bound, because this runs against a free public
 * generator that is slow by nature - it is rendering an image, not serving a
 * file - and a bake must never hang a caller:
 *
 *   * a timeout, because the generator can simply not answer;
 *   * a content-type check, so an HTML error page is never stored as if it
 *     were a picture (it would render as a broken image forever, in the
 *     database, for every player);
 *   * a byte ceiling well under `normalizeImage`'s 2 MB TEXT limit, so one
 *     unusually large image cannot bloat every catalogue read that follows.
 *
 * Returns null on any failure rather than throwing: a row that cannot be baked
 * today keeps its empty image, shows the placeholder the UI already draws, and
 * is retried by the next run. A failed bake must never be recorded as success.
 */
export async function fetchMarketplaceArtDataUri(
  url: string,
  { timeoutMs = 90_000, maxBytes = MAX_ART_BYTES, fetchImpl = fetch }: {
    timeoutMs?: number;
    maxBytes?: number;
    fetchImpl?: typeof fetch;
  } = {}
): Promise<string | null> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!type.startsWith('image/')) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!buf.byteLength || buf.byteLength > maxBytes) return null;
    return `data:${type};base64,${Buffer.from(buf).toString('base64')}`;
  } catch {
    return null;
  }
}

export function isLegacyTextImage(value: string): boolean {
  const raw = (value || '').trim().toLowerCase();
  return raw.startsWith('data:image/svg+xml');
}

