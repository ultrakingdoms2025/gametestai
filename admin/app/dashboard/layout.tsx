import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSession } from '@/lib/session';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session.adminId) redirect('/login');

  async function logout() {
    'use server';
    const s = await import('@/lib/session').then(m => m.getSession());
    const { audit } = await import('@/lib/db');
    if (s.adminId) await audit(s.username, 'auth.logout', `admin:${s.adminId}`);
    s.destroy();
    redirect('/login');
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-logo">AETHER<span>NEXUS</span><br />Admin Panel</div>
        <nav>
          <Link href="/dashboard">Overview</Link>
          <Link href="/dashboard/players">Players</Link>
          <Link href="/dashboard/quests">Quests</Link>
          <Link href="/dashboard/marketplace">Marketplace</Link>
          <Link href="/dashboard/map">Map Editor</Link>
          <Link href="/dashboard/purchases">Purchases</Link>
          <Link href="/dashboard/lore">Lore</Link>
          <Link href="/dashboard/audit">Audit Log</Link>
          <Link href="/dashboard/config">Config</Link>
        </nav>
        <div className="sidebar-footer">
          <form action={logout}>
            <button type="submit" style={{ fontSize: 11, padding: '6px 12px' }}>Sign out</button>
          </form>
        </div>
      </aside>

      <main className="main">
        <div className="top-bar">
          <span>Signed in as <strong style={{ color: 'var(--cy)' }}>{session.username}</strong></span>
          <span style={{ fontSize: 11 }}>AetherNexus Admin · restricted access</span>
        </div>
        {children}
      </main>
    </div>
  );
}