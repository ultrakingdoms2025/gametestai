import { requireAdminPage } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function MarketplacePage() {
  await requireAdminPage();

  const target = process.env.NEXT_PUBLIC_MARKETPLACE_ADMIN_URL || 'https://aethernexus.games/admin/marketplace';

  return (
    <div className="page-body">
      <h1 className="page-title">Marketplace</h1>
      <div className="card" style={{ display: 'grid', gap: 14, maxWidth: 820 }}>
        <p style={{ margin: 0, color: 'var(--txt-2)' }}>
          Open the live marketplace catalog manager to create, update, deactivate, and remove shop items.
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <a href={target} className="btn btn-primary">
            Open marketplace manager
          </a>
          <span className="mono">{target}</span>
        </div>
        <p style={{ margin: 0, color: 'var(--txt-dim)', fontSize: 12 }}>
          If this link should point to a different domain, set <code>NEXT_PUBLIC_MARKETPLACE_ADMIN_URL</code> on this admin deployment.
        </p>
      </div>
    </div>
  );
}
