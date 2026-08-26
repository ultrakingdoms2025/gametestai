/**
 * The KPI queries, as parameterized SQL text — brief 5.7's metrics, limited
 * to what `telemetry_events` can HONESTLY answer.
 *
 * ── Why this file is plain strings with zero imports ──────────────────────
 *
 * Postgres refuses an expression in a UNION's own ORDER BY — a runtime error
 * tsc cannot see; only integration tests catch that class. So the EXACT text
 * the admin page executes lives here, dependency-free, where the site's
 * integration suite (`site/lib/telemetry.test.ts`) can import it and run
 * every statement against a real Postgres with seeded events. `admin/lib/kpi.ts`
 * executes these same constants in production. One copy, tested as written.
 * (None of these use UNION, which is also deliberate.)
 *
 * Every query takes `$1 = window in days` unless noted, and windows on
 * `server_ts` — the server's clock is the only trustworthy one; `client_ts`
 * is a debugging aid and appears in no metric.
 *
 * ── Honesty notes are load-bearing ────────────────────────────────────────
 *
 * Each query says what it can and cannot claim. Do not render a metric these
 * events cannot support; an empty section labeled "needs N days of data"
 * beats a fabricated zero.
 */

/**
 * Sessions per day, newest first.
 * CAN claim: distinct booted game sessions that sent ≥1 event that day, and
 *   how many distinct signed-in players were among them.
 * CANNOT claim: unique PEOPLE. Anonymous sessions have no durable identity —
 *   two boots by one signed-out player are two sessions; a session spanning
 *   midnight UTC counts on both days.
 */
export const SQL_SESSIONS_PER_DAY = `
  SELECT (server_ts AT TIME ZONE 'utc')::date::text AS day,
         COUNT(DISTINCT session_id)::int      AS sessions,
         COUNT(DISTINCT player_id)::int       AS signed_in_players
    FROM telemetry_events
   WHERE server_ts > NOW() - make_interval(days => $1)
   GROUP BY 1
   ORDER BY 1 DESC`;

/**
 * Median session length in seconds over the window.
 * CAN claim: the median of (last event − first event) per session — a FLOOR
 *   on real session length, not a truth. A session that sends one flush and
 *   closes measures near zero however long it was; time after the final
 *   event is invisible; a killed tab whose pagehide beacon was lost loses
 *   its tail.
 * Single-event sessions measure 0 and are INCLUDED: excluding them would
 *   silently trim the population toward the engaged.
 */
export const SQL_MEDIAN_SESSION_SECONDS = `
  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY dur)::float8 AS median_seconds,
         COUNT(*)::int AS sessions
    FROM (
      SELECT EXTRACT(EPOCH FROM (MAX(server_ts) - MIN(server_ts))) AS dur
        FROM telemetry_events
       WHERE server_ts > NOW() - make_interval(days => $1)
       GROUP BY session_id
    ) s`;

/**
 * D1 / D7 return rate. No parameters.
 * CAN claim: of SIGNED-IN players first seen at least 2 (resp. 8) days ago,
 *   the share with any event exactly 1 day after (D1), or on any of days
 *   1–7 after (D7), their first-seen UTC day.
 * CANNOT claim: anything about anonymous players (no durable identity), or
 *   about players whose first day predates telemetry going live — "first
 *   seen" means first seen BY TELEMETRY, so early cohorts include veterans
 *   and will read artificially high or low until the table has real history.
 * Cohorts too young to have had the chance are excluded, not counted as
 *   failures.
 */
