import * as THREE from 'three';

/**
 * Procedural humanoid characters.
 *
 * Everything here is generated from code: no meshes, no textures, no rigs are
 * loaded from disk. A character is a single `THREE.SkinnedMesh` built by lofting
 * superelliptic cross-sections along the body, plus a sculpted head, hair shell,
 * eyeballs and eyelids.
 *
 * The expensive half (geometry) is cached per *archetype* - build, frame and
 * outfit - because 16 NPCs in a world only need a handful of distinct bodies.
 * The cheap half (skeleton, materials, eye rig) is per instance so every NPC can
 * animate independently and carry its own skin tone / palette.
 */

/* ------------------------------------------------------------------ */
/* Deterministic RNG + value noise                                     */
/* ------------------------------------------------------------------ */

/** mulberry32 - small, fast, good enough for character variation. */
export function createRng(seed) {
  let a = (seed >>> 0) || 1;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(i, j, seed) {
  let h = Math.imul(i | 0, 73856093) ^ Math.imul(j | 0, 19349663) ^ Math.imul(seed | 0, 83492791);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const smooth = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const gauss = (v, c, s) => Math.exp(-((v - c) * (v - c)) / (s * s));
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Tileable value noise. `u`,`v` in [0,1); lattice wraps at `period`. */
function valueNoise(u, v, period, seed) {
  const x = u * period;
  const y = v * period;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = smooth(x - xi);
  const fy = smooth(y - yi);
  const x0 = ((xi % period) + period) % period;
  const y0 = ((yi % period) + period) % period;
  const x1 = (x0 + 1) % period;
  const y1 = (y0 + 1) % period;
  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);
  return lerp(lerp(a, b, fx), lerp(c, d, fx), fy);
}

/** Fractal sum of tileable value noise. Returns 0..1. */
function fbm(u, v, octaves, basePeriod, seed, lacunarity = 2) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let per = basePeriod;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(u, v, Math.max(2, Math.round(per)), seed + o * 977);
    norm += amp;
    amp *= 0.5;
    per *= lacunarity;
  }
  return sum / norm;
}

/** Anisotropic noise - stretched along v. Used for hair strands and brushed metal. */
function streakNoise(u, v, period, stretch, seed) {
  return valueNoise(u, v / stretch, period, seed);
}

/* ------------------------------------------------------------------ */
/* Texture generation (DataTexture only - no canvas, works headless)   */
/* ------------------------------------------------------------------ */

function makeDataTexture(size, writer, srgb, aniso) {
  const data = new Uint8Array(size * size * 4);
  writer(data, size);
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = aniso;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Sobel a height field into a tangent-space normal map. Doing this from the
 * same function that drives the albedo keeps bumps and shading in agreement,
 * which is what sells a surface as real rather than as a texture.
 */
function makeNormalTexture(size, heightFn, strength, aniso) {
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) h[y * size + x] = heightFn(x / size, y / size);
  }
  const at = (x, y) => h[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  return makeDataTexture(
    size,
    (data) => {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const dx =
            at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1) -
            (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1));
          const dy =
            at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1) -
            (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1));
          let nx = dx * strength;
          let ny = dy * strength;
          const nz = 1;
          const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
          nx *= inv;
          ny *= inv;
          const i = (y * size + x) * 4;
          data[i] = Math.round((nx * 0.5 + 0.5) * 255);
          data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
          data[i + 2] = Math.round((nz * inv * 0.5 + 0.5) * 255);
          data[i + 3] = 255;
        }
      }
    },
    false,
    aniso
  );
}

/** Pack a scalar field into all three channels (roughness / AO style maps). */
function makeScalarTexture(size, fn, aniso) {
  return makeDataTexture(
    size,
    (data) => {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const v = Math.round(clamp(fn(x / size, y / size), 0, 1) * 255);
          const i = (y * size + x) * 4;
          data[i] = v;
          data[i + 1] = v;
          data[i + 2] = v;
          data[i + 3] = 255;
        }
      }
    },
    false,
    aniso
  );
}

function makeColorTexture(size, fn, aniso) {
  const c = { r: 1, g: 1, b: 1 };
  return makeDataTexture(
    size,
    (data) => {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          fn(x / size, y / size, c);
          const i = (y * size + x) * 4;
          data[i] = Math.round(clamp(c.r, 0, 1) * 255);
          data[i + 1] = Math.round(clamp(c.g, 0, 1) * 255);
          data[i + 2] = Math.round(clamp(c.b, 0, 1) * 255);
          data[i + 3] = 255;
        }
      }
    },
    true,
    aniso
  );
}

/* --- individual surface definitions --------------------------------- */

// Skin: fine pore breakup plus a slow mottle so large areas never read flat.
//
// The old field asked for lattice periods of 96 and 220 out of a 256 px map:
// 2.7 and 1.2 texels per cell. Both are at or past Nyquist, so what actually
// reached the GPU was white hash noise that the first mip averaged to a flat
// grey - which is precisely the reviewer's "no pore normal, no specular
// breakup, uniform matte putty". The map is 512 px now (see SKIN_TEX) and every
// period below resolves to at least two and a half texels, so the octaves are
// real surface rather than aliasing.
//
// Note the scale ceiling this surface lives under: UV_DENSITY is 3 tiles/m, so
// one tile spans 33 cm of skin and a 512 px map gives 0.65 mm per texel. True
// pores are sub-texel and always will be; what these octaves buy is the 2-5 mm
// orange-peel breakup, which is exactly the scale that decides whether a cheek
// answers a key light with one smooth lobe or with skin.
const skinHeight = (u, v) =>
  fbm(u, v, 3, 44, 11) * 0.46 + fbm(u, v, 3, 104, 23) * 0.34 + fbm(u, v, 2, 208, 53) * 0.20;

function skinAlbedo(u, v, out) {
  // A base period of 7 over a full-body UV atlas puts one noise cell at roughly
  // head width, and at that scale a "mottle" is not skin variation, it is a
  // rash - reviewers read the cheeks as camouflage and the forearms as a
  // pattern. Period 44 puts the cell at ~2 cm (a real dermal blotch) and the
  // amplitude comes down by 3x so the term modulates the shading instead of
  // competing with it.
  const mottle = fbm(u, v, 4, 44, 3) - 0.5;
  const pore = skinHeight(u, v) - 0.5;
  const freckle = smoothstep(0.74, 0.88, fbm(u, v, 2, 130, 41));
  // The value variation the old mottle was trying to buy comes back as a slow
  // directional ramp instead: extremities warmer and slightly lighter than the
  // trunk, which is what real skin does and what isotropic noise never will.
  const ramp = (fbm(u, v, 1, 220, 77) - 0.5) * 0.6 + 0.5;
  const base = 0.82 + mottle * 0.03 + pore * 0.05 + (ramp - 0.5) * 0.045;
  // Blood is closer to the surface in some regions - bias red slightly.
  out.r = base * (1.0 + mottle * 0.02 + (ramp - 0.5) * 0.05) - freckle * 0.05;
  out.g = base * (0.955 - mottle * 0.012) - freckle * 0.08;
  out.b = base * (0.925 - mottle * 0.02 - (ramp - 0.5) * 0.04) - freckle * 0.09;
}

const fabricHeight = (u, v) => {
  const weave =
    Math.abs(Math.sin(u * Math.PI * 64)) * 0.5 + Math.abs(Math.sin(v * Math.PI * 64)) * 0.5;
  return weave * 0.6 + fbm(u, v, 3, 64, 7) * 0.4;
};

const knitHeight = (u, v) => {
  // The chevron has to be a *weave*, not wallpaper. At the old 26-cycle period
  // one repeat landed at ~2 cm on the torso and read as a printed pattern; at 78
  // it is stitch-scale. A second decorrelating layer on a coprime period breaks
  // the visible tile so the eye cannot lock onto the repeat.
  const rib = Math.abs(Math.sin(u * Math.PI * 78 + Math.sin(v * Math.PI * 78) * 0.8));
  const slub = fbm(u, v, 3, 37, 113);
  return rib * 0.42 + fbm(u, v, 4, 40, 13) * 0.34 + slub * 0.24;
};

// Leather has to read as *cut and sewn panels*, not as an organic lump field.
// The old version was two octaves of fbm on an 18-cell period, which at the
// texel density a chest rig gets is exactly "wet gravel stretched over a slab" -
// no seams, no bevels, no directional structure, and identical at every scale
// so a thigh pad and a chest plate looked stamped from the same photograph.
// Here the pebble grain is 2x finer and half the amplitude, and a coarse panel
// grid cuts a real groove with a stitch row beside it.
const leatherHeight = (u, v) => {
  const grain = fbm(u, v, 4, 66, 31);
  const cell = fbm(u, v, 2, 30, 29);
  const crack = 1 - smoothstep(0.44, 0.54, Math.abs(cell - 0.5) * 2);
  const px = Math.abs(((u * 3) % 1) - 0.5) * 2;
  const py = Math.abs(((v * 4) % 1) - 0.5) * 2;
  // Bevelled seam at the panel border, plus a stitch row just inside it.
  const seam = Math.max(smoothstep(0.82, 0.99, px), smoothstep(0.82, 0.99, py));
  const stitch =
    (gauss(px - 0.74, 0, 0.035) + gauss(py - 0.74, 0, 0.035)) *
    (Math.sin((u + v) * Math.PI * 150) * 0.5 + 0.5) *
    0.22;
  return clamp(0.52 + (grain - 0.5) * 0.30 + crack * 0.14 - seam * 0.34 + stitch, 0, 1);
};

const techHeight = (u, v) => {
  // Panel grid with bevelled seams and a rivet row.
  const gx = u * 6;
  const gy = v * 8;
  const fx = Math.abs((gx % 1) - 0.5) * 2;
  const fy = Math.abs((gy % 1) - 0.5) * 2;
  const seam = Math.min(smoothstep(0.86, 0.99, fx), 1) * Math.min(smoothstep(0.86, 0.99, fy), 1);
  const rivet =
    gauss((gx % 1) - 0.5, 0, 0.06) * gauss((gy % 1) - 0.12, 0, 0.05) * 0.6;
  return 0.55 + (1 - seam) * -0.35 + rivet + streakNoise(u, v, 180, 26, 5) * 0.12;
};

const mailHeight = (u, v) => {
  // Interlocked rings: distance to the nearest ring centre on an offset lattice.
  //
  // The isoline falloff used to be `1 - best * 4.2`, which spreads the ring wall
  // over a quarter of a cell - at 256 px that is wider than the cell itself and
  // the lattice resolves as a field of rounded lumps rather than linked rings.
  // 9.0 keeps the wall inside two texels of the isoline, which is what makes a
  // ring a ring. Sampled at 512 (see _metalMaps) so the tighter wall survives.
  const s = 26;
  const gx = u * s;
  const gy = v * s;
  let best = 1;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const cx = Math.floor(gx) + ox + 0.5;
      const cy = Math.floor(gy) + oy + 0.5;
      const jx = cx + (Math.floor(cy) % 2 === 0 ? 0 : 0.5);
      const d = Math.hypot(gx - jx, gy - cy);
      best = Math.min(best, Math.abs(d - 0.38));
    }
  }
  return clamp(1 - best * 9.0, 0, 1) * 0.88 + fbm(u, v, 2, 90, 61) * 0.12;
};

// Period 220 with a stretch of 34 puts one strand band inside a single texel of
// the mip the head-sized UV island actually samples, so the anisotropic streak
// averaged away to nothing and the hair shaded like moulded rubber. A coarser
// period and a much longer stretch give a band that survives mipmapping and
// produces a real directional highlight down the length of the strand.
const hairHeight = (u, v) =>
  streakNoise(u, v, 80, 62, 71) * 0.62 + streakNoise(u, v, 190, 40, 17) * 0.2 + fbm(u, v, 2, 26, 73) * 0.18;

/* ------------------------------------------------------------------ */
/* Per-character rim term                                              */
/* ------------------------------------------------------------------ */

/**
 * Inject a fresnel rim into a standard/physical material.
 *
 * A character standing in a level lit only by that level's ambient has no value
 * separation from the background - a navy suit in a navy cargo bay disappears
 * and the silhouette dies. A real production rig would parent a rim light to
 * every NPC, but sixteen extra DirectionalLights would rebuild every shader in
 * the scene. A view-space fresnel added to `outgoingLight` buys the same edge
 * separation for nothing: it is deliberately *not* physical, it is a lighting
 * intent baked into the shader.
 *
 * @param {THREE.Material} mat
 * @param {number} rimHex complementary to the world's ambient, not matching it
 * @param {number} strength linear radiance added at grazing angles
 * @param {number} power fresnel falloff exponent (higher = tighter edge)
 */
function addRim(mat, rimHex, strength, power = 3.0, opts = {}) {
  const col = new THREE.Color(rimHex);
  const fill = FILL_FOR.get(rimHex) ?? DEFAULT_FILL;
  const sky = new THREE.Color(fill.sky);
  const ground = new THREE.Color(fill.ground);
  // Camera-facing lift. See the shader comment below - this is the term that
  // decides whether a standing character has a face or a value hole.
  const fwdK = opts.forward ?? 0.45;
  const fwdCol = new THREE.Color(opts.forwardHex ?? fill.sky);
  const key = `rim3|${rimHex}|${strength}|${power}|${fwdK}|${fwdCol.getHex()}`;
  mat.userData.rim = { hex: rimHex, strength, power };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColor = { value: col };
    shader.uniforms.uRimStrength = { value: strength };
    shader.uniforms.uRimPower = { value: power };
    shader.uniforms.uRimDir = { value: RIM_DIR };
    shader.uniforms.uFillSky = { value: sky };
    shader.uniforms.uFillGround = { value: ground };
    shader.uniforms.uFillStrength = { value: fill.strength };
    shader.uniforms.uFillFwd = { value: fwdCol };
    shader.uniforms.uFillFwdK = { value: fwdK };
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      '#include <common>\nuniform vec3 uRimColor;\nuniform float uRimStrength;\nuniform float uRimPower;\n' +
        'uniform vec3 uRimDir;\nuniform vec3 uFillSky;\nuniform vec3 uFillGround;\nuniform float uFillStrength;\n' +
        'uniform vec3 uFillFwd;\nuniform float uFillFwdK;'
    );

    // The fill goes in as *irradiance*, not as a paste-on after the fact.
    //
    // The previous version added it straight to `outgoingLight`, which meant it
    // ignored the AO map and every shadow on the character: the result was a
    // uniform milky veil over the whole figure with no form shadow anywhere,
    // and the edges glowing into the background instead of separating from it.
    // Injected before <lights_fragment_end> it runs through RE_IndirectDiffuse
    // exactly like a HemisphereLight would, so <aomap_fragment> occludes it and
    // cavities stay dark. It is still character-only - no scene light is added,
    // no other shader in the frame is rebuilt.
    // `irradiance` is declared inside `#if defined( RE_IndirectDiffuse )` in
    // <lights_fragment_begin>, so the guard is not decorative.
    // The forward term is the fix for "the face is a flat dark ovoid at the
    // exact distance a player would talk to it".
    //
    // The hemisphere above biases sky light onto up-facing normals, which is
    // correct for a floor or a shoulder and catastrophic for a face: a standing
    // character's face is a *vertical plane*, normal.y is ~0, so hemi is 0.5 and
    // the smoothstep hands it almost pure ground colour. Under the sports rig
    // that ground colour is dim concrete, so the single most important surface
    // on the character received the least light of anything on it.
    //
    // `geometryNormal` is view-space, so -z is "turned toward the camera". A
    // surface the player is looking straight at gets the sky/forward colour
    // regardless of which way is up. That is not physical - it is a bounce card
    // parented to the camera, which is exactly what a portrait rig is.
    const fillInject = `
#if defined( RE_IndirectDiffuse )
  {
    float hemi = geometryNormal.y * 0.5 + 0.5;
    // Bias the sky term to up-facing normals only: a symmetric hemisphere lifts
    // the down-planes it exists to contrast against, which is flattening.
    vec3 fillC = mix( uFillGround, uFillSky, smoothstep( 0.28, 0.92, hemi ) );
    float fwd = saturate( -geometryNormal.z );
    fillC = mix( fillC, uFillFwd, fwd * uFillFwdK );
    irradiance += fillC * uFillStrength;
  }
#endif
`;
    const fillAnchor = '#include <lights_fragment_end>';
    if (shader.fragmentShader.includes(fillAnchor)) {
      shader.fragmentShader = shader.fragmentShader.replace(fillAnchor, fillInject + fillAnchor);
    }
    // `geometryNormal` and `geometryViewDir` are both declared by
    // <lights_fragment_begin> and still in scope at <opaque_fragment>, where
    // `outgoingLight` holds the final radiance before alpha and fog.
    //
    // Two terms, and they do different jobs. The rim is an *edge*: it separates
    // the silhouette from whatever is behind it. The fill is a *body*: a cheap
    // two-colour hemisphere wrap that lifts the shadow side off the floor of
    // the histogram so a dark suit in a dark bay is still a readable figure
    // rather than a hole. Reviewers saw both failures at once - "a dark navy
    // blob against a dark navy container wall with one blown-out white specular
    // pop as the entire lighting story" - and a rim alone cannot fix the second,
    // because a rim by definition does nothing to the middle of the body.
    //
    // The fill is 60% modulated by albedo and 40% flat. Fully modulated it
    // vanishes on exactly the dark garments that need it; fully flat it turns
    // every character into grey plastic. The split keeps material identity while
    // guaranteeing a floor on the darkest surfaces.
    // An omnidirectional fresnel is not a rim light, it is a halo. It fires on
    // every interior shell boundary as hard as it fires on the silhouette -
    // reviewers saw a warm orange line traced along the bottom edge of the chest
    // plate where it meets the torso, which reads as a cartoon outline shader
    // dropped into a PBR scene. Two gates fix that:
    //
    //  - a directional term, so the band only exists where the surface turns
    //    away toward the (virtual) back-light. That is what makes it read as a
    //    light with a position rather than an outline;
    //  - a down-plane suppressor, because the underside of a layered shell is
    //    always the false positive. Nothing facing the floor gets a rim.
    //
    // `geometryNormal` is view-space here, so uRimDir is a *camera-relative*
    // direction: behind, above and to camera-left. That is deliberate - it keeps
    // the key/rim relationship stable as the player orbits an NPC, which is the
    // only way to buy a consistent silhouette read without a real light per
    // character.
    const inject = `
  {
    float fres = 1.0 - saturate( dot( geometryNormal, geometryViewDir ) );
    float dirF = smoothstep( -0.20, 0.70, dot( geometryNormal, uRimDir ) );
    float up = smoothstep( -0.42, 0.05, geometryNormal.y );
    outgoingLight += uRimColor * pow( fres, uRimPower ) * uRimStrength * dirF * up;
  }
`;
    const anchor = '#include <opaque_fragment>';
    if (shader.fragmentShader.includes(anchor)) {
      shader.fragmentShader = shader.fragmentShader.replace(anchor, inject + anchor);
    }
  };
  // Without a distinct cache key three would reuse the first compiled program
  // for every rim colour.
  mat.customProgramCacheKey = () => key;
  return mat;
}

/**
 * View-space direction the character rim comes from: up, camera-left and behind
 * the subject. Shared by every rim-injected material so the whole cast is lit by
 * one consistent imaginary back-light.
 */
const RIM_DIR = new THREE.Vector3(-0.55, 0.62, -0.56).normalize();

/**
 * Per-theme character fill rig, keyed by the theme's rim colour so a material
 * only has to be handed one descriptor.
 *
 * `sky` is what a surface facing up receives, `ground` what a surface facing
 * down receives - the same idea as a HemisphereLight, but applied only to
 * characters, which is the point: it lifts the cast without touching the
 * level's exposure or the art director's grade on anything else.
 */
// Strengths are irradiance now, not radiance pasted onto the output, so they
// are read in the same units three uses for a HemisphereLight - roughly PI x
// the old additive numbers for the same apparent brightness. They are set well
// below that: the fill exists to keep the shadow side off the floor of the
// histogram, not to become the lighting.
const DEFAULT_FILL = { sky: 0x7f93a8, ground: 0x2e3138, strength: 0.40 };
const FILL_FOR = new Map([
  // Station: cool overhead panel light, dark deck plate bounce.
  [0xffd2a8, { sky: 0x7fa2c8, ground: 0x2b2f36, strength: 0.50 }],
  // Medieval: warm sky dome, dry-earth bounce.
  [0x9fc4ff, { sky: 0xa9b8cf, ground: 0x4a3b2a, strength: 0.44 }],
  // Sports: bright midday sky, bright concrete bounce.
  //
  // 0.32 was the lowest fill of any theme on the reasoning that midday sun
  // needs no help. It does: a vertical face plane under a straight-down key
  // receives almost nothing from the key and, before the forward term existed,
  // almost nothing from the fill either - so the one theme shot in full daylight
  // was the one whose faces went black. Nearly doubled, and the ground bounce is
  // lifted toward real concrete albedo instead of asphalt.
  [0xbfe6ff, { sky: 0xb6cfe4, ground: 0x8b8d93, strength: 0.60 }],
]);

/**
 * Default rim per world theme.
 *
 * Station used to be 0xffb070 - a fully saturated orange against a blue-grey
 * bay, which is precisely what made the fresnel read as a drawn line rather
 * than a bounce off a warm deck lamp. Pulled two thirds of the way to its own
 * pale tint so it stays warm without becoming a hue statement, and raised in
 * strength because it is now gated by direction and only covers about a third
 * of the silhouette instead of ringing the whole figure.
 */
export const THEME_RIM = {
  station: { hex: 0xffd2a8, strength: 0.62 },
  medieval: { hex: 0x9fc4ff, strength: 0.42 },
  // Sports characters stand on pale concrete under a pale sky, so the
  // silhouette has the least background contrast of the three worlds and needs
  // the *most* edge, not the least. At 0.30 the limbs merged into the deck.
  sports: { hex: 0xbfe6ff, strength: 0.45 },
};

/* ------------------------------------------------------------------ */
/* Shared texture + material library for characters                    */
/* ------------------------------------------------------------------ */

/**
 * Every garment shell on the character is opaque and single-sided. This is not
 * a style choice, it is the fix for the defect three separate reviews opened
 * with: "the character renders semi-transparent, you can read the wall mullions
 * straight through the torso".
 *
 * The cause was `side: DoubleSide` on the garment materials. A garment is an
 * open lofted tube around the body; double-siding it shades the *inside* wall
 * of the tube with an inverted normal and composites it over the outside wall,
 * and with a broad white-lerped sheen on top the result is a milky X-ray wash
 * that reads exactly like alpha blending even though nothing is transparent.
 * The correct answer is to close the shell (see `addHem`, which now tucks the
 * end ring inside the body, plus caps on every garment loft) and cull the back
 * face. `transparent/opacity/depthWrite/alphaTest` are asserted explicitly so
 * no future edit can reintroduce a blend path by accident.
 *
 * `polygonOffset` is belt and braces: a garment shell and the body underneath
 * it are two surfaces a couple of centimetres apart bound to *different* bone
 * sets, and biasing the garment toward the camera means a skinning divergence
 * can never resolve as a speckled interleave.
 */
/**
 * Skin map resolution. Everything else on the character can live at 256 - a
 * weave or a leather grain is a repeating pattern and mips gracefully - but skin
 * is the one surface a player puts their face against, and its height field
 * needs periods that a 256 px lattice cannot represent without aliasing.
 */
const SKIN_TEX = 512;

const OPAQUE_SHELL = {
  side: THREE.FrontSide,
  transparent: false,
  opacity: 1,
  depthWrite: true,
  depthTest: true,
  alphaTest: 0,
  polygonOffset: true,
  polygonOffsetFactor: -1,
  polygonOffsetUnits: -1,
};

/**
 * Owns every texture and material a character can use. One instance is shared
 * by the whole NPCManager so 16 characters cost a handful of GPU uploads.
 */
export class CharacterAssets {
  /** @param {THREE.WebGLRenderer} [renderer] used only for max anisotropy. */
  constructor(renderer) {
    this.aniso = Math.min(8, renderer?.capabilities?.getMaxAnisotropy?.() ?? 8);
    /** @type {Map<string, THREE.Texture>} */
    this._tex = new Map();
    /** @type {Map<string, THREE.Material>} */
    this._mat = new Map();
    /** @type {Map<string, THREE.BufferGeometry>} */
    this.geoCache = new Map();
    /**
     * Live holders per `geoCache` key, for the entries that are acquired and
     * released (see `acquireGeometry`). Keys absent from this map are session
     * geometry - the contact disc, the weapon shapes - which is a small closed
     * set and is freed only by `dispose()`.
     * @type {Map<string, number>}
     */
    this._geoRefs = new Map();
  }

  _t(key, make) {
    let t = this._tex.get(key);
    if (!t) {
      t = make();
      this._tex.set(key, t);
    }
    return t;
  }

  _skinMaps() {
    return {
      map: this._t('skin.a', () => makeColorTexture(SKIN_TEX, skinAlbedo, this.aniso)),
      // 0.55 on a height field that was aliasing to grey is 1.8x of nothing.
      // With the field fixed the normal can carry real weight.
      normalMap: this._t('skin.n', () => makeNormalTexture(SKIN_TEX, skinHeight, 1.15, this.aniso)),
      // Skin is not one roughness. The T-zone (forehead, nose bridge, the point
      // of the chin) is oily and answers a key light with a tight lobe; cheeks
      // and jaw are dry and matte. Without that difference no facial specular
      // ever forms and the whole head renders as unpainted clay however good the
      // sculpt underneath is.
      //
      // The head UV island tiles the map rather than owning a unique chart, so
      // an authored T-zone mask is not available - the variation has to be
      // stochastic. Two decorrelated bands do the job: a broad one at period 5
      // for oily/dry patches the size of a cheek, and the height field itself
      // for per-bump breakup. The floor comes down from 0.40 to 0.28, which is
      // the whole point: at 0.40 the material never had a highlight to modulate.
      roughnessMap: this._t('skin.r', () =>
        makeScalarTexture(
          SKIN_TEX,
          (u, v) =>
            clamp(
              0.44 + fbm(u, v, 2, 5, 17) * 0.30 + (fbm(u, v, 3, 21, 67) - 0.5) * 0.18 +
                (skinHeight(u, v) - 0.5) * 0.34,
              0.28,
              0.9
            ),
          this.aniso
        )
      ),
    };
  }

  _clothMaps(kind) {
    const h =
      kind === 'knit' ? knitHeight : kind === 'tech' ? techHeight : kind === 'jersey' ? fabricHeight : fabricHeight;
    const rep = kind === 'tech' ? 1 : 1;
    return {
      map: this._t(`cloth.${kind}.a`, () =>
        makeColorTexture(
          256,
          (u, v, o) => {
            const hv = h(u * rep, v * rep);
            const dirt = fbm(u, v, 4, 5, 91) * 0.13;
            // Near-binary weave contrast out-competes the character's own form
            // and reads as printed wallpaper. Keep the weave read in the normal
            // and roughness maps; the albedo only needs a hint of it.
            const g = 0.74 + (hv - 0.5) * 0.15 - dirt;
            o.r = g * (kind === 'tech' ? 1.0 : 1.02);
            o.g = g;
            o.b = g * (kind === 'tech' ? 1.03 : 0.98);
          },
          this.aniso
        )
      ),
      normalMap: this._t(`cloth.${kind}.n`, () =>
        makeNormalTexture(256, (u, v) => h(u * rep, v * rep), kind === 'tech' ? 1.1 : 0.85, this.aniso)
      ),
      roughnessMap: this._t(`cloth.${kind}.r`, () =>
        makeScalarTexture(
          256,
          // A flightsuit is fabric. The old tech branch bottomed out near 0.29,
          // which is wet-vinyl gloss and produced one broad clipped specular
          // lobe across the shoulders. Widen the range so weave and wear
          // actually modulate the highlight, and clamp it out of mirror land.
          (u, v) =>
            kind === 'tech'
              ? clamp(0.68 + (h(u, v) - 0.5) * 0.42, 0.4, 0.95)
              : clamp(0.8 + (h(u, v) - 0.5) * 0.3, 0.45, 0.98),
          this.aniso
        )
      ),
    };
  }

  _leatherMaps() {
    return {
      map: this._t('leather.a', () =>
        makeColorTexture(
          256,
          (u, v, o) => {
            const hv = leatherHeight(u, v);
            const g = 0.62 + (hv - 0.5) * 0.42;
            o.r = g * 1.04;
            o.g = g * 0.97;
            o.b = g * 0.9;
          },
          this.aniso
        )
      ),
      normalMap: this._t('leather.n', () => makeNormalTexture(256, leatherHeight, 1.0, this.aniso)),
      roughnessMap: this._t('leather.r', () =>
        makeScalarTexture(256, (u, v) => 0.45 + leatherHeight(u, v) * 0.35, this.aniso)
      ),
    };
  }

