import test from 'node:test';
import assert from 'node:assert/strict';

import { MapOverlay } from '../../src/systems/MapOverlay.js';

/**
 * WHICH BUILD OF THE GAME WALKED THIS WORLD (spec D5).
 *
 * A layout report - the minimap shapes and the sampled ground grid the map
 * editor snaps against - describes the world AS BUILT WHEN AN ADMIN LAST
 * WALKED IT. A redeploy that re-authors a district leaves that grid describing
 * surfaces that no longer exist, and nothing compared the two: the editor went
 * on snapping props onto the previous build's roofs, and the save route judged
 * those positions against the same stale grid, so it agreed with itself.
 *
 * `builtVersion` cannot answer it - that is a DOCUMENT version and says
 * nothing about geometry. The identity is the deployed bundle's commit, which
 * `site/scripts/bundle-game.mjs` stamps into `build.json` beside the bundle.
 * Both sides read that same file, so they agree exactly when nothing has been
 * redeployed since - no clock comparison, no hash both ends have to compute
 * the same way.
 *
 * ── What is asserted here, and why each one ───────────────────────────────
 *
 * The field is OMITTED rather than nulled when it cannot be read, because the
 * site distinguishes "a different build" from "this build cannot say" and only
 * the first stops an admin editing. `unknown` - what the bundler stamps for a
 * checkout with no git history - is refused for the same reason: every such
 * build shares it, so it identifies nothing and would read as a match.
 *
 * And it is read ONCE. A 404 that is not remembered is a request per report
 * for the rest of the session, on the one machine whose console an admin is
 * watching.
 */

const WORLD = { id: 'station', bounds: null, minimapShapes: [], builtVersion: 0 };

/** A fetch that serves a build stamp and records what it was asked for. */
function rig(stamp, { stampOk = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' });
    if (String(url).includes('build.json')) {
      return stampOk
        ? { ok: true, status: 200, json: async () => stamp }
        : { ok: false, status: 404, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  fetchImpl.calls = calls;
  const system = new MapOverlay({ fetch: fetchImpl });
  return { system, calls, posts: () => calls.filter((c) => c.method === 'POST') };
}

const report = { world: 'station', version: 1, builtVersion: 0, applied: [], unresolved: [], objects: [] };

/** The body of the last POST, by intercepting `JSON.stringify` through the fetch stub. */
async function postBody(system, fetchCalls) {
  let sent = null;
  const original = system._fetch;
  system._fetch = async (url, init) => {
    if ((init?.method ?? 'GET') === 'POST') sent = JSON.parse(init.body);
    return original(url, init);
  };
  await system._reportBack(report, WORLD);
  fetchCalls.length = 0;
  return sent;
}

test('the report names the build that walked the world', async () => {
  const r = rig({ commit: 'a1b2c3d4e5', builtAt: '2026-08-30T00:00:00.000Z' });
  const body = await postBody(r.system, r.calls);
  assert.equal(body.buildId, 'a1b2c3d4e5');
});

test('a build that cannot say omits the field rather than nulling it', async () => {
  for (const [what, stamp, ok] of [
    ['no stamp beside the bundle', {}, false],
    ['a stamp with no commit', { builtAt: 'x' }, true],
    ['a checkout with no git history', { commit: 'unknown' }, true],
    ['a non-string commit', { commit: 42 }, true],
    ['an empty commit', { commit: '' }, true],
  ]) {
    const r = rig(stamp, { stampOk: ok });
    const body = await postBody(r.system, r.calls);
    assert.equal('buildId' in body, false, what);
  }
});

test('the stamp is read once, not once per report', async () => {
  const r = rig({ commit: 'a1b2c3d4e5' });
  await r.system._reportBack(report, WORLD);
  await r.system._reportBack(report, WORLD);
  await r.system._reportBack(report, WORLD);
  const stampReads = r.calls.filter((c) => c.url.includes('build.json'));
  assert.equal(stampReads.length, 1, 'the build stamp was fetched more than once');
});

/* A 404 is a fact about this deploy and will not change while the tab is open.
 * The FAILURE has to be cached as hard as the success, or a bundle with no
 * stamp costs a request per report forever. */
test('a missing stamp is remembered as missing', async () => {
  const r = rig({}, { stampOk: false });
  await r.system._reportBack(report, WORLD);
  await r.system._reportBack(report, WORLD);
  assert.equal(r.calls.filter((c) => c.url.includes('build.json')).length, 1);
});

test('the stamp path is overridable, so a test never reaches the real one', () => {
  assert.equal(new MapOverlay({ buildStamp: '/elsewhere.json' }).buildStamp, '/elsewhere.json');
  assert.equal(new MapOverlay({}).buildStamp, '/game/build.json');
});
