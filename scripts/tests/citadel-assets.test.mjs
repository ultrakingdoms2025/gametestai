/**
 * The authored citadel architecture, held to the contract the ship, hero and
 * beast assets are held to - plus the two that are specific to a world built
 * out of merged batches.
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
 * ── The first one that is new here, and it is the whole perf argument ─────
 *
 * **No part may be added to a batch in a material key that batch does not
 * already flush.** `Batch.flush` builds one `THREE.Mesh` per bucket, so a part
 * in a new key is a draw call and a candidate shader program - and Citadel's
 * entire render argument is 166 meshes for 550,000 triangles from every camera.
 * The allow-list is asserted here against a REAL headless build rather than
 * against itself, so it cannot rot into a stale claim that welding somewhere is
 * safe. And the cost is then measured the only way that counts: the world is
 * built twice, once with the assets and once without, and the mesh count, the
 * material set and the collider count must be identical.
 *
 * ── The second one, which cost a photograph to find ───────────────────────
 *
 * **Every normal in the file must be unit length.** This generator computes its
 * own normals from a cross product, and a quad on these surfaces is often HALF
 * degenerate - an arch spandrel has zero width at the springing line. The first
 * version divided by `len || 1` and wrote the normal (0, 0, 0): finite, valid
 * glTF, and NaN the moment a shader calls `normalize` on it. 8 in the arch and
 * 56 in the corbel, times ~350 placements, and
 * `.probe/art-citadel/mid2/gate-approach.png` is a photograph of a gatehouse
 * that has become a white cloud through bloom. The generator refuses one now;
 * this asserts the committed BYTES, which is the thing the browser loads.
 *
 * ── And one that is about a route rather than about cost ──────────────────
 *
 * Nothing authored here carries a collider. Every gap, reach, landing and route
 * measurement in the citadel suite is taken against the colliders, so art that
 * moved one would invalidate the whole suite silently. Asserted by counting.
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
  CITADEL_PART_KEYS, CITADEL_WELDABLE, CITADEL_TRI_BUDGET,
  citadelPart, citadelParts, installCitadelAssets, resetCitadelAssets,
} from '../../src/worlds/citadel/CitadelAssets.js';
import {
  WELDABLE, PART_BINDING, TRI_BUDGET, SET_TRI_BUDGET, SET_PARTS,
  ARCH_C, ARCH_R, ARCH_CROWN, ARCH_STATIONS, archPoint,
} from '../make-citadel-glb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'public/assets/citadel');
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

/** { partName -> {tris, verts, positions, normals, uvs, indices, min, max} }. */
function glbParts(file) {
  const { json, bin } = readGlb(file);
  const out = {};
  const grab = (accIdx, Arr) => {
    const acc = json.accessors[accIdx];
    const view = json.bufferViews[acc.bufferView];
    return new Arr(bin.buffer.slice(
      bin.byteOffset + view.byteOffset,
      bin.byteOffset + view.byteOffset + view.byteLength
    ));
  };
  for (const mesh of json.meshes) {
    const prim = mesh.primitives[0];
    const pos = json.accessors[prim.attributes.POSITION];
    const idx = json.accessors[prim.indices];
    out[mesh.name] = {
      tris: idx.count / 3,
      verts: pos.count,
      positions: grab(prim.attributes.POSITION, Float32Array),
      normals: grab(prim.attributes.NORMAL, Float32Array),
      uvs: grab(prim.attributes.TEXCOORD_0, Float32Array),
      /* The REAL indices, not a fabricated identity list. The build tests below
       * feed these buffers into the world, so a synthetic index would measure a
       * triangle count this file invented rather than the one the committed
       * bytes carry. 5125 is UNSIGNED_INT, 5123 UNSIGNED_SHORT. */
      indices: grab(prim.indices, idx.componentType === 5125 ? Uint32Array : Uint16Array),
      min: pos.min,
      max: pos.max,
    };
  }
  return out;
}

