import * as THREE from 'three';
import { CONFIG } from '../core/Config.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/**
 * The post-processing chain.
 *
 *   RenderPass -> GTAO -> light shafts -> UnrealBloom -> Grade -> Output -> SMAA -> Film
 *
 * The split into *two* creative passes is the whole point of the ordering, and
 * each half lives in the colour space its maths is actually defined in:
 *
 * 1. Everything up to and including `gradePass` runs on **linear, unclamped
 *    HDR**. Bloom's high-pass threshold, the light-shaft high-pass, white
 *    balance, lift/gamma/gain, contrast about middle grey, saturation and haze
 *    are all scene-referred operations - they only behave predictably on the
 *    radiometric signal. A threshold of 0.9 here is *not* "near white": in this
 *    scene a lit floor sits around 2.0 linear, so thresholds are tuned per world
 *    against measured luminance (see `GRADE_PRESETS`).
 *
 * 2. `OutputPass` then applies ACES + the sRGB transfer, `SMAAPass` antialiases
 *    the resulting LDR image (SMAA's edge detection is defined on perceptual,
 *    display-referred data), and `filmPass` finally adds the things that are
 *    properties of the *lens and the print*: barrel warp, chromatic
 *    aberration, vignette, shadow toe, scanlines, grain and dither. Doing those
 *    in linear HDR makes grain vanish in highlights and vignette crush shadows;
 *    doing them before SMAA lets the antialiaser smear the grain.
 *
 * Three things in here are load-bearing and easy to undo by accident:
 *
 * - **The composer's render target carries the scene MSAA** (`MSAA_SAMPLES`).
 *   `WebGLRenderer({antialias})` is inert in this architecture because the scene
 *   never reaches the default framebuffer, and SMAA alone cannot reconstruct
 *   sub-pixel geometry - see the comment on MSAA_SAMPLES.
 * - **The grade's highlight shoulder** (`uHiKnee`/`uHiShoulder`) is what keeps
 *   emissives readable. Bloom and the contrast operator both multiply the top
 *   end; without a shoulder after them, anything genuinely bright resolves to
 *   flat white.
 * - **The dither is the last operation before quantisation**, and has to stay
 *   there. Anything added after it rescales it away from one LSB and the
 *   banding comes back.
 *
 * Everything is wrapped in try/catch: if any pass fails to construct the object
 * degrades to a bare `renderer.render()` and the game keeps running.
 */

/* ------------------------------------------------------------------ */
/* Scratch - no allocation in the per-frame path                       */
/* ------------------------------------------------------------------ */

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _size = new THREE.Vector2();

const QUERY = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
const FORCE_DISABLED = QUERY.get('postfx') === '0';
const AO_DISABLED = QUERY.get('ao') === '0';
const SHAFTS_DISABLED = QUERY.get('godrays') === '0';

/**
 * Scene MSAA sample count on the composer's HDR render target.
 *
 * This - not `WebGLRenderer({antialias})` - is the setting that antialiases the
 * game, because the scene is rendered into this target and the default drawing
 * buffer only ever receives a full-screen quad. SMAA still runs at the end of
 * the chain, but SMAA is a spatial filter working on an already-sampled image:
 * it can soften a staircase it can *see*, and it cannot invent the coverage
 * information needed to reconstruct a 1-pixel truss beam or a chain-link fence
 * wire. 4x MSAA supplies that coverage before anything else touches the frame;
 * SMAA then cleans up the shading and alpha-test edges MSAA leaves behind.
 *
 * Overridable with `?msaa=0|2|4|8` for A/B and for the perf floor.
 */
const MSAA_SAMPLES = (() => {
  const raw = QUERY.get('msaa');
  if (raw !== null) {
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(0, Math.min(8, Math.round(n))) : 4;
  }
  return 4;
})();

/** Rec.709 luminance weights, used identically on the CPU and in both shaders. */
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

/**
 * Bloom strength ceiling. Worlds authored their `environment.bloom` against the
 * old display-referred chain where a strength near 1.0 was survivable; on
 * linear HDR it is not, so the value is accepted but capped.
 */
const BLOOM_STRENGTH_MAX = 0.42;

/**
 * Soft-knee width as a fraction of the bloom threshold.
 *
 * `UnrealBloomPass` ships a `smoothWidth` of 0.01, i.e. a step function: a pixel
 * one part in a hundred above the threshold contributes its full energy and its
 * neighbour one part below contributes none. On an emissive with a gradient
 * across it - a portal iris, a strip light seen end-on - that hard cut is what
 * produces a blown core with a hard bright edge instead of a glow. Widening the
 * knee to half the threshold turns the high-pass into a ramp, so the bloom rises
 * smoothly out of the surface it belongs to and falls off wide and soft.
 *
 * It also makes the chain *tolerant*: whatever absolute level a world hands us,
 * the ramp straddles it instead of either clipping or vanishing.
 */
const BLOOM_KNEE = 0.5;

/**
 * How far a world-supplied tint colour is allowed to pull the balance. A raw
 * `Color(0xd8ecff)` normalises to a +22% blue multiplier, which reads as a
 * filter rather than a grade; 40% of it reads as art direction.
 */
const TINT_STRENGTH = 0.4;

/** Direction "warmth"/"temperature" pushes the white balance, per unit. */
const WARM_AXIS = [1.16, 1.0, 0.76];

/**
 * GTAO's radius is in world metres, and `CONFIG.postfx.ao.radius` reads as a
 * 0..1 fraction. Taken literally at 0.5 m the occlusion is a hairline that
 * vanishes entirely once blended - confirmed by rendering the denoised AO
 * buffer to screen. These worlds are hundreds of metres across with 3-6 m
 * props, so the config value scales a metre radius instead: at the shipped
 * `ao.radius` of 0.5 that lands on 2.4 m, which is the scale at which a crate,
 * a column base or a pair of boots actually darkens the ground it stands on.
 */
const AO_RADIUS_METRES = 4.8;

/**
 * Exponent applied to the raw GTAO visibility term (`ao = pow(ao, scale)` in
 * GTAOShader). This is the contrast control, and it is the right knob to reach
 * for: `blendIntensity` above 1.0 extrapolates past full occlusion and can drive
 * the multiply below zero on a half-float buffer, which shows up as black
 * fringes rather than as darker contact.
 */
const AO_CONTRAST = 2.2;

/** GTAO horizon samples. 16 is the addon default and visibly under-samples 2 m radii. */
const AO_SAMPLES = 24;

/** Consecutive `composer.render()` throws tolerated before the chain gives up. */
const RENDER_FAILURE_LIMIT = 8;

/* ------------------------------------------------------------------ */
/* Shaders                                                             */
/* ------------------------------------------------------------------ */

const FULLSCREEN_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * ONE BAD TEXEL MUST NOT BLACK OUT THE FRAME.
 *
 * `UnrealBloomPass` high-passes the scene, blurs the result through five mip
 * levels and then blends the pyramid additively back over the image. Every one
 * of those steps is a weighted sum, and a weighted sum containing a NaN is a
 * NaN — so ONE non-finite fragment anywhere on screen is smeared across the
 * whole pyramid and the additive composite writes NaN over EVERY pixel of the
 * frame. Nothing downstream can recover it: the grade, the tone map and the
 * sRGB transfer all carry NaN through to a black pixel.
 *
 * That is not hypothetical. Four boxes in `dock/Hulls.js` shipped with a `tile`
 * of 0, which divides by zero in `boxUV` and gives them NaN texture
 * coordinates. Nineteen NaN pixels at `VIEWS.dock` `gantry-crossing` took the
 * frame's mean luminance from 18.99 to 4.08 out of 255 — a world that looked
 * unlit, that no light in it could brighten (ambient 0.22 -> 6.0 moved the mean
 * by 0.07), and that read for a whole review cycle as a lighting problem.
 *
 * This does not fix the cause and is not meant to; it bounds the blast radius
 * to the pixels that are actually broken, so the next occurrence looks like a
 * few black specks on a hull instead of a black world. `scripts/tests/
 * dock-light.test.mjs` is what finds the cause.
 *
 * `notEqual(c, c)` is the NaN test — NaN is the only value not equal to itself
 * — and the `min` clamps an Inf, which blurs into a NaN one step later.
 */
