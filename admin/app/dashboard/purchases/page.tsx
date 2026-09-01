import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { audit, listPurchases, purchaseStats, recordPurchase } from '@/lib/db';
import { getSession, requireAdminPage } from '@/lib/session';

export const dynamic = 'force-dynamic';

function s(v: FormDataEntryValue | null) {
  return typeof v === 'string' ? v.trim() : '';
}

export default async function PurchasesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; saved?: string; error?: string }>;
}) {
  await requireAdminPage();

  const { page = '0', saved, error } = await searchParams;
  const [rows, stats] = await Promise.all([listPurchases(Number(page)), purchaseStats()]);

  async function createPurchase(formData: FormData) {
    'use server';
    const session = await getSession();
    if (!session.adminId) redirect('/login');

    const playerId = s(formData.get('player_id'));
    const stripeIntent = s(formData.get('stripe_intent'));
    const amountCents = Number(s(formData.get('amount_cents')) || 0);
    const currency = s(formData.get('currency')) || 'usd';
    const type = s(formData.get('type')) as 'access' | 'credits';
    const creditsAmount = s(formData.get('credits_amount'));

    if (!playerId || !stripeIntent || !amountCents || !type) {
      redirect('/dashboard/purchases?error=Missing required purchase fields');
    }

    await recordPurchase({
      playerId,
      stripeIntent,
      amountCents,
      currency,
      type,
      creditsAmount: creditsAmount ? Number(creditsAmount) : undefined,
    });
    await audit(session.username, 'purchase.create', `player:${playerId}`, `amount=${amountCents} currency=${currency} type=${type}`);
    revalidatePath('/dashboard');
    revalidatePath('/dashboard/purchases');
    redirect('/dashboard/purchases?saved=1');
  }

  return (
    <div className="page-body">
      <h1 className="page-title">Purchases</h1>
      {saved ? <div className="form-success">Saved.</div> : null}
      {error ? <div className="form-error" style={{ marginBottom: 16 }}>{error}</div> : null}

      <div className="stat-grid">
        <div className="stat">
          <div className="stat-val">{stats?.total_count ?? 0}</div>
          <div className="stat-key">Completed purchases</div>
        </div>
        <div className="stat">
          <div className="stat-val">${(Number(stats?.total_cents ?? 0) / 100).toFixed(2)}</div>
          <div className="stat-key">Revenue</div>
        </div>
        <div className="stat">
          <div className="stat-val">{stats?.access_count ?? 0}</div>
          <div className="stat-key">Access purchases</div>
        </div>
        <div className="stat">
          <div className="stat-val">{stats?.credits_count ?? 0}</div>
          <div className="stat-key">Credit purchases</div>
        </div>
      </div>

      <section className="card" style={{ marginBottom: 20 }}>
        <h2 className="section-title">Create manual purchase</h2>
        <form action={createPurchase}>
          <div className="form-grid">
            <div className="form-row">
              <label className="form-label" htmlFor="player_id">Player ID</label>
              <input id="player_id" name="player_id" placeholder="uuid" />
            </div>
            <div className="form-row">
              <label className="form-label" htmlFor="stripe_intent">Stripe intent / ref</label>
              <input id="stripe_intent" name="stripe_intent" placeholder="pi_..." />
            </div>
            <div className="form-row">
              <label className="form-label" htmlFor="amount_cents">Amount (cents)</label>
              <input id="amount_cents" name="amount_cents" type="number" min="0" step="1" />
            </div>
            <div className="form-row">
              <label className="form-label" htmlFor="currency">Currency</label>
              <input id="currency" name="currency" defaultValue="usd" />
            </div>
            <div className="form-row">
              <label className="form-label" htmlFor="type">Type</label>
              <select id="type" name="type" defaultValue="access">
                <option value="access">Access</option>
                <option value="credits">Credits</option>
              </select>
            </div>
            <div className="form-row">
              <label className="form-label" htmlFor="credits_amount">Credits</label>
              <input id="credits_amount" name="credits_amount" type="number" min="0" step="1" />
            </div>
          </div>
          <button type="submit" className="btn btn-primary" style={{ marginTop: 18 }}>Record purchase</button>
        </form>
      </section>

      <div className="tbl-wrap">
        <table>
          <thead><tr>
            <th>ID</th><th>Player</th><th>Amount</th><th>Currency</th><th>Type</th>
            <th>Credits</th><th>Status</th><th>Created</th>
          </tr></thead>
          <tbody>
            {rows.map((r: Record<string, unknown>) => (
              <tr key={String(r.id)}>
                <td className="mono">{String(r.id).slice(0,8)}…</td>
                <td className="mono">{String(r.player_id ?? '—').slice(0,8)}…</td>
                <td>{String(r.amount_cents)}</td>
                <td>{String(r.currency)}</td>
                <td><span className="tag tag-cyan">{String(r.type)}</span></td>
                <td>{String(r.credits_amount ?? '—')}</td>
                <td>{String(r.status ?? '—')}</td>
                <td className="mono">{new Date(String(r.created_at)).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 16, display: 'flex', gap: 10 }}>
        {Number(page) > 0 && <a href={`?page=${Number(page)-1}`} className="btn">← Previous</a>}
        {rows.length === 50 && <a href={`?page=${Number(page)+1}`} className="btn">Next →</a>}
      </div>
    </div>
  );
}
