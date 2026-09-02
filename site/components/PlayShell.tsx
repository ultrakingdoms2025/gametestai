'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ServerStartPanel } from './ServerStartPanel';
import { ServerChatPanel } from './ServerChatPanel';
import { SUPPORT_EMAIL, supportMailto } from './support';

/**
 * The start panel, and then the game.
 *
 * ── Why the iframe is not rendered until the choice is made ───────────────
 *
 * The game fetches its quest list and its marketplace catalogue during boot, and
 * both resolve their scope from the player's stored selection. Mounting the
 * iframe first and letting the panel change the selection afterwards would build
 * a world from one catalogue and then tell it about another — so the panel is a
 * gate rather than an overlay, and `src` is null until it opens it.
 *
 * ── One re-render, no key churn ───────────────────────────────────────────
 *
 * `entered` flips once per visit. The iframe is created at that point and never
 * re-created, because re-creating it is a full reload of a 24 MB bundle and a
 * lost session.
 *
 * ── The two black rectangles this used to have ────────────────────────────
 *
 * A bare iframe on a black ground has exactly one appearance for two completely
 * different situations: a 24 MB build still arriving, and a machine that cannot
 * run WebGL at all. A customer who has just paid could not tell "wait a minute"
 * from "this will never work", and the page offered no way to find out. Both
 * are answered before the iframe is mounted now — a real context probe up
 * front, and a loading panel behind the frame until its `load` event.
 */

type Webgl = 'probing' | 'ok' | 'missing';

/**
 * The same probe `GatewayDescent` uses, for the same reason: a throwaway canvas
 * so the failure path never constructs a renderer. WebGL 2 first, WebGL 1 as
 * the fallback — the game runs on either.
 */
function probeWebgl(): boolean {
  try {
    const probe = document.createElement('canvas');
    return !!(probe.getContext('webgl2') || probe.getContext('webgl'));
  } catch {
    return false;
  }
}

/** Long enough that it is not shown to anyone on a normal connection. */
const SLOW_AFTER_MS = 20_000;

export function PlayShell({ src }: { src: string }) {
  const [entered, setEntered] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [slow, setSlow] = useState(false);
  /* Probed after mount, never during render: a canvas context is a browser API
   * and the server has no answer for it. `probing` is the SSR value, so the
   * first client paint agrees with the server's. */
  const [webgl, setWebgl] = useState<Webgl>('probing');

  useEffect(() => { setWebgl(probeWebgl() ? 'ok' : 'missing'); }, []);

  /* While the iframe is mounted the site header is not rendered (see
   * `body.in-game` in globals.css): the game owns the whole screen, and on a
   * phone the header's own overflow was what widened the layout viewport the
   * iframe is sized from. Cleared on unmount so the rest of the site gets its
   * header back. */
  useEffect(() => {
    if (!entered) return undefined;
    document.body.classList.add('in-game');
    return () => document.body.classList.remove('in-game');
  }, [entered]);

  useEffect(() => {
    if (!entered || loaded) return undefined;
    const t = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => clearTimeout(t);
  }, [entered, loaded]);

  /* ---- no WebGL: say so, in full, before anything else ------------------ */
  if (webgl === 'missing') {
    return (
      <main id="main" tabIndex={-1} className="play-gate">
        <div className="wrap play-requirements" role="alert">
          <div className="eyebrow">Cannot start</div>
          <h1>This browser cannot run the game</h1>
          <p>
            Aether Nexus draws every world with WebGL, and this browser did not give us
            a WebGL context. That is a hard requirement — there is no software mode to
            fall back to, so the game would show you a black screen rather than a world.
          </p>
          <h2 className="play-requirements-h2">What usually fixes it</h2>
          <ul>
            <li>
              <b>Turn hardware acceleration back on.</b> It is off in some managed and
              battery-saver setups, and it is the single most common cause.
              In Chrome and Edge: Settings → System. In Firefox: Settings → General →
              Performance.
            </li>
            <li>
              <b>Update the browser</b>, then the graphics driver. A driver the browser
              has blocklisted disables WebGL silently.
            </li>
            <li>
              <b>Try another browser.</b> Current Chrome, Edge, Firefox and Safari all
              support WebGL 2.
            </li>
            <li>
              <b>Check the browser&rsquo;s own diagnosis.</b> Chrome and Edge report it at{' '}
              <code>about:gpu</code>; Firefox at <code>about:support</code>.
            </li>
          </ul>
          <p className="note">
            Your access is unaffected by any of this — it lives on your account, not on
            this machine, so it will still be there from another device.
          </p>
          <div className="actions">
            <button type="button" className="btn btn-primary"
              onClick={() => setWebgl(probeWebgl() ? 'ok' : 'missing')}>
              Check again
            </button>
            <a
              className="btn btn-ghost"
              href={supportMailto(
                'Aether Nexus — no WebGL on my browser',
                'The game says my browser has no WebGL context.\n\n'
                + 'Browser and version:\n'
                + 'Operating system:\n'
                + 'What about:gpu or about:support says:\n'
              )}
            >
              Contact support
            </a>
            <Link className="btn btn-ghost" href="/account">Your account</Link>
          </div>
          <p className="note">
            If none of it works, write to <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>{' '}
            and we will refund the access rather than leave you paying for something your
            machine will not run.
          </p>
        </div>
      </main>
    );
  }

  /* `play-gate`, NOT `play-shell`. The shell is `position: fixed; inset: 0`,
   * which is right for a full-bleed game iframe and wrong for a panel that
   * shares the page with a sticky 54 px header at z-index 200: the panel
   * pins to the viewport top, the header covers its controls, and
   * elementFromPoint at the button centre returns the header. A paid,
   * signed-in player saw a black page they could not click. */
  if (!entered) {
    return (
      <main id="main" tabIndex={-1} className="play-gate">
        <ServerStartPanel onEnter={() => setEntered(true)} />
      </main>
    );
  }

  return (
    <main id="main" tabIndex={-1} className="play-shell">
      {/* Behind the iframe, which is transparent until it has painted: the
          panel is what fills the screen for as long as the build is arriving,
          and it unmounts the moment `load` fires. */}
      {!loaded && (
        <div className="play-loading" role="status" aria-live="polite">
          <div className="play-loading-lockup" aria-hidden="true">
            AETHER<span>NEXUS</span>
          </div>
          <div className="play-loading-bar" aria-hidden="true"><span /></div>
          <p className="play-loading-line">Building your worlds…</p>
          {slow && (
            <p className="play-loading-slow">
              Still going. The build is large — every world, texture and sound is code
              that has to arrive before the first frame, and on a slow connection the
              first visit can take a couple of minutes. It is cached afterwards, so
              this only happens once per release. Nothing has gone wrong.
            </p>
          )}
        </div>
      )}
      <iframe
        src={src}
        title="Aether Nexus"
        allow="pointer-lock; fullscreen; gamepad; autoplay; clipboard-write"
        allowFullScreen
        onLoad={() => setLoaded(true)}
        className={loaded ? 'play-frame is-loaded' : 'play-frame'}
      />
      {/* Outside the iframe, on purpose. Chat has no dependency on the running
          world — D2 means two members in the same world do not share an instance
          — so it does not belong in the renderer. It renders nothing at all in
          default mode, because there is no global channel by design. */}
      <ServerChatPanel />
    </main>
  );
}
