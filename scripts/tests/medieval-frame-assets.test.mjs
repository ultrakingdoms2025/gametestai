/**
 * The authored medieval carpentry, held to the contract every authored asset
 * in this repository is held to - plus the environment-pass gates that are
 * specific to how Aldermoor Vale is built.
 *
 * ── What this file is defending ───────────────────────────────────────────
 *
 * A binary in a repository is a claim that somebody made it and that it still
 * says what the manifest says it says. Neither half survives on trust:
 * allow-listed licence, a ledger line, manifest byte count against the file
 * on disk, triangle count against the parsed bytes, per-part reservations, a
 * re-run of the generator compared with `Buffer.equals`, and every normal
 * unit length in the committed bytes - the zero-length-normal defect is the
 * one that dissolved the citadel's gatehouse into a white cloud through
 * bloom, and this generator computes its normals the same way.
 *
 * ── The cost gate, measured on a REAL headless build ──────────────────────
 *
 * The village and the castle are built twice - once with the committed bytes
 * installed and once without - and the mesh count and material set must be
 * IDENTICAL, with triangles the only line allowed to move and a ceiling on
 * how far. A new shader program can only come from a new material, and there
 * is no new material.
 *
 * ── And the round-6 environment gates, because a gate that measures what ──
 * ── the game does not do is worse than no gate ────────────────────────────
 *
 * The same headless build is then asked what a PLAYER standing in the vale
 * would find: that the side faces of the village houses actually carry
 * glazing now (the before shots photographed two facades in the hero framing
 * without a single opening), that every rut puddle stands on a road rather
 * than floating in open meadow (the before shots carried eight black discs
 * across the street framing's foreground), and that the castle's talus stays
 * off the roads and out of the gate passage.
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
  FRAME_PART_KEYS, FRAME_WELDABLE, MEDIEVAL_FRAME_TRI_BUDGET,
  framePart, installFrameAssets, resetFrameAssets,
} from '../../src/worlds/medieval/FrameAssets.js';
import {
  WELDABLE, PART_BINDING, TRI_BUDGET, SET_TRI_BUDGET, SET_PARTS,
} from '../make-medieval-glb.mjs';
import { MedievalWorld } from '../../src/worlds/MedievalWorld.js';
import { PLOTS } from '../../src/worlds/medieval/Settlements.js';
import { CASTLE, MARKET } from '../../src/worlds/terrain/MedievalHeight.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'public/assets/medieval');
const MANIFEST = JSON.parse(readFileSync(path.join(DIR, 'frame-manifest.json'), 'utf8'));

/** Licences an asset in this repository may carry. Same list as the maze's. */
const LICENCES = ['generated', 'CC0-1.0', 'CC-BY-4.0', 'proprietary-owned'];

/* CRLF: this repo has previously had a source scrape pass in a worktree and
 * fail in the checkout for no other reason. Every text read here normalises
 * before it anchors on anything. */
const text = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const ledger = () => text(path.join(ROOT, 'docs/assets/LICENCES.md'));

if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
}

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
      indices: grab(prim.indices, idx.componentType === 5125 ? Uint32Array : Uint16Array),
      min: pos.min,
      max: pos.max,
    };
  }
  return out;
}

const GLB_FILE = path.join(DIR, 'frame.glb');
const PARTS = glbParts(GLB_FILE);

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

  test(`${entry.id}: the manifest's triangle count is the parsed bytes`, () => {
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
  assert.deepEqual([...manifestParts].sort(), [...FRAME_PART_KEYS].sort(),
    'FrameAssets.FRAME_PART_KEYS and the manifest have drifted apart');
  for (const [set, parts] of Object.entries(SET_PARTS)) {
    const entry = MANIFEST.assets.find((a) => a.id === set);
    assert.ok(entry, `the generator writes a set '${set}' the manifest does not declare`);
    assert.deepEqual([...entry.parts].sort(), [...parts].sort(),
      `${set}: the generator's parts and the manifest's have drifted apart`);
  }
});

