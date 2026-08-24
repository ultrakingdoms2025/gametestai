import { requireAdminPage } from '@/lib/session';

/**
 * Map editor entry point.
 *
 * A guarded page whose content is a link out to the site's `/admin/map`, which
 * is exactly what `dashboard/marketplace/page.tsx` next door already is. The
 * editor lives in the site app for the same reasons the marketplace catalogue
 * manager does: it needs the marketplace catalogue, the player session, and
 * same-origin access to the game that applies the overlay.
 *
 * The audit trail still lands here. Every save and revert writes a chained row
 * into `audit_log` through `site/lib/auditChain.ts`, whose tests import this
 * app's `lib/hmac.ts` directly and assert the two produce identical digests —
 * so the chain the Audit Log page verifies does not fork.
 */

export const dynamic = 'force-dynamic';

export default async function MapEditorLinkPage() {
  await requireAdminPage();

  const target = process.env.NEXT_PUBLIC_MAP_EDITOR_URL || 'https://aethernexus.games/admin/map';

  return (
    <div className="page-body">
      <div className="page-title">Map Editor</div>
      <div className="card" style={{ display: 'grid', gap: 14, maxWidth: 820 }}>
        <p style={{ margin: 0, color: 'var(--txt-2)' }}>
          Move fixed objects and place marketplace items in any world. Saves a versioned placement
          overlay that the game applies after the world builds — world source is never written, so
          this never collides with an art pass.
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <a href={target} className="btn btn-primary">
            Open map editor
          </a>
          <span className="mono">{target}</span>
        </div>
        <p style={{ margin: 0, color: 'var(--txt-dim)', fontSize: 12 }}>
          Every save and revert is recorded in the Audit Log as <code>map.overlay.save</code> /{' '}
          <code>map.overlay.revert</code> against <code>world:&lt;id&gt;</code>. If this link should
          point to a different domain, set <code>NEXT_PUBLIC_MAP_EDITOR_URL</code> on this admin
          deployment.
        </p>
      </div>
    </div>
  );
}
