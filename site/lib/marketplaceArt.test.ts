/**
 * Art is STORED, never generated on demand.
 *
 * `marketplace_items.image` held a text-to-image URL for the whole catalogue,
 * so opening a merchant asked a free public generator to render 122 images on
 * the spot. Measured in a live session: 7 loaded, 115 refused, and which ones
 * differed per player and per visit. The player-visible symptom was "the images
 * load the first few and then they stop".
 *
 * These pin the three things that keep it from coming back: the seed does not
 * carry a recipe, the column refuses one, and a bake stores bytes or nothing.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  ART_GENERATOR_HOST,
  MARKETPLACE_ART_SIZE,
  buildMarketplaceAiImageUrl,
  isGeneratedArtUrl,
} from './marketplaceImages';
import { fetchMarketplaceArtDataUri } from './marketplaceArtServer';
import { buildMarketplaceSeedItems } from './marketplaceCatalog';

const A_RECIPE = buildMarketplaceAiImageUrl({
  name: 'Fleetstep Spark',
  category: 'spells',
  world: 'station',
});

describe('the seed catalogue', () => {
  it('never ships a generator URL as an item image', () => {
    const seeded = buildMarketplaceSeedItems();
    expect(seeded.length).toBeGreaterThan(50);

    const recipes = seeded.filter((i) => isGeneratedArtUrl(String(i.image ?? '')));
    expect(
      recipes.map((r) => r.name).slice(0, 5),
      'a seeded recipe is re-written into every row on each cold start'
    ).toEqual([]);
  });
});

describe('isGeneratedArtUrl', () => {
  it('recognises the generator, and nothing else', () => {
    expect(isGeneratedArtUrl(A_RECIPE)).toBe(true);
    expect(isGeneratedArtUrl(`https://${ART_GENERATOR_HOST}/prompt/x`)).toBe(true);

    expect(isGeneratedArtUrl('')).toBe(false);
    expect(isGeneratedArtUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(false);
    expect(isGeneratedArtUrl('https://cdn.example.com/sword.png')).toBe(false);
    // Must not be fooled by the host appearing somewhere other than the host.
    expect(isGeneratedArtUrl(`https://evil.example/?u=${ART_GENERATOR_HOST}`)).toBe(false);
    expect(isGeneratedArtUrl('not a url at all')).toBe(false);
  });
});

describe('the generated-art URL', () => {
  it('asks for an icon-sized image, not a poster', () => {
    /* The art cell draws at 72 CSS px. 512 was up to 7x what any screen shows
     * and every byte of it was paid for on the way into the database. */
    expect(MARKETPLACE_ART_SIZE).toBeLessThanOrEqual(256);
    const u = new URL(A_RECIPE);
    expect(u.searchParams.get('width')).toBe(String(MARKETPLACE_ART_SIZE));
    expect(u.searchParams.get('height')).toBe(String(MARKETPLACE_ART_SIZE));
  });

  it('is stable for a row, so a re-bake yields the same art', () => {
    const once = buildMarketplaceAiImageUrl({
      name: 'X', category: 'tools', world: 'station', sourceKey: 'k',
    });
    const twice = buildMarketplaceAiImageUrl({
      name: 'X', category: 'tools', world: 'station', sourceKey: 'k',
    });
    expect(once).toBe(twice);
    expect(new URL(once).searchParams.get('seed')).toBeTruthy();
  });
});

