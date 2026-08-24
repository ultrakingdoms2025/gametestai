/**
 * The authored crowd assets, held to the contract the ship, hero and beast
 * assets are held to - plus the two that are specific to a crowd.
 *
 * ── What this file is defending ───────────────────────────────────────────
 *
 * A binary in a repository is a claim that somebody made it and that it still
 * says what the manifest says it says. Neither half survives on trust. The
 * ship tests established the shape - allow-listed licence, manifest byte count
 * against the file on disk, triangle count against the parsed scene, and a
 * re-run of the generator compared with `Buffer.equals`; `npc-assets.test.mjs`
 * added the licence ledger and both directions of the manifest's
 * cross-references; `beast-assets.test.mjs` added the weld-site gate. This
 * file follows all three.
 *
 * ── The first thing that is new here, and it is the whole perf argument ───
 *
 * **A part must merge into a geometry the crowd already draws.** The crowd is
 * six `InstancedMesh`es for about 180 people, and it must stay six. There is
 * no scene node to hang a part off - "a figure" is one index into all six
 * meshes - so the only two destinations that exist are the garment geometry
 * (`M.crowd`) and the skin geometry (`M.skin`), and the A/B at the bottom
 * asserts that installing the real committed `.glb` changes the triangle count
 * by exactly the authored triangles and changes nothing else.
 *
 * ── The second, which would be silent rather than expensive ───────────────
 *
 * **The attribute sets have to match.** `M.crowd` is built `vertexColors: true`
 * and `M.skin` is not, so a body part must carry a `color` attribute and a
 * skin part must carry none. `mergeGeometries` does not throw on a mismatch -
 * it returns `null`. A part in the wrong slot therefore takes out a whole body
 * variant, and the visible result is a plaza that quietly reverts to the old
 * mannequins with nothing in the console and no number moving anywhere. So the
 * bake is exercised through the SHIPPED `bakeCrowdPart`, not a copy of it, and
 * both slots are merged for real below.
 *
 * ── And one that is about drift rather than about cost ────────────────────
 *
 * The generator derives its anchors from `CROWD` in `StationKit.js` - the same
 * table `StationWorld` builds the figure from - so a joint edit that moves a
 * wrist moves the hand with it. That is only true while the derivation is what
 * it claims to be, so the derivation is asserted here against the table: the
 * lesson `make-ship-glb.mjs` paid for when asserting two of a plan's fields
 * let a 0.40 m divergence ship unnoticed.
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
  CROWD_PART_KEYS, CROWD_SLOTS, crowdParts, crowdSets,
  bakeCrowdPart, installCrowdAssets, resetCrowdAssets,
} from '../../src/worlds/station/CrowdAssets.js';
import { CROWD, crowdWrist, crowdSeatedWrist, crowdFore } from '../../src/worlds/station/StationKit.js';
import { SLOT, WELDABLE, TRI_BUDGET, SET_PARTS, PART_BINDING, HAIR_CAP } from '../make-crowd-glb.mjs';
import { StationWorld } from '../../src/worlds/StationWorld.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'public/assets/station');
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

function accessorArray(json, bin, index, Ctor) {
  const acc = json.accessors[index];
  const view = json.bufferViews[acc.bufferView];
  return new Ctor(bin.buffer.slice(
    bin.byteOffset + view.byteOffset,
    bin.byteOffset + view.byteOffset + view.byteLength
  ));
}

/** { partName -> {tris, verts, positions, indices, min, max} } from the file. */
function glbParts(file) {
  const { json, bin } = readGlb(file);
  const out = {};
  for (const mesh of json.meshes) {
    const prim = mesh.primitives[0];
    const idx = json.accessors[prim.indices];
    const pos = json.accessors[prim.attributes.POSITION];
    out[mesh.name] = {
      tris: idx.count / 3,
      verts: pos.count,
      positions: accessorArray(json, bin, prim.attributes.POSITION, Float32Array),
      normals: accessorArray(json, bin, prim.attributes.NORMAL, Float32Array),
      uvs: accessorArray(json, bin, prim.attributes.TEXCOORD_0, Float32Array),
      /* The REAL indices, not a fabricated identity list. The merge tests below
       * build the crowd's geometry out of these buffers, so a synthetic index
       * would measure a triangle count this file invented rather than the one
       * the committed bytes carry. 5125 is UNSIGNED_INT, 5123 UNSIGNED_SHORT. */
      indices: idx.componentType === 5125
        ? accessorArray(json, bin, prim.indices, Uint32Array)
        : accessorArray(json, bin, prim.indices, Uint16Array),
      min: pos.min,
      max: pos.max,
    };
  }
  return out;
}

