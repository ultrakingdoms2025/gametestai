/**
 * Fetch every marketplace item's art ONCE and store the bytes in the database.
 *
 *   cd site && node scripts/bake-marketplace-art.mjs            # bake everything
 *   cd site && node scripts/bake-marketplace-art.mjs --limit 5  # try a few first
 *   cd site && node scripts/bake-marketplace-art.mjs --pause 1500
 *
 * Needs POSTGRES_URL, the same variable the site runs on:
 *   vercel env pull .env.local     (then this script reads it)
 *
 * ── Why this is a script and not part of a request ────────────────────────
 *
 * `marketplace_items.image` used to hold a text-to-image URL rather than a
 * picture, so every player opening a merchant asked a free public generator to
 * render the whole catalogue on the spot. Measured in a live session: 122
 * requests, 7 loaded, 115 refused - which is what "the images load and then
 * stop" was. The cure is to render each one once, here, and store the result.
 *
 * It cannot live on the request path: one network call per row against a
 * generator that takes seconds means a cold start would time out long before it
 * finished. So it is explicit, serial, and resumable - re-running it only
 * touches rows that still have no stored art, so an interrupted run costs
 * nothing and a failed row is simply retried next time.
 *
 * Expect this to take a while. It is rendering images.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, '..');

/* Load .env.local the way `next` would, so the script needs no extra dep. */
for (const name of ['.env.local', '.env']) {
  const file = join(site, name);
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, '');
    if (!process.env[m[1]]) process.env[m[1]] = value;
  }
}

if (!process.env.POSTGRES_URL) {
  console.error('POSTGRES_URL is not set. Run `vercel env pull .env.local` in site/ first.');
  process.exit(1);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
}

const limit = arg('limit', 100000);
const pauseMs = arg('pause', 750);

/* `--provider gateway` renders through Vercel's AI Gateway instead of the free
 * public endpoint. Measured on the same prompt: 1.6 s a render with no queue,
 * against ~37 s and a one-request-at-a-time limit per IP that a
 * catalogue-sized run turns into a cooldown nothing can wait out.
 *
 * It COSTS MONEY, which is why the free path stays the default and this is a
 * flag: nobody should spend by accident. Auth is the VERCEL_OIDC_TOKEN that
 * `vercel env pull` already writes - no key to manage - and it lasts about a
 * day, so re-pull before a long-delayed run. */
/* `--model` picks which gateway image model renders.
 *
 * Every image model on the gateway is rate-limited on the FREE tier - measured,
 * all five of `bfl/flux-pro-1.1`, `bfl/flux-2-klein-4b`, `bfl/flux-2-klein-9b`,
 * `bytedance/seedream-5.0-lite` and `meta/muse-image-1.0` refused with "Free
 * tier requests on this model are rate-limited" after a first small burst got
 * through. So this flag is not about taste, it is about price once credits are
 * on: the klein models are the cheap end of the same flux family and the pro
 * one is the expensive end, and 115 icons is a small enough job that either
 * costs a few dollars at most.
 *
 * Only models whose `modelType` is `image` work here; run
 * `gateway.getAvailableModels()` to see the current list. */
const modelArg = process.argv.indexOf('--model');
const model = modelArg === -1 ? undefined : String(process.argv[modelArg + 1] ?? '');

const providerArg = process.argv.indexOf('--provider');
const provider = providerArg === -1 ? 'pollinations' : String(process.argv[providerArg + 1] ?? '');
if (!['pollinations', 'gateway'].includes(provider)) {
  console.error(`Unknown --provider "${provider}". Use "pollinations" (free, slow) or "gateway" (paid, fast).`);
  process.exit(1);
}
if (provider === 'gateway' && !process.env.VERCEL_OIDC_TOKEN && !process.env.AI_GATEWAY_API_KEY) {
  console.error(
    'The gateway provider needs credentials. Run:\n  vercel env pull .env.local --yes\n' +
      '(or set AI_GATEWAY_API_KEY). The OIDC token expires after about a day.'
  );
  process.exit(1);
}

/* Imported through tsx/next's TS pipeline is overkill for one function; the
 * lib is plain TypeScript with no JSX, so `tsx` handles it if present and we
 * fall back to a clear message rather than a stack trace if it is not. */
let bakeMarketplaceArt;
try {
  ({ bakeMarketplaceArt } = await import('../lib/marketplaceDb.ts'));
} catch (err) {
  console.error(
    'Could not load lib/marketplaceDb.ts — run this with tsx:\n' +
      '  npx tsx scripts/bake-marketplace-art.mjs\n\n' +
      String(err?.message ?? err)
  );
  process.exit(1);
}

console.log(
  `Baking marketplace art via ${provider} (limit ${limit}, ${pauseMs}ms between rows)…`
);

const started = Date.now();
const result = await bakeMarketplaceArt({
  limit,
  pauseMs,
  provider,
  model,
  onProgress: (done, total, name, ok) => {
    const pct = String(Math.round((done / total) * 100)).padStart(3);
    console.log(`${pct}%  ${done}/${total}  ${ok ? 'baked ' : 'FAILED'}  ${name}`);
  },
});

const secs = Math.round((Date.now() - started) / 1000);
console.log(
  `\nDone in ${secs}s — ${result.items} images rendered, filling ${result.baked} rows` +
    ` (${result.failed} rows still unbaked, of ${result.total} attempted).`
);
if (result.failed) {
  console.log('Failed rows keep an empty image and show the placeholder. Re-run to retry them.');
}
process.exit(0);
