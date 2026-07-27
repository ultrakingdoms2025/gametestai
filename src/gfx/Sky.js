import * as THREE from 'three';

/**
 * Procedural sky domes.
 *
 * Three flavours, all generated in GLSL with zero texture fetches so the game
 * ships with no assets at all:
 *   'space'    - deep-field starscape: layered stars, fbm nebula, galactic band,
 *                a shaded planet with terminator, clouds, city lights and rim.
 *   'daylight' - single-scattering Rayleigh/Mie integration tuned to late
 *                golden hour, with cirrus and horizon haze.
 *   'alpine'   - the same atmosphere model at altitude: deep zenith, thin air,
 *                bright horizon, high wispy cirrus.
 *
 * The dome is an inverted sphere drawn with `renderOrder = -1000`, `BackSide`
 * and `depthWrite = false`, so it always sits behind the world and never fogs.
 *
 * Colour note: the shaders emit *linear scene-referred* HDR. Tone mapping and
 * the sRGB transfer are applied once, at the end of the post chain, by
 * `OutputPass`. Deliberately no `<tonemapping_fragment>` include here - that
 * would double-tonemap when the composer is running.
 */

/* ------------------------------------------------------------------ */
/* Scratch                                                             */
/* ------------------------------------------------------------------ */

const _v1 = new THREE.Vector3();

/* ------------------------------------------------------------------ */
/* Shared GLSL                                                         */
/* ------------------------------------------------------------------ */

const SKY_VERTEX = /* glsl */ `
varying vec3 vDir;

void main() {
  // The dome is centred on its own origin, so object-space position doubles as
  // the view direction once normalised in the fragment stage.
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** Hash + value-noise + fbm. Shared verbatim by every sky shader. */
const NOISE_GLSL = /* glsl */ `
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = x - i;
  f = f * f * (3.0 - 2.0 * f);

  float n000 = hash13(i + vec3(0.0, 0.0, 0.0));
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));

  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z
  );
}

// Bounded loop: GLSL ES 1.00 needs a constant limit, so octave count is a break.
float fbm(vec3 p, int oct) {
  float amp = 0.5;
  float sum = 0.0;
  float norm = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    sum += amp * vnoise(p);
    norm += amp;
    p = p * 2.03 + vec3(17.31, 9.17, 23.73);
    amp *= 0.5;
  }
  return sum / max(norm, 1e-4);
}

// Ridged variant - gives nebulae and cirrus their filament structure.
float ridged(vec3 p, int oct) {
  float amp = 0.5;
  float sum = 0.0;
  float norm = 0.0;
  for (int i = 0; i < 5; i++) {
    if (i >= oct) break;
    float n = 1.0 - abs(vnoise(p) * 2.0 - 1.0);
    sum += amp * n * n;
    norm += amp;
    p = p * 2.07 + vec3(5.19, 31.7, 11.3);
    amp *= 0.5;
  }
  return sum / max(norm, 1e-4);
}
`;

/* ------------------------------------------------------------------ */
/* Space                                                               */
/* ------------------------------------------------------------------ */

const SPACE_FRAGMENT = /* glsl */ `
precision highp float;

varying vec3 vDir;

uniform float uTime;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform float uSunSize;

uniform vec3  uNebulaA;
uniform vec3  uNebulaB;
uniform vec3  uNebulaC;
uniform float uNebulaDensity;

uniform vec3  uGalaxyAxis;
uniform float uGalaxyStrength;

uniform vec3  uPlanetDir;
uniform float uPlanetAngular;
uniform vec3  uPlanetLand;
uniform vec3  uPlanetOcean;
uniform vec3  uPlanetAtmo;
uniform float uPlanetSpin;

uniform vec3  uMoonDir;
uniform float uMoonAngular;

uniform float uStarBrightness;
uniform float uExposure;

${NOISE_GLSL}

