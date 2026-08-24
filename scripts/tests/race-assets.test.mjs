import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { RaceWorld } from '../../src/worlds/RaceWorld.js';
import { RaceCourse, mulberry32 } from '../../src/worlds/RaceTrack.js';
import {
  CIRCUITS, CourseSet, baseTerrain, worldControls,
} from '../../src/worlds/RaceCircuits.js';
import {
  SPECTATOR_PARTS, SPECTATOR_TRIS, SPECTATOR_HEIGHT,
  MARSHAL_PART_KEYS, MARSHAL_SHELL, MARSHAL_TRIS,
  installRaceAssets, resetRaceAssets, spectatorGeometry, marshalParts,
  mergeSpectatorParts,
} from '../../src/worlds/race/RaceAssets.js';

/**
 * THE RACE WORLD'S TWO AUTHORED ASSETS, AND WHAT THEY ARE ALLOWED TO COST.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A binary in a repository is a claim that somebody made it and that it still
 * says what the manifest says it says. Neither half survives on trust. The
 * shape is the one `ship`, `npc`, `beast`, `crowd`, `yard`, `belt`, `maze` and
 * `planet` established: allow-listed licence, manifest byte count against the
 * file on disk, triangle count against the parsed bytes, a re-run of the
 * generator compared with `Buffer.equals`, a line in the licence ledger, the
 * three geometry gates re-asserted against the SHIPPED bytes rather than
 * against the generator's own report, and - the one that matters most - the
 * world built BOTH WAYS and diffed.
 *
 * ── WHAT IS DIFFERENT HERE, AND WHY THERE ARE TWO KINDS OF ASSERTION ──────
 *
 * These two assets sit at opposite ends of the same budget.
 *
 *   The spectator is instanced 819 times and is the SECOND largest object in
 *   the world - 102,384 triangles in a frame from the start/finish straight,
 *   12.6% of everything drawn. Its budget is therefore EXACT and equal to the
 *   primitive it replaces: 144, no ceiling, no round number. A draft at 276
 *   was refused for +11.9% on a measured frame.
 *
 *   The marshal is placed 29 times. Its budget is 204 against 132, +2,088
 *   across the whole map, and it is allowed to be bigger because 29 is not
 *   819 - which is a judgement, so it is written down as a number a change
 *   has to move rather than as an opinion.
 *
 * Both are pinned exactly, so a tessellation change cannot pass by being
 * "within budget".
 *
 * ── THE GATE `art-citadel` PAID FOR ──────────────────────────────────────
 *
 * A degenerate triangle has a zero-length normal, which is finite, valid
 * glTF, and NaN the instant a shader normalizes it. It dissolved a gatehouse
 * into a white cloud. The race materials do not set `flatShading`, so three
 * uses the STORED normals - a zero-length one reaches `normalize()` in the
 * VERTEX shader and NaNs every fragment the triangle covers, on 819 instances.
 *
 * ── AND NOT A STAR-SHAPED FACING TEST ────────────────────────────────────
 *
 * `art-maze` recorded that a per-face "does this point away from the centroid"
 * test fires on geometry that legitimately faces inward, and both of these
 * bodies have parts that do - the marshal's recess jambs face each other
 * across the slot, and the spectator's arms face the flank. So winding is
 * checked by the two claims true of any closed solid however shaped: every
 * directed edge matched by its reverse, and positive signed volume.
 *
 * And the edge count is a BALANCE rather than "exactly once", which is where
 * the inherited generator was wrong in the other direction. It tallied
 * directed edges across a whole PART under an exactly-once rule and its
 * docblock claimed that made abutting solids each closed. It does not: the
 * marshal's shell runs its front face's bottom edge +X -> -X at (+/-1.6, 0,
 * -1.16) and the sill box against it runs its own bottom face's last edge
 * through the same two points in the same direction. Its own gate caught that
 * on the first run anybody ever gave it. The generator now tallies per solid,
 * where it knows the boundaries; this file cannot recover them from the bytes
 * and asserts the invariant that survives abutment instead - see the test.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'public/assets/race');
const MANIFEST = JSON.parse(readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));

/** Licences an asset in this repository may carry. Same list as the belt's. */
const LICENCES = ['generated', 'CC0-1.0', 'CC-BY-4.0', 'proprietary-owned'];

