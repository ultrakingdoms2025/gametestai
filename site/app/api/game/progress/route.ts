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
  readFirstReports,
  FIRST_REPORT_CAVEAT,
  FIRST_REPORT_CLAIM,
  type ProgressPayload,
} from '@/lib/progressLedger';
import { currentServerId, ensureCustomServerSchema } from '@/lib/customServers';

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

/**
 * GET → everything the account holds, for hydration at boot.
 *
 * ── `?firsts=<kind>&scope=<world>`: who reported each find first ─────────
 *
 * A second, additive shape on the same verb. With no `firsts` parameter the
 * response is byte-identical to what it always was, so no existing reader
 * changes.
 *
 * The scope is the caller's CURRENT server, resolved server-side from the
 * stored selection — never taken from the query string, the same rule
 * `/api/game/chat` states. A player in default mode gets `{ server: null,
 * firsts: [] }` rather than an error: there is no global first-finder board by
 * design, for the same reason there is no global chat channel.
 *
 * ── The claim this endpoint is allowed to make, and the one it is not ────
 *
 * It answers FIRST TO REPORT. `created_at` is when the row reached Postgres and
 * `ProgressSync` batches, so a player who was offline for a week can lose a
 * claim they earned by finding it first. That is not a defect to be fixed
 * later — a client-declared discovery time would be a clock the player owns,
 * which `progressLedger`'s header refuses everywhere else in the file for the
 * same reason.
 *
 * So the caveat travels WITH the data, in the response body, rather than being
 * left to whichever UI renders it. A client that shows these rows has the
 * sentence in hand; one that invents "first to find" had to ignore a field
 * literally named `caveat` to do it.
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
  }

  const user = await getUserById(session.user.id);
  if (!user) return NextResponse.json({ error: 'User not found.' }, { status: 404 });
  const playerId = await findOrCreatePlayer(session.user.id, user.email);

  const url = new URL(req.url);
  const firstsKind = (url.searchParams.get('firsts') ?? '').trim();

  const client = makeClient();
  await client.connect();
  try {
    await ensureProgressSchema(client);
    if (!firstsKind) {
      return NextResponse.json({ state: await readProgress(client, playerId) });
    }

    await ensureCustomServerSchema(client);
    const serverId = await currentServerId(client, playerId);
    if (!serverId) {
      return NextResponse.json({
        server: null,
        kind: firstsKind,
        scope: (url.searchParams.get('scope') ?? '').trim(),
        claim: FIRST_REPORT_CLAIM,
        caveat: FIRST_REPORT_CAVEAT,
        firsts: [],
      });
    }

    const rows = await readFirstReports(client, {
      serverId,
      kind: firstsKind,
      scope: (url.searchParams.get('scope') ?? '').trim(),
      playerId,
      limit: Number(url.searchParams.get('limit') ?? 200),
    });

    return NextResponse.json({
      server: serverId,
      kind: firstsKind,
      scope: (url.searchParams.get('scope') ?? '').trim(),
      claim: FIRST_REPORT_CLAIM,
      caveat: FIRST_REPORT_CAVEAT,
      firsts: rows.map((r) => ({
        key: r.itemKey,
        /* The handle, and the caller's own id when it is theirs. Another
         * member's internal id stays off the wire, exactly as the leaderboard
         * route keeps it off: this is the other endpoint that hands a list of
         * accounts to somebody. */
        name: r.handle,
        reported_at: r.reportedAt,
        self: r.self,
        ...(r.self ? { playerId: r.playerId } : {}),
      })),
    });
  } catch (err) {
    console.error('[game/progress] read failed:', err);
    return NextResponse.json({ error: 'Could not read progress.' }, { status: 500 });
  } finally {
    await client.end().catch(() => {});
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
