import Link from 'next/link';
import { MarketplaceAdminPanel } from '@/components/MarketplaceAdminPanel';
import { requireMarketplaceAdmin } from '@/lib/adminAccess';

export const dynamic = 'force-dynamic';

export default async function MarketplaceAdminPage() {
  const admin = await requireMarketplaceAdmin();

  if (!admin) {
    return (
      <main className="wrap" style={{ padding: '48px 20px' }}>
        <div className="banner" role="status">
          <b>Marketplace admin locked</b>
          <span>
            Sign in with an address listed in <code>MARKETPLACE_ADMIN_EMAILS</code> (or <code>ADMIN_EMAILS</code>) to manage items.
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
        <h1 style={{ margin: 0 }}>Marketplace catalog</h1>
        <p style={{ margin: 0, color: '#9bb0c2' }}>
          Create, edit, search, filter, and retire item records for the future database-driven marketplace.
        </p>
      </div>

      <MarketplaceAdminPanel />
    </main>
  );
}
