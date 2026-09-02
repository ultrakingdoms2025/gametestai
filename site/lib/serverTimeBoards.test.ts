import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import {
  RANKABLE,
  SERVER_TIME_BOARDS,
  SPEED_SOURCES,
  SPEED_CEILING_MPS,
  RACE_TRACKS,
  RACE_GRADES,
  timeFloorMs,
  raceTimeBoardId,
  formatRaceTime,
  boardSpec,
  isServerOnlyBoard,
  rankableCategory,
  openBoards,
  readBoard,
  ensureLeaderboardSchema,
  GLOBAL,
} from './leaderboard';
import { ensureCustomServerSchema } from './customServers';

/**
 * SERVER-SCOPED TIME BOARDS, AND THE FOUR CLAIMS THEY REST ON.
 *
 * §9 refuses to rank a time globally because "a time has no ceiling, so a
 * forger's advantage on one is unbounded". These boards exist because a time
 * has a FLOOR, and a floor bounds a forgery the same way a ceiling does. That
 * argument is only worth anything while all four of these hold, so all four are
 * gated here:
 *
 *   1. **The floor is derived, not chosen.** Track length comes off the real
 *      `RaceCourse`, lap counts off the real `CIRCUITS`, and the speed it is
 *      divided by comes out of four constants in the game source. The test
 *      rebuilds the courses and re-reads the constants rather than trusting the
 *      copies in `leaderboard.ts`.
 *
 *   2. **The floor cannot delete a real run.** The divisor must be at least the
 *      fastest speed any legal player machine can reach. A floor built on the
 *      rival envelope alone (43.014 m/s) is 18% under the best measured lap and
 *      beautifully tight — and would have dropped the record of anyone who had
 *      bought the Speed fittings the shop sells and drunk the potion beside
 *      them (34 × 1.36 × 2 = 92.48 m/s). Case 2 is the one that decides the
 *      number.
 *
 *   3. **They are invisible and unreachable outside a server.** Two checks,
 *      because the advertisement is a convenience and the refusal is the gate.
 *
 *   4. **The global refusals did not move.** `rankableCategory('race')` still
 *      answers null, `RANKABLE` still ranks no value column, and `REFUSED`
 *      still carries a reason for both times. Adding a scoped board must not
 *      quietly widen the global one.
 *
 * The database half runs against `aether_test`, with `beforeAll` refusing to
 * run anywhere else — the same isolation `leaderboard.test.ts` uses, and the
 * ...0018 player block, because vitest runs these files in parallel against one
 * database and every other suite has claimed a block of its own.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

function read(...parts: string[]): string {
  return readFileSync(join(root, ...parts), 'utf8').replace(/\r\n/g, '\n');
}

function testUrl(): string | null {
  if (process.env.POSTGRES_TEST_URL) return process.env.POSTGRES_TEST_URL;
  const envFile = join(here, '..', '.env.test.local');
  if (!existsSync(envFile)) return null;
  const line = readFileSync(envFile, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith('POSTGRES_TEST_URL='));
  if (!line) return null;
  return line.slice('POSTGRES_TEST_URL='.length).trim().replace(/^["']|["']$/g, '');
}

const URL_ = testUrl();
const suite = URL_ ? describe : describe.skip;

/* ====================================================================== */
/* 1. The floor is derived from the game, not authored here                */
/* ====================================================================== */

