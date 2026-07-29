import { existsSync } from 'node:fs';
import path from 'node:path';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { readPass } from '@/lib/entitlement';
import { ENTRY_CENTS, formatCents, grossUp } from '@/lib/pricing';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'AETHER NEXUS' };

/**
 * The game, behind the gate.
 *
 * ## Why it is an iframe on this origin
 *
 * The game is a static Vite build copied into `public/game` by
 * `npm run bundle-game`. Serving it from this deployment is the whole point: a
 * gate in front of a game that also lives on its own public URL is decoration,
 * because the URL is the way in and it is not gated.
 *
 * That is still a soft gate — `/game/index.html` is a public path on this
 * origin, so someone who guesses it gets in. Closing that properly means
 * serving the bundle through an authenticated route handler rather than from
 * `public/`, which is a real change and is written up in the README. For a
 * one-dollar unlock it is the honest trade; for anything more it is not.
 *
 * `allow="pointer-lock"` is not optional. The game takes pointer lock to look
 * around, and an iframe cannot without being permitted to.
 */
export default async function Play() {
  const pass = await readPass();
  if (!pass?.paid) redirect('/checkout?intent=entry');

  const external = process.env.NEXT_PUBLIC_GAME_URL;
  const bundled = existsSync(path.join(process.cwd(), 'public', 'game', 'index.html'));
  const src = external || (bundled ? '/game/index.html' : null);

  if (!src) {
    return (
      <main className="play-missing">
        <div className="wrap" style={{ maxWidth: 560 }}>
          <div className="eyebrow" style={{ justifyContent: 'center' }}>Nothing to load</div>
          <h2 style={{ margin: '14px 0 12px', letterSpacing: '0.06em' }}>
            THE GAME BUILD IS NOT HERE
          </h2>
          <p style={{ color: 'var(--txt-2)' }}>
            Your access is fine — {formatCents(grossUp(ENTRY_CENTS))} paid, pass held on
            this browser. The build just has not been bundled into this deployment yet.
          </p>
          <p style={{ color: 'var(--txt-dim)', fontSize: '0.86rem' }}>
            Run <code>npm run bundle-game</code> from <code>site/</code> to build the game
            and copy it into <code>public/game</code>, or set{' '}
            <code>NEXT_PUBLIC_GAME_URL</code> to where it is hosted.
          </p>
          <div className="actions" style={{ justifyContent: 'center', marginTop: 26 }}>
            <Link className="btn btn-ghost" href="/">Back</Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="play-shell">
      <iframe
        src={src}
        title="Aether Nexus"
        allow="pointer-lock; fullscreen; gamepad; autoplay; clipboard-write"
        allowFullScreen
      />
    </main>
  );
}