export const SQL_RETURN_RATES = `
  WITH pdays AS (
    SELECT player_id, (server_ts AT TIME ZONE 'utc')::date AS day
      FROM telemetry_events
     WHERE player_id IS NOT NULL
     GROUP BY 1, 2
  ), firsts AS (
    SELECT player_id, MIN(day) AS d0 FROM pdays GROUP BY 1
  )
  SELECT
    COUNT(*) FILTER (WHERE d0 <= CURRENT_DATE - 2)::int AS d1_cohort,
    COUNT(*) FILTER (
      WHERE d0 <= CURRENT_DATE - 2
        AND EXISTS (SELECT 1 FROM pdays p
                     WHERE p.player_id = f.player_id AND p.day = f.d0 + 1)
    )::int AS d1_returned,
    COUNT(*) FILTER (WHERE d0 <= CURRENT_DATE - 8)::int AS d7_cohort,
    COUNT(*) FILTER (
      WHERE d0 <= CURRENT_DATE - 8
        AND EXISTS (SELECT 1 FROM pdays p
                     WHERE p.player_id = f.player_id
                       AND p.day BETWEEN f.d0 + 1 AND f.d0 + 7)
    )::int AS d7_returned
  FROM firsts f`;

/**
 * Onboarding step funnel.
 * CAN claim: how many distinct sessions (and signed-in players) COMPLETED
 *   each onboarding step in the window. Ordered by the average completion
 *   ordinal the client reported (`detail.done` — the running count at the
 *   moment the step completed), which approximates authored order without
 *   this file pretending to know it.
 * CANNOT claim: how many players SAW a step and bounced — only completions
 *   are emitted (`onboarding:step` fires when a step is credited), so the
 *   drop-off between rows is the real signal and step-zero exposure is not
 *   measured. Sessions predating a step's introduction never show it.
 */
export const SQL_ONBOARDING_FUNNEL = `
  SELECT detail->>'stepId'                 AS step_id,
         COUNT(DISTINCT session_id)::int   AS sessions,
         COUNT(DISTINCT player_id)::int    AS players,
         AVG((detail->>'done')::int)::float8 AS avg_ordinal
    FROM telemetry_events
   WHERE kind = 'onboarding_step'
     AND server_ts > NOW() - make_interval(days => $1)
   GROUP BY 1
   ORDER BY AVG((detail->>'done')::int) NULLS LAST, 1`;

/**
 * Minigame plays, replays, wins.
 * CAN claim: finished contests per game in the window; "replays" = finishes
 *   beyond the first within one SESSION (a session that finished the same
 *   game three times contributes two), which reads as "came back for more".
 * CANNOT claim: abandonment — a quit contest never emits `minigame:finished`
 *   (compare `minigame_started` counts for that); nor cross-session replay
 *   by anonymous players.
 */
export const SQL_MINIGAME_PLAYS = `
  SELECT detail->>'gameId' AS game_id,
         COUNT(*)::int AS plays,
         (COUNT(*) - COUNT(DISTINCT session_id))::int AS replays,
         COUNT(*) FILTER (WHERE (detail->>'won')::boolean)::int AS wins
    FROM telemetry_events
   WHERE kind = 'minigame_finished'
     AND server_ts > NOW() - make_interval(days => $1)
   GROUP BY 1
   ORDER BY COUNT(*) DESC, 1`;

/**
 * Minigame starts — the denominator for abandonment, kept separate so the
 * plays query stays one GROUP BY.
 * CAN claim: contests entered. starts − plays ≈ abandoned or in-flight.
 */
export const SQL_MINIGAME_STARTS = `
  SELECT detail->>'gameId' AS game_id,
         COUNT(*)::int AS starts
    FROM telemetry_events
   WHERE kind = 'minigame_started'
     AND server_ts > NOW() - make_interval(days => $1)
   GROUP BY 1
   ORDER BY COUNT(*) DESC, 1`;

/**
 * Quest completions per day, newest first.
 * CAN claim: `quests:quest:complete` events per UTC day — client-observed
 *   completions, which fire alongside the server's own quest-complete call.
 * CANNOT claim: authoritative completion counts (the quest ledger owns
 *   those); a client that crashed mid-completion is missing here.
 */
