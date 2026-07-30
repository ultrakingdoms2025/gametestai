/**
 * AccountDashboard — shown on the home page when the user is logged in.
 * Displays credit balance, access status, days remaining, and action button.
 * Server component: reads session + player DB directly.
 */
import Link from 'next/link';
import { auth } from '@/lib/auth';
import { findOrCreatePlayer, getPlayerStatus } from '@/lib/playerDb';

export default async function AccountDashboard() {
  const session = await auth();
  if (!session?.user?.id || !session?.user?.email) return null;

  let status;
  try {
    await findOrCreatePlayer(session.user.id, session.user.email);
    status = await getPlayerStatus(session.user.id);
  } catch {
    status = null;
  }

  const credits = status?.creditBalance ?? 0;
  const hasAccess = status?.hasAccess ?? false;
  const daysRemaining = status?.daysRemaining ?? 0;
  const userName = session.user.name ?? session.user.email?.split('@')[0] ?? 'Player';

  return (
    <section className="account-dashboard">
      <div className="wrap">
        <div className="acct-inner">
          <div className="acct-welcome">
            <span className="acct-label">Welcome back</span>
            <span className="acct-name">{userName}</span>
          </div>

          <div className="acct-stats">
            <div className="acct-stat">
              <span className="acct-stat-val">{credits.toLocaleString()}</span>
              <span className="acct-stat-key">Credits</span>
            </div>
            <div className="acct-stat">
              {hasAccess ? (
                <>
                  <span className="acct-stat-val acct-access-active">{daysRemaining}d</span>
                  <span className="acct-stat-key">Access remaining</span>
                </>
              ) : (
                <>
                  <span className="acct-stat-val acct-access-inactive">—</span>
                  <span className="acct-stat-key">No active access</span>
                </>
              )}
            </div>
          </div>

          <div className="acct-actions">
            {hasAccess ? (
              <>
                <Link href="/play" className="btn btn-primary">
                  Launch Game
                </Link>
                <span className="acct-access-note">
                  Access expires in {daysRemaining} day{daysRemaining !== 1 ? 's' : ''}
                </span>
              </>
            ) : (
              <>
                <Link href="/checkout?intent=entry" className="btn btn-primary">
                  Purchase Access
                </Link>
                <span className="acct-access-note">30 days of full access</span>
              </>
            )}
            {credits > 0 && (
              <Link href="/store" className="btn btn-amber btn-sm">
                Buy more credits
              </Link>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}