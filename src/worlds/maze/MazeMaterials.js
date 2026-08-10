import * as THREE from 'three';
import {
  bakeSurface, bakeSurfaceAsync, fbm01, fbm2D, ridgedFbm2D, worley2D, WORLEY,
  domainWarp2D, WARP, smoothstep, mix, clamp01,
} from '../../gfx/Textures.js';

/**
 * The maze's cached material set, and the gate that replaced the frozen 385.
 *
 * ## Where this came from
 *
 * Lifted VERBATIM out of `MazeWorld._ensureMaterials` in Phase 6 Task 3 - same
 * colours, same emissive terms, same comments. `MazeWorld` keeps a one-line
 * delegate so its dispose path is untouched: materials deliberately survive
 * re-rolls (see the note in `MazeWorld.dispose`), because rebuilding them would
 * re-trigger the shader compilation that already dominates cold boot. The lift
 * happened now, not for tidiness, but because the program gate below has to be
 * testable headlessly - and a test that must import the 1300-line `MazeWorld.js`
 * to see a material is a test nobody will keep.
 *
 * ## The gate
 *
 * Phase 5 froze `renderer.info.programs.length` at 385. That number was never
 * the point - it was a proxy for "no material or texture is allocated per chunk
 * or per re-roll", and it becomes unpayable the moment Tasks 4-5 add maps and
 * vertex colours, which change program cache keys by construction. What
 * replaces it:
 *
 *  - `MAZE_PROGRAM_FAMILIES` - every distinct material feature-set this world
 *    compiles, enumerated. `scripts/tests/maze-materials.test.mjs` asserts the
 *    built set produces exactly these and no others, headless, per commit.
 *    Growing a family is legal but must be DECLARED in the same commit.
 *  - `MAZE_PROGRAM_BUDGET` - the browser-side ceiling, derived from a measured
 *    per-family cost rather than guessed (see its own comment).
 *  - Flatness - the entry-3-to-entry-10 program delta must be exactly 0. That,
 *    not the absolute count, is what actually detects the failure mode.
 */

/**
 * The subset of a material's state that three bakes into its shader program
 * cache key - the "family" a material compiles into.
 *
 * Read from the installed three 0.185.1, `src/renderers/webgl/WebGLPrograms.js`,
 * not from memory: `getParameters()` (the HAS_* block and the parameters
 * object) and `getProgramCacheKey()` / `getProgramCacheKeyBooleans()`. For the
 * material types this world uses, the material-derived key inputs are:
 *
 *  - `shaderID` from `material.type` - the biggest axis, a whole ShaderLib entry.
 *  - PRESENCE of each map slot (`HAS_MAP = !! material.map` and friends) - the
 *    key never looks at a map's contents, only whether the slot is filled and
 *    which UV channel it samples. Swapping one 256 texture for another is free;
 *    filling an empty slot is a new program.
 *  - `vertexColors`, and `vertexAlphas` derived from it (booleans mask, bits
 *    10-11).
 *  - `opaque` = `transparent === false && blending === NormalBlending` - so
 *    `transparent` and a non-normal blending mode both move the key, which is
 *    why the additive well-light materials are their own family.
 *  - `doubleSided` / `flipSided` from `material.side`.
 *  - `flatShading` (with a wrinkle: a geometry with no normal attribute and no
 *    normal map is forced flat for the standard family - all maze prefabs
 *    carry normals, so the material flag is the truth here).
 *  - `alphaTest > 0`, `alphaHash`, `premultipliedAlpha`, `dithering`,
 *    `material.fog`, and `normalMapType` (object- vs tangent-space, plus the
 *    packed-RG format probe) - captured for completeness even though today's
 *    set leaves them all at defaults.
 *
 * Deliberately NOT captured: everything three derives from the scene or the
 * object rather than the material - light counts, shadow counts, fog presence,
 * instancing/batching, tone mapping, output colour space. Those multiply every
 * family by the same scene-shaped factor; they are why 3 families become 385
 * programs, and they are the renderer's business, not this module's.
 *
 * @param {THREE.Material} mat
 * @returns {string} stable, human-readable - the strings in MAZE_PROGRAM_FAMILIES
 */
