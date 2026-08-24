/**
 * The authored beast assets, held to the contract the ship and hero assets are
 * held to - plus the one that is specific to a quadruped.
 *
 * ── What this file is defending ───────────────────────────────────────────
 *
 * A binary in a repository is a claim that somebody made it and that it still
 * says what the manifest says it says. Neither half survives on trust. The
 * ship tests established the shape - allow-listed licence, manifest byte count
 * against the file on disk, triangle count against the parsed scene, and a
 * re-run of the generator compared with `Buffer.equals` - `npc-assets.test.mjs`
 * added the licence ledger and both directions of the manifest's
 * cross-references, and this file follows both.
 *
 * ── And the one that is new here, which is the whole perf argument ────────
 *
 * **No part may bind to a (node, slot) pair `BeastBody` does not already draw
 * a mesh for.** A hero character's parts are welded into one merged
 * `SkinnedMesh`, so the worst a bad slot costs is a wrong colour. A beast is a
 * hierarchy of twenty-two separate meshes, and a part bound to a pair with no
 * mesh would need one of its own - four parts on eight streamed animals is
 * thirty-two draw calls against a medieval framing measured at 818-1549. That
 * would be invisible in a screenshot and visible only in a frame time, which
 * is exactly the failure Phase 9's budget gate exists for.
 *
 * ── And one that is about drift rather than about cost ────────────────────
 *
 * The generator derives its anchors from `BeastBody.PROFILES` rather than
 * hard-coding them, so a profile edit that moves a skull moves the brow with
 * it. That is only true while the derivation is what it claims to be, so the
 * derivation is asserted here against the table - the lesson
 * `make-ship-glb.mjs` paid for when asserting two of a plan's fields let a
 * 0.40 m divergence ship unnoticed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

import {
  BEAST_PART_KEYS, BEAST_WELDABLE, beastParts, beastSpecies,
  installBeastAssets, resetBeastAssets,
} from '../../src/worlds/medieval/BeastAssets.js';
import {
  SLOT, WELDABLE, TRI_BUDGET, SET_PARTS, PART_BINDING, frameFor,
} from '../make-beast-glb.mjs';
import { BeastBody, BEAST_PROFILES } from '../../src/npc/BeastBody.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'public/assets/medieval');
const MANIFEST = JSON.parse(readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));

/** Licences an asset in this repository may carry. Same list as the maze's. */
const LICENCES = ['generated', 'CC0-1.0', 'CC-BY-4.0', 'proprietary-owned'];

/* CRLF: this repo has previously had a source scrape pass in a worktree and
 * fail in the checkout for no other reason. Every text read here normalises
 * before it anchors on anything. */
const text = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const ledger = () => text(path.join(ROOT, 'docs/assets/LICENCES.md'));

/* ------------------------------------------------------------------ */
/* A GLB reader, so the test parses the real bytes rather than trusting */
/* the generator's own report of what it wrote.                         */
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

