import type { MetadataRoute } from 'next';
import { siteUrl } from '@/components/siteUrl';

/**
 * The four pages that are actually public and actually the same for everybody.
 *
 * Deliberately short. A sitemap listing `/checkout`, `/account` or `/play`
 * would be asking a crawler to index a redirect, and every one of those is in
 * `robots.ts`'s disallow list — a sitemap that contradicts robots.txt is a
 * reported error rather than a clever hedge.
 *
 * `/redeem` and `/restore` are left out for the same reason: they are recovery
 * routes reached from a receipt or an email, not destinations.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl();
  /* Build time, not request time — this file is statically generated. The date
   * is what the deployment was built, which is the honest answer for a page
   * whose copy only changes when the site is rebuilt. */
  const lastModified = new Date();

  return [
    { url: `${base}/`,         lastModified, changeFrequency: 'weekly',  priority: 1 },
    { url: `${base}/features`, lastModified, changeFrequency: 'weekly',  priority: 0.8 },
    { url: `${base}/store`,    lastModified, changeFrequency: 'monthly', priority: 0.6 },
  ];
}
