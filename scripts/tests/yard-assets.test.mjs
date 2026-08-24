/**
 * The authored yard assets, held to the contract the ship, hero and beast
 * assets are held to - plus the one that is specific to a batched world.
 *
 * ── What this file is defending ───────────────────────────────────────────
 *
 * A binary in a repository is a claim that somebody made it and that it still
 * says what the manifest says it says. Neither half survives on trust. The
 * ship tests established the shape - allow-listed licence, manifest byte count
 * against the file on disk, triangle count against the parsed scene, and a
 * re-run of the generator compared with `Buffer.equals` - `npc-assets` added
 * the licence ledger and both directions of the manifest's cross-references,
 * `beast-assets` added the cost rule, and this file follows all three.
 *
 * ── And the one that is new here, which is the whole perf argument ────────
 *
 * **No part may name a key `buildYardMaterials` does not produce.** The yard
 * draws itself through ONE `GeoBatch` keyed on material name, and
 * `GeoBatch.flush` ends in `new THREE.Mesh(merged, materials[key])`. Three
 * replaces an undefined material with a default white `MeshBasicMaterial`, so
 * a part naming a bucket with no material behind it is not a wrong colour: it
 * is a new draw call, a new material and a new shader program, appearing
 * silently, in the phase the roadmap names as the one most likely to regress
 * production frame time.
 *
 * That is asserted twice and in two different ways, because an allow-list is
 * only worth what it describes: once against the constant the loader carries,
 * and once against the material set read off a REAL built `DockWorld`. The
 * medieval pass learned that shape the hard way - an allow-list can go stale
 * while every test that reads the allow-list stays green.
 *
 * ── And the gate that measures something the game actually does ───────────
 *
 * The last two tests build the yard twice, once with the committed geometry
 * installed and once without, and compare what came out. A gate that measures
 * a thing the game does not do is worse than no gate; "the .glb parses" is
 * that kind of gate. "The world built from it has the same materials, the same
 * meshes and the same colliders as the world built without it" is not.
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
  TRI_BUDGET, SECTION_PARTS, YARD_PART_KEYS as GEN_KEYS,
} from '../make-yard-glb.mjs';
import { SECTIONS } from '../../src/worlds/dock/YardPlan.js';
import {
  YARD_PART_KEYS, sectionParts, yardSections, installYardAssets, resetYardAssets,
} from '../../src/worlds/dock/YardAssets.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'public/assets/dock');
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

/** Copy one accessor out of the BIN chunk as the typed array it declares. */
function accessorArray(json, bin, index, Ctor) {
  const acc = json.accessors[index];
  const view = json.bufferViews[acc.bufferView];
  const slice = bin.buffer.slice(
    bin.byteOffset + view.byteOffset,
    bin.byteOffset + view.byteOffset + view.byteLength
  );
  return new Ctor(slice);
}