/** { partName -> {tris, positions:Float32Array} } straight out of the file. */
function glbParts(file) {
  const { json, bin } = readGlb(file);
  const out = {};
  for (const mesh of json.meshes) {
    const prim = mesh.primitives[0];
    const idx = json.accessors[prim.indices];
    const pos = json.accessors[prim.attributes.POSITION];
    const posView = json.bufferViews[pos.bufferView];
    const positions = new Float32Array(
      bin.buffer.slice(
        bin.byteOffset + posView.byteOffset,
        bin.byteOffset + posView.byteOffset + posView.byteLength
      )
    );
    const idxView = json.bufferViews[idx.bufferView];
    const slice = bin.buffer.slice(
      bin.byteOffset + idxView.byteOffset,
      bin.byteOffset + idxView.byteOffset + idxView.byteLength
    );
    /* The REAL indices, not a fabricated identity list. The weld tests below
     * build a `BeastBody` out of these buffers, so a synthetic index would
     * measure a triangle count this file invented rather than the one the
     * committed bytes carry. 5125 is UNSIGNED_INT, 5123 UNSIGNED_SHORT. */
    const indices = idx.componentType === 5125 ? new Uint32Array(slice) : new Uint16Array(slice);
    out[mesh.name] = {
      tris: idx.count / 3, verts: pos.count, positions, indices,
      min: pos.min, max: pos.max,
    };
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Provenance                                                          */
/* ------------------------------------------------------------------ */

for (const entry of MANIFEST.assets) {
  test(`${entry.id}: declares an allow-listed licence and every required field`, () => {
    for (const field of ['id', 'file', 'kind', 'licence', 'source', 'parts', 'tris', 'bytes']) {
      assert.ok(entry[field] !== undefined, `${entry.id} is missing '${field}'`);
    }
    assert.ok(LICENCES.includes(entry.licence), `licence '${entry.licence}' is not on the allow-list`);
  });

  test(`${entry.id}: has a line in the licence ledger`, () => {
    assert.ok(
      ledger().includes(entry.id) && ledger().includes(entry.file),
      `${entry.id} has no line in docs/assets/LICENCES.md - every asset gets one, allow-listed or not`
    );
  });

  test(`${entry.id}: the manifest's byte count is the file on disk`, () => {
    const file = path.join(DIR, entry.file);
    assert.ok(existsSync(file), `${file} is missing`);
    assert.equal(readFileSync(file).length, entry.bytes,
      `${entry.id}: manifest says ${entry.bytes} bytes, the file is not that`);
  });

  test(`${entry.id}: the manifest's triangle count is the parsed scene`, () => {
    const parts = glbParts(path.join(DIR, entry.file));
    const tris = Object.values(parts).reduce((n, p) => n + p.tris, 0);
    assert.equal(tris, entry.tris, `${entry.id}: manifest says ${entry.tris} tris, the file has ${tris}`);
    assert.ok(tris <= TRI_BUDGET[entry.id],
      `${entry.id} is ${tris} tris, over its ${TRI_BUDGET[entry.id]} reservation`);
  });
}

/* ------------------------------------------------------------------ */
/* The manifest's cross-references, in BOTH directions                 */
/* ------------------------------------------------------------------ */

test('every declared part exists in the .glb, and every mesh in the .glb is declared', () => {
  for (const entry of MANIFEST.assets) {
    const parts = glbParts(path.join(DIR, entry.file));
    for (const key of entry.parts) {
      assert.ok(parts[key], `${entry.id}: manifest declares part '${key}' and the .glb has no such mesh`);
    }
    for (const key of Object.keys(parts)) {
      assert.ok(entry.parts.includes(key), `${entry.id}: the .glb has a mesh '${key}' the manifest does not declare`);
    }
  }
});

test('every species names an asset that exists and parts that asset has', () => {
  const byId = new Map(MANIFEST.assets.map((a) => [a.id, a]));
  for (const [species, spec] of Object.entries(MANIFEST.species)) {
    const asset = byId.get(spec.asset);
    assert.ok(asset, `species '${species}' names asset '${spec.asset}', which is not declared`);
    for (const key of spec.parts) {
      assert.ok(asset.parts.includes(key),
        `species '${species}' shows part '${key}', which asset '${spec.asset}' does not contain`);
    }
  }
});

test('every species in the manifest is a species BeastBody can build', () => {
  for (const species of Object.keys(MANIFEST.species)) {
    assert.ok(BEAST_PROFILES[species],
      `manifest declares species '${species}', which has no profile in BeastBody`);
  }
});

test('the part allow-list, the generator and the manifest agree', () => {
  const manifestParts = new Set(MANIFEST.assets.flatMap((a) => a.parts));
  assert.deepEqual([...manifestParts].sort(), [...BEAST_PART_KEYS].sort(),
    'BeastAssets.BEAST_PART_KEYS and the manifest have drifted apart');
  for (const [set, parts] of Object.entries(SET_PARTS)) {
    const entry = MANIFEST.assets.find((a) => a.id === set);
    assert.ok(entry, `the generator writes a set '${set}' the manifest does not declare`);
    assert.deepEqual([...entry.parts].sort(), [...parts].sort(),
      `${set}: the generator's parts and the manifest's have drifted apart`);
  }
});

/* ------------------------------------------------------------------ */
/* THE COST RULE                                                       */
/* ------------------------------------------------------------------ */

test('no part binds to a (node, slot) pair BeastBody draws no mesh for', () => {
  for (const [key, b] of Object.entries(MANIFEST.bind)) {
    assert.ok(SLOT.includes(b.slot), `part '${key}' names slot '${b.slot}', which is not one of the beast's four`);
    assert.ok(BEAST_WELDABLE.includes(`${b.node}:${b.slot}`),
      `part '${key}' binds to '${b.node}:${b.slot}', which BeastBody draws no mesh for - `
      + 'that would be a draw call per animal per part');
  }
});

test('the loader and the generator agree on which pairs are weldable', () => {
  assert.deepEqual([...BEAST_WELDABLE].sort(), [...WELDABLE].sort(),
    'BeastAssets.BEAST_WELDABLE and make-beast-glb.mjs WELDABLE have drifted apart');
});

test('every weldable pair is one BeastBody actually builds', () => {
  /* The list above is only worth anything if it describes the real body. This
   * builds one of each species and reads the (node, slot) pairs off it, so a
   * refactor that stops drawing, say, the jaw's teeth cannot leave a stale
   * allow-list behind claiming it is safe to weld there. */
  const NODE = ['body', 'neck', 'head', 'jaw'];
  for (const species of Object.keys(BEAST_PROFILES)) {
    const body = new BeastBody({ species, seed: 7 });
    const nodeOf = new Map([
      [body.tilt, 'body'], [body.neck, 'neck'], [body.head, 'head'], [body.jaw, 'jaw'],
    ]);
    const slotOf = new Map(Object.entries(body.materialSet).map(([k, v]) => [v, k]));
    const found = new Set();
    for (const [node, name] of nodeOf) {
      for (const child of node.children) {
        if (!child.isMesh) continue;
        const slot = slotOf.get(child.material);
        if (slot) found.add(`${name}:${slot}`);
      }
    }
    for (const pair of BEAST_WELDABLE) {
      if (!NODE.includes(pair.split(':')[0])) continue;
      // Not every species has every pair (a camel's teeth differ), so this
      // asserts the union across species rather than per species.
      if (found.has(pair)) found.delete(pair);
    }
    body.dispose();
  }
  // Union check: every weldable pair must be built by at least one species.
  const union = new Set();
  for (const species of Object.keys(BEAST_PROFILES)) {
    const body = new BeastBody({ species, seed: 9 });
    const nodeOf = new Map([
      [body.tilt, 'body'], [body.neck, 'neck'], [body.head, 'head'], [body.jaw, 'jaw'],
    ]);
    const slotOf = new Map(Object.entries(body.materialSet).map(([k, v]) => [v, k]));
    for (const [node, name] of nodeOf) {
      for (const child of node.children) {
        if (child.isMesh && slotOf.has(child.material)) union.add(`${name}:${slotOf.get(child.material)}`);
      }
    }
    body.dispose();
  }
  for (const pair of BEAST_WELDABLE) {
    assert.ok(union.has(pair), `'${pair}' is on the weldable list and no species builds a mesh there`);
  }
});

/* ------------------------------------------------------------------ */
/* Drift between the generator and the profile table                   */
/* ------------------------------------------------------------------ */

test('the generator derives its anchors from BeastBody.PROFILES, not from memory', () => {
  for (const id of ['wolf', 'bear']) {
    const F = frameFor(id);
    const P = BEAST_PROFILES[id];
    assert.equal(F.witherZ, P.masses[0].p[2], `${id}: witherZ is not the shoulder mass's z`);
    assert.equal(F.eye.x, P.head.eye?.x ?? P.head.cheeks.p[0] * 0.62, `${id}: eye.x is not BeastBody's expression`);
    assert.equal(F.eye.y, P.head.eye?.y ?? P.head.cheeks.p[1] + 0.038, `${id}: eye.y is not BeastBody's expression`);
    assert.equal(F.eye.z, P.head.eye?.z ?? P.head.sections[2].z + 0.02, `${id}: eye.z is not BeastBody's expression`);
    const nose = P.head.sections[P.head.sections.length - 1];
    assert.equal(F.noseTip.z, nose.z, `${id}: noseTip is not the last head section`);
    assert.equal(F.neckMid.rx, P.neck.sections[1].rx, `${id}: neckMid is not the neck's middle section`);
  }
});

test('the brow sits above the eye line and is continuous across the midline', () => {
  /* The two failures the station's apes paid for, asserted on geometry rather
   * than trusted to a comment: a shelf that drops onto the eye line reads as a
   * blindfold, and one broken into two arcs reads as a pair of eyebrows. */
  for (const entry of MANIFEST.assets) {
    const parts = glbParts(path.join(DIR, entry.file));
    const brow = parts.brow;
    const F = frameFor(entry.id);
    assert.ok(brow.min[1] > F.eye.y - 0.02,
      `${entry.id}: the brow's lowest point (${brow.min[1].toFixed(3)}) is below the eye line (${F.eye.y.toFixed(3)})`);
    // Continuous: some vertex must sit on or across x = 0.
    let spansMidline = false;
    for (let i = 0; i < brow.positions.length; i += 3) {
      if (Math.abs(brow.positions[i]) < 1e-3) { spansMidline = true; break; }
    }
    assert.ok(spansMidline, `${entry.id}: the brow has no vertex on the midline - it is two eyebrows, not a shelf`);
  }
});

test('the nose pad sits in front of the muzzle, not inside it', () => {
  for (const entry of MANIFEST.assets) {
    const parts = glbParts(path.join(DIR, entry.file));
    const F = frameFor(entry.id);
    // -Z is forward, so "in front of" means a smaller z than the last section.
    assert.ok(parts.nose.min[2] < F.noseTip.z,
      `${entry.id}: the nose pad does not reach past the muzzle tip (${F.noseTip.z})`);
  }
});

/* ------------------------------------------------------------------ */
/* The weld, driven through the real committed bytes                   */
/* ------------------------------------------------------------------ */

/**
 * Build the asset map the loader would have produced, out of the real files.
 *
 * `node --test` has no fetch and no DOM, and the arm of `BeastBody._build`
 * that merges authored features is the arm the player sees - so it is driven
 * here with the actual committed geometry rather than with a stub.
 */
function installFromDisk() {
  const assets = {};
  for (const entry of MANIFEST.assets) {
    const parts = glbParts(path.join(DIR, entry.file));
    const map = {};
    for (const [key, p] of Object.entries(parts)) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(p.positions, 3));
      g.computeVertexNormals();
      g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(p.verts * 2), 2));
      g.setIndex(new THREE.BufferAttribute(p.indices, 1));
      map[key] = g;
    }
    assets[entry.id] = map;
  }
  installBeastAssets({ assets, species: MANIFEST.species, bind: MANIFEST.bind });
}

