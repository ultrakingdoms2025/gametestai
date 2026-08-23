import type { Client, PoolClient } from 'pg';
import { ensureProgressSchema } from './progressLedger';

/**
 * Leaderboards: derived, never submitted, and never movable by custom content.
 *
 * ── The contradiction this file resolves, and which way ────────────────────
 *
 * Roadmap §Phase 11 offers to rank "fastest races, highest survival wave,
 * weekly credits, rare collections". Phase 3 §9 — the phase explicitly tasked
 * with settling rankability — rules three of those four out, and §9 wins:
 *
 *   > Rank only on sets whose maximum is fixed by content, never on totals or
 *   > times.
 *
 * The reasoning is worth restating because it is the whole file. A forger can
 * reach a content cap; so can an honest completionist. The board then ranks
 * COMPLETION, and a forger merely arrives sooner at a ceiling everyone shares —
 * a bounded, survivable failure. A total or a time has no ceiling, so a forger's
 * advantage on one is unbounded, which is not survivable.
 *
 * Times are refused for a second, concrete reason: `completeQuestEngagement`
 * (`playerDb.ts:862`) never reads `step_states`, trial PBs live in editable
 * localStorage, and race pickups pay on DNF. A forged time is not merely early,
 * it is unreachable.
 *
 * ── Nothing is written, so nothing can be submitted ────────────────────────
 *
 * §9's amendment: "the score endpoint derives from the identity sets in
 * `player_progress_items`, which the server already holds, rather than accepting
 * a submitted figure." There is no scores table in this file and no writer. A
 * client cannot post a rank because there is nowhere to post it to.
 *
 * ── The Phase 7 abuse vector, and the three layers that close it ───────────
 *
 * D2 lets a custom-server owner author their own quests and marketplace items
 * AND share leaderboards. Left alone an owner mints rank with a one-step quest
 * paying 10,000 CR. Phase 7's rule is that enforcement lives at write time, not
 * in a read filter, "because a filter is a gate that can be forgotten, whereas a
 * score that was never written globally cannot leak".
 *
 *   1. **The write-time stamp.** `server_id` is added additively to the progress
 *      tables and to quests/engagements BY THIS FILE, TODAY, before any writer
 *      exists that could set it. Platform writes leave it NULL. Every board is
 *      derived for a scope and partitions on that stamp. There is no later "and
 *      now add the filter" step to forget, because the partition is already here
 *      and already under test while the column is still always NULL.
 *
 *   2. **The identity domain, which is the layer that does not depend on (1).**
 *      A global board does not count a player's rows and then remove the bad
 *      ones. It ENUMERATES the platform content manifest and asks which of those
 *      identities the player holds:
 *
 *          FROM unnest($worlds) AS w(id) JOIN player_progress_items p ON p.scope = w.id
 *
 *      A forged world id is not in the FROM clause, so no filter is needed to
 *      exclude it and there is no filter to forget. This holds even if layer (1)
 *      fails completely — a custom-server writer that forgets the stamp still
 *      moves nothing, which `leaderboard.test.ts` case 2 is exactly about.
 *
 *   3. **The content ceiling.** Where a forged row DOES collide with a platform
 *      identity, `LEAST(n, ceiling)` bounds it at the number the content itself
 *      allows. This is §9's "bounded, survivable failure" expressed as a number,
 *      and it is load-bearing: §9's argument assumes a forger is limited to real
 *      identities, and `/api/game/progress` does not limit them to any such
 *      thing — it accepts up to 4,000 keys per group of whatever text it likes.
 *
 * ── What is deliberately not here ──────────────────────────────────────────
 *
 * §9 also lists viewpoints, wings, bodies surveyed and elements assayed. Their
 * rosters are learned per world and `ProgressSync` deliberately keeps elements
 * and wing rosters LOCAL, so the server cannot state their maximum — and a set
 * whose maximum the server cannot state is, from the server's side, exactly the
 * unbounded thing §9 refused. They are declared below with `ceiling: null` and
 * refused at read, so the plumbing is ready the day a roster is published and
 * nothing ranks on a ceiling nobody measured.
 */

/** Any pg client — a plain Client in tests, a pooled one in a route. */
type Db = Client | PoolClient;