/** `{ partName -> { tris, geometry, min, max } }` straight out of the file. */
function glbParts(file) {
  const { json, bin } = readGlb(file);
  const out = {};
  for (const mesh of json.meshes) {
    const prim = mesh.primitives[0];
    const posAcc = json.accessors[prim.attributes.POSITION];
    const idxAcc = json.accessors[prim.indices];
    const position = accessorArray(json, bin, prim.attributes.POSITION, Float32Array);
    const normal = accessorArray(json, bin, prim.attributes.NORMAL, Float32Array);
    const uv = accessorArray(json, bin, prim.attributes.TEXCOORD_0, Float32Array);
    /* The REAL indices, not a fabricated identity list: the build tests below
     * merge these buffers into a live `GeoBatch`, so a synthetic index would
     * measure a triangle count this file invented rather than the one the
     * committed bytes carry. 5125 is UNSIGNED_INT, 5123 UNSIGNED_SHORT. */
    const indices = accessorArray(
      json, bin, prim.indices, idxAcc.componentType === 5125 ? Uint32Array : Uint16Array
    );
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    out[mesh.name] = {
      tris: idxAcc.count / 3, verts: posAcc.count, geometry,
      min: posAcc.min, max: posAcc.max,
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
    assert.ok(tris <= TRI_BUDGET,
      `${entry.id} is ${tris} tris, over the ${TRI_BUDGET} reservation`);
  });

  test(`${entry.id}: re-running the generator reproduces the committed file`, () => {
    /* The whole meaning of the `generated` licence. Without this the word is a
     * claim; with it, a hand-edited or externally-sourced .glb cannot survive
     * a test run. */
    const tmp = mkdtempSync(path.join(tmpdir(), 'yard-glb-'));
    try {
      const out = path.join(tmp, entry.file);
      execFileSync(process.execPath, [path.join(ROOT, 'scripts/make-yard-glb.mjs')], {
        env: { ...process.env, YARD_GLB_SECTION: entry.id, YARD_GLB_OUT: out },
        stdio: 'pipe',
      });
      assert.ok(existsSync(out), `${entry.id}: the generator wrote nothing`);
      const fresh = readFileSync(out);
      const committed = readFileSync(path.join(DIR, entry.file));
      assert.ok(fresh.equals(committed),
        `${entry.id}: re-running scripts/make-yard-glb.mjs does not reproduce the committed file `
        + `(${committed.length} bytes committed, ${fresh.length} fresh) - re-run it and commit the result`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
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
      assert.ok(entry.parts.includes(key),
        `${entry.id}: the .glb has a mesh '${key}' the manifest does not declare`);
    }
  }
});

test('every manifest section is a real SECTIONS row, and every SECTIONS row has one', () => {
  const planIds = SECTIONS.map((s) => s.id);
  const byId = new Map(MANIFEST.assets.map((a) => [a.id, a]));
  for (const [id, spec] of Object.entries(MANIFEST.sections)) {
    assert.ok(planIds.includes(id),
      `manifest declares section '${id}', which is not in YardPlan.SECTIONS - `
      + 'that section would be authored for a jig the yard never builds');
    const asset = byId.get(spec.asset);
    assert.ok(asset, `section '${id}' names asset '${spec.asset}', which is not declared`);
    for (const key of spec.parts) {
      assert.ok(asset.parts.includes(key),
        `section '${id}' shows part '${key}', which asset '${spec.asset}' does not contain`);
    }
  }
  for (const id of planIds) {
    assert.ok(MANIFEST.sections[id],
      `YardPlan.SECTIONS has '${id}' and the manifest does not - that jig would carry the `
      + 'procedural drum while its neighbours carry authored plating, which reads as a bug');
  }
});

test('the part allow-list, the generator and the manifest agree', () => {
  const manifestParts = new Set(MANIFEST.assets.flatMap((a) => a.parts));
  assert.deepEqual([...manifestParts].sort(), [...YARD_PART_KEYS].sort(),
    'YardAssets.YARD_PART_KEYS and the manifest have drifted apart');
  assert.deepEqual([...GEN_KEYS].sort(), [...YARD_PART_KEYS].sort(),
    'make-yard-glb.mjs and YardAssets.js have drifted apart on the part keys');
  for (const [id, parts] of Object.entries(SECTION_PARTS)) {
    const entry = MANIFEST.assets.find((a) => a.id === id);
    assert.ok(entry, `the generator writes a section '${id}' the manifest does not declare`);
    assert.deepEqual([...entry.parts].sort(), [...parts].sort(),
      `${id}: the generator's parts and the manifest's have drifted apart`);
  }
});

/* ------------------------------------------------------------------ */
/* Geometry: the asset has to fit the collider the yard already has    */
/* ------------------------------------------------------------------ */

test('every authored section fits inside the collider the yard registers for it', () => {
  /* `DockWorld._buildSections` registers `_solidRot(x, cy, z, r, r, len/2, yaw)`
   * for BOTH arms, and it is the same collider it registered when the section
   * was a `CylinderGeometry`. Geometry outside it is a thing the player walks
   * through; geometry far inside it is a section that no longer fills its own
   * jig. Both are defects a screenshot would take a while to find and this
   * finds in milliseconds.
   *
   * The margin is the plating's own: LAP (0.04) + FRAME_PROUD (0.17) + the
   * bolt heads (0.11) is 0.32, and a ring frame is meant to stand off the
   * skin. */
  const MARGIN = 0.35;
  for (const s of SECTIONS) {
    const entry = MANIFEST.assets.find((a) => a.id === MANIFEST.sections[s.id].asset);
    const parts = glbParts(path.join(DIR, entry.file));
    let min = [Infinity, Infinity, Infinity];
    let max = [-Infinity, -Infinity, -Infinity];
    for (const p of Object.values(parts)) {
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], p.min[a]);
        max[a] = Math.max(max[a], p.max[a]);
      }
    }
    for (const [axis, limit] of [[0, s.r], [1, s.r], [2, s.len / 2]]) {
      const reach = Math.max(Math.abs(min[axis]), Math.abs(max[axis]));
      assert.ok(reach <= limit + MARGIN,
        `${s.id}: authored geometry reaches ${reach.toFixed(2)} on axis ${axis}, `
        + `outside the ${limit.toFixed(2)} + ${MARGIN} collider - the player would walk through it`);
    }
    /* ...and it has to actually FILL the drum. A section authored at half its
     * plan radius would pass every test above and float in its saddles. */
    assert.ok(Math.max(Math.abs(min[0]), Math.abs(max[0])) >= s.r * 0.95,
      `${s.id}: authored geometry is narrower than the ${s.r} m section the plan declares`);
    assert.ok(max[2] - min[2] >= s.len * 0.9,
      `${s.id}: authored geometry is shorter than the ${s.len} m section the plan declares`);
  }
});