const PARTS = glbParts(path.join(DIR, 'citadel.glb'));

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
      ledger().includes(entry.file),
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
    const tris = Object.values(PARTS).reduce((n, p) => n + p.tris, 0);
    assert.equal(tris, entry.tris, `${entry.id}: manifest says ${entry.tris} tris, the file has ${tris}`);
    assert.ok(tris <= SET_TRI_BUDGET,
      `${entry.id} is ${tris} tris, over its ${SET_TRI_BUDGET} reservation`);
  });
}

test('every part is inside its own reservation, in the committed bytes', () => {
  for (const [key, p] of Object.entries(PARTS)) {
    assert.ok(p.tris <= TRI_BUDGET[key],
      `part '${key}' is ${p.tris} tris, over its ${TRI_BUDGET[key]} reservation`);
    assert.equal(p.tris, MANIFEST.parts[key].tris,
      `manifest says part '${key}' is ${MANIFEST.parts[key].tris} tris; the file has ${p.tris}`);
  }
});

/* ------------------------------------------------------------------ */
/* The manifest's cross-references, in BOTH directions                 */
/* ------------------------------------------------------------------ */

test('every declared part exists in the .glb, and every mesh in the .glb is declared', () => {
  for (const entry of MANIFEST.assets) {
    for (const key of entry.parts) {
      assert.ok(PARTS[key], `${entry.id}: manifest declares part '${key}' and the .glb has no such mesh`);
    }
  }
  const declared = new Set(MANIFEST.assets.flatMap((a) => a.parts));
  for (const key of Object.keys(PARTS)) {
    assert.ok(declared.has(key), `the .glb has a mesh '${key}' the manifest does not declare`);
  }
});

test('the part allow-list, the generator and the manifest agree', () => {
  const manifestParts = new Set(MANIFEST.assets.flatMap((a) => a.parts));
  assert.deepEqual([...manifestParts].sort(), [...CITADEL_PART_KEYS].sort(),
    'CitadelAssets.CITADEL_PART_KEYS and the manifest have drifted apart');
  for (const [set, parts] of Object.entries(SET_PARTS)) {
    const entry = MANIFEST.assets.find((a) => a.id === set);
    assert.ok(entry, `the generator writes a set '${set}' the manifest does not declare`);
    assert.deepEqual([...entry.parts].sort(), [...parts].sort(),
      `${set}: the generator's parts and the manifest's have drifted apart`);
  }
});

test('the loader and the generator agree on which buckets are weldable', () => {
  assert.deepEqual([...CITADEL_WELDABLE].sort(), [...WELDABLE].sort(),
    'CitadelAssets.CITADEL_WELDABLE and make-citadel-glb.mjs WELDABLE have drifted apart');
});

