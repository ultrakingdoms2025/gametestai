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
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE ONE EXCEPTION: TIMES, INSIDE A CUSTOM SERVER, WITH A FLOOR
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Everything above stands. `REFUSED.race` and `REFUSED.trial` are unchanged,
 * `rankableCategory('race')` still answers null, and no global board ranks a
 * time. What is added below is a set of boards that exist ONLY inside a custom
 * server, and the argument for them is not that §9 was wrong. It is that §9's
 * own test — "is the forger's advantage bounded?" — has a different answer here
 * for two separate reasons, and both had to hold before a single row was
 * ranked.
 *
 * ── 1. The floor makes a forged time bounded, which was §9's whole test ───
 *
 * §9 permits a board where "a forger merely arrives sooner at a ceiling
 * everyone shares — a bounded, survivable failure", and refuses times because
 * "a time has no ceiling, so a forger's advantage on one is unbounded". A time
 * has no ceiling. It does have a FLOOR, and a floor bounds a forgery in exactly
 * the same way a ceiling does: a claim below the floor is not merely early, it
 * is impossible, so it is dropped rather than ranked, and the best available
 * forgery is a fixed distance from the best available truth.
 *
 * That distance is not hand-waved. `timeFloorMs` divides the circuit's real
 * measured length by the fastest speed the game's own tuning permits anything
 * to travel — see `SPEED_CEILING_MPS`, which is derived from four constants in
 * the game source and not chosen. On Vellum at CONTENDER the floor is 86.4 s
 * against a best measured clean lap set of 220.3 s
 * (`scripts/tests/race-pace.test.mjs` measures the laps), so a perfect forgery
 * beats a perfect run by a factor of 2.5 and can never beat it by more. Bounded
 * — which is the property §9 asked for — and stated as a number.
 *
 * ── 2. Forty members are an accountability a global board cannot have ─────
 *
 * A global board is strangers. A custom server is a room of people who invited
 * each other, whose owner can remove a member, and whose chat log sits beside
 * the board. A time that beats the field by a factor of two in that room is
 * read by forty people who know whether it happened. The bound in (1) is what
 * makes the residual small; this is what makes the residual somebody's problem
 * rather than nobody's.
 *
 * Neither argument transfers to the global board, which is why these boards
 * appear in `openBoards` only under a server scope and `readBoard` refuses them
 * outright with `serverId: null`. There is no flag to flip and no configuration
 * that widens them: the refusal is a branch on the scope, in the reader.
 *
 * ── What is still refused, and why the list did not simply grow ───────────
 *
 * TRIAL times are NOT ranked, here or anywhere, and the reason is the floor
 * rather than the clock. A trial venue is published by a world at build time,
 * the roster is learned per visit, and the venues are not even the same KIND of
 * contest — `DroneHack` and `TestFire` have no route to measure. The server
 * cannot state the minimum possible time for a venue it has never heard of, and
 * a "floor" of zero is not a floor. That is the same refusal `viewpoints` gets
 * one paragraph up, applied to the other end of the number line: a bound the
 * server cannot compute is a bound that does not exist.
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
export type ManifestDomain =
  | 'world-scope'
  | 'world-key'
  | 'quest-catalogue'
  /** One circuit at one grade, ranked ascending among a server's members. */
  | 'server-time'
  | 'none';

export interface CategorySpec {
  readonly id: string;
  readonly label: string;
  readonly source: BoardSource;
  /** Progress kind, for `source: 'items'`. */
  readonly kind: string;
  readonly domain: ManifestDomain;
  /**
   * True for a board that has no global form at all.
   *
   * Read by `openBoards` (which never advertises one outside a server) AND by
   * `readBoard` (which refuses one outside a server). Two independent checks on
   * purpose: the advertisement is a convenience and the refusal is the gate, so
   * a client that guesses an id it was never offered still gets nothing.
   */
  readonly serverOnly?: boolean;
  /** Ledger scope for a `server-time` board: the world id. */
  readonly scope?: string;
  /** Ledger item key for a `server-time` board: `circuitId/difficulty`. */
  readonly itemKey?: string;
  /**
   * The fastest time this board will admit, in milliseconds. A stored value
   * below it is DROPPED — never ranked, never shown, never corrected to the
   * floor. See `timeFloorMs`.
   */
  readonly floorMs?: number;
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
    'Not ranked globally: a client clock with unbounded improvement, and race pickups pay on DNF so '
    + 'the run need not even finish. Inside a custom server the same times ARE ranked, per circuit and '
    + 'grade, because a floor derived from the track length bounds a forgery and forty members can see it.',
  trial:
    'A client clock, and trial PBs are editable localStorage. Not ranked anywhere, global or scoped: a '
    + 'venue roster is learned per visit and half the venues are not races at all, so the server cannot '
    + 'state the minimum possible time — and a time board with no floor is the unbounded thing §9 refused.',
  kills: 'Respawning source; unbounded.',
  ore: 'Respawning source; unbounded.',
  survival_wave: 'A count from a respawning source. Same shape as kills.',
});

