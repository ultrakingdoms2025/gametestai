/**
 * Renderer quality tiers.
 *
 * ── What shipped before this file ─────────────────────────────────────────
 *
 * One setting, for every device: 4x MSAA, GTAO, bloom, light shafts, SMAA, a
 * 2048 shadow map, a 2,000 m far plane, and an adaptive resolution scaler that
 * bottoms out at 0.8. `PostFX.setQuality()` existed and was reachable from
 * nothing - no menu row, no key, no query parameter - so the levers were built
 * and unreachable, which is this project's signature defect.
 *
 * GTAO is the first thing `low` and `medium` drop, and not by taste: it
 * measures 373-828 draw calls and 40-46% of the frame. The resolution floor is
 * the second lever. `Engine._adaptResolution` raised that floor from 0.65 to
 * 0.8 with the argument that "below ~0.8 the upscale reintroduces exactly the
 * stair-stepping the composer's MSAA is there to remove" - which is true, and
 * which stops applying the moment MSAA is 0. `low` sets MSAA to 0, so `low`
 * gets its floor back.
 *
 * ── Boot-time and live settings are not the same set ──────────────────────
 *
 * Four settings can only be applied before the game is built:
 * `msaa` lives on the composer's HDR render target, and `shadowMapSize`,
 * `far` and `maxPixelRatio` are read out of `CONFIG.render` by `Engine`'s
 * constructor and by the light rig. `applyBootTier` writes those into `CONFIG`
 * before `new Engine(...)`; `applyTier` moves everything that genuinely can
 * move at runtime. A mid-session tier change therefore says "takes effect on
 * reload" for the rest, rather than pretending.
 *
 * This module is deliberately pure and node-importable: no DOM at module
 * scope, every `localStorage` and `navigator` access guarded, so a gate can
 * drive it and so `PostFX` can read it before anything exists.
 */

const STORAGE = 'aether:quality';

/** Cheapest first. The order is load-bearing; a gate checks monotonic cost. */
export const TIER_IDS = ['low', 'medium', 'high'];

/**
 * @typedef {object} QualityTier
 * @property {string} id
 * @property {string} label
 * @property {number} msaa          scene MSAA samples — BOOT ONLY
 * @property {number} shadowMapSize BOOT ONLY
 * @property {number} far           camera far plane, metres
 * @property {number} maxPixelRatio ceiling on devicePixelRatio
 * @property {number} resolutionFloor lower bound for the adaptive scaler
 * @property {boolean} shadows
 * @property {number} geometryScale multiplier on radial segment counts — BOOT
 *   ONLY, and the one field where `high` is deliberately ABOVE what shipped.
 *   See the tessellation section below.
 * @property {{ao:boolean, shafts:boolean, bloom:boolean, smaa:boolean, film:boolean}} postfx
 *   exactly the flags `PostFX.setQuality` reads; pinned by a gate against its
 *   real signature, because a renamed flag would apply nothing and the only
 *   symptom would be a phone that is still slow.
 */