describe('the speed ceiling comes out of the game source', () => {
  it('reads REF_TOP and the APEX band off RacerAI.js', () => {
    const src = read('src', 'race', 'RacerAI.js');
    expect(src).toMatch(
      new RegExp(`const REF_TOP = ${SPEED_SOURCES.refTopMps}\\s*;`)
    );
    /* The `expert` row of DIFFICULTIES, pace and spread together, because the
     * envelope is the pair and reading one without the other would let the
     * other drift. */
    const apex = /expert:\s*\{\s*label:\s*'APEX',\s*pace:\s*([\d.]+),\s*spread:\s*([\d.]+)/.exec(src);
    expect(apex, 'DIFFICULTIES.expert no longer parses — the envelope is unpinned').toBeTruthy();
    expect(Number(apex![1])).toBe(SPEED_SOURCES.apexPace);
    expect(Number(apex![2])).toBe(SPEED_SOURCES.apexSpread);
  });

  it("reads the player car's top speed and its per-tier gain off Car.js", () => {
    const src = read('src', 'mounts', 'Car.js');
    expect(src).toMatch(new RegExp(`const BOOST_SPEED = ${SPEED_SOURCES.carBoostMps}\\s*;`));
    const power = /_powerMul = 1 \+ Math\.max\(0, power\) \* ([\d.]+)/.exec(src);
    expect(power, 'Car._powerMul no longer parses — the fittings gain is unpinned').toBeTruthy();
    expect(Number(power![1])).toBe(SPEED_SOURCES.powerPerTier);
  });

  it('reads the top Speed tier and the strongest potion off ItemDefs.js', () => {
    const src = read('src', 'systems', 'ItemDefs.js');
    expect(src).toMatch(
      new RegExp(`MOUNT_POWER_TIERS = ${SPEED_SOURCES.mountPowerTiers}\\s*;`)
    );
    /* `speed_boost_100` is the strongest one authored, and its own description
     * is the statement of what it does. A stronger potion added without
     * updating `SPEED_SOURCES` would raise the real maximum above the divisor,
     * which is the direction that deletes records. */
    expect(src).toMatch(/speed_boost_100:/);
    expect(src).toMatch(/Temporarily doubles movement speed/);
    expect(src).not.toMatch(/speed_boost_(1[2-9]\d|[2-9]\d\d)\b/);
  });

  it('divides by the FASTEST of the two candidates, not the prettier one', () => {
    const rivals = SPEED_SOURCES.refTopMps * SPEED_SOURCES.apexPace * (1 + SPEED_SOURCES.apexSpread);
    const player = SPEED_SOURCES.carBoostMps
      * (1 + SPEED_SOURCES.mountPowerTiers * SPEED_SOURCES.powerPerTier)
      * SPEED_SOURCES.maxSpeedPotion;
    expect(rivals).toBeCloseTo(43.014, 3);
    expect(player).toBeCloseTo(92.48, 6);
    expect(SPEED_CEILING_MPS).toBe(Math.max(rivals, player));

    /* THE PROPERTY THAT MATTERS, stated as an inequality rather than as a
     * number: no legal machine may exceed the divisor, because a floor a real
     * player can beat is a floor that deletes their record. */
    expect(SPEED_CEILING_MPS).toBeGreaterThanOrEqual(player);
    expect(SPEED_CEILING_MPS).toBeGreaterThanOrEqual(rivals);
  });
});

describe('the track table is the real geometry', () => {
  it('matches a rebuilt RaceCourse and the real lap counts', async () => {
    /* Built end to end out of production code, the way `race-pace.test.mjs`
     * builds it — same spacing, same verge, same terrain — because a length
     * copied from a comment is a length that stops being true silently. */
    const { RaceCourse } = await import('../../src/worlds/RaceTrack.js');
    const { CIRCUITS, baseTerrain, worldControls } = await import('../../src/worlds/RaceCircuits.js');

    expect(RACE_TRACKS).toHaveLength(CIRCUITS.length);
    for (const def of CIRCUITS as Array<Record<string, unknown>>) {
      const track = RACE_TRACKS.find((t) => t.id === def.id);
      expect(track, `no entry for circuit ${def.id}`).toBeTruthy();

      const course = new (RaceCourse as new (c: unknown, o: unknown) => { length: number })(
        (worldControls as (d: unknown) => unknown)(def),
        { spacing: 2, verge: 11, baseHeight: baseTerrain, maxBankDeg: 5, cornerWiden: 0.2 }
      );
      expect(track!.metres).toBeCloseTo(course.length, 3);
      expect(track!.name).toBe(def.name);
      expect(track!.laps).toEqual(def.laps);
    }
  });

  it('scopes every board under the world the ledger actually keys on', () => {
    /* `ProgressSync` posts `val('race', worldId, circuitId/difficulty, ms)` and
     * the circuits belong to RaceWorld. A board scoped to the wrong world would
     * simply be empty for ever, which reads as "nobody has raced". */
    const raceWorld = read('src', 'worlds', 'RaceWorld.js');
    expect(raceWorld).toMatch(/static id = 'race'/);
    for (const track of RACE_TRACKS) expect(track.world).toBe('race');
  });
});

describe('timeFloorMs', () => {
  it('is exactly distance over the ceiling, floored', () => {
    for (const track of RACE_TRACKS) {
      for (const [grade, laps] of Object.entries(track.laps)) {
        const want = Math.floor((track.metres * laps * 1000) / SPEED_CEILING_MPS);
        expect(timeFloorMs(track.metres, laps), `${track.id}/${grade}`).toBe(want);
      }
    }
  });

  it('implies an average speed no faster than the ceiling', () => {
    /* The floor read back the other way: a run AT the floor averaged exactly
     * the fastest speed anything in this game can travel, over a road with
     * corners in it. Anything quicker is not a good lap, it is not a lap. */
    for (const track of RACE_TRACKS) {
      const laps = track.laps.standard;
      const mps = (track.metres * laps) / (timeFloorMs(track.metres, laps) / 1000);
      expect(mps).toBeGreaterThanOrEqual(SPEED_CEILING_MPS);
    }
  });

  it('leaves every real measured lap comfortably above it', () => {
    /* The fastest clean laps `race-pace.test.mjs` measured, at the top power
     * tier on the quicker of the two mounts. Copied WITH their source named so
     * a reader can re-derive them; they are here to prove the floor sits under
     * reality by a wide margin, not to pin the pace suite's numbers. */
    const fastestLapSeconds: Record<string, number> = {
      vellum: 44.058333, cinder: 37.116667, aurora: 35.550000,
    };
    for (const track of RACE_TRACKS) {
      const lapFloor = timeFloorMs(track.metres, 1) / 1000;
      expect(lapFloor, `${track.id} floor is not below the fastest measured lap`)
        .toBeLessThan(fastestLapSeconds[track.id]);
    }
  });

  it('bounds a forgery, which is the whole §9 argument', () => {
    /* Vellum at CONTENDER: five laps of a 44.058 s best is 220.3 s and the
     * floor is 86.4 s, so the very best forgery available beats the very best
     * real run by a factor of 2.55 and can never beat it by more. A number, not
     * a hope — and the assertion is the BOUND rather than the ratio, so
     * tightening the floor later cannot fail this. */
    const vellum = RACE_TRACKS.find((t) => t.id === 'vellum')!;
    const floor = timeFloorMs(vellum.metres, vellum.laps.standard);
    const bestReal = 44.058333 * vellum.laps.standard * 1000;
    expect(floor).toBeGreaterThan(0);
    expect(bestReal / floor).toBeLessThan(3);
  });
});

/* ====================================================================== */
/* 2. The registry, the scoping, and the refusals that did not move        */
/* ====================================================================== */

describe('the registry', () => {
  it('publishes one board per circuit and grade', () => {
    const want = RACE_TRACKS.length * Object.keys(RACE_GRADES).length;
    expect(Object.keys(SERVER_TIME_BOARDS)).toHaveLength(want);
    for (const track of RACE_TRACKS) {
      for (const grade of Object.keys(RACE_GRADES)) {
        const spec = SERVER_TIME_BOARDS[raceTimeBoardId(track.world, track.id, grade)];
        expect(spec, `${track.id}/${grade} has no board`).toBeTruthy();
        expect(spec.itemKey).toBe(`${track.id}/${grade}`);
        expect(spec.scope).toBe(track.world);
        expect(spec.kind).toBe('race');
        expect(spec.serverOnly).toBe(true);
        expect(spec.floorMs).toBeGreaterThan(0);
      }
    }
  });

  it('keys the ledger exactly the way ProgressSync writes it', () => {
    /* `worldId/circuitId/difficulty` locally, split on the FIRST slash, so the
     * ledger scope is the world and the item key is `circuit/difficulty`. A
     * board that split the other way would read an item key nobody writes. */
    const sync = read('src', 'systems', 'ProgressSync.js');
    expect(sync).toMatch(/val\('race', world, rest, Math\.round\(Number\(row\.time\) \* 1000\)\)/);
    const save = read('src', 'systems', 'SaveGame.js');
    expect(save).toMatch(/const key = `\$\{worldId \?\? '\?'\}\/\$\{circuitId\}\/\$\{difficulty\}`/);
  });

  it('never appears in a global index, and never resolves without a server', () => {
    const id = raceTimeBoardId('race', 'vellum', 'standard');
    expect(openBoards(GLOBAL).map((s) => s.id)).not.toContain(id);
    expect(openBoards().map((s) => s.id)).not.toContain(id);
    expect(boardSpec(id, GLOBAL)).toBeNull();
    expect(isServerOnlyBoard(id)).toBe(true);

    const scoped = openBoards({ serverId: 'some-server' }).map((s) => s.id);
    expect(scoped).toContain(id);
    expect(scoped).toContain('relics');
    expect(boardSpec(id, { serverId: 'some-server' })).toBeTruthy();
  });

  it('leaves §9 exactly where it was for the global boards', () => {
    expect(rankableCategory('race')).toBeNull();
    expect(rankableCategory('trial')).toBeNull();
    expect(rankableCategory(raceTimeBoardId('race', 'vellum', 'standard'))).toBeNull();
    for (const spec of Object.values(RANKABLE)) expect(spec.source).not.toBe('values');
  });

  it('refuses trial times at every scope, because there is no floor to state', () => {
    /* The venue roster is learned per visit and half the venues are not races
     * — `DroneHack` and `TestFire` have no route to measure — so the server
     * cannot state a minimum. The same refusal `viewpoints` gets, at the other
     * end of the number line. */
    const trialBoards = Object.keys(SERVER_TIME_BOARDS).filter((id) => id.includes('trial'));
    expect(trialBoards).toEqual([]);
    for (const spec of Object.values(SERVER_TIME_BOARDS)) expect(spec.kind).not.toBe('trial');
  });
});

describe('formatRaceTime', () => {
  it('renders whole milliseconds as a readable lap time', () => {
    expect(formatRaceTime(0)).toBe('0:00.000');
    expect(formatRaceTime(1)).toBe('0:00.001');
    expect(formatRaceTime(59_999)).toBe('0:59.999');
    expect(formatRaceTime(60_000)).toBe('1:00.000');
    expect(formatRaceTime(220_338)).toBe('3:40.338');
    expect(formatRaceTime(3_671_004)).toBe('61:11.004');
  });

  it('never renders a negative or fractional time', () => {
    expect(formatRaceTime(-5)).toBe('0:00.000');
    expect(formatRaceTime(1234.9)).toBe('0:01.234');
  });
});

describe('the route', () => {
  it('formats a time board on the wire, so no client change is needed', () => {
    /* `RecordsPanel` renders `${e.score}` for whatever board the index offered
     * it. An unformatted time board would read as a six-digit millisecond
     * count on the standings sheet. */
    const route = read('site', 'app', 'api', 'game', 'leaderboard', 'route.ts');
    expect(route).toMatch(/board\.unit === 'time' \? formatRaceTime\(e\.score\) : e\.score/);
    expect(route).toMatch(/\{ ms: e\.score \}/);
  });

  it('resolves the scope of a server-only board from the stored selection', () => {
    /* Not from a query parameter. `currentServerId` re-checks membership, which
     * is what makes a scoped board reachable by a client that knows only the id
     * the index gave it. */
    const route = read('site', 'app', 'api', 'game', 'leaderboard', 'route.ts');
    expect(route).toMatch(/memberOf = await currentServerId\(check, playerId\)/);
    expect(route).toMatch(/isServerOnlyBoard\(category\) && memberOf/);
    /* And a GLOBAL category is not silently re-scoped by the same resolution:
     * the scope only moves for a board that has no global form. */
    expect(route).toMatch(/let scope: BoardScope = GLOBAL;/);
    expect(route).toMatch(/if \(requested\) scope = \{ serverId: requested \};/);
  });

  it('still has no way to submit a score', () => {
    const route = read('site', 'app', 'api', 'game', 'leaderboard', 'route.ts');
    expect(route).toMatch(/export async function GET/);
    expect(route).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/);
  });
});