/** The spec for a category, or null if this server will not rank it. */
export function rankableCategory(id: string): CategorySpec | null {
  return (Object.prototype.hasOwnProperty.call(RANKABLE, id) && RANKABLE[id]) || null;
}

/* ---------------------------------------------------------------------- */
/* Server-scoped time boards, and the floor that makes them admissible     */
/* ---------------------------------------------------------------------- */

/**
 * The four constants the speed ceiling is built out of, each with the file it
 * comes from. `leaderboard.test.ts` reads all four back out of the game source
 * and fails if any has moved, because the floor is only a bound while these
 * are the real numbers.
 */
export const SPEED_SOURCES = Object.freeze({
  /** `src/race/RacerAI.js` — `REF_TOP`, the rival pace reference, m/s. */
  refTopMps: 33.5,
  /** `src/race/RacerAI.js` — `DIFFICULTIES.expert.pace`, the fastest band. */
  apexPace: 1.20,
  /** `src/race/RacerAI.js` — `DIFFICULTIES.expert.spread`, its envelope. */
  apexSpread: 0.07,
  /** `src/mounts/Car.js` — `BOOST_SPEED`, the quickest player machine, m/s. */
  carBoostMps: 34,
  /** `src/systems/ItemDefs.js` — `MOUNT_POWER_TIERS`, the top Speed tier. */
  mountPowerTiers: 3,
  /** `src/mounts/Car.js` — `_powerMul = 1 + power * 0.12`, per-tier gain. */
  powerPerTier: 0.12,
  /** `src/systems/ItemDefs.js` — `speed_boost_100`, "temporarily doubles". */
  maxSpeedPotion: 2,
});

/**
 * The fastest anything in this game can travel in a straight line, m/s.
 *
 * ── Why this is a MAXIMUM over two candidates and not one number ─────────
 *
 * The obvious candidate is the tuned rival envelope: `REF_TOP * pace *
 * (1 + spread)` at APEX, which is 33.5 × 1.20 × 1.07 = 43.014 m/s. That is the
 * quickest thing `RacerAI` will ever put on the road, and using it alone gives
 * a floor 18-25% under the best lap anybody has measured — a beautifully tight
 * bound.
 *
 * It is also WRONG, in the one direction a floor must never be wrong. The
 * player's car tops out at `BOOST_SPEED` 34 m/s stock, `_powerMul` multiplies
 * that by `1 + tiers * 0.12` (1.36 at the third and last Speed tier), and a
 * Velocity Crown multiplies it AGAIN by 2 for as long as the player keeps
 * drinking them — `MountManager` feeds `player.speedMultiplier` straight into
 * `Car._buffMul` with nothing in a race that turns it off. 34 × 1.36 × 2 =
 * 92.48 m/s. A floor built on 43.014 would delete the record of a player who
 * had bought the fittings and used the consumable the shop sells them, which is
 * a real run destroyed to catch a forgery — the exact trade `progressLedger`'s
 * whole header refuses to make.
 *
 * So the ceiling is the larger, and the cost is stated rather than hidden: the
 * floor is roughly 2.5x under a strong real time instead of 1.2x. Bounded is
 * the property §9 asked for. Tight was never the property.
 *
 * The assumption inside the number is deliberately the generous one — that the
 * doubling potion is held for the entire race, which its duration does not
 * actually allow. A bound is allowed to assume the impossible in the direction
 * that admits more real runs. It is not allowed to assume it in the other.
 */
export const SPEED_CEILING_MPS = Math.max(
  SPEED_SOURCES.refTopMps * SPEED_SOURCES.apexPace * (1 + SPEED_SOURCES.apexSpread),
  SPEED_SOURCES.carBoostMps
    * (1 + SPEED_SOURCES.mountPowerTiers * SPEED_SOURCES.powerPerTier)
    * SPEED_SOURCES.maxSpeedPotion
);