/** @type {Record<string, QualityTier>} */
export const TIERS = {
  low: {
    id: 'low',
    label: 'Low',
    msaa: 0,
    shadowMapSize: 512,
    far: 900,
    maxPixelRatio: 1,
    /* 0.5, not 0.8. See the file header: the floor was raised to protect MSAA,
     * and this tier has none. Half resolution on a phone screen is still more
     * pixels than a 1080p desktop was giving each degree of view. */
    resolutionFloor: 0.5,
    shadows: false,
    /* 1, not 0.75. Tessellation only ever goes UP from here; see the
     * tessellation section below for why a phone gains nothing from coarser
     * cylinders and loses every silhouette in the game. */
    geometryScale: 1,
    postfx: { ao: false, shafts: false, bloom: false, smaa: false, film: false },
  },
  medium: {
    id: 'medium',
    label: 'Medium',
    msaa: 2,
    shadowMapSize: 1024,
    far: 1400,
    maxPixelRatio: 1.5,
    resolutionFloor: 0.7,
    shadows: true,
    /* GTAO off here too. It is not a middle-of-the-road cost that can be halved
     * - it is one pass costing 40-46% of the frame, so the honest middle tier
     * is "everything that makes the game look like itself, minus the one pass
     * that costs as much as the rest". Bloom and shafts are most of the art
     * direction; ambient occlusion is contact shading nobody misses at 30 fps. */
    geometryScale: 1,
    postfx: { ao: false, shafts: true, bloom: true, smaa: true, film: true },
  },
  high: {
    id: 'high',
    label: 'High',
    /* Every value here is what the game shipped with, read out of `Config.js`
     * and `PostFX.js`. A tier system that quietly moved the default would be a
     * graphics downgrade sold as a mobile feature; a gate pins these. */
    msaa: 4,
    shadowMapSize: 2048,
    far: 2000,
    maxPixelRatio: 2,
    resolutionFloor: 0.8,
    shadows: true,
    /* THE ONE EXCEPTION to the paragraph above, and deliberately so. Every
     * other field on this tier RESTORES what shipped; this one is the only
     * lever on the table that can RAISE it, and a tier system that can only
     * ever subtract is half a tier system. 1.5, argued below. */
    geometryScale: 1.5,
    postfx: { ao: true, shafts: true, bloom: true, smaa: true, film: true },
  },
};

/* ------------------------------------------------------------------ */
/* Tessellation                                                        */
/* ------------------------------------------------------------------ */

/**
 * The scale the world kits multiply a radial segment count by. See
 * `tessSegments`.
 *
 * ── Why a latched module value and not `resolveTier()` at the call site ───
 *
 * This module imports nothing, so a world file CAN import it without a cycle -
 * that is not what stops it. Two other things do.
 *
 * `detectTierId({})` returns `'high'`: with no `navigator` the coarse-pointer
 * test is false and every numeric test is undefined, so a world that resolved
 * its own tier would silently re-tessellate itself in every headless test and
 * every `make-*-glb` run. A default of 1 keeps a build with no boot byte-for-
 * byte what shipped, and makes raising it an explicit act.
 *
 * And a world that is already built cannot be re-tessellated. That puts this
 * squarely with `msaa` and `shadowMapSize` in the BOOT-ONLY half - so
 * `applyBootTier` latches it and `applyTier` deliberately does not, and the
 * hub's Graphics row is already honest that the boot-only half waits for a
 * reload.
 */
let _geometryScale = 1;

/**
 * Latch the scale. Called by `applyBootTier`, before any world is built.
 *
 * Clamped to >= 1, and that clamp is the invariant rather than a defensive
 * habit: every radial count in the game was authored against 1.0, and a scale
 * below it would quietly redraw the whole world coarser than any artist ever
 * saw it. Anything non-finite means "no opinion", which is 1.
 *
 * @param {number} scale
 */
export function setGeometryScale(scale) {
  _geometryScale = Number.isFinite(scale) && scale > 1 ? scale : 1;
}

/** @returns {number} the scale in force. For gates and diagnostics. */
export function getGeometryScale() {
  return _geometryScale;
}