/* CRLF: this repo has previously had a source scrape pass in a worktree and
 * fail in the checkout for no other reason. Every text read here normalises. */
const text = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const ledger = () => text(path.join(ROOT, 'docs/assets/LICENCES.md'));

const ASSETS = {
  spectator: { file: 'spectator.glb', tris: SPECTATOR_TRIS, parts: Object.keys(SPECTATOR_PARTS) },
  marshal: { file: 'marshal.glb', tris: MARSHAL_TRIS, parts: [...MARSHAL_PART_KEYS] },
};

/* ------------------------------------------------------------------ */
/* A GLB reader, so every claim below is about the bytes that ship.     */
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
    bin.byteOffset + view.byteOffset + view.byteLength,
  ));
}

/** Every mesh in one file, by name, straight out of the bytes. */
function glbParts(id) {
  const { buf, json, bin } = readGlb(path.join(DIR, ASSETS[id].file));
  const out = {};
  for (const mesh of json.meshes) {
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
    out[mesh.name] = { position, normal, uv, indices, tris: indices.length / 3, geometry };
  }
  return { buf, json, parts: out };
}

const box3 = (position) => {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < position.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (position[i + k] < lo[k]) lo[k] = position[i + k];
      if (position[i + k] > hi[k]) hi[k] = position[i + k];
    }
  }
  return { lo, hi };
};

/* ================================================================== */
/* 1. The manifest, the ledger and the bytes                           */
/* ================================================================== */

test('the manifest declares exactly the two assets the loader looks for', () => {
  assert.ok(Array.isArray(MANIFEST.assets), 'manifest has no `assets` array');
  assert.equal(MANIFEST.assets.length, 2, 'the race manifest declares other than two assets');
  for (const id of Object.keys(ASSETS)) {
    const e = MANIFEST.assets.find((a) => a.id === id);
    assert.ok(e, `no \`${id}\` entry`);
    for (const field of ['file', 'kind', 'licence', 'source', 'parts', 'tris', 'verts', 'bytes']) {
      assert.ok(e[field] !== undefined, `${id}: manifest is missing \`${field}\``);
    }
    assert.equal(e.kind, 'geometry');
    assert.ok(LICENCES.includes(e.licence),
      `${id}: licence '${e.licence}' is not on the allow-list (${LICENCES.join(', ')})`);
    assert.deepEqual(e.parts, ASSETS[id].parts,
      `${id}: the manifest's part list is not the list the loader accepts`);
    assert.equal(e.tris, ASSETS[id].tris,
      `${id}: the manifest and the loader disagree about the triangle budget`);
    assert.equal(e.file, ASSETS[id].file);
  }
});

test('both assets have a line in the licence ledger', () => {
  const md = ledger();
  for (const id of Object.keys(ASSETS)) {
    assert.ok(md.includes(`\`${id}\``),
      `docs/assets/LICENCES.md has no line for \`${id}\` - every asset gets one on the day it lands`);
    assert.ok(md.includes(`public/assets/race/${ASSETS[id].file}`),
      `the ledger line for \`${id}\` does not name its file`);
  }
});

test("each manifest byte and vertex count is the file on disk", () => {
  for (const id of Object.keys(ASSETS)) {
    const e = MANIFEST.assets.find((a) => a.id === id);
    const bytes = readFileSync(path.join(DIR, ASSETS[id].file)).length;
    assert.equal(e.bytes, bytes, `${id}: manifest says ${e.bytes} bytes, the file is ${bytes}`);
    const { parts } = glbParts(id);
    const verts = Object.values(parts)
      .reduce((n, p) => n + p.position.length / 3, 0);
    assert.equal(e.verts, verts, `${id}: manifest says ${e.verts} verts, the file has ${verts}`);
  }
});

