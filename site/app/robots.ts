import type { MetadataRoute } from 'next';
import { siteUrl } from '@/components/siteUrl';

/**
 * There was no robots.txt at all, so everything was fair game — including the
 * paid game bundle under `/game`, the whole of `/admin`, and every screen that
 * only means anything to one signed-in person.
 *
 * ── What is disallowed, and why each one ──────────────────────────────────
 *
 * `/api`, `/admin`, `/play`, `/game` — nothing here renders for an anonymous
 * crawler except a redirect or a 401, and `/game` is the 24 MB build the
 * paywall exists to protect.
 *
 * `/account`, `/order`, `/checkout`, `/redeem`, `/restore` and the four auth
 * screens — per-user or single-use pages. `/order/failed` in particular carries
 * a live payment reference on its query string and must never be indexed.
 *
 * This is a crawl instruction, not access control: the real gates are the
 * launch cookie, the session and the admin allowlist. It stops the pages being
 * listed, not fetched.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/api/',
          '/admin/',
          '/play',
          '/game/',
          '/account',
          '/order/',
          '/checkout',
          '/redeem',
          '/restore',
          '/login',
          '/register',
          '/forgot-password',
          '/reset-password',
        ],
      },
    ],
    sitemap: `${siteUrl()}/sitemap.xml`,
    host: siteUrl(),
  };
}