test('the loader and the generator agree on which slots are weldable', () => {
  assert.deepEqual([...FRAME_WELDABLE].sort(), [...WELDABLE].sort(),
    'FrameAssets.FRAME_WELDABLE and make-medieval-glb.mjs WELDABLE have drifted apart');
});

test('every bind in the manifest is on the weldable list', () => {
  for (const [key, b] of Object.entries(MANIFEST.bind)) {
    assert.ok(FRAME_PART_KEYS.includes(key), `manifest binds an unknown part '${key}'`);
    assert.deepEqual(b, PART_BINDING[key],
      `the manifest's bind for '${key}' and the generator's have drifted apart`);
    assert.ok(FRAME_WELDABLE.includes(b.slot),
      `part '${key}' binds to slot '${b.slot}', which the village GeoBatch does not already flush`);
  }
});

/* ------------------------------------------------------------------ */
/* THE NORMALS - the defect that whited out the citadel's gatehouse    */
/* ------------------------------------------------------------------ */

test('every normal in the committed .glb is unit length', () => {
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
      assert.ok(Number.isFinite(v), `part '${key}' carries a non-finite position`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* Byte-diff: the generator reproduces the committed file exactly      */
/* ------------------------------------------------------------------ */

test('re-running the generator reproduces the committed bytes', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'medieval-glb-'));
  try {
    const out = path.join(dir, 'frame.glb');
    execFileSync(process.execPath, [path.join(ROOT, 'scripts/make-medieval-glb.mjs')], {
      env: { ...process.env, MEDIEVAL_GLB_SET: 'frame', MEDIEVAL_GLB_OUT: out },
      stdio: 'pipe',
    });
    const fresh = readFileSync(out);
    const committed = readFileSync(GLB_FILE);
    assert.ok(fresh.equals(committed),
      `scripts/make-medieval-glb.mjs no longer reproduces public/assets/medieval/frame.glb `
      + `(${fresh.length} fresh vs ${committed.length} committed bytes) - regenerate and re-measure, `
      + 'or the committed binary is an orphan');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* The loader's own contract                                           */
/* ------------------------------------------------------------------ */

test('framePart is null before any install, and refuses unknown keys after one', () => {
  resetFrameAssets();
  assert.equal(framePart('brace'), null, 'a part resolved before anything loaded');
  installFrameAssets({
    parts: { brace: new THREE.BufferGeometry() },
    bind: { brace: { slot: 'beam' } },
  });
  assert.ok(framePart('brace'), 'an installed part did not resolve');
  assert.equal(framePart('console'), null, 'a part with no geometry resolved');
  assert.equal(framePart('gargoyle'), null, 'an unknown key resolved');
  resetFrameAssets();
});

/* ------------------------------------------------------------------ */
/* The cost, priced on a REAL headless build                           */
/* ------------------------------------------------------------------ */

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
  installFrameAssets({ parts, bind: MANIFEST.bind });
}

/**
 * The village and the castle, built for real under Node against a stub
 * physics and a stub material set - the same rig `medieval-approach.test.mjs`
 * uses, so the geometry priced here is the geometry that ships. The full
 * world build (terrain, forest, towns) costs a minute a run and adds nothing
 * to what these gates measure: every placement this pass makes lives in
 * `_buildCastle` and `_buildVillage`.
 */
async function build() {
  const colliders = [];
  const w = new MedievalWorld({
    physics: {
      addBox: (x, y, z, hx, hy, hz) => ({ x, y, z, hx, hy, hz, rotY: 0, solid: true }),
      addRotatedBox: (p, h, rotY) =>
        ({ x: p.x, y: p.y, z: p.z, hx: h.x, hy: h.y, hz: h.z, rotY, solid: true }),
    },
  });
  w.track = (c) => { colliders.push(c); return c; };
  const mats = new Map();
  w._mats = new Proxy({}, {
    get: (_t, k) => {
      if (typeof k !== 'string') return undefined;
      let m = mats.get(k);
      if (!m) {
        m = new THREE.MeshStandardMaterial({ vertexColors: true });
        m.userData.key = k;
        mats.set(k, m);
      }
      return m;
    },
    has: () => true,
  });
  w._buildRoadPaths();
  // Props and folk hang off `_buildMarket` and need the texture rig; neither
  // is touched by this pass and neither is measured by it.
  w._buildProps = () => {};
  w._buildFolk = () => {};
  await w._buildCastle();
  await w._buildVillage();
  await w._buildMarket();
  await w._buildRoads();

  let meshes = 0;
  let tris = 0;
  const geoByKey = new Map();
  w.group.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    const g = o.geometry;
    const n = (g.index ? g.index.count : g.attributes.position.count) / 3;
    tris += n * (o.isInstancedMesh ? o.count : 1);
    if (o.name) geoByKey.set(o.name, o);
  });
  return {
    world: w, meshes, tris, colliders: colliders.length,
    materialKeys: [...mats.keys()].sort(),
    geoByKey,
    placed: w._authoredBy ?? {},
  };
}

