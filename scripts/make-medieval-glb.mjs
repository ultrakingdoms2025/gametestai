/**
 * Authored timber-frame carpentry for Aldermoor Vale.
 *
 * Phase 9 / decision D4, applied to the one world the nine-branch art pass
 * never reached: the vale got authored wolves and bears (`make-beast-glb.mjs`)
 * and its ENVIRONMENT got nothing. The before shots for this pass
 * (`.probe/art-medieval-env/before/`) say where the environment's authoring
 * budget belongs: the village framings are walls of timber framing seen at
 * 15-40 m, and every member in every frame is a straight axis-aligned box.
 *
 * ── What is authored, and why exactly these ──────────────────────────────
 *
 * English vernacular framing does not read as carpentry because of its posts
 * and rails - those really are straight, and `boxGeo` draws them perfectly.
 * It reads as carpentry because of its CURVED members: the arch-brace bowing
 * across a corner, and the carved console carrying a jettied storey. A curve
 * is the one shape a box batch cannot make - the same argument that authored
 * the citadel's pointed arch - and stepping one out of small boxes costs more
 * triangles than authoring it.
 *
 *   - **`brace`** - the arch-brace. `_house` draws a 0.19 m straight strap at
 *     ±0.62 rad in every storey corner; this is that strap with the sweep a
 *     sawn oak blade actually has: a shallow symmetric bow, deepest at the
 *     belly. Authored in the strap's own placement frame (length normalised
 *     to Y ∈ [-0.5, 0.5], width and bow in real metres) so the call site can
 *     keep its tuned position and rotation and scale only the length.
 *   - **`console`** - the jetty console. A jettied upper storey is carried on
 *     joist ends, and the village drew the joists and nothing under them; a
 *     cyma-curved console under each end is what makes an overhang read as
 *     carried rather than glued. Authored X ∈ [0, 1] out from the wall,
 *     Y ∈ [-1, 0] up the drop, thickness in real metres.
 *
 * ── The two rules, inherited verbatim ────────────────────────────────────
 *
 * **1. NORMALISED LOCAL SPACE**, placed by a matrix - because one brace has
 * to fit a 1.0 m cottage corner and a 2.4 m tavern one.
 *
 * **2. NO NEW MATERIAL, NO NEW MESH, NO NEW DRAW CALL.** Both parts bind to
 * the `beam` material slot, which every village `GeoBatch` already flushes,
 * and are merged into that bucket by `GeoBatch.add`. Three keys its shader
 * cache on material configuration and medieval's entry budget is already
 * 2.9x over; the cost of this file is triangles and nothing else, and
 * `TRI_BUDGET` below is the reservation.
 *
 * ── Output ───────────────────────────────────────────────────────────────
 *
 *   public/assets/medieval/frame.glb   brace, console
 *
 *   node scripts/make-medieval-glb.mjs
 *   MEDIEVAL_GLB_SET=frame MEDIEVAL_GLB_OUT=/tmp/x.glb node scripts/make-medieval-glb.mjs
 *
 * The env override exists for the reason every generator here has one: the
 * byte-diff test re-runs this into a temp file and compares buffers, and a
 * generator that can only write to its committed path cannot be tested.
 */

import * as THREE from 'three';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ */
/* Where each part is allowed to be welded                             */
/* ------------------------------------------------------------------ */

/**
 * Material slots `MedievalWorld._buildMaterials` defines and every village
 * `GeoBatch` flushes. A part bound to a slot outside this list would open a
 * new bucket in `GeoBatch.build` - one more `THREE.Mesh`, one more draw call
 * and a candidate shader program on a world whose `stats().warm.programs` is
 * already the boot budget's biggest line. The loader refuses a bind outside
 * it; `medieval-frame-assets.test.mjs` holds the list against a real headless
 * build so it cannot rot into a stale claim that welding somewhere is safe.
 */
export const WELDABLE = Object.freeze(['beam']);

/** part key -> { slot } - mirrored into the manifest's `bind`. */
export const PART_BINDING = Object.freeze({
  brace: { slot: 'beam' },
  console: { slot: 'beam' },
});

/**
 * Triangle reservation, per part, for ONE placement.
 *
 * A brace is placed in every storey corner of every house in the village -
 * the count is a property of `PLOTS`, not of this file - so the per-part
 * number is what bounds the world-level spend. The world-level reservation is
 * `MEDIEVAL_FRAME_TRI_BUDGET` in `FrameAssets.js`, asserted against a real
 * headless build.
 */
export const TRI_BUDGET = Object.freeze({ brace: 64, console: 60 });

/** Total for the one file, for the manifest test. */
export const SET_TRI_BUDGET = 124;

