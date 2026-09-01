import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * WHAT HAPPENS WHEN A GENERATION WORKER NEVER ANSWERS?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DEFECT: A BLACK LOADING SCREEN WITH NO ERROR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `GenPool.run` registers a promise in `_pending` and that promise is settled
 * by a MESSAGE FROM THE WORKER and by nothing else. `worker.onerror` logged a
 * warning and returned. So a module-load failure - a 404 on the hashed
 * `GenWorker` chunk after a deploy, a CSP refusal, an uncaught throw at the top
 * of the worker module - left `run()` permanently pending, `slot.busy`
 * permanently incremented, and `MedievalWorld`, `CitadelWorld` and
 * `PlanetWorld` awaiting a terrain job that would never arrive. The player sees
 * a loading screen that never finishes and a console warning nobody reads.
 *
 * The `catch` in `run()` whose comment says it "retries inline" could not fire
 * for this case, because nothing ever rejected. The fallback existed, was
 * correct, and was unreachable.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THIS IS DRIVEN AGAINST A FAKE WORKER AND NOT AGAINST THE REAL ONE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The failures worth testing are the ones a real worker cannot be asked to
 * perform on demand: refusing to load, going silent, and answering with
 * something that will not deserialise. A fake `Worker` global is the only way
 * to hold each of those still. Everything under test - the pending map, the
 * busy counter, the fuse, the fallback - is `GenPool`'s own code, and
 * `_runInline` runs the identical shipping job function on the main thread.
 */

const { GenPool } = await import('../../src/workers/GenPool.js');

/** A worker that does precisely what the test tells it to and nothing else. */
class FakeWorker {
  constructor() {
    FakeWorker.live.push(this);
    this.posted = [];
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
  }

  postMessage(msg) {
    this.posted.push(msg);
    FakeWorker.behave?.(this, msg);
  }

  terminate() { this.terminated = true; }

  /** Answer a job the way the real worker does. */
  reply(id, result) { this.onmessage?.({ data: { id, ok: true, result } }); }

  static reset(behave = null) {
    FakeWorker.live = [];
    FakeWorker.behave = behave;
  }
}
FakeWorker.live = [];
FakeWorker.behave = null;

async function withWorker(fn, behave) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'Worker');
  const prev = globalThis.Worker;
  FakeWorker.reset(behave);
  globalThis.Worker = FakeWorker;
  try {
    return await fn();
  } finally {
    if (had) globalThis.Worker = prev; else delete globalThis.Worker;
  }
}

/** The one job kind the real pool is asked for, with the cheapest real payload. */
const JOB = ['terrain', {
  field: 'planet', width: 4, height: 4, size: 8, seed: 1,
}];

test('a worker that fails to load rejects its jobs and the pool falls back inline', async () => {
  const pool = await withWorker(async () => {
    const p = new GenPool({ size: 2, idleReleaseMs: 0 });
    /* Fire `onerror` the way a browser does for a module that would not load:
     * after the job has been posted, with no `id` to key the rejection on. */
    const run = p.run('unknown-job-kind', {});
    for (const w of FakeWorker.live) w.onerror?.({ message: 'Failed to fetch dynamically imported module' });
    /* The fallback is reached - which is the whole point - and then throws on
     * its own terms, because this job kind does not exist. A hang would time
     * this test out instead, which is exactly the difference being asserted. */
    await assert.rejects(run, /unknown job "unknown-job-kind"/);
    return p;
  });

  assert.equal(pool.usingWorkers, false, 'the pool must take itself out of service after a worker failed to load');
  assert.equal(pool._pending.size, 0, 'nothing may be left pending - that is the hang');
  for (const s of pool._workers) assert.equal(s.busy, 0, 'the busy counter is what starves later jobs if it is not unwound');
  assert.equal(pool.stats.workerErrors, 2);
  pool.dispose();
});

test('a later job goes straight inline once the pool has failed', async () => {
  await withWorker(async () => {
    const p = new GenPool({ size: 1, idleReleaseMs: 0 });
    await assert.rejects(p.run('nope', {}), /unknown job/);
    for (const w of FakeWorker.live) w.onerror?.({ message: 'boom' });
    const posted = FakeWorker.live[0].posted.length;
    await assert.rejects(p.run('nope', {}), /unknown job/);
    assert.equal(FakeWorker.live[0].posted.length, posted,
      'a pool that is out of service must not post to a worker that is not answering');
    assert.equal(p.stats.inline, 2);
    p.dispose();
  }, (w, msg) => { w.onerror?.({ message: 'boom' }); void msg; });
});

