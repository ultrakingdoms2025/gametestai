/**
 * The absolute origin this deployment is reachable at.
 *
 * The same precedence `siteOrigin()` in `lib/stripe.ts` uses and the same one
 * `app/layout.tsx` sets `metadataBase` from — explicit setting, then whatever
 * Vercel says the deployment is, then the production domain — so a preview
 * build's sitemap and robots advertise the preview rather than production.
 *
 * It lives here rather than in `lib/` only because that directory is owned
 * elsewhere in this pass; it belongs beside `siteOrigin` and should be folded
 * into it, since two functions answering one question is how they drift.
 */
export function siteUrl(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  if (configured) return configured.replace(/\/+$/, '');
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (vercel) return `https://${vercel}`;
  return 'https://aethernexus.games';
}
