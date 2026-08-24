/**
 * The maze's Phase 9 authored geometry, held to the contract the ship, npc,
 * beast, crowd and yard assets are held to - plus the two that are specific
 * to a world that draws itself through `BatchedMesh` and `InstancedMesh`.
 *
 * ── What this file is defending ───────────────────────────────────────────
 *
 * A binary in a repository is a claim that somebody made it and that it still
 * says what the manifest says it says. Neither half survives on trust. The
 * ship tests established the shape - allow-listed licence, manifest byte
 * count against the file on disk, triangle count against the parsed file, and
 * a re-run of the generator compared with `Buffer.equals`. `npc-assets` added
 * the licence ledger; `yard-assets` added the cost rule. This file follows
 * all three and adds:
 *
 * ── The three geometry gates, re-asserted against the COMMITTED BYTES ─────
 *
 * `scripts/make-maze-glb.mjs` refuses to WRITE a file that fails them. That
 * is worth something only if the file in the repository is the file the
 * generator wrote, so they are checked again here, on the bytes, in the
 * suite:
 *
 *   1. **no degenerate face.** A zero-length normal is finite, valid glTF,
 *      and NaN the moment a shader normalizes it. `art-citadel` dissolved a
 *      gatehouse into a white cloud that way, and every stored NORMAL here is
 *      checked to be unit length rather than merely present.
 *   2. **closed and consistently oriented.** Every directed edge, matched by
 *      POSITION because flat shading duplicates vertices, occurs exactly once
 *      and its reverse exactly once. One flipped triangle breaks this on all
 *      three of its edges.
 *   3. **positive signed volume**, so the whole surface is wound outward
 *      rather than inward. A backfacing surface is ABSENT, not wrong-looking,
 *      and absent is what a screenshot review of a 20 cm prop cannot catch.
 *
 * ── And the cost rule, which is the whole reason these two exist ──────────
 *
 * The maze's triangle count is not spread across its geometry; it is
 * concentrated in one of them. Measured with `scripts/world-shot.mjs` before
 * anything was authored, the `byName` breakdown's top FOURTEEN objects in
 * every single framing were fourteen `maze:foliage:<district>` meshes at
 * 43,200 triangles each - 3,600 instances of a twelve-triangle box. So:
 *
 *   - the sprig's authored geometry may never be MORE expensive than the box
 *     it replaced. Not "roughly as expensive": less. It is asserted at <= 12
 *     triangles, and the committed file is 10.
 *   - the candle's authored geometry must fit `GEOMETRY_BUDGET.candle`, which
 *     was 24 verts / 36 indices - EXACTLY one box, with no headroom at all.
 *     Adopting the file without re-sizing that reservation would not have
 *     looked wrong; it would have thrown inside `BatchedMesh.addGeometry` on
 *     the first district streamed, at boot. The reservation is asserted here
 *     against the real file rather than against a remembered number.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { MAZE_ASSET_PREFABS } from '../../src/worlds/maze/MazeAssets.js';
import {
  prefabFor, releasePrefabs, sprigGeometry, SPRIG_HALF, DRESSING_KINDS,
} from '../../src/worlds/maze/MazeMeshes.js';
import { GEOMETRY_BUDGET, BATCH_FAMILIES } from '../../src/worlds/maze/MazeBatches.js';
import { CHUNK_MESH_KINDS } from '../../src/worlds/maze/MazeChunks.js';
import { buildMazeMaterials } from '../../src/worlds/maze/MazeMaterials.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'public/assets/maze');
const GENERATOR = path.join(ROOT, 'scripts/make-maze-glb.mjs');

const MANIFEST = JSON.parse(readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));

/** The ids this generator owns. The newel predates it and has its own script. */
const OURS = ['leaf-tuft', 'hedge-candle'];

/* CRLF: this repo has previously had a source scrape pass in a worktree and
 * fail in the checkout for no other reason. Every text read here normalises
 * before it anchors on anything. */
const text = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const ledger = () => text(path.join(ROOT, 'docs/assets/LICENCES.md'));

/* ------------------------------------------------------------------ */
/* A GLB reader, so the tests parse the real bytes rather than trusting */
/* the generator's own report of what it wrote                          */
/* ------------------------------------------------------------------ */

function readGlb(file) {
  const buf = readFileSync(file);
  assert.equal(buf.readUInt32LE(0), 0x46546c67, `${file}: not a glB`);
  assert.equal(buf.readUInt32LE(4), 2, `${file}: not glTF 2.0`);
  const jsonLen = buf.readUInt32LE(12);
  assert.equal(buf.readUInt32LE(16), 0x4e4f534a, `${file}: first chunk is not JSON`);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  const binStart = 20 + jsonLen;
  const binLen = buf.readUInt32LE(binStart);
  const bin = buf.subarray(binStart + 8, binStart + 8 + binLen);
  return { buf, json, bin };
}

