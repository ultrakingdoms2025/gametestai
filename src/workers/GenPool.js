/**
 * A small pool of generation workers, plus the fallback for when there are none.
 *
 * Why a pool and not one worker: terrain sampling is the part of world building
 * that grows with world *area*, so it is also the part that most wants more than
 * one core. Five worlds' worth of ground is five independent jobs, and a single
 * worker would serialise them for no reason.
 *
 * Why a fallback: `new Worker(..., {type:'module'})` is not universally
 * available, a page served from `file://` cannot spawn one at all, and the
 * headless review harness runs in neither. Rather than have world generation
 * fail in those cases, `run()` quietly executes the identical job function on
 * the main thread. It is slower - it is exactly the behaviour we are trying to
 * get away from - but it is never wrong, and every caller is already async.
 */

/** Leave a core for the render thread, and do not spin up more than the work needs. */
function defaultSize() {
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  return Math.max(1, Math.min(4, cores - 1));
}

/**
 * How long a job may go unanswered before it is failed and retried inline.
 *
 * Terrain jobs measure 100-800 ms in this game (medieval's is the longest).
 * Ten seconds is therefore an order of magnitude of headroom on the slowest
 * one, on the slowest hardware, and is only ever reached by a job that is
 * never coming back. It is a FUSE, not a deadline: blowing it costs a
 * main-thread re-run of a job that would otherwise have hung the world build
 * for ever, which is strictly better than the alternative.
 */
const JOB_TIMEOUT_MS = 10_000;

/**
 * Idle time after which the pool releases its workers.
 *
 * `dispose()` had NO CALLERS, so up to four module workers were held for the
 * whole session after the last terrain world was built - and only four of the
 * seventeen worlds use terrain jobs at all. Under the lazy `WorldPrefetch` a
 * player may never approach any of them.
 *
 * Sixty seconds rather than something eager: the cost of getting this wrong is
 * a module-graph parse on the next terrain build, which is exactly the stall
 * the pool exists to avoid paying repeatedly. A minute is longer than any
 * plausible gap between the worlds of one prefetch burst (the whole eager
 * 17-world chain used to run in 93.5 s and the lazy one prepares one world at
 * a time), so in practice this fires when the player has settled somewhere,
 * and the respawn it costs lands behind a loading screen.
 */
const IDLE_RELEASE_MS = 60_000;

export class GenPool {
  constructor({ size = defaultSize(), jobTimeoutMs = JOB_TIMEOUT_MS, idleReleaseMs = IDLE_RELEASE_MS } = {}) {
    this.size = size;
    this.jobTimeoutMs = jobTimeoutMs;
    this.idleReleaseMs = idleReleaseMs;
    this._idleTimer = null;
    /** @type {{worker: Worker, busy: number}[]} */
    this._workers = [];
    /** @type {Map<number, {resolve: Function, reject: Function}>} */
    this._pending = new Map();
    this._nextId = 1;
    /** null = not yet attempted, false = unavailable, true = running on workers. */
    this._available = null;
    this._inlineJobs = null;
    this.stats = { jobs: 0, inline: 0, workerMs: 0, workerErrors: 0, timeouts: 0, releases: 0 };
  }

  /** True once at least one worker has been created successfully. */
  get usingWorkers() {
    return this._available === true;
  }

  _spawn() {
    if (this._available !== null) return this._available;
    if (typeof Worker === 'undefined') {
      this._available = false;
      return false;
    }
    try {
      for (let i = 0; i < this.size; i++) {
        // `new URL(..., import.meta.url)` is the form bundlers detect, so the
        // worker gets built and hashed alongside everything else.
        const worker = new Worker(new URL('./GenWorker.js', import.meta.url), {
          type: 'module',
          name: `gen-${i}`,
        });
        worker.onmessage = (e) => this._settle(e.data);
        /* ── A WORKER THAT FAILS TO LOAD USED TO HANG THE WHOLE GAME ────────
         *
         * This handler logged and returned. Every promise in `_pending` is
         * settled by a MESSAGE FROM THE WORKER and by nothing else, so a
         * module-load failure, a 404 on the hashed GenWorker chunk, or an
         * uncaught throw inside the worker left `run()` permanently pending,
         * `slot.busy` permanently incremented, and MedievalWorld,
         * CitadelWorld and PlanetWorld awaiting a terrain job that would never
         * arrive. The player sees a black loading screen and no error, for
         * ever. The `catch` in `run()` whose comment says it "retries inline"
         * could never fire for this case, because nothing ever rejected.
         *
         * `onerror` fires for a load failure with no `id` to key on, so the
         * rejection has to be by WORKER: every pending job on this worker
         * fails, and the pool marks itself unavailable so `_spawn()` refuses
         * from here on and every job - the failed ones through `run()`'s catch,
         * and every later one through `_spawn()` - goes down `_runInline`.
         *
         * Marking the whole pool unavailable rather than dropping the one
         * worker is deliberate: these workers are four copies of one module,
         * so whatever stopped one loading has stopped all four, and a pool
         * that limped on with three would just hang three-quarters as often. */
        worker.onerror = (err) => {
          this.stats.workerErrors++;
          const why = err?.message ?? err?.type ?? String(err);
          console.warn('[GenPool] worker error, falling back to inline:', why);
          this._failWorker(worker, `[GenPool] worker failed: ${why}`);
        };
        /* Same hole, different door: a result that cannot be structured-cloned
         * back arrives as `messageerror` and never as `message`. */
        worker.onmessageerror = () => {
          this.stats.workerErrors++;
          console.warn('[GenPool] worker message could not be deserialised, falling back to inline');
          this._failWorker(worker, '[GenPool] worker message could not be deserialised');
        };
        this._workers.push({ worker, busy: 0 });
      }
      this._available = this._workers.length > 0;
    } catch (err) {
      console.warn('[GenPool] workers unavailable, generating on the main thread:', err?.message ?? err);
      this._available = false;
    }
    return this._available;
  }