/**
 * One octave of stars. Each grid cell holds at most one star, placed away from
 * the cell border so a single-cell lookup never clips the glow - that keeps the
 * whole starfield at 1 hash-set per layer instead of 27.
 */
vec3 starLayer(vec3 dir, float scale, float density, float sizeMul, float bright, float tw) {
  vec3 p = dir * scale;
  vec3 cell = floor(p);
  vec3 f = p - cell;

  float present = hash13(cell + 0.5);
  if (present > density) return vec3(0.0);

  vec3 sp = vec3(hash13(cell + 11.13), hash13(cell + 23.71), hash13(cell + 47.37));
  sp = 0.5 + (sp - 0.5) * 0.5;

  float mag = hash13(cell + 3.31);
  mag = mag * mag;                       // few bright stars, many faint ones
  float radius = (0.022 + 0.055 * mag) * sizeMul;

  // Tight halo on purpose: anything wider gets caught by the bloom threshold
  // and the starfield turns into falling snow.
  float d = length(f - sp);
  float core = pow(clamp(1.0 - d / radius, 0.0, 1.0), 2.4);
  float halo = exp(-d / max(radius * 1.25, 1e-3)) * (0.045 + 0.17 * mag);

  // Spectral class ramp: O/B blue-white -> G white -> K amber -> M red.
  float t = hash13(cell + 71.93);
  vec3 col = mix(vec3(0.60, 0.72, 1.00), vec3(1.00, 0.97, 0.93), smoothstep(0.00, 0.45, t));
  col = mix(col, vec3(1.00, 0.83, 0.58), smoothstep(0.64, 0.90, t));
  col = mix(col, vec3(1.00, 0.55, 0.38), smoothstep(0.92, 1.00, t));

  float twinkle = 1.0 + tw * sin(uTime * (1.3 + mag * 4.0) + present * 63.0) * (0.30 + 0.70 * mag);

  return col * (core + halo) * bright * (0.16 + 0.95 * mag) * twinkle;
}