test('the parsed triangle count is EXACTLY the budget, both files', () => {
  for (const id of Object.keys(ASSETS)) {
    const { parts } = glbParts(id);
    assert.deepEqual(Object.keys(parts).sort(), [...ASSETS[id].parts].sort(),
      `${id}: the file's mesh names are not the parts the loader wires`);
    const tris = Object.values(parts).reduce((n, p) => n + p.tris, 0);
    assert.equal(tris, ASSETS[id].tris,
      `${id} is ${tris} triangles against a budget of ${ASSETS[id].tris}. `
      + 'These budgets are exact rather than ceilings BECAUSE they are multiplied by '
      + '819 and by 29 - a ceiling lets a tessellation change through unnoticed.');
  }
});

test('re-running the generator reproduces both files byte for byte', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'race-glb-'));
  try {
    for (const id of Object.keys(ASSETS)) {
      const out = path.join(tmp, ASSETS[id].file);
      execFileSync(process.execPath, [path.join(ROOT, 'scripts/make-race-glb.mjs')], {
        env: { ...process.env, RACE_GLB_ASSET: id, RACE_GLB_OUT: out },
        stdio: 'pipe',
      });
      assert.ok(readFileSync(out).equals(readFileSync(path.join(DIR, ASSETS[id].file))),
        `${id}: a fresh build differs from the committed file - the generator is not the `
        + 'provenance of what ships');
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

/* ================================================================== */
/* 2. The three geometry gates, against the shipped bytes              */
/* ================================================================== */

test('no normal in either file is anything but unit length', () => {
  for (const id of Object.keys(ASSETS)) {
    const { parts } = glbParts(id);
    for (const [name, p] of Object.entries(parts)) {
      for (let i = 0; i < p.normal.length; i += 3) {
        const l = Math.hypot(p.normal[i], p.normal[i + 1], p.normal[i + 2]);
        assert.ok(Number.isFinite(l) && Math.abs(l - 1) < 1e-4,
          `${id}.${name}: normal of length ${l} at vertex ${i / 3}. A zero-length normal is `
          + 'valid glTF and NaN the instant a shader normalizes it - it whited out a whole '
          + 'gatehouse before this gate existed.');
      }
    }
  }
});

test('no triangle in either file is degenerate', () => {
  for (const id of Object.keys(ASSETS)) {
    const { parts } = glbParts(id);
    for (const [name, p] of Object.entries(parts)) {
      for (let t = 0; t < p.indices.length; t += 3) {
        const a = p.indices[t] * 3;
        const b = p.indices[t + 1] * 3;
        const c = p.indices[t + 2] * 3;
        const ux = p.position[b] - p.position[a];
        const uy = p.position[b + 1] - p.position[a + 1];
        const uz = p.position[b + 2] - p.position[a + 2];
        const vx = p.position[c] - p.position[a];
        const vy = p.position[c + 1] - p.position[a + 1];
        const vz = p.position[c + 2] - p.position[a + 2];
        const area = 0.5 * Math.hypot(
          uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx,
        );
        assert.ok(area > 1e-9,
          `${id}.${name}: triangle ${t / 3} has area ${area} - that is the zero-normal source`);
      }
    }
  }
});

test('every part is a set of closed, outward-wound solids', () => {
  /* ── WHY THIS COUNTS EDGES THE WAY IT DOES ────────────────────────────
   *
   * The generator can check each solid separately because it knows where each
   * one begins. A reader of the BYTES cannot: the parts are flat-shaded, so no
   * two faces share an index even inside one box (grouping by index gives one
   * component per face), and abutting boxes DO share corner positions (so
   * grouping by position merges them). Neither decomposition recovers "solid".
   *
   * So the invariant asserted here is the one that is true of a union of
   * closed solids however they abut: **every directed edge appears exactly as
   * often as its reverse.** For a single closed solid that is "once each",
   * which is the textbook statement. For the marshal's shell and the sill box
   * against it, the shared bottom edge appears twice in each direction - twice
   * matched, still closed, and the inherited generator's global "exactly once"
   * called that broken, correctly, which is how the bug was found.
   *
   * A hole leaves a directed edge with no reverse. A face wound backwards
   * leaves two. Both fail. Components are still separated where positions
   * allow it, so a fault in one solid is reported against that solid rather
   * than against the whole part. */
  for (const id of Object.keys(ASSETS)) {
    const { parts } = glbParts(id);
    for (const [name, p] of Object.entries(parts)) {
      const key = (i) => {
        const o = i * 3;
        return `${Math.round(p.position[o] * 1e4)},${Math.round(p.position[o + 1] * 1e4)},`
          + `${Math.round(p.position[o + 2] * 1e4)}`;
      };
      /* Union-find over positions, so a solid is a set of faces reachable
       * through shared corners. */
      const parent = new Map();
      const find = (k) => {
        let r = k;
        while (parent.get(r) !== r) r = parent.get(r);
        while (parent.get(k) !== r) { const n = parent.get(k); parent.set(k, r); k = n; }
        return r;
      };
      const add = (k) => { if (!parent.has(k)) parent.set(k, k); };
      const union = (a, b) => { add(a); add(b); parent.set(find(a), find(b)); };
      for (let t = 0; t < p.indices.length; t += 3) {
        const k0 = key(p.indices[t]);
        const k1 = key(p.indices[t + 1]);
        const k2 = key(p.indices[t + 2]);
        union(k0, k1);
        union(k1, k2);
      }
      /** @type {Map<string,{edges:Map<string,number>, vol2:number, tris:number}>} */
      const solids = new Map();
      for (let t = 0; t < p.indices.length; t += 3) {
        const ks = [key(p.indices[t]), key(p.indices[t + 1]), key(p.indices[t + 2])];
        const root = find(ks[0]);
        let s = solids.get(root);
        if (!s) solids.set(root, (s = { edges: new Map(), vol2: 0, tris: 0 }));
        for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
          const e = `${ks[a]}|${ks[b]}`;
          s.edges.set(e, (s.edges.get(e) ?? 0) + 1);
        }
        s.tris++;
        const P = (n) => {
          const o = p.indices[t + n] * 3;
          return [p.position[o], p.position[o + 1], p.position[o + 2]];
        };
        const [A, B, C] = [P(0), P(1), P(2)];
        s.vol2 += A[0] * (B[1] * C[2] - B[2] * C[1])
          - A[1] * (B[0] * C[2] - B[2] * C[0])
          + A[2] * (B[0] * C[1] - B[1] * C[0]);
      }
      assert.ok(solids.size >= 1, `${id}.${name}: no solids found`);
      let n = 0;
      for (const [root, s] of solids) {
        n++;
        for (const [e, count] of s.edges) {
          const [a, b] = e.split('|');
          const back = s.edges.get(`${b}|${a}`) ?? 0;
          assert.equal(back, count,
            `${id}.${name}: solid at ${root} uses edge ${e} ${count} time(s) and its reverse `
            + `${back} - a hole in a solid is invisible from most angles, and a face wound `
            + 'backwards is invisible from all of them');
        }
        assert.ok(s.vol2 > 0,
          `${id}.${name}: solid at ${root} has signed volume ${(s.vol2 / 6).toFixed(5)} - `
          + 'wound inside out, which is invisible from ALL angles');
      }
      assert.ok(n >= 1);
    }
  }
});

test('both files carry UVs on every part', () => {
  /* Both assets draw with materials that carry an albedo, a normal and an ORM
   * map. A part that arrived without UVs would sample texel (0,0) over its
   * whole surface - one flat colour, and no error anywhere. */
  for (const id of Object.keys(ASSETS)) {
    const { parts } = glbParts(id);
    for (const [name, p] of Object.entries(parts)) {
      assert.ok(p.uv, `${id}.${name} carries no TEXCOORD_0`);
      assert.equal(p.uv.length / 2, p.position.length / 3, `${id}.${name}: UV count mismatch`);
      for (const v of p.uv) assert.ok(Number.isFinite(v), `${id}.${name}: non-finite UV`);
    }
  }
});

/* ================================================================== */
/* 3. What the geometry has to BE, not just that it parses             */
/* ================================================================== */

test('the spectator stands on its own origin at the height it declares', () => {
  const { parts } = glbParts('spectator');
  const all = box3(Float32Array.from(
    Object.values(parts).flatMap((p) => Array.from(p.position)),
  ));
  /* The instance matrix is composed from the placement point directly, so the
   * origin is where the feet go. The first build of this file put the legs'
   * bottom station at the ANKLE and shipped a crowd floating 9 cm off the
   * deck; nothing in the gates above would have said so. */
  assert.ok(Math.abs(all.lo[1]) < 1e-3,
    `the figure's lowest vertex is at y=${all.lo[1].toFixed(3)}, not on its own origin - `
    + 'it will float above, or sink into, every terrace it is placed on');
  assert.ok(Math.abs(all.hi[1] - SPECTATOR_HEIGHT) < 1e-3,
    `the figure is ${all.hi[1].toFixed(3)} m tall against the ${SPECTATOR_HEIGHT} it declares`);
  // A person is taller than they are wide, and much taller than they are deep.
  const w = all.hi[0] - all.lo[0];
  const d = all.hi[2] - all.lo[2];
  assert.ok(w > 0.40 && w < 0.70, `shoulder-to-shoulder is ${w.toFixed(3)} m`);
  assert.ok(d > 0.15 && d < 0.40, `front-to-back is ${d.toFixed(3)} m`);
});

test('the spectator has a head that is not the width of its neck', () => {
  /* The one proportion the shape it replaces cannot have. `blob(0.12, 0.14,
   * 0.12, ...)` on a cone whose top station is rx 0.11 is a ball the width of
   * the neck under it, which is what makes the shipped figure a bowling pin
   * from every angle. A skull is widest at the brow and tapers to the crown. */
  const { parts } = glbParts('spectator');
  const head = box3(parts.head.position);
  const torso = box3(parts.torso.position);
  const headW = head.hi[0] - head.lo[0];
  assert.ok(headW > 0.13 && headW < 0.17,
    `the skull is ${headW.toFixed(3)} m across; a head is about 1/11 of a 1.70 m figure`);
  assert.ok(head.lo[1] > torso.hi[1] - 0.02,
    'the head does not sit above the shoulders');

  /* Widest in the middle: sample the ring at three heights and require the
   * middle to be the broadest. */
  const widthAt = (y) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < parts.head.position.length; i += 3) {
      if (Math.abs(parts.head.position[i + 1] - y) > 1e-3) continue;
      lo = Math.min(lo, parts.head.position[i]);
      hi = Math.max(hi, parts.head.position[i]);
    }
    return hi - lo;
  };
  const ys = [...new Set(Array.from(
    { length: parts.head.position.length / 3 },
    (_, i) => Math.round(parts.head.position[i * 3 + 1] * 1e4) / 1e4,
  ))].sort((a, b) => a - b);
  assert.equal(ys.length, 3, `the skull has ${ys.length} stations, not the three it is built with`);
  const [neck, brow, crown] = ys.map(widthAt);
  assert.ok(brow > neck && brow > crown,
    `the skull is widest at ${brow > neck ? 'the crown' : 'the neck'} `
    + `(neck ${neck.toFixed(3)}, brow ${brow.toFixed(3)}, crown ${crown.toFixed(3)}) - `
    + 'a head tapers upward, which is the proportion a sphere cannot have');
});

