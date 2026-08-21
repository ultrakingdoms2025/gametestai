import { describe, expect, it } from 'vitest';
import { painters } from './painters';
import { WORLDS } from './worlds';

/**
 * The never-blank guarantee: every world's `painterKey` must resolve to a real
 * painter, or the static fallback renders an empty plate. Canonical ids and
 * painter keys deliberately differ (medieval→valley, race→circuit, maze→maze),
 * which is exactly the mismatch class this catches mechanically.
 *
 * Key presence / typeof only — painters touch canvas APIs when CALLED, and this
 * suite runs in the node environment, so they are never invoked here.
 */
describe('painters registry', () => {
  it('has a painter function for every WORLDS painterKey', () => {
    for (const w of WORLDS) {
      expect(
        typeof painters[w.painterKey],
        `painter "${w.painterKey}" (world "${w.id}") missing from painters.ts`,
      ).toBe('function');
    }
  });

  it('covers all seven expected keys including the maze and yard painters', () => {
    for (const key of ['station', 'valley', 'sports', 'citadel', 'circuit', 'maze', 'yard']) {
      expect(typeof painters[key], `painter "${key}"`).toBe('function');
    }
  });
});