// Shaded planet disc. Returns colour; "cover" is 1 inside the solid disc.
vec3 planet(vec3 dir, vec3 pd, float ang, out float cover) {
  cover = 0.0;
  if (dot(dir, pd) <= 0.0) return vec3(0.0);

  vec3 upRef = abs(pd.y) > 0.95 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
  vec3 right = normalize(cross(upRef, pd));
  vec3 up = cross(pd, right);

  float sr = max(sin(ang), 1e-4);
  float u = dot(dir, right) / sr;
  float v = dot(dir, up) / sr;
  float r2 = u * u + v * v;
  if (r2 > 3.2) return vec3(0.0);

  vec3 sun = normalize(uSunDir);

  // Outer atmospheric shell, visible as a crescent glow off the lit limb.
  float rr = sqrt(r2);
  float shell = exp(-max(rr - 1.0, 0.0) * 24.0);
  vec3 limbDir = normalize(right * (u / max(rr, 1e-4)) + up * (v / max(rr, 1e-4)) - pd * 0.05);
  float shellLit = pow(clamp(dot(limbDir, sun) * 0.5 + 0.5, 0.0, 1.0), 3.0);
  vec3 outCol = uPlanetAtmo * shell * shellLit * 1.6 * step(1.0, rr);

  if (r2 >= 1.0) return outCol;

  float z = sqrt(max(0.0, 1.0 - r2));
  vec3 N = normalize(right * u + up * v - pd * z);
  float ndl = dot(N, sun);

  // Planet-local coordinates so the surface can spin without moving the disc.
  vec3 L = vec3(u, v, -z);
  float ca = cos(uPlanetSpin);
  float sa = sin(uPlanetSpin);
  vec3 S = vec3(L.x * ca - L.z * sa, L.y, L.x * sa + L.z * ca);

  float cont = fbm(S * 2.4 + 5.0, 5);
  float detail = fbm(S * 7.5 + 12.0, 4);
  float land = smoothstep(0.47, 0.55, cont * 0.78 + detail * 0.28);
  float ice = smoothstep(0.74, 0.94, abs(S.y));

  vec3 surf = mix(uPlanetOcean * (0.75 + 0.5 * detail), uPlanetLand, land);
  surf = mix(surf, uPlanetLand * vec3(0.62, 0.78, 0.55), land * detail * 0.65);
  surf = mix(surf, vec3(0.90, 0.94, 1.00), ice);

  // Specular glint off the oceans, killed on land.
  vec3 h = normalize(sun - dir);
  float spec = pow(clamp(dot(N, h), 0.0, 1.0), 220.0) * (1.0 - land) * (1.0 - ice) * 2.2;

  // Banded cloud deck, drifting slightly faster than the surface rotates.
  float cd = cos(uPlanetSpin * 1.18 + 0.6);
  float sd = sin(uPlanetSpin * 1.18 + 0.6);
  vec3 C = vec3(L.x * cd - L.z * sd, L.y, L.x * sd + L.z * cd);
  float bands = fbm(vec3(C.x * 2.6, C.y * 8.5, C.z * 2.6) + 31.0, 4);
  bands = mix(bands, ridged(C * 4.2 + 3.0, 3), 0.35);
  float cloud = smoothstep(0.50, 0.80, bands);

  float term = smoothstep(-0.14, 0.30, ndl);
  float lam = clamp(ndl, 0.0, 1.0);

  vec3 lit = surf * (lam * 1.25 + 0.008);
  lit += spec * uSunColor * term;
  lit = mix(lit, vec3(0.94, 0.96, 1.00) * (lam * 1.30 + 0.005), cloud * 0.82);

  // Limb: atmosphere thickens toward the edge and scatters blue, then red at
  // the terminator where the light path through air is longest. The base term
  // is kept tiny so the night limb is airglow, not a uniform neon ring.
  float rim = pow(1.0 - z, 3.5);
  lit += uPlanetAtmo * rim * (0.07 + 1.7 * pow(clamp(ndl, 0.0, 1.0), 0.55));
  float sunset = smoothstep(-0.10, 0.06, ndl) * (1.0 - smoothstep(0.04, 0.36, ndl));
  lit += vec3(1.00, 0.42, 0.16) * sunset * (0.35 + rim * 1.6) * 0.55;

  // Night side: settlement lights clustered on the continents.
  float night = smoothstep(0.02, -0.22, ndl);
  float cities = smoothstep(0.54, 0.72, cont) * land * smoothstep(0.45, 0.80, detail);
  lit += vec3(1.00, 0.72, 0.34) * night * cities * 0.30;
  lit += uPlanetAtmo * 0.025 * night * rim;

  // Soft edge over the last 1.8% of r2 keeps the limb from aliasing.
  cover = 1.0 - smoothstep(0.982, 1.0, r2);
  return mix(outCol, lit, cover);
}

/** Small airless moon - cratered, no atmosphere, sharp terminator. */
vec3 moon(vec3 dir, vec3 md, float ang, out float cover) {
  cover = 0.0;
  if (dot(dir, md) <= 0.0 || ang <= 0.0) return vec3(0.0);

  vec3 upRef = abs(md.y) > 0.95 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
  vec3 right = normalize(cross(upRef, md));
  vec3 up = cross(md, right);

  float sr = max(sin(ang), 1e-5);
  float u = dot(dir, right) / sr;
  float v = dot(dir, up) / sr;
  float r2 = u * u + v * v;
  if (r2 >= 1.0) return vec3(0.0);

  float z = sqrt(1.0 - r2);
  vec3 N = normalize(right * u + up * v - md * z);
  vec3 L = vec3(u, v, -z);

  float craters = ridged(L * 9.0 + 2.0, 4);
  float mare = smoothstep(0.42, 0.62, fbm(L * 3.1 + 8.0, 4));
  float alb = mix(0.78, 0.42, mare) * (1.0 - craters * 0.35);

  float ndl = clamp(dot(N, normalize(uSunDir)), 0.0, 1.0);
  cover = 1.0 - smoothstep(0.986, 1.0, r2);
  return vec3(alb) * vec3(0.98, 0.97, 0.94) * (pow(ndl, 0.85) * 0.9 + 0.006) * cover;
}