export function materialFingerprint(mat) {
  const parts = [mat.type];
  /* Ordered as WebGLPrograms declares its HAS_* block, so a fingerprint reads
   * in the same order a shader-cache spelunker will meet the flags. */
  for (const slot of ['map', 'aoMap', 'lightMap', 'bumpMap', 'normalMap',
    'displacementMap', 'emissiveMap', 'metalnessMap', 'roughnessMap',
    'specularMap', 'alphaMap', 'envMap', 'matcap', 'gradientMap']) {
    if (mat[slot]) parts.push(slot);
  }
  if (mat.normalMap && mat.normalMapType === THREE.ObjectSpaceNormalMap) parts.push('objectSpaceNormals');
  if (mat.vertexColors) parts.push('vertexColors');
  if (mat.transparent) parts.push('transparent');
  if (mat.blending !== THREE.NormalBlending) {
    const names = {
      [THREE.NoBlending]: 'none', [THREE.AdditiveBlending]: 'additive',
      [THREE.SubtractiveBlending]: 'subtractive', [THREE.MultiplyBlending]: 'multiply',
      [THREE.CustomBlending]: 'custom',
    };
    parts.push(`blending:${names[mat.blending] ?? mat.blending}`);
  }
  if (mat.side === THREE.DoubleSide) parts.push('doubleSided');
  else if (mat.side === THREE.BackSide) parts.push('backSide');
  if (mat.flatShading) parts.push('flatShading');
  if (mat.alphaTest > 0) parts.push('alphaTest');
  if (mat.alphaHash) parts.push('alphaHash');
  if (mat.premultipliedAlpha) parts.push('premultipliedAlpha');
  if (mat.dithering) parts.push('dithering');
  if (mat.fog === false) parts.push('noFog');
  return parts.join('|');
}

/**
 * Every material feature-set the maze compiles, measured by running
 * `materialFingerprint` over the built set - not asserted from hope. Five
 * families for nineteen kinds, which is the whole reason the world can
 * afford nineteen kinds:
 *
 *  - the plain lit family: kinds differing only in uniforms (colour,
 *    roughness, emissive), which the program cache key never sees;
 *  - the vertex-coloured lit family (Task 4): the movers whose prefabs bake
 *    contact AO into a colour attribute but carry no maps (gate, slideWall);
 *  - the full PBR family, vertex-coloured - Task 5's DELIBERATE addition:
 *    hedge, floor, stair/shaftWall and footing wear a complete
 *    albedo + normal + packed-ORM set from `bakeSurface` on top of Task 4's
 *    AO bake. Task 4's 'map|vertexColors' family MOVED here rather than
 *    grew - hedge and floor swapped fingerprints 1:1 and released their old
 *    programs - and the AO-baked stone kinds moved up out of the plain
 *    vertex-coloured family;
 *  - the same PBR set WITHOUT vertex colours: tunnel, whose treads never
 *    joined the AO bake (a tunnel folds under a floor and has no visible
 *    ground contact), so it keeps a vertex-colour-free variant exactly as
 *    the Task 3 budget derivation predicted it would;
 *  - the additive family: the well light and its pool, transparent + additive,
 *    which `opaque` in the cache key splits from everything else.
 */
export const MAZE_PROGRAM_FAMILIES = Object.freeze([
  'MeshStandardMaterial',
  'MeshStandardMaterial|vertexColors',
  'MeshStandardMaterial|map|normalMap|metalnessMap|roughnessMap',
  'MeshStandardMaterial|map|normalMap|metalnessMap|roughnessMap|vertexColors',
  'MeshBasicMaterial|transparent|blending:additive',
]);