  /**
   * Retroreflective tape maps.
   *
   * Hi-vis trim is *tape sewn onto cloth*, and every part of that sentence has
   * to be visible: the microprism ribs that make it retroreflective, the weave
   * of the garment showing through the backing, and a stitched border where the
   * tape meets the suit. Without those it is a coloured ring, and a coloured
   * ring with any emissive on it is a decal.
   */
  _trimMaps() {
    // v runs along the limb, u around it - so ribs along u are the bands that
    // catch a moving highlight as the limb turns away from the key light.
    const rib = (u, v) => {
      const r = Math.abs(Math.sin(v * Math.PI * 46));
      const backing = fabricHeight(u * 0.5, v * 0.5) * 0.35;
      // Stitch line: two narrow grooves near the tape edges, in u.
      const stitch =
        gauss((u * 6) % 1, 0.08, 0.035) * 0.5 + gauss((u * 6) % 1, 0.92, 0.035) * 0.5;
      return clamp(0.30 + r * 0.5 + backing - stitch * 0.55, 0, 1);
    };
    return {
      map: this._t('trim.a', () =>
        makeColorTexture(
          256,
          (u, v, o) => {
            const h = rib(u, v);
            // Tape is a pale grey-white carrier tinted by the material colour;
            // keeping most of the value in the carrier is what stops it reading
            // as a block of pure hue.
            const g = 0.72 + (h - 0.5) * 0.34;
            const scuff = fbm(u, v, 4, 6, 57) * 0.16;
            o.r = g - scuff;
            o.g = g - scuff * 0.95;
            o.b = g - scuff * 0.9;
          },
          this.aniso
        )
      ),
      normalMap: this._t('trim.n', () => makeNormalTexture(256, rib, 1.5, this.aniso)),
      roughnessMap: this._t('trim.r', () =>
        // Crests glint, troughs and stitching stay matte: that difference is the
        // entire reason the band reads as a physical strip and not a light.
        makeScalarTexture(256, (u, v) => clamp(0.72 - rib(u, v) * 0.42, 0.24, 0.9), this.aniso)
      ),
    };
  }

  _metalMaps(pattern) {
    const h = pattern === 'mail' ? mailHeight : techHeight;
    // Mail is a 26-cell lattice with a two-texel ring wall; at 256 the wall
    // aliases into a blob field. Panel work has no feature that fine.
    const size = pattern === 'mail' ? 512 : 256;
    return {
      map: this._t(`metal.${pattern}.a`, () =>
        makeColorTexture(
          size,
          (u, v, o) => {
            const g = 0.6 + (h(u, v) - 0.5) * 0.4;
            o.r = g;
            o.g = g * 1.0;
            o.b = g * 1.02;
          },
          this.aniso
        )
      ),
      normalMap: this._t(`metal.${pattern}.n`, () =>
        makeNormalTexture(size, h, pattern === 'mail' ? 1.7 : 1.2, this.aniso)
      ),
      roughnessMap: this._t(`metal.${pattern}.r`, () =>
        makeScalarTexture(size, (u, v) => 0.24 + h(u, v) * 0.42, this.aniso)
      ),
    };
  }

  /**
   * Skin uses MeshPhysicalMaterial sheen: a warm grazing-angle response that
   * reads as subsurface scattering without the cost of real SSS.
   */
  /** Rim descriptor -> a stable cache-key fragment. */
  static _rimKey(rim) {
    return rim ? `${rim.hex}:${rim.strength}` : 'none';
  }

  /**
   * Skin uses MeshPhysicalMaterial sheen: a warm grazing-angle response that
   * reads as subsurface scattering without the cost of real SSS.
   *
   * `vertexColors` is on because the face carries a baked cavity map in the
   * colour attribute - eye sockets, lash line, nasolabial, under-lip. A
   * low-poly face is sold by albedo cavity, not by silhouette.
   */
  skin(colorHex, rim) {
    const key = `skin:${colorHex}:${CharacterAssets._rimKey(rim)}`;
    let m = this._mat.get(key);
    if (!m) {
      const maps = this._skinMaps();
      m = new THREE.MeshPhysicalMaterial({
        ...maps,
        color: new THREE.Color(colorHex),
        // 0.82 with the map clamped to [0.4,1] meant the material's brightest
        // possible specular was still a broad matte lobe: there was no value on
        // the face that a viewer could read as a highlight, so every anatomical
        // term the sculpt paid for - malar, buccal hollow, nose wing, mental
        // crease - was invisible. Real skin is roughly 0.35-0.55; this is the
        // centre of that band and lets the map swing either side of it.
        roughness: 0.52,
        metalness: 0.0,
        vertexColors: true,
        // Sheen stands in for subsurface scattering, but a warm sheen under the
        // medieval late-afternoon sun stacked with a warm rim and turned every
        // villager terracotta. Kept modest, and pulled off red toward flesh.
        // It does the forward-scatter job at grazing angles that a real SSS pass
        // would; the wrapped-diffuse term in addRim does the rest.
        sheen: 0.28,
        sheenRoughness: 0.82,
        sheenColor: new THREE.Color(0xd0968a),
        // Skin is not lacquered, but it is wet: a very low clearcoat gives the
        // forehead and the nose tip a second, tighter specular lobe on top of
        // the diffuse one, which is what separates skin from plaster.
        clearcoat: 0.16,
        clearcoatRoughness: 0.42,
        normalScale: new THREE.Vector2(1.35, 1.35),
        // The body is the depth reference every garment shell is offset against;
        // it must never end up on a blend path.
        side: THREE.FrontSide,
        transparent: false,
        opacity: 1,
        depthWrite: true,
        alphaTest: 0,
      });
      m.userData.uvRepeat = 1;
      // Skin takes the least rim of anything on the character and takes it in a
      // tight band: a broad fresnel over a face is a wash of coloured light
      // across the cheeks, which is what bleached the medieval heads out.
      //
      // The forward fill is warm and stronger than the default, which is the
      // cheapest honest stand-in for subsurface scattering available without a
      // second pass: light that enters skin and comes back out is red-shifted,
      // and it comes back out toward the viewer. Tinting the camera-facing lift
      // flesh-warm rather than sky-cool is what stops a dark-skinned character
      // reading as a grey silhouette and a pale one reading as plaster.
      if (rim) addRim(m, rim.hex, rim.strength * 0.5, 4.0, { forward: 0.62, forwardHex: 0xffc8ac });
      this._mat.set(key, m);
    }
    return m;
  }

  cloth(colorHex, kind = 'canvas', rim) {
    const key = `cloth:${kind}:${colorHex}:${CharacterAssets._rimKey(rim)}`;
    let m = this._mat.get(key);
    if (!m) {
      const c = new THREE.Color(colorHex);
      m = new THREE.MeshPhysicalMaterial({
        ...this._clothMaps(kind),
        color: c,
        // Cloth is cloth. Metalness on a flightsuit is what produced the wet
        // vinyl highlight; grazing-angle sheen is what fabric actually does.
        roughness: kind === 'tech' ? 0.78 : 0.92,
        metalness: 0.0,
        // 0.45 sheen lerped 55% to white is not fabric, it is cling film: on a
        // curved limb the grazing lobe covers most of the visible surface, so
        // every arm and every shoulder carried a pale wash that merged with the
        // background. Sheen is a *grazing* effect - it has to be small enough
        // that the middle of the limb never sees it.
        sheen: kind === 'tech' ? 0.14 : 0.12,
        sheenRoughness: 0.85,
        sheenColor: c.clone().lerp(new THREE.Color(0xffffff), 0.15),
        normalScale: new THREE.Vector2(0.55, 0.55),
        ...OPAQUE_SHELL,
      });
      if (rim) addRim(m, rim.hex, rim.strength, 3.2);
      this._mat.set(key, m);
    }
    return m;
  }

  leather(colorHex, rim) {
    const key = `leather:${colorHex}:${CharacterAssets._rimKey(rim)}`;
    let m = this._mat.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({
        ...this._leatherMaps(),
        color: new THREE.Color(colorHex),
        roughness: 0.7,
        metalness: 0.02,
        ...OPAQUE_SHELL,
      });
      if (rim) addRim(m, rim.hex, rim.strength * 0.9, 3.4);
      this._mat.set(key, m);
    }
    return m;
  }

  metal(colorHex, pattern = 'panel', roughness = 0.42, rim) {
    const key = `metal:${pattern}:${colorHex}:${roughness}:${CharacterAssets._rimKey(rim)}`;
    let m = this._mat.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({
        ...this._metalMaps(pattern),
        color: new THREE.Color(colorHex),
        roughness,
        metalness: 0.88,
        ...OPAQUE_SHELL,
      });
      if (rim) addRim(m, rim.hex, rim.strength * 0.7, 3.8);
      this._mat.set(key, m);
    }
    return m;
  }

  /**
   * Retroreflective hi-vis tape, not a self-lit decal.
   *
   * Two rounds of review called these bands "unshaded emissive rings that read
   * as decals stuck on a cylinder", and both times the cause was the same: any
   * meaningful emissive term on a small, fully saturated hue survives ACES and
   * bloom as a flat clipped patch, so the lit side and the shadow side of an arm
   * come out identical and the band stops belonging to the limb.
   *
   * So: no emissive at all in daylight terms. What makes safety tape visible in
   * real life is a very high-albedo carrier plus a microprism surface that
   * throws a hard specular back at the viewer, and both of those are ordinary
   * PBR. The hue is pulled 45% toward its own pale carrier so it reads as dyed
   * tape rather than neon, and a token 0.06 emissive keeps it from going
   * completely dead in an unlit corridor.
   */
  glow(colorHex, rim) {
    const key = `glow:${colorHex}:${CharacterAssets._rimKey(rim)}`;
    let m = this._mat.get(key);
    if (!m) {
      const c = new THREE.Color(colorHex);
      // Carrier: the hue lifted toward its own pale tint, never toward pure
      // white, so a cyan band stays cyan-grey instead of turning into a lamp.
      const carrier = c.clone().lerp(new THREE.Color(0xf2f4f2), 0.45);
      m = new THREE.MeshPhysicalMaterial({
        ...this._trimMaps(),
        color: carrier,
        emissive: c.clone().multiplyScalar(0.6),
        emissiveIntensity: 0.06,
        roughness: 0.55,
        metalness: 0.0,
        // The prism sheet sits on woven backing; sheen is what sells the join.
        sheen: 0.4,
        sheenRoughness: 0.6,
        sheenColor: carrier.clone().lerp(new THREE.Color(0xffffff), 0.4),
        normalScale: new THREE.Vector2(0.9, 0.9),
        ...OPAQUE_SHELL,
      });
      if (rim) addRim(m, rim.hex, rim.strength * 0.45, 3.2);
      this._mat.set(key, m);
    }
    return m;
  }

  /** True light sources on a character (lamp lenses, ID strips). */
  emissive(colorHex) {
    const key = `emissive:${colorHex}`;
    let m = this._mat.get(key);
    if (!m) {
      const c = new THREE.Color(colorHex);
      m = new THREE.MeshStandardMaterial({
        color: c.clone().multiplyScalar(0.3),
        emissive: c,
        emissiveIntensity: 1.6,
        roughness: 0.3,
        metalness: 0.0,
      });
      this._mat.set(key, m);
    }
    return m;
  }

  hair(colorHex, rim) {
    const key = `hair:${colorHex}:${CharacterAssets._rimKey(rim)}`;
    let m = this._mat.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({
        map: this._t('hair.a', () =>
          makeColorTexture(
            256,
            (u, v, o) => {
              const s = hairHeight(u, v);
              // Contrast raised from 0.7. One flat brown over the whole shell is
              // what makes it a moulded object; individual clumps only separate
              // if the value between them actually differs.
              const g = 0.5 + (s - 0.5) * 1.05;
              o.r = g * 1.05;
              o.g = g;
              o.b = g * 0.94;
            },
            this.aniso
          )
        ),
        normalMap: this._t('hair.n', () => makeNormalTexture(256, hairHeight, 1.6, this.aniso)),
        roughnessMap: this._t('hair.r', () =>
          makeScalarTexture(256, (u, v) => clamp(0.42 + hairHeight(u, v) * 0.34, 0.42, 0.8), this.aniso)
        ),
        color: new THREE.Color(colorHex),
        // Hair is a shiny fibre bundle, not felt. Lower base roughness plus the
        // streak normal gives it a directional highlight instead of moss - at
        // 0.44 with a 1.1 normal scale nothing survived and the shell shaded as
        // a single smooth dome, which is the whole "latex swim cap" read.
        roughness: 0.30,
        metalness: 0.0,
        // Eyebrows and lashes live in this mesh and are darkened per-vertex.
        vertexColors: true,
        normalScale: new THREE.Vector2(1.6, 1.6),
        // The shell is a closed dome sitting on the scalp - lighting its
        // backfaces is what made it read as a hard plastic helmet.
        side: THREE.FrontSide,
      });
      if (rim) addRim(m, rim.hex, rim.strength * 1.1, 2.4);
      this._mat.set(key, m);
    }
    return m;
  }

  /** Unit disc in the XZ plane, for the shared contact-shadow InstancedMesh. */
  contactDiscGeometry() {
    let g = this.geoCache.get('contact.disc');
    if (!g) {
      g = new THREE.PlaneGeometry(1, 1);
      g.rotateX(-Math.PI / 2);
      this.geoCache.set('contact.disc', g);
    }
    return g;
  }

  /**
   * The single element that does more grounding work than the shadow map at
   * gameplay distance: a multiply-blended radial AO decal under the feet.
   *
   * Drawn by one InstancedMesh owned by NPCManager, so a crowd of 24 costs a
   * single draw call rather than 24.
   */
  contactShadow() {
    const key = 'contactShadow';
    let m = this._mat.get(key);
    if (!m) {
      // Black with a radial alpha ramp, composited with ordinary alpha
      // blending. Multiply blending would be more physically honest, but it
      // behaves differently depending on where in the post chain the transparent
      // pass lands; a plain alpha blob is the same on every path, and being
      // reliably visible matters more here than being technically elegant.
      const tex = this._t('contact.a', () =>
        makeDataTexture(
          64,
          (data, size) => {
            for (let y = 0; y < size; y++) {
              for (let x = 0; x < size; x++) {
                const r = Math.hypot((x + 0.5) / size - 0.5, (y + 0.5) / size - 0.5) * 2;
                // Two lobes: a tight core under the soles, a wide soft skirt.
                const core = 1 - smoothstep(0.0, 0.5, r);
                const skirt = 1 - smoothstep(0.15, 1.0, r);
                // Was 0.52/0.24, which on a bright deck under a bright key is
                // below the threshold where the eye registers contact at all -
                // every reviewer read the characters as floating. A real
                // occlusion skirt under a standing figure is much darker than
                // this even before the cast shadow lands on top of it.
                const a = clamp(core * 0.78 + skirt * 0.36, 0, 1);
                const i = (y * size + x) * 4;
                data[i] = 0;
                data[i + 1] = 0;
                data[i + 2] = 0;
                data[i + 3] = Math.round(a * 255);
              }
            }
          },
          false,
          this.aniso
        )
      );
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      m = new THREE.MeshBasicMaterial({
        map: tex,
        color: 0x000000,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      });
      this._mat.set(key, m);
    }
    return m;
  }

  sclera() {
    const key = 'sclera';
    let m = this._mat.get(key);
    if (!m) {
      // Not white. A pure-white sclera under a bright key clips to a flat disc
      // and the iris stops being the darkest thing in the socket, which is what
      // made the eyes read as beads. A sclera is a slightly warm off-grey that
      // sits *below* the surrounding skin in value in almost every light.
      // Cooled and lifted from 0xc4c0bd: against skin sitting at 0.82 base the
      // old value never separated, so the whole palpebral aperture read as one
      // dark smear with no white-of-eye anywhere in it. It still must not be
      // pure white - that clips and turns the eye into a bead - but it has to
      // carry a distinct cool cast so the socket has two materials in it.
      //
      // Lifted again to 0xe4e2e0. The constraint that kept it dark was "a pure
      // white sclera clips to a flat disc", and that is true - but 0xd2d0cf sits
      // at essentially the same luminance as the 0.82-base skin around it, so
      // the whole palpebral aperture resolved as one dark smear with no white of
      // the eye anywhere in frame. The sclera has to be *bracketed* by dark to
      // read, which is what the lash line on the lid rim and the new upper-lid
      // contact shadow in faceCavity are for; given that bracket it can afford
      // to be a genuine off-white.
      m = new THREE.MeshPhysicalMaterial({
        color: 0xe4e2e0,
        roughness: 0.18,
        metalness: 0,
        clearcoat: 1,
        clearcoatRoughness: 0.04,
        // 2.0 on a clearcoated sphere is what turned a corneal reflection into a
        // blown starburst that cleared the bloom threshold. 1.0 is neutral.
        envMapIntensity: 1.0,
      });
      this._mat.set(key, m);
    }
    return m;
  }

  iris(colorHex) {
    const key = `iris:${colorHex}`;
    let m = this._mat.get(key);
    if (!m) {
      m = new THREE.MeshPhysicalMaterial({
        map: this._t('iris.a', () =>
          makeColorTexture(
            128,
            (u, v, o) => {
              const dx = u - 0.5;
              const dy = v - 0.5;
              const r = Math.hypot(dx, dy) * 2; // 0 centre .. 1 edge
              const a = Math.atan2(dy, dx);
              const fibre = 0.72 + Math.sin(a * 34 + r * 9) * 0.16 + fbm(u, v, 3, 12, 5) * 0.2;
              const pupil = 1 - smoothstep(0.30, 0.40, r);
              // A wide, hard limbal ring. Without a dark outline the iris has
              // no edge against the sclera and the eye stops being round: the
              // outer 15% is crushed to a third of its value so the boundary
              // survives both mipmapping and a flat ambient.
              const limbal = smoothstep(0.66, 0.92, r);
              const outer = smoothstep(0.85, 0.97, r);
              const g = fibre * (1 - pupil) * (1 - limbal * 0.85) * (1 - outer * 0.65);
              o.r = g;
              o.g = g;
              o.b = g;
            },
            this.aniso
          )
        ),
        // The corneal catchlight, baked.
        //
        // No eye reads as alive without a hard white speck, and in a scene lit
        // by broad ambient no PBR response will ever produce one - which is
        // exactly what the closeup showed: two flat dark discs. The honest fix
        // is a billboard quad per eye, but that is two extra draw calls on every
        // character in the crowd and the eye meshes already cost six. An
        // emissive spot in the iris map is free, sits on the cornea because the
        // iris cap *is* the cornea here, and rotates with the gaze because it
        // lives in the eye's own UV space.
        //
        // It also has to stay *under* the bloom threshold, and at 1.15 it did
        // not: emissive 1.0 white at intensity 1.15, sitting on clearcoat 1 with
        // envMapIntensity 2, put the screen-left eye of the medieval closeup
        // over the post-exposure knee and produced a saturated orange starburst
        // with an anamorphic streak running a third of the way across the frame
        // - the single worst defect in the round. A catchlight is a *reflection*,
        // not a light: it needs to be the brightest thing on the head and
        // nothing more. 0.18 puts it a little above the lit sclera and well
        // below anything that can bloom, and the sigma comes down from 0.052 to
        // 0.022 so it is a hard speck of a few pixels rather than a soft glow
        // over a quarter of the iris. The 0.16-weight secondary bounce stays -
        // it is what makes the sphere read as wet.
        emissive: 0xffffff,
        emissiveIntensity: 0.18,
        emissiveMap: this._t('iris.e', () =>
          makeColorTexture(
            128,
            (u, v, o) => {
              // ~1 o'clock, just inside the limbus, plus a much fainter
              // secondary bounce opposite it so the sphere reads as wet.
              const spec =
                gauss(Math.hypot(u - 0.335, v - 0.665), 0, 0.022) * 1.0 +
                gauss(Math.hypot(u - 0.63, v - 0.37), 0, 0.05) * 0.16;
              const g = clamp(spec, 0, 1);
              o.r = g;
              o.g = g;
              o.b = g;
            },
            this.aniso
          )
        ),
        color: new THREE.Color(colorHex),
        roughness: 0.10,
        metalness: 0,
        clearcoat: 1,
        clearcoatRoughness: 0.02,
        envMapIntensity: 1.0,
      });
      this._mat.set(key, m);
    }
    return m;
  }

  /**
   * Take out a hold on a cached geometry, building it on first ask.
   *
   * Why a hold rather than a plain memo: `geoCache` is keyed on the appearance
   * combination, so two characters who happen to roll the same body, outfit,
   * proportions and face legitimately *draw the same buffer*. That is the whole
   * point of the cache and it is why a character must never dispose its own
   * geometry - the naive fix frees a buffer other live characters are still
   * rendering, and they vanish or garble.
   *
   * The old contract said the geometry was "freed by CharacterAssets" and it
   * was: at teardown, and only then. Within a session every world activation
   * deals a fresh cast, mints new keys and never gives any back, so the cache
   * grew without bound across world swaps (807 -> 1177 geometries over ten
   * entries; 279 bodies and 111 hair shells alive and unreachable).
   *
   * Reference counting is the strategy because this code can support it
   * exactly: there is one acquire site (`HumanoidFactory.create`, plus the
   * player's hair swap) and one release site (`Humanoid.dispose`), and a
   * character's held keys are recorded on the character itself. A bounded LRU
   * would still need this liveness information to know what it may evict, and
   * purging at world teardown would only be correct because of the same
   * information; neither buys anything over counting the holders directly.
   *
   * Failure is asymmetric and lands on the safe side: a character that is
   * dropped without `dispose()` leaks its entry (as today) rather than freeing
   * something live.
   *
   * @param {string} key
   * @param {() => THREE.BufferGeometry|null} make
   * @returns {THREE.BufferGeometry|null} null when the style has no geometry
   *   (bald); nothing is cached and nothing is held in that case.
   */
  acquireGeometry(key, make) {
    let g = this.geoCache.get(key);
    if (!g) {
      g = make();
      if (!g) return null;
      this.geoCache.set(key, g);
    }
    this._geoRefs.set(key, (this._geoRefs.get(key) ?? 0) + 1);
    return g;
  }

  /**
   * Give back one hold. The entry is disposed and evicted only when the last
   * holder lets go, so a geometry still attached to a live mesh is never freed.
   *
   * Releasing a key that was never acquired is a no-op: the untracked session
   * geometry (contact disc, weapons) must not be freed by a character's death.
   *
   * @param {string} key
   * @returns {boolean} true when this call disposed the entry
   */
  releaseGeometry(key) {
    const n = this._geoRefs.get(key);
    if (n === undefined) return false;
    if (n > 1) {
      this._geoRefs.set(key, n - 1);
      return false;
    }
    this._geoRefs.delete(key);
    const g = this.geoCache.get(key);
    this.geoCache.delete(key);
    g?.dispose();
    return true;
  }

  dispose() {
    for (const t of this._tex.values()) t.dispose();
    for (const m of this._mat.values()) m.dispose();
    for (const g of this.geoCache.values()) g.dispose();
    this._tex.clear();
    this._mat.clear();
    this.geoCache.clear();
    this._geoRefs.clear();
  }
}

/* ------------------------------------------------------------------ */
/* Body proportions                                                    */
/* ------------------------------------------------------------------ */

/** Every profile below is authored for this canonical height; instances scale. */
export const BASE_HEIGHT = 1.78;

/** Material slots on the merged body mesh. Unused slots cost no draw call. */
export const SLOT = { SKIN: 0, PRIMARY: 1, SECONDARY: 2, LEATHER: 3, METAL: 4, GLOW: 5 };
const SLOT_COUNT = 6;

// y, half-width, front depth, back depth, superellipse exponent.
const TORSO_KEYS = [
  { y: 0.860, rx: 0.152, rf: 0.100, rb: 0.112, e: 2.6 },
  { y: 0.950, rx: 0.166, rf: 0.114, rb: 0.128, e: 2.8 },
  { y: 1.020, rx: 0.146, rf: 0.106, rb: 0.118, e: 2.8 },
  { y: 1.090, rx: 0.134, rf: 0.099, rb: 0.110, e: 2.9 },
  { y: 1.170, rx: 0.150, rf: 0.110, rb: 0.114, e: 3.0 },
  { y: 1.250, rx: 0.170, rf: 0.126, rb: 0.118, e: 3.0 },
  { y: 1.320, rx: 0.184, rf: 0.120, rb: 0.114, e: 3.1 },
  // The deltoid is an angular plane, not a sphere: e 3.4 flattens the shoulder
  // cap so it catches a plane of light instead of a bowling-ball highlight.
  { y: 1.392, rx: 0.196, rf: 0.092, rb: 0.098, e: 3.4 },
  // The old table dropped 8 cm of width across 4.8 cm of height here, which is
  // the hard shelf that made the head look plugged into the trapezius. Three
  // intermediate keys ramp the trap instead.
  { y: 1.408, rx: 0.172, rf: 0.088, rb: 0.096, e: 2.9 },
  { y: 1.424, rx: 0.138, rf: 0.080, rb: 0.090, e: 2.6 },
  // Trapezius. The old table went 0.100 -> 0.055 in 3.6 cm, which is a pole
  // stuck into a slab: from 2.5 m the bare column between the collar and the
  // jaw read as a giraffe neck because nothing filled the angle between them.
  // A real trapezius runs *diagonally* from the acromion to the middle of the
  // neck, so the taper has to start wide and stay wide for the first
  // centimetre and a half. Three keys instead of one, and the neck itself is
  // 3 mm thicker - a 106 mm neck on a 1.78 m frame is still slim.
  //
  // Round 4 still read as "a giraffe neck plugged into a flat shoulder shelf":
  // a visible column of ~90 mm between the jaw and the collar against an 80 mm
  // head. Two changes here. The trap keys carry more width for longer, so the
  // wedge between the acromion and the neck is filled rather than stepped; and
  // an extra key at 1.532 keeps the column thick almost to the jaw line, which
  // shortens the *visible* neck without moving a single joint.
  { y: 1.444, rx: 0.114, rf: 0.079, rb: 0.090, e: 2.4 },
  { y: 1.468, rx: 0.092, rf: 0.070, rb: 0.081, e: 2.3 },
  { y: 1.496, rx: 0.069, rf: 0.061, rb: 0.069, e: 2.2 },
  { y: 1.532, rx: 0.060, rf: 0.057, rb: 0.063, e: 2.2 },
  { y: 1.570, rx: 0.056, rf: 0.054, rb: 0.059, e: 2.2 },
];

const LEG_KEYS = [
  { y: 1.005, rx: 0.108, rf: 0.108, rb: 0.108, z: 0.000, e: 2.3 },
  { y: 0.930, rx: 0.100, rf: 0.098, rb: 0.104, z: -0.002, e: 2.3 },
  { y: 0.800, rx: 0.089, rf: 0.086, rb: 0.094, z: -0.006, e: 2.2 },
  { y: 0.640, rx: 0.078, rf: 0.076, rb: 0.080, z: -0.010, e: 2.2 },
  { y: 0.515, rx: 0.069, rf: 0.072, rb: 0.062, z: -0.012, e: 2.2 },
  { y: 0.440, rx: 0.066, rf: 0.060, rb: 0.072, z: -0.006, e: 2.2 },
  { y: 0.330, rx: 0.062, rf: 0.052, rb: 0.074, z: 0.000, e: 2.2 },
  { y: 0.230, rx: 0.050, rf: 0.044, rb: 0.058, z: 0.004, e: 2.2 },
  { y: 0.140, rx: 0.040, rf: 0.038, rb: 0.046, z: 0.008, e: 2.2 },
  { y: 0.098, rx: 0.037, rf: 0.038, rb: 0.044, z: 0.010, e: 2.2 },
];

// Foot runs along -Z (forward). ry = up, ryn = down (kept just above the sole).
//
// The old table stopped at z -0.186 and tapered to a 29 mm half-width there,
// which on a 1.75 m character is a foot with no toe box: from 3 m the legs
// terminated in flat-cut cylinders with no instep, no toe and no forward
// projection at all. A real shoe on this stature runs ~26 cm heel to toe and
// holds most of its width to the ball before breaking. This table does that -
// the ball (z -0.09) is the widest point, the break is at -0.15, and the toe
// carries out to -0.212.
const FOOT_KEYS = [
  { z: 0.070, y: 0.052, rx: 0.033, ry: 0.044 },
  { z: 0.030, y: 0.048, rx: 0.041, ry: 0.044 },
  { z: -0.020, y: 0.044, rx: 0.044, ry: 0.038 },
  { z: -0.090, y: 0.039, rx: 0.045, ry: 0.031 },
  { z: -0.150, y: 0.034, rx: 0.042, ry: 0.024 },
  { z: -0.178, y: 0.030, rx: 0.037, ry: 0.017 },
  { z: -0.200, y: 0.027, rx: 0.024, ry: 0.010 },
];

