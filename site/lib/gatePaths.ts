/**
 * Which paths the launch gate covers.
 *
 * ── Why anything is excluded ───────────────────────────────────────────────
 *
 * `proxy.ts` gates /game on a session plus an HMAC-signed launch cookie. Its
 * matcher covered every path under /game, so a cold first load ran a middleware
 * function per file: a JWT decode and an HMAC verify, 59 times, for one player
 * arriving once. Vercel runs Routing Middleware BEFORE the cache, so the
 * `immutable, max-age=31536000` headers in `next.config.ts` could not spare it —
 * they spare the *second* visit, not the first.
 *
 * Locally, Vite serves those same files directly with no middleware at all.
 * That asymmetry is the reported symptom: production slower than development.
 *
 * ── What is still gated, and what that costs ───────────────────────────────
 *
 * The entry document is. A player without a session and a valid launch cookie
 * still cannot open the game, which is what the paywall is for. What changes is
 * that the hashed asset files can be fetched by anyone who already knows their
 * exact names — and those names appear only inside the gated document.
 *
 * The trade is deliberate: those files are inert client code that any
 * legitimate player can already save out of their own browser, so gating them
 * bought obscurity rather than protection, and charged every first load for it.
 *
 * `next.config.ts` states the original intent — "the access gate is only
 * meaningful if the thing being gated is not also sitting on a public URL of
 * its own". That remains true of the game itself; it was never true of a
 * content-hashed chunk.
 */

/** Everything below here is a build artefact, not the game's entry point. */
export const GAME_ASSET_PREFIX = '/game/assets/';

/** Fetched at runtime by KTX2Loader; as inert as anything under /assets. */
export const GAME_VENDOR_PREFIX = '/game/vendor/';

const UNGATED_PREFIXES = [GAME_ASSET_PREFIX, GAME_VENDOR_PREFIX] as const;

/**
 * A build artefact that does not need the gate.
 *
 * A path containing a `..` segment is never treated as an asset: the prefix
 * test alone would accept `/game/assets/../index.html`, which resolves to the
 * very document the gate exists to protect. Next normalises paths before
 * middleware sees them, so this is belt and braces — but it is the kind of belt
 * worth wearing on an auth boundary.
 */
export function isGameAssetPath(pathname: string): boolean {
  if (!pathname || pathname.split('/').includes('..')) return false;
  return UNGATED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/** The game entry point, which still requires a session and a launch cookie. */
export function isGatedGamePath(pathname: string): boolean {
  const isGame = pathname === '/game' || pathname.startsWith('/game/');
  return isGame && !isGameAssetPath(pathname);
}
