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

export class GenPool {
  constructor({ size = defaultSize() } = {}) {
    this.size = size;
    /** @type {{worker: Worker, busy: number}[]} */
    this._workers = [];
    /** @type {Map<number, {resolve: Function, reject: Function}>} */
    this._pending = new Map();
    this._nextId = 1;
    /** null = not yet attempted, false = unavailable, true = running on workers. */
    this._available = null;
    this._inlineJobs = null;
    this.stats = { jobs: 0, inline: 0, workerMs: 0 };
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
        worker.onerror = (err) => {
          console.warn('[GenPool] worker error, falling back to inline:', err.message ?? err);
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
    entry.slot.busy--;
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(new Error(msg.error));
  }

  /**
   * Run a job, on a worker when possible and inline when not.
   * @param {string} kind key into the job registry
   * @param {object} payload structured-cloneable job description
   * @returns {Promise<object>} the job's buffers
   */
  async run(kind, payload) {
    this.stats.jobs++;
    if (!this._spawn()) return this._runInline(kind, payload);

    // Least-busy slot, so a long job does not park later ones behind it.
    let slot = this._workers[0];
    for (const s of this._workers) if (s.busy < slot.busy) slot = s;

    const id = this._nextId++;
    slot.busy++;
    const t0 = performance.now();
    try {
      const result = await new Promise((resolve, reject) => {
        this._pending.set(id, { resolve, reject, slot });
        slot.worker.postMessage({ id, kind, payload });
      });
      this.stats.workerMs += performance.now() - t0;
      return result;
    } catch (err) {
      console.warn(`[GenPool] job "${kind}" failed on a worker, retrying inline:`, err.message);
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

  dispose() {
    for (const s of this._workers) s.worker.terminate();
    this._workers.length = 0;
    for (const p of this._pending.values()) p.reject(new Error('[GenPool] disposed'));
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
