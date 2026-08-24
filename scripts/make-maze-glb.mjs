/**
 * Authors the maze's Phase 9 hero geometry:
 *
 *   public/assets/maze/leaf-tuft.glb      the hedge-top sprig AND the shaft ivy leaf
 *   public/assets/maze/hedge-candle.glb   the wall candle
 *
 *   node scripts/make-maze-glb.mjs                     # both
 *   MAZE_GLB_ASSET=leaf-tuft node scripts/make-maze-glb.mjs
 *   MAZE_GLB_ASSET=leaf-tuft MAZE_GLB_OUT=/tmp/x.glb node scripts/make-maze-glb.mjs
 *
 * The two environment overrides exist for `scripts/tests/maze-glb.test.mjs`,
 * which re-runs this script into a temp file and `Buffer.equals` the result
 * against the committed one. That test is the entire meaning of the
 * `generated` licence: without it the word is a claim, with it a hand-edited
 * or externally-sourced .glb cannot survive a test run.
 *
 * ── Why these two, and why so small ──────────────────────────────────────
 *
 * Measured before anything was authored (`world-shot --world maze`, the
 * `byName` triangle breakdown): every `maze:foliage:<district>` InstancedMesh
 * in this world is **43,200 triangles** - 3,600 instances of a 12-triangle
 * `BoxGeometry(0.5, 0.5, 0.5)` - and the top fourteen objects in EVERY
 * framing are fourteen of those meshes. Twenty-one of them are resident at
 * the entrance. Roughly two thirds of the entire world's triangle count is
 * hedge-top "unkempt growth" drawn as axis-aligned cubes.
 *
 * So the sprig is this world's hero asset by frame area and by cost at the
 * same time, and its triangle budget is not "what looks good" but "what the
 * world already spends, or less". Ten is less than twelve. The whole design
 * below - five-fold, irregular, bipyramidal - is what fits in ten triangles
 * and still has no flat top face and no axis-aligned side, which is what the
 * before-shots show the box failing at.
 *
 * The candle is the opposite trade and is what the sprig's saving pays for.
 * Seventy per district sit at chest height on the hedge faces; they are the
 * only OBJECT (rather than surface) a maze player ever stands next to, they
 * are the brightest thing in every corridor framing, and they are a glowing
 * rectangular slab. 64 triangles buys a round tapered pillar with a melted
 * lip and an actual flame.
 *
 * ── The gates this generator refuses to write past ───────────────────────
 *
 * Two failures cost sibling branches real time and both are cheap to make
 * impossible here rather than to catch in review:
 *
 *  - **A degenerate face has a zero-length normal**, which is finite, valid
 *    glTF, and NaN the moment a shader normalizes it. `art-citadel` dissolved
 *    a gatehouse into a white cloud that way. `tri()` below computes the
 *    cross product and THROWS on anything that is not unit length.
 *  - **A backfacing triangle is *absent*, not wrong-looking** - and a surface
 *    missing from a screenshot of a 20 cm prop is not something a review
 *    catches. `art-dock` added a winding gate that then caught its own bad
 *    correction, which is the point: three lines of cross product in a
 *    comment is not a check.
 *
 * The winding gate here is EXACT rather than heuristic, and that is a
 * correction made inside this branch. The first version tested each face
 * against the shape's own centre ("does this normal point away from the
 * middle?"), which is only valid for a star-shaped solid - and it fired
 * immediately on the candle's flame, whose underside legitimately faces back
 * down toward the middle. A gate that rejects correct geometry is worse than
 * no gate, so it was replaced by the assumption-free version:
 *
 *   1. every face normal is unit length (no degenerate triangle);
 *   2. the surface is CLOSED and CONSISTENTLY ORIENTED - every directed edge
 *      (a->b), matched by POSITION because flat shading duplicates vertices,
 *      occurs exactly once, and its reverse (b->a) occurs exactly once. One
 *      flipped triangle breaks this on all three of its edges;
 *   3. the signed volume `(1/6) sum a.(b x c)` is POSITIVE, which for a
 *      closed consistently-oriented surface means the orientation is outward
 *      rather than inward.
 *
 * Together those three admit exactly one answer, and none of them cares what
 * shape the solid is. All three are re-asserted against the COMMITTED BYTES
 * by `scripts/tests/maze-glb.test.mjs`, so a file that stops satisfying them
 * cannot sit in the repository unnoticed.
 *
 * ── Determinism ──────────────────────────────────────────────────────────
 *
 * No `Math.random`, no `Date`, no floating-point accumulation order that
 * depends on anything but the source. Every "jitter" is `hash01`, the same
 * integer hash `MazeTopology` uses, so re-running reproduces the file byte
 * for byte on any machine.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ */
