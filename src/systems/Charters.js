/**
 * CHART THE NEXUS - the thing the game is for.
 *
 * ===========================================================================
 *  WHAT THIS IS
 * ===========================================================================
 *
 * A player arrived on a station with six gateways and was told nothing. Every
 * portal was open from the first minute, every world was built, and no system
 * anywhere said what any of it was FOR. That is not a missing tutorial, it is a
 * missing objective, and this file is the objective:
 *
 *   The Nexus is a gateway network of eighteen worlds whose survey records were
 *   lost. Every world holds a RECORD - its relics, its viewpoints, its trials,
 *   its circuits, its seams, its wings - and completing a world's record
 *   restores that gateway's CHARTER. Restore all eighteen and the network is
 *   whole again.
 *
 * ── This file authors nothing ──────────────────────────────────────────────
 *
 * A charter is a NAME for the union of completion sets that already exist,
 * already persist and already merge. There is no new collectible here, no new
 * placement, no new world data. `Relics`, `Viewpoints`, `Mining`,
 * `SpaceObjectives` and the trial/race ledgers keep every identity; this file
 * keeps only two things of its own - a learned ROSTER per world and the SET of
 * charters restored - and derives everything else.
 *
 * ===========================================================================
 *  THE DENOMINATORS ARE LEARNED, NEVER WRITTEN DOWN
 * ===========================================================================
 *
 * This is the rule the whole design turns on, and it is `SpaceObjectives`'
 * `_learnElements` / `_learnWings` arrangement applied one level up. Phase 2
 * grew the space encounter set from 3 wings to 12 without editing
 * `SpaceObjectives.js` at all, because that file never held a copy of the list.
 *
 * So: no count in this file is a constant. `record('dock').viewpoints.need` is
 * what `DockWorld` published the last time the player stood in it. Add a mast
 * to the yard, a seam to Cinder, a circuit to Vellum Ridge or an entire
 * nineteenth world, and the board counts it the next time somebody goes there,
 * with no edit here and no constant to move.
 *
 * The price of that is honest and worth stating: a world you have never
 * visited has an UNKNOWN record, not an empty one. `known` is false, the row
 * reads "unsurveyed", and it fills in when you go. You do not know what is down
 * there until you go and look - the same sentence `_learnElements` is written
 * under.
 *
 * ── The 0/0 charter, which would have made the objective a lie ─────────────
 *
 * An unknown record is `0 of 0`, and `have >= need` is TRUE for `0 of 0`. Left
 * alone, a player who had never left the station would hold seventeen charters
 * for worlds they had never seen, and the top rank would be free. So a record
 * is complete only when `need > 0` - the identical guard
 * `Viewpoints._onWorld` puts on `list.length > 0` before paying a set, and
 * `SpaceObjectives.deserialize` puts on `wingTotal > 0` before believing a
 * receipt. It has a case of its own in `charters.test.mjs`.
 *
 * ── A shrinking world, which is the other half of the same problem ─────────
 *
 * `SpaceObjectives` keeps its wing roster GROW-ONLY for display and decides its
 * set prize against the LIVE world, because a zone deleted from `SpaceWorld`
 * would otherwise leave a ghost in the total and make the set uncompletable for
 * ever. A charter cannot take that deal: it has to draw a row for a world the
 * player is NOT standing in, so it has no live world to ask.
 *
 * It takes the other half instead. Each learner REPLACES exactly its own column
 * of exactly its own world, so content that disappears takes its denominator
 * with it the next time the player is there, and a roster can shrink. Learning
 * one column at a time is also what makes the order of `world:changed`
 * subscribers irrelevant: `relics:changed`, `viewpoints:changed` and
 * `minigame:armed` all carry their own world id, so it does not matter whether
 * they land before or after this file's own handler.
 *
 * ===========================================================================
 *  IDENTITY, NOT COUNT
 * ===========================================================================
 *
 * `Relics.serialize` once wrote `{ found: { citadel: 17 } }` and a reload
 * marked the first seventeen sites in publication order. The tally was right
 * and every marked thing was wrong.
 *
 * This file cannot repeat that defect, because IT PERSISTS NO NUMERATOR AT ALL.
 * Every "have" on the board is recomputed, on read, from the identity set of
 * the system that owns it - `Relics.foundIds`, `Viewpoints.worlds`,
 * `Mining.taken`, the trial and race ledgers keyed by venue. What is persisted
 * is:
 *
 *   rosters   worldId -> { column: N }. Denominators, learned. Not progress:
 *             a roster is a record of what a world PUBLISHED, the same thing
 *             `SpaceObjectives._elements` and `_wingRoster` are.
 *   charters  a SET of world ids whose charter is restored. A receipt.
 *   deeds     a SET of `worldId/deedId`. The one column with no owning system;
 *             see CHARTER_DEEDS.
 *
 * Both sets are unions of ids, which is exactly what `progressLedger.ts` merges
 * without a clock, so cross-device costs nothing but two new kinds.
 *
 * ===========================================================================
 *  WHAT THIS DELIBERATELY DOES NOT DO
 * ===========================================================================
 *
 * **It does not gate anything.** Every gateway is open from the first minute
 * and stays open. A charter is a record OF completion, never a key TO it, and
 * gating the eighteen worlds behind each other would break the one thing this
 * game already does well - that a new player can walk through any gateway and
 * find something built.
 *
 * **It pays no credits.** The mission design's section 5 proposes charter
 * restoration as the economy's missing drain, priced per world, and is explicit
 * that the price must be MEASURED against real play rather than guessed. It is
 * not measured yet, and a charter that paid OUT would deepen a faucet the same
 * document measures at 22 sources against 5 sinks. So restoration is free and
 * silent about money until somebody does the measuring.
 *
 * **There is no XP.** Hostiles respawn every 22 s and space encounters rearm
 * every 210 s; a bar fed by a respawning source is an idle game. Rank here is
 * DERIVED from charters held - a pure function of two sets - so it cannot be
 * farmed, cannot drift, and falls again if a load takes progress away.
 */

