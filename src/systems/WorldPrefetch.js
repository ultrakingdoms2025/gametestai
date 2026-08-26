/**
 * Which world to generate next, and when - the lazy replacement for the boot's
 * eighteen-world background chain.
 *
 * ── The defect this exists to close ───────────────────────────────────────
 *
 * `scheduleBackgroundBuilds` used to generate and shader-warm EVERY registered
 * world the moment the player entered the first one: seventeen builds back to
 * back, on the main thread, in the player's frames. Measured on the
 * production bundle (RTX 5080, warm shader cache, `frame-gaps.mjs --frames`):
 * the chain ran for 93.5 s, and 46 s of that wall clock was spent inside 1,009
 * frames over 24 ms - 234 of them over 50 ms, 45 over 100 ms, twelve over 250.
 * Medieval alone is an 11.8 s generation that yields only between its coarse
 * phases. The owner's report was "loading all the worlds effectively freezes
 * the desktop all the time", and that is a literal description of the design:
 * a top-end desktop was choppy for the first minute and a half of every
 * session, and a slower one for several.
 *
 * `--gl` attributed only ~5.5 s of the 53 s of gap time to the driver
 * (getProgramInfoLog 2.7 s, getShaderInfoLog 1.7 s, texSubImage2D 0.5 s); the
 * CPU profile put the rest in generation - physics raycast settles, terrain
 * noise, three's material-to-program resolution. Nothing about the chain's
 * SLICING was wrong; what was wrong was doing all of it, up front, for worlds
 * the player might never walk towards.
 *
 * ── What replaces it ──────────────────────────────────────────────────────
 *
 * A world is prepared when the player is about to need it: when they come
 * within `PREFETCH_RANGE` of a gateway that leads to it. One at a time,
 * nearest first, through exactly the per-world step the chain used to run
 * (build, claim the gateways, sliced program warm, sliced preview warm,
 * release). The station's gateways stand ~54 m from the plaza centre, so a
 * player crossing the plaza collects one or two worlds' worth of work as they
 * pass each dais, instead of seventeen worlds' worth on arrival - and a player
 * who never leaves the plaza pays for nothing.
 *
 * `PREFETCH_RANGE` is just past `PREVIEW_RANGE` (40 m, `Portals.js`): the
 * disc's window needs the destination built and warmed before it can show
 * anything, so the honest minimum is "start before the preview would". Walking
 * from 48 m to the dais takes ~10 s at 4.6 m/s and medieval takes ~20 s to
 * prepare on a fast desktop, so an eager walker meets a STABILISING disc for a
 * few seconds and then walks through it - `Portals.enter` already builds an
 * unbuilt destination behind the warp's white-out, exactly as it always has
 * for the maze.
 *
 * ── The invariant that must hold across all of this ──────────────────────
 *
 * A gateway's preview must never be drawn un-warmed: that first draw links the
 * destination's whole preview program set inside one gameplay frame, measured
 * at 8-14 s. Under the old chain it could not happen, because every
 * destination was warmed before the player could reach any gateway. Under lazy
 * preparation it CAN: a player can enter medieval before its preparation
 * finished, come back, and stand two metres from a gateway whose destination
 * is built but whose preview programs were never linked. So `update` HOLDS
 * every gateway whose destination has not been prepared - the same
 * `_warmPending` claim the warm itself takes - on every frame, before any
 * distance is measured. Held gateways keep their stabilising look and their
 * `enter` still works; the claim comes off inside `prepare`'s own `finally`.
 *
 * ── What is deliberately unchanged ───────────────────────────────────────
 *
 * `?prefetch=all` runs the old eager chain, because the instruments need it:
 * `frame-gaps.mjs` measures world entry after `worlds:all-ready`, and that
 * event only means anything if every world was prepared. The default a player
 * gets is this file.
 *
 * Pure and node-importable: no THREE, no DOM. `scripts/tests/world-prefetch
 * .test.mjs` drives it with plain objects.
 */

/** Metres from a gateway at which its destination starts preparing. */
export const PREFETCH_RANGE = 48;