/** One accessor out of the BIN chunk, as the typed array it declares. */
function accessorArray(json, bin, index) {
  const acc = json.accessors[index];
  const view = json.bufferViews[acc.bufferView];
  const items = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[acc.type];
  const Ctor = acc.componentType === 5126 ? Float32Array
    : acc.componentType === 5123 ? Uint16Array
      : acc.componentType === 5125 ? Uint32Array : null;
  assert.ok(Ctor, `unhandled componentType ${acc.componentType}`);
  const slice = bin.buffer.slice(
    bin.byteOffset + view.byteOffset,
    bin.byteOffset + view.byteOffset + acc.count * items * Ctor.BYTES_PER_ELEMENT,
  );
  return { array: new Ctor(slice), items, count: acc.count };
}

/** Everything the gates below need, read out of the committed file. */
function parts(file) {
  const { json, bin } = readGlb(file);
  assert.equal(json.meshes.length, 1, `${file}: expected exactly one mesh`);
  const prim = json.meshes[0].primitives[0];
  assert.equal(prim.mode ?? 4, 4, `${file}: not a triangle mesh`);
  return {
    json,
    pos: accessorArray(json, bin, prim.attributes.POSITION),
    nor: accessorArray(json, bin, prim.attributes.NORMAL),
    idx: accessorArray(json, bin, prim.indices),
  };
}

/* ------------------------------------------------------------------ */
/* The manifest's own claims                                           */
/* ------------------------------------------------------------------ */

