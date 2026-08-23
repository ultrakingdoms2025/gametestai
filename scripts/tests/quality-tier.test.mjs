import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../../src/core/Engine.js';
import {
  TIERS,
  TIER_IDS,
  detectTierId,
  resolveTierId,
  resolveTier,
  storeTierId,
  applyTier,
  applyBootTier,
} from '../../src/gfx/QualityTier.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The low-end renderer tier.
 *
 * ── What shipped before this ──────────────────────────────────────────────
 *
 * One setting, for every device: 4x MSAA, GTAO, bloom, light shafts, SMAA, a
 * 2048 shadow map, a 2,000 m far plane, and a resolution scaler that bottoms
 * out at 0.8. `PostFX.setQuality()` existed and had **no UI at all**, so a
 * player on a phone had no way to reach any of it.
 *
 * GTAO alone measures 373-828 draw calls and 40-46% of the frame, which makes
 * it the obvious first drop and the one thing `low` must be pinned to do. The
 * resolution floor is the second lever, and the comment that raised it to 0.8
 * argues from MSAA quality - an argument that stops applying the moment MSAA is
 * 0, which is exactly what `low` does.
 *
 * These gates drive the real module against recording stubs shaped like the
 * real `PostFX`, `Engine` and `WebGLRenderer` surfaces, and one of them reads
 * `PostFX.setQuality`'s actual parameter names out of the source so a renamed
 * flag fails here rather than silently applying nothing.
 */

/** Storage that this file owns, so a real localStorage cannot leak in. */
function withStore(seed, fn) {
  const map = new Map(Object.entries(seed ?? {}));
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
    },
    configurable: true,
    writable: true,
  });
  try {
    return fn(map);
  } finally {
    if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
    else delete globalThis.localStorage;
  }
}

/* -------------------------------------------------------- the table -- */

test('there are three tiers and they are ordered', () => {
  assert.deepEqual(TIER_IDS, ['low', 'medium', 'high']);
  const cost = (t) => [t.msaa, t.shadowMapSize, t.far, t.maxPixelRatio, t.resolutionFloor];
  const [lo, mid, hi] = TIER_IDS.map((id) => cost(TIERS[id]));
  for (let i = 0; i < lo.length; i++) {
    assert.ok(lo[i] <= mid[i], `low is not cheaper than medium at index ${i}`);
    assert.ok(mid[i] <= hi[i], `medium is not cheaper than high at index ${i}`);
  }
});

test('high is what the game shipped with, so nothing regresses for a desktop player', () => {
  /* The regression gate for item 4. A tier system that quietly changed the
   * default is a graphics downgrade sold as a mobile feature. These are the
   * values read out of `Config.js` and `PostFX.js` before this phase. */
  const hi = TIERS.high;
  assert.equal(hi.msaa, 4);
  assert.equal(hi.shadowMapSize, 2048);
  assert.equal(hi.far, 2000);
  assert.equal(hi.maxPixelRatio, 2);
  assert.equal(hi.resolutionFloor, 0.8);
  for (const f of ['ao', 'shafts', 'bloom', 'smaa', 'film']) {
    assert.equal(hi.postfx[f], true, `high turned '${f}' off`);
  }
  assert.equal(hi.shadows, true);
});

test('low drops GTAO first, and then everything else that costs a pass', () => {
  const lo = TIERS.low;
  assert.equal(lo.postfx.ao, false, 'low still runs GTAO, which is 40-46% of the frame');
  for (const f of ['shafts', 'bloom', 'smaa']) {
    assert.equal(lo.postfx[f], false, `low still runs '${f}'`);
  }
  assert.equal(lo.msaa, 0);
  assert.equal(lo.shadows, false);
  assert.ok(lo.far <= 1000, 'low still draws to a kilometre');
  assert.ok(lo.maxPixelRatio <= 1, 'low still renders above one device pixel per CSS pixel');
  assert.ok(
    lo.resolutionFloor < 0.8,
    'low kept the 0.8 floor, which was argued from an MSAA it no longer has'
  );
});

test('medium drops GTAO too - it is the single most expensive pass', () => {
  assert.equal(TIERS.medium.postfx.ao, false);
  // ...but keeps the passes that are most of the game's look.
  assert.equal(TIERS.medium.postfx.bloom, true);
});

test('the postfx flags are exactly the ones PostFX.setQuality accepts', async () => {
  /* Pinned against the real signature. A flag renamed in `PostFX` and not here
   * would apply nothing at all, silently, and the only symptom would be a phone
   * that is still slow - which is indistinguishable from the tier not helping. */
  const src = await readFile(path.join(root, 'src/gfx/PostFX.js'), 'utf8');
  const at = src.indexOf('setQuality(flags');
  assert.ok(at > 0, 'PostFX no longer has setQuality(flags)');
  const body = src.slice(at, src.indexOf('\n  }', at));
  const accepted = new Set([...body.matchAll(/flags\.(\w+)\s*!==\s*undefined/g)].map((m) => m[1]));
  assert.ok(accepted.size >= 5, `only found ${accepted.size} flags in setQuality`);
  for (const id of TIER_IDS) {
    assert.deepEqual(
      new Set(Object.keys(TIERS[id].postfx)),
      accepted,
      `tier '${id}' does not name the flags setQuality reads`
    );
  }
});

