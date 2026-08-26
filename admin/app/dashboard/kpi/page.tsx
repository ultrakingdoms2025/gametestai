import { requireAdminPage } from '@/lib/session';
import { loadKpiReport, KPI_WINDOW_DAYS } from '@/lib/kpi';

export const dynamic = 'force-dynamic';

/**
 * Product KPIs (brief 5.7), computed from `telemetry_events` and nothing
 * else — no joins into players or the credit ledger.
 *
 * Every section renders ONLY what the events can honestly support; the
 * honesty caveats live as comments on each query in `admin/lib/kpiSql.ts`
 * and as the small print under each section here. Sections whose metric
 * needs history the table does not yet hold say so instead of showing a
 * fabricated zero.
 */
export default async function KpiPage() {
  // Guard before the queries, not after: proxy.ts is defence in depth, not the gate.
  await requireAdminPage();

  const kpi = await loadKpiReport();
  const span = kpi.span;
  const days = KPI_WINDOW_DAYS;

  const fmtMin = (s: number | null) =>
    s === null || !Number.isFinite(s) ? '—' : `${(s / 60).toFixed(1)} min`;
  const pct = (num: number, den: number) =>
    den > 0 ? `${((100 * num) / den).toFixed(1)}%` : '—';

  const note: React.CSSProperties = { fontSize: 11, opacity: 0.65, margin: '6px 0 0' };
  const section: React.CSSProperties = { marginTop: 22 };
  const h = (text: string) => (
    <div className="page-title" style={{ fontSize: 13, marginBottom: 10 }}>{text}</div>
  );
  const empty = (text: string) => (
    <div style={{ fontSize: 12, opacity: 0.7, padding: '8px 0' }}>{text}</div>
  );

  if (span.total_events === 0) {
    return (
      <div className="page-body">
        <div className="page-title">Product KPIs</div>
        {empty(
          'No telemetry yet. The game client posts batches to /api/telemetry once ' +
          'src/systems/Telemetry.js is wired into main.js; every metric on this page ' +
          'fills in from there. Nothing is shown because nothing has been measured.'
        )}
      </div>
    );
  }

  // Starts, keyed for the abandonment column.
  const startsByGame = new Map(kpi.minigameStarts.map((r) => [r.game_id ?? '?', r.starts]));

  return (
    <div className="page-body">
      <div className="page-title">Product KPIs</div>
      <p style={note}>
        {span.total_events.toLocaleString()} events · {span.span_days} day{span.span_days === 1 ? '' : 's'} of
        history · windowed metrics cover the last {days} days · all times UTC ·
        retention 90 days (site/lib/telemetry.ts).
      </p>

      {/* ── Headline ─────────────────────────────────────────────────── */}
      <div className="stat-grid" style={{ marginTop: 14 }}>
        <div className="stat">
          <div className="stat-val">{kpi.sessionsPerDay[0]?.sessions ?? 0}</div>
          <div className="stat-key">Sessions today (UTC)</div>
        </div>
        <div className="stat">
          <div className="stat-val">{fmtMin(kpi.medianSession.median_seconds)}</div>
          <div className="stat-key">Median session (floor)</div>
        </div>
        <div className="stat">
          <div className="stat-val">
            {span.span_days >= 2 ? pct(kpi.returnRates.d1_returned, kpi.returnRates.d1_cohort) : '—'}
          </div>
          <div className="stat-key">D1 return</div>
        </div>
        <div className="stat">
          <div className="stat-val">
            {span.span_days >= 8 ? pct(kpi.returnRates.d7_returned, kpi.returnRates.d7_cohort) : '—'}
          </div>
          <div className="stat-key">D7 return</div>
        </div>
      </div>
      <p style={note}>
        Median session is first-to-last event per session — a floor, not a truth: time after the
        final flush is invisible, and one-flush sessions measure near zero.
      </p>

      {/* ── Sessions per day ─────────────────────────────────────────── */}
      <div style={section}>
        {h('Sessions per day')}
        {kpi.sessionsPerDay.length === 0 ? empty(`No events in the last ${days} days.`) : (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Day (UTC)</th><th>Sessions</th><th>Signed-in players</th></tr></thead>
              <tbody>
                {kpi.sessionsPerDay.map((r) => (
                  <tr key={String(r.day)}>
                    <td className="mono">{String(r.day).slice(0, 10)}</td>
                    <td>{r.sessions}</td>
                    <td>{r.signed_in_players}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p style={note}>
          Distinct booted sessions with at least one event that day. Anonymous sessions have no
          durable identity, so this counts sessions, never unique people.
        </p>
      </div>

      {/* ── Return rates ─────────────────────────────────────────────── */}
      <div style={section}>
        {h('D1 / D7 return rate (signed-in only)')}
        {span.span_days < 2 ? (
          empty(`Needs 2 days of data (have ${span.span_days}). D7 needs 8.`)
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Metric</th><th>Cohort</th><th>Returned</th><th>Rate</th></tr></thead>
              <tbody>
                <tr>
                  <td>D1 (came back the next day)</td>
                  <td>{kpi.returnRates.d1_cohort}</td>
                  <td>{kpi.returnRates.d1_returned}</td>
                  <td>{pct(kpi.returnRates.d1_returned, kpi.returnRates.d1_cohort)}</td>
                </tr>
                <tr>
                  <td>D7 (came back within days 1–7)</td>
                  <td>{span.span_days >= 8 ? kpi.returnRates.d7_cohort : '—'}</td>
                  <td>{span.span_days >= 8 ? kpi.returnRates.d7_returned : '—'}</td>
                  <td>{span.span_days >= 8 ? pct(kpi.returnRates.d7_returned, kpi.returnRates.d7_cohort) : 'needs 8 days'}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
        <p style={note}>
          "First seen" means first seen by telemetry, so early cohorts include veteran players and
          the numbers only become trustworthy once the table has real history. Anonymous players
          cannot be tracked across days and are excluded.
        </p>
      </div>

      {/* ── Onboarding funnel ────────────────────────────────────────── */}
      <div style={section}>
        {h('Onboarding step funnel')}
        {kpi.onboardingFunnel.length === 0 ? empty(`No onboarding completions in the last ${days} days.`) : (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Step</th><th>Sessions</th><th>Signed-in players</th></tr></thead>
              <tbody>
                {kpi.onboardingFunnel.map((r) => (
                  <tr key={r.step_id ?? '?'}>
                    <td className="mono">{r.step_id ?? '(unnamed)'}</td>
                    <td>{r.sessions}</td>
                    <td>{r.players}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p style={note}>
          Completions only — a step players saw and bounced off emits nothing, so the drop
          BETWEEN rows is the signal. Ordered by the average completion ordinal the client
          reported, which approximates authored order.
        </p>
      </div>

      {/* ── Minigames ────────────────────────────────────────────────── */}
      <div style={section}>
        {h('Minigame plays and replays')}
        {kpi.minigamePlays.length === 0 && kpi.minigameStarts.length === 0
          ? empty(`No contests in the last ${days} days.`)
          : (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Game</th><th>Starts</th><th>Finishes</th><th>Replays</th><th>Wins</th></tr></thead>
              <tbody>
                {kpi.minigamePlays.map((r) => (
                  <tr key={r.game_id ?? '?'}>
                    <td className="mono">{r.game_id ?? '(unknown)'}</td>
                    <td>{startsByGame.get(r.game_id ?? '?') ?? 0}</td>
                    <td>{r.plays}</td>
                    <td>{r.replays}</td>
                    <td>{r.wins}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p style={note}>
          Replays = finishes beyond the first within one session. Starts minus finishes is
          abandonment (a quit contest never emits a finish) plus batches still in flight.
        </p>
      </div>

      {/* ── Quests ───────────────────────────────────────────────────── */}
      <div style={section}>
        {h('Quest completions per day')}
        {kpi.questCompletions.length === 0 ? empty(`No completions in the last ${days} days.`) : (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Day (UTC)</th><th>Completions</th><th>Completers</th></tr></thead>
              <tbody>
                {kpi.questCompletions.map((r) => (
                  <tr key={String(r.day)}>
                    <td className="mono">{String(r.day).slice(0, 10)}</td>
                    <td>{r.completions}</td>
                    <td>{r.completers}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p style={note}>
          Client-observed completions; the quest ledger owns the authoritative count. A client
          that crashed mid-completion is missing here.
        </p>
      </div>

      {/* ── Worlds ───────────────────────────────────────────────────── */}
      <div style={section}>
        {h('World entry popularity')}
        {kpi.worldPopularity.length === 0 ? empty(`No world entries in the last ${days} days.`) : (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>World</th><th>Entries</th><th>Sessions</th></tr></thead>
              <tbody>
                {kpi.worldPopularity.map((r) => (
                  <tr key={r.world}>
                    <td className="mono">{r.world}</td>
                    <td>{r.entries}</td>
                    <td>{r.sessions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p style={note}>
          Entries, not dwell time — the boot world dominates raw entries because every session
          starts somewhere, and a portal round-trip counts twice. Read the SESSIONS column for
          reach.
        </p>
      </div>

      {/* ── Economy flows ────────────────────────────────────────────── */}
      <div style={section}>
        {h('Economy flows (brief 5.5 measurement — directional)')}
        {kpi.economyFlows.length === 0 ? empty(`No credit flow events in the last ${days} days.`) : (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Reason</th><th>Op</th><th>Events</th><th>Total delta</th></tr></thead>
              <tbody>
                {kpi.economyFlows.map((r) => (
                  <tr key={`${r.reason}-${r.op}`}>
                    <td className="mono">{r.reason ?? '(untagged)'}</td>
                    <td><span className={`tag ${r.op === 'spend' ? 'tag-cyan' : ''}`}>{r.op ?? '?'}</span></td>
                    <td>{r.events}</td>
                    <td className="mono">{Number(r.total_delta).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p style={note}>
          Client-reported claims, useful for RANKING the 22 sources against the 5 sinks — the
          measurement the rebalance was deferred pending. The credit ledger owns the true
          amounts; nothing on this page reads or reconciles against it.
        </p>
      </div>
    </div>
  );
}
