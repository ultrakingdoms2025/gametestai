'use client';

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import HostingSubscribeButton from './HostingSubscribeButton';
import { OVERLAY_WORLDS } from '@/lib/mapOverlaySchema';
import { LORE_SCOPES } from '@/lib/loreScopes';
import {
  MARKETPLACE_ACTIONS,
  MARKETPLACE_CATEGORIES,
  MARKETPLACE_WORLDS,
} from '@/lib/marketplaceCatalog';

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
  /* `deleted` never reaches the owner's lists (they exclude it) but CAN appear
   * in the platform admin's all-servers view, which deliberately keeps
   * history visible. */
  status: 'active' | 'suspended' | 'deleted';
  /** `extend`: platform content plus this server's. `replace`: this server's only. */
  contentMode: 'extend' | 'replace';
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
    /** Nobody paid for this one. See `premium.ts`, "Simulated purchase". */
    simulated: boolean;
  };
  sku: { totalCents: number; detail: string; label: string; intent: string };
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

/* ---- dropdown sources -------------------------------------------------
 * Every one of these is the CANONICAL list the write path validates against
 * (or, for lore, the canonical order the read path sorts by). Nothing here is
 * hand-written: a free-text `game_action` once took the whole marketplace of a
 * server to a bodiless 500, and a hand-copied list is the same bug on a delay.
 * `contentDropdowns.test.ts` fails this file if a second list appears. */
const WORLD_OPTIONS = OVERLAY_WORLDS.map((w) => ({ value: w, label: w }));
const LORE_SCOPE_OPTIONS = LORE_SCOPES.map((s) => ({ value: s, label: s }));
const CATEGORY_OPTIONS = MARKETPLACE_CATEGORIES.map((c) => ({ value: c, label: c }));
const ACTION_OPTIONS = MARKETPLACE_ACTIONS.map((a) => ({ value: a.id, label: `${a.label} — ${a.id}` }));
const ITEM_WORLD_OPTIONS = MARKETPLACE_WORLDS.map((w) => ({ value: w, label: w }));

/**
 * A `<select>` over a canonical list.
 *
 * `legacyValues` is for rows that already hold a value outside the list (rows
 * written before the write path validated, or scopes the platform never
 * named): they are offered, labelled as legacy, rather than silently dropped
 * or rewritten — deleting an owner's data by prettying up a form is not a UX
 * improvement.
 */