/* ====================================================================== */
/* 3. Against a real Postgres                                              */
/* ====================================================================== */

/**
 * Fixed, obviously synthetic, and in a block NOBODY ELSE HAS CLAIMED.
 *
 * Vitest runs test FILES in parallel against one shared database. The ...0006
 * block belongs to `customServers.test.ts`, and taking it here made that suite
 * fail with `fixture server refused: quota` — its owner already had a server,
 * mine, created a moment earlier by a file it has never heard of. The symptom
 * appeared in the OTHER suite, which is what makes this worth a paragraph: a
 * colliding block does not fail the file that collided.
 */
const OWNER = '00000000-0000-4000-8000-000000000018';
const ME = '00000000-0000-4000-8000-000000180001';
const RIVAL = '00000000-0000-4000-8000-000000180002';
const OUTSIDER = '00000000-0000-4000-8000-000000180003';
const PENDING = '00000000-0000-4000-8000-000000180004';
const PLAYERS = [OWNER, ME, RIVAL, OUTSIDER, PENDING];
const SERVER = 'stb-test-server';
const BOARD = raceTimeBoardId('race', 'vellum', 'standard');
const FLOOR = SERVER_TIME_BOARDS[BOARD].floorMs!;

suite('server time boards (integration)', () => {
  let db: Client;

  const setTime = async (playerId: string, ms: number, key = 'vellum/standard') =>
    db.query(
      `INSERT INTO player_progress_values (player_id, kind, scope, item_key, value)
       VALUES ($1, 'race', 'race', $2, $3)
       ON CONFLICT (player_id, kind, scope, item_key) DO UPDATE SET value = EXCLUDED.value`,
      [playerId, key, ms]
    );

  const board = async (scope: { serverId: string | null } = { serverId: SERVER }) => {
    const out = await readBoard(db, BOARD, scope, { limit: 100, playerId: ME });
    if (!out.ok) throw new Error(`refused: ${out.reason}`);
    return out.board;
  };

  beforeAll(async () => {
    db = new Client({ connectionString: URL_!, ssl: { rejectUnauthorized: false } });
    await db.connect();
    const which = await db.query('SELECT current_database() AS db');
    if (which.rows[0].db !== 'aether_test') {
      throw new Error(`refusing to run against "${which.rows[0].db}" — expected aether_test`);
    }
    await db.query(`
      CREATE TABLE IF NOT EXISTS players (
        id             TEXT PRIMARY KEY,
        handle         TEXT,
        credit_balance INTEGER NOT NULL DEFAULT 0,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS handle TEXT`);
    await ensureLeaderboardSchema(db);
    await ensureCustomServerSchema(db);
  });

  afterAll(async () => {
    if (!db) return;
    await db.query('DELETE FROM player_progress_values WHERE player_id = ANY($1::text[])', [PLAYERS]);
    await db.query('DELETE FROM server_members WHERE server_id = $1', [SERVER]);
    await db.query('DELETE FROM custom_servers WHERE id = $1', [SERVER]);
    await db.end();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM player_progress_values WHERE player_id = ANY($1::text[])', [PLAYERS]);
    for (const id of PLAYERS) {
      await db.query(
        `INSERT INTO players (id, handle, credit_balance) VALUES ($1, $2, 0)
         ON CONFLICT (id) DO UPDATE SET handle = EXCLUDED.handle`,
        /* Suite-prefixed, because `players.handle` is UNIQUE in this database
         * and a bare `p0001` collides with another suite's fixture — which
         * fails HERE while being caused THERE, or the other way round,
         * depending on which file's beforeEach ran first. */
        [id, `stb-${id.slice(-6)}`]
      );
    }
    await db.query(
      `INSERT INTO custom_servers (id, owner_player_id, name, slug)
       VALUES ($1, $2, 'Time board test', $1)
       ON CONFLICT (id) DO NOTHING`,
      [SERVER, OWNER]
    );
    await db.query('DELETE FROM server_members WHERE server_id = $1', [SERVER]);
    for (const [id, state] of [[OWNER, 'approved'], [ME, 'approved'], [RIVAL, 'approved'], [PENDING, 'requested']] as const) {
      await db.query(
        `INSERT INTO server_members (server_id, player_id, state) VALUES ($1, $2, $3)`,
        [SERVER, id, state]
      );
    }
  });

  it('ranks the QUICKEST first, which is the opposite of every other board', async () => {
    await setTime(ME, 240_000);
    await setTime(RIVAL, 200_000);
    const b = await board();
    expect(b.unit).toBe('time');
    expect(b.ceiling).toBeNull();
    expect(b.floorMs).toBe(FLOOR);
    expect(b.entries.map((e) => [e.playerId, e.rank])).toEqual([
      [RIVAL, 1], [ME, 2],
    ]);
  });

  it('DROPS a time below the floor rather than ranking or correcting it', async () => {
    /* One millisecond — the shape of a forged claim, and the exact case §9's
     * "unbounded advantage" describes. It is not clamped to the floor and it is
     * not ranked last: it is not selected at all, so the player is simply not
     * on the board with that time. */
    await setTime(ME, 1);
    await setTime(RIVAL, 200_000);
    const b = await board();
    expect(b.entries.map((e) => e.playerId)).toEqual([RIVAL]);

    /* And the boundary is inclusive: a time AT the floor is admitted, because
     * rounding a player off by a millisecond for no reconstructable reason is
     * the other way to get this wrong. */
    await setTime(ME, FLOOR);
    const at = await board();
    expect(at.entries.map((e) => e.playerId)).toEqual([ME, RIVAL]);

    await setTime(ME, FLOOR - 1);
    const under = await board();
    expect(under.entries.map((e) => e.playerId)).toEqual([RIVAL]);
  });

  it('never carries a non-member, however good their time', async () => {
    await setTime(OUTSIDER, 100_000);
    await setTime(ME, 240_000);
    const b = await board();
    expect(b.entries.map((e) => e.playerId)).toEqual([ME]);
  });

  it('never carries a member who has not been approved', async () => {
    /* `requested` is a row in `server_members`. A board that tested for the row
     * rather than the state would put anyone who had ever asked to join onto a
     * private leaderboard. */
    await setTime(PENDING, 100_000);
    await setTime(ME, 240_000);
    const b = await board();
    expect(b.entries.map((e) => e.playerId)).toEqual([ME]);
  });

  it('reads only the circuit and grade it names', async () => {
    await setTime(ME, 240_000, 'vellum/standard');
    await setTime(RIVAL, 90_000, 'vellum/easy');
    await setTime(OWNER, 95_000, 'cinder/standard');
    const b = await board();
    expect(b.entries.map((e) => e.playerId)).toEqual([ME]);
  });

  it('tells the caller where they stand even outside the top slice', async () => {
    await setTime(RIVAL, 200_000);
    await setTime(OWNER, 210_000);
    await setTime(ME, 400_000);
    const out = await readBoard(db, BOARD, { serverId: SERVER }, { limit: 1, playerId: ME });
    if (!out.ok) throw new Error(`refused: ${out.reason}`);
    const mine = out.board.entries.find((e) => e.self);
    expect(mine?.rank).toBe(3);
    expect(out.board.entries[0].playerId).toBe(RIVAL);
  });

  it('refuses the same board outright when the scope is global', async () => {
    await setTime(ME, 240_000);
    const out = await readBoard(db, BOARD, GLOBAL, { limit: 10, playerId: ME });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('server_only');
  });

  it('still refuses an unknown category', async () => {
    const out = await readBoard(db, 'not-a-board', { serverId: SERVER }, { limit: 10, playerId: ME });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('unknown_category');
  });

  it('leaves the counting boards ranking downwards, unchanged', async () => {
    /* The ascending order is a per-board property, not a new global one. */
    await db.query(
      `INSERT INTO player_progress_items (player_id, kind, scope, item_key)
       VALUES ($1, 'charter', '', 'maze'), ($1, 'charter', '', 'race'), ($2, 'charter', '', 'maze')
       ON CONFLICT DO NOTHING`,
      [ME, RIVAL]
    );
    try {
      const out = await readBoard(db, 'charters', GLOBAL, { limit: 100, playerId: ME });
      if (!out.ok) throw new Error('charters refused');
      const mine = out.board.entries.find((e) => e.playerId === ME);
      const theirs = out.board.entries.find((e) => e.playerId === RIVAL);
      expect(mine!.score).toBe(2);
      expect(theirs!.score).toBe(1);
      expect(mine!.rank).toBeLessThan(theirs!.rank);
      expect(out.board.unit).toBe('count');
      expect(out.board.floorMs).toBeNull();
    } finally {
      await db.query('DELETE FROM player_progress_items WHERE player_id = ANY($1::text[])', [PLAYERS]);
    }
  });
});
