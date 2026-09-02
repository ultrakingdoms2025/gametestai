/**
 * Aldermoor Vale's authored PBR surfaces: the second world on the pipeline
 * `maze/MazeAssets.js` proved, riding the shared core in
 * `../assets/AuthoredAssets.js`.
 *
 * ── WHAT THIS BUYS, AND WHY MEDIEVAL ──────────────────────────────────────
 *
 * Every surface in this world is painted at build time by
 * `MedievalWorld._surface` - a 2D canvas, a height canvas, and normal /
 * roughness / AO derived from the height. That bake is good, and it is what
 * ships when this file finds nothing; but at the range the player actually
 * stands from a village wall it is a blur, because a 512px canvas spanning a
 * 2 m tile is 3.9 mm per texel and the eye is a metre away. The five surfaces
 * declared below are the ones a village-square framing puts within touching
 * distance: lime render, framing timber, sawn boards, thatch and paving.
 *
 * The station is deliberately NOT the world this landed on. Station boot-warm
 * sits at 144 shader programs against a pin of 142 +/- 4
 * (`scripts/tests/frame-gaps-program-gate.test.mjs`), so two of the margin
 * remain; medieval is not on the boot path, and its own entry allowance in
 * that same baseline is `entry:medieval: 2` with +2 of headroom.
 *
 * ── AND WHY THIS COSTS ZERO SHADER PROGRAMS, BY CONSTRUCTION ──────────────
 *
 * This is the whole reason the design is a SWAP and not an addition. Three
 * keys its program cache on material CONFIGURATION, and for a map the only
 * thing the key reads is slot PRESENCE (`!!material.map`, `!!material.normalMap`,
 * ...) plus each map's UV channel. `MedievalWorld._std` already builds every
 * one of these five with `map`, `normalMap`, `roughnessMap` and `aoMap` bound,
 * all on UV channel 0. Dressing a surface replaces the four texture OBJECTS in
 * those same four slots - albedo to albedo, normal to normal, and the one ORM
 * to both `roughnessMap` and `aoMap`, exactly as `MazeMaterials` binds an ORM
 * to `roughnessMap` and `metalnessMap`. Presence is unchanged, the channel is
 * unchanged, `material.version` is never bumped, so no program is relinked and
 * none is added. The maze measured the same construction directly: 391 programs
 * in the shaft with and without its authored set.
 *
 * `metalnessMap` is deliberately NOT bound even though the ORM's B channel
 * carries metalness. Binding it WOULD be a new slot on these materials, which
 * is a new program family - and every surface here is a dielectric whose
 * `metalness` scalar is already 0, so the channel carries nothing this world
 * would use. That is the one place the maze's wiring is not copied, and it is
 * copied nowhere else for a reason.
 *
 * ── DEGRADATION IS THE DEFAULT STATE, NOT THE ERROR PATH ──────────────────
 *
 * At the time of writing not one of these fifteen files exists: the KTX2 sets
 * are produced by a separate generator. That is not a caveat, it is the shape
 * of the design. `surface-manifest.json` declares them in a `pending` array
 * that the loader never reads, so today the manifest's `assets` is empty, no
 * fetch is issued, no set is complete, `dressMedievalSurfaces` dresses
 * nothing and logs one line, and the vale renders EXACTLY as it did before
 * this file existed. The day the generator writes the files it moves the
 * entries into `assets` with their byte counts, and this code path lights up
 * with no change here - which `scripts/tests/medieval-surfaces.test.mjs`
 * gates from both ends.
 *
 * ── THE UV CONTRACT, WHICH IS WHERE A REPEAT GOES WRONG ───────────────────
 *
 * Medieval UVs are world-scaled by the geometry helpers, not normalised:
 * `boxGeo`/`panelGeo`/`cylGeo`/`planeGeo` all multiply the unit UV by the
 * face's size in metres times `tile`, whose default is 0.5. So a UV unit is
 * two metres and a texture at `repeat = 1` spans a 2 m tile - which is what
 * every procedural bake in this world was authored against. An authored set
 * knows its own physical tile in metres, so:
 *
 *     repeat = MEDIEVAL_UV_TILE_METRES / tileMetres
 *
 * which is 1 for a 2 m asset and leaves the world's apparent feature scale
 * exactly where the procedural bake put it. Getting this backwards is the
 * failure that reads as "the new stone is fine but everything is the wrong
 * size", and it is silent.
 */

