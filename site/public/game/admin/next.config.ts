import type { NextConfig } from 'next';
import path from 'node:path';

const config: NextConfig = {
  output: 'standalone',
  productionBrowserSourceMaps: false,
  turbopack: {
    root: path.resolve(__dirname),
    resolveAlias: {
      '@': path.resolve(__dirname),
    },
  },
};

export default config;