/**
 * The eighteen worlds. This is the counted domain for every world-keyed board.
 *
 * Authored here rather than imported because `site/` is a separate Next app that
 * does not import the game's ES modules. The drift that costs is one-directional
 * and safe: a world missing from this list is never counted, so the board
 * UNDER-counts and never over-counts. `leaderboard.test.ts` checks the list
 * against `src/main.js`'s registrations and the planet descriptors rather than
 * trusting it — which is not ceremony: `Volcanic.js` publishes `id: 'cinder'`,
 * so a list derived from filenames would already be wrong on its first planet.
 */
export const PLATFORM_WORLDS: readonly string[] = Object.freeze([
  /* Registered in src/main.js, in registration order. */
  'station', 'medieval', 'sports', 'citadel', 'race', 'maze', 'dock', 'space',
  /* The ten landable bodies of world 06, from src/worlds/planets/index.js. */
  'cinder', 'tessera', 'sirocco', 'shoal', 'vitrine', 'verdigris',
  'lathe', 'carnelian', 'sallow', 'cathedra',
]);

/**
 * The hard ceiling on relics in one world.
 *
 * Measured, not chosen: `Relics.js:58` sets `MAX_PER_WORLD = 110` and the
 * instanced meshes are allocated at exactly that count, so "a world that wanted
 * more relics than this would place them, count them, and draw only the first
 * hundred and ten". No honest player can pass it because the game cannot show
 * them a 111th. §9's "109 in citadel" sits just under it.
 */
export const RELIC_CEILING_PER_WORLD = 110;

/* ---------------------------------------------------------------------- */
/* The registry                                                            */
/* ---------------------------------------------------------------------- */

/** Where a category's identities live. No category reads a value column. */
export type BoardSource = 'items' | 'quests' | 'values';

/** Which column the platform manifest is enumerated against. */
export type ManifestDomain = 'world-scope' | 'world-key' | 'quest-catalogue' | 'none';

export interface CategorySpec {
  readonly id: string;
  readonly label: string;
  readonly source: BoardSource;
  /** Progress kind, for `source: 'items'`. */
  readonly kind: string;
  readonly domain: ManifestDomain;
  /**
   * The maximum a player can reach, fixed by content.
   *
   * A number for a per-scope ceiling (relics: 110 per world). `null` means the
   * server cannot state this set's maximum, and `readBoard` refuses it — see the
   * header. `'catalogue'` means it is counted live off the platform content
   * table rather than written down here.
   */
  readonly ceiling: number | null | 'catalogue';
  readonly why: string;
}

const cat = (spec: CategorySpec) => Object.freeze(spec);

/**
 * Every category this server will rank, and the ones it declares but refuses.
 *
 * Adding a row here is the only way to create a board, which is what keeps the
 * §9 rule in one readable place instead of spread across query sites.
 */
export const RANKABLE: Readonly<Record<string, CategorySpec>> = Object.freeze({
  relics: cat({
    id: 'relics', label: 'Relics recovered', source: 'items', kind: 'relic',
    domain: 'world-scope', ceiling: RELIC_CEILING_PER_WORLD,
    why: 'Identity-keyed, capped by content at 110 per world (Relics.js MAX_PER_WORLD).',
  }),
  charters: cat({
    id: 'charters', label: 'Charters restored', source: 'items', kind: 'charter',
    domain: 'world-key', ceiling: 1,
    why: 'The keys are world ids, so the manifest IS the ceiling: eighteen, once each.',
  }),
  quests: cat({
    id: 'quests', label: 'Quests completed', source: 'quests', kind: 'quest',
    domain: 'quest-catalogue', ceiling: 'catalogue',
    why: 'Capped by the platform quest catalogue. Forgeable, but only up to the cap (§9).',
  }),

  /* Declared, refused at read: §9 lists these, and the server cannot state what
   * "all of them" is. See the header. */
  viewpoints: cat({
    id: 'viewpoints', label: 'Viewpoints synced', source: 'items', kind: 'viewpoint',
    domain: 'world-scope', ceiling: null,
    why: 'No server-side per-world roster. MAX_TRAVEL_ROWS is a menu allocation, not a content count — Viewpoints.js says so itself.',
  }),
  wings: cat({
    id: 'wings', label: 'Wings broken', source: 'items', kind: 'wing',
    domain: 'none', ceiling: null,
    why: 'The wing roster is learned per visit and ProgressSync deliberately keeps it local.',
  }),
});

