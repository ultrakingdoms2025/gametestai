import { redirect } from 'next/navigation';
import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { audit } from '@/lib/db';
import { getSession, requireAdminPage } from '@/lib/session';
import {
  MAX_BATCH,
  MAX_GRANT_DAYS,
  MAX_USES_PER_CODE,
  accessCodeStats,
  clawBackAccessCode,
  createAccessCodes,
  listAccessCodes,
  listBatchCodes,
  listRedemptions,
  restoreAccessCode,
  revealAccessCode,
  revokeAccessCode,
} from '@/lib/accessCodes';
import { isAccessCodeKind } from '@/lib/accessCodeFormat';

export const dynamic = 'force-dynamic';

/**
 * Access codes.
 *
 * Mint codes that are worth what a purchase is worth -- 30 days of game access,
 * or a comped custom-server slot -- and withdraw them again.
 *
 * -- Why a code is never rendered unless it is asked for --------------------
 *
 * The listing shows `AN-7Q2K-...` and nothing more. A page that renders every
 * live code in full is a page whose screenshot, or whose over-the-shoulder
 * glance, is a giveaway of every unclaimed grant on the platform. A code comes
 * out of the database in plaintext in exactly two situations: the batch you
 * have this second minted, and one code you have deliberately clicked to
 * reveal. Both are written to the audit chain, so "who read that code out" is a
 * question with an answer.
 *
 * -- Why revoke and claw back are two buttons ------------------------------
 *
 * Withdrawing a code that leaked and taking access away from the people who
 * redeemed it before it leaked are different decisions. One is free, the other
 * ends somebody's play session, and the second is not a reasonable side effect
 * of the first. So revoke stops future redemptions and touches nobody, and the
 * claw-back is a separate, counted, confirmed action that additionally skips
 * anyone who has bought access since -- see `clawBackAccessCode`.
 */

function s(v: FormDataEntryValue | null): string {
  return typeof v === 'string' ? v.trim() : '';
}

