import { existsSync } from 'node:fs';
import path from 'node:path';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentAccessState } from '@/lib/access';
import { PlayShell } from '@/components/PlayShell';
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
 * The public files themselves still live under `public/game`, but access is
 * gated by a signed launch cookie issued at `/play/launch` and checked by the
 * app proxy before `/game/*` is served.
 *
 * `allow="pointer-lock"` is not optional. The game takes pointer lock to look
 * around, and an iframe cannot without being permitted to.
 */
export default async function Play() {
  const { hasAccess } = await getCurrentAccessState();
  if (!hasAccess) redirect('/checkout?intent=entry');

  const bundled = existsSync(path.join(process.cwd(), 'public', 'game', 'index.html'));
  const src = bundled ? '/play/launch' : null;

  if (!src) {
    return (
      <main className="play-missing">
        <div className="wrap" style={{ maxWidth: 560 }}>
          <div className="eyebrow" style={{ justifyContent: 'center' }}>Nothing to load</div>
          <h2 style={{ margin: '14px 0 12px', letterSpacing: '0.06em' }}>
            THE GAME BUILD IS NOT HERE
          </h2>
          <p style={{ color: 'var(--txt-2)' }}>
            Your access is active and the launch gate is working. The game build
            just has not been bundled into this deployment yet.
          </p>
          <p style={{ color: 'var(--txt-dim)', fontSize: '0.86rem' }}>
            Run <code>npm run bundle-game</code> from <code>site/</code> to build the game
            and copy it into <code>public/game</code>.
          </p>
          <div className="actions" style={{ justifyContent: 'center', marginTop: 26 }}>
            <Link className="btn btn-ghost" href="/">Back</Link>
          </div>
        </div>
      </main>
    );
  }

  /* The start panel (7d) chooses default mode or a server BEFORE the iframe is
   * mounted, because the game resolves its quest and marketplace scope during
   * boot and a choice made afterwards would arrive too late. `PlayShell` is the
   * client component that holds that one piece of state; everything else on this
   * page stays a server component. */
  return <PlayShell src={src} />;
}
