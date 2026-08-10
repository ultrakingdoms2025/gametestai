import * as THREE from 'three';
import { makeNoiseTexture } from '../../gfx/Textures.js';

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
 * `materialFingerprint` over the built set - not asserted from hope. Four
 * families for nineteen kinds, which is the whole reason the world can
 * afford nineteen kinds:
 *
 *  - the plain lit family: kinds differing only in uniforms (colour,
 *    roughness, emissive), which the program cache key never sees;
 *  - the vertex-coloured lit family - Task 4's DELIBERATE addition: the
 *    stone/mover kinds whose prefabs bake contact AO into a colour attribute
 *    (stair/shaftWall, gate, slideWall, footing);
 *  - the textured family, now also vertex-coloured: hedge and floor gained
 *    Task 4's bake on top of Phase 5's colour maps, so the old
 *    'MeshStandardMaterial|map' family MOVED rather than grew - the two
 *    fingerprints swap 1:1 and their old programs are released;
 *  - the additive family: the well light and its pool, transparent + additive,
 *    which `opaque` in the cache key splits from everything else.
 *
 * Task 5 will grow this list again on purpose (normal/ORM maps); the test
 * that fails when it does is the mechanism that makes the growth a decision
 * instead of an accident.
 */
export const MAZE_PROGRAM_FAMILIES = Object.freeze([
  'MeshStandardMaterial',
  'MeshStandardMaterial|vertexColors',
  'MeshStandardMaterial|map|vertexColors',
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
 */
export const MAZE_PROGRAM_BUDGET = 394;

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

  /* Maps, generated ONCE with the material set - which is once per session,
   * since the set is cached and reused across every re-roll and every
   * streamed chunk. A texture built per chunk would be worse than a material
   * per chunk, and `scripts/tests/maze-lighting.test.mjs` has a tripwire
   * asserting MazeChunks never builds either.
   *
   * Colour maps only, no normal maps: `makeNormalFromHeight` takes a
   * Float32Array HEIGHT FIELD, not a texture, and there is no exported
   * helper that hands one back from `makeNoiseTexture`. Passing the texture
   * would have compiled and produced garbage. Worth revisiting with a real
   * height field; not worth guessing at.
   */
  const hedgeMap = makeNoiseTexture({
    size: 256, frequency: 22, octaves: 5, gain: 0.55, contrast: 1.15, seed: 0x4a1,
    /* The ramp's low end sets the average, and the first pass came out
     * darker than the flat colour it replaced - a textured hedge that
     * reads as black is not an improvement on a flat one. */
    colorA: 0x2c4526, colorB: 0x74a54e,
  });
  hedgeMap.wrapS = THREE.RepeatWrapping;
  hedgeMap.wrapT = THREE.RepeatWrapping;
  hedgeMap.repeat.set(2.5, 1.6);

  /* The floor: packed earth, much coarser than the hedge so the two never
   * read as the same surface down a corridor. */
  const floorMap = makeNoiseTexture({
    size: 256, frequency: 9, octaves: 4, gain: 0.5, contrast: 0.9, seed: 0x77c,
    colorA: 0x5d5446, colorB: 0x9a8e78,
  });
  floorMap.wrapS = THREE.RepeatWrapping;
  floorMap.wrapT = THREE.RepeatWrapping;
  floorMap.repeat.set(8, 8);

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
    color: 0xd8cdb0, roughness: 0.8, metalness: 0,
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
      color: 0xffffff, roughness: 0.95, metalness: 0, map: hedgeMap, vertexColors: true,
    }),
    floor: new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 1.0, metalness: 0, map: floorMap, vertexColors: true,
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
      color: 0xb9a488, roughness: 0.85, metalness: 0,
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
      color: 0x7d7566, roughness: 1.0, metalness: 0, vertexColors: true,
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