/**
 * The browser-side program ceiling at full residency, derived from a
 * measurement rather than guessed.
 *
 * MEASURED 2026-08-09 (Task 3 Step 5, dev build, full 43-district residency at
 * (1200, 18.05, 1200), settled until two consecutive 5 s samples agreed):
 *
 *   baseline material set ................ 381 programs (stable, reproduced
 *                                          exactly on a second cold session)
 *   + normalMap on `footing` only ........ 382 programs (stable)
 *   marginal cost of one family        =  +1 program
 *
 * The plan predicted a family would cost its colour program PLUS depth and
 * distance shadow variants. It does not, and the installed three says why:
 * the depth/distance materials used for shadow rendering key on
 * `displacementMap` / `alphaMap` / `alphaTest`, never on `normalMap`,
 * `roughnessMap`, `metalnessMap` or `map`-as-colour - so every family this
 * phase plans to add shares the existing shadow programs and pays for exactly
 * one new colour program.
 *
 * Derivation: Tasks 4-5 introduce four distinct new feature-sets over today's
 * three (vertex colours split the plain and textured families in Task 4;
 * Task 5's normal+ORM maps re-split them, tunnel keeping a vertex-colour-free
 * variant). Budget = 385 (Phase 5's recorded ceiling; today measures 381)
 * + 4 families x 1 program = 389. The plan's headline was <= 420; the
 * measurement wins, and it says 420 was pessimistic by a factor of eight on
 * the marginal cost - the ledger should record 389, not 420.
 *
 * RE-MEASURED 2026-08-10 (Task 6, same amendment rule). BatchedMesh is a
 * program cache-key axis this derivation had not met: three keys every
 * program on BATCHING (`WebGLRenderer` recompiles a material the first time
 * it draws a BatchedMesh), so the batched families compile batched variants
 * of their colour programs AND of the shared shadow depth/distance programs.
 * Ten station/maze round trips, seed 2026, identical protocol on both
 * builds: pre-batch flat at 385 from entry 5, post-batch flat at 390 from
 * entry 5 - the batching axis costs exactly +5 programs, once, and the
 * entry-to-entry delta stays 0, which is the invariant that actually guards
 * against leaks. Budget = 389 + 5 = 394.
 *
 * SPENT AT TASK 4 (2026-08-10, same protocol, budget UNCHANGED): turning on
 * vertexColors for the AO-baked kinds measured flat 393 across sixteen
 * station/maze round trips against the box build's flat 390 - +3, inside the
 * two-families-at-+1-each the 389 derivation had banked for this task (the
 * odd +1 is the mover/instanced variant of the new vertex-coloured plain
 * family, which the derivation counted under Task 5's re-split). Entry-3-to-
 * entry-10 delta 0 on both builds. Headroom left for Task 5: 394 - 393 = 1
 * program, plus whatever the map families release when their fingerprints
 * move.
 *
 * SPENT AT TASK 5 (2026-08-10, same protocol, budget UNCHANGED): the full
 * normal+ORM wiring measured 387 at the worst-case teleport (seed 2026, 43
 * districts from (1200, 18.05, 1200)) and flat 392 from entry 2 of ten
 * station/maze round trips, entry-3-to-entry-10 delta 0. The releases the
 * Task 4 note banked came in: hedge/floor's 'map|vertexColors' programs and
 * the plain vertex-coloured programs of stair/shaftWall/footing were freed
 * when those kinds moved into the two PBR families, so five surfaced kinds
 * net out at 392 against 393 pre-task. Headroom: 394 - 392 = 2.
 */
export const MAZE_PROGRAM_BUDGET = 394;

/* ------------------------------------------------------------------ */
/* Task 5: real PBR surfaces from real height fields                   */
/* ------------------------------------------------------------------ */

/**
 * Bake resolution per surfaced kind, in texels - THE size table, the single
 * place the phase's texture budget is written down. `declaredTextureBytes`
 * sums it and the suite holds the sum under 96 MB; the browser gate holds
 * `renderer.info.memory.textures` under 48. 1024 only for the two surfaces a
 * player stands nose-to (a hedge wall fills the screen at arm's length; so
 * does the floor when looking down); 512 for stone that is mostly read at a
 * stride's distance or under shaft-lantern light, where the extra texels
 * would be spent below the rasteriser's ability to show them.
 */
export const MAZE_TEXTURE_SIZES = Object.freeze({
  hedge: 1024, floor: 1024, stair: 512, footing: 512, tunnel: 512,
});

/**
 * The byte cost of the declared texture set: three RGBA8 maps per surface
 * (albedo + normal + packed ORM - `bakeSurface`'s whole output), each with a
 * full mip chain (the 4/3 factor). Computed from the size table rather than
 * from live textures so the suite can hold the budget headlessly, and so a
 * bake that outgrew its declaration fails the size assertion rather than
 * silently inflating this figure.
 */
export function declaredTextureBytes() {
  let bytes = 0;
  for (const size of Object.values(MAZE_TEXTURE_SIZES)) {
    bytes += 3 * size * size * 4 * (4 / 3);
  }
  return bytes;
}

/** 0xRRGGBB -> [r, g, b] in 0..1, hoisted out of the per-texel path. */
const rgb = (hex) => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];

/** Write `mix(a, b, t)` into the texel's albedo - every recipe's closing move. */
function tint(out, a, b, t) {
  out.r = mix(a[0], b[0], t);
  out.g = mix(a[1], b[1], t);
  out.b = mix(a[2], b[2], t);
}

/* Palette per surface, authored IN the albedo now (the materials' colour
 * tints go to white): the same greens and earths Phase 5 ramped, plus the
 * stone tones that used to live in `material.color` for stair, footing and
 * tunnel. */
