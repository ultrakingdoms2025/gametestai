import { describe, it, expect } from 'vitest';
import { heroTicker, statBar, WORLDS, MOUNTS, WEAPONS } from './worlds';

describe('no stale counts', () => {
  it('derived copy says six, not five', () => {
    expect(heroTicker().join(' ')).toMatch(/Six worlds/);
    expect(heroTicker().join(' ').toLowerCase()).not.toContain('five');
    expect(statBar()[0]).toBe('6');
  });
  it('roster matches the game', () => {
    expect(WORLDS).toHaveLength(6);
    expect(MOUNTS).toBe(6);
    expect(WEAPONS).toBe(4);
  });
});