/**
 * What §9 refuses to rank, and why — recorded so it is not re-litigated.
 *
 * These ids are NOT in `RANKABLE`, so `rankableCategory` returns null for them
 * and no board can be built. The map exists to answer "why not?" in the one
 * place someone will look.
 */
export const REFUSED: Readonly<Record<string, string>> = Object.freeze({
  credits:
    'Bounded per event, unbounded in aggregate. A credit board ranks whoever forged most patiently — the economy design reached this independently.',
  weekly_credits: 'Same as credits. Roadmap §5.6 asked for it; Phase 3 §9 refuses it.',
  race:
    'A client clock with unbounded improvement. Race pickups pay on DNF, so the run need not even finish.',
  trial:
    'A client clock, and trial PBs are editable localStorage. A forged time is not merely early, it is unreachable.',
  kills: 'Respawning source; unbounded.',
  ore: 'Respawning source; unbounded.',
  survival_wave: 'A count from a respawning source. Same shape as kills.',
});

/** The spec for a category, or null if this server will not rank it. */
export function rankableCategory(id: string): CategorySpec | null {
  return (Object.prototype.hasOwnProperty.call(RANKABLE, id) && RANKABLE[id]) || null;
}

/* ---------------------------------------------------------------------- */
/* Scope                                                                   */
/* ---------------------------------------------------------------------- */

/**
 * Which board. `serverId: null` is the global one.
 *
 * A required argument with no default, deliberately. There is no `readBoard(db,
 * category)` overload that quietly means "global", because that overload is how
 * a scope gets forgotten.
 */
export interface BoardScope {
  readonly serverId: string | null;
}

/** The global board. Named so a caller states it rather than omitting it. */
export const GLOBAL: BoardScope = Object.freeze({ serverId: null });

/**
 * The world manifest a board enumerates.
 *
 * One function, so the day a custom server has worlds of its own there is one
 * place to teach and not a scatter of query sites. Today every board enumerates
 * the platform worlds, which for a server board is D2's "that server's items *in
 * addition to* defaults" minus the server's own — under-counting, which is the
 * safe direction, and academic while the route serves no server board.
 */
function manifestFor(_scope: BoardScope): readonly string[] {
  return PLATFORM_WORLDS;
}

/* ---------------------------------------------------------------------- */
/* Schema                                                                  */
/* ---------------------------------------------------------------------- */

let schemaPromise: Promise<void> | null = null;

/**
 * Additive, idempotent, and run before `custom_servers` exists on purpose.
 *
 * `server_id` is NULL for platform progress, which is every row today. Adding it
 * now is what removes the future edit: by the time Phase 7 has somewhere to
 * write a non-NULL value, the boards that must not see it are already scoped and
 * already tested.
 *
 * The promise is memoised, not a boolean, so concurrent lambdas wait for the DDL
 * instead of racing past it into a missing column. Memoising across connections
 * is correct because the DDL is a property of the DATABASE, not of the client
 * that ran it; a rejection clears the memo so a transient failure is not cached
 * for the life of the process.
 */
