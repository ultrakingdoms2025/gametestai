import { describe, it, expect } from 'vitest';
import { WORLDS, MOUNTS, WEAPONS, heroTicker, statBar, worldSeq } from './worlds';

describe('canonical world model', () => {
  it('has exactly 7 worlds in order with unique ids and 1-based index', () => {
    expect(WORLDS).toHaveLength(7);
    expect(WORLDS.map(w => w.id)).toEqual(['station','medieval','sports','citadel','race','maze','dock']);
    WORLDS.forEach((w, i) => expect(w.index).toBe(i + 1));
    expect(new Set(WORLDS.map(w => w.id)).size).toBe(7);
  });
  it('uses canonical in-game display names', () => {
    const byId = Object.fromEntries(WORLDS.map(w => [w.id, w.name]));
    expect(byId.medieval).toBe('Aldermoor Vale');
    expect(byId.race).toBe('Vellum Ridge');
    expect(byId.maze).toBe('The Verdant Coil');
    expect(byId.station).toBe('Aether Nexus Station');
    expect(byId.dock).toBe('Lodestar Yard');
  });
  it('every world has copy, fact, accent, a scene id equal to its id, and a valid painterKey', () => {
    const validPainterKeys = new Set(['station','valley','sports','citadel','circuit','maze','yard']);
    for (const w of WORLDS) {
      expect(w.copy.length).toBeGreaterThan(10);
      expect(w.fact.length).toBeGreaterThan(3);
      expect(w.accent).toMatch(/^#[0-9a-f]{6}$/i);
      expect(w.scene).toBe(w.id);
      expect(validPainterKeys.has(w.painterKey)).toBe(true);
    }
  });
  it('roster counts are correct', () => {
    expect(MOUNTS).toBe(6);
    expect(WEAPONS).toBe(4);
  });
  it('derivation helpers reflect the roster and never say five', () => {
    const ticker = heroTicker();
    /* "gateways", not "worlds" — see lib/corrections.test.ts for the full
     * reasoning. In short: seven is the number of GATEWAYS, and calling it the
     * number of worlds undersold an eighteen-world game by eleven. */
    expect(ticker).toContain('Seven gateways');
    expect(ticker).toContain('Six mounts');
    expect(ticker).toContain('Four weapons');
    expect(ticker.join(' ')).not.toMatch(/five|(six|seven) worlds/i);

    expect(statBar()).toEqual(['7', '6', '4', '0 GB']);
    expect(worldSeq(1)).toBe('01 / 07');
    expect(worldSeq(7)).toBe('07 / 07');
  });
});
