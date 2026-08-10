import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { MAZE, generateTopology, cellIndex, isOpen, DIR, connectorAt } from '../../src/worlds/maze/MazeTopology.js';
import {
  prefabFor, releasePrefabs, isPrefab, DRESSING_KINDS,
} from '../../src/worlds/maze/MazeMeshes.js';
import { MAZE_ASSET_PREFABS, MAZE_TEXTURE_SLOTS } from '../../src/worlds/maze/MazeAssets.js';
import {
  MAZE_AUTHORED_TEXTURE_SIZES, MAZE_AUTHORED_TILE_METRES, mazeSurfaceMode, setMazeSurfaceMode,
} from '../../src/worlds/maze/MazeMaterials.js';
import { CHUNK_MESH_KINDS } from '../../src/worlds/maze/MazeChunks.js';
import { BATCH_FAMILIES, GEOMETRY_BUDGET } from '../../src/worlds/maze/MazeBatches.js';
import { newelPlacements, NEWEL_HALF } from '../../src/worlds/maze/MazeFoliage.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Task 8's gate: the authored-asset pipeline, proved by one hero prop.
 *
 * The pipeline is manifest -> loader -> prefab registry, and every test here
 * is one of the practical questions the plan says only show up in practice:
 * the licence line, the `/game/` base path, the fallback when the fetch 404s,
 * and whether a loaded mesh actually lands in the same registry-and-batch
 * machinery every procedural prefab already rides.
 *
 * The loading itself (fetch + GLTFLoader.parse) is browser-only and is proved
 * by the dev-server and build-preview gates; what is provable headless is
 * everything AROUND the load - which is exactly the part that keeps working
 * when the file is missing, and the part these tests own.
 */

const manifest = JSON.parse(
  readFileSync(path.join(root, 'public/assets/maze/manifest.json'), 'utf8'),
);

const attributions = () => readFileSync(path.join(root, 'docs/assets/LICENCES.md'), 'utf8');

test('every manifest entry declares a licence from the allow-list', () => {
  /* Sketchfab is a licence minefield and CC-BY carries an attribution
   * obligation that is invisible at import time and expensive at ship time.
   * The allow-list is the cheapest possible place to enforce it. */
  const ALLOWED = ['CC0-1.0', 'CC-BY-4.0', 'proprietary-owned', 'generated'];
  assert.ok(Array.isArray(manifest.assets) && manifest.assets.length > 0,
    'the manifest declares no assets - Task 8 lands the pipeline with exactly one in it');
  for (const e of manifest.assets) {
    assert.ok(ALLOWED.includes(e.licence), `${e.id}: licence '${e.licence}' is not on the allow-list`);
    if (e.licence === 'CC-BY-4.0') {
      assert.ok(attributions().includes(e.id), `${e.id} is CC-BY and has no line in docs/assets/LICENCES.md`);
    }
    /* The ledger records every external file regardless of obligation, so the
     * day a CC-BY file arrives there is already a place its line goes. */
    assert.ok(attributions().includes(e.id),
      `${e.id} has no line in docs/assets/LICENCES.md - every asset gets one, allow-listed or not`);
    for (const field of ['id', 'file', 'kind', 'licence', 'source']) {
      assert.ok(typeof e[field] === 'string' && e[field].length > 0,
        `${e.id ?? '(no id)'}: manifest entry is missing '${field}'`);
    }
  }
});