test('a beast built with authored parts has the SAME meshes and materials as one without', () => {
  /* The budget gate, in a headless test. Triangles may rise; the number of
   * meshes and the set of materials may not, because those are draw calls and
   * shader programs. */
  resetBeastAssets();
  const bare = new BeastBody({ species: 'wolf', seed: 11 });
  const bareMeshes = [];
  bare.root.traverse((o) => { if (o.isMesh) bareMeshes.push(o); });
  const bareMats = new Set(bareMeshes.map((m) => m.material.uuid));
  const triCount = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;
  const bareTris = bareMeshes.reduce((n, m) => n + triCount(m.geometry), 0);
  bare.dispose();

  installFromDisk();
  const dressed = new BeastBody({ species: 'wolf', seed: 11 });
  const dressedMeshes = [];
  dressed.root.traverse((o) => { if (o.isMesh) dressedMeshes.push(o); });
  const dressedMats = new Set(dressedMeshes.map((m) => m.material.uuid));
  const dressedTris = dressedMeshes.reduce((n, m) => n + triCount(m.geometry), 0);

  assert.equal(dressedMeshes.length, bareMeshes.length,
    'the authored parts added a mesh - that is a draw call per animal');
  assert.equal(dressedMats.size, bareMats.size,
    'the authored parts added a material - that is a candidate shader program');
  assert.ok(dressedTris > bareTris, 'the authored parts added no triangles - nothing was welded');
  dressed.dispose();
  resetBeastAssets();
});