/** The committed .glb, rebuilt as real BufferGeometry and baked as shipped. */
function installFromDisk() {
  const assets = {};
  for (const entry of MANIFEST.assets) {
    const parts = glbParts(path.join(DIR, entry.file));
    const bag = {};
    for (const [key, p] of Object.entries(parts)) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(p.positions, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(p.normals, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(p.uvs, 2));
      g.setIndex(new THREE.BufferAttribute(p.indices, 1));
      /* The SHIPPED bake, not a copy - see the header. */
      bakeCrowdPart(g, MANIFEST.bind[key]);
      bag[key] = g;
    }
    assets[entry.id] = bag;
  }
  installCrowdAssets({ assets, sets: MANIFEST.sets, bind: MANIFEST.bind });
  return assets;
}

/* The crowd's geometry builders touch no instance state, so they can be driven
 * straight off the prototype - which is the only reason this pass is testable
 * headlessly at all. `Object.create` rather than `{}` so `_mergeCrowd` is
 * reachable from them. */
const figure = () => Object.create(StationWorld.prototype);

const triCount = (geo) => (geo.index ? geo.index.count : geo.getAttribute('position').count) / 3;

/** Every geometry the crowd builds, in the order `_buildCrowd` builds them. */
function buildCrowdGeometries() {
  const f = figure();
  return {
    body0: f._crowdBodyGeo(0),
    body1: f._crowdBodyGeo(1),
    body2: f._crowdBodyGeo(2),
    seated: f._crowdSeatedGeo(),
    head: f._crowdHeadGeo(),
    headSeated: f._crowdHeadGeo(CROWD.SEAT_HEAD_DY, CROWD.SEAT_HEAD_DZ, 'seated'),
  };
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
      ledger().includes(entry.id) && ledger().includes(`public/assets/station/${entry.file}`),
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

test('every set names an asset that exists and parts that asset has', () => {
  const byId = new Map(MANIFEST.assets.map((a) => [a.id, a]));
  for (const [set, spec] of Object.entries(MANIFEST.sets)) {
    const asset = byId.get(spec.asset);
    assert.ok(asset, `set '${set}' names asset '${spec.asset}', which is not declared`);
    for (const key of spec.parts) {
      assert.ok(asset.parts.includes(key),
        `set '${set}' shows part '${key}', which asset '${spec.asset}' does not contain`);
    }
  }
});

test('the part allow-list, the generator and the manifest agree', () => {
  const manifestParts = new Set(MANIFEST.assets.flatMap((a) => a.parts));
  assert.deepEqual([...manifestParts].sort(), [...CROWD_PART_KEYS].sort(),
    'CrowdAssets.CROWD_PART_KEYS and the manifest have drifted apart');
  for (const [set, parts] of Object.entries(SET_PARTS)) {
    const entry = MANIFEST.assets.find((a) => a.id === set);
    assert.ok(entry, `the generator writes a set '${set}' the manifest does not declare`);
    assert.deepEqual([...entry.parts].sort(), [...parts].sort(),
      `${set}: the generator's parts and the manifest's have drifted apart`);
  }
});

test('the slot vocabulary agrees across the generator, the loader and the manifest', () => {
  assert.deepEqual([...SLOT].sort(), [...CROWD_SLOTS].sort(),
    'make-crowd-glb.SLOT and CrowdAssets.CROWD_SLOTS have drifted apart');
  assert.deepEqual([...WELDABLE].sort(), [...CROWD_SLOTS].sort(),
    'the generator will write a slot the loader refuses, or the reverse');
  for (const [key, b] of Object.entries(MANIFEST.bind)) {
    assert.ok(CROWD_SLOTS.includes(b.slot), `manifest binds '${key}' to unknown slot '${b.slot}'`);
  }
});

test('both sets bind every part to the same slot, shade and uv', () => {
  /* The manifest carries ONE global `bind`, so a generator that gave a part a
   * different slot in one set than in the other would be honoured as whichever
   * the manifest happened to record - a hand that is skin when standing and
   * navy-blue garment when sitting on a bench, which is exactly the sort of
   * thing nobody looks at a bench closely enough to catch. */
  const sets = Object.keys(PART_BINDING);
  for (const key of CROWD_PART_KEYS) {
    const seen = sets.map((s) => JSON.stringify(PART_BINDING[s][key]));
    assert.equal(new Set(seen).size, 1,
      `part '${key}' is bound differently per set: ${seen.join(' vs ')}`);
    assert.deepEqual(PART_BINDING[sets[0]][key], MANIFEST.bind[key],
      `part '${key}': the generator's binding and the manifest's have drifted apart`);
  }
});

test('body parts carry a shade and skin parts do not', () => {
  for (const [key, b] of Object.entries(MANIFEST.bind)) {
    if (b.slot === 'body') {
      assert.ok(b.shade > 0,
        `body part '${key}' has no shade - M.crowd reads vertex colours and would draw it black`);
    } else {
      assert.equal(b.shade, undefined,
        `skin part '${key}' declares a shade - M.skin has no vertexColors to read it`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* The derivation: authored parts land on the crowd's own joints        */
/* ------------------------------------------------------------------ */

/** Bounding box of one part, straight out of the committed bytes. */
function bbox(part) {
  const p = part.positions;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      if (p[i + c] < min[c]) min[c] = p[i + c];
      if (p[i + c] > max[c]) max[c] = p[i + c];
    }
  }
  return { min, max };
}

test('standing: the hands sit on the wrists the arm table derives', () => {
  const parts = glbParts(path.join(DIR, 'standing.glb'));
  const b = bbox(parts.hand);
  for (const s of [-1, 1]) {
    const [wx, wy] = crowdWrist(s);
    /* The pair is one mesh, so the test can only check that the mesh SPANS
     * both wrists - which is the assertion that actually matters, because the
     * failure it guards is a mirrored pair landing on one side. */
    assert.ok(b.min[0] <= wx + 0.06 && b.max[0] >= wx - 0.06,
      `hand mesh spans x ${b.min[0].toFixed(3)}..${b.max[0].toFixed(3)}, which does not reach the ${s > 0 ? 'right' : 'left'} wrist at ${wx.toFixed(3)}`);
    assert.ok(b.min[1] <= wy + 0.09 && b.max[1] >= wy - 0.12,
      `hand mesh spans y ${b.min[1].toFixed(3)}..${b.max[1].toFixed(3)}, which does not reach the wrist at ${wy.toFixed(3)}`);
  }
  /* And that it is a PAIR, not one hand: the x span has to straddle zero. */
  assert.ok(b.min[0] < 0 && b.max[0] > 0,
    'the hand mesh is entirely on one side of the centreline - the pair collapsed');
});

test('seated: the hands sit on the seated wrists, which are NOT the standing ones', () => {
  const parts = glbParts(path.join(DIR, 'seated.glb'));
  const b = bbox(parts.hand);
  const [, sy, sz] = crowdSeatedWrist(1);
  assert.ok(b.min[1] <= sy + 0.09 && b.max[1] >= sy - 0.12,
    `seated hand y ${b.min[1].toFixed(3)}..${b.max[1].toFixed(3)} does not reach ${sy.toFixed(3)}`);
  assert.ok(b.min[2] <= sz + 0.09 && b.max[2] >= sz - 0.12,
    `seated hand z ${b.min[2].toFixed(3)}..${b.max[2].toFixed(3)} does not reach ${sz.toFixed(3)}`);
  /* Distance in THREE dimensions, not in y.
   *
   * The two wrists are only 4.9 cm apart vertically - a seated forearm raked
   * onto a thigh happens to end at almost the height a standing one hangs to -
   * and a y-only guard fails on a derivation that is perfectly correct. What
   * actually separates them is z: 18 cm forward, onto the knee. Recorded
   * because the first version of this assertion was the y one and it was
   * wrong in exactly the way a gate must not be. */
  const stand = crowdWrist(1);
  const seated = crowdSeatedWrist(1);
  const apart = Math.hypot(stand[0] - seated[0], stand[1] - seated[1], stand[2] - seated[2]);
  assert.ok(apart > 0.1,
    `the seated wrist is ${apart.toFixed(3)} m from the standing one - the pose is being ignored`);
});

test('the hair caps the head, and moves with it on the seated variant', () => {
  const stand = bbox(glbParts(path.join(DIR, 'standing.glb')).hair);
  const seat = bbox(glbParts(path.join(DIR, 'seated.glb')).hair);
  const crown = CROWD.HEAD_Y + CROWD.HEAD_R * CROWD.HEAD_SY;
  assert.ok(stand.max[1] > crown - 0.02 && stand.max[1] < crown + 0.05,
    `hair tops out at ${stand.max[1].toFixed(3)}, the crown is ${crown.toFixed(3)}`);
  assert.ok(Math.abs((seat.max[1] - stand.max[1]) - CROWD.SEAT_HEAD_DY) < 1e-3,
    'the seated hair did not move with the seated head');
});

test('the hair cap clears the skull BETWEEN its vertices, not just at them', () => {
  /* The defect this pins, which only a screenshot found and only arithmetic
   * can prevent coming back.
   *
   * The cap's vertices sat 4.5% off a 105 mm skull, which reads as ample. But
   * the cap is EIGHT segments around and a chord of an eight-segment circle
   * lies `1 - cos(pi/8)` = 7.6% of the radius inside the arc its vertices are
   * on - so every flat facet dipped BELOW the smooth twelve-segment head
   * underneath it and the skin striped through the hair in eight bright
   * wedges. In the source it is two numbers that both look reasonable; in the
   * shot it is a black-and-tan striped helmet.
   *
   * The relation, not the constants: raising the segment count or lowering the
   * clearance is fine, doing either alone is not. */
  const sag = 1 - Math.cos(Math.PI / HAIR_CAP.segments);
  const clearance = HAIR_CAP.grow - 1;
  assert.ok(clearance > sag + 0.02,
    `hair cap clearance is ${(clearance * 100).toFixed(1)}% and its facets sag ${(sag * 100).toFixed(1)}% - `
    + 'the skull will stripe through the hair between the cap\'s vertices');

  /* And the empirical half: the cap's own crown really is outside the head. */
  const hair = glbParts(path.join(DIR, 'standing.glb')).hair;
  const crown = CROWD.HEAD_Y + CROWD.HEAD_R * CROWD.HEAD_SY;
  const top = Math.max(...Array.from({ length: hair.positions.length / 3 }, (_, i) => hair.positions[i * 3 + 1]));
  assert.ok(top > crown + CROWD.HEAD_R * CROWD.HEAD_SY * sag,
    `the hair tops out at ${top.toFixed(4)}, which does not clear the crown at ${crown.toFixed(4)} by the facet sag`);
});

test('the shoes sit on the feet, and honour the asymmetric stance', () => {
  const parts = glbParts(path.join(DIR, 'standing.glb'));
  const p = parts.shoe.positions;
  /* Split the mesh by side and read each half's z centre, because the whole
   * point of `crowdFore` is that the two are DIFFERENT. A mirrored pair would
   * make these identical, which is a 16 cm error nobody sees in a wide shot. */
  const zByside = { '-1': [Infinity, -Infinity], 1: [Infinity, -Infinity] };
  for (let i = 0; i < p.length; i += 3) {
    const s = p[i] < 0 ? '-1' : 1;
    if (p[i + 2] < zByside[s][0]) zByside[s][0] = p[i + 2];
    if (p[i + 2] > zByside[s][1]) zByside[s][1] = p[i + 2];
  }
  const mid = (s) => (zByside[s][0] + zByside[s][1]) / 2;
  const want = (side) => crowdFore(side) + CROWD.FOOT_DZ;
  assert.ok(Math.abs(mid(1) - want(1)) < 0.05,
    `right shoe centres at z ${mid(1).toFixed(3)}, the right foot is at ${want(1).toFixed(3)}`);
  assert.ok(Math.abs(mid('-1') - want(-1)) < 0.05,
    `left shoe centres at z ${mid('-1').toFixed(3)}, the left foot is at ${want(-1).toFixed(3)}`);
  assert.ok(Math.abs(mid(1) - mid('-1')) > 0.1,
    'both shoes are at the same z - the pair was mirrored and the stance was lost');
});

/* ------------------------------------------------------------------ */
/* THE BUDGET A/B - the assertion the whole design exists for           */
/* ------------------------------------------------------------------ */

test('installing the authored crowd costs triangles and NOTHING else', () => {
  resetCrowdAssets();
  const before = buildCrowdGeometries();
  const beforeTris = Object.fromEntries(Object.entries(before).map(([k, g]) => [k, triCount(g)]));
  const beforeAttrs = Object.fromEntries(
    Object.entries(before).map(([k, g]) => [k, Object.keys(g.attributes).sort().join(',')])
  );

  installFromDisk();
  const after = buildCrowdGeometries();

  try {
    /* 1. Still ONE geometry per mesh. The crowd is six draw calls and every
     *    one of these is exactly one of them; a null here would be the merge
     *    having silently refused, which reverts a whole variant. */
    for (const [k, g] of Object.entries(after)) {
      assert.ok(g && g.isBufferGeometry, `${k}: the merge returned nothing with the assets installed`);
    }

    /* 2. The same attribute set. A body part that arrived without a colour
     *    attribute, or a skin part that arrived with one, changes this - and
     *    changing it is what makes `mergeGeometries` return null. */
    for (const [k, g] of Object.entries(after)) {
      assert.equal(Object.keys(g.attributes).sort().join(','), beforeAttrs[k],
        `${k}: the authored parts changed the attribute set`);
    }

    /* 3. The triangle delta is EXACTLY the authored triangles for that slot,
     *    and not one more. This is the number Phase 9 is gated on. */
    const authored = {
      standing: glbParts(path.join(DIR, 'standing.glb')),
      seated: glbParts(path.join(DIR, 'seated.glb')),
    };
    const expect = (set, slot) => Object.entries(authored[set])
      .filter(([key]) => MANIFEST.bind[key].slot === slot)
      .reduce((n, [, p]) => n + p.tris, 0);

    const want = {
      body0: expect('standing', 'body'),
      body1: expect('standing', 'body'),
      body2: expect('standing', 'body'),
      seated: expect('seated', 'body'),
      head: expect('standing', 'skin'),
      headSeated: expect('seated', 'skin'),
    };
    for (const [k, g] of Object.entries(after)) {
      assert.equal(triCount(g) - beforeTris[k], want[k],
        `${k}: expected +${want[k]} triangles from the authored parts, got +${triCount(g) - beforeTris[k]}`);
    }

    /* 4. Every authored triangle actually landed somewhere. Sum both slots
     *    across both sets against the manifest's own totals, so a part that
     *    was dropped by the allow-list cannot pass as "nothing to add". */
    const totalAuthored = MANIFEST.assets.reduce((n, a) => n + a.tris, 0);
    const landedPerFigure = want.body0 + want.head + want.seated + want.headSeated;
    assert.equal(landedPerFigure, totalAuthored,
      'some authored triangles are in neither slot - a part is being silently dropped');
  } finally {
    resetCrowdAssets();
  }
});

test('with no assets installed the crowd is exactly the procedural figure', () => {
  resetCrowdAssets();
  assert.equal(crowdParts('standing'), null, 'crowdParts must return null before anything loads');
  assert.deepEqual(crowdSets(), [], 'crowdSets must be empty before anything loads');
  const g = buildCrowdGeometries();
  for (const [k, geo] of Object.entries(g)) {
    assert.ok(geo && geo.isBufferGeometry, `${k}: the procedural merge failed`);
  }
  /* The counts every other test in this suite has always measured. A 404 on a
   * phone must land here, not on a plaza with no people in it. */
  assert.equal(triCount(g.body0), 524);
  assert.equal(triCount(g.head), 260);
});

test('a part bound to an unknown slot is refused, not guessed at', () => {
  resetCrowdAssets();
  const warn = console.warn;
  const said = [];
  console.warn = (m) => said.push(String(m));
  try {
    installCrowdAssets({
      assets: { standing: { hair: new THREE.BufferGeometry() } },
      sets: { standing: { asset: 'standing', parts: ['hair'] } },
      bind: { hair: { slot: 'hat', shade: 0.26, uv: 2 } },
    });
    const got = crowdParts('standing');
    assert.equal(got, null, "a part in slot 'hat' must not be merged into anything");
  } finally {
    console.warn = warn;
    resetCrowdAssets();
  }
});

/* ------------------------------------------------------------------ */
/* Byte-diff: the committed file IS what the generator writes           */
/* ------------------------------------------------------------------ */

test('re-running the generator reproduces both files byte for byte', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'crowd-glb-'));
  try {
    for (const entry of MANIFEST.assets) {
      const out = path.join(dir, entry.file);
      execFileSync(process.execPath, [path.join(ROOT, 'scripts/make-crowd-glb.mjs')], {
        env: { ...process.env, CROWD_GLB_SET: entry.id, CROWD_GLB_OUT: out },
        stdio: 'pipe',
      });
      assert.ok(
        readFileSync(out).equals(readFileSync(path.join(DIR, entry.file))),
        `${entry.file} on disk is not what scripts/make-crowd-glb.mjs writes today`
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
