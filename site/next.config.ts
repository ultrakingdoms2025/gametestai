import type { NextConfig } from 'next';
import path from 'node:path';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  turbopack: {
    root: path.resolve(__dirname),
  },

  /* The game is copied into `public/game` by `npm run bundle-game`, and is
   * served from this origin on purpose: the access gate is only meaningful if
   * the thing being gated is not also sitting on a public URL of its own.
   *
   * It ships its own hashed filenames, so it can be cached hard. `index.html`
   * must not be, or a returning player is pinned to whatever build they first
   * loaded. */
  async headers() {
    return [
      {
        source: '/game/assets/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        ],
      },
      {
        source: '/game/index.html',
        headers: [{ key: 'Cache-Control', value: 'no-cache' }],
      },
    ];
  },
};

export default nextConfig;