void main() {
  vec3 dir = normalize(vDir);

  /* --- nebula ------------------------------------------------------ */
  vec3 np = dir * 1.55;
  float base = fbm(np, 5);
  float clump = smoothstep(0.40, 0.86, fbm(dir * 0.85 + 19.0, 3));
  float fil = ridged(np * 2.35 + 7.0, 4);
  float density = (base * 0.62 + fil * 0.62) * clump;

  vec3 neb = mix(uNebulaA, uNebulaB, clamp(base * 1.5, 0.0, 1.0));
  neb = mix(neb, uNebulaC, clamp(fil * fil * 1.6, 0.0, 1.0));
  vec3 col = neb * density * uNebulaDensity;

  /* --- galactic band ----------------------------------------------- */
  vec3 gAxis = normalize(uGalaxyAxis);
  float gd = dot(dir, gAxis);
  // Narrow core plus a much fainter halo: a wide single gaussian reads as fog
  // rather than as a galactic plane seen edge-on.
  float band = exp(-gd * gd * 190.0) + 0.22 * exp(-gd * gd * 34.0);
  float dust = fbm(dir * 6.5 + 41.0, 4);
  float glow = band * (0.22 + 0.95 * fbm(dir * 2.6 + 3.0, 3));
  glow *= 1.0 - 0.92 * smoothstep(0.32, 0.70, dust);
  vec3 galaxy = mix(vec3(0.34, 0.44, 0.80), vec3(1.00, 0.90, 0.72), 0.20 + 0.55 * dust);
  col += galaxy * glow * uGalaxyStrength;

  /* --- stars -------------------------------------------------------- */
  vec3 stars = vec3(0.0);
  stars += starLayer(dir,  85.0, 0.26, 1.35, 1.00, 0.55);
  stars += starLayer(dir, 205.0, 0.38, 0.85, 0.55, 0.35);
  stars += starLayer(dir, 520.0, 0.52, 0.50, 0.24, 0.14);
  // Extra dust of faint stars concentrated in the galactic plane.
  stars += starLayer(dir, 760.0, 0.60, 0.40, 0.20, 0.0) * band * 2.2;
  col += stars * uStarBrightness;

  /* --- bodies -------------------------------------------------------- */
  float pCover = 0.0;
  vec3 pCol = planet(dir, normalize(uPlanetDir), uPlanetAngular, pCover);
  float mCover = 0.0;
  vec3 mCol = moon(dir, normalize(uMoonDir), uMoonAngular, mCover);

  col *= (1.0 - clamp(pCover + mCover, 0.0, 1.0));
  col += pCol + mCol;

  /* --- local star ----------------------------------------------------- */
  float sd = dot(dir, normalize(uSunDir));
  float disc = smoothstep(cos(uSunSize * 1.35), cos(uSunSize * 0.85), sd);
  float bleed = pow(clamp(sd, 0.0, 1.0), 3000.0) * 1.8
              + pow(clamp(sd, 0.0, 1.0), 400.0) * 0.10
              + pow(clamp(sd, 0.0, 1.0), 40.0) * 0.008;
  col += uSunColor * (disc * 9.0 + bleed) * (1.0 - clamp(pCover + mCover, 0.0, 1.0));

  gl_FragColor = vec4(max(col * uExposure, 0.0), 1.0);
}
`;

/* ------------------------------------------------------------------ */
/* Atmosphere (daylight + alpine)                                      */
/* ------------------------------------------------------------------ */

const ATMOSPHERE_FRAGMENT = /* glsl */ `
precision highp float;