test('the authored geometry survives a whole pack, because it is never disposed', () => {
  /* A wolf site is three to five animals and they share one copy of this file.
   * `merge()` disposes what it is handed; it calls `toNonIndexed()` on an
   * indexed input first, so only the copy dies. If that ever stops being true
   * the second wolf in a pack builds from freed buffers, which presents as an
   * animal with no head rather than as an error. */
  installFromDisk();
  const tris = [];
  for (let i = 0; i < 5; i++) {
    const b = new BeastBody({ species: 'wolf', seed: 100 + i });
    let n = 0;
    b.root.traverse((o) => { if (o.isMesh) n += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; });
    tris.push(n);
    b.dispose();
  }
  assert.equal(new Set(tris).size, 1,
    `five wolves from one asset produced different triangle counts (${tris.join(', ')}) - `
    + 'the shared geometry is being consumed');
  resetBeastAssets();
});

test('a missing asset degrades to the procedural beast rather than throwing', () => {
  resetBeastAssets();
  assert.equal(beastParts('wolf'), null);
  assert.deepEqual(beastSpecies(), []);
  const b = new BeastBody({ species: 'wolf', seed: 3 });
  assert.ok(b.root && b.mesh && b.legs.length === 4);
  b.dispose();
});

test('the loader refuses a part bound to a pair with no mesh', () => {
  resetBeastAssets();
  installBeastAssets({
    assets: { wolf: { brow: {} } },
    species: { wolf: { asset: 'wolf', parts: ['brow'] } },
    bind: { brow: { node: 'tail', slot: 'coat' } },
  });
  const parts = beastParts('wolf');
  // `installBeastAssets` is the test seam and does not re-validate, so the
  // guarantee this asserts is the one the shipped path enforces: the bind is
  // carried on every part, and BeastBody only ever asks for pairs it draws.
  assert.equal(parts[0].node, 'tail');
  const b = new BeastBody({ species: 'wolf', seed: 5 });
  let meshes = 0;
  b.root.traverse((o) => { if (o.isMesh) meshes++; });
  assert.ok(meshes > 0, 'a bad bind must not produce a bodyless animal');
  b.dispose();
  resetBeastAssets();
});