/* -------------------------------------------------------- detection -- */

test('a low-memory, few-core touch device lands on low', () => {
  assert.equal(
    detectTierId({ deviceMemory: 4, hardwareConcurrency: 4, coarsePointer: true }),
    'low'
  );
  assert.equal(detectTierId({ hardwareConcurrency: 2, coarsePointer: true }), 'low');
});

test('a phone that hides its specs still does not get the desktop tier', () => {
  /* Safari reports no `deviceMemory` at all, and a current iPhone reports six
   * cores - so a purely numeric heuristic would hand an iPhone the same
   * settings as a workstation. A coarse pointer is the fact that is always
   * available, and it is enough to keep GTAO off. */
  assert.equal(detectTierId({ hardwareConcurrency: 6, coarsePointer: true }), 'medium');
  assert.equal(detectTierId({ coarsePointer: true }), 'medium');
});

test('a desktop gets what it always got', () => {
  assert.equal(detectTierId({ deviceMemory: 16, hardwareConcurrency: 16 }), 'high');
  // Nothing known at all is a desktop: it is the case a browser that reports
  // nothing AND has a fine pointer is in.
  assert.equal(detectTierId({}), 'high');
});

/* ------------------------------------------------------ persistence -- */

test('a stored choice beats detection, in both directions', () => {
  withStore({}, () => {
    storeTierId('high');
    assert.equal(resolveTierId({ hardwareConcurrency: 2, coarsePointer: true }), 'high');
    storeTierId('low');
    assert.equal(resolveTierId({ deviceMemory: 32, hardwareConcurrency: 32 }), 'low');
  });
});

test('"auto" clears the choice rather than storing a fourth tier', () => {
  withStore({}, () => {
    storeTierId('low');
    storeTierId('auto');
    assert.equal(resolveTierId({ deviceMemory: 32, hardwareConcurrency: 32 }), 'high');
  });
});

test('a stale or hand-edited stored tier is ignored, not obeyed', () => {
  // Storage outlives the build that wrote it - the same reasoning as
  // `Input._loadBinds` dropping a reserved key.
  withStore({ 'aether:quality': 'ultra' }, () => {
    assert.equal(resolveTierId({ deviceMemory: 32, hardwareConcurrency: 32 }), 'high');
  });
  withStore({ 'aether:quality': 'low' }, () => {
    assert.equal(resolveTier({}).id, 'low');
  });
});

/* ----------------------------------------------------------- apply -- */

function stubs() {
  const seen = { quality: null, pixelRatio: null, floor: null, resized: 0, far: null };
  return {
    seen,
    postfx: { setQuality: (f) => { seen.quality = f; } },
    engine: {
      setResolutionFloor: (f) => { seen.floor = f; },
      resize: () => { seen.resized++; },
    },
    renderer: {
      shadowMap: { enabled: true },
      setPixelRatio: (r) => { seen.pixelRatio = r; },
    },
    camera: { far: 2000, updateProjectionMatrix() { seen.far = this.far; } },
  };
}

test('applying low turns the passes off and moves every live lever', () => {
  const s = stubs();
  applyTier(TIERS.low, s);
  assert.deepEqual(s.seen.quality, TIERS.low.postfx, 'the passes were not handed to PostFX');
  assert.equal(s.renderer.shadowMap.enabled, false, 'shadows were left on');
  assert.equal(s.camera.far, TIERS.low.far, 'the far plane did not move');
  assert.equal(s.seen.far, TIERS.low.far, 'the projection matrix was not rebuilt');
  assert.equal(s.seen.floor, TIERS.low.resolutionFloor);
  assert.ok(s.seen.resized > 0, 'the renderer was never resized, so the pixel ratio never took');
});

test('applying high puts a desktop back exactly as it was', () => {
  const s = stubs();
  applyTier(TIERS.low, s);
  applyTier(TIERS.high, s);
  assert.equal(s.renderer.shadowMap.enabled, true);
  assert.equal(s.camera.far, 2000);
  assert.equal(s.seen.floor, 0.8);
  assert.deepEqual(s.seen.quality, TIERS.high.postfx);
});

test('applyTier survives a missing collaborator', () => {
  // It runs at boot, before some of these exist, and again from a menu row. A
  // throw in either place is a black screen.
  assert.doesNotThrow(() => applyTier(TIERS.low, {}));
  assert.doesNotThrow(() => applyTier(null, stubs()));
});