/* Deterministic jitter                                                */
/* ------------------------------------------------------------------ */

/** The integer hash `MazeTopology.hash32` uses, inlined so this file imports nothing. */
function hash32(...nums) {
  let h = 0x811c9dc5;
  for (const n of nums) {
    let v = n | 0;
    for (let i = 0; i < 4; i++) {
      h ^= v & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
      v >>>= 8;
    }
  }
  return h >>> 0;
}

/** 0..1, deterministic. */
const hash01 = (...nums) => hash32(...nums) / 0x100000000;
/** -1..1, deterministic. */
const hashPm = (...nums) => hash01(...nums) * 2 - 1;

/* ------------------------------------------------------------------ */
/* A flat-shaded triangle soup with both gates built in                */
/* ------------------------------------------------------------------ */

/** Position key for edge matching. Flat shading duplicates vertices, so the
 *  surface's topology lives in the COORDINATES rather than in the indices. */
const vkey = (p) => `${p[0].toFixed(6)},${p[1].toFixed(6)},${p[2].toFixed(6)}`;

/**
 * Every face owns its three vertices, so the facets shade FLAT with a crease
 * at every edge. That is not laziness - it is the read: a leaf tuft whose ten
 * facets each catch a different amount of light is a clump, and the same
 * silhouette shaded smooth is a blob.
 */
function soup() {
  const pos = [];
  const nor = [];
  const uv = [];
  const idx = [];
  /** directed edge key -> how many times it was written. */
  const edges = new Map();
  let n = 0;
  let volume6 = 0;

  /**
   * One triangle. Winding is checked GLOBALLY by `close()`, not here.
   *
   * @param {number[]} a @param {number[]} b @param {number[]} c
   */
  const tri = (a, b, c) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    /* THE DEGENERATE GATE. A zero-length normal is a valid float and a NaN
     * in the first shader that normalizes it. 1e-9 is far below any face
     * either of these shapes has; a legitimate face here is ~1e-4 or bigger. */
    if (!(len > 1e-9)) {
      throw new Error(`degenerate triangle: |n| = ${len} at (${a}) (${b}) (${c})`);
    }
    nx /= len; ny /= len; nz /= len;
    for (const p of [a, b, c]) {
      pos.push(p[0], p[1], p[2]);
      nor.push(nx, ny, nz);
      /* Cylindrical, which suits both shapes: both are rings about y. No maze
       * material that draws either of these carries a map today; the UVs are
       * emitted so the file is complete rather than because anything samples
       * them. */
      uv.push((Math.atan2(p[2], p[0]) / (Math.PI * 2)) + 0.5, p[1] + 0.5);
    }
    idx.push(n, n + 1, n + 2);
    n += 3;
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const k = `${vkey(p)}|${vkey(q)}`;
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
    volume6 += a[0] * (b[1] * c[2] - b[2] * c[1])
      + a[1] * (b[2] * c[0] - b[0] * c[2])
      + a[2] * (b[0] * c[1] - b[1] * c[0]);
  };

  /** Run the two global gates and hand back the buffers. */
  const close = (name) => {
    for (const [k, count] of edges) {
      if (count !== 1) {
        throw new Error(`${name}: directed edge ${k} written ${count} times - the surface is not manifold`);
      }
      const [p, q] = k.split('|');
      if ((edges.get(`${q}|${p}`) ?? 0) !== 1) {
        throw new Error(
          `${name}: edge ${p} -> ${q} has no matching ${q} -> ${p} - the surface is open or a face is `
          + 'flipped. A backfacing face is INVISIBLE, not wrong-looking',
        );
      }
    }
    if (!(volume6 > 0)) {
      throw new Error(
        `${name}: signed volume ${(volume6 / 6).toExponential(3)} is not positive - the whole surface is `
        + 'wound inside out, which renders as nothing at all',
      );
    }
    return { pos, nor, uv, idx, volume: volume6 / 6 };
  };

  return { tri, close };
}

/**
 * A triangle fan around a ring, closing it onto one point.
 * @param {boolean} apexAbove is the apex on the +y side of the ring?
 */
function fan(tri, ring, apex, apexAbove) {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (apexAbove) tri(apex, b, a);
    else tri(apex, a, b);
  }
}