describe('fetchMarketplaceArtDataUri', () => {
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ok = (body: Uint8Array, type = 'image/png') =>
    vi.fn(async () =>
      new Response(body as unknown as BodyInit, { status: 200, headers: { 'content-type': type } })
    ) as unknown as typeof fetch;

  it('returns a data URI carrying the bytes', async () => {
    const out = await fetchMarketplaceArtDataUri('https://x/y', { fetchImpl: ok(png) });
    expect(out).toBe(`data:image/png;base64,${Buffer.from(png).toString('base64')}`);
  });

  it('refuses a non-image, so an error page is never stored as art', async () => {
    /* The generator answers HTML when it is rate-limiting. Storing that would
     * put a permanently broken image in the database for every player. */
    const html = ok(new TextEncoder().encode('<html>rate limited</html>'), 'text/html');
    expect(await fetchMarketplaceArtDataUri('https://x/y', { fetchImpl: html })).toBeNull();
  });

  /* Never actually wait in a test - the real backoff is 15 s and doubling. */
  const noSleep = async () => {};

  it('gives up on a refusal that will not change', async () => {
    const gone = vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    expect(
      await fetchMarketplaceArtDataUri('https://x/y', { fetchImpl: gone, sleep: noSleep })
    ).toBeNull();
    expect(gone, 'a 404 is permanent — retrying it only lengthens the run').toHaveBeenCalledTimes(1);
  });

  it('RETRIES a throttle instead of recording it as a failed row', async () => {
    /* The generator admits one request at a time per IP and answers 429 in
     * ~370 ms. Treating that as failure marched through the whole catalogue in
     * seconds marking every row failed - which is what the first full run did. */
    let n = 0;
    const throttled = vi.fn(async () => {
      n += 1;
      return n < 3
        ? new Response('{"error":"Too Many Requests"}', { status: 429 })
        : new Response(png as unknown as BodyInit, {
            status: 200,
            headers: { 'content-type': 'image/png' },
          });
    }) as unknown as typeof fetch;

    const out = await fetchMarketplaceArtDataUri('https://x/y', {
      fetchImpl: throttled,
      sleep: noSleep,
    });
    expect(out, 'the third attempt succeeded, so the row is baked').toBeTruthy();
    expect(throttled).toHaveBeenCalledTimes(3);
  });

  it('reports WHY it failed, so a throttle is not mistaken for a broken row', async () => {
    const seen: string[] = [];
    const throttled = vi.fn(async () => new Response('', { status: 429 })) as unknown as typeof fetch;
    await fetchMarketplaceArtDataUri('https://x/y', {
      fetchImpl: throttled,
      sleep: noSleep,
      throttleRetries: 2,
      onAttempt: ({ reason }) => seen.push(reason),
    });
    expect(seen).toEqual(['throttled', 'throttled']);
  });

  it('waits longer than a render before retrying a throttle, and does not double', async () => {
    /* The queue admits one request at a time and a render takes ~37 s. A wait
     * SHORTER than that sends the next attempt into a slot still occupied by
     * the previous generation, so a run collides with itself and 429s from the
     * first item to the last with nothing else on the network. That is exactly
     * what a 15 s backoff did. Doubling from a correct base is also wrong here:
     * it reaches half-hour sleeps over a queue that is merely busy. */
    const waits: number[] = [];
    const throttled = vi.fn(async () => new Response('', { status: 429 })) as unknown as typeof fetch;
    await fetchMarketplaceArtDataUri('https://x/y', {
      fetchImpl: throttled,
      throttleRetries: 4,
      sleep: async (ms: number) => {
        waits.push(ms);
      },
    });
    expect(waits.every((w) => w >= 40_000), `waits were ${waits}`).toBe(true);
    expect(new Set(waits).size, 'a throttle wait is flat, not exponential').toBe(1);
  });

  it('a busy queue does not consume the budget meant for real errors', async () => {
    /* Sharing one budget meant a slow queue exhausted the retries and the row
     * was recorded failed when nothing was wrong with it. */
    let n = 0;
    const thenOk = vi.fn(async () => {
      n += 1;
      return n <= 6
        ? new Response('', { status: 429 })
        : new Response(png as unknown as BodyInit, {
            status: 200,
            headers: { 'content-type': 'image/png' },
          });
    }) as unknown as typeof fetch;

    const out = await fetchMarketplaceArtDataUri('https://x/y', {
      fetchImpl: thenOk,
      sleep: noSleep,
      retries: 2, // the ERROR budget, which six throttles must not spend
    });
    expect(out, 'six throttles then success must bake the row').toBeTruthy();
  });

  it('refuses an empty body and an oversized one', async () => {
    expect(
      await fetchMarketplaceArtDataUri('https://x/y', { fetchImpl: ok(new Uint8Array(0)) })
    ).toBeNull();
    expect(
      await fetchMarketplaceArtDataUri('https://x/y', {
        fetchImpl: ok(new Uint8Array(64)),
        maxBytes: 8,
      })
    ).toBeNull();
  });

  it('returns null rather than throwing when the fetch fails', async () => {
    /* A row that cannot be baked keeps its empty image and is retried. A bake
     * that threw would abort the whole run partway through the catalogue. */
    const boom = vi.fn(async () => {
      throw new Error('network');
    }) as unknown as typeof fetch;
    await expect(
      fetchMarketplaceArtDataUri('https://x/y', { fetchImpl: boom, sleep: noSleep, retries: 2 })
    ).resolves.toBeNull();
  });
});