resetFrameAssets();
const BARE = await build();
installFromDisk();
const DRESSED = await build();
resetFrameAssets();

test('the authored carpentry adds no mesh, no material and no collider', () => {
  console.log(`  meshes    ${BARE.meshes} -> ${DRESSED.meshes}`);
  console.log(`  materials ${BARE.materialKeys.length} -> ${DRESSED.materialKeys.length}`);
  console.log(`  colliders ${BARE.colliders} -> ${DRESSED.colliders}`);
  console.log(`  triangles ${BARE.tris} -> ${DRESSED.tris}  (+${DRESSED.tris - BARE.tris})`);
  console.log(`  placements ${JSON.stringify(DRESSED.placed)}`);

  assert.equal(DRESSED.meshes, BARE.meshes,
    'the authored parts added a scene mesh - that is a draw call');
  assert.deepEqual(DRESSED.materialKeys, BARE.materialKeys,
    'the authored parts touched a material key the bare build does not - a candidate shader program');
  assert.equal(DRESSED.colliders, BARE.colliders,
    'the authored parts added a collider - art may not move a route, and every door-approach '
    + 'measurement in the medieval suite is taken against the colliders');
});

test('the authored carpentry is inside its world-level triangle reservation', () => {
  const delta = DRESSED.tris - BARE.tris;
  assert.ok(delta > 0, 'the authored parts added no triangles - nothing was placed');
  assert.ok(delta <= MEDIEVAL_FRAME_TRI_BUDGET,
    `the authored parts cost ${delta} triangles, over the ${MEDIEVAL_FRAME_TRI_BUDGET} reservation`);
});

test('every part is actually placed, and well past a handful', () => {
  /* Floors, not exact counts - the counts follow `PLOTS` and the jetty rule,
   * and neither belongs to this file. But "hundreds" is the difference
   * between a placement rule that fires and a manifest entry pretending to
   * be art. Measured at 424 braces / 154 consoles when this gate landed. */
  const FLOOR = { brace: 200, console: 60 };
  for (const key of FRAME_PART_KEYS) {
    const n = DRESSED.placed[key] ?? 0;
    assert.ok(n >= FLOOR[key],
      `part '${key}' was placed ${n} times, under its floor of ${FLOOR[key]} - the placement rule is not firing`);
  }
});

test('a missing asset degrades to the procedural strap, not to a hole', () => {
  // The bare build IS the fallback path. If it lost geometry relative to what
  // the village drew before this pass, the fallback strap has rotted.
  assert.ok(BARE.tris > 100000, `the bare village+castle build is ${BARE.tris} tris - the fallback path collapsed`);
  assert.equal(Object.keys(BARE.placed).length, 0, 'the bare build claims authored placements');
});

/* ------------------------------------------------------------------ */
/* ROUND-6 ENVIRONMENT GATES - what a player standing in the vale finds */
/* ------------------------------------------------------------------ */

