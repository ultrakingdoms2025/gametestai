import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { createAuthoredAssets, TEXTURE_SLOTS } from '../../src/worlds/assets/AuthoredAssets.js';
import {
  MEDIEVAL_AUTHORED_SURFACES, MEDIEVAL_AUTHORED_CALIBRATION, MEDIEVAL_UV_TILE_METRES,
  MEDIEVAL_EXCLUDED_SURFACES, AUTHORED_NORMAL_SCALE,
  applyAuthoredSets, setMedievalSurfaceMode, medievalSurfaceMode, resetMedievalSurfaces,
  declaredAuthoredBytes,
} from '../../src/worlds/medieval/MedievalSurfaces.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The gate on Aldermoor Vale's authored PBR - the maze's asset pipeline
 * generalised to a second world.
 *
 * Written in the shape of `maze-assets.test.mjs`, which is the point: the
 * questions that only show up in practice are the same ones (the licence
 * line, the `/game/` base path, what happens when the file is not there), so
 * the second world gets the same answers rather than new ones.
 *
 * Two things here that the maze's gate could not have:
 *
 *  - the manifest declares files that DO NOT EXIST YET, because the KTX2 sets
 *    come from a separate generator. So the gate runs from both ends: an
 *    entry with no file must be in `pending` and must not claim a licence, a
 *    source or a byte count; an entry in `assets` must claim all three and be
 *    exactly the size it claims. Neither half can be satisfied by accident.
 *  - the invariant that makes this affordable at all - dressing changes which
 *    textures are bound and never WHICH SLOTS are bound - is asserted
 *    directly on real materials, in both modes, because slot presence is the
 *    only thing three's program cache key reads and a fourth bound slot would
 *    be a new shader-program family on a world whose entry allowance is 2.
 */