/** A quad band between two rings of equal length, wound outward. */
function band(tri, lower, upper) {
  for (let i = 0; i < lower.length; i++) {
    const j = (i + 1) % lower.length;
    tri(lower[i], upper[i], upper[j]);
    tri(lower[i], upper[j], lower[j]);
  }
}

/* ------------------------------------------------------------------ */
/* leaf-tuft: the hedge sprig and the ivy leaf, one geometry           */
/* ------------------------------------------------------------------ */

/**
 * An irregular five-fold bipyramid, authored to the SAME 0.5 m bounding cube
 * as the `BoxGeometry(0.5, 0.5, 0.5)` it replaces, so that every scale
 * `MazeFoliage` already computes keeps its meaning and this commit changes
 * shape and nothing else.
 *
 * Why five and not four or six. Four is the box's own symmetry and reads as a
 * turned box; six lines up with itself every 60 degrees, which at the yaw
 * range the sprigs use makes neighbouring tufts look copy-pasted. Five has no
 * axis in common with a rectangular hedge, and it is the smallest odd ring
 * that still closes into a mass.
 *
 * ── The shape is a CROWN, and that is a correction made inside this branch ─
 *
 * The first authored version was the obvious one: a ring near the waist, an
 * apex at the top, an apex at the bottom - an irregular bipyramid. It shipped,
 * it was photographed at conversational distance, and it read as a row of
 * little green TRAFFIC CONES stood on the hedge. Two reasons, both visible
 * only in the shot:
 *
 *  - a bipyramid seen from any single angle is a clean triangle, and a clean
 *    triangle is a cone;
 *  - a sprig is mostly BURIED. Only its top few centimetres clear the hedge,
 *    so what a player sees is not the tuft, it is the tuft's TIP - and the tip
 *    of a bipyramid is the most cone-like part of it.
 *
 * So the ring moved UP to become the silhouette, and its five vertices got
 * wildly different heights instead of a small zigzag: they are shoot tips of
 * different lengths, and the notches between them fall below the hedge line.
 * The centre vertex sits BELOW the mean of the ring, so the top surface is a
 * shallow irregular rosette rather than a point - three tall shoots, two
 * short ones, and no straight run anywhere in the outline. Same ten
 * triangles. `MazeFoliage.SPRIG_SINK` moved with it, because a crown whose
 * points are buried is a cone again.
 *
 * ONE geometry serves the hedge sprig and the shaft ivy because
 * `MazeChunks.buildSprigInstances` scales per instance: the hedge growth
 * takes it at (s, 1.4s, s) and reads as a tuft of shoots; the ivy squashes it
 * to 0.09 on the wall's own normal, and a squashed crown is a ragged leaf
 * with a central rib - which is exactly what the ivy needed and exactly what
 * a squashed box could never be.
 */
function leafTuft() {
  const HALF = 0.25;
  const s = soup();

  /* Shoot tips: five, at five different lengths. The tallest reaches the full
   * half-extent so the authored bounding box is exactly the 0.5 m cube the
   * box it replaces had - which is what lets every scale in `MazeFoliage`
   * keep its meaning. Written out rather than hashed because these five
   * numbers ARE the silhouette, and a silhouette should be readable in the
   * source that makes it. */
  const TIPS = [
    { th: 0.00, r: 0.96, y: 1.00 },
    { th: 1.31, r: 0.82, y: 0.12 },
    { th: 2.44, r: 0.99, y: 0.78 },
    { th: 3.86, r: 0.74, y: -0.28 },
    { th: 5.13, r: 0.90, y: 0.50 },
  ];
  const ring = TIPS.map((t) => {
    const th = t.th + hashPm(0x1eaf, Math.round(t.th * 100), 1) * 0.10;
    const r = HALF * t.r;
    return [Math.cos(th) * r, HALF * t.y, Math.sin(th) * r];
  });
  /* The crotch of the crown - below the mean of the tips (0.224 of HALF), so
   * the top surface dishes between the shoots instead of coming to a point.
   * Off the axis, because growth is not symmetric about its own stem. */
  const crotch = [0.036, HALF * 0.10, -0.028];
  const root = [-0.030, -HALF, 0.046];

  fan(s.tri, ring, crotch, true);
  fan(s.tri, ring, root, false);
  return { name: 'leaf-tuft', ...s.close('leaf-tuft') };
}

/* ------------------------------------------------------------------ */
/* hedge-candle: the wall candle                                       */
/* ------------------------------------------------------------------ */