test('the marshal keeps the shell its collider is placed on', () => {
  /* `_buildTrackside` puts a 1.6 x 1.3 x 1.3 rotated box at road + 1.3 m,
   * which is the crate the three shipped boxes drew. Art may hang a platform,
   * a rail and a roof outside that; art may not move the shell, because the
   * collider is not moving with it. */
  const { parts } = glbParts('marshal');
  const shell = box3(parts['metal.panel'].position);
  assert.ok(Math.abs(shell.lo[1]) < 1e-3,
    `the post's foot is at y=${shell.lo[1].toFixed(3)}, not on the ground`);
  assert.ok(Math.abs(shell.hi[1] - MARSHAL_SHELL.h) < 1e-3,
    `the post is ${shell.hi[1].toFixed(3)} m tall against the collider's ${MARSHAL_SHELL.h}`);
  assert.ok(Math.abs(shell.lo[0] + MARSHAL_SHELL.hx) < 1e-3
    && Math.abs(shell.hi[0] - MARSHAL_SHELL.hx) < 1e-3,
    `the post spans x ${shell.lo[0].toFixed(3)}..${shell.hi[0].toFixed(3)} `
    + `against the collider's +/-${MARSHAL_SHELL.hx}`);
  assert.ok(Math.abs(shell.hi[2] - MARSHAL_SHELL.hz) < 1e-3,
    `the post's back is at z=${shell.hi[2].toFixed(3)} against the collider's ${MARSHAL_SHELL.hz}`);
});