/* ------------------------------------------------------------------ */
/* THE COST RULE, against a real built world                           */
/* ------------------------------------------------------------------ */

function harness() {
  if (globalThis.__yardAssetHarness) return;
  globalThis.__yardAssetHarness = true;
  class Img {
    constructor(a, b, c) {
      if (typeof a === 'number') { this.width = a; this.height = b; this.data = new Uint8ClampedArray(a * b * 4); }
      else { this.data = a; this.width = b; this.height = c ?? 1; }
    }
  }
  const gradient = { addColorStop() {} };
  const context2d = (canvas) => {
    const real = {
      canvas,
      createImageData: (w, h) => new Img(Math.max(1, w | 0), Math.max(1, (h ?? w) | 0)),
      getImageData: (x, y, w, h) => new Img(Math.max(1, w | 0), Math.max(1, h | 0)),
      createLinearGradient: () => gradient,
      createRadialGradient: () => gradient,
      createConicGradient: () => gradient,
      createPattern: () => null,
      measureText: () => ({ width: 8 }),
      getLineDash: () => [],
    };
    return new Proxy(real, { get: (o, k) => (k in o ? o[k] : () => undefined), set: () => true });
  };
  globalThis.ImageData = Img;
  globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  globalThis.document = {
    createElement(tag) { const c = { width: 1, height: 1, style: {}, tagName: tag }; c.getContext = () => context2d(c); return c; },
    createElementNS(_ns, tag) { return this.createElement(tag); },
  };
  globalThis.window = globalThis;
  globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return context2d(this); } };
  const dead = () => ({ texture: null, dispose() {} });
  THREE.PMREMGenerator.prototype.fromEquirectangular = dead;
  THREE.PMREMGenerator.prototype.fromScene = dead;
  THREE.PMREMGenerator.prototype.compileEquirectangularShader = () => {};
}

harness();
const { Physics } = await import('../../src/physics/Physics.js');
const { DockWorld } = await import('../../src/worlds/DockWorld.js');

async function buildYard() {
  const physics = new Physics();
  const world = new DockWorld({
    physics,
    scene: new THREE.Scene(),
    bus: { on: () => () => {}, emit() {} },
    engine: {
      renderer: {
        capabilities: { getMaxAnisotropy: () => 4, isWebGL2: true },
        initTexture() {}, getContext: () => ({}),
        getRenderTarget: () => null, setRenderTarget() {}, render() {}, clear() {},
      },
      onFrameUpdate: () => () => {}, onResize: () => () => {},
    },
    materials: {
      get: () => new THREE.MeshStandardMaterial(),
      getEnvMap: (mood) => ({ __probe: mood }),
      dispose() {},
    },
  });
  world.physics = physics;
  await world.build(() => {});
  world.group.updateMatrixWorld(true);
  return { world, physics };
}

/** The batched yard, as it is actually drawn: mesh name -> triangles. */
function yardMeshes(world) {
  const out = new Map();
  const mats = new Set();
  world.group.traverse((o) => {
    if (!o.isMesh || !o.geometry?.getIndex) return;
    const idx = o.geometry.getIndex();
    const tris = idx ? idx.count / 3 : (o.geometry.getAttribute('position')?.count ?? 0) / 3;
    out.set(o.name, (out.get(o.name) ?? 0) + tris);
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (m) mats.add(m.name || m.type);
    }
  });
  return { meshes: out, materials: mats };
}

