import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getUserById } from '@/lib/db';
import { findOrCreatePlayer, getPlayerStatus } from '@/lib/playerDb';

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

  return NextResponse.json({
    player_id: profile.playerId,
    handle: profile.handle ?? session.user.name ?? user.email.split('@')[0],
    full_name: profile.fullName,
    credits: profile.creditBalance,
    has_access: profile.hasAccess,
    days_remaining: profile.daysRemaining,
  });
}