const HEDGE_DARK = rgb(0x24391c); const HEDGE_LIGHT = rgb(0x74a54e);
const FLOOR_DARK = rgb(0x554b3e); const FLOOR_LIGHT = rgb(0x9a8e78);
const STONE_DARK = rgb(0xb3a888); const STONE_LIGHT = rgb(0xe2d8bc);
const FOOT_DARK = rgb(0x5f584c); const FOOT_LIGHT = rgb(0x8d8271);
const TUNNEL_DARK = rgb(0x84705a); const TUNNEL_LIGHT = rgb(0xc4ad8b);

/**
 * One `bakeSurface` recipe per surfaced kind. Each shading callback writes
 * albedo, height, AO, roughness and metalness off ONE noise walk - the whole
 * reason Phase 5 stopped at colour maps was that its API (`makeNoiseTexture`)
 * could not hand back the Float32Array height field `makeNormalFromHeight`
 * needs; `bakeSurface` emits it as a by-product of work already done.
 *
 * `repeat` is in tiles per METRE, because Task 5 moved every prefab to
 * world-scale UVs (see MazeMeshes.js): a hedge tile spans 2.5 m, earth 2 m,
 * stone ~1.4 m. The AO channel is baked honestly even though no material
 * wires `aoMap` (no prefab carries a second UV set - see the note on the
 * material below), so the data is ready the day a uv1 exists.
 *
 * Octave counts are the boot budget's pressure point: ~2.9 M texels flow
 * through these callbacks, so each extra octave on a 1024 surface is
 * ~4 M more `perlin2D` calls. Every count here was trimmed to the last
 * octave that visibly mattered at the declared resolution.
 *
 * Recipes are DATA (`{shade, opts}`), not closures over `bakeSurface`, so
 * the synchronous path and the frame-sliced path below run the exact same
 * shading through the toolkit's two bakers and cannot drift apart.
 */
const recipe = (shade, opts) => ({ shade, opts });

