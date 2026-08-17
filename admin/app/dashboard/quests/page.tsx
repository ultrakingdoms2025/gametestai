import { revalidatePath } from 'next/cache';
import { redirect, notFound } from 'next/navigation';
import { audit, createQuest, deleteQuest, getQuestById, listQuests, updateQuest } from '@/lib/db';
import { getSession } from '@/lib/session';
import QuestStepEditor from './StepEditor';
import type { Step } from './StepEditor';

export const dynamic = 'force-dynamic';

function s(v: FormDataEntryValue | null) {
  return typeof v === 'string' ? v.trim() : '';
}

function toBool(v: FormDataEntryValue | null) {
  const raw = s(v).toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

function toOptionalNumber(v: FormDataEntryValue | null) {
  const raw = s(v);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function parseStoredSelections(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map((item) => String(item).trim()).filter(Boolean);
  } catch { /* empty */ }
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function serializeSelections(values: string[]) {
  const unique = Array.from(new Set(values.map((item) => item.trim()).filter(Boolean)));
  return unique.length ? JSON.stringify(unique) : null;
}

function parseSteps(value: unknown): Step[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map((s, i) => ({
        order: Number(s.order) || i + 1,
        label: String(s.label ?? ''),
        type: String(s.type ?? 'visit'),
        target: String(s.target ?? ''),
        count: Number(s.count) || 1,
        world: String(s.world ?? ''),
      }));
    }
  } catch { /* empty */ }
  return [];
}

const WORLD_OPTIONS = [
  { value: 'station',  label: 'Station'  },
  { value: 'sports',   label: 'Sports'   },
  { value: 'race',     label: 'Race'     },
  { value: 'medieval', label: 'Medieval' },
  { value: 'citadel',  label: 'Citadel'  },
] as const;

