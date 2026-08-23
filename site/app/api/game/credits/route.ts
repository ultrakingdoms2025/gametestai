import { NextResponse } from 'next/server';
import { Client } from 'pg';
import { auth } from '@/lib/auth';
import { getUserById } from '@/lib/db';
import { findOrCreatePlayer } from '@/lib/playerDb';
import {
  ensureCreditSchema,
  ensureOpeningBalance,
  applyReportedEvent,
  type ReportedEvent,
  type ReportResult,
} from '@/lib/creditLedger';

export const dynamic = 'force-dynamic';

/** One request carries at most this many events; the client batches to 100. */
const MAX_EVENTS = 100;

function makeClient() {
  const connStr = process.env.POSTGRES_URL ?? '';
  const ssl = connStr.includes('sslmode=disable') ? false : { rejectUnauthorized: false };
  return new Client({ connectionString: connStr, ssl });
}

/**
 * POST → report gameplay events; the server decides what they were worth.
 *
 * Body: `{ events: [{ key, reason, delta }] }`.
 *
 * `delta` is the game's own number and is only honoured for the kinds the server
 * cannot price (see DECLARED_KINDS). For everything else it is discarded and the
 * server's price is used, which is the entire point of the endpoint: the browser
 * reports what happened, never what it is worth.
 *
 * Every event is answered individually. A refused one is not a failed request —
 * the client should drop it, not retry it — so the response is 200 with per-event
 * outcomes, and the authoritative balance either way.
 *
 * The whole batch runs on ONE connection. Each event still gets its own
 * transaction inside the ledger, which is what keeps one refused event from
 * rolling back the twenty good ones in front of it.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
  }

  let body: { events?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const raw = Array.isArray(body.events) ? body.events : null;
  if (!raw) {
    return NextResponse.json({ error: 'events must be an array.' }, { status: 400 });
  }
  if (raw.length > MAX_EVENTS) {
    return NextResponse.json({ error: `at most ${MAX_EVENTS} events per request.` }, { status: 400 });
  }

  const user = await getUserById(session.user.id);
  if (!user) return NextResponse.json({ error: 'User not found.' }, { status: 404 });
  const playerId = await findOrCreatePlayer(session.user.id, user.email);

  const client = makeClient();
  await client.connect();
  try {
    await ensureCreditSchema(client);
    // Before anything is applied: the ledger has to know where the balance
    // started, or its first `balance_after` is a number with no provenance.
    await ensureOpeningBalance(client, playerId);

    const results: ReportResult[] = [];
    for (const item of raw) {
      const event = item as ReportedEvent;
      results.push(
        await applyReportedEvent(client, playerId, {
          key: String((event as { key?: unknown })?.key ?? ''),
          reason: String((event as { reason?: unknown })?.reason ?? ''),
          delta: Number((event as { delta?: unknown })?.delta),
        })
      );
    }

    const balance = results.length
      ? results[results.length - 1].balance
      : (await client.query('SELECT credit_balance FROM players WHERE id = $1', [playerId]))
          .rows[0]?.credit_balance ?? 0;

    return NextResponse.json({ balance: Number(balance), results });
  } catch (err) {
    console.error('[game/credits] failed:', err);
    return NextResponse.json({ error: 'Could not record events.' }, { status: 500 });
  } finally {
    await client.end();
  }
}