/* ------------------------------------------------------------------ */
/* The same explicit-quad mesher every architecture generator uses     */
/* ------------------------------------------------------------------ */

/**
 * Accumulates explicit quads into one indexed buffer. Copied in shape from
 * `make-citadel-glb.mjs`, including the two gates that file earned the hard
 * way: a half-degenerate quad takes its normal from whichever of its two
 * triangles has area (a zero-length normal is finite, writes as valid glTF,
 * and is NaN the moment a shader normalises it - the citadel's gatehouse
 * dissolved into a white cloud through bloom before that gate existed), and
 * `geometry()` refuses any normal that is not unit length in the bytes that
 * actually ship.
 */
class Mesher {
  constructor() {
    this.pos = [];
    this.nor = [];
    this.uv = [];
    this.idx = [];
  }

  quad(p0, p1, p2, p3, normals = null) {
    const base = this.pos.length / 3;
    let n = normals;
    if (!n) {
      const face = (q0, q1, q2) => {
        const ax = q1[0] - q0[0], ay = q1[1] - q0[1], az = q1[2] - q0[2];
        const bx = q2[0] - q0[0], by = q2[1] - q0[1], bz = q2[2] - q0[2];
        const cx = ay * bz - az * by;
        const cy = az * bx - ax * bz;
        const cz = ax * by - ay * bx;
        const len = Math.hypot(cx, cy, cz);
        return len > 1e-9 ? [cx / len, cy / len, cz / len] : null;
      };
      const c = face(p0, p1, p2) ?? face(p0, p2, p3) ?? face(p1, p2, p3);
      if (!c) return this;                 // no area anywhere: nothing to draw
      n = [c, c, c, c];
    }
    const uvs = [[0, 0], [1, 0], [1, 1], [0, 1]];
    for (let i = 0; i < 4; i++) {
      const p = [p0, p1, p2, p3][i];
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(n[i][0], n[i][1], n[i][2]);
      this.uv.push(uvs[i][0], uvs[i][1]);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    return this;
  }

  geometry(name) {
    const g = new THREE.BufferGeometry();
    g.name = name;
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    for (const v of this.pos) {
      if (!Number.isFinite(v)) throw new Error(`${name}: non-finite position`);
    }
    for (let i = 0; i < this.nor.length; i += 3) {
      const len = Math.hypot(this.nor[i], this.nor[i + 1], this.nor[i + 2]);
      if (!(Math.abs(len - 1) < 1e-4)) {
        throw new Error(`${name}: normal ${i / 3} has length ${len} - a shader normalizes that to NaN`);
      }
    }
    return g;
  }
}

/* ------------------------------------------------------------------ */
/* A curved strap, which both parts are                                */
/* ------------------------------------------------------------------ */

/**
 * Sweep a rectangular timber section along a planar centreline.
 *
 * `points` are [x, y] centreline stations in the part's local frame; the
 * section is `width` across the in-plane normal and `thick` through Z. Four
 * ruled faces (front, back, and the two sawn edges) plus end caps. The edge
 * faces are the read: they are what a low sun rakes, and a curve with lit
 * edges is the whole difference between a sawn blade and a printed stripe.
 */
function strap(m, points, width, thick) {
  const n = points.length;
  const widthAt = typeof width === 'function' ? width : () => width;
  const hz = thick / 2;
  // In-plane normal per station, averaged over the adjacent segments.
  const nrm = [];
  for (let i = 0; i < n; i++) {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(n - 1, i + 1)];
    const tx = b[0] - a[0];
    const ty = b[1] - a[1];
    const tl = Math.hypot(tx, ty) || 1;
    nrm.push([-ty / tl, tx / tl]);
  }
  const P = (i, side, z) => [
    points[i][0] + nrm[i][0] * (widthAt(i) / 2) * side,
    points[i][1] + nrm[i][1] * (widthAt(i) / 2) * side,
    z,
  ];
  for (let i = 0; i < n - 1; i++) {
    // Front (+z) and back (-z).
    m.quad(P(i, -1, hz), P(i, 1, hz), P(i + 1, 1, hz), P(i + 1, -1, hz));
    m.quad(P(i + 1, -1, -hz), P(i + 1, 1, -hz), P(i, 1, -hz), P(i, -1, -hz));
    // The two sawn edges.
    m.quad(P(i, 1, hz), P(i, 1, -hz), P(i + 1, 1, -hz), P(i + 1, 1, hz));
    m.quad(P(i + 1, -1, hz), P(i + 1, -1, -hz), P(i, -1, -hz), P(i, -1, hz));
  }
  // End caps.
  m.quad(P(0, 1, hz), P(0, 1, -hz), P(0, -1, -hz), P(0, -1, hz));
  const e = n - 1;
  m.quad(P(e, -1, hz), P(e, -1, -hz), P(e, 1, -hz), P(e, 1, hz));
}