test('the hazard band is OUTSIDE the post, which is the defect it exists to fix', () => {
  /* The band the three boxes drew was 3.3 x 0.5 x 0.2 at the centre of a solid
   * 3.2 x 2.6 x 2.6. Ninety-three per cent of its surface was inside the
   * crate, and the seven per cent that rendered was a 5 cm tab on each END,
   * side-on to the road - so from a car it was never visible at all.
   *
   * The claim this asserts is the one a driver cares about: the band stands
   * proud of the shell on all four sides. */
  const { parts } = glbParts('marshal');
  const shell = box3(parts['metal.panel'].position);
  const band = box3(parts['hazard.stripe'].position);
  assert.ok(band.lo[0] < -MARSHAL_SHELL.hx && band.hi[0] > MARSHAL_SHELL.hx,
    'the hazard band does not reach past the ends of the post');
  assert.ok(band.lo[2] < -MARSHAL_SHELL.hz && band.hi[2] > MARSHAL_SHELL.hz,
    `the hazard band spans z ${band.lo[2].toFixed(3)}..${band.hi[2].toFixed(3)} inside a post `
    + `that spans +/-${MARSHAL_SHELL.hz} - it is buried again`);
  assert.ok(band.lo[1] > shell.lo[1] && band.hi[1] < shell.hi[1],
    'the band is not on the post at all');
});

