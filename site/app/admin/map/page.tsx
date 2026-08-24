import Link from 'next/link';
import { MapEditorPanel } from '@/components/MapEditorPanel';
import { requireMarketplaceAdmin } from '@/lib/adminAccess';

/**
 * The map editor page.
 *
 * Guarded here, in the page itself, not only in `proxy.ts`. `admin/lib/session.ts`
 * already records why: Next 16 renamed `middleware.ts` to `proxy.ts` partly
 * because of CVE-2025-29927, a middleware auth bypass driven by a request
 * header, and "a proxy that is the only gate is one header away from being no
 * gate". Nine admin pages in this project once shipped with no gate of their
 * own at all.
 *
 * A non-admin gets the locked banner. Even if that render were somehow reached,
 * the panel it replaces fetches everything it shows from routes that each check
 * again — so the page render is the courtesy, and the routes are the boundary.
 */

export const dynamic = 'force-dynamic';

export default async function MapEditorPage() {
  const admin = await requireMarketplaceAdmin();

  if (!admin) {
    return (
      <main className="wrap" style={{ padding: '48px 20px' }}>
        <div className="banner" role="status">
          <b>Map editor locked</b>
          <span>
            Sign in with an address listed in <code>ADMIN_EMAILS</code> (or{' '}
            <code>MARKETPLACE_ADMIN_EMAILS</code>) to edit world placements.
          </span>
        </div>
        <p style={{ marginTop: 20 }}>
          <Link href="/">Back home</Link>
        </p>
      </main>
    );
  }

  return (
    <main className="wrap" style={{ padding: '36px 20px 56px' }}>
      <div style={{ display: 'grid', gap: 12, marginBottom: 18 }}>
        <div style={{ color: '#7fe7ff', textTransform: 'uppercase', letterSpacing: '0.18em', fontSize: 12 }}>Admin</div>
        <h1 style={{ margin: 0 }}>World map editor</h1>
        <p style={{ margin: 0, color: '#9bb0c2', maxWidth: 760 }}>
          Move fixed objects and place marketplace items. Changes are saved as a versioned
          placement overlay applied after the world builds — no world source is ever written, so
          this never collides with an art pass, and every version stays revertible.
        </p>
      </div>

      <MapEditorPanel />
    </main>
  );
}
