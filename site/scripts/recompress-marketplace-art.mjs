/**
 * Shrink marketplace art that is already in the database. Spends nothing.
 *
 *   cd site && npx tsx scripts/recompress-marketplace-art.mjs
 *
 * The bake stored whatever the generator returned. Flux returns far more than a
 * 72 px cell needs — measured at 48 KB a row, 32.3 MB across the catalogue, and
 * 7.0 MB to open the dock merchant. This re-encodes those bytes to 192 px WebP,
 * which is indistinguishable at the size the panel draws and roughly six times
 * smaller.
 *
 * It touches no generator, so it costs no credits and no renders: the rows
 * already baked at full size are fixed for free. Resumable — each row is
 * written as it is done, and a re-run only finds what is still oversized.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const name of ['.env.local', '.env']) {
  const file = join(site, name);
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
if (!process.env.POSTGRES_URL) {
  console.error('POSTGRES_URL is not set. Run `vercel env pull .env.local` in site/ first.');
  process.exit(1);
}

const { recompressMarketplaceArt } = await import('../lib/marketplaceDb.ts');

console.log('Re-compressing stored marketplace art (no generator, no credits)…');
const r = await recompressMarketplaceArt({
  onProgress: (done, total, savedPct) => {
    if (done % 25 === 0 || done === total) {
      console.log(`  ${done}/${total} — ${savedPct}% smaller so far`);
    }
  },
});
console.log(
  `\nDone — ${r.shrunk} of ${r.total} rows shrunk. ` +
    `${r.beforeMb} MB -> ${r.afterMb} MB stored.`
);
process.exit(0);
