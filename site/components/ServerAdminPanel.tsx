'use client';

import { useCallback, useEffect, useState, type CSSProperties } from 'react';

/**
 * Owner CRUD over an owner's own server (7c), and the platform admin's view of
 * every server.
 *
 * ── Why this lives in the site app and not the admin app ──────────────────
 *
 * The roadmap says "reusing the existing dashboard". There are two, and this is
 * the right one: the `admin/` app authenticates STAFF against its own session
 * system, while a server owner is an ordinary player with a site account and a
 * subscription. Putting owner CRUD behind staff credentials would mean either
 * giving every owner a staff login or building a second one — and the site app
 * already hosts `/admin/marketplace` and `/admin/map`, so "the existing
 * dashboard" is a real place with a real precedent.
 *
 * Platform-admin visibility rides the same page, gated on the `ADMIN_EMAILS`
 * allowlist that `adminAccess.ts` already uses, and shows every server rather
 * than only the caller's.
 */

type ServerRow = {
  id: string;
  name: string;
  slug: string;
  description: string;
  status: 'active' | 'suspended';
  ownerPlayerId: string;
  createdAt: string;
};

type Member = { playerId: string; handle: string | null; state: string; updatedAt: string };
type Quest = {
  id: string; title: string; world: string; questLine: string;
  rewardCredits: number; isActive: boolean; questNumber: number;
};
type Lore = { scope: string; title: string; signLabel: string; body: string };
type Item = {
  id: string; name: string; category: string; worldName: string;
  costBuy: number; costSell: number; isActive: boolean;
};

type Overview = {
  owned: ServerRow[];
  memberships: Array<ServerRow & { state: string }>;
  joinable: ServerRow[];
  all: ServerRow[] | null;
  platformAdmin: boolean;
  entitlement: {
    status: string; maxServers: number; used: number;
    canCreate: boolean; currentPeriodEnd: string | null;
  };
  sku: { totalCents: number; detail: string; label: string };
};

type Detail = {
  server: ServerRow;
  isOwner: boolean;
  members: Member[];
  quests: Quest[];
  lore: Lore[];
  items: Item[];
};

const card: CSSProperties = {
  border: '1px solid #1d3346', borderRadius: 10, padding: 16,
  background: 'rgba(8,18,28,0.6)', display: 'grid', gap: 12,
};
const label: CSSProperties = { fontSize: 12, color: '#7fa4bd', letterSpacing: '0.08em' };
const input: CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 6,
  border: '1px solid #23415a', background: '#061019', color: '#dcecf7',
};
const btn: CSSProperties = {
  padding: '8px 14px', borderRadius: 6, border: '1px solid #2b5f80',
  background: '#0d2233', color: '#9fe4ff', cursor: 'pointer',
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(body?.error ?? `Request failed (${res.status})`));
  return body as T;
}