export interface RaceTrack {
  readonly id: string;
  readonly name: string;
  /** World id the ledger scopes these times under. */
  readonly world: string;
  /** Centreline length in metres, measured off the real `RaceCourse`. */
  readonly metres: number;
  readonly laps: Readonly<Record<string, number>>;
}

/**
 * The circuits, their measured lengths and their lap counts.
 *
 * Authored here for the same reason `PLATFORM_WORLDS` is: `site/` is a separate
 * Next app that does not import the game's ES modules. `metres` is not a design
 * figure — it is `new RaceCourse(worldControls(def), …).length` for the real
 * definition, and `leaderboard.test.ts` rebuilds all three and compares, so a
 * control point moved in `RaceCircuits.js` fails this file rather than quietly
 * lowering a floor.
 *
 * The drift that survives that test is one-directional and safe. The centreline
 * is the ROAD's length; a racing line clips the inside of a corner and is
 * marginally shorter, and Aurora's vertical loop is geometry the car climbs
 * over that the centreline does not measure at all. Both make the true distance
 * differ from `metres` — the first downwards by a fraction of a percent over
 * 20 m minimum-radius corners, the second upwards. Against 150% of headroom in
 * `SPEED_CEILING_MPS`, neither moves the verdict.
 */
export const RACE_TRACKS: readonly RaceTrack[] = Object.freeze([
  Object.freeze({
    id: 'vellum', name: 'Vellum Ridge Circuit', world: 'race',
    metres: 1598.9648, laps: Object.freeze({ easy: 3, standard: 5, expert: 10 }),
  }),
  Object.freeze({
    id: 'cinder', name: 'Cinder Gorge', world: 'race',
    metres: 1295.4912, laps: Object.freeze({ easy: 3, standard: 6, expert: 11 }),
  }),
  Object.freeze({
    id: 'aurora', name: 'Aurora Rise', world: 'race',
    metres: 1220.0744, laps: Object.freeze({ easy: 3, standard: 6, expert: 11 }),
  }),
]);

/** `RacerAI.DIFFICULTIES` grade ids, with the labels the game shows. */
export const RACE_GRADES: Readonly<Record<string, string>> = Object.freeze({
  easy: 'ROOKIE',
  standard: 'CONTENDER',
  expert: 'APEX',
});

/**
 * The fastest time a run over `metres * laps` could possibly take, in whole ms.
 *
 * `Math.floor`, and the comparison downstream is `>=`, so the floor itself is
 * admitted. Rounding the other way would reject a time by one millisecond for
 * no reason anybody could reconstruct.
 */
export function timeFloorMs(metres: number, laps: number): number {
  return Math.floor((metres * laps * 1000) / SPEED_CEILING_MPS);
}

/** `race_time.<world>.<circuit>.<grade>` — the id a client passes back. */
export function raceTimeBoardId(world: string, circuitId: string, grade: string): string {
  return `race_time.${world}.${circuitId}.${grade}`;
}

function buildTimeBoards(): Record<string, CategorySpec> {
  const out: Record<string, CategorySpec> = {};
  for (const track of RACE_TRACKS) {
    for (const grade of Object.keys(RACE_GRADES)) {
      const laps = track.laps[grade];
      if (!(laps > 0)) continue;
      const id = raceTimeBoardId(track.world, track.id, grade);
      out[id] = cat({
        id,
        label: `${track.name} · ${RACE_GRADES[grade]}`,
        source: 'values',
        /* The ledger kind `ProgressSync` already posts: `val('race', world,
         * circuitId/difficulty, ms)`. Nothing new is written for these boards
         * and nothing new is asked of the client — every one of these times has
         * been in `player_progress_values` since the mission drop. */
        kind: 'race',
        domain: 'server-time',
        serverOnly: true,
        scope: track.world,
        itemKey: `${track.id}/${grade}`,
        floorMs: timeFloorMs(track.metres, laps),
        /* A time board has no ceiling and never will. `null` here is what makes
         * `readBoard`'s generic "no ceiling, refuse" branch unreachable for it —
         * the `server-time` case is handled before that test, and the test that
         * follows still protects every other domain. */
        ceiling: null,
        why: `${laps} laps of ${Math.round(track.metres)} m. Times under `
          + `${timeFloorMs(track.metres, laps)} ms are physically impossible and are dropped.`,
      });
    }
  }
  return out;
}