import { createAuthoredAssets } from '../assets/AuthoredAssets.js';

/**
 * Metres one texture tile spans at `repeat = 1`, given this world's
 * world-scaled UVs and the 0.5 `tile` default in its geometry helpers. The
 * single number the repeat arithmetic above turns on; asserted against the
 * helpers by `medieval-surfaces.test.mjs` so a change to that default cannot
 * silently rescale every authored set.
 */
export const MEDIEVAL_UV_TILE_METRES = 2;

/**
 * The surfaces that may be dressed, and what each authored set is expected to
 * be. The key is a `MedievalWorld._mats` key, which is also a `_tex` key and
 * a `_surface()` name - one word, three registries, which is what makes an
 * override a one-line table entry rather than a wiring exercise.
 *
 *  - `size`   texels per side of the authored KTX2 files. 1024 across the
 *             board: every one of these five is procedurally baked at 512
 *             today, so 1024 is already a doubling of texel density, and a
 *             2048 set costs four times the download for a surface the player
 *             sees at a metre rather than at ten centimetres. DOWNLOAD IS A
 *             REAL COST here - `public/` is 20 MB today and the maze's five
 *             surfaces alone are 17 MB of it - so 2048 needs a texel-density
 *             argument and none of these five has one.
 *  - `tileMetres` the physical size of one tile of the authored material, from
 *             the asset's own published scale. Drives `repeat` - see the
 *             header. 2 is the value that changes nothing.
 *  - `why`    what a player is standing in front of when they see it, which is
 *             the only reason any of these five and not the other fourteen.
 */
export const MEDIEVAL_AUTHORED_SURFACES = Object.freeze({
  daub: Object.freeze({
    size: 1024,
    tileMetres: 2,
    why: 'lime render between the studs - the largest light-value surface in the '
      + 'village and the one every gable presents to the square at 2-4 m',
  }),
  beam: Object.freeze({
    size: 1024,
    tileMetres: 2,
    why: 'the framing timber that frames every one of those panels, and the '
      + 'surface the authored arch-braces and jetty consoles are merged into',
  }),
  plank: Object.freeze({
    size: 1024,
    tileMetres: 2,
    why: 'sawn boards: doors, shutters, stall counters and the jetty decks - '
      + 'the surface most often within arm\'s reach. The first of the five to '
      + 'cut if the download budget bites, because it covers the least frame.',
  }),
  thatch: Object.freeze({
    size: 1024,
    tileMetres: 2,
    why: 'the eaves are at head height on a cottage and fill the top half of '
      + 'the square framing',
  }),
  cobble: Object.freeze({
    size: 1024,
    tileMetres: 2,
    why: 'what the player is standing ON. Flattest surface in the world and '
      + 'the one that covers most of a street shot.',
  }),
});

/**
 * Deliberately NOT on the list, recorded so nobody adds it without reading
 * this: the ground.
 *
 * The vale's road and dirt are the terrain material's `detail` sheet, and
 * `MedievalWorld._buildTextures` sets `this._tex.detail.map.colorSpace =
 * THREE.NoColorSpace` because that albedo is a pure MULTIPLIER over the
 * terrain's vertex-painted colour, not a colour in its own right. An authored
 * albedo is sRGB by construction - the KTX2 container records it and
 * KTX2Loader tags the texture from it - so dropping one into that slot would
 * decode it and then multiply the terrain's own colour by it, twice-darkening
 * every road in the world. There is no such thing as an authored "multiplier"
 * map to buy, so the ground needs a different design, not this one.
 */