const SURFACE_RECIPES = {
  hedge: recipe((u, v, out) => {
    /* Clipped hedge: worley cells read as foliage clumps, F1 rising toward
     * each cell wall so the crevice BETWEEN clumps is deep, dark and rough. */
    const crevice = clamp01(worley2D(u, v, 26, 26, 0x4a1, 1) * 1.15);
    const leaf = fbm01(u, v, 52, 52, 3, 0x4a2, 0.55);
    const patch = fbm01(u, v, 5, 5, 2, 0x4a3, 0.5);
    const body = clamp01(1 - crevice * 0.85 + (leaf - 0.5) * 0.35);
    out.h = body;
    tint(out, HEDGE_DARK, HEDGE_LIGHT, clamp01(body * 0.75 + patch * 0.4 - 0.12));
    out.ao = 0.6 + 0.4 * body;
    out.rough = 0.98 - 0.14 * body; // sun-catching leaf tips are the least matt part
    out.metal = 0;
  }, { normalStrength: 0.65, repeat: 1 / 2.5, name: 'maze.hedge' }),

  floor: recipe((u, v, out) => {
    /* Packed earth: domain-warped mottle so the soil has no grid to find,
     * with sparse half-buried pebbles from a jittered worley field. */
    domainWarp2D(u, v, 3, 0.05, 0x77c);
    const mottle = fbm01(WARP[0], WARP[1], 9, 9, 4, 0x77d, 0.5);
    const pebble = smoothstep(0.34, 0.16, worley2D(u, v, 34, 34, 0x77e, 0.9));
    const stoneId = WORLEY[2];
    out.h = 0.42 + (mottle - 0.5) * 0.45 + pebble * 0.4;
    tint(out, FLOOR_DARK, FLOOR_LIGHT, clamp01(mottle * 1.1 - 0.05));
    if (pebble > 0.01) {
      /* Grey the pebbles toward stone, each its own shade via the cell id. */
      const grey = 0.42 + stoneId * 0.25;
      const w = pebble * 0.8;
      out.r = mix(out.r, grey, w);
      out.g = mix(out.g, grey, w);
      out.b = mix(out.b, grey * 0.96, w);
    }
    out.ao = 0.75 + 0.25 * clamp01(out.h);
    out.rough = 0.97 - pebble * 0.35; // worn pebble tops polish; earth never does
    out.metal = 0;
  }, { normalStrength: 0.55, repeat: 1 / 2, name: 'maze.floor' }),

  stair: recipe((u, v, out) => {
    /* Pale worked stone: soft bedding strata, thin dark veins, tool-fine
     * grain. Deliberately the QUIETEST surface of the five - a tread is read
     * underfoot and lit by its own emissive term, where busy noise reads as
     * dirt rather than as stone. */
    const strata = fbm2D(u, v, 4, 9, 3, 0xb52, 0.5);
    const vein = Math.pow(ridgedFbm2D(u, v, 6, 6, 3, 0xb53, 0.5), 4);
    const grain = fbm01(u, v, 44, 44, 2, 0xb54, 0.5);
    out.h = clamp01(0.55 + strata * 0.18 - vein * 0.5 + (grain - 0.5) * 0.1);
    tint(out, STONE_DARK, STONE_LIGHT, clamp01(0.6 + strata * 0.5 - vein * 1.4));
    out.ao = 1 - vein * 0.45;
    out.rough = 0.72 + strata * 0.1 + vein * 0.25;
    out.metal = 0;
  }, { normalStrength: 0.5, repeat: 1 / 1.4, name: 'maze.stair' }),

  footing: recipe((u, v, out) => {
    /* Weathered stone blocks: a low-jitter worley grid whose F2-F1 ridge is
     * the mortar line, each block tinted by its own cell id the way real
     * courses mix quarry batches. */
    worley2D(u, v, 5, 4, 0xf07, 0.55);
    const joint = 1 - smoothstep(0.02, 0.14, WORLEY[1] - WORLEY[0]);
    const block = WORLEY[2];
    const grain = fbm01(u, v, 26, 26, 3, 0xf08, 0.55);
    out.h = clamp01(0.72 - joint * 0.55 + (grain - 0.5) * 0.22);
    tint(out, FOOT_DARK, FOOT_LIGHT, clamp01(0.25 + block * 0.55 + (grain - 0.5) * 0.5));
    if (joint > 0.01) {
      const shade = 1 - joint * 0.45;
      out.r *= shade; out.g *= shade; out.b *= shade;
    }
    out.ao = 1 - joint * 0.5;
    out.rough = 0.9 + joint * 0.1 - grain * 0.08;
    out.metal = 0;
  }, { normalStrength: 0.7, repeat: 1 / 1.25, name: 'maze.footing' }),

  tunnel: recipe((u, v, out) => {
    /* The vaulted descent: warm packed earth over rough-cut courses, midway
     * between the floor's soil and the stair's masonry because that is what
     * the tunnel is - a stair worked out of the ground. */
    domainWarp2D(u, v, 2, 0.06, 0x70e);
    const earth = fbm01(WARP[0], WARP[1], 7, 7, 3, 0x70f, 0.55);
    const course = fbm2D(u, v, 3, 10, 2, 0x710, 0.5);
    out.h = clamp01(0.5 + (earth - 0.5) * 0.5 + course * 0.12);
    tint(out, TUNNEL_DARK, TUNNEL_LIGHT, clamp01(earth * 0.9 + course * 0.3));
    out.ao = 0.8 + 0.2 * earth;
    out.rough = 0.88 - earth * 0.1;
    out.metal = 0;
  }, { normalStrength: 0.5, repeat: 1 / 1.6, name: 'maze.tunnel' }),
};

/** Baked surfaces by kind - filled on demand, kept for the session like the materials. */
const _surfaces = new Map();
/** Wall-clock spent inside `bakeSurface`, for the boot-cost gate. */
let _bakeMillis = 0;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function surfaceFor(kind) {
  let s = _surfaces.get(kind);
  if (!s) {
    const r = SURFACE_RECIPES[kind];
    const t0 = now();
    s = bakeSurface(MAZE_TEXTURE_SIZES[kind], r.shade, r.opts);
    _bakeMillis += now() - t0;
    _surfaces.set(kind, s);
  }
  return s;
}

/**
 * Milliseconds spent baking the surface set so far - the number the phase's
 * "builds in <= 250 ms, or across frames" gate is judged on, exported so the
 * browser harness can read the real figure instead of re-deriving it. On the
 * sliced path this is wall-clock INCLUDING the yielded frame gaps, which
 * overstates the CPU cost - conservative in the direction a budget wants.
 */
export function surfaceBakeMillis() {
  return _bakeMillis;
}