/**
 * Every server-scoped time board, by id.
 *
 * Deliberately a SECOND registry rather than more rows in `RANKABLE`. That
 * separation is not tidiness: `leaderboard.test.ts` asserts that no member of
 * `RANKABLE` has `source: 'values'` — "a value is a number a device sent, and
 * §9's refusal of times is exactly a refusal to rank one" — and that assertion
 * must keep meaning what it says. A global board still ranks no number a client
 * chose. These are the boards that do, and they are somewhere else, under a
 * scope check, with a floor.
 */
export const SERVER_TIME_BOARDS: Readonly<Record<string, CategorySpec>> =
  Object.freeze(buildTimeBoards());

/**
 * The spec for any board id, given the scope it was asked for.
 *
 * `rankableCategory` is left alone and still answers only for the global
 * registry, because the test that pins §9's refusals calls it and its answer is
 * the thing being pinned. This is the resolver `readBoard` uses.
 */
export function boardSpec(id: string, scope: BoardScope): CategorySpec | null {
  const global = rankableCategory(id);
  if (global) return global;
  if (!scope?.serverId) return null;
  return (
    (Object.prototype.hasOwnProperty.call(SERVER_TIME_BOARDS, id) && SERVER_TIME_BOARDS[id]) || null
  );
}

/** True for an id that only ever exists inside a server. Used by the route. */
export function isServerOnlyBoard(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(SERVER_TIME_BOARDS, id);
}

/**
 * `M:SS.mmm`, from whole milliseconds.
 *
 * The wire carries this string in `score` for a time board, and the raw integer
 * in `ms` beside it. That is not a cosmetic choice: `RecordsPanel` renders
 * `${e.score}` for every board it is offered, so a board whose score is a
 * millisecond count reads as "220338" on the standings sheet. Formatting on the
 * server is what lets a new category appear in-game with no client change,
 * which is the same reasoning that put the refusal REASONS on the wire rather
 * than in the client.
 */
export function formatRaceTime(ms: number): string {
  const whole = Math.max(0, Math.trunc(ms));
  const minutes = Math.floor(whole / 60000);
  const seconds = Math.floor((whole % 60000) / 1000);
  const millis = whole % 1000;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
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
  /**
   * The maximum this board can show. §9's rule, as a number.
   *
   * `null` for a time board, which has no maximum and never will — the bound
   * that makes one admissible is `floorMs`, at the other end. Nullable rather
   * than zero so a reader cannot mistake "unbounded above" for "nothing to
   * score".
   */
  ceiling: number | null;
  /** The fastest time this board admits, ms. Null for a counting board. */
  floorMs: number | null;
  /** How to read `score`: a tally, or a formatted time. */
  unit: 'count' | 'time';
  entries: BoardEntry[];
}

export type BoardRefusal = 'unknown_category' | 'no_ceiling' | 'server_only';

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
 *
 * `dir` is which way "better" runs. Counting boards rank the largest first; a
 * time board ranks the smallest first, and it is a parameter of this function
 * rather than a second copy of the wrapper because everything else about
 * ranking — the tie rule, the caller's own row, the join to `players` — is
 * identical and a second copy would drift. It is an enum, not a string spliced
 * from a caller, so no request can reach the SQL text.
 */