export function ServerAdminPanel() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadOverview = useCallback(async () => {
    try {
      const data = await api<Overview>('/api/servers');
      setOverview(data);
      setSelected((current) => current ?? data.owned[0]?.id ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const loadDetail = useCallback(async (id: string | null) => {
    if (!id) return setDetail(null);
    try {
      setDetail(await api<Detail>(`/api/servers/${id}`));
    } catch (e) {
      setError((e as Error).message);
      setDetail(null);
    }
  }, []);

  useEffect(() => { void loadOverview(); }, [loadOverview]);
  useEffect(() => { void loadDetail(selected); }, [selected, loadDetail]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await loadOverview();
      await loadDetail(selected);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!overview) {
    return <p style={{ color: '#7fa4bd' }}>{error ?? 'Loading servers…'}</p>;
  }

  const ent = overview.entitlement;

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      {error && (
        <div role="alert" style={{ ...card, borderColor: '#7a2b2b', color: '#ffb4b4' }}>{error}</div>
      )}

      {/* ---- subscription ------------------------------------------------ */}
      <section style={card}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Hosting subscription</h2>
        <p style={{ margin: 0, color: '#9bb0c2' }}>
          {ent.status === 'active' || ent.status === 'past_due'
            ? `Active — ${ent.used} of ${ent.maxServers} server${ent.maxServers === 1 ? '' : 's'} in use.`
            : 'No hosting subscription. A custom server needs one before it can be created.'}
          {ent.status === 'past_due' && ' Payment is overdue; hosting continues while Stripe retries.'}
        </p>
        {!ent.canCreate && ent.status !== 'active' && ent.status !== 'past_due' && (
          <div>
            <button
              type="button"
              style={btn}
              disabled={busy}
              onClick={() => run(async () => {
                const out = await api<{ url: string }>('/api/checkout', {
                  method: 'POST',
                  body: JSON.stringify({ intent: 'server_hosting_monthly' }),
                });
                window.location.href = out.url;
              })}
            >
              Subscribe — {overview.sku.detail}
            </button>
          </div>
        )}
      </section>

      {/* ---- create ------------------------------------------------------ */}
      {ent.canCreate && (
        <section style={card}>
          <h2 style={{ margin: 0, fontSize: 18 }}>New server</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              void run(() => api('/api/servers', {
                method: 'POST',
                body: JSON.stringify({
                  name: String(form.get('name') ?? ''),
                  description: String(form.get('description') ?? ''),
                }),
              }));
              e.currentTarget.reset();
            }}
            style={{ display: 'grid', gap: 8 }}
          >
            <label style={label} htmlFor="server-name">NAME</label>
            <input id="server-name" name="name" style={input} required minLength={3} maxLength={48} />
            <label style={label} htmlFor="server-desc">DESCRIPTION</label>
            <input id="server-desc" name="description" style={input} maxLength={300} />
            <div><button type="submit" style={btn} disabled={busy}>Create</button></div>
          </form>
        </section>
      )}

      {/* ---- picker ------------------------------------------------------ */}
      <section style={card}>
        <h2 style={{ margin: 0, fontSize: 18 }}>
          {overview.platformAdmin ? 'Servers (all)' : 'Your servers'}
        </h2>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
          {(overview.all ?? overview.owned).map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => setSelected(s.id)}
                style={{
                  ...btn,
                  width: '100%', textAlign: 'left',
                  borderColor: s.id === selected ? '#52e9ff' : '#2b5f80',
                  opacity: s.status === 'suspended' ? 0.55 : 1,
                }}
              >
                {s.name} <span style={{ color: '#6f8ea3' }}>/{s.slug}</span>
                {s.status === 'suspended' && <span style={{ color: '#ffb4b4' }}> — suspended</span>}
              </button>
            </li>
          ))}
          {!(overview.all ?? overview.owned).length && (
            <li style={{ color: '#7fa4bd' }}>None yet.</li>
          )}
        </ul>
      </section>

      {detail && (
        <>
          {/* ---- members ------------------------------------------------- */}
          <section style={card}>
            <h2 style={{ margin: 0, fontSize: 18 }}>Members of {detail.server.name}</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const form = new FormData(e.currentTarget);
                void run(() => api(`/api/servers/${detail.server.id}/members`, {
                  method: 'POST',
                  body: JSON.stringify({ action: 'invite', handle: String(form.get('handle') ?? '') }),
                }));
                e.currentTarget.reset();
              }}
              style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
            >
              <input name="handle" placeholder="player handle" style={{ ...input, maxWidth: 260 }} required />
              <button type="submit" style={btn} disabled={busy}>Invite</button>
            </form>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
              {detail.members.map((m) => (
                <li key={m.playerId} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ minWidth: 180 }}>{m.handle ?? '(no handle)'}</span>
                  <span style={{ color: '#7fa4bd', minWidth: 90 }}>{m.state}</span>
                  {m.state === 'requested' || m.state === 'invited' ? (
                    <>
                      <button type="button" style={btn} disabled={busy}
                        onClick={() => run(() => memberAction(detail.server.id, m, 'approve'))}>
                        Approve
                      </button>
                      <button type="button" style={btn} disabled={busy}
                        onClick={() => run(() => memberAction(detail.server.id, m, 'reject'))}>
                        Reject
                      </button>
                    </>
                  ) : null}
                  {m.state === 'approved' && m.playerId !== detail.server.ownerPlayerId && (
                    <button type="button" style={btn} disabled={busy}
                      onClick={() => run(() => memberAction(detail.server.id, m, 'remove'))}>
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>

          {/* ---- quests -------------------------------------------------- */}
          <section style={card}>
            <h2 style={{ margin: 0, fontSize: 18 }}>Quests</h2>
            <p style={{ margin: 0, color: '#7fa4bd', fontSize: 13 }}>
              Authored quests are stamped to this server. They never appear in the default
              game and never move a shared leaderboard — everything earned here accrues to
              this server&rsquo;s own ledger and its own board.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const form = new FormData(e.currentTarget);
                void run(() => api(`/api/servers/${detail.server.id}/content`, {
                  method: 'POST',
                  body: JSON.stringify({
                    kind: 'quest',
                    world: String(form.get('world') ?? ''),
                    title: String(form.get('title') ?? ''),
                    questLine: String(form.get('questLine') ?? 'custom'),
                    rewardCredits: Number(form.get('rewardCredits') ?? 0),
                  }),
                }));
                e.currentTarget.reset();
              }}
              style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))' }}
            >
              <input name="title" placeholder="title" style={input} required />
              <input name="world" placeholder="world id" style={input} required />
              <input name="questLine" placeholder="quest line" style={input} />
              <input name="rewardCredits" type="number" min={0} placeholder="reward" style={input} />
              <button type="submit" style={btn} disabled={busy}>Author</button>
            </form>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }}>
              {detail.quests.map((q) => (
                <li key={q.id} style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ minWidth: 220 }}>#{q.questNumber} {q.title}</span>
                  <span style={{ color: '#7fa4bd' }}>{q.world}</span>
                  <span style={{ color: '#9fe4ff' }}>{q.rewardCredits} CR</span>
                  <button type="button" style={btn} disabled={busy}
                    onClick={() => run(() => api(
                      `/api/servers/${detail.server.id}/content?kind=quest&id=${encodeURIComponent(q.id)}`,
                      { method: 'DELETE' }
                    ))}>
                    Delete
                  </button>
                </li>
              ))}
              {!detail.quests.length && <li style={{ color: '#7fa4bd' }}>None yet.</li>}
            </ul>
          </section>

          {/* ---- lore ---------------------------------------------------- */}
          <section style={card}>
            <h2 style={{ margin: 0, fontSize: 18 }}>Lore</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const form = new FormData(e.currentTarget);
                void run(() => api(`/api/servers/${detail.server.id}/content`, {
                  method: 'POST',
                  body: JSON.stringify({
                    kind: 'lore',
                    scope: String(form.get('scope') ?? ''),
                    title: String(form.get('title') ?? ''),
                    signLabel: String(form.get('signLabel') ?? 'Lorekeeper'),
                    body: String(form.get('body') ?? ''),
                  }),
                }));
                e.currentTarget.reset();
              }}
              style={{ display: 'grid', gap: 8 }}
            >
              <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))' }}>
                <input name="scope" placeholder="world id" style={input} required />
                <input name="title" placeholder="title" style={input} required />
                <input name="signLabel" placeholder="sign label" style={input} />
              </div>
              <textarea name="body" placeholder="prose" style={{ ...input, minHeight: 80 }} required />
              <div><button type="submit" style={btn} disabled={busy}>Save</button></div>
            </form>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }}>
              {detail.lore.map((l) => (
                <li key={l.scope} style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ minWidth: 120, color: '#7fa4bd' }}>{l.scope}</span>
                  <span>{l.title}</span>
                  <button type="button" style={btn} disabled={busy}
                    onClick={() => run(() => api(
                      `/api/servers/${detail.server.id}/content?kind=lore&id=${encodeURIComponent(l.scope)}`,
                      { method: 'DELETE' }
                    ))}>
                    Delete
                  </button>
                </li>
              ))}
              {!detail.lore.length && <li style={{ color: '#7fa4bd' }}>None yet.</li>}
            </ul>
          </section>

          {/* ---- items --------------------------------------------------- */}
          <section style={card}>
            <h2 style={{ margin: 0, fontSize: 18 }}>Marketplace items</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const form = new FormData(e.currentTarget);
                void run(() => api(`/api/servers/${detail.server.id}/content`, {
                  method: 'POST',
                  body: JSON.stringify({
                    kind: 'item',
                    name: String(form.get('name') ?? ''),
                    description: String(form.get('description') ?? ''),
                    category: String(form.get('category') ?? 'tools'),
                    gameAction: String(form.get('gameAction') ?? ''),
                    worldName: String(form.get('worldName') ?? ''),
                    costBuy: Number(form.get('costBuy') ?? 0),
                    costSell: Number(form.get('costSell') ?? 0),
                  }),
                }));
                e.currentTarget.reset();
              }}
              style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))' }}
            >
              <input name="name" placeholder="name" style={input} required />
              <input name="description" placeholder="description" style={input} />
              <input name="category" placeholder="category" style={input} />
              <input name="gameAction" placeholder="game action" style={input} />
              <input name="worldName" placeholder="world" style={input} />
              <input name="costBuy" type="number" min={0} placeholder="buy" style={input} />
              <input name="costSell" type="number" min={0} placeholder="sell" style={input} />
              <button type="submit" style={btn} disabled={busy}>Add</button>
            </form>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }}>
              {detail.items.map((it) => (
                <li key={it.id} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', opacity: it.isActive ? 1 : 0.55 }}>
                  <span style={{ minWidth: 200 }}>{it.name}</span>
                  <span style={{ color: '#7fa4bd' }}>{it.worldName}</span>
                  <span style={{ color: '#9fe4ff' }}>{it.costBuy} / {it.costSell} CR</span>
                  {it.isActive && (
                    <button type="button" style={btn} disabled={busy}
                      onClick={() => run(() => api(
                        `/api/servers/${detail.server.id}/content?kind=item&id=${encodeURIComponent(it.id)}`,
                        { method: 'DELETE' }
                      ))}>
                      Retire
                    </button>
                  )}
                </li>
              ))}
              {!detail.items.length && <li style={{ color: '#7fa4bd' }}>None yet.</li>}
            </ul>
          </section>

          {overview.platformAdmin && (
            <section style={{ ...card, borderColor: '#5a4620' }}>
              <h2 style={{ margin: 0, fontSize: 18 }}>Platform administration</h2>
              <p style={{ margin: 0, color: '#9bb0c2' }}>
                A suspended server serves nobody, including its owner — its content, chat
                and credits all stop. Reversible.
              </p>
              <div>
                <button type="button" style={btn} disabled={busy}
                  onClick={() => run(() => api(`/api/servers/${detail.server.id}`, {
                    method: 'PATCH',
                    body: JSON.stringify({
                      status: detail.server.status === 'active' ? 'suspended' : 'active',
                    }),
                  }))}>
                  {detail.server.status === 'active' ? 'Suspend' : 'Reinstate'}
                </button>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function memberAction(serverId: string, member: Member, action: string) {
  /* By handle where there is one, by id otherwise. A player with no handle is
   * still removable, which matters because "the account with no name" is exactly
   * the one an owner most wants gone. */
  return api(`/api/servers/${serverId}/members`, {
    method: 'POST',
    body: JSON.stringify(
      member.handle ? { action, handle: member.handle } : { action, playerId: member.playerId }
    ),
  });
}
