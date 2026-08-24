/**
 * The authored Halberd Reach boulder, held to the contract the ship, hero,
 * beast, crowd and yard assets are held to - plus the two that are specific to
 * a rock in an instanced field.
 *
 * ── What this file is defending ───────────────────────────────────────────
 *
 * A binary in a repository is a claim that somebody made it and that it still
 * says what the manifest says it says. Neither half survives on trust. The
 * ship tests established the shape - allow-listed licence, manifest byte count
 * against the file on disk, triangle count against the parsed scene, and a
 * re-run of the generator compared with `Buffer.equals`; `npc-assets` added
 * the licence ledger; `beast-assets` added the cost rule; `yard-assets` added
 * "build the world both ways and diff it". This follows all four.
 *
 * ── The gate `art-citadel` paid for, read off the committed bytes ─────────
 *
 * **A degenerate triangle has a zero-length normal, which is finite, valid
 * glTF, and NaN the instant a shader normalizes it.** `art-citadel` dissolved
 * a gatehouse into a white cloud that way. It is worse here than there: the
 * belt's material carries `flatShading: true`, so three ignores the stored
 * normals entirely and takes `normalize(cross(dFdx(v), dFdy(v)))` in the
 * FRAGMENT shader - a zero-area triangle is a NaN pixel, `UnrealBloomPass`
 * smears one NaN over the whole frame, and the symptom is a white screen with
 * no error anywhere.
 *
 * The generator refuses one at the line where the triangle is written. This
 * file refuses one in the bytes that actually ship, which is not the same
 * claim: a file could have been hand-edited, re-exported, or written by an
 * older generator and committed.
 *
 * ── And the gate that measures something the game actually does ───────────
 *
 * The last tests build the belt BOTH ways - with the committed geometry
 * installed and without it - and compare what came out. "The .glb parses" is a
 * gate that measures something the game does not do, and the roadmap's line is
 * that such a gate is worse than no gate. "The field built from it has the
 * same material, the same colliders, the same 260 rocks in the same places,
 * and differs by exactly one bucket and its triangles" is not.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

import { heroReport } from '../make-belt-glb.mjs';
import { BELT, SPACE_BODIES } from '../../src/worlds/space/Bodies.js';
import { Belt, HERO_RADIUS } from '../../src/worlds/space/Belt.js';
import {
  BELT_PART_KEY, HERO_DETAIL, HERO_TRI_BUDGET,
  installBeltAssets, resetBeltAssets, heroGeometry,
} from '../../src/worlds/space/BeltAssets.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'public/assets/space');
const MANIFEST = JSON.parse(readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));

/** Licences an asset in this repository may carry. Same list as the yard's. */
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

/** The one mesh in the file, straight out of the bytes. */
function glbMesh(file) {
  const { json, bin } = readGlb(file);
  assert.equal(json.meshes.length, 1, `${file}: expected exactly one mesh`);
  const mesh = json.meshes[0];
  const prim = mesh.primitives[0];
  const idxAcc = json.accessors[prim.indices];
  const position = accessorArray(json, bin, prim.attributes.POSITION, Float32Array);
  const normal = accessorArray(json, bin, prim.attributes.NORMAL, Float32Array);
  const indices = accessorArray(
    json, bin, prim.indices, idxAcc.componentType === 5125 ? Uint32Array : Uint16Array
  );
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  return { json, name: mesh.name, position, normal, indices, tris: indices.length / 3, geometry };
}

const FILE = path.join(DIR, 'reach-boulder.glb');
const ENTRY = MANIFEST.assets.find((a) => a.id === 'reach-boulder');

/* ------------------------------------------------------------------ */
/* The manifest and the ledger                                         */
/* ------------------------------------------------------------------ */

test('the manifest declares exactly the asset the loader looks for', () => {
  assert.ok(Array.isArray(MANIFEST.assets), 'manifest has no `assets` array');
  assert.equal(MANIFEST.assets.length, 1, 'the space manifest declares more than the one asset');
  assert.ok(ENTRY, 'no `reach-boulder` entry');
  for (const field of ['file', 'kind', 'licence', 'source', 'parts', 'tris', 'bytes']) {
    assert.ok(ENTRY[field] !== undefined, `reach-boulder: manifest is missing \`${field}\``);
  }
  assert.equal(ENTRY.kind, 'geometry');
  assert.ok(LICENCES.includes(ENTRY.licence),
    `reach-boulder: licence '${ENTRY.licence}' is not on the allow-list (${LICENCES.join(', ')})`);
  assert.deepEqual(ENTRY.parts, [BELT_PART_KEY],
    'the manifest\'s part list is not the belt material key the loader accepts');
});