const manifestPath = path.join(root, 'public/assets/medieval/surface-manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const assetsDir = path.join(root, 'public/assets/medieval');
const declared = () => [...(manifest.assets ?? []), ...(manifest.pending ?? [])];
const attributions = () => readFileSync(path.join(root, 'docs/assets/LICENCES.md'), 'utf8');

/* ------------------------------------------------------------------ */
/* The manifest, and the table it has to agree with                    */
/* ------------------------------------------------------------------ */

test('every declared entry names a surface this world can dress and a slot it can bind', () => {
  const entries = declared();
  assert.ok(entries.length > 0, 'the manifest declares nothing at all - it is gating nothing');
  const seen = new Set();
  for (const e of entries) {
    for (const field of ['id', 'file', 'kind', 'surface', 'slot']) {
      assert.ok(typeof e[field] === 'string' && e[field].length > 0,
        `${e.id ?? '(no id)'}: entry is missing '${field}'`);
    }
    assert.equal(e.kind, 'texture', `${e.id}: this manifest is textures only`);
    assert.ok(!seen.has(e.id), `${e.id} is declared twice`);
    seen.add(e.id);
    const decl = MEDIEVAL_AUTHORED_SURFACES[e.surface];
    assert.ok(decl, `${e.id}: surface '${e.surface}' is not in MEDIEVAL_AUTHORED_SURFACES`);
    assert.ok(TEXTURE_SLOTS.includes(e.slot),
      `${e.id}: slot '${e.slot}' is not one of ${TEXTURE_SLOTS}`);
    /* `size` is OPTIONAL, and which way round is the point.
     *
     * On a pending entry it is the declared intent, and there is no file to
     * read it off. On a promoted one the KTX2 header carries it and
     * `MEDIEVAL_AUTHORED_SURFACES` declares it, so a third copy in the
     * manifest would be a third thing to disagree - and the generator that
     * writes these files (`scripts/make-world-tex.mjs`) deliberately does not
     * emit one, so requiring it would fail every entry it produces. Checked
     * against the table wherever it IS present, which is what stops a pending
     * entry declaring a size the world was never going to ask for. */
    if (e.size !== undefined) {
      assert.equal(e.size, decl.size,
        `${e.id}: declares ${e.size}px against the table's ${decl.size}px for '${e.surface}'`);
    }
    /* The file path must sit under this world's own directory. A '..' would
     * reach out of public/assets/medieval/ and quietly load another world's
     * bytes under this world's licence line. */
    assert.ok(!e.file.includes('..') && !e.file.startsWith('/'),
      `${e.id}: file '${e.file}' escapes the world's asset directory`);
    /* The filename is the one place this manifest has to agree with a file
     * this repository does not write by hand: `scripts/make-world-tex.mjs`
     * emits `tex/<surface>-<suffix>.ktx2` with suffixes albedo/normal/orm.
     * Spelled out here rather than imported from that script, because a
     * cross-import would make this gate fail for reasons that are not about
     * this world - but a typo in a filename is a silent 404 that degrades so
     * gracefully nobody notices the surface never arrived. */
    const SUFFIX = { map: 'albedo', normalMap: 'normal', ormMap: 'orm' };
    assert.equal(e.file, `tex/${e.surface}-${SUFFIX[e.slot]}.ktx2`,
      `${e.id}: file '${e.file}' is not the name the texture generator emits for this slot`);
  }
});

test('every surface in the table is declared, and every declared surface has a complete set', () => {
  /* Runtime refuses an incomplete set (an authored albedo under a procedural
   * normal map disagrees about where the relief is); this is the commit-time
   * version of the same rule, so an incomplete set is a test failure rather
   * than a silent fallback that nobody notices for a month. */
  const bySurface = {};
  for (const e of declared()) (bySurface[e.surface] ??= new Set()).add(e.slot);
  for (const [surface, slots] of Object.entries(bySurface)) {
    for (const slot of TEXTURE_SLOTS) {
      assert.ok(slots.has(slot), `surface '${surface}' has no ${slot} entry - the set is incomplete`);
    }
  }
  for (const surface of Object.keys(MEDIEVAL_AUTHORED_SURFACES)) {
    assert.ok(bySurface[surface],
      `'${surface}' is in the table and in no manifest array - a surface that waits forever`);
  }
  /* And the whole set must be in ONE array: half-promoted is a world where
   * two of three maps load and the surface silently keeps its bake. */
  for (const surface of Object.keys(bySurface)) {
    const inAssets = (manifest.assets ?? []).filter((e) => e.surface === surface).length;
    const inPending = (manifest.pending ?? []).filter((e) => e.surface === surface).length;
    assert.ok(inAssets === 0 || inPending === 0,
      `'${surface}' is split across assets and pending - promote a set, never a slot`);
  }
});

test('a promoted entry has its file, its bytes and its ledger line; a pending one has none of them', () => {
  /* The forcing function. `bytes`, `licence` and `source` are facts about a
   * file: they may not be claimed before the file exists, and they may not be
   * omitted once it does. Which means the day the generator writes the KTX2
   * sets, it cannot ship them without also writing the ledger line. */
  const ALLOWED = ['CC0-1.0', 'CC-BY-4.0', 'proprietary-owned', 'generated'];
  for (const e of manifest.assets ?? []) {
    assert.ok(ALLOWED.includes(e.licence), `${e.id}: licence '${e.licence}' is not on the allow-list`);
    assert.ok(typeof e.source === 'string' && e.source.length > 0, `${e.id}: no source`);
    /* The ledger records every external file regardless of obligation, so the
     * day a CC-BY file arrives there is already a place its line goes. */
    assert.ok(attributions().includes(e.id),
      `${e.id} has no line in docs/assets/LICENCES.md - every asset gets one, allow-listed or not`);
    const file = path.join(assetsDir, e.file);
    const buf = readFileSync(file); // throws if the file is not committed
    assert.equal(buf.length, e.bytes,
      `${e.id}: ${e.file} is ${buf.length} bytes on disk against a declared ${e.bytes} - a re-export drifted from the manifest`);
    /* The KTX2 header is little-endian u32s after a 12-byte identifier:
     * pixelWidth@20, pixelHeight@24. Reading it is what makes the size table
     * a declaration with teeth rather than a comment. */
    const magic = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb];
    for (let i = 0; i < magic.length; i++) {
      assert.equal(buf[i], magic[i], `${e.id}: ${e.file} is not a KTX2 file`);
    }
    const width = buf.readUInt32LE(20);
    const height = buf.readUInt32LE(24);
    const want = MEDIEVAL_AUTHORED_SURFACES[e.surface].size;
    assert.equal(width, want,
      `${e.id}: ${width}px against the ${want}px MEDIEVAL_AUTHORED_SURFACES declares for '${e.surface}' `
      + '- which is a download-budget decision, so a silent re-export at 2048 is a 4x bill');
    assert.equal(width, height, `${e.id}: not square`);
  }
  for (const e of manifest.pending ?? []) {
    for (const claim of ['licence', 'source', 'bytes']) {
      assert.equal(e[claim], undefined,
        `${e.id} is pending and claims a '${claim}' - that is a fact about a file, and there is no file`);
    }
    assert.ok(!existsSync(path.join(assetsDir, e.file)),
      `${e.id}: ${e.file} exists on disk but is still in 'pending' - a produced file that nothing gates`);
  }
});

