/**
 * Authored ejecta block for the ten planet surfaces - the rock you walk into.
 *
 *   node scripts/make-planet-glb.mjs                    # writes the committed file
 *   PLANET_GLB_OUT=/tmp/x.glb node scripts/make-planet-glb.mjs
 *   PLANET_GLB_SPLITS=0 PLANET_GLB_OUT=/tmp/a.glb node scripts/make-planet-glb.mjs
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THIS OBJECT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 9 / decision D4: authored `.glb` hero assets through the pipeline
 * proven six times (`make-newel-glb`, `make-ship-glb`, `make-npc-glb`,
 * `make-beast-glb`, `make-yard-glb`, `make-belt-glb`), procedural systems for
 * bulk content.
 *
 * `boulders` is the most-used prop family in the game: **thirteen fields across
 * nine of the ten planets, 8,880 instances, 177,600 triangles**, which is 44%
 * of all the prop geometry the surfaces draw. Every one of the thirteen fields
 * declares `collide: true`. Every one of the 8,880 is `IcosahedronGeometry(1, 0)`.
 *
 * Photographed on Cinder from seven metres, the largest block measured mean
 * luma 29.4 over its own interior at 87.6% of pixels under 48/255 and a Sobel
 * edge energy of 2.87 - three or four facets across a 1600 px frame, each an
 * unbroken flat value, with a UV seam down the lit one. It reads as masonry.
 *
 * ── What authoring buys, stated honestly ─────────────────────────────────
 *
 * NOT more triangles for their own sake, and NOT a different topology - a
 * rounded fragment IS a displaced sphere and the primitive is right. What
 * twenty regular triangles cannot express:
 *
 *   - **Unequal facets.** A fractured block has a few broad conchoidal faces
 *     and a lot of chipped edge. A regular solid has twenty identical ones,
 *     and that regularity is what the eye reads as "primitive". Eight of the
 *     twenty faces are split into four here and the other twelve are left
 *     alone, so the facet SIZES differ by 4x across one body.
 *   - **Fracture planes.** Two seeded half-space cuts. Ejecta is a fragment:
 *     it came off something, and the faces it came off on are flat and large
 *     and meet the rest on a hard edge. Flattening costs no triangles at all.
 *   - **A silhouette with bays in it.** Three octaves of value noise on the
 *     radius rather than the regular hull, so the outline is not a rounded
 *     polygon - and so the per-instance tumble `buildPropField` already
 *     applies changes the silhouette instead of rotating a symmetry.
 *   - **UVs that are not the polyhedron's.** This is the free half and the
 *     one the shot made obvious. `PolyhedronGeometry` UVs are spherical:
 *     they pinch to a point at the poles and carry a wrap seam, and the prop
 *     material is `stone.castle` at repeat 1.4 with an albedo, a normal and an
 *     ORM map. So the shipped block has a hard vertical join down the middle
 *     of its lit face and its texel density varies by an order of magnitude
 *     across one facet. Every face here gets its OWN UV island, placed at a
 *     seeded offset and scaled to the face's own size, so density is even and
 *     there is no seam anywhere.
 *
 * ── The cost rule, which is the whole design ─────────────────────────────
 *
 * The mesh is named for the PROP KIND it stands in for, and `PlanetProps`
 * substitutes it inside the field's existing `InstancedMesh`. Nothing is added:
 *
 *   no renderable, no instanced mesh, no draw call, no material,
 *   no shader program, no light, no collider.
 *
 * Only triangles move, by `BLOCK_SPLITS * 3` per instance, and the ceiling is
 * `BLOCK_TRI_BUDGET`. That is a stronger position than `make-belt-glb.mjs`
 * could take: it bought a fourth `InstancedMesh` because it wanted hero detail
 * for 44 rocks out of 260 and a bucket carries one geometry. Here every boulder
 * in the game is the same case, so there is nothing to partition.
 *
 * ── Which boulders get it ────────────────────────────────────────────────
 *
 * All of them, and that is the point rather than an omission. `Belt.HERO_RADIUS`
 * existed because the belt's population genuinely split - 44 colliding rocks
 * against 216 pebbles. The equivalent rule here was measured before it was
 * believed: `CONFIG.player.stepHeight` is 0.45 m and `StationAuditMath` states
 * that a body steps over anything shorter, and a boulder's collider stands
 * `0.58 * sy` proud of the ground - so "a boulder you cannot walk over" selects
 * **83% of all 8,880**, which is not a partition. Recorded in the design doc as
 * a costed dead end. The rule that is left is the descriptor's own word for
 * what the thing is, `kind: 'boulders'`, and `planet-assets.test.mjs` asserts
 * the drawn set is the field's whole instance set off a real planet.
 *
 * ── The frame ────────────────────────────────────────────────────────────
 *
 * `buildPropField`'s boulder branch composes every instance as
 *
 *     compose(pos - sink, euler(a*PI, a*2PI, c*PI), (sx, sy, sz))
 *
 * so this geometry is authored on a UNIT sphere - radius 1 means "the block's
 * nominal radius" - and there is NO privileged axis, because the tumble is a
 * full 3-D one. That last point killed the first design: 74.2% of every
 * boulder's triangles are drawn below the terrain (measured on Cinder, 16,330
 * of 22,000), and the obvious answer is to tessellate the visible side densely
 * and cap the buried one - but with a full tumble there IS no fixed buried
 * side. The measurement is in the design doc as a finding; the recovery is not
 * available without changing the placement, which is not an art change.
 */

