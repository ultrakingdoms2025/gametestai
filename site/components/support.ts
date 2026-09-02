/**
 * Where a customer with a problem is sent.
 *
 * One constant rather than an address typed into each screen: the payment
 * failure pages are the ones nobody rehearses, and a stale mailto on the page a
 * charged customer lands on is worse than no page at all. Overridable per
 * deployment so a preview build can point somewhere that is read.
 */
export const SUPPORT_EMAIL =
  process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? 'support@aethernexus.games';

/**
 * A mailto with the subject and the reference already in it, so the customer
 * does not have to copy an id out of a page and into a mail client — which is
 * exactly where a reference gets truncated and the trail goes cold.
 */
export function supportMailto(subject: string, body?: string): string {
  const q = new URLSearchParams({ subject });
  if (body) q.set('body', body);
  return `mailto:${SUPPORT_EMAIL}?${q.toString().replace(/\+/g, '%20')}`;
}