/**
 * Raise an authored radial segment count to the tier in force.
 *
 * ── What this is for ──────────────────────────────────────────────────────
 *
 * Nothing under `src/worlds/` read a tier before this. Every radial count in
 * the game was a literal that an RTX 5080 and a phone both received, so the
 * ~650 curved primitives sitting at radial <= 12 could not be raised for
 * desktop because there was no mechanism, not because anyone had measured that
 * they should not be. 375 of those call sites funnel through four helpers -
 * `MedievalWorld`'s `cylGeo`/`coneGeo`, `station/StationKit`'s `cylGeo` and
 * `InteriorKit`'s `vcyl` - which is why one multiplier reaches half of them.
 *
 * ── UP ONLY, and why the lower tiers sit at 1.0 ───────────────────────────
 *
 * `Math.max` is not belt-and-braces; it is the whole policy. The authored
 * counts are already AT the floor: across the four helpers the histogram's
 * mass is radial 4-8 (medieval alone: 4 x21, 5 x39, 6 x29, 7 x13, 8 x30), and
 * a 0.75 scale would round radial 4 down to 3. Radial 3 is a count this
 * codebase uses ON PURPOSE - the bridge-pier cutwaters at MedievalWorld.js
 * ~9738 and ~10509 - precisely because three segments read as a triangle. A
 * cheap tier that turned every iron strap into a cutwater is not a cheap tier.
 *
 * Nor would it buy a phone anything measurable. All of this geometry is merged
 * once into a `GeoBatch` bucket at build time and uploaded; a phone's bill in
 * this project is shader link (42 point lights measured at 59.8 s of compile)
 * and fill (GTAO measured at 40-46% of the frame), which is why `low` and
 * `medium` spend their budget on `postfx` and `resolutionFloor` and leave the
 * static vertex buffers alone.
 *
 * ── Why 1.5 for `high`, and not 1.25 ──────────────────────────────────────
 *
 * The dominant bucket is radial 8, which is a 45-degree facet. 1.25 rounds it
 * to 10 (36 degrees); 1.5 rounds it to 12 (30 degrees), and 30 degrees is the
 * step where a barrel at arm's length stops reading as an octagon. The same
 * holds up the histogram: 6 -> 9 rather than 8, 12 -> 18 rather than 15,
 * 16 -> 24 rather than 20, 20 -> 30 rather than 25. 1.25 is a number that
 * costs a quarter and shows in nothing.
 *
 * ── What it costs, honestly ───────────────────────────────────────────────
 *
 * ZERO shader programs, which is this project's standing budget gate: a radial
 * count is not a `#define`, and a 30-segment cylinder links the same program as
 * a 20-segment one. Zero draw calls - every one of these lands in a merged
 * batch that already existed.
 *
 * Triangles scale EXACTLY linearly and nothing else moves: a closed
 * `CylinderGeometry(_,_,_,r,1)` is 4r triangles, open-ended 2r, a
 * `ConeGeometry(_,_,r,1)` 2r. Summed over the literal call sites, 1.5 raises
 * the radial-segment sum by 51.5% (MedievalWorld), 50.1% (station kits and
 * zones), 50.3% (StationWorld) and 50.0% (InteriorKit) - so it raises the
 * triangles those helpers emit by the same, at any instance multiplicity.
 *
 * NOT MEASURED: what share of a world's 2.3-3.4 M `worldTriangles` those
 * helpers emit. There is no headless path to a built world (see the note at
 * the top of scripts/tests/station-audit.test.mjs) and this machine cannot
 * time frames. A `world-shot` sweep is the measurement that closes it, and if
 * the station's comes back expensive this single number is the entire knob.
 *
 * @param {number} seg an authored radial segment count
 * @returns {number} the count to build with
 */
export function tessSegments(seg) {
  if (!Number.isFinite(seg)) return seg;
  return Math.max(seg, Math.round(seg * _geometryScale));
}

/**
 * Read what the device is willing to say about itself.
 *
 * Split out from `detectTierId` so the heuristic can be driven with values
 * rather than with a faked global.
 *
 * @returns {{deviceMemory?:number, hardwareConcurrency?:number, coarsePointer?:boolean, gpu?:string}}
 */
export function readDeviceHints() {
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  let coarsePointer = false;
  try {
    coarsePointer =
      typeof matchMedia === 'function'
      && (matchMedia('(pointer: coarse)').matches || matchMedia('(hover: none)').matches);
  } catch { /* no matchMedia; fall back to the touch-point count below */ }
  if (!coarsePointer && nav && typeof nav.maxTouchPoints === 'number') {
    coarsePointer = nav.maxTouchPoints > 0;
  }
  return {
    deviceMemory: typeof nav?.deviceMemory === 'number' ? nav.deviceMemory : undefined,
    hardwareConcurrency:
      typeof nav?.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : undefined,
    coarsePointer,
    gpu: readGpuString(),
  };
}

/**
 * What the driver calls the GPU, read off a throwaway context.
 *
 * A throwaway rather than the engine's own renderer because this runs BEFORE
 * `new Engine(...)` - the tier has to be known before the composer's render
 * target and the shadow map are sized. The context is released the moment the
 * string is read. Undefined wherever there is no document, no WebGL, or a
 * browser that hides the string; every caller treats undefined as "no
 * opinion".
 *
 * @returns {string|undefined}
 */