/* ====================================================================== */
/* 1. Columns                                                             */
/* ====================================================================== */

/**
 * The columns a record can have, in the order they are drawn.
 *
 * Each names a completion set that ALREADY exists somewhere else. There is
 * deliberately no column for anything counted rather than collected: kills,
 * credits and time are all unbounded against a respawning source, and a
 * denominator that never stops moving is a denominator that is lying about
 * there being something left to do.
 */
export const CHARTER_COLUMNS = Object.freeze([
  Object.freeze({ key: 'relics', label: 'Relics', noun: 'relics' }),
  Object.freeze({ key: 'viewpoints', label: 'Viewpoints', noun: 'viewpoints' }),
  Object.freeze({ key: 'trials', label: 'Trials', noun: 'contests' }),
  Object.freeze({ key: 'races', label: 'Circuits', noun: 'circuits' }),
  Object.freeze({ key: 'seams', label: 'Seams', noun: 'seams' }),
  Object.freeze({ key: 'wings', label: 'Wings', noun: 'wings' }),
  Object.freeze({ key: 'survey', label: 'Bodies', noun: 'bodies' }),
  Object.freeze({ key: 'deeds', label: 'Deeds', noun: 'deeds' }),
]);

const COLUMN_LABEL = new Map(CHARTER_COLUMNS.map((c) => [c.key, c]));

/* ====================================================================== */
/* 2. Deeds - the one authored column, and why                            */
/* ====================================================================== */

/**
 * Named one-off acts, per world, each satisfied by an event the game ALREADY
 * fires.
 *
 * ── Why this table exists at all ───────────────────────────────────────────
 *
 * Everything else on the board is learned from a world publishing a list. Two
 * worlds publish no such list and still have a job:
 *
 *   THE COIL has no relics, no loot, no races and no interiors by its own
 *   rules, and its job is deprivation - one exit, everything switched off. Its
 *   record is "reached the centre", and no list anywhere says how many centres
 *   a maze has.
 *
 *   THE STATION is the hub and the only place with all five shop categories.
 *   Its job is arrival, and its record is the first trade, the first mount and
 *   the first gateway - the three things a first-run player has to do once.
 *
 * So this column is AUTHORED, and that is a real cost: it is the one place a
 * charter can name something the world does not publish, which is the same
 * shape as a quest step naming a target nothing emits. Five step verbs were
 * deleted from `QuestSystem` after an audit found 0 of 50 quests completable
 * for exactly that reason.
 *
 * The guard is the one that audit produced: **an emitter first**. Every `event`
 * below is scraped out of `src/` by `charters.test.mjs`, and a deed waiting on
 * a channel nothing emits fails the build rather than sitting on a board
 * forever.
 *
 * Deeds are NOT gated on having visited the world, unlike every learned column.
 * That is deliberate and it is what gives a first-run player a next action: the
 * station's three-row record is legible from the first frame, before anything
 * has been learned about anywhere.
 */
