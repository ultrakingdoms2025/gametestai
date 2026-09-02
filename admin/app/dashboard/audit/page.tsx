import { listAudit, verifyAuditChain } from '@/lib/db';
import { requireAdminPage } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  await requireAdminPage();

  const { page = '0' } = await searchParams;
  const [rows, chain] = await Promise.all([listAudit(Number(page)), verifyAuditChain()]);

  return (
    <div className="page-body">
      <h1 className="page-title">Audit Log</h1>

      <div style={{ marginBottom: 20, display: 'flex', alignItems: 'center', gap: 16 }}>
        <div className="card" style={{ padding: '12px 20px', display: 'inline-flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.15em', color: 'var(--txt-dim)' }}>Chain integrity</span>
          <span className={chain.valid ? 'audit-chain-ok' : 'audit-chain-fail'} style={{ fontWeight: 700 }}>
            {chain.valid ? '✓ All entries verified' : `✗ Chain broken at entry #${chain.brokenAt}`}
          </span>
        </div>
        <form method="POST" action="/api/audit">
          <button type="submit" className="btn">Re-verify chain</button>
        </form>
      </div>

      <div className="tbl-wrap">
        <table>
          <thead><tr>
            <th>#</th><th>Time</th><th>Actor</th><th>Action</th><th>Resource</th><th>Detail</th>
          </tr></thead>
          <tbody>
            {rows.map((r: Record<string, unknown>) => (
              <tr key={String(r.id)}>
                <td className="mono">{String(r.seq)}</td>
                <td className="mono">{new Date(String(r.created_at)).toLocaleString()}</td>
                <td>{String(r.actor)}</td>
                <td><span className="tag tag-cyan">{String(r.action)}</span></td>
                <td className="mono">{String(r.resource)}</td>
                <td className="mono">{String(r.detail ?? '—')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 16, display: 'flex', gap: 10 }}>
        {Number(page) > 0 && <a href={`?page=${Number(page)-1}`} className="btn">← Previous</a>}
        {rows.length === 50 && <a href={`?page=${Number(page)+1}`} className="btn">Next →</a>}
      </div>

      <p style={{ marginTop: 24, fontSize: 12, color: 'var(--txt-dim)', maxWidth: 640 }}>
        The audit log uses HMAC chaining: each entry includes a cryptographic signature
        of the previous entry. If any entry is edited, deleted, or inserted out-of-order,
        chain verification will fail from that point forward.
      </p>
    </div>
  );
}