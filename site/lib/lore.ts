import { sql } from '@vercel/postgres';
import { WORLDS, type WorldId } from './worlds';

export interface ResolvedLore { title: string; body: string; sign_label: string; }
export interface LoreEntryRow { scope: string; title: string; sign_label: string; body: string; updated_at?: unknown; }

export type LoreFetcher = () => Promise<LoreEntryRow[]>;

/** Shared query used by BOTH the API route and server-side getLore — no HTTP self-fetch. */
export const getLoreEntries: LoreFetcher = async () => {
  await sql`
    CREATE TABLE IF NOT EXISTS lore_entries (
      scope TEXT PRIMARY KEY, title TEXT NOT NULL,
      sign_label TEXT NOT NULL DEFAULT 'Lorekeeper', body TEXT NOT NULL,
      updated_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  const { rows } = await sql`
    SELECT scope, title, sign_label, body, updated_at FROM lore_entries
    ORDER BY CASE scope
      WHEN 'overall' THEN 0 WHEN 'station' THEN 1 WHEN 'medieval' THEN 2
      WHEN 'sports' THEN 3 WHEN 'citadel' THEN 4 WHEN 'race' THEN 5
      WHEN 'maze' THEN 6 WHEN 'dock' THEN 7 WHEN 'space' THEN 8
      ELSE 99 END, scope`;
  return rows as LoreEntryRow[];
};

/* Prose fallback for EVERY world, sourced from `src/content/Lore.js`
 * DEFAULT_LORE (maze from src/worlds/MazeWorld.js). Keep in sync with the
 * in-game canon: `scripts/tests/dock-economy.test.mjs` reads this file and
 * DEFAULT_LORE together and fails when a scope exists in one and not the
 * other, because the two drifting is invisible until a reader notices the
 * marketing page describing a world that is not there any more.
 *
 * `space` is deliberately NOT here. It is a lore SCOPE (the yard's second
 * keeper recites it) and not a world with a gateway, a card or a diorama, and
 * this table is keyed by `WorldId`. */
export const FALLBACK_LORE: Record<WorldId, ResolvedLore> = {
  station: { title: 'Aether Nexus Station', sign_label: 'Dockmaster',
    body: 'Orbital hub of the Nexus: a ring of concourses, plazas, gantries and glass. The archive. The checkpoint. Every gateway begins here.' },
  medieval: { title: 'Aldermoor Vale', sign_label: 'Reeve',
    body: 'An old-world valley of timber roofs, market squares, castle walls and pilgrim roads. The lakes are swimmable and have real depth.' },
  sports: { title: 'Meridian Athletic Grounds', sign_label: 'Groundskeeper',
    body: 'A bright training complex of courts, tracks, bowls, snow runs and grandstands — under lights, with a seated crowd.' },
  citadel: { title: 'Sunspire Citadel', sign_label: 'Gate Warden',
    body: 'A vertical town crowning a cliff above the desert: terraces, rope bridges, towers and guarded gates, up to a 46 m great tower.' },
  race: { title: 'Vellum Ridge', sign_label: 'Race Marshal',
    body: 'Three circuits over rough terrain and city streets — Vellum Ridge, Cinder Gorge and Aurora Rise — each run on a real F1 start.' },
  maze: { title: 'The Verdant Coil', sign_label: 'Keeper of the Verdant Coil',
    body: 'A hedge maze that re-rolls its layout on every entry. Its districts and levels never repeat. The maze that cannot be learned is the entire point.' },
  dock: { title: 'Lodestar Yard', sign_label: 'Yard Warden',
    body: 'Survey Site 06, commissioned. Nothing here was built here: every hull came through the gateway in sections narrower than the arch and was pinned back together on a cradle, which is why they are slab-sided and ribbed and why a yard rat can climb one like a wall. Four hulls are fitted out. The board on the blast door reads LAUNCHES: 000.' },
};

/** Resolve prose lore for every world: DB entry wins, else fallback; total failure → all fallback. */
export async function getLore(fetcher: LoreFetcher = getLoreEntries): Promise<Record<WorldId, ResolvedLore>> {
  const byScope = new Map<string, LoreEntryRow>();
  try {
    for (const row of await fetcher()) byScope.set(row.scope, row);
  } catch (e) {
    console.error('[lore] fetch failed, using fallback:', e);
  }
  const out = {} as Record<WorldId, ResolvedLore>;
  for (const w of WORLDS) {
    const db = byScope.get(w.loreScope);
    out[w.id] = db
      ? { title: db.title, body: db.body, sign_label: db.sign_label }
      : FALLBACK_LORE[w.id];
  }
  return out;
}
