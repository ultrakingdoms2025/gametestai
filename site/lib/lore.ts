import { Client } from 'pg';
import { WORLDS, type WorldId } from './worlds';

/**
 * RAW `pg`, not `@vercel/postgres`, for the reason `playerDb.ts` states in its
 * own header: "to support direct Neon connection strings". `@vercel/postgres`
 * refuses one and this module answered 503 on it - which mattered more here
 * than anywhere else, because this is the module that gets the rest right and
 * was the only Postgres-backed route still answering 200 during the
 * `server_id` outage. Thirty modules had already moved; this was the last.
 *
 * All three statements below are PARAMETERLESS, so the conversion carries no
 * placeholder risk - there is nothing to renumber.
 */
function makeClient() {
  const connStr = process.env.POSTGRES_URL ?? '';
  const ssl = connStr.includes('sslmode=disable') ? false : { rejectUnauthorized: false };
  return new Client({ connectionString: connStr, ssl });
}

export interface ResolvedLore { title: string; body: string; sign_label: string; }
export interface LoreEntryRow { scope: string; title: string; sign_label: string; body: string; updated_at?: unknown; }

/**
 * `serverId` defaults to null, and null means the PLATFORM partition — not "no
 * filter". Same contract as `listActiveQuestsForWorld` and
 * `listMarketplaceItems`: a caller written before custom servers existed keeps
 * seeing exactly today's content without being edited.
 */
export type LoreFetcher = (serverId?: string | null) => Promise<LoreEntryRow[]>;

/**
 * The platform partition.
 *
 * `server_id IS NULL` is the whole of the platform today. The `COALESCE` half
 * is the same union clause `playerDb.ts` and `marketplaceDb.ts` already use, so
 * a row ever stamped into THIS table for a server is picked up by the same
 * read rather than by a second one somebody has to remember to write. A null
 * parameter coalesces to `''`, which matches no `server_id`, so default mode
 * gets the NULL rows and nothing else.
 *
 * Written out literally, not interpolated, for the reason
 * `contentScoping.test.ts` records at length: a clause behind `${aVariable}` is
 * a clause no source test can read.
 */
const PLATFORM_LORE_SELECT = `
  SELECT scope, title, sign_label, body, updated_at, 0 AS scope_origin
    FROM lore_entries
   WHERE server_id IS NULL OR server_id = COALESCE($1, '')`;

/**
 * The owner's overlay, from the separate table `customServers.ts` explains.
 *
 * Only ever unioned in when a server has actually been resolved — see
 * `getLoreEntries`. `server_id = COALESCE($1, '')` is belt as well as braces:
 * the caller has already decided, and this clause makes the decision visible in
 * the statement.
 */
const SERVER_LORE_SELECT = `
  SELECT scope, title, sign_label, body, updated_at, 1 AS scope_origin
    FROM server_lore_entries
   WHERE server_id = COALESCE($1, '')`;

/**
 * Platform rows first, the server's overlay second.
 *
 * That ordering IS the merge rule. Both consumers key by scope and keep the
 * last row they see — `/api/lore` with `Object.fromEntries`, `getLore` with a
 * Map — so an owner's variant of a scope replaces the platform text for that
 * world, and every scope the owner did not author keeps the platform text. A
 * scope the platform has never had is pure addition. That is D2's "in addition
 * to defaults" applied to a table whose key is the scope.
 *
 * Wrapped around a subquery rather than appended to the branches, because
 * Postgres refuses an expression in a UNION's own ORDER BY — "invalid
 * UNION/INTERSECT/EXCEPT ORDER BY clause", which is a runtime error and not a
 * type error, so it is found by running the query and by nothing else. The
 * wrapper also keeps `scope_origin` out of the returned rows: it is a sort key,
 * not part of the shape callers read.
 */
function orderedLore(inner: string): string {
  return `
  SELECT scope, title, sign_label, body, updated_at
    FROM (${inner}) AS lore
   ORDER BY scope_origin, CASE scope
     WHEN 'overall' THEN 0 WHEN 'station' THEN 1 WHEN 'medieval' THEN 2
     WHEN 'sports' THEN 3 WHEN 'citadel' THEN 4 WHEN 'race' THEN 5
     WHEN 'maze' THEN 6 WHEN 'dock' THEN 7 WHEN 'space' THEN 8
     ELSE 99 END, scope`;
}

/** Shared query used by BOTH the API route and server-side getLore — no HTTP self-fetch. */
export const getLoreEntries: LoreFetcher = async (serverId = null) => {
  const scoped = String(serverId ?? '').trim() || null;
  const client = makeClient();
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS lore_entries (
        scope TEXT PRIMARY KEY, title TEXT NOT NULL,
        sign_label TEXT NOT NULL DEFAULT 'Lorekeeper', body TEXT NOT NULL,
        updated_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    /* Additive, and declared HERE as well as in `customServers.ts` because this
     * function creates the table it reads and must not depend on another module
     * having run first. Without it, a database where the custom-server schema has
     * not been ensured answers the SELECT below with "column server_id does not
     * exist" — which `getLore` catches and turns into every world showing its
     * fallback prose. A silent, total content outage from a missing column. */
    await client.query(`ALTER TABLE lore_entries ADD COLUMN IF NOT EXISTS server_id TEXT`);

    /* The overlay is unioned in ONLY when a server was resolved, and that is a
     * safety property rather than an optimisation.
     *
     * `server_lore_entries` is created by `ensureCustomServerSchema`, which this
     * module deliberately does not call — it has a foreign key to
     * `custom_servers`, so declaring it here would need that table too, and this
     * function must keep working on a database where the custom-server schema has
     * never run. Naming a missing table in the statement would not degrade, it
     * would throw, and `getLore` would turn that into every world showing its
     * fallback prose: the same silent, total content outage the ALTER above
     * exists to prevent.
     *
     * A non-null `scoped` cannot arrive on such a database. It comes from
     * `currentServerId`, which reads `player_server_selection`, `custom_servers`
     * and `server_members` through a connection `openServerDb` has already run
     * `ensureCustomServerSchema` on. So by construction: if there is a server to
     * scope to, the table exists. */
    const sql = orderedLore(
      scoped ? `${PLATFORM_LORE_SELECT} UNION ALL ${SERVER_LORE_SELECT}` : PLATFORM_LORE_SELECT
    );
    const { rows } = await client.query(sql, [scoped]);
    return rows as LoreEntryRow[];
  } finally {
    await client.end();
  }
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

/**
 * Resolve prose lore for every world: DB entry wins, else fallback; total
 * failure → all fallback.
 *
 * `fetcher()` is called with no argument, so this is the PLATFORM partition.
 * Its caller is the public marketing page, which is read by people who are not
 * signed in and must not vary by whose server the reader happens to be in.
 * The in-game scoped read is `/api/lore`, which resolves the scope from the
 * session before calling the same fetcher.
 */
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
