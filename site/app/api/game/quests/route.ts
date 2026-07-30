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

export async function GET(request: NextRequest) {
  const worldRaw = request.nextUrl.searchParams.get('world') ?? 'station';
  const world = String(worldRaw).trim().toLowerCase() || 'station';
  const quests = await listActiveQuestsForWorld(world);

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ quests, engagements: [], player_id: null });
  }
  const user = await getUserById(session.user.id);
  if (!user) {
    return NextResponse.json({ quests, engagements: [], player_id: null });
  }

  const playerId = await findOrCreatePlayer(session.user.id, user.email);
  const engagements = await getPlayerQuestEngagements(playerId);
  return NextResponse.json({ quests, engagements, player_id: playerId });
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
    const { questId, questNumber, questTitle, world, durationMinutes } = body as {
      questId: string; questNumber: number; questTitle: string;
      world: string; durationMinutes: number | null;
    };
    const engagementId = await acceptQuestEngagement(
      playerId, questId, questNumber, questTitle, world, durationMinutes ?? null
    );
    return NextResponse.json({ engagementId });
  }

  if (action === 'progress') {
    const { engagementId, stepStates, percentComplete } = body as {
      engagementId: string; stepStates: unknown; percentComplete: number;
    };
    await updateQuestStepStates(engagementId, stepStates, percentComplete ?? 0);
    return NextResponse.json({ ok: true });
  }

  if (action === 'complete') {
    const { engagementId, creditsRewarded } = body as {
      engagementId: string; creditsRewarded: number;
    };
    await completeQuestEngagement(engagementId, playerId, creditsRewarded ?? 0);
    return NextResponse.json({ ok: true });
  }

  if (action === 'fail') {
    const { engagementId, reason } = body as {
      engagementId: string; reason: string;
    };
    await failQuestEngagement(engagementId, reason ?? 'expired');
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
