import * as THREE from 'three';

/**
 * The materials that make a sphere read as a PLACE.
 *
 * ===========================================================================
 *  WHY SHADERS AND NOT TEXTURES
 * ===========================================================================
 *
 * A planet needs detail at two scales that are four orders of magnitude apart:
 * the whole disc at 62 km, and the ground under the nose at 700 m. An equirect
 * texture that survives the second one is 8192 x 4096 per body, five bodies,
 * decoded on the boot path. A 3D noise field evaluated on the object-space
 * normal has no resolution at all - it is exact at every zoom - and costs a
 * few dozen ALU on the pixels the body actually covers.
 *
 * It also solves the seam. Equirect mapping pinches at the poles and joins at
 * the date line, and both are visible on a body you can fly around. Sampling
 * noise in 3D on the sphere has neither.
 *
 * ===========================================================================
 *  WHAT MAKES EACH KIND RECOGNISABLE
 * ===========================================================================
 *
 * One deliberate identifying feature per kind, and the rest is support:
 *
 *   rock  EMISSIVE FISSURES. The single detail that says "volcanic" from a
 *         distance no texture could: the night side is not black, it is veined
 *         with orange. This is why Cinder is identifiable at 62 km when it is
 *         only a fifth of a screen height across.
 *   gas   LATITUDINAL BANDS dragged sideways by turbulence, plus one storm.
 *         Bands alone read as a beach ball; the shear is what reads as weather.
 *   ice   POLAR CAPS and a hard specular sheen. A white sphere is a ping-pong
 *         ball until it has a horizon between cap and terrain.
 *   moon  MARIA - large dark low-frequency patches over a bright cratered
 *         ground. Craters alone are noise; maria give it a face.
 *   star  LIMB DARKENING and granulation, output well above 1.0 so the bloom
 *         in PostFX has something to catch.
 *
 * ===========================================================================
 *  RENDER STATE - READ THIS BEFORE CHANGING IT
 * ===========================================================================
 *
 * Every body material is `depthTest: false, depthWrite: false`. That is not an
 * oversight and it is not a transparency hack. See the painter-ordering note
 * at the top of Backdrop.js: the far-limb cap in Scale.js can place a nearer
 * body at a LARGER proxy distance than a further one, so the depth buffer
 * cannot be trusted between bodies. Draw order decides instead, which is exact
 * here because the bodies are convex, opaque and never intersect.
 *
 * The consequence to remember: a body will paint over ANYTHING already drawn.
 * That is why the backdrop is drawn first, at negative render orders, and why
 * nothing in the near field may be given a negative render order.
 */

/* ------------------------------------------------------------------ */
/* Shared GLSL                                                         */
/* ------------------------------------------------------------------ */

/**
 * Value noise in 3D, plus fbm.
 *
 * Value and not gradient noise: gradient noise needs a hash per corner that
 * returns a VECTOR rather than a scalar, which is three times the hash work
 * for a difference that four octaves of fbm bury. No timing is claimed for
 * that choice - it was made on the arithmetic, and the whole-frame cost never
 * came up as a problem to investigate.
 *
 * What IS measured is where this runs: the body shaders only ever cover the
 * pixels a body actually occupies, which from the dock is a fifth of the
 * screen height for the largest of them. The one case that covers the frame is
 * the last second of a descent, and that second ends in a world swap.
 */
const NOISE = /* glsl */ `
float hash31(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash31(i + vec3(0.0, 0.0, 0.0));
  float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash31(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z
  );
}

float fbm4(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return s / 0.9375;
}

float fbm5(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return s / 0.96875;
}

/** Ridged noise: creases where the fbm crosses its midpoint. Veins, not blobs. */
float ridged(vec3 p) {
  float n = fbm4(p);
  return 1.0 - abs(n * 2.0 - 1.0);
}
`;

/**
 * Shared vertex stage.
 *
 * `vObj` is the LOCAL unit normal, so the noise field rotates with the body and
 * a planet's spin actually turns its surface rather than sliding a pattern
 * across a stationary one.
 */