export const CHARTER_DEEDS = Object.freeze({
  station: Object.freeze([
    Object.freeze({ id: 'trade', event: 'market:trade', label: 'Trade at a market' }),
    Object.freeze({ id: 'mount', event: 'mount:mounted', label: 'Ride a mount' }),
    Object.freeze({ id: 'gateway', event: 'portal:entering', label: 'Step through a gateway' }),
  ]),
  maze: Object.freeze([
    Object.freeze({ id: 'centre', event: 'maze:centre-found', label: 'Reach the centre of the Coil' }),
  ]),
});

/** Every distinct channel the deed table waits on. */
const DEED_EVENTS = (() => {
  const out = new Map();
  for (const [worldId, rows] of Object.entries(CHARTER_DEEDS)) {
    for (const deed of rows) {
      const list = out.get(deed.event) ?? [];
      list.push({ worldId, id: deed.id });
      out.set(deed.event, list);
    }
  }
  return out;
})();

/* ====================================================================== */
/* 3. Rank and reputation - both derived                                  */
/* ====================================================================== */

/**
 * The charter ladder.
 *
 * `fraction` and not a count, so the ladder scales with the registry rather
 * than with a constant somebody has to remember. Register a nineteenth world
 * and every threshold moves by itself; the top rung stays "every world", which
 * is the only threshold that can be neither unreachable nor free.
 *
 * The house rule from `SpaceObjectives.js:65` is that a threshold nobody can
 * reach is the same defect as a relic nobody can find. Every rung here is
 * reachable by construction: a charter is made only of content that is already
 * placed and already completable, so "all eighteen" is exactly as reachable as
 * the eighteen records are.
 */
export const CHARTER_RANKS = Object.freeze([
  Object.freeze({ fraction: 0, title: 'Unlisted' }),
  Object.freeze({ fraction: 1 / 18, title: 'Runner' }),
  Object.freeze({ fraction: 1 / 6, title: 'Surveyor' }),
  Object.freeze({ fraction: 1 / 3, title: 'Pathfinder' }),
  Object.freeze({ fraction: 2 / 3, title: 'Cartographer' }),
  Object.freeze({ fraction: 1, title: 'Charter of the Nexus' }),
]);

/**
 * Standings, as fractions of a world's record.
 *
 * Reputation in the mission design is "that world's record expressed as a
 * relationship", which means it is not a second ledger and cannot disagree with
 * the first. It is a function, not a field, and there is nothing to persist.
 */
const STANDINGS = Object.freeze([
  Object.freeze({ at: 0, title: 'Unknown' }),
  Object.freeze({ at: 0.01, title: 'Noted' }),
  Object.freeze({ at: 1 / 3, title: 'Trusted' }),
  Object.freeze({ at: 2 / 3, title: 'Vouched' }),
  Object.freeze({ at: 1, title: 'Chartered' }),
]);

/**
 * A world's standing from its record.
 *
 * Null for a world with no record, because "Unknown" and "there is nothing to
 * know" are different sentences and a row that claimed a standing in a world
 * nobody has surveyed would be inventing a relationship.
 *
 * @param {number} have
 * @param {number} need
 * @returns {string|null}
 */
export function reputationOf(have, need) {
  if (!(need > 0)) return null;
  const f = Math.max(0, Math.min(1, have / need));
  let title = STANDINGS[0].title;
  for (const s of STANDINGS) if (f >= s.at) title = s.title;
  return title;
}