  _settle(msg) {
    const entry = this._pending.get(msg.id);
    if (!entry) return;
    this._pending.delete(msg.id);
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.slot.busy--;
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(new Error(msg.error));
    this._armIdleRelease();
  }

  /**
   * Fail every job in flight on one worker, and take the pool out of service.
   *
   * @param {Worker} worker
   * @param {string} why
   */
  _failWorker(worker, why) {
    /* Unavailable FIRST: `run()`'s catch calls `_runInline` directly, but a
     * job that arrives between the failure and the last rejection must not be
     * posted to a worker that is not answering. */
    this._available = false;
    for (const [id, entry] of [...this._pending]) {
      if (entry.slot.worker !== worker) continue;
      this._pending.delete(id);
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.slot.busy--;
      entry.reject(new Error(why));
    }
  }

  /**
   * Give the workers back when nothing has needed them for a while.
   *
   * Only arms when the pool is genuinely idle; any job in flight cancels it,
   * and `run()` re-arms after each one finishes. `_available` back to null
   * rather than false, so the next terrain build spawns a fresh pool instead
   * of falling to the main thread for the rest of the session.
   */
  _armIdleRelease() {
    if (this._idleTimer !== null) { clearTimeout(this._idleTimer); this._idleTimer = null; }
    if (!this.idleReleaseMs || this._available !== true || this._pending.size) return;
    if (typeof setTimeout !== 'function') return;
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null;
      if (this._pending.size || this._available !== true) return;
      this.stats.releases++;
      for (const s of this._workers) s.worker.terminate();
      this._workers.length = 0;
      this._available = null;
    }, this.idleReleaseMs);
    /* Node keeps the process alive for a pending timer; a test suite that
     * built a terrain world would otherwise hang for a minute at the end. */
    this._idleTimer?.unref?.();
  }

  /**
   * Run a job, on a worker when possible and inline when not.
   * @param {string} kind key into the job registry
   * @param {object} payload structured-cloneable job description
   * @returns {Promise<object>} the job's buffers
   */
  async run(kind, payload) {
    this.stats.jobs++;
    if (this._idleTimer !== null) { clearTimeout(this._idleTimer); this._idleTimer = null; }
    if (!this._spawn()) return this._runInline(kind, payload);

    // Least-busy slot, so a long job does not park later ones behind it.
    let slot = this._workers[0];
    for (const s of this._workers) if (s.busy < slot.busy) slot = s;

    const id = this._nextId++;
    slot.busy++;
    const t0 = performance.now();
    try {
      const result = await new Promise((resolve, reject) => {
        /* THE FUSE. `onerror` covers a worker that failed loudly; this covers
         * one that went quiet - a job the worker dropped, a `postMessage` that
         * never arrived, a worker the browser killed under memory pressure.
         * Without it those are indistinguishable from a slow job and the world
         * build waits for ever. @see JOB_TIMEOUT_MS */
        const timer = (this.jobTimeoutMs && typeof setTimeout === 'function')
          ? setTimeout(() => {
            const entry = this._pending.get(id);
            if (!entry) return;
            this.stats.timeouts++;
            this._pending.delete(id);
            entry.slot.busy--;
            entry.reject(new Error(`[GenPool] job "${kind}" did not answer in ${this.jobTimeoutMs} ms`));
          }, this.jobTimeoutMs)
          : null;
        /* Deliberately NOT `unref`ed, unlike the idle timer below. A job is in
         * flight and something is awaiting it; a fuse that let the event loop
         * drain would turn the hang this exists to prevent into a silent
         * exit under `node --test`. */
        this._pending.set(id, { resolve, reject, slot, timer });
        slot.worker.postMessage({ id, kind, payload });
      });
      this.stats.workerMs += performance.now() - t0;
      this._armIdleRelease();
      return result;
    } catch (err) {
      console.warn(`[GenPool] job "${kind}" failed on a worker, retrying inline:`, err.message);
      this._armIdleRelease();
      return this._runInline(kind, payload);
    }
  }

  async _runInline(kind, payload) {
    this.stats.inline++;
    if (!this._inlineJobs) {
      this._inlineJobs = (await import('./jobs/TerrainJob.js')).JOBS;
    }
    const job = this._inlineJobs[kind];
    if (!job) throw new Error(`[GenPool] unknown job "${kind}"`);
    return job(payload).buffers;
  }

  /**
   * Give every worker back and fail anything in flight.
   *
   * Called from `WorldManager.dispose()` (page teardown / hot reload) and,
   * for the ordinary case, by the idle release above - `dispose()` had no
   * callers at all when this was written, which is how four module workers
   * came to be held for a whole session after the last terrain build.
   */
  dispose() {
    if (this._idleTimer !== null) { clearTimeout(this._idleTimer); this._idleTimer = null; }
    for (const s of this._workers) s.worker.terminate();
    this._workers.length = 0;
    for (const p of this._pending.values()) {
      if (p.timer !== null && p.timer !== undefined) clearTimeout(p.timer);
      p.reject(new Error('[GenPool] disposed'));
    }
    this._pending.clear();
    this._available = null;
  }
}

/**
 * Process-wide pool.
 *
 * Worlds are built one at a time from `WorldManager`, and the pool is shared so
 * the workers are spawned once for the session rather than per world - spawning
 * costs a module graph parse each time, which is exactly the kind of stall this
 * is here to remove.
 * @type {GenPool}
 */
export const genPool = new GenPool();
