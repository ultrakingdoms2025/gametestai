/**
 * The authored ejecta block, held to the contract the ship, hero, beast, crowd,
 * yard and belt assets are held to - plus the ones specific to a geometry that
 * SUBSTITUTES for a primitive rather than arriving as its own bucket.
 *
 * ── What this file is defending ───────────────────────────────────────────
 *
 * A binary in a repository is a claim that somebody made it and that it still
 * says what the manifest says it says. Neither half survives on trust. The
 * ship tests established the shape - allow-listed licence, manifest byte count
 * against the file on disk, triangle count against the parsed scene, and a
 * re-run of the generator compared with `Buffer.equals`; `npc-assets` added the
 * licence ledger; `beast-assets` added the cost rule; `yard-assets` added
 * "build the world both ways and diff it"; `maze-glb` added the three geometry
 * gates. This follows all five.
 *
 * ── The gate `art-citadel` paid for, and why it bites HARDER here ─────────
 *
 * **A degenerate triangle has a zero-length normal, which is finite, valid
 * glTF, and NaN the instant a shader normalizes it.** `art-citadel` dissolved a
 * gatehouse into a white cloud that way.
 *
 * `belt-assets.test.mjs` records that the belt's material carries
 * `flatShading: true`, so three ignores the stored normals and takes
 * `normalize(cross(dFdx, dFdy))` per fragment. **The planet prop material is
 * the other case**: `flatShading` is false and the geometry carries its own
 * per-face normals, so three uses the STORED normals - which means a
 * zero-length one reaches `normalize()` in the VERTEX shader and NaNs every
 * fragment the triangle covers, on 8,880 instances across ten worlds. The
 * generator refuses one where the triangle is written; this file refuses one in
 * the bytes that ship, which is a different claim - a file could have been
 * hand-edited, re-exported, or written by an older generator and committed.
 *
 * ── The winding gate, and the shape `art-maze` warned against ─────────────
 *
 * NOT a star-shaped facing test. `art-maze` recorded that its per-face outward
 * test fired on a candle flame that legitimately faces inward, and this body
 * has two fracture planes cut through it whose faces legitimately lean well off
 * radial. So winding is checked by the two claims that are true of any closed
 * solid however it is shaped: **every directed edge is matched by its reverse**
 * (closed manifold) and **the signed volume is positive** (wound outward).
 *
 * The manifold check is not decoration. The first build of the generator split
 * eight faces into four and left their neighbours spanning the old edge - a
 * T-junction, and because the new midpoints are re-projected onto the noise
 * surface rather than left on the chord, a visible triangular crack straight
 * through into the inside of the rock. Nothing in the engine would have said
 * so. This gate caught it before a byte shipped.
 *
 * ── And the gates that measure something the game actually does ───────────
 *
 * The last block builds a real boulder field BOTH ways - with the committed
 * geometry installed and without it - and asserts that the placement, every
 * instance matrix and every collider box are IDENTICAL and that the only thing
 * that differs is which geometry the mesh carries. "The .glb parses" is a gate
 * that measures something the game does not do, and the roadmap's line is that
 * such a gate is worse than no gate.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

import { blockReport } from '../make-planet-glb.mjs';
import { buildPropField } from '../../src/worlds/planets/PlanetProps.js';
import { PLANETS } from '../../src/worlds/planets/index.js';
import {
  BLOCK_PART_KEY, BLOCK_SPLITS, BLOCK_TRI_BUDGET, BLOCK_R_MAX, BLOCK_R_MIN,
  installPlanetAssets, resetPlanetAssets, blockGeometry,
} from '../../src/worlds/planets/PlanetAssets.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'public/assets/planets');
const MANIFEST = JSON.parse(readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));

/** Licences an asset in this repository may carry. Same list as the belt's. */
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
    bin.byteOffset + view.byteOffset + view.byteLength,
  );
  return new Ctor(slice);
}

