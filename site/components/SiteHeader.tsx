'use client';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { usePathname } from 'next/navigation';
import SignOutButton from '@/components/SignOutButton';

/**
 * Persistent site header shown on all pages EXCEPT the home page (which has its own nav).
 *
 * ── Why "Servers" is here ─────────────────────────────────────────────────
 *
 * `/admin/servers` is the whole of the custom-server product — the dashboard
 * where an owner subscribes, creates a server, invites players and authors its
 * content. It was linked from nowhere: not this header, not the store, not the
 * account dashboard. A customer could reach the only recurring SKU the project
 * sells by typing the URL and by no other means.
 *
 * It sits inside the authenticated branch because the page itself redirects a
 * signed-out visitor to `/login?callbackUrl=%2Fadmin%2Fservers`, and a nav link
 * whose only outcome is a login bounce is not navigation. The store's own
 * section covers the signed-out reader, who has to be sold the thing before
 * being sent to a dashboard for it.
 *
 * "Servers", not "Admin": despite the URL this is not a staff page. It is
 * deliberately signed-in-only rather than allowlisted — see the page's own
 * header — because a server owner is an ordinary player who has paid for
 * hosting, and every real authorisation decision is made per request by the
 * routes the panel calls.
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
            <Link href="/admin/servers" className="site-header-link">Servers</Link>
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
