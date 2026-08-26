import { NextResponse } from 'next/server';
import { Client } from 'pg';
import { auth } from '@/lib/auth';
import { getUserById } from '@/lib/db';
import { findOrCreatePlayer } from '@/lib/playerDb';
import {
  ingestTelemetryBatch,
  isValidSessionId,
  hashIp,
  TELEMETRY_LIMITS,
} from '@/lib/telemetry';

export const dynamic = 'force-dynamic';

/**
 * POST → a BATCH of gameplay telemetry events.
 *
 * Body: `{ session_id, events: [{ kind, world?, detail?, client_ts? }] }`.
 *
 * The client (`src/systems/Telemetry.js`) buffers and flushes every ~30s and
 * on pagehide — one request per flush, never one per event. This endpoint is
 * fire-and-forget from the game's point of view: it must be cheap, it must
 * never block gameplay, and it must never 500 on garbage. Individual bad
 * events are refused with counted reasons and the rest of the batch lands.
 *
 * Identity: `player_id` is stamped from the SESSION, never the body — the
 * same rule every game route follows. Anonymous batches are accepted with
 * player_id NULL and rate-limited harder, keyed by a keyed hash of the
 * caller's address (never the raw IP — see `hashIp`). Limits live in
 * `TELEMETRY_LIMITS` (site/lib/telemetry.ts): 3600 events/h signed-in per
 * player, 600 events/h anonymous per IP, 100 events and 256 KB per request.
 *
 * Auth failures downgrade to anonymous rather than erroring: telemetry from
 * a half-signed-in client is still telemetry, and a 401 here would make an
 * auth hiccup look like a gameplay bug in the client's console.
 *
 * Responses:
 *   200 { accepted, refused, reasons }  — normal, including partial refusals
 *   400                                 — unreadable envelope (bad JSON, bad
 *                                         session_id, events not an array)
 *   413                                 — body over 256 KB
 *   429                                 — rate limited (client drops silently)
 *   503                                 — database unavailable (client drops)
 */
export async function POST(req: Request) {
  // Size gate before JSON.parse ever runs: parsing an unbounded body is the
  // expensive path, and the game's own batches are ~100 × ~300 B.
  let text: string;
  try {
    text = await req.text();
  } catch {
    return NextResponse.json({ error: 'Unreadable body.' }, { status: 400 });
  }
  if (text.length > TELEMETRY_LIMITS.maxBodyBytes) {
    return NextResponse.json({ error: 'Body too large.' }, { status: 413 });
  }

  let body: { session_id?: unknown; events?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  if (typeof body !== 'object' || body === null) {
    return NextResponse.json({ error: 'Body must be an object.' }, { status: 400 });
  }

  if (!isValidSessionId(body.session_id)) {
    return NextResponse.json({ error: 'Invalid session_id.' }, { status: 400 });
  }
  const events = Array.isArray(body.events) ? body.events : null;
  if (!events) {
    return NextResponse.json({ error: 'events must be an array.' }, { status: 400 });
  }
  if (events.length === 0) {
    return NextResponse.json({ accepted: 0, refused: 0, reasons: {} });
  }
  if (events.length > TELEMETRY_LIMITS.maxEventsPerBatch) {
    return NextResponse.json(
      { error: `at most ${TELEMETRY_LIMITS.maxEventsPerBatch} events per request.` },
      { status: 400 }
    );
  }

  // Scope from the session, never the body. Any failure here means anonymous,
  // not an error — see the header comment.
  let playerId: string | null = null;
  try {
    const session = await auth();
    if (session?.user?.id) {
      const user = await getUserById(session.user.id);
      if (user) playerId = await findOrCreatePlayer(session.user.id, user.email);
    }
  } catch {
    playerId = null;
  }

  // First hop of x-forwarded-for is the client as Vercel saw it. Hashed with
  // the app secret before it goes anywhere near the database.
  const fwd = req.headers.get('x-forwarded-for') ?? '';
  const ipHash = playerId ? null : hashIp(fwd.split(',')[0]);

  const connStr = process.env.POSTGRES_URL ?? '';
  const ssl = connStr.includes('sslmode=disable') ? false : { rejectUnauthorized: false };
  const client = new Client({ connectionString: connStr, ssl });
  try {
    await client.connect();
    const out = await ingestTelemetryBatch(client, {
      sessionId: body.session_id,
      playerId,
      ipHash,
      events,
    });
    if (!out.ok && out.refusedBatch === 'rate_limited') {
      return NextResponse.json(
        { accepted: 0, refused: out.refused, reasons: {}, error: 'rate_limited' },
        { status: 429 }
      );
    }
    return NextResponse.json({
      accepted: out.accepted,
      refused: out.refused,
      reasons: out.reasons,
    });
  } catch (err) {
    // Infrastructure, not garbage: garbage never reaches this catch, because
    // sanitize refuses per-event and never throws. The client treats any
    // non-ok the same way — drop the batch and keep playing.
    console.error('[telemetry] ingest failed:', err);
    return NextResponse.json({ error: 'Telemetry unavailable.' }, { status: 503 });
  } finally {
    await client.end().catch(() => {});
  }
}
