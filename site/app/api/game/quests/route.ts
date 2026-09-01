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
import { currentContentScope } from '@/lib/serverRoutes';

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
  /* The scope pair — which server AND how it merges — is resolved ONCE by
   * `currentContentScope` and handed to the read whole. In `extend` mode this
   * is D2 verbatim: the server's quests IN ADDITION TO defaults. In `replace`
   * mode the board is the server's rows only — an owner who authored 3 quests
   * shows 3 quests, and an owner who authored none shows the same empty board
   * the shipped empty-state already renders. The resolver re-checks
   * membership, so a player removed since their last request drops back to
   * the platform catalogue on this very call. */
  const scope = await currentContentScope(playerId);
  const quests = await listActiveQuestsForWorld(world, scope.serverId, scope.mode);
  const engagements = await getPlayerQuestEngagements(playerId);
  return NextResponse.json({
    quests,
    engagements,
    player_id: playerId,
    server_id: scope.serverId,
    content_mode: scope.mode,
  });
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
     * It does three jobs: an owner quest is only acceptable by somebody in
     * that owner's server; a PLATFORM quest accepted inside a custom server
     * accrues to that server (D2 gives a member both catalogues); and in
     * `replace` mode a platform quest is not acceptable at all — the accept
     * must agree with the board. All are decided by acceptQuestEngagement,
     * from the quest row plus this one resolved pair. */
    const scope = await currentContentScope(playerId);
    const result = await acceptQuestEngagement(playerId, questId.trim(), scope.serverId, scope.mode);
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
      /* `reason` distinguishes the three refusals that used to share one 404:
       * no such engagement, wrong status, and "the steps are not finished" —
       * which is now a real answer rather than an impossible one. A capped
       * completion is a 429: nothing was taken, and trying later works. */
      const status = result.reason === 'capped' ? 429 : 404;
      return NextResponse.json(
        {
          ok: false,
          error: result.reason === 'steps_incomplete'
            ? 'That quest still has unfinished steps.'
            : result.reason === 'capped'
              ? 'Too many quest rewards in the last hour. Nothing was taken; try again shortly.'
              : 'Engagement not found or not completable.',
          reason: result.reason ?? null,
          status: result.status,
        },
        { status }
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
