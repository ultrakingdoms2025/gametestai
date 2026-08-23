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
    postfx: { ao: true, shafts: true, bloom: true, smaa: true, film: true },
  },
};

/**
 * Read what the device is willing to say about itself.
 *
 * Split out from `detectTierId` so the heuristic can be driven with values
 * rather than with a faked global.
 *
 * @returns {{deviceMemory?:number, hardwareConcurrency?:number, coarsePointer?:boolean}}
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
  };
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
 * @param {{deviceMemory?:number, hardwareConcurrency?:number, coarsePointer?:boolean}} hints
 * @returns {'low'|'medium'|'high'}
 */
export function detectTierId(hints = {}) {
  const { deviceMemory, hardwareConcurrency, coarsePointer } = hints;
  if (typeof deviceMemory === 'number' && deviceMemory <= 4) return 'low';
  if (typeof hardwareConcurrency === 'number' && hardwareConcurrency <= 4) return 'low';
  /* Safari reports no `deviceMemory` at all and a current iPhone reports six
   * cores, so a purely numeric heuristic hands an iPhone a workstation's
   * settings. A coarse pointer is the fact that is always available. */
  if (coarsePointer) return 'medium';
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
 * @returns {string} the tier id in force
 */
export function resolveTierId(hints) {
  return storedTierId() ?? detectTierId(hints ?? readDeviceHints());
}

/**
 * @param {object} [hints]
 * @returns {QualityTier}
 */
export function resolveTier(hints) {
  return TIERS[resolveTierId(hints)] ?? TIERS.high;
}

/**
 * The half of a tier that can only be applied before the game is built.
 *
 * Called before `new Engine(...)`: the camera's far plane, the pixel-ratio
 * ceiling and the shadow map's resolution are all read out of `CONFIG` by
 * constructors, and the composer's MSAA is read by `PostFX`'s module scope.
 *
 * @param {QualityTier} tier
 * @param {{render:object}} config
 */
export function applyBootTier(tier, config) {
  if (!tier || !config?.render) return;
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
