import { defineConfig } from 'vite';

export default defineConfig({
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
    sourcemap: true,
    base: '/game/',
  },
  base: '/game/',
});
