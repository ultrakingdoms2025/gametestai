import { NextResponse } from 'next/server';
import { Client } from 'pg';
import { requireMarketplaceAdmin } from '@/lib/adminAccess';
import { isKnownOverlayWorld } from '@/lib/mapOverlaySchema';
import { MAX_LAYOUT_BYTES } from '@/lib/mapLayout';
import { recordWorldReport } from '@/lib/mapOverlay';

/**
 * What the running game found and did — reported back by an admin's own client.
 *
 * ── Why the editor needs this at all ───────────────────────────────────────
 *
 * A world is procedural code. Nothing on the server knows what objects
 * `MedievalWorld.js` built, or what they are called, or where they ended up —
 * and an editor that asks an admin to type an object name out of a 12,945-line
 * file is not an editor. So the game, which does know, says so: after applying
 * the overlay it posts the world's named objects plus a per-entry outcome.
 *
 * That also turns the phase's acceptance criterion — "saves, reloads and sees
 * it in game" — into something the editor can display rather than something a
 * human has to swear to. An entry the game could not resolve appears in the
 * editor as unresolved, next to the object names that do exist.
 *
 * ── Why the admin check is here and not only in the client ─────────────────
 *
 * `/api/game/map-overlay` tells the client whether the player is an admin, and
 * a non-admin's client does not call this route. That flag is a HINT, so the
 * client can avoid a pointless request — it is not a permission, because it
 * arrived over the wire and anything that arrived over the wire can be replayed
 * with a different value. The decision is taken here, again, from the session.
 */

export const dynamic = 'force-dynamic';

function makeClient() {
  const connStr = process.env.POSTGRES_URL ?? '';
  const ssl = connStr.includes('sslmode=disable') ? false : { rejectUnauthorized: false };
  return new Client({ connectionString: connStr, ssl });
}

export async function POST(request: Request) {
  const admin = await requireMarketplaceAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  /* Checked twice: the declared length refuses an honest oversized client before a byte
   * is read; the bytes that arrived are checked again because the header is the client's
   * claim. `Buffer.byteLength` counts UTF-8 bytes (a Cyrillic name is not under-counted as
   * `text.length` would); this is a Node route. 4 MB sits under Vercel's 4.5 MB body limit. */
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_LAYOUT_BYTES) return NextResponse.json({ error: 'Report too large' }, { status: 413 });
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_LAYOUT_BYTES) return NextResponse.json({ error: 'Report too large' }, { status: 413 });

  let body: {
    world?: unknown; appliedVersion?: unknown; objects?: unknown; applied?: unknown; unresolved?: unknown;
    layoutSchema?: unknown; bounds?: unknown; shapes?: unknown; ground?: unknown;
  };
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const world = body.world;
  if (!isKnownOverlayWorld(world)) {
    return NextResponse.json({ error: 'Unknown world' }, { status: 404 });
  }

  const db = makeClient();
  await db.connect();
  try {
    // Every field is clamped and coerced inside recordWorldReport: this is data
    // from a browser, and being an admin's browser does not make it structured.
    // The layout fields go through as-is for the same reason: the store, not
    // the route, decides what a usable grid is, and keeps the prior one if not.
    await recordWorldReport(db, world, {
      appliedVersion: Number(body.appliedVersion) || 0,
      objects: Array.isArray(body.objects) ? (body.objects as never[]) : [],
      applied: Array.isArray(body.applied) ? (body.applied as never[]) : [],
      unresolved: Array.isArray(body.unresolved) ? (body.unresolved as never[]) : [],
      layoutSchema: body.layoutSchema,
      bounds: body.bounds,
      shapes: body.shapes,
      ground: body.ground,
    });
    return NextResponse.json({ ok: true, world });
  } catch (err) {
    console.error('[admin/map/report] failed:', err);
    return NextResponse.json({ error: 'Could not record the report.' }, { status: 500 });
  } finally {
    await db.end().catch(() => {});
  }
}