const BODY_VERT = /* glsl */ `
varying vec3 vObj;
varying vec3 vN;
varying vec3 vW;
void main() {
  vObj = normalize(position);
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

/**
 * The lighting every lit body shares.
 *
 * `smoothstep(-0.06, 0.20, ndl)` and not `max(ndl, 0.0)`: a hard Lambert
 * terminator on a sphere with no atmosphere scattering is a knife edge, and it
 * is the tell that gives away a cheap planet at a glance. A 0.26-wide soft
 * band is the cheapest stand-in for limb scattering that reads.
 *
 * The ambient term is deliberately blue and deliberately tiny (0.055). Space
 * has no fill light; what little there is comes from the starfield, and the
 * value exists so the night side is a shape rather than a hole.
 */
const LIT = /* glsl */ `
uniform vec3 uStarDir;
uniform vec3 uAmbient;
float dayFactor(vec3 n) {
  return smoothstep(-0.06, 0.20, dot(n, uStarDir));
}
vec3 litColor(vec3 albedo, vec3 n) {
  return albedo * (uAmbient + vec3(dayFactor(n)));
}
`;

/**
 * Declared for every kind whether it is used or not. An unused uniform is
 * compiled out and its location comes back null, which three skips silently;
 * a MISSING one is a compile error at first draw, in a world that is already
 * three portals deep. The trade is obvious in that direction.
 */
const SHARED_DECLS = /* glsl */ `
uniform vec3 uBase;
uniform vec3 uHigh;
uniform vec3 uLow;
uniform float uDetail;
uniform float uTime;
`;

/** Render state shared by every backdrop body. See the header. */
const BACKDROP_STATE = {
  depthTest: false,
  depthWrite: false,
  side: THREE.FrontSide,
  fog: false,
  /* The composer renders the scene into an HDR target, and three applies tone
   * mapping only when drawing to the canvas - so the scene pass is untone-
   * mapped and `PostFX`'s OutputPass does it at the end. These shaders
   * therefore emit LINEAR values and are free to exceed 1.0, which is the
   * whole mechanism behind the star. Setting this true would change nothing
   * (a raw ShaderMaterial without `#include <tonemapping_fragment>` is never
   * tone mapped) and would imply something false. */
  toneMapped: false,
};

/**
 * Render state for the TRANSPARENT parts of a backdrop body - the atmosphere
 * halo, the ring, the corona.
 *
 * These differ from the opaque surfaces in one flag, and it is the flag that
 * matters most in the whole file: `depthTest` is ON.
 *
 * WHY, and it cost a screenshot to find. three draws every opaque object
 * first and every transparent object afterwards, each group sorted by
 * `renderOrder`. So a body's opaque surface is correctly painted over by the
 * dock - the dock has a higher render order and wins the opaque pass - but its
 * transparent halo is drawn in a LATER pass entirely, after the dock has
 * finished, and with the depth test off nothing can stop it. What you see is a
 * flat red disc laid over the pier rail with the planet's actual surface
 * correctly hidden behind it: the halo of a planet 62 km away painted on top
 * of a handrail four metres from your face.
 *
 * With the test on, the halo is compared against the depth buffer - which by
 * then holds the near field and the belt, and NOTHING ELSE, because the
 * opaque bodies deliberately do not write depth. Every depth in that buffer is
 * honest (identity inside NEAR_FIELD, uncapped monotone outside it), so the
 * comparison is meaningful and the halo goes behind the rail.
 *
 * KNOWN RESIDUAL, stated rather than hidden: the opaque bodies write no depth,
 * so nothing stops a distant body's halo bleeding over a nearer body's disc
 * where two bodies overlap on screen. It is a thin additive arc at the limb,
 * because the fresnel gates the halo to the limb anyway.
 *
 * The obvious fix - let the bodies write depth - was tried and is worse. Their
 * proxy distances are cap-bound and therefore not ordered (see Scale.js), so
 * writing them stamps a LYING depth field: Ceraunus at 245 km stamps 1403
 * while Cinder at 62 km stamps 1659, and every asteroid between you and the
 * gas giant then fails the test and vanishes behind it. A faint arc at a limb
 * beats rocks disappearing.
 */
