import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',                 // three's object creation works headless; no jsdom needed
    include: ['lib/**/*.test.ts', 'components/**/*.test.ts'],  // lib logic + scene leak/determinism tests
    passWithNoTests: true,               // this verify step runs before any test exists
  },
});