/** Load the committed geometry the way the loader would, without a browser. */
function installCommitted() {
  const assets = {};
  for (const entry of MANIFEST.assets) {
    const parts = glbParts(path.join(DIR, entry.file));
    assets[entry.id] = Object.fromEntries(
      Object.entries(parts).map(([k, p]) => [k, p.geometry])
    );
  }
  installYardAssets({ assets, sections: MANIFEST.sections });
}

test('installing the authored sections costs triangles and nothing else', async () => {
  /* The whole argument of decision D4's pipeline, measured rather than
   * asserted. Two real builds of the real world:
   *
   *   without   the procedural drums, which is what every other headless test
   *             in this repo measures and what a player with a failed download
   *             gets
   *   with      the committed .glb parsed off disk and installed
   *
   * The yard batches by material key, so an authored part that named a new key
   * would show up as a NEW MESH in the flushed batch; one that brought its own
   * material would show up in the material set. Both are checked. Triangles
   * are expected to move and are the only thing allowed to. */
  resetYardAssets();
  const plain = await buildYard();
  const before = yardMeshes(plain.world);
  const collidersBefore = plain.world.colliders.length;

  installCommitted();
  assert.deepEqual(yardSections().sort(), SECTIONS.map((s) => s.id).sort(),
    'the installed manifest does not describe the plan\'s sections');
  assert.ok(sectionParts('sec-b2'), 'sec-b2 has no installed parts - the rig is not testing the authored arm');

  const authored = await buildYard();
  const after = yardMeshes(authored.world);

  assert.deepEqual([...after.meshes.keys()].sort(), [...before.meshes.keys()].sort(),
    'the authored sections changed which meshes the yard draws - a new mesh here is a new draw call');
  assert.deepEqual([...after.materials].sort(), [...before.materials].sort(),
    'the authored sections changed the yard\'s material set - a new material here is a candidate new shader program');
  assert.equal(authored.world.colliders.length, collidersBefore,
    'the authored sections changed the collider count - the section collider is meant to be identical either way');

  let moved = 0;
  for (const [name, tris] of after.meshes) {
    const was = before.meshes.get(name) ?? 0;
    if (tris !== was) moved++;
    if (!YARD_PART_KEYS.some((k) => name === `yard:${k}`)) {
      assert.equal(tris, was,
        `mesh '${name}' changed from ${was} to ${tris} triangles and it carries no authored part`);
    }
  }
  assert.ok(moved > 0, 'installing the authored sections changed no triangle count at all - nothing was drawn');

  plain.world.dispose?.();
  authored.world.dispose?.();
  resetYardAssets();
});

test('every part key names a material the yard actually builds', async () => {
  /* The allow-list is only worth what it describes. This reads the material
   * set off a REAL built world rather than off a constant, so a rename in
   * `buildYardMaterials` cannot leave a stale list behind claiming a bucket
   * exists. Without a material, `GeoBatch.flush` hands three an undefined and
   * three substitutes a white `MeshBasicMaterial` - a new draw, a new material
   * and a new program, silently. */
  resetYardAssets();
  const { world } = await buildYard();
  const have = Object.keys(world.mat);
  for (const key of YARD_PART_KEYS) {
    assert.ok(have.includes(key),
      `part key '${key}' is not a material buildYardMaterials produces (has: ${have.join(', ')})`);
    assert.ok(world.mat[key]?.isMaterial, `yard material '${key}' is not a material`);
  }
  world.dispose?.();
});

test('every yard material carries its own key as its name, so --ablate can see it', () => {
  /* `scripts/world-shot.mjs --ablate` hides meshes BY MATERIAL NAME, and it is
   * the only tool in this repository that can answer "which system drew this
   * pixel". Before this pass the yard offered it exactly one name and every
   * report's `materialNames` read "116 MeshStandardMaterial". A material that
   * loses its name does not break the game, it breaks the next art pass - so
   * it is caught here rather than discovered by an agent who has already
   * concluded the wrong thing. */
  return buildYard().then(({ world }) => {
    for (const [key, m] of Object.entries(world.mat)) {
      assert.equal(m.name, `yard.${key}`,
        `yard material '${key}' is named '${m.name}' - --ablate identifies materials by name`);
    }
    world.dispose?.();
  });
});