const BACKDROP_TRANSPARENT = {
  ...BACKDROP_STATE,
  transparent: true,
  depthTest: true,
  depthWrite: false,
};

/* ------------------------------------------------------------------ */
/* Per-kind fragment stages                                            */
/* ------------------------------------------------------------------ */

/**
 * ROCK - a basalt world veined with molten fissures.
 *
 * The fissure network is `ridged()` thresholded near its top, which produces
 * connected filaments rather than the disconnected blobs a plain fbm threshold
 * gives. Two thresholds, not one: a wide warm one for the glow bleeding into
 * the rock either side of a crack, and a narrow hot one for the crack itself.
 * A single threshold gives you orange worms on grey; two give you rock that is
 * hot near the cracks, which is what a lava field looks like.
 *
 * `1.0 + 2.2 * (1.0 - day)` is the payload: the fissures are 3.2x brighter on
 * the night side. Physically that is just the eye's response, and dramatically
 * it is the reason a dark planet is still legible at 62 km.
 */
const FRAG_ROCK = /* glsl */ `
uniform vec3 uFissure;
uniform vec3 uFissureHot;
uniform float uCover;
varying vec3 vObj;
varying vec3 vN;
varying vec3 vW;

void main() {
  vec3 p = vObj * uDetail;
  float h = fbm5(p * 3.1);
  vec3 albedo = mix(uLow, uHigh, smoothstep(0.34, 0.70, h));
  albedo = mix(albedo, uBase, 0.45);

  // Large dark plains, so the surface has features bigger than its grain.
  float plain = fbm4(p * 0.85 + 31.7);
  albedo *= mix(0.62, 1.12, smoothstep(0.30, 0.72, plain));

  float r = ridged(p * 1.55 + 11.3);
  float warm = smoothstep(1.0 - uCover * 1.35, 1.0, r);
  float hot  = smoothstep(1.0 - uCover * 0.34, 1.0, r);

  float day = dayFactor(vN);
  vec3 col = albedo * (uAmbient + vec3(day));
  vec3 glow = mix(uFissure, uFissureHot, hot);
  col += glow * (warm * 0.55 + hot * 1.30) * (1.0 + 2.2 * (1.0 - day));

  gl_FragColor = vec4(col, 1.0);
}
`;

/**
 * GAS - banded, sheared, one storm.
 *
 * The bands are a sine in latitude whose PHASE is displaced by an fbm, not
 * whose amplitude is modulated by one. Modulating amplitude gives you stripes
 * that fade; displacing phase gives you stripes that are dragged, which is
 * what differential rotation does to a gas giant and the only part of this
 * that has to be right.
 *
 * `uSpin` shifts the noise field in longitude over time so the churn moves at
 * a different rate to the body's own rotation. Two rates is weather; one is a
 * decal.
 */
const FRAG_GAS = /* glsl */ `
uniform float uBands;
uniform float uChurn;
uniform vec3 uStorm;
uniform vec3 uStormDir;
varying vec3 vObj;
varying vec3 vN;
varying vec3 vW;

void main() {
  vec3 p = vObj * uDetail;
  float shear = (fbm4(p * 1.35 + vec3(uTime * 0.006, 0.0, 0.0)) - 0.5) * uChurn;
  float lat = vObj.y;
  float band = sin(lat * uBands * 3.14159 + shear * 9.0);
  float fine = (fbm4(p * 6.0 + 5.1) - 0.5) * 0.30;

  vec3 col = mix(uLow, uHigh, clamp(0.5 + 0.5 * band + fine, 0.0, 1.0));
  col = mix(col, uBase, 0.25);

  // The storm. An oval, because a circle reads as a bullet hole.
  vec3 sd = normalize(uStormDir);
  vec3 rel = vObj - sd * dot(vObj, sd);
  float ov = length(vec3(rel.x * 0.55, rel.y * 1.6, rel.z * 0.55));
  float inStorm = smoothstep(0.34, 0.06, ov) * step(0.0, dot(vObj, sd));
  col = mix(col, uStorm, inStorm * 0.85);
  col += uHigh * inStorm * 0.12 * smoothstep(0.20, 0.34, ov);

  // Limb darkening. A gas giant has no hard edge; without this it is a decal.
  float limb = pow(max(dot(vN, normalize(cameraPosition - vW)), 0.0), 0.45);
  col *= mix(0.55, 1.0, limb);

  gl_FragColor = vec4(col * (uAmbient + vec3(dayFactor(vN))), 1.0);
}
`;