test('asset URLs go through the Vite base, or the built game 404s', async () => {
  /* This project sets base: '/game/'. A leading-slash path works in dev and
   * fails in the build, which is the worst shape of bug: it passes every check
   * a developer runs and fails only for the player. */
  const src = await readFile(path.join(root, 'src/worlds/maze/MazeAssets.js'), 'utf8');
  assert.ok(!/['"`]\/assets\//.test(src), 'a hard-coded absolute asset path');
  /* Task 9 extends the same discipline to the vendored Basis transcoder:
   * /vendor/basis/ is served from public/ exactly like /assets/, and a
   * leading-slash path 404s under the /game/ base in exactly the same way. */
  assert.ok(!/['"`]\/vendor\//.test(src), 'a hard-coded absolute vendor path');
  assert.ok(/import\.meta\.env\.BASE_URL/.test(src), 'BASE_URL is not used to build asset URLs');
});

/* ------------------------------------------------------------------ */
/* Task 9: the bulk CC0 texture sets                                   */
/* ------------------------------------------------------------------ */

const textureEntries = manifest.assets.filter((e) => e.kind === 'texture');

test('texture entries declare a surface, a slot, and a real committed file of the declared size', () => {
  assert.ok(textureEntries.length > 0, 'Task 9 landed no texture entries');
  for (const e of textureEntries) {
    assert.ok(MAZE_AUTHORED_TEXTURE_SIZES[e.surface],
      `${e.id}: surface '${e.surface}' has no entry in MAZE_AUTHORED_TEXTURE_SIZES`);
    assert.ok(MAZE_TEXTURE_SLOTS.includes(e.slot),
      `${e.id}: slot '${e.slot}' is not one of ${MAZE_TEXTURE_SLOTS}`);
    const file = path.join(root, 'public/assets/maze', e.file);
    const buf = readFileSync(file); // throws if the file is not committed
    assert.equal(buf.length, e.bytes,
      `${e.id}: ${e.file} is ${buf.length} bytes on disk against a declared ${e.bytes} - re-export drifted from the manifest`);
    /* The KTX2 header is little-endian u32s after a 12-byte identifier:
     * vkFormat@12, typeSize@16, pixelWidth@20. Reading it here is what makes
     * the size table above a declaration with teeth rather than a comment. */
    const magic = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb];
    for (let i = 0; i < magic.length; i++) {
      assert.equal(buf[i], magic[i], `${e.id}: ${e.file} is not a KTX2 file`);
    }
    const width = buf.readUInt32LE(20);
    const height = buf.readUInt32LE(24);
    assert.equal(width, MAZE_AUTHORED_TEXTURE_SIZES[e.surface],
      `${e.id}: ${width}px against the declared ${MAZE_AUTHORED_TEXTURE_SIZES[e.surface]}px for '${e.surface}'`);
    assert.equal(width, height, `${e.id}: not square`);
  }
});

test('every surface that has any authored texture has the complete set', () => {
  /* MazeAssets.authoredSurfaces refuses an incomplete set at runtime (an
   * authored albedo under a procedural normal map disagrees about where the
   * relief is); this is the commit-time version of the same rule, so an
   * incomplete set is a test failure rather than a silent fallback. */
  const bySurface = {};
  for (const e of textureEntries) (bySurface[e.surface] ??= new Set()).add(e.slot);
  for (const [surface, slots] of Object.entries(bySurface)) {
    for (const slot of MAZE_TEXTURE_SLOTS) {
      assert.ok(slots.has(slot), `surface '${surface}' has no ${slot} entry - the set is incomplete`);
    }
  }
});

test('every authored surface declares its physical tile, and headless stays procedural', () => {
  for (const surface of Object.keys(MAZE_AUTHORED_TEXTURE_SIZES)) {
    const m = MAZE_AUTHORED_TILE_METRES[surface];
    assert.ok(typeof m === 'number' && m > 0,
      `'${surface}' has no physical tile size - its repeat would be undefined against world-scale UVs`);
  }
  /* Headless, nothing loads KTX2, so the mode must be procedural and the
   * switch must be a safe no-op - the same never-a-hole rule as geometry. */
  assert.equal(mazeSurfaceMode(), 'procedural');
  assert.equal(setMazeSurfaceMode('authored'), 'procedural',
    'setMazeSurfaceMode claimed authored surfaces exist in a session that loaded none');
});

test('a missing asset degrades to its procedural prefab', () => {
  /* The user may never supply a model. The world must not care. */
  const g = prefabFor({ kind: 'newel', hx: 0.3, hy: 0.5, hz: 0.3, lod: 0, assets: {} });
  assert.ok(g, 'no fallback geometry when the asset is absent - the world would render a hole');
  releasePrefabs();
});

test('the fallback newel is a real prefab: cached, in-box, and batchable with the stone family', () => {
  /* The fallback is not an apology - it is the same first-class prefab every
   * other kind gets, because Option D's whole design is that a world with no
   * authored file must be indistinguishable in kind from one with. */
  const ext = { kind: 'newel', hx: 0.3, hy: 0.5, hz: 0.3 };
  const a = prefabFor({ ...ext, lod: 0 });
  const b = prefabFor({ ...ext, lod: 0, assets: {} });
  assert.equal(a, b, 'assets:{} and assets omitted built two fallback geometries for one class');
  assert.ok(isPrefab(a), 'the registry does not own the newel fallback');

  /* Dressing is EXEMPT from the fit contract, but the fallback keeps to the
   * box anyway - free to assert, and it means the exemption is spare headroom
   * for authored art rather than something the procedural path leans on. */
  a.computeBoundingBox();
  const bb = a.boundingBox;
  const EPS = 1e-6;
  assert.ok(bb.min.x >= -ext.hx - EPS && bb.max.x <= ext.hx + EPS
         && bb.min.y >= -ext.hy - EPS && bb.max.y <= ext.hy + EPS
         && bb.min.z >= -ext.hz - EPS && bb.max.z <= ext.hz + EPS,
    'the fallback newel leaves its dressing box');

  /* The stone material reads vertexColors; a geometry without the attribute
   * renders BLACK, silently - the same trap maze-bevel.test.mjs pins for
   * every other stone kind. And it needs uv, because the stone material
   * carries the Task 5 map set. */
  assert.ok(a.attributes.color, 'the fallback newel has no colour attribute - it would render black');
  assert.ok(a.attributes.uv, 'the fallback newel has no uv - the stone maps cannot land on it');
  assert.ok(a.attributes.normal, 'the fallback newel has no normals');

  /* One tier: at newel size (0.6 m), LOD is noise. Same object at every lod
   * is the contract that makes MazeBatches.setLod skip it (gidNear===gidFar). */
  assert.equal(prefabFor({ ...ext, lod: 1 }), a, 'newel lod 1 is a second geometry for one small prop');
  assert.equal(prefabFor({ ...ext, lod: 2 }), a, 'newel lod 2 is a second geometry for one small prop');

  /* And it must fit the stone batch's per-prefab reservation, or addGeometry
   * throws at boot in the first shaft district streamed. */
  const budget = GEOMETRY_BUDGET.stone;
  assert.ok(a.attributes.position.count <= budget.verts,
    `fallback newel is ${a.attributes.position.count} verts, stone reservation ${budget.verts}`);
  assert.ok(a.index.count <= budget.indices,
    `fallback newel is ${a.index.count} indices, stone reservation ${budget.indices}`);
  releasePrefabs();
});

test('an authored geometry is adopted, refitted into the dressing box, and cached apart from the fallback', () => {
  /* Headless stand-in for the browser load: whatever GLTFLoader hands back is
   * just a BufferGeometry by the time the registry sees it, so the adoption
   * path is provable with a made-up one. Authored deliberately at the WRONG
   * size and off-centre, because the whole point of the refit is that an
   * artist's export scale must not matter. */
  const authored = new THREE.CylinderGeometry(2, 3, 10, 12);
  authored.translate(5, 3, -2);
  const assets = { [MAZE_ASSET_PREFABS.newel]: authored };

  const ext = { kind: 'newel', hx: 0.3, hy: 0.5, hz: 0.3 };
  const fallback = prefabFor({ ...ext, lod: 0 });
  const loaded = prefabFor({ ...ext, lod: 0, assets });
  assert.notEqual(loaded, fallback,
    'the asset-backed prefab and the fallback share a cache slot - one of them is being served for the other');
  assert.equal(loaded, prefabFor({ ...ext, lod: 0, assets }), 'the asset-backed prefab is not cached');
  assert.ok(isPrefab(loaded), 'the registry does not own the asset-backed prefab');
  assert.notEqual(loaded, authored,
    'the registry adopted the session-cached source geometry itself - releasePrefabs would dispose it');

  /* Refit: uniform scale, centred in x/z, standing on the box floor, inside
   * the dressing box. Uniform, because a non-uniform fit would squash the
   * authored silhouette - the one thing an authored asset is FOR. */
  loaded.computeBoundingBox();
  const bb = loaded.boundingBox;
  const EPS = 1e-6;
  assert.ok(bb.min.x >= -ext.hx - EPS && bb.max.x <= ext.hx + EPS
         && bb.min.y >= -ext.hy - EPS && bb.max.y <= ext.hy + EPS
         && bb.min.z >= -ext.hz - EPS && bb.max.z <= ext.hz + EPS,
    'the refitted asset leaves its dressing box');
  assert.ok(Math.abs(bb.min.y - (-ext.hy)) < 1e-3, 'the refitted asset floats above the box floor');

  /* Same attribute contract as the fallback: the stone material does not know
   * or care where a geometry came from. */
  assert.ok(loaded.attributes.color, 'the asset-backed newel has no colour attribute - it would render black');
  assert.ok(loaded.attributes.uv, 'the asset-backed newel has no uv');
  releasePrefabs();
});

test('the newel is dressing: batched with stone, never a collider kind', () => {
  /* The dressing exemption from the fit contract is EXPLICIT (dressing: true
   * in the registry) rather than implied by absence - and the reason it is
   * safe is provable: a kind that never appears in CHUNK_MESH_KINDS never
   * comes from districtColliders, so no physics box exists for a visual to
   * disagree with. */
  assert.equal(DRESSING_KINDS.newel, true, "the registry does not declare 'newel' as dressing");
  assert.ok(!CHUNK_MESH_KINDS.includes('newel'),
    "'newel' is in CHUNK_MESH_KINDS - dressing must never reach the collider descriptor path");
  assert.ok(BATCH_FAMILIES.stone.kinds.includes('newel'),
    "'newel' is not in the stone batch family - it would need its own mesh per district");
});

test('the manifest and the prefab registry agree about which assets exist', () => {
  /* MAZE_ASSET_PREFABS is the registry's side of the contract (which asset id
   * backs which kind); the manifest is the loader's. An id in one and not the
   * other is either an asset nothing draws or a kind that waits forever. */
  const ids = new Set(manifest.assets.map((e) => e.id));
  for (const [kind, id] of Object.entries(MAZE_ASSET_PREFABS)) {
    assert.ok(ids.has(id), `kind '${kind}' expects asset '${id}' but the manifest does not declare it`);
  }
  /* The declared triangle count must fit the stone reservation - the manifest
   * is where an oversized re-export gets caught, before addGeometry throws. */
  for (const e of manifest.assets) {
    if (e.kind !== 'geometry') continue;
    assert.ok(typeof e.tris === 'number' && e.tris > 0, `${e.id}: geometry entry declares no tris`);
    assert.ok(e.tris * 3 <= GEOMETRY_BUDGET.stone.indices,
      `${e.id} declares ${e.tris} tris (${e.tris * 3} indices), stone reservation `
      + `${GEOMETRY_BUDGET.stone.indices} - addGeometry will throw at boot`);
  }
});

test('one newel per stair shaft, at the well centre, and none anywhere else', () => {
  /* Placement is derived from the same cells the colliders are derived from,
   * so the newel can no more drift off its stair than a wall can. Lifts and
   * tunnels get none: a lift car sweeps the whole well, and a tunnel has no
   * well at all. */
  const { cells } = generateTopology(2026);
  const D = MAZE.DISTRICT;
  let total = 0; let stairs = 0;
  for (let level = 0; level < MAZE.LEVELS; level++) {
    for (let dz = 0; dz < MAZE.DISTRICTS; dz++) {
      for (let dx = 0; dx < MAZE.DISTRICTS; dx++) {
        const placed = newelPlacements(cells, dx, dz, level);
        total += placed.length;
        for (let lz = 0; lz < D; lz++) {
          for (let lx = 0; lx < D; lx++) {
            const x = dx * D + lx; const z = dz * D + lz;
            if (isOpen(cells, cellIndex(x, z, level), DIR.UP)
              && connectorAt(cells, x, z, level) === 'stair') stairs += 1;
          }
        }
      }
    }
  }
  assert.ok(stairs > 0, 'the scan found no stair shafts - it is checking nothing');
  assert.equal(total, stairs, `${total} newels for ${stairs} stair shafts`);
  assert.ok(NEWEL_HALF.hx > 0 && NEWEL_HALF.hy > 0 && NEWEL_HALF.hz > 0, 'NEWEL_HALF is not a box');
});