/* ------------------------------------------------------------------ */
/* The parts                                                           */
/* ------------------------------------------------------------------ */

/**
 * The arch-brace.
 *
 * Frame: length along Y ∈ [-0.5, 0.5] - the call site scales Y by the brace
 * length `bl` and NOTHING else, so width, bow and thickness below are real
 * metres and every brace in the village carries the same curvature whatever
 * its length, which is what a yard sawing braces from the same crooks would
 * produce.
 *
 * The bow is a symmetric cosine, deepest at the belly, ZERO at both ends with
 * a non-zero end slope - so the brace meets post and plate on the same line
 * the straight strap did and the tuned placement in `_house` still lands.
 *
 * Bow AND belly. The first cut bowed a constant-width 0.19 m blade by
 * 0.11 m, and the mid shots read it as straight from 20 m: a thin ribbon's
 * curve disappears into its own width the moment the framing timbers around
 * it are the same value. What says "sawn from a crook" at distance is the
 * blade DEEPENING through the belly - ends at 0.17 m, belly at 0.29 - which
 * is also what a real arch-brace is, because the sawyer follows the grain of
 * a bent limb and the width follows the bend.
 *
 * Seven stations: six chords over the bow leave a maximum sagitta of ~12 mm,
 * under a pixel at the 8-15 m these live at in the street framings.
 */
function brace(m) {
  const S = 7;
  const BOW = 0.15;
  const pts = [];
  for (let i = 0; i < S; i++) {
    const y = -0.5 + i / (S - 1);
    pts.push([BOW * Math.cos(Math.PI * y), y]);
  }
  strap(m, pts, (i) => {
    const y = -0.5 + i / (S - 1);
    return 0.17 + 0.12 * Math.cos(Math.PI * y);
  }, 0.15);
}

/**
 * The jetty console.
 *
 * Frame: X ∈ [0, 1] out from the wall face (the call site scales X to the
 * jetty depth), Y ∈ [-1, 0] up the drop (scaled to the console's height),
 * thickness in real metres through Z. A cyma - tangent vertical against the
 * wall, tangent horizontal under the joist - which is the profile every
 * carved console since the Romans has carried, because it takes the load
 * story straight down the wall and the eye follows it.
 */
function consolePart(m) {
  const S = 7;
  const pts = [];
  for (let i = 0; i < S; i++) {
    const s = i / (S - 1);
    pts.push([(1 - Math.cos(Math.PI * s)) / 2, s - 1]);
  }
  strap(m, pts, 0.15, 0.14);
}

/* ------------------------------------------------------------------ */
/* The set                                                             */
/* ------------------------------------------------------------------ */

/** @type {Record<string, {file:string, parts:Record<string, (m:Mesher)=>void>}>} */
const SETS = {
  frame: {
    file: 'frame.glb',
    parts: { brace, console: consolePart },
  },
};

/** The parts each set contains, for the manifest and for the tests. */
export const SET_PARTS = Object.freeze(
  Object.fromEntries(Object.entries(SETS).map(([k, v]) => [k, Object.keys(v.parts)]))
);

/* ------------------------------------------------------------------ */
/* glTF writer - the same one every generator in this repo uses        */
/* ------------------------------------------------------------------ */

const align = (n) => (n % 4 ? 4 - (n % 4) : 0);

