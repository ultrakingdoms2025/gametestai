import bcrypt from 'bcryptjs';
import { redirect, notFound } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  audit,
  createPlayer,
  getPlayerById,
  listPlayerQuestEngagements,
  lockPlayer,
  unlockPlayer,
  updatePlayer,
  adjustCredits,
} from '@/lib/db';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

function s(v: FormDataEntryValue | null) {
  return typeof v === 'string' ? v.trim() : '';
}

function formatDuration(minutes: number | null | undefined) {
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return 'No limit';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m}m`;
  if (!m) return `${h}h`;
  return `${h}h ${m}m`;
}

function formatRemaining(acceptedAt: unknown, durationMinutes: number | null | undefined, status: unknown) {
  if (typeof acceptedAt !== 'string' || !acceptedAt) return '—';
  if (status === 'completed') return 'Completed';
  if (status === 'failed') return 'Failed';
  if (status === 'timed_out') return 'Timed out';
  if (durationMinutes == null || durationMinutes <= 0) return 'No limit';
  const started = new Date(acceptedAt).getTime();
  if (!Number.isFinite(started)) return '—';
  const deadline = started + (durationMinutes * 60 * 1000);
  const diff = deadline - Date.now();
  if (diff <= 0) return 'Timed out';
  const totalMinutes = Math.ceil(diff / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (!hours) return `${mins}m left`;
  if (!mins) return `${hours}h left`;
  return `${hours}h ${mins}m left`;
}

function displayEngagementStatus(acceptedAt: unknown, durationMinutes: number | null | undefined, status: unknown) {
  const value = String(status ?? '').toLowerCase();
  if (value === 'completed') return 'Completed';
  if (value === 'failed') return 'Failed';
  if (value === 'timed_out') return 'Timed out';
  if (typeof acceptedAt === 'string' && durationMinutes != null && durationMinutes > 0) {
    const started = new Date(acceptedAt).getTime();
    if (Number.isFinite(started) && started + (durationMinutes * 60 * 1000) <= Date.now()) {
      return 'Timed out';
    }
  }
  return 'In progress';
}

function statusTagClass(status: string) {
  if (status === 'Completed') return 'tag tag-green';
  if (status === 'Failed' || status === 'Timed out') return 'tag tag-red';
  return 'tag tag-amber';
}

export default async function PlayerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { id } = await params;
  const creating = id === 'new';
  const { error, saved } = await searchParams;
  const player = creating ? null : ((await getPlayerById(id)) as Record<string, any> | null);
  const engagements = creating ? [] : await listPlayerQuestEngagements(id);

  if (!creating && !player) notFound();

  async function savePlayer(formData: FormData) {
    'use server';
    const session = await getSession();
    if (!session.adminId) redirect('/login');

    const fullName = s(formData.get('full_name')) || null;
    const handle = s(formData.get('handle')) || null;
    const email = s(formData.get('email')) || null;
    const country = s(formData.get('country')) || null;
    const authProvider = s(formData.get('auth_provider')) || 'password';
    const oauthProvider = s(formData.get('oauth_provider')) || null;
    const oauthKey = s(formData.get('oauth_key')) || null;
    const notes = s(formData.get('notes')) || null;
    const status = s(formData.get('status')) || 'active';
    const password = s(formData.get('password')) || null;

    if (creating && !password) {
      redirect(`/dashboard/players/new?error=${encodeURIComponent('Password is required for new players')}`);
    }

    try {
      const passwordHash = password ? await bcrypt.hash(password, 12) : null;
      if (creating) {
        const newId = await createPlayer({
          fullName: fullName ?? undefined,
          handle: handle ?? undefined,
          email: email ?? undefined,
          country: country ?? undefined,
          passwordHash: passwordHash ?? undefined,
          authProvider,
          oauthProvider: oauthProvider ?? undefined,
          oauthKey: oauthKey ?? undefined,
          notes: notes ?? undefined,
          status,
        });
        await audit(session.username, 'player.create', `player:${newId}`, `handle=${handle ?? '—'}`);
        revalidatePath('/dashboard/players');
        redirect(`/dashboard/players/${newId}?saved=1`);
      }

      await updatePlayer(id, {
        fullName,
        handle,
        email,
        country,
        passwordHash,
        authProvider,
        oauthProvider,
        oauthKey,
        notes,
        status,
      });
      await audit(session.username, 'player.update', `player:${id}`, `handle=${handle ?? '—'}`);
      revalidatePath('/dashboard/players');
      revalidatePath(`/dashboard/players/${id}`);
      redirect(`/dashboard/players/${id}?saved=1`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to save player';
      redirect(`/dashboard/players/${creating ? 'new' : id}?error=${encodeURIComponent(message)}`);
    }
  }

  async function toggleLock(formData: FormData) {
    'use server';
    const session = await getSession();
    if (!session.adminId) redirect('/login');
    const locked = s(formData.get('locked')) === '1';
    if (locked) {
      await lockPlayer(id);
      await audit(session.username, 'player.lock', `player:${id}`, 'locked');
    } else {
      await unlockPlayer(id);
      await audit(session.username, 'player.unlock', `player:${id}`, 'unlocked');
    }
    revalidatePath('/dashboard/players');
    revalidatePath(`/dashboard/players/${id}`);
    redirect(`/dashboard/players/${id}?saved=1`);
  }

  async function adjust(formData: FormData) {
    'use server';
    const session = await getSession();
    if (!session.adminId) redirect('/login');
    const delta = Number(s(formData.get('delta')) || 0);
    const reason = s(formData.get('reason')) || 'manual_adjustment';
    await adjustCredits(id, delta);
    await audit(session.username, 'player.adjust_credits', `player:${id}`, `delta=${delta} reason=${reason}`);
    revalidatePath('/dashboard/players');
    revalidatePath(`/dashboard/players/${id}`);
    redirect(`/dashboard/players/${id}?saved=1`);
  }

  const label = player ? (player.full_name || player.handle || player.id) : 'New player';
  const title = creating ? 'New player' : `Player ${String(label).slice(0, 18)}`;
  const locked = String(player?.status ?? '').toLowerCase() === 'locked' || !!player?.access_revoked_at;

  return (
    <div className="page-body">
      <div className="page-title">{title}</div>

      {saved ? <div className="form-success">Saved.</div> : null}
      {error ? <div className="form-error" style={{ marginBottom: 16 }}>{error}</div> : null}

      <div className="grid-2">
        <section className="card">
          <div className="section-title">Account details</div>
          <form action={savePlayer}>
            <div className="form-grid">
              <div className="form-row">
                <label className="form-label" htmlFor="full_name">Full name</label>
                <input id="full_name" name="full_name" defaultValue={String(player?.full_name ?? '')} />
              </div>
              <div className="form-row">
                <label className="form-label" htmlFor="handle">Handle</label>
                <input id="handle" name="handle" defaultValue={String(player?.handle ?? '')} />
              </div>
              <div className="form-row">
                <label className="form-label" htmlFor="email">Email</label>
                <input id="email" name="email" defaultValue={String(player?.email ?? '')} />
              </div>
              <div className="form-row">
                <label className="form-label" htmlFor="country">Country</label>
                <input id="country" name="country" defaultValue={String(player?.country ?? '')} />
              </div>
              <div className="form-row">
                <label className="form-label" htmlFor="auth_provider">Auth provider</label>
                <select id="auth_provider" name="auth_provider" defaultValue={String(player?.auth_provider ?? 'password')}>
                  <option value="password">Password</option>
                  <option value="oauth">OAuth</option>
                  <option value="key">Key</option>
                </select>
              </div>
              <div className="form-row">
                <label className="form-label" htmlFor="status">Status</label>
                <select id="status" name="status" defaultValue={String(player?.status ?? 'active')}>
                  <option value="active">Active</option>
                  <option value="locked">Locked</option>
                  <option value="pending">Pending</option>
                </select>
              </div>
              <div className="form-row">
                <label className="form-label" htmlFor="oauth_provider">OAuth provider</label>
                <input id="oauth_provider" name="oauth_provider" defaultValue={String(player?.oauth_provider ?? '')} />
              </div>
              <div className="form-row">
                <label className="form-label" htmlFor="oauth_key">OAuth key</label>
                <input id="oauth_key" name="oauth_key" defaultValue={String(player?.oauth_key ?? '')} />
              </div>
              <div className="form-row" style={{ gridColumn: '1 / -1' }}>
                <label className="form-label" htmlFor="password">Password {creating ? '(required)' : '(leave blank to keep current)'}</label>
                <input id="password" name="password" type="password" />
              </div>
              <div className="form-row" style={{ gridColumn: '1 / -1' }}>
                <label className="form-label" htmlFor="notes">Notes</label>
                <textarea id="notes" name="notes" rows={5} defaultValue={String(player?.notes ?? '')} />
              </div>
            </div>

            <button type="submit" className="btn btn-primary" style={{ marginTop: 18 }}>
              {creating ? 'Create player' : 'Save changes'}
            </button>
          </form>
        </section>

        <section className="card">
          <div className="section-title">Access & credits</div>
          <div className="mini-stack">
            <div><span className="mini-label">Player ID</span><div className="mono">{creating ? 'new' : String(player?.id)}</div></div>
            <div><span className="mini-label">Email hash</span><div className="mono">{String(player?.email_hash ?? '—')}</div></div>
            <div><span className="mini-label">Credits</span><div>{String(player?.credit_balance ?? 0)}</div></div>
            <div><span className="mini-label">Status</span><div>{locked ? <span className="tag tag-red">Locked</span> : <span className="tag tag-green">Active</span>}</div></div>
          </div>

          {!creating && (
            <form action={toggleLock} style={{ marginTop: 18, display: 'flex', gap: 10 }}>
              <input type="hidden" name="locked" value={locked ? '0' : '1'} />
              <button type="submit" className={locked ? 'btn btn-primary' : 'btn btn-danger'}>
                {locked ? 'Unlock player' : 'Lock player'}
              </button>
            </form>
          )}

          {!creating && (
            <form action={adjust} style={{ marginTop: 18 }}>
              <div className="form-row">
                <label className="form-label" htmlFor="delta">Credit delta</label>
                <input id="delta" name="delta" type="number" step="1" placeholder="0" />
              </div>
              <div className="form-row">
                <label className="form-label" htmlFor="reason">Reason</label>
                <input id="reason" name="reason" placeholder="manual_adjustment" />
              </div>
              <button type="submit" className="btn">Apply credits</button>
            </form>
          )}

          <div style={{ marginTop: 24 }}>
            <div className="section-title">Recent purchase snapshot</div>
            {player?.purchase_at ? (
              <div className="mini-stack">
                <div><span className="mini-label">Last purchase time</span><div className="mono">{new Date(String(player.purchase_at)).toLocaleString()}</div></div>
                <div><span className="mini-label">Amount</span><div>{String(player.amount_cents ?? '—')}</div></div>
                <div><span className="mini-label">Type</span><div>{String(player.type ?? '—')}</div></div>
              </div>
            ) : (
              <p style={{ color: 'var(--txt-dim)', margin: 0 }}>No purchase snapshot available.</p>
            )}
          </div>
        </section>
      </div>

      {!creating ? (
        <section className="card" style={{ marginTop: 24 }}>
          <div className="section-title">Quest engagement history</div>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Quest</th>
                  <th>World</th>
                  <th>Status</th>
                  <th>%</th>
                  <th>Time left</th>
                  <th>Credits</th>
                  <th>Accepted</th>
                </tr>
              </thead>
              <tbody>
                {engagements.map((engagement: Record<string, unknown>) => {
                  const durationMinutes = engagement.duration_minutes as number | null | undefined;
                  const statusText = displayEngagementStatus(engagement.accepted_at, durationMinutes, engagement.status);
                  return (
                    <tr key={String(engagement.id)}>
                      <td>
                        <div style={{ fontWeight: 600 }}>#{String(engagement.quest_number)} {String(engagement.quest_title)}</div>
                        <div className="mono" style={{ fontSize: 11, color: 'var(--txt-dim)' }}>{String(engagement.quest_id ?? '—')}</div>
                      </td>
                      <td>{String(engagement.world)}</td>
                      <td><span className={statusTagClass(statusText)}>{statusText}</span></td>
                      <td>{String(engagement.percent_complete ?? 0)}%</td>
                      <td>{formatRemaining(engagement.accepted_at, durationMinutes, engagement.status)}</td>
                      <td>{String(engagement.credits_rewarded ?? 0)}</td>
                      <td className="mono">{engagement.accepted_at ? new Date(String(engagement.accepted_at)).toLocaleString() : '—'}</td>
                    </tr>
                  );
                })}
                {engagements.length === 0 ? (
                  <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--txt-dim)', padding: 28 }}>No quest engagements recorded for this player yet.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