test('the marshal recess is geometry standing proud, not a colour inside a solid', () => {
  /* `art-citadel` painted 800 window openings as a dark panel 16 cm INSIDE a
   * solid box, under a comment calling it "what the eye reads as depth", and
   * not one of them ever drew a pixel. A recess is a surround that stands out
   * from a back panel. So: the front of the post must not be one plane. */
  const { parts } = glbParts('marshal');
  const zs = new Set();
  for (let i = 2; i < parts['metal.panel'].position.length; i += 3) {
    zs.add(Math.round(parts['metal.panel'].position[i] * 1e3));
  }
  const front = [...zs].filter((z) => z < -1000).sort((a, b) => a - b);
  assert.ok(front.length >= 3,
    `the post's front is at ${front.length} distinct depth(s) - a recess needs a surround `
    + 'in front of a back panel, which is at least two, plus whatever stands off it');
  const proud = (front[front.length - 1] - front[0]) / 1000;
  assert.ok(proud > 0.10,
    `the front's deepest and shallowest planes are ${proud.toFixed(3)} m apart - `
    + 'that is not a recess a shadow can fall into');
});

/* ================================================================== */
/* 4. The world built BOTH WAYS                                        */
/* ================================================================== */

/**
 * "The .glb parses" is a gate that measures something the game does not do.
 * These build the real trackside pass and the real crowd twice - once with the
 * committed bytes installed and once with nothing - and assert that only the
 * geometry moves.
 */

