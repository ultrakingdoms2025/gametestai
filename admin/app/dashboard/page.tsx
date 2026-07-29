import { countPlayers, countActivePlayers, purchaseStats, listAudit, verifyAuditChain } from '@/lib/db';

export const dynamic = 'force-dynamic';

export default async function DashboardHome() {
  const [total, active, stats, recent, chain] = await Promise.all([
    countPlayers(),
    countActivePlayers(),
    purchaseStats(),
    listAudit(0),
    verifyAuditChain(),
  ]);

  const revenue = (Number(stats?.total_cents ?? 0) / 100).toFixed(2);

  return (
    <div className="page-body">
      <div className="page-title">Overview</div>

      <div className="stat-grid">
        <div className="stat">
          <div className="stat-val">{total}</div>
          <div className="stat-key">Total players</div>
        </div>
        <div className="stat">
          <div className="stat-val">{active}</div>
          <div className="stat-key">Active access</div>
        </div>
        <div className="stat">
          <div className="stat-val">{stats?.total_count ?? 0}</div>
          <div className="stat-key">Purchases</div>
        </div>
        <div className="stat">
          <div className="stat-val">${revenue}</div>
          <div className="stat-key">Revenue</div>
        </div>
        <div className="stat">
          <div className={`stat-val ${chain.valid ? 'audit-chain-ok' : 'audit-chain-fail'}`}>
            {chain.valid ? '✓ INTACT' : '✗ BROKEN'}
          </div>
          <div className="stat-key">Audit chain</div>
        </div>
      </div>

      <div style={{ marginTop: 8 }}>
        <div className="page-title" style={{ fontSize: 13, marginBottom: 14 }}>Recent activity</div>
        <div className="tbl-wrap">
          <table>
            <thead><tr>
              <th>#</th><th>Actor</th><th>Action</th><th>Resource</th><th>Time</th>
            </tr></thead>
            <tbody>
              {recent.slice(0, 15).map((r: Record<string, unknown>) => (
                <tr key={String(r.id)}>
                  <td className="mono">{String(r.seq)}</td>
                  <td>{String(r.actor)}</td>
                  <td><span className="tag tag-cyan">{String(r.action)}</span></td>
                  <td className="mono">{String(r.resource)}</td>
                  <td className="mono">{new Date(String(r.created_at)).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}