test('reach-boulder has a line in the licence ledger', () => {
  const md = ledger();
  assert.ok(md.includes('`reach-boulder`'),
    'docs/assets/LICENCES.md has no line for `reach-boulder` - every asset gets one on the day it lands');
  assert.ok(md.includes('public/assets/space/reach-boulder.glb'),
    'the ledger line for `reach-boulder` does not name its file');
});

test("the manifest's byte count is the file on disk", () => {
  const bytes = readFileSync(FILE).length;
  assert.equal(ENTRY.bytes, bytes,
    `reach-boulder: manifest says ${ENTRY.bytes} bytes, the file is ${bytes}`);
});

test("the manifest's triangle count is the parsed scene", () => {
  const m = glbMesh(FILE);
  assert.equal(m.tris, ENTRY.tris,
    `reach-boulder: manifest says ${ENTRY.tris} triangles, the file has ${m.tris}`);
  assert.equal(m.tris, HERO_TRI_BUDGET,
    `reach-boulder: ${m.tris} triangles is not the ${HERO_TRI_BUDGET} the loader reserves`);
  assert.equal(ENTRY.detail, HERO_DETAIL, 'the manifest and the loader disagree about the tessellation');
});

test('re-running the generator reproduces the committed file', () => {
  /* The whole meaning of the `generated` licence. Without this the word is a
   * claim; with it, a hand-edited or externally-sourced .glb cannot survive a
   * test run. */
  const tmp = mkdtempSync(path.join(tmpdir(), 'belt-glb-'));
  try {
    const out = path.join(tmp, 'reach-boulder.glb');
    execFileSync(process.execPath, [path.join(ROOT, 'scripts/make-belt-glb.mjs')], {
      env: { ...process.env, BELT_GLB_OUT: out },
      stdio: 'pipe',
    });
    assert.ok(existsSync(out), 'the generator wrote nothing');
    const fresh = readFileSync(out);
    const committed = readFileSync(FILE);
    assert.ok(fresh.equals(committed),
      're-running scripts/make-belt-glb.mjs does not reproduce the committed file '
      + `(${fresh.length} bytes fresh, ${committed.length} committed) - re-run it and commit the result`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* The bytes themselves                                                */
/* ------------------------------------------------------------------ */

test('the mesh is named for the belt material key, and nothing else is in the file', () => {
  const m = glbMesh(FILE);
  assert.equal(m.name, BELT_PART_KEY,
    `the mesh is named '${m.name}'; the loader only accepts '${BELT_PART_KEY}' and discards the rest`);
  assert.equal(m.json.nodes.length, 1, 'the file has more than one node');
  /* One placeholder material, and the loader is required never to read it.
   * Asserted so a future generator cannot start shipping a real PBR material
   * on the assumption that something downstream would notice. */
  assert.equal(m.json.materials.length, 1);
  assert.match(m.json.materials[0].name, /placeholder/);
});

test('every normal in the committed bytes is finite and unit length', () => {
  /* The art-citadel gate, read off the shipped file rather than off the
   * generator's own opinion of it. A zero-length normal is valid glTF. */
  const m = glbMesh(FILE);
  let worst = 0;
  for (let i = 0; i < m.normal.length; i += 3) {
    const x = m.normal[i], y = m.normal[i + 1], z = m.normal[i + 2];
    assert.ok(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z),
      `normal ${i / 3} is not finite`);
    const len = Math.hypot(x, y, z);
    worst = Math.max(worst, Math.abs(len - 1));
    assert.ok(Math.abs(len - 1) < 1e-4,
      `normal ${i / 3} has length ${len.toFixed(6)} - a non-unit normal is a NaN the moment a shader normalizes it`);
  }
  console.log(`   worst |‖n‖ - 1| over ${m.normal.length / 3} normals: ${worst.toExponential(2)}`);
});

test('every position is finite, and no triangle is degenerate', () => {
  const m = glbMesh(FILE);
  for (let i = 0; i < m.position.length; i++) {
    assert.ok(Number.isFinite(m.position[i]), `position component ${i} is not finite`);
  }
  let worstArea = Infinity;
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = m.indices[t] * 3, b = m.indices[t + 1] * 3, c = m.indices[t + 2] * 3;
    const ux = m.position[b] - m.position[a];
    const uy = m.position[b + 1] - m.position[a + 1];
    const uz = m.position[b + 2] - m.position[a + 2];
    const vx = m.position[c] - m.position[a];
    const vy = m.position[c + 1] - m.position[a + 1];
    const vz = m.position[c + 2] - m.position[a + 2];
    const area2 = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    worstArea = Math.min(worstArea, area2);
    assert.ok(area2 > 1e-7,
      `triangle ${t / 3} has area ${(area2 / 2).toExponential(2)} - `
      + 'flatShading takes the normal from screen-space derivatives, so a zero-area '
      + 'triangle is a NaN pixel and one NaN through the bloom is a white frame');
  }
  console.log(`   smallest triangle: ${(worstArea / 2).toExponential(2)} square units of a unit-radius rock`);
});

test('the surface is wound outward - positive signed volume', () => {
  /* A backfacing surface is ABSENT rather than wrong-looking: you see through
   * the rock to its far inside wall, which a screenshot review does not
   * reliably catch (art-dock). The per-face gate in the generator is
   * deliberately permissive so crater walls survive it; this is the global
   * check, and between them an inside-out mesh cannot ship. */
  const m = glbMesh(FILE);
  let v = 0;
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = m.indices[t] * 3, b = m.indices[t + 1] * 3, c = m.indices[t + 2] * 3;
    const ax = m.position[a], ay = m.position[a + 1], az = m.position[a + 2];
    const bx = m.position[b], by = m.position[b + 1], bz = m.position[b + 2];
    const cx = m.position[c], cy = m.position[c + 1], cz = m.position[c + 2];
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  assert.ok(v > 0, `signed volume is ${(v / 6).toFixed(4)} - the surface is inside out`);
});

test('the rock stays inside the collider envelope the procedural one had', () => {
  /* `SpaceWorld._buildBelt` registers a box of half-extent `r * 0.62`, and the
   * procedural rock already reaches 1.24r - documented, deliberate, "the
   * failure mode is clipping a rock's edge rather than hitting empty space".
   * The authored rock must not make that worse. */
  const m = glbMesh(FILE);
  let lo = Infinity, hi = 0;
  for (let i = 0; i < m.position.length; i += 3) {
    const r = Math.hypot(m.position[i], m.position[i + 1], m.position[i + 2]);
    lo = Math.min(lo, r);
    hi = Math.max(hi, r);
  }
  assert.ok(hi <= 1.24, `the rock reaches ${hi.toFixed(3)}r, outside the 1.24r the procedural rock reached`);
  assert.ok(lo >= 0.45, `the rock pinches to ${lo.toFixed(3)}r - that is a shard, not a boulder`);
  assert.ok(Math.abs(lo - ENTRY.radius[0]) < 5e-3 && Math.abs(hi - ENTRY.radius[1]) < 5e-3,
    `the manifest says radius ${ENTRY.radius.join('..')}, the file is ${lo.toFixed(3)}..${hi.toFixed(3)}`);
});

test("the generator's own report agrees with the bytes it wrote", () => {
  const r = heroReport();
  const m = glbMesh(FILE);
  assert.equal(r.tris, m.tris);
  assert.equal(r.verts, m.position.length / 3);
  assert.ok(r.volume6 > 0);
});

/* ------------------------------------------------------------------ */
/* The belt built both ways                                            */
/* ------------------------------------------------------------------ */

function buildBelt() {
  /* No camera: `update` no-ops and nothing is placed, which is exactly the
   * head-less arm the rest of the suite exercises. Everything asserted below
   * is decided in `_build`. */
  return new Belt(BELT, null);
}

test('installing the authored rock costs one bucket and its triangles, and nothing else', () => {
  resetBeltAssets();
  const plain = buildBelt();
  const plainMats = new Set(plain.meshes.map((m) => m.material.uuid));
  const plainNames = new Set(plain.meshes.map((m) => m.material.name));
  const plainColliders = plain.colliderRocks.map((r) => `${r.x},${r.y},${r.z},${r.r}`);
  /* `index ? index.count : position.count` - the procedural rocks come out of
   * `IcosahedronGeometry`, which three writes NON-indexed, and the authored one
   * is indexed. Reading `index.count` alone would throw on the arm this test
   * exists to prove still works. */
  const tris = (b) => b.meshes.reduce(
    (n, m) => n + ((m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3) * m.count,
    0
  );
  const plainTris = tris(plain);
  const plainPositions = Array.from(plain.trueX).map((x, i) => `${x},${plain.trueY[i]},${plain.trueZ[i]},${plain.radius[i]}`);
  assert.equal(plain.heroMesh, -1, 'the procedural arm should not report a hero bucket');
  assert.equal(plain.meshes.length, 3);

  installBeltAssets(glbMesh(FILE).geometry);
  const hero = buildBelt();
  const heroMats = new Set(hero.meshes.map((m) => m.material.uuid));
  const heroTris = tris(hero);
  const heroPositions = Array.from(hero.trueX).map((x, i) => `${x},${hero.trueY[i]},${hero.trueZ[i]},${hero.radius[i]}`);

  /* ONE material either way, and it is the SAME one across every bucket.
   * This is the whole perf argument: a fourth InstancedMesh that brought its
   * own material would be a candidate new shader program. */
  assert.equal(plainMats.size, 1, 'the procedural belt uses more than one material');
  assert.equal(heroMats.size, 1, 'the authored belt uses more than one material');
  assert.deepEqual([...plainNames], ['space:belt:rock'],
    'the belt material must carry a name, or `world-shot --ablate` cannot see it');

  /* The field itself is untouched: same rocks, same places, same radii, same
   * colliders. Only the label saying which mesh draws which rock moves. */
  assert.deepEqual(heroPositions, plainPositions, 'installing the asset moved the field');
  assert.deepEqual(
    hero.colliderRocks.map((r) => `${r.x},${r.y},${r.z},${r.r}`), plainColliders,
    'installing the asset changed the collider set'
  );

  assert.equal(hero.meshes.length, 4, 'the authored belt should have exactly one more bucket');
  assert.equal(hero.heroMesh, 3);
  assert.equal(hero.meshes[3].name, 'space:belt:hero');

  const total = hero.meshes.reduce((n, m) => n + m.count, 0);
  assert.equal(total, plain.meshes.reduce((n, m) => n + m.count, 0), 'a rock was lost or duplicated');
  assert.equal(total, BELT.count);

  console.log(
    `   belt triangles ${plainTris} -> ${heroTris} (+${heroTris - plainTris}), `
    + `buckets 3 -> 4, materials 1 -> 1, hero instances ${hero.meshes[3].count}`
  );
  plain.dispose();
  hero.dispose();
  resetBeltAssets();
});

test('the hero bucket is EXACTLY the collider set - every rock you can hit is a rock you can see', () => {
  /* The rule the threshold exists to express. Asserted as set equality rather
   * than as "both use HERO_RADIUS", because reading the same constant twice
   * proves the constant is the same, not that the two sets are. */
  resetBeltAssets();
  installBeltAssets(glbMesh(FILE).geometry);
  const belt = buildBelt();

  const heroKeys = new Set();
  for (let i = 0; i < belt.count; i++) {
    if (belt.mesh[i] === belt.heroMesh) {
      heroKeys.add(`${belt.trueX[i]},${belt.trueY[i]},${belt.trueZ[i]}`);
      assert.ok(belt.radius[i] >= HERO_RADIUS,
        `rock ${i} is ${belt.radius[i].toFixed(1)} m and is in the hero bucket`);
    } else {
      assert.ok(belt.radius[i] < HERO_RADIUS,
        `rock ${i} is ${belt.radius[i].toFixed(1)} m and is NOT in the hero bucket`);
    }
  }
  const colliderKeys = new Set(belt.colliderRocks.map((r) => `${r.x},${r.y},${r.z}`));
  assert.equal(heroKeys.size, colliderKeys.size,
    `${heroKeys.size} rocks draw at hero detail but ${colliderKeys.size} carry a collider`);
  for (const k of colliderKeys) assert.ok(heroKeys.has(k), `a collider rock at ${k} is not drawn at hero detail`);
  console.log(`   ${heroKeys.size} of ${belt.count} rocks are hero rocks, and they are the ${colliderKeys.size} you can hit`);
  belt.dispose();
  resetBeltAssets();
});

test('every instance has a slot, and no two rocks share one', () => {
  /* The bucketing is now two passes - a provisional shape from the PRNG, then
   * a re-label once the radii are known - and a slot handed out twice would
   * be one rock drawn on top of another with the other never drawn at all.
   * Silent, and invisible in a field of 260. */
  for (const withAsset of [false, true]) {
    resetBeltAssets();
    if (withAsset) installBeltAssets(glbMesh(FILE).geometry);
    const belt = buildBelt();
    const seen = belt.meshes.map(() => new Set());
    for (let i = 0; i < belt.count; i++) {
      const m = belt.mesh[i];
      assert.ok(m >= 0 && m < belt.meshes.length, `rock ${i} points at bucket ${m}`);
      assert.ok(!seen[m].has(belt.slot[i]), `bucket ${m} slot ${belt.slot[i]} is used twice`);
      assert.ok(belt.slot[i] < belt.meshes[m].count, `rock ${i} sits past the end of its bucket`);
      seen[m].add(belt.slot[i]);
    }
    for (let m = 0; m < belt.meshes.length; m++) {
      assert.equal(seen[m].size, belt.meshes[m].count,
        `bucket ${m} was allocated ${belt.meshes[m].count} instances but only ${seen[m].size} are filled`);
    }
    belt.dispose();
  }
  resetBeltAssets();
});

test('the belt material is white, so the tint is applied once and not squared', () => {
  /* The defect this pass found. `material.color * instanceColor` is what three
   * multiplies into `diffuseColor`, and both halves used to carry the spec's
   * tint - an albedo of 0x5d564e SQUARED, linear 0.0117 against the 0.108 the
   * tint names. Measured on the largest rock in the field at 900 m, the lit
   * facets read 4.5, 8.4 and 8.9 out of 255.
   *
   * Asserted on the material rather than on a screenshot because a screenshot
   * gate cannot run in `node --test`, and asserted together with the instance
   * colours so "white material" cannot be made to pass by also whitening the
   * instances, which would delete the field's colour variation instead. */
  resetBeltAssets();
  const belt = buildBelt();
  const mat = belt.meshes[0].material;
  assert.equal(mat.color.getHex(), 0xffffff,
    'the belt material must be white - the albedo rides on the per-instance colour');

  const colours = belt.meshes[0].instanceColor;
  assert.ok(colours, 'the belt lost its per-instance colour');
  let lo = Infinity, hi = 0;
  for (let i = 0; i < colours.count; i++) {
    const l = Math.max(colours.getX(i), colours.getY(i), colours.getZ(i));
    lo = Math.min(lo, l);
    hi = Math.max(hi, l);
  }
  /* The tint is 0x5d564e, linear ~0.108, scaled 0.72..1.27 and lerped towards
   * two other stones - so the brightest channel of any instance lives in a
   * band around it. A band, not a number: the point is that it is nowhere near
   * 1 (which would be an untinted white field) and nowhere near the 0.0117 the
   * squared albedo produced. */
  assert.ok(lo > 0.02 && hi < 0.55,
    `per-instance albedo runs ${lo.toFixed(4)}..${hi.toFixed(4)} - `
    + 'that is not a tinted rock field'
  );
  console.log(`   material #ffffff, per-instance albedo ${lo.toFixed(4)}..${hi.toFixed(4)} (linear)`);
  belt.dispose();
});

/* ------------------------------------------------------------------ */
/* The world around it                                                 */
/* ------------------------------------------------------------------ */

test('the loader degrades to null rather than throwing when nothing is installed', () => {
  resetBeltAssets();
  assert.equal(heroGeometry(), null,
    'heroGeometry() must return null, not throw - it is the arm the whole headless suite takes');
});

test('the belt is still the only asset space owns, and its bodies are untouched', () => {
  /* A cheap tripwire on the line this branch drew against `art-planets`:
   * nothing here may start shipping geometry for a BODY. Twelve of them, all
   * raw shader spheres, and an authored mesh cannot help a shader. */
  assert.equal(SPACE_BODIES.length, 12);
  for (const a of MANIFEST.assets) {
    assert.equal(a.id, 'reach-boulder',
      `public/assets/space declares '${a.id}' - open space owns one authored asset, the belt boulder`);
  }
});
