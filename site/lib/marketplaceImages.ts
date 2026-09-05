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
 * Shrink a stored picture to what the panel actually draws.
 *
 * ── The measurement that made this necessary ──────────────────────────────
 *
 * `.mkt-art` renders at 72 CSS px. The generators return far more than that -
 * flux answers ~200 KB unconstrained, and ~40 KB even with `size` set, because
 * `size` only steers its aspect ratio (the SDK says so out loud: "The feature
 * size is not supported. Deriving aspect_ratio from size"). Stored per row and
 * base64'd, that measured 48 KB a row, 32.3 MB across the catalogue, and
 * **7.0 MB shipped to the browser to open the dock merchant** - for icons drawn
 * at 72 px. That is a worse deal for a player on a slow link than the broken
 * images this whole thread started with.
 *
 * 192 px covers a 2x display for a 72 px cell with room over, and WebP at 80 is
 * indistinguishable at that size. Measured, it takes a 40 KB JPEG to roughly
 * 6 KB - so a world's worth of art goes from ~7 MB to ~1 MB.
 *
 * ── Why it is a separate step, and why failure is not fatal ───────────────
 *
 * It runs on BYTES, not on a generator, so it re-compresses art that is already
 * in the database without spending anything: the fix for the 702 rows baked at
 * full size costs no credits and no renders. And if `sharp` is unavailable in
 * some environment, the original is returned unchanged - a large picture is
 * worse than a small one and better than none.
 */
export async function downscaleArtDataUri(
  dataUri: string,
  { size = 192, quality = 80 }: { size?: number; quality?: number } = {}
): Promise<string> {
  const comma = dataUri.indexOf(',');
  if (!dataUri.startsWith('data:image/') || comma === -1) return dataUri;
  try {
    const { default: sharp } = await import('sharp');
    const input = Buffer.from(dataUri.slice(comma + 1), 'base64');
    const out = await sharp(input)
      .resize(size, size, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality })
      .toBuffer();
    /* Never trade up. A tiny source can compress LARGER as WebP, and a rewrite
     * that grows the row is the opposite of the point. */
    if (out.byteLength >= input.byteLength) return dataUri;
    return `data:image/webp;base64,${out.toString('base64')}`;
  } catch {
    return dataUri;
  }
}

/**
 * The image model used when baking through Vercel's AI Gateway.
 *
 * `bfl/flux-*` on purpose: the original catalogue art was generated by
 * pollinations with `model=flux`, so staying on the same family keeps the
 * already-baked rows and the newly baked ones looking like one set. Measured
 * through the gateway, same prompt: `bfl/flux-pro-1.1` 1.6 s,
 * `bfl/flux-2-klein-4b` 3.0 s - against ~37 s and a one-at-a-time queue on the
 * free public endpoint.
 *
 * Chosen from `gateway.getAvailableModels()` rather than memory; the ones whose
 * `modelType` is `image` are the ones `experimental_generateImage` accepts. The
 * `google/gemini-*-image` slugs look right and are NOT - they are language
 * models that happen to return images, and the gateway rejects them here with
 * "is a language model, not an image model".
 */
export const GATEWAY_ART_MODEL = 'bfl/flux-pro-1.1';

/**
 * Render an item's art through Vercel's AI Gateway.
 *
 * ── Why a second provider exists at all ───────────────────────────────────
 *
 * The free generator admits ONE request at a time per IP, and a catalogue-sized
 * run earns a cooldown that outlasts any backoff worth writing - measured, a
 * whole run refused from the first item to the last with nothing else on the
 * network. That is not a bug to fix, it is what an unmetered public service
 * owes you. The gateway is the paid path: no queue, ~1.6 s a render, and it is
 * plain HTTP so the bake script can drive it.
 *
 * Auth is `VERCEL_OIDC_TOKEN`, which `vercel env pull` already writes and the
 * SDK reads on its own - no key to manage, and nothing to leak into a URL. It
 * expires in about a day, so a long-idle checkout re-pulls before baking.
 *
 * Returns null on failure, exactly like the free path, so `bakeMarketplaceArt`
 * treats both the same: a row that cannot be baked keeps its empty image and is
 * retried by the next run.
 */