function Picker(props: {
  name: string;
  ariaLabel: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  placeholder: string;
  required?: boolean;
  legacyValues?: readonly string[];
}) {
  const legacy = (props.legacyValues ?? []).filter(
    (v, i, all) => v && all.indexOf(v) === i && !props.options.some((o) => o.value === v)
  );
  return (
    <select name={props.name} aria-label={props.ariaLabel} style={input}
      required={props.required} defaultValue="">
      <option value="" disabled>{props.placeholder}</option>
      {props.options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
      {legacy.map((v) => (
        <option key={`legacy:${v}`} value={v}>{v} (legacy)</option>
      ))}
    </select>
  );
}

/**
 * @param justSubscribed the customer arrived here straight from a completed
 * hosting purchase (`/admin/servers?subscribed=1`, which is both the live
 * `success_url` and where the simulated confirm redirects). It is the trigger
 * for the "what now?" callout — the answer to "how would they after purchase
 * access backend to set up".
 */
export function ServerAdminPanel({ justSubscribed = false }: { justSubscribed?: boolean } = {}) {
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

  /* ---- invite type-ahead ------------------------------------------------
   * A searchable list instead of a blind handle field: the owner types two or
   * more characters and the owner-gated search route answers with up to ten
   * matching handles (players already on the roster excluded). Debounced so a
   * keystroke is not a request, and stale responses are dropped so a slow
   * early answer cannot overwrite a fast later one. */
  const [inviteQuery, setInviteQuery] = useState('');
  const [inviteResults, setInviteResults] = useState<Array<{ playerId: string; handle: string }>>([]);
  const [searching, setSearching] = useState(false);
  /* The typed confirmation for Delete: the server's own name, verbatim. A
   * click-through dialog is muscle memory; retyping the name is a decision. */
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const detailServerId = detail?.server.id ?? null;

  useEffect(() => { setInviteQuery(''); setDeleteConfirm(''); }, [selected]);

  useEffect(() => {
    const q = inviteQuery.trim();
    if (!detailServerId || q.length < 2) {
      setInviteResults([]);
      setSearching(false);
      return;
    }
    let stale = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const data = await api<{ players: Array<{ playerId: string; handle: string }> }>(
          `/api/servers/${detailServerId}/members/search?q=${encodeURIComponent(q)}`
        );
        if (!stale) setInviteResults(data.players);
      } catch {
        if (!stale) setInviteResults([]);
      } finally {
        if (!stale) setSearching(false);
      }
    }, 250);
    return () => { stale = true; clearTimeout(timer); };
  }, [inviteQuery, detailServerId]);

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
  const hosting = ent.status === 'active' || ent.status === 'past_due';

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      {error && (
        <div role="alert" style={{ ...card, borderColor: '#7a2b2b', color: '#ffb4b4' }}>{error}</div>
      )}

      {/* ---- what now? ---------------------------------------------------
          The answer to "how would they after purchase access backend to set
          up". Shown only on arrival from a purchase, and only once the
          entitlement is actually readable, so it never promises a dashboard
          the customer cannot use yet. */}
      {justSubscribed && hosting && (
        <section role="status" style={{ ...card, borderColor: '#2b805f' }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Your hosting is live — two steps left</h2>
          <ol style={{ margin: 0, paddingLeft: 20, color: '#cfe6f5', display: 'grid', gap: 6 }}>
            <li><b>Name your server</b> in &ldquo;New server&rdquo; just below. That creates it.</li>
            <li><b>Invite your players</b> by handle from the &ldquo;Members&rdquo; panel once it exists.</li>
          </ol>
          <p style={{ margin: 0, color: '#9bb0c2', fontSize: 13 }}>
            After that, &ldquo;Quests&rdquo;, &ldquo;Lore&rdquo; and &ldquo;Marketplace items&rdquo;
            on this page are your server&rsquo;s own content — none of it touches the default
            game or the shared leaderboards.
          </p>
        </section>
      )}

      {/* ---- subscription ------------------------------------------------ */}
      <section style={card}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Hosting subscription</h2>
        <p style={{ margin: 0, color: '#9bb0c2' }}>
          {hosting
            ? `Active — ${ent.used} of ${ent.maxServers} server${ent.maxServers === 1 ? '' : 's'} in use.`
            : 'No hosting subscription. A custom server needs one before it can be created.'}
          {ent.status === 'past_due' && ' Payment is overdue; hosting continues while Stripe retries.'}
        </p>
        {/* Never let the screen imply a payment was taken when none was. */}
        {ent.simulated && (
          <p style={{ margin: 0, color: '#ffdca6', fontSize: 13 }}>
            <b>Simulated subscription.</b> No card was charged and nothing reached Stripe —
            this exists so the product can be set up and used before payments are switched
            on. It works exactly like a paid one, and it will be cleared when real billing
            goes live.
          </p>
        )}
        {!ent.canCreate && !hosting && (
          <HostingSubscribeButton
            intent={overview.sku.intent}
            detail={overview.sku.detail}
            callbackUrl="/admin/servers"
            style={btn}
            disabled={busy}
          />
        )}
        {/* At quota with hosting live: the SAME control, buying one more slot.
            Pay-per-server means "New server" beyond the allowance is another
            purchase — simulated today, so no card is taken (the banner above
            says so) — and checkout lands back here with the slot added. */}
        {hosting && !ent.canCreate && (
          <>
            <p style={{ margin: 0, color: '#9bb0c2', fontSize: 13 }}>
              Every server slot you have paid for is in use. Each additional
              server is a separate purchase at the same monthly price.
            </p>
            <HostingSubscribeButton
              intent={overview.sku.intent}
              detail={overview.sku.detail}
              caption="Add another server"
              callbackUrl="/admin/servers"
              style={btn}
              disabled={busy}
            />
          </>
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
          {/* ---- play it ------------------------------------------------- */}
          {detail.server.status === 'active' && (
            <section style={card}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                {/* The owner's natural next step after creating: go be IN it.
                    /play opens the launch modal, where this server shows
                    "Approved + Enter" — the same door every member uses, so
                    what the owner sees is what their players see. */}
                <a href="/play" style={{ ...btn, textDecoration: 'none', display: 'inline-block' }}>
                  Enter this server →
                </a>
                <span style={{ color: '#7fa4bd', fontSize: 13 }}>
                  Opens the game&rsquo;s launch screen — pick {detail.server.name} there and
                  everything in-game (quests, marketplace, lore, credits) is this
                  server&rsquo;s own.
                </span>
              </div>
            </section>
          )}

          {/* ---- members ------------------------------------------------- */}
          <section style={card}>
            <h2 style={{ margin: 0, fontSize: 18 }}>Members of {detail.server.name}</h2>

            {/* Requests first: these are the rows where somebody is actively
                waiting on the owner, so they outrank a roster that is merely
                true. */}
            {detail.members.some((m) => m.state === 'requested') && (
              <div style={{ display: 'grid', gap: 6 }}>
                <h3 style={{ margin: 0, fontSize: 14, color: '#ffd9a0' }}>
                  Requests to join
                </h3>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
                  {detail.members.filter((m) => m.state === 'requested').map((m) => (
                    <li key={m.playerId} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span style={{ minWidth: 180 }}>{m.handle ?? '(no handle)'}</span>
                      <button type="button" style={btn} disabled={busy}
                        onClick={() => run(() => memberAction(detail.server.id, m, 'approve'))}>
                        Approve
                      </button>
                      <button type="button" style={btn} disabled={busy}
                        onClick={() => run(() => memberAction(detail.server.id, m, 'reject'))}>
                        Reject
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Invite via search, not via a blind handle field. Results come
                from the owner-gated search route: handle matches only, two
                characters minimum, roster excluded, never an email. */}
            <div style={{ display: 'grid', gap: 6 }}>
              <label style={label} htmlFor="invite-search">INVITE A PLAYER</label>
              <input
                id="invite-search"
                type="search"
                role="combobox"
                aria-expanded={inviteResults.length > 0}
                aria-controls="invite-results"
                autoComplete="off"
                placeholder="Search by handle (2+ characters)"
                style={{ ...input, maxWidth: 320 }}
                value={inviteQuery}
                onChange={(e) => setInviteQuery(e.target.value)}
              />
              <ul id="invite-results" role="listbox" aria-label="Matching players"
                style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {inviteResults.map((p) => (
                  <li key={p.playerId} role="option" aria-selected={false}>
                    <button type="button" style={{ ...btn, padding: '6px 12px' }} disabled={busy}
                      onClick={() => {
                        void run(() => api(`/api/servers/${detail.server.id}/members`, {
                          method: 'POST',
                          body: JSON.stringify({ action: 'invite', handle: p.handle }),
                        }));
                        setInviteQuery('');
                      }}>
                      Invite {p.handle}
                    </button>
                  </li>
                ))}
              </ul>
              <p role="status" style={{ margin: 0, color: '#7fa4bd', fontSize: 12 }}>
                {searching
                  ? 'Searching…'
                  : inviteQuery.trim().length >= 2 && !inviteResults.length
                    ? 'No players match that handle (players already on the roster are not shown).'
                    : ''}
              </p>
            </div>

            {/* The roster. Requested rows live in the panel above. */}
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
              {detail.members.filter((m) => m.state !== 'requested').map((m) => (
                <li key={m.playerId} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ minWidth: 180 }}>{m.handle ?? '(no handle)'}</span>
                  {/* The owner's own row says WHY it has no Remove button. A
                      fresh server's roster is exactly one row - the owner -
                      and a lone unlabelled row with no controls made the whole
                      remove capability look absent; the owner reported it as
                      missing. Ownership rides `owner_player_id` on the server,
                      not this row, so removing it would only strand the owner
                      out of scoped play on their own server. */}
                  {m.playerId === detail.server.ownerPlayerId ? (
                    <span style={{ color: '#d8b25a', minWidth: 90 }}>owner</span>
                  ) : (
                    <span style={{ color: '#7fa4bd', minWidth: 90 }}>{m.state}</span>
                  )}
                  {m.state === 'invited' && (
                    <>
                      <button type="button" style={btn} disabled={busy}
                        onClick={() => run(() => memberAction(detail.server.id, m, 'approve'))}>
                        Approve
                      </button>
                      {/* `reject` from `invited` IS retraction - same verb the
                          transition table already carries; only the word on
                          the button changes, because "Reject" on an invitation
                          the owner sent themselves reads backwards. */}
                      <button type="button" style={btn} disabled={busy}
                        onClick={() => run(() => memberAction(detail.server.id, m, 'reject'))}>
                        Retract invite
                      </button>
                    </>
                  )}
                  {m.state === 'approved' && m.playerId !== detail.server.ownerPlayerId && (
                    <button type="button" style={btn} disabled={busy}
                      onClick={() => run(() => memberAction(detail.server.id, m, 'remove'))}>
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {detail.members.filter((m) => m.state !== 'requested' && m.playerId !== detail.server.ownerPlayerId).length === 0 && (
              <p style={{ color: '#7fa4bd', fontSize: 13, margin: '8px 0 0' }}>
                No members yet. Players you invite or approve appear here, each with a
                Remove control.
              </p>
            )}
          </section>

          {/* ---- content mode --------------------------------------------
              The owner's one decision about how everything authored below
              meets the default game. Two radios, one honest sentence each —
              the replace sentence says out loud that a thin server LOOKS
              thin, because a member who finds an empty marketplace after
              joining reads it as an outage. PATCHed alone; every other field
              is absent, and absent means unchanged. */}
          <section style={card}>
            <h2 style={{ margin: 0, fontSize: 18 }}>Content mode</h2>
            <div role="radiogroup" aria-label="Content mode" style={{ display: 'grid', gap: 10 }}>
              {([
                {
                  value: 'extend' as const,
                  title: 'Extend the default game',
                  blurb: 'Members get every platform quest, marketplace item and lore entry, plus everything you author below. This is the default, and how every server behaved before this choice existed.',
                },
                {
                  value: 'replace' as const,
                  title: 'Replace the default game',
                  blurb: 'Members see ONLY what you author below — a server with 3 quests shows exactly 3 quests, and the platform quests, marketplace items and lore are gone until you switch back.',
                },
              ]).map((opt) => (
                <label key={opt.value}
                  style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="contentMode"
                    value={opt.value}
                    checked={detail.server.contentMode === opt.value}
                    disabled={busy}
                    onChange={() => run(() => api(`/api/servers/${detail.server.id}`, {
                      method: 'PATCH',
                      body: JSON.stringify({ contentMode: opt.value }),
                    }))}
                  />
                  <span style={{ display: 'grid', gap: 2 }}>
                    <b>{opt.title}</b>
                    <span style={{ color: '#9bb0c2', fontSize: 13 }}>{opt.blurb}</span>
                  </span>
                </label>
              ))}
            </div>
            {detail.server.contentMode === 'replace' && (
              <p style={{ margin: 0, color: '#ffdca6', fontSize: 13 }}>
                Members keep any quest they had already started, including platform ones —
                switching modes never cancels work in progress. The directory marks this
                server &ldquo;curated&rdquo; so joining players know what to expect.
              </p>
            )}
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
              {/* The canonical 18, from `mapOverlaySchema` — the list a test
                  already pins to the game's own world registrations. Free
                  text here would author quests no player can ever reach. */}
              <Picker name="world" ariaLabel="World" options={WORLD_OPTIONS}
                placeholder="world…" required />
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
                {/* The canonical lore scopes in their canonical order, plus
                    any scope an existing row of THIS server already holds
                    outside that list — offered as "(legacy)" so the entry
                    stays editable rather than stranded. Saving to an existing
                    scope replaces that entry (upsert). */}
                <Picker name="scope" ariaLabel="Lore scope" options={LORE_SCOPE_OPTIONS}
                  placeholder="scope…" required
                  legacyValues={detail.lore.map((l) => l.scope)} />
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
                    /* No fallback literal: the category is a required select
                       over the canonical list, and the write validates. */
                    category: String(form.get('category') ?? ''),
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
              {/* All three from `marketplaceCatalog` — the SAME constants the
                  write path validates against and the read path throws on. A
                  free-text `gameAction` here once took a server's whole
                  marketplace listing to a 500. */}
              <Picker name="category" ariaLabel="Category" options={CATEGORY_OPTIONS}
                placeholder="category…" required />
              <Picker name="gameAction" ariaLabel="Game action" options={ACTION_OPTIONS}
                placeholder="game action…" required />
              <Picker name="worldName" ariaLabel="World" options={ITEM_WORLD_OPTIONS}
                placeholder="world…" required />
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

          {detail.isOwner && (
            <section style={{ ...card, borderColor: '#7a2b2b' }}>
              <h2 style={{ margin: 0, fontSize: 18 }}>Delete this server</h2>
              <p style={{ margin: 0, color: '#9bb0c2', fontSize: 13 }}>
                Deleting hides {detail.server.name} from every directory and closes it to all
                members immediately. Members&rsquo; server-credit history is kept for the
                record, but nobody can enter or earn again. <b>Your server slot frees at
                once</b> — you can create a new server without buying another slot.
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (deleteConfirm.trim() !== detail.server.name) return;
                  const doomed = detail.server.id;
                  setDeleteConfirm('');
                  /* NOT `run(...)`: that helper reloads the detail of the
                   * still-`selected` server afterwards, and the server this
                   * just deleted answers 404 — the owner would see "Not
                   * found." as the reward for a successful delete. */
                  void (async () => {
                    setBusy(true);
                    setError(null);
                    try {
                      await api(`/api/servers/${doomed}`, { method: 'DELETE' });
                      setSelected(null);
                      setDetail(null);
                      await loadOverview();
                    } catch (err) {
                      setError((err as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  })();
                }}
                style={{ display: 'grid', gap: 8, maxWidth: 420 }}
              >
                <label style={label} htmlFor="delete-confirm">
                  TYPE THE SERVER&rsquo;S NAME TO CONFIRM
                </label>
                <input
                  id="delete-confirm"
                  style={input}
                  autoComplete="off"
                  placeholder={detail.server.name}
                  value={deleteConfirm}
                  onChange={(e) => setDeleteConfirm(e.target.value)}
                />
                <div>
                  <button
                    type="submit"
                    style={{ ...btn, borderColor: '#7a2b2b', color: '#ffb4b4' }}
                    disabled={busy || deleteConfirm.trim() !== detail.server.name}
                  >
                    Delete {detail.server.name}
                  </button>
                </div>
              </form>
            </section>
          )}

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