/**
 * ICE - mottled ground, hard caps, a sheen.
 *
 * The caps are a smoothstep on |latitude| whose EDGE is displaced by noise, so
 * the cap boundary is ragged. A clean latitude line is the most artificial
 * thing you can put on a planet.
 */
const FRAG_ICE = /* glsl */ `
uniform vec3 uFissure;
uniform float uCover;
varying vec3 vObj;
varying vec3 vN;
varying vec3 vW;

void main() {
  vec3 p = vObj * uDetail;
  float h = fbm5(p * 2.7);
  vec3 albedo = mix(uLow, uBase, smoothstep(0.30, 0.66, h));

  // Crevasse field: dark blue cracks in the ice sheets.
  float r = ridged(p * 3.4 + 7.7);
  albedo = mix(albedo, uFissure, smoothstep(1.0 - uCover * 0.5, 1.0, r) * 0.7);

  // Ragged polar caps.
  float capEdge = 0.58 + (fbm4(p * 4.0 + 19.0) - 0.5) * 0.22;
  float cap = smoothstep(capEdge, capEdge + 0.14, abs(vObj.y));
  albedo = mix(albedo, uHigh, cap);

  float day = dayFactor(vN);
  vec3 V = normalize(cameraPosition - vW);
  vec3 H = normalize(V + uStarDir);
  float spec = pow(max(dot(vN, H), 0.0), 42.0) * day * (0.35 + 0.55 * cap);

  gl_FragColor = vec4(albedo * (uAmbient + vec3(day)) + vec3(spec), 1.0);
}
`;

/**
 * MOON - maria over cratered highlands.
 *
 * Craters are `1.0 - ridged()` at high frequency, which gives closed rounded
 * depressions rather than the filaments `ridged()` itself gives. Cheap, and at
 * 5.5 degrees across nobody is counting rims.
 */
const FRAG_MOON = /* glsl */ `
uniform vec3 uFissure;
uniform float uCover;
varying vec3 vObj;
varying vec3 vN;
varying vec3 vW;

void main() {
  vec3 p = vObj * uDetail;
  float crater = 1.0 - ridged(p * 5.5 + 3.3);
  vec3 albedo = mix(uBase, uHigh, smoothstep(0.35, 0.85, crater));

  // Maria: big, dark, low-frequency, with hard-ish shores.
  float maria = fbm4(p * 0.72 + 41.0);
  albedo = mix(albedo, uLow, smoothstep(0.52, 0.62, maria) * uCover);

  // Ejecta rays out of the brightest crater floors.
  float rays = smoothstep(0.86, 1.0, ridged(p * 9.0 + 61.0));
  albedo += uHigh * rays * 0.14;

  gl_FragColor = vec4(albedo * (uAmbient + vec3(dayFactor(vN))), 1.0);
}
`;

/**
 * STAR - unlit, granulated, limb-darkened, and deliberately over 1.0.
 *
 * `2.9` at the core is above the `space` grade's bloom threshold of 1.60
 * (PostFX.js), which is the entire reason a 2.8-degree disc reads as a sun
 * rather than an orange dot: the bloom does the flare and the disc only has to
 * be bright. Take this below 1.6 and the star goes out.
 */