/**
 * A seven-sided wax pillar with a melted lip and a flame, authored inside the
 * candle descriptor's own dressing box (0.18 x 0.52 x 0.18 - see
 * `MazeChunks.ensure`, which synthesises `hx: 0.09, hy: 0.26, hz: 0.09`).
 *
 * Seven, not eight: an even ring presents a flat face square-on to a player
 * walking a corridor that runs on the same axes the hedge does, and a flat
 * face square-on is what the box already looked like. An odd ring never lines
 * up with the corridor.
 *
 * EVERYTHING HERE IS WAX. `MazeMaterials.candle` is one emissive material for
 * the whole prop (`emissive 0xffb457`, intensity 2.2), and a batched prefab
 * cannot carry a second one - so an iron bracket, which is what a wall candle
 * would really have, would be an iron bracket glowing as brightly as the
 * flame. The shape is therefore a free-standing pillar that has been stood on
 * the hedge's own face, and the detail budget goes where it can be seen: the
 * taper, the drip lip, and a flame that a player can read at twenty metres.
 *
 *   base cap        7
 *   body band       14   base -> drip lip
 *   shoulder band   14   drip lip -> shoulder
 *   neck band       14   shoulder -> wick neck
 *   flame band      14   wick neck -> flame belly
 *   flame tip        7
 *                 ----
 *                  70 triangles
 *
 * The flame is the top of the SAME lathe rather than a separate cone stood on
 * the wick: two cones meeting at a single shared vertex is a pinch point, and
 * a pinch point is where a closed-surface check stops being able to tell a
 * flipped face from a legitimate one. One continuous surface is both cheaper
 * to reason about and what a candle burnt down into its own wax looks like.
 */
function hedgeCandle() {
  const RING = 7;
  const s = soup();

  /* Hand-dipped wax is not a lathe. A per-vertex radius wobble of a few per
   * cent is what stops seven flat facets reading as a machined nut. */
  const ringAt = (y, r, tag, wobble = 0.06) => {
    const out = [];
    for (let i = 0; i < RING; i++) {
      const th = (i / RING) * Math.PI * 2;
      const rr = r * (1 + hashPm(0xca9d, i, tag) * wobble);
      out.push([Math.cos(th) * rr, y, Math.sin(th) * rr]);
    }
    return out;
  };

  /* The foot apex, not the base ring, is the lowest point - so the ring sits
   * a little above the box floor and the apex lands exactly on it. The whole
   * prop then spans exactly the 0.52 m the candle descriptor declares, and
   * `buildAssetPrefab` refits it at scale 1.0. */
  const base = ringAt(-0.248, 0.073, 1);
  /* The melted lip: wider than the body and hanging unevenly, which is the
   * one silhouette detail that says "this has been burning" rather than
   * "this is a cylinder". */
  const drip = [];
  for (let i = 0; i < RING; i++) {
    const th = (i / RING) * Math.PI * 2;
    const rr = 0.084 * (1 + hashPm(0xca9d, i, 3) * 0.09);
    drip.push([Math.cos(th) * rr, 0.120 - hash01(0xca9d, i, 4) * 0.042, Math.sin(th) * rr]);
  }
  const shoulder = ringAt(0.166, 0.052, 5);
  const neck = ringAt(0.185, 0.013, 6, 0.10);
  const flame = ringAt(0.209, 0.027, 7, 0.14);

  fan(s.tri, base, [0, -0.260, 0], false);  // the foot, seen from below
  band(s.tri, base, drip);
  band(s.tri, drip, shoulder);
  band(s.tri, shoulder, neck);
  band(s.tri, neck, flame);
  /* The tip leans, and reaches the top of the dressing box so the prop's own
   * bounding box is the box `buildAssetPrefab` refits it into - scale 1, no
   * silhouette lost to a fit. */
  fan(s.tri, flame, [0.008, 0.260, -0.005], true);

  return { name: 'hedge-candle', ...s.close('hedge-candle') };
}

/* ------------------------------------------------------------------ */
/* Minimal binary glTF 2.0 writer - the shape make-newel-glb.mjs uses  */
/* ------------------------------------------------------------------ */

