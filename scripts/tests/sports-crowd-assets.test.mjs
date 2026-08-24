/**
 * The authored sports-crowd assets, held to the contract the ship, hero, beast,
 * station-crowd and yard assets are held to - plus the three that are specific
 * to this world.
 *
 * ── What this file is defending ───────────────────────────────────────────
 *
 * A binary in a repository is a claim that somebody made it and that it still
 * says what the manifest says it says. Neither half survives on trust. The
 * ship tests established the shape - allow-listed licence, manifest byte count
 * against the file on disk, triangle count against the parsed scene, and a
 * re-run of the generator compared with `Buffer.equals`; `npc-assets` added
 * the licence ledger and both directions of the manifest's cross-references;
 * `crowd-assets` added the merge A/B. This file follows all three.
 *
 * ── The first thing that is new here: the budget is a NET number ──────────
 *
 * Every other authored asset in this repository costs triangles and gives
 * nothing back. This one does both: the shoe covers a leg's end face and the
 * hand covers a sleeve's, so `crowdFigure` builds those limbs `openEnded` and
 * returns twelve triangles per limb. The A/B below therefore asserts the delta
 * against `authored - 12 * sparedLimbs`, computed from the kit, rather than
 * against the authored count. An assertion of `+authored` would pass while the
 * saving silently stopped happening.
 *
 * ── The second: an open end that nothing covers is a HOLE ─────────────────
 *
 * The saving is gated on the authored part having actually landed. With no
 * assets installed - a 404, a phone that lost the connection, a headless test -
 * every limb must keep its caps, because an open-ended leg with no shoe on it
 * is a hollow tube and a graceful degradation that degrades to a hole is not
 * one. That is asserted as a triangle count in both states.
 *
 * ── The third: which end of a limb is the far end ─────────────────────────
 *
 * `carry`'s left arm was `rz: 0.9`, which put its -Y end at the CENTRE OF THE
 * CHEST and its +Y end 44 cm out at shoulder height - a salute, on nineteen
 * figures, and an arm whose hand end is not the end every other arm's is. The
 * generator hangs a hand on the -Y end, so left alone it would have put a hand
 * in an armpit. The invariant is now a test: for every arm and every leg in
 * every pose, the -Y end must be FURTHER from the head than the +Y end.
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
  SPORTS_CROWD_PART_KEYS, SPORTS_CROWD_SLOTS, sportsCrowdParts, sportsCrowdSets,
  sportsCrowdHas, bakeSportsCrowdPart, installSportsCrowdAssets, resetSportsCrowdAssets,
} from '../../src/worlds/sports/SportsCrowdAssets.js';
import {
  POSES, POSE_KEYS, BAND, LIMB_SEGMENTS, place, limbEnd, specOf, headOf,
} from '../../src/worlds/sports/CrowdKit.js';
import { SLOT, TRI_BUDGET, SET_PARTS, PART_BINDING, HAIR_CAP, SPARED } from '../make-sports-crowd-glb.mjs';
import { crowdFigure } from '../../src/worlds/SportsWorld.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'public/assets/sports');
const MANIFEST = JSON.parse(readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));

/** Licences an asset in this repository may carry. Same list as the maze's. */
const LICENCES = ['generated', 'CC0-1.0', 'CC-BY-4.0', 'proprietary-owned'];

/**
 * The measured population, per pose.
 *
 * Not an estimate. `world-shot.mjs` with this world's materials named reports
 * `byMaterial` for `sports.crowd.cloth` at 88,908 triangles and
 * `sports.crowd.skin` at 60,632 on the pre-pass tree; skin was a flat 104
 * triangles a figure at every pose, so 60,632/104 = 583 figures, and the five
 * per-pose cloth counts (120, 120, 132, 168, 168) resolve that total to
 * exactly one set of counts. They are here because every triangle number in
 * the branch ledger is one of these multiplied by a per-figure count, and a
 * guess would make the whole budget table fiction.
 */