/**
 * The yield path: bake the surfaces in row slices across frames, then
 * assemble the set.
 *
 * MEASURED 2026-08-10 (Node, same V8 as the browser): the five bakes cost
 * 1685 ms in one gulp - hedge 512 ms, floor 729 ms, the 512s 90-150 ms each -
 * against the plan's 250 ms boot budget. Two alternatives lost before this
 * shape won. Shrinking the maps is the one the plan forbids by name: a
 * permanently blurrier world is a permanent price for a one-off cost.
 * Yielding between WHOLE surfaces - the first implementation here - was
 * measured and rejected too: it caps the stall at the largest single bake,
 * and 729 ms is not a cap, it is the original problem relocated to frame
 * one of five. `bakeSurfaceAsync` slices the texel loop itself (~45 ms of
 * shading per yielded frame), so the loading bar animates through the whole
 * bake and no frame eats more than a slice. `MazeWorld.build` awaits this;
 * the synchronous `buildMazeMaterials` still bakes inline for headless
 * tests, and both paths fill the same session-lifetime caches.
 *
 * Browser reality check (RTX 5080, first maze entry of a session): the wall
 * clock through this path is CPU plus one frame gap per slice, so it
 * stretches with whatever else the loading frames are doing - measured
 * 6.3 s inside an automation window throttled to ~42 ms frames, ~2.5 s at a
 * 60 Hz foreground cadence. That is wall time the loading bar animates
 * through, not a stall, and it is paid once per session: every later entry
 * finds the caches full and pays nothing.
 */
export async function buildMazeMaterialsAsync() {
  if (_materials) return _materials;
  for (const kind of Object.keys(SURFACE_RECIPES)) {
    if (_surfaces.has(kind)) continue;
    const r = SURFACE_RECIPES[kind];
    const t0 = now();
    _surfaces.set(kind, await bakeSurfaceAsync(MAZE_TEXTURE_SIZES[kind], r.shade, r.opts));
    _bakeMillis += now() - t0;
  }
  return buildMazeMaterials();
}

/** The one set, built on first use and kept for the session - see buildMazeMaterials. */
let _materials = null;

/**
 * The maze's material set: `{ [kind]: THREE.Material }`, built once per
 * session and cached at module scope. Callers share the same objects on every
 * call - that identity is asserted, not just intended, because a material
 * rebuilt per world build would recompile its programs on every re-roll and
 * re-rolling is this world's entire premise.
 */