export function readGpuString() {
  if (_gpuString !== null) return _gpuString.value;
  _gpuString = { value: undefined };
  try {
    if (typeof document === 'undefined') return undefined;
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return undefined;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const s = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    _gpuString.value = typeof s === 'string' && s ? s : undefined;
    return _gpuString.value;
  } catch {
    return undefined;
  }
}

/**
 * Read once per page. `resolveTier` is called at PostFX's module scope, at
 * boot and from the hub's Graphics row, and a throwaway WebGL context per call
 * is a cost with no second answer to buy.
 * @type {{value: string|undefined}|null}
 */
let _gpuString = null;

/**
 * The one fact the tier needs from a renderer string: is this a GPU that can
 * take the desktop settings, or one that provably cannot?
 *
 * Conservative in the same single direction as `detectTierId`: only ever a
 * reason to go DOWN. A discrete card that is misread lands on `high`, which is
 * what it always got; the two classes below are the ones where `high` -
 * 4x MSAA, a 2048 shadow map, GTAO - is a slideshow before the runtime guards
 * (the resolution scaler, PostFX's budget) have had their four samples.
 *
 *   software    SwiftShader, llvmpipe, WARP - a CPU pretending. `low`.
 *   integrated  Intel HD/UHD/Iris/Xe, AMD APU "Radeon(TM) Graphics" and the
 *               `xxxM` mobile parts, and the phone families. `medium`.
 *
 * Intel Arc, every GeForce, every Radeon RX and every Apple M-series are left
 * alone - Arc and the M-series are real GPUs that happen to share a vendor
 * word with the integrated parts, which is why the patterns name the
 * integrated FAMILIES rather than the vendor.
 *
 * @param {string|undefined} gpu
 * @returns {'software'|'integrated'|null}
 */
export function classifyGpu(gpu) {
  if (typeof gpu !== 'string' || !gpu) return null;
  if (/swiftshader|llvmpipe|softpipe|microsoft basic render|\bwarp\b/i.test(gpu)) return 'software';
  if (/intel\b[^,]*\b(hd|uhd|iris|xe)\b/i.test(gpu)) return 'integrated';
  if (/radeon\(tm\)\s+(vega|graphics|r[2-7]\b)|radeon\s+\d{3}m\b|radeon rx vega \d+ graphics/i.test(gpu)) return 'integrated';
  if (/\b(mali|adreno|powervr|videocore)\b/i.test(gpu)) return 'integrated';
  return null;
}

/**
 * Pick a tier from what the device admits to.
 *
 * Deliberately conservative in one direction only: a desktop that is
 * misdetected as `medium` loses ambient occlusion, while a phone misdetected as
 * `high` gets an unplayable frame rate and no visible reason for it. So the
 * coarse-pointer test is enough on its own to keep GTAO off, and the numeric
 * tests only ever push further down.
 *
 * @param {{deviceMemory?:number, hardwareConcurrency?:number, coarsePointer?:boolean, gpu?:string}} hints
 * @returns {'low'|'medium'|'high'}
 */
export function detectTierId(hints = {}) {
  const { deviceMemory, hardwareConcurrency, coarsePointer, gpu } = hints;
  const gpuClass = classifyGpu(gpu);
  if (gpuClass === 'software') return 'low';
  if (typeof deviceMemory === 'number' && deviceMemory <= 4) return 'low';
  if (typeof hardwareConcurrency === 'number' && hardwareConcurrency <= 4) return 'low';
  /* Safari reports no `deviceMemory` at all and a current iPhone reports six
   * cores, so a purely numeric heuristic hands an iPhone a workstation's
   * settings. A coarse pointer is the fact that is always available. */
  if (coarsePointer) return 'medium';
  /* A desktop on an integrated GPU has a keyboard, a mouse, eight cores and
   * sixteen gigabytes, and every numeric test above says "workstation". The
   * GPU string is the only fact that says otherwise. See `classifyGpu`. */
  if (gpuClass === 'integrated') return 'medium';
  return 'high';
}