test('the boot-only settings are written into CONFIG before the engine reads them', () => {
  /* MSAA lives on the composer's render target and `shadowMapSize` is baked
   * into the shadow map when the rig is built, so both have to be in `CONFIG`
   * before `new Engine(...)` and `createPostFX(...)` run. This is the half of
   * the tier that a mid-session change honestly cannot move. */
  const config = { render: { maxPixelRatio: 2, far: 2000, shadowMapSize: 2048 } };
  applyBootTier(TIERS.low, config);
  assert.equal(config.render.shadowMapSize, TIERS.low.shadowMapSize);
  assert.equal(config.render.far, TIERS.low.far);
  assert.equal(config.render.maxPixelRatio, TIERS.low.maxPixelRatio);
});

/* ---------------------------------------------------------- wiring -- */

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('PostFX takes its MSAA sample count from the resolved tier', async () => {
  // The tier is only real if the renderer reads it. Four of the ten settings
  // are applied through `applyTier`; this is the one that is applied by being
  // read at construction, so it needs its own gate.
  const src = strip(await readFile(path.join(root, 'src/gfx/PostFX.js'), 'utf8'));
  assert.ok(src.includes("from './QualityTier.js'"), 'PostFX does not know about the tiers');
  const at = src.indexOf('const MSAA_SAMPLES');
  assert.ok(at > 0);
  const body = src.slice(at, src.indexOf('})();', at));
  assert.ok(/resolveTier\(/.test(body), 'MSAA_SAMPLES ignores the tier');
  assert.ok(body.includes("QUERY.get('msaa')"), 'the ?msaa= A/B override was lost');
});

/**
 * The real `Engine._adaptResolution`, with only the fields it reads.
 *
 * Driven rather than source-scanned. The first version of this gate DID read
 * the source, and a deliberate revert - `const floor = 0.8` in place of `const
 * floor = this._resolutionFloor` - sailed straight through it, because the
 * comparison it was matching on still said `> floor`. A gate that reports
 * confidence about the wrong thing is worse than no gate.
 */
function stubEngine(floor) {
  const e = Object.create(Engine.prototype);
  e.stats = { frameMsMedian: 60, drawCalls: 0, triangles: 0, programs: 0, fps: 0, frameMs: 0 };
  e._resolutionScale = 1;
  e._resolutionFloor = 0.8;
  e.adaptiveResolution = true;
  e.renderer = { setPixelRatio() {}, setSize() {} };
  e.postfx = null;
  e.camera = { aspect: 1, updateProjectionMatrix() {} };
  e.bus = { emit() {} };
  if (floor !== undefined) e.setResolutionFloor(floor);
  return e;
}

/** `resize()` and `_adaptResolution` both read `window`. */
function withWindow(fn) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    value: { innerWidth: 800, innerHeight: 600, devicePixelRatio: 2 },
    configurable: true,
    writable: true,
  });
  try {
    return fn();
  } finally {
    if (saved) Object.defineProperty(globalThis, 'window', saved);
    else delete globalThis.window;
  }
}

test('the resolution scaler stops at the tier floor, not at a constant', () => {
  withWindow(() => {
    // A sustained 60 ms frame: the scaler drops 0.05 per call and must stop dead
    // on the floor it was given.
    for (const floor of [0.8, TIERS.low.resolutionFloor]) {
      const e = stubEngine(floor);
      for (let i = 0; i < 40; i++) e._adaptResolution();
      assert.ok(
        Math.abs(e._resolutionScale - floor) < 1e-6,
        `the scaler bottomed out at ${e._resolutionScale}, not at the ${floor} floor it was set to`
      );
    }
  });
});

test('a floor tightened mid-session takes effect at once', () => {
  // Switching from low back to high with the scaler already at 0.5 would
  // otherwise leave the player on a soft image until the next hitch.
  withWindow(() => {
    const e = stubEngine(0.5);
    for (let i = 0; i < 40; i++) e._adaptResolution();
    assert.ok(e._resolutionScale < 0.8);
    e.setResolutionFloor(0.8);
    assert.ok(Math.abs(e._resolutionScale - 0.8) < 1e-6, 'the scale stayed below its new floor');
  });
});

test('a nonsense floor is ignored rather than obeyed', () => {
  withWindow(() => {
    const e = stubEngine();
    e.setResolutionFloor(Number.NaN);
    assert.equal(e._resolutionFloor, 0.8);
    e.setResolutionFloor(9);
    assert.ok(e._resolutionFloor <= 1, 'a floor above 1 would pin the scaler above full resolution');
  });
});

test('the boot tier is applied before the engine is constructed', async () => {
  /* Order is the whole point of `applyBootTier`, and it is invisible at
   * runtime: applied after `new Engine(...)` it would set a far plane on a
   * camera that has already been built with the old one, and an MSAA count on
   * a render target that already exists. */
  const src = strip(await readFile(path.join(root, 'src/main.js'), 'utf8'));
  const boot = src.indexOf('applyBootTier(');
  const engine = src.indexOf('new Engine(');
  assert.ok(boot > 0, 'main.js never applies the boot tier');
  assert.ok(boot < engine, 'the boot tier is applied after the engine already exists');
});