export function buildMazeMaterials() {
  if (_materials) return _materials;

  /* Surfaces, baked ONCE with the material set - which is once per session,
   * since the set is cached and reused across every re-roll and every
   * streamed chunk. A texture built per chunk would be worse than a material
   * per chunk, and `scripts/tests/maze-lighting.test.mjs` has a tripwire
   * asserting MazeChunks never builds either.
   *
   * Phase 5's note here said "colour maps only, no normal maps" and recorded
   * why: `makeNormalFromHeight` takes a Float32Array HEIGHT FIELD and
   * `makeNoiseTexture` could not hand one back. `bakeSurface` was the answer
   * the note pointed at - it emits albedo, height and packed ORM off one
   * noise walk - and SURFACE_RECIPES above is Task 5 finally reaching it.
   *
   * The full PBR wiring, and its two deliberate absences:
   *  - the ORM texture fills BOTH `roughnessMap` and `metalnessMap` - one
   *    upload, one sampler, two channels (glTF packing, G=roughness,
   *    B=metalness) - so the scalar `roughness`/`metalness` go to 1.0, the
   *    identity for a mapped material, and the map carries the value;
   *  - `aoMap` stays empty: no maze prefab carries a uv1 attribute, and an
   *    aoMap without its UV set is a silent no-op at best. The occlusion
   *    this world actually owns per-instance is Task 4's vertex-colour bake,
   *    which multiplies in through `vertexColors` - wiring the ORM's R
   *    channel on top would darken the same corners twice;
   *  - `color` goes to WHITE on every surfaced kind: the tone lives in the
   *    authored albedo now, and a leftover tint would multiply it into mud.
   */
  const hedgeSurf = surfaceFor('hedge');
  const floorSurf = surfaceFor('floor');
  const stairSurf = surfaceFor('stair');
  const footingSurf = surfaceFor('footing');
  const tunnelSurf = surfaceFor('tunnel');

  /* Stair treads and landings. Pale stonework, deliberately far from both
   * the dark hedge green and the stone-brown floor - a stair is meant to
   * read as a landmark the instant it comes into view down a corridor, not
   * blend into the hedge that walls it in. Built once and reused across
   * every re-roll for the same reason every other cached material is.
   *
   * The emissive term dates from Phase 2b, when a sealed shaft was pitch
   * black and the reasoning was that a per-shaft lamp was impossible. THAT
   * REASONING WAS WRONG - see `MazeChunks`'s lantern note and LightRig's own
   * header: authored lights are claimed into fixed slots and cost no
   * programs. The emissive is kept because a stair that glows faintly reads
   * as a landmark down a dark corridor, which is a reason that survives the
   * correction; it is no longer load-bearing for visibility.
   *
   * Reused verbatim (not merely colour-matched) for the shaft's own walls
   * below - see `shaftWall`. */
  /* `vertexColors` on the six kinds whose prefabs bake contact AO (Task 4:
   * hedge, floor, shaftWall, gate, slideWall, footing) - plus, by aliasing,
   * this stair material, which shaftWall IS. The flag is scoped to materials
   * whose every geometry provably carries a colour attribute: all six kinds
   * (and stair, at every LOD) draw registry prefabs, whether through the
   * static batches, the movers' InstancedMesh path or the forecourt - and
   * `maze-bevel.test.mjs` asserts attribute coverage kind by kind, because a
   * mesh with no colour attribute under a vertexColors material renders
   * BLACK in three and does it silently. */
  const stair = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 1.0, metalness: 1.0,
    map: stairSurf.map, normalMap: stairSurf.normalMap,
    roughnessMap: stairSurf.ormMap, metalnessMap: stairSurf.ormMap,
    emissive: 0x4a4330, emissiveIntensity: 0.45, vertexColors: true,
  });

  _materials = {
    /* Textured since Phase 5. Flat colour read as a box at any distance,
     * which is what a hedge maze must not do: the player navigates by
     * telling one corridor from another. */
    /* Textured since Phase 5. Flat colour read as a box at any distance,
     * which is the one thing a hedge maze must not do: the player navigates
     * by telling one corridor from another. */
    hedge: new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 1.0, metalness: 1.0,
      map: hedgeSurf.map, normalMap: hedgeSurf.normalMap,
      roughnessMap: hedgeSurf.ormMap, metalnessMap: hedgeSurf.ormMap,
      vertexColors: true,
    }),
    floor: new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 1.0, metalness: 1.0,
      map: floorSurf.map, normalMap: floorSurf.normalMap,
      roughnessMap: floorSurf.ormMap, metalnessMap: floorSurf.ormMap,
      vertexColors: true,
    }),
    stair,
    /* The shaft's own walls (see shaftColliders) - the exact same cached
     * material as `stair` (not merely colour-matched), so a shaft reads as
     * one continuous piece of pale stonework rather than a tower of one
     * colour wrapped around a staircase of another.
     *
     * This is the fix for a shaft being invisible from outside: its walls
     * rise to LEVEL_HEIGHT (9m), 4m above the 5m hedge line, so a shaft is
     * already geometrically a tower - but `shaftColliders` used to emit
     * those walls with kind:'hedge', so they were drawn in the same dark
     * green as every ordinary hedge and vanished into the canopy.
     * `shaftWall` is its own `CHUNK_MESH_KINDS` entry (see MazeChunks.js)
     * specifically so it gets its own InstancedMesh in this pale material
     * instead - ordinary hedges are untouched. */
    shaftWall: stair,
    /* The lift car. Its own material rather than the stair's, because it is
     * the one surface in a shaft that MOVES and the player needs to read it
     * as a thing rather than as more stonework - a darker metal against the
     * pale stone of the shaft it rides in. Emissive for the same reason the
     * treads are: a shaft is sealed and unlit, and `LightRig.js` pools every
     * light into a fixed slot because Three bakes the light COUNT into each
     * shader's program cache key, so a lamp per lift is the 250 s of
     * recompilation main.js already measured. Built once and cached here
     * like every other entry - a material allocated per chunk or per lift
     * would re-trigger that compilation on every re-roll. */
    lift: new THREE.MeshStandardMaterial({
      color: 0x8a8f99, roughness: 0.45, metalness: 0.65,
      emissive: 0x2b3138, emissiveIntensity: 0.55,
    }),
    /* Tunnel treads. A vaulted descent rather than an open spiral, so a
     * shade warmer and darker than the stair's pale stone - the two must not
     * read as the same structure seen twice, since the whole point of three
     * connectors is that a player learns to tell them apart. Emissive for
     * the same reason everything down here is: a tunnel folds under level
     * N+1's floor and is the darkest space in the maze, and `LightRig.js`
     * bans a lamp per connector because Three bakes the light COUNT into
     * every shader's program cache key. Built once and cached. */
    tunnel: new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 1.0, metalness: 1.0,
      map: tunnelSurf.map, normalMap: tunnelSurf.normalMap,
      roughnessMap: tunnelSurf.ormMap, metalnessMap: tunnelSurf.ormMap,
      emissive: 0x4a3c2a, emissiveIntensity: 0.5,
    }),
    /* The landing door. Read as a counterweight slab: the same stone family
     * as the shaft so it belongs to the structure, but darker and plainly
     * a moving part, so that a closed door reads as "the lift is elsewhere"
     * rather than as a dead end. */
    liftDoor: new THREE.MeshStandardMaterial({
      color: 0x9a917c, roughness: 0.7, metalness: 0.15,
      emissive: 0x3a3428, emissiveIntensity: 0.35,
    }),
    credits: new THREE.MeshStandardMaterial({
      color: 0xffd479, roughness: 0.35, metalness: 0.8,
      emissive: 0x6a4a10, emissiveIntensity: 0.6,
    }),
    /* Dead-end tokens. One more cached material, built once here and reused
     * across every re-roll for the same reason the other two are - see
     * the module docstring above. A cool glow reads clearly in a dim dead end
     * without being mistaken for the centre stack's gold. */
    token: new THREE.MeshStandardMaterial({
      color: 0x8fe0c9, roughness: 0.3, metalness: 0.25,
      emissive: 0x2fae86, emissiveIntensity: 1.15,
    }),
    /* Distant hedge-tops beyond the streamed districts - see MazeCanopy. One
     * more cached, built-once entry for the same reason as the others: a flat
     * quad allocated per district or per build would re-trigger the shader
     * compilation that already dominates cold boot. Flat and a shade darker
     * than the hedge material so it reads as distance, not as more maze. */
    /* Weathered stone at each hedge's base - "five-metre hedges over
     * weathered stone footings", section 10. Mesh only; see MazeFoliage.js
     * for why it registers no colliders. */
    footing: new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 1.0, metalness: 1.0,
      map: footingSurf.map, normalMap: footingSurf.normalMap,
      roughnessMap: footingSurf.ormMap, metalnessMap: footingSurf.ormMap,
      vertexColors: true,
    }),
    /* Unkempt growth along the hedge tops. A shade lighter and yellower than
     * the hedge itself so it reads as new growth against clipped body,
     * rather than as noise on the same surface. */
    foliage: new THREE.MeshStandardMaterial({
      color: 0x86ab55, roughness: 1.0, metalness: 0,
    }),
    /* The candle itself - wax, lit from within. Strongly emissive so it
     * reads as a source at a distance even where the rig has spent its
     * twelve point slots elsewhere. */
    candle: new THREE.MeshStandardMaterial({
      color: 0xffe9c0, roughness: 0.6, metalness: 0,
      emissive: 0xffb457, emissiveIntensity: 2.2,
    }),
    /* The shaft of daylight down a tower, and the patch it lands in.
     * Additive with depth-write off: a column of light is not a surface, so
     * it must not occlude, must not sort, and must not take a shadow. */
    wellLight: new THREE.MeshBasicMaterial({
      color: 0xdfeecf, transparent: true, opacity: 0.045,
      /* FRONT faces only. `DoubleSide` draws the near and far walls of the
       * cylinder over each other and doubles the brightness, which from
       * inside the shaft - where a climber spends the whole ascent - washed
       * the stairs out to near white. */
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.FrontSide,
    }),
    wellPool: new THREE.MeshBasicMaterial({
      color: 0xe8f2d8, transparent: true, opacity: 0.16,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }),
    /* Ivy on the tower shafts. Darker and bluer than hedge foliage, because
     * it is growing on cold stone in a stairwell rather than in the open,
     * and because a shaft that reads as "more hedge" loses the one change of
     * material this world has. */
    ivy: new THREE.MeshStandardMaterial({
      color: 0x4c7a48, roughness: 1.0, metalness: 0,
    }),
    /* A one-way gate. Hedge that has been cut and trained over a frame -
     * darker and greyer than a grown hedge, so that a corridor which is
     * about to close behind you does not look like every other corridor. */
    gate: new THREE.MeshStandardMaterial({
      color: 0x3f5a34, roughness: 1.0, metalness: 0, vertexColors: true,
    }),
    /* A sliding hedge wall. Reads as the same worked hedge as a gate, warmed
     * slightly so the two are distinguishable at a glance without either
     * looking like plain hedge. */
    slideWall: new THREE.MeshStandardMaterial({
      color: 0x4a5b2f, roughness: 1.0, metalness: 0, vertexColors: true,
    }),
    /* The pressure plate. Worked stone, faintly lit, because a flush pad on
     * a dim corridor floor is invisible otherwise and an invisible trigger
     * is indistinguishable from no trigger. */
    plate: new THREE.MeshStandardMaterial({
      color: 0x9a8f74, roughness: 0.75, metalness: 0,
      emissive: 0x6f5a2a, emissiveIntensity: 0.7,
    }),
    canopy: new THREE.MeshStandardMaterial({ color: 0x24391f, roughness: 1, metalness: 0 }),
  };
  return _materials;
}