function writeGlb(model, out) {
  const bins = [];
  const bufferViews = [];
  const accessors = [];
  let binOffset = 0;

  const minMax = (arr, itemSize) => {
    const min = new Array(itemSize).fill(Infinity);
    const max = new Array(itemSize).fill(-Infinity);
    for (let i = 0; i < arr.length; i += itemSize) {
      for (let c = 0; c < itemSize; c++) {
        const v = arr[i + c];
        if (v < min[c]) min[c] = v;
        if (v > max[c]) max[c] = v;
      }
    }
    return { min, max };
  };

  const push = (typedArray, { itemSize, componentType, type, target, withMinMax }) => {
    const bytes = Buffer.from(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
    bufferViews.push({
      buffer: 0, byteOffset: binOffset, byteLength: bytes.length, target,
    });
    const acc = {
      bufferView: bufferViews.length - 1,
      componentType,
      count: typedArray.length / itemSize,
      type,
    };
    if (withMinMax) Object.assign(acc, minMax(typedArray, itemSize));
    accessors.push(acc);
    bins.push(bytes);
    const pad = Math.ceil(bytes.length / 4) * 4 - bytes.length;
    if (pad) bins.push(Buffer.alloc(pad));
    binOffset += bytes.length + pad;
    return accessors.length - 1;
  };

  const ARRAY_BUFFER = 34962; const ELEMENT_ARRAY_BUFFER = 34963;
  const FLOAT = 5126; const UNSIGNED_SHORT = 5123;

  const posAcc = push(new Float32Array(model.pos), {
    itemSize: 3, componentType: FLOAT, type: 'VEC3', target: ARRAY_BUFFER, withMinMax: true,
  });
  const norAcc = push(new Float32Array(model.nor), {
    itemSize: 3, componentType: FLOAT, type: 'VEC3', target: ARRAY_BUFFER,
  });
  const uvAcc = push(new Float32Array(model.uv), {
    itemSize: 2, componentType: FLOAT, type: 'VEC2', target: ARRAY_BUFFER,
  });
  const idxAcc = push(new Uint16Array(model.idx), {
    itemSize: 1, componentType: UNSIGNED_SHORT, type: 'SCALAR', target: ELEMENT_ARRAY_BUFFER,
  });

  const json = {
    asset: {
      version: '2.0',
      generator: 'aether-nexus scripts/make-maze-glb.mjs',
      copyright: 'generated - procedurally authored in this repository, no external source',
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: model.name }],
    meshes: [{
      name: model.name,
      primitives: [{
        attributes: { POSITION: posAcc, NORMAL: norAcc, TEXCOORD_0: uvAcc },
        indices: idxAcc,
        mode: 4,
        material: 0,
      }],
    }],
    /* A placeholder so the file stands alone in any viewer. The game DISCARDS
     * it on load (`MazeAssets.firstGeometry`) and draws the geometry with the
     * cached maze material of the bucket it joins, so nothing here costs a
     * program. */
    materials: [{
      name: `${model.name}-placeholder`,
      pbrMetallicRoughness: {
        baseColorFactor: [0.52, 0.67, 0.33, 1], metallicFactor: 0, roughnessFactor: 1,
      },
    }],
    buffers: [{ byteLength: binOffset }],
    bufferViews,
    accessors,
  };

  let jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  if (jsonBytes.length % 4) {
    jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc(4 - (jsonBytes.length % 4), 0x20)]);
  }
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

  mkdirSync(path.dirname(out), { recursive: true });
  const glb = Buffer.concat([header, jsonHeader, jsonBytes, binHeader, binBytes]);
  writeFileSync(out, glb);
  return { glb, tris: model.idx.length / 3, verts: model.pos.length / 3 };
}

/* ------------------------------------------------------------------ */

const ASSETS = {
  'leaf-tuft': { build: leafTuft, file: 'leaf-tuft.glb' },
  'hedge-candle': { build: hedgeCandle, file: 'hedge-candle.glb' },
};

const only = process.env.MAZE_GLB_ASSET;
if (only && !ASSETS[only]) {
  throw new Error(`MAZE_GLB_ASSET='${only}' is not one of ${Object.keys(ASSETS).join(', ')}`);
}
const outOverride = process.env.MAZE_GLB_OUT;
if (outOverride && !only) {
  throw new Error('MAZE_GLB_OUT needs MAZE_GLB_ASSET - one output path cannot hold two assets');
}

for (const [id, spec] of Object.entries(ASSETS)) {
  if (only && id !== only) continue;
  const model = spec.build();
  const out = outOverride ?? path.join(root, 'public/assets/maze', spec.file);
  const { glb, tris, verts } = writeGlb(model, out);
  console.log(`${out}\n  ${verts} verts, ${tris} tris, ${glb.length} bytes`);
}