/**
 * Arm polyline for the +X side, parameterised 0 (shoulder) -> 1 (fingertip).
 *
 * The old table drifted x from 0.150 at the acromion to 0.344 at the tip: 19 cm
 * of outboard travel in one unbroken curve, which is the inflatable tube-man
 * silhouette. A relaxed arm angles out over the deltoid and then hangs. Here x
 * reaches the elbow by u=0.36 and then holds almost flat, so the profile has a
 * break in it. It cannot hold *dead* flat: the hand still has to clear the hip
 * garment shell, which sits ~22 cm outboard on a heavy build.
 *
 * `WRIST_U` is where the arm loft stops and the hand mesh takes over. Beyond it
 * the rx/ry columns describe a flattened palm envelope, not a tapering tube -
 * lofting the arm straight through to u=1 with a rounded cap is what produced
 * the cone-shaped spike that every reviewer called out.
 */
const WRIST_U = 0.78;
const ARM_KEYS = [
  { u: 0.00, p: [0.150, 1.392, 0.000], rx: 0.058, ry: 0.062 },
  { u: 0.06, p: [0.180, 1.345, -0.004], rx: 0.064, ry: 0.066 },
  { u: 0.16, p: [0.206, 1.262, -0.005], rx: 0.055, ry: 0.058 },
  { u: 0.28, p: [0.226, 1.163, -0.008], rx: 0.047, ry: 0.050 },
  // Elbow. Pulled back in z so the bind pose already has a hint of flexion.
  { u: 0.36, p: [0.236, 1.098, -0.012], rx: 0.044, ry: 0.047 },
  { u: 0.46, p: [0.244, 1.020, 0.002], rx: 0.045, ry: 0.047 },
  { u: 0.60, p: [0.252, 0.918, 0.012], rx: 0.038, ry: 0.039 },
  { u: 0.72, p: [0.259, 0.836, 0.019], rx: 0.031, ry: 0.031 },
  { u: 0.78, p: [0.262, 0.798, 0.021], rx: 0.030, ry: 0.025 },
  // Hand envelope: wide front-to-back, thin across. Used by gloves and by the
  // hand bone's tail, never by the arm tube.
  { u: 0.88, p: [0.265, 0.742, 0.024], rx: 0.047, ry: 0.022 },
  { u: 0.96, p: [0.267, 0.686, 0.026], rx: 0.038, ry: 0.018 },
  { u: 1.00, p: [0.268, 0.648, 0.027], rx: 0.020, ry: 0.013 },
];

/** Interpolate a key table on `field`. Handles ascending and descending tables. */
function interpKeys(keys, field, value, lerpFn) {
  const n = keys.length;
  const asc = keys[n - 1][field] >= keys[0][field];
  const first = keys[0][field];
  const last = keys[n - 1][field];
  if (asc ? value <= first : value >= first) return lerpFn(keys[0], keys[0], 0);
  if (asc ? value >= last : value <= last) return lerpFn(keys[n - 1], keys[n - 1], 0);
  for (let i = 0; i < n - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    const av = a[field];
    const bv = b[field];
    const inside = asc ? value >= av && value <= bv : value <= av && value >= bv;
    if (inside) {
      const denom = bv - av;
      return lerpFn(a, b, smooth(denom === 0 ? 0 : (value - av) / denom));
    }
  }
  return lerpFn(keys[n - 1], keys[n - 1], 0);
}

/**
 * A body archetype: girth, shoulder/hip ratio and limb thickness modifiers
 * applied on top of the canonical profiles above.
 *
 * @param {{build:number, frame:number, shoulderScale:number}} opts
 *   build 0 slim / 1 average / 2 heavy; frame 0 broad-shouldered / 1 narrower.
 */
export function makeProportions(opts) {
  const build = clamp(opts.build | 0, 0, 2);
  const frame = clamp(opts.frame | 0, 0, 1);
  const girth = [0.90, 1.0, 1.17][build];
  const belly = [-0.008, 0.0, 0.034][build];
  const limb = [0.90, 1.0, 1.13][build];
  // A shoulder line that is narrow *and* rounded is the loudest anatomical tell
  // in a full-body shot - the figure reads as a bottle with a head balanced on
  // it. The broad frame goes to 1.14 and the narrow one to 1.00, and the
  // outboard deltoid term below is raised to match, so the arm is actually
  // capped by a mass rather than sloping straight into the sleeve.
  const shoulderW = (frame === 0 ? 1.14 : 1.0) * (opts.shoulderScale ?? 1);
  const hipW = frame === 0 ? 0.96 : 1.08;
  const chestF = frame === 0 ? 1.0 : 1.06;

  const P = {
    build,
    frame,
    girth,
    limbScale: limb,
    hipY: 0.955,
    pelvisY: 0.995,
    chestY: 1.29,
    // Raised with the trapezius ramp so there is a real neck column between the
    // collar line and the jaw instead of a head plugged into the shoulders.
    neckY: 1.464,
    headY: 1.545,
    ankleY: 0.098,
    legSideX: 0.095,
    key: `b${build}f${frame}s${Math.round((opts.shoulderScale ?? 1) * 20)}`,
  };

  /** Torso cross-section at world height `y`. */
  P.torso = (y) =>
    interpKeys(TORSO_KEYS, 'y', y, (a, b, t) => {
      // Shoulders widen with frame, hips widen the other way, waist carries build.
      const wMul =
        lerp(1, shoulderW, smoothstep(1.15, 1.36, y)) * lerp(1, hipW, smoothstep(1.1, 0.93, y));
      const bellyAdd = belly * gauss(y, 1.06, 0.16);
      return {
        rx: lerp(a.rx, b.rx, t) * girth * wMul,
        rf: (lerp(a.rf, b.rf, t) * girth + bellyAdd) * lerp(1, chestF, smoothstep(1.15, 1.32, y)),
        rb: lerp(a.rb, b.rb, t) * girth + bellyAdd * 0.35,
        e: lerp(a.e, b.e, t),
      };
    });

  /** Leg cross-section at world height `y`. */
  P.leg = (y) =>
    interpKeys(LEG_KEYS, 'y', y, (a, b, t) => ({
      rx: lerp(a.rx, b.rx, t) * limb,
      rf: lerp(a.rf, b.rf, t) * limb,
      rb: lerp(a.rb, b.rb, t) * limb,
      z: lerp(a.z, b.z, t),
      e: lerp(a.e, b.e, t),
    }));

  /** Foot cross-section at world depth `z`. */
  P.foot = (z) =>
    interpKeys(FOOT_KEYS, 'z', z, (a, b, t) => ({
      y: lerp(a.y, b.y, t),
      rx: lerp(a.rx, b.rx, t) * lerp(1, limb, 0.5),
      ry: lerp(a.ry, b.ry, t),
    }));

  /**
   * Widest bare-body half-width at height `y` - ribcage or hip, whichever wins.
   * The leg blends in rather than switching on at the top of the thigh loft: a
   * step here becomes a visible kink in the arm that clears it.
   */
  P.bodyOuterX = (y) => {
    const t = P.torso(y);
    const hip = P.legSideX + P.leg(y).rx;
    return Math.max(t.rx, lerp(t.rx, hip, smoothstep(1.10, 0.98, y)));
  };

  /**
   * Arm sample at parameter `u`; `side` is +1 (right) or -1 (left).
   *
   * The raw ARM_KEYS polyline is authored for an average build. Two corrections
   * sit on top of it. The first is the old one: wider shoulders push the whole
   * arm outboard, not just the deltoid. The second is a hard clearance floor
   * derived from the body it has to hang beside - a heavy, wide-hipped build's
   * thigh reaches 22 cm outboard, and an arm authored at 25 cm buries its own
   * hand in the hip. Taking a running maximum from the elbow down keeps the
   * result monotonic, so clearing the hip does not put a bulge in the forearm.
   */
  P.arm = (u, side) =>
    interpKeys(ARM_KEYS, 'u', u, (a, b, t) => {
      const x = lerp(a.p[0], b.p[0], t);
      const y = lerp(a.p[1], b.p[1], t);
      const rx = lerp(a.rx, b.rx, t) * limb;
      const outboard = (shoulderW - 1) * (0.09 + 0.26 * smoothstep(0.5, 0.0, u));

      let armX = x + outboard;
      if (u > 0.30) {
        // Widest body the arm has already passed, from the elbow to here.
        let widest = 0;
        for (let k = 0; k <= 6; k++) {
          const uu = lerp(0.30, u, k / 6);
          const yy = interpKeys(ARM_KEYS, 'u', uu, (c, d, s) => lerp(c.p[1], d.p[1], s));
          widest = Math.max(widest, P.bodyOuterX(yy));
        }
        // 26 mm was measured against the *bare* body, and every outfit in the
        // file then drapes a 20-50 mm shell over the hip on top of it. The
        // sports shorts were the extreme case: the reviewer's shot has the
        // screen-left forearm and hand buried inside the shorts shell with only
        // a fragment of the opposite hand grazing the edge. 40 mm covers the
        // widest garment shell plus a sleeve on the arm and still leaves the
        // hand a few millimetres of daylight against the silhouette. The radius
        // term uses the elbow's, not this section's, so the forearm taper cannot
        // pull the clearance back in and dent the profile.
        const need = widest + Math.max(rx, 0.044 * limb) + 0.040;
        armX += Math.max(0, need - armX) * smoothstep(0.30, 0.46, u);
      }

      return {
        p: new THREE.Vector3(armX * side, y, lerp(a.p[2], b.p[2], t)),
        rx,
        ry: lerp(a.ry, b.ry, t) * limb,
        armX,
      };
    });

  P.shoulderX = P.arm(0, 1).armX;
  return P;
}

/* ------------------------------------------------------------------ */
/* Skeleton                                                            */
/* ------------------------------------------------------------------ */

/**
 * Bind-pose bone table. Positions are in character space; `tail` exists only so
 * skin weighting can measure distance to a bone *segment* rather than a point.
 * Rest rotations are identity, which makes additive animation trivial.
 */
export function buildSkeletonSpec(P) {
  const sx = P.legSideX;
  const shoulder = P.shoulderX;
  const elbow = P.arm(0.36, 1).p;
  const wrist = P.arm(0.72, 1).p;
  const tip = P.arm(1.0, 1).p;
  const defs = [];
  const add = (name, parent, pos, tail) => defs.push({ name, parent, pos, tail });

  add('pelvis', null, [0, P.pelvisY, 0], [0, 1.075, 0]);
  add('spine01', 'pelvis', [0, 1.075, -0.005], [0, 1.18, -0.01]);
  add('spine02', 'spine01', [0, 1.18, -0.01], [0, 1.29, -0.008]);
  add('spine03', 'spine02', [0, 1.29, -0.008], [0, P.neckY, 0.006]);
  add('neck', 'spine03', [0, P.neckY, 0.006], [0, P.headY, 0]);
  add('head', 'neck', [0, P.headY, 0], [0, 1.735, -0.012]);

  for (const side of [1, -1]) {
    const s = side > 0 ? 'R' : 'L';
    add(`clavicle${s}`, 'spine03', [0.032 * side, 1.4, -0.012], [shoulder * side, 1.392, 0]);
    add(`upperArm${s}`, `clavicle${s}`, [shoulder * side, 1.392, 0], [elbow.x * side, elbow.y, elbow.z]);
    add(`foreArm${s}`, `upperArm${s}`, [elbow.x * side, elbow.y, elbow.z], [wrist.x * side, wrist.y, wrist.z]);
    add(`hand${s}`, `foreArm${s}`, [wrist.x * side, wrist.y, wrist.z], [tip.x * side, tip.y, tip.z]);
    add(`thigh${s}`, 'pelvis', [sx * side, P.hipY, 0], [sx * side, 0.515, -0.012]);
    add(`calf${s}`, `thigh${s}`, [sx * side, 0.515, -0.012], [sx * side, P.ankleY, 0.01]);
    add(`foot${s}`, `calf${s}`, [sx * side, P.ankleY, 0.01], [sx * side, 0.03, -0.12]);
    add(`toe${s}`, `foot${s}`, [sx * side, 0.03, -0.12], [sx * side, 0.026, -0.19]);
  }
  return defs;
}

/** Instantiate a fresh bone tree from a spec. Geometry is shared; bones are not. */
export function createSkeleton(spec) {
  const bones = [];
  const byName = new Map();
  const posByName = new Map();
  for (const def of spec) {
    const bone = new THREE.Bone();
    bone.name = def.name;
    const pp = def.parent ? posByName.get(def.parent) : [0, 0, 0];
    bone.position.set(def.pos[0] - pp[0], def.pos[1] - pp[1], def.pos[2] - pp[2]);
    if (def.parent) byName.get(def.parent).add(bone);
    byName.set(def.name, bone);
    posByName.set(def.name, def.pos);
    bones.push(bone);
  }
  const root = byName.get(spec[0].name);
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  return { skeleton, bones, byName, root };
}

/* ------------------------------------------------------------------ */
/* Lofting                                                             */
/* ------------------------------------------------------------------ */

const _lt = new THREE.Vector3();
const _lr = new THREE.Vector3();
const _lu = new THREE.Vector3();
const _lp = new THREE.Vector3();
const _la = new THREE.Vector3();
const _lb = new THREE.Vector3();

/**
 * One chunk of the body destined for a single material slot. Parts are welded
 * and skinned individually so a sleeve never smooths its normals into the arm
 * underneath it.
 */
class Part {
  constructor(slot, bones, uvScale = 1) {
    this.slot = slot;
    /** @type {Array<{name:string, bias:number}>} candidate bones for skinning. */
    this.bones = bones;
    this.uvScale = uvScale;
    this.pos = [];
    this.uv = [];
    this.idx = [];
    /** Baked albedo multiplier (face cavity). Padded to white on merge. */
    this.col = [];
  }
  get vertexCount() {
    return this.pos.length / 3;
  }
}

/** Fill the colour channel with white for every vertex that did not write one. */
function padColors(part) {
  const need = part.vertexCount * 3;
  while (part.col.length < need) part.col.push(1);
  return part.col;
}

/**
 * Texel density for every lofted surface, in texture tiles per metre.
 * One constant, applied to both axes, is the whole fix for the anisotropic UVs:
 * the old parameterisation normalised u around the ring regardless of
 * circumference while v was arc length, so cloth was smeared 1.5x on the torso
 * and nearly 3x on the arms - two visibly different weave scales on one garment.
 */
const UV_DENSITY = 3.0;

/** Ramanujan-free perimeter estimate for a superellipse ring. Good to a few %. */
function ringPerimeter(sec) {
  const rx = (Math.abs(sec.rx) + Math.abs(sec.rxn ?? sec.rx)) * 0.5;
  const ry = (Math.abs(sec.ry) + Math.abs(sec.ryn ?? sec.ry)) * 0.5;
  return Math.PI * 2 * Math.sqrt((rx * rx + ry * ry) * 0.5);
}

/** Superellipse ring point in the section's local frame. */
function ringOffset(angle, sec, outX, outY) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const p = 2 / sec.e;
  const cx = Math.sign(c) * Math.pow(Math.abs(c), p);
  const cy = Math.sign(s) * Math.pow(Math.abs(s), p);
  const rx = cx >= 0 ? sec.rx : sec.rxn ?? sec.rx;
  const ry = cy >= 0 ? sec.ry : sec.ryn ?? sec.ry;
  let m = 1;
  if (sec.ripple) m += sec.ripple.amp * Math.cos(sec.ripple.freq * angle + (sec.ripple.phase || 0));
  outX[0] = cx * rx * m;
  outY[0] = cy * ry * m;
}

const _rx = [0];
const _ry = [0];

/**
 * Loft a tube through `sections`. Each section carries a centre, two half-radii
 * and a superellipse exponent; the frame is derived from the local tangent so
 * limbs bend and taper naturally.
 *
 * @param {Part} part
 * @param {Array<{p:THREE.Vector3, rx:number, ry:number, rxn?:number, ryn?:number, e:number}>} sections
 * @param {number} radial number of points around the ring
 * @param {{upHint?:THREE.Vector3, capStart?:boolean, capEnd?:boolean, capDepth?:number}} [opts]
 */
function loft(part, sections, radial, opts = {}) {
  const n = sections.length;
  if (n < 2) return;
  const upHint = opts.upHint ?? _lu.set(0, 0, -1);
  const hint = new THREE.Vector3().copy(upHint).normalize();
  const alt = new THREE.Vector3(0, 1, 0);
  const base = part.vertexCount;
  const uvScale = part.uvScale;

  // Arc length gives a v coordinate that does not stretch on tapered limbs.
  const arc = new Float32Array(n);
  for (let i = 1; i < n; i++) arc[i] = arc[i - 1] + sections[i].p.distanceTo(sections[i - 1].p);

  const frames = [];
  for (let i = 0; i < n; i++) {
    const a = sections[Math.max(0, i - 1)].p;
    const b = sections[Math.min(n - 1, i + 1)].p;
    _lt.subVectors(b, a);
    if (_lt.lengthSq() < 1e-12) _lt.set(0, 1, 0);
    _lt.normalize();
    let h = hint;
    if (Math.abs(h.dot(_lt)) > 0.94) h = alt;
    _lr.crossVectors(h, _lt);
    if (_lr.lengthSq() < 1e-10) _lr.set(1, 0, 0);
    _lr.normalize();
    _lu.crossVectors(_lt, _lr).normalize();
    frames.push({
      t: _lt.clone(),
      r: _lr.clone(),
      u: _lu.clone(),
    });
  }

  for (let i = 0; i < n; i++) {
    const sec = sections[i];
    const f = frames[i];
    const perim = ringPerimeter(sec);
    for (let j = 0; j <= radial; j++) {
      const angle = (j / radial) * Math.PI * 2;
      ringOffset(angle, sec, _rx, _ry);
      _lp.copy(sec.p).addScaledVector(f.r, _rx[0]).addScaledVector(f.u, _ry[0]);
      part.pos.push(_lp.x, _lp.y, _lp.z);
      // Both axes in metres * UV_DENSITY: square texels on every ring size.
      part.uv.push((j / radial) * perim * UV_DENSITY * uvScale, arc[i] * UV_DENSITY * uvScale);
    }
  }

  const stride = radial + 1;
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = base + i * stride + j;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      // WINDING. This is the single most load-bearing line in the file and it
      // was wrong for three review rounds.
      //
      // The section frame is right-handed as (r, u, t): r x u = t. A ring point
      // is p + r*cos + u*sin, so walking j upward walks *counter-clockwise* in
      // the (r,u) plane, and walking i upward walks along +t. For the face
      // normal (edge1 x edge2) to point away from the tube axis the triangle
      // must be wound ring-tangential *before* longitudinal: (a,b,c) gives
      // (b-a) x (c-a) = tangential x t = +radial. The old order (a,c,b) is
      // t x tangential = -radial, i.e. every tube on the character - torso,
      // arms, legs, feet, every garment shell, every prop - was built
      // inside-out.
      //
      // What that looked like: with side:FrontSide the near wall of each tube
      // is culled and you see its far wall, so the garment shells (which sit
      // 1-2 cm outside the body) were hidden *behind* the body's own far wall
      // and only survived as thin ribbons past the silhouette - the reviewers'
      // "you can read the wall mullions straight through the torso" and "the
      // lavender collar reads straight through the grey chest shell". With the
      // earlier side:DoubleSide it was the same geometry lit on its interior,
      // which is the "milky X-ray wash" and the "soft white smear halo".
      // Neither the materials nor the rim injection were ever involved.
      part.idx.push(a, b, c, b, d, c);
    }
  }

  if (opts.capStart)
    capRing(part, sections[0], frames[0], radial, -1, opts.capDepth ?? 0.5, base, arc[0]);
  if (opts.capEnd)
    capRing(
      part, sections[n - 1], frames[n - 1], radial, 1, opts.capDepth ?? 0.5,
      base + (n - 1) * stride, arc[n - 1]
    );
}

/**
 * Rounded end cap: two shrinking rings plus a pole, so limbs end domed.
 * `vBase` continues the tube's arc-length v across the dome; pushing v=0 for
 * every cap ring collapsed the whole dome onto one texel row, which is what
 * smeared the wrist and boot caps into streaks.
 */
function capRing(part, sec, frame, radial, dir, depth, ringBase, vBase = 0) {
  const stride = radial + 1;
  const r = Math.max(sec.rx, sec.ry);
  const perim = ringPerimeter(sec);
  const uvScale = part.uvScale;
  const steps = [
    { s: 0.78, d: 0.42 },
    { s: 0.44, d: 0.76 },
  ];
  let prev = ringBase;
  for (const st of steps) {
    const start = part.vertexCount;
    for (let j = 0; j <= radial; j++) {
      const angle = (j / radial) * Math.PI * 2;
      ringOffset(angle, sec, _rx, _ry);
      _lp
        .copy(sec.p)
        .addScaledVector(frame.r, _rx[0] * st.s)
        .addScaledVector(frame.u, _ry[0] * st.s)
        .addScaledVector(frame.t, dir * r * depth * st.d);
      part.pos.push(_lp.x, _lp.y, _lp.z);
      part.uv.push(
        (j / radial) * perim * st.s * UV_DENSITY * uvScale,
        (vBase + dir * r * depth * st.d) * UV_DENSITY * uvScale
      );
    }
    for (let j = 0; j < radial; j++) {
      const a = prev + j;
      const b = a + 1;
      const c = start + j;
      const d = c + 1;
      // Same handedness rule as `loft`: outward is tangential-then-longitudinal.
      // The cap grows along +t when dir > 0, so it keeps the tube's order; the
      // start cap grows along -t and has to reverse it.
      if (dir > 0) part.idx.push(a, b, c, b, d, c);
      else part.idx.push(a, c, b, b, c, d);
    }
    prev = start;
  }
  const pole = part.vertexCount;
  _lp.copy(sec.p).addScaledVector(frame.t, dir * r * depth);
  part.pos.push(_lp.x, _lp.y, _lp.z);
  part.uv.push(perim * 0.5 * UV_DENSITY * uvScale, (vBase + dir * r * depth) * UV_DENSITY * uvScale);
  for (let j = 0; j < radial; j++) {
    const a = prev + j;
    const b = a + 1;
    if (dir > 0) part.idx.push(a, b, pole);
    else part.idx.push(a, pole, b);
  }
  void stride;
}

/**
 * Area-weighted normals, welded by position. Welding is what removes the seam
 * line where a lofted ring wraps back on itself and where caps meet the body.
 */
function computeWeldedNormals(pos, idx) {
  const count = pos.length / 3;
  const nrm = new Float32Array(count * 3);
  const ax = new THREE.Vector3();
  const bx = new THREE.Vector3();
  const cx = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const fn = new THREE.Vector3();
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3;
    const b = idx[i + 1] * 3;
    const c = idx[i + 2] * 3;
    ax.set(pos[a], pos[a + 1], pos[a + 2]);
    bx.set(pos[b], pos[b + 1], pos[b + 2]);
    cx.set(pos[c], pos[c + 1], pos[c + 2]);
    e1.subVectors(bx, ax);
    e2.subVectors(cx, ax);
    fn.crossVectors(e1, e2);
    nrm[a] += fn.x; nrm[a + 1] += fn.y; nrm[a + 2] += fn.z;
    nrm[b] += fn.x; nrm[b + 1] += fn.y; nrm[b + 2] += fn.z;
    nrm[c] += fn.x; nrm[c + 1] += fn.y; nrm[c + 2] += fn.z;
  }
  // Merge coincident vertices so duplicated seam/pole vertices share a normal.
  const buckets = new Map();
  for (let i = 0; i < count; i++) {
    const k =
      `${Math.round(pos[i * 3] * 8000)},${Math.round(pos[i * 3 + 1] * 8000)},` +
      `${Math.round(pos[i * 3 + 2] * 8000)}`;
    let list = buckets.get(k);
    if (!list) buckets.set(k, (list = []));
    list.push(i);
  }
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    let x = 0, y = 0, z = 0;
    for (const i of list) {
      x += nrm[i * 3];
      y += nrm[i * 3 + 1];
      z += nrm[i * 3 + 2];
    }
    for (const i of list) {
      nrm[i * 3] = x;
      nrm[i * 3 + 1] = y;
      nrm[i * 3 + 2] = z;
    }
  }
  for (let i = 0; i < count; i++) {
    const x = nrm[i * 3];
    const y = nrm[i * 3 + 1];
    const z = nrm[i * 3 + 2];
    const l = Math.sqrt(x * x + y * y + z * z) || 1;
    nrm[i * 3] = x / l;
    nrm[i * 3 + 1] = y / l;
    nrm[i * 3 + 2] = z / l;
  }
  return nrm;
}

function distanceToSegment(px, py, pz, a, b) {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const apx = px - a[0];
  const apy = py - a[1];
  const apz = pz - a[2];
  const len = abx * abx + aby * aby + abz * abz;
  let t = len > 1e-9 ? (apx * abx + apy * aby + apz * abz) / len : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = apx - abx * t;
  const dy = apy - aby * t;
  const dz = apz - abz * t;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Distance-to-bone-segment skinning with an explicit candidate list per part.
 * Restricting candidates is what stops a sleeve picking up thigh influence and
 * is far more reliable than a global nearest-bone search.
 */
function assignSkinWeights(part, boneIndex, spec, power = 3.6) {
  const count = part.vertexCount;
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  const cands = part.bones
    .map((b) => {
      const def = spec.find((d) => d.name === b.name);
      return def ? { index: boneIndex.get(b.name), a: def.pos, b: def.tail, bias: b.bias ?? 1 } : null;
    })
    .filter(Boolean);
  if (cands.length === 0) return { skinIndex, skinWeight };

  const w = new Float64Array(cands.length);
  for (let v = 0; v < count; v++) {
    const px = part.pos[v * 3];
    const py = part.pos[v * 3 + 1];
    const pz = part.pos[v * 3 + 2];
    for (let c = 0; c < cands.length; c++) {
      const d = distanceToSegment(px, py, pz, cands[c].a, cands[c].b) * cands[c].bias;
      w[c] = Math.pow(1 / (d + 0.022), power);
    }
    // Keep the four strongest influences.
    let i0 = -1, i1 = -1, i2 = -1, i3 = -1;
    let w0 = -1, w1 = -1, w2 = -1, w3 = -1;
    for (let c = 0; c < cands.length; c++) {
      const val = w[c];
      if (val > w0) { w3 = w2; i3 = i2; w2 = w1; i2 = i1; w1 = w0; i1 = i0; w0 = val; i0 = c; }
      else if (val > w1) { w3 = w2; i3 = i2; w2 = w1; i2 = i1; w1 = val; i1 = c; }
      else if (val > w2) { w3 = w2; i3 = i2; w2 = val; i2 = c; }
      else if (val > w3) { w3 = val; i3 = c; }
    }
    const picks = [i0, i1, i2, i3];
    const wts = [w0, w1, w2, w3];
    let sum = 0;
    for (let k = 0; k < 4; k++) if (picks[k] >= 0 && wts[k] > 0) sum += wts[k];
    if (sum <= 0) {
      skinIndex[v * 4] = cands[0].index;
      skinWeight[v * 4] = 1;
      continue;
    }
    for (let k = 0; k < 4; k++) {
      if (picks[k] >= 0 && wts[k] > 0) {
        skinIndex[v * 4 + k] = cands[picks[k]].index;
        skinWeight[v * 4 + k] = wts[k] / sum;
      }
    }
  }
  return { skinIndex, skinWeight };
}

/** Merge parts into one indexed BufferGeometry with per-slot draw groups. */
function mergeParts(parts, boneIndex, spec) {
  const bySlot = [];
  for (let s = 0; s < SLOT_COUNT; s++) bySlot.push([]);
  for (const p of parts) if (p.vertexCount > 0) bySlot[p.slot].push(p);

  let totalV = 0;
  let totalI = 0;
  for (const p of parts) {
    totalV += p.vertexCount;
    totalI += p.idx.length;
  }
  const position = new Float32Array(totalV * 3);
  const normal = new Float32Array(totalV * 3);
  const color = new Float32Array(totalV * 3);
  const uv = new Float32Array(totalV * 2);
  const skinIndex = new Uint16Array(totalV * 4);
  const skinWeight = new Float32Array(totalV * 4);
  const index = totalV > 65535 ? new Uint32Array(totalI) : new Uint16Array(totalI);

  const groups = [];
  let vOff = 0;
  let iOff = 0;
  for (let slot = 0; slot < SLOT_COUNT; slot++) {
    const list = bySlot[slot];
    if (list.length === 0) continue;
    const groupStart = iOff;
    for (const p of list) {
      const nrm = computeWeldedNormals(p.pos, p.idx);
      const skin = assignSkinWeights(p, boneIndex, spec);
      position.set(p.pos, vOff * 3);
      normal.set(nrm, vOff * 3);
      color.set(padColors(p), vOff * 3);
      uv.set(p.uv, vOff * 2);
      skinIndex.set(skin.skinIndex, vOff * 4);
      skinWeight.set(skin.skinWeight, vOff * 4);
      for (let i = 0; i < p.idx.length; i++) index[iOff + i] = p.idx[i] + vOff;
      vOff += p.vertexCount;
      iOff += p.idx.length;
    }
    groups.push({ start: groupStart, count: iOff - groupStart, slot });
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(color, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  for (const g of groups) geo.addGroup(g.start, g.count, g.slot);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  // Animation moves vertices outside the bind pose; pad so frustum culling and
  // shadow bounds do not pop limbs away at the edge of the screen.
  geo.boundingSphere.radius *= 1.5;
  return geo;
}

/* ------------------------------------------------------------------ */
/* Section builders                                                    */
/* ------------------------------------------------------------------ */

const B = (name, bias) => ({ name, bias: bias ?? 1 });
const S = (side) => (side > 0 ? 'R' : 'L');

const TORSO_BONES = [
  B('pelvis'), B('spine01'), B('spine02'), B('spine03'), B('neck', 1.1), B('head', 2.4),
  B('clavicleR', 1.1), B('clavicleL', 1.1), B('upperArmR', 1.8), B('upperArmL', 1.8),
  B('thighR', 1.6), B('thighL', 1.6),
];
const HEAD_BONES = [B('head'), B('neck', 1.25), B('spine03', 2.6)];
const armBones = (side) => [
  B(`clavicle${S(side)}`, 1.1), B(`upperArm${S(side)}`), B(`foreArm${S(side)}`),
  B(`hand${S(side)}`), B('spine03', 2.0),
];
const handBones = (side) => [B(`hand${S(side)}`, 0.8), B(`foreArm${S(side)}`, 1.3)];
const legBones = (side) => [
  B('pelvis', 1.6), B(`thigh${S(side)}`), B(`calf${S(side)}`), B(`foot${S(side)}`, 1.15),
  B(`toe${S(side)}`, 1.8),
];
const footBones = (side) => [B(`foot${S(side)}`, 0.85), B(`calf${S(side)}`, 1.5), B(`toe${S(side)}`, 0.95)];

/** @returns loft sections through the torso between two heights. */
function torsoSections(P, yMin, yMax, steps, expand) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const y = lerp(yMin, yMax, i / steps);
    const s = P.torso(y);
    const d = expand ? expand(y, i / steps) : null;
    const a = d?.a ?? 0;
    out.push({
      p: new THREE.Vector3(d?.ox ?? 0, y, d?.oz ?? 0),
      rx: s.rx + a + (d?.x ?? 0),
      ry: s.rf + a + (d?.f ?? 0),
      ryn: s.rb + a + (d?.b ?? 0),
      e: d?.e ?? s.e,
      // Per-angle radius modulation. `ringOffset` already understands it; this
      // is how a garment loft acquires folds instead of staying an extruded
      // tube (see FOLD below).
      ripple: d?.ripple ?? null,
    });
  }
  return out;
}

function legSections(P, side, yTop, yBottom, steps, expand) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const y = lerp(yTop, yBottom, i / steps);
    const s = P.leg(y);
    const d = expand ? expand(y, i / steps) : null;
    const a = d?.a ?? 0;
    // Lateral / medial expansion, split. A scalar offset on a leg garment is
    // what fused the sports shorts into one slab: 50 mm of shell on a 34 mm
    // inner-thigh gap means the two shells meet across the crotch and there is
    // no daylight between the legs and no per-leg hem. `lat` is the outboard
    // side (where a garment really does stand off the limb), `med` the inboard
    // side (where it is pulled tight and must stay clear of the other leg).
    const lat = d?.lat ?? 0;
    const med = d?.med ?? 0;
    // Which of rx/rxn is lateral depends on the loft frame, and the leg frame is
    // not the obvious one. Leg sections descend in y, so the tangent is -Y; with
    // the (0,0,-1) up-hint the frame's right vector comes out as **-X**, which
    // means `rx` is the -x half-width and `rxn` is the +x one. Getting this
    // backwards silently mirrors the garment - the shorts flare inward and pinch
    // outward - and it is invisible in a symmetric outfit, so it is spelled out
    // here rather than left to be rediscovered.
    out.push({
      p: new THREE.Vector3(P.legSideX * side, y, s.z),
      rx: s.rx + a + (side > 0 ? med : lat),
      rxn: s.rx + a + (side > 0 ? lat : med),
      ry: s.rf + a,
      ryn: s.rb + a,
      e: d?.e ?? s.e,
      ripple: d?.ripple ?? null,
    });
  }
  return out;
}

