/**
 * THE CLOCK THIS GAME DID NOT HAVE.
 *
 * ===========================================================================
 *  WHAT THIS IS
 * ===========================================================================
 *
 * A grep of the whole tree for daily, weekly, streak, season, login bonus and
 * persistent restock returned zero functional hits. The only recurring thing in
 * the game was `Caches` restocking on a timer that did not survive walking
 * through a gateway. So there was no reason to come back tomorrow, and eighteen
 * worlds of content had exactly one shape of session: play until you stop.
 *
 * This file is three sentences of design:
 *
 *   - a DAILY task drawn from the player's own incomplete records, so it always
 *     points at something that advances the objective;
 *   - a WEEKLY that asks for a different world;
 *   - a SEASON that resets nothing and instead names the window a record was
 *     completed in.
 *
 * Design: `docs/superpowers/specs/2026-08-23-retention-loops-design.md`.
 *
 * ===========================================================================
 *  IT AUTHORS NO TASKS
 * ===========================================================================
 *
 * There is no table of dailies in this file, and that is the single most
 * important thing about it. `Charters.records()` already produces, per world, a
 * list of columns with a `have`, a `need` and a `known` flag, every one of them
 * learned from what a world published rather than written down. The daily's
 * pool is exactly that: every column of every known, unfinished record.
 *
 * An authored list of tasks would be the `CHARTER_DEEDS` problem without
 * `CHARTER_DEEDS`' justification - a list in a file, going stale the day the
 * yard grows a sixth mast, and pointing players at content that moved. Five
 * quest step verbs were deleted after an audit found 0 of 50 quests completable
 * for precisely that reason.
 *
 * ===========================================================================
 *  WHY IT CANNOT BE FARMED, AND WHY THAT IS NOT A RATE CAP
 * ===========================================================================
 *
 * Brief 5.5 requires that a daily not be farmable. The mission design's section
 * 6 proposed buying that with the server-side cap in `site/lib/creditPricing.ts`
 * - `maxEvents: 1, windowSeconds: 86400`. That cap is real and it works, and it
 * cannot be reached from here: the only route into the credit ledger is
 * `POST /api/game/credits`, whose resolver refuses an event with a zero delta
 * outright. A kind there exists only if the daily pays credits, and the same
 * design measures the whole-game faucet at over 250,000 CR against five spend
 * sites and says the problem is a missing sink. See the design's section 0.
 *
 * So the guarantee comes from somewhere stronger than a clock:
 *
 *   A DAILY CAN ONLY BE COMPLETED AS OFTEN AS A RECORD COLUMN ADVANCES, AND
 *   EVERY RECORD COLUMN IS AN IDENTITY SET CAPPED BY CONTENT.
 *
 * Wind the browser's clock forward a hundred days and a hundred day keys become
 * claimable - and each one still wants three relic ids, three viewpoint ids or
 * three seams this player does not already hold. There is a finite number of
 * those. A clock-fiddler arrives sooner at a ceiling everybody shares, which is
 * the same bounded, survivable failure section 9 accepts for leaderboards, and
 * it holds signed out, offline, with no server involved at all.
 *
 * The streak is the one number here a clock CAN move, which is why it is
 * derived on read, never persisted, never paid for and never rankable. It is a
 * number on the player's own screen - the correct home for a number that cannot
 * be defended.
 *
 * ===========================================================================
 *  NOTHING EXPIRES
 * ===========================================================================
 *
 * `_done` and `_season` are grow-only sets of ids. A missed day is a day absent
 * from a set, never a deletion; a season turning over takes nothing with it.
 * `progressLedger` never subtracts and neither does this, because a retention
 * loop that deletes progress teaches people to stop playing.
 *
 * ===========================================================================
 *  IDENTITY, NOT COUNT
 * ===========================================================================
 *
 * Two sets of ids are persisted and nothing else:
 *
 *   done    'daily/2026-08-23', 'weekly/2026-W34'
 *   season  '2026-Q3/medieval'
 *
 * No streak, no tally, no best. Every one of those is recomputed on read from
 * those two sets - the rule `Charters.serialize` writes down and the defect
 * `Relics.serialize` used to have, where `{ found: { citadel: 17 } }` was a
 * right tally over seventeen wrong things.
 *
 * ===========================================================================
 *  WHAT IT PAYS
 * ===========================================================================
 *
 * Progress, because the task IS a record column and finishing it advances a
 * charter. And a consignment: `Caches.consign(worldId)` releases the caches the
 * player has already emptied in that world so they restock at once. Items, and
 * a reason to go back to a place.
 *
 * It pays no credits. Not a small number, not a capped number - none. See the
 * farming note above and the design's section 0.
 */