const POPULATION = Object.freeze({ stand: 132, sit: 382, lean: 42, carry: 19, crouch: 8 });

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

/** { partName -> {tris, verts, positions, normals, uvs, indices} } from the file. */
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
      /* The REAL indices, not a fabricated identity list: the merge tests below
       * build the crowd's geometry out of these buffers, so a synthetic index
       * would measure a triangle count this file invented. 5125 is
       * UNSIGNED_INT, 5123 UNSIGNED_SHORT. */
      indices: idx.componentType === 5125
        ? accessorArray(json, bin, prim.indices, Uint32Array)
        : accessorArray(json, bin, prim.indices, Uint16Array),
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
      /* The SHIPPED bake, not a copy - see the loader's header. */
      bakeSportsCrowdPart(g, MANIFEST.bind[key]);
      bag[key] = g;
    }
    assets[entry.id] = bag;
  }
  installSportsCrowdAssets({ assets, sets: MANIFEST.sets, bind: MANIFEST.bind });
  return assets;
}

const triCount = (geo) => (geo.index ? geo.index.count : geo.getAttribute('position').count) / 3;

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
    const l = ledger();
    assert.ok(
      l.includes(`\`crowd-${entry.id}\``) && l.includes(`public/assets/sports/${entry.file}`),
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
    assert.ok(tris <= TRI_BUDGET, `${entry.id} is ${tris} tris, over the ${TRI_BUDGET} reservation`);
  });

  test(`${entry.id}: every normal in the committed bytes is unit length`, () => {
    /* `art-citadel` dissolved a gatehouse into a white cloud because a
     * degenerate quad produced a ZERO-LENGTH normal: finite, valid glTF, and
     * NaN the instant a shader normalizes it. The generator refuses to write
     * one; this asserts the same thing about the bytes that are actually
     * committed, which is the only half of the pair that can see a file
     * written before the gate existed. */
    for (const [key, p] of Object.entries(glbParts(path.join(DIR, entry.file)))) {
      for (let i = 0; i < p.normals.length; i += 3) {
        const l = Math.hypot(p.normals[i], p.normals[i + 1], p.normals[i + 2]);
        assert.ok(Math.abs(l - 1) < 1e-3,
          `${entry.id}/${key}: normal ${i / 3} has length ${l} - it will NaN the moment a shader normalizes it`);
      }
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

test('there is one set per pose, and the poses are the kit\'s', () => {
  assert.deepEqual(Object.keys(MANIFEST.sets).sort(), [...POSE_KEYS].sort(),
    'the manifest and CrowdKit.POSE_KEYS have drifted apart - a pose with no asset is a bald pose');
  assert.deepEqual(Object.keys(SET_PARTS).sort(), [...POSE_KEYS].sort());
  assert.deepEqual(Object.keys(POPULATION).sort(), [...POSE_KEYS].sort());
});

test('the part allow-list, the generator and the manifest agree', () => {
  const manifestParts = new Set(MANIFEST.assets.flatMap((a) => a.parts));
  assert.deepEqual([...manifestParts].sort(), [...SPORTS_CROWD_PART_KEYS].sort(),
    'SportsCrowdAssets.SPORTS_CROWD_PART_KEYS and the manifest have drifted apart');
  for (const [set, parts] of Object.entries(SET_PARTS)) {
    const entry = MANIFEST.assets.find((a) => a.id === set);
    assert.ok(entry, `the generator writes a set '${set}' the manifest does not declare`);
    assert.deepEqual([...entry.parts].sort(), [...parts].sort(),
      `${set}: the generator's parts and the manifest's have drifted apart`);
  }
});

test('the slot vocabulary agrees across the generator, the loader and the manifest', () => {
  assert.deepEqual([...SLOT].sort(), [...SPORTS_CROWD_SLOTS].sort(),
    'make-sports-crowd-glb.SLOT and SportsCrowdAssets.SPORTS_CROWD_SLOTS have drifted apart');
  for (const [key, b] of Object.entries(MANIFEST.bind)) {
    assert.ok(SPORTS_CROWD_SLOTS.includes(b.slot), `manifest binds '${key}' to unknown slot '${b.slot}'`);
    assert.deepEqual(PART_BINDING[key], b,
      `part '${key}': the generator's binding and the manifest's have drifted apart`);
  }
});

test('EVERY part carries a shade, because both crowd materials read vertex colours', () => {
  /* The one place this world differs from the station's, and the difference is
   * silent in the wrong direction. `M.skin` there is not `vertexColors`, so a
   * skin part must carry no colour; BOTH materials here are, so a part with no
   * colour attribute is drawn against the generic vertex-attribute default of
   * (0,0,0) - pure black hands. `whiteColor()` in SportsWorld.js records that
   * exact bug having already shipped once on this crowd. */
  for (const [key, b] of Object.entries(MANIFEST.bind)) {
    assert.ok(b.shade > 0, `part '${key}' has no shade - it would be drawn black`);
  }
});

/* ------------------------------------------------------------------ */
/* The derivation: authored parts land on the crowd's own joints        */
/* ------------------------------------------------------------------ */

test('the -Y end of every arm and leg is the end FURTHEST from the head', () => {
  /* The invariant `carry`'s salute broke, and the reason it is a test.
   *
   * The generator hangs a hand on `place(arm, [0, -len/2 - d, 0])` and a shoe
   * on `place(leg, [0, -len/2, 0])`. That is only the hand and the foot while
   * the -Y end is the end pointing AWAY from the body. `carry`'s left arm was
   * rotated 0.9 rad, which put its -Y end at the centre of the chest - so the
   * derivation would have welded a hand into an armpit and nothing anywhere
   * would have said so. */
  for (const pose of POSE_KEYS) {
    const h = headOf(pose).at;
    const d = (p) => Math.hypot(p[0] - h[0], p[1] - h[1], p[2] - h[2]);
    for (const side of [-1, 1]) {
      for (const role of ['arm', 'leg']) {
        const s = specOf(pose, role, side);
        assert.ok(s, `${pose}: no ${role} on side ${side}`);
        assert.ok(d(limbEnd(s, -1)) > d(limbEnd(s, 1)),
          `${pose}/${role}/${side}: the -Y end is CLOSER to the head than the +Y end - `
          + 'the generator will put the hand or the shoe at the shoulder or the hip');
      }
    }
  }
});

for (const pose of POSE_KEYS) {
  test(`${pose}: the hands sit on the wrists the arm table derives`, () => {
    const parts = glbParts(path.join(DIR, `crowd-${pose}.glb`));
    const b = bbox(parts.hand);
    for (const side of [-1, 1]) {
      const arm = specOf(pose, 'arm', side);
      const w = place(arm, [0, -arm.len / 2, 0]);
      /* The pair is one mesh, so the test can only check that the mesh SPANS
       * both wrists - which is the assertion that matters, because the failure
       * it guards is a mirrored pair landing on one side. */
      for (const c of [0, 1, 2]) {
        assert.ok(b.min[c] <= w[c] + 0.09 && b.max[c] >= w[c] - 0.13,
          `${pose}: hand mesh spans ${'xyz'[c]} ${b.min[c].toFixed(3)}..${b.max[c].toFixed(3)}, `
          + `which does not reach the ${side > 0 ? 'right' : 'left'} wrist at ${w[c].toFixed(3)}`);
      }
    }
    assert.ok(b.min[0] < 0 && b.max[0] > 0,
      `${pose}: the hand mesh is entirely on one side of the centreline - the pair collapsed`);
  });

  test(`${pose}: the shoes cover the leg's end face, which is what lets it open`, () => {
    /* Not "the shoe is near the ankle" - "the shoe is WIDER than the hexagon
     * it is covering". The leg is built `openEnded` only because this is true;
     * a shoe narrower than the leg would leave a hole in the sole and the only
     * symptom would be a dark spot at ground level in a wide shot. */
    const parts = glbParts(path.join(DIR, `crowd-${pose}.glb`));
    const p = parts.shoe.positions;
    for (const side of [-1, 1]) {
      const leg = specOf(pose, 'leg', side);
      const a = place(leg, [0, -leg.len / 2, 0]);
      /* Flat-to-flat width of a LIMB_SEGMENTS-gon of radius r1. */
      const flat = 2 * leg.r1 * Math.cos(Math.PI / LIMB_SEGMENTS);
      /* Split by which ankle a vertex is NEARER, not by the sign of its x.
       * A box has exactly two distinct x values, and `lean`'s left ankle is at
       * x -0.089 with a 0.19 m shoe on it, so one of that shoe's two x values
       * is on the far side of the centreline - a sign test throws it away and
       * then reports the surviving one as a shoe zero metres wide. The first
       * version of this assertion did exactly that and failed a derivation
       * that was perfectly correct. */
      const other = place(specOf(pose, 'leg', -side), [0, -leg.len / 2, 0]);
      const mine = place(leg, [0, -leg.len / 2, 0]);
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, top = -Infinity;
      for (let i = 0; i < p.length; i += 3) {
        if (Math.abs(p[i] - mine[0]) > Math.abs(p[i] - other[0])) continue;
        if (p[i] < minX) minX = p[i];
        if (p[i] > maxX) maxX = p[i];
        if (p[i + 2] < minZ) minZ = p[i + 2];
        if (p[i + 2] > maxZ) maxZ = p[i + 2];
        if (p[i + 1] > top) top = p[i + 1];
      }
      assert.ok(maxX - minX >= flat,
        `${pose}/${side}: the shoe is ${(maxX - minX).toFixed(3)} m wide and the leg's end face is `
        + `${flat.toFixed(3)} m across - the open end would show`);
      assert.ok(minX <= a[0] - flat / 2 + 1e-6 && maxX >= a[0] + flat / 2 - 1e-6,
        `${pose}/${side}: the shoe does not straddle the ankle at x ${a[0].toFixed(3)}`);
      assert.ok(minZ <= a[2] && maxZ >= a[2],
        `${pose}/${side}: the shoe does not straddle the ankle at z ${a[2].toFixed(3)}`);
      assert.ok(top > a[1], `${pose}/${side}: the shoe's top is below the ankle - it is buried in the ground`);
      /* And it has a TOE: the mass projects forward past the ankle, which is
       * the whole read a single box is bought for. */
      assert.ok(maxZ - a[2] > (a[2] - minZ) * 1.3,
        `${pose}/${side}: the shoe is symmetric about the ankle - it has no toe overhang`);
    }
  });

  test(`${pose}: the hair caps that pose's own head`, () => {
    const h = headOf(pose);
    const b = bbox(glbParts(path.join(DIR, `crowd-${pose}.glb`)).hair);
    const crown = h.at[1] + h.r;
    assert.ok(b.max[1] > crown, `${pose}: hair tops out at ${b.max[1].toFixed(3)}, under the crown at ${crown.toFixed(3)}`);
    assert.ok(b.max[1] < crown + h.r * 0.4, `${pose}: hair floats ${(b.max[1] - crown).toFixed(3)} m over the crown`);
    /* And it is over THIS pose's head, not the standing one's - the seated and
     * crouching heads are 50-56 cm lower and 6 cm back. */
    const cx = (b.min[0] + b.max[0]) / 2;
    assert.ok(Math.abs(cx - h.at[0]) < 0.05,
      `${pose}: hair centres at x ${cx.toFixed(3)}, the head is at ${h.at[0].toFixed(3)}`);
  });
}

test('the hair cap clears the skull BETWEEN its vertices, not just at them', () => {
  /* The defect only a screenshot found on the station and only arithmetic can
   * prevent coming back here.
   *
   * The cap is 8 segments round and so is the head, and both start at phi 0,
   * so there is no sag in AZIMUTH. In THETA there is: the cap covers
   * `sweep * PI` in `rings` rings, so each ring spans `sweep * PI / rings` and
   * its chord lies `1 - cos(half)` of the radius inside the arc its vertices
   * are on. Below that clearance the skin stripes through the hair in bands -
   * two numbers that both look reasonable in source and a striped helmet in a
   * shot.
   *
   * The relation, not the constants: raising `rings` or lowering `grow` is
   * fine, doing either alone is not. */
  const half = (Math.PI * HAIR_CAP.sweep) / HAIR_CAP.rings / 2;
  const sag = 1 - Math.cos(half);
  const clearance = HAIR_CAP.grow - 1;
  assert.ok(clearance > sag + 0.02,
    `hair cap clearance is ${(clearance * 100).toFixed(1)}% and its facets sag ${(sag * 100).toFixed(1)}% - `
    + 'the skull will stripe through the hair between the cap\'s rings');
  assert.equal(HAIR_CAP.segments, POSES.stand.head.wseg,
    'the cap and the head no longer have the same number of segments, so they no longer agree in azimuth '
    + 'either - recompute the azimuthal sag before changing this');
});

test('the kit bag is a bag, not a plank across the hips', () => {
  /* The regression gate on the defect this pass found. The bag was
   * `BoxGeometry(0.5, 0.24, 0.22)` - half a metre wide along X on a figure
   * 0.44 m across, so it stuck 33 cm past one shoulder and reached the far
   * hip. A bag worn across the body is DEEPER than it is wide and narrower
   * than the person carrying it. */
  const bag = POSES.carry.bag;
  assert.ok(bag, 'the carry pose lost its bag');
  const [w, hgt, d] = bag.body.size;
  const shoulders = 2 * POSES.carry.cloth.find((s) => s.role === 'torso').r0;
  assert.ok(w < shoulders * 0.75,
    `the bag is ${w} m wide against ${shoulders.toFixed(3)} m of shoulder - it is a plank again`);
  assert.ok(hgt > w, 'the bag is wider than it is tall - it is lying across the hips');
  assert.ok(bag.straps.length >= 1, 'the bag has no strap, so nothing holds it on');
  assert.ok(d < w * 1.2 && d > w * 0.4, 'the bag has lost its proportions');
});

/* ------------------------------------------------------------------ */
/* THE BUDGET A/B - the assertion the whole design exists for           */
/* ------------------------------------------------------------------ */

/** Twelve triangles per end cap; `openEnded` removes both. */
const CAP_TRIS = 2 * LIMB_SEGMENTS;

/** How many triangles a pose gives back when its authored parts land. */
function sparedTris(pose) {
  let n = 0;
  for (const s of POSES[pose].cloth) {
    if (s.open && SPARED[pose].includes(s.role)) n += CAP_TRIS;
  }
  return n;
}

test('SPARED and the kit\'s own `open` flags describe the same limbs', () => {
  for (const pose of POSE_KEYS) {
    const open = [...new Set(POSES[pose].cloth.filter((s) => s.open).map((s) => s.role))].sort();
    assert.deepEqual(open, [...SPARED[pose]].sort(),
      `${pose}: the generator's SPARED table and the kit's 'open' flags disagree - `
      + 'one of them is describing a limb that will be built with a hole in it');
  }
});

test('installing the authored crowd costs triangles NET of the caps it spares, and nothing else', () => {
  resetSportsCrowdAssets();
  const before = Object.fromEntries(POSE_KEYS.map((p) => [p, crowdFigure(p)]));
  const beforeTris = Object.fromEntries(
    Object.entries(before).map(([k, g]) => [k, { cloth: triCount(g.cloth), skin: triCount(g.skin) }])
  );
  const beforeAttrs = Object.fromEntries(
    Object.entries(before).map(([k, g]) => [k, {
      cloth: Object.keys(g.cloth.attributes).sort().join(','),
      skin: Object.keys(g.skin.attributes).sort().join(','),
    }])
  );

  installFromDisk();
  const after = Object.fromEntries(POSE_KEYS.map((p) => [p, crowdFigure(p)]));

  try {
    for (const pose of POSE_KEYS) {
      /* 1. Still ONE geometry per surface. A null here would be the merge
       *    having silently refused, which reverts a whole pose. */
      assert.ok(after[pose].cloth?.isBufferGeometry, `${pose}: the cloth merge returned nothing`);
      assert.ok(after[pose].skin?.isBufferGeometry, `${pose}: the skin merge returned nothing`);

      /* 2. The same attribute set. A part that arrived without a colour
       *    attribute changes this - and changing it is what makes
       *    `mergeGeometries` return null. */
      for (const slot of ['cloth', 'skin']) {
        assert.equal(Object.keys(after[pose][slot].attributes).sort().join(','), beforeAttrs[pose][slot],
          `${pose}/${slot}: the authored parts changed the attribute set`);
      }

      /* 3. The delta is EXACTLY the authored triangles for that slot, less the
       *    end caps those parts made unnecessary. This is the number Phase 9 is
       *    gated on, and asserting only `+authored` would let the saving stop
       *    happening in silence. */
      const parts = glbParts(path.join(DIR, `crowd-${pose}.glb`));
      const authoredIn = (slot) => Object.entries(parts)
        .filter(([key]) => MANIFEST.bind[key].slot === slot)
        .reduce((n, [, p]) => n + p.tris, 0);

      assert.equal(triCount(after[pose].cloth) - beforeTris[pose].cloth,
        authoredIn('cloth') - sparedTris(pose),
        `${pose}/cloth: expected +${authoredIn('cloth')} authored less ${sparedTris(pose)} spared caps`);
      assert.equal(triCount(after[pose].skin) - beforeTris[pose].skin, authoredIn('skin'),
        `${pose}/skin: expected +${authoredIn('skin')} from the authored hands`);
    }

    /* 4. The world total, which is the row in the branch ledger.
     *
     * `PROCEDURAL` and `INSTALLED` are the two states multiplied by the
     * measured population, and `WAS` is what the pre-pass tree drew - taken
     * off `byMaterial` in a real harness run, not computed here, so this
     * assertion compares an arithmetic model with a photographed measurement
     * rather than with itself. */
    let procedural = 0;
    let installed = 0;
    for (const pose of POSE_KEYS) {
      procedural += (beforeTris[pose].cloth + beforeTris[pose].skin) * POPULATION[pose];
      installed += (triCount(after[pose].cloth) + triCount(after[pose].skin)) * POPULATION[pose];
    }
    const WAS = 88908 + 60632; // sports.crowd.cloth + sports.crowd.skin, pre-pass harness run
    assert.equal(procedural, 142772,
      'the procedural fallback\'s world cost has moved - update the branch ledger');
    assert.equal(installed, 173312,
      'the installed crowd\'s world cost has moved - update the branch ledger\'s budget table');
    assert.equal(installed - procedural, 30540, 'the A/B delta has moved');
    assert.equal(installed - WAS, 23772,
      'the whole pass\'s net triangle cost against the pre-pass tree has moved - update the ledger');
    assert.ok(procedural < WAS,
      'the procedural fallback must be CHEAPER than the pre-pass figure: the open neck and the '
      + 'rebuilt bag are unconditional, so a player who never downloads the assets still gains');
  } finally {
    resetSportsCrowdAssets();
  }
});

test('with no assets installed every limb keeps its caps', () => {
  /* The gate on the hollow-tube failure. A 404 on a phone must land on a
   * figure that is merely bald, never on one with open pipes for legs. */
  resetSportsCrowdAssets();
  assert.equal(sportsCrowdParts('stand'), null, 'sportsCrowdParts must return null before anything loads');
  assert.deepEqual(sportsCrowdSets(), [], 'sportsCrowdSets must be empty before anything loads');
  for (const pose of POSE_KEYS) {
    assert.equal(sportsCrowdHas(pose, 'shoe'), false, `${pose}: sportsCrowdHas lied about a shoe`);
  }
  const g = crowdFigure('stand');
  /* Five limbs at 24 triangles each: the count every headless test in this
   * suite has always measured for a standing figure. */
  assert.equal(triCount(g.cloth), 5 * (2 * LIMB_SEGMENTS + 2 * LIMB_SEGMENTS));
  /* Head sphere 8x6 = 80, plus a NECK that is open at both ends under every
   * condition because both its caps are inside solids by construction. */
  assert.equal(triCount(g.skin), 80 + 12);
});

test('a part bound to an unknown slot is refused, not guessed at', () => {
  resetSportsCrowdAssets();
  const warn = console.warn;
  const said = [];
  console.warn = (m) => said.push(String(m));
  try {
    installSportsCrowdAssets({
      assets: { stand: { hair: new THREE.BufferGeometry() } },
      sets: { stand: { asset: 'stand', parts: ['hair'] } },
      bind: { hair: { slot: 'hat', shade: 0.22 } },
    });
    assert.equal(sportsCrowdParts('stand'), null, "a part in slot 'hat' must not be merged into anything");
  } finally {
    console.warn = warn;
    resetSportsCrowdAssets();
  }
});

test('the bake writes a constant colour at the manifest\'s shade', () => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  bakeSportsCrowdPart(g, { slot: 'cloth', shade: 0.22 });
  const c = g.getAttribute('color');
  assert.ok(c, 'no colour attribute - both crowd materials would draw this black');
  assert.equal(c.count, 3);
  assert.equal(c.itemSize, 3, 'the colour attribute is not RGB - mergeGeometries will refuse the whole pose');
  for (let i = 0; i < c.array.length; i++) {
    assert.ok(Math.abs(c.array[i] - 0.22) < 1e-7,
      `component ${i} is ${c.array[i]}, not the manifest's shade`);
  }
});

/* ------------------------------------------------------------------ */
/* The value bands                                                     */
/* ------------------------------------------------------------------ */

test('the figure has a value break at the waist, and it is not free-floating', () => {
  /* The change that costs nothing and does the most: trousers at 0.52 of the
   * instance's own coat colour. Asserted on the geometry rather than on the
   * constant, because a band that is declared and never written is exactly the
   * "invisible since the day it was written" shape `art-citadel` found. */
  resetSportsCrowdAssets();
  const g = crowdFigure('stand');
  const col = g.cloth.getAttribute('color');
  const seen = new Set();
  for (let i = 0; i < col.count; i++) seen.add(Number(col.getX(i).toFixed(4)));
  assert.ok(seen.has(Number(BAND.leg.toFixed(4))), 'no vertex carries the trouser band');
  assert.ok(seen.has(Number(BAND.torso.toFixed(4))), 'no vertex carries the torso band');
  assert.ok(seen.has(Number(BAND.arm.toFixed(4))), 'no vertex carries the sleeve band');
  assert.ok(BAND.leg < BAND.arm && BAND.arm <= BAND.torso,
    'the bands no longer descend from torso to sleeve to trouser');
});

/* ------------------------------------------------------------------ */
/* Byte-diff: the committed file IS what the generator writes           */
/* ------------------------------------------------------------------ */

test('re-running the generator reproduces all five files byte for byte', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sports-crowd-glb-'));
  try {
    for (const entry of MANIFEST.assets) {
      const out = path.join(dir, entry.file);
      execFileSync(process.execPath, [path.join(ROOT, 'scripts/make-sports-crowd-glb.mjs')], {
        env: { ...process.env, SPORTS_CROWD_GLB_SET: entry.id, SPORTS_CROWD_GLB_OUT: out },
        stdio: 'pipe',
      });
      assert.ok(
        readFileSync(out).equals(readFileSync(path.join(DIR, entry.file))),
        `${entry.file} is not what scripts/make-sports-crowd-glb.mjs writes today - `
        + 'regenerate it, or find out what changed in the kit'
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