/** The one mesh in the file, straight out of the bytes. */
function glbMesh(file) {
  const { json, bin } = readGlb(file);
  assert.equal(json.meshes.length, 1, `${file}: expected exactly one mesh`);
  const mesh = json.meshes[0];
  const prim = mesh.primitives[0];
  const idxAcc = json.accessors[prim.indices];
  const position = accessorArray(json, bin, prim.attributes.POSITION, Float32Array);
  const normal = accessorArray(json, bin, prim.attributes.NORMAL, Float32Array);
  const uv = prim.attributes.TEXCOORD_0 === undefined
    ? null : accessorArray(json, bin, prim.attributes.TEXCOORD_0, Float32Array);
  const indices = accessorArray(
    json, bin, prim.indices, idxAcc.componentType === 5125 ? Uint32Array : Uint16Array,
  );
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  if (uv) geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  return { json, name: mesh.name, position, normal, uv, indices, tris: indices.length / 3, geometry };
}

const FILE = path.join(DIR, 'ejecta-block.glb');
const ENTRY = MANIFEST.assets.find((a) => a.id === 'ejecta-block');

/* ------------------------------------------------------------------ */
/* The manifest and the ledger                                         */
/* ------------------------------------------------------------------ */

test('the manifest declares exactly the asset the loader looks for', () => {
  assert.ok(Array.isArray(MANIFEST.assets), 'manifest has no `assets` array');
  assert.equal(MANIFEST.assets.length, 1, 'the planets manifest declares more than the one asset');
  assert.ok(ENTRY, 'no `ejecta-block` entry');
  for (const field of ['file', 'kind', 'licence', 'source', 'parts', 'tris', 'bytes']) {
    assert.ok(ENTRY[field] !== undefined, `ejecta-block: manifest is missing \`${field}\``);
  }
  assert.equal(ENTRY.kind, 'geometry');
  assert.ok(LICENCES.includes(ENTRY.licence),
    `ejecta-block: licence '${ENTRY.licence}' is not on the allow-list (${LICENCES.join(', ')})`);
  assert.deepEqual(ENTRY.parts, [BLOCK_PART_KEY],
    "the manifest's part list is not the prop kind the loader accepts");
  assert.equal(ENTRY.splits, BLOCK_SPLITS,
    'the manifest and the loader disagree about the tessellation');
});

test('ejecta-block has a line in the licence ledger', () => {
  const md = ledger();
  assert.ok(md.includes('`ejecta-block`'),
    'docs/assets/LICENCES.md has no line for `ejecta-block` - every asset gets one on the day it lands');
  assert.ok(md.includes('public/assets/planets/ejecta-block.glb'),
    'the ledger line for `ejecta-block` does not name its file');
});

test("the manifest's byte count is the file on disk", () => {
  const bytes = readFileSync(FILE).length;
  assert.equal(ENTRY.bytes, bytes,
    `ejecta-block: manifest says ${ENTRY.bytes} bytes, the file is ${bytes}`);
});

test("the manifest's triangle count is the parsed scene, and it is the budget", () => {
  const m = glbMesh(FILE);
  assert.equal(m.tris, ENTRY.tris,
    `ejecta-block: manifest says ${ENTRY.tris} triangles, the file has ${m.tris}`);
  assert.equal(m.tris, BLOCK_TRI_BUDGET,
    `ejecta-block: ${m.tris} triangles is not the ${BLOCK_TRI_BUDGET} the loader reserves`);
  assert.equal(m.position.length / 3, ENTRY.verts,
    'the manifest and the file disagree about the vertex count');
});

