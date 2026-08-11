/**
 * Authors `public/assets/maze/newel-finial.glb` - the shaft newel / stair
 * finial, Task 8's one hero prop.
 *
 *   node scripts/make-newel-glb.mjs
 *
 * The task is about the PIPELINE, not the art (the plan says so in as many
 * words), so the model is authored procedurally right here: a turned newel
 * post - plinth, coved shaft, collar bead, acorn finial - lathed by the same
 * three.js the game ships, then written out as a self-contained binary glTF
 * with no dependency beyond `node_modules/three`. That keeps the licence line
 * honest (`generated`: this repo made it, nobody is owed attribution) and
 * makes the asset reproducible: re-run this script and the byte-identical
 * prop comes back.
 *
 * Deliberately authored at the CANONICAL dressing size (0.6 m wide, 1 m
 * tall, y centred on 0) even though `MazeMeshes.buildAssetPrefab` refits
 * whatever arrives - the refit exists for files authored elsewhere at
 * whatever scale an artist exported; this file may as well be right.
 *
 * Budget: <= 512 vertices / <= 1536 indices, the stone family's per-prefab
 * reservation in MazeBatches.GEOMETRY_BUDGET - `scripts/tests/
 * maze-assets.test.mjs` holds the manifest's declared `tris` to it, and this
 * script refuses to write a file that would fail that test.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* The turned profile, bottom to top: (radius, y). Max radius 0.28 keeps the
 * silhouette visibly clear of the 0.3 m dressing box; y spans the full box. */
const PROFILE = [
  [0.0, -0.50], // bottom centre (closes the base)
  [0.26, -0.50], // base bottom edge
  [0.28, -0.46], // base chamfer
  [0.28, -0.34], // plinth top edge
  [0.20, -0.30], // cove into the shaft
  [0.16, -0.22],
  [0.13, -0.05], // shaft taper
  [0.12, 0.10], // shaft top
  [0.17, 0.16], // collar bead
  [0.17, 0.20],
  [0.12, 0.24], // neck
  [0.19, 0.34], // acorn belly
  [0.14, 0.44], // acorn shoulder
  [0.05, 0.49],
  [0.0, 0.50], // apex (closes the tip)
];
const RADIAL_SEGMENTS = 16;

const geo = new THREE.LatheGeometry(
  PROFILE.map(([r, y]) => new THREE.Vector2(r, y)), RADIAL_SEGMENTS,
);

const verts = geo.attributes.position.count;
const tris = geo.index.count / 3;
if (verts > 512 || geo.index.count > 1536) {
  throw new Error(`newel is ${verts} verts / ${geo.index.count} indices - over the stone reservation`);
}

/* ---- minimal binary glTF 2.0 writer ---------------------------------- */

const align = (n, pad) => Math.ceil(n / 4) * 4 - n + (pad ? 0 : 0);

function accessorMinMax(attr) {
  const size = attr.itemSize;
  const min = new Array(size).fill(Infinity);
  const max = new Array(size).fill(-Infinity);
  for (let i = 0; i < attr.count; i++) {
    for (let c = 0; c < size; c++) {
      const v = attr.array[i * size + c];
      if (v < min[c]) min[c] = v;
      if (v > max[c]) max[c] = v;
    }
  }
  return { min, max };
}

const bins = [];
const bufferViews = [];
const accessors = [];
let binOffset = 0;

function push(typedArray, { itemSize, componentType, type, target, withMinMax }) {
  const bytes = Buffer.from(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
  bufferViews.push({ buffer: 0, byteOffset: binOffset, byteLength: bytes.length, target });
  const acc = {
    bufferView: bufferViews.length - 1,
    componentType,
    count: typedArray.length / itemSize,
    type,
  };
  if (withMinMax) Object.assign(acc, accessorMinMax({ array: typedArray, itemSize, count: acc.count }));
  accessors.push(acc);
  bins.push(bytes);
  const padded = align(bytes.length);
  if (padded) bins.push(Buffer.alloc(padded));
  binOffset += bytes.length + padded;
  return accessors.length - 1;
}

const ARRAY_BUFFER = 34962; const ELEMENT_ARRAY_BUFFER = 34963;
const FLOAT = 5126; const UNSIGNED_SHORT = 5123;

const posAcc = push(geo.attributes.position.array, {
  itemSize: 3, componentType: FLOAT, type: 'VEC3', target: ARRAY_BUFFER, withMinMax: true,
});
const norAcc = push(geo.attributes.normal.array, {
  itemSize: 3, componentType: FLOAT, type: 'VEC3', target: ARRAY_BUFFER,
});
const uvAcc = push(geo.attributes.uv.array, {
  itemSize: 2, componentType: FLOAT, type: 'VEC2', target: ARRAY_BUFFER,
});
const idxAcc = push(new Uint16Array(geo.index.array), {
  itemSize: 1, componentType: UNSIGNED_SHORT, type: 'SCALAR', target: ELEMENT_ARRAY_BUFFER,
});

const json = {
  asset: {
    version: '2.0',
    generator: 'aether-nexus scripts/make-newel-glb.mjs',
    copyright: 'generated - procedurally authored in this repository, no external source',
  },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0, name: 'newel-finial' }],
  meshes: [{
    name: 'newel-finial',
    primitives: [{
      attributes: { POSITION: posAcc, NORMAL: norAcc, TEXCOORD_0: uvAcc },
      indices: idxAcc,
      mode: 4,
      material: 0,
    }],
  }],
  /* A placeholder so the file stands alone in any viewer. The game DISCARDS
   * this material on load and draws the geometry with the cached maze stone
   * material instead - see MazeAssets.js - so nothing here costs a program. */
  materials: [{
    name: 'newel-stone-placeholder',
    pbrMetallicRoughness: { baseColorFactor: [0.85, 0.81, 0.70, 1], metallicFactor: 0, roughnessFactor: 0.8 },
  }],
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

const out = path.join(root, 'public/assets/maze/newel-finial.glb');
mkdirSync(path.dirname(out), { recursive: true });
const glb = Buffer.concat([header, jsonHeader, jsonBytes, binHeader, binBytes]);
writeFileSync(out, glb);

console.log(`${out}\n  ${verts} verts, ${tris} tris, ${glb.length} bytes`);