const FRAG_STAR = /* glsl */ `
uniform vec3 uCore;
uniform vec3 uEdge;
uniform float uGrain;
varying vec3 vObj;
varying vec3 vN;
varying vec3 vW;

void main() {
  float g = fbm4(vObj * uGrain + vec3(0.0, uTime * 0.02, 0.0));
  float g2 = fbm4(vObj * uGrain * 3.7 - vec3(uTime * 0.05, 0.0, 0.0));
  float cell = clamp(g * 0.7 + g2 * 0.3, 0.0, 1.0);

  // Limb darkening. The 0.42 exponent is eyeballed against a photograph of
  // the sun in continuum white light; anything nearer 1.0 looks like a ball.
  float mu = max(dot(vN, normalize(cameraPosition - vW)), 0.0);
  float limb = pow(mu, 0.42);

  vec3 col = mix(uEdge, uCore, cell * 0.55 + 0.25);
  col *= mix(0.55, 1.0, limb);
  gl_FragColor = vec4(col * 2.9, 1.0);
}
`;

const FRAG_BY_KIND = {
  rock: FRAG_ROCK,
  gas: FRAG_GAS,
  ice: FRAG_ICE,
  moon: FRAG_MOON,
  star: FRAG_STAR,
};

/**
 * Build the surface material for one body.
 *
 * @param {import('./Bodies.js').SpaceBody} body
 * @param {THREE.Vector3} starDir shared uniform value; every body points at
 *        the SAME Vector3 instance so moving the star moves every terminator
 * @returns {THREE.ShaderMaterial}
 */
export function makeBodyMaterial(body, starDir) {
  const frag = FRAG_BY_KIND[body.kind];
  if (!frag) throw new Error(`[space/BodyShaders] no shader for kind "${body.kind}"`);
  const look = body.look;

  const u = {
    uStarDir: { value: starDir },
    /* ── THE NIGHT SIDE WAS A HOLE, AND ITS OWN COMMENT SAID IT SHOULD NOT BE ──
     *
     * `LIT`'s docblock says this ambient exists "so the night side is a shape
     * rather than a hole". It was 0x121c2e — linear (0.006, 0.012, 0.027) —
     * which against a gas albedo of ~0.35 lands under 1% of display at exposure
     * 1.02. Measured across Ceraunus's unlit face from the hull wall, clear of
     * the ship: **median 3.1 of 255 at 1.70 radii and 1.4 at 2.10**, with
     * samples of literally [0,0,0]. The ring system was visibly passing behind a
     * black cut-out.
     *
     * The unlit face itself is CORRECT and is not what changed: the player
     * always arrives from the yard side, and the two positions fix the phase
     * angle at 130 degrees — an illuminated fraction of 0.18. A gas giant seen
     * mostly at night is the honest picture. It just has to be a SHAPE.
     *
     * 0x243a5c is the same hue, doubled. The day side moves by an additive
     * amount that is negligible against a `dayFactor` of ~1, and the peak stays
     * far under the space grade's 1.60 bloom threshold — the constraint that
     * governs everything else in this file. `.probe/tk/cer-nightside.mjs` samples
     * a line across the disc and prints the number; re-run it if this moves. */
    uAmbient: { value: new THREE.Color(0x243a5c) },
    uBase: { value: new THREE.Color(look.base ?? 0x808080) },
    uHigh: { value: new THREE.Color(look.high ?? 0xffffff) },
    uLow: { value: new THREE.Color(look.low ?? 0x202020) },
    uDetail: { value: look.detail ?? 2.5 },
    uTime: { value: 0 },
  };

  if (body.kind === 'star') {
    u.uCore = { value: new THREE.Color(look.core) };
    u.uEdge = { value: new THREE.Color(look.edge) };
    u.uGrain = { value: look.grain ?? 5.0 };
  } else if (body.kind === 'gas') {
    u.uBands = { value: look.bands ?? 10 };
    u.uChurn = { value: look.churn ?? 0.3 };
    u.uStorm = { value: new THREE.Color(look.storm ?? 0x884422) };
    u.uStormDir = { value: new THREE.Vector3(0.55, -0.34, 0.76).normalize() };
  } else {
    u.uFissure = { value: new THREE.Color(look.fissure ?? 0x000000) };
    u.uFissureHot = { value: new THREE.Color(look.fissureHot ?? look.fissure ?? 0x000000) };
    u.uCover = { value: look.fissureCover ?? 0.2 };
  }

  const isStar = body.kind === 'star';
  return new THREE.ShaderMaterial({
    ...BACKDROP_STATE,
    uniforms: u,
    vertexShader: BODY_VERT,
    fragmentShader: [NOISE, isStar ? '' : LIT, SHARED_DECLS, frag].join('\n'),
  });
}