test('re-running the generator reproduces the committed file', () => {
  /* The whole meaning of the `generated` licence. Without this the word is a
   * claim; with it, a hand-edited or externally-sourced .glb cannot survive a
   * test run. */
  const tmp = mkdtempSync(path.join(tmpdir(), 'planet-glb-'));
  try {
    const out = path.join(tmp, 'ejecta-block.glb');
    execFileSync(process.execPath, [path.join(ROOT, 'scripts/make-planet-glb.mjs')], {
      env: { ...process.env, PLANET_GLB_OUT: out },
      stdio: 'pipe',
    });
    assert.ok(existsSync(out), 'the generator wrote nothing');
    const fresh = readFileSync(out);
    const committed = readFileSync(FILE);
    assert.ok(fresh.equals(committed),
      're-running scripts/make-planet-glb.mjs does not reproduce the committed file '
      + `(${fresh.length} bytes fresh, ${committed.length} committed) - re-run it and commit the result`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* The bytes themselves                                                */
/* ------------------------------------------------------------------ */

test('the mesh is named for the prop kind, and nothing else is in the file', () => {
  const { json } = readGlb(FILE);
  assert.equal(json.meshes.length, 1);
  assert.equal(json.meshes[0].name, BLOCK_PART_KEY,
    `the mesh is named '${json.meshes[0].name}', which PlanetAssets.namedPart will refuse`);
  assert.equal(json.nodes.length, 1, 'the file carries more than one node');
  assert.equal(json.nodes[0].name, BLOCK_PART_KEY);
});

test('the glTF material is a placeholder the game never reads', () => {
  const { json } = readGlb(FILE);
  /* One material, and its NAME says it is not for use. `PlanetAssets.namedPart`
   * never touches `o.material`, and the block draws in the planet's own
   * `planet.<id>.rock` - so an authored PBR material here would be a new
   * program family on every one of ten world loads if anybody ever wired it. */
  assert.equal(json.materials.length, 1);
  assert.match(json.materials[0].name, /placeholder/,
    'the glTF material is not marked as a placeholder');
});

test('the file carries UVs, because the prop material is textured', () => {
  const m = glbMesh(FILE);
  assert.ok(m.uv, 'no TEXCOORD_0 - every facet would sample texel (0,0) and no error anywhere');
  assert.equal(m.uv.length / 2, m.position.length / 3, 'one UV per vertex');
  for (let i = 0; i < m.uv.length; i++) {
    assert.ok(Number.isFinite(m.uv[i]), `UV ${i} is ${m.uv[i]}`);
  }
});

test('every normal in the committed bytes is unit length', () => {
  /* @see the header. `flatShading` is false on the prop material, so these
   * stored normals are the ones the shader normalizes. */
  const m = glbMesh(FILE);
  assert.equal(m.normal.length, m.position.length, 'one normal per vertex');
  let worst = 0;
  for (let i = 0; i < m.normal.length; i += 3) {
    const len = Math.hypot(m.normal[i], m.normal[i + 1], m.normal[i + 2]);
    assert.ok(Number.isFinite(len) && len > 0,
      `normal at vertex ${i / 3} has length ${len} - a NaN pixel through the bloom pass`);
    worst = Math.max(worst, Math.abs(len - 1));
  }
  assert.ok(worst < 1e-4, `worst normal is off unit length by ${worst}`);
});

test('no triangle in the committed bytes is degenerate', () => {
  const m = glbMesh(FILE);
  let worst = Infinity;
  for (let t = 0; t < m.tris; t++) {
    const a = m.indices[t * 3] * 3;
    const b = m.indices[t * 3 + 1] * 3;
    const c = m.indices[t * 3 + 2] * 3;
    const e1 = [m.position[b] - m.position[a], m.position[b + 1] - m.position[a + 1], m.position[b + 2] - m.position[a + 2]];
    const e2 = [m.position[c] - m.position[a], m.position[c + 1] - m.position[a + 1], m.position[c + 2] - m.position[a + 2]];
    const n = Math.hypot(
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    );
    worst = Math.min(worst, n);
  }
  assert.ok(worst > 1e-6,
    `the smallest triangle in the file has cross-product length ${worst} - a zero-length normal`);
});

test('the committed body is a closed manifold wound outward', () => {
  /* NOT a star-shaped facing test - @see the header, and `art-maze`'s candle
   * flame. These two claims are true of any closed solid however it is cut. */
  const m = glbMesh(FILE);
  const seen = new Set();
  for (let t = 0; t < m.tris; t++) {
    const a = m.indices[t * 3]; const b = m.indices[t * 3 + 1]; const c = m.indices[t * 3 + 2];
    for (const [i, j] of [[a, b], [b, c], [c, a]]) {
      const k = `${i}>${j}`;
      assert.ok(!seen.has(k), `directed edge ${k} appears twice - the surface overlaps itself`);
      seen.add(k);
    }
  }
  /* The file is written with per-face vertices, so an edge's reverse is on a
   * DIFFERENT pair of indices at the same two POSITIONS. Match on the position
   * pair, quantised, which is the only form the bytes can be checked in. */
  const key = (i) => `${m.position[i * 3].toFixed(5)},${m.position[i * 3 + 1].toFixed(5)},${m.position[i * 3 + 2].toFixed(5)}`;
  const dir = new Map();
  for (let t = 0; t < m.tris; t++) {
    const a = m.indices[t * 3]; const b = m.indices[t * 3 + 1]; const c = m.indices[t * 3 + 2];
    for (const [i, j] of [[a, b], [b, c], [c, a]]) {
      const k = `${key(i)}|${key(j)}`;
      dir.set(k, (dir.get(k) ?? 0) + 1);
    }
  }
  for (const k of dir.keys()) {
    const [p, q] = k.split('|');
    assert.equal(dir.get(`${q}|${p}`), 1,
      `edge ${k} has no single reverse - the body has a hole or a T-junction in it`);
    assert.equal(dir.get(k), 1, `edge ${k} appears ${dir.get(k)} times`);
  }

  let vol6 = 0;
  for (let t = 0; t < m.tris; t++) {
    const a = m.indices[t * 3] * 3; const b = m.indices[t * 3 + 1] * 3; const c = m.indices[t * 3 + 2] * 3;
    const ax = m.position[a]; const ay = m.position[a + 1]; const az = m.position[a + 2];
    const bx = m.position[b]; const by = m.position[b + 1]; const bz = m.position[b + 2];
    const cx = m.position[c]; const cy = m.position[c + 1]; const cz = m.position[c + 2];
    vol6 += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  assert.ok(vol6 > 0, `signed volume is ${vol6} - the body is wound inside out and renders as absent`);
});

test('the committed body stays inside the envelope the icosahedron it replaces reaches', () => {
  /* `buildPropField`'s boulder collider is `max(sx, sz2) * 0.8` and
   * `IcosahedronGeometry(1, 0)` reaches 1.0 at its twelve vertices, so the
   * drawn rock ALREADY spills a quarter of its radius outside its own collider.
   * That is a pre-existing trade and this asset may not make it worse. */
  const m = glbMesh(FILE);
  let lo = Infinity; let hi = -Infinity;
  for (let i = 0; i < m.position.length; i += 3) {
    const r = Math.hypot(m.position[i], m.position[i + 1], m.position[i + 2]);
    lo = Math.min(lo, r); hi = Math.max(hi, r);
  }
  assert.ok(hi <= BLOCK_R_MAX,
    `the block reaches ${hi.toFixed(4)}, outside the ${BLOCK_R_MAX} envelope - it would spill further outside its collider than the primitive did`);
  assert.ok(lo >= BLOCK_R_MIN, `the block pinches to ${lo.toFixed(4)}, under the ${BLOCK_R_MIN} floor`);
  assert.ok(Math.abs(hi - ENTRY.radius[1]) < 1e-3 && Math.abs(lo - ENTRY.radius[0]) < 1e-3,
    `the manifest claims radius ${ENTRY.radius.join('..')}, the file measures ${lo.toFixed(4)}..${hi.toFixed(4)}`);
});

test('the block is not a regular solid, which is the whole reason it exists', () => {
  /* The defect being fixed is that all 8,880 boulders in the game were the SAME
   * twenty faces at different scales, so the per-instance tumble rotated a
   * symmetry instead of changing a silhouette. A test that only checked the
   * triangle count would pass on an unmodified icosahedron. */
  const m = glbMesh(FILE);
  const radii = [];
  for (let i = 0; i < m.position.length; i += 3) {
    radii.push(Math.hypot(m.position[i], m.position[i + 1], m.position[i + 2]));
  }
  const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
  const spread = Math.max(...radii) - Math.min(...radii);
  assert.ok(spread / mean > 0.2,
    `the vertex radii span only ${(100 * spread / mean).toFixed(1)}% of the mean - this is still a regular solid`);

  /* And the facets have to differ in AREA. The threshold is 1.25 and not 1.8,
   * and the low number is the honest one: at twenty triangles every face
   * descends from one of the icosahedron's twenty equal ones, so the only
   * thing that can vary their areas is how far their three corners moved. The
   * committed file measures 1.40. An 8-split build reaches 3.1 - and that
   * build was refused on the pixels, so this gate is set against what actually
   * ships. Above 1.0 by a real margin is the claim: an unmodified
   * IcosahedronGeometry(1, 0) measures exactly 1.00 and would fail here. */
  const areas = [];
  for (let t = 0; t < m.tris; t++) {
    const a = m.indices[t * 3] * 3; const b = m.indices[t * 3 + 1] * 3; const c = m.indices[t * 3 + 2] * 3;
    const e1 = [m.position[b] - m.position[a], m.position[b + 1] - m.position[a + 1], m.position[b + 2] - m.position[a + 2]];
    const e2 = [m.position[c] - m.position[a], m.position[c + 1] - m.position[a + 1], m.position[c + 2] - m.position[a + 2]];
    areas.push(0.5 * Math.hypot(
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ));
  }
  assert.ok(Math.max(...areas) / Math.min(...areas) > 1.25,
    `the largest facet is only ${(Math.max(...areas) / Math.min(...areas)).toFixed(2)}x the smallest - the faces are still all the same size`);
});

test('the per-face UV islands are not all pointing the same way', () => {
  /* THE GATE FOR THE DEFECT THIS PASS CREATED AND THEN FIXED.
   *
   * The first build unwrapped every face onto a basis taken from its own first
   * edge. Adjacent facets therefore sampled the texture in nearly the same
   * DIRECTION, the prop texture is anisotropic, and its strong lines ran on
   * across facet boundaries into ladders spanning the whole rock - it
   * photographed as a paved terrace. The islands now carry a seeded rotation.
   *
   * Measured as the circular mean resultant of the per-face UV gradient angle:
   * 1.0 is every face aligned (the defect), 0.0 is fully scattered. The
   * committed file measures 0.31. The unrotated build measured 0.93.
   */
  const m = glbMesh(FILE);
  const angles = [];
  for (let t = 0; t < m.tris; t++) {
    const a = m.indices[t * 3]; const b = m.indices[t * 3 + 1];
    angles.push(Math.atan2(m.uv[b * 2 + 1] - m.uv[a * 2 + 1], m.uv[b * 2] - m.uv[a * 2]));
  }
  const mx = angles.reduce((s, x) => s + Math.cos(x), 0) / angles.length;
  const my = angles.reduce((s, x) => s + Math.sin(x), 0) / angles.length;
  const resultant = Math.hypot(mx, my);
  assert.ok(resultant < 0.6,
    `the per-face UV orientations have a mean resultant of ${resultant.toFixed(3)} - they are clustered, and an anisotropic texture will run on across facet boundaries`);
});

test('no two facets are coplanar, which is what twenty triangles can and cannot do', () => {
  /* A deliberately NEGATIVE assertion, pinning a limitation rather than a
   * feature, because the generator claimed a "fracture face" until this was
   * measured. A plane at offset 0.80 catches a 37-degree cap and an
   * icosahedron's vertices are 63.4 degrees apart, so at most ONE vertex is
   * ever clipped and no two faces can be made coplanar. If somebody raises the
   * split count or drops the plane offsets far enough to change that, this
   * fails and points at the comment that needs rewriting with it. */
  const m = glbMesh(FILE);
  const nor = [];
  for (let t = 0; t < m.tris; t++) {
    const i = m.indices[t * 3] * 3;
    nor.push([m.normal[i], m.normal[i + 1], m.normal[i + 2]]);
  }
  let best = -1;
  for (let i = 0; i < nor.length; i++) {
    for (let j = i + 1; j < nor.length; j++) {
      best = Math.max(best, nor[i][0] * nor[j][0] + nor[i][1] * nor[j][1] + nor[i][2] * nor[j][2]);
    }
  }
  assert.ok(best < 0.999,
    `two faces are coplanar (dot ${best.toFixed(5)}) - the generator's note about what a clipping plane can do at this tessellation is now wrong`);
  assert.ok(best > 0.7947,
    `the most parallel face pair is at dot ${best.toFixed(5)}, no better than a regular icosahedron's adjacent faces (0.7947) - the clipping planes did nothing`);
});

test("the generator's own report agrees with the committed bytes", () => {
  const r = blockReport(BLOCK_SPLITS);
  const m = glbMesh(FILE);
  assert.equal(r.tris, m.tris);
  assert.equal(r.verts, m.position.length / 3);
  assert.equal(r.unmatched, null, 'the generator reports an unmatched edge');
  assert.ok(r.volume6 > 0);
});

/* ------------------------------------------------------------------ */
/* The gates that measure something the game actually does             */
/* ------------------------------------------------------------------ */

/** A physics sink that records every collider a field asks for. */
function sink() {
  return {
    boxes: [],
    addBox(x, y, z, hx, hy, hz) { const c = { x, y, z, hx, hy, hz }; this.boxes.push(c); return c; },
    addRotatedBox(centre, half, yaw) {
      const c = { x: centre.x, y: centre.y, z: centre.z, hx: half.x, hy: half.y, hz: half.z, yaw };
      this.boxes.push(c);
      return c;
    },
  };
}

const HEIGHT = (x, z) => Math.sin(x * 0.011) * 2.4 + Math.cos(z * 0.013) * 1.7;

/** Build Cinder's real ejecta field, with the authored block or without it. */
function ejectaField(authored) {
  const spec = PLANETS.cinder.props.find((p) => p.id === 'ejecta');
  assert.ok(spec, 'Cinder has no `ejecta` prop field any more - this test is measuring nothing');
  const phys = sink();
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ name: 'planet.cinder.rock', vertexColors: true });
  const built = buildPropField(spec, {
    height: HEIGHT,
    half: 400,
    slopeStep: 3.1,
    seed: 0x51a7,
    liquid: null,
    landing: [],
    material,
    authored: authored ? { boulders: authored } : undefined,
    physics: phys,
    group,
    track: (c) => c,
  });
  const mats = [];
  const m = new THREE.Matrix4();
  for (let i = 0; i < built.mesh.count; i++) {
    built.mesh.getMatrixAt(i, m);
    mats.push([...m.elements]);
  }
  return { built, phys, mats, spec };
}

test('the committed block is what a real boulder field draws, in place of the primitive', () => {
  const geo = glbMesh(FILE).geometry;
  const withAsset = ejectaField(geo);
  const without = ejectaField(null);

  const triOf = (f) => (f.built.mesh.geometry.index
    ? f.built.mesh.geometry.index.count : f.built.mesh.geometry.attributes.position.count) / 3;

  assert.equal(triOf(without), 20, 'the procedural arm is not IcosahedronGeometry(1, 0) any more');
  assert.equal(triOf(withAsset), BLOCK_TRI_BUDGET, 'the authored arm is not the block');

  /* THE COST RULE. One mesh either way - the substitution does not earn a
   * bucket, so it costs no renderable, no instanced mesh and no draw call. */
  assert.equal(withAsset.built.mesh.count, without.built.mesh.count);
  assert.equal(group_meshes(withAsset), group_meshes(without),
    'the authored arm added a mesh to the group - the substitution is supposed to be free');
  assert.equal(withAsset.built.material, withAsset.built.material,
    'the authored arm cloned a material');
});

function group_meshes(f) {
  let n = 0;
  f.built.mesh.parent?.traverse((o) => { if (o.isMesh) n++; });
  return n;
}

test('the authored arm changes NOTHING about where the boulders are or what you can hit', () => {
  /* The claim the degradation path rests on: a deploy missing the file is the
   * same world minus some facets. Placement, every instance matrix and every
   * collider box have to be identical, or the asset is a gameplay change
   * wearing an art change's clothes. */
  const geo = glbMesh(FILE).geometry;
  const a = ejectaField(geo);
  const b = ejectaField(null);

  assert.equal(a.built.placed, b.built.placed, 'a different number of boulders was placed');
  assert.ok(a.built.placed > 500, `only ${a.built.placed} boulders placed - this test is measuring nothing`);
  assert.equal(a.built.colliders, b.built.colliders, 'a different number of colliders was registered');
  assert.equal(a.phys.boxes.length, b.phys.boxes.length);

  for (let i = 0; i < a.mats.length; i++) {
    assert.deepEqual(a.mats[i], b.mats[i], `instance ${i} is not in the same place in both arms`);
  }
  for (let i = 0; i < a.phys.boxes.length; i++) {
    assert.deepEqual(a.phys.boxes[i], b.phys.boxes[i], `collider ${i} differs between the arms`);
  }
});

test('every boulder field on every planet takes the authored block - there is no threshold', () => {
  /* `Belt.HERO_RADIUS` split the belt's population because it genuinely split.
   * Here the rule is the descriptor's own word for what the thing is, and this
   * asserts the drawn set is the WHOLE instance set of every field, off the real
   * descriptors rather than off a constant two files quote. */
  const geo = glbMesh(FILE).geometry;
  let fields = 0; let instances = 0;
  for (const [id, P] of Object.entries(PLANETS)) {
    for (const spec of P.props ?? []) {
      if (spec.kind !== 'boulders') continue;
      fields++;
      instances += spec.count;
      assert.equal(spec.collide, true,
        `${id}/${spec.id}: a boulders field that does not collide - the asset's premise is that these are things a body meets`);
    }
  }
  assert.ok(fields >= 13, `only ${fields} boulder fields found across the ten planets`);
  assert.ok(instances >= 8000, `only ${instances} boulder instances - the leverage claim is wrong`);

  /* And the substitution really is keyed on the kind, not on a size. */
  const spec = PLANETS.cinder.props.find((p) => p.id === 'ejecta');
  const built = ejectaField(geo);
  assert.equal(built.built.mesh.count, built.built.placed);
  assert.ok(built.built.placed <= spec.count);
});

test('a field of another kind is untouched by the authored block', () => {
  /* The asset is wired on the mesh NAME being a prop kind. A loader that
   * returned the block under the wrong key would silently turn every column,
   * spire and slab in the game into a rock. */
  const geo = glbMesh(FILE).geometry;
  const spec = PLANETS.cinder.props.find((p) => p.id === 'colonnade');
  const phys = sink();
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ vertexColors: true });
  const ctx = {
    height: HEIGHT, half: 400, slopeStep: 3.1, seed: 0x51a7, liquid: null, landing: [],
    material, physics: phys, group, track: (c) => c,
  };
  const plain = buildPropField(spec, ctx);
  const withBlock = buildPropField(spec, { ...ctx, authored: { boulders: geo } });
  const tris = (m) => (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
  assert.equal(tris(withBlock.mesh), tris(plain.mesh),
    'the boulder block leaked into a columns field');
  assert.equal(tris(plain.mesh), 24, 'the columns primitive changed');
});

/* ------------------------------------------------------------------ */
/* The loader                                                          */
/* ------------------------------------------------------------------ */

test('the loader degrades to null rather than throwing, and installs cleanly', () => {
  resetPlanetAssets();
  assert.equal(blockGeometry(), null, 'a fresh session should have no geometry until one is installed');
  const geo = glbMesh(FILE).geometry;
  installPlanetAssets(geo);
  assert.equal(blockGeometry(), geo);
  installPlanetAssets(null);
  assert.equal(blockGeometry(), null, 'installing null should force the procedural arm');
  resetPlanetAssets();
});
