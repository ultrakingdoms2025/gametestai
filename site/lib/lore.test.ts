import { describe, it, expect } from 'vitest';
import { getLore, FALLBACK_LORE, type LoreEntryRow } from './lore';

const rows = (r: Partial<LoreEntryRow>[]): LoreEntryRow[] =>
  r.map(x => ({ scope: 'station', title: 't', sign_label: 'Lorekeeper', body: 'b', ...x })) as LoreEntryRow[];

describe('getLore', () => {
  it('returns all 6 worlds even when the DB is empty', async () => {
    const lore = await getLore(async () => []);
    expect(Object.keys(lore).sort()).toEqual(['citadel','maze','medieval','race','sports','station']);
    // maze has no DB row ever → must come from fallback
    expect(lore.maze.body).toBe(FALLBACK_LORE.maze.body);
  });
  it('prefers DB entries over fallback, mapping scope→world', async () => {
    const lore = await getLore(async () => rows([{ scope: 'medieval', title: 'DB Vale', body: 'db body', sign_label: 'Reeve' }]));
    expect(lore.medieval.title).toBe('DB Vale');
    expect(lore.medieval.sign_label).toBe('Reeve');
    // untouched worlds still resolve from fallback
    expect(lore.citadel.body).toBe(FALLBACK_LORE.citadel.body);
  });
  it('falls back entirely when the fetcher throws (503/no Postgres)', async () => {
    const lore = await getLore(async () => { throw new Error('no db'); });
    for (const id of Object.keys(FALLBACK_LORE)) {
      expect(lore[id as keyof typeof FALLBACK_LORE].body).toBe(FALLBACK_LORE[id as keyof typeof FALLBACK_LORE].body);
    }
  });
});