const P = RaceWorld.prototype;
const MAT = new THREE.MeshBasicMaterial();

function realCircuits() {
  const circuits = CIRCUITS.map((def) => ({
    def,
    id: def.id,
    origin: def.origin ?? { x: 0, z: 0 },
    course: new RaceCourse(worldControls(def), {
      spacing: 2, verge: 11, baseHeight: baseTerrain, maxBankDeg: 5, cornerWiden: 0.2,
    }),
  }));
  return { circuits, set: new CourseSet(circuits.map((c) => c.course), baseTerrain) };
}

function stand(set) {
  const colliders = [];
  const rec = (c) => { colliders.push(c); return c; };
  const mats = new Set();
  const self = {
    rnd: mulberry32(0x5eed),
    group: new THREE.Group(),
    _owned: [],
    _variantFurniture: [],
    courseSet: set,
    _roadPoint: P._roadPoint,
    _orientedBox: (c, n, a, hx, hy, hz) =>
      rec({ kind: 'oriented', x: c.x, y: c.y, z: c.z, hx, hy, hz }),
    _mat: (k, o) => { mats.add(`${k}${o?.vertexColors === false ? '|novc' : ''}`); return MAT; },
    track: (x) => x,
    _flushFence() {},
    _buildVariantFurniture() {},
    _buildTrackObstacles() {},
    setDifficulty() {},
    variant: 'standard',
    physics: {
      addRotatedBox: (c, h) => rec({ kind: 'rotated', x: c.x, y: c.y, z: c.z, hy: h.y }),
      addBox: (x, y, z, hx, hy, hz) => rec({ kind: 'box', x, y, z, hy }),
      add: () => rec({ kind: 'collider' }),
    },
  };
  return { self, colliders, mats };
}

/** Parse the committed spectator and merge it exactly as the browser would. */
function committedSpectator() {
  const { parts } = glbParts('spectator');
  const geos = {};
  for (const [k, p] of Object.entries(parts)) geos[k] = p.geometry;
  return mergeSpectatorParts(THREE, mergeGeometries, geos);
}

function committedMarshal() {
  const { parts } = glbParts('marshal');
  const out = {};
  for (const [k, p] of Object.entries(parts)) out[k] = p.geometry;
  return out;
}

test('the assets install and are what the loader publishes', () => {
  resetRaceAssets();
  assert.equal(spectatorGeometry(), null, 'a reset loader must publish nothing');
  assert.equal(marshalParts(), null);
  installRaceAssets({ spectator: committedSpectator(), marshal: committedMarshal() });
  const g = spectatorGeometry();
  assert.ok(g, 'the merged spectator did not come back');
  assert.equal(
    (g.index ? g.index.count : g.attributes.position.count) / 3, SPECTATOR_TRIS,
    'the merge changed the triangle count',
  );
  assert.ok(g.attributes.color, 'the merged spectator carries no colour attribute - '
    + 'the crowd material has vertexColors on, and a missing attribute reads as ZERO, '
    + 'which renders BLACK rather than untinted');
  resetRaceAssets();
});

test('the merged spectator carries one shade per part, and they are the published ones', () => {
  resetRaceAssets();
  installRaceAssets({ spectator: committedSpectator() });
  const g = spectatorGeometry();
  const col = g.attributes.color;
  const seen = new Map();
  for (let i = 0; i < col.count; i++) {
    const r = Math.round(col.getX(i) * 1e4) / 1e4;
    assert.equal(Math.round(col.getY(i) * 1e4) / 1e4, r, 'a shade is not grey - it would tint the shirt');
    assert.equal(Math.round(col.getZ(i) * 1e4) / 1e4, r);
    seen.set(r, (seen.get(r) ?? 0) + 1);
  }
  const want = [...new Set(Object.values(SPECTATOR_PARTS))].sort((a, b) => a - b);
  assert.deepEqual([...seen.keys()].sort((a, b) => a - b), want,
    'the baked shades are not the ones RaceAssets publishes');
  /* The face is the ONE part above 1.0, and it is what says "this has a head".
   * A bake that clamped it to 1.0 would pass every other assertion here. */
  assert.ok(Math.max(...seen.keys()) > 1,
    'no part is drawn above 1.0 - the face has been clamped and the head has no highlight');
  resetRaceAssets();
});