export const MEDIEVAL_EXCLUDED_SURFACES = Object.freeze(['detail']);

/**
 * Per-surface calibration: where an authored set's own idea of its finish has
 * to be overruled to be lit by THIS world. Same rule and same direction as
 * `MAZE_AUTHORED_CALIBRATION` - a set is brought TO the world's lighting, not
 * the other way round, because five surfaces must not be able to re-light the
 * vale between them.
 *
 * `null` is a DECLARATION, not an omission: it means "measured, and the set
 * wears its own finish". Which is why every entry here is `null` and must be:
 * NO FILE EXISTS YET, so no measurement exists yet, and a calibration
 * asserted without one is exactly the folklore this project keeps catching.
 * `medieval-surfaces.test.mjs` refuses a non-null entry for a surface whose
 * files are not on disk, so the first person to write one has to have the
 * bytes in front of them.
 *
 * @type {Readonly<{[surface:string]: null|Readonly<{flatOrm?:Readonly<{ao:number,
 *   roughness:number, metalness:number}>, normalScale?:number}>}>}
 */
export const MEDIEVAL_AUTHORED_CALIBRATION = Object.freeze({
  daub: null,
  beam: null,
  plank: null,
  thatch: null,
  cobble: null,
});

/**
 * The normal-map gain an authored set is dressed with unless its calibration
 * overrules it, and why it is not the material's own.
 *
 * `_std('daub', { normalScale: (2.4, 2.4) })` and `hay`'s 1.7 are not taste,
 * they are compensation: `normalFromHeight` Sobels a canvas that was filled
 * with flat grey and then painted, so its usable height range is a fraction
 * of the byte, and the gain buys the slope back. An authored NormalGL map
 * already encodes true surface slopes at unit gain, and multiplying its
 * tangent-space xy by 2.4 tilts every normal toward the horizon - which
 * three then renormalises, so the result is not "more relief", it is wrong
 * normals. The procedural gain is RECORDED at dress time and restored when
 * the A/B switch flips back, so neither state is guessing about the other.
 */
export const AUTHORED_NORMAL_SCALE = 1;

/* BASE_URL, not '/': the built game mounts under /game/ and a hard-coded
 * absolute path works in dev and 404s for the player. Guarded so the module
 * stays importable under plain Node (no import.meta.env). Built HERE rather
 * than in the shared core so the grep that catches the mistake lands on the
 * file that made the decision - see the core's header. */
const MEDIEVAL_ASSET_DIR = `${(import.meta.env && import.meta.env.BASE_URL) || '/'}assets/medieval/`;

/**
 * Its own manifest, next to `manifest.json` (the beasts) and
 * `frame-manifest.json` (the carpentry), because those two are geometry bound
 * to `BeastBody` and to the village `GeoBatch` and this one is textures bound
 * to a material table. One file per contract is what has kept those two from
 * having to know about each other.
 */
const _pipeline = createAuthoredAssets({
  label: 'MedievalSurfaces',
  dir: MEDIEVAL_ASSET_DIR,
  manifest: 'surface-manifest.json',
  namespace: 'medieval.authored',
  fallback: 'keeping the procedural bake',
});

/**
 * Load the declared surface sets. Resolves even when the manifest or any file
 * is absent - never rejects, and today resolves to `{}` because the manifest
 * declares no `assets` yet.
 *
 * @param {import('three').WebGLRenderer} [renderer] KTX2 needs it for
 *   `detectSupport`; without it texture entries are skipped with one warning,
 *   which is what `node --test` gets.
 */
export function loadMedievalSurfaces(renderer) {
  return _pipeline.load(renderer);
}

/** Complete authored sets only, keyed by surface - see the core's `surfaces`. */
export function medievalAuthoredSurfaces(assets) {
  return _pipeline.surfaces(assets);
}