varying vec3 vDir;

uniform float uTime;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform float uSunIntensity;
uniform float uSunAngular;
uniform float uRayleigh;
uniform float uMie;
uniform float uMieG;
uniform float uAltitude;
uniform vec3  uGroundColor;
uniform vec3  uHazeColor;
uniform float uHorizonHaze;
uniform float uCirrus;
uniform float uCirrusScale;
uniform float uCirrusSpeed;
uniform float uExposure;

${NOISE_GLSL}

const float PI = 3.14159265359;
const float R_EARTH = 6360000.0;
const float R_ATMOS = 6420000.0;
const float H_RAY   = 7994.0;
const float H_MIE   = 1200.0;
const vec3  BETA_R  = vec3(5.8e-6, 13.5e-6, 33.1e-6);
const float BETA_M  = 21e-6;

/** Distance to the far intersection with a sphere of radius r centred at 0. */
float raySphere(vec3 o, vec3 d, float r) {
  float b = dot(o, d);
  float c = dot(o, o) - r * r;
  float disc = b * b - c;
  if (disc < 0.0) return -1.0;
  return -b + sqrt(disc);
}

/**
 * Single-scattering integration through a spherical, exponentially stratified
 * atmosphere. Ten view samples with four in-scattering samples each is the
 * cheapest configuration that still resolves the golden-hour gradient without
 * banding.
 */
vec3 scatter(vec3 dir, vec3 sun) {
  vec3 origin = vec3(0.0, R_EARTH + uAltitude, 0.0);
  float far = raySphere(origin, dir, R_ATMOS);
  if (far <= 0.0) return vec3(0.0);

  vec3 betaR = BETA_R * uRayleigh;
  float betaM = BETA_M * uMie;

  const int VIEW_STEPS = 10;
  const int LIGHT_STEPS = 4;

  float segment = far / float(VIEW_STEPS);
  float odR = 0.0;
  float odM = 0.0;
  vec3 sumR = vec3(0.0);
  vec3 sumM = vec3(0.0);

  float mu = dot(dir, sun);
  float phaseR = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
  float g = uMieG;
  float phaseM = 3.0 / (8.0 * PI) * ((1.0 - g * g) * (1.0 + mu * mu)) /
                 ((2.0 + g * g) * pow(max(1.0 + g * g - 2.0 * g * mu, 1e-4), 1.5));

  float t = 0.0;
  for (int i = 0; i < VIEW_STEPS; i++) {
    vec3 sp = origin + dir * (t + segment * 0.5);
    float h = length(sp) - R_EARTH;
    float hr = exp(-h / H_RAY) * segment;
    float hm = exp(-h / H_MIE) * segment;
    odR += hr;
    odM += hm;

    float lightFar = raySphere(sp, sun, R_ATMOS);
    float lseg = lightFar / float(LIGHT_STEPS);
    float odRL = 0.0;
    float odML = 0.0;
    float lt = 0.0;
    bool lit = true;
    for (int j = 0; j < LIGHT_STEPS; j++) {
      vec3 lp = sp + sun * (lt + lseg * 0.5);
      float lh = length(lp) - R_EARTH;
      if (lh < 0.0) { lit = false; break; }
      odRL += exp(-lh / H_RAY) * lseg;
      odML += exp(-lh / H_MIE) * lseg;
      lt += lseg;
    }

    if (lit) {
      vec3 tau = betaR * (odR + odRL) + vec3(betaM * 1.1 * (odM + odML));
      vec3 att = exp(-tau);
      sumR += att * hr;
      sumM += att * hm;
    }
    t += segment;
  }

  return (sumR * betaR * phaseR + sumM * vec3(betaM) * phaseM) * uSunIntensity;
}