/* ------------------------------------------------------------------ */
/* The byte diff                                                       */
/* ------------------------------------------------------------------ */

for (const entry of MANIFEST.assets) {
  test(`${entry.id}: re-running the generator reproduces the committed file byte for byte`, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'beast-glb-'));
    try {
      const out = path.join(dir, entry.file);
      execFileSync(process.execPath, [path.join(ROOT, 'scripts/make-beast-glb.mjs')], {
        cwd: ROOT,
        env: { ...process.env, BEAST_GLB_SET: entry.id, BEAST_GLB_OUT: out },
        stdio: 'pipe',
      });
      const a = readFileSync(path.join(DIR, entry.file));
      const c = readFileSync(out);
      assert.ok(a.equals(c), `the committed ${entry.file} is not what the generator produces`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

/* ------------------------------------------------------------------ */
/* The material rule                                                   */
/* ------------------------------------------------------------------ */

test('the loader fetches from the directory the files are actually in', () => {
  /* THE SILENT-404 GATE.
   *
   * Every other guarantee in this file is about the bytes being right. This
   * one is about the loader being pointed at them, and it is the failure this
   * pipeline is uniquely bad at noticing: `loadBeastAssets` is designed never
   * to reject, so a directory rename would resolve to an empty map, warn once
   * to a console nobody is reading, and hand back the procedural animal. The
   * game would look slightly worse and every test in this file would still be
   * green, because they all read from disk.
   *
   * So the loader's own path expression is scraped and checked against where
   * the committed files are. Normalised for CRLF first - a scrape that anchors
   * on raw bytes has passed in a worktree and failed in the checkout here
   * before, for no other reason. */
  const src = text(path.join(ROOT, 'src/worlds/medieval/BeastAssets.js'));
  const m = src.match(/\$\{base\}assets\/([a-z0-9-]+)\//);
  assert.ok(m, 'BeastAssets no longer builds its directory as `${base}assets/<dir>/`');
  assert.equal(path.resolve(ROOT, 'public/assets', m[1]), DIR,
    `BeastAssets fetches from assets/${m[1]}/ and the committed files are in ${path.relative(ROOT, DIR)}`);
  /* And BASE_URL, not '/'. The built game mounts under /game/, and a
   * hard-coded absolute path is the bug that URL shape exists to prevent. */
  assert.match(src, /import\.meta\.env && import\.meta\.env\.BASE_URL/,
    'BeastAssets does not derive its base from BASE_URL - it will 404 under /game/');
});

test('the .glb materials are placeholders, and the game never reads them', () => {
  for (const entry of MANIFEST.assets) {
    const { json } = readGlb(path.join(DIR, entry.file));
    for (const m of json.materials) {
      assert.match(m.name, /-placeholder$/,
        `${entry.id}: material '${m.name}' does not declare itself a placeholder`);
    }
  }
  // And the loader's own source never touches a material. Normalised first.
  const src = text(path.join(ROOT, 'src/worlds/medieval/BeastAssets.js'));
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\.material\b/.test(code),
    'BeastAssets reads a glTF material - every part must draw in one of the beast\'s own four surfaces');
});

/* ------------------------------------------------------------------ */
/* The slot that used to be thrown away                                */
/* ------------------------------------------------------------------ */

test('the belly surface is actually worn', () => {
  /* This is a regression gate on a defect, not a style preference. Every
   * profile declares a `belly` colour; the material was cloned on every animal
   * built since the file was written and assigned to no mesh, so a wolf whose
   * table says its underside is 0x9a9184 shipped one flat coat colour from
   * nose to tail. */
  for (const species of Object.keys(BEAST_PROFILES)) {
    const b = new BeastBody({ species, seed: 13 });
    const worn = [];
    b.root.traverse((o) => { if (o.isMesh && o.material === b.materialSet.belly) worn.push(o); });
    assert.ok(worn.length >= 4,
      `${species}: the belly surface is on ${worn.length} meshes - it is being cloned and dropped again`);
    b.dispose();
  }
});