/* ------------------------------------------------------------------ */
/* The two rules that fail only for the player                         */
/* ------------------------------------------------------------------ */

test('asset URLs go through the Vite base, or the built game 404s', async () => {
  /* This project sets base: '/game/'. A leading-slash path works in dev and
   * fails in the build, which is the worst shape of bug: it passes every
   * check a developer runs and fails only for the player. Asserted on BOTH
   * files in the chain - the world builds its own directory, the shared core
   * builds the vendored transcoder path - which is precisely why the
   * directory is not built inside the core. */
  for (const rel of [
    'src/worlds/medieval/MedievalSurfaces.js',
    'src/worlds/assets/AuthoredAssets.js',
  ]) {
    const src = await readFile(path.join(root, rel), 'utf8');
    assert.ok(!/['"`]\/assets\//.test(src), `${rel}: a hard-coded absolute asset path`);
    assert.ok(!/['"`]\/vendor\//.test(src), `${rel}: a hard-coded absolute vendor path`);
  }
  const world = await readFile(path.join(root, 'src/worlds/medieval/MedievalSurfaces.js'), 'utf8');
  assert.ok(/import\.meta\.env\.BASE_URL/.test(world),
    'MedievalSurfaces does not build its asset directory from BASE_URL');
  const core = await readFile(path.join(root, 'src/worlds/assets/AuthoredAssets.js'), 'utf8');
  assert.ok(/import\.meta\.env\.BASE_URL/.test(core),
    'AuthoredAssets does not build the transcoder path from BASE_URL');
});

test('the UV contract the repeat arithmetic turns on is the one the geometry helpers implement', async () => {
  /* `repeat = MEDIEVAL_UV_TILE_METRES / tileMetres` is only correct while a
   * UV unit really is two metres, and that comes from one default argument
   * three thousand lines away in another file. Changing it would silently
   * rescale every authored set in the world, so it is read rather than
   * trusted. */
  const src = await readFile(path.join(root, 'src/worlds/MedievalWorld.js'), 'utf8');
  const m = /function boxGeo\(w, h, d, tile = ([0-9.]+)\)/.exec(src);
  assert.ok(m, 'boxGeo no longer has a default tile - the UV contract has moved');
  assert.equal(MEDIEVAL_UV_TILE_METRES, 1 / Number(m[1]),
    `boxGeo tiles at ${m[1]} per metre, so a UV unit is ${1 / Number(m[1])} m, `
    + `not the ${MEDIEVAL_UV_TILE_METRES} m the repeat arithmetic assumes`);
});

/* ------------------------------------------------------------------ */
/* The invariant that keeps the program count still                    */
/* ------------------------------------------------------------------ */

/** A stand-in for one of `_buildMaterials`' surfaced materials. */
function proceduralMaterial(name, normalScale = 1) {
  const t = () => new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
  const m = new THREE.MeshStandardMaterial({
    map: t(), normalMap: t(), roughnessMap: t(), aoMap: t(),
    roughness: 1, metalness: 0, vertexColors: true,
  });
  m.normalScale.set(normalScale, normalScale);
  m.name = `medieval.${name}`;
  return m;
}

/** A resolved authored set, as `AuthoredAssets.surfaces` would hand one back. */
function authoredSet() {
  const t = (n) => {
    const tex = new THREE.DataTexture(new Uint8Array([200, 180, 0, 255]), 1, 1);
    tex.name = n;
    return tex;
  };
  return { map: t('a'), normalMap: t('n'), ormMap: t('orm') };
}

/** Which map slots three's program cache key would see as present. */
const slotPresence = (m) => ({
  map: !!m.map,
  normalMap: !!m.normalMap,
  roughnessMap: !!m.roughnessMap,
  metalnessMap: !!m.metalnessMap,
  aoMap: !!m.aoMap,
  emissiveMap: !!m.emissiveMap,
  alphaMap: !!m.alphaMap,
  bumpMap: !!m.bumpMap,
  displacementMap: !!m.displacementMap,
  channels: [m.map?.channel, m.normalMap?.channel, m.roughnessMap?.channel, m.aoMap?.channel],
});

test('dressing swaps which textures are bound and never which slots - so it costs no program', (t) => {
  t.after(() => resetMedievalSurfaces());
  resetMedievalSurfaces();
  const mats = { daub: proceduralMaterial('daub', 2.4), cobble: proceduralMaterial('cobble') };
  const before = { daub: slotPresence(mats.daub), cobble: slotPresence(mats.cobble) };
  const versions = { daub: mats.daub.version, cobble: mats.cobble.version };

  const n = applyAuthoredSets(mats, { daub: authoredSet(), cobble: authoredSet() });
  assert.equal(n, 2, 'two declared surfaces with complete sets dressed neither or one');
  assert.equal(medievalSurfaceMode(), 'authored');

  for (const k of ['daub', 'cobble']) {
    assert.deepEqual(slotPresence(mats[k]), before[k],
      `'${k}' changed which map slots are bound - that is a new shader-program family`);
    /* three only recomputes a program cache key when `material.version`
     * moves. Assigning a texture into an already-bound slot must not move it;
     * `material.needsUpdate = true` would, and would relink for nothing. */
    assert.equal(mats[k].version, versions[k],
      `'${k}'.version moved, so three will recompute its program cache key`);
    assert.equal(mats[k].roughnessMap, mats[k].aoMap,
      `'${k}' bound two textures where the ORM is one - R is AO and G is roughness in one file`);
    assert.equal(mats[k].metalnessMap, null,
      `'${k}' bound metalnessMap, which these materials never had - a fourth slot is a new family`);
  }
  /* The normal gain is not carried over: it existed to buy back the range a
   * Sobel of a flat-grey canvas throws away, and an authored NormalGL map
   * already encodes true slopes at unit gain. */
  assert.equal(mats.daub.normalScale.x, AUTHORED_NORMAL_SCALE,
    "daub kept its procedural 2.4 normal gain on an authored normal map");

  /* And back, which is the half that proves the A/B is a real control rather
   * than a one-way door. */
  assert.equal(setMedievalSurfaceMode('procedural'), 'procedural');
  assert.equal(mats.daub.normalScale.x, 2.4, 'the procedural normal gain was not restored');
  for (const k of ['daub', 'cobble']) {
    assert.deepEqual(slotPresence(mats[k]), before[k], `'${k}' lost a slot on the way back`);
    assert.notEqual(mats[k].roughnessMap, mats[k].aoMap,
      `'${k}' still wears one ORM in two slots after flipping back to the procedural bake`);
  }
});

test('a second dress of the same materials does not record the authored set as the procedural one', (t) => {
  t.after(() => resetMedievalSurfaces());
  resetMedievalSurfaces();
  /* A re-roll rebuilds the world, and a rebuild dresses again. Reading
   * `mat.map` the second time - when it is already the authored albedo -
   * would leave the A/B switch with no way back, and nothing about the frame
   * would look wrong until a reviewer pressed the switch. */
  const mats = { thatch: proceduralMaterial('thatch') };
  const proceduralAlbedo = mats.thatch.map;
  applyAuthoredSets(mats, { thatch: authoredSet() });
  applyAuthoredSets(mats, { thatch: authoredSet() });
  setMedievalSurfaceMode('procedural');
  assert.equal(mats.thatch.map, proceduralAlbedo,
    'the second dress overwrote the recorded procedural set with the authored one');
});

test('a set for a surface the world does not declare is ignored, not bound', (t) => {
  t.after(() => resetMedievalSurfaces());
  resetMedievalSurfaces();
  /* Binding it would mean choosing a repeat with no declared tile size behind
   * it, which is the silent "everything is the wrong size" failure. */
  const mats = { detail: proceduralMaterial('detail'), ashlar: proceduralMaterial('ashlar') };
  const was = mats.detail.map;
  assert.equal(applyAuthoredSets(mats, { detail: authoredSet(), ashlar: authoredSet() }), 0);
  assert.equal(mats.detail.map, was, 'an undeclared surface was dressed anyway');
  for (const s of MEDIEVAL_EXCLUDED_SURFACES) {
    assert.ok(!(s in MEDIEVAL_AUTHORED_SURFACES),
      `'${s}' is on the excluded list and in the table - one of the two is wrong`);
  }
});

test('the repeat comes from the authored tile size, and headless stays procedural', (t) => {
  t.after(() => resetMedievalSurfaces());
  resetMedievalSurfaces();
  const mats = { cobble: proceduralMaterial('cobble') };
  const set = authoredSet();
  applyAuthoredSets(mats, { cobble: set });
  const expect = MEDIEVAL_UV_TILE_METRES / MEDIEVAL_AUTHORED_SURFACES.cobble.tileMetres;
  for (const slot of TEXTURE_SLOTS) {
    assert.equal(set[slot].repeat.x, expect, `${slot} repeat is not the declared tile`);
    assert.equal(set[slot].repeat.y, expect, `${slot} repeat is not square`);
  }
  resetMedievalSurfaces();
  /* Headless nothing loads KTX2, so the mode must be procedural and the
   * switch a safe no-op - the same never-a-hole rule the maze's gate pins. */
  assert.equal(medievalSurfaceMode(), 'procedural');
  assert.equal(setMedievalSurfaceMode('authored'), 'procedural',
    'setMedievalSurfaceMode claimed authored surfaces exist in a session that loaded none');
});

/* ------------------------------------------------------------------ */
/* Degradation - the state this ships in                               */
/* ------------------------------------------------------------------ */

/**
 * A `fetch` stand-in. `ok:false` is what a 404 looks like to the loader;
 * `throw` is what a dead socket or an aborted request looks like.
 */
function stubFetch(handler) {
  const prev = globalThis.fetch;
  globalThis.fetch = async (url) => handler(String(url));
  return () => { globalThis.fetch = prev; };
}

test('the degradation assertions can actually see a rejection', async () => {
  /* The control, and it is not ceremony: a "resolves rather than throws"
   * assertion that cannot observe a throw is worthless, and every assertion
   * below is exactly that shape. This proves the mechanism has teeth before
   * the real cases lean on it. */
  await assert.rejects(
    (async () => { throw new Error('boom'); })(),
    /boom/,
    'assert.rejects did not observe a thrown error - every degradation assertion below is vacuous',
  );
});

test('a missing manifest degrades to an empty map, and logs once', async () => {
  const restore = stubFetch(async () => { throw new Error('ECONNREFUSED'); });
  const warned = [];
  const prevWarn = console.warn;
  console.warn = (m) => warned.push(String(m));
  try {
    const p = createAuthoredAssets({ label: 'T', dir: 'x/', manifest: 'm.json' });
    const a = await p.load();
    assert.deepEqual(a, {}, 'a dead manifest fetch did not resolve to an empty map');
    assert.deepEqual(p.surfaces(a), {}, 'surfaces() invented a set out of nothing');
    /* Cached for the session, so a second build does not re-fetch - and the
     * warning does not repeat, which is the whole once-per-session rule. */
    await p.load();
    assert.equal(warned.length, 1, `${warned.length} warnings for one missing manifest`);
  } finally {
    console.warn = prevWarn;
    restore();
  }
});

test('a missing FILE degrades without its entry, and the rest of the manifest still loads', async () => {
  /* The case the whole design exists for, and the one that will be true of
   * this world on every boot until the KTX2 sets are produced. Driven through
   * a geometry entry because a texture entry needs a live WebGLRenderer for
   * KTX2 `detectSupport`, and there is not one in `node --test` - the two
   * paths share the same try/catch and the same warnOnce, which is the thing
   * under test. */
  const manifestBody = {
    assets: [
      { id: 'gone', file: 'gone.glb', kind: 'geometry', licence: 'generated', source: 't' },
      { id: 'odd', file: 'odd.bin', kind: 'sound', licence: 'generated', source: 't' },
    ],
  };
  const restore = stubFetch(async (url) => {
    if (url.endsWith('m.json')) {
      return { ok: true, json: async () => manifestBody };
    }
    return { ok: false, status: 404 };
  });
  const warned = [];
  const prevWarn = console.warn;
  console.warn = (m) => warned.push(String(m));
  try {
    const p = createAuthoredAssets({ label: 'T', dir: 'x/', manifest: 'm.json' });
    /* `await` rather than `assert.doesNotReject` so a rejection surfaces as
     * the real error rather than as an assertion message about one. */
    const a = await p.load();
    assert.deepEqual(Object.keys(a), [],
      'a 404 on an asset file put something in the map anyway');
    assert.equal(warned.length, 2, `${warned.length} warnings for one 404 and one bad kind`);
    assert.ok(warned.some((w) => /gone/.test(w)), 'the missing file was not named');
    assert.ok(warned.some((w) => /unhandled kind/.test(w)), 'the unknown kind was not reported');
  } finally {
    console.warn = prevWarn;
    restore();
  }
});

test('a manifest with no assets array, or an empty one, resolves rather than throwing', async () => {
  for (const body of [{}, { assets: [] }, { assets: 'not an array' }, null]) {
    const restore = stubFetch(async () => ({ ok: true, json: async () => body }));
    try {
      const p = createAuthoredAssets({ label: 'T', dir: 'x/', manifest: 'm.json' });
      assert.deepEqual(await p.load(), {},
        `a manifest of ${JSON.stringify(body)} did not resolve to an empty map`);
    } finally {
      restore();
    }
  }
});

test("the shipped manifest declares no loadable assets yet, so today's vale is unchanged", async () => {
  /* Stated as a test rather than left to a comment, because it is the claim
   * the whole pass rests on right now: nothing is fetched, nothing is bound,
   * and the world renders exactly as it did. When the generator promotes the
   * first set this test is what says so out loud. */
  assert.ok(Array.isArray(manifest.assets), 'the manifest has no assets array');
  if (manifest.assets.length === 0) {
    assert.ok((manifest.pending ?? []).length > 0,
      'nothing is promoted and nothing is pending - the manifest declares no intent at all');
  }
});

/* ------------------------------------------------------------------ */
/* Download and GPU cost                                               */
/* ------------------------------------------------------------------ */

test('the authored sets stay inside a declared download and GPU ceiling', () => {
  /* Download is a real cost: public/ is 20 MB today and the maze's five
   * surfaces are 17 MB of it. This ceiling is on the DECLARED bytes, so it
   * bites the moment the generator promotes a set that is too big rather
   * than after someone notices the game got heavier.
   *
   * 9 MB: five 1024 sets, priced off the maze's three committed 1024 sets
   * (stair 0.75 MB, footing 1.80 MB, tunnel 1.76 MB - mean 1.44 MB) with
   * room for the normal maps, which are UASTC and are ~73% of each of those
   * totals. If a set lands materially over that, the lever is the normal
   * map's encoder, not the albedo. */
  const CEILING = 9 * 1024 * 1024;
  let bytes = 0;
  for (const e of manifest.assets ?? []) bytes += e.bytes;
  assert.ok(bytes <= CEILING,
    `the promoted sets are ${(bytes / 1048576).toFixed(2)} MB against a ${CEILING / 1048576} MB ceiling`);

  /* And the GPU side, which is the part a download budget hides: both sets
   * are resident at once here (see setMedievalSurfaceMode on why nothing is
   * disposed), so the authored bytes are added to the procedural bake rather
   * than replacing it. Three slots per surface at 1 byte/texel is the worst
   * case the installed KTX2Loader can pick - BC7 at 8 bpp - with mips. */
  const gpu = declaredAuthoredBytes();
  assert.ok(gpu <= 24 * 1024 * 1024,
    `the authored sets declare ${(gpu / 1048576).toFixed(1)} MB of GPU texture`);
  assert.equal(gpu, Object.values(MEDIEVAL_AUTHORED_SURFACES)
    .reduce((n, s) => n + 3 * s.size * s.size * (4 / 3), 0),
    'declaredAuthoredBytes and the surface table disagree');
});

/* ------------------------------------------------------------------ */
/* Calibration: a decision you may not make without the bytes          */
/* ------------------------------------------------------------------ */

test('every authored surface declares a calibration, and none may be asserted without a file', () => {
  /* The table is a DECLARATION per surface, `null` included: nobody adds a
   * sixth authored set without saying, in the same commit, whether this
   * world's lighting can take its finish as shipped. A missing key reads as
   * "not calibrated" exactly like `null` does, and only one of those is a
   * decision - which is the failure this catches. */
  assert.deepEqual(
    Object.keys(MEDIEVAL_AUTHORED_CALIBRATION).sort(),
    Object.keys(MEDIEVAL_AUTHORED_SURFACES).sort(),
    'the calibration table and the surface table disagree about which surfaces exist',
  );
  const promoted = new Set((manifest.assets ?? []).map((e) => e.surface));
  for (const [surface, cal] of Object.entries(MEDIEVAL_AUTHORED_CALIBRATION)) {
    if (cal === null) continue;
    /* The rule this project keeps re-learning: a number with no measurement
     * behind it is folklore. There is no measuring a file that does not
     * exist, so a calibration for an unpromoted surface is refused outright. */
    assert.ok(promoted.has(surface),
      `'${surface}' declares a calibration and has no committed file to have measured`);
    if (cal.flatOrm) {
      for (const ch of ['ao', 'roughness', 'metalness']) {
        assert.ok(typeof cal.flatOrm[ch] === 'number' && cal.flatOrm[ch] >= 0 && cal.flatOrm[ch] <= 1,
          `'${surface}'.flatOrm.${ch} is ${cal.flatOrm[ch]}, outside the 0..1 an ORM channel can carry`);
      }
      assert.equal(cal.flatOrm.metalness, 0,
        `'${surface}'.flatOrm.metalness is ${cal.flatOrm.metalness}; every surface here is a dielectric`);
    }
    if (cal.normalScale !== undefined) {
      assert.ok(typeof cal.normalScale === 'number' && cal.normalScale > 0 && cal.normalScale <= 3,
        `'${surface}'.normalScale is ${cal.normalScale}`);
    }
  }
});
