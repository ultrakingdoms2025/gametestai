import { NextResponse } from 'next/server';
import { Client } from 'pg';
import { auth } from '@/lib/auth';
import { getUserById } from '@/lib/db';
import { findOrCreatePlayer } from '@/lib/playerDb';
import { RATE_LIMITS, clientIp, consumeRateLimit, tooManyRequests } from '@/lib/rateLimit';
import {
  ensureProgressSchema,
  mergeProgress,
  readProgress,
  type ProgressPayload,
} from '@/lib/progressLedger';

export const dynamic = 'force-dynamic';

function makeClient() {
  const connStr = process.env.POSTGRES_URL ?? '';
  const ssl = connStr.includes('sslmode=disable') ? false : { rejectUnauthorized: false };
  return new Client({ connectionString: connStr, ssl });
}

/**
 * Cross-device player progress: relics found, viewpoints synced, seams worked
 * out, objectives, best times.
 *
 * Deliberately NOT part of `/api/game/state`. That route stores one opaque blob
 * and can only keep whichever copy arrived last, which is the exact failure this
 * endpoint exists to remove — a phone and a PC each holding half a world's
 * relics, and the later sync deleting the other half. Here the server merges,
 * and the merge cannot lose: union for sets, LEAST/GREATEST for numbers, with
 * the rule chosen server-side per kind.
 *
 * Both verbs return the SAME shape — the player's full merged progress — so the
 * client has one adoption path rather than two.
 */

/** GET → everything the account holds, for hydration at boot. */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
  }

  const user = await getUserById(session.user.id);
  if (!user) return NextResponse.json({ error: 'User not found.' }, { status: 404 });
  const playerId = await findOrCreatePlayer(session.user.id, user.email);

  const client = makeClient();
  await client.connect();
  try {
    await ensureProgressSchema(client);
    return NextResponse.json({ state: await readProgress(client, playerId) });
  } catch (err) {
    console.error('[game/progress] read failed:', err);
    return NextResponse.json({ error: 'Could not read progress.' }, { status: 500 });
  } finally {
    await client.end();
  }
}

/**
 * POST → merge this device's progress in, and return the merged truth.
 *
 * Body: `{ items: [{ kind, scope, keys }], values: [{ kind, scope, key, value }] }`.
 *
 * Never subtracts. A payload that omits something the server already holds is a
 * device that has not seen it yet, not a report that it was lost. That single
 * rule is what makes the endpoint safe to call from a device with a stale save.
 *
 * An unrecognised kind is reported in `rejected` rather than failing the batch,
 * for the same reason the credits route answers per-event: one bad entry from a
 * stale bundle must not cost the player the twenty good ones beside it.
 *
 * ── Bounded now, in two ways ──────────────────────────────────────────────
 *
 * This is a grow-only ledger of client-declared claims, so what it stores is
 * whatever the client says it found and nothing here witnessed any of it. It
 * had no rate limit and no revoke path, which together meant one POST could
 * award every relic, viewpoint, charter and deed in the game and the result was
 * PERMANENT.
 *
 * The rate limit is here; the per-(kind, scope) delta cap and the operator's
 * `revokeProgressItems` are in `lib/progressLedger.ts`. The limit is set well
 * clear of the client's own sync cadence -- `ProgressSync` pushes on discovery,
 * not on a tight timer -- so it bounds a script rather than a player.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
  }

  const limit = await consumeRateLimit(
    'progress',
    [
      { namespace: 'user', value: session.user.id },
      { namespace: 'ip', value: clientIp(req) },
    ],
    RATE_LIMITS.progress
  );
  if (!limit.allowed) return tooManyRequests(limit, 'Too many progress syncs.');

  let body: ProgressPayload;
  try {
    body = (await req.json()) as ProgressPayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Body must be an object.' }, { status: 400 });
  }

  const user = await getUserById(session.user.id);
  if (!user) return NextResponse.json({ error: 'User not found.' }, { status: 404 });
  const playerId = await findOrCreatePlayer(session.user.id, user.email);

  const client = makeClient();
  await client.connect();
  try {
    await ensureProgressSchema(client);
    const result = await mergeProgress(client, playerId, body);
    return NextResponse.json(result);
  } catch (err) {
    console.error('[game/progress] merge failed:', err);
    return NextResponse.json({ error: 'Could not record progress.' }, { status: 500 });
  } finally {
    await client.end();
  }
}