export const SQL_QUEST_COMPLETIONS_PER_DAY = `
  SELECT (server_ts AT TIME ZONE 'utc')::date::text AS day,
         COUNT(*)::int AS completions,
         COUNT(DISTINCT COALESCE(player_id, session_id))::int AS completers
    FROM telemetry_events
   WHERE kind = 'quest_completed'
     AND server_ts > NOW() - make_interval(days => $1)
   GROUP BY 1
   ORDER BY 1 DESC`;

/**
 * World entry popularity.
 * CAN claim: which worlds sessions ENTERED, and how many distinct sessions
 *   entered each — `world:changed` fires on every arrival including the
 *   boot world, so the boot world will dominate raw entries.
 * CANNOT claim: time SPENT per world (entries are not dwell), or that an
 *   entry was deliberate (a portal round-trip is two entries).
 */
export const SQL_WORLD_POPULARITY = `
  SELECT world,
         COUNT(*)::int AS entries,
         COUNT(DISTINCT session_id)::int AS sessions
    FROM telemetry_events
   WHERE kind = 'world_enter'
     AND world IS NOT NULL
     AND server_ts > NOW() - make_interval(days => $1)
   GROUP BY 1
   ORDER BY COUNT(*) DESC, 1`;

/**
 * Economy flows — the measurement brief 5.5 was deferred pending
 * (`src/systems/Charters.js:109-114` refuses to guess prices without data).
 * CAN claim: the client-reported flow per reason tag — how often each of the
 *   22 sources and 5 sinks fires and the credits it claims to move,
 *   DIRECTIONALLY. `op`='add' is a source, 'spend' a sink; `set` (balance
 *   bookkeeping) is filtered out client-side and never lands here.
 * CANNOT claim: authoritative amounts. These are unverified client claims —
 *   the credit LEDGER owns truth; this exists to rank sources and sinks
 *   against each other, which is exactly the data the rebalance was waiting
 *   for. Telemetry never joins or touches the ledger.
 */
export const SQL_ECONOMY_FLOWS = `
  SELECT detail->>'reason' AS reason,
         detail->>'op'     AS op,
         COUNT(*)::int     AS events,
         COALESCE(SUM((detail->>'delta')::bigint), 0)::bigint AS total_delta
    FROM telemetry_events
   WHERE kind = 'credits_delta'
     AND server_ts > NOW() - make_interval(days => $1)
   GROUP BY 1, 2
   ORDER BY ABS(COALESCE(SUM((detail->>'delta')::bigint), 0)) DESC, 1`;

/**
 * How much history the table actually holds — the page gates D1/D7 and
 * trend sections on this rather than rendering a fabricated zero.
 * No parameters.
 */
export const SQL_DATA_SPAN = `
  SELECT COUNT(*)::int AS total_events,
         MIN(server_ts) AS oldest,
         MAX(server_ts) AS newest,
         COALESCE(EXTRACT(DAY FROM (NOW() - MIN(server_ts)))::int, 0) AS span_days
    FROM telemetry_events`;

/* Row shapes, matching the SELECT lists above. */
export type SessionsPerDayRow = { day: string; sessions: number; signed_in_players: number };
export type MedianSessionRow = { median_seconds: number | null; sessions: number };
export type ReturnRatesRow = {
  d1_cohort: number;
  d1_returned: number;
  d7_cohort: number;
  d7_returned: number;
};
export type OnboardingFunnelRow = {
  step_id: string | null;
  sessions: number;
  players: number;
  avg_ordinal: number | null;
};
export type MinigamePlaysRow = { game_id: string | null; plays: number; replays: number; wins: number };
export type MinigameStartsRow = { game_id: string | null; starts: number };
export type QuestCompletionsRow = { day: string; completions: number; completers: number };
export type WorldPopularityRow = { world: string; entries: number; sessions: number };
export type EconomyFlowsRow = { reason: string | null; op: string | null; events: number; total_delta: number | string };
export type DataSpanRow = { total_events: number; oldest: string | Date | null; newest: string | Date | null; span_days: number };