/* ====================================================================== */
/* 4. The system                                                          */
/* ====================================================================== */

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const count = (v) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export class Charters {
  /**
   * Every system is optional. A game booted without mining still charters the
   * worlds that do not have seams, which is the same probe-first arrangement
   * `SaveGame` uses for its whole progress layer.
   *
   * @param {{bus?:any, worldManager?:any, relics?:any, viewpoints?:any,
   *          mining?:any, objectives?:any, cosmetics?:any,
   *          trials?:{read:()=>any}, races?:{read:()=>any}}} ctx
   */
  constructor({
    bus, worldManager, relics, viewpoints, mining, objectives, cosmetics, trials, races,
  } = {}) {
    this.bus = bus ?? null;
    this.worldManager = worldManager ?? null;
    this.relics = relics ?? null;
    this.viewpoints = viewpoints ?? null;
    this.mining = mining ?? null;
    this.objectives = objectives ?? null;
    this.cosmetics = cosmetics ?? null;
    /**
     * The two best-time ledgers, as `{ read() }` pairs rather than systems.
     *
     * Neither has an owning system - `SaveGame` keeps both itself, for the
     * reason its `_trialLedger` writes down - so this file takes a reader
     * rather than pretending there is an object to hold. Same shape
     * `ProgressSync` already takes for the trial ledger.
     */
    this.trials = trials ?? null;
    this.races = races ?? null;

    /** worldId -> { column -> denominator }. Learned, never authored. */
    this._rosters = new Map();
    /** World ids whose charter is restored. A receipt, keyed by identity. */
    this._charters = new Set();
    /** `worldId/deedId` for every deed done. */
    this._deeds = new Set();

    this._worldId = this.worldManager?.active?.id ?? null;
    /** Last announced summary, so an unchanged board does not re-announce. */
    this._sig = '';

    this._offs = [];
    if (this.bus) {
      /* Every channel below already existed and already fired. Nothing in
       * `Relics`, `Viewpoints`, `Mining`, `MinigameManager`, `RaceManager` or
       * `SpaceObjectives` was changed to make this file work - which is the
       * whole point of a system that names what other systems already do. */
      this._offs.push(bus.on('world:changed', (p) => this._onWorld(p?.id ?? null, p?.world ?? null)));
      this._offs.push(bus.on('relics:changed', (p) => {
        this._learn(p?.worldId, 'relics', p?.total);
        this._settle();
      }));
      this._offs.push(bus.on('viewpoints:changed', (p) => {
        this._learn(p?.worldId, 'viewpoints', p?.total);
        this._settle();
      }));
      this._offs.push(bus.on('minigame:armed', (p) => {
        this._learn(p?.worldId, 'trials', Array.isArray(p?.venues) ? p.venues.length : 0);
        this._settle();
      }));
      /* Numerator movers. Each of these is a discrete act, never a frame, so
       * recomputing the whole board on one is the same arrangement
       * `Viewpoints._announce` and `SpaceObjectives._announce` already have. */
      this._offs.push(bus.on('mining:node', () => this._settle()));
      this._offs.push(bus.on('trial:best', () => this._settle()));
      this._offs.push(bus.on('race:best', () => this._settle()));
      this._offs.push(bus.on('combat:cleared', () => this._settle()));
      this._offs.push(bus.on('pilot:entry', () => this._settle()));
      this._offs.push(bus.on('pilot:landed', () => this._settle()));
      this._offs.push(bus.on('save:loaded', () => this._settle()));
      for (const [event, rows] of DEED_EVENTS) {
        this._offs.push(bus.on(event, () => this._credit(event, rows)));
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Read surface                                                        */
  /* ------------------------------------------------------------------ */

  /** How many gateways there are to chart. The registry, never a constant. */
  get worldTotal() {
    return this.worldManager?.ids?.length ?? 0;
  }

  /** How many charters are restored. */
  get charteredCount() {
    return this._charters.size;
  }

  /** @param {string} id */
  isChartered(id) {
    return this._charters.has(id);
  }

  /**
   * The rung index the charters justify. Derived on every read, so there is no
   * stored number for a load to disagree with and nothing to farm.
   */
  get charterRank() {
    const total = this.worldTotal;
    if (total <= 0) return 0;
    const f = this._charters.size / total;
    let rung = 0;
    for (let i = 0; i < CHARTER_RANKS.length; i++) if (f >= CHARTER_RANKS[i].fraction) rung = i;
    return rung;
  }

  /** The title for that rung. */
  get rank() {
    return CHARTER_RANKS[this.charterRank]?.title ?? null;
  }

  /**
   * One world's record.
   *
   * A fresh object per call, which is safe because this is read on a `*:changed`
   * event and never per frame - the arrangement `SpaceObjectives.progress` has
   * with the same panel.
   *
   * @param {string} worldId
   * @param {any} [held] pre-read identity sets, when a caller is walking the
   *   whole registry and does not want eighteen serialisations of each system
   */
  record(worldId, held = this._held()) {
    const roster = this._rosters.get(worldId) ?? null;
    const columns = [];
    let have = 0;
    let need = 0;

    for (const spec of CHARTER_COLUMNS) {
      const n = spec.key === 'deeds'
        ? (CHARTER_DEEDS[worldId]?.length ?? 0)
        : count(roster?.[spec.key]);
      if (n <= 0) continue;
      /* CLAMPED. A venue that stopped arming, or a relic site that moved,
       * would otherwise let a numerator run past its own denominator and show
       * `5/4` - which reads as a bug even when the underlying set is fine. */
      const got = Math.min(n, this._have(worldId, spec.key, held));
      columns.push({ key: spec.key, label: spec.label, noun: spec.noun, have: got, need: n });
      have += got;
      need += n;
    }

    const known = columns.length > 0;
    return {
      id: worldId,
      name: this.worldManager?.displayNameOf?.(worldId) ?? worldId,
      columns,
      have,
      need,
      known,
      /* `need > 0` is the whole guard. See the header: without it every world
       * nobody has visited is `0 of 0`, which is complete, and the objective
       * completes itself. */
      complete: known && have >= need,
      restored: this._charters.has(worldId),
      reputation: reputationOf(have, need),
    };
  }

  /** Every registered world's record, in registration order. */
  records() {
    const held = this._held();
    return (this.worldManager?.ids ?? []).map((id) => this.record(id, held));
  }

  /**
   * Everything a panel draws, as one plain object.
   * @returns {{chartered:number,total:number,rank:string|null,rung:number,
   *            worlds:Array<any>, hint:string, here:any|null}}
   */
  progress() {
    const worlds = this.records();
    const here = worlds.find((w) => w.id === this._worldId) ?? null;
    return {
      chartered: this._charters.size,
      total: this.worldTotal,
      rank: this.rank,
      rung: this.charterRank,
      worlds,
      here,
      hint: this._hint(worlds, here),
    };
  }

  /**
   * Mastery: the per-verb depth that already exists and has never been shown in
   * one place.
   *
   * Every row is READ from the system that owns it. Nothing here is stored, so
   * a row cannot go stale and there is no second copy to disagree with the
   * first. Rows with nothing in them are dropped rather than drawn at zero: an
   * empty ledger is not a skill you have none of, it is a thing you have not
   * done yet, and a panel of zeroes teaches nobody anything.
   */
  mastery() {
    const rows = [];
    const trials = this._ledger(this.trials);
    const races = this._ledger(this.races);
    if (Object.keys(trials).length) {
      rows.push({ key: 'trials', label: 'Contest bests', value: Object.keys(trials).length });
    }
    if (Object.keys(races).length) {
      rows.push({ key: 'races', label: 'Circuit bests', value: Object.keys(races).length });
    }
    const o = this.objectives;
    if (o) {
      if (o.assayCount > 0) rows.push({ key: 'assay', label: 'Elements assayed', value: o.assayCount, total: o.assayTotal });
      if (o.wingCount > 0) rows.push({ key: 'wings', label: 'Wings broken', value: o.wingCount, total: o.wingTotal });
      if (o.killCount > 0) rows.push({ key: 'kills', label: 'Hostiles downed', value: o.killCount });
    }
    return rows;
  }

  /**
   * Collection: the finite things, counted across every world at once.
   *
   * `Relics` and `Viewpoints` each answer only for the world they are standing
   * in - `total` is the ACTIVE world's placement - so neither of them can draw
   * this row, and nothing did. The denominators come from the same learned
   * rosters the records use, so a world nobody has visited contributes nothing
   * to either side of the fraction rather than a guess to one of them.
   */
  collection() {
    const held = this._held();
    let relics = 0; let relicTotal = 0;
    let viewpoints = 0; let viewpointTotal = 0;
    for (const id of this.worldManager?.ids ?? []) {
      const roster = this._rosters.get(id);
      const r = count(roster?.relics);
      if (r > 0) { relicTotal += r; relics += Math.min(r, this._have(id, 'relics', held)); }
      const v = count(roster?.viewpoints);
      if (v > 0) { viewpointTotal += v; viewpoints += Math.min(v, this._have(id, 'viewpoints', held)); }
    }
    let cosmetics = 0;
    try {
      const owned = this.cosmetics?.serialize?.();
      cosmetics = Array.isArray(owned) ? owned.length
        : Array.isArray(owned?.owned) ? owned.owned.length : 0;
    } catch { cosmetics = 0; }
    return { relics, relicTotal, viewpoints, viewpointTotal, cosmetics };
  }

  /* ------------------------------------------------------------------ */
  /* Learning                                                            */
  /* ------------------------------------------------------------------ */

  _onWorld(id, world) {
    this._worldId = id ?? null;
    if (id) {
      /* Read straight off the world object rather than off a system, because
       * both of these are published by the world and neither has an
       * announcement of its own to ride. Order-independent for the same reason
       * every other learner is: the id comes with the payload. */
      this._learn(id, 'seams', Array.isArray(world?.mineralNodes) ? world.mineralNodes.length : 0);
      /* Vellum Ridge's job is racing, and a circuit run at one difficulty is
       * not the same run at another - the world reconfigures its chicanes. So
       * the denominator is circuits x difficulties, both published. */
      const circuits = Array.isArray(world?.circuits) ? world.circuits.length : 0;
      const grades = Array.isArray(world?.difficulties) ? world.difficulties.length : 0;
      this._learn(id, 'races', circuits * grades);
      const wings = Array.isArray(world?.encounters) ? world.encounters.length : 0;
      this._learn(id, 'wings', wings);
      /* The bodies are the void's own denominator and no world publishes them,
       * so this one is read off `SpaceObjectives` - which is the authority for
       * it, not a copy of one. Learned only where wings exist, so the row
       * appears when the player first reaches the void and not before. */
      this._learn(id, 'survey', wings > 0 ? count(this.objectives?.surveyTotal) : 0);
    }
    this._settle();
  }

  /**
   * Set or clear one column of one world's roster.
   *
   * REPLACE, and a zero DELETES. That is the shrink guarantee from the header:
   * a world that stops publishing viewpoints stops having a viewpoint column,
   * rather than keeping a denominator no player can ever fill.
   *
   * @param {string|null|undefined} worldId
   * @param {string} key
   * @param {any} n
   */
  _learn(worldId, key, n) {
    if (typeof worldId !== 'string' || !worldId) return;
    if (!COLUMN_LABEL.has(key) || key === 'deeds') return;
    const total = count(n);
    const roster = this._rosters.get(worldId);
    if (total <= 0) {
      if (roster) {
        delete roster[key];
        if (Object.keys(roster).length === 0) this._rosters.delete(worldId);
      }
      return;
    }
    if (roster) roster[key] = total;
    else this._rosters.set(worldId, { [key]: total });
  }

  /**
   * Credit every deed on this channel that belongs to the world the player is
   * actually in.
   *
   * The world check is not decoration. `market:trade` fires in six worlds and
   * `mount:mounted` in most of them; without it the station's arrival record
   * would be satisfied by a purchase made in the citadel, and the one record a
   * first-run player is meant to complete on the way out of the hub would
   * complete itself somewhere else.
   */
  _credit(event, rows) {
    let moved = false;
    for (const row of rows) {
      if (row.worldId !== this._worldId) continue;
      const key = `${row.worldId}/${row.id}`;
      if (this._deeds.has(key)) continue;
      this._deeds.add(key);
      moved = true;
    }
    if (moved) this._settle();
  }

  /* ------------------------------------------------------------------ */
  /* Numerators                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * The identity sets, read once per board.
   *
   * `Relics.serialize` and friends allocate, and `records()` asks for eighteen
   * worlds' numbers at a time, so reading them eighteen times over would be
   * eighteen copies of the same ledger. Every read is guarded: a system that
   * throws in `serialize` must cost its own column, not the whole board.
   */
  _held() {
    const safe = (fn) => { try { return fn(); } catch { return null; } };
    return {
      relics: safe(() => this.relics?.serialize?.()),
      viewpoints: safe(() => this.viewpoints?.serialize?.()),
      mining: safe(() => this.mining?.serialize?.()),
      trials: this._ledger(this.trials),
      races: this._ledger(this.races),
    };
  }

  /** `{ best: {...} }` from a ledger reader, or an empty map. */
  _ledger(reader) {
    try {
      const out = reader?.read?.();
      return isObj(out?.best) ? out.best : {};
    } catch {
      return {};
    }
  }

  /**
   * How many of one column this player holds in one world.
   *
   * Every branch reads somebody else's identity set. Nothing is stored here and
   * nothing is counted here, which is what makes a charter incapable of
   * disagreeing with the systems it is a summary of.
   */
  _have(worldId, key, held) {
    switch (key) {
      case 'relics': {
        const ids = held.relics?.foundIds?.[worldId];
        if (Array.isArray(ids)) return ids.length;
        /* A save written before `foundIds` existed still carries a count. It is
         * the wrong shape and it is what that player has; refusing to read it
         * would show them zero relics in a world they cleared. */
        return count(held.relics?.found?.[worldId]);
      }
      case 'viewpoints':
        return Array.isArray(held.viewpoints?.worlds?.[worldId])
          ? held.viewpoints.worlds[worldId].length : 0;
      case 'seams':
        return this._prefixCount(held.mining?.taken, `${worldId}/`);
      case 'trials':
        return this._prefixKeys(held.trials, `${worldId}/`);
      case 'races':
        return this._prefixKeys(held.races, `${worldId}/`);
      case 'wings':
        return count(this.objectives?.wingCount);
      case 'survey':
        return count(this.objectives?.surveyCount);
      case 'deeds': {
        let n = 0;
        for (const deed of CHARTER_DEEDS[worldId] ?? []) {
          if (this._deeds.has(`${worldId}/${deed.id}`)) n++;
        }
        return n;
      }
      default:
        return 0;
    }
  }

  /** @param {any} list @param {string} prefix */
  _prefixCount(list, prefix) {
    if (!Array.isArray(list)) return 0;
    let n = 0;
    for (const k of list) if (typeof k === 'string' && k.startsWith(prefix)) n++;
    return n;
  }

  /** @param {any} map @param {string} prefix */
  _prefixKeys(map, prefix) {
    if (!isObj(map)) return 0;
    let n = 0;
    for (const k of Object.keys(map)) if (k.startsWith(prefix)) n++;
    return n;
  }

  /* ------------------------------------------------------------------ */
  /* Settling                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Restore any charter whose record is now complete, and announce.
   *
   * Idempotent for the current state, and NOT across states a load replaced -
   * the distinction `SpaceObjectives.deserialize` draws about its own receipts.
   * A charter already in the set is not re-announced; a charter whose record no
   * longer stands (a save loaded from before it, a world whose content shrank
   * out from under it) is REVOKED, because a receipt that outlives the thing it
   * is a receipt for is how rank gets farmed.
   */
  _settle() {
    const worlds = this.records();
    const won = [];
    for (const rec of worlds) {
      if (rec.complete && !this._charters.has(rec.id)) {
        this._charters.add(rec.id);
        won.push(rec);
      } else if (!rec.complete && this._charters.has(rec.id) && rec.known) {
        /* Only when the record is KNOWN. An unvisited world's record is
         * unknown, not empty, and revoking a charter because the player has not
         * been back since the last reload would delete the objective. */
        this._charters.delete(rec.id);
      }
    }
    for (const rec of won) {
      this.bus?.emit('charter:restored', {
        id: rec.id,
        name: rec.name,
        chartered: this._charters.size,
        total: this.worldTotal,
        rank: this.rank,
      });
      this.bus?.emit('hud:notify', {
        text: `${rec.name} charted — ${this._charters.size}/${this.worldTotal} gateways restored`,
        tone: 'good',
      });
    }
    this._announce(worlds);
  }

  /** Write the board out, but only when it has actually moved. */
  _announce(worlds = this.records()) {
    const sig = `${this._charters.size}|${this._worldId}|`
      + worlds.map((w) => `${w.id}:${w.have}/${w.need}`).join(',');
    if (sig === this._sig) return;
    this._sig = sig;
    const here = worlds.find((w) => w.id === this._worldId) ?? null;
    this.bus?.emit('charter:changed', {
      chartered: this._charters.size,
      total: this.worldTotal,
      rank: this.rank,
      rung: this.charterRank,
      worlds,
      here,
      hint: this._hint(worlds, here),
    });
  }

  /**
   * ONE SENTENCE SAYING WHAT TO DO NEXT.
   *
   * Derived, never authored - every branch reads the same records the rows are
   * drawn from, so the sentence can never disagree with the board above it.
   * The same arrangement, and the same reason, as `SpaceObjectives.hint`.
   *
   * It never returns nothing while there is anything left to do, because the
   * acceptance test for this phase is that a first-run player ALWAYS has a next
   * action. It does fall silent once all eighteen are restored, at which point
   * repeating itself would be furniture the eye stops reading.
   */
  _hint(worlds, here) {
    if (this.worldTotal > 0 && this._charters.size >= this.worldTotal) {
      return 'The Nexus is charted. Every gateway is on the record.';
    }
    /* Where you are, first. A brief that points somewhere else while you are
     * standing in an unfinished world is a brief that makes you travel to obey
     * it. */
    if (here && here.known && !here.complete) {
      const col = here.columns.find((c) => c.have < c.need);
      if (col) {
        const left = col.need - col.have;
        return `${here.name}: ${left} ${left === 1 ? col.noun.replace(/s$/, '') : col.noun} left to complete the record.`;
      }
    }
    const next = worlds.find((w) => w.known && !w.complete);
    if (next) {
      const col = next.columns.find((c) => c.have < c.need);
      return col
        ? `Finish the record at ${next.name} — ${next.need - next.have} left, starting with the ${col.noun}.`
        : `Finish the record at ${next.name}.`;
    }
    const unseen = worlds.find((w) => !w.known);
    if (unseen) {
      return `Chart the Nexus: eighteen gateways, eighteen records. ${unseen.name} has never been surveyed.`;
    }
    return 'Chart the Nexus: every world keeps a record, and completing one restores its charter.';
  }

  /* ------------------------------------------------------------------ */
  /* Persistence                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Plain JSON: two identity sets and the learned rosters.
   *
   * There is deliberately no `have`, no `found` and no `chartered` count. Every
   * one of those is recomputed on read from the systems that own the identity,
   * so a save cannot carry a summary that disagrees with its own detail - which
   * is the rule `SpaceObjectives.serialize` writes down and the defect
   * `Relics.serialize` used to have.
   */
  serialize() {
    const rosters = {};
    for (const [worldId, roster] of this._rosters) {
      const row = {};
      let any = false;
      for (const spec of CHARTER_COLUMNS) {
        const n = count(roster[spec.key]);
        if (n > 0) { row[spec.key] = n; any = true; }
      }
      if (any) rosters[worldId] = row;
    }
    return {
      rosters,
      charters: [...this._charters].sort(),
      deeds: [...this._deeds].sort(),
    };
  }

  /**
   * Restore. REPLACE, not merge - the rule `MountManager`, `Relics` and
   * `Viewpoints` all record: a load has to be able to take progress AWAY, or a
   * player keeps progress the save they loaded does not contain.
   *
   * The charter set is CLAMPED against the records the payload's own rosters
   * and the live systems justify, rather than trusted. A hand-edited
   * localStorage entry claiming all eighteen would otherwise mint the top rank,
   * and `_settle` would never take it back because a restored charter is only
   * revoked for a world whose record is known. Clamping is the same thing
   * `SpaceObjectives.deserialize` does to its four receipts, and for the same
   * reason: the worst a bad receipt can do is cost a re-announcement.
   *
   * @param {any} data
   * @returns {boolean} true when a well-formed payload was applied
   */
  deserialize(data) {
    if (!isObj(data)) return false;
    this._rosters.clear();
    this._charters.clear();
    this._deeds.clear();

    if (isObj(data.rosters)) {
      for (const worldId of Object.keys(data.rosters)) {
        const row = data.rosters[worldId];
        if (!isObj(row)) continue;
        for (const spec of CHARTER_COLUMNS) this._learn(worldId, spec.key, row[spec.key]);
      }
    }
    if (Array.isArray(data.deeds)) {
      for (const key of data.deeds) if (typeof key === 'string' && key) this._deeds.add(key);
    }

    /* The clamp. Every claimed charter is re-earned against the record it is a
     * receipt for; anything that does not stand up is dropped on the floor. */
    if (Array.isArray(data.charters)) {
      const held = this._held();
      for (const id of data.charters) {
        if (typeof id !== 'string' || !id) continue;
        if (this.record(id, held).complete) this._charters.add(id);
      }
    }

    this._settle();
    return true;
  }

  dispose() {
    for (const off of this._offs) off?.();
    this._offs.length = 0;
    this._rosters.clear();
    this._charters.clear();
    this._deeds.clear();
  }
}
