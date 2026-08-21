import { describe, it, expect } from 'vitest';
import { heroTicker, statBar, WORLDS, MOUNTS, WEAPONS } from './worlds';

describe('no stale counts', () => {
  it('derived copy says seven, and never a count the game has outgrown', () => {
    expect(heroTicker().join(' ')).toMatch(/Seven worlds/);
    expect(heroTicker().join(' ').toLowerCase()).not.toContain('five');
    expect(heroTicker().join(' ')).not.toMatch(/Six worlds/);
    expect(statBar()[0]).toBe('7');
  });
  it('roster matches the game', () => {
    expect(WORLDS).toHaveLength(7);
    expect(MOUNTS).toBe(6);
    expect(WEAPONS).toBe(4);
  });
});
