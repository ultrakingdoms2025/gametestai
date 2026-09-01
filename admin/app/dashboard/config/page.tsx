import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { audit, getAdminById, listConfigKeys, setConfig, updateAdminPassword, updateAdminTotpSecret } from '@/lib/db';
import { getSession, requireAdminPage } from '@/lib/session';
import { encrypt } from '@/lib/encrypt';
import { generateTotpSecret, totpUri } from '@/lib/totp';

export const dynamic = 'force-dynamic';

function s(v: FormDataEntryValue | null) {
  return typeof v === 'string' ? v.trim() : '';
}

export default async function ConfigPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string; totpSecret?: string; adminSaved?: string }>;
}) {
  // Guards the read path. The `'use server'` actions below check separately —
  // they run on their own requests, and a guarded render does not guard a POST.
  const session = await requireAdminPage();

  const { saved, error, totpSecret, adminSaved } = await searchParams;
  const [rows, admin] = await Promise.all([
    listConfigKeys(),
    getAdminById(session.adminId),
  ]);

  async function saveConfig(formData: FormData) {
    'use server';
    const session = await getSession();
    if (!session.adminId) redirect('/login');

    const key = s(formData.get('key'));
    const value = s(formData.get('value'));
    const description = s(formData.get('description')) || undefined;
    if (!key || !value) redirect('/dashboard/config?error=Key and value are required');

    await setConfig(key, value, session.username, description);
    await audit(session.username, 'config.set', `config:${key}`, description ?? 'updated');
    revalidatePath('/dashboard');
    revalidatePath('/dashboard/config');
    redirect('/dashboard/config?saved=1');
  }

  async function resetPassword(formData: FormData) {
    'use server';
    const session = await getSession();
    if (!session.adminId) redirect('/login');

    const current = s(formData.get('current_password'));
    const next = s(formData.get('new_password'));
    const confirm = s(formData.get('confirm_password'));
    if (!current || !next || !confirm) redirect('/dashboard/config?error=Missing password fields');
    if (next.length < 12) redirect('/dashboard/config?error=New password must be at least 12 characters');
    if (next !== confirm) redirect('/dashboard/config?error=Passwords do not match');

    const adminRow = await getAdminById(session.adminId);
    if (!adminRow) redirect('/login');
    const ok = await bcrypt.compare(current, adminRow.password_hash);
    if (!ok) redirect('/dashboard/config?error=Current password is incorrect');

    const hash = await bcrypt.hash(next, 12);
    await updateAdminPassword(session.adminId, hash);
    await audit(session.username, 'admin.password_reset', `admin:${session.adminId}`);
    revalidatePath('/dashboard/config');
    redirect('/dashboard/config?adminSaved=1');
  }

  async function rotateTotp(formData: FormData) {
    'use server';
    const session = await getSession();
    if (!session.adminId) redirect('/login');

    const current = s(formData.get('current_password'));
    if (!current) redirect('/dashboard/config?error=Current password is required');

    const adminRow = await getAdminById(session.adminId);
    if (!adminRow) redirect('/login');
    const ok = await bcrypt.compare(current, adminRow.password_hash);
    if (!ok) redirect('/dashboard/config?error=Current password is incorrect');

    const secret = generateTotpSecret();
    const enc = encrypt(secret);
    await updateAdminTotpSecret(session.adminId, enc);
    await audit(session.username, 'admin.totp_rotate', `admin:${session.adminId}`);
    revalidatePath('/dashboard/config');
    redirect(`/dashboard/config?totpSecret=${encodeURIComponent(secret)}&adminSaved=1`);
  }

  let qrSvg = '';
  let uri = '';
  if (totpSecret && admin) {
    uri = totpUri(admin.username, totpSecret);
    qrSvg = await QRCode.toString(uri, { type: 'svg' });
  }

  return (
    <div className="page-body">
      <h1 className="page-title">Config</h1>
      {saved ? <div className="form-success">Config saved.</div> : null}
      {adminSaved ? <div className="form-success">Admin credentials updated.</div> : null}
      {error ? <div className="form-error" style={{ marginBottom: 16 }}>{error}</div> : null}

      <div className="grid-2">
        <section className="card">
          <h2 className="section-title">Configuration keys</h2>
          <form action={saveConfig}>
            <div className="form-grid">
              <div className="form-row">
                <label className="form-label" htmlFor="key">Key</label>
                <input id="key" name="key" placeholder="quest.default_reward" />
              </div>
              <div className="form-row">
                <label className="form-label" htmlFor="description">Description</label>
                <input id="description" name="description" placeholder="Optional note" />
              </div>
              <div className="form-row" style={{ gridColumn: '1 / -1' }}>
                <label className="form-label" htmlFor="value">Value</label>
                <textarea id="value" name="value" rows={4} />
              </div>
            </div>
            <button type="submit" className="btn btn-primary" style={{ marginTop: 18 }}>Save config</button>
          </form>

          <div className="tbl-wrap" style={{ marginTop: 24 }}>
            <table>
              <thead><tr><th>Key</th><th>Description</th><th>Updated by</th><th>Updated</th></tr></thead>
              <tbody>
                {rows.map((r: Record<string, unknown>) => (
                  <tr key={String(r.key)}>
                    <td className="mono">{String(r.key)}</td>
                    <td>{String(r.description ?? '—')}</td>
                    <td>{String(r.updated_by ?? '—')}</td>
                    <td className="mono">{new Date(String(r.updated_at)).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card">
          <h2 className="section-title">Admin security</h2>
          <div style={{ color: 'var(--txt-dim)', marginBottom: 14, fontSize: 12 }}>
            Logged in as <span className="mono">{session.username}</span>
          </div>

          <form action={resetPassword}>
            <div className="form-row">
              <label className="form-label" htmlFor="current_password">Current password</label>
              <input id="current_password" name="current_password" type="password" />
            </div>
            <div className="form-row">
              <label className="form-label" htmlFor="new_password">New password</label>
              <input id="new_password" name="new_password" type="password" />
            </div>
            <div className="form-row">
              <label className="form-label" htmlFor="confirm_password">Confirm password</label>
              <input id="confirm_password" name="confirm_password" type="password" />
            </div>
            <button type="submit" className="btn btn-primary">Reset password</button>
          </form>

          <div style={{ height: 18 }} />

          <form action={rotateTotp}>
            <div className="form-row">
              <label className="form-label" htmlFor="totp_current_password">Current password</label>
              <input id="totp_current_password" name="current_password" type="password" />
            </div>
            <button type="submit" className="btn">Rotate 2FA key</button>
          </form>

          {totpSecret ? (
            <div style={{ marginTop: 24 }}>
              <h2 className="section-title">New 2FA QR</h2>
              <p style={{ color: 'var(--txt-dim)', fontSize: 12, marginTop: 0 }}>
                Scan this code in your authenticator app now. Secret:
                <span className="mono" style={{ display: 'block', marginTop: 6 }}>{totpSecret}</span>
              </p>
              <div className="qr-shell" dangerouslySetInnerHTML={{ __html: qrSvg }} />
              <div className="mono" style={{ marginTop: 12, wordBreak: 'break-all' }}>{uri}</div>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
