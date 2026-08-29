/**
 * THE WORLD KIT - a real StationWorld or DockWorld, built without a browser.
 *
 * ── Why this is a kit and not a test ──────────────────────────────────────
 * Every symbol here was written inside `station-minigames.test.mjs`, which was
 * the only file that needed a built station. Phase 0 of the placement re-plan
 * needs a second and a third (`station-catalogue.test.mjs`,
 * `station-overlay-e2e.test.mjs`), and importing a `*.test.mjs` file
 * re-registers its cases in the importer's run - the citadel hit exactly this
 * and split `citadel-reach-kit.mjs` out for the same reason. The file is
 * deliberately NOT named `*.test.mjs`, because `npm test` globs
 * `scripts/tests/*.test.mjs` and a kit is not a suite.
 *
 * ── What "headless" costs, stated so nobody trusts it too far ─────────────
 * `document.createElement('canvas')` answers a 1x1 canvas whose 2D context is a
 * Proxy returning `() => undefined` for every method it was not given, and
 * `getImageData` returns zeroed pixels. So every texture the station paints is
 * a 1x1 black square, and `loadHeroAssets()` / `loadCrowdAssets()` resolve to
 * empty maps under Node by design (StationWorld.js, the two awaits in `build`).
 *
 * That is fine for GEOMETRY, PLACEMENT and COLLISION, which is all anything
 * here measures - the meshes, their names, their transforms and the colliders
 * derived from them do not depend on what a texture looks like. It is NOT fine
 * for anything that reads a pixel, and it means a name set pinned here is the
 * HEADLESS name set. `station-catalogue.test.mjs` reconciles that against the
 * catalogue production actually reported, which is the only thing that proves
 * the pin guards what the editor addresses.
 *
 * ── Freshness ────────────────────────────────────────────────────────────
 * `buildStation()` memoises: a station build is the most expensive thing in
 * this suite and a read-only test should pay for it once. Anything that
 * MUTATES the world - and applying an overlay document moves objects, hides
 * them and removes colliders - must call `buildStationFresh()` instead, or it
 * hands the next test a world somebody already edited.
 */
import * as THREE from 'three';

/* ------------------------------------------------------------------ */
/* A browser, for the parts of one this world insists on               */
/* ------------------------------------------------------------------ */

/**
 * Install the DOM and canvas stand-ins the world's texture painting needs.
 *
 * Idempotent through a global flag: two kits in one process would otherwise
 * fight over `globalThis.document`. Extracted verbatim from
 * `station-minigames.test.mjs`, where it was proven against a real build.
 */
export function installHeadlessDom() {
  if (globalThis.__stationWorldKitInstalled) return;
  globalThis.__stationWorldKitInstalled = true;

  class Img {
    constructor(a, b, c) {
      if (typeof a === 'number') { this.width = a; this.height = b; this.data = new Uint8ClampedArray(a * b * 4); }
      else { this.data = a; this.width = b; this.height = c ?? 1; }
    }
  }
  const gradient = { addColorStop() {} };
  const context2d = (canvas) => {
    const real = {
      canvas,
      createImageData: (w, h) => new Img(Math.max(1, w | 0), Math.max(1, (h ?? w) | 0)),
      getImageData: (_x, _y, w, h) => new Img(Math.max(1, w | 0), Math.max(1, h | 0)),
      createLinearGradient: () => gradient,
      createRadialGradient: () => gradient,
      createConicGradient: () => gradient,
      createPattern: () => null,
      measureText: () => ({ width: 8 }),
      getLineDash: () => [],
    };
    return new Proxy(real, { get: (o, k) => (k in o ? o[k] : () => undefined), set: () => true });
  };
  globalThis.ImageData = Img;
  globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  globalThis.document = {
    createElement(tag) { const c = { width: 1, height: 1, style: {}, tagName: tag }; c.getContext = () => context2d(c); return c; },
    createElementNS(_ns, tag) { return this.createElement(tag); },
  };
  globalThis.window = globalThis;
  globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return context2d(this); } };
  const dead = () => ({ texture: null, dispose() {} });
  THREE.PMREMGenerator.prototype.fromEquirectangular = dead;
  THREE.PMREMGenerator.prototype.fromScene = dead;
  THREE.PMREMGenerator.prototype.compileEquirectangularShader = () => {};
}

installHeadlessDom();

const { Physics, COLLISION_LAYER } = await import('../../src/physics/Physics.js');
const { StationWorld } = await import('../../src/worlds/StationWorld.js');
const { DockWorld } = await import('../../src/worlds/DockWorld.js');

export { Physics, COLLISION_LAYER, THREE };

/* ------------------------------------------------------------------ */
/* The build                                                           */
/* ------------------------------------------------------------------ */

/** A renderer that answers the five questions the build actually asks it. */
function stubRenderer() {
  return {
    capabilities: { getMaxAnisotropy: () => 4, isWebGL2: true },
    initTexture() {}, getContext: () => ({}),
    getRenderTarget: () => null, setRenderTarget() {}, render() {}, clear() {},
  };
}

/**
 * Build a StationWorld from scratch. Returns the world, its physics, and every
 * console line the build printed.
 *
 * The log is captured rather than discarded because the build prints the
 * numbers Phase 0 wants as baselines - `[station] structure collided from
 * geometry: N triangles found ... in N chunks (N MB)` among them - and a
 * baseline read out of the world's own reporting cannot drift away from what
 * the world did.
 */
async function buildFresh(Ctor) {
  const physics = new Physics();
  const world = new Ctor({
    physics,
    scene: new THREE.Scene(),
    bus: { on: () => () => {}, emit() {} },
    engine: { renderer: stubRenderer(), onFrameUpdate: () => () => {}, onResize: () => () => {} },
    materials: { get: () => new THREE.MeshStandardMaterial(), dispose() {} },
  });
  world.physics = physics;

  const log = [];
  const say = console.log;
  const info = console.info;
  console.log = (...a) => { log.push(a.join(' ')); };
  console.info = (...a) => { log.push(a.join(' ')); };
  const t0 = Date.now();
  try {
    await world.build(() => {});
  } finally {
    console.log = say;
    console.info = info;
  }
  return { world, physics, log, buildMs: Date.now() - t0 };
}

/** A fresh StationWorld, its physics, and every console line its build printed. */
export const buildStationFresh = () => buildFresh(StationWorld);

/**
 * A fresh DockWorld, on the same terms.
 *
 * The yard is here because it is the OTHER editable overlay world
 * (site/lib/mapOverlaySchema.ts lists `dock` in OVERLAY_WORLDS) and it shares
 * StationKit with the station - so a change to the kit's naming or to
 * `markRampProxy` moves the yard's editor address space too. It had no
 * catalogue pin when the station got one, which is exactly the gap a shared
 * kit invites; `dock-catalogue.test.mjs` closes it.
 */
export const buildDockFresh = () => buildFresh(DockWorld);

const _memo = new Map();
/**
 * The shared, memoised worlds. Read-only callers only - see the freshness note
 * in this file's header.
 */
export async function buildStation() {
  if (!_memo.has('station')) _memo.set('station', await buildStationFresh());
  return _memo.get('station');
}

export async function buildDock() {
  if (!_memo.has('dock')) _memo.set('dock', await buildDockFresh());
  return _memo.get('dock');
}

/** One line of the captured build log, by substring. Null when absent. */
export function logLine(log, needle) {
  return log.find((l) => l.includes(needle)) ?? null;
}