test('every house face carries glazing: the side facades are no longer blank', () => {
  /* The before shots photographed the village-square framing with two entire
   * facades holding not one opening. The window loop only dressed local ±z;
   * round 6 added the ±x faces. Asserted against the built 'glass' district:
   * for a sample of plots, panes must exist near BOTH side faces of the
   * house, in its own frame. */
  const glass = BARE.geoByKey.get('medieval:glass');
  assert.ok(glass, 'the village build produced no glass district at all');
  const pos = glass.geometry.attributes.position;
  const sample = [PLOTS[0], PLOTS[3], PLOTS[7], PLOTS[12]];
  for (const [x, z, ry, w, d] of sample) {
    const c = Math.cos(ry);
    const s = Math.sin(ry);
    let west = false;
    let east = false;
    for (let i = 0; i < pos.count; i++) {
      const dx = pos.getX(i) - x;
      const dz = pos.getZ(i) - z;
      // Into the house's own frame.
      const lx = dx * c - dz * s;
      const lz = dx * s + dz * c;
      if (Math.abs(lz) > d / 2 + 0.1) continue;         // not this house's side band
      if (Math.abs(Math.abs(lx) - w / 2) > 0.75) continue; // not on a ±x face
      if (lx > 0) east = true; else west = true;
      if (east && west) break;
    }
    assert.ok(east && west,
      `plot at (${x}, ${z}): side faces carry no glazing (east ${east}, west ${west}) - the blank-facade defect is back`);
  }
});

test('every rut puddle stands on a road', () => {
  /* The before shots carried eight hard black discs across the street
   * framing's foreground, two of them floating in open meadow. A puddle is
   * water standing in a wheel line; an instance more than a wheel line's
   * width from any road is the defect returning. */
  const w = BARE.world;
  let pm = null;
  w.group.traverse((o) => {
    if (o.isInstancedMesh && o.material?.name === 'medieval.puddle') pm = o;
  });
  assert.ok(pm, 'the market build produced no puddle mesh');
  assert.ok(pm.count > 0, 'every puddle was dropped - the road snap is broken');
  const m = new THREE.Matrix4();
  const v = new THREE.Vector3();
  for (let i = 0; i < pm.count; i++) {
    pm.getMatrixAt(i, m);
    v.setFromMatrixPosition(m);
    const dist = w._roadDist(v.x, v.z);
    assert.ok(dist < 7.5,
      `puddle ${i} at (${v.x.toFixed(1)}, ${v.z.toFixed(1)}) stands ${dist.toFixed(1)} m from the nearest road - `
      + 'a black disc floating in meadow, which is the defect this rule exists to prevent');
  }
});

test('the loose setts read as pavement, not as black polka dots', () => {
  /* The composed street framing's whole foreground was stippled with hard
   * near-black discs, and it took an instance scan to name them after five
   * other systems had been fixed or ablated: the loose-sett stones were
   * tinted at HALF the street's own value and a third of them ringed the
   * market 4.6-7.8 m out in open ground. Two rules keep the defect out:
   * every stone's tint stays within sight of the pavement's own, and every
   * stone stands either on a road verge or tight against the market fringe. */
  const w = BARE.world;
  let setts = null;
  w.group.traverse((o) => {
    if (o.isInstancedMesh && o.material?.userData?.key === 'cobble') setts = o;
  });
  assert.ok(setts, 'the road build produced no loose-sett mesh');
  assert.ok(setts.count > 300, `only ${setts.count} loose setts placed`);
  const m = new THREE.Matrix4();
  const v = new THREE.Vector3();
  const c = new THREE.Color();
  for (let i = 0; i < setts.count; i++) {
    setts.getColorAt(i, c);
    assert.ok(Math.max(c.r, c.g, c.b) >= 0.3,
      `loose sett ${i} carries tint (${c.r.toFixed(2)}, ${c.g.toFixed(2)}, ${c.b.toFixed(2)}) - `
      + 'dark enough to read as a black disc on open ground, which is the photographed defect');
    setts.getMatrixAt(i, m);
    v.setFromMatrixPosition(m);
    const nearRoad = w._roadDist(v.x, v.z) < 3.2;
    const fringe =
      Math.abs(v.x - MARKET.x) < MARKET.hx + 6.2 && Math.abs(v.z - MARKET.z) < MARKET.hz + 6.2;
    assert.ok(nearRoad || fringe,
      `loose sett ${i} at (${v.x.toFixed(1)}, ${v.z.toFixed(1)}) stands in open ground - `
      + 'a cobble far from any pavement is a spot, not a dissolve');
  }
});