/** Session teardown for tests; the game never calls it. */
export function resetMedievalSurfaces() {
  _pipeline.reset();
  _dressed.clear();
  _mode = 'procedural';
}

/**
 * surface -> { mat, authored:{map,normalMap,ormMap}, procedural:{...},
 * normalScale:{authored, procedural} }. Recorded by `dressMedievalSurfaces`
 * so the A/B switch can put either set back without the world rebuilding.
 */
let _dressed = new Map();

/** Which set the dressed materials currently wear. */
let _mode = 'procedural';

/**
 * Force-procedural override: `?proc=1` on the URL keeps every surface on its
 * procedural bake even when the authored sets loaded - the reviewer's half of
 * the A/B, one query flip apart from the authored build. The same flag
 * `MazeMaterials` reads, deliberately: a reviewer comparing two worlds should
 * not have to remember two spellings. Guarded so the module stays importable
 * under plain Node (no `location`).
 */
const FORCE_PROCEDURAL = typeof location !== 'undefined' && /[?&]proc=1/.test(location.search);

/**
 * Dress the world's materials in whichever authored sets actually loaded.
 *
 * Never throws, never leaves a slot empty, and never touches a material whose
 * set is incomplete or absent - which is what makes it safe against the
 * program budget: presence is what the cache key reads, and presence is
 * identical either way. See the header.
 *
 * @param {{[key:string]: import('three').Material}} mats `MedievalWorld._mats`
 * @param {{[id:string]: any}} assets the map `loadMedievalSurfaces` resolved
 * @returns {number} how many surfaces have an authored set available
 */
export function dressMedievalSurfaces(mats, assets) {
  return applyAuthoredSets(mats, medievalAuthoredSurfaces(assets));
}

/**
 * The binding itself, split out from the load so it can be proved headlessly.
 *
 * There is no `fetch` and no `WebGLRenderer` in `node --test`, so the arm of
 * this file a player actually sees - which slot each map lands in, what the
 * repeat works out to, and above all that slot PRESENCE is identical in both
 * modes - would otherwise be provable only in a browser. It takes resolved
 * sets rather than the asset map for exactly that reason: a test can hand it
 * three `DataTexture`s and check the arithmetic and the invariant that keeps
 * the program count still.
 *
 * @param {{[key:string]: import('three').Material}} mats
 * @param {{[surface:string]: {map:any, normalMap:any, ormMap:any}}} sets
 * @returns {number} how many surfaces were dressed
 */
export function applyAuthoredSets(mats, sets) {
  /* Idempotence, which a re-roll makes mandatory rather than tidy.
   *
   * `MedievalWorld.build` runs this once per build and a re-roll builds
   * again, so this can be called a second time on materials that are ALREADY
   * wearing the authored set. Reading `mat.map` at that point would record
   * the authored albedo as "the procedural one" and the A/B switch would then
   * have no way back. The previous record is therefore kept whenever it is
   * about the same material object; a rebuild makes new materials, so the
   * identity check is exactly the right discriminator, and the old map is
   * dropped so a torn-down world's materials do not stay reachable. */
  const prior = _dressed;
  _dressed = new Map();
  for (const [surface, set] of Object.entries(sets)) {
    const decl = MEDIEVAL_AUTHORED_SURFACES[surface];
    const mat = mats?.[surface];
    /* A set for a surface this world does not declare, or does not have a
     * material for, is a manifest that has drifted from the table. It is
     * ignored rather than bound, because binding it would mean deciding a
     * repeat with no declared tile size behind it. */
    if (!decl || !mat) continue;

    /* Repeat is tiles-per-UV-unit against world-scaled UVs, from the authored
     * set's own physical size - see the header. */
    const r = MEDIEVAL_UV_TILE_METRES / decl.tileMetres;
    for (const slot of ['map', 'normalMap', 'ormMap']) set[slot].repeat.set(r, r);

    const was = prior.get(surface);
    const kept = was && was.mat === mat ? was : null;
    _dressed.set(surface, {
      mat,
      authored: set,
      /* The procedural set is read off the MATERIAL rather than off `_tex`,
       * so whatever the world actually bound is what the A/B puts back -
       * including any slot a later art pass rewires without telling this file. */
      procedural: kept ? kept.procedural : {
        map: mat.map, normalMap: mat.normalMap,
        roughnessMap: mat.roughnessMap, aoMap: mat.aoMap,
      },
      normalScale: {
        authored: MEDIEVAL_AUTHORED_CALIBRATION[surface]?.normalScale ?? AUTHORED_NORMAL_SCALE,
        procedural: kept ? kept.normalScale.procedural : (mat.normalScale ? mat.normalScale.x : 1),
      },
    });
  }
  setMedievalSurfaceMode(FORCE_PROCEDURAL ? 'procedural' : 'authored');
  return _dressed.size;
}