function sanitiseBloomInput(bloomPass) {
  const m = bloomPass?.materialHighPassFilter;
  if (!m || typeof m.fragmentShader !== 'string') return false;
  const anchor = 'vec4 texel = texture2D( tDiffuse, vUv );';
  if (!m.fragmentShader.includes(anchor)) {
    // The addon's shader changed shape. Say so rather than silently not guarding.
    console.warn('[postfx] bloom high-pass shader not in the expected shape; NaN guard NOT installed');
    return false;
  }
  m.fragmentShader = m.fragmentShader.replace(
    anchor,
    `${anchor}
    texel.rgb = mix( texel.rgb, vec3( 0.0 ), vec3( notEqual( texel.rgb, texel.rgb ) ) );
    texel.rgb = min( texel.rgb, vec3( 1.0e4 ) );`
  );
  m.needsUpdate = true;
  return true;
}

/**
 * Scene-referred colour grade. Runs after bloom and *before* `OutputPass`, so
 * the input is linear HDR with values well above 1.0 and nothing is clipped
 * yet. Tone mapping deliberately happens downstream.
 */
const GradeShader = {
  name: 'AetherGradeShader',
  uniforms: {
    tDiffuse: { value: null },

    uBalance: { value: new THREE.Vector3(1, 1, 1) },
    uLift: { value: new THREE.Vector3(0, 0, 0) },
    uGamma: { value: new THREE.Vector3(1, 1, 1) },
    uGain: { value: new THREE.Vector3(1, 1, 1) },
    uShadowTint: { value: new THREE.Vector3(1, 1, 1) },
    uHighlightTint: { value: new THREE.Vector3(1, 1, 1) },
    uSplit: { value: 0.28 },

    uContrast: { value: 1.06 },
    uSaturation: { value: 1.05 },
    uToe: { value: 0.14 },

    uHiKnee: { value: 1.0 },
    uHiShoulder: { value: 1.6 },

    uHaze: { value: 0.02 },
    uHazeColor: { value: new THREE.Vector3(0.1, 0.14, 0.2) },
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
    precision highp float;

    varying vec2 vUv;

    uniform sampler2D tDiffuse;

    uniform vec3  uBalance;
    uniform vec3  uLift;
    uniform vec3  uGamma;
    uniform vec3  uGain;
    uniform vec3  uShadowTint;
    uniform vec3  uHighlightTint;
    uniform float uSplit;

    uniform float uContrast;
    uniform float uSaturation;
    uniform float uToe;

    uniform float uHiKnee;
    uniform float uHiShoulder;

    uniform float uHaze;
    uniform vec3  uHazeColor;

    const vec3  LUMA = vec3(${LUMA_R}, ${LUMA_G}, ${LUMA_B});
    const float MIDGREY = 0.18;

    void main() {
      vec3 col = texture2D(tDiffuse, vUv).rgb;
      /* NaN survives a max() - every comparison against it is false - so it
       * has to be tested for by name. Same guard as sanitiseBloomInput, one
       * pass later, so a non-finite fragment that reaches the grade stays one
       * black pixel instead of being multiplied through the contrast and
       * saturation operators. (No backticks in here: this whole shader is a
       * template literal and one would end it.) */
      col = mix(col, vec3(0.0), vec3(notEqual(col, col)));
      col = max(col, 0.0);

      /* --- white balance and exposure gain ------------------------- */
      col *= uBalance * uGain;

      // Pedestal. Scaled by (1 - col) so it lifts the floor without also
      // adding a constant to a 5.0-linear light fixture.
      col += uLift * max(1.0 - col, 0.0);

      // A bounded view of an unbounded signal. Every region mask below is
      // measured on this, so "shadows" and "highlights" keep meaning when the
      // input runs to 6.0 and beyond.
      float lum = dot(col, LUMA);
      float ln = lum / (1.0 + lum);

      /* --- split toning -------------------------------------------- */
      float shadowW = 1.0 - smoothstep(0.0, 0.40, ln);
      float highW = smoothstep(0.32, 0.85, ln);
      col = mix(col, col * uShadowTint, shadowW * uSplit);
      col = mix(col, col * uHighlightTint, highW * uSplit);

      /* --- gamma / contrast ---------------------------------------- */
      col = pow(max(col, 0.0), uGamma);

      // Contrast as a power about middle grey. On scene-referred data this is
      // the correct pivot; the (x - 0.5) * c + 0.5 form belongs to display
      // space and would crush everything here, since the median pixel of a lit
      // interior sits nowhere near 0.5 linear.
      col = pow(max(col, 1e-5) / MIDGREY, vec3(uContrast)) * MIDGREY;

      // Toe: deepen the darkest values only, for readable black shadows once
      // ACES has lifted them downstream.
      col *= mix(1.0, smoothstep(0.0, 0.12, ln), uToe);

      /* --- saturation ---------------------------------------------- */
      lum = dot(col, LUMA);
      col = max(mix(vec3(lum), col, uSaturation), 0.0);

      /* --- highlight shoulder --------------------------------------- */
      // The contrast operator above is a power about middle grey, so it does not
      // just add contrast - it *multiplies* the top end. A portal iris sitting at
      // 8.0 linear leaves it near 14.0, bloom has already added a halo on top of
      // that, and ACES then maps the whole region to a single flat white: the
      // "featureless blob with no readable iris" the review called out.
      //
      // This is a logarithmic shoulder rather than an asymptote. An asymptote
      // (Reinhard, a max-white clamp) maps everything above the knee onto a
      // vanishing range and destroys the very structure it is supposed to save;
      // a log curve keeps compressing, slowly, forever, so two pixels four stops
      // apart above the knee still land on two different values. Mid-tones below
      // uHiKnee are passed through untouched, and the curve is C1-continuous
      // there, so there is no visible seam where it engages.
      //
      // Luminance-only by design: compressing the channels independently pulls
      // every bright hue towards white, which is the same failure by another
      // route. The ratio between channels - the hue and saturation of the
      // emissive - is preserved exactly.
      float L = dot(col, LUMA);
      if (L > uHiKnee) {
        float compressed = uHiKnee + uHiShoulder * log(1.0 + (L - uHiKnee) / uHiShoulder);
        col *= compressed / max(L, 1e-5);
      }

      /* --- atmospheric haze (additive, shadows only) ---------------- */
      col += uHazeColor * (uHaze * (1.0 - smoothstep(0.0, 0.45, ln)));

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

/**
 * Display-referred finishing pass. Runs last, on the tone-mapped, sRGB-encoded,
 * antialiased image - which is where lens and film artefacts belong.
 */
const FilmShader = {
  name: 'AetherFilmShader',
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new THREE.Vector2(1920, 1080) },
    uAspect: { value: 16 / 9 },
    uTime: { value: 0 },

    uDistortion: { value: 0.014 },
    uChroma: { value: 0.0014 },

    uVignette: { value: 0.32 },
    uVignetteSoft: { value: 0.28 },

    uToeLift: { value: 0.016 },

    uGrain: { value: 0.016 },
    uScanline: { value: 0.0 },
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
    precision highp float;

    varying vec2 vUv;

    uniform sampler2D tDiffuse;
    uniform vec2  uResolution;
    uniform float uAspect;
    uniform float uTime;

    uniform float uDistortion;
    uniform float uChroma;

    uniform float uVignette;
    uniform float uVignetteSoft;

    uniform float uToeLift;

    uniform float uGrain;
    uniform float uScanline;

    const vec3 LUMA = vec3(${LUMA_R}, ${LUMA_G}, ${LUMA_B});

    float hash21(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    /**
     * Interleaved gradient noise. Cheaper than a hash, and - unlike a hash - its
     * output is spatially decorrelated in a way that looks like fine grain
     * rather than like salt and pepper, which is exactly what a dither pattern
     * wants to be.
     */
    float ign(vec2 p) {
      return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
    }

    void main() {
      // Aspect-corrected centred coordinates: everything radial below is
      // measured in these so the effect is circular, not elliptical.
      vec2 p = vUv - 0.5;
      p.x *= uAspect;
      float r2 = dot(p, p);

      // Barrel warp. Sampling *inwards* (k < 1) guarantees we never read
      // outside the buffer, which would smear the clamped edge texels.
      float k = 1.0 - uDistortion * r2;
      vec2 warped = p * k;
      vec2 duv = vec2(warped.x / uAspect, warped.y) + 0.5;

      // Per-channel radial dispersion, quadratic so the centre stays clean.
      // The radial term is deliberately gentle: at 1080p this puts ~3px of
      // fringe in the extreme corner and none in the readable middle third.
      vec2 caDir = vec2(warped.x / uAspect, warped.y);
      float ca = uChroma * (0.08 + r2 * 0.85);
      vec3 col;
      col.r = texture2D(tDiffuse, clamp(duv + caDir * ca, 0.0, 1.0)).r;
      col.g = texture2D(tDiffuse, clamp(duv, 0.0, 1.0)).g;
      col.b = texture2D(tDiffuse, clamp(duv - caDir * ca, 0.0, 1.0)).b;

      /* --- vignette ------------------------------------------------- */
      // Long smoothstep ramp: no visible ring, just a slow corner falloff.
      float vd = sqrt(r2) * 1.42;
      col *= 1.0 - uVignette * smoothstep(uVignetteSoft, 1.30, vd);

      float luma = dot(col, LUMA);

      /* --- shadow toe ----------------------------------------------- */
      // ACES plus a scene-referred contrast curve puts a lot of the frame in the
      // bottom two or three code values, where 8-bit output simply has nowhere
      // left to put detail - hulls, cobbles and grass all crush to the same
      // black. A small additive pedestal confined to the darkest quarter of the
      // range buys that detail back: it costs a little absolute black in a game
      // that is watched on a lit desk anyway, and it is what puts the shadow
      // *inside* the vignette instead of merging with it.
      //
      // Deliberately after the vignette, so vignetted corners get the same floor
      // as the rest of the frame rather than being crushed by the multiply.
      col += uToeLift * (1.0 - smoothstep(0.0, 0.26, luma));

      /* --- scanlines / interference (station only) ------------------ */
      if (uScanline > 0.0) {
        float lines = sin(vUv.y * uResolution.y * 1.55 + uTime * 2.2);
        col *= 1.0 - uScanline * (0.5 + 0.5 * lines);
        float band = fract(vUv.y * 0.55 - uTime * 0.07);
        float bandAmt = smoothstep(0.0, 0.05, band) * (1.0 - smoothstep(0.05, 0.16, band));
        col += vec3(0.30, 0.72, 1.0) * bandAmt * uScanline * 0.45;
      }

      /* --- film grain ----------------------------------------------- */
      // Quantised to 24 fps so the grain steps like film instead of
      // strobing at whatever refresh rate the display happens to run at.
      //
      // AND WRAPPED, WHICH IS THE WHOLE OF WHY THE GAME USED TO GO DARK AND
      // STAY DARK. uTime is unbounded - PostFX.update does this._time += dt
      // and never wraps it - and this line used to be a bare
      // floor(uTime * 24.0) feeding hash21. hash21's first operation is
      // p * vec2(123.34, 456.21); once that product passes 2^23 the float32
      // ULP is >= 1, so the rounded product IS an integer, fract returns
      // exactly 0 for both components, and the hash returns 0. Both taps
      // return 0, grain is 0 + 0 - 1 = -1.0 on every pixel of every frame from
      // then on, and the pass subtracts a flat uGrain from the whole image for
      // the rest of the session.
      //
      // Measured by float32 emulation of this exact expression - see
      // scripts/tests/postfx-grain.test.mjs, which runs the sweep - the
      // collapse is total at tq = 3971, i.e. at uTime 165.5 s, and the hash is
      // already down to 8 distinct values over a 64x64 tile by tq 1080 (45 s)
      // with a mean of -0.14. In the browser at the kestrel framing, world
      // frozen: mean frame luma 23.20 at uTime 0.5, 16.54 at 170 s and locked
      // at 16.63 from there on; 21.14 with uGrain forced to 0 at the same
      // instant.
      //
      // Two changes, and both are needed. The mod keeps the argument small
      // enough that no hash can degenerate however long the tab is left open;
      // ign replaces hash21 because even under the wrap hash21 is badly
      // conditioned at these magnitudes - emulated at tq 1440 it gives 8
      // distinct values and an adjacent-column mean swing of 0.357, which is
      // the vertical striping this pass used to lay over every flat wall. ign
      // measures 0.012 at the same tq, and it is what the dither below has
      // always used.
      float tq = mod(floor(uTime * 24.0), 512.0);
      vec2 gp = vUv * uResolution;
      float n1 = ign(gp + tq * 17.13);
      float n2 = ign(gp + tq * 17.13 + 91.7);
      float grain = n1 + n2 - 1.0;   // triangular PDF - far less "crawly" than uniform
      col += grain * uGrain * (0.35 + 0.65 * (1.0 - smoothstep(0.15, 0.95, luma)));

      /* --- output dither -------------------------------------------- */
      // The genuinely last operation in the chain, and it has to be: dither is
      // only correct immediately before quantisation, and everything above -
      // vignette, toe, grain - is a multiply or an add that would rescale the
      // noise away from the one-LSB amplitude the quantiser needs.
      //
      // Triangular PDF (two independent samples minus one) spanning +/-1 LSB.
      // A uniform +/-0.5 LSB dither, which is what this pass used to do,
      // decorrelates the quantisation error but leaves its *variance* dependent
      // on the signal - so a slow sky gradient still shows its steps breathing.
      // TPDF makes the error independent of the signal outright, which is what
      // actually removes the contours from a 400 m sky and a flat plated wall.
      vec2 dp = gp + tq * 0.71;
      float d = ign(dp) + ign(dp + 111.7) - 1.0;
      col += d * (1.0 / 255.0);

      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
  `,
};

/* ------------------------------------------------------------------ */
/* Light-shaft shader                                                  */
/* ------------------------------------------------------------------ */

const LightShaftShader = {
  name: 'AetherLightShaftShader',
  uniforms: {
    tDiffuse: { value: null },
    uSunPos: { value: new THREE.Vector2(0.5, 0.5) },
    uDensity: { value: 0.72 },
    uDecay: { value: 0.94 },
    uWeight: { value: 0.022 },
    uThreshold: { value: 1.6 },
    uIntensity: { value: 0.0 },
    uTint: { value: new THREE.Vector3(1, 0.92, 0.78) },
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
    precision highp float;

    varying vec2 vUv;

    uniform sampler2D tDiffuse;
    uniform vec2  uSunPos;
    uniform float uDensity;
    uniform float uDecay;
    uniform float uWeight;
    uniform float uThreshold;
    uniform float uIntensity;
    uniform vec3  uTint;

    const int SAMPLES = 24;

    float hash21(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    void main() {
      vec3 base = texture2D(tDiffuse, vUv).rgb;

      // uIntensity is driven on the CPU from sun visibility, so an off-screen
      // or behind-camera sun costs one texture fetch and nothing else.
      if (uIntensity <= 0.0001) {
        gl_FragColor = vec4(base, 1.0);
        return;
      }

      vec2 delta = (vUv - uSunPos) * (uDensity / float(SAMPLES));

      // Jittering the march start trades hard stair-step ghosts of the
      // occluders for high-frequency noise, which the film grain then hides.
      float jitter = hash21(vUv * 1024.0);
      vec2 uv = vUv - delta * jitter;
      float illum = pow(uDecay, jitter);
      vec3 accum = vec3(0.0);

      for (int i = 0; i < SAMPLES; i++) {
        uv -= delta;
        vec3 s = texture2D(tDiffuse, clamp(uv, 0.0, 1.0)).rgb;
        // High-pass on *linear* radiance: only genuinely emissive pixels throw
        // shafts, so a lit wall between the camera and the sun never becomes a
        // smear. Thresholds live in the same units as the bloom threshold.
        accum += max(s - uThreshold, 0.0) * illum;
        illum *= uDecay;
      }

      gl_FragColor = vec4(base + accum * (uWeight * uIntensity) * uTint, 1.0);
    }
  `,
};

/* ------------------------------------------------------------------ */
/* Per-world grade presets                                             */
/* ------------------------------------------------------------------ */

/**
 * Bloom and shaft thresholds below are *linear HDR luminance*, measured from
 * the actual RenderPass output at each world's spawn:
 *
 *   station   median 0.06, p90 2.04 (the lit deck plate), peak 5.2 (fixtures)
 *   medieval  median 0.01, p90 0.18, peak 1.17 (sky and sunlit thatch)
 *   sports    median 0.19, p90 1.15, peak 1.63 (snow and floodlights)
 *
 * Each threshold sits above that world's p95 so lit surfaces stay crisp and
 * only emissives clear the high-pass.
 */
const BASE_GRADE = {
  bloom: { strength: 0.34, radius: 0.85, threshold: 1.80 },
  ao: 1.0,
  distortion: 0.014,
  chroma: 0.0014,
  balance: [1, 1, 1],
  lift: [0, 0, 0],
  gamma: [1, 1, 1],
  gain: [1, 1, 1],
  shadowTint: [1, 1, 1],
  highlightTint: [1, 1, 1],
  split: 0.28,
  toe: 0.10,
  contrast: 1.06,
  saturation: 1.05,
  hiKnee: 1.0,
  hiShoulder: 1.6,
  haze: 0.02,
  hazeColor: [0.10, 0.14, 0.20],
  vignette: 0.32,
  vignetteSoft: 0.28,
  toeLift: 0.014,
  grain: 0.016,
  scanline: 0.0,
  shafts: 0.0,
  shaftTint: [1, 0.94, 0.84],
  shaftDensity: 0.72,
  shaftDecay: 0.94,
  shaftWeight: 0.022,
  shaftThreshold: 1.60,
};

/**
 * Named looks. A world selects one via `environment.grade` (a string), or
 * overrides individual fields by passing an object instead.
 */
const GRADE_PRESETS = {
  /**
   * Orbital station: cool steel structure lit warm.
   *
   * Round 1 read this world as monochrome, and the grade was the reason - the
   * shadows *and* the highlights were both pushed blue, so every form separated
   * from every other form by brightness alone. The fix is complementary split
   * toning: the shadows keep (and slightly deepen) their cold blue, while the
   * highlights and the bounce carry a warm amber that matches the hazard
   * striping and the dock lighting the world already contains. Nothing about
   * the world's own palette changed; the two halves of the value range simply
   * stopped agreeing with each other.
   */
  station: {
    // Threshold above the 2.0-ish lit deck plate so plating never glows, with a
    // wide soft knee (BLOOM_KNEE) so the ramp still catches a portal or a strip
    // light whatever level it is authored at.
    bloom: { strength: 0.30, radius: 0.92, threshold: 3.00 },
    distortion: 0.020,
    chroma: 0.0016,
    balance: [0.968, 1.0, 1.055],
    lift: [0.0022, 0.0028, 0.0052],
    gamma: [1.0, 1.0, 1.0],
    gain: [1.0, 1.0, 1.0],
    shadowTint: [0.70, 0.90, 1.22],
    highlightTint: [1.14, 1.01, 0.80],
    split: 0.44,
    toe: 0.08,
    contrast: 1.12,
    saturation: 1.12,
    hiKnee: 0.95,
    hiShoulder: 1.45,
    haze: 0.030,
    hazeColor: [0.050, 0.110, 0.190],
    vignette: 0.38,
    vignetteSoft: 0.24,
    toeLift: 0.020,
    grain: 0.020,
    scanline: 0.014,
    shafts: 0.18,
    shaftTint: [0.72, 0.92, 1.0],
    shaftWeight: 0.014,
    shaftThreshold: 3.20,
  },

  /**
   * Lodestar Yard: a cold shed lit by sodium.
   *
   * Built as the STATION'S INVERSE, deliberately. The station preset is a
   * complementary split-tone with cold shadows and warm highlights over a
   * near-neutral balance, and it works because the world's own palette is a
   * cold blue hull. The yard's palette is already warm - amber worklights,
   * ochre hazard paint, rust weep - so repeating that in the highlights would
   * give a monochrome amber frame with nothing to separate a lit hull from a
   * lit floor. So the split runs the other way: the SHADOWS carry the blue
   * that is genuinely in the room (a clerestory band of daylight, the cyan
   * wayfinding, the cool rim on every character) and the highlights stay
   * nearly neutral, letting the sodium do its own work rather than being
   * pushed further into orange by the grade.
   *
   * Contrast and toe are the other half. This is the darkest interior in the
   * game - ambient 0.22 plus hemi 0.34 - and a shed read through the station's
   * 0.08 toe collapses the unlit two thirds of the bay to black. A higher toe
   * lift plus slightly less contrast keeps structure in the dark, which is
   * what makes a half-finished world read as half finished rather than as
   * under-lit.
   *
   * -- THE THIRD PASS, and it is on the SHADOW end deliberately -----------
   * `toe` 0.06 -> 0.030 and `toeLift` 0.030 -> 0.058. Measured off the
   * drawing buffer at 1600x900 with `readPixels`, Rec.709 luma 0-255, over
   * the framings a player actually stands in:
   *
   *   framing          before   after
   *   apron-arrival     38.0
   *   keel-line         33.2
   *   chandlery         36.2
   *   yard-wide         32.1
   *   kestrel           31.2
   *   mouth-inside      32.3
   *
   * A tester who played the loop cold called that "a big dark room", which is
   * the player's own second rejection of this world word for word.
   *
   * These two controls and not `exposure`, for two reasons that both matter.
   * The bloom threshold below (2.40) is calibrated against this world's
   * measured LINEAR luminance and exposure scales that before tone mapping, so
   * reaching for exposure silently re-points the bloom - `dock-light.test.mjs`
   * pins 1.20 for exactly that reason. And the complaint is not that the lit
   * parts are dim; it is that everything between them is black. `uToe`
   * multiplies the darks DOWN (`col *= mix(1.0, smoothstep(0, 0.12, ln),
   * uToe)`) and `uToeLift` adds back only under 26% luma
   * (`col += uToeLift * (1 - smoothstep(0, 0.26, luma))`), so this pair acts
   * on precisely the pixels that were the problem and leaves the sodium pools
   * and the bloom operating point where they were.
   *
   * Bloom threshold 2.40, not the station's 3.00: the sodium practicals are
   * authored at 22-26 cd against the station's 1050-at-5 m fittings and the
   * emissive strip runs sit lower again, so at 3.00 nothing in this world
   * blooms at all and the worklights read as painted rectangles.
   */
  dock: {
    bloom: { strength: 0.34, radius: 0.90, threshold: 2.40 },
    distortion: 0.018,
    chroma: 0.0018,
    balance: [1.012, 1.0, 0.982],
    lift: [0.0042, 0.0044, 0.0062],
    gamma: [1.0, 1.0, 1.0],
    gain: [1.0, 1.0, 1.0],
    shadowTint: [0.66, 0.86, 1.28],
    highlightTint: [1.06, 1.0, 0.90],
    split: 0.50,
    toe: 0.030,
    contrast: 1.07,
    saturation: 1.06,
    hiKnee: 0.94,
    hiShoulder: 1.55,
    haze: 0.038,
    hazeColor: [0.070, 0.090, 0.140],
    vignette: 0.42,
    vignetteSoft: 0.26,
    toeLift: 0.058,
    grain: 0.026,
    scanline: 0.010,
    /* God rays through the clerestory band, and only there. Kept low and
     * cool: the shafts a shed gets are daylight through high glazing, not the
     * medieval world's 0.55 of golden hour through trees. */
    shafts: 0.22,
    shaftTint: [0.78, 0.90, 1.0],
    shaftWeight: 0.016,
    shaftThreshold: 2.60,
  },

  /**
   * Open space: hard, clean and almost ungraded.
   *
   * One key, no atmosphere and no bounce. Everything this preset does is
   * subtractive - no haze, no shafts, a low toe and a small vignette - because
   * the only thing that sells vacuum is that nothing softens the terminator.
   * The bloom threshold is the lowest in the game so the beacons and the
   * portal actually flare against a black field; there is nothing else in the
   * frame bright enough for it to catch.
   */
  space: {
    bloom: { strength: 0.42, radius: 0.94, threshold: 1.60 },
    distortion: 0.010,
    chroma: 0.0012,
    balance: [0.976, 1.0, 1.048],
    lift: [0.0, 0.0, 0.0012],
    gamma: [1.0, 1.0, 1.0],
    gain: [1.0, 1.0, 1.0],
    shadowTint: [0.74, 0.88, 1.18],
    highlightTint: [1.0, 1.0, 1.02],
    split: 0.34,
    toe: 0.03,
    contrast: 1.16,
    saturation: 1.04,
    hiKnee: 0.96,
    hiShoulder: 1.35,
    haze: 0.0,
    hazeColor: [0.0, 0.0, 0.0],
    vignette: 0.30,
    vignetteSoft: 0.30,
    toeLift: 0.004,
    grain: 0.014,
    scanline: 0.008,
    shafts: 0.0,
    shaftTint: [1.0, 1.0, 1.0],
    shaftWeight: 0.0,
    shaftThreshold: 4.0,
  },

  /** Castle + village at golden hour: warm, soft bloom, hazy depth. */
  medieval: {
    // Golden hour survives untouched apart from the shared bloom/shoulder work:
    // the warm-highlight / cool-shadow tension this world already had is the
    // model the station preset was rebuilt against.
    bloom: { strength: 0.34, radius: 0.88, threshold: 1.30 },
    distortion: 0.014,
    chroma: 0.0016,
    balance: [1.060, 1.0, 0.905],
    lift: [0.0060, 0.0044, 0.0026],
    gamma: [1.0, 1.0, 1.0],
    gain: [1.0, 1.0, 1.0],
    shadowTint: [0.80, 0.91, 1.20],
    highlightTint: [1.12, 0.99, 0.80],
    split: 0.42,
    toe: 0.10,
    contrast: 1.09,
    saturation: 1.10,
    hiKnee: 0.90,
    hiShoulder: 1.70,
    haze: 0.050,
    hazeColor: [0.340, 0.240, 0.160],
    vignette: 0.34,
    vignetteSoft: 0.28,
    toeLift: 0.018,
    grain: 0.018,
    scanline: 0.0,
    shafts: 0.55,
    shaftTint: [1.0, 0.86, 0.62],
    shaftDensity: 0.52,
    shaftDecay: 0.955,
    shaftWeight: 0.022,
    shaftThreshold: 1.00,
  },

  /** Sports complex: bright, neutral, high-key, crisp, almost no grain. */
  sports: {
    // Sunlit snow reaches ~2.0 linear from the plaza, well above the p99 of
    // 1.52 measured at spawn; the threshold clears it so only the floodlights
    // and specular glints bloom. The split stays small on purpose - this world
    // is meant to read as bright neutral daylight, so it gets just enough
    // cool-shadow / warm-sun separation to keep white surfaces from flattening
    // into each other, and no more.
    bloom: { strength: 0.26, radius: 0.72, threshold: 2.30 },
    distortion: 0.008,
    chroma: 0.0009,
    balance: [1.0, 1.0, 1.010],
    lift: [0.0006, 0.0006, 0.0018],
    gamma: [1.0, 1.0, 1.0],
    gain: [1.0, 1.0, 1.0],
    shadowTint: [0.88, 0.95, 1.12],
    highlightTint: [1.06, 1.01, 0.94],
    split: 0.26,
    toe: 0.06,
    contrast: 1.11,
    saturation: 1.10,
    hiKnee: 1.05,
    hiShoulder: 1.90,
    haze: 0.020,
    hazeColor: [0.420, 0.500, 0.620],
    vignette: 0.22,
    vignetteSoft: 0.34,
    toeLift: 0.012,
    grain: 0.008,
    scanline: 0.0,
    shafts: 0.22,
    shaftTint: [1.0, 0.98, 0.92],
    shaftWeight: 0.016,
    shaftThreshold: 1.35,
  },
};

/**
 * Uniform routing tables: `[uniformName, gradeKey]`. Kept as module constants so
 * the per-frame blend allocates nothing.
 */
const GRADE_SCALARS = [
  ['uSplit', 'split'],
  ['uContrast', 'contrast'],
  ['uSaturation', 'saturation'],
  ['uToe', 'toe'],
  ['uHiKnee', 'hiKnee'],
  ['uHiShoulder', 'hiShoulder'],
  ['uHaze', 'haze'],
];

const GRADE_VECTORS = [
  ['uBalance', 'balance'],
  ['uLift', 'lift'],
  ['uGamma', 'gamma'],
  ['uGain', 'gain'],
  ['uShadowTint', 'shadowTint'],
  ['uHighlightTint', 'highlightTint'],
  ['uHazeColor', 'hazeColor'],
];

const FILM_SCALARS = [
  ['uDistortion', 'distortion'],
  ['uChroma', 'chroma'],
  ['uVignette', 'vignette'],
  ['uVignetteSoft', 'vignetteSoft'],
  ['uToeLift', 'toeLift'],
  ['uGrain', 'grain'],
  ['uScanline', 'scanline'],
];

/* ------------------------------------------------------------------ */
/* Grade-override normalisation                                        */
/* ------------------------------------------------------------------ */

/** Scalar keys a world may override, mapped to their canonical grade key. */
const SCALAR_OVERRIDES = {
  contrast: 'contrast',
  saturation: 'saturation',
  split: 'split',
  toe: 'toe',
  filmic: 'toe',
  toeLift: 'toeLift',
  shadowLift: 'toeLift',
  hiKnee: 'hiKnee',
  hiShoulder: 'hiShoulder',
  haze: 'haze',
  distortion: 'distortion',
  chroma: 'chroma',
  chromatic: 'chroma',
  chromaticAberration: 'chroma',
  vignette: 'vignette',
  vignetteSoft: 'vignetteSoft',
  grain: 'grain',
  filmGrain: 'grain',
  scanline: 'scanline',
  shafts: 'shafts',
  shaftDensity: 'shaftDensity',
  shaftDecay: 'shaftDecay',
  shaftWeight: 'shaftWeight',
  shaftThreshold: 'shaftThreshold',
  ao: 'ao',
};

/** Vector keys a world may override; values may be Color, Vector3, array or number. */
const VECTOR_OVERRIDES = {
  balance: 'balance',
  lift: 'lift',
  gamma: 'gamma',
  gain: 'gain',
  shadowTint: 'shadowTint',
  highlightTint: 'highlightTint',
  hazeColor: 'hazeColor',
  shaftTint: 'shaftTint',
};

/** `true` for a finite number - the guard that keeps NaN out of every uniform. */
function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Coerce anything a world might plausibly hand us into a `[r, g, b]` triple.
 *
 * `THREE.Color` is the important case: colour management stores it already
 * linearised, which is exactly the space the grade shader works in. A bare
 * number becomes a neutral triple. Anything unrecognised - or containing a NaN
 * - returns `null` so the caller can keep the preset value instead of poisoning
 * a uniform (a single NaN multiplies the whole frame to black).
 *
 * @param {*} value
 * @returns {number[]|null}
 */
function toTriple(value) {
  let out = null;
  if (Array.isArray(value) && value.length >= 3) out = [value[0], value[1], value[2]];
  else if (value && value.isColor) out = [value.r, value.g, value.b];
  else if (value && value.isVector3) out = [value.x, value.y, value.z];
  else if (isNum(value)) out = [value, value, value];
  if (!out || !isNum(out[0]) || !isNum(out[1]) || !isNum(out[2])) return null;
  return out;
}

/** Scale a triple so its Rec.709 luminance is 1.0 - a pure hue shift, no exposure change. */
function lumaNormalise(rgb) {
  const l = LUMA_R * rgb[0] + LUMA_G * rgb[1] + LUMA_B * rgb[2];
  if (!isNum(l) || l <= 1e-4) return [1, 1, 1];
  return [rgb[0] / l, rgb[1] / l, rgb[2] / l];
}

/** `target[i] *= mix(1, tint[i], strength)`, in place. */
function applyTint(target, tint, strength) {
  for (let i = 0; i < 3; i++) target[i] *= 1 + (tint[i] - 1) * strength;
}

/* ------------------------------------------------------------------ */
/* PostFX                                                              */
/* ------------------------------------------------------------------ */

class PostFX {
  /** @param {import('../core/Engine.js').Engine} engine */
  constructor(engine) {
    this.engine = engine;
    this.renderer = engine.renderer;
    this.scene = engine.scene;
    this.camera = engine.camera;

    this.composer = null;
    this.renderPass = null;
    this.gtaoPass = null;
    this.shaftPass = null;
    this.bloomPass = null;
    this.gradePass = null;
    this.outputPass = null;
    this.smaaPass = null;
    this.filmPass = null;

    this._enabled = false;
    this._time = 0;
    this._snapGrade = true;
    this._frames = 0;
    this._slowStrikes = 0;
    this._fastStrikes = 0;
    this._degraded = false;
    this._msaa = 0;
    this._renderFailures = 0;
    this._sunDir = new THREE.Vector3(0, 1, 0);
    this._shaftAmount = 0;
    this._pixelRatio = 1;
    this._aoIntensity = CONFIG.postfx.ao.intensity ?? 1;

    /** Blend targets - the uniforms chase these so world swaps cross-fade. */
    this._target = {
      bloomStrength: BASE_GRADE.bloom.strength,
      bloomRadius: BASE_GRADE.bloom.radius,
      bloomThreshold: BASE_GRADE.bloom.threshold,
      shafts: 0,
      shaftTint: new THREE.Vector3(1, 0.94, 0.84),
      ao: 1,
    };
    for (const [uniform, key] of GRADE_SCALARS) this._target[uniform] = BASE_GRADE[key];
    for (const [uniform, key] of FILM_SCALARS) this._target[uniform] = BASE_GRADE[key];
    for (const [uniform, key] of GRADE_VECTORS) {
      this._target[uniform] = new THREE.Vector3().fromArray(BASE_GRADE[key]);
    }

    /** Which named world the grade last resolved to; also picks the preset. */
    this._worldId = null;
    engine.bus?.on?.('world:changed', ({ id }) => {
      // Fires before main.js's own handler (registered later), so the id is
      // already correct by the time setWorldGrade() runs.
      this._worldId = id;
    });

    this._build();
  }

  /* ---------------------------------------------------------------- */
  /* Construction                                                      */
  /* ---------------------------------------------------------------- */

  _build() {
    if (FORCE_DISABLED) {
      console.info('[PostFX] disabled by ?postfx=0 - rendering directly.');
      return;
    }

    try {
      const renderer = this.renderer;
      renderer.getSize(_size);
      const pr = renderer.getPixelRatio();
      const w = Math.max(1, Math.round(_size.x * pr));
      const h = Math.max(1, Math.round(_size.y * pr));

      // HalfFloat everywhere: the scene is HDR and bloom thresholds only make
      // sense if values above 1.0 survive the first buffer.
      //
      // `samples` is the game's actual anti-aliasing (see MSAA_SAMPLES). It is
      // only honoured on WebGL2 - on a WebGL1 context three silently ignores it
      // and we would be paying nothing for nothing, so the capability is checked
      // rather than assumed. EffectComposer clones this target for its second
      // ping-pong buffer, so the sample count carries to both.
      const msaa = renderer.capabilities.isWebGL2 ? MSAA_SAMPLES : 0;
      const rt = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType,
        depthBuffer: true,
        stencilBuffer: false,
        samples: msaa,
      });
      rt.texture.name = 'PostFX.rt';
      this._msaa = msaa;

      const composer = new EffectComposer(renderer, rt);
      composer.setPixelRatio(pr);
      composer.setSize(_size.x, _size.y);
      this._pixelRatio = pr;

      this.renderPass = new RenderPass(this.scene, this.camera);
      composer.addPass(this.renderPass);

      // --- ambient occlusion -------------------------------------------------
      // GTAOPass builds its own normal+depth prepass when no G-buffer is handed
      // in (the `undefined` fifth argument), and re-reads camera.near/far every
      // frame, so it only needs a correctly configured camera - which Engine
      // gives it. Verified contributing: with blendIntensity at 1 the denoised
      // AO buffer darkens creases by ~25% versus a flat white buffer.
      if (CONFIG.postfx.ao.enabled && !AO_DISABLED) {
        try {
          this.gtaoPass = new GTAOPass(
            this.scene,
            this.camera,
            w,
            h,
            undefined,
            {
              // Contact-scale occlusion at the scale the *worlds* are built to:
              // a 2.4 m gathering radius is roughly the height of a crate, the
              // width of a doorway and the length of a stride, so it darkens
              // where a crate meets the deck, where a wall meets the floor and
              // where a character's feet meet the ground - which is the whole
              // point. Half a metre, which is what the raw config value would
              // give, occludes nothing bigger than a bolt head and disappears
              // completely under the denoiser.
              radius: AO_RADIUS_METRES * (CONFIG.postfx.ao.radius ?? 0.5),
              // Bias the samples towards the near end of the radius: contact
              // shadows are what is missing, not a soft global dimming.
              distanceExponent: 1.4,
              thickness: 1.0,
              distanceFallOff: 1.0,
              scale: AO_CONTRAST,
              samples: AO_SAMPLES,
              screenSpaceRadius: false,
            },
            { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, radiusExponent: 1, rings: 2, samples: 8 }
          );
          this.gtaoPass.output = GTAOPass.OUTPUT.Default;
          this.gtaoPass.blendIntensity = this._aoIntensity;
          excludeEffectsFromAO(this.gtaoPass);
          composer.addPass(this.gtaoPass);
        } catch (err) {
          console.warn('[PostFX] GTAO unavailable, continuing without AO:', err);
          this.gtaoPass = null;
        }
      }

      // --- light shafts (linear HDR) ----------------------------------------
      if (!SHAFTS_DISABLED) {
        this.shaftPass = new ShaderPass(LightShaftShader);
        composer.addPass(this.shaftPass);
      }

      // --- bloom (linear HDR; threshold is scene-referred luminance) ---------
      const b = CONFIG.postfx.bloom;
      this.bloomPass = new UnrealBloomPass(
        new THREE.Vector2(w, h),
        Math.min(b.strength, BLOOM_STRENGTH_MAX),
        BASE_GRADE.bloom.radius,
        BASE_GRADE.bloom.threshold
      );
      sanitiseBloomInput(this.bloomPass);
      composer.addPass(this.bloomPass);

      // --- creative grade, still linear and unclamped ------------------------
      this.gradePass = new ShaderPass(GradeShader);
      composer.addPass(this.gradePass);

      // --- ACES tone map + sRGB transfer -------------------------------------
      this.outputPass = new OutputPass();
      composer.addPass(this.outputPass);

      // --- anti-aliasing, on the LDR display-referred image -------------------
      this.smaaPass = new SMAAPass();
      composer.addPass(this.smaaPass);

      // --- lens + film artefacts (see file header for the ordering rationale) -
      this.filmPass = new ShaderPass(FilmShader);
      this.filmPass.uniforms.uResolution.value.set(w, h);
      this.filmPass.uniforms.uAspect.value = w / Math.max(1, h);
      composer.addPass(this.filmPass);

      this.composer = composer;
      this._enabled = true;

      // Apply the default look immediately so frame 0 is already graded.
      this.setWorldGrade(null);
      console.info(
        `[PostFX] chain ready (${msaa ? `${msaa}x MSAA` : 'no MSAA'}): render -> ` +
          `${this.gtaoPass ? 'gtao -> ' : ''}${this.shaftPass ? 'shafts -> ' : ''}` +
          'bloom -> grade[linear] -> output -> smaa -> film'
      );
    } catch (err) {
      console.error('[PostFX] failed to build the composer - falling back to direct rendering:', err);
      this._disposePasses();
      this.composer = null;
      this._enabled = false;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Public API                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Render one frame. Falls back to a plain scene render whenever the chain is
   * disabled or has failed.
   * @param {number} dt Seconds since the last frame.
   */
  render(dt) {
    if (!this._enabled || !this.composer) {
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
      return;
    }

    this._time += dt;
    this.filmPass.uniforms.uTime.value = this._time;
    this._blendGrade(dt);
    this._updateShafts();
    this._trackBudget();

    try {
      this.composer.render(dt);
      this._renderFailures = 0;
    } catch (err) {
      // A single throw is usually transient - a resize landing mid-frame leaves
      // a zero-sized buffer for one tick. Latching the whole chain off for the
      // rest of the session on the strength of that costs the player every
      // subsequent frame, so only give up once it is clearly not recovering.
      this._renderFailures++;
      console.error(
        `[PostFX] composer.render() threw (${this._renderFailures}/${RENDER_FAILURE_LIMIT}):`,
        err
      );
      if (this._renderFailures >= RENDER_FAILURE_LIMIT) {
        console.error('[PostFX] repeated composer failures - disabling post-processing.');
        this._enabled = false;
      }
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
    }
  }

  /**
   * Resize every buffer. Called by Engine on window resize *and* whenever the
   * adaptive resolution scaler changes the renderer's pixel ratio.
   * @param {number} width  Logical CSS pixels.
   * @param {number} height Logical CSS pixels.
   */
  setSize(width, height) {
    if (!this.composer) return;
    const pr = this.renderer.getPixelRatio();
    if (pr !== this._pixelRatio) {
      this._pixelRatio = pr;
      this.composer.setPixelRatio(pr);
    }
    this.composer.setSize(width, height);

    const w = Math.max(1, Math.round(width * pr));
    const h = Math.max(1, Math.round(height * pr));
    this.filmPass.uniforms.uResolution.value.set(w, h);
    this.filmPass.uniforms.uAspect.value = w / h;
  }

  /**
   * Retune the whole look for a world.
   *
   * Resolution order for the preset:
   *   `environment.grade` as a string  -> named preset
   *   `environment.grade` as an object -> named preset (via `.preset`) + overrides
   *   otherwise                        -> the id of the world that just became
   *                                       active, if it names a known preset
   *
   * Override objects are normalised, not trusted: a world may express a tint as
   * a `THREE.Color`, a `Vector3`, an array or a scalar, and unknown keys are
   * ignored. Anything that would resolve to NaN keeps the preset value instead.
   *
   * `environment.bloom` (`{strength, radius, threshold}`) refines the preset's
   * bloom so a world can push its own neon, but the threshold can only be
   * raised: it is measured on linear HDR luminance here, and every world's
   * stored value predates that and would blow the frame out.
   *
   * @param {object|null} environment A `World.environment` object.
   */
  setWorldGrade(environment) {
    const grade = { ...BASE_GRADE };

    const raw = environment?.grade;
    let presetName = null;
    let overrides = null;

    if (typeof raw === 'string') {
      presetName = raw;
    } else if (raw && typeof raw === 'object') {
      presetName = raw.preset ?? raw.name ?? null;
      overrides = raw;
    }
    if (!presetName && GRADE_PRESETS[this._worldId]) presetName = this._worldId;

    const preset = presetName ? GRADE_PRESETS[presetName] : null;
    if (presetName && !preset) {
      console.warn(`[PostFX] unknown grade preset "${presetName}" - using the neutral look.`);
    }
    if (preset) Object.assign(grade, preset);

    // `environment.bloom` only steers the neutral look. Once a preset matched,
    // the preset owns bloom: its threshold is calibrated against that world's
    // measured linear-HDR luminance, and no world's stored value is expressed
    // in those units. A world that genuinely wants to override it can say so in
    // linear terms via `environment.grade.bloom`, which _mergeOverrides honours.
    if (!preset && environment?.bloom) this._mergeBloom(grade, environment.bloom);
    if (overrides) this._mergeOverrides(grade, overrides);
    if (isNum(environment?.godrays)) grade.shafts = environment.godrays;
    else if (environment?.godrays !== undefined) grade.shafts = environment.godrays ? grade.shafts || 0.6 : 0;
    if (isNum(environment?.ao)) grade.ao = environment.ao;

    if (environment?.sunDirection) this._sunDir.copy(environment.sunDirection).normalize();

    this._applyTarget(grade);
    if (this._snapGrade && this.gradePass) {
      this._blendGrade(1e3); // huge dt -> instant snap, no fade on the first world
      this._snapGrade = false;
    }
  }

  /**
   * Turn the chain on or off. Off means a straight `renderer.render()`, which
   * is also the automatic fallback if construction or rendering ever fails.
   * @param {boolean} value
   */
  setEnabled(value) {
    const want = !!value && !!this.composer;
    if (want === this._enabled) return;
    this._enabled = want;
    if (!want) {
      this.renderer.setRenderTarget(null);
    }
  }

  /** @returns {boolean} */
  get enabled() {
    return this._enabled;
  }

  /**
   * Manual quality override; also used by the automatic frame-budget guard.
   * @param {{ ao?: boolean, shafts?: boolean, bloom?: boolean, smaa?: boolean, film?: boolean }} flags
   */
  setQuality(flags = {}) {
    if (flags.ao !== undefined && this.gtaoPass) this.gtaoPass.enabled = !!flags.ao;
    if (flags.shafts !== undefined && this.shaftPass) this.shaftPass.enabled = !!flags.shafts;
    if (flags.bloom !== undefined && this.bloomPass) this.bloomPass.enabled = !!flags.bloom;
    if (flags.smaa !== undefined && this.smaaPass) this.smaaPass.enabled = !!flags.smaa;
    if (flags.film !== undefined && this.filmPass) this.filmPass.enabled = !!flags.film;
  }

  /**
   * Debug helper: route the AO pass's intermediate buffers to the screen so the
   * occlusion term can actually be seen.
   * @param {'default'|'ao'|'denoise'|'normal'|'depth'|'off'} mode
   */
  setAOOutput(mode = 'default') {
    if (!this.gtaoPass) return;
    const map = {
      default: GTAOPass.OUTPUT.Default,
      ao: GTAOPass.OUTPUT.AO,
      denoise: GTAOPass.OUTPUT.Denoise,
      normal: GTAOPass.OUTPUT.Normal,
      depth: GTAOPass.OUTPUT.Depth,
      off: GTAOPass.OUTPUT.Off,
    };
    this.gtaoPass.output = map[mode] ?? GTAOPass.OUTPUT.Default;
  }

  /** Free every render target and material the chain owns. */
  dispose() {
    this._disposePasses();
    this.composer?.dispose();
    this.composer = null;
    this._enabled = false;
  }

  /* ---------------------------------------------------------------- */
  /* Internals                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Fold a world's `environment.grade` object into a resolved grade, coercing
   * every value and dropping anything that does not resolve to a finite number.
   */
  _mergeOverrides(grade, raw) {
    for (const key in raw) {
      const value = raw[key];

      if (key === 'bloom' && value && typeof value === 'object') {
        this._mergeBloom(grade, value);
        continue;
      }

      const scalarKey = SCALAR_OVERRIDES[key];
      if (scalarKey) {
        if (isNum(value)) grade[scalarKey] = value;
        continue;
      }

      const vectorKey = VECTOR_OVERRIDES[key];
      if (vectorKey) {
        const triple = toTriple(value);
        if (!triple) continue;
        // A colour-valued multiplier is art direction, not exposure: normalise
        // the luminance out so a "cool white" gain tints rather than darkens,
        // then pull it back towards neutral so it grades instead of filtering.
        // Pedestals and haze colours are absolute, so they pass through as-is.
        if (value && value.isColor && vectorKey !== 'lift' && vectorKey !== 'hazeColor') {
          const tinted = [1, 1, 1];
          applyTint(tinted, lumaNormalise(triple), TINT_STRENGTH);
          grade[vectorKey] = tinted;
        } else {
          grade[vectorKey] = triple;
        }
        continue;
      }

      // Legacy/free-form keys the worlds already use.
      if (key === 'tint') {
        const triple = toTriple(value);
        if (triple) {
          const balance = grade.balance.slice();
          applyTint(balance, lumaNormalise(triple), TINT_STRENGTH);
          grade.balance = balance;
        }
      } else if ((key === 'warmth' || key === 'temperature') && isNum(value)) {
        const balance = grade.balance.slice();
        applyTint(balance, WARM_AXIS, value);
        grade.balance = balance;
      }
    }
  }

  /**
   * Fold a `{strength, radius, threshold}` block into a resolved grade, ignoring
   * non-numeric fields and capping strength - a linear-HDR bloom above
   * {@link BLOOM_STRENGTH_MAX} washes the frame out no matter the threshold.
   */
  _mergeBloom(grade, block) {
    const bloom = { ...grade.bloom };
    if (isNum(block.strength)) bloom.strength = Math.min(Math.max(block.strength, 0), BLOOM_STRENGTH_MAX);
    if (isNum(block.radius)) bloom.radius = block.radius;
    if (isNum(block.threshold)) bloom.threshold = block.threshold;
    grade.bloom = bloom;
  }

  _applyTarget(grade) {
    const t = this._target;
    t.bloomStrength = grade.bloom.strength;
    t.bloomRadius = grade.bloom.radius;
    t.bloomThreshold = grade.bloom.threshold;
    t.shafts = SHAFTS_DISABLED ? 0 : grade.shafts;
    t.shaftTint.fromArray(grade.shaftTint);
    t.ao = grade.ao;

    for (let i = 0; i < GRADE_SCALARS.length; i++) t[GRADE_SCALARS[i][0]] = grade[GRADE_SCALARS[i][1]];
    for (let i = 0; i < FILM_SCALARS.length; i++) t[FILM_SCALARS[i][0]] = grade[FILM_SCALARS[i][1]];
    for (let i = 0; i < GRADE_VECTORS.length; i++) t[GRADE_VECTORS[i][0]].fromArray(grade[GRADE_VECTORS[i][1]]);

    // Shaft sampling parameters are not blended - they are structural, and a
    // half-way density looks like a bug rather than a transition.
    if (this.shaftPass) {
      const u = this.shaftPass.uniforms;
      u.uDensity.value = grade.shaftDensity;
      u.uDecay.value = grade.shaftDecay;
      u.uWeight.value = grade.shaftWeight;
      u.uThreshold.value = grade.shaftThreshold;
    }
  }

  /** Exponential chase so a portal transition cross-fades the look. */
  _blendGrade(dt) {
    if (!this.gradePass || !this.filmPass || !this.bloomPass) return;
    const a = 1 - Math.exp(-dt * 3.5);
    const t = this._target;
    const g = this.gradePass.uniforms;
    const f = this.filmPass.uniforms;

    for (let i = 0; i < GRADE_SCALARS.length; i++) {
      const key = GRADE_SCALARS[i][0];
      g[key].value += (t[key] - g[key].value) * a;
    }
    for (let i = 0; i < FILM_SCALARS.length; i++) {
      const key = FILM_SCALARS[i][0];
      f[key].value += (t[key] - f[key].value) * a;
    }
    for (let i = 0; i < GRADE_VECTORS.length; i++) {
      const key = GRADE_VECTORS[i][0];
      g[key].value.lerp(t[key], a);
    }

    const bloom = this.bloomPass;
    bloom.strength += (t.bloomStrength - bloom.strength) * a;
    bloom.radius += (t.bloomRadius - bloom.radius) * a;
    bloom.threshold += (t.bloomThreshold - bloom.threshold) * a;
    // UnrealBloomPass re-pushes `threshold` into the high-pass every frame but
    // never touches `smoothWidth`, so the knee has to be maintained here. See
    // BLOOM_KNEE for why the addon's default of 0.01 is the wrong shape.
    bloom.highPassUniforms.smoothWidth.value = bloom.threshold * BLOOM_KNEE;

    this._shaftAmount += (t.shafts - this._shaftAmount) * a;
    if (this.shaftPass) this.shaftPass.uniforms.uTint.value.lerp(t.shaftTint, a);
    if (this.gtaoPass) {
      this.gtaoPass.blendIntensity += (t.ao * this._aoIntensity - this.gtaoPass.blendIntensity) * a;
    }
  }

  /**
   * Project the sun onto the screen and fade the shafts in only when it is
   * genuinely in front of the camera and near the frame.
   */
  _updateShafts() {
    if (!this.shaftPass) return;
    const u = this.shaftPass.uniforms;

    if (this._shaftAmount <= 0.001) {
      u.uIntensity.value = 0;
      return;
    }

    const cam = this.camera;
    _v2.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const facing = _v2.dot(this._sunDir);
    if (facing <= 0.02) {
      u.uIntensity.value = 0;
      return;
    }

    // A point far along the sun direction is, for projection purposes, the sun.
    cam.getWorldPosition(_v1).addScaledVector(this._sunDir, 4000);
    _v1.project(cam);
    const sx = _v1.x * 0.5 + 0.5;
    const sy = _v1.y * 0.5 + 0.5;
    u.uSunPos.value.set(sx, sy);

    const ox = Math.max(0, Math.max(-sx, sx - 1));
    const oy = Math.max(0, Math.max(-sy, sy - 1));
    const edge = 1 - Math.min(1, Math.sqrt(ox * ox + oy * oy) / 0.4);
    u.uIntensity.value = this._shaftAmount * THREE.MathUtils.smoothstep(facing, 0.02, 0.35) * edge;
  }

  /**
   * Drop the two most expensive optional passes if the frame budget is being
   * blown for a sustained period. The engine's own resolution scaler handles
   * small overruns; this catches the case where AO alone is the problem.
   *
   * Two things this must *not* do, both learned the hard way:
   *
   * 1. React to hitches. The other two worlds stream in on idle callbacks after
   *    the first frame is up, and a single build step is a 150 ms frame. Judged
   *    on the mean frame time that reads as "the budget is blown", and the guard
   *    would switch AO off within the first few seconds of every session and
   *    never switch it back on - which is precisely why round 1 saw "no contact
   *    occlusion anywhere". It now reads `frameMsMedian`, which a hitch cannot
   *    move, and ignores absurd samples outright.
   * 2. Latch. Degradation is now reversible: once the frame time has been
   *    comfortably inside budget for a sustained run, the passes come back.
   */
  _trackBudget() {
    if (++this._frames < 150) return;
    this._frames = 0;

    const stats = this.engine.stats;
    const ms = stats?.frameMsMedian ?? stats?.frameMs ?? 0;

    // A median this large is a stall, a tab restore or a world build, not a
    // steady-state budget problem. Sampling again in 150 frames costs nothing.
    if (ms > 60) return;

    if (ms > 21) {
      this._fastStrikes = 0;
      this._slowStrikes++;
      if (this._slowStrikes >= 4) {
        this._slowStrikes = 0;
        this._degraded = true;
        if (this.gtaoPass?.enabled) {
          this.gtaoPass.enabled = false;
          console.info(`[PostFX] frame budget exceeded (${ms.toFixed(1)}ms median) - disabling GTAO.`);
        } else if (this.shaftPass?.enabled) {
          this.shaftPass.enabled = false;
          console.info(`[PostFX] frame budget exceeded (${ms.toFixed(1)}ms median) - disabling light shafts.`);
        }
      }
    } else {
      this._slowStrikes = 0;
      if (!this._degraded) return;
      // Restore in the reverse order they were dropped, and only with real
      // headroom (13 ms median, ~77 fps) so the chain cannot oscillate.
      if (ms < 13 && ++this._fastStrikes >= 6) {
        this._fastStrikes = 0;
        if (this.shaftPass && !this.shaftPass.enabled) {
          this.shaftPass.enabled = true;
          console.info('[PostFX] frame budget recovered - light shafts back on.');
        } else if (this.gtaoPass && !this.gtaoPass.enabled) {
          this.gtaoPass.enabled = true;
          console.info('[PostFX] frame budget recovered - GTAO back on.');
        } else {
          this._degraded = false;
        }
      }
    }
  }

  _disposePasses() {
    this.gtaoPass?.dispose?.();
    this.shaftPass?.dispose?.();
    this.bloomPass?.dispose?.();
    this.gradePass?.dispose?.();
    this.outputPass?.dispose?.();
    this.smaaPass?.dispose?.();
    this.filmPass?.dispose?.();
    this.gtaoPass = this.shaftPass = this.bloomPass = this.gradePass = null;
    this.outputPass = this.smaaPass = this.filmPass = null;
  }
}

/**
 * Build the post-processing chain for an engine.
 *
 * @param {import('../core/Engine.js').Engine} engine
 * @returns {PostFX} `{ render(dt), setSize(w,h), setWorldGrade(env), composer, setEnabled(bool) }`
 */
/**
 * Keep transparent effect meshes out of the ambient-occlusion prepass.
 *
 * GTAOPass builds its normal/depth G-buffer by re-rendering the scene with
 * `scene.overrideMaterial = MeshNormalMaterial`. Its own `_overrideVisibility`
 * hides only Points, Line and Line2 - every transparent *mesh* is drawn into
 * that buffer at full strength, because the override material carries its own
 * blending and depth state and ignores the material the object actually uses.
 *
 * The consequence is severe and was shipped once already: the sword's edge
 * trail had no `normal` attribute, stamped a null normal across its whole
 * silhouette, and GTAO multiplied the frame to black in that shape - the "big
 * black triangles" the user reported. Any additive or transparent effect is
 * exposed to the same trap: tracers, muzzle flashes, decals, projectile trails,
 * portal particles.
 *
 * Rather than require every effect author to remember a per-mesh workaround,
 * extend the pass's own visibility override to also skip transparent and
 * additively-blended meshes, plus anything explicitly flagged `userData.noAO`.
 * Occlusion from a see-through effect was never wanted anyway.
 */
function excludeEffectsFromAO(gtaoPass) {
  const original = gtaoPass._overrideVisibility;
  if (typeof original !== 'function') {
    console.warn('[PostFX] GTAOPass._overrideVisibility missing - effects may be stamped into the AO buffer');
    return;
  }
  gtaoPass._overrideVisibility = function patched() {
    original.call(this);
    const cache = this._visibilityCache;
    this.scene.traverse((object) => {
      // Sprites too, not just meshes. GTAO's prepass renders whatever it is
      // handed into a depth+normal buffer, and the AO term then multiplies the
      // frame by it - so an additive *sprite* is stamped in as a hard opaque
      // shape exactly like an additive mesh would be. Missing them here is what
      // drew a black square around every loot halo seen close up, which the
      // underwater caches made impossible to miss.
      if (!object.visible || (!object.isMesh && !object.isSprite)) return;
      const m = object.material;
      if (!m) return;
      const mats = Array.isArray(m) ? m : [m];
      // Alpha-tested cutout cards (foliage leaves, grass billboards) belong
      // here too: the MeshNormalMaterial override ignores alphaMap/alphaTest,
      // so every leaf card was stamped into the AO buffer as a full opaque
      // quad - the "solid black rectangles in the tree canopy" bug in the
      // sports world. Occlusion from a mostly-transparent card is not worth
      // keeping; skip anything with an alpha-tested texture.
      const skip = object.userData?.noAO === true ||
        mats.some((mat) => mat && (
          mat.transparent === true ||
          mat.blending === THREE.AdditiveBlending ||
          (mat.alphaTest > 0 && (mat.alphaMap || mat.map))
        ));
      if (skip) {
        object.visible = false;
        cache.push(object);
      }
    });
  };
}

export function createPostFX(engine) {
  return new PostFX(engine);
}

export { GRADE_PRESETS, PostFX };
export default createPostFX;
