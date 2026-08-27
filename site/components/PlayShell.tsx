'use client';

import { useEffect, useState } from 'react';
import { ServerStartPanel } from './ServerStartPanel';
import { ServerChatPanel } from './ServerChatPanel';

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
 */
export function PlayShell({ src }: { src: string }) {
  const [entered, setEntered] = useState(false);

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

  /* `play-gate`, NOT `play-shell`. The shell is `position: fixed; inset: 0`,
   * which is right for a full-bleed game iframe and wrong for a panel that
   * shares the page with a sticky 54 px header at z-index 200: the panel
   * pins to the viewport top, the header covers its controls, and
   * elementFromPoint at the button centre returns the header. A paid,
   * signed-in player saw a black page they could not click. */
  if (!entered) {
    return (
      <main className="play-gate">
        <ServerStartPanel onEnter={() => setEntered(true)} />
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
      {/* Outside the iframe, on purpose. Chat has no dependency on the running
          world — D2 means two members in the same world do not share an instance
          — so it does not belong in the renderer. It renders nothing at all in
          default mode, because there is no global channel by design. */}
      <ServerChatPanel />
    </main>
  );
}
