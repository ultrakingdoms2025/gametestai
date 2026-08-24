import { NextResponse, NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { getUserById } from '@/lib/db';
import {
  findOrCreatePlayer,
  listActiveQuestsForWorld,
  getPlayerQuestEngagements,
  acceptQuestEngagement,
  updateQuestStepStates,
  completeQuestEngagement,
  failQuestEngagement,
} from '@/lib/playerDb';
import { currentServer } from '@/lib/serverRoutes';

export async function GET(request: NextRequest) {
  const worldRaw = request.nextUrl.searchParams.get('world') ?? 'station';
  const world = String(worldRaw).trim().toLowerCase() || 'station';

  const session = await auth();
  if (!session?.user?.id) {
    /* Signed out: the platform catalogue, exactly as before. `serverId` omitted
     * means the platform partition — never "no filter" — so this branch is
     * unchanged by custom servers existing. */
    return NextResponse.json({
      quests: await listActiveQuestsForWorld(world),
      engagements: [],
      player_id: null,
    });
  }
  const user = await getUserById(session.user.id);
  if (!user) {
    return NextResponse.json({
      quests: await listActiveQuestsForWorld(world),
      engagements: [],
      player_id: null,
    });
  }

  const playerId = await findOrCreatePlayer(session.user.id, user.email);
  /* D2: entry with that server's items IN ADDITION TO defaults. `currentServer`
   * re-checks membership, so a player removed since their last request drops
   * back to the platform catalogue on this very call. */
  const serverId = await currentServer(playerId);
  const quests = await listActiveQuestsForWorld(world, serverId);
  const engagements = await getPlayerQuestEngagements(playerId);
  return NextResponse.json({ quests, engagements, player_id: playerId, server_id: serverId });
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
  }
  const user = await getUserById(session.user.id);
  if (!user) {
    return NextResponse.json({ error: 'User not found.' }, { status: 404 });
  }
  const playerId = await findOrCreatePlayer(session.user.id, user.email);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { action } = body;

  if (action === 'accept') {
    // Only questId is trusted from the client — quest_number/title/world/
    // duration/reward/quest_line are all read from the quests table server-side.
    const { questId } = body as { questId: string };
    if (typeof questId !== 'string' || !questId.trim()) {
      return NextResponse.json({ ok: false, error: 'questId is required.' }, { status: 400 });
    }
    /* The scope is resolved server-side, never read from the body.
     *
     * It does two jobs: an owner quest is only acceptable by somebody in that
     * owner's server, and a PLATFORM quest accepted inside a custom server
     * accrues to that server (D2 gives a member both catalogues). Both are
     * decided by acceptQuestEngagement, from the quest row plus this value. */
    const serverId = await currentServer(playerId);
    const result = await acceptQuestEngagement(playerId, questId.trim(), serverId);
    if (!result.ok) {
      if (result.reason === 'quest_not_found') {
        return NextResponse.json(
          { ok: false, reason: 'quest_not_found', error: 'Quest not found.' },
          { status: 404 }
        );
      }
      if (result.reason === 'already_completed') {
        // 409, same as prerequisites: well-formed request, ineligible player.
        return NextResponse.json(
          {
            ok: false,
            reason: 'already_completed',
            error: 'You have already completed this quest.',
          },
          { status: 409 }
        );
      }
      // 409: the request is well-formed, the player just is not eligible yet.
      return NextResponse.json(
        {
          ok: false,
          reason: 'prerequisites',
          missing: result.missing,
          error: `Complete first: ${result.missing.join(', ')}`,
        },
        { status: 409 }
      );
    }
    return NextResponse.json({
      ok: true,
      engagementId: result.engagementId,
      existing: result.existing,
    });
  }

  if (action === 'progress') {
    const { engagementId, stepStates, percentComplete } = body as {
      engagementId: string; stepStates: unknown; percentComplete: number;
    };
    await updateQuestStepStates(engagementId, playerId, stepStates, percentComplete ?? 0);
    return NextResponse.json({ ok: true });
  }

  if (action === 'complete') {
    // creditsRewarded is deliberately NOT read from the body — the server
    // re-reads quests.reward_credits so the award cannot be forged.
    const { engagementId } = body as { engagementId: string };
    const result = await completeQuestEngagement(engagementId, playerId);
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: 'Engagement not found or not completable.', status: result.status },
        { status: 404 }
      );
    }
    return NextResponse.json({
      ok: true,
      // creditsRewarded/creditsAwarded are the same server-decided delta under
      // both names the client reads; creditBalance is the authoritative total
      // so the next /api/game/state push cannot overwrite this grant.
      creditsRewarded: result.creditsAwarded,
      creditsAwarded: result.creditsAwarded,
      creditBalance: result.creditBalance,
      alreadyCompleted: result.alreadyCompleted,
    });
  }

  if (action === 'fail') {
    const { engagementId, reason } = body as {
      engagementId: string; reason: string;
    };
    await failQuestEngagement(engagementId, playerId, reason ?? 'expired');
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
