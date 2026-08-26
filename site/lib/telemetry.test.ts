import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import {
  ensureTelemetrySchema,
  _resetTelemetrySchemaMemo,
  ingestTelemetryBatch,
  sanitizeTelemetryEvent,
  isValidSessionId,
  pruneTelemetryEvents,
  hashIp,
  TELEMETRY_KINDS,
  TELEMETRY_LIMITS,
} from './telemetry';
import {
  SQL_SESSIONS_PER_DAY,
  SQL_MEDIAN_SESSION_SECONDS,
  SQL_RETURN_RATES,
  SQL_ONBOARDING_FUNNEL,
  SQL_MINIGAME_PLAYS,
  SQL_QUEST_COMPLETIONS_PER_DAY,
  SQL_WORLD_POPULARITY,
  SQL_ECONOMY_FLOWS,
  SQL_DATA_SPAN,
} from '../../admin/lib/kpiSql';

/**
 * Telemetry ingest and the KPI reads, against a real Postgres.
 *
 * The KPI statements are imported from `admin/lib/kpiSql.ts` and executed
 * VERBATIM — the exact text the admin page runs. That is the point: tsc
 * cannot see a bad JSONB cast or an illegal ORDER BY (the UNION class);
 * only running the statements can, and a paraphrased copy here would be a
 * second system that agrees with me.
 *
 * Same harness rules as creditLedger.test.ts: `aether_test` only, refuse to
 * run anywhere else, skip cleanly when POSTGRES_TEST_URL is absent.
 */

