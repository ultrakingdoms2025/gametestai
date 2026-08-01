'use client';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { usePathname } from 'next/navigation';
import SignOutButton from '@/components/SignOutButton';

/**
 * Persistent site header shown on all pages EXCEPT the home page (which has its own nav).
 */
export default function SiteHeader() {
  const { data: session, status } = useSession();
  const pathname = usePathname();

  // The home page has its own hero nav — don't double up
  if (pathname === '/') return null;

  return (
    <div className="site-header">
      <Link href="/" className="site-header-logo">AETHER NEXUS</Link>
      <nav className="site-header-nav">
        <Link href="/store" className="site-header-link">Credits</Link>
        {status === 'authenticated' ? (
          <>
            <span className="site-header-email">{session.user?.name ?? session.user?.email}</span>
            <Link href="/account" className="btn btn-ghost site-header-btn">Account</Link>
            <Link href="/play" className="btn btn-primary site-header-btn">Enter game</Link>
            <SignOutButton className="btn btn-ghost site-header-btn" />
          </>
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
