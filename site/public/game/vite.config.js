import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
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
