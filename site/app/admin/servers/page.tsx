import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { ServerAdminPanel } from '@/components/ServerAdminPanel';

export const dynamic = 'force-dynamic';

/**
 * The owner's dashboard for their custom servers (7c).
 *
 * ── Deliberately NOT behind the marketplace allowlist ─────────────────────
 *
 * `/admin/marketplace` requires `ADMIN_EMAILS`, because the marketplace
 * catalogue is the platform's economy and only staff may price it. This page is
 * different: a server owner is an ordinary player who has paid for hosting, and
 * gating it on a staff allowlist would make the feature unsellable.
 *
 * So the gate here is only "signed in", and every real authorisation decision is
 * made per request by the routes the panel calls — `requireOwnedServer` for the
 * owner's own server, `actor.platformAdmin` for the all-servers view. That is
 * the right place for it: a page render is not a security boundary, and a panel
 * that shows an empty list to somebody who owns nothing costs nothing.
 */
export default async function ServersAdminPage(props: {
  searchParams: Promise<{ [k: string]: string | string[] | undefined }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/login?callbackUrl=%2Fadmin%2Fservers');

  /* `?subscribed=1` is what both purchase paths land on — Stripe's
   * `success_url` and the simulated confirm redirect — so the panel has one
   * trigger to read for "you have just bought this, here is what to do next".
   * Awaited because in Next 16 `searchParams` is a Promise; read on the server
   * so this route does not bail out to the client for one query parameter. */
  const sp = await props.searchParams;
  const justSubscribed = sp.subscribed === '1';

  return (
    <main className="wrap" style={{ padding: '36px 20px 56px' }}>
      <div style={{ display: 'grid', gap: 12, marginBottom: 18 }}>
        <div style={{ color: '#7fe7ff', textTransform: 'uppercase', letterSpacing: '0.18em', fontSize: 12 }}>
          Custom servers
        </div>
        <h1 style={{ margin: 0 }}>Your servers</h1>
        <p style={{ margin: 0, color: '#9bb0c2', maxWidth: 720 }}>
          A custom server is your own lore, quests and marketplace items, played by the
          people you invite. Everything earned inside one stays inside it: server credits
          are a separate balance that cannot reach your main one, and shared leaderboards
          rank platform content only.
        </p>
      </div>

      <ServerAdminPanel justSubscribed={justSubscribed} />

      <p style={{ marginTop: 24 }}>
        <Link href="/account">Back to your account</Link>
      </p>
    </main>
  );
}
