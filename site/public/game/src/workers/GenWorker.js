/**
 * Generation worker entry point.
 *
 * Deliberately thin: it owns the message protocol and nothing else. All the
 * actual work lives in `jobs/`, which the main thread can also import directly -
 * that is what lets `GenPool` fall back to running a job inline when workers are
 * unavailable without maintaining a second implementation of anything.
 */

import { JOBS } from './jobs/TerrainJob.js';

self.onmessage = (e) => {
  const { id, kind, payload } = e.data;
  const job = JOBS[kind];
  if (!job) {
    self.postMessage({ id, ok: false, error: `unknown job "${kind}"` });
    return;
  }
  try {
    const { buffers, transfer } = job(payload);
    // Transfer rather than clone: a 400 m terrain is about 2 MB of typed array
    // and a world ten times wider is 200 MB. Structured-cloning that back would
    // cost more than generating it did.
    self.postMessage({ id, ok: true, result: buffers }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message ?? String(err) });
  }
};