/** Kasten-Young relative air mass - drives sun-disc reddening near the horizon. */
float airMass(float cosZenith) {
  float z = degrees(acos(clamp(cosZenith, -1.0, 1.0)));
  return 1.0 / (max(cosZenith, 0.0) + 0.15 * pow(max(93.885 - z, 1e-3), -1.253));
}

void main() {
  vec3 dir = normalize(vDir);
  vec3 sun = normalize(uSunDir);

  // Below the horizon we reuse the horizon colour: everything down there is
  // occluded by terrain anyway, and it keeps aerial perspective continuous.
  vec3 sdir = normalize(vec3(dir.x, max(dir.y, 0.0015), dir.z));
  vec3 col = scatter(sdir, sun);

  /* --- sun disc + glare -------------------------------------------- */
  float cosA = dot(dir, sun);
  float ang = acos(clamp(cosA, -1.0, 1.0));
  vec3 ext = exp(-(BETA_R * uRayleigh * H_RAY + vec3(BETA_M * uMie * H_MIE)) * airMass(sun.y));

  float disc = 1.0 - smoothstep(uSunAngular * 0.82, uSunAngular, ang);
  float limb = sqrt(max(0.0, 1.0 - pow(min(ang / uSunAngular, 1.0), 2.0)));
  col += uSunColor * ext * disc * (0.55 + 0.45 * limb) * uSunIntensity * 0.45;
  // Forward-scattered aureole around the sun; sells the haze more than the disc.
  col += uSunColor * ext * pow(clamp(cosA, 0.0, 1.0), 500.0) * uSunIntensity * 0.020;
  col += uSunColor * ext * pow(clamp(cosA, 0.0, 1.0), 24.0) * uSunIntensity * 0.0022;

  /* --- cirrus ------------------------------------------------------- */
  if (uCirrus > 0.0 && dir.y > 0.0) {
    // Flat-plane projection: cheap parallax that reads as a high cloud deck.
    vec2 cp = dir.xz / max(dir.y, 0.055) * uCirrusScale;
    vec3 q = vec3(cp.x * 0.30 + uTime * uCirrusSpeed, cp.y * 1.45, 0.0);
    float c = ridged(q, 4);
    c = c * 0.65 + fbm(vec3(cp * 0.7, uTime * uCirrusSpeed * 0.5), 4) * 0.45;
    float wisp = pow(smoothstep(0.46, 0.88, c), 1.5);
    float fade = smoothstep(0.02, 0.26, dir.y) * (1.0 - smoothstep(0.75, 1.0, dir.y) * 0.35);
    float amount = clamp(wisp * fade * uCirrus, 0.0, 1.0);

    // Clouds are lit by the sun through their own thickness: warm where they
    // face the sun, cool ambient elsewhere.
    float towards = pow(clamp(cosA, 0.0, 1.0), 5.0);
    vec3 cloudCol = mix(uHazeColor * 1.15, uSunColor * ext * 2.4, towards);
    cloudCol *= mix(0.55, 1.35, wisp);
    col = mix(col, cloudCol * uSunIntensity * 0.026, amount);
  }

  /* --- horizon haze + ground --------------------------------------- */
  float hz = exp(-max(dir.y, 0.0) * 7.0);
  col = mix(col, uHazeColor * (0.35 + 0.9 * length(col)), uHorizonHaze * hz);

  float below = 1.0 - smoothstep(-0.055, 0.005, dir.y);
  col = mix(col, uGroundColor, below * 0.9);

  gl_FragColor = vec4(max(col * uExposure, 0.0), 1.0);
}
`;

/* ------------------------------------------------------------------ */
/* Presets                                                             */
/* ------------------------------------------------------------------ */

const SPACE_DEFAULTS = {
  radius: 1500,
  sunDirection: new THREE.Vector3(0.55, 0.28, -0.78),
  sunColor: 0xfff3e0,
  sunSize: 0.010,
  nebulaA: 0x2a1848,
  nebulaB: 0x0d3a56,
  nebulaC: 0x7a2a5e,
  nebulaDensity: 0.42,
  galaxyAxis: new THREE.Vector3(0.24, 0.94, -0.24),
  galaxyStrength: 0.11,
  planetDirection: new THREE.Vector3(-0.62, 0.12, -0.77),
  planetAngularRadius: 0.34,
  planetLand: 0x5b6b3f,
  planetOcean: 0x0d2b52,
  planetAtmosphere: 0x4f9dd8,
  planetSpinSpeed: 0.006,
  moonDirection: new THREE.Vector3(0.28, 0.46, -0.84),
  moonAngularRadius: 0.055,
  starBrightness: 1.0,
  exposure: 1.0,
};

const DAYLIGHT_DEFAULTS = {
  radius: 1500,
  // Late golden hour: sun low, slightly behind the player's spawn heading.
  sunDirection: new THREE.Vector3(-0.62, 0.155, -0.77),
  sunColor: 0xfff0d4,
  // Calibrated against ACES at exposure 1: gives a mean scene-referred sky
  // luminance of ~0.23, which lands mid-frame instead of clipping.
  sunIntensity: 13,
  sunAngularSize: 0.021,
  rayleigh: 1.9,
  mie: 1.5,
  mieG: 0.78,
  altitude: 120,
  groundColor: 0x2b2519,
  hazeColor: 0xd79a5c,
  horizonHaze: 0.42,
  cirrus: 0.55,
  cirrusScale: 1.5,
  cirrusSpeed: 0.0035,
  exposure: 1.0,
};

const ALPINE_DEFAULTS = {
  radius: 1500,
  sunDirection: new THREE.Vector3(0.25, 0.90, -0.36),
  sunColor: 0xfffaf0,
  sunIntensity: 16,
  sunAngularSize: 0.017,
  // Thin, clean air: less Mie, more Rayleigh -> very deep zenith.
  rayleigh: 3.1,
  mie: 0.26,
  mieG: 0.72,
  altitude: 2600,
  groundColor: 0xa8b6c4,
  hazeColor: 0xc9dcec,
  horizonHaze: 0.22,
  cirrus: 0.30,
  cirrusScale: 2.4,
  cirrusSpeed: 0.0022,
  exposure: 1.0,
};

/* ------------------------------------------------------------------ */
/* Factory                                                             */
/* ------------------------------------------------------------------ */

function toVec3(value, fallback) {
  if (value instanceof THREE.Vector3) return value.clone().normalize();
  if (Array.isArray(value)) return new THREE.Vector3(value[0], value[1], value[2]).normalize();
  return fallback.clone().normalize();
}

function toColor(value, fallback) {
  if (value instanceof THREE.Color) return value.clone();
  if (value !== undefined && value !== null) return new THREE.Color(value);
  return new THREE.Color(fallback);
}

/**
 * Build a sky dome.
 *
 * @param {'space'|'daylight'|'alpine'} kind
 * @param {object} [params] Overrides; see the *_DEFAULTS tables above. Two
 *   generic extras are honoured by every kind:
 *   `radius` (dome size in metres) and `camera` (a THREE.Camera the dome will
 *   be re-centred on every update, so the player can never walk out of it).
 * @returns {{ mesh: THREE.Mesh, material: THREE.ShaderMaterial,
 *             sunDirection: THREE.Vector3, setSunDirection(v: THREE.Vector3): void,
 *             update(dt: number): void, dispose(): void }}
 */
export function createSky(kind, params = {}) {
  const preset =
    kind === 'space' ? SPACE_DEFAULTS : kind === 'alpine' ? ALPINE_DEFAULTS : DAYLIGHT_DEFAULTS;
  if (kind !== 'space' && kind !== 'daylight' && kind !== 'alpine') {
    console.warn(`[Sky] unknown kind "${kind}" - falling back to 'daylight'.`);
  }

  const p = { ...preset, ...params };
  const radius = p.radius ?? 1500;
  const sunDirection = toVec3(p.sunDirection, preset.sunDirection);

  let material;

  if (kind === 'space') {
    material = new THREE.ShaderMaterial({
      name: 'Sky.space',
      uniforms: {
        uTime: { value: 0 },
        uSunDir: { value: sunDirection },
        uSunColor: { value: toColor(p.sunColor, preset.sunColor) },
        uSunSize: { value: p.sunSize },
        uNebulaA: { value: toColor(p.nebulaA, preset.nebulaA) },
        uNebulaB: { value: toColor(p.nebulaB, preset.nebulaB) },
        uNebulaC: { value: toColor(p.nebulaC, preset.nebulaC) },
        uNebulaDensity: { value: p.nebulaDensity },
        uGalaxyAxis: { value: toVec3(p.galaxyAxis, preset.galaxyAxis) },
        uGalaxyStrength: { value: p.galaxyStrength },
        uPlanetDir: { value: toVec3(p.planetDirection, preset.planetDirection) },
        uPlanetAngular: { value: p.planetAngularRadius },
        uPlanetLand: { value: toColor(p.planetLand, preset.planetLand) },
        uPlanetOcean: { value: toColor(p.planetOcean, preset.planetOcean) },
        uPlanetAtmo: { value: toColor(p.planetAtmosphere, preset.planetAtmosphere) },
        uPlanetSpin: { value: 0 },
        uMoonDir: { value: toVec3(p.moonDirection, preset.moonDirection) },
        uMoonAngular: { value: p.moonAngularRadius },
        uStarBrightness: { value: p.starBrightness },
        uExposure: { value: p.exposure },
      },
      vertexShader: SKY_VERTEX,
      fragmentShader: SPACE_FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });
  } else {
    material = new THREE.ShaderMaterial({
      name: `Sky.${kind}`,
      uniforms: {
        uTime: { value: 0 },
        uSunDir: { value: sunDirection },
        uSunColor: { value: toColor(p.sunColor, preset.sunColor) },
        uSunIntensity: { value: p.sunIntensity },
        uSunAngular: { value: p.sunAngularSize },
        uRayleigh: { value: p.rayleigh },
        uMie: { value: p.mie },
        uMieG: { value: p.mieG },
        uAltitude: { value: p.altitude },
        uGroundColor: { value: toColor(p.groundColor, preset.groundColor) },
        uHazeColor: { value: toColor(p.hazeColor, preset.hazeColor) },
        uHorizonHaze: { value: p.horizonHaze },
        uCirrus: { value: p.cirrus },
        uCirrusScale: { value: p.cirrusScale },
        uCirrusSpeed: { value: p.cirrusSpeed },
        uExposure: { value: p.exposure },
      },
      vertexShader: SKY_VERTEX,
      fragmentShader: ATMOSPHERE_FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });
  }

  const geometry = new THREE.SphereGeometry(radius, 64, 32);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `sky:${kind}`;
  // Drawn first and writes no depth, so every piece of world geometry - however
  // far away - composites on top of it without a depth fight.
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = true;

  const camera = p.camera ?? null;
  const spinSpeed = p.planetSpinSpeed ?? 0;
  let time = 0;

  return {
    mesh,
    material,
    /** Live reference - mutate it (and normalise) to move the light source. */
    sunDirection,

    /** @param {THREE.Vector3} v Direction *towards* the sun/star. */
    setSunDirection(v) {
      sunDirection.copy(v).normalize();
    },

    /** @param {number} dt Seconds since the last frame. */
    update(dt) {
      time += dt;
      material.uniforms.uTime.value = time;
      if (kind === 'space') material.uniforms.uPlanetSpin.value = time * spinSpeed;
      if (camera) {
        // Keep the dome centred on the viewer so it stays infinitely far away.
        camera.getWorldPosition(_v1);
        mesh.position.copy(_v1);
      }
    },

    dispose() {
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}

export default createSky;
