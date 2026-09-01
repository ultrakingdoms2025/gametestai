import * as THREE from 'three';

/**
 * The drone hack: brief 5.3's splice, and the one contest that asks you to STOP.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE VERB
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every contest the framework runs today is a race: swim, ski, run, rooftop,
 * tennis, and the test-fire butts against their clock. All six reward MOVING,
 * and standing still is only ever how you lose one.
 *
 * A splice inverts that. Each relay node in the chain has to be HELD - you
 * stand inside its field and stay there while the splice charges - and the
 * opposition is a trace clock that does not stop for you. Step out and the
 * charge does not pause, it DRAINS, at a published multiple of the rate it was
 * earned. That is a second verb, and it is the whole reason this is a module
 * and not a rooftop route with different rings.
 *
 * The economics of the chain are the design: every crack hands a few seconds
 * back to the trace, so a long chain is survivable while a slow one is not.
 * The bonus is always smaller than a node costs to hold, which is what keeps
 * the trace a real opponent rather than decoration - see
 * `minigame-hack.test.mjs`, which states that as an assertion.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  A FIELD IS A DISC AND A BAND
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Same rule, and the same recorded defect, as `DeliveryRun`: a planar radius
 * alone charges a node for anybody standing on the walkway above it. The
 * station's promenade deck is 10 m over its floor and the deck under it is
 * where these nodes stand, so the vertical band is not a nicety - it is the
 * difference between a contest and a place you can complete by being upstairs.
 */

/**
 * The id the finish event carries as `target`/`id`.
 *
 * `scripts/quest-vocab.mjs` scrapes this constant by name - the regex is
 * `export const (\w*GAME_ID) = '([a-z0-9_]+)'` - follows `main.js`'s
 * `registerGame` call to find which kind runs this module, and only then will
 * it offer `drone_hack_won` / `drone_hack_lost` as legal `minigame` targets.
 */
export const HACK_GAME_ID = 'drone_hack';

/** Seconds of "on your marks". Short - you are already at the access node. */
const COUNTDOWN_S = 3.0;

/** Fallbacks for a venue that publishes an incomplete config. */
const DEFAULT_HOLD_R = 3.0;
const DEFAULT_BAND = 3.0;
const DEFAULT_HOLD_S = 3.5;
/** Charge lost per second out of the field, as a multiple of the gain rate. */
const DEFAULT_DECAY = 1.8;
/** Seconds the trace returns per node cracked. */
const DEFAULT_BONUS = 6;
const DEFAULT_SECONDS = 75;

/** How far from the access node a splice may be started. */
const ACCESS_R = 6.0;
/** Vertical band on that gate. */
const ACCESS_BAND = 3.0;

/** mm:ss.t */
function clockText(t) {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
}

/**
 * Read the venue's node chain into the shape this module runs.
 *
 * Null rather than a throw for anything unusable, because `MinigameManager`
 * treats a null factory result as "not available" and a thrown one as an error
 * it logs - and a world shipping a malformed descriptor is the first case.
 *
 * @param {any} venue
 * @returns {{nodes:Array<object>, holdR:number, band:number, holdS:number,
 *   decay:number, bonus:number, limit:number}|null}
 */
export function readNodes(venue) {
  const cfg = venue?.config;
  if (!cfg || typeof cfg !== 'object') return null;
  const raw = Array.isArray(cfg.nodes) ? cfg.nodes : null;
  if (!raw || !raw.length) return null;

  const nodes = [];
  for (const n of raw) {
    const x = Number(n?.x);
    const y = Number(n?.y);
    const z = Number(n?.z);
    if (![x, y, z].every(Number.isFinite)) continue;
    nodes.push({
      id: typeof n?.id === 'string' && n.id ? n.id : `node-${nodes.length}`,
      label: typeof n?.label === 'string' && n.label ? n.label : `Relay ${nodes.length + 1}`,
      x, y, z,
    });
  }
  if (!nodes.length) return null;

  const num = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);
  return {
    nodes,
    holdR: num(cfg.holdR, DEFAULT_HOLD_R),
    band: num(cfg.band, DEFAULT_BAND),
    holdS: num(cfg.holdS, DEFAULT_HOLD_S),
    /* Decay may legitimately be zero - a venue that wants a forgiving splice -
     * so it is read as "finite and not negative" rather than through `num`. */
    decay: Number.isFinite(Number(cfg.decay)) && Number(cfg.decay) >= 0 ? Number(cfg.decay) : DEFAULT_DECAY,
    bonus: Number.isFinite(Number(cfg.bonus)) && Number(cfg.bonus) >= 0 ? Number(cfg.bonus) : DEFAULT_BONUS,
    limit: num(cfg.seconds, DEFAULT_SECONDS),
  };
}

