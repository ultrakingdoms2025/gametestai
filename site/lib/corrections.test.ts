import { describe, it, expect } from 'vitest';
import { heroTicker, statBar, WORLDS, MOUNTS, WEAPONS } from './worlds';

describe('no stale counts', () => {
  it('derived copy says seven, and never a count the game has outgrown', () => {
    /* The noun is "gateways", not "worlds", and that is the correction rather
     * than a loosening of this test. WORLDS holds the seven destinations
     * reachable through the station's ring; the game registers EIGHTEEN, because
     * space and the ten landable planets sit behind Lodestar Yard's second gate.
     * "Seven worlds" was therefore a stale count in its own right — it just
     * happened to be stale in the direction nobody noticed, and it disagreed
     * with the stat tiles once those were relabelled Gateways.
     *
     * The property under test is unchanged: the chip is DERIVED from
     * WORLDS.length and never states a number the game has outgrown. */
    expect(heroTicker().join(' ')).toMatch(/Seven gateways/);
    expect(heroTicker().join(' ')).not.toMatch(/\b(Six|Seven) worlds\b/);
    expect(heroTicker().join(' ').toLowerCase()).not.toContain('five');
    expect(statBar()[0]).toBe('7');
  });
  it('roster matches the game', () => {
    expect(WORLDS).toHaveLength(7);
    expect(MOUNTS).toBe(6);
    expect(WEAPONS).toBe(4);
  });
});
