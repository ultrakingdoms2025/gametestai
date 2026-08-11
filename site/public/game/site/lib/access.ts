import { auth } from '@/lib/auth';
import type { Session } from 'next-auth';
import { findOrCreatePlayer, getPlayerStatus, type PlayerStatus } from '@/lib/playerDb';

export type CurrentAccessState = {
  status: PlayerStatus | null;
  hasAccess: boolean;
  daysRemaining: number;
};

export async function getAccessStateForSession(session: Session | null): Promise<CurrentAccessState> {
  if (!session?.user?.id || !session.user.email) {
    return {
      status: null,
      hasAccess: false,
      daysRemaining: 0,
    };
  }

  await findOrCreatePlayer(session.user.id, session.user.email);
  const status = await getPlayerStatus(session.user.id);

  return {
    status,
    hasAccess: !!status?.hasAccess,
    daysRemaining: status?.daysRemaining ?? 0,
  };
}

export async function getCurrentAccessState(): Promise<CurrentAccessState> {
  return getAccessStateForSession(await auth());
}
