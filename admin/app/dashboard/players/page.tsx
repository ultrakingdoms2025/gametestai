import { listPlayers } from '@/lib/db';

export const dynamic = 'force-dynamic';

export default async function PlayersPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; search?: string }>;
}) {
  const { page = '0', search } = await searchParams;
  const rows = await listPlayers(Number(page), search);

  return (
    <div className="page-body">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginBottom: 24 }}>
        <div className="page-title" style={{ marginBottom: 0 }}>Players</div>
        <a href="/dashboard/players/new" className="btn btn-primary">New player</a>
      </div>

      <form style={{ marginBottom: 20, display: 'flex', gap: 10 }}>
        <input name="search" placeholder="Search by email (exact)…" defaultValue={search} style={{ maxWidth: 320 }} />
        <button type="submit" className="btn">Search</button>
      </form>

      <div className="tbl-wrap">
        <table>
          <thead><tr>
            <th>ID</th><th>Name</th><th>Handle</th><th>Email hash</th><th>Status</th>
            <th>Credits</th><th>Country</th><th>Created</th><th>Actions</th>
          </tr></thead>
          <tbody>
            {rows.map((r: Record<string, unknown>) => {
              const status = String(r.status ?? (r.access_revoked_at ? 'locked' : r.access_granted_at ? 'active' : 'pending'));
              const active = status === 'active' || (!!r.access_granted_at && !r.access_revoked_at);
              const revoked = status === 'locked' || !!r.access_revoked_at;
              return (
                <tr key={String(r.id)}>
                  <td className="mono" title={String(r.id)}>{String(r.id).slice(0,8)}…</td>
                  <td>{String(r.full_name ?? '—')}</td>
                  <td className="mono">{String(r.handle ?? '—')}</td>
                  <td className="mono">{String(r.email_hash ?? '—').slice(0,12)}…</td>
                  <td>
                    {revoked
                      ? <span className="tag tag-red">Locked</span>
                      : active
                        ? <span className="tag tag-green">Active</span>
                        : <span className="tag tag-amber">{status}</span>
                    }
                  </td>
                  <td>{String(r.credit_balance)}</td>
                  <td>{String(r.country ?? '—')}</td>
                  <td className="mono">{new Date(String(r.created_at)).toLocaleDateString()}</td>
                  <td>
                    <a href={`/dashboard/players/${String(r.id)}`} className="btn" style={{ fontSize: 11, padding: '4px 10px' }}>
                      View
                    </a>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan={9} style={{ textAlign: 'center', color: 'var(--txt-dim)', padding: 32 }}>No players found</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 16, display: 'flex', gap: 10 }}>
        {Number(page) > 0 && (
          <a href={`?page=${Number(page)-1}${search ? `&search=${encodeURIComponent(search)}` : ''}`} className="btn">← Previous</a>
        )}
        {rows.length === 50 && (
          <a href={`?page=${Number(page)+1}${search ? `&search=${encodeURIComponent(search)}` : ''}`} className="btn">Next →</a>
        )}
      </div>
    </div>
  );
}