/**
 * The nearest gateway within `range` whose destination is not yet prepared.
 *
 * Durable worlds first among those in range, then volatile ones. The maze is
 * volatile - its build is thrown away on entry and only its warm programs
 * survive - and its gateway happens to be the nearest to the station's spawn:
 * measured, a stationary player's very first preparation was a 12.6 s maze
 * build (first KTX2 fetch included) that buys no reusable world, while the
 * citadel 20 m further off had to wait. Same rule the eager chain sorts by,
 * applied to the candidates in reach rather than to all seventeen.
 *
 * @param {Array<{target?:string, position?:{x:number,y:number,z:number}}>} portals
 * @param {{x:number,y:number,z:number}|null} pos the player
 * @param {(id:string)=>boolean} isPrepared
 * @param {number} [range]
 * @param {(id:string)=>boolean} [isVolatile]
 * @returns {string|null} a world id
 */
export function pickPrefetchTarget(portals, pos, isPrepared, range = PREFETCH_RANGE, isVolatile = () => false) {
  if (!pos || !portals) return null;
  let best = null;
  let bestD = Infinity;
  let bestVolatile = true;
  for (const p of portals) {
    const id = p?.target;
    const at = p?.position;
    if (!id || !at || isPrepared(id)) continue;
    const d = Math.hypot(at.x - pos.x, at.y - pos.y, at.z - pos.z);
    if (d >= range) continue;
    const v = !!isVolatile(id);
    // A durable candidate beats any volatile one; within a class, nearest wins.
    if (best !== null && (v && !bestVolatile || (v === bestVolatile && d >= bestD))) continue;
    bestD = d;
    best = id;
    bestVolatile = v;
  }
  return best;
}

export class WorldPrefetch {
  /**
   * @param {object} ctx
   * @param {{portals: any[], holdPreviews?: (id:string)=>void}} ctx.portals
   * @param {{position: {x:number,y:number,z:number}}} ctx.player
   * @param {(id:string)=>Promise<void>} ctx.prepare the per-world step; must
   *   claim and release the gateways itself
   * @param {(id:string)=>boolean} [ctx.isVolatile] see `pickPrefetchTarget`
   * @param {number} [ctx.range]
   */
  constructor({ portals, player, prepare, isVolatile = () => false, range = PREFETCH_RANGE }) {
    this.portals = portals;
    this.player = player;
    this.prepare = prepare;
    this.isVolatile = isVolatile;
    this.range = range;
    /** @type {Map<string, Promise<void>>} started (and finished) preparations */
    this.started = new Map();
    /** @type {Promise<void>|null} the one in flight */
    this.inFlight = null;
    /** Off switch, for `?prefetch=off` and for tests. */
    this.enabled = true;
  }

  /** Has preparation been started for this world (finished or not)? */
  isPrepared(id) {
    return this.started.has(id);
  }

  /**
   * Record a preparation that something else started - the eager chain, or a
   * portal entry - so this never starts a second one.
   * @param {string} id
   * @param {Promise<void>} [promise]
   */
  claim(id, promise = Promise.resolve()) {
    if (!this.started.has(id)) this.started.set(id, promise);
  }

  /**
   * Start preparing `id` now. One at a time: a second request while one is in
   * flight is remembered by `started` and will simply find itself already
   * done when the poller next looks. Returns the preparation's promise.
   * @param {string} id
   */
  request(id) {
    const have = this.started.get(id);
    if (have) return have;
    /* Called synchronously, so the build starts in this task - the eager chain
     * relies on that ordering, and a poller that only queued a microtask
     * would let one more frame draw before the hold below it lands. A throw
     * is a failed preparation, not a broken poller. */
    let started;
    try {
      started = Promise.resolve(this.prepare(id));
    } catch (err) {
      started = Promise.reject(err);
    }
    const p = started
      .catch((err) => { console.error(`[prefetch] preparing "${id}" failed:`, err); })
      .finally(() => {
        if (this.inFlight === p) this.inFlight = null;
      });
    this.started.set(id, p);
    this.inFlight = p;
    return p;
  }

  /**
   * One frame: hold every unprepared gateway, then start the nearest one in
   * range if nothing is in flight. Cheap - one distance per gateway - so it
   * runs every frame rather than on a timer, which is what makes the hold
   * land before the first preview frame of a newly entered world.
   */
  update() {
    if (!this.enabled) return;
    const list = this.portals?.portals ?? [];
    for (const p of list) {
      const id = p?.target;
      if (!id || this.started.has(id)) continue;
      if (!p._warmPending) this.portals.holdPreviews?.(id);
    }
    if (this.inFlight) return;
    const id = pickPrefetchTarget(list, this.player?.position ?? null, (w) => this.started.has(w), this.range, this.isVolatile);
    if (id) this.request(id);
  }
}

export default WorldPrefetch;