function ranked(inner: string, nextIndex: number, dir: 'desc' | 'asc' = 'desc'): string {
  const lim = `$${nextIndex}`;
  const me = `$${nextIndex + 1}`;
  const order = dir === 'asc' ? 'ASC' : 'DESC';
  return `
    WITH scores AS (${inner}),
    ranked AS (
      SELECT player_id, score, RANK() OVER (ORDER BY score ${order}) AS rank
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

/**
 * One circuit at one grade, among the approved members of one server.
 *
 * Three things this query is doing that are each load-bearing.
 *
 *   - **`server_members` is the FROM clause**, exactly as the world manifest is
 *     the FROM clause of the relic board. A player who is not an approved member
 *     of this server is not a candidate row, so there is no membership filter to
 *     forget and no way for a stranger's time to appear on a private board.
 *     `state = 'approved'` and not merely "has a row": an invited or removed
 *     member is in `server_members` too.
 *
 *   - **`v.value >= $5` is the floor**, applied in the WHERE and not afterwards
 *     in JavaScript. A time below the physically possible is never selected, so
 *     it cannot be ranked, cannot be counted, and cannot appear as the caller's
 *     own row through the `OR r.player_id = $me` clause in `ranked`. It is also
 *     not corrected upward to the floor: an impossible claim is dropped, and
 *     rewriting it would be the server inventing a time nobody drove.
 *
 *   - **`server_id` is NOT consulted on the value row.** These times were
 *     recorded against the PLATFORM circuits — `ProgressSync` has been posting
 *     them since long before custom servers existed and stamps nothing — so a
 *     board that required a stamp would be permanently empty. The scope of this
 *     board is who may see it and who may be on it, both of which come from
 *     membership. The identity being ranked is a platform circuit at a platform
 *     grade, enumerated by `RACE_TRACKS`, so the forged-identity hole the global
 *     boards close by construction does not open here either: an owner cannot
 *     author `vellum/standard`, it already exists.
 */
const SERVER_TIME_SCORES = `
  SELECT v.player_id, v.value AS score
    FROM server_members m
    JOIN player_progress_values v
      ON v.player_id = m.player_id
   WHERE m.server_id = $1
     AND m.state = 'approved'
     AND v.kind = $2
     AND v.scope = $3
     AND v.item_key = $4
     AND v.value >= $5::bigint
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
  const spec = boardSpec(categoryId, scope);
  /* The gate, and it is a gate rather than an advertisement. A caller that
   * guesses a server-only id while unscoped is refused here even though
   * `openBoards` never offered it — `boardSpec` returns null for one without a
   * server, so this is `unknown_category`; the explicit `server_only` refusal
   * below is for the case where the id resolved but the scope did not. */
  if (!spec) {
    return {
      ok: false,
      reason: isServerOnlyBoard(categoryId) ? 'server_only' : 'unknown_category',
    };
  }
  if (spec.serverOnly && !scope?.serverId) return { ok: false, reason: 'server_only' };

  const limit = Math.max(1, Math.min(100, Math.trunc(opts.limit) || 1));
  const me = opts.playerId;
  const worlds = [...manifestFor(scope)];

  /* A time board is handled BEFORE the no-ceiling refusal, because it is the
   * one board whose `ceiling: null` is a statement of fact rather than a
   * declaration that the server cannot rank it. Every other domain still falls
   * through to that test, which is what keeps `viewpoints` and `wings` refused.
   */
  if (spec.domain === 'server-time') {
    const floorMs = Number(spec.floorMs);
    /* A time board with no floor is not a time board this server will read. It
     * cannot happen from `buildTimeBoards`, which computes one for every entry;
     * it is checked anyway because the ONLY thing making a ranked time
     * admissible at all is that number, and a silent zero would rank a claim of
     * one millisecond. Fails closed. */
    if (!Number.isFinite(floorMs) || floorMs <= 0) return { ok: false, reason: 'no_ceiling' };

    const r = await db.query(ranked(SERVER_TIME_SCORES, 6, 'asc'), [
      scope.serverId, spec.kind, spec.scope ?? '', spec.itemKey ?? '', floorMs, limit, me,
    ]);
    return {
      ok: true,
      board: {
        category: spec.id,
        label: spec.label,
        scope,
        ceiling: null,
        floorMs,
        unit: 'time',
        entries: (r.rows as ScoreRow[]).map((row) => ({
          playerId: String(row.player_id),
          handle: row.handle ?? null,
          score: Number(row.score),
          rank: Number(row.rank),
          self: String(row.player_id) === me,
        })),
      },
    };
  }

  if (spec.ceiling === null) return { ok: false, reason: 'no_ceiling' };

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
    board: { category: spec.id, label: spec.label, scope, ceiling, floorMs: null, unit: 'count', entries },
  };
}

/**
 * Every board a caller may ask for in this scope, with the refusals left out.
 *
 * The scope argument is what keeps the time boards out of a global index. It
 * defaults to `GLOBAL` rather than being required, because the default is the
 * NARROWER answer: a caller that forgets to pass a scope advertises fewer
 * boards, never more. That is the opposite of `BoardScope`'s own rule about
 * required arguments, and deliberately so — there the risk was reading a global
 * board when a server one was meant, here the risk is offering a server board
 * to somebody with no server.
 */
export function openBoards(scope: BoardScope = GLOBAL): CategorySpec[] {
  const global = Object.values(RANKABLE).filter((s) => s.ceiling !== null);
  if (!scope?.serverId) return global;
  return [...global, ...Object.values(SERVER_TIME_BOARDS)];
}