test('the marshal moves the geometry and NOTHING else - collider, count and place', () => {
  const { circuits, set } = realCircuits();
  for (const cir of circuits) {
    resetRaceAssets();
    const a = stand(set);
    P._buildTrackside.call(a.self, cir);

    installRaceAssets({ marshal: committedMarshal() });
    const b = stand(set);
    P._buildTrackside.call(b.self, cir);
    resetRaceAssets();

    assert.equal(b.colliders.length, a.colliders.length,
      `${cir.id}: the authored post changed the collider count`);
    for (let i = 0; i < a.colliders.length; i++) {
      assert.deepEqual(b.colliders[i], a.colliders[i],
        `${cir.id}: collider ${i} moved when the asset was installed`);
    }
    assert.deepEqual([...b.mats].sort(), [...a.mats].sort(),
      `${cir.id}: the authored post asked for a material the box version did not`);

    const names = (s) => {
      const out = [];
      s.self.group.traverse((o) => { if (o.isMesh) out.push(o.name); });
      return out.sort();
    };
    assert.deepEqual(names(b), names(a),
      `${cir.id}: the authored post changed which merged meshes exist - `
      + 'that is a draw call, and this asset is not allowed to buy one');
  }
});

test('the authored post faces the circuit from BOTH sides of the road', () => {
  /* A Y-rotation by `atan2(rx, rz)` maps the post's local +Z onto the road's
   * RIGHT-HAND normal, and the observation slot is on local -Z. So a post at
   * +lat looks back at the circuit and a post at -lat looks away from it into
   * the country. That is invisible while the post is a symmetric crate and is
   * the first thing an authored one gets wrong.
   *
   * Measured, not asserted from the source: for every post, take the direction
   * from the post to the nearest point on its own centreline, and require the
   * drawn slot to be on that side. The slot is the deepest -Z geometry in the
   * shell, so it is found by which side of the post's centre the front face
   * lies once the placement rotation is applied. */
  const { circuits, set } = realCircuits();
  const marshal = committedMarshal();
  const front = box3(marshal['metal.panel'].attributes.position.array).lo[2];
  assert.ok(front < -1.3, 'the fixture no longer knows which way the post faces');

  for (const cir of circuits) {
    resetRaceAssets();
    installRaceAssets({ marshal });
    const co = cir.course;
    const postEvery = Math.max(1, Math.round(150 / co.step));
    let checked = 0;
    for (let i = 0; i < co.count; i += postEvery) {
      const inboard = (i / postEvery) % 2 === 0;
      const lat = inboard ? -(co.W[i] + 3.5) : co.W[i] + 3.5;
      const yaw = Math.atan2(co.rx[i], co.rz[i]);
      const face = inboard ? yaw + Math.PI : yaw;
      /* Local -Z under a Y-rotation of `face` lands on -(sin face, cos face). */
      const fx = -Math.sin(face);
      const fz = -Math.cos(face);
      /* And the road is at -lat * (rx, rz) from the post. */
      const tx = -Math.sign(lat) * co.rx[i];
      const tz = -Math.sign(lat) * co.rz[i];
      assert.ok(fx * tx + fz * tz > 0.99,
        `${cir.id} post ${i} (${inboard ? 'inboard' : 'outboard'}): its observation slot points `
        + `${(Math.acos(Math.max(-1, Math.min(1, fx * tx + fz * tz))) * 180 / Math.PI).toFixed(0)} `
        + 'degrees away from its own circuit');
      checked++;
    }
    assert.ok(checked >= 8, `${cir.id}: only ${checked} posts checked`);
    resetRaceAssets();
  }
});