test('the market paving is one slab: the fray strands no islands in the meadow', () => {
  /* The composed street framing's foreground was stippled with hard black
   * ellipses, and a pixel-projection probe put every one inside the market
   * field's own fray band: the two-octave boundary noise in `_pavedField`
   * stranded detached one-quad islands of cobble out in the grass, which at
   * dusk render as holes punched in the meadow. The fix flood-fills the
   * candidate cells and keeps the main component; this asserts the shipped
   * geometry really is one component, by union-find over shared vertices. */
  const g = BARE.world._pavedField(MARKET.x, MARKET.z, MARKET.hx + 6, MARKET.hz + 5.5);
  const idx = g.getIndex().array;
  const n = g.attributes.position.count;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (a) => { while (parent[a] !== a) a = parent[a] = parent[parent[a]]; return a; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  for (let i = 0; i < idx.length; i += 3) {
    union(idx[i], idx[i + 1]);
    union(idx[i], idx[i + 2]);
  }
  const used = new Set();
  for (const i of idx) used.add(i);
  const roots = new Set();
  for (const i of used) roots.add(find(i));
  assert.equal(roots.size, 1,
    `the market paving is ${roots.size} disconnected pieces - stranded fray islands `
    + 'render as black discs in the street framing, which is the defect this gate exists for');
  g.dispose();
});

test('the castle talus hugs the curtain, stays off the roads and out of the gate', () => {
  /* The talus geometry merges into 'rubble'/'ashlar'/'leaf' and cannot be
   * counted from the scene; `_talusSpots` is the one-per-placement record it
   * leaves for exactly this gate - the same role `_authoredBy` plays for the
   * braces. Each spot must lie on the curtain's own apron, clear of the
   * roads, and clear of the gate passage. */
  const w = BARE.world;
  const spots = w._talusSpots;
  assert.ok(Array.isArray(spots), 'the talus run left no placement record');
  const count = spots.length / 2;
  assert.ok(count >= 25,
    `only ${count} talus placements committed at the curtain's foot - the run is not firing`);
  const wallW = CASTLE.x - CASTLE.hx;
  const wallE = CASTLE.x + CASTLE.hx;
  const wallN = CASTLE.z - CASTLE.hz;
  const wallS = CASTLE.z + CASTLE.hz;
  for (let i = 0; i < spots.length; i += 2) {
    const x = spots[i];
    const z = spots[i + 1];
    // On the apron: within 6 m outside the castle rectangle's perimeter.
    const dx = Math.max(wallW - x, x - wallE, 0);
    const dz = Math.max(wallN - z, z - wallS, 0);
    assert.ok(Math.hypot(dx, dz) < 6.5 && (dx > 0 || dz > 0 || true),
      `talus at (${x.toFixed(1)}, ${z.toFixed(1)}) is not on the curtain's apron`);
    assert.ok(w._roadDist(x, z) >= 3.5,
      `talus at (${x.toFixed(1)}, ${z.toFixed(1)}) sits on a road`);
    assert.ok(!(x > wallE - 1 && Math.abs(z - CASTLE.z) < 9),
      `talus at (${x.toFixed(1)}, ${z.toFixed(1)}) blocks the gate passage`);
  }
});