export class DroneHack {
  /**
   * @param {object} venue the manager's validated venue record
   * @param {{player?:any, bus?:any, input?:any, worldManager?:any, scene?:any}} ctx
   */
  constructor(venue, ctx = {}) {
    this.id = HACK_GAME_ID;
    this.venue = venue;
    this.bus = ctx.bus ?? null;
    this.player = ctx.player ?? null;

    this.chain = readNodes(venue);
    if (!this.chain) throw new Error('drone hack: the venue publishes no usable relay chain');

    /** Index of the node currently lit. */
    this.node = 0;
    /** Nodes spliced. */
    this.cracked = 0;
    /** Seconds of hold banked against the live node, 0..holdS. */
    this.charge = 0;
    /** Seconds left before the trace completes. */
    this.trace = this.chain.limit;
    this.clock = 0;
    /** True between `begin` and `dispose`. Nothing charges outside it. */
    this._live = false;

    this._host = ctx.worldManager?.active?.group ?? ctx.scene ?? this.player?.scene ?? null;
    /** @type {Map<string, THREE.Object3D>} */
    this._pips = new Map();
    this._pipGeo = null;
    this._litMat = null;
    this._darkMat = null;
    this._buildPips();
  }

  get countdown() {
    return COUNTDOWN_S;
  }

  /** The node currently lit, or null once the chain is spliced. */
  get target() {
    return this.chain.nodes[this.node] ?? null;
  }

  /**
   * One pip per node, because the CHAIN is the map.
   *
   * Unlike the delivery run - where showing every bay would give away a route
   * the contest is about being sent down - a splice is a fixed installation and
   * the player is meant to be able to plan it. Lit pip = live node; dark pip =
   * one already spliced or not yet reached. Two materials and one geometry for
   * the whole chain, disposed with the run.
   *
   * No host group is not an error: it is the headless case. Same contract as
   * `TestFire._buildLamps`.
   */
  _buildPips() {
    if (!this._host || typeof this._host.add !== 'function') return;
    this._pipGeo = new THREE.OctahedronGeometry(0.34, 0);
    this._litMat = new THREE.MeshBasicMaterial({ color: 0x52e9ff, toneMapped: false });
    this._darkMat = new THREE.MeshBasicMaterial({
      color: 0x2a4a58, toneMapped: false, transparent: true, opacity: 0.5,
    });
    for (const n of this.chain.nodes) {
      const m = new THREE.Mesh(this._pipGeo, this._darkMat);
      m.position.set(n.x, n.y + 1.9, n.z);
      m.name = `hack-pip-${this.venue.id}-${n.id}`;
      this._host.add(m);
      this._pips.set(n.id, m);
    }
    this._relight();
  }

  _relight() {
    if (!this._pips.size) return;
    for (let i = 0; i < this.chain.nodes.length; i++) {
      const pip = this._pips.get(this.chain.nodes[i].id);
      if (!pip) continue;
      pip.material = i === this.node && this._live ? this._litMat : this._darkMat;
      pip.visible = i >= this.node;
    }
  }

  begin(elapsed) {
    void elapsed;
    this.clock = 0;
    this._live = true;
    this._relight();
    this.bus?.emit('hack:started', {
      venueId: this.venue.id,
      label: this.venue.label,
      nodes: this.chain.nodes.length,
      seconds: this.chain.limit,
    });
    this._announce();
  }

  _announce() {
    const n = this.target;
    if (!n) return;
    this.bus?.emit('hud:notify', {
      text: `${n.label} — hold ${this.chain.holdS.toFixed(1)} s inside the field`,
      tone: 'info',
    });
  }

  /** Is the body inside the live node's field? Disc plus vertical band. */
  _inField(n) {
    const b = this.player?.position;
    if (!b || !n) return false;
    if (Math.abs(b.y - n.y) > this.chain.band) return false;
    return Math.hypot(b.x - n.x, b.z - n.z) <= this.chain.holdR;
  }

  /**
   * @param {number} dt fixed step
   * @param {number} clock seconds since the lights went out
   * @returns {object|null} an outcome ends the contest
   */
  fixedUpdate(dt, clock) {
    if (!this._live) return null;
    this.clock = clock;

    const n = this.target;
    if (!n) return this._win();

    if (this._inField(n)) {
      this.charge += dt;
      if (this.charge >= this.chain.holdS) this._crack(n);
    } else {
      /* DRAINS, not pauses. See the class header: a charge that survives
       * leaving turns the contest into "visit six points", which is the
       * delivery run with a different noun on it. */
      this.charge = Math.max(0, this.charge - dt * this.chain.decay);
    }

    /* The trace runs down AFTER the charge is resolved, so a splice that
     * completes on the same step the trace expires is a win. A contest that
     * could be lost on the frame it was won would be unarguable and unfair,
     * and it is exactly the sort of thing that only shows up in production. */
    this.trace -= dt;
    if (this.node >= this.chain.nodes.length) return this._win();
    if (this.trace <= 0) return this._lose();
    return null;
  }