/**
 * The A/B switch: dress every surface that HAS an authored set in either that
 * set or its procedural bake.
 *
 * Neither set's GPU copy is disposed on the way out, which is where this
 * departs from `setMazeSurfaceMode`, and the reason is ownership rather than
 * thrift: the maze owns its five surfaces outright, while this world's
 * procedural `beam` albedo is also the `bird` material's grain map and every
 * procedural texture here is in `MedievalWorld._owned` and disposed at world
 * teardown. Disposing one out from under a second material that still samples
 * it would be a silent black flock. The cost of keeping both resident is the
 * authored sets' ~21 MB of BC7 on top of the procedural bake; the saving is
 * that a flip costs one uniform write and cannot desynchronise two materials
 * that share a texture.
 *
 * `?proc=1` pins the choice at load, which is the half a reviewer needs and
 * the half this pass wires. The live console flip the maze has
 * (`HARNESS.mazeSurfaces`) is deliberately NOT wired here: that binding lives
 * in `src/main.js`, which this change does not touch, and an export claiming
 * a console entry point that does not exist is worse than no entry point. The
 * function is exported and ready for one line there.
 *
 * @param {'authored'|'procedural'} mode
 * @returns {'authored'|'procedural'} the mode actually in effect
 */
export function setMedievalSurfaceMode(mode) {
  if (_dressed.size === 0) return _mode;
  for (const [, d] of _dressed) {
    const authored = mode === 'authored';
    const m = d.mat;
    m.map = authored ? d.authored.map : d.procedural.map;
    m.normalMap = authored ? d.authored.normalMap : d.procedural.normalMap;
    /* One ORM, two slots: R is AO and G is roughness in the glTF packing, and
     * three reads exactly those channels from `aoMap` and `roughnessMap`. So
     * the authored state binds ONE texture where the procedural state binds
     * two - four textures per surface become three - with identical slot
     * presence. `metalnessMap` stays unbound in both: see the header. */
    m.roughnessMap = authored ? d.authored.ormMap : d.procedural.roughnessMap;
    m.aoMap = authored ? d.authored.ormMap : d.procedural.aoMap;
    if (m.normalScale) {
      const s = authored ? d.normalScale.authored : d.normalScale.procedural;
      m.normalScale.set(s, s);
    }
  }
  _mode = mode;
  return _mode;
}

/** Which set the dressed materials wear - for the harness and the tests. */
export function medievalSurfaceMode() {
  return _mode;
}

/**
 * Declared GPU bytes of the authored sets, for the budget conversation.
 *
 * Three slots per surface at 1 byte/texel - the worst case the installed
 * KTX2Loader can choose, which on desktop is BC7 at 8 bpp for both ETC1S and
 * UASTC sources - with a full mip chain (the 4/3). Computed from the table
 * rather than from live textures so the suite can hold it headlessly.
 */
export function declaredAuthoredBytes() {
  let bytes = 0;
  for (const { size } of Object.values(MEDIEVAL_AUTHORED_SURFACES)) {
    bytes += 3 * size * size * 1 * (4 / 3);
  }
  return bytes;
}
