import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { audit, listLoreEntries, upsertLoreEntry } from '@/lib/db';
import { getSession, requireAdminPage } from '@/lib/session';

export const dynamic = 'force-dynamic';

/* Mirrors `LORE_ORDER` in src/content/Lore.js. This copy had drifted two
 * scopes behind - the maze and gateway six's destination both had lore in the
 * game and no row on this page, so an admin could not edit either - which is
 * the failure a second hardcoded list always eventually produces. */
const LORE_ORDER = ['overall', 'station', 'medieval', 'sports', 'citadel', 'race', 'maze', 'dock', 'space'] as const;

const LORE_LABELS: Record<(typeof LORE_ORDER)[number], string> = {
  overall: 'Overall lore',
  station: 'Station lore',
  medieval: 'Medieval lore',
  sports: 'Sports lore',
  citadel: 'Citadel lore',
  race: 'Race lore',
  maze: 'Maze lore (The Verdant Coil)',
  dock: 'Dock lore (Lodestar Yard)',
  space: 'Open space lore',
};

function s(v: FormDataEntryValue | null) {
  return typeof v === 'string' ? v.trim() : '';
}

export default async function LorePage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  await requireAdminPage();

  const { saved, error } = await searchParams;
  const rows = await listLoreEntries();
  const byScope = new Map(rows.map((row: Record<string, unknown>) => [String(row.scope), row]));

  async function saveLore(formData: FormData) {
    'use server';
    const session = await getSession();
    if (!session.adminId) redirect('/login');

    const scope = s(formData.get('scope'));
    const title = s(formData.get('title'));
    const signLabel = s(formData.get('sign_label')) || 'Lorekeeper';
    const body = s(formData.get('body'));
    if (!scope || !title || !body) redirect('/dashboard/lore?error=Scope, title and body are required');
    if (!LORE_ORDER.includes(scope as (typeof LORE_ORDER)[number])) {
      redirect('/dashboard/lore?error=Unknown lore scope');
    }

    await upsertLoreEntry({
      scope,
      title,
      signLabel,
      body,
      updatedBy: session.username,
    });
    await audit(session.username, 'lore.update', `lore:${scope}`, title);
    revalidatePath('/dashboard/lore');
    redirect('/dashboard/lore?saved=1');
  }

  return (
    <div className="page-body">
      <h1 className="page-title">Lore management</h1>
      <p style={{ color: 'var(--txt-dim)', fontSize: 12, marginTop: -10, maxWidth: 900 }}>
        These entries feed the portal lorekeepers in-game and the public lore endpoint.
      </p>
      {saved ? <div className="form-success">Lore saved.</div> : null}
      {error ? <div className="form-error" style={{ marginBottom: 16 }}>{error}</div> : null}

      <div style={{ display: 'grid', gap: 16 }}>
        {LORE_ORDER.map((scope) => {
          const entry = (byScope.get(scope) as Record<string, unknown> | undefined) ?? {};
          return (
            <section key={scope} className="card">
              <h2 className="section-title">{LORE_LABELS[scope]}</h2>
              <form action={saveLore}>
                <input type="hidden" name="scope" value={scope} />
                <div className="form-grid">
                  <div className="form-row">
                    <label className="form-label" htmlFor={`${scope}_title`}>Title</label>
                    <input
                      id={`${scope}_title`}
                      name="title"
                      defaultValue={String(entry.title ?? '')}
                      placeholder="Lore title"
                    />
                  </div>
                  <div className="form-row">
                    <label className="form-label" htmlFor={`${scope}_sign_label`}>Sign label</label>
                    <input
                      id={`${scope}_sign_label`}
                      name="sign_label"
                      defaultValue={String(entry.sign_label ?? 'Lorekeeper')}
                      placeholder="Lorekeeper"
                    />
                  </div>
                  <div className="form-row" style={{ gridColumn: '1 / -1' }}>
                    <label className="form-label" htmlFor={`${scope}_body`}>Body</label>
                    <textarea
                      id={`${scope}_body`}
                      name="body"
                      rows={5}
                      defaultValue={String(entry.body ?? '')}
                    />
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 16 }}>
                  <button type="submit" className="btn btn-primary">Save lore</button>
                  <span style={{ color: 'var(--txt-dim)', fontSize: 12 }}>
                    Updated by {String(entry.updated_by ?? '—')}
                  </span>
                </div>
              </form>
            </section>
          );
        })}
      </div>
    </div>
  );
}