/**
 * ATMOSPHERE - the limb halo.
 *
 * A front-facing sphere at the atmosphere radius, additive, with a cubic
 * fresnel. At the centre of the disc `dot(N,V)` is 1 and the term vanishes, so
 * the shell contributes nothing over the planet's face and everything at its
 * edge. That is why it can be drawn over the body without washing it out, and
 * why it does not need to be sorted against it.
 *
 * Gated by the day factor with a wide soft edge, so the halo fades round the
 * terminator instead of ending in a line - the twilight arc is the single most
 * recognisable thing about a planet seen from orbit.
 */
export function makeAtmosphereMaterial(body, starDir) {
  return new THREE.ShaderMaterial({
    ...BACKDROP_TRANSPARENT,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uStarDir: { value: starDir },
      uColor: { value: new THREE.Color(body.look.atmosphere ?? 0x88aaff) },
      uStrength: { value: body.look.atmoStrength ?? 1.0 },
    },
    vertexShader: BODY_VERT,
    fragmentShader: /* glsl */ `
      uniform vec3 uStarDir;
      uniform vec3 uColor;
      uniform float uStrength;
      varying vec3 vObj;
      varying vec3 vN;
      varying vec3 vW;
      void main() {
        vec3 V = normalize(cameraPosition - vW);
        float fres = pow(1.0 - clamp(dot(vN, V), 0.0, 1.0), 3.0);
        float day = smoothstep(-0.45, 0.35, dot(vN, uStarDir));
        gl_FragColor = vec4(uColor * uStrength * fres * day * 1.4, 1.0);
      }
    `,
  });
}

/**
 * RING - an annulus that knows where its planet is.
 *
 * The two things that make a ring system read, and both are done analytically
 * in the fragment shader because neither can be done by sorting:
 *
 *  1. OCCLUSION. Half the ring is behind the planet. With `depthTest` off
 *     there is no buffer to ask, so the shader casts the camera ray at the
 *     planet sphere itself and discards any fragment the planet is in front
 *     of. Exact, and it costs one quadratic.
 *
 *  2. THE PLANET'S SHADOW ON THE RING. A second ray, from the fragment toward
 *     the star. This is the detail that turns a hoop into a ring system: a
 *     dark bite taken out of the annulus on the anti-star side. Every
 *     photograph of Saturn has it and no cheap ring in a game does.
 *
 * Both rays are in the RENDER frame, against the planet's PROXY centre and
 * PROXY radius, which is why `uPlanetCenter` and `uPlanetRadius` are rewritten
 * every frame by Backdrop.js rather than set once. Passing true-frame values
 * here would put the shadow in the wrong place by the proxy ratio.
 */
