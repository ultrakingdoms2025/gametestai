import { NextResponse } from 'next/server';
import { Client } from 'pg';
import { requireMarketplaceAdmin } from '@/lib/adminAccess';
import { appendAudit, ensureAuditSchema } from '@/lib/auditChain';
import { isKnownOverlayWorld } from '@/lib/mapOverlaySchema';
import {
  ensureMapOverlaySchema,
  listOverlayVersions,
  readCurrentOverlay,
  readWorldReport,
  revertOverlayTo,
  saveOverlayVersion,
} from '@/lib/mapOverlay';

/**
 * The map editor's read and write surface. Admin only.
 *
 * ── The guard is the first statement of every handler ──────────────────────
 *
 * Not middleware, and not a wrapper. Next 16 renamed `middleware.ts` to
 * `proxy.ts` partly because of CVE-2025-29927 — a middleware auth bypass driven
 * by a request header — and `admin/lib/session.ts` already records the
 * conclusion this project drew from that: "a proxy that is the only gate is one
 * header away from being no gate". The proxy stays as defence in depth; this is
 * the gate.
 *
 * Nothing before the guard opens a connection or reads a body, so a refused
 * caller costs one session lookup and touches no data. `mapAdminRoutes.test.ts`
 * asserts exactly that, by mocking the store and checking it was never called.
 */

export const dynamic = 'force-dynamic';

function makeClient() {
  const connStr = process.env.POSTGRES_URL ?? '';
  const ssl = connStr.includes('sslmode=disable') ? false : { rejectUnauthorized: false };
  return new Client({ connectionString: connStr, ssl });
}

/**
 * Client IP for the audit row, hashed before storage by `appendAudit`.
 *
 * `x-forwarded-for` is spoofable by anyone who can reach the origin directly.
 * It is recorded anyway, because on Vercel it is set by the platform and is the
 * only IP available — and because an audit row's value does not rest on it: the
 * actor is the authenticated allowlisted address, which is not spoofable.
 */
function clientIp(request: Request): string | null {
  const fwd = request.headers.get('x-forwarded-for');
  if (!fwd) return null;
  return fwd.split(',')[0]?.trim() || null;
}

export async function GET(request: Request, ctx: { params: Promise<{ world: string }> }) {
  const admin = await requireMarketplaceAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { world } = await ctx.params;
  if (!isKnownOverlayWorld(world)) {
    return NextResponse.json({ error: 'Unknown world' }, { status: 404 });
  }

  const db = makeClient();
  await db.connect();
  try {
    const [overlay, versions, report] = await Promise.all([
      readCurrentOverlay(db, world),
      listOverlayVersions(db, world),
      readWorldReport(db, world),
    ]);
    return NextResponse.json({ world, overlay, versions, report });
  } catch (err) {
    console.error('[admin/map] read failed:', err);
    return NextResponse.json({ error: 'Could not read the overlay.' }, { status: 500 });
  } finally {
    await db.end().catch(() => {});
  }
}

/**
 * Save a new version, or revert to an old one.
 *
 * Both are the same operation underneath — reverting writes a NEW version
 * holding a copy of an old one's entries — but they are different actions to
 * whoever reads the audit log later, so they are recorded under different names.
 */
export async function POST(request: Request, ctx: { params: Promise<{ world: string }> }) {
  const admin = await requireMarketplaceAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { world } = await ctx.params;
  if (!isKnownOverlayWorld(world)) {
    return NextResponse.json({ error: 'Unknown world' }, { status: 404 });
  }

  let body: { entries?: unknown; note?: unknown; revertTo?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const actor = admin.user.email;
  const ip = clientIp(request);
  const db = makeClient();
  await db.connect();
  try {
    /* Both schemas are ensured OUTSIDE the transaction below, and the ordering
     * is load bearing. `ensureMapOverlaySchema` memoises its promise; if its
     * CREATE TABLE ran inside a transaction that then rolled back, the tables
     * would be gone while the memo still said "ensured", and every later request
     * on this instance would skip the DDL and fail on a table that is not
     * there. */
    await ensureMapOverlaySchema(db);
    await ensureAuditSchema(db);

    /* The change and the record of the change are ONE transaction.
     *
     * The audit log is the only thing that says an administrator moved a
     * building in a live world. Of the three possible outcomes — recorded and
     * done, neither, or done but not recorded — the third is the worst, because
     * afterwards nothing anywhere says it happened. `HMAC_SECRET` missing on
     * this deployment is how that actually occurs, and it is a configuration
     * state rather than an exotic one. So an unauditable change does not
     * happen. */
    await db.query('BEGIN');

    if (body.revertTo !== undefined && body.revertTo !== null) {
      const version = Number(body.revertTo);
      if (!Number.isInteger(version) || version < 1) {
        await db.query('ROLLBACK').catch(() => {});
        return NextResponse.json({ error: 'revertTo must be a version number' }, { status: 400 });
      }
      const saved = await revertOverlayTo(db, { worldId: world, version, author: actor });
      if (!saved) {
        await db.query('ROLLBACK').catch(() => {});
        return NextResponse.json({ error: 'No such version' }, { status: 404 });
      }

      await appendAudit(db, {
        actor,
        action: 'map.overlay.revert',
        resource: `world:${world}`,
        detail: JSON.stringify({
          version: saved.version,
          revertedTo: version,
          entries: saved.entries.length,
        }),
        ip,
      });
      await db.query('COMMIT');
      return NextResponse.json({ world, overlay: saved, reverted: version });
    }

    const saved = await saveOverlayVersion(db, {
      worldId: world,
      entries: body.entries,
      author: actor,
      note: typeof body.note === 'string' ? body.note : null,
    });

    await appendAudit(db, {
      actor,
      action: 'map.overlay.save',
      resource: `world:${world}`,
      detail: JSON.stringify({
        version: saved.version,
        entries: saved.entries.length,
        rejected: saved.rejected.length,
      }),
      ip,
    });
    await db.query('COMMIT');
    return NextResponse.json({ world, overlay: saved });
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('[admin/map] save failed:', err);
    const unconfigured = err instanceof Error && /HMAC_SECRET/.test(err.message);
    return NextResponse.json(
      {
        error: unconfigured
          ? 'Nothing was saved: this deployment cannot write the admin audit log. Set HMAC_SECRET to the same value the admin app uses.'
          : 'Could not save the overlay.',
      },
      { status: 500 }
    );
  } finally {
    await db.end().catch(() => {});
  }
}
