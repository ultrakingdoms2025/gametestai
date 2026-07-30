'use client';
import Link from 'next/link';
import { useSession, signOut } from 'next-auth/react';
import { useState } from 'react';
import { usePathname } from 'next/navigation';

/**
 * Persistent site header shown on all pages EXCEPT the home page (which has its own nav).
 */
export default function SiteHeader() {
  const { data: session, status } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = usePathname();

  // The home page has its own hero nav — don't double up
  if (pathname === '/') return null;

  return (
    <div className="site-header">
      <Link href="/" className="site-header-logo">AETHER NEXUS</Link>
      <nav className="site-header-nav">
        <Link href="/store" className="site-header-link">Credits</Link>
        {status === 'authenticated' ? (
          <div className="site-header-user">
            <button
              className="site-header-avatar"
              onClick={() => setMenuOpen((v) => !v)}
              aria-label="Account menu"
            >
              {session.user?.email?.[0]?.toUpperCase() ?? '?'}
            </button>
            {menuOpen && (
              <div className="site-header-dropdown" onMouseLeave={() => setMenuOpen(false)}>
                <div className="site-header-email">{session.user?.email}</div>
                <Link href="/account" className="site-header-item" onClick={() => setMenuOpen(false)}>Account &amp; 2FA</Link>
                <Link href="/play" className="site-header-item" onClick={() => setMenuOpen(false)}>Enter game</Link>
                <button
                  className="site-header-item site-header-item--danger"
                  onClick={() => { setMenuOpen(false); signOut({ callbackUrl: '/' }); }}
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        ) : status === 'unauthenticated' ? (
          <>
            <Link href="/login" className="btn btn-ghost site-header-btn">Sign in</Link>
            <Link href="/register" className="btn btn-primary site-header-btn">Create account</Link>
          </>
        ) : null}
      </nav>
    </div>
  );
}