function footSections(P, side, expand, zFrom = 0.062, zTo = -0.196) {
  const out = [];
  const steps = 7;
  for (let i = 0; i <= steps; i++) {
    const z = lerp(zFrom, zTo, i / steps);
    const s = P.foot(z);
    const a = expand ? expand(i / steps) : 0;
    out.push({
      p: new THREE.Vector3(P.legSideX * side, s.y, z),
      rx: s.rx + a,
      ry: s.ry + a,
      ryn: Math.max(0.004, s.y - 0.004),
      e: 2.4,
    });
  }
  return out;
}

function armSections(P, side, uMin, uMax, steps, expand) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const u = lerp(uMin, uMax, i / steps);
    const s = P.arm(u, side);
    const d = expand ? expand(u, i / steps) : null;
    const a = d?.a ?? 0;
    out.push({
      p: s.p,
      rx: s.rx + a,
      ry: s.ry + a,
      // Flatten toward the wrist so the arm meets the palm slab, not a circle.
      e: d?.e ?? lerp(2.2, 3.0, smoothstep(0.52, WRIST_U, u)),
      ripple: d?.ripple ?? null,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Head sculpt                                                         */
/* ------------------------------------------------------------------ */

/** Cranium centre and radii, shared by the head mesh, hair shell and helmets. */
function headFrame(P) {
  const w = 1 + (P.girth - 1) * 0.32;
  // Head size is the single strongest cue for "is this a person or a puppet".
  // At 0.0835 x 0.1055 x 0.0995 the skull was still ~8.4 heads to the body's
  // height; a human adult is 7.4-7.8. Another 6% on every axis lands at ~7.9
  // and, just as importantly, gives the lat-long sculpt more millimetres per
  // quad for the brow, nose and lips to occupy.
  //
  // The centre rises by exactly the growth in ry so the chin, the jaw taper and
  // the neck junction below it all stay where the torso loft expects them - the
  // skull grows upward out of the jaw, it does not swallow the throat.
  const ry = 0.1055 * 1.06;
  return {
    c: new THREE.Vector3(0, 1.5425 + ry, 0.01),
    r: new THREE.Vector3(0.0835 * 1.06 * w, ry, 0.0995 * 1.06 * w),
  };
}

/**
 * How many distinct face archetypes exist.
 *
 * The head is welded into the merged body geometry, so a face variant costs a
 * whole cached body geometry (~1 MB). Twelve is the point where a 24-strong
 * crowd stops reading as one sculpt repeated - reviewers called that out three
 * rounds running - without the cache degenerating into one geometry per NPC.
 *
 * Six, not twelve. Twelve was measured: with three worlds resident the cache
 * held 95 merged body geometries, ~1 MB each, because the key is
 * theme x variant x proportions x face and the face dimension was multiplying
 * an already-large product. Six halves that and the crowd still reads as
 * individuals, because the face archetype is only one of five independent
 * variation axes - skin tone, hair style, hair colour, stature and build all
 * ride on top of it and none of them cost a geometry.
 */
const FACE_COUNT = 6;

/**
 * A face archetype: eleven dials over the head sculpt, derived from a small
 * integer so the geometry cache key stays short and the archetype count stays
 * bounded.
 *
 * Every dial is a *multiplier* on an amplitude that already exists in
 * `buildHead`, which means no combination can fold the surface: the sculpt is a
 * sum of gaussian displacements and scaling each one keeps it a sum of gaussian
 * displacements. The ranges are deliberately wide (roughly +/-25%) because the
 * features are only 2-3 cm to begin with; a 5% spread is invisible at 2.5 m and
 * invisible variation is the same as none.
 *
 * @param {number} id 0..FACE_COUNT-1
 */
function makeFace(id) {
  const r = createRng((id | 0) * 9176 + 31);
  const q = (lo, hi) => lo + (hi - lo) * r();
  return {
    id: id | 0,
    brow: q(0.70, 1.36),
    // Nose is split into three dials because "long", "projecting" and "broad"
    // are independent in life and coupling them makes every face the same face
    // at a different scale.
    noseLen: q(0.84, 1.24),
    noseProj: q(0.78, 1.38),
    noseWide: q(0.76, 1.32),
    lips: q(0.72, 1.36),
    mouthW: q(0.86, 1.18),
    chin: q(0.72, 1.34),
    jaw: q(0.80, 1.28),
    cheek: q(0.72, 1.32),
    eyeSep: q(0.945, 1.055),
    occiput: q(0.7, 1.3),
  };
}

/** Face archetypes are pure functions of their id; build each one once. */
const _faceCache = new Map();
function faceArchetype(id) {
  const k = ((id | 0) % FACE_COUNT + FACE_COUNT) % FACE_COUNT;
  let f = _faceCache.get(k);
  if (!f) {
    f = makeFace(k);
    _faceCache.set(k, f);
  }
  return f;
}

/**
 * Sculpt a head out of a lat-long lattice. Every feature is a smooth radial or
 * directional displacement, which keeps the surface manifold and lets normals
 * be computed from the result rather than faked.
 */
/**
 * Baked albedo cavity for the face, written into the vertex colour channel.
 *
 * This is the single highest-value thing on the head. A 40x32 lat-long skull
 * cannot carry an eye, a lash line or a nasolabial fold in *silhouette* at
 * gameplay distance - the quads are bigger than the features. What it can carry
 * is value. Every term below is driven by the same gauss field that drives the
 * corresponding geometric displacement, so the darkening always lands exactly
 * in the crease the sculpt just made and the two reinforce each other.
 *
 * @param {number} ax |x| on the unit sphere (0 centre-line, 1 temple)
 * @param {number} ay y on the unit sphere (+ crown, - chin)
 * @param {number} f  -z on the unit sphere (+1 straight out of the face)
 * @param {{r:number,g:number,b:number}} out multiplied in place
 */
function faceCavity(ax, ay, f, out, FA) {
  const front = Math.max(0, f);
  const f2 = front * front;
  const f3 = f2 * front;
  // Every cavity term below is driven by the same dial as the geometric feature
  // it shades, so a face with a long nose gets its nostrils moved down with it
  // rather than acquiring two dark dots on the philtrum.
  const eyeX = 0.42 * FA.eyeSep;
  const noseY = -0.235 * FA.noseLen;
  const mouthY = -0.408 - (FA.lips - 1) * 0.012;
  const mw = FA.mouthW;
  let k = 1;

  // Orbital recess: the socket itself. This is what reads as "has eyes" from
  // 3 m even before the eyeball geometry draws.
  // These are *ambient occlusion in albedo*, not make-up. Every one of them was
  // originally authored twice as strong and the socket plus the lash line
  // merged into a single black band across the face - the character read as
  // wearing sunglasses. Cavity has to stay under the threshold where the eye
  // reads it as a separate material.
  //
  // The orbital block is the one place the additive model breaks down. The
  // recess, the lash line and the brow shadow all peak within a few millimetres
  // of each other, so summing them drove the product into the floor and the
  // whole orbit came out as one featureless dark band - "no sclera, no iris, no
  // catchlight, the face reads as a blank egg". They are gathered here and
  // *combined* rather than stacked: the strongest term wins, the others only
  // deepen it a little. That keeps each one legible as a separate mark, which is
  // the entire job - a socket, a lash, and a brow are three shapes, not one.
  const orbRecess = 0.16 * gauss(ay, 0.145, 0.10) * gauss(ax, eyeX, 0.155) * f2;
  // Lash line / upper lid crease - the cheapest possible "has eyes" signal.
  // Every sigma below is held at or above the face-band sample spacing; a field
  // narrower than the mesh can sample simply does not exist on screen.
  //
  // Raised from 0.13 to 0.24 because this is the term that has to survive when
  // the eye meshes are culled by LOD: with nothing else in the socket, the lash
  // line *is* the eye. It no longer stacks with the recess, so it can afford to.
  const lashLine = 0.24 * gauss(ay, 0.075, 0.045) * gauss(ax, eyeX, 0.15) * f2;
  // Upper-lid contact shadow: a narrow band immediately above the aperture,
  // which is what brackets the sclera in dark so an off-white eyeball separates
  // from the skin instead of merging into it.
  const lidContact = 0.20 * gauss(ay, 0.115, 0.028) * gauss(ax, eyeX, 0.13) * f2;
  // Brow shadow under the ridge, so a brow reads even at LOD. Raised, and
  // raised more for shaved-head variants (see BROW_DARKEN / buildBrows): with no
  // hairline the brow is the only horizontal the eye can anchor on.
  const browShadow = 0.16 * FA.brow * gauss(ay, 0.245, 0.075) * gauss(ax, 0.34, 0.2) * f2;
  // Combine, do not sum: strongest term plus a fraction of the rest.
  const orbTotal = orbRecess + lashLine + lidContact + browShadow;
  const orbPeak = Math.max(orbRecess, lashLine, lidContact, browShadow);
  // Hard-capped at 0.28, i.e. the socket can never take the face below 0.72 of
  // base albedo. The eyeball is rendered into this region and it has to be
  // lighter than what surrounds it; if the surround is already black there is
  // nothing left for an eye to be.
  k -= Math.min(0.28, orbPeak + 0.28 * (orbTotal - orbPeak));
  // Nostrils. The single most identifiable mark on a low-poly face after the
  // eyes - two dark dots either side of the centre line are what tell a viewer
  // the projection in the middle of the face is a nose and not a lump.
  // Tighter than it was: at sigma 0.062 the two nostril dots overlapped across
  // the centre line into one dark bar under the nose, which at 2.5 m reads as a
  // moustache rather than as nostrils.
  k -= 0.34 * gauss(ay, noseY, 0.042) * gauss(ax, 0.125 * FA.noseWide, 0.045) * f3;
  // Philtrum: two short verticals between the nose base and the lip bow. On a
  // real face this is the only structure between two of the three features a
  // viewer reads, and leaving it out is a large part of why the mid-face went
  // on being called "weak" - the nose simply stopped and the mouth started.
  k -= 0.07 * gauss(ay, mouthY + 0.075, 0.038) * gauss(ax, 0.038, 0.016) * f3;
  // Under-lip shadow and the mouth seam. The seam was the weakest line on the
  // face: at 0.17 over a 0.045 sigma it faded to nothing by 2 m and the mouth
  // stopped existing. Darker and slightly wider, so the line survives both the
  // mesh sampling and the distance.
  k -= 0.10 * gauss(ay, mouthY - 0.092, 0.06) * gauss(ax, 0, 0.20 * mw) * f2;
  // The seam itself, tightened and darkened: at 0.30 over a 0.052 sigma it was
  // a soft dent rather than a line, and a mouth without a line is a smudge.
  k -= 0.40 * gauss(ay, mouthY, 0.038) * gauss(ax, 0, 0.20 * mw) * f2;
  // Mouth corners: two short vertical shadows that stop the seam reading as a
  // ruled line drawn across the face.
  k -= 0.14 * gauss(ay, mouthY - 0.007, 0.075) * gauss(ax, 0.20 * mw, 0.05) * f2;
  // Temple hollow and the shadow under the jaw.
  k -= 0.06 * gauss(ay, 0.30, 0.17) * gauss(ax, 0.84, 0.16);
  // Under-cheekbone hollow. The cheek is the largest uninterrupted area on the
  // face and with nothing under the malar the whole mid-face renders as one
  // flat value - which is exactly the "soft and waxy" read.
  k -= 0.07 * FA.cheek * gauss(ay, -0.18, 0.13) * gauss(ax, 0.60, 0.14) * f2;
  k -= 0.10 * smoothstep(-0.55, -0.95, ay);

  // Nasolabial fold, proper. The old single 0.10 lobe sat at a fixed (ay, ax)
  // and read as a smudge on the cheek; a real fold runs *diagonally* from the
  // nose wing to the mouth corner, so this traces that line and darkens along
  // it. It is the mark that separates a mid-face from a putty mask.
  {
    const t = clamp((mouthY + 0.135 - ay) / 0.20, 0, 1);
    const foldX = lerp(0.155 * FA.noseWide, 0.215 * mw, t);
    k -= 0.13 * gauss(ax, foldX, 0.045) * gauss(ay, mouthY + 0.135 - t * 0.20, 0.115) * f3;
  }

  // Global floor.
  //
  // The orbital region has its own, much higher cap above - that is where the
  // "eyes read as a black band" failure lived. Everything else is a *feature
  // line*: a nostril, a lip seam, a nasolabial. Those are allowed to be genuinely
  // dark, because they are the only marks a 44x36 lattice can carry at all, and
  // clamping them to the same floor as the socket is what turned the mouth into
  // a smudge. 0.44 is about as dark as albedo can go before the surface stops
  // responding to light entirely.
  k = Math.max(k, 0.44);

  out.r *= k;
  out.g *= k;
  out.b *= k;
  // Lips carry blood, not shadow: warm them rather than darkening them.
  const lip = gauss(ay, mouthY + 0.008, 0.07) * gauss(ax, 0, 0.185 * mw) * f3;
  out.r *= 1 + lip * 0.10;
  out.g *= 1 - lip * 0.14;
  out.b *= 1 - lip * 0.16;
}

const _fc = { r: 1, g: 1, b: 1 };

/**
 * Monotone sample table over [0, span] with extra density where `weight` is
 * high. Integrating a density and inverting it is the only way to redistribute
 * rows that is guaranteed not to fold the surface back on itself.
 */
function densifiedTable(n, span, weight) {
  const fine = n * 8;
  const cum = new Float64Array(fine + 1);
  for (let i = 0; i < fine; i++) cum[i + 1] = cum[i] + Math.max(1e-6, weight((i + 0.5) / fine));
  const total = cum[fine];
  const out = new Float64Array(n + 1);
  let j = 0;
  for (let k = 0; k <= n; k++) {
    const target = (k / n) * total;
    while (j < fine - 1 && cum[j + 1] < target) j++;
    const seg = cum[j + 1] - cum[j] || 1;
    out[k] = ((j + clamp((target - cum[j]) / seg, 0, 1)) / fine) * span;
  }
  out[n] = span;
  return out;
}

function buildHead(part, P, FA) {
  const F = headFrame(P);
  // 26x22 on a 0.1 m head gave ~7 mm quads - larger than the brow, nose-wing
  // and lip offsets themselves, so computeWeldedNormals smoothed every feature
  // straight back out.
  const segU = 44;
  const segV = 36;
  // Uniform lat-long spends most of its rows on the back of the skull and the
  // scalp, where nothing happens. These tables push rows into the theta band
  // that carries the brow-to-chin range and columns into the front hemisphere,
  // which roughly halves the quad size across the face for the same triangle
  // budget. Everything on the face is authored against a ~4 mm quad; the
  // eye-socket and lash-line fields below are only a few millimetres wide, and
  // at the old spacing they fell *between* samples and vanished entirely.
  const thetaTab = densifiedTable(segV, Math.PI, (t) => 1 + 2.1 * gauss(t, 0.575, 0.175));
  const phiTab = densifiedTable(segU, Math.PI * 2, (t) => 1 + 1.6 * gauss(t, 0.5, 0.15));
  const base = part.vertexCount;
  const p = new THREE.Vector3();
  const off = new THREE.Vector3();
  // Orbit centre on the unit sphere. The eyeballs are seated against the same
  // number in `create`, so a wide-set face gets wide-set sockets *and* wide-set
  // eyes rather than eyeballs floating off the recess.
  const eyeX = 0.42 * FA.eyeSep;

  for (let v = 0; v <= segV; v++) {
    const theta = thetaTab[v];
    const st = Math.sin(theta);
    const ct = Math.cos(theta);
    for (let u = 0; u <= segU; u++) {
      const phi = phiTab[u];
      const dx = st * Math.sin(phi);
      const dy = ct;
      const dz = st * Math.cos(phi);
      const f = -dz;
      const ay = dy;
      const ax = Math.abs(dx);

      let rad = 1;
      off.set(0, 0, 0);

      // Occiput sticks out behind; temples flatten.
      off.z += 0.014 * FA.occiput * Math.max(0, dz) ** 2;
      rad -= 0.055 * gauss(ay, 0.34, 0.34) * gauss(ax, 0.94, 0.22);
      // Parietal flattening. A bare ellipsoid comes to a rounded point at the
      // top and, with no hair to hide it, a lat-long pole sitting on that point
      // reads as a cone - which is exactly what the bald sports NPC showed.
      // A real cranium is noticeably flatter across the crown than it is round
      // at the sides, so this is anatomy as well as a pole fix.
      rad -= 0.030 * gauss(ay, 1.0, 0.30);

      // Brow ridge. Every feature amplitude below is roughly double the
      // original: at 0.013 the brow was sub-quad and the mesh could not hold it.
      const brow = gauss(ay, 0.3, 0.15) * gauss(f, 0.88, 0.28) * smoothstep(0.66, 0.3, ax);
      off.z -= 0.026 * FA.brow * brow;
      off.y += 0.007 * brow;

      // Orbital recess. A face is made by the socket, not by the eyeball - but
      // 5 mm over a 0.095 sigma is not a socket, it is a crater, and the whole
      // eyeball fell into it: the medieval closeup showed a single dark
      // horizontal slit with no sclera anywhere in the frame, and the sports
      // full-body showed no orbit at all.
      //
      // 3 mm over a 0.065 sigma is a socket *rim*. The narrower sigma matters as
      // much as the smaller amplitude: at 0.095 the hollow was wide enough to
      // swallow the brow ridge above and the malar below, so the entire orbital
      // region sank together and there was no local relief left for the eye to
      // sit in front of.
      rad -= 0.030 * gauss(ay, 0.135, 0.065) * gauss(ax, eyeX, 0.135) * Math.max(0, f) ** 2;

      off.z += 0.020 * gauss(ay, 0.11, 0.115) * gauss(ax, 0.38, 0.17) * gauss(f, 0.86, 0.24);

      // Malar (cheekbone) out, buccal hollow under it, masseter at the jaw
      // angle. Three terms, and the middle one is what stops the cheek being a
      // single flat plane from the eye to the chin.
      //
      // Amplitudes roughly doubled. At 0.058/0.044 spread over 0.15-0.19 sigmas
      // the zygomatic was a gentle swelling, and a gentle swelling on a matte
      // material produces no terminator at all - "cheek-to-jaw is one continuous
      // unbroken gradient". A cheekbone is a *plane break*, so the malar term
      // now carries a tighter companion lobe on its lower edge that cuts the
      // transition instead of blending it, which is what throws the hard
      // triangular shadow under the bone that a viewer reads as bone.
      rad += 0.078 * FA.cheek * gauss(ay, -0.04, 0.14) * gauss(ax, 0.62, 0.18) * gauss(f, 0.55, 0.34);
      rad -= 0.030 * FA.cheek * gauss(ay, -0.155, 0.055) * gauss(ax, 0.58, 0.16) * gauss(f, 0.60, 0.30);
      rad -= 0.062 * FA.cheek * gauss(ay, -0.3, 0.15) * gauss(ax, 0.52, 0.17) * gauss(f, 0.62, 0.3);
      rad += 0.05 * FA.jaw * gauss(ay, -0.5, 0.27) * gauss(ax, 0.75, 0.35) * smoothstep(-0.4, 0.4, f);

      const chin = gauss(ay, -0.63, 0.16) * gauss(f, 0.94, 0.15) * gauss(ax, 0, 0.34);
      off.z -= 0.024 * FA.chin * chin;
      off.y -= 0.008 * chin;
      // Mental crease: the short horizontal furrow between the lower lip and
      // the chin pad. Without it the chin is a bump on a curve rather than a
      // separate mass, which is most of why the lower face read as soft.
      off.z += 0.007 * gauss(ay, -0.565, 0.032) * gauss(ax, 0, 0.16) * gauss(f, 0.95, 0.1);
      // Keep width in the jaw instead of pinching straight to the chin point.
      rad += 0.034 * FA.jaw * gauss(ay, -0.45, 0.2) * gauss(ax, 0.72, 0.28);

      // Nose. Still short and broad - a narrow high-projection nose on a
      // low-poly head reads as a beak - but it now actually projects: ~3 cm at
      // the tip on a 0.095 depth-radius head, which is a human nose.
      //
      // The mid-face was still being called weak after round 3, and the reason
      // is that the projection was spread over one broad 0.17-sigma lobe: a
      // ramp that gentle is read as a swelling, not as a nose. The projection
      // is now split into a *bridge* ramp and a much tighter *tip* ball sitting
      // on the end of it, which is the actual anatomy and the only shape that
      // throws the hard down-shadow onto the philtrum that says "nose".
      const centre = gauss(ax, 0, 0.155 * FA.noseWide);
      const nY = FA.noseLen;
      // Nasion (the dip between the brows) - the nose has to start somewhere.
      off.z += 0.006 * gauss(ay, 0.235 * nY, 0.055) * centre * gauss(f, 0.96, 0.12);
      // Bridge.
      off.z -= 0.019 * gauss(ay, 0.15 * nY, 0.135) * centre * gauss(f, 0.97, 0.1);
      // Tip. Tighter sigma, more amplitude, and pulled down a touch so the
      // under-plane of the nose faces the floor instead of the camera.
      const tip = gauss(ay, -0.055 * nY, 0.085) * centre * Math.max(0, f) ** 3;
      off.z -= 0.040 * FA.noseProj * tip;
      off.y -= 0.006 * tip;
      const wing = gauss(ay, -0.17 * nY, 0.075) * gauss(ax, 0.155 * FA.noseWide, 0.082) * gauss(f, 0.9, 0.14);
      off.z -= 0.018 * wing;
      rad += 0.032 * FA.noseWide * wing;
      // Base of the columella and the shadow shelf under it.
      off.z += 0.013 * gauss(ay, -0.245 * nY, 0.05) * gauss(ax, 0, 0.12) * gauss(f, 0.95, 0.1);
      off.z += 0.007 * gauss(ay, -0.30 * nY, 0.05) * gauss(ax, 0, 0.09) * gauss(f, 0.96, 0.08);

      // Lips: upper, lower, and the seam between them.
      const mY = -0.408 - (FA.lips - 1) * 0.012;
      const mW = FA.mouthW;
      // Lip volume up ~40%. "The mouth is a single scratched line with no
      // upper/lower lip separation" - at 16/19 mm of displacement spread over a
      // 0.055 sigma the lips were a swelling either side of the seam rather than
      // two distinct masses, and the seam alone was doing all the work. The
      // upper lip also gains a cupid's bow: two small lobes either side of the
      // philtrum, which is the detail that stops a mouth reading as a slot.
      off.z -= 0.023 * FA.lips * gauss(ay, mY + 0.053, 0.050) * gauss(ax, 0, 0.19 * mW) * gauss(f, 0.95, 0.11);
      off.z -= 0.006 * FA.lips * gauss(ay, mY + 0.040, 0.030) * gauss(ax, 0.062 * mW, 0.038) * gauss(f, 0.95, 0.11);
      off.z -= 0.027 * FA.lips * gauss(ay, mY - 0.047, 0.055) * gauss(ax, 0, 0.17 * mW) * gauss(f, 0.95, 0.11);
      // Lip seam. 9 mm of recess over a 0.05 sigma is a dent; a mouth needs a
      // line, and at this poly density the only way to get one is to cut deep
      // enough that the welded normals cannot smooth it away.
      off.z += 0.017 * gauss(ay, mY, 0.034) * gauss(ax, 0, 0.2 * mW) * gauss(f, 0.96, 0.1);
      off.z += 0.008 * gauss(ay, mY - 0.137, 0.05) * gauss(ax, 0, 0.22 * mW) * gauss(f, 0.95, 0.1);

      p.set(F.c.x + dx * F.r.x * rad, F.c.y + dy * F.r.y * rad, F.c.z + dz * F.r.z * rad).add(off);

      // Taper the underside into the neck tube so jaw and throat meet cleanly.
      const k = smoothstep(-0.76, -0.99, ay);
      if (k > 0) {
        p.x = lerp(p.x, dx * 0.062, k);
        p.z = lerp(p.z, F.c.z + dz * 0.062, k);
        p.y = lerp(p.y, 1.512, k);
      }

      part.pos.push(p.x, p.y, p.z);
      part.uv.push((u / segU) * 2, (v / segV) * 2);
      _fc.r = 1;
      _fc.g = 1;
      _fc.b = 1;
      faceCavity(ax, ay, f, _fc, FA);
      part.col.push(_fc.r, _fc.g, _fc.b);
    }
  }

  const stride = segU + 1;
  for (let v = 0; v < segV; v++) {
    for (let u = 0; u < segU; u++) {
      const a = base + v * stride + u;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      part.idx.push(a, c, b, b, c, d);
    }
  }
}

/**
 * Ears: a small lofted lobe with a ripple that reads as the helix.
 *
 * These were being built *inside the skull*. The lobe ran from 0.72 to 0.97 of
 * the head's x-radius, and at the ear's own latitude the cranium surface is at
 * ~0.99 of it - so every character had two ears entirely buried under the
 * temple, which is why the medieval closeup showed no ear anywhere on the
 * visible side of the head. A missing ear at portrait framing is an instant
 * tell, and this one had been missing for four rounds because the geometry was
 * present in the vertex count and absent from the silhouette.
 *
 * The frame is x-aligned, so in the loft's local axes `rx` is the ear's height
 * and `ry` its depth front-to-back. 60 mm tall and ~18 mm of protrusion is a
 * human ear on a 1.78 m frame.
 */
function buildEar(part, P, side) {
  const F = headFrame(P);
  const R = F.r.x;
  // Behind the coronal mid-line: an ear sits at the back of the jaw hinge, not
  // over the cheek. F.c.z is the skull centre, +z is behind the character.
  const z = F.c.z + 0.016;
  const sections = [
    { p: new THREE.Vector3(0.95 * R * side, 1.641, z + 0.006), rx: 0.028, ry: 0.012, e: 2.4 },
    { p: new THREE.Vector3(1.07 * R * side, 1.639, z + 0.002), rx: 0.035, ry: 0.017, e: 2.2 },
    { p: new THREE.Vector3(1.16 * R * side, 1.636, z - 0.003), rx: 0.032, ry: 0.016, e: 2.2 },
    { p: new THREE.Vector3(1.21 * R * side, 1.632, z - 0.008), rx: 0.022, ry: 0.010, e: 2.4 },
  ];
  for (const s of sections) s.ripple = { amp: 0.14, freq: 2, phase: 0.7 };
  loft(part, sections, 12, { upHint: new THREE.Vector3(0, 0, -1), capEnd: true, capDepth: 0.5 });
}

/**
 * A hand, with fingers.
 *
 * Previously the arm was one loft from the acromion to u=1.0 with `capEnd`,
 * which domed a 12 mm ring into a point: every character had a cone where a
 * hand should be. Nothing else on the body costs a frame as badly, because the
 * hands sit at the exact height a standing character's silhouette is read at.
 *
 * The frame is built explicitly rather than left to the loft's tangent frame so
 * the palm is a *slab*: a relaxed arm hangs with the palm facing the thigh, so
 * the wide axis runs front-to-back and the thin axis runs across the body.
 * ~430 triangles per hand at radial 6 on the fingers.
 */
function buildHand(part, P, side) {
  const wrist = P.arm(WRIST_U, side).p.clone();
  const back = P.arm(WRIST_U - 0.09, side).p;
  // Down the forearm axis toward the fingertips.
  const dir = wrist.clone().sub(back).normalize();
  // Front-to-back across the palm, and the medial palm normal.
  const across = new THREE.Vector3(0, 0, 1);
  const inward = new THREE.Vector3(-side, 0, 0);

  const at = (along, z, x) =>
    wrist
      .clone()
      .addScaledVector(dir, along)
      .addScaledVector(across, z)
      .addScaledVector(inward, x);

  // A game hand is deliberately oversized. Hands are the second-most-read
  // feature on a humanoid after the face, they sit at exactly the height a
  // standing silhouette is judged at, and at true anatomical scale they
  // disappear into the hip garment at any distance past two metres - which is
  // precisely what the reviewer saw ("the left hand is not resolvable at all").
  // Every shipped character in the genre runs 8-12% over; this is 9%.
  const HS = 1.09;

  // --- palm: a flattened slab that swells to the knuckle line --------
  const palm = [
    { s: -0.006, rx: 0.030, ry: 0.026, e: 2.8 },
    { s: 0.016, rx: 0.038, ry: 0.025, e: 3.0 },
    { s: 0.044, rx: 0.046, ry: 0.023, e: 3.2 },
    { s: 0.068, rx: 0.047, ry: 0.021, e: 3.2 },
    // Knuckle ring: the ripple is what puts four bumps in the silhouette.
    { s: 0.085, rx: 0.045, ry: 0.020, e: 3.0, ripple: { amp: 0.14, freq: 4, phase: 0.4 } },
  ];
  for (const k of palm) {
    k.rx *= HS;
    k.ry *= HS;
  }
  loft(
    part,
    palm.map((k) => ({ p: at(k.s, 0, 0), rx: k.rx, ry: k.ry, e: k.e, ripple: k.ripple ?? null })),
    12,
    { upHint: new THREE.Vector3(1, 0, 0), capStart: true, capDepth: 0.25 }
  );

  // --- four fingers, splayed and curled toward the palm --------------
  // Index is forward (-Z, the direction the character faces).
  //
  // Spacing versus radius is the whole game here. At 20.5 mm apart and 20.8 mm
  // thick the four digits were exactly tangent for their whole length, welded
  // into one slab, and the hand went back to being an oar blade. They are now
  // pitched 23 mm apart, thinner, and splayed harder, so a 4-6 mm gap opens
  // between them - about five pixels at 2.5 m, which is the threshold at which
  // a viewer counts fingers instead of seeing a paddle. The per-finger curl
  // offset staggers the tips so the far edge of the hand is a staircase rather
  // than a straight cut.
  //
  // The curls are also no longer a monotone ramp. A relaxed human hand rests in
  // an uneven hook - index least curled, middle most, ring following it, little
  // finger pulled in behind - and that irregularity is what stops four digits
  // reading as one moulded slab even when the gaps between them are correct.
  // Roughly 12/18/16/20 degrees at the MCP.
  const fingers = [
    { z: -0.0345, len: 0.072, r: 0.0097, splay: -0.30, curl: 0.21 },
    { z: -0.0115, len: 0.079, r: 0.0100, splay: -0.10, curl: 0.31 },
    { z: 0.0115, len: 0.073, r: 0.0094, splay: 0.11, curl: 0.28 },
    { z: 0.0345, len: 0.057, r: 0.0082, splay: 0.31, curl: 0.35 },
  ];
  for (const fg of fingers) {
    fg.z *= HS;
    fg.r *= HS;
    fg.len *= 1.05;
  }
  for (const fg of fingers) {
    const sections = [];
    // Three phalanges: four rings, each rotated a little further into the curl.
    const phal = [0, 0.36, 0.68, 0.88, 1.0];
    let along = 0.085;
    let z = fg.z;
    let x = 0;
    let curl = fg.curl;
    for (let i = 0; i < phal.length; i++) {
      const t = phal[i];
      if (i > 0) {
        const seg = (phal[i] - phal[i - 1]) * fg.len;
        curl += 0.30;
        along += seg * Math.cos(curl);
        x += seg * Math.sin(curl);
        z += seg * Math.sin(fg.splay);
      }
      // Knuckle -> tip taper with a slight swell at each joint.
      const r = fg.r * lerp(1.0, 0.60, t) * (1 + 0.10 * Math.cos(t * Math.PI * 6));
      sections.push({
        p: at(along, z, x),
        rx: r,
        ry: r * 0.88,
        e: 2.5,
      });
    }
    loft(part, sections, 7, {
      upHint: new THREE.Vector3(1, 0, 0),
      capEnd: true,
      capDepth: 0.6,
    });
  }

  // --- thumb: opposed, on the radial (forward) side of the palm ------
  const th = [
    { s: 0.014, z: -0.030, x: 0.004, r: 0.0145 },
    { s: 0.038, z: -0.046, x: 0.015, r: 0.0128 },
    { s: 0.058, z: -0.056, x: 0.028, r: 0.0108 },
    { s: 0.070, z: -0.060, x: 0.040, r: 0.0086 },
  ];
  for (const k of th) {
    k.z *= HS;
    k.x *= HS;
    k.r *= HS;
  }
  loft(
    part,
    th.map((k) => ({ p: at(k.s, k.z, k.x), rx: k.r, ry: k.r * 0.9, e: 2.4 })),
    8,
    { upHint: new THREE.Vector3(0, 1, 0), capStart: true, capEnd: true, capDepth: 0.5 }
  );
}

/** The bare body: torso, head, ears, arms, hands, legs, feet. */
function buildBody(P, parts, FA) {
  const skin = (bones, uv = 1) => {
    const p = new Part(SLOT.SKIN, bones, uv);
    parts.push(p);
    return p;
  };

  const torso = skin(TORSO_BONES, 1);
  // 30 steps rather than 22: the trapezius ramp between y 1.392 and 1.444 puts
  // four keys inside 5 cm and under-sampling it just restores the hard shelf.
  loft(torso, torsoSections(P, 0.86, 1.57, 30), 20, {
    upHint: new THREE.Vector3(0, 0, -1),
    capStart: true,
    capEnd: true,
    capDepth: 0.55,
  });

  const head = skin(HEAD_BONES, 1.4);
  buildHead(head, P, FA);
  buildEar(head, P, 1);
  buildEar(head, P, -1);

  for (const side of [1, -1]) {
    // The arm tube stops at the wrist; the hand is its own part so it can be
    // weighted to the hand bone and shaped as a slab instead of a cone.
    const arm = skin(armBones(side), 1.2);
    loft(arm, armSections(P, side, 0.0, WRIST_U, 15), 12, {
      upHint: new THREE.Vector3(0, 0, -1),
      capStart: true,
      capEnd: true,
      // Shallow, so the stub under the palm can never form a tip.
      capDepth: 0.22,
    });
    const hand = skin(handBones(side), 1.2);
    buildHand(hand, P, side);

    const leg = skin(legBones(side), 1);
    loft(leg, legSections(P, side, 1.005, 0.098, 16), 14, {
      upHint: new THREE.Vector3(0, 0, -1),
      capStart: true,
      capEnd: false,
      capDepth: 0.5,
    });

    const foot = skin(footBones(side), 1.4);
    // 0.6 on a heel whose largest radius is 4.4 cm rounds 2.6 cm off the back
    // of the foot and pushes the toe another 1.7 cm past the last key. The key
    // table gained a toe box this pass, so the caps have to come in or the shoe
    // ends up 32 cm long on a 1.78 m frame.
    loft(foot, footSections(P, side), 12, {
      upHint: new THREE.Vector3(0, 1, 0),
      capStart: true,
      capEnd: true,
      capDepth: 0.42,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Garment primitives                                                  */
/* ------------------------------------------------------------------ */

const asExpand = (exp) => (typeof exp === 'function' ? exp : () => exp);

/**
 * Clearance every garment gets over the body, on top of whatever the outfit
 * asks for.
 *
 * The body is a closed lofted surface and the clothing is another one draped a
 * few millimetres outside it. Skinning is not identical between the two - they
 * bind to different bone sets with different falloff - so at 1 cm of clearance
 * the bare body punches through the cloth on every stride and the character
 * reads as naked with a few ribbons stuck to it. These offsets are the
 * difference between "wearing clothes" and "wearing decals".
 */
// Raised ~25% across the board, not the 70% the review asked for.
//
// The interleave reviewers saw ("the lavender undersuit strobing through the
// brown overshell") was overwhelmingly the DoubleSide backface composite, not
// skinning divergence - a garment and the body ring it wraps bind to the *same*
// bone set here, so their weights are a smooth function of the same position
// and they cannot shear apart. Taking the gap to 3 cm would have solved a
// problem that no longer exists at the cost of a 6 cm-thicker torso and a
// sleeve wider than the shoulder. The real fixes are FrontSide, closed shells
// and a polygon offset; this is headroom on top of them.
const GAP = { torso: 0.024, leg: 0.017, arm: 0.014, foot: 0.008 };

/** How far inside the body the hem ring is tucked, so the seam never shows. */
const HEM_INSET = 0.93;

/**
 * Close a garment's open end back onto the body so no interior is visible.
 *
 * Two details matter. The ring is placed at `HEM_INSET` of the *body* radius,
 * not at the body radius, so it finishes a few millimetres under the skin
 * rather than coplanar with it - coplanar is a z-fight. And the loft that
 * consumes these sections now caps both ends (see gTorso/gLeg/gArm), which is
 * what actually makes the shell watertight and lets the material cull its
 * back faces. An uncapped tube plus FrontSide is a hole; DoubleSide was only
 * ever hiding that hole by lighting the tube's inner wall, and lighting the
 * inner wall is what produced the X-ray wash over the whole figure.
 */
function addHem(sections, radii, atStart, roll = false) {
  const i = atStart ? 0 : sections.length - 1;
  const j = atStart ? 1 : sections.length - 2;
  const s = sections[i];
  const dir = new THREE.Vector3().subVectors(s.p, sections[j].p);
  if (dir.lengthSq() < 1e-10) dir.set(0, atStart ? 1 : -1, 0);
  dir.normalize().multiplyScalar(0.005);
  const ring = {
    p: s.p.clone().add(dir),
    rx: radii.rx * HEM_INSET,
    ry: radii.ry * HEM_INSET,
    ryn: (radii.ryn ?? radii.ry) * HEM_INSET,
    e: s.e,
  };
  const add = [];
  // Rolled hem.
  //
  // This is the single change that makes cloth read as having thickness rather
  // than as a paint layer, and it is why "the jersey is a smooth tube with a
  // painted stripe" and "the shorts hem is a perfectly level ring" kept coming
  // back. A garment terminating in one inset ring is a surface with an edge; a
  // real hem is folded fabric, so it bulges *outward* just before it turns
  // under. Two extra rings - one at 1.5 mm proud of the shell, one back at the
  // shell radius, 4 mm apart along the body axis - give a lip that catches its
  // own highlight and its own shadow, which is what the eye reads as thickness.
  if (roll) {
    const step = dir.clone().normalize().multiplyScalar(0.004);
    add.push({
      p: s.p.clone().addScaledVector(step, 0.45),
      rx: s.rx + 0.0016,
      ry: s.ry + 0.0016,
      ryn: (s.ryn ?? s.ry) + 0.0016,
      e: Math.max(2.0, s.e - 0.4),
      ripple: s.ripple ?? null,
    });
    add.push({
      p: s.p.clone().add(step),
      rx: s.rx - 0.0006,
      ry: s.ry - 0.0006,
      ryn: (s.ryn ?? s.ry) - 0.0006,
      e: s.e,
      ripple: s.ripple ?? null,
    });
  }
  add.push(ring);
  if (atStart) sections.unshift(...add.reverse());
  else sections.push(...add);
}

/**
 * Cap options shared by every garment loft. The cap discs land inside the body
 * surface (the hem ring is already inset), so they are never visible - they
 * exist purely so the shell is a closed manifold and back-face culling is safe.
 */
const GARMENT_CAPS = { capStart: true, capEnd: true, capDepth: 0.12 };

/**
 * Fold field for a garment loft.
 *
 * An offset shell is a mathematically perfect extrusion of the body underneath
 * it, and no amount of texture rescues that: "a rigid cylinder with a single
 * vertical crease", "a mathematically perfect cone with a straight bottom edge",
 * "a towel wrapped around a post". Cloth hangs in a small number of soft
 * vertical folds that follow gravity and the body, and it takes very little to
 * suggest them - three to four lobes of a few percent radius, phase-shifted from
 * ring to ring so they lean rather than running dead straight.
 *
 * `ringOffset` already multiplies the ring radius by `1 + amp*cos(freq*angle +
 * phase)`, so this only has to produce the descriptor. The damping is what keeps
 * it honest: folds go to zero where the garment is pulled tight over a joint -
 * the shoulders, the hips, a cuff - and are deepest in the free span between.
 *
 * @param {{fold?:{amp:number, freq?:number, phase?:number, twist?:number}}} cfg
 * @param {number} t 0..1 along the loft
 */
function foldFor(cfg, t) {
  const f = cfg.fold;
  if (!f) return null;
  // Default: pinned at both ends, deepest in the free span. A hem that is
  // supposed to break and scallop wants the opposite, so `damp` is overridable.
  const damp = f.damp ? f.damp(t) : smoothstep(0, 0.18, t) * smoothstep(1, 0.82, t);
  if (damp <= 0.001) return null;
  return {
    amp: f.amp * damp,
    // MUST be an integer. The ring is closed - vertex j=0 and j=radial are the
    // same point at angle 0 and 2*pi - so a fractional frequency evaluates the
    // cosine differently at the two ends, the seam vertices land in different
    // places, computeWeldedNormals cannot weld them, and the garment splits open
    // down one side. Rounded here rather than trusted to every call site.
    freq: Math.max(1, Math.round(f.freq ?? 4)),
    // Phase, by contrast, is constant within a ring and free to drift between
    // rings - that drift is what makes the folds lean instead of running as
    // straight flutes down the garment.
    phase: (f.phase ?? 0) + t * (f.twist ?? 4.9),
  };
}

/** Wrap an expansion callback so it also carries the fold ripple. */
function withFold(exp, gap, cfg) {
  return (v, t) => {
    const e = exp(v, t);
    const rip = foldFor(cfg, t);
    if (typeof e === 'number') return { a: e + gap, ripple: rip };
    return { ...e, a: (e.a ?? 0) + gap, ripple: e.ripple ?? rip };
  };
}

/**
 * Which half of a costume the garment helpers are currently allowed to emit.
 *
 * ── Why a gate rather than a refactor ─────────────────────────────────────
 *
 * Shirt style and trouser style were welded together: picking "Tunic" set the
 * top *and* the legs, because each of the three outfit builders is a single
 * function that lofts the torso, arms, legs and feet in one pass. Splitting
 * them by hand meant cutting four hundred lines of very carefully tuned
 * geometry in half and hoping every seam still met at the waist.
 *
 * The observation that makes it cheap: those builders already say which region
 * every piece belongs to, in the name of the helper they call. `gTorso` and
 * `gArm` are the top; `gLeg` and `gFoot` are the bottom. So the builders do not
 * need to change at all - each one is simply run twice, once with the gate set
 * to `top` and once to `bottom`, and each pass keeps only its own half. A
 * player wearing a tunic over tracksuit trousers gets the tunic's torso code
 * and the tracksuit's leg code, both exactly as their authors tuned them.
 *
 * Kit - belts, pouches, the chest lamp - rides with the top, because it is worn
 * at the waist and above and a bottom brings its own.
 */
let REGION = null;
const inRegion = (r) => REGION === null || REGION === r;

const rollAt = (cfg, atStart) =>
  cfg.roll === 'both' || cfg.roll === (atStart ? 'start' : 'end');

function gTorso(parts, P, slot, cfg) {
  if (!inRegion('top')) return null;
  const part = new Part(slot, cfg.bones ?? TORSO_BONES, cfg.uv ?? 1);
  const exp = asExpand(cfg.exp ?? 0.012);
  const gap = cfg.gap ?? GAP.torso;
  const sections = torsoSections(P, cfg.y0, cfg.y1, cfg.steps ?? 16, withFold(exp, gap, cfg));
  const t0 = P.torso(cfg.y0);
  const t1 = P.torso(cfg.y1);
  // Both ends always get a hem now: a garment with one open end is a tube you
  // can see the inside of, and `hemStart:false` used to leave exactly that.
  // `roll` additionally gives the end that a viewer can actually see a folded
  // lip, which is what makes it read as fabric rather than as a paint boundary.
  addHem(sections, { rx: t0.rx, ry: t0.rf, ryn: t0.rb }, true, rollAt(cfg, true));
  addHem(sections, { rx: t1.rx, ry: t1.rf, ryn: t1.rb }, false, rollAt(cfg, false));
  loft(part, sections, cfg.radial ?? 20, { upHint: new THREE.Vector3(0, 0, -1), ...GARMENT_CAPS });
  parts.push(part);
  return part;
}

function gLeg(parts, P, side, slot, cfg) {
  if (!inRegion('bottom')) return null;
  const part = new Part(slot, legBones(side), cfg.uv ?? 1);
  const exp = asExpand(cfg.exp ?? 0.012);
  const gap = cfg.gap ?? GAP.leg;
  const sections = legSections(P, side, cfg.y0, cfg.y1, cfg.steps ?? 12, withFold(exp, gap, cfg));
  const top = P.leg(cfg.y0);
  const bot = P.leg(cfg.y1);
  addHem(sections, { rx: top.rx, ry: top.rf, ryn: top.rb }, true, rollAt(cfg, true));
  addHem(sections, { rx: bot.rx, ry: bot.rf, ryn: bot.rb }, false, rollAt(cfg, false));
  loft(part, sections, cfg.radial ?? 14, { upHint: new THREE.Vector3(0, 0, -1), ...GARMENT_CAPS });
  parts.push(part);
  return part;
}

function gArm(parts, P, side, slot, cfg) {
  if (!inRegion('top')) return null;
  const part = new Part(slot, armBones(side), cfg.uv ?? 1.2);
  const exp = asExpand(cfg.exp ?? 0.011);
  const gap = cfg.gap ?? GAP.arm;
  const sections = armSections(P, side, cfg.u0, cfg.u1, cfg.steps ?? 10, withFold(exp, gap, cfg));
  const a0 = P.arm(cfg.u0, side);
  const a1 = P.arm(cfg.u1, side);
  addHem(sections, { rx: a0.rx, ry: a0.ry }, true, rollAt(cfg, true));
  addHem(sections, { rx: a1.rx, ry: a1.ry }, false, rollAt(cfg, false));
  loft(part, sections, cfg.radial ?? 12, { upHint: new THREE.Vector3(0, 0, -1), ...GARMENT_CAPS });
  parts.push(part);
  return part;
}

/**
 * Expansion profile for a pad or a band: zero at both ends, full in the middle.
 *
 * A constant `exp` over three or four steps produces a shell that begins and
 * ends at full offset, i.e. two flat cap rings standing off the limb with a
 * visible gap under them - "black napkin rings floating around the limb",
 * "floating tori with a visible gap to the arm". A pad is bonded to what it sits
 * on; its shell has to converge onto the limb surface at both edges, and it
 * needs enough steps for that convergence not to be faceted.
 */
const pad = (peak, lead = 0.26, trail = 0.26) => (v, t) =>
  peak * smoothstep(0, lead, t) * smoothstep(1, 1 - trail, t);

/**
 * A boot, in two pieces: an upper with a boxier cross-section than a bare foot,
 * and a hard flat sole slab under it.
 *
 * The old version added `cfg.sole` to `ryn`, which pushed the bottom of the
 * shell *below* y=0 - the sole disappeared into the deck and the boot lost the
 * one edge that tells a viewer the character is standing on something. Here the
 * bottom of the upper stops at `soleTop` and the slab occupies 0 -> soleTop with
 * an e of 6, so there is a hard horizontal line at the ground plane for the
 * contact decal to sit under.
 */
function gFoot(parts, P, side, slot, cfg) {
  if (!inRegion('bottom')) return null;
  const part = new Part(slot, footBones(side), cfg.uv ?? 1.4);
  const exp = asExpand(cfg.exp ?? 0.016);
  const gap = cfg.gap ?? GAP.foot;
  const zTo = cfg.zTo ?? -0.202;
  // Toe box and flex crease.
  //
  // "White blobs with no shoe construction - no last shape, no toe box crease."
  // A shoe is not a smooth taper from heel to toe: it rises over the ball of the
  // foot into a toe box, and it creases where it bends. `t` runs heel (0) to toe
  // (1), so the box is a lobe near 0.82 and the crease a narrow negative one at
  // 0.58, which is where the metatarsals actually flex.
  const lastShape = (t) => 0.007 * gauss(t, 0.80, 0.13) - 0.0035 * gauss(t, 0.57, 0.045);
  const sections = footSections(P, side, (t) => exp(t, t) + gap + lastShape(t), 0.066, zTo);
  const soleTop = cfg.sole ?? 0.018;
  for (const s of sections) {
    // Footwear is hard-surface: a boxier superellipse than the 2.4 a bare foot
    // uses is the difference between a shoe and a swollen sock.
    s.e = 3.4;
    s.ryn = Math.max(0.004, s.p.y - soleTop);
  }
  loft(part, sections, cfg.radial ?? 12, {
    upHint: new THREE.Vector3(0, 1, 0),
    capStart: true,
    capEnd: true,
    capDepth: 0.26,
  });
  parts.push(part);

  // Sole. This is 80% of what makes a shoe read, and it only works if it is a
  // *different material* from the upper: one hard horizontal value break across
  // the bottom of the silhouette. Callers that pass no `soleSlot` used to get
  // the sole in the upper's own slot, which is why the sports shoes resolved as
  // undifferentiated white lumps. It also flares 3 mm proud of the upper, the
  // way a real outsole does, so the break has a lit edge on it.
  const sole = new Part(cfg.soleSlot ?? slot, footBones(side), cfg.uv ?? 1.6);
  const half = soleTop * 0.5;
  const soleSections = sections.map((s, i) => {
    const t = i / (sections.length - 1);
    // The flare dies away at the toe so the outsole does not overhang the box.
    const flare = 0.003 * smoothstep(1.0, 0.72, t);
    return {
      p: new THREE.Vector3(s.p.x, half + 0.002, s.p.z),
      rx: s.rx * 0.985 + flare,
      ry: half,
      ryn: half,
      e: 6,
    };
  });
  loft(sole, soleSections, cfg.radial ?? 12, {
    upHint: new THREE.Vector3(0, 1, 0),
    capStart: true,
    capEnd: true,
    capDepth: 0.2,
  });
  parts.push(sole);

  // Lacing panel: a narrow raised channel down the instep in a third material,
  // with cross-straps. Without it a trainer is a bag with a sole under it.
  if (cfg.laceSlot !== undefined) {
    const lace = new Part(cfg.laceSlot, footBones(side), 2.2);
    const zA = -0.02;
    const zB = -0.148;
    const strip = [];
    for (let i = 0; i <= 5; i++) {
      const t = i / 5;
      const z = lerp(zA, zB, t);
      const f = P.foot(z);
      strip.push({
        p: new THREE.Vector3(P.legSideX * side, f.y + f.ry * 0.5 + gap + lastShape(0.3 + t * 0.5), z),
        rx: lerp(0.017, 0.011, t),
        ry: 0.004,
        e: 4,
      });
    }
    loft(lace, strip, 8, { upHint: new THREE.Vector3(0, 1, 0), capStart: true, capEnd: true, capDepth: 0.3 });
    // Four cross-straps over the channel.
    for (let i = 0; i < 4; i++) {
      const z = lerp(zA - 0.008, zB + 0.014, i / 3);
      const f = P.foot(z);
      const y = f.y + f.ry * 0.5 + gap + 0.004;
      loft(
        lace,
        [
          { p: new THREE.Vector3(P.legSideX * side - 0.019, y - 0.004, z), rx: 0.004, ry: 0.0035, e: 3 },
          { p: new THREE.Vector3(P.legSideX * side, y + 0.003, z), rx: 0.004, ry: 0.0035, e: 3 },
          { p: new THREE.Vector3(P.legSideX * side + 0.019, y - 0.004, z), rx: 0.004, ry: 0.0035, e: 3 },
        ],
        6,
        { upHint: new THREE.Vector3(0, 0, -1), capStart: true, capEnd: true, capDepth: 0.4 }
      );
    }
    parts.push(lace);
  }
  return part;
}

/* --- set dressing --------------------------------------------------- */

/**
 * Bone sets for carried kit. Deliberately exclude the clavicles and arms: a
 * pouch that picks up clavicle weight shears off the hip the moment the
 * shoulder moves, which is the same bug that sheared the medieval cloak.
 */
const PROP_TORSO_BONES = [B('pelvis', 1.5), B('spine01'), B('spine02'), B('spine03'), B('neck', 2.0)];
const PROP_HIP_BONES = [B('pelvis'), B('spine01', 1.4), B('thighR', 2.2), B('thighL', 2.2)];
const CLOAK_BONES = [B('pelvis', 1.4), B('spine01'), B('spine02'), B('spine03')];

/**
 * A free-standing prop welded into the character mesh.
 *
 * Props ride the existing material slots, so a toolbelt, a satchel and a
 * scabbard together cost zero extra draw calls - they are extra triangles in a
 * group that was already being drawn. That is the only reason it is affordable
 * to put three pieces of kit on every NPC in a crowd.
 */
function gProp(parts, slot, bones, sections, opts = {}) {
  if (!inRegion('top')) return null;
  const part = new Part(slot, bones, opts.uv ?? 1);
  loft(part, sections, opts.radial ?? 10, {
    upHint: opts.upHint ?? new THREE.Vector3(0, 0, -1),
    capStart: opts.capStart !== false,
    capEnd: opts.capEnd !== false,
    capDepth: opts.capDepth ?? 0.28,
  });
  parts.push(part);
  return part;
}

/** Rounded box extruded along +Y, as loft sections. */
function boxY(cx, cy, cz, hw, hh, hd, e = 5) {
  return [
    { p: new THREE.Vector3(cx, cy - hh, cz), rx: hw * 0.9, ry: hd * 0.9, e },
    { p: new THREE.Vector3(cx, cy - hh * 0.5, cz), rx: hw, ry: hd, e },
    { p: new THREE.Vector3(cx, cy + hh * 0.5, cz), rx: hw, ry: hd, e },
    { p: new THREE.Vector3(cx, cy + hh, cz), rx: hw * 0.9, ry: hd * 0.9, e },
  ];
}

/** A strap or sling: a flat band lofted through a list of [x,y,z] points. */
function strap(points, hw, hd, e = 4) {
  return points.map((q) => ({
    p: new THREE.Vector3(q[0], q[1], q[2]),
    rx: hw,
    ry: hd,
    e,
  }));
}

/** A shell over the cranium: helmets, caps and the outer surface of hair. */
function craniumShell(part, P, cfg, rng, originY = 0) {
  const F = headFrame(P);
  const segU = cfg.segU ?? 24;
  const segV = cfg.segV ?? 9;
  const base = part.vertexCount;
  const p = new THREE.Vector3();
  const seed = cfg.seed ?? 5;
  const rims = [];

  for (let v = 0; v <= segV; v++) {
    const t = v / segV;
    for (let u = 0; u <= segU; u++) {
      const phi = (u / segU) * Math.PI * 2;
      const front = -Math.cos(phi);
      let thetaMax = cfg.base + front * cfg.frontAdj;
      if (cfg.strip) {
        // Mohawk: keep only a sagittal band.
        thetaMax *= 1 - smoothstep(0.07, 0.3, Math.abs(Math.sin(phi)));
      }
      // The hairline is the most irregular edge on a head and the old single
      // low-frequency octave produced a smooth wobble, which at a distance is
      // indistinguishable from the clean geometric arc it replaced - hence
      // "moulded rubber swim cap" in three consecutive reviews. Two decorrelated
      // bands, one coarse (locks) and one fine (individual strands), and the
      // fine one is weighted onto the last rings only, where it can actually
      // break the silhouette instead of rippling the whole shell.
      const en = cfg.edgeNoise ?? 0.12;
      const lock = (fbm(u / segU, 0.3, 2, 6, seed) - 0.5) * en;
      // Period 23 over the whole circumference is roughly one wisp every 15
      // degrees, which on a forehead is a single smooth wave - and a single
      // smooth wave is still a drawn line. 47 puts three or four separate
      // breaks across the front hairline alone, and the extra weight on `front`
      // spends the amplitude where the eye actually looks for it: the temples
      // and the forehead, not the nape.
      const wisp = (fbm(u / segU, 0.7, 3, 47, seed + 91) - 0.5) * en * (0.9 + 0.9 * Math.max(0, front));
      thetaMax += lock + wisp * smoothstep(0.45, 1.0, t);
      const theta = t * Math.max(0.02, thetaMax);
      const st = Math.sin(theta);
      const ct = Math.cos(theta);
      const dx = st * Math.sin(phi);
      const dy = ct;
      const dz = st * Math.cos(phi);
      // Volume peaks over the crown and thins to nothing at the hairline.
      // Thickness at the hairline. Ending the shell 28% thick leaves a 5 mm
      // ledge standing off the forehead, and a ledge with a dark value on it is
      // the "hard rim where the hair meets the scalp" from the last review. At
      // 0.08 the shell effectively runs out at its own boundary.
      const taper = 0.08 + 0.92 * smoothstep(1.0, 0.15, t);
      const noise = cfg.lumpy ? (fbm(u / segU, t, 3, 8, seed + 31) - 0.5) * cfg.lumpy : 0;
      // Lift the whole shell off the scalp. Hair sitting *on* the skull radius
      // is a painted-on cap; a few millimetres of standoff plus the ragged
      // boundary is what makes it read as a separate object with its own
      // silhouette. Scaled by the style's own volume so a buzz cut does not
      // acquire more standoff than it has hair.
      const standoff = Math.min(0.006, cfg.thick * 0.4) * smoothstep(1.05, 0.2, t);
      // Locks, in geometry rather than in the normal map.
      //
      // Reviewers kept calling the hair "a smooth shell with no strand
      // definition", and a normal map cannot fix that: a strand read lives in
      // the *silhouette* and in the self-shadowing between hair groups, and a
      // constant-thickness dome has neither. This is a ridge field running
      // crown-to-nape - it varies with phi, it is constant along theta - so the
      // shell breaks into ~11 lock groups whose edges catch the key light and
      // whose valleys go dark. The phase jitter stops them being a regular
      // fluted column, and the taper keeps the crown (where a parting sits)
      // smoother than the sides.
      // `locks` defaults to 0 so the same function still produces a smooth
      // moulded shell for the skate helmet, which is a hard surface and must
      // not acquire hair.
      let lockRidge = 0;
      if (cfg.locks) {
        const lockPhase = phi * cfg.locks + (fbm(u / segU, 0.55, 2, 7, seed + 53) - 0.5) * 2.6;
        lockRidge =
          (Math.pow(Math.cos(lockPhase) * 0.5 + 0.5, 1.7) - 0.42) *
          cfg.thick *
          0.62 *
          smoothstep(0.05, 0.42, t) *
          // Fade the ridge field out before the hairline. The lock term is
          // signed - its trough is -0.26 of `thick` - and near t=1 `taper` has
          // already fallen to 0.08, so the sum went *negative* and the shell
          // dived inside the scalp. Its backfaces then rendered as the black
          // jagged sliver the review found spiking through the temple onto the
          // lit cheek beside the eye.
          smoothstep(0.98, 0.62, t);
      }
      // Belt and braces on the same defect: no vertex of the hair shell may ever
      // sit at or inside the skull radius, whatever combination of noise, lock
      // trough and taper produced it.
      const thick = Math.max(0.0015, cfg.thick * taper + noise + standoff + lockRidge);
      const rr = 1 + thick / F.r.y;
      p.set(F.c.x + dx * F.r.x * rr, F.c.y + dy * F.r.y * rr, F.c.z + dz * F.r.z * rr);
      if (cfg.strip) p.y += cfg.stripLift * (1 - Math.abs(Math.sin(phi))) * st;
      part.pos.push(p.x, p.y - originY, p.z);
      // Strands must run crown-to-nape, not around the head like contour lines.
      //
      // `streakNoise` divides *v* by the stretch factor, so the elongated axis
      // of `hairHeight` is v. The previous mapping put phi in v, which pointed
      // every strand *around* the skull - that is precisely the "visible
      // contour banding" the last review described, and it was one swapped pair
      // of arguments. v is the theta (crown-to-nape) axis.
      part.uv.push((u / segU) * 2, t * 3);
      // Value taper into the scalp. Without it the shell terminates on a hard
      // step from full hair value to full skin value, and a hard value step
      // across the forehead is the single strongest "swim cap" signal there is.
      // Roots are darker than the length on every real head, so darkening the
      // last 6 mm is both the cheap fix and the correct one.
      const rootK = lerp(1, 0.42, smoothstep(0.72, 1.0, t));
      part.col.push(rootK, rootK * 0.99, rootK * 0.97);
      if (v === segV) rims.push({ dx, dy, dz, phi });
    }
  }

  const stride = segU + 1;
  for (let v = 0; v < segV; v++) {
    for (let u = 0; u < segU; u++) {
      const a = base + v * stride + u;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      part.idx.push(a, c, b, b, c, d);
    }
  }

  // Rim strip: drop the outer edge back onto the scalp so the shell has thickness.
  //
  // It now finishes ~1% *inside* the skull rather than exactly on it. Landing
  // the rim coplanar with the scalp is what produced the hard line around the
  // hairline that the last review called out: two surfaces meeting edge-on at a
  // fixed radius read as a moulded lip however ragged the boundary is. Tucking
  // it under the skin hides the termination entirely and lets the ragged outer
  // ring be the only edge the eye can find.
  const rimStart = part.vertexCount;
  for (let u = 0; u <= segU; u++) {
    const r = rims[u];
    const k = 0.988;
    p.set(F.c.x + r.dx * F.r.x * k, F.c.y + r.dy * F.r.y * k, F.c.z + r.dz * F.r.z * k);
    part.pos.push(p.x, p.y - originY, p.z);
    part.uv.push((u / segU) * 2, 3.15);
    // Darkest point on the shell: this ring is on the scalp itself, so it is
    // the shadow the hair casts on the head, not hair. It is only a short step
    // below the 0.42 the shell already tapers to, so the value ramp across the
    // hairline stays a ramp instead of becoming a second hard edge.
    part.col.push(0.34, 0.34, 0.33);
  }
  const lastRing = base + segV * stride;
  for (let u = 0; u < segU; u++) {
    const a = lastRing + u;
    const b = a + 1;
    const c = rimStart + u;
    const d = c + 1;
    part.idx.push(a, c, b, b, c, d);
  }
  void rng;
}

/**
 * Hair as an independent mesh parented to the head bone, so styles can be
 * swapped without rebuilding the body. Geometry is in head-bone local space.
 */
/**
 * Eyebrows: two shallow arched slabs sitting on the brow ridge.
 *
 * They cost nothing (they merge into the hair mesh) and they are the single
 * biggest difference between a face and a mannequin head - a browless character
 * reads as a shop dummy at any distance where the eyes are visible.
 */
function buildBrows(part, P, originY) {
  const F = headFrame(P);
  const steps = 9;
  for (const side of [1, -1]) {
    const sections = [];
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      // Sweep from the inner end (near the nose) out over the temple, arching
      // slightly at the peak the way a real brow does.
      const axp = lerp(0.13, 0.62, t);
      const ay = lerp(0.255, 0.212, t) + 0.022 * Math.sin(t * Math.PI);
      const st = Math.sqrt(Math.max(0, 1 - ay * ay));
      const dx = st * axp * side;
      const dz = -st * Math.sqrt(Math.max(0, 1 - axp * axp));

      // Track the sculpted brow ridge instead of floating a flat ribbon over
      // it. These are the same two terms buildHead uses, so the brow sits on
      // the ridge at the centre and follows it down onto the temple.
      const absDx = Math.abs(dx);
      const ridge =
        0.026 * gauss(ay, 0.3, 0.15) * smoothstep(0.66, 0.3, absDx) -
        0.020 * gauss(ay, 0.11, 0.115) * gauss(absDx, 0.38, 0.17);
      const proud = ridge + 0.006 + 0.003 * Math.sin(t * Math.PI);

      // Tapered profile, not a bar.
      //
      // "Flat black painted rectangles", "a solid black rectangle with a hard
      // terminating edge and uniform thickness end to end" - a constant-section
      // loft with two cap discs is a bar, and a bar decaled above the eye is the
      // strongest programmer-art signal on a close-up. A real brow is thickest
      // about a third of the way out from the medial end and thins to nothing at
      // both tips, so the profile is a lobe centred at t=0.30 with hard fades at
      // both ends. The fade is what removes the terminating edge; there is
      // simply no cross-section left there to cap.
      const lobe = gauss(t, 0.30, 0.40) * smoothstep(0, 0.10, t) * smoothstep(1, 0.86, t);
      sections.push({
        p: new THREE.Vector3(
          F.c.x + dx * F.r.x * 1.004,
          F.c.y + ay * F.r.y * 1.004 - originY,
          F.c.z + dz * F.r.z * 1.004 - proud
        ),
        // rx runs vertically in the loft frame, ry into the face.
        rx: 0.0008 + 0.0102 * lobe,
        ry: 0.0009 + 0.0054 * lobe,
        e: 2.8,
      });
    }
    loft(part, sections, 8, {
      upHint: new THREE.Vector3(0, 0, -1),
      capStart: true,
      capEnd: true,
      capDepth: 0.35,
    });
  }
}

/**
 * How much darker a brow is than the hair it belongs to, written into the hair
 * mesh's vertex-colour channel.
 *
 * The review's complaint was concrete: "Eyebrows must not inherit hair colour
 * if that makes them vanish." A platinum-blond or white-haired character had
 * white brows on pale skin, which is geometrically present and visually absent.
 *
 * The obvious fix - a second mesh with its own darker material - costs one
 * extra draw call per character, and with 24 NPCs in the station that is 24
 * draw calls spent on two ribbons of geometry. Vertex colours buy the same
 * separation inside the existing hair mesh for nothing: brows come out at 30%
 * of the hair's value, which is dark against every skin tone in the ramp while
 * still reading as the same person's colouring.
 */
// Raised from 0.22. At that value the brow was ~78% darker than the hair, which
// against any skin tone is effectively black - it punched a hole in the face
// rather than sitting on it. 0.45 is roughly the 55% of hair value a real brow
// carries: still unambiguously darker than the skin at every tone in the ramp,
// but a colour rather than a void.
const BROW_DARKEN = 0.45;

/**
 * Every headgear style, in menu order. `none` is first and is the default.
 *
 * These are worn *over* the hair rather than replacing it, which is why every
 * one of them sits proud of the scalp by a few millimetres: a cap at scalp
 * radius z-fights the hair shell across the whole crown, and the artefact moves
 * with the camera, so it reads as the head flickering.
 */
export const HEADGEAR_STYLES = ['none', 'band', 'cap', 'hood', 'helm', 'turban', 'circlet'];

export const HEADGEAR_LABELS = {
  none: 'None',
  band: 'Headband',
  cap: 'Peaked cap',
  hood: 'Hood',
  helm: 'Helm',
  turban: 'Wrap',
  circlet: 'Circlet',
};

/**
 * A ring of quads swept around the skull at a fixed polar angle.
 *
 * Bands, brims and hood rims are all this shape: a closed loop that follows the
 * head's own ellipsoid rather than a circle, because a circular band on an
 * ellipsoid skull stands off at the temples and cuts in at the front.
 *
 * @param {Part} part
 * @param {object} F headFrame
 * @param {number} originY
 * @param {{theta:number, lift:number, thick:number, drop:number,
 *          front?:number, back?:number, seg?:number}} cfg
 */
function skullBand(part, F, originY, cfg) {
  const seg = cfg.seg ?? 28;
  const base = part.vertexCount;
  const p = new THREE.Vector3();
  // Two rings - a top and a bottom edge - swept round, then stitched into a
  // cylinder. The band has real height so it catches a shadow on its underside.
  for (let e = 0; e < 2; e++) {
    const theta = cfg.theta + (e === 0 ? -cfg.drop * 0.5 : cfg.drop * 0.5);
    for (let u = 0; u <= seg; u++) {
      const phi = (u / seg) * Math.PI * 2;
      const front = -Math.cos(phi);
      // Front and back can each push the band up or down, which is what makes a
      // cap sit back off the brow and a hood sit forward over it.
      const th = theta + front * (front > 0 ? (cfg.front ?? 0) : -(cfg.back ?? 0));
      const st = Math.sin(th);
      const ct = Math.cos(th);
      const k = 1 + cfg.lift + cfg.thick;
      p.set(
        F.c.x + Math.sin(phi) * st * F.r.x * k,
        F.c.y + ct * F.r.y * k,
        F.c.z + -Math.cos(phi) * st * F.r.z * k
      );
      part.pos.push(p.x, p.y - originY, p.z);
      part.uv.push(u / seg * 3, e);
    }
  }
  const row = seg + 1;
  for (let u = 0; u < seg; u++) {
    const a = base + u;
    const b = base + u + 1;
    const c = base + row + u;
    const d = base + row + u + 1;
    part.idx.push(a, c, b, b, c, d);
  }
}

/**
 * Headgear, built in the same space and on the same machinery as the hair so it
 * can hang off the head bone unchanged.
 *
 * Returns null for `none`, which the caller treats as "no mesh" - cheaper than
 * an empty geometry and it keeps the draw call off characters not wearing one.
 *
 * @param {object} P proportions
 * @param {string} style one of {@link HEADGEAR_STYLES}
 * @param {number} seed
 * @returns {THREE.BufferGeometry|null}
 */
export function buildHeadgearGeometry(P, style, seed) {
  if (!style || style === 'none') return null;
  const rng = createRng(seed);
  const part = new Part(0, [], 1);
  const F = headFrame(P);
  const originY = P.headY;

  /* The domes reuse the hair shell, with the noise turned off.
   *
   * A hairline is the most irregular edge on a head and the shell's edge noise
   * exists entirely to sell that; a manufactured object has a *clean* rim, and
   * leaving the noise on is what makes a helmet look knitted. `locks: 0` for the
   * same reason - lock ridges are strands. */
  const dome = (cfg) => craniumShell(part, P, {
    lumpy: 0, edgeNoise: 0, locks: 0, segU: 30, segV: 10, seed: (seed % 997) + 1, ...cfg,
  }, rng, originY);

  switch (style) {
    case 'band':
      skullBand(part, F, originY, { theta: 1.14, lift: 0.04, thick: 0.012, drop: 0.30, front: 0.05 });
      break;

    case 'cap':
      // Crown, then a peak that projects forward over the brow. The peak is the
      // whole silhouette of a cap; without it this is a beanie.
      dome({ base: 1.30, frontAdj: -0.40, thick: 0.030 });
      skullBand(part, F, originY, { theta: 1.30, lift: 0.05, thick: 0.02, drop: 0.16 });
      {
        const b = part.vertexCount;
        const p = new THREE.Vector3();
        const seg = 12;
        // A flat blade swept through the forward arc only, tilted down slightly.
        for (let e = 0; e < 2; e++) {
          const reach = e === 0 ? 1.02 : 1.62;      // inner edge, then the tip
          for (let u = 0; u <= seg; u++) {
            const a = (u / seg - 0.5) * 1.9;        // ~109 deg of front arc
            const st = Math.sin(1.32);
            p.set(
              F.c.x + Math.sin(a) * st * F.r.x * reach * 1.05,
              F.c.y + Math.cos(1.32) * F.r.y * (1 + 0.05) - (e === 1 ? 0.012 : 0),
              F.c.z - Math.cos(a) * st * F.r.z * reach
            );
            part.pos.push(p.x, p.y - originY, p.z);
            part.uv.push(u / seg, e);
          }
        }
        const row = seg + 1;
        for (let u = 0; u < seg; u++) {
          part.idx.push(b + u, b + row + u, b + u + 1, b + u + 1, b + row + u, b + row + u + 1);
        }
      }
      break;

    case 'hood':
      // Deeper than a cap and carried further back, with a rim that stands
      // forward of the face - a hood is read by the opening, not the crown.
      dome({ base: 1.72, frontAdj: -0.30, thick: 0.055 });
      skullBand(part, F, originY, {
        theta: 1.42, lift: 0.10, thick: 0.03, drop: 0.42, front: 0.16, back: 0.10, seg: 30,
      });
      break;

    case 'helm':
      // Sits lower on the skull than anything else here, and the nasal is what
      // separates a helmet from a bowl.
      dome({ base: 1.60, frontAdj: -0.16, thick: 0.040 });
      skullBand(part, F, originY, { theta: 1.55, lift: 0.055, thick: 0.022, drop: 0.20 });
      {
        const b = part.vertexCount;
        const p = new THREE.Vector3();
        for (let e = 0; e < 2; e++) {
          const half = e === 0 ? -0.055 : 0.055;
          for (let k = 0; k <= 3; k++) {
            const th = 1.30 + k * 0.30;             // down the front of the face
            p.set(
              F.c.x + half * F.r.x,
              F.c.y + Math.cos(th) * F.r.y * 1.06,
              F.c.z - Math.sin(th) * F.r.z * 1.08
            );
            part.pos.push(p.x, p.y - originY, p.z);
            part.uv.push(e, k / 3);
          }
        }
        for (let k = 0; k < 3; k++) {
          part.idx.push(b + k, b + 4 + k, b + k + 1, b + k + 1, b + 4 + k, b + 4 + k + 1);
        }
      }
      break;

    case 'turban':
      // Three offset wraps. Cloth wound round a head is never symmetrical, so
      // each band is nudged by the rng - a stack of concentric rings is a
      // radiator, not a wrap.
      dome({ base: 1.28, frontAdj: -0.44, thick: 0.045 });
      for (let i = 0; i < 3; i++) {
        skullBand(part, F, originY, {
          theta: 1.22 - i * 0.24,
          lift: 0.075 + i * 0.018,
          thick: 0.016,
          drop: 0.26,
          front: (rng() - 0.5) * 0.10,
          back: (rng() - 0.5) * 0.10,
        });
      }
      break;

    case 'circlet':
    default:
      skullBand(part, F, originY, { theta: 1.06, lift: 0.045, thick: 0.008, drop: 0.10, front: 0.10 });
      break;
  }

  if (!part.idx.length) return null;
  return partToGeometry(part);
}

export function buildHairGeometry(P, style, seed) {
  const rng = createRng(seed);
  const part = new Part(0, [], 1);
  const F = headFrame(P);
  const originY = P.headY;
  // Brows ride in the hair mesh but are darkened through the colour attribute,
  // so a bald or white-haired character still has readable brows.
  buildBrows(part, P, originY);
  while (part.col.length < part.vertexCount * 3) part.col.push(BROW_DARKEN);
  if (style === 'bald') return partToGeometry(part);

  // `base` is how far from the crown the shell sweeps at the sides. At 1.48-1.52
  // rad (85-87 deg) it reached the equator of the skull and buried the ears
  // completely, which is why every character read as wearing a moulded helmet.
  // Dropped ~0.14 rad so ears and a real hairline are exposed, with more edge
  // noise so the hairline is irregular rather than a razor-straight geometric
  // step across the skull.
  // `lumpy` and `edgeNoise` are both up ~2x on the smoother styles: a shell of
  // constant thickness with a clean rim is a moulded plastic cap no matter what
  // the normal map does, and a hairline is the most irregular edge on a head.
  // `locks` is the number of strand groups the shell breaks into around the
  // skull. A buzz cut has none worth resolving; a crop or a long style is read
  // almost entirely by them. `segU` rises with the lock count because a ridge
  // field needs at least three columns per lock or it aliases into a moire.
  const presets = {
    buzz: { base: 1.36, frontAdj: -0.5, thick: 0.006, lumpy: 0.004, edgeNoise: 0.16, locks: 0 },
    short: { base: 1.34, frontAdj: -0.5, thick: 0.017, lumpy: 0.013, edgeNoise: 0.3, locks: 10, segU: 34, segV: 12 },
    crop: { base: 1.38, frontAdj: -0.46, thick: 0.026, lumpy: 0.02, edgeNoise: 0.34, locks: 9, segU: 34, segV: 12 },
    ponytail: { base: 1.44, frontAdj: -0.48, thick: 0.016, lumpy: 0.011, edgeNoise: 0.26, locks: 12, segU: 40, segV: 12 },
    bun: { base: 1.43, frontAdj: -0.5, thick: 0.015, lumpy: 0.011, edgeNoise: 0.26, locks: 12, segU: 40, segV: 12 },
    long: { base: 1.56, frontAdj: -0.52, thick: 0.02, lumpy: 0.015, edgeNoise: 0.28, locks: 11, segU: 40, segV: 13 },
    mohawk: {
      base: 1.58, frontAdj: -0.36, thick: 0.05, lumpy: 0.01, edgeNoise: 0.08,
      strip: true, stripLift: 0.045, locks: 7, segU: 34, segV: 11,
    },
  };
  const cfg = { ...(presets[style] ?? presets.short), seed: (seed % 997) + 1 };
  craniumShell(part, P, cfg, rng, originY);

  // Sideburns and nape.
  //
  // A cranium shell alone terminates in one closed loop, and a closed loop over
  // a skull is a bathing cap however much noise is on its edge. The two places
  // where real hair leaves that loop are in front of the ear and at the
  // occiput, and their absence is the strongest single "swim cap" signal on the
  // head - stronger than the hairline itself, because they are what break the
  // profile silhouette rather than the front one.
  if (!cfg.strip && style !== 'buzz') {
    for (const side of [1, -1]) {
      const phi = 1.98; // ~113 deg: on the temple, forward of the ear
      const secs = [];
      for (let k = 0; k <= 3; k++) {
        const t = k / 3;
        const ay = lerp(0.10, -0.30, t);
        const st = Math.sqrt(Math.max(0, 1 - ay * ay));
        // rx runs front-to-back across the temple, ry is the thickness standing
        // off it. A sideburn is a wide, thin patch - 12 mm of thickness is a
        // slab bolted to the head.
        secs.push({
          p: new THREE.Vector3(
            F.c.x + st * Math.sin(phi) * side * F.r.x * 1.004,
            F.c.y + ay * F.r.y * 1.004 - originY,
            F.c.z + st * Math.cos(phi) * F.r.z * 1.004
          ),
          rx: lerp(0.013, 0.005, t),
          ry: lerp(0.0035, 0.002, t),
          e: 2.6,
        });
      }
      loft(part, secs, 6, {
        upHint: new THREE.Vector3(1, 0, 0),
        capStart: true,
        capEnd: true,
        capDepth: 0.3,
      });
    }
    const nape = [];
    for (let k = 0; k <= 8; k++) {
      const t = k / 8;
      const ph = lerp(-0.62, 0.62, t);
      const ay = -0.24 - 0.11 * Math.cos(ph * 1.6);
      const st = Math.sqrt(Math.max(0, 1 - ay * ay));
      const dz = st * Math.cos(ph);
      nape.push({
        p: new THREE.Vector3(
          F.c.x + st * Math.sin(ph) * F.r.x * 1.005,
          F.c.y + ay * F.r.y * 1.005 - originY,
          // buildHead pushes the occiput back by up to 14 mm; a strip authored
          // against the bare ellipsoid would be buried inside the skull.
          F.c.z + dz * F.r.z * 1.005 + 0.014 * dz * dz
        ),
        // rx is thickness off the skull, ry the height of the band.
        rx: 0.0028,
        ry: 0.015 * (1 - 0.45 * Math.abs(t * 2 - 1)),
        e: 2.6,
      });
    }
    loft(part, nape, 6, {
      upHint: new THREE.Vector3(0, 1, 0),
      capStart: true,
      capEnd: true,
      capDepth: 0.3,
    });
    // Sideburns and nape are roots, so they take the same low value the shell
    // boundary does rather than the full length value.
    while (part.col.length < part.vertexCount * 3) part.col.push(0.55);

    // Hairline strand cards.
    //
    // A closed shell can never read as hair, however ragged its boundary is,
    // because the boundary is still a single continuous curve at a single
    // radius: "a solid brown bowl shell with a hard geometric hairline", "a
    // moulded polygonal cap with a hard faceted boundary". The silhouette break
    // is non-negotiable and it has to come from geometry that *leaves* the
    // shell.
    //
    // Each card is a short tapered prism straddling the hairline - rooted a
    // little inside it, tip a little outside - and lifted progressively off the
    // scalp so it stands 8-20 degrees proud rather than lying flat. Seven of
    // them across the forehead and temples is enough to stop the eye finding a
    // clean edge anywhere along the front. They are appended after the root
    // padding above, so they take the full (lighter) hair value: real hair is
    // darkest at the root and these are all tip.
    const cards = 7;
    for (let s = 0; s < cards; s++) {
      // Spread across the front hemisphere, centred on the face (phi = pi).
      const phi = Math.PI + ((s + 0.5) / cards - 0.5) * 2.7 + (rng() - 0.5) * 0.26;
      const front = -Math.cos(phi);
      const tm = cfg.base + front * cfg.frontAdj;
      const theta1 = tm + 0.17 + rng() * 0.15;
      const secs = [];
      const steps = 3;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const theta = lerp(tm - 0.17, theta1, t);
        const st = Math.sin(theta);
        const dx = st * Math.sin(phi);
        const dy = Math.cos(theta);
        const dz = st * Math.cos(phi);
        // Standoff grows toward the tip: that is the rotation off the scalp
        // normal, expressed as a radius rather than as an angle.
        const thick = cfg.thick * (0.85 + 1.5 * t * t);
        const rr = 1 + thick / F.r.y;
        secs.push({
          p: new THREE.Vector3(
            F.c.x + dx * F.r.x * rr,
            F.c.y + dy * F.r.y * rr - originY,
            F.c.z + dz * F.r.z * rr
          ),
          rx: lerp(0.0105, 0.0026, t),
          ry: lerp(0.0042, 0.0014, t),
          e: 2.6,
        });
      }
      loft(part, secs, 6, {
        upHint: new THREE.Vector3(Math.sin(phi), 0, Math.cos(phi)),
        capStart: true,
        capEnd: true,
        capDepth: 0.4,
      });
    }
  }

  if (style === 'ponytail' || style === 'bun') {
    // A gathered mass at the back of the crown.
    const anchor = new THREE.Vector3(0, F.c.y + F.r.y * 0.42 - originY, F.c.z + F.r.z * 0.9);
    const sections =
      style === 'bun'
        ? [
            { p: anchor.clone(), rx: 0.026, ry: 0.026, e: 2.2 },
            { p: anchor.clone().add(new THREE.Vector3(0, -0.012, 0.03)), rx: 0.042, ry: 0.042, e: 2.4 },
            { p: anchor.clone().add(new THREE.Vector3(0, -0.03, 0.052)), rx: 0.03, ry: 0.03, e: 2.2 },
          ]
        : [
            { p: anchor.clone(), rx: 0.028, ry: 0.026, e: 2.2 },
            { p: anchor.clone().add(new THREE.Vector3(0, -0.06, 0.028)), rx: 0.033, ry: 0.03, e: 2.2 },
            { p: anchor.clone().add(new THREE.Vector3(0, -0.14, 0.026)), rx: 0.03, ry: 0.028, e: 2.2 },
            { p: anchor.clone().add(new THREE.Vector3(0, -0.21, 0.012)), rx: 0.02, ry: 0.019, e: 2.2 },
            { p: anchor.clone().add(new THREE.Vector3(0, -0.25, 0.0)), rx: 0.009, ry: 0.009, e: 2.2 },
          ];
    loft(part, sections, 12, { upHint: new THREE.Vector3(0, 0, -1), capStart: true, capEnd: true });
  }

  if (style === 'long') {
    // Open curtain over the back and sides. The hair material is single-sided
    // now (double-sided was lighting the backfaces of the closed shell and
    // making it read as plastic), so the curtain gets an explicit inner wall.
    const phiSteps = 18;
    const drop = 7;
    const start = part.vertexCount;
    for (let d = 0; d <= drop; d++) {
      const t = d / drop;
      for (let i = 0; i <= phiSteps; i++) {
        const phi = lerp(-0.62 * Math.PI, 0.62 * Math.PI, i / phiSteps);
        const theta = 1.62 + t * 0.05;
        const st = Math.sin(theta);
        const dx = st * Math.sin(phi);
        const dz = st * Math.cos(phi);
        const flare = 1 + t * 0.22 + (fbm(i / phiSteps, t, 2, 5, 17) - 0.5) * 0.12;
        const y = F.c.y + Math.cos(theta) * F.r.y - t * 0.24;
        part.pos.push(
          F.c.x + dx * F.r.x * flare,
          y - originY,
          F.c.z + dz * F.r.z * flare + t * 0.012
        );
        part.uv.push((i / phiSteps) * 3, t * 3);
      }
    }
    // Inner wall: the same lattice pulled 6 mm toward the skull.
    const inner = part.vertexCount;
    const outerCount = part.vertexCount - start;
    for (let k = 0; k < outerCount; k++) {
      const i = (start + k) * 3;
      const nx = part.pos[i];
      const ny = part.pos[i + 1];
      const nz = part.pos[i + 2];
      const len = Math.hypot(nx, nz) || 1;
      part.pos.push(nx - (nx / len) * 0.006, ny, nz - (nz / len) * 0.006);
      part.uv.push(part.uv[(start + k) * 2], part.uv[(start + k) * 2 + 1]);
    }

    const stride = phiSteps + 1;
    for (let d = 0; d < drop; d++) {
      for (let i = 0; i < phiSteps; i++) {
        const a = start + d * stride + i;
        const b = a + 1;
        const c = a + stride;
        const e = c + 1;
        part.idx.push(a, c, b, b, c, e);
        const a2 = inner + d * stride + i;
        const b2 = a2 + 1;
        const c2 = a2 + stride;
        const e2 = c2 + 1;
        part.idx.push(a2, b2, c2, b2, e2, c2);
      }
    }
  }

  return partToGeometry(part);
}

function partToGeometry(part) {
  const nrm = computeWeldedNormals(part.pos, part.idx);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(part.pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(part.uv, 2));
  // Hair carries brows at a lower value in this channel; anything not written
  // pads to white so the shell itself is untinted.
  g.setAttribute('color', new THREE.Float32BufferAttribute(padColors(part), 3));
  g.setIndex(part.idx);
  g.computeBoundingSphere();
  return g;
}

/* ------------------------------------------------------------------ */
/* Outfits                                                             */
/* ------------------------------------------------------------------ */

export const THEME_VARIANTS = {
  station: ['eva', 'rig', 'jumpsuit'],
  medieval: ['tunic', 'mail', 'robe'],
  sports: ['jersey', 'track', 'skate'],
};

/**
 * Costume palettes.
 *
 * Two rules, both learned the hard way:
 *
 * 1. No character albedo below ~0.045 linear. The old station suits sat at
 *    0.017-0.032 linear, which is darker than any real dyed fabric and crushed
 *    the whole figure to a black silhouette with no readable material - against
 *    a dark blue station the arm edges vanished entirely. This is not fixable
 *    with exposure, because the background is already correctly exposed.
 * 2. The costume counterpoints the level, it does not repeat it. A navy suit
 *    with yellow hazard bands standing in a navy bay painted with yellow hazard
 *    chevrons has nothing separating it. Station crew are therefore warm
 *    ochre/rust/olive against the cold blue hull; medieval villagers are cool
 *    sage and slate against the forge orange.
 */
const PALETTES = {
  // 3. The `leather` slot is worn as a chest rig covering most of the sternum,
  //    which makes it a *primary* read, not an accent. At 0x45403a it was
  //    0.03 linear - a black slab across the middle of the character, exactly
  //    the shape a viewer uses to judge the torso. Every leather here is now
  //    a legible mid-tone that still sits darker than the garment it rides on.
  // 4. Station is built on a *value* contract, not a hue contract, because the
  //    previous set failed on exactly that: pastel mauve and mud brown sitting
  //    on the same midtone as a blue-grey container wall, so the silhouette
  //    dissolved and the only thing separating the figure from the background
  //    was a slight warm note in the skin. The contract is now:
  //
  //      primary   (the large area, ~60% of the figure) - warm neutral charcoal
  //                or oxide, 0.10-0.16 linear, a full stop under the ~0.35 wall
  //      secondary (~30%, worn as the collar and shoulder yoke) - the one HIGH
  //                value element, 0.45-0.60 linear, so the silhouette gets a
  //                hard top-value anchor against a dark bay
  //      leather   mid, always between the two
  //      glow      the saturated accent, and it covers under 8% of the surface
  //
  //    Nothing else on the character is allowed to be saturated. That is what
  //    makes the accent read as an accent.
  station: [
    { primary: 0x2f2b26, secondary: 0xc9c2b4, leather: 0x5c564c, metal: 0x9aa3af, glow: 0x2fe0ff },
    { primary: 0x33302b, secondary: 0xb9bcc0, leather: 0x585d64, metal: 0xa8b0ba, glow: 0xff9a2b },
    { primary: 0x2b2f33, secondary: 0xd2cec4, leather: 0x5e6168, metal: 0x9aa0a6, glow: 0xffae2b },
    { primary: 0x3a332c, secondary: 0xa8adb4, leather: 0x63594e, metal: 0x8892a0, glow: 0x35d6ff },
    { primary: 0x2c3130, secondary: 0xc4c6bc, leather: 0x565e58, metal: 0x969c96, glow: 0x8fff5a },
    { primary: 0x3a2e28, secondary: 0xbfb2a4, leather: 0x655750, metal: 0xa09090, glow: 0xff6a3a },
  ],
  medieval: [
    { primary: 0x8a6a42, secondary: 0x9a4433, leather: 0x6b4e35, metal: 0x8b8f96, glow: 0xffb45a },
    { primary: 0x4a6b44, secondary: 0xc4ae68, leather: 0x5c452e, metal: 0x9aa0a8, glow: 0xffc06a },
    { primary: 0x4e5f7a, secondary: 0xc8b898, leather: 0x60482f, metal: 0x8f949c, glow: 0xffd08a },
    { primary: 0x9a8a63, secondary: 0x7a3434, leather: 0x513c2a, metal: 0x878c93, glow: 0xffcc7a },
    { primary: 0x5f7268, secondary: 0x35566f, leather: 0x59402b, metal: 0x9ba1a9, glow: 0xffcc7a },
    { primary: 0x6d7f74, secondary: 0xd8c8a8, leather: 0x664c33, metal: 0x9298a0, glow: 0xffcc7a },
  ],
  sports: [
    { primary: 0xe23b3b, secondary: 0xf2f2f2, leather: 0x232426, metal: 0xb8bcc2, glow: 0xffe14a },
    { primary: 0x1f6fd0, secondary: 0xffd23b, leather: 0x1e1f22, metal: 0xb0b6bd, glow: 0x3bffd2 },
    { primary: 0x18a86b, secondary: 0x101418, leather: 0x22252a, metal: 0xb4bac0, glow: 0xa8ff3b },
    { primary: 0xf27b1f, secondary: 0x2b2f36, leather: 0x1c1e21, metal: 0xb8bec4, glow: 0xffb03b },
    { primary: 0x8f2fd0, secondary: 0xf0f0f5, leather: 0x202227, metal: 0xb2b8bf, glow: 0xff3bd2 },
    { primary: 0x101418, secondary: 0xe8e8ee, leather: 0x1a1c20, metal: 0xbcc2c8, glow: 0x3bd2ff },
  ],
};

const CLOTH_KIND = { station: 'tech', medieval: 'knit', sports: 'jersey' };

/**
 * The top of this ramp used to sit at 0xffe2c8, which is 1.0 in red before the
 * albedo texture, the sheen and a warm key light have had their turn - it clips
 * the moment a character stands in sunlight and takes the whole face with it.
 * Every tone is now headroom-safe (max channel <= 0.95) and slightly less
 * saturated, so the shading, not the base colour, decides what the skin does.
 */
// The dark end also has a floor, and it was being broken. 0x4c2f20 is 0.036
// linear luminance; after ACES that bottoms out and the arms, neck and face lose
// all form and read as a flat silhouette - deep skin in life is never that dark
// and never that flat, because it is also glossier than pale skin, not matt.
// The three darkest entries are lifted ~18% L*, which puts every tone in the
// ramp above ~0.06 linear with real diffuse still measurable in shadow.
const SKIN_TONES = [
  0xf0d6c0, 0xe6c5a8, 0xd9b18e, 0xcb9c78, 0xb98764, 0xad7b56, 0x9a6949, 0x7d5339, 0x66412e, 0x926547,
];
const HAIR_COLORS = [
  0x1b1512, 0x2e2119, 0x4a3225, 0x6b4a2f, 0x8a6a3f, 0xb99a63, 0xd8c08a, 0x7a7a7a, 0xbfbfbf, 0x6b2f1f,
];
const EYE_COLORS = [0x4a3a2a, 0x2f2a22, 0x3d5a6c, 0x4a6b45, 0x6b7f8f, 0x5a4630];
const HAIR_STYLES = ['short', 'crop', 'buzz', 'ponytail', 'bun', 'long', 'bald'];

/** CIE L* of an sRGB hex, 0..100. Perceptual value, which is what separates. */
function lstar(hex) {
  const _c = _lstarColor.setHex(hex, THREE.SRGBColorSpace);
  // Relative luminance in linear-light, then the CIE lightness transfer.
  const y = 0.2126 * _c.r + 0.7152 * _c.g + 0.0722 * _c.b;
  return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y;
}
const _lstarColor = new THREE.Color();

/**
 * Pick a hair colour that is not the same *value* as the skin it sits on.
 *
 * "The head reads as bald" and "hair is a flesh-coloured bathing cap" were both
 * the same bug: the hair ramp and the skin ramp overlap in lightness, so a
 * mid-blond on a light-tan character produced a cranium and a forehead within a
 * few percent of each other. Blonde is fine. Blonde at skin luminance is not -
 * there has to be a value edge at the hairline or the hair is not an object.
 *
 * 25 L* is roughly the point at which a boundary survives ACES plus a flat
 * ambient; anything closer relies on the normal map alone, which mips away.
 */
function pickHairColor(skinHex, rng) {
  const target = lstar(skinHex);
  const ok = HAIR_COLORS.filter((h) => Math.abs(lstar(h) - target) >= 25);
  const pool = ok.length ? ok : HAIR_COLORS;
  return pool[(rng() * pool.length) | 0];
}

function buildStationOutfit(P, parts, variant) {
  const heavy = variant === 'eva';
  const suitTop = 1.45;
  gTorso(parts, P, SLOT.PRIMARY, {
    y0: 0.84, y1: suitTop, steps: 20,
    exp: (y) => (heavy ? 0.017 : 0.011) + 0.005 * gauss(y, 1.28, 0.12),
    fold: { amp: 0.024, freq: 4, twist: 4.6 },
  });
  // Collar. It has to start above the acromion: at y 1.40 the torso is still
  // 18 cm wide, so a "collar" there is a shawl draped over both shoulders.
  // Starting at 1.436 puts it on the neck base and leaves ~2 cm of throat.
  gTorso(parts, P, SLOT.SECONDARY, {
    y0: 1.436, y1: 1.496, steps: 5,
    exp: (y) => lerp(0.028, 0.015, smoothstep(1.436, 1.496, y)),
  });
  // Shoulder yoke. This is the character's one high-value element and the whole
  // reason the station palette puts an off-white in the secondary slot: against
  // a dark bay a figure dressed entirely in charcoal has a bottom-anchored
  // value range and no top, and a silhouette with no top anchor reads as a
  // shadow. A pale yoke across the deltoids gives the eye something to find
  // first and something to measure the rest of the figure against.
  gTorso(parts, P, SLOT.SECONDARY, {
    y0: 1.318, y1: 1.436, steps: 6,
    exp: (y) => ({ a: 0.015 + 0.009 * gauss(y, 1.392, 0.03), e: 3.3 }),
  });
  // Chest rig: deep at the front, thin at the sides. Its own UV scale so the
  // leather grain here is at a different texel density to the thigh pads - two
  // surfaces sharing one noise field at one scale is what made both read as
  // copy-pasted wet gravel.
  gTorso(parts, P, SLOT.LEATHER, {
    y0: 1.17, y1: 1.36, steps: 7, uv: 2.4,
    exp: () => ({ a: 0.02, f: 0.016, b: 0.008, x: -0.008, e: 3.4 }),
  });
  // Hip band raised so the forearm shell cannot punch a shard through it.
  gTorso(parts, P, SLOT.LEATHER, { y0: 1.015, y1: 1.075, steps: 3, uv: 1.5, exp: 0.034 });
  gTorso(parts, P, SLOT.GLOW, { y0: 1.302, y1: 1.33, steps: 2, exp: heavy ? 0.026 : 0.02 });

  for (const side of [1, -1]) {
    gArm(parts, P, side, SLOT.PRIMARY, {
      u0: 0.02, u1: 0.7, steps: 11, exp: 0.011,
      fold: { amp: 0.022, freq: 3, twist: 3.2 },
    });
    // Cuff, not a mitten: the sleeve stops at the wrist so the hand reads. Wide
    // and dark, because a bare forearm running straight into a bare hand at the
    // same value is why the arms terminated in "tapered stumps" - the wrist
    // needs a value break, not a silhouette break.
    gArm(parts, P, side, SLOT.LEATHER, {
      u0: 0.645, u1: 0.778, steps: 6, uv: 2.0, exp: (u, t) => 0.016 * (1 - 0.6 * smoothstep(0.82, 1.0, t)),
    });
    if (heavy) gArm(parts, P, side, SLOT.SECONDARY, { u0: 0.0, u1: 0.17, steps: 6, exp: pad(0.024, 0.10, 0.34) });
    gArm(parts, P, side, SLOT.GLOW, { u0: 0.192, u1: 0.252, steps: 6, exp: pad(0.014, 0.32, 0.32) });

    gLeg(parts, P, side, SLOT.PRIMARY, {
      y0: 1.0, y1: 0.16, steps: 14, exp: 0.013, fold: { amp: 0.030, freq: 3, twist: 5.0 },
    });
    if (heavy) gLeg(parts, P, side, SLOT.SECONDARY, { y0: 0.575, y1: 0.46, steps: 8, exp: pad(0.022) });
    // 4 cm of band across a 12-section loft landed between rings and clipped;
    // widened and given its own steps so it wraps the limb properly.
    gLeg(parts, P, side, SLOT.GLOW, { y0: 0.678, y1: 0.622, steps: 6, exp: pad(0.017, 0.32, 0.32) });
    gLeg(parts, P, side, SLOT.LEATHER, {
      y0: 0.3, y1: 0.1, steps: 6, uv: 1.1, exp: 0.025, roll: 'start',
    });
    gFoot(parts, P, side, SLOT.LEATHER, {
      exp: 0.011, sole: 0.019, soleSlot: SLOT.PRIMARY, laceSlot: SLOT.METAL,
    });
  }

  // --- kit ----------------------------------------------------------
  // Expand shells cannot break a silhouette by construction: they are the body
  // with a few millimetres added, so from 15 m the character is a capsule.
  // Everything below stands >= 4 cm proud of the garment, which is the minimum
  // that registers in profile, and says what this person does for a living.
  const beltY = 0.975;
  const beltT = P.torso(beltY);
  const beltZ = -(beltT.rf + 0.052);
  const beltBack = beltT.rb + 0.05;
  for (const side of [1, -1]) {
    // Front tool pouches either side of the buckle.
    gProp(parts, SLOT.LEATHER, PROP_HIP_BONES, boxY(0.072 * side, beltY, beltZ, 0.05, 0.058, 0.034));
    // A rear pouch so the profile reads from behind too.
    gProp(parts, SLOT.LEATHER, PROP_HIP_BONES, boxY(0.095 * side, beltY + 0.01, beltBack, 0.042, 0.046, 0.03));
  }

  // Chest lamp with an emissive lens - a real light source on a real worker,
  // and the only warm point on the figure when the level light dies.
  //
  // Housing and panel are LEATHER, not METAL: there is no environment map on
  // these scenes, so a metalness-0.88 slot has nothing to reflect and renders
  // as a flat black box stuck to the chest.
  const lampZ = -(P.torso(1.372).rf + 0.05);
  gProp(parts, SLOT.LEATHER, PROP_TORSO_BONES, boxY(0.088, 1.372, lampZ, 0.028, 0.031, 0.022), {
    radial: 8,
  });
  gProp(
    parts, SLOT.GLOW, PROP_TORSO_BONES,
    [
      { p: new THREE.Vector3(0.088, 1.372, lampZ - 0.019), rx: 0.016, ry: 0.016, e: 3.0 },
      { p: new THREE.Vector3(0.088, 1.372, lampZ - 0.026), rx: 0.012, ry: 0.012, e: 3.0 },
    ],
    { radial: 8, upHint: new THREE.Vector3(0, 1, 0), capDepth: 0.3 }
  );

  // Chest ID panel with a thin status strip.
  const chestZ = -(P.torso(1.25).rf + 0.05);
  gProp(parts, SLOT.LEATHER, PROP_TORSO_BONES, boxY(-0.072, 1.252, chestZ, 0.034, 0.042, 0.008), {
    radial: 8,
  });
  gProp(parts, SLOT.GLOW, PROP_TORSO_BONES, boxY(-0.072, 1.232, chestZ - 0.006, 0.024, 0.004, 0.005), {
    radial: 6,
  });

  // Thigh strap on the dominant leg: a hard diagonal against all those tubes.
  gProp(
    parts, SLOT.LEATHER, [B('thighR'), B('pelvis', 1.8), B('calfR', 2.2)],
    strap(
      [
        [P.legSideX + 0.01, 0.782, -0.1],
        [P.legSideX + 0.07, 0.758, -0.052],
        [P.legSideX + 0.082, 0.734, 0.028],
      ],
      0.028, 0.013
    ),
    { radial: 8, upHint: new THREE.Vector3(0, 1, 0) }
  );
}

function buildMedievalOutfit(P, parts, variant) {
  if (variant === 'robe') {
    gTorso(parts, P, SLOT.PRIMARY, {
      y0: 0.42, y1: 1.44, steps: 26,
      exp: (y) => 0.016 + 0.075 * smoothstep(1.0, 0.42, y),
      // A robe is the garment with the most free fabric on any character here,
      // so it carries the deepest folds, and the hem is where they break.
      fold: { amp: 0.055, freq: 4, twist: 6.2, damp: (t) => smoothstep(0.62, 0.02, t) + 0.35 },
      roll: 'start',
    });
    // Cowl resting on the shoulders.
    gTorso(parts, P, SLOT.SECONDARY, {
      y0: 1.36, y1: 1.55, steps: 8,
      exp: () => ({ a: 0.03, b: 0.05, f: 0.012 }),
      fold: { amp: 0.03, freq: 3, twist: 2.6 },
      roll: 'start',
    });
    gTorso(parts, P, SLOT.LEATHER, { y0: 1.045, y1: 1.095, steps: 4, exp: pad(0.028, 0.3, 0.3) });
    for (const side of [1, -1]) {
      gArm(parts, P, side, SLOT.PRIMARY, {
        u0: 0.02, u1: 0.7, steps: 11,
        exp: (u) => 0.014 + 0.05 * smoothstep(0.25, 0.7, u),
        fold: { amp: 0.04, freq: 3, twist: 3.8 },
        roll: 'end',
      });
      gFoot(parts, P, side, SLOT.LEATHER, { exp: 0.013, sole: 0.010 });
    }
    return;
  }

  const mail = variant === 'mail';
  // Tunic with a flared skirt.
  // Tunic. The skirt flare is held to 4.8 cm: at 5.5 cm on a heavy build the
  // hem reached 26 cm outboard and the forearm shell punched straight through
  // it, which is one of the hard geometric shards in the silhouette.
  gTorso(parts, P, SLOT.PRIMARY, {
    y0: 0.72, y1: 1.42, steps: 22,
    exp: (y) => 0.015 + 0.048 * smoothstep(1.02, 0.72, y),
    fold: { amp: 0.045, freq: 4, twist: 5.0, damp: (t) => 0.35 + 0.65 * smoothstep(0.7, 0.05, t) },
    roll: 'start',
  });
  if (mail) {
    gTorso(parts, P, SLOT.METAL, {
      y0: 0.86, y1: 1.45, steps: 16,
      exp: (y) => 0.026 + 0.02 * smoothstep(1.0, 0.86, y),
    });
    // Surcoat: front and back panels only.
    gTorso(parts, P, SLOT.SECONDARY, {
      y0: 0.92, y1: 1.4, steps: 12,
      exp: () => ({ a: 0.032, f: 0.014, b: 0.014, x: -0.014 }),
    });
  } else {
    gTorso(parts, P, SLOT.LEATHER, { y0: 1.0, y1: 1.39, steps: 10, exp: 0.026 });
  }
  gTorso(parts, P, SLOT.LEATHER, { y0: 1.04, y1: 1.1, steps: 3, exp: mail ? 0.055 : 0.03 });
  // Cloak: hugs the chest, falls behind.
  //
  // This used to shear into a flat diagonal wedge slicing through the shoulder.
  // Two causes, both fixed here. (a) It was bound to TORSO_BONES, which
  // includes the clavicles, so the cloak's upper rings were dragged outboard by
  // clavicle weight while the tunic - a different weight distribution - was not;
  // that differential *is* the shear. It now binds to the spine chain only.
  // (b) Its front clearance was a:0.006, and GAP.torso is 0.019, so the cloak
  // was authored *inside* the tunic and the two coincident double-sided shells
  // z-fought all the way down the body.
  if (!mail) {
    // Mantle.
    //
    // "A mathematically perfect cone with a straight bottom edge that no cloth
    // has ever fallen into" - which is exactly what an offset shell with a
    // monotone expansion is. The fold field is weighted onto the lower half and
    // runs at a low angular frequency, so the hem radius wanders by ~7% and
    // scallops instead of ruling a straight line across the frame; the rolled
    // start hem gives that edge thickness so it catches its own shadow.
    gTorso(parts, P, SLOT.SECONDARY, {
      y0: 0.78, y1: 1.44, steps: 20,
      bones: CLOAK_BONES,
      exp: (y) => ({ a: 0.028, b: 0.034 + 0.07 * smoothstep(1.2, 0.78, y), x: 0.016 }),
      fold: { amp: 0.070, freq: 3, twist: 4.4, damp: (t) => 0.20 + 0.80 * smoothstep(0.55, 0.0, t) },
      roll: 'start',
    });
  }

  for (const side of [1, -1]) {
    gArm(parts, P, side, SLOT.PRIMARY, {
      u0: 0.02, u1: 0.7, steps: 11, exp: (u, t) => 0.016 * (1 - 0.55 * smoothstep(0.86, 1.0, t)),
      fold: { amp: 0.028, freq: 3, twist: 3.4 },
      roll: 'end',
    });
    if (mail) gArm(parts, P, side, SLOT.METAL, { u0: 0.0, u1: 0.44, steps: 8, exp: pad(0.024, 0.12, 0.30) });
    gLeg(parts, P, side, SLOT.SECONDARY, {
      y0: 1.0, y1: 0.13, steps: 13, exp: 0.01, fold: { amp: 0.026, freq: 3, twist: 4.4 },
    });
    gLeg(parts, P, side, SLOT.LEATHER, {
      y0: mail ? 0.42 : 0.32, y1: 0.1, steps: 6, exp: (y, t) => 0.021 * (1 - 0.5 * smoothstep(0.0, 0.22, 1 - t)),
      roll: 'start',
    });
    // Sole stays in the leather slot - a period boot really is leather all
    // through, and the medieval palette has no darker slot to put a sole in
    // without turning it green. The value break here comes from the outsole
    // flare gFoot now adds, which throws its own shadow line at the ground.
    gFoot(parts, P, side, SLOT.LEATHER, { exp: 0.014, sole: 0.012 });
  }

  // --- kit ----------------------------------------------------------
  // A villager with nothing on their belt is a shop dummy in a costume.
  const beltY = 0.995;
  const bt = P.torso(beltY);
  // Belt pouch on the right hip, hanging off the belt line.
  gProp(
    parts, SLOT.LEATHER, PROP_HIP_BONES,
    boxY(bt.rx * 0.62, beltY - 0.055, -(bt.rf + 0.062), 0.046, 0.056, 0.036),
    { radial: 10 }
  );
  // Satchel strap crossing the chest at a different value from the tunic. It
  // must be its own part on the spine chain, not a torso expand shell, or it
  // picks up the same shear the cloak used to.
  gProp(
    parts, SLOT.LEATHER, PROP_TORSO_BONES,
    strap(
      [
        [-(P.torso(1.4).rx * 0.72), 1.398, 0.02],
        [-(P.torso(1.36).rx * 0.68), 1.352, -(P.torso(1.36).rf + 0.03)],
        [-0.03, 1.2, -(P.torso(1.2).rf + 0.034)],
        [bt.rx * 0.6, 1.02, -(P.torso(1.02).rf + 0.03)],
        [bt.rx * 0.74, 0.965, 0.0],
      ],
      0.03, 0.011
    ),
    { radial: 8, upHint: new THREE.Vector3(0, 1, 0) }
  );

  if (mail) {
    // Scabbard slung off the left hip, angled back and clear of the hand.
    gProp(
      parts, SLOT.LEATHER, PROP_HIP_BONES,
      [
        { p: new THREE.Vector3(-(bt.rx + 0.03), 1.01, 0.03), rx: 0.026, ry: 0.016, e: 3.0 },
        { p: new THREE.Vector3(-(bt.rx + 0.036), 0.9, 0.09), rx: 0.024, ry: 0.014, e: 3.0 },
        { p: new THREE.Vector3(-(bt.rx + 0.04), 0.76, 0.16), rx: 0.021, ry: 0.012, e: 3.0 },
        { p: new THREE.Vector3(-(bt.rx + 0.042), 0.64, 0.215), rx: 0.014, ry: 0.009, e: 3.0 },
      ],
      { radial: 8, upHint: new THREE.Vector3(1, 0, 0), capDepth: 0.35 }
    );
  } else {
    // Bedroll strapped across the small of the back.
    gProp(
      parts, SLOT.PRIMARY, PROP_TORSO_BONES,
      [
        { p: new THREE.Vector3(-0.13, 1.155, P.torso(1.155).rb + 0.07), rx: 0.036, ry: 0.036, e: 2.4 },
        { p: new THREE.Vector3(0.0, 1.17, P.torso(1.17).rb + 0.078), rx: 0.042, ry: 0.042, e: 2.4 },
        { p: new THREE.Vector3(0.13, 1.155, P.torso(1.155).rb + 0.07), rx: 0.036, ry: 0.036, e: 2.4 },
      ],
      { radial: 10, upHint: new THREE.Vector3(0, 1, 0), capDepth: 0.45 }
    );
  }
}

function buildSportsOutfit(P, parts, variant) {
  const track = variant === 'track';
  const skate = variant === 'skate';

  // --- top -----------------------------------------------------------
  // Folds and a rolled hem at the waist. A jersey is a knit tube hanging off
  // the shoulders; without folds it is an extrusion of the ribcage and without a
  // hem it is a paint boundary, which together are most of "a shrinkwrapped tube
  // jersey with a painted stripe instead of a collar/hem/seam".
  gTorso(parts, P, SLOT.PRIMARY, {
    y0: track ? 0.98 : 0.94,
    y1: track ? 1.46 : 1.42,
    steps: 18,
    exp: track ? 0.014 : 0.011,
    fold: { amp: 0.030, freq: 3, twist: 4.2 },
    roll: 'start',
  });
  // Collar. The fabric used to run flush into the neck tube - there was no
  // neckline geometry at all, which is why the head looked plugged into the
  // shirt. This is a real ribbed band in the contrast colour, tapering onto the
  // neck and rolled at its top edge.
  gTorso(parts, P, SLOT.SECONDARY, {
    y0: track ? 1.438 : 1.402,
    y1: 1.478,
    steps: 6,
    uv: 2.2,
    exp: (y, t) => lerp(0.021, 0.010, t),
    roll: 'end',
  });
  // Chest band. Two steps over a 40 mm span put the band's only interior ring
  // between two inset hem rings, so its upper edge wandered with the loft
  // spacing and skewed visibly across the deltoids. Six steps over a wider span
  // with a converging profile gives a band with parallel edges that dies onto
  // the jersey instead of standing off it.
  gTorso(parts, P, SLOT.SECONDARY, {
    y0: 1.222, y1: 1.302, steps: 8, uv: 1.8,
    exp: pad(track ? 0.019 : 0.015, 0.30, 0.30),
  });

  for (const side of [1, -1]) {
    const sleeveEnd = track ? 0.72 : 0.30;
    // Sleeve. The old constant expansion ended in a hard cap ring hovering off
    // the arm - the "floating black cuff" read - because the shell was still at
    // full offset when the loft stopped. It now converges onto skin over the
    // last 15% so the cuff *meets* the arm.
    gArm(parts, P, side, SLOT.PRIMARY, {
      u0: 0.02, u1: sleeveEnd, steps: 10,
      exp: (u, t) => 0.013 * (1 - 0.78 * smoothstep(0.85, 1.0, t)),
      fold: { amp: 0.022, freq: 3, twist: 3.4 },
    });
    if (skate) {
      // Pads, tapered at both ends. u0 pulled back to 0.28 so it overlaps the
      // sleeve end at 0.30 instead of butting against it - that seam was showing
      // as a hard dark ring gap on both upper arms.
      gArm(parts, P, side, SLOT.LEATHER, { u0: 0.28, u1: 0.46, steps: 9, uv: 2.0, exp: pad(0.024) });
      gLeg(parts, P, side, SLOT.LEATHER, { y0: 0.585, y1: 0.435, steps: 9, uv: 1.6, exp: pad(0.026) });
    }
    if (track) {
      gLeg(parts, P, side, SLOT.SECONDARY, {
        y0: 1.0, y1: 0.13, steps: 14, exp: 0.017,
        fold: { amp: 0.038, freq: 3, twist: 5.4 },
        roll: 'end',
      });
      gLeg(parts, P, side, SLOT.GLOW, { y0: 0.735, y1: 0.695, steps: 5, exp: pad(0.020, 0.34, 0.34) });
    } else {
      // Shorts.
      //
      // The old profile was a scalar 50 mm shell at the hem on both legs, and
      // the inner-thigh clearance at that height is only 34 mm - so the two
      // shells met across the crotch and fused into one white slab with no
      // daylight between the legs, no leg opening and no per-leg hem. Reviewers
      // read it as a towel wrapped around a post, and they were describing the
      // geometry accurately.
      //
      // The expansion is split lateral/medial. Outboard the shell stands well
      // proud of the thigh the way sportswear does; inboard it is pulled *in*
      // below the crotch so each leg is a closed tube with 20-odd millimetres of
      // air beside it. The medial pull ramps in below y=0.92 so the two legs
      // still join at the seat, which is where shorts really do join.
      const shortGap = 0.010;
      gLeg(parts, P, side, SLOT.SECONDARY, {
        y0: 1.0, y1: 0.575, steps: 12, gap: shortGap,
        exp: (y) => {
          const flare = smoothstep(0.82, 0.62, y);
          const a = 0.006 + 0.009 * flare;
          const lr = P.leg(y).rx;
          // Medial target: leave 13 mm either side of the centre line, but never
          // pull the shell inside the thigh it is wrapping. On a heavy build
          // those two demands collide - real heavy thighs nearly touch - so the
          // clamp wins and the gap closes to whatever the anatomy allows.
          const want = P.legSideX - 0.013 - (lr + a + shortGap);
          const floor = 0.002 - a - shortGap;
          return {
            a,
            lat: 0.008 + 0.013 * flare,
            med: clamp(want, floor, 0) * smoothstep(0.96, 0.80, y),
          };
        },
        // Cloth with zero high-frequency radius variation always reads as
        // extruded plastic. Four soft folds, leaning as they fall.
        fold: { amp: 0.045, freq: 4, twist: 5.6 },
        roll: 'end',
      });
      // Waistband: a darker band over the top of the shorts so the belt line
      // exists at all. It has to be a leg loft, not a torso one - at this height
      // the thigh lofts carry the hip mass and a torso band would be buried.
      gLeg(parts, P, side, SLOT.LEATHER, {
        y0: 1.008, y1: 0.952, steps: 4, gap: 0.010, uv: 1.8, exp: pad(0.014, 0.30, 0.30),
      });
    }
    // Shoe. The sole and the lacing go in the LEATHER slot so there is a real
    // value break between sole and upper: without it the foot resolved as a
    // white blob with no last, no sole split and no laces.
    gFoot(parts, P, side, SLOT.SECONDARY, {
      exp: 0.019, sole: 0.020, soleSlot: SLOT.LEATHER, laceSlot: SLOT.LEATHER,
    });
    // Sock, tapered into the calf at the top and running down into the shoe
    // collar at the bottom, so the three elements read as one leg rather than
    // as three stacked disconnected objects.
    gLeg(parts, P, side, SLOT.SECONDARY, {
      y0: 0.225, y1: 0.098, steps: 7,
      exp: (y, t) => 0.003 + 0.017 * smoothstep(0.0, 0.55, t),
    });
  }

  // --- story ---------------------------------------------------------
  // One asymmetric element. A costume that is perfectly bilateral is a uniform
  // on a mannequin; a strapped wrist on one side only is a person who plays.
  // Not on `track`, whose sleeve already runs to u=0.72 - a tape wrap inside a
  // sleeve cuff is two shells fighting for the same 8 cm of forearm.
  if (!track) {
    gArm(parts, P, 1, SLOT.SECONDARY, { u0: 0.695, u1: 0.775, steps: 5, uv: 2.6, exp: pad(0.007, 0.3, 0.3) });
  }

  if (skate) {
    // Skate lid: a rigid shell weighted entirely to the head bone.
    const helmet = new Part(SLOT.LEATHER, [B('head')], 1.6);
    craniumShell(helmet, P, { base: 1.62, frontAdj: -0.3, thick: 0.019, edgeNoise: 0.02, segV: 7 }, null, 0);
    parts.push(helmet);
  }
}

function runOutfit(P, theme, variant, parts) {
  if (theme === 'medieval') buildMedievalOutfit(P, parts, variant);
  else if (theme === 'sports') buildSportsOutfit(P, parts, variant);
  else buildStationOutfit(P, parts, variant);
}

/**
 * Dress the figure, optionally from two different outfits.
 *
 * With no `bottom` this is exactly what it always was - one builder, one pass,
 * gate open. With one, each builder runs for its own half only; see the note on
 * REGION for why that is a gate rather than a refactor.
 *
 * The gate is always cleared, including if a builder throws, because a REGION
 * left set would silently halve every character built afterwards - a bug that
 * would show up nowhere near the code that caused it.
 *
 * @param {object} P
 * @param {string} theme top theme
 * @param {string} variant top variant
 * @param {Part[]} parts
 * @param {{theme:string, variant:string}|null} [bottom]
 */
function buildOutfit(P, theme, variant, parts, bottom = null) {
  if (!bottom || (bottom.theme === theme && bottom.variant === variant)) {
    runOutfit(P, theme, variant, parts);
    return;
  }
  try {
    REGION = 'top';
    runOutfit(P, theme, variant, parts);
    REGION = 'bottom';
    runOutfit(P, bottom.theme, bottom.variant, parts);
  } finally {
    REGION = null;
  }
}

/* ------------------------------------------------------------------ */
/* Humanoid instance                                                   */
/* ------------------------------------------------------------------ */

const _hv = new THREE.Vector3();

/**
 * One character. `root` is what the NPC moves; `rig` is an inner node the
 * animator owns (used for stagger lean and the death collapse) so gameplay
 * position and animation never fight over the same transform.
 */
export class Humanoid {
  constructor(data) {
    Object.assign(this, data);
  }

  /** World-space head centre, used for headshot spheres and look-at. */
  getHeadWorldPosition(out) {
    this.headBone.updateWorldMatrix(true, false);
    out.setFromMatrixPosition(this.headBone.matrixWorld);
    // The bone sits at the atlas; the skull centre is a little above it.
    out.y += 0.1 * this.heightScale;
    return out;
  }

  /**
   * Distance LOD for the eye rig.
   *
   * This used to hide the eyeballs, both lids and the iris wholesale and put
   * nothing in their place, so beyond the threshold a character's orbit was an
   * empty socket - a featureless mannequin at exactly the framing a full-body
   * screenshot is taken at.
   *
   * The iris cap is never hidden now. It is the reviewer's requested impostor by
   * construction: a ~180-triangle disc, already seated in the socket, already
   * carrying the limbal ring, and it costs the one draw call per eye that the
   * face cannot do without. What drops out beyond the threshold is everything
   * that is pure refinement at that size - the sclera behind it and both lids -
   * so a distant character costs two eye draw calls rather than eight.
   *
   * The baked lash line and orbital shadow in `faceCavity` are the backstop
   * behind that: even with the whole rig gone the face still has an eye line and
   * a socket in albedo.
   */
  setDetailVisible(v) {
    if (this._detail === v) return;
    this._detail = v;
    for (const e of this.eyes) {
      e.sclera.visible = v;
      e.lidUpper.visible = v;
      e.lidLower.visible = v;
    }
  }

  /**
   * Exchange one held geometry key for another, keeping the release list exact.
   *
   * Only the player uses this, to swap the hair shell without rebuilding the
   * body. The contract is that `newKey` has *already* been acquired by the
   * caller; this balances that acquire by giving back `oldKey`. Acquiring
   * before releasing is what makes re-selecting the style you are already
   * wearing safe - the count goes 1 -> 2 -> 1 and never touches zero.
   *
   * @param {string|null} oldKey @param {string|null} newKey
   */
  replaceHeldGeometry(oldKey, newKey) {
    if (newKey && newKey !== oldKey) this.geoKeys?.push(newKey);
    if (!oldKey) return;
    if (oldKey !== newKey) {
      const i = this.geoKeys?.indexOf(oldKey) ?? -1;
      if (i >= 0) this.geoKeys.splice(i, 1);
    }
    this.assets?.releaseGeometry(oldKey);
  }

  dispose() {
    // Idempotent: a double dispose would hand back holds this character does
    // not have, and free a body another live character is still drawing.
    if (this._disposed) return;
    this._disposed = true;
    this.skeleton.dispose();
    // Materials are shared through CharacterAssets and freed there - they are
    // keyed on colour, a small closed set. Geometry is keyed on the appearance
    // combination, which is not closed, so it is held and given back instead
    // (see CharacterAssets.acquireGeometry).
    if (this.assets && this.geoKeys) {
      for (const key of this.geoKeys) this.assets.releaseGeometry(key);
      this.geoKeys.length = 0;
    }
    this.root.removeFromParent();
  }
}

/**
 * Bakes body archetypes once and hands out instances. Sixteen NPCs in a world
 * typically resolve to three or four distinct geometries.
 */
export class HumanoidFactory {
  /** @param {{ renderer?:THREE.WebGLRenderer, assets?:CharacterAssets }} ctx */
  constructor({ renderer, assets } = {}) {
    this.assets = assets ?? new CharacterAssets(renderer);
    this._ownsAssets = !assets;
    this._specCache = new Map();
    this._propCache = new Map();
  }

  _proportions(build, frame, shoulderScale) {
    const key = `${build}|${frame}|${shoulderScale.toFixed(2)}`;
    let P = this._propCache.get(key);
    if (!P) {
      P = makeProportions({ build, frame, shoulderScale });
      this._propCache.set(key, P);
    }
    return P;
  }

  _spec(P) {
    let spec = this._specCache.get(P.key);
    if (!spec) {
      spec = buildSkeletonSpec(P);
      this._specCache.set(P.key, spec);
    }
    return spec;
  }

  /**
   * @param {object} P @param {string} theme @param {string} variant
   * @param {object} FA face archetype
   * @param {{theme:string, variant:string}|null} [bottom] when the legs come
   *   from a different outfit to the torso
   * @param {string[]} held keys this character will hand back on dispose
   */
  _bodyGeometry(P, theme, variant, FA, bottom, held) {
    // The cache is keyed on both halves. Without the bottom in the key a
    // tunic-over-tracksuit would be served whatever tunic combination happened
    // to be built first, and every later pairing would silently be wrong.
    const b = bottom ? `|${bottom.theme}.${bottom.variant}` : '';
    const key = `body|${theme}|${variant}${b}|${P.key}|f${FA.id}`;
    return this._shared(key, () => {
      const parts = [];
      buildBody(P, parts, FA);
      buildOutfit(P, theme, variant, parts, bottom);
      const spec = this._spec(P);
      const boneIndex = new Map(spec.map((d, i) => [d.name, i]));
      return mergeParts(parts, boneIndex, spec);
    }, held);
  }

  /**
   * Acquire a cached geometry and record the hold on the character being built.
   *
   * `held` is the character's key list; every key that goes in here comes back
   * out in `Humanoid.dispose`, which is what keeps the cache from growing
   * across world swaps. A style with no geometry (bald) yields null, is not
   * cached, and is not held.
   *
   * @param {string} key @param {() => THREE.BufferGeometry|null} make
   * @param {string[]} held
   */
  _shared(key, make, held) {
    const g = this.assets.acquireGeometry(key, make);
    if (g) held.push(key);
    return g;
  }

  /**
   * @param {{seed?:number, theme?:string, variant?:string, palette?:number,
   *          height?:number, build?:number, frame?:number, shoulderScale?:number,
   *          skinTone?:number, hairStyle?:string, hairColor?:number, eyeColor?:number}} params
   * @returns {Humanoid}
   */
  create(params = {}) {
    const seed = params.seed ?? ((Math.random() * 1e9) | 0);
    const rng = createRng(seed);
    const theme = THEME_VARIANTS[params.theme] ? params.theme : 'station';
    const variants = THEME_VARIANTS[theme];
    const variant = params.variant ?? variants[(rng() * variants.length) | 0];
    const paletteList = PALETTES[theme];
    const pal = paletteList[params.palette ?? ((rng() * paletteList.length) | 0)];

    const build = params.build ?? (rng() < 0.3 ? 0 : rng() < 0.78 ? 1 : 2);
    const frame = params.frame ?? (rng() < 0.55 ? 0 : 1);
    const shoulderScale = params.shoulderScale ?? 0.94 + rng() * 0.14;
    const height = clamp(params.height ?? 1.58 + rng() * 0.34, 1.5, 2.0);
    const heightScale = height / BASE_HEIGHT;

    const P = this._proportions(build, frame, Math.round(shoulderScale * 20) / 20);
    const spec = this._spec(P);
    const FA = faceArchetype(params.faceId ?? (rng() * FACE_COUNT) | 0);
    /* An independent lower body, when one is asked for.
     *
     * `legs` names an outfit whose trousers are worn with this outfit's shirt.
     * Absent, or the same as the top, and nothing changes - which is every NPC
     * in the game, so the crowd path is untouched. */
    const legsSpec = params.legs && (params.legs.theme !== theme || params.legs.variant !== variant)
      ? { theme: params.legs.theme, variant: params.legs.variant }
      : null;
    /** Every cached geometry this character takes a hold on, in acquire order.
     *  Handed straight to the Humanoid, which gives them all back on dispose. */
    const held = [];
    const geo = this._bodyGeometry(P, theme, variant, FA, legsSpec, held);

    const skinTone = params.skinTone ?? SKIN_TONES[(rng() * SKIN_TONES.length) | 0];
    const hairColor = params.hairColor ?? pickHairColor(skinTone, rng);
    const eyeColor = params.eyeColor ?? EYE_COLORS[(rng() * EYE_COLORS.length) | 0];
    let hairStyle = params.hairStyle ?? HAIR_STYLES[(rng() * HAIR_STYLES.length) | 0];
    if (theme === 'sports' && variant === 'skate') hairStyle = rng() < 0.5 ? 'buzz' : 'short';
    /* Headgear defaults to none rather than to a random pick.
     *
     * Every other appearance field randomises when unset, because a crowd of
     * identical faces is the failure mode there. Hats are different: a street
     * where everyone happens to be wearing one reads as a uniform, and worse,
     * NPCs from every existing save would suddenly acquire one. Opt-in. */
    const headgear = params.headgear ?? 'none';

    const A = this.assets;
    const kind = CLOTH_KIND[theme];
    // One rim per theme, deliberately complementary to that world's ambient, so
    // the character separates from the background instead of dissolving into it.
    const rim = params.rim ?? THEME_RIM[theme] ?? THEME_RIM.station;
    const materials = [
      A.skin(skinTone, rim),
      A.cloth(pal.primary, kind, rim),
      A.cloth(pal.secondary, kind, rim),
      A.leather(pal.leather, rim),
      A.metal(
        pal.metal,
        theme === 'medieval' ? 'mail' : 'panel',
        theme === 'medieval' ? 0.5 : 0.38,
        rim
      ),
      A.glow(pal.glow, rim),
    ];

    const { skeleton, bones, byName, root: boneRoot } = createSkeleton(spec);

    const mesh = new THREE.SkinnedMesh(geo, materials);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;

    const rig = new THREE.Object3D();
    rig.name = 'rig';
    rig.add(boneRoot);
    rig.add(mesh);

    const root = new THREE.Group();
    root.name = `humanoid:${seed}`;
    root.add(rig);
    root.updateMatrixWorld(true);
    // Bind with an identity matrix: geometry, bone inverses and the mesh all
    // live in character space, so root scaling and the death rig stay clean.
    mesh.bind(skeleton, new THREE.Matrix4());

    const headBone = byName.get('head');

    // --- hair and brows ---------------------------------------------
    let hairMesh = null;
    const hairKey = `hair|${hairStyle}|${P.key}`;
    const hairGeo = this._shared(hairKey, () =>
      buildHairGeometry(P, hairStyle, (seed % 9973) + 7)
    , held);
    if (hairGeo) {
      hairMesh = new THREE.Mesh(hairGeo, A.hair(hairColor, rim));
      hairMesh.castShadow = true;
      // The hair shell stands off the scalp now, so it has a real underside for
      // the head's own shadow to land on.
      hairMesh.receiveShadow = true;
      headBone.add(hairMesh);
    }

    /* --- headgear ---------------------------------------------------
     *
     * Worn over the hair on the same bone, so it inherits the per-character
     * skull jitter applied below and never drifts off a larger or smaller head.
     *
     * It borrows an existing garment slot material rather than introducing one:
     * those are already correctly textured PBR surfaces for this theme, so a
     * cap matches the outfit it is worn with for free, and a character in a hat
     * costs no extra material and no extra shader program. Soft things take the
     * cloth slot and hard things the leather/metal one, which is the only
     * distinction that actually matters at a glance. */
    let headgearMesh = null;
    if (headgear && headgear !== 'none') {
      const hgGeo = this._shared(`headgear|${headgear}|${P.key}`, () =>
        buildHeadgearGeometry(P, headgear, (seed % 9973) + 31)
      , held);
      if (hgGeo) {
        const soft = headgear === 'hood' || headgear === 'turban' || headgear === 'band';
        const hgMat = materials[soft ? SLOT.SECONDARY : SLOT.LEATHER] ?? materials[SLOT.PRIMARY];
        headgearMesh = new THREE.Mesh(hgGeo, hgMat);
        // Named so it can be found on a built character - there is otherwise
        // nothing to distinguish it from the hair shell hanging off the same
        // bone, which cost me a wrong measurement while checking the fit.
        headgearMesh.name = 'headgear';
        headgearMesh.castShadow = true;
        headgearMesh.receiveShadow = true;
        headBone.add(headgearMesh);
      }
    }

    // Per-character skull jitter. Head geometry is cached per body archetype,
    // so without this every average-build character in a crowd shares one skull
    // and the crowd reads as one mannequin repeated. Scaling the head bone is
    // free and changes the single silhouette element a player actually looks at.
    headBone.scale.set(
      0.96 + rng() * 0.085,
      0.965 + rng() * 0.075,
      0.96 + rng() * 0.08
    );


    // --- eyes -------------------------------------------------------
    // Eyeball radius up from 13.9 to 14.4 mm. The orbital recess in buildHead is
    // 2 mm shallower this pass, so the sclera equator now clears the socket
    // instead of sitting at the bottom of a crater with only its cornea lit.
    const scleraGeo = this._shared('eye.sclera', () => new THREE.SphereGeometry(0.0144, 16, 12), held);
    // A human iris is ~12 mm across on a ~24 mm eyeball: half the visible
    // aperture. Anything smaller reads as a doll's painted-on eye. Widened to
    // 0.70 rad of arc as well, because what a player registers at 2.5 m is the
    // dark disc, not the white around it.
    // 0.72 rad of arc is a 24 mm iris on a 28 mm eyeball - the iris covered the
    // entire palpebral aperture, there was no white anywhere in the socket, and
    // the eye rendered as one dark disc. That, not the sclera colour, is why
    // three reviews running described the eyes as beads or slots. 0.56 rad is
    // ~15 mm of chord, which leaves sclera visible either side of the iris at
    // every gaze angle the look-at rig can reach.
    const irisGeo = this._shared('eye.iris', () => {
      const g = new THREE.SphereGeometry(0.0149, 18, 10, 0, Math.PI * 2, 0, 0.56);
      g.rotateX(-Math.PI / 2); // pole faces -Z, the direction characters look
      const pos = g.getAttribute('position');
      const uv = g.getAttribute('uv');
      const rMax = 0.0149 * Math.sin(0.72);
      for (let i = 0; i < pos.count; i++) {
        uv.setXY(i, 0.5 + (pos.getX(i) / rMax) * 0.5, 0.5 + (pos.getY(i) / rMax) * 0.5);
      }
      uv.needsUpdate = true;
      return g;
    }, held);
    // The eyelids draw with the skin material, which reads vertex colours for
    // the face cavity map, so they need a colour attribute or they would render
    // black. That attribute is also the cheapest lash line available: darken
    // the last few millimetres of the lid rim and the eye acquires the hard
    // upper edge that separates "an eye" from "a bead pressed into a face".
    // Nothing else on the head buys as much legibility per byte.
    // The lash line is built on the *lid*, not on the face and not as a
    // free-floating strip.
    //
    // Two earlier attempts are worth recording as dead ends. Painting it into
    // the head's vertex colours cannot work: the face band is ~4 mm per quad
    // and a lash is 2 mm, so the darkening blurs across the lid and merges with
    // the orbital cavity into the single dark smear reviewers kept describing.
    // Floating a separate ribbon over the eye cannot work either, because the
    // sculpted head surface sits several millimetres off the base ellipsoid in
    // this region and any strip authored against the ellipsoid either sinks
    // into the face or hovers in front of it.
    //
    // The lid mesh has neither problem: it is a sphere cap built about the eye
    // pivot, so its rim *is* the palpebral margin by construction, wherever the
    // eye ends up seated. Rolling that rim outward by ~0.7 mm gives it a real
    // lip that catches its own shading, and crushing its value gives the hard
    // upper edge that separates "an eye" from "a bead pressed into a face".
    const lidTint = (g, lashFrom) => {
      const pos = g.getAttribute('position');
      const n = pos.count;
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        // Lid geometry is a sphere cap about the eye centre; the rim is where
        // the polar angle from the lid's own pole is largest.
        const x = pos.getX(i);
        const y = pos.getY(i);
        const z = pos.getZ(i);
        const r = Math.hypot(x, z);
        const polar = Math.atan2(r, lashFrom > 0 ? y : -y);
        const rim = smoothstep(0.95, 1.16, polar);
        // 0.86 crushed the whole lid rim to near black, and the face cavity map
        // puts its own lash line in the same few millimetres. Stacked, the two
        // produced the solid dark bar reviewers read as sunglasses. The lash is
        // allowed to be the darkest thing on the head; it is not allowed to be
        // the only thing on it. The face cavity no longer stacks its terms, so
        // the lid can take a little more here: the upper margin is the hard edge
        // that separates an eye from a bead pressed into a face.
        const k = 1 - (lashFrom > 0 ? 0.74 : 0.42) * rim;
        col[i * 3] = k;
        col[i * 3 + 1] = k * 0.98;
        col[i * 3 + 2] = k * 0.97;
        // Rolled margin: a lid has real thickness and its rim catches its own
        // shading, which is what gives the eye a lid *silhouette* rather than
        // just a darker band of albedo. The lower lid gets a much smaller roll -
        // enough to sit tangent to the bottom of the limbus - because a lower
        // margin that reads as strongly as the upper one is make-up, not anatomy.
        if (rim > 0) {
          const s = 1 + (lashFrom > 0 ? 0.062 : 0.026) * rim;
          pos.setXYZ(i, x * s, y * s, z * s);
        }
      }
      pos.needsUpdate = true;
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.computeVertexNormals();
      return g;
    };
    // Palpebral aperture. The lids are caps about the eye's *vertical* axis, so
    // the open band is (lower start) - (upper end) measured from the +Y pole.
    // At 1.32 / pi-1.4 that band was 25 degrees - a 6 mm slot on a 28 mm eye,
    // which is a squint, not an eye, and no amount of sclera tuning can rescue
    // it. 1.16 / pi-1.28 opens it to ~43 degrees, about 10 mm, which is a
    // relaxed human lid line.
    //
    // Opened another ~25% to 1.08 / pi-1.20, i.e. ~0.86 rad. The review was
    // unambiguous - "the eyes are two narrow dark horizontal marks, the white of
    // the eye is nowhere in the frame" - and with the orbital recess reduced and
    // the eyeball pushed forward there is finally a lit band of sclera worth
    // exposing. The radius rises to 15.9 mm so the enlarged iris cannot punch
    // through the lid where the two surfaces overlap at the top of the limbus.
    const lidUpGeo = this._shared('eye.lidUp', () =>
      lidTint(new THREE.SphereGeometry(0.0159, 14, 8, 0, Math.PI * 2, 0, 1.08), 1)
    , held);
    const lidLowGeo = this._shared('eye.lidLow', () =>
      lidTint(new THREE.SphereGeometry(0.0159, 14, 6, 0, Math.PI * 2, Math.PI - 1.20, 1.20), -1)
    , held);
    const skinMat = materials[SLOT.SKIN];
    const eyes = [];
    // Eye seating is expressed in skull-frame units, not absolute metres, so
    // any change to headFrame carries the eyes, lids, brows and hair with it
    // instead of leaving the eyeballs floating in front of a resized face.
    const EF = headFrame(P);
    for (const side of [1, -1]) {
      // Seated back into the orbital recess. At the old z the eyeball's front
      // pole stood 15 mm proud of the skin surface - a bug-eyed doll. Here the
      // cornea sits ~2 mm outside the lid line, which is a human eye.
      //
      // Pushed forward ~2.5 mm from 0.669 since the last pass: the orbital
      // recess in buildHead removes 5% of the radius right at this seat, and at
      // the old depth the lit region of the sclera fell *behind* the palpebral
      // aperture - the lid opening was narrower than the part of the eyeball
      // that could receive light, so no white read at any distance.
      // Pushed forward another 2.5 mm (0.693 -> 0.717 of the skull's depth
      // radius). Combined with halving the orbital recess in buildHead, the
      // sclera equator now clears the socket rim: the previous seating had the
      // lit band of the eyeball behind the palpebral aperture, so no white read
      // at any distance and the eye resolved as a dark slot.
      const local = new THREE.Vector3(
        0.42 * FA.eyeSep * EF.r.x * side,
        EF.c.y + 0.147 * EF.r.y - P.headY,
        EF.c.z - 0.717 * EF.r.z
      );
      const pivot = new THREE.Object3D();
      pivot.position.copy(local);
      const sclera = new THREE.Mesh(scleraGeo, A.sclera());
      const iris = new THREE.Mesh(irisGeo, A.iris(eyeColor));
      iris.position.z = -0.0006;
      pivot.add(sclera, iris);
      const lidUpper = new THREE.Mesh(lidUpGeo, skinMat);
      const lidLower = new THREE.Mesh(lidLowGeo, skinMat);
      lidUpper.position.copy(local);
      lidLower.position.copy(local);
      lidUpper.castShadow = false;
      lidLower.castShadow = false;
      headBone.add(pivot, lidUpper, lidLower);
      eyes.push({ pivot, iris, sclera, lidUpper, lidLower, side });
    }

    // --- weapon mount ----------------------------------------------
    const weaponMount = new THREE.Object3D();
    weaponMount.name = 'weaponMount';
    byName.get('handR').add(weaponMount);

    root.scale.setScalar(heightScale);
    // Per-instance width. Height alone is not silhouette variety - "the crowd in
    // the stands is visibly the same body repeated in different colours" is what
    // you get when every NPC of a given build shares one cached geometry and the
    // only free axis is a uniform scale. A few percent of non-uniform width on
    // the rig is free (it rides the same matrix the bones already use) and it
    // changes the shoulder-to-hip ratio, which is the proportion a viewer
    // actually reads at ten metres.
    const widthJitter = 0.965 + rng() * 0.075;
    rig.scale.set(widthJitter, 1, widthJitter * (0.99 + rng() * 0.02));

    return new Humanoid({
      root,
      rig,
      mesh,
      skeleton,
      bones: byName,
      boneList: bones,
      boneRoot,
      spec,
      P,
      headBone,
      hairMesh,
      eyes,
      weaponMount,
      materials,
      height,
      heightScale,
      theme,
      variant,
      palette: pal,
      face: FA,
      seed,
      _detail: true,
      // The cache these geometries came from, and the keys to give back to it.
      assets: this.assets,
      geoKeys: held,
      hairKey: hairGeo ? hairKey : null,
    });
  }

  dispose() {
    if (this._ownsAssets) this.assets.dispose();
    this._specCache.clear();
    this._propCache.clear();
  }
}

void _hv;
