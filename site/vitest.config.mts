import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': dirname, // mirror tsconfig's "@/*" -> "./*" so scene files can import via the same alias Next.js uses
    },
  },
  test: {
    environment: 'node',                 // three's object creation works headless; no jsdom needed
    include: ['lib/**/*.test.ts', 'components/**/*.test.ts'],  // lib logic + scene leak/determinism tests
    passWithNoTests: true,               // this verify step runs before any test exists
  },
});