export default async function QuestsPage({
  searchParams,
}: {
  searchParams: Promise<{ quest?: string; saved?: string; error?: string }>;
}) {
  const { quest, saved, error } = await searchParams;
  const rows = await listQuests();
  const questLineOptions = Array.from(
    new Set(rows.map((r: Record<string, unknown>) => String(r.quest_line)))
  ).filter(Boolean);
  const editingId = quest && quest !== 'new' ? quest : null;
  const editing = editingId ? await getQuestById(editingId) : null;
  const selectedPreSteps = parseStoredSelections(editing?.pre_steps);
  const selectedPostSteps = parseStoredSelections(editing?.post_steps);
  const editingSteps = parseSteps(editing?.steps);

  if (editingId && !editing) notFound();

  async function saveQuest(formData: FormData) {
    'use server';
    const session = await getSession();
    if (!session.adminId) redirect('/login');

    const id = s(formData.get('id')) || null;
    const questNumber = Number(s(formData.get('quest_number')) || 0);
    const world = s(formData.get('world'));
    const questLine = s(formData.get('quest_line'));
    const title = s(formData.get('title'));
    const rewardCredits = Number(s(formData.get('reward_credits')) || 0);
    const durationMinutes = toOptionalNumber(formData.get('duration_minutes'));
    const preSteps = formData.getAll('pre_steps').map(s).filter(Boolean);
    const postSteps = formData.getAll('post_steps').map(s).filter(Boolean);
    const notes = s(formData.get('notes'));
    const isActive = toBool(formData.get('is_active'));
    // Off => one-shot: the site refuses to re-accept a completed engagement.
    const repeatable = toBool(formData.get('repeatable'));

    // Steps come as a single JSON string from the client StepEditor component
    let stepsJson: string | null = null;
    const rawSteps = s(formData.get('steps_json'));
    if (rawSteps) {
      try {
        const parsed = JSON.parse(rawSteps);
        if (Array.isArray(parsed) && parsed.length > 0) stepsJson = rawSteps;
      } catch { /* malformed — leave null */ }
    }

    if (!questNumber || !world || !questLine || !title) {
      redirect(
        `/dashboard/quests?${id ? `quest=${encodeURIComponent(id)}&` : ''}error=Quest number, world, line and title are required`
      );
    }
    if (!WORLD_OPTIONS.some((option) => option.value === world)) {
      redirect(
        `/dashboard/quests?${id ? `quest=${encodeURIComponent(id)}&` : ''}error=World must be one of the 5 available worlds`
      );
    }
    if (durationMinutes !== null && (!Number.isInteger(durationMinutes) || durationMinutes < 1)) {
      redirect(
        `/dashboard/quests?${id ? `quest=${encodeURIComponent(id)}&` : ''}error=Completion window must be a whole number of minutes`
      );
    }

    if (id) {
      await updateQuest(id, {
        questNumber, world, questLine, title, rewardCredits, durationMinutes,
        preSteps: serializeSelections(preSteps), postSteps: serializeSelections(postSteps),
        steps: stepsJson, notes, isActive, repeatable, updatedBy: session.username,
      });
      await audit(session.username, 'quest.update', `quest:${id}`, `#${questNumber} ${title}`);
      revalidatePath('/dashboard');
      revalidatePath('/dashboard/quests');
      redirect(`/dashboard/quests?quest=${id}&saved=1`);
    }

    const newId = await createQuest({
      questNumber, world, questLine, title, rewardCredits, durationMinutes,
      preSteps: serializeSelections(preSteps), postSteps: serializeSelections(postSteps),
      steps: stepsJson, notes, isActive, repeatable, updatedBy: session.username,
    });
    await audit(session.username, 'quest.create', `quest:${newId}`, `#${questNumber} ${title}`);
    revalidatePath('/dashboard');
    revalidatePath('/dashboard/quests');
    redirect(`/dashboard/quests?quest=${newId}&saved=1`);
  }

  async function removeQuest(formData: FormData) {
    'use server';
    const session = await getSession();
    if (!session.adminId) redirect('/login');
    const id = s(formData.get('id'));
    if (!id) redirect('/dashboard/quests?error=Missing quest id');
    await deleteQuest(id);
    await audit(session.username, 'quest.delete', `quest:${id}`);
    revalidatePath('/dashboard');
    revalidatePath('/dashboard/quests');
    redirect('/dashboard/quests?saved=1');
  }

  return (
    <div className="page-body">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginBottom: 24 }}>
        <div className="page-title" style={{ marginBottom: 0 }}>Quest management</div>
        <a href="/dashboard/quests?quest=new" className="btn btn-primary">New quest</a>
      </div>

      {saved ? <div className="form-success">Quest saved.</div> : null}
      {error ? <div className="form-error" style={{ marginBottom: 16 }}>{error}</div> : null}

      <div className="grid-2">
        <section className="card">
          <div className="section-title">{editing ? `Edit quest #${editing.quest_number}` : 'Create quest'}</div>
          <form action={saveQuest}>
            {editing ? <input type="hidden" name="id" value={String(editing.id)} /> : null}
            <div className="form-grid">

              <div className="form-row">
                <label className="form-label" htmlFor="quest_number">Quest number</label>
                <input id="quest_number" name="quest_number" type="number" min="1" step="1"
                  defaultValue={String(editing?.quest_number ?? '')} />
              </div>

              <div className="form-row">
                <label className="form-label" htmlFor="reward_credits">Reward credits</label>
                <input id="reward_credits" name="reward_credits" type="number" min="0" step="1"
                  defaultValue={String(editing?.reward_credits ?? 0)} />
              </div>

              <div className="form-row">
                <label className="form-label" htmlFor="duration_minutes">Completion window (minutes)</label>
                <input
                  id="duration_minutes"
                  name="duration_minutes"
                  type="number"
                  min="1"
                  step="1"
                  defaultValue={editing?.duration_minutes != null ? String(editing.duration_minutes) : ''}
                  placeholder="Optional"
                />
              </div>

              <div className="form-row">
                <label className="form-label" htmlFor="world">World assigned to</label>
                <select id="world" name="world" defaultValue={editing?.world ?? ''}>
                  <option value="" disabled>Select a world</option>
                  {WORLD_OPTIONS.map((w) => (
                    <option key={w.value} value={w.value}>{w.label}</option>
                  ))}
                </select>
              </div>

              <div className="form-row">
                <label className="form-label" htmlFor="quest_line">Quest line</label>
                <input id="quest_line" name="quest_line"
                  defaultValue={String(editing?.quest_line ?? '')} placeholder="Main story" />
              </div>

              <div className="form-row" style={{ gridColumn: '1 / -1' }}>
                <label className="form-label" htmlFor="title">Title</label>
                <input id="title" name="title" defaultValue={String(editing?.title ?? '')} />
              </div>

              {/* Activity Steps -- client component handles add/remove */}
              <div className="form-row" style={{ gridColumn: '1 / -1' }}>
                <label className="form-label">Activity steps</label>
                <div style={{ fontSize: 11, color: 'var(--txt-dim)', marginBottom: 8 }}>
                  Each step defines a concrete in-game action the player must complete.
                  Changes are saved when you click &ldquo;Save quest&rdquo;.
                </div>
                <QuestStepEditor initial={editingSteps} />
              </div>

              <div className="form-row" style={{ gridColumn: '1 / -1' }}>
                <label className="form-label" htmlFor="pre_steps">Pre-quest requirements</label>
                <select
                  id="pre_steps"
                  name="pre_steps"
                  multiple
                  size={Math.max(4, Math.min(8, questLineOptions.length || 4))}
                  defaultValue={selectedPreSteps}
                >
                  {questLineOptions.length === 0
                    ? <option value="" disabled>No quest lines available yet</option>
                    : null}
                  {questLineOptions.map((line) => (
                    <option key={line} value={line}>{line}</option>
                  ))}
                </select>
                <div style={{ fontSize: 11, color: 'var(--txt-dim)', marginTop: 6 }}>
                  Hold Ctrl/Cmd to select multiple quest lines.
                </div>
              </div>

              <div className="form-row" style={{ gridColumn: '1 / -1' }}>
                <label className="form-label" htmlFor="post_steps">Unlocks quest lines</label>
                <select
                  id="post_steps"
                  name="post_steps"
                  multiple
                  size={Math.max(4, Math.min(8, questLineOptions.length || 4))}
                  defaultValue={selectedPostSteps}
                >
                  {questLineOptions.length === 0
                    ? <option value="" disabled>No quest lines available yet</option>
                    : null}
                  {questLineOptions.map((line) => (
                    <option key={line} value={line}>{line}</option>
                  ))}
                </select>
                <div style={{ fontSize: 11, color: 'var(--txt-dim)', marginTop: 6 }}>
                  Hold Ctrl/Cmd to select multiple quest lines.
                </div>
              </div>

              <div className="form-row" style={{ gridColumn: '1 / -1' }}>
                <label className="form-label" htmlFor="notes">Notes</label>
                <textarea id="notes" name="notes" rows={3}
                  defaultValue={String(editing?.notes ?? '')} />
              </div>

              <div className="form-row">
                <label className="form-label" htmlFor="is_active">Status</label>
                <select id="is_active" name="is_active"
                  defaultValue={editing ? (editing.is_active ? '1' : '0') : '1'}>
                  <option value="1">Active</option>
                  <option value="0">Disabled</option>
                </select>
              </div>

              <div className="form-row">
                <label className="form-label" htmlFor="repeatable">Repeatable</label>
                <select id="repeatable" name="repeatable"
                  defaultValue={editing?.repeatable ? '1' : '0'}>
                  <option value="0">One-shot (pays once)</option>
                  <option value="1">Repeatable (farmable)</option>
                </select>
                <div style={{ fontSize: 11, color: 'var(--txt-dim)', marginTop: 6 }}>
                  One-shot quests cannot be re-accepted after completion.
                </div>
              </div>
            </div>

            <button type="submit" className="btn btn-primary" style={{ marginTop: 18 }}>
              {editing ? 'Save quest' : 'Create quest'}
            </button>
          </form>

          {editing ? (
            <form action={removeQuest} style={{ marginTop: 16 }}>
              <input type="hidden" name="id" value={String(editing.id)} />
              <button type="submit" className="btn btn-danger">Delete quest</button>
            </form>
          ) : null}
        </section>

        <section className="card">
          <div className="section-title">Quest list</div>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>World</th>
                  <th>Line</th>
                  <th>Title</th>
                  <th>Steps</th>
                  <th>Reward</th>
                  <th>Time limit</th>
                  <th>Repeat</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r: Record<string, unknown>) => {
                  const stepCount = parseSteps(r.steps).length;
                  return (
                    <tr key={String(r.id)}>
                      <td className="mono">{String(r.quest_number)}</td>
                      <td>{String(r.world)}</td>
                      <td>{String(r.quest_line)}</td>
                      <td>{String(r.title)}</td>
                      <td style={{ textAlign: 'center' }}>
                        {stepCount > 0
                          ? <span className="tag tag-green">{stepCount}</span>
                          : <span className="tag tag-amber">0</span>}
                      </td>
                      <td>{String(r.reward_credits)}</td>
                      <td>{r.duration_minutes != null ? `${String(r.duration_minutes)} min` : 'No limit'}</td>
                      <td>
                        {r.repeatable
                          ? <span className="tag tag-amber">Repeatable</span>
                          : <span className="tag tag-green">One-shot</span>}
                      </td>
                      <td>
                        {r.is_active
                          ? <span className="tag tag-green">Active</span>
                          : <span className="tag tag-amber">Disabled</span>}
                      </td>
                      <td>
                        <a
                          className="btn"
                          style={{ fontSize: 11, padding: '4px 10px' }}
                          href={`/dashboard/quests?quest=${encodeURIComponent(String(r.id))}`}
                        >
                          Edit
                        </a>
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={10} style={{ textAlign: 'center', color: 'var(--txt-dim)', padding: 32 }}>
                      No quests yet
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}