function accessorMinMax(arr, itemSize, count) {
  const min = new Array(itemSize).fill(Infinity);
  const max = new Array(itemSize).fill(-Infinity);
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < itemSize; k++) {
      const v = arr[i * itemSize + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

function writeGlb(setName, parts) {
  const bins = [];
  const bufferViews = [];
  const accessors = [];
  let binOffset = 0;

  const ARRAY_BUFFER = 34962, ELEMENT_ARRAY_BUFFER = 34963;
  const FLOAT = 5126, UNSIGNED_SHORT = 5123, UNSIGNED_INT = 5125;

  function push(typedArray, { itemSize, componentType, type, target, withMinMax }) {
    const bytes = Buffer.from(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
    bufferViews.push({ buffer: 0, byteOffset: binOffset, byteLength: bytes.length, target });
    const count = typedArray.length / itemSize;
    const acc = { bufferView: bufferViews.length - 1, componentType, count, type };
    if (withMinMax) Object.assign(acc, accessorMinMax(typedArray, itemSize, count));
    accessors.push(acc);
    bins.push(bytes);
    const pad = align(bytes.length);
    if (pad) bins.push(Buffer.alloc(pad));
    binOffset += bytes.length + pad;
    return accessors.length - 1;
  }

  const nodes = [];
  const meshes = [];
  const materials = [];
  const perPart = {};
  let tris = 0;
  let verts = 0;

  for (const [key, build] of Object.entries(parts)) {
    const m = new Mesher();
    build(m);
    const geo = m.geometry(key);
    const vCount = geo.attributes.position.count;
    const iArr = geo.index.array;
    verts += vCount;
    tris += iArr.length / 3;
    perPart[key] = iArr.length / 3;

    const posAcc = push(new Float32Array(geo.attributes.position.array), {
      itemSize: 3, componentType: FLOAT, type: 'VEC3', target: ARRAY_BUFFER, withMinMax: true,
    });
    const norAcc = push(new Float32Array(geo.attributes.normal.array), {
      itemSize: 3, componentType: FLOAT, type: 'VEC3', target: ARRAY_BUFFER,
    });
    const uvAcc = push(new Float32Array(geo.attributes.uv.array), {
      itemSize: 2, componentType: FLOAT, type: 'VEC2', target: ARRAY_BUFFER,
    });
    const wide = vCount > 65535;
    const idxAcc = push(wide ? new Uint32Array(iArr) : new Uint16Array(iArr), {
      itemSize: 1, componentType: wide ? UNSIGNED_INT : UNSIGNED_SHORT, type: 'SCALAR', target: ELEMENT_ARRAY_BUFFER,
    });

    materials.push({
      name: `${setName}-${key}-placeholder`,
      pbrMetallicRoughness: { baseColorFactor: [0.45, 0.35, 0.24, 1], metallicFactor: 0, roughnessFactor: 0.94 },
    });
    meshes.push({
      name: key,
      primitives: [{
        attributes: { POSITION: posAcc, NORMAL: norAcc, TEXCOORD_0: uvAcc },
        indices: idxAcc, mode: 4, material: materials.length - 1,
      }],
    });
    nodes.push({ mesh: meshes.length - 1, name: key });
  }

  const json = {
    asset: {
      version: '2.0',
      generator: 'aether-nexus scripts/make-medieval-glb.mjs',
      copyright: 'generated - procedurally authored in this repository, no external source',
    },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    /* Placeholders so the file stands alone in a viewer. The game DISCARDS
     * every one of these and merges each part into the village GeoBatch under
     * the material slot the manifest names - see FrameAssets.js. A test
     * asserts a built world's mesh and material counts are unchanged by
     * loading this. */
    materials,
    buffers: [{ byteLength: binOffset }],
    bufferViews,
    accessors,
  };

  let jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  if (jsonBytes.length % 4) jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc(4 - (jsonBytes.length % 4), 0x20)]);
  const binBytes = Buffer.concat(bins);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // 'glTF'
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBytes.length + 8 + binBytes.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonBytes.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4); // 'JSON'
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binBytes.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4); // 'BIN'

  return { glb: Buffer.concat([header, jsonHeader, jsonBytes, binHeader, binBytes]), tris, verts, perPart };
}

/* Guarded so the module can be imported by the test without writing files. */
const isMain = path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const only = process.env.MEDIEVAL_GLB_SET;
  const outOverride = process.env.MEDIEVAL_GLB_OUT;
  if (outOverride && !only) {
    throw new Error('MEDIEVAL_GLB_OUT needs MEDIEVAL_GLB_SET - it names one file, not both');
  }

  for (const [name, set] of Object.entries(SETS)) {
    if (only && only !== name) continue;
    for (const key of Object.keys(set.parts)) {
      const bind = PART_BINDING[key];
      if (!bind) throw new Error(`${name}.${key} has no binding declared`);
      if (!WELDABLE.includes(bind.slot)) {
        throw new Error(`${name}.${key} binds to '${bind.slot}', which the village GeoBatch does not already flush`);
      }
    }
    const { glb, tris, verts, perPart } = writeGlb(name, set.parts);
    for (const [key, n] of Object.entries(perPart)) {
      if (n > TRI_BUDGET[key]) {
        throw new Error(`${name}.${key} is ${n} tris - over the ${TRI_BUDGET[key]} reservation`);
      }
    }
    if (tris > SET_TRI_BUDGET) {
      throw new Error(`${name} is ${tris} tris - over the ${SET_TRI_BUDGET} reservation`);
    }
    const out = outOverride
      ? path.resolve(outOverride)
      : path.join(root, 'public/assets/medieval', set.file);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, glb);
    console.log(`${out}\n  ${Object.keys(set.parts).length} parts, ${verts} verts, ${tris} tris, ${glb.length} bytes`);
    for (const [key, n] of Object.entries(perPart)) console.log(`    ${key.padEnd(10)} ${n} tris`);
  }
}