test('a worker that goes silent blows the fuse instead of hanging for ever', async () => {
  await withWorker(async () => {
    /* No behaviour: the job is posted and never answered. This is the failure
     * `onerror` cannot see - a dropped message, a worker the browser killed
     * under memory pressure - and without the fuse it is indistinguishable
     * from a slow job for the rest of the session. */
    const p = new GenPool({ size: 1, jobTimeoutMs: 30, idleReleaseMs: 0 });
    await assert.rejects(p.run('nope', {}), /unknown job/);
    assert.equal(p.stats.timeouts, 1, 'the fuse is what turned a hang into a retry');
    assert.equal(p._pending.size, 0);
    assert.equal(p._workers[0].busy, 0);
    p.dispose();
  });
});

test('an answered job clears its fuse and leaves nothing behind', async () => {
  await withWorker(async () => {
    const p = new GenPool({ size: 1, jobTimeoutMs: 10_000, idleReleaseMs: 0 });
    const out = await p.run(...JOB);
    assert.ok(out && typeof out === 'object', 'the worker\'s result is handed back untouched');
    assert.equal(p._pending.size, 0);
    assert.equal(p._workers[0].busy, 0);
    assert.equal(p.stats.timeouts, 0);
    assert.equal(p.stats.inline, 0, 'a job the worker answered must not also run on the main thread');
    p.dispose();
  }, (w, msg) => { w.reply(msg.id, { ok: true }); });
});

test('a result that will not deserialise is a rejection, not a hang', async () => {
  await withWorker(async () => {
    const p = new GenPool({ size: 1, idleReleaseMs: 0 });
    /* `messageerror` fires INSTEAD of `message`, so the pending promise is
     * never settled by the normal path. Same hole as `onerror`, different
     * door. */
    await assert.rejects(p.run('nope', {}), /unknown job/);
    assert.equal(p._pending.size, 0);
    assert.equal(p.usingWorkers, false);
    p.dispose();
  }, (w) => { w.onmessageerror?.({}); });
});

test('the pool gives its workers back when nothing has needed them', async () => {
  await withWorker(async () => {
    /* `dispose()` had NO CALLERS ANYWHERE in the tree when this was written,
     * so up to four module workers were held for the whole session after the
     * last terrain build - and only four of seventeen worlds run terrain jobs
     * at all. Under lazy prefetch a player may approach none of them. */
    const p = new GenPool({ size: 3, idleReleaseMs: 15 });
    await p.run(...JOB);
    assert.equal(p.usingWorkers, true);
    const workers = FakeWorker.live.slice();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(p.stats.releases, 1);
    for (const w of workers) assert.equal(w.terminated, true, 'an idle worker still holds a module graph');
    /* Null, not false: the next terrain build spawns a fresh pool rather than
     * running on the main thread for the rest of the session. */
    assert.equal(p._available, null);
    await p.run(...JOB);
    assert.equal(p.usingWorkers, true, 'the pool must come back for the next world');
    p.dispose();
  }, (w, msg) => { w.reply(msg.id, { ok: true }); });
});

test('a job in flight holds the idle release off', async () => {
  await withWorker(async () => {
    const p = new GenPool({ size: 1, jobTimeoutMs: 10_000, idleReleaseMs: 15 });
    const pending = p.run(...JOB);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(p.stats.releases, 0, 'releasing a worker mid-job would strand the promise it is holding');
    FakeWorker.live[0].reply(FakeWorker.live[0].posted[0].id, { ok: true });
    await pending;
    p.dispose();
  });
});

test('WorldManager.dispose gives the pool back', async () => {
  /* The teardown path, and the reason `dispose()` had no callers is that
   * nobody owned the question. `WorldManager.dispose()` is the one place in
   * the tree that already means "free everything this session built". */
  const src = await import('node:fs/promises')
    .then((fs) => fs.readFile(new URL('../../src/worlds/WorldManager.js', import.meta.url), 'utf8'));
  const body = src.slice(src.indexOf('  dispose() {'));
  assert.match(body, /genPool\.dispose\(\)/,
    'WorldManager.dispose() no longer releases the generation workers');
});
