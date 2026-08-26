/**
 * KPI reads for the admin dashboard — the only consumer of telemetry_events.
 *
 * ── The `server_id` lesson, applied ───────────────────────────────────────
 *
 * The table is OWNED and written by `site/lib/telemetry.ts`, but this module
 * ensures the same schema before its first read, because an ALTER living in
 * a module a read path never calls has already shipped two production 500s
 * in this repo: every module that reads a table must ensure the columns it
 * reads. The DDL below is a copy of the site's, statement for statement —
 * if you change one, change both.
 *
 * ── Economy separation ────────────────────────────────────────────────────
 *
 * Nothing here joins players, credit_events, or any balance-bearing table.
 * The KPI page reads telemetry_events alone; the flows it shows are ranked
 * client claims, labeled as such, never reconciled against the ledger.
 */

import { sqlUnsafe } from './sql';
import {
  SQL_SESSIONS_PER_DAY,
  SQL_MEDIAN_SESSION_SECONDS,
  SQL_RETURN_RATES,
  SQL_ONBOARDING_FUNNEL,
  SQL_MINIGAME_PLAYS,
  SQL_MINIGAME_STARTS,
  SQL_QUEST_COMPLETIONS_PER_DAY,
  SQL_WORLD_POPULARITY,
  SQL_ECONOMY_FLOWS,
  SQL_DATA_SPAN,
  type SessionsPerDayRow,
  type MedianSessionRow,
  type ReturnRatesRow,
  type OnboardingFunnelRow,
  type MinigamePlaysRow,
  type MinigameStartsRow,
  type QuestCompletionsRow,
  type WorldPopularityRow,
  type EconomyFlowsRow,
  type DataSpanRow,
} from './kpiSql';

let ensured = false;

/**
 * Identical to site/lib/telemetry.ts `ensureTelemetrySchema` — the write
 * path's DDL, repeated on the read path on purpose. Memoised per process.
 */
export async function ensureTelemetryReadable(): Promise<void> {
  if (ensured) return;
  await sqlUnsafe(`
    CREATE TABLE IF NOT EXISTS telemetry_events (
      id         BIGSERIAL PRIMARY KEY,
      player_id  TEXT,
      session_id TEXT NOT NULL,
      kind       TEXT NOT NULL,
      world      TEXT,
      detail     JSONB NOT NULL DEFAULT '{}'::jsonb,
      client_ts  TIMESTAMPTZ,
      server_ts  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ip_hash    TEXT
    )
  `);
  await sqlUnsafe(`
    CREATE INDEX IF NOT EXISTS telemetry_events_session_ts_idx
      ON telemetry_events (session_id, server_ts)
  `);
  await sqlUnsafe(`
    CREATE INDEX IF NOT EXISTS telemetry_events_player_ts_idx
      ON telemetry_events (player_id, server_ts) WHERE player_id IS NOT NULL
  `);
  await sqlUnsafe(`
    CREATE INDEX IF NOT EXISTS telemetry_events_kind_ts_idx
      ON telemetry_events (kind, server_ts)
  `);
  await sqlUnsafe(`
    CREATE INDEX IF NOT EXISTS telemetry_events_ip_ts_idx
      ON telemetry_events (ip_hash, server_ts) WHERE ip_hash IS NOT NULL
  `);
  ensured = true;
}

export type KpiReport = {
  span: DataSpanRow;
  sessionsPerDay: SessionsPerDayRow[];
  medianSession: MedianSessionRow;
  returnRates: ReturnRatesRow;
  onboardingFunnel: OnboardingFunnelRow[];
  minigamePlays: MinigamePlaysRow[];
  minigameStarts: MinigameStartsRow[];
  questCompletions: QuestCompletionsRow[];
  worldPopularity: WorldPopularityRow[];
  economyFlows: EconomyFlowsRow[];
};

/** Window, in days, for every windowed metric on the page. */
export const KPI_WINDOW_DAYS = 14;

export async function loadKpiReport(days: number = KPI_WINDOW_DAYS): Promise<KpiReport> {
  await ensureTelemetryReadable();
  const d = Math.max(1, Math.min(90, Math.trunc(days) || KPI_WINDOW_DAYS));

  const [
    span,
    sessionsPerDay,
    medianSession,
    returnRates,
    onboardingFunnel,
    minigamePlays,
    minigameStarts,
    questCompletions,
    worldPopularity,
    economyFlows,
  ] = await Promise.all([
    sqlUnsafe<DataSpanRow>(SQL_DATA_SPAN),
    sqlUnsafe<SessionsPerDayRow>(SQL_SESSIONS_PER_DAY, [d]),
    sqlUnsafe<MedianSessionRow>(SQL_MEDIAN_SESSION_SECONDS, [d]),
    sqlUnsafe<ReturnRatesRow>(SQL_RETURN_RATES),
    sqlUnsafe<OnboardingFunnelRow>(SQL_ONBOARDING_FUNNEL, [d]),
    sqlUnsafe<MinigamePlaysRow>(SQL_MINIGAME_PLAYS, [d]),
    sqlUnsafe<MinigameStartsRow>(SQL_MINIGAME_STARTS, [d]),
    sqlUnsafe<QuestCompletionsRow>(SQL_QUEST_COMPLETIONS_PER_DAY, [d]),
    sqlUnsafe<WorldPopularityRow>(SQL_WORLD_POPULARITY, [d]),
    sqlUnsafe<EconomyFlowsRow>(SQL_ECONOMY_FLOWS, [d]),
  ]);

  return {
    span: span.rows[0] ?? { total_events: 0, oldest: null, newest: null, span_days: 0 },
    sessionsPerDay: sessionsPerDay.rows,
    medianSession: medianSession.rows[0] ?? { median_seconds: null, sessions: 0 },
    returnRates:
      returnRates.rows[0] ?? { d1_cohort: 0, d1_returned: 0, d7_cohort: 0, d7_returned: 0 },
    onboardingFunnel: onboardingFunnel.rows,
    minigamePlays: minigamePlays.rows,
    minigameStarts: minigameStarts.rows,
    questCompletions: questCompletions.rows,
    worldPopularity: worldPopularity.rows,
    economyFlows: economyFlows.rows,
  };
}