export async function generateArtViaGateway(
  prompt: string,
  {
    model = GATEWAY_ART_MODEL,
    size = `${MARKETPLACE_ART_SIZE}x${MARKETPLACE_ART_SIZE}`,
    maxBytes = MAX_ART_BYTES,
    onAttempt,
  }: {
    model?: string;
    size?: string;
    maxBytes?: number;
    onAttempt?: (info: { attempt: number; status: number | null; reason: string }) => void;
  } = {}
): Promise<string | null> {
  try {
    const { experimental_generateImage: generateImage } = await import('ai');
    const res = await generateImage({ model, prompt, size: size as `${number}x${number}` });
    const image = res.images?.[0];
    const bytes = image?.uint8Array;
    if (!bytes?.length) {
      onAttempt?.({ attempt: 1, status: 200, reason: 'gateway returned no image' });
      return null;
    }
    if (bytes.length > maxBytes) {
      onAttempt?.({ attempt: 1, status: 200, reason: `too large (${bytes.length}B)` });
      return null;
    }
    const type = image.mediaType || 'image/jpeg';
    /* Shrunk before it is ever stored — see `downscaleArtDataUri` for the
     * 7 MB-per-world measurement that made this mandatory rather than nice. */
    return downscaleArtDataUri(`data:${type};base64,${Buffer.from(bytes).toString('base64')}`);
  } catch (err) {
    const e = err as { statusCode?: number; message?: string };
    onAttempt?.({
      attempt: 1,
      status: e?.statusCode ?? null,
      /* 402 is a spent budget and 401 an expired OIDC token - both are things
       * the operator must act on, so they are named rather than folded into a
       * generic failure the run would silently retry past. */
      reason:
        e?.statusCode === 402
          ? 'gateway budget exhausted'
          : e?.statusCode === 401
            ? 'gateway auth expired — re-run: vercel env pull .env.local'
            : `gateway: ${String(e?.message ?? err).slice(0, 120)}`,
    });
    return null;
  }
}

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
  {
    timeoutMs = 90_000,
    maxBytes = MAX_ART_BYTES,
    fetchImpl = fetch,
    retries = 5,
    /**
     * A THROTTLE WAIT MUST OUTLAST A GENERATION, or the run fights itself.
     *
     * The queue admits one request at a time per IP and a render takes ~37 s
     * measured. A 15 s backoff therefore sent the next attempt while the slot
     * was still occupied by a generation - our own, or one a previous run
     * abandoned when its client timed out - so every retry was refused on
     * arrival and a whole run could 429 from the first item to the last with
     * nothing else on the network. The wait has to clear a render, not a
     * round trip.
     */
    backoffMs = 60_000,
    /**
     * Throttling is not failure, so it gets its own, much larger budget.
     *
     * A 404 is answered once and believed. A 429 only means "not yet": the
     * queue drains on its own and the only cost of waiting is time on a job
     * that is already long and unattended. Sharing one small budget between
     * the two meant a busy queue exhausted the retries meant for real errors
     * and the row was recorded as failed when nothing was wrong with it.
     */
    throttleRetries = 20,
    onAttempt,
    sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  }: {
    timeoutMs?: number;
    maxBytes?: number;
    fetchImpl?: typeof fetch;
    retries?: number;
    backoffMs?: number;
    throttleRetries?: number;
    onAttempt?: (info: { attempt: number; status: number | null; reason: string }) => void;
    sleep?: (ms: number) => Promise<unknown>;
  } = {}
): Promise<string | null> {
  /* RETRY ON A THROTTLE, GIVE UP ON A REFUSAL.
   *
   * The generator admits exactly ONE request at a time per IP and answers 429
   * with "Queue full for IP ... 1 requests already queued (max: 1)" the instant
   * a second arrives - or when a sustained run has earned a cooldown. Measured:
   * a throttled request comes back in ~370 ms, so a bake that treats 429 as
   * failure marches through the whole catalogue in seconds marking every row
   * failed, which is exactly what it looked like.
   *
   * 429 and 5xx are TEMPORARY and worth waiting out; a 404 or a non-image is
   * not, and retrying it only lengthens the run. The wait doubles each time
   * because the queue clears on its own schedule, not ours.
   */
  let throttleSpent = 0;
  let errorSpent = 0;
  for (let attempt = 1; attempt <= retries + throttleRetries; attempt += 1) {
    let status: number | null = null;
    let reason = 'unknown';
    try {
      /* THE KEY GOES IN A HEADER, NEVER IN THE URL.
       *
       * The generator accepts either `?token=` or a bearer header - both
       * measured working - and the header is the one that cannot leak. These
       * URLs are logged by the bake, and an earlier version of this very
       * feature wrote generator URLs into a database column that the game then
       * served to every player. A token in the query string would have followed
       * it there.
       *
       * Without a key the public queue admits ONE request at a time per IP and
       * a sustained run earns a cooldown; with one, the same render measured
       * 2.4 s against 37 s. Optional on purpose: no key still works, just
       * slowly, so nothing here depends on a secret existing. */
      const token = process.env.POLLINATIONS_API_KEY?.trim();
      const res = await fetchImpl(url, {
        signal: AbortSignal.timeout(timeoutMs),
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      });
      status = res.status;
      if (res.ok) {
        const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!type.startsWith('image/')) {
          onAttempt?.({ attempt, status, reason: `not an image (${type || 'no type'})` });
          return null;
        }
        const buf = new Uint8Array(await res.arrayBuffer());
        if (!buf.byteLength || buf.byteLength > maxBytes) {
          onAttempt?.({ attempt, status, reason: `bad size (${buf.byteLength}B)` });
          return null;
        }
        return `data:${type};base64,${Buffer.from(buf).toString('base64')}`;
      }
      reason = res.status === 429 ? 'throttled' : `http ${res.status}`;
    } catch (err) {
      reason = String((err as Error)?.name === 'TimeoutError' ? 'timeout' : 'network');
    }

    const throttled = status === 429;
    const retryable = throttled || status === null || status >= 500;
    onAttempt?.({ attempt, status, reason });
    if (!retryable) return null;

    /* A throttle spends the throttle budget, an error spends the error one, and
     * neither drains the other - see `throttleRetries`. The wait does NOT
     * double for a throttle: `backoffMs` is already sized to outlast a render,
     * and doubling from there reaches half-hour sleeps on a job whose only
     * problem is that a queue is busy. Errors still back off exponentially,
     * because a failing server wants to be left alone. */
    if (throttled) {
      throttleSpent += 1;
      if (throttleSpent >= throttleRetries) return null;
      await sleep(backoffMs);
      continue;
    }
    errorSpent += 1;
    if (errorSpent >= retries) return null;
    await sleep(backoffMs * 2 ** (errorSpent - 1));
  }
  return null;
}

export function isLegacyTextImage(value: string): boolean {
  const raw = (value || '').trim().toLowerCase();
  return raw.startsWith('data:image/svg+xml');
}