function n(v: FormDataEntryValue | null, fallback: number): number {
  const parsed = Number(s(v));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export default async function CodesPage({
  searchParams,
}: {
  searchParams: Promise<{
    batch?: string;
    code?: string;
    reveal?: string;
    error?: string;
    done?: string;
  }>;
}) {
  // Guards the read path. The actions below guard separately -- they run on
  // their own requests, and a guarded render does not guard a POST.
  await requireAdminPage();

  const { batch, code: selected, reveal, error, done } = await searchParams;

  const [stats, codes] = await Promise.all([accessCodeStats(), listAccessCodes(0)]);
  const minted = batch ? await listBatchCodes(batch) : [];
  const redemptions = selected ? await listRedemptions(selected) : [];
  const revealed = reveal ? await revealAccessCode(reveal) : null;
  const selectedRow = selected ? codes.find((row) => row.code_hash === selected) ?? null : null;

  async function mint(formData: FormData) {
    'use server';
    const session = await getSession();
    if (!session.adminId) redirect('/login');

    const kind = s(formData.get('kind'));
    if (!isAccessCodeKind(kind)) redirect('/dashboard/codes?error=Pick+what+the+code+grants');

    const days = n(formData.get('days'), 30);
    const maxUses = n(formData.get('max_uses'), 1);
    const quantity = n(formData.get('quantity'), 1);
    const label = s(formData.get('label')) || null;
    /* A date input gives `YYYY-MM-DD`, which Postgres reads as midnight UTC on
     * that morning -- i.e. the code dies at the START of the day the operator
     * typed. Pushed to the end of it, because "expires 5 March" universally
     * means "works on the 5th". */
    const expiresRaw = s(formData.get('expires_at'));
    const expiresAt = expiresRaw ? `${expiresRaw}T23:59:59Z` : null;

    if (days < 1 || days > MAX_GRANT_DAYS) {
      redirect(`/dashboard/codes?error=Days+must+be+between+1+and+${MAX_GRANT_DAYS}`);
    }
    if (quantity < 1 || quantity > MAX_BATCH) {
      redirect(`/dashboard/codes?error=Quantity+must+be+between+1+and+${MAX_BATCH}`);
    }
    if (maxUses < 1 || maxUses > MAX_USES_PER_CODE) {
      redirect(`/dashboard/codes?error=Uses+must+be+between+1+and+${MAX_USES_PER_CODE}`);
    }

    const { batchId, codes: made } = await createAccessCodes({
      kind,
      days,
      maxUses,
      quantity,
      label,
      expiresAt,
      createdBy: session.username,
    });

    /* The audit entry names the batch and its terms, never a code. The chain is
     * readable by anyone with the audit page; putting the credential in it would
     * make the tamper-evident log the easiest place on the platform to harvest
     * unclaimed grants from. */
    await audit(
      session.username,
      'access_code.mint',
      `batch:${batchId}`,
      JSON.stringify({ kind, days, maxUses, quantity: made.length, label, expiresAt })
    );
    revalidatePath('/dashboard/codes');
    redirect(`/dashboard/codes?batch=${encodeURIComponent(batchId)}`);
  }

  async function revoke(formData: FormData) {
    'use server';
    const session = await getSession();
    if (!session.adminId) redirect('/login');
    const codeHash = s(formData.get('code_hash'));
    if (!codeHash) redirect('/dashboard/codes?error=No+code+selected');

    const changed = await revokeAccessCode(codeHash, session.username);
    if (changed) {
      await audit(session.username, 'access_code.revoke', `code:${codeHash}`);
    }
    revalidatePath('/dashboard/codes');
    redirect(`/dashboard/codes?code=${encodeURIComponent(codeHash)}&done=revoked`);
  }

  async function restore(formData: FormData) {
    'use server';
    const session = await getSession();
    if (!session.adminId) redirect('/login');
    const codeHash = s(formData.get('code_hash'));
    if (!codeHash) redirect('/dashboard/codes?error=No+code+selected');

    const changed = await restoreAccessCode(codeHash);
    if (changed) {
      await audit(session.username, 'access_code.restore', `code:${codeHash}`);
    }
    revalidatePath('/dashboard/codes');
    redirect(`/dashboard/codes?code=${encodeURIComponent(codeHash)}&done=restored`);
  }

  async function clawBack(formData: FormData) {
    'use server';
    const session = await getSession();
    if (!session.adminId) redirect('/login');
    const codeHash = s(formData.get('code_hash'));
    if (!codeHash) redirect('/dashboard/codes?error=No+code+selected');

    const result = await clawBackAccessCode(codeHash);
    await audit(
      session.username,
      'access_code.claw_back',
      `code:${codeHash}`,
      JSON.stringify({
        revoked: result.revoked.length,
        skippedPaid: result.skippedPaid.length,
        hostingExpired: result.hostingExpired,
      })
    );
    revalidatePath('/dashboard/codes');
    redirect(
      `/dashboard/codes?code=${encodeURIComponent(codeHash)}`
        + `&done=clawed:${result.revoked.length}:${result.skippedPaid.length}`
    );
  }

  async function revealOne(formData: FormData) {
    'use server';
    const session = await getSession();
    if (!session.adminId) redirect('/login');
    const codeHash = s(formData.get('code_hash'));
    if (!codeHash) redirect('/dashboard/codes?error=No+code+selected');

    await audit(session.username, 'access_code.reveal', `code:${codeHash}`);
    redirect(
      `/dashboard/codes?code=${encodeURIComponent(codeHash)}&reveal=${encodeURIComponent(codeHash)}`
    );
  }

  return (
    <div className="page-body">
      <div className="page-title">Access codes</div>

      {error ? <div className="form-error" style={{ marginBottom: 16 }}>{error}</div> : null}
      {done ? <div className="form-success">{describeDone(done)}</div> : null}

      <div className="stat-grid">
        <div className="stat">
          <div className="stat-val">{stats.live}</div>
          <div className="stat-key">Live codes</div>
        </div>
        <div className="stat">
          <div className="stat-val">{stats.total}</div>
          <div className="stat-key">Codes ever minted</div>
        </div>
        <div className="stat">
          <div className="stat-val">{stats.redemptions}</div>
          <div className="stat-key">Redemptions</div>
        </div>
      </div>

      {minted.length > 0 ? (
        <section className="card" style={{ marginBottom: 18 }}>
          <div className="section-title">Just minted — copy these now</div>
          <p className="mono" style={{ marginBottom: 12 }}>
            {minted.length} code{minted.length === 1 ? '' : 's'}. They are stored encrypted and
            can be revealed one at a time later, but this is the only place they appear together.
          </p>
          <textarea
            readOnly
            rows={Math.min(12, minted.length + 1)}
            style={{ width: '100%', fontFamily: 'var(--font)', fontSize: 13, letterSpacing: '0.06em' }}
            value={minted.map((row) => row.code ?? `${row.hint} (could not decrypt)`).join('\n')}
          />
        </section>
      ) : null}

      <div className="grid-2" style={{ alignItems: 'start' }}>
        <section className="card">
          <div className="section-title">Mint codes</div>
          <form action={mint}>
            <div className="form-grid">
              <div className="form-row">
                <label className="form-label" htmlFor="kind">Grants</label>
                <select id="kind" name="kind" defaultValue="play" style={{ width: '100%' }}>
                  <option value="play">Game access (as if paid)</option>
                  <option value="server">Custom server hosting</option>
                </select>
              </div>
              <div className="form-row">
                <label className="form-label" htmlFor="days">Days</label>
                <input id="days" name="days" type="number" min={1} max={MAX_GRANT_DAYS} defaultValue={30} />
              </div>
              <div className="form-row">
                <label className="form-label" htmlFor="quantity">How many codes</label>
                <input id="quantity" name="quantity" type="number" min={1} max={MAX_BATCH} defaultValue={1} />
              </div>
              <div className="form-row">
                <label className="form-label" htmlFor="max_uses">Uses per code</label>
                <input id="max_uses" name="max_uses" type="number" min={1} max={MAX_USES_PER_CODE} defaultValue={1} />
              </div>
              <div className="form-row">
                <label className="form-label" htmlFor="label">Label</label>
                <input id="label" name="label" placeholder="Discord launch" maxLength={200} />
              </div>
              <div className="form-row">
                <label className="form-label" htmlFor="expires_at">Code expires (optional)</label>
                <input id="expires_at" name="expires_at" type="date" />
              </div>
            </div>
            <p className="mono" style={{ margin: '4px 0 14px' }}>
              One use per code is a hand-out. Raise it for a single shareable promo code —
              the expiry above is when the CODE stops working, not how long the grant lasts.
            </p>
            <button type="submit" className="btn btn-primary">Mint</button>
          </form>
        </section>

        <section className="card">
          <div className="section-title">
            {selectedRow ? `Code ${selectedRow.code_hint}` : 'Select a code'}
          </div>
          {!selectedRow ? (
            <p className="mono">Pick a code from the table to see who redeemed it and to withdraw it.</p>
          ) : (
            <>
              {revealed ? (
                <div className="form-success" style={{ fontSize: 15, letterSpacing: '0.08em' }}>
                  {revealed}
                </div>
              ) : (
                <form action={revealOne} style={{ marginBottom: 14 }}>
                  <input type="hidden" name="code_hash" value={selectedRow.code_hash} />
                  <button type="submit" className="btn">Reveal code</button>
                </form>
              )}

              <div className="mini-stack" style={{ marginBottom: 16 }}>
                <div>
                  <span className="mini-label">Grants</span>
                  {selectedRow.kind === 'server' ? 'Custom server hosting' : 'Game access'} · {selectedRow.days} days
                </div>
                <div>
                  <span className="mini-label">Used</span>
                  {selectedRow.uses} of {selectedRow.max_uses}
                </div>
                <div>
                  <span className="mini-label">Minted</span>
                  {selectedRow.created_by} · {fmt(selectedRow.created_at)}
                </div>
                {selectedRow.label ? (
                  <div><span className="mini-label">Label</span>{selectedRow.label}</div>
                ) : null}
                {selectedRow.expires_at ? (
                  <div><span className="mini-label">Code expires</span>{fmt(selectedRow.expires_at)}</div>
                ) : null}
                {selectedRow.revoked_at ? (
                  <div>
                    <span className="mini-label">Withdrawn</span>
                    {fmt(selectedRow.revoked_at)} by {selectedRow.revoked_by ?? 'unknown'}
                  </div>
                ) : null}
              </div>

              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 18 }}>
                {selectedRow.revoked_at ? (
                  <form action={restore}>
                    <input type="hidden" name="code_hash" value={selectedRow.code_hash} />
                    <button type="submit" className="btn">Put back into service</button>
                  </form>
                ) : (
                  <form action={revoke}>
                    <input type="hidden" name="code_hash" value={selectedRow.code_hash} />
                    <button type="submit" className="btn btn-danger">Withdraw code</button>
                  </form>
                )}
                {redemptions.some((r) => !r.clawed_back_at) ? (
                  <form action={clawBack}>
                    <input type="hidden" name="code_hash" value={selectedRow.code_hash} />
                    <button type="submit" className="btn btn-danger">
                      Also end access for {redemptions.filter((r) => !r.clawed_back_at).length} redeemer
                      {redemptions.filter((r) => !r.clawed_back_at).length === 1 ? '' : 's'}
                    </button>
                  </form>
                ) : null}
              </div>

              <div className="section-title" style={{ fontSize: 11 }}>Redeemed by</div>
              {redemptions.length === 0 ? (
                <p className="mono">Nobody has redeemed this code yet.</p>
              ) : (
                <div className="tbl-wrap">
                  <table>
                    <thead>
                      <tr><th>Player</th><th>When</th><th>State</th></tr>
                    </thead>
                    <tbody>
                      {redemptions.map((row) => (
                        <tr key={row.player_id}>
                          <td>
                            <Link href={`/dashboard/players/${row.player_id}`}>
                              {row.handle ?? row.email ?? row.player_id.slice(0, 8)}
                            </Link>
                          </td>
                          <td className="mono">{fmt(row.redeemed_at)}</td>
                          <td>
                            {row.clawed_back_at ? (
                              <span className="tag tag-red">Clawed back</span>
                            ) : row.paid_since ? (
                              <span className="tag tag-cyan">Paid since — will be skipped</span>
                            ) : row.has_active_access || row.kind === 'server' ? (
                              <span className="tag tag-green">Active</span>
                            ) : (
                              <span className="tag tag-amber">Lapsed</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      <div style={{ marginTop: 24 }}>
        <div className="section-title">All codes</div>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Code</th><th>Grants</th><th>Days</th><th>Used</th>
                <th>Label</th><th>Minted</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {codes.length === 0 ? (
                <tr><td colSpan={7} className="mono">No codes yet.</td></tr>
              ) : (
                codes.map((row) => (
                  <tr key={row.code_hash}>
                    <td className="mono">
                      <Link href={`/dashboard/codes?code=${encodeURIComponent(row.code_hash)}`}>
                        {row.code_hint}
                      </Link>
                    </td>
                    <td>{row.kind === 'server' ? 'Server' : 'Access'}</td>
                    <td className="mono">{row.days}</td>
                    <td className="mono">{row.uses}/{row.max_uses}</td>
                    <td>{row.label ?? '—'}</td>
                    <td className="mono">{fmt(row.created_at)}</td>
                    <td><StatusTag row={row} /></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StatusTag({ row }: { row: { revoked_at: string | null; uses: number; max_uses: number; expires_at: string | null } }) {
  if (row.revoked_at) return <span className="tag tag-red">Withdrawn</span>;
  if (row.uses >= row.max_uses) return <span className="tag tag-amber">Used up</span>;
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
    return <span className="tag tag-amber">Expired</span>;
  }
  return <span className="tag tag-green">Live</span>;
}

function fmt(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 16).replace('T', ' ') : '—';
}

/** Turn the `done=` token back into a sentence, so the action reports its count. */
function describeDone(token: string): string {
  if (token === 'revoked') return 'Code withdrawn. Nobody who already redeemed it was affected.';
  if (token === 'restored') return 'Code put back into service.';
  if (token.startsWith('clawed:')) {
    const [, revoked, skipped] = token.split(':');
    const skippedNote = Number(skipped) > 0
      ? ` ${skipped} skipped because they have bought access since redeeming.`
      : '';
    return `Access ended for ${revoked} redeemer${revoked === '1' ? '' : 's'}.${skippedNote}`;
  }
  return 'Done.';
}