export function ensureLeaderboardSchema(db: Db): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = runLeaderboardSchema(db).catch((err) => {
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}

async function runLeaderboardSchema(db: Db): Promise<void> {
  // The boards read the progress ledger, so its tables must exist first.
  await ensureProgressSchema(db);

  await db.query(`ALTER TABLE player_progress_items ADD COLUMN IF NOT EXISTS server_id TEXT`);
  await db.query(`ALTER TABLE player_progress_values ADD COLUMN IF NOT EXISTS server_id TEXT`);
  // Partial on the global partition: it is the one every board reads and the one
  // that must stay fast as the ledger grows.
  await db.query(`
    CREATE INDEX IF NOT EXISTS player_progress_items_board_idx
      ON player_progress_items (kind, scope, player_id)
      WHERE server_id IS NULL
  `);

  /* `quests` and `player_quest_engagements` are seeded by the admin app and may
   * not exist in a fresh database. Guarded rather than fatal, exactly as
   * `playerDb.runQuestSchema` guards the same tables — and a missing column here
   * fails the quest board closed (an error, no score), never open. */
  await db.query(`ALTER TABLE quests ADD COLUMN IF NOT EXISTS server_id TEXT`).catch(() => {});
  await db
    .query(`ALTER TABLE player_quest_engagements ADD COLUMN IF NOT EXISTS server_id TEXT`)
    .catch(() => {});
}

/* ---------------------------------------------------------------------- */
/* Reading a board                                                         */
/* ---------------------------------------------------------------------- */

export interface BoardEntry {
  /** Internal id. The route does not put this on the wire for other players. */
  playerId: string;
  handle: string | null;
  score: number;
  rank: number;
  self: boolean;
}

export interface BoardResult {
  category: string;
  label: string;
  scope: BoardScope;
  /** The maximum this board can show. §9's rule, as a number. */
  ceiling: number;
  entries: BoardEntry[];
}

export type BoardRefusal = 'unknown_category' | 'no_ceiling';

export type BoardOutcome =
  | { ok: true; board: BoardResult }
  | { ok: false; reason: BoardRefusal };

export interface BoardOptions {
  /** How many ranked players to return. Clamped to 1..100. */
  limit: number;
  /** The caller, whose own row is always included even outside the slice. */
  playerId: string;
}

/**
 * Wrap a per-player score SELECT in ranking, naming and the caller's own row.
 *
 * The inner query must yield `(player_id, score)`. `$limit` and `$me` are the
 * two parameters after whatever the inner query used, so each category can bind
 * exactly the parameters it needs and no more — Postgres refuses a query with a
 * parameter it cannot type, so an unused shared slot is not an option.
 */
function ranked(inner: string, nextIndex: number): string {
  const lim = `$${nextIndex}`;
  const me = `$${nextIndex + 1}`;
  return `
    WITH scores AS (${inner}),
    ranked AS (
      SELECT player_id, score, RANK() OVER (ORDER BY score DESC) AS rank
        FROM scores
       WHERE score > 0
    )
    SELECT r.player_id, r.score, r.rank, pl.handle
      FROM ranked r
      LEFT JOIN players pl ON pl.id = r.player_id
     WHERE r.rank <= ${lim} OR r.player_id = ${me}
     ORDER BY r.rank, r.player_id
  `;
}

/**
 * A world-scoped identity set: relics today.
 *
 * The manifest is the FROM clause. `unnest($1)` enumerates the platform worlds
 * and the join reaches into the ledger from there, so a row in a world nobody
 * shipped is never a candidate. `LEAST(n, $3)` is the content ceiling, applied
 * per world because that is where the content caps it.
 */
const WORLD_SCOPE_SCORES = `
  SELECT t.player_id, SUM(LEAST(t.n, $3::bigint))::int AS score
    FROM (
      SELECT p.player_id, p.scope, COUNT(*) AS n
        FROM unnest($1::text[]) AS w(id)
        JOIN player_progress_items p
          ON p.scope = w.id
         AND p.kind = $2
         AND p.server_id IS NOT DISTINCT FROM $4
       GROUP BY p.player_id, p.scope
    ) t
   GROUP BY t.player_id
`;

/**
 * A set whose KEYS are world ids: charters.
 *
 * Same manifest enumeration, one column over. No ceiling constant is needed: the
 * ledger's `UNIQUE (player_id, kind, scope, item_key)` allows one row per world
 * and the manifest holds eighteen, so eighteen is the maximum by construction.
 */
const WORLD_KEY_SCORES = `
  SELECT p.player_id, COUNT(*)::int AS score
    FROM unnest($1::text[]) AS w(id)
    JOIN player_progress_items p
      ON p.item_key = w.id
     AND p.kind = $2
     AND p.scope = ''
     AND p.server_id IS NOT DISTINCT FROM $3
   GROUP BY p.player_id
`;

/**
 * Quests completed, counted off the platform catalogue.
 *
 * Three guards, doing three different jobs.
 *
 *   - `q.world` joined to the world manifest, exactly as the relic board does
 *     it. An owner-authored quest set in a vanity world is not in the counted
 *     domain, so it is excluded WITHOUT depending on any stamp. Every platform
 *     quest is authored for a platform world, so this can never clip one.
 *   - `e.server_id` decides WHICH board a completion lands on. Everything earned
 *     inside a custom server accrues to that server, which is Phase 7's rule
 *     verbatim — including a PLATFORM quest completed there, because D2 gives a
 *     member the platform catalogue *in addition to* the owner's.
 *   - `q.server_id` is the global board's extra refusal: an owner-authored quest
 *     never counts globally even if the engagement stamp is forgotten. A
 *     server's own board is welcome to its owner's quests, which is the point
 *     of D2.
 *
 * An engagement whose quest row was deleted has `quest_id` NULL (ON DELETE SET
 * NULL) and does not join, so the count fails closed.
 *
 * The one guarantee here that rests on a writer rather than on the shape of the
 * query: a quest authored by an owner INTO A PLATFORM WORLD with `server_id`
 * left NULL is, by every column this table has, a platform quest. Phase 7c's
 * owner CRUD must stamp it. That is a genuinely different position from the
 * world-keyed boards, where a forged identity is invisible whatever the writer
 * does, and it is recorded rather than papered over.
 */
const QUEST_SCORES = `
  SELECT e.player_id, COUNT(DISTINCT q.id)::int AS score
    FROM unnest($1::text[]) AS w(id)
    JOIN quests q
      ON q.world = w.id
    JOIN player_quest_engagements e
      ON e.quest_id = q.id
     AND e.status = 'completed'
     AND e.server_id IS NOT DISTINCT FROM $2::text
   WHERE $2::text IS NOT NULL OR q.server_id IS NULL
   GROUP BY e.player_id
`;

/** The same countable set as `QUEST_SCORES`, so the two cannot disagree. */
const QUEST_CEILING = `
  SELECT COUNT(*)::int AS n
    FROM unnest($1::text[]) AS w(id)
    JOIN quests q ON q.world = w.id
   WHERE $2::text IS NOT NULL OR q.server_id IS NULL
`;

interface ScoreRow {
  player_id: string;
  score: number | string;
  rank: number | string;
  handle: string | null;
}

/**
 * One board, derived. Never reads a submitted figure and never writes anything.
 */
export async function readBoard(
  db: Db,
  categoryId: string,
  scope: BoardScope,
  opts: BoardOptions
): Promise<BoardOutcome> {
  const spec = rankableCategory(categoryId);
  if (!spec) return { ok: false, reason: 'unknown_category' };
  if (spec.ceiling === null) return { ok: false, reason: 'no_ceiling' };

  const limit = Math.max(1, Math.min(100, Math.trunc(opts.limit) || 1));
  const me = opts.playerId;
  const worlds = [...manifestFor(scope)];

  let sql: string;
  let params: unknown[];
  let ceiling: number;

  switch (spec.domain) {
    case 'world-scope':
      sql = ranked(WORLD_SCOPE_SCORES, 5);
      params = [worlds, spec.kind, spec.ceiling as number, scope.serverId, limit, me];
      ceiling = (spec.ceiling as number) * worlds.length;
      break;

    case 'world-key':
      sql = ranked(WORLD_KEY_SCORES, 4);
      params = [worlds, spec.kind, scope.serverId, limit, me];
      ceiling = (spec.ceiling as number) * worlds.length;
      break;

    case 'quest-catalogue': {
      sql = ranked(QUEST_SCORES, 3);
      params = [worlds, scope.serverId, limit, me];
      // Counted live off the catalogue: a quest authored tomorrow raises the
      // ceiling without an edit here, which is the arrangement Charters.js
      // argues for ("no count in this file is a constant").
      const total = await db.query(QUEST_CEILING, [worlds, scope.serverId]);
      ceiling = Number(total.rows[0]?.n ?? 0);
      break;
    }

    /* `domain: 'none'` and anything added later. Refused rather than counted:
     * a domain with no manifest has nothing to enumerate, and the failure mode
     * of guessing here is a board that counts forged identities. Fails closed. */
    default:
      return { ok: false, reason: 'no_ceiling' };
  }

  const r = await db.query(sql, params);
  const entries: BoardEntry[] = (r.rows as ScoreRow[]).map((row) => ({
    playerId: String(row.player_id),
    handle: row.handle ?? null,
    score: Number(row.score),
    rank: Number(row.rank),
    self: String(row.player_id) === me,
  }));

  return {
    ok: true,
    board: { category: spec.id, label: spec.label, scope, ceiling, entries },
  };
}

/** Every board a caller may ask for, with the refusals left out. */
export function openBoards(): CategorySpec[] {
  return Object.values(RANKABLE).filter((s) => s.ceiling !== null);
}