import * as THREE from 'three';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BLOCK_PART_KEY, BLOCK_SPLITS, BLOCK_TRI_BUDGET, BLOCK_R_MAX, BLOCK_R_MIN,
} from '../src/worlds/planets/PlanetAssets.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* Overridable ONLY so the A/B in the design doc can be re-run at other split
 * counts. The committed file is always `BLOCK_SPLITS`, and the write path below
 * refuses to overwrite the committed path with anything else. */
const SPLITS = process.env.PLANET_GLB_SPLITS !== undefined
  ? Number(process.env.PLANET_GLB_SPLITS)
  : BLOCK_SPLITS;

/* ------------------------------------------------------------------ */
/* Determinism                                                         */
/* ------------------------------------------------------------------ */

/**
 * A 32-bit integer hash, and the reason this file has no `Math.random` in it.
 *
 * The committed `.glb` has to reproduce byte for byte on re-run - that is what
 * `planet-assets.test.mjs` asserts - so every number below comes from a pure
 * function of an integer key. `Math.imul` keeps the multiply 32-bit on a
 * platform whose numbers are doubles.
 */
function hash1(n) {
  let h = n | 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Three-dimensional value noise on an integer lattice, smoothstep-blended. */
function noise3(x, y, z, seed) {
  const xi = Math.floor(x); const yi = Math.floor(y); const zi = Math.floor(z);
  const xf = x - xi; const yf = y - yi; const zf = z - zi;
  const s = (t) => t * t * (3 - 2 * t);
  const u = s(xf); const v = s(yf); const w = s(zf);
  const at = (i, j, k) => hash1(
    Math.imul(i + 1013, 73856093) ^ Math.imul(j + 3571, 19349663) ^ Math.imul(k + 6151, 83492791) ^ seed,
  );
  const lerp = (a, b, t) => a + (b - a) * t;
  const c00 = lerp(at(xi, yi, zi), at(xi + 1, yi, zi), u);
  const c10 = lerp(at(xi, yi + 1, zi), at(xi + 1, yi + 1, zi), u);
  const c01 = lerp(at(xi, yi, zi + 1), at(xi + 1, yi, zi + 1), u);
  const c11 = lerp(at(xi, yi + 1, zi + 1), at(xi + 1, yi + 1, zi + 1), u);
  return lerp(lerp(c00, c10, v), lerp(c01, c11, v), w) * 2 - 1;
}

/**
 * The radial displacement field, in the block's own unit space.
 *
 * THREE OCTAVES, and the number was measured rather than chosen. `PlanetProps`
 * already jitters the SLABS family's eight corners with one octave and that
 * reads as a rectangle with rounded corners, which is the failure this is
 * avoiding. One octave here gave a smooth lumpy potato: the low frequency
 * moves the whole body and nothing distinguishes one facet from its
 * neighbour. The third octave is at a wavelength of about one facet, which is
 * the scale that makes adjacent faces take different light.
 *
 * The amplitude budget is deliberately asymmetric - `-0.30 .. +0.15` about 1.0
 * - because a rock is a thing with bites taken OUT of it. A symmetric field
 * produces bulges, and a bulge on a convex body is invisible; a bay is not.
 */
function radiusAt(x, y, z, seed) {
  let r = 1;
  r += noise3(x * 1.15, y * 1.15, z * 1.15, seed) * 0.155;
  r += noise3(x * 2.7, y * 2.7, z * 2.7, seed + 917) * 0.085;
  r += noise3(x * 5.9, y * 5.9, z * 5.9, seed + 2311) * 0.045;
  /* Bias the whole field inward so the envelope check below has room: the
   * shipped icosahedron reaches exactly 1.0 at its twelve vertices and this
   * must not reach further, or the drawn rock spills further outside its own
   * collider than the one it replaces did. @see BLOCK_R_MAX.
   *
   * 0.88 rather than a normalisation pass. Dividing the finished body by its
   * own worst radius would hold the envelope for ANY seed and any octave
   * change, and it would also mean the shape silently rescales the day one of
   * those moves - so the gate would never fire and the size would drift. A
   * fixed bias with a hard check is the pair that stays honest: at three
   * octaves and this seed the body reaches 0.9864, and if an edit pushes it
   * past 1.0 the generator refuses to write rather than shrinking to fit. */
  return r * 0.88;
}

/* ------------------------------------------------------------------ */
/* The body                                                            */
/* ------------------------------------------------------------------ */

const PHI = (1 + Math.sqrt(5)) / 2;

/**
 * The twelve icosahedron vertices and twenty faces, written out rather than
 * taken from `IcosahedronGeometry`.
 *
 * Not a stylistic choice. `PolyhedronGeometry` hands back a NON-INDEXED buffer
 * with its own spherical UVs and its own vertex order, and this file needs the
 * topology - which faces share which edge - to split eight of the twenty and to
 * check that the result is a closed manifold. Reconstructing an adjacency from
 * a de-indexed soup by welding on a position tolerance is exactly the kind of
 * step that is right until a noise seed puts two vertices inside the tolerance.
 */
function icosahedron() {
  const v = [
    [-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0],
    [0, -1, PHI], [0, 1, PHI], [0, -1, -PHI], [0, 1, -PHI],
    [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1],
  ].map(([x, y, z]) => {
    const n = Math.hypot(x, y, z);
    return [x / n, y / n, z / n];
  });
  const f = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  return { verts: v, faces: f };
}

/**
 * Build the block: displace, split, shear, and hand back flat-shaded triangles.
 *
 * @param {number} splits how many of the twenty faces are subdivided once
 * @param {number} seed
 */
export function buildBlock(splits = SPLITS, seed = 0x51a7c0) {
  if (!Number.isInteger(splits) || splits < 0 || splits > 20) {
    throw new Error(`[make-planet-glb] splits must be an integer 0..20, got ${splits}`);
  }
  const { verts, faces } = icosahedron();

  /* ---- 1. Displace the twelve corner vertices ------------------------
   * Radially, off the noise field, so the hull stops being regular. Keyed on
   * the DIRECTION rather than on the index, so a vertex introduced by a split
   * below lands on the same surface as its neighbours instead of on a
   * different function. */
  const V = verts.map(([x, y, z]) => {
    const r = radiusAt(x, y, z, seed);
    return [x * r, y * r, z * r];
  });

  /* ---- 2. Split `splits` of the twenty faces --------------------------
   *
   * RED-GREEN REFINEMENT, and the green half is not optional.
   *
   * The first version simply split the chosen faces into four and left their
   * neighbours alone, and the closed-manifold gate below caught it before
   * anything shipped: a face split into four introduces a midpoint on each of
   * its three edges, and the unsplit face on the other side of that edge still
   * spans it as one straight run. That is a T-junction. It would be invisible
   * if the midpoint sat exactly on the segment - but it does not, because it is
   * re-projected onto the noise surface, which moves it off the chord by up to
   * a tenth of the radius. So it is a HOLE: a triangular crack you can see the
   * inside of the rock through, on eight faces of every one of 8,880 boulders,
   * with no error anywhere and nothing in the engine that would have said so.
   *
   * The fix is the standard one. A face is RED if it was chosen (split into
   * four on all three midpoints) and GREEN if it merely has to close against a
   * neighbour's midpoints - split into two, three or four depending on how many
   * of its edges carry one.
   *
   * WHICH faces are red is deterministic and it is not "the first eight". A run
   * of consecutive faces in the table above is a connected cap, so splitting
   * the first eight puts every small facet on one side of the body and leaves
   * the other a smooth dome - which photographs as two different rocks
   * depending on how the instance tumbled. Sorted by a hash of the face index
   * instead, which scatters them. */
  const order = faces.map((_, i) => i).sort((a, b) => hash1(a * 7 + 31) - hash1(b * 7 + 31));
  const red = new Set(order.slice(0, splits));

  /* Midpoints are shared between the two faces on an edge, so an edge whose two
   * faces both want one gets the same vertex. Keyed on the edge, low index
   * first. */
  const midOf = new Map();
  const edgeKey = (ia, ib) => (ia < ib ? `${ia}:${ib}` : `${ib}:${ia}`);
  const midpoint = (ia, ib) => {
    const key = edgeKey(ia, ib);
    const had = midOf.get(key);
    if (had !== undefined) return had;
    const a = V[ia]; const b = V[ib];
    const mx = (a[0] + b[0]) / 2; const my = (a[1] + b[1]) / 2; const mz = (a[2] + b[2]) / 2;
    const n = Math.hypot(mx, my, mz) || 1;
    /* Re-projected onto the SAME noise surface the corners came off, so a split
     * face is a chipped region of the body and not a flat panel inside it. This
     * is exactly what makes the green half necessary. */
    const r = radiusAt(mx / n, my / n, mz / n, seed);
    V.push([(mx / n) * r, (my / n) * r, (mz / n) * r]);
    const idx = V.length - 1;
    midOf.set(key, idx);
    return idx;
  };

  // Every edge of every red face gets a midpoint, and both sides then see it.
  const cut = new Set();
  for (const i of red) {
    const [a, b, c] = faces[i];
    for (const [p, q] of [[a, b], [b, c], [c, a]]) { midpoint(p, q); cut.add(edgeKey(p, q)); }
  }

  const tris = [];
  for (let i = 0; i < faces.length; i++) {
    const [a, b, c] = faces[i];
    const eAB = cut.has(edgeKey(a, b));
    const eBC = cut.has(edgeKey(b, c));
    const eCA = cut.has(edgeKey(c, a));
    const n = (eAB ? 1 : 0) + (eBC ? 1 : 0) + (eCA ? 1 : 0);
    if (n === 0) { tris.push([a, b, c]); continue; }
    if (n === 3) {
      const ab = midpoint(a, b); const bc = midpoint(b, c); const ca = midpoint(c, a);
      tris.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
      continue;
    }
    if (n === 1) {
      /* One cut edge: a bisection from the midpoint to the opposite corner.
       * Rotated so the cut edge is always AB, which keeps the winding right
       * without three copies of the same two lines. */
      const [x, y, z] = eAB ? [a, b, c] : (eBC ? [b, c, a] : [c, a, b]);
      const m = midpoint(x, y);
      tris.push([x, m, z], [m, y, z]);
      continue;
    }
    /* Two cut edges. Rotate so the UNCUT edge is ZX; the midpoints are then on
     * XY and YZ. The corner triangle at Y comes off, and the quad X-m1-m2-Z
     * that is left is split on the SHORTER diagonal - the longer one produces
     * a sliver, and a sliver is the triangle that goes degenerate the day a
     * noise octave moves. */
    const [x, y, z] = !eCA ? [a, b, c] : (!eAB ? [b, c, a] : [c, a, b]);
    const m1 = midpoint(x, y); const m2 = midpoint(y, z);
    const d = (p, q) => Math.hypot(V[p][0] - V[q][0], V[p][1] - V[q][1], V[p][2] - V[q][2]);
    tris.push([m1, y, m2]);
    if (d(x, m2) <= d(m1, z)) tris.push([x, m1, m2], [x, m2, z]);
    else tris.push([x, m1, z], [m1, m2, z]);
  }

  /* ---- 3. Two fracture planes ----------------------------------------
   * A half-space cut: every vertex beyond the plane is PROJECTED onto it, which
   * flattens a cap into one broad face without adding or removing a triangle.
   *
   * The offsets are 0.80 and 0.86, and both numbers are a lesson borrowed
   * rather than re-learned. `make-belt-glb.mjs` records that its first
   * fracture planes sat at 0.58-0.74 and each of them sheared a 55-degree cap -
   * a quarter of the whole body - so the lit hemisphere came out as one
   * unbroken plane and read as a smooth disc, "the same defect the 80-triangle
   * rock had, arrived at from the other side". A plane at offset `o` on a unit
   * body shears a cap of half-angle `acos(o)`: 0.80 is 37 degrees, 0.86 is 31.
   * They are also on deliberately non-opposed normals, because two parallel
   * cuts make a slab. */
  const planes = [];
  for (let k = 0; k < 2; k++) {
    const t = hash1(seed + k * 71) * Math.PI * 2;
    const u = hash1(seed + k * 131 + 5) * 1.6 - 0.8;
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    planes.push({ n: [s * Math.cos(t), u, s * Math.sin(t)], o: k === 0 ? 0.80 : 0.86 });
  }
  for (const p of planes) {
    for (let i = 0; i < V.length; i++) {
      const d = V[i][0] * p.n[0] + V[i][1] * p.n[1] + V[i][2] * p.n[2];
      if (d > p.o) {
        const k = d - p.o;
        V[i] = [V[i][0] - p.n[0] * k, V[i][1] - p.n[1] * k, V[i][2] - p.n[2] * k];
      }
    }
  }

  /* ---- 4. Flat shading, and per-face UV islands ----------------------- */
  const pos = []; const nor = []; const uv = []; const idx = [];
  let worstDot = 1;
  let minLen = Infinity;
  for (let t = 0; t < tris.length; t++) {
    const [ia, ib, ic] = tris[t];
    const A = V[ia]; const B = V[ib]; const C = V[ic];
    const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
    const e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const n = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    const len = Math.hypot(n[0], n[1], n[2]);
    minLen = Math.min(minLen, len);
    /* A ZERO-LENGTH NORMAL IS FINITE, VALID glTF AND A NaN THE INSTANT A SHADER
     * NORMALIZES IT, and this material does normalize it - the prop material is
     * `flatShading: false`, so three uses the STORED normals rather than
     * recomputing them per fragment. Nineteen NaN pixels have already blacked
     * out a whole 921,600-pixel frame in this project through the bloom pass.
     * Refused where the triangle is written; `planet-assets.test.mjs` refuses
     * it again in the bytes that ship, which is a different claim. */
    if (!(len > 1e-7)) {
      throw new Error(`[make-planet-glb] triangle ${t} is degenerate (normal length ${len})`);
    }
    n[0] /= len; n[1] /= len; n[2] /= len;

    /* Outward winding, checked per face against the face centroid's own
     * direction. The threshold is generous rather than zero because a fracture
     * plane legitimately leaves faces that lean well away from radial - but a
     * face pointing INTO the body is a hole, and `art-dock` recorded that a
     * backfacing surface reads as ABSENT rather than as wrong. Signed volume
     * checks the same thing globally, in `signedVolume6`. */
    const cx = (A[0] + B[0] + C[0]) / 3;
    const cy = (A[1] + B[1] + C[1]) / 3;
    const cz = (A[2] + B[2] + C[2]) / 3;
    const cl = Math.hypot(cx, cy, cz) || 1;
    worstDot = Math.min(worstDot, (n[0] * cx + n[1] * cy + n[2] * cz) / cl);

    /* PER-FACE UV ISLAND. The face is unwrapped onto its own plane with an
     * orthonormal basis, then dropped at a seeded offset in the tile. The scale
     * is 1:1 with the block's own unit space, so texel density is the SAME on
     * every facet of every boulder in the game whatever the instance scale
     * stretched it to - which is what the spherical UVs it replaces could not
     * do, pinching to a point at the poles and carrying a wrap seam down the
     * front of the lit face. */
    let u0 = [e1[0], e1[1], e1[2]];
    const ul = Math.hypot(u0[0], u0[1], u0[2]) || 1;
    u0 = [u0[0] / ul, u0[1] / ul, u0[2] / ul];
    const v0 = [
      n[1] * u0[2] - n[2] * u0[1],
      n[2] * u0[0] - n[0] * u0[2],
      n[0] * u0[1] - n[1] * u0[0],
    ];
    const ox = hash1(t * 3 + 11 + seed);
    const oy = hash1(t * 3 + 97 + seed);
    const base = pos.length / 3;
    for (const P of [A, B, C]) {
      const dx = P[0] - A[0]; const dy = P[1] - A[1]; const dz = P[2] - A[2];
      pos.push(P[0], P[1], P[2]);
      nor.push(n[0], n[1], n[2]);
      uv.push(
        ox + (dx * u0[0] + dy * u0[1] + dz * u0[2]),
        oy + (dx * v0[0] + dy * v0[1] + dz * v0[2]),
      );
    }
    idx.push(base, base + 1, base + 2);
  }

  return {
    pos, nor, uv, idx, tris: tris.length, worstDot, minNormalLen: minLen,
    /* The topology, kept so the manifold check below reads the same edges the
     * splits were made on rather than re-deriving them from the soup. */
    topology: { verts: V, tris },
  };
}

/* ------------------------------------------------------------------ */
/* Gates the generator applies to itself                               */
/* ------------------------------------------------------------------ */

/** Six times the signed volume. Positive means wound outward. */
export function signedVolume6(t) {
  let s = 0;
  for (let i = 0; i < t.idx.length; i += 3) {
    const a = t.idx[i] * 3; const b = t.idx[i + 1] * 3; const c = t.idx[i + 2] * 3;
    const ax = t.pos[a]; const ay = t.pos[a + 1]; const az = t.pos[a + 2];
    const bx = t.pos[b]; const by = t.pos[b + 1]; const bz = t.pos[b + 2];
    const cx = t.pos[c]; const cy = t.pos[c + 1]; const cz = t.pos[c + 2];
    s += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return s;
}

/**
 * Every directed edge appears exactly once and its reverse exactly once.
 *
 * The closed-manifold check, and it is done on the TOPOLOGY rather than on
 * welded positions - two vertices that a noise seed happened to put within a
 * tolerance of each other would weld into a false pass.
 */
export function unmatchedEdges(t) {
  const seen = new Map();
  for (const [a, b, c] of t.topology.tris) {
    for (const [i, j] of [[a, b], [b, c], [c, a]]) {
      const k = `${i}>${j}`;
      if (seen.has(k)) return { bad: k, why: 'directed edge appears twice' };
      seen.set(k, true);
    }
  }
  for (const k of seen.keys()) {
    const [i, j] = k.split('>');
    if (!seen.has(`${j}>${i}`)) return { bad: k, why: 'no reverse edge' };
  }
  return null;
}

/** Radial extent of the finished body. */
export function radialRange(t) {
  let lo = Infinity; let hi = -Infinity;
  for (let i = 0; i < t.pos.length; i += 3) {
    const r = Math.hypot(t.pos[i], t.pos[i + 1], t.pos[i + 2]);
    if (r < lo) lo = r;
    if (r > hi) hi = r;
  }
  return [lo, hi];
}

/* ------------------------------------------------------------------ */
/* glTF container                                                      */
/* ------------------------------------------------------------------ */

const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

/**
 * No `GLTFExporter`. The exporter is a DOM-shaped module that wants a
 * `FileReader`, and every generator in this repository writes the container by
 * hand for the same reason: a byte-for-byte reproducible file cannot go through
 * a dependency whose output is allowed to change between versions.
 *
 * TEXCOORD_0 IS PRESENT here, unlike `make-belt-glb.mjs`, and that is not a
 * copy that drifted. The belt's material carries no map at all, so UVs there
 * would be twelve kilobytes claiming a texture that does not exist. The prop
 * material on a planet is `stone.castle:1.4` with an albedo, a normal and an
 * ORM map, and a block that arrived without UVs would sample texel (0,0) on
 * every facet - one flat colour across 8,880 rocks and no error anywhere.
 */
function writeGlb(t) {
  const bins = [];
  const bufferViews = [];
  const accessors = [];
  let binOffset = 0;

  const push = (typed, { itemSize, componentType, type, target, withMinMax = false }) => {
    const bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    const pad = (4 - (bytes.length % 4)) % 4;
    bufferViews.push({ buffer: 0, byteOffset: binOffset, byteLength: bytes.length, target });
    bins.push(bytes);
    if (pad) bins.push(Buffer.alloc(pad, 0));
    binOffset += bytes.length + pad;

    const acc = {
      bufferView: bufferViews.length - 1, componentType, count: typed.length / itemSize, type,
    };
    if (withMinMax) {
      const min = new Array(itemSize).fill(Infinity);
      const max = new Array(itemSize).fill(-Infinity);
      for (let i = 0; i < typed.length; i += itemSize) {
        for (let k = 0; k < itemSize; k++) {
          const v = typed[i + k];
          if (v < min[k]) min[k] = v;
          if (v > max[k]) max[k] = v;
        }
      }
      acc.min = min;
      acc.max = max;
    }
    accessors.push(acc);
    return accessors.length - 1;
  };

  const vCount = t.pos.length / 3;
  const posAcc = push(new Float32Array(t.pos), {
    itemSize: 3, componentType: FLOAT, type: 'VEC3', target: ARRAY_BUFFER, withMinMax: true,
  });
  const norAcc = push(new Float32Array(t.nor), {
    itemSize: 3, componentType: FLOAT, type: 'VEC3', target: ARRAY_BUFFER,
  });
  const uvAcc = push(new Float32Array(t.uv), {
    itemSize: 2, componentType: FLOAT, type: 'VEC2', target: ARRAY_BUFFER,
  });
  if (vCount > 65535) throw new Error('[make-planet-glb] too many vertices for a 16-bit index');
  const idxAcc = push(new Uint16Array(t.idx), {
    itemSize: 1, componentType: UNSIGNED_SHORT, type: 'SCALAR', target: ELEMENT_ARRAY_BUFFER,
  });

  const json = {
    asset: {
      version: '2.0',
      generator: 'aether-nexus scripts/make-planet-glb.mjs',
      copyright: 'generated - procedurally authored in this repository, no external source',
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: BLOCK_PART_KEY }],
    meshes: [{
      /* THE MESH NAME IS THE CONTRACT - it is the `geometryFor` prop KIND this
       * part stands in for. `planets/PlanetAssets.js` reads it and discards the
       * glTF material beside it unread. See that file's header for why the name
       * is a kind here and a material key in the yard and the belt. */
      name: BLOCK_PART_KEY,
      primitives: [{
        attributes: { POSITION: posAcc, NORMAL: norAcc, TEXCOORD_0: uvAcc },
        indices: idxAcc, mode: 4, material: 0,
      }],
    }],
    /* A placeholder so the file stands alone in a viewer. The game DISCARDS it
     * and draws the block with the planet's own shared `planet.<id>.rock`. */
    materials: [{
      name: 'ejecta-block-placeholder',
      pbrMetallicRoughness: {
        baseColorFactor: [0.42, 0.39, 0.36, 1], metallicFactor: 0.0, roughnessFactor: 0.95,
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

  return { glb: Buffer.concat([header, jsonHeader, jsonBytes, binHeader, binBytes]), verts: vCount };
}

/**
 * Everything the file claims about itself, computed from the mesh rather than
 * asserted about it. The test reads the same numbers off the committed bytes.
 */
export function blockReport(splits = BLOCK_SPLITS) {
  const t = buildBlock(splits);
  const [rLo, rHi] = radialRange(t);
  return {
    tris: t.tris,
    verts: t.pos.length / 3,
    rLo,
    rHi,
    volume6: signedVolume6(t),
    worstDot: t.worstDot,
    minNormalLen: t.minNormalLen,
    unmatched: unmatchedEdges(t),
  };
}

/** The bytes, so the test can compare without a temporary file. */
export function blockBytes(splits = BLOCK_SPLITS) {
  return writeGlb(buildBlock(splits)).glb;
}

/* ------------------------------------------------------------------ */

/* Guarded so the module can be imported by the test without writing files.
 * The `argv` comparison is the portable half of `import.meta.main`. */
const isMain = path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const t = buildBlock(SPLITS);
  if (SPLITS === BLOCK_SPLITS && t.tris > BLOCK_TRI_BUDGET) {
    throw new Error(`ejecta block is ${t.tris} tris - over the ${BLOCK_TRI_BUDGET} reservation`);
  }
  const [rLo, rHi] = radialRange(t);
  if (!(rHi <= BLOCK_R_MAX)) {
    throw new Error(`ejecta block reaches ${rHi.toFixed(4)} - outside the ${BLOCK_R_MAX} envelope the icosahedron it replaces stays inside`);
  }
  if (!(rLo >= BLOCK_R_MIN)) throw new Error(`ejecta block pinches to ${rLo.toFixed(4)} - under the ${BLOCK_R_MIN} floor`);
  if (!(signedVolume6(t) > 0)) throw new Error('ejecta block is wound inside out - negative signed volume');
  const bad = unmatchedEdges(t);
  if (bad) throw new Error(`ejecta block is not a closed manifold: ${bad.bad} - ${bad.why}`);

  const { glb, verts } = writeGlb(t);
  const committed = path.join(root, 'public/assets/planets', 'ejecta-block.glb');
  const out = process.env.PLANET_GLB_OUT ? path.resolve(process.env.PLANET_GLB_OUT) : committed;
  /* The committed path is only ever written at the published split count, so an
   * A/B run cannot leave an off-budget file in `public/`. */
  if (path.resolve(out) === committed && SPLITS !== BLOCK_SPLITS) {
    throw new Error(`refusing to write the committed file at ${SPLITS} splits - set PLANET_GLB_OUT`);
  }
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, glb);
  console.log(`${out}`);
  console.log(`  ${String(verts).padStart(5)} verts  ${String(t.tris).padStart(5)} tris  ${glb.length} bytes  (${SPLITS} splits)`);
  console.log(`  radius ${rLo.toFixed(4)} .. ${rHi.toFixed(4)}   worst outward dot ${t.worstDot.toFixed(3)}   min |n| ${t.minNormalLen.toExponential(2)}`);
}
