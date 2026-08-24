import { NextResponse } from 'next/server';
import { Client } from 'pg';
import { auth } from '@/lib/auth';
import { isMarketplaceAdminEmail } from '@/lib/adminAccess';
import { isKnownOverlayWorld, MAP_OVERLAY_SCHEMA } from '@/lib/mapOverlaySchema';
import { readCurrentOverlay } from '@/lib/mapOverlay';

/**
 * The overlay, for the game.
 *
 * Read-only, and the only endpoint the player's client ever calls about the
 * map. A signed-in session is required — the game itself is paywalled by
 * `proxy.ts`, so its content has no business being anonymously fetchable — but
 * being signed in is enough: the overlay is world dressing, the same category
 * as `/api/lore`.
 *
 * `admin` is a HINT for the client, not a grant. It exists so a normal player's
 * browser does not make a doomed POST to the report endpoint on every world
 * change. The report endpoint decides for itself, from the session, and refuses
 * a client that lies about this flag.
 *
 * The session's email is enough to answer `admin`: it comes from the signed
 * session, and `isMarketplaceAdminEmail` re-reads the allowlist on every call —
 * so a corrected env var takes effect immediately rather than at the next
 * deploy, which is the property `adminAllowlist.ts` was written to have.
 */

export const dynamic = 'force-dynamic';

function makeClient() {
  const connStr = process.env.POSTGRES_URL ?? '';
  const ssl = connStr.includes('sslmode=disable') ? false : { rejectUnauthorized: false };
  return new Client({ connectionString: connStr, ssl });
}

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
  }

  const world = new URL(request.url).searchParams.get('world');
  if (!isKnownOverlayWorld(world)) {
    return NextResponse.json({ error: 'Unknown world' }, { status: 404 });
  }

  const admin = isMarketplaceAdminEmail(session.user.email);

  const db = makeClient();
  await db.connect();
  try {
    const overlay = await readCurrentOverlay(db, world);
    return NextResponse.json({
      world,
      schema: MAP_OVERLAY_SCHEMA,
      version: overlay.version,
      entries: overlay.entries,
      admin,
    });
  } catch (err) {
    console.error('[game/map-overlay] failed:', err);
    // A world that cannot read its overlay must still be enterable. The client
    // treats a failure as "no overlay", which is the state every world was in
    // before this phase existed.
    return NextResponse.json({ error: 'Overlay unavailable.' }, { status: 503 });
  } finally {
    await db.end().catch(() => {});
  }
}