/** @returns {string|null} the player's stored choice, or null for auto. */
export function storedTierId() {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE);
    // Validated, never trusted: storage outlives the build that wrote it, and a
    // tier that no longer exists would otherwise resolve to `undefined` and
    // take every setting with it. Same reasoning as `Input._loadBinds`.
    return TIER_IDS.includes(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Store a choice. `'auto'` (or anything unrecognised) clears it, so automatic
 * detection is the absence of a preference rather than a fourth tier that would
 * have to be special-cased in every consumer.
 *
 * @param {string} id
 */
export function storeTierId(id) {
  try {
    if (TIER_IDS.includes(id)) globalThis.localStorage?.setItem(STORAGE, id);
    else globalThis.localStorage?.removeItem(STORAGE);
  } catch { /* private mode; the session's choice still applies */ }
}

/**
 * @param {object} [hints] defaults to `readDeviceHints()`
 * @param {string|null} [pin] a tier id to use regardless of storage and
 *   detection - the `?quality=` URL override. Anything unrecognised is
 *   ignored rather than obeyed, like a stale stored choice.
 * @returns {string} the tier id in force
 */
export function resolveTierId(hints, pin = null) {
  if (TIER_IDS.includes(pin)) return pin;
  return storedTierId() ?? detectTierId(hints ?? readDeviceHints());
}

/**
 * @param {object} [hints]
 * @param {string|null} [pin] see `resolveTierId`
 * @returns {QualityTier}
 */
export function resolveTier(hints, pin = null) {
  return TIERS[resolveTierId(hints, pin)] ?? TIERS.high;
}

/**
 * The half of a tier that can only be applied before the game is built.
 *
 * Called before `new Engine(...)`: the camera's far plane, the pixel-ratio
 * ceiling and the shadow map's resolution are all read out of `CONFIG` by
 * constructors, and the composer's MSAA is read by `PostFX`'s module scope.
 *
 * `geometryScale` joins them because a world that has already been built and
 * merged cannot be re-tessellated - and because this is the hook `main.js`
 * already calls before any world exists, so the kits need nothing threaded
 * through them. It is latched ahead of the `config` guard: a caller with no
 * `CONFIG` still gets a coherent tessellation rather than the previous tier's.
 *
 * @param {QualityTier} tier
 * @param {{render:object}} config
 */
export function applyBootTier(tier, config) {
  if (!tier) return;
  setGeometryScale(tier.geometryScale);
  if (!config?.render) return;
  config.render.maxPixelRatio = tier.maxPixelRatio;
  config.render.far = tier.far;
  config.render.shadowMapSize = tier.shadowMapSize;
}

/**
 * The half that can move at runtime.
 *
 * Every collaborator is optional and every call is guarded: this runs at boot
 * before some of them exist, and again from a menu row where a throw would be a
 * black screen rather than a missing setting.
 *
 * `geometryScale` is deliberately NOT here. Re-latching it mid-session would
 * leave the worlds already built at one tessellation and the ones the lazy
 * prefetcher builds next at another, inside a single session, for no gain a
 * player could see - the built worlds cannot follow. It belongs to
 * `applyBootTier` and to a reload.
 *
 * @param {QualityTier} tier
 * @param {{renderer?:any, camera?:any, engine?:any, postfx?:any, config?:object}} ctx
 */
export function applyTier(tier, ctx = {}) {
  if (!tier) return;
  const { renderer, camera, engine, postfx, config } = ctx;

  postfx?.setQuality?.({ ...tier.postfx });

  if (renderer?.shadowMap) renderer.shadowMap.enabled = tier.shadows;

  if (camera) {
    camera.far = tier.far;
    camera.updateProjectionMatrix?.();
  }

  if (config?.render) {
    // `Engine.resize` and `_adaptResolution` both re-read this, so it has to
    // move before the resize below rather than only at boot.
    config.render.maxPixelRatio = tier.maxPixelRatio;
    config.render.far = tier.far;
  }

  engine?.setResolutionFloor?.(tier.resolutionFloor);
  // The pixel-ratio ceiling only reaches the renderer through a resize.
  engine?.resize?.();
}
