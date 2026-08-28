import { NextResponse } from 'next/server';
import { Client } from 'pg';
import { requireMarketplaceAdmin } from '@/lib/adminAccess';
import { appendAudit, ensureAuditSchema } from '@/lib/auditChain';
import { isKnownOverlayWorld, normaliseOverlayEntries, type NormalisedOverlay } from '@/lib/mapOverlaySchema';
import {
  ensureMapOverlaySchema,
  listOverlayVersions,
  readCurrentOverlay,
  readWorldReport,
  revertOverlayTo,
  saveOverlayVersion,
  type WorldReport,
} from '@/lib/mapOverlay';
import { conflictContextFor, conflictsForDocument, hasErrors, type Conflict, type ConflictCode } from '@/lib/mapConflicts';

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

type Rejection = { index: number; id: string; reason: ConflictCode };

/**
 * Error-level conflicts as `rejected[]` rows, indexed into the array the
 * client SENT. The normaliser drops entries it cannot read, so position k in
 * its output is not raw index k; its own `rejected[].index` is a raw index and
 * the editor highlights rows by it, so these rows use the same coordinate and
 * one response never carries two meanings of "index". Every raw index lands in
 * exactly one of `entries` or `rejected`, which is what makes the walk sound.
 */
function conflictRejections(normalised: NormalisedOverlay, all: Conflict[][]): Rejection[] {
  const dropped = new Set(normalised.rejected.map((r) => r.index));
  const rawIndex: number[] = [];
  const total = normalised.entries.length + normalised.rejected.length;
  for (let i = 0; i < total; i++) if (!dropped.has(i)) rawIndex.push(i);

  const out: Rejection[] = [];
  all.forEach((conflicts, k) => {
    for (const c of conflicts) {
      if (c.level === 'error') out.push({ index: rawIndex[k], id: normalised.entries[k].id, reason: c.code });
    }
  });
  return out;
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
    const [overlay, versions, stored] = await Promise.all([
      readCurrentOverlay(db, world),
      listOverlayVersions(db, world),
      readWorldReport(db, world),
    ]);
    // One read serves both. `report` keeps its shape for the panel that already reads it; the layout
    // rides BESIDE it (a 700 KB grid is not catalogue), and `reportedAt` is lifted so the editor can show the map's age.
    // `reportedAt` is when the game last REPORTED — any report, including the immediate one that carries no
    // ground yet — not when the layout last changed; the editor's banner says "reported N min ago", which is that.
    // The annotation is load bearing: a SEVENTH field on this literal is a type error, not a wider `report`.
    const report: WorldReport | null = stored && {
      appliedVersion: stored.appliedVersion, builtVersion: stored.builtVersion, objects: stored.objects, applied: stored.applied,
      unresolved: stored.unresolved, reportedAt: stored.reportedAt,
    };
    return NextResponse.json({ world, overlay, versions, report, layout: stored?.layout ?? null, reportedAt: stored?.reportedAt ?? null });
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

    /* The conflict gate. The editor runs the same rules live and shows the
     * result before the admin clicks Save, but the editor is a courtesy: this
     * is the boundary, and a client that skipped the check (or a replayed
     * request) cannot write a document with an error-level conflict. Only
     * errors refuse; warnings are the admin's call and are saved as they are.
     * Refusing writes nothing — the audit row records saves, and there was no
     * save. Reverts bypass this on purpose (above): a version accepted once
     * stays reachable even after a later layout report would have refused it,
     * or history becomes unreachable by accident. `saveOverlayVersion`
     * normalises again below; the normaliser is a fixed point, and letting it
     * keep doing so leaves its `rejected` reporting exactly as it was. The
     * context comes from `conflictContextFor`, the helper the editor's panel
     * uses too, so the two never disagree about a grid: a stored ground that
     * will not decode is a warning in the log and no grid, and the bounds
     * rule — the one that refuses — still refuses. */
    const normalised = normaliseOverlayEntries(body.entries);
    const report = await readWorldReport(db, world);
    const conflicts = conflictsForDocument(
      normalised.entries,
      conflictContextFor(report?.layout ?? null, report?.objects ?? [])
    );
    if (hasErrors(conflicts)) {
      await db.query('ROLLBACK').catch(() => {});
      return NextResponse.json(
        { error: 'conflicts', rejected: conflictRejections(normalised, conflicts) },
        { status: 400 }
      );
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