/* ====================================================================== */
/* Period keys                                                            */
/* ====================================================================== */

/**
 * Every key here is UTC.
 *
 * Local time would give a player two dailies by flying west, and would make the
 * ledger's union non-deterministic: two devices in two time zones would file
 * the same evening's play under different day ids and the merge would count it
 * twice. The ledger unions ids and asks no questions, so the ids have to agree.
 */
const DAY_MS = 86400000;

/** `YYYY-MM-DD`, UTC. */
export function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * `YYYY-Www`, ISO-8601, UTC.
 *
 * ISO rather than "day of year over seven", because the ISO year of the last
 * days of December is sometimes the next year, and a home-made week number puts
 * the 30th and the 31st in different weeks from the 1st and the 2nd that follow
 * them. The Thursday rule is what makes a week belong to exactly one year.
 */
export function weekKey(ms) {
  const d = new Date(ms);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Monday = 0. Step to this week's Thursday; that day names the ISO year.
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7) + 3);
  const year = t.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  firstThursday.setUTCDate(
    firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3
  );
  const week = 1 + Math.round((t.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/**
 * `YYYY-Qn`, UTC.
 *
 * A calendar quarter, because a season here is a WINDOW and not a content drop:
 * it is not tied to a release, nothing is authored per season, and nothing has
 * to be scheduled. A season anchored on an epoch would need someone to remember
 * the epoch; a quarter is a thing the player already has a name for.
 */
export function seasonKey(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

/* ====================================================================== */
/* Task sizes                                                             */
/* ====================================================================== */

/**
 * How much of a column a period asks for.
 *
 * Small on purpose, and the house rule from `SpaceObjectives.js:65` is why: a
 * threshold nobody can reach is the same defect as a relic nobody can find.
 * Three relics is one errand; a week's eight is an evening. Both are clamped
 * against the column's own `need`, so a world with four viewpoints left never
 * asks for eight.
 */
const STEP = Object.freeze({ daily: 3, weekly: 8 });
const KINDS = Object.freeze(['daily', 'weekly']);

/** FNV-1a. The same one `Caches` seeds its placement with. */
function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/* ====================================================================== */
/* The system                                                             */
/* ====================================================================== */

export class Retention {
  /**
   * Everything is optional, the same probe-first arrangement `SaveGame` uses
   * for its whole progress layer. Without `charters` there are no tasks and the
   * season still records nothing incorrectly; without `caches` a completed task
   * still counts and simply pays no consignment.
   *
   * @param {{bus?:any, charters?:any, caches?:any, now?:() => number}} ctx
   */
  constructor({ bus, charters, caches, now } = {}) {
    this.bus = bus ?? null;
    this.charters = charters ?? null;
    this.caches = caches ?? null;
    /** Wall clock, injectable so the cases can wind it. */
    this.now = typeof now === 'function' ? now : () => Date.now();

    /** Period ids already claimed. `daily/2026-08-23`, `weekly/2026-W34`. */
    this._done = new Set();
    /** `seasonId/worldId` for every charter restored inside a window. */
    this._season = new Set();

    /**
     * The board as of the last settled announcement.
     *
     * A task is derived from THIS, and the claim is checked against the board
     * that just arrived. Deriving from the new board instead would miss the one
     * claim that matters most: the column that has just been finished is gone
     * from the pool by the time the event lands.
     * @type {Array<any>}
     */
    this._board = [];
    /**
     * True while a save is being restored.
     *
     * `Charters.deserialize` re-derives every record and announces a board that
     * can jump by a hundred relics at once. That is a load, not a day's play,
     * and a loop that claimed on it would hand a returning player a free daily
     * on every boot. `SaveGame` calls {@link Retention#resync} before restoring
     * and the `save:loaded` that follows closes the window.
     */
    this._loading = false;
    /** Last announced signature, so an unchanged loop does not re-announce. */
    this._sig = '';

    this._offs = [];
    if (this.bus) {
      this._offs.push(this.bus.on('charter:changed', (p) => this._onBoard(p?.worlds)));
      this._offs.push(this.bus.on('charter:restored', (p) => this._onRestored(p?.id)));
      this._offs.push(this.bus.on('save:loaded', () => this._onLoaded()));
    }
    this._board = this._records();
  }

  /* ------------------------------------------------------------------ */
  /* Read surface                                                        */
  /* ------------------------------------------------------------------ */

  /** Today's task, or null when there is nothing unfinished to point at. */
  get daily() {
    return this._derive('daily', this.now(), this._board);
  }

  /** This week's, in a different world where the board offers one. */
  get weekly() {
    return this._derive('weekly', this.now(), this._board);
  }

  /**
   * Consecutive days claimed, counting back from today.
   *
   * Derived on every read. Today not being claimed yet does not break a streak
   * - a player who opens the game at nine in the morning has not lost anything
   * - so the walk starts at yesterday when today is still open.
   */
  get streak() {
    let t = this.now();
    if (!this._done.has(`daily/${dayKey(t)}`)) t -= DAY_MS;
    let n = 0;
    while (this._done.has(`daily/${dayKey(t)}`)) { n++; t -= DAY_MS; }
    return n;
  }

  /** The longest run of consecutive claimed days in the whole record. */
  get bestStreak() {
    const days = [...this._done]
      .filter((k) => k.startsWith('daily/'))
      .map((k) => Date.parse(`${k.slice(6)}T00:00:00Z`))
      .filter((t) => Number.isFinite(t))
      .sort((a, b) => a - b);
    let best = 0;
    let run = 0;
    let prev = null;
    for (const t of days) {
      run = prev !== null && t - prev === DAY_MS ? run + 1 : 1;
      prev = t;
      if (run > best) best = run;
    }
    return best;
  }

  /** The window the player is in, and the records completed inside it. */
  season(at = this.now()) {
    const id = seasonKey(at);
    return { id, worlds: this._worldsIn(id) };
  }

  /** Every window that has anything in it, oldest first. Nothing is dropped. */
  seasons() {
    const ids = new Set();
    for (const key of this._season) {
      const slash = key.indexOf('/');
      if (slash > 0) ids.add(key.slice(0, slash));
    }
    return [...ids].sort().map((id) => ({ id, worlds: this._worldsIn(id) }));
  }

  /**
   * Everything a panel would draw, as one plain object.
   *
   * Nothing draws it yet: `src/ui/**` belongs to another change this cycle, so
   * this is the hook and `retention:changed` is where it arrives. Recorded in
   * the design's section 5 as an outstanding surface rather than left implied.
   */
  progress() {
    const at = this.now();
    return {
      daily: this._derive('daily', at, this._board),
      weekly: this._derive('weekly', at, this._board),
      dailyDone: this._done.has(`daily/${dayKey(at)}`),
      weeklyDone: this._done.has(`weekly/${weekKey(at)}`),
      streak: this.streak,
      best: this.bestStreak,
      season: this.season(at),
    };
  }

  /* ------------------------------------------------------------------ */
  /* Deriving a task                                                     */
  /* ------------------------------------------------------------------ */

  _records() {
    try {
      const out = this.charters?.records?.();
      return Array.isArray(out) ? out : [];
    } catch {
      return [];
    }
  }

  _periodKey(kind, at) {
    return kind === 'weekly' ? weekKey(at) : dayKey(at);
  }

  /**
   * Every unfinished column of every known record, in a stable order.
   *
   * Sorted, because the pick below indexes into this list and an unsorted pool
   * would hand the same day two different tasks depending on which world the
   * player happened to visit first.
   */
  _pool(board) {
    const pool = [];
    for (const w of board) {
      if (!w?.known || w.complete) continue;
      for (const c of w.columns ?? []) {
        if (!(c.have < c.need)) continue;
        pool.push({
          worldId: w.id,
          world: w.name,
          column: c.key,
          label: c.label,
          noun: c.noun,
          have: c.have,
          need: c.need,
        });
      }
    }
    pool.sort((a, b) => (`${a.worldId}/${a.column}`).localeCompare(`${b.worldId}/${b.column}`));
    return pool;
  }

  /**
   * The task for one period, derived from a board.
   *
   * ── Why the target is a multiple and not `have + step` ────────────────────
   *
   * `have + step` is a delta, and a delta has to be remembered from the moment
   * the task was issued - so a reload either loses it or persists a count,
   * which is the one thing this file will not do. The next multiple of `step`
   * above `have` is a pure function of the board: with `have` unchanged the
   * same target comes back after any reload, a half-done task does not restart,
   * and it advances only once the previous target is met.
   *
   * @param {'daily'|'weekly'} kind
   * @param {number} at
   * @param {Array<any>} board
   */
  _derive(kind, at, board) {
    const pool = this._pool(board ?? []);
    if (!pool.length) return null;

    let choices = pool;
    if (kind === 'weekly') {
      /* A week in the same world the day already points at is one task with two
       * labels. Where the board offers nowhere else it falls back rather than
       * offering nothing - a player with one unfinished world still has a week. */
      const day = this._derive('daily', at, board);
      const elsewhere = day ? pool.filter((p) => p.worldId !== day.worldId) : pool;
      if (elsewhere.length) choices = elsewhere;
    }

    const period = this._periodKey(kind, at);
    const step = STEP[kind];
    const pick = choices[hashString(`${kind}:${period}`) % choices.length];
    const target = Math.min(pick.need, (Math.floor(pick.have / step) + 1) * step);
    return {
      kind,
      period,
      ...pick,
      step,
      target,
      left: Math.max(0, target - pick.have),
      done: this._done.has(`${kind}/${period}`),
    };
  }

  /** What this player currently holds of one column. */
  _have(board, worldId, column) {
    const world = board.find((w) => w?.id === worldId);
    const col = world?.columns?.find((c) => c.key === column);
    return col ? col.have : -1;
  }

  /* ------------------------------------------------------------------ */
  /* Claiming                                                            */
  /* ------------------------------------------------------------------ */

  _onBoard(worlds) {
    const board = Array.isArray(worlds) ? worlds : this._records();
    if (this._loading) {
      this._board = board;
      return;
    }
    const at = this.now();
    for (const kind of KINDS) {
      const key = `${kind}/${this._periodKey(kind, at)}`;
      if (this._done.has(key)) continue;
      const task = this._derive(kind, at, this._board);
      if (!task) continue;
      /* Against the board that just arrived, not the one the task came from.
       * `_have` answers -1 for a column that is no longer on the board at all,
       * which is a world whose content shrank - not a completion. */
      const have = this._have(board, task.worldId, task.column);
      if (have >= task.target) this._claim(kind, key, task);
    }
    this._board = board;
    this._announce();
  }

  _claim(kind, key, task) {
    this._done.add(key);
    /* The whole material reward. Not credits: see the header, and the design's
     * section 0. `consign` answers how many sites it released so the notice can
     * stay quiet when there was nothing to release. */
    let released = 0;
    try { released = Number(this.caches?.consign?.(task.worldId)) || 0; } catch { released = 0; }

    this.bus?.emit('retention:complete', {
      kind,
      period: task.period,
      worldId: task.worldId,
      world: task.world,
      column: task.column,
      streak: this.streak,
      released,
    });
    const what = kind === 'weekly' ? "This week's survey" : "Today's survey";
    this.bus?.emit('hud:notify', {
      text: released > 0
        ? `${what} filed at ${task.world} — a consignment has restocked`
        : `${what} filed at ${task.world}`,
      tone: 'good',
    });
  }

  _onRestored(worldId) {
    if (typeof worldId !== 'string' || !worldId) return;
    const key = `${seasonKey(this.now())}/${worldId}`;
    if (this._season.has(key)) return;
    this._season.add(key);
    this._announce(true);
  }

  /**
   * A save is about to be restored.
   *
   * Called by `SaveGame` at the top of its progress pass, and closed by the
   * `save:loaded` that follows it. The window has to open BEFORE
   * `Charters.deserialize` announces, which is why it is a method rather than
   * an event: the ordering of two subscribers on one channel is not something
   * to rely on.
   */
  resync() {
    this._loading = true;
  }

  /**
   * The restore is finished; take the board as it now stands and resume.
   *
   * Paired with `resync` by the SAME method in `SaveGame`, rather than left to
   * the `save:loaded` that follows it. The event is emitted after the restore
   * returns and is skipped entirely on the failure path, so hanging the close
   * on it would leave a failed load with the loop switched off for the rest of
   * the session - silently, and in exactly the session a player is least likely
   * to forgive. The `save:loaded` handler below still calls this, which costs
   * nothing and covers the case where somebody restores by another route.
   */
  resume() {
    this._loading = false;
    this._board = this._records();
    this._announce(true);
  }

  _onLoaded() {
    this.resume();
  }

  _worldsIn(seasonId) {
    const prefix = `${seasonId}/`;
    const out = [];
    for (const key of this._season) if (key.startsWith(prefix)) out.push(key.slice(prefix.length));
    return out.sort();
  }

  /** Write the loop out, but only when it has actually moved. */
  _announce(force = false) {
    const state = this.progress();
    const sig = [
      state.daily ? `${state.daily.worldId}/${state.daily.column}/${state.daily.target}` : '-',
      state.weekly ? `${state.weekly.worldId}/${state.weekly.column}/${state.weekly.target}` : '-',
      state.dailyDone, state.weeklyDone, state.streak, state.season.worlds.length,
    ].join('|');
    if (!force && sig === this._sig) return;
    this._sig = sig;
    this.bus?.emit('retention:changed', state);
  }

  /* ------------------------------------------------------------------ */
  /* Persistence                                                         */
  /* ------------------------------------------------------------------ */

  /** Two sets of ids. Deliberately no streak, no tally, no best. */
  serialize() {
    return {
      done: [...this._done].sort(),
      season: [...this._season].sort(),
    };
  }

  /**
   * REPLACE, not merge - the rule `Relics`, `Viewpoints` and `Charters` all
   * record: a load has to be able to take progress away, or a player keeps
   * progress the save they loaded does not contain.
   *
   * The union that cross-device needs happens one level up, in `ProgressSync`,
   * which builds it before calling this - the same shape the onboarding block
   * there already uses.
   */
  deserialize(data) {
    if (!isObj(data)) return false;
    this._done.clear();
    this._season.clear();
    if (Array.isArray(data.done)) {
      for (const k of data.done) if (typeof k === 'string' && k) this._done.add(k);
    }
    if (Array.isArray(data.season)) {
      for (const k of data.season) if (typeof k === 'string' && k.includes('/')) this._season.add(k);
    }
    this._announce(true);
    return true;
  }

  dispose() {
    for (const off of this._offs) off?.();
    this._offs.length = 0;
    this._done.clear();
    this._season.clear();
    this._board = [];
  }
}

export default Retention;