export function makeRingMaterial(body, starDir) {
  const ring = body.ring;
  return new THREE.ShaderMaterial({
    ...BACKDROP_TRANSPARENT,
    side: THREE.DoubleSide,
    uniforms: {
      uStarDir: { value: starDir },
      uTint: { value: new THREE.Color(ring.tint) },
      uDensity: { value: ring.density },
      uInner: { value: ring.inner },
      uOuter: { value: ring.outer },
      uGap: { value: new THREE.Vector2(ring.gap[0], ring.gap[1]) },
      /** Proxy-frame centre of the planet. Rewritten per frame. */
      uPlanetCenter: { value: new THREE.Vector3() },
      /** Proxy-frame radius of the planet. Rewritten per frame. */
      uPlanetRadius: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vLocal;
      varying vec3 vW;
      void main() {
        vLocal = position;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vW = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      ${NOISE}
      uniform vec3 uStarDir;
      uniform vec3 uTint;
      uniform float uDensity;
      uniform float uInner;
      uniform float uOuter;
      uniform vec2 uGap;
      uniform vec3 uPlanetCenter;
      uniform float uPlanetRadius;
      varying vec3 vLocal;
      varying vec3 vW;

      /* Does the ray from ro along unit rd hit the sphere within
       * (0, maxT)? Standard quadratic; only the discriminant and the near
       * root are needed. */
      bool hitsSphere(vec3 ro, vec3 rd, vec3 c, float r, float maxT) {
        vec3 oc = ro - c;
        float b = dot(oc, rd);
        float cc = dot(oc, oc) - r * r;
        float disc = b * b - cc;
        if (disc < 0.0) return false;
        float t = -b - sqrt(disc);
        return t > 0.0001 && t < maxT;
      }

      void main() {
        /* vLocal is the raw RingGeometry position, which lies in the mesh's
         * LOCAL XY plane - the -PI/2 rotation that lays the annulus flat is on
         * the mesh transform and never reaches the attribute. Using .xz here
         * gives length() of (x, 0) and the ring collapses to a bow tie.
         *
         * The mesh is scaled by the planet radius, so this length is already
         * in units of planet radii and compares directly against uInner and
         * uOuter as the descriptor writes them. */
        float r = length(vLocal.xy);
        float t = (r - uInner) / (uOuter - uInner);
        if (t < 0.0 || t > 1.0) discard;

        // Ringlets. Three incommensurate frequencies plus noise: any single
        // frequency reads as corduroy.
        float fine = 0.5
          + 0.26 * sin(r * 118.0)
          + 0.16 * sin(r * 47.3 + 1.7)
          + 0.12 * sin(r * 211.0 + 4.1);
        fine = mix(fine, fbm4(vec3(r * 26.0, 3.7, 0.0)), 0.45);

        float a = uDensity * clamp(fine, 0.0, 1.0);
        // Cassini gap, and a soft fade at both rims.
        a *= 1.0 - smoothstep(uGap.x, (uGap.x + uGap.y) * 0.5, r)
                 * (1.0 - smoothstep((uGap.x + uGap.y) * 0.5, uGap.y, r));
        a *= smoothstep(0.0, 0.06, t) * (1.0 - smoothstep(0.86, 1.0, t));

        vec3 toFrag = vW - cameraPosition;
        float dist = length(toFrag);
        vec3 rd = toFrag / dist;
        // 1. Behind the planet?
        if (hitsSphere(cameraPosition, rd, uPlanetCenter, uPlanetRadius, dist)) discard;
        // 2. In the planet's shadow?
        float shade = hitsSphere(vW, uStarDir, uPlanetCenter, uPlanetRadius, 1.0e7) ? 0.10 : 1.0;

        // Rings are ice: they scatter forwards, so they are brightest when the
        // star is behind them relative to the eye.
        float fwd = 0.75 + 0.45 * max(-dot(rd, uStarDir), 0.0);

        gl_FragColor = vec4(uTint * shade * fwd, a);
      }
    `,
  });
}

/**
 * CORONA - a camera-facing disc of glow behind the star.
 *
 * Radial falloff to the power of 2.6, additive, alpha-blended. It exists
 * because a hard-edged 2.8-degree disc, however bright, still reads as a
 * sticker; the halo is what makes the eye call it a light source. Kept
 * separate from the star body so it can be scaled independently of the
 * photosphere.
 */
export function makeCoronaMaterial(body) {
  return new THREE.ShaderMaterial({
    ...BACKDROP_TRANSPARENT,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uColor: { value: new THREE.Color(body.look.corona) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying vec2 vUv;
      void main() {
        float d = length(vUv - 0.5) * 2.0;
        if (d > 1.0) discard;
        float a = pow(1.0 - d, 2.6);
        gl_FragColor = vec4(uColor * a * 1.6, a);
      }
    `,
  });
}