for (const id of OURS) {
  const entry = MANIFEST.assets.find((e) => e.id === id);

  test(`${id}: the manifest declares it, with a licence and a ledger line`, () => {
    assert.ok(entry, `the manifest does not declare '${id}'`);
    assert.equal(entry.licence, 'generated',
      `${id}: this repository authored the file, so the licence is 'generated'`);
    assert.ok(entry.source.includes('make-maze-glb.mjs'),
      `${id}: the manifest does not name the generator that made it`);
    assert.ok(ledger().includes(`\`${id}\``),
      `${id} has no line in docs/assets/LICENCES.md - every asset gets one`);
  });

  test(`${id}: the committed file is the size and shape the manifest says`, () => {
    const file = path.join(DIR, entry.file);
    const buf = readFileSync(file); // throws if it is not committed
    assert.equal(buf.length, entry.bytes,
      `${id}: ${entry.file} is ${buf.length} bytes on disk against a declared ${entry.bytes} `
      + '- a re-export drifted from the manifest');
    const p = parts(file);
    assert.equal(p.idx.count / 3, entry.tris,
      `${id}: manifest says ${entry.tris} tris, the file has ${p.idx.count / 3}`);
    assert.equal(p.pos.count, entry.verts,
      `${id}: manifest says ${entry.verts} verts, the file has ${p.pos.count}`);
  });

  test(`${id}: re-running the generator reproduces the committed file`, () => {
    /* The whole meaning of the `generated` licence. Without this the word is a
     * claim; with it, a hand-edited or externally-sourced .glb cannot survive
     * a test run. */
    const tmp = mkdtempSync(path.join(tmpdir(), 'maze-glb-'));
    try {
      const out = path.join(tmp, entry.file);
      execFileSync(process.execPath, [GENERATOR], {
        env: { ...process.env, MAZE_GLB_ASSET: id, MAZE_GLB_OUT: out },
        stdio: 'pipe',
      });
      assert.ok(existsSync(out), `${id}: the generator wrote nothing`);
      const fresh = readFileSync(out);
      const committed = readFileSync(path.join(DIR, entry.file));
      assert.ok(fresh.equals(committed),
        `${id}: re-running scripts/make-maze-glb.mjs does not reproduce the committed file `
        + `(${committed.length} bytes committed, ${fresh.length} fresh) - re-run it and commit the result`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  /* -------------------------------------------------------------- */
  /* The three geometry gates, on the bytes                          */
  /* -------------------------------------------------------------- */

  test(`${id}: no stored normal is degenerate`, () => {
    const { nor } = parts(path.join(DIR, entry.file));
    for (let i = 0; i < nor.count; i++) {
      const x = nor.array[i * 3];
      const y = nor.array[i * 3 + 1];
      const z = nor.array[i * 3 + 2];
      const len = Math.hypot(x, y, z);
      assert.ok(Math.abs(len - 1) < 1e-3,
        `${id}: normal ${i} is (${x}, ${y}, ${z}), length ${len} - a non-unit normal is finite, `
        + 'valid glTF, and NaN the moment a shader normalizes it');
    }
  });

  test(`${id}: the surface is closed and consistently oriented`, () => {
    /* Matched by POSITION, not by index: flat shading gives every face its own
     * three vertices, so the topology lives in the coordinates. */
    const { pos, idx } = parts(path.join(DIR, entry.file));
    const key = (i) => `${pos.array[i * 3].toFixed(5)},`
      + `${pos.array[i * 3 + 1].toFixed(5)},${pos.array[i * 3 + 2].toFixed(5)}`;
    const seen = new Map();
    for (let t = 0; t < idx.count; t += 3) {
      const a = key(idx.array[t]);
      const b = key(idx.array[t + 1]);
      const c = key(idx.array[t + 2]);
      for (const [p, q] of [[a, b], [b, c], [c, a]]) {
        const k = `${p}|${q}`;
        seen.set(k, (seen.get(k) ?? 0) + 1);
      }
    }
    for (const [k, n] of seen) {
      assert.equal(n, 1, `${id}: directed edge ${k} appears ${n} times - the surface is not manifold`);
      const [p, q] = k.split('|');
      assert.equal(seen.get(`${q}|${p}`) ?? 0, 1,
        `${id}: edge ${p} -> ${q} has no matching reverse - the surface is open, or a face is `
        + 'flipped. A backfacing face is INVISIBLE, not wrong-looking');
    }
  });

  test(`${id}: the signed volume is positive, so the winding is outward`, () => {
    const { pos, idx } = parts(path.join(DIR, entry.file));
    const v = (i) => [pos.array[i * 3], pos.array[i * 3 + 1], pos.array[i * 3 + 2]];
    let vol6 = 0;
    for (let t = 0; t < idx.count; t += 3) {
      const a = v(idx.array[t]); const b = v(idx.array[t + 1]); const c = v(idx.array[t + 2]);
      vol6 += a[0] * (b[1] * c[2] - b[2] * c[1])
        + a[1] * (b[2] * c[0] - b[0] * c[2])
        + a[2] * (b[0] * c[1] - b[1] * c[0]);
    }
    assert.ok(vol6 > 0,
      `${id}: signed volume ${(vol6 / 6).toExponential(3)} - the surface is wound inside out, `
      + 'which renders as nothing at all');
  });
}

/* ------------------------------------------------------------------ */
/* The cost rule                                                       */
/* ------------------------------------------------------------------ */

test('the sprig is not more expensive than the box it replaced', () => {
  /* THE measurement of this world. `world-shot --world maze` reports the top
   * fourteen objects by triangle count in every framing, and in every framing
   * all fourteen were `maze:foliage:<district>` at 43,200 triangles - 3,600
   * instances of a twelve-triangle `BoxGeometry(0.5, 0.5, 0.5)`. Roughly two
   * thirds of the whole world's triangles are hedge-top growth. Anything
   * authored here multiplies by 3,600 per district, so "about the same" is
   * not good enough and this is a hard ceiling. */
  const BOX_TRIS = 12;
  const entry = MANIFEST.assets.find((e) => e.id === MAZE_ASSET_PREFABS.sprig);
  assert.ok(entry.tris <= BOX_TRIS,
    `the authored sprig is ${entry.tris} triangles against the box's ${BOX_TRIS} - `
    + `at 3,600 instances per district that is +${(entry.tris - BOX_TRIS) * 3600} triangles a district`);
});

test('the authored candle fits the candle batch reservation, which was re-sized for it', () => {
  /* `GEOMETRY_BUDGET.candle` was 24 verts / 36 indices - exactly one box.
   * `BatchedMesh.addGeometry` THROWS at capacity rather than degrading, so a
   * 210-vertex prefab against that reservation is a boot crash in the first
   * district streamed, not a visual regression. */
  const entry = MANIFEST.assets.find((e) => e.id === MAZE_ASSET_PREFABS.candle);
  const budget = GEOMETRY_BUDGET.candle;
  assert.ok(entry.verts <= budget.verts,
    `the authored candle is ${entry.verts} verts against a ${budget.verts} reservation - `
    + 'addGeometry will throw at boot');
  assert.ok(entry.tris * 3 <= budget.indices,
    `the authored candle is ${entry.tris * 3} indices against a ${budget.indices} reservation`);
  /* And the procedural fallback still fits, because a session with no
   * authored file registers the box instead. */
  const fallback = prefabFor({ kind: 'candle', hx: 0.09, hy: 0.26, hz: 0.09 });
  assert.ok(fallback.attributes.position.count <= budget.verts, 'the fallback candle box no longer fits');
  releasePrefabs();
});

/* ------------------------------------------------------------------ */
/* The gate that measures something the game actually does             */
/* ------------------------------------------------------------------ */

test('the sprig geometry is registry-owned, shared, and the same box when no asset loaded', () => {
  /* Three claims at once, and all three are what makes this change free:
   *  - one geometry for the whole world rather than a `new BoxGeometry` per
   *    resident district (twenty-one of them at the entrance, rebuilt on
   *    every residency change);
   *  - the fallback is EXACTLY the 0.5 m cube `buildSprigInstances` used to
   *    allocate, so a missing file leaves the world as it shipped;
   *  - the authored file is adopted into a DIFFERENT cache slot, so a build
   *    that raced the load can never pin the fallback where the authored
   *    version belongs. */
  const a = sprigGeometry();
  const b = sprigGeometry();
  assert.equal(a, b, 'sprigGeometry built two geometries for one shared tuft');

  a.computeBoundingBox();
  const bb = a.boundingBox;
  for (const axis of ['x', 'y', 'z']) {
    assert.ok(Math.abs(bb.min[axis] + 0.25) < 1e-6 && Math.abs(bb.max[axis] - 0.25) < 1e-6,
      `the fallback sprig is ${bb.min[axis]}..${bb.max[axis]} on ${axis}, not the 0.5 m cube `
      + 'every scale in MazeFoliage is expressed against');
  }

  const authored = new THREE.OctahedronGeometry(3).toNonIndexed();
  authored.translate(9, -4, 2);
  const loaded = sprigGeometry({ [MAZE_ASSET_PREFABS.sprig]: authored });
  assert.notEqual(loaded, a,
    'the authored sprig and the fallback share a cache slot - one is being served for the other');
  assert.equal(loaded, sprigGeometry({ [MAZE_ASSET_PREFABS.sprig]: authored }),
    'the authored sprig is not cached');
  loaded.computeBoundingBox();
  const lb = loaded.boundingBox;
  assert.ok(lb.min.x >= -0.25 - 1e-6 && lb.max.x <= 0.25 + 1e-6
    && lb.min.y >= -0.25 - 1e-6 && lb.max.y <= 0.25 + 1e-6
    && lb.min.z >= -0.25 - 1e-6 && lb.max.z <= 0.25 + 1e-6,
    'the refitted authored sprig leaves the box the instancer scales against');
  releasePrefabs();
});

test('the sprig is dressing: never a collider kind, never a batch family', () => {
  /* The dressing exemption is EXPLICIT rather than implied by absence, and
   * the reason it is safe is provable: a kind that never appears in
   * `CHUNK_MESH_KINDS` never comes from `districtColliders`, so no physics box
   * exists for a visual to disagree with. And unlike the newel, the sprig is
   * NOT batched - it has its own InstancedMesh because it needs a per-instance
   * rotation - so it must not appear in a family either, or it would be drawn
   * twice. */
  assert.equal(DRESSING_KINDS.sprig, true, "the registry does not declare 'sprig' as dressing");
  assert.ok(!CHUNK_MESH_KINDS.includes('sprig'),
    "'sprig' is in CHUNK_MESH_KINDS - dressing must never reach the collider descriptor path");
  for (const [name, fam] of Object.entries(BATCH_FAMILIES)) {
    assert.ok(!fam.kinds.includes('sprig'),
      `'sprig' is in the ${name} batch family AND on its own InstancedMesh - it would draw twice`);
  }
  assert.equal(SPRIG_HALF.hx, 0.25, 'SPRIG_HALF drifted from the 0.5 m cube the instancer assumes');
});

test('both authored files join buckets the maze already draws - no new material, no new program', () => {
  /* The cost argument, asserted rather than asserted-in-a-comment. An
   * authored asset here contributes GEOMETRY ONLY: `MazeAssets.firstGeometry`
   * discards the .glb's own material, and the prefab is drawn with the cached
   * maze material of the bucket it joins. Both buckets pre-date this branch.
   *
   * The candle's is a BATCH family, and a BatchedMesh draws with exactly one
   * material - so a candle prefab that somehow arrived under a different kind
   * would be a new mesh, a new material and a new program, silently. The
   * sprig's is `materials.foliage` / `materials.ivy`, both of which already
   * existed and neither of which this branch touched. */
  const mats = buildMazeMaterials();
  for (const key of ['candle', 'foliage', 'ivy']) {
    assert.ok(mats[key], `the maze has no '${key}' material for an authored prefab to be drawn with`);
  }
  assert.ok(BATCH_FAMILIES.candle.kinds.includes('candle'),
    "'candle' left its own batch family - the authored pillar would need its own mesh per district");
  assert.equal(BATCH_FAMILIES.candle.kinds.length, 1,
    'the candle family gained a second kind - a BatchedMesh has exactly one material');
});
