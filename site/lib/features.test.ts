import { describe, it, expect } from 'vitest';
import { FEATURE_SECTIONS, worldFeatures, featureTotal, type WorldsSection } from './features';
import { WORLDS, MOUNTS, WEAPONS } from './worlds';

const byId = (id: string) => {
  const s = FEATURE_SECTIONS.find((x) => x.id === id);
  if (!s) throw new Error(`no section ${id}`);
  return s;
};

describe('feature sections', () => {
  it('have unique, slug-shaped ids usable as hash deep links', () => {
    const ids = FEATURE_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it('every section has a title, a blurb and at least one named item', () => {
    for (const s of FEATURE_SECTIONS) {
      expect(s.title.trim().length).toBeGreaterThan(0);
      expect(s.blurb.trim().length).toBeGreaterThan(0);
      expect(s.items.length).toBeGreaterThan(0);
      for (const item of s.items) {
        const name = 'name' in item ? item.name : item.label;
        expect(name.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('the Worlds section names every world in WORLDS exactly once', () => {
    const worlds = byId('worlds');
    expect(worlds.kind).toBe('worlds');
    const ids = (worlds as WorldsSection).items.map((w) => w.world);
    expect(ids.length).toBe(WORLDS.length);
    expect([...ids].sort()).toEqual(WORLDS.map((w) => w.id).sort());
  });

  it('worldFeatures joins each entry to its WORLDS row, preserving page order', () => {
    const resolved = worldFeatures(byId('worlds') as WorldsSection);
    expect(resolved.map((r) => r.label)).toEqual(
      ['Station', 'Medieval', 'Citadel', 'Sports', 'Maze', 'Circuit', 'Space'],
    );
    for (const r of resolved) expect(r.def.id).toBe(r.world);
    // The in-game name is the one the visitor will see over the gateway.
    expect(resolved.find((r) => r.label === 'Medieval')?.def.name).toBe('Aldermoor Vale');
  });

  it('the Mounts and Weapons lists are exactly as long as the roster counts', () => {
    expect(byId('mounts').items.length).toBe(MOUNTS);
    expect(byId('weapons').items.length).toBe(WEAPONS);
  });

  it('featureTotal sums every item across every section', () => {
    const expected = FEATURE_SECTIONS.reduce((n, s) => n + s.items.length, 0);
    expect(featureTotal()).toBe(expected);
    expect(featureTotal([])).toBe(0);
  });
});