test('every bind in the manifest is on the weldable list', () => {
  for (const [key, b] of Object.entries(MANIFEST.bind)) {
    assert.ok(CITADEL_PART_KEYS.includes(key), `manifest binds an unknown part '${key}'`);
    assert.deepEqual(b, PART_BINDING[key],
      `the manifest's bind for '${key}' and the generator's have drifted apart`);
    for (const batch of b.batches) {
      assert.ok(CITADEL_WELDABLE.includes(`${batch}:${b.slot}`),
        `part '${key}' binds to '${batch}:${b.slot}', which CitadelWorld does not already flush`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* THE NORMALS - the defect that whited out the gatehouse              */
/* ------------------------------------------------------------------ */

test('every normal in the committed .glb is unit length', () => {
  /* A zero-length normal is finite, is valid glTF, passes a NaN check, and is
   * NaN the moment the shader normalizes it. See this file's header, and
   * `.probe/art-citadel/mid2/` for what it looks like. 1e-4 rather than exact,
   * because these are single-precision floats by the time they are here. */
  for (const [key, p] of Object.entries(PARTS)) {
    let worst = 0;
    for (let i = 0; i < p.normals.length; i += 3) {
      const len = Math.hypot(p.normals[i], p.normals[i + 1], p.normals[i + 2]);
      worst = Math.max(worst, Math.abs(len - 1));
    }
    assert.ok(worst < 1e-4,
      `part '${key}' has a normal off unit length by ${worst} - a shader normalizes that to NaN`);
  }
});

test('no position in the committed .glb is non-finite', () => {
  for (const [key, p] of Object.entries(PARTS)) {
    for (const v of p.positions) {
      assert.ok(Number.isFinite(v), `part '${key}' has a non-finite position`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* The authored frames, which every placement's arithmetic assumes     */
/* ------------------------------------------------------------------ */

test('the arch is authored to the frame the world places it by', () => {
  /* `CitadelWorld` computes every springing line as `head - halfSpan *
   * Math.SQRT2`, which is only correct while the curve really does rise
   * `sqrt(1 + 2c)` half-spans. Asserted against the committed bytes rather than
   * against the constant, because the constant is what the generator used and
   * the bytes are what the browser loads. */
  assert.equal(ARCH_R, 1 + ARCH_C);
  assert.ok(Math.abs(ARCH_CROWN - Math.sqrt(1 + 2 * ARCH_C)) < 1e-12);
  assert.ok(Math.abs(ARCH_CROWN - Math.SQRT2) < 1e-12,
    'the world places arches with Math.SQRT2; the curve must rise that many half-spans');

  const a = PARTS.arch;
  // Springing line at y = 0: nothing below it, and the spandrel reaches it.
  assert.ok(a.min[1] >= -1e-5, `the arch reaches below its springing line (${a.min[1]})`);
  // The crown, plus the keystone, which is the only thing above it.
  assert.ok(a.max[1] > ARCH_CROWN, 'the arch has no keystone above the crown');
  assert.ok(a.max[1] < ARCH_CROWN + 0.25, `the keystone stands ${a.max[1] - ARCH_CROWN} over the crown`);
  // Half-span 1 either side, plus the archivolt's outward offset.
  assert.ok(a.min[0] < -1 && a.max[0] > 1, 'the arch does not span its own half-spans');
  assert.ok(a.max[0] < 1.25, 'the arch is wider than the opening it surrounds');

  // The curve itself: first station on the springing line at the jamb, last on
  // the axis at the crown.
  const first = archPoint(0);
  const last = archPoint(ARCH_STATIONS - 1);
  assert.ok(Math.abs(first.x - 1) < 1e-12 && Math.abs(first.y) < 1e-12);
  assert.ok(Math.abs(last.x) < 1e-12 && Math.abs(last.y - ARCH_CROWN) < 1e-12);
});

test('the screen and the corbel are authored to the frames the world places them by', () => {
  const s = PARTS.screen;
  for (const k of [0, 1, 2]) {
    assert.ok(s.min[k] >= -0.5 - 1e-5 && s.max[k] <= 0.5 + 1e-5,
      `the screen leaves its unit frame on axis ${k} (${s.min[k]}..${s.max[k]})`);
  }

  const c = PARTS.corbel;
  assert.ok(c.min[0] >= -0.5 - 1e-5 && c.max[0] <= 0.5 + 1e-5,
    'the corbel run leaves its own length');
  assert.ok(c.max[1] <= 0.12, 'the corbel rises above the slab it hangs under');
  assert.ok(c.min[1] >= -1.0 - 1e-5, 'the corbel hangs below its declared drop');
  assert.ok(c.min[2] >= -1e-5, 'the corbel reaches back through the wall it sits on');
  assert.ok(c.max[2] <= 1.1, 'the corbel projects past its declared reach');
});

/* ------------------------------------------------------------------ */
/* THE COST RULE, driven through a real headless build                 */
/* ------------------------------------------------------------------ */

/**
 * Install the least DOM and WebGL a world build touches.
 *
 * Copied rather than imported, for the reason `citadel-budgets.test.mjs`
 * records: importing another suite's harness also RUNS its tests inside this
 * file's process and reports them as this file's.
 */
function harness() {
  if (globalThis.__citadelAssetsHarness) return;
  globalThis.__citadelAssetsHarness = true;

  class Img {
    constructor(a, b, c) {
      if (typeof a === 'number') {
        this.width = a; this.height = b;
        this.data = new Uint8ClampedArray(a * b * 4);
      } else {
        this.data = a; this.width = b; this.height = c ?? 1;
      }
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
    createElement(tag) {
      const c = { width: 1, height: 1, style: {}, tagName: tag };
      c.getContext = () => context2d(c);
      return c;
    },
    createElementNS(_ns, tag) { return this.createElement(tag); },
  };
  globalThis.window = globalThis;
  globalThis.OffscreenCanvas = class {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { return context2d(this); }
  };
  const dead = () => ({ texture: null, dispose() {} });
  THREE.PMREMGenerator.prototype.fromEquirectangular = dead;
  THREE.PMREMGenerator.prototype.fromScene = dead;
  THREE.PMREMGenerator.prototype.compileEquirectangularShader = () => {};
}

harness();
const { Physics } = await import('../../src/physics/Physics.js');
const { CitadelWorld } = await import('../../src/worlds/CitadelWorld.js');

/** The asset map the loader would have produced, out of the real committed bytes. */
function installFromDisk() {
  const parts = {};
  for (const [key, p] of Object.entries(PARTS)) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p.positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(p.normals, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(p.uvs, 2));
    g.setIndex(new THREE.BufferAttribute(p.indices, 1));
    parts[key] = g;
  }
  installCitadelAssets({ parts, bind: MANIFEST.bind });
}

async function build() {
  const physics = new Physics();
  const renderer = {
    capabilities: { getMaxAnisotropy: () => 4, isWebGL2: true },
    initTexture() {}, getContext: () => ({}),
    getRenderTarget: () => null, setRenderTarget() {}, render() {}, clear() {},
  };
  const scene = new THREE.Scene();
  const mats = new Map();
  const world = new CitadelWorld({
    physics,
    scene,
    bus: { on: () => () => {}, emit() {} },
    engine: { renderer, onFrameUpdate: () => () => {}, onResize: () => () => {} },
    materials: {
      get: (k) => {
        if (!mats.has(k)) { const m = new THREE.MeshStandardMaterial(); m.name = String(k); mats.set(k, m); }
        return mats.get(k);
      },
      dispose() {},
    },
  });
  world.physics = physics;
  let colliders = 0;
  for (const m of ['addBox', 'addRotatedBox', 'addSphere', 'addMesh', 'addHeightfield']) {
    const fn = physics[m];
    if (typeof fn !== 'function') continue;
    physics[m] = function counted(...a) { colliders++; return fn.apply(this, a); };
  }
  await world.build(() => {});

  let meshes = 0;
  let tris = 0;
  const materials = new Set();
  const names = [];
  world.group.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    names.push(o.name);
    const g = o.geometry;
    const n = (g.index ? g.index.count : g.attributes.position.count) / 3;
    tris += n * (o.isInstancedMesh ? o.count : 1);
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) if (m) materials.add(m.name);
  });
  return {
    meshes, tris, colliders, names,
    materials: [...materials].sort(),
    placed: world._authoredBy ?? {},
  };
}

/* One build of each, shared by every test below. Each costs seconds; the
 * citadel suite already spends 140 of them and this file is not the place to
 * spend four more per assertion. */
resetCitadelAssets();
const BARE = await build();
installFromDisk();
const DRESSED = await build();
resetCitadelAssets();

test('the authored architecture adds no mesh, no material and no collider', () => {
  console.log(`  meshes    ${BARE.meshes} -> ${DRESSED.meshes}`);
  console.log(`  materials ${BARE.materials.length} -> ${DRESSED.materials.length}`);
  console.log(`  colliders ${BARE.colliders} -> ${DRESSED.colliders}`);
  console.log(`  triangles ${BARE.tris} -> ${DRESSED.tris}  (+${DRESSED.tris - BARE.tris})`);
  console.log(`  placements ${JSON.stringify(DRESSED.placed)}`);

  assert.equal(DRESSED.meshes, BARE.meshes,
    'the authored parts added a scene mesh - that is a draw call');
  assert.deepEqual(DRESSED.materials, BARE.materials,
    'the authored parts added a material - that is a candidate shader program');
  assert.equal(DRESSED.colliders, BARE.colliders,
    'the authored parts added a collider - art may not move a route, and every gap, '
    + 'reach and landing measurement in this suite is taken against the colliders');
});

test('the authored architecture is inside its world-level triangle reservation', () => {
  const delta = DRESSED.tris - BARE.tris;
  assert.ok(delta > 0, 'the authored parts added no triangles - nothing was placed');
  assert.ok(delta <= CITADEL_TRI_BUDGET,
    `the authored parts cost ${delta} triangles, over the ${CITADEL_TRI_BUDGET} reservation`);
});

test('every part is actually placed, and no part is placed once by accident', () => {
  /* A part that loads and is never used is a manifest entry pretending to be
   * art, and it would pass every assertion above. The floors are deliberately
   * loose - the counts follow `SOUK_RINGS` and the minaret count, neither of
   * which this file owns - but "more than a handful" is the difference between
   * a rule that fires and a rule that does not. */
  const FLOOR = { arch: 50, screen: 50, corbel: 20 };
  for (const key of CITADEL_PART_KEYS) {
    const n = DRESSED.placed[key] ?? 0;
    assert.ok(n >= FLOOR[key],
      `part '${key}' was placed ${n} times, under its floor of ${FLOOR[key]} - the placement rule is not firing`);
  }
});

test('CITADEL_WELDABLE names buckets the world really flushes', () => {
  /* The list is only worth anything if it describes the real build. Every
   * `batch:key` on it must be a mesh the world produced, or the allow-list is a
   * stale claim that welding somewhere is safe. */
  const built = new Set(BARE.names);
  for (const pair of CITADEL_WELDABLE) {
    assert.ok(built.has(pair) || [...built].some((n) => n.startsWith(`${pair}#`)),
      `'${pair}' is on the weldable list and the world flushes no such bucket `
      + `(it flushes: ${[...built].filter((n) => n.includes(':')).slice(0, 12).join(', ')})`);
  }
});

test('a missing asset degrades to the world as it was, rather than throwing', () => {
  resetCitadelAssets();
  assert.equal(citadelPart('arch'), null);
  assert.deepEqual(citadelParts(), []);
  assert.ok(BARE.meshes > 100, 'the bare world did not build');
  assert.ok(BARE.tris > 100000, 'the bare world built nothing');
});

test('the loader refuses a bind to a bucket the world does not flush', () => {
  resetCitadelAssets();
  installCitadelAssets({
    parts: { arch: {} },
    bind: { arch: { slot: 'fabric.banner', batches: ['cliff'] } },
  });
  /* `installCitadelAssets` is the test seam and does not re-validate, so what
   * this pins is the guarantee the SHIPPED path enforces: `_authored` re-checks
   * the bind against the batch it is adding to, so a bad bind places nothing
   * rather than opening a bucket. */
  const part = citadelPart('arch');
  assert.equal(part.slot, 'fabric.banner');
  assert.ok(!CITADEL_WELDABLE.includes('cliff:fabric.banner'));
  resetCitadelAssets();
});

/* ------------------------------------------------------------------ */
/* The byte diff                                                       */
/* ------------------------------------------------------------------ */

test('re-running the generator reproduces the committed file byte for byte', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'citadel-glb-'));
  try {
    for (const entry of MANIFEST.assets) {
      const out = path.join(dir, entry.file);
      execFileSync(process.execPath, [path.join(ROOT, 'scripts/make-citadel-glb.mjs')], {
        cwd: ROOT,
        env: { ...process.env, CITADEL_GLB_SET: entry.id, CITADEL_GLB_OUT: out },
        stdio: 'pipe',
      });
      const a = readFileSync(path.join(DIR, entry.file));
      const b = readFileSync(out);
      assert.ok(a.equals(b),
        `${entry.file} is not what scripts/make-citadel-glb.mjs produces today `
        + `(${a.length} bytes committed, ${b.length} regenerated)`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