  _crack(n) {
    this.node++;
    this.cracked++;
    this.charge = 0;
    this.trace += this.chain.bonus;
    this._relight();
    this.bus?.emit('hack:node', {
      venueId: this.venue.id,
      node: n.id,
      cracked: this.cracked,
      of: this.chain.nodes.length,
      trace: this.trace,
      time: this.clock,
    });
    if (this.node < this.chain.nodes.length) this._announce();
  }

  /**
   * A FIELD OF ONE. `total: 1` is the whole of it, and it is not cosmetic.
   *
   * The splice is a stand-still puzzle against a countdown. There is no rival,
   * no grid and nobody to be second to - so the outcome carries `total: 1`, and
   * `MinigameUI` suppresses the PLACE stat entirely on a field of one rather
   * than printing "PLACE 2nd" over a contest nothing else entered. `place` is
   * 1 in both branches for the same reason: the player is the only entrant, and
   * whether they beat the trace is `won`, never a position.
   *
   * The two delivery rounds (`DeliveryRun`) and the archery butts (`TestFire`)
   * are the same shape and say so the same way.
   */
  _win() {
    this._live = false;
    return {
      won: true,
      place: 1,
      total: 1,
      score: this.cracked,
      scoreLabel: `${this.cracked}/${this.chain.nodes.length} relays in ${clockText(this.clock)}`,
      detail: `${clockText(Math.max(0, this.trace))} ahead of the trace`,
    };
  }

  _lose() {
    this._live = false;
    return {
      won: false,
      place: 1,
      total: 1,
      score: this.cracked,
      scoreLabel: `${this.cracked}/${this.chain.nodes.length} relays`,
      detail: `traced at ${this.target?.label ?? 'the last relay'}`,
    };
  }

  snapshot() {
    const n = this.target;
    return {
      rows: [
        { k: 'TRACE', v: clockText(Math.max(0, this.trace)), tone: this.trace <= 10 ? 'warn' : null },
        { k: 'NODE', v: n ? n.label : 'clear' },
        { k: 'SPLICE', v: `${Math.round(Math.min(1, this.charge / this.chain.holdS) * 100)}%` },
      ],
      progress: Math.max(0, Math.min(1, this.cracked / this.chain.nodes.length)),
    };
  }

  /** Idempotent: the manager tears down on quit, death and world change too. */
  dispose() {
    this._live = false;
    for (const pip of this._pips.values()) pip.parent?.remove(pip);
    this._pips.clear();
    this._pipGeo?.dispose?.();
    this._litMat?.dispose?.();
    this._darkMat?.dispose?.();
    this._pipGeo = null;
    this._litMat = null;
    this._darkMat = null;
  }
}

/**
 * The factory `minigames.registerGame('hack', ...)` calls.
 *
 * Two gates, in this order:
 *
 *  1. **A usable chain.** No nodes, no contest - null, not a throw.
 *  2. **At the access node.** The venue disc has to hold the WHOLE chain or
 *     `MinigameManager`'s `LEAVE_GRACE_S` abandons a run in progress, so the
 *     disc cannot be the start gate. This is, and it NAMES the node rather than
 *     refusing blankly - `RooftopTrial`'s recorded reason: a bare "not
 *     available" over a working venue reads as a broken world.
 *
 * @param {object} venue
 * @param {object} ctx
 * @returns {DroneHack|null}
 */
export function createDroneHack(venue, ctx = {}) {
  const chain = readNodes(venue);
  if (!chain) return null;

  const first = chain.nodes[0];
  const p = ctx.player?.position;
  if (p && first) {
    const d = Math.hypot(p.x - first.x, p.z - first.z);
    if (d > ACCESS_R || Math.abs(p.y - first.y) > ACCESS_BAND) {
      ctx.bus?.emit('hud:notify', {
        text: `${venue.label ?? 'The splice'} starts at ${first.label}, ${Math.round(d)} m away`,
        tone: 'warn',
      });
      return null;
    }
  }

  try {
    return new DroneHack(venue, ctx);
  } catch (err) {
    console.warn('[drone-hack] the splice failed to build:', err?.message ?? err);
    return null;
  }
}

export default createDroneHack;
