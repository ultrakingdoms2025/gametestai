import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getUserById } from '@/lib/db';
import { findOrCreatePlayer, getPlayerStatus, getGameState } from '@/lib/playerDb';
import { currentServer, openServerDb } from '@/lib/serverRoutes';
import { serverBalance } from '@/lib/serverCredits';
import { getServer } from '@/lib/customServers';

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
  }

  const user = await getUserById(session.user.id);
  if (!user) {
    return NextResponse.json({ error: 'User not found.' }, { status: 404 });
  }

  await findOrCreatePlayer(session.user.id, user.email);
  const profile = await getPlayerStatus(session.user.id);
  if (!profile) {
    return NextResponse.json({ error: 'Player profile not found.' }, { status: 404 });
  }

  const gameState = await getGameState(session.user.id).catch(() => null);

  /* Which content scope this boot is in (7d). Resolved server-side and
   * re-checked against membership, so the game is told the answer rather than
   * asked for it — and `null` is default mode, which is every session that
   * existed before this phase.
   *
   * `server_credits` rides along because a member's server balance is a
   * DIFFERENT number from `credits` above and the two must never be confused.
   * They come from separate tables and neither can move the other. */
  const serverId = await currentServer(profile.playerId);
  let serverCredits: number | null = null;
  /* `server` is the same fact as `server_id` with its NAME attached, for the
   * game HUD to display. Resolved here, server-side, from the stored selection
   * `currentServer` has already re-checked against membership — this handler
   * takes no Request and reads no query parameter, so there is no way for the
   * client to name a server it is not in. Additive: `server_id` and
   * `server_credits` keep their exact shapes for every existing reader. */
  let server: { id: string; name: string } | null = null;
  if (serverId) {
    const db = await openServerDb();
    try {
      serverCredits = await serverBalance(db, serverId, profile.playerId);
      const row = await getServer(db, serverId);
      if (row) server = { id: row.id, name: row.name };
    } catch (err) {
      console.error('[game/session] server balance failed:', err);
    } finally {
      await db.end().catch(() => {});
    }
  }

  return NextResponse.json({
    player_id: profile.playerId,
    handle: profile.handle ?? session.user.name ?? user.email.split('@')[0],
    full_name: profile.fullName,
    /* THE credits the HUD shows. Scoped to a server, that is the SERVER
     * balance — the owner's instruction: inside a custom server, the server's
     * economy IS the economy, and /api/game/credits applies every delta to the
     * same ledger this number came from, so the client's mirror and the
     * server's answer converge on one ledger. The client treats the field
     * opaquely; the server decides whose number it is. Unscoped, it is the
     * platform balance it always was. `platform_credits` and `server_credits`
     * carry both raw facts for any reader that needs to tell them apart. */
    credits: serverId ? serverCredits ?? 0 : profile.creditBalance,
    platform_credits: profile.creditBalance,
    has_access: profile.hasAccess,
    days_remaining: profile.daysRemaining,
    game_state: gameState,
    server_id: serverId,
    server_credits: serverCredits,
    server,
  });
}
