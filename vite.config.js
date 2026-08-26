import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';

/**
 * The commit this bundle was built from, for the boot card's "build" line.
 *
 * Exists because "I am not sure if it pushed" is a question that has now been
 * asked from a phone twice, and the only way to answer it was a curl of a
 * hashed asset from a machine with a terminal. A seven-character stamp on the
 * title card lets the owner read the deployed build off the screen. Vercel
 * exposes the SHA as an env var (its build has no .git); a local build reads
 * git; a checkout with neither says so rather than failing the build.
 */
function buildCommit() {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  if (sha) return sha.slice(0, 7);
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'local';
  }
}

export default defineConfig({
  define: {
    __BUILD_COMMIT__: JSON.stringify(buildCommit()),
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      /* Game/account API lives in the Next site, not the chat server. Without
       * this, `/api/game/quests` fell through to the chat process and 404'd, so
       * quests silently never loaded in dev and the quest board was always
       * empty - which is a large part of why broken quest data went unnoticed.
       * Run `npm run dev` in site/ (port 3000) alongside this server.
       * The more specific prefix must come FIRST: vite matches in key order. */
      '/api/game': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
      // Chat AI backend runs as a separate node process (server/chat-server.js)
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'esnext',
    /* The deployed bundle carried 18 MB of sourcemaps -- the index map alone was
     * 15.4 MB -- and a sourcemap embeds the original sources, so the whole tree
     * was publicly readable under /game/assets. Commit 042e753 ("Ship the
     * expansion, and stop publishing the source tree with it") had already
     * decided that question once; it had regressed since.
     *
     * Browsers only fetch a map when devtools are open, so real players never
     * paid for the bytes. What they paid for was the publication.
     *
     * Deploy verification used to grep those maps, because a source-level marker
     * survives only in the map once the chunk is minified. `bundle-game.mjs`
     * writes `build.json` next to the bundle instead -- see the note there. */
    sourcemap: false,
    base: '/game/',
  },
  base: '/game/',
});