function testUrl(): string | null {
  if (process.env.POSTGRES_TEST_URL) return process.env.POSTGRES_TEST_URL;
  const here = dirname(fileURLToPath(import.meta.url));
  const envFile = join(here, '..', '.env.test.local');
  if (!existsSync(envFile)) return null;
  const line = readFileSync(envFile, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith('POSTGRES_TEST_URL='));
  if (!line) return null;
  return line.slice('POSTGRES_TEST_URL='.length).trim().replace(/^["']|["']$/g, '');
}

const URL_ = testUrl();
const suite = URL_ ? describe : describe.skip;

/** Fixed and obviously synthetic. Never a real player id. */
const PLAYER = '00000000-0000-4000-8000-0000000000a1';
const PLAYER_B = '00000000-0000-4000-8000-0000000000b2';
const SESSION = 'tttttttt-1111-4111-8111-111111111111';

function ev(kind: string, extra: Record<string, unknown> = {}) {
  return { kind, world: 'station', detail: {}, client_ts: Date.now(), ...extra };
}

suite('telemetry ingest + KPI queries (integration)', () => {
  let db: Client;

  async function count(where = 'TRUE', params: unknown[] = []): Promise<number> {
    const r = await db.query(`SELECT COUNT(*)::int AS n FROM telemetry_events WHERE ${where}`, params);
    return Number(r.rows[0]?.n ?? 0);
  }

  /** Seed one row with full control of identity and server_ts. */
  async function seed(row: {
    playerId?: string | null;
    sessionId?: string;
    kind: string;
    world?: string | null;
    detail?: Record<string, unknown>;
    at?: string; // SQL expression for server_ts
    ipHash?: string | null;
  }) {
    await db.query(
      `INSERT INTO telemetry_events (player_id, session_id, kind, world, detail, server_ts, ip_hash)
       VALUES ($1, $2, $3, $4, $5::jsonb, ${row.at ?? 'NOW()'}, $6)`,
      [
        row.playerId ?? null,
        row.sessionId ?? SESSION,
        row.kind,
        row.world ?? null,
        JSON.stringify(row.detail ?? {}),
        row.ipHash ?? null,
      ]
    );
  }

  beforeAll(async () => {
    db = new Client({ connectionString: URL_!, ssl: { rejectUnauthorized: false } });
    await db.connect();

    // Refuse to run anywhere but the test database. A misconfigured URL pointing
    // at neondb would otherwise create tables in production.
    const which = await db.query('SELECT current_database() AS db');
    if (which.rows[0].db !== 'aether_test') {
      throw new Error(`refusing to run against "${which.rows[0].db}" — expected aether_test`);
    }

    await db.query('DROP TABLE IF EXISTS telemetry_events');
    _resetTelemetrySchemaMemo();
    await ensureTelemetrySchema(db);
  });

  afterAll(async () => {
    await db?.end();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM telemetry_events');
  });

  /* ── Ingest ─────────────────────────────────────────────────────────── */

  it('lands a clean batch and stamps the signed-in player from the caller, not the body', async () => {
    const out = await ingestTelemetryBatch(db, {
      sessionId: SESSION,
      playerId: PLAYER,
      ipHash: hashIp('203.0.113.9'),
      events: [
        ev('session_start'),
        ev('world_enter', { world: 'lodestar' }),
        // A forged player_id in the body must be ignored: identity comes from
        // the session alone.
        ev('npc_killed', { player_id: 'attacker-chosen' } as Record<string, unknown>),
      ],
    });
    expect(out.ok).toBe(true);
    expect(out.accepted).toBe(3);
    expect(out.refused).toBe(0);

    const rows = await db.query(
      'SELECT player_id, session_id, kind, world, ip_hash FROM telemetry_events ORDER BY id'
    );
    expect(rows.rows).toHaveLength(3);
    for (const r of rows.rows) {
      expect(r.player_id).toBe(PLAYER);
      expect(r.session_id).toBe(SESSION);
      // Signed-in rows never carry the address hash — they are keyed by player.
      expect(r.ip_hash).toBeNull();
    }
    expect(rows.rows[1].world).toBe('lodestar');
  });

  it('accepts anonymous batches with player_id NULL and stores the keyed ip hash', async () => {
    const ip = hashIp('203.0.113.10');
    const out = await ingestTelemetryBatch(db, {
      sessionId: SESSION,
      playerId: null,
      ipHash: ip,
      events: [ev('session_start')],
    });
    expect(out.accepted).toBe(1);
    const r = await db.query('SELECT player_id, ip_hash FROM telemetry_events');
    expect(r.rows[0].player_id).toBeNull();
    expect(r.rows[0].ip_hash).toBe(ip);
    // The hash is a hash: the address itself must never appear in the table.
    expect(r.rows[0].ip_hash).not.toContain('203.0.113');
  });

  it('refuses individual bad events, accepts the rest, and reports counts — never throws', async () => {
    const big = { blob: 'x'.repeat(TELEMETRY_LIMITS.maxDetailBytes + 100) };
    const out = await ingestTelemetryBatch(db, {
      sessionId: SESSION,
      playerId: null,
      ipHash: hashIp('203.0.113.11'),
      events: [
        ev('quest_completed', { detail: { questId: 'q1' } }), // good
        ev('game_action'),                                    // the free-text lesson: unknown kind
        ev('minigame_finished', { detail: big }),             // oversized detail
        'not even an object',                                 // garbage
        null,                                                 // more garbage
      ],
    });
    expect(out.ok).toBe(true);
    expect(out.accepted).toBe(1);
    expect(out.refused).toBe(4);
    expect(out.reasons.unknown_kind).toBe(1);
    expect(out.reasons.detail_too_large).toBe(1);
    expect(out.reasons.not_an_object).toBe(2);
    expect(await count()).toBe(1);
  });

  it('rate-limits anonymous callers at the per-hour cap, keyed by ip hash', async () => {
    const ip = hashIp('203.0.113.12')!;
    // Fill the rolling hour to exactly the cap with one statement.
    await db.query(
      `INSERT INTO telemetry_events (player_id, session_id, kind, ip_hash, server_ts)
       SELECT NULL, $1, 'session_start', $2, NOW() - interval '5 minutes'
         FROM generate_series(1, $3::int)`,
      [SESSION, ip, TELEMETRY_LIMITS.anonymousPerHour]
    );
    const refused = await ingestTelemetryBatch(db, {
      sessionId: 'other-session-1111-4111-8111-2222',
      playerId: null,
      ipHash: ip,
      events: [ev('session_start')],
    });
    expect(refused.ok).toBe(false);
    expect(refused.refusedBatch).toBe('rate_limited');
    expect(refused.accepted).toBe(0);

    // A DIFFERENT address is not affected — the key is the caller, not the world.
    const other = await ingestTelemetryBatch(db, {
      sessionId: SESSION,
      playerId: null,
      ipHash: hashIp('203.0.113.99'),
      events: [ev('session_start')],
    });
    expect(other.accepted).toBe(1);
  });

  it('gives signed-in players the higher cap (anonymous cap does not bind them)', async () => {
    // Same volume that just rate-limited an anonymous caller...
    await db.query(
      `INSERT INTO telemetry_events (player_id, session_id, kind, server_ts)
       SELECT $1, $2, 'session_start', NOW() - interval '5 minutes'
         FROM generate_series(1, $3::int)`,
      [PLAYER, SESSION, TELEMETRY_LIMITS.anonymousPerHour]
    );
    const out = await ingestTelemetryBatch(db, {
      sessionId: SESSION,
      playerId: PLAYER,
      ipHash: null,
      events: [ev('npc_killed')],
    });
    expect(out.ok).toBe(true);
    expect(out.accepted).toBe(1);

    // ...but the signed-in ceiling is real too.
    await db.query(
      `INSERT INTO telemetry_events (player_id, session_id, kind, server_ts)
       SELECT $1, $2, 'session_start', NOW() - interval '5 minutes'
         FROM generate_series(1, $3::int)`,
      [PLAYER, SESSION, TELEMETRY_LIMITS.signedInPerHour]
    );
    const capped = await ingestTelemetryBatch(db, {
      sessionId: SESSION,
      playerId: PLAYER,
      ipHash: null,
      events: [ev('npc_killed')],
    });
    expect(capped.refusedBatch).toBe('rate_limited');
  });

  it('prunes by the documented retention statement', async () => {
    await seed({ kind: 'session_start', at: `NOW() - interval '100 days'` });
    await seed({ kind: 'session_start', at: `NOW() - interval '1 day'` });
    const removed = await pruneTelemetryEvents(db); // default 90 days
    expect(removed).toBe(1);
    expect(await count()).toBe(1);
  });

  /* ── KPI queries — the admin page's exact SQL, against seeded events ─── */

  it('sessions per day counts distinct sessions and signed-in players', async () => {
    await seed({ sessionId: 's-one-1111-aaaa', kind: 'session_start', playerId: PLAYER });
    await seed({ sessionId: 's-one-1111-aaaa', kind: 'npc_killed', playerId: PLAYER });
    await seed({ sessionId: 's-two-2222-bbbb', kind: 'session_start' }); // anonymous
    await seed({ sessionId: 's-old-3333-cccc', kind: 'session_start', at: `NOW() - interval '2 days'` });

    const r = await db.query(SQL_SESSIONS_PER_DAY, [14]);
    expect(r.rows.length).toBe(2);
    // Newest first.
    expect(Number(r.rows[0].sessions)).toBe(2);
    expect(Number(r.rows[0].signed_in_players)).toBe(1);
    expect(Number(r.rows[1].sessions)).toBe(1);
  });

  it('median session length is the floor between first and last event', async () => {
    // Session A: 10 minutes between first and last event → 600s.
    await seed({ sessionId: 'sess-aaaa-1111', kind: 'session_start', at: `NOW() - interval '10 minutes'` });
    await seed({ sessionId: 'sess-aaaa-1111', kind: 'npc_killed', at: 'NOW()' });
    // Session B: one flush → measures 0. Included on purpose: excluding
    // single-event sessions would trim the population toward the engaged.
    await seed({ sessionId: 'sess-bbbb-2222', kind: 'session_start', at: 'NOW()' });

    const r = await db.query(SQL_MEDIAN_SESSION_SECONDS, [14]);
    expect(Number(r.rows[0].sessions)).toBe(2);
    expect(Number(r.rows[0].median_seconds)).toBeCloseTo(300, 0); // interpolated between 0 and 600
  });

  it('D1/D7 return rates count distinct player days off the first-seen day', async () => {
    // Player A: first seen 10 days ago, returned the next day (counts for D1 and D7).
    await seed({ playerId: PLAYER, kind: 'session_start', at: `NOW() - interval '10 days'` });
    await seed({ playerId: PLAYER, kind: 'session_start', at: `NOW() - interval '9 days'` });
    // Player B: first seen 10 days ago, never returned.
    await seed({ playerId: PLAYER_B, kind: 'session_start', at: `NOW() - interval '10 days'` });
    // Anonymous rows must not enter the cohort at all.
    await seed({ playerId: null, kind: 'session_start', at: `NOW() - interval '10 days'` });

    const r = await db.query(SQL_RETURN_RATES);
    expect(Number(r.rows[0].d1_cohort)).toBe(2);
    expect(Number(r.rows[0].d1_returned)).toBe(1);
    expect(Number(r.rows[0].d7_cohort)).toBe(2);
    expect(Number(r.rows[0].d7_returned)).toBe(1);
  });

  it('onboarding funnel orders steps by reported completion ordinal', async () => {
    // Two sessions complete 'move'; one goes on to 'first_kill'.
    await seed({ sessionId: 'fa-1', kind: 'onboarding_step', detail: { stepId: 'move', done: 1, total: 5 } });
    await seed({ sessionId: 'fb-2', kind: 'onboarding_step', detail: { stepId: 'move', done: 1, total: 5 } });
    await seed({ sessionId: 'fa-1', kind: 'onboarding_step', detail: { stepId: 'first_kill', done: 2, total: 5 } });

    const r = await db.query(SQL_ONBOARDING_FUNNEL, [14]);
    expect(r.rows.map((x: Record<string, unknown>) => x.step_id)).toEqual(['move', 'first_kill']);
    expect(Number(r.rows[0].sessions)).toBe(2);
    expect(Number(r.rows[1].sessions)).toBe(1);
  });

  it('minigame plays counts finishes, replays within a session, and wins', async () => {
    const d = (won: boolean) => ({ gameId: 'ski_run', won, place: won ? 1 : 2 });
    await seed({ sessionId: 'mg-1', kind: 'minigame_finished', detail: d(true) });
    await seed({ sessionId: 'mg-1', kind: 'minigame_finished', detail: d(false) }); // replay
    await seed({ sessionId: 'mg-2', kind: 'minigame_finished', detail: d(true) });
    await seed({ sessionId: 'mg-2', kind: 'minigame_finished', detail: { gameId: 'tennis', won: false } });

    const r = await db.query(SQL_MINIGAME_PLAYS, [14]);
    const ski = r.rows.find((x: Record<string, unknown>) => x.game_id === 'ski_run');
    expect(Number(ski.plays)).toBe(3);
    expect(Number(ski.replays)).toBe(1); // 3 finishes across 2 sessions
    expect(Number(ski.wins)).toBe(2);
  });

  it('quest completions per day, and world popularity, group what the client sent', async () => {
    await seed({ playerId: PLAYER, kind: 'quest_completed', detail: { questId: 'q1', credits: 40 } });
    await seed({ playerId: PLAYER, kind: 'quest_completed', detail: { questId: 'q2', credits: 10 } });
    await seed({ sessionId: 'wp-1', kind: 'world_enter', world: 'station' });
    await seed({ sessionId: 'wp-1', kind: 'world_enter', world: 'lodestar' });
    await seed({ sessionId: 'wp-2', kind: 'world_enter', world: 'station' });

    const q = await db.query(SQL_QUEST_COMPLETIONS_PER_DAY, [14]);
    expect(Number(q.rows[0].completions)).toBe(2);
    expect(Number(q.rows[0].completers)).toBe(1);

    const w = await db.query(SQL_WORLD_POPULARITY, [14]);
    expect(w.rows[0].world).toBe('station');
    expect(Number(w.rows[0].entries)).toBe(2);
    expect(Number(w.rows[0].sessions)).toBe(2);
    expect(w.rows[1].world).toBe('lodestar');
  });

  it('economy flows rank reasons by absolute claimed movement — brief 5.5 measurement', async () => {
    for (let i = 0; i < 3; i++) {
      await seed({ kind: 'credits_delta', detail: { reason: 'kill', delta: 5, op: 'add' } });
    }
    await seed({ kind: 'credits_delta', detail: { reason: 'market', delta: -50, op: 'spend' } });

    const r = await db.query(SQL_ECONOMY_FLOWS, [14]);
    expect(r.rows[0].reason).toBe('market'); // |−50| > |15|
    expect(Number(r.rows[0].total_delta)).toBe(-50);
    expect(r.rows[1].reason).toBe('kill');
    expect(Number(r.rows[1].events)).toBe(3);
    expect(Number(r.rows[1].total_delta)).toBe(15);
  });

  it('data span reports how much history the table holds — the page gates on it', async () => {
    const empty = await db.query(SQL_DATA_SPAN);
    expect(Number(empty.rows[0].total_events)).toBe(0);
    expect(Number(empty.rows[0].span_days)).toBe(0);

    await seed({ kind: 'session_start', at: `NOW() - interval '3 days'` });
    await seed({ kind: 'session_start' });
    const r = await db.query(SQL_DATA_SPAN);
    expect(Number(r.rows[0].total_events)).toBe(2);
    expect(Number(r.rows[0].span_days)).toBe(3);
  });
});

/* ── Pure validation — no database needed, runs everywhere ─────────────── */

describe('telemetry validation (unit)', () => {
  it('the kind allowlist refuses free text — the game_action lesson', () => {
    expect(sanitizeTelemetryEvent({ kind: 'session_start' }).ok).toBe(true);
    expect(sanitizeTelemetryEvent({ kind: 'game_action' })).toEqual({ ok: false, reason: 'unknown_kind' });
    expect(sanitizeTelemetryEvent({ kind: 'SESSION_START' }).ok).toBe(false); // exact match only
    expect(sanitizeTelemetryEvent({ kind: 12 }).ok).toBe(false);
  });

  it('every allowlisted kind round-trips through sanitize', () => {
    for (const kind of TELEMETRY_KINDS) {
      const res = sanitizeTelemetryEvent({ kind, world: 'station', detail: { a: 1 } });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.event.kind).toBe(kind);
    }
  });

  it('collapses non-object detail to {} but refuses an oversized one', () => {
    const ok = sanitizeTelemetryEvent({ kind: 'session_start', detail: 'a string' });
    expect(ok.ok && ok.event.detailJson).toBe('{}');
    const big = sanitizeTelemetryEvent({
      kind: 'session_start',
      detail: { blob: 'x'.repeat(TELEMETRY_LIMITS.maxDetailBytes) },
    });
    expect(big).toEqual({ ok: false, reason: 'detail_too_large' });
  });

  it('nulls a skewed client clock instead of trusting or refusing it', () => {
    const now = new Date('2026-08-26T12:00:00Z');
    const sane = sanitizeTelemetryEvent({ kind: 'session_start', client_ts: now.getTime() - 60_000 }, now);
    expect(sane.ok && sane.event.clientTs?.getTime()).toBe(now.getTime() - 60_000);
    const skewed = sanitizeTelemetryEvent(
      { kind: 'session_start', client_ts: now.getTime() + TELEMETRY_LIMITS.clientTsSkewMs + 1 },
      now
    );
    expect(skewed.ok && skewed.event.clientTs).toBeNull();
  });

  it('session ids: uuid shape yes, junk no', () => {
    expect(isValidSessionId('6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d')).toBe(true);
    expect(isValidSessionId('s-abc123xyz-1756200000000')).toBe(true); // the client's non-crypto fallback
    expect(isValidSessionId('short')).toBe(false);
    expect(isValidSessionId('x'.repeat(65))).toBe(false);
    expect(isValidSessionId('has spaces here!')).toBe(false);
    expect(isValidSessionId(42)).toBe(false);
    expect(isValidSessionId(null)).toBe(false);
  });

  it('hashIp is keyed, short, and never the address', () => {
    const h = hashIp('203.0.113.7');
    expect(h).toMatch(/^[0-9a-f]{32}$/);
    expect(h).not.toContain('203');
    expect(hashIp('')).toBeNull();
    expect(hashIp(null)).toBeNull();
    expect(hashIp('203.0.113.7')).toBe(h); // stable, so the rolling count works
  });
});
