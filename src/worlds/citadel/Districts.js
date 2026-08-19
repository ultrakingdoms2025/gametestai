import * as THREE from 'three';
import { CENTRE, SURFACE, DEFAULT_BAND } from '../lod/DistanceLod.js';
import { HALF } from '../terrain/CitadelHeight.js';

/**
 * SPATIAL PARTITIONING FOR THE CITADEL'S MERGED DISTRICTS.
 *
 * ── The measured problem ──────────────────────────────────────────────────
 *
 * `CitadelWorld`'s `Batch.flush` merges by MATERIAL at build time: one mesh per
 * material key per district, each spanning a whole concentric ring of the town.
 * That is the right call for draw calls and the wrong one for culling, and the
 * numbers say so. Measured headless (2026-08-18) at `HALF = 200`, against the
 * seven positioned `Harness.VIEWS.citadel` framings:
 *
 *   48 meshes, 311,120 triangles, 26.29 MB of attribute bytes.
 *
 *   gate-approach    48 objects drawn,  0 culled   311,120 triangles submitted
 *   gate-spawn       48                 0          311,120
 *   souk-alley       26                22          308,020   (99.0% of the world)
 *   souk-roofs       48                 0          311,120
 *   ward-centre      39                 9          307,544
 *   minaret-bridge   38                10          306,464
 *   desert-overview  48                 0          311,120
 *
 * The twenty-two objects the alley culls are banners, saplings and door leaves:
 * 3,100 triangles between them. Standing in a 29 m alley with a wall 2.9 m away
 * costs 99.0% of what the aerial overview costs. There is nothing wrong with
 * the frustum test - it is working perfectly. There is simply nothing for it to
 * cull, because `cliff:stone.castle` is one 54,432-triangle mesh with a 186.8 m
 * bounding sphere and every camera in the world stands inside it.
 *
 * Every number in this header was taken at both `HALF = 200` and `HALF = 450`,
 * because Drop Three moves it and a figure that only holds at one is a figure
 * that will be wrong next week. Where they differ, both are quoted.
 *
 * ── What this module is, and what it deliberately is not ──────────────────
 *
 * It is NOT the maze's `BatchedMesh` machinery, and porting that here would be
 * a mistake. The maze needed multi-draw because it STREAMS - chunks arrive and
 * leave and the batch has to absorb that without re-merging. Citadel is static.
 * A static world merges by material at build time and then splits by SPACE, and
 * `MedievalWorld.js:7689` states the corollary that keeps getting forgotten:
 * many meshes sharing one material is NOT automatically a batching opportunity.
 * In these worlds it is deliberate spatial partitioning that exists so frustum
 * culling has something to cull. Merging Medieval's five towns into one batch
 * would merge just as well and would then be in frustum from everywhere - which
 * is exactly the state Citadel is in today, arrived at from the other side.
 *
 * Medieval ships the assertion this module inherits
 * (`medieval-towns.test.mjs:583-584`): no mesh may carry a bounding sphere of
 * 130 m or more. That is the number, and it is not arbitrary - it is one town's
 * worth of world, the granularity at which a frustum can hold half a map out.
 *
 * One honest difference. Medieval's version of that assertion runs over
 * `_buildTowns()` alone: five dense districts and no ground. Citadel's group
 * contains its own ground, and ground is where a triangle-budgeted splitter can
 * run out of road - `cliff:dirt.ground` is 3,708 triangles over a 560 m ring at
 * `HALF = 200`, so its last two leaves come to rest at 140.1 m holding 232
 * triangles between them, 0.07% of the world. Bringing those two under the
 * ceiling costs four more draw calls and emits leaves of 24 triangles. The test
 * therefore asserts what is actually guaranteed - 99.5% of triangles inside the
 * ceiling, and every bucket outside it small enough that only the floor stopped
 * it - rather than a blanket claim that would have to be quietly weakened later.
 *
 * ── Order of operations, and why it is not the other one ──────────────────
 *
 * THE SPATIAL SPLIT COMES FIRST, THEN `DistanceLod`. `DistanceLod`'s own header
 * says it "never merges or re-buckets anything", and that its conservative
 * `SURFACE` measure means "a quadrant-sized tree bucket has a 140 m radius, so
 * its nearest point is almost always underfoot and it almost never demotes".
 * Citadel's district spheres run 103-283 m at `HALF = 200` and 103-637 m at
 * `HALF = 450`, and every one of them is centred within about 30 m of the
 * origin. Measured, a hide band on those districts hides NOTHING from any of
 * the six framings a player can stand at, under either measure, at any
 * threshold from 200 m to 450 m. Not a weak optimisation - an inert one. Split
 * first and both culls have something to work on. See `station/Tower.js`
 * :1032-1049 for the same argument made about one building.
 *
 * The two budgets pull against each other and the reader should know it up
 * front: the split costs ZERO extra resident bytes (it is a partition - the
 * same vertices, redistributed), but `DistanceLod` holds a second `lo` geometry
 * per registration, so it REDUCES submitted triangles and ADDS resident bytes.
 * Memory has to be budgeted against post-LOD residency, never pre-LOD.
 *
 * ── The trade, measured at both extents ───────────────────────────────────
 *
 * Splitting is not free and is not always worth it. Every leaf is a draw call,
 * for ever, from every camera; the triangles it saves are saved only from the
 * cameras that happen not to see it. `scripts/tests/citadel-districts.test.mjs`
 * measures the whole curve and pins the crossover. The short version:
 *
 *   TODAY, HALF = 200 (all content inside r = 305)
 *     130 m target   48 -> 74 draws, worst sphere 282.9 -> 140.1 m,
 *                    99.93% of triangles inside the ceiling (was 74.24%),
 *                    mean submitted 309,501 -> 293,549 (94.8%),
 *                    alley 308,020 -> 269,966 (87.6%),
 *                    resident 26.29 -> 26.20 MB.
 *                    614 triangles saved per draw call added.
 *
 *   TODAY, HALF = 450 (the same content, a 900 m terrain sheet under it)
 *     130 m target   48 -> 96 draws, worst sphere 636.8 -> 128.7 m,
 *                    100.00% of triangles inside the ceiling (was 71.33%),
 *                    mean submitted 314,728 -> 290,333 (92.2%),
 *                    alley 312,602 -> 267,710 (85.6%),
 *                    resident 27.40 -> 27.33 MB.
 *                    508 triangles saved per draw call added.
 *
 *   The split is a PARTITION, so it cannot cost bytes: the 0.07 MB it hands
 *   back is the terrain's index dropping to 16 bits once each bucket fits.
 *
 * The exchange rate to judge those against is this project's own shipped
 * granularity: Medieval asserts `draws < 150` against `triangles < 260000`
 * (`medieval-towns.test.mjs:606-607`) and its own comment records ~116 draws
 * for ~177k triangles - 1,500 to 1,733 triangles per draw call. At 508-614,
 * today's split buys BELOW that rate. It is still worth landing, for a reason
 * that is not draw-call arithmetic: it is what makes `DistanceLod` work at all,
 * and the band is where the large win is (the swap band alone takes the aerial
 * overview from 309,846 to 164,404).
 *
 * ── The 5x extent, MODELLED, and the crossover ────────────────────────────
 *
 * Drop Three does not exist yet, so this is a model and is labelled as one.
 * What is real in it: every triangle, every sphere and every frustum test comes
 * from the Citadel that IS built. What is modelled: design 5.2 names seven
 * regions in the ring, so the model is the real mesa plus six clones of its own
 * souk/props/dressing/bridges districts placed on 60 degree bearings at a ring
 * radius that is swept, with the terrain sheet at 900 m. ~1.04M triangles,
 * which brackets the 846k the design quotes.
 *
 * Marginal rate, one merged mesh per material for the whole world, 130 m
 * target, `minLeaf 1500` (the ECONOMICAL floor - see `MIN_LEAF_TRIANGLES`):
 *
 *   ring radius     0    120    200    260    320    380    440
 *   draws          64    131    166    179    203    229    231
 *   mean submitted 1.017M 911k  840k   808k   743k   703k   672k
 *   tri per draw  1,011  1,537  1,678  1,756  1,904  1,851  1,999
 *
 * The curve crosses the shipped 1,500-1,733 band between a ring radius of about
 * 115 m and about 250 m - a content spread of 225-360 m from the origin, a
 * world 450-720 m across. Today's Citadel sits below it and the 5x ring sits
 * well above it, which is exactly what design 5.4 C3 claims and is now measured
 * rather than asserted.
 *
 * ── The result from that sweep worth more than the crossover ──────────────
 *
 * Giving each region its OWN `Batch` beats splitting a global one, at every
 * spread measured, and by a wide margin. At a 440 m ring: per-region batches
 * submit 684,595 triangles for 144 draws; one global batch plus a 130 m split
 * submits 672,458 for 231. Splitting ON TOP of regional batches then buys only
 * 691 triangles per added draw - below the shipped rate again.
 *
 * So the first move at 5x is regional batches, and this module is for what that
 * cannot reach: the ground sheets, the cliff and the curtain wall, which span
 * the map whatever you do with the town standing on them.
 *
 * ── What this module cannot reach, said out loud ──────────────────────────
 *
 * `citadel:tree.crown` is 71,176 triangles - 22.9% of the whole world - in ONE
 * `InstancedMesh` with a 161 m bounding sphere, and it is drawn from
 * everywhere. Nothing here can touch it: an instanced field is split by
 * building it as several fields, which is `MedievalWorld`'s quadrant tree
 * buckets and is a decision in the world's own code. `registerDistricts` does
 * read an instanced mesh's OBJECT sphere (not its geometry's, which describes
 * one palm at the origin), so a distance band on the palm fields works today
 * and is the cheapest single win available; a spatial split of them is the
 * bigger one and belongs to whoever plants them.
 */

/* ------------------------------------------------------------------ */
/* Module scratch. Nothing below allocates inside a loop.              */
/* ------------------------------------------------------------------ */
const _box = new THREE.Box3();
const _v = new THREE.Vector3();
const _ea = new THREE.Vector3();
const _eb = new THREE.Vector3();

/**
 * The ceiling Medieval already ships and this module inherits.
 *
 * `medieval-towns.test.mjs:583-584` asserts `worst < 130` over every mesh in
 * the world group, with the comment "a town mesh has a N m bounding sphere -
 * the districts have been merged". The same assertion is what makes the same
 * claim provable here, so the same number is used rather than a new one
 * invented for the occasion.
 */
export const MAX_DISTRICT_RADIUS = 130;

/**
 * The recursion's floor. NOT an economic threshold - read the difference.
 *
 * The tempting reading of this constant is "the smallest leaf worth a draw
 * call", and the tempting value is the granularity this project already ships:
 * Medieval asserts `draws < 150` against `triangles < 260000` and measures ~116
 * draws for ~177k, so 1,500-1,700 triangles per draw. Setting it there was
 * MEASURED and rejected, and so was 256. Citadel's ground is a low-triangle
 * map-spanning sheet - `cliff:dirt.ground` is 3,708 triangles over a 560 m ring
 * - and a floor expressed in triangles bites hardest on exactly the meshes with
 * the largest spheres in the world. On that ring, split to a 130 m ceiling:
 *
 *   floor 1,500   2 leaves,  worst sphere 251.8 m   ceiling missed
 *   floor   256   8 leaves,  worst sphere 152.1 m   ceiling missed
 *   floor   108  16 leaves,  worst sphere 106.9 m   ceiling met
 *
 * So the ceiling is the contract and this is only what stops the recursion
 * shaving props. 108 is one bevelled box: `Batch.box` builds a
 * `RoundedBoxGeometry` for anything clearing `BEVEL_MIN`, and CitadelWorld's
 * own comment records that as "108 triangles against a plain one's 12". A leaf
 * smaller than a single souk lintel is not a district by any reading.
 *
 * The economics did not disappear, they moved to the caller, with numbers
 * attached. Measured on the built world at `HALF = 450`, 130 m target:
 *
 *   minLeaf 1500   70 draws, worst 253.3 m, 20,115 triangles never culling
 *                  925 triangles saved per added draw call
 *   minLeaf  108   96 draws, worst 128.7 m, nothing over the ceiling
 *                  508 triangles saved per added draw call
 *
 * And in the 5x model the same choice is the difference between 231 draws
 * buying at 1,999 triangles each and 585 buying at 763. So a world that wants
 * only the cheap half of the deal raises `minLeaf`, and gets told in the test
 * output exactly which sheets it left behind and how many triangles they are.
 */
export const MIN_LEAF_TRIANGLES = 108;

/* ================================================================== */
/* Triangle-level geometry surgery                                     */
/* ================================================================== */

/**
 * Triangle count the way a draw call counts it.
 * @param {THREE.BufferGeometry} geo
 * @returns {number}
 */
export function triangleCount(geo) {
  if (!geo) return 0;
  const n = geo.index ? geo.index.count : (geo.attributes?.position?.count ?? 0);
  return Math.floor(n / 3);
}

/**
 * Resident attribute bytes for one geometry.
 *
 * Every attribute array plus the index, because that is what is uploaded and
 * what the C2 budget is written against. Callers walking a scene must
 * de-duplicate by geometry identity first - a shared `lo` is one buffer however
 * many meshes point at it.
 *
 * @param {THREE.BufferGeometry} geo
 * @returns {number}
 */
export function geometryBytes(geo) {
  if (!geo) return 0;
  let b = 0;
  for (const k of Object.keys(geo.attributes)) {
    const a = geo.attributes[k];
    if (a?.array) b += a.array.byteLength;
  }
  if (geo.index?.array) b += geo.index.array.byteLength;
  return b;
}

/**
 * The sphere `computeBoundingSphere` would produce for a subset of triangles,
 * computed without building the geometry first.
 *
 * It has to agree with three's definition exactly or the recursion below stops
 * one level too early and ships a mesh over the ceiling. Three takes the
 * BOUNDING BOX centre - not the centroid, and not a minimal enclosing sphere -
 * and then the greatest vertex distance from it (`BufferGeometry.js:718-790`).
 * That is what this reproduces, and it leaves `_box` holding the range's box so
 * the caller can pick a split axis from it without a second pass.
 *
 * @param {ArrayLike<number>} pos flat xyz vertex positions
 * @param {Uint32Array} verts vertex ids in emission order, three per triangle
 * @param {number} from first triangle slot in the range
 * @param {number} to one past the last
 * @param {THREE.Sphere} out
 * @returns {THREE.Sphere} `out`
 */
function sphereOfRange(pos, verts, from, to, out) {
  /* Raw arithmetic rather than `Box3.expandByPoint` and `distanceToSquared`.
   * This is the hot loop - it runs over every vertex of every node at every
   * level of the recursion - and the three-vector call pairs measured a third
   * of the whole module's build cost on the 54,432-triangle cliff. */
  let x0 = Infinity; let y0 = Infinity; let z0 = Infinity;
  let x1 = -Infinity; let y1 = -Infinity; let z1 = -Infinity;
  for (let i = from * 3; i < to * 3; i++) {
    const v = verts[i] * 3;
    const x = pos[v]; const y = pos[v + 1]; const z = pos[v + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  const cxx = (x0 + x1) * 0.5;
  const cyy = (y0 + y1) * 0.5;
  const czz = (z0 + z1) * 0.5;
  let maxSq = 0;
  for (let i = from * 3; i < to * 3; i++) {
    const v = verts[i] * 3;
    const dx = pos[v] - cxx; const dy = pos[v + 1] - cyy; const dz = pos[v + 2] - czz;
    const d = dx * dx + dy * dy + dz * dz;
    if (d > maxSq) maxSq = d;
  }
  _box.min.set(x0, y0, z0);
  _box.max.set(x1, y1, z1);
  out.center.set(cxx, cyy, czz);
  out.radius = Math.sqrt(maxSq);
  return out;
}

/**
 * Build one sub-geometry from a contiguous run of the triangle order.
 *
 * Indexed input keeps its index: used vertices are collected, compacted and
 * renumbered, so a bucket carries only the vertices its own triangles touch
 * plus whatever duplication the cut line forces. Sharing the parent's
 * attributes and handing each bucket its own index would have been cheaper
 * still and is a trap - `computeBoundingSphere` walks the whole POSITION
 * attribute and ignores the index, so every bucket would report the parent's
 * sphere and nothing would ever cull. That is the bug this module exists to
 * fix, reintroduced one layer down.
 *
 * Non-indexed input (everything `Batch.flush` produces) is a straight
 * redistribution: three fresh vertices per triangle, exactly as before, so the
 * byte total across the leaves equals the byte total of the input.
 *
 * @param {THREE.BufferGeometry} geo source, read only
 * @param {Uint32Array} verts vertex ids, three per triangle
 * @param {number} from first triangle slot
 * @param {number} to one past the last
 * @returns {THREE.BufferGeometry}
 */
function buildSub(geo, verts, from, to) {
  const src = geo.attributes;
  const keys = Object.keys(src);
  const tris = to - from;
  const out = new THREE.BufferGeometry();

  if (!geo.index) {
    for (const k of keys) {
      const a = src[k];
      const it = a.itemSize;
      const dst = new a.array.constructor(tris * 3 * it);
      const arr = a.array;
      const n = tris * 3;
      /* Specialised by item size. Every attribute in this world is a vec3 or a
       * vec2 - position, normal, colour, uv - and the generic inner loop over
       * `itemSize` measured a third of `buildSub` on the 54,432-triangle
       * cliff, for a loop that always runs two or three times. */
      if (it === 3) {
        for (let t = 0; t < n; t++) {
          const s = verts[from * 3 + t] * 3;
          const d = t * 3;
          dst[d] = arr[s]; dst[d + 1] = arr[s + 1]; dst[d + 2] = arr[s + 2];
        }
      } else if (it === 2) {
        for (let t = 0; t < n; t++) {
          const s = verts[from * 3 + t] * 2;
          const d = t * 2;
          dst[d] = arr[s]; dst[d + 1] = arr[s + 1];
        }
      } else {
        for (let t = 0; t < n; t++) {
          const s = verts[from * 3 + t] * it;
          const d = t * it;
          for (let i = 0; i < it; i++) dst[d + i] = arr[s + i];
        }
      }
      out.setAttribute(k, new THREE.BufferAttribute(dst, it, a.normalized));
    }
    return out;
  }

  /* Indexed: compact the used vertices, then renumber.
   *
   * A `Map` keyed by vertex id is the obvious spelling and measured 21.9 ms on
   * the terrain sheet's 55,296 index entries. A dense `Int32Array` of -1 is
   * one allocation per bucket and a plain array read per entry. */
  const vertexCount = src.position.count;
  const remap = new Int32Array(vertexCount).fill(-1);
  const used = [];
  const idx = new Uint32Array(tris * 3);
  for (let t = 0; t < tris * 3; t++) {
    const v = verts[from * 3 + t];
    let n = remap[v];
    if (n < 0) { n = used.length; remap[v] = n; used.push(v); }
    idx[t] = n;
  }
  for (const k of keys) {
    const a = src[k];
    const it = a.itemSize;
    const dst = new a.array.constructor(used.length * it);
    for (let n = 0; n < used.length; n++) {
      const s = used[n] * it;
      const d = n * it;
      for (let i = 0; i < it; i++) dst[d + i] = a.array[s + i];
    }
    out.setAttribute(k, new THREE.BufferAttribute(dst, it, a.normalized));
  }
  /* 16-bit where it fits: a terrain bucket is a few thousand vertices and
   * paying 32 bits an index for it would hand back a slice of what the split
   * just saved. */
  out.setIndex(used.length > 65535
    ? new THREE.BufferAttribute(idx, 1)
    : new THREE.BufferAttribute(Uint16Array.from(idx), 1));
  return out;
}

/**
 * Split one geometry into buckets whose bounding spheres are all under
 * `maxRadius`.
 *
 * ── Why a median KD split and not a grid ──────────────────────────────────
 *
 * A fixed grid is the obvious answer and it is the expensive one. Citadel's
 * content is a set of concentric RINGS: a grid fine enough to bring the cliff's
 * 186.8 m sphere under 130 m also cuts the souk - which is already under it -
 * into cells that are mostly empty, and every occupied cell is a draw call
 * whether it holds a district or forty triangles of window trim.
 *
 * Recursive median splitting on the longest axis of the CURRENT bucket adapts
 * to whatever shape the content actually has, and - the part that matters - it
 * STOPS. The recursion asks "is this bucket already under the ceiling" before
 * every cut, so a district that is small enough is returned untouched and costs
 * exactly the one draw call it costs today.
 *
 * ── Where it stops, and why each stop is there ────────────────────────────
 *
 *  - radius already under `maxRadius`: nothing to buy.
 *  - fewer than `2 * minLeaf` triangles: either half would be finer-grained
 *    than the geometry this project already ships (see `MIN_LEAF_TRIANGLES`).
 *  - the median cut puts every triangle on one side: degenerate input (all
 *    centroids coincident on the chosen axis); splitting again would recurse
 *    for ever.
 *
 * The stops mean the ceiling is a TARGET, not a guarantee: a single 400 m
 * triangle cannot be split and this returns it. The caller asserts the achieved
 * worst radius rather than assuming it, which is also how the test
 * distinguishes "the splitter did not fire" from "the splitter could not".
 *
 * Determinism: the sort key is `(axis coordinate, triangle id)` and leaves are
 * emitted depth-first, low side first, so two builds of the same world produce
 * identical buckets in the same order.
 *
 * @param {THREE.BufferGeometry} geo read only; not disposed
 * @param {{maxRadius?:number, minLeaf?:number}} [opts]
 * @returns {THREE.BufferGeometry[]} exactly `[geo]`, by identity, when no split
 *   was warranted - so a caller can test identity to find out whether it fired
 */
export function splitGeometry(geo, opts = {}) {
  const maxRadius = opts.maxRadius ?? MAX_DISTRICT_RADIUS;
  const minLeaf = opts.minLeaf ?? MIN_LEAF_TRIANGLES;
  const posA = geo?.attributes?.position;
  if (!posA) return [geo];
  const pos = posA.array;
  const tris = triangleCount(geo);
  if (tris < 2) return [geo];

  /* Vertex ids, three per triangle. */
  const verts = new Uint32Array(tris * 3);
  if (geo.index) {
    const ia = geo.index.array;
    for (let i = 0; i < tris * 3; i++) verts[i] = ia[i];
  } else {
    for (let i = 0; i < tris * 3; i++) verts[i] = i;
  }

  /* Centroids, computed once. The split key is the centroid, so a triangle
   * lands wholly in one bucket and no geometry is duplicated or lost. */
  const cx = new Float32Array(tris);
  const cy = new Float32Array(tris);
  const cz = new Float32Array(tris);
  for (let t = 0; t < tris; t++) {
    let x = 0; let y = 0; let z = 0;
    for (let k = 0; k < 3; k++) {
      const v = verts[t * 3 + k] * 3;
      x += pos[v]; y += pos[v + 1]; z += pos[v + 2];
    }
    cx[t] = x / 3; cy[t] = y / 3; cz[t] = z / 3;
  }

  /* `order[i]` is the triangle currently at slot i. The recursion sorts
   * sub-ranges of this and never moves vertex data until a leaf is emitted. */
  const order = new Uint32Array(tris);
  for (let t = 0; t < tris; t++) order[t] = t;

  /* Vertex ids in slot order, kept in step with `order` so `sphereOfRange` and
   * `buildSub` can both read a range without indirecting through it. */
  const slots = new Uint32Array(tris * 3);
  const syncSlots = (from, to) => {
    for (let i = from; i < to; i++) {
      const t = order[i];
      slots[i * 3] = verts[t * 3];
      slots[i * 3 + 1] = verts[t * 3 + 1];
      slots[i * 3 + 2] = verts[t * 3 + 2];
    }
  };
  syncSlots(0, tris);

  const sphere = new THREE.Sphere();
  const ranges = [];

  /* Median selection, not a sort.
   *
   * The recursion only needs `order[from..mid)` to hold the low half - it does
   * not care what order they are in - and a full comparator sort at every node
   * is what makes this expensive. `cliff:stone.castle` is 54,432 triangles and
   * sorting it at each of five levels measured 50.7 ms, against a 24 ms slice
   * budget (design 5.4, C5). Quickselect is linear per node.
   *
   * The comparison breaks ties on triangle id, which makes it a STRICT total
   * order: no two triangles ever compare equal, so the partition cannot
   * degenerate on repeated coordinates - which merged box geometry is full of,
   * every face of a wall sharing one plane - and the emitted order is a
   * function of the input alone. That is what makes two builds byte-identical.
   */
  const before = (axis, a, b) => (axis[a] < axis[b] || (axis[a] === axis[b] && a < b));
  const select = (axis, from, to, k) => {
    let lo = from;
    let hi = to - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      /* Median-of-three, by index, so the pivot is deterministic. */
      if (before(axis, order[hi], order[lo])) { const t = order[lo]; order[lo] = order[hi]; order[hi] = t; }
      if (before(axis, order[mid], order[lo])) { const t = order[lo]; order[lo] = order[mid]; order[mid] = t; }
      if (before(axis, order[hi], order[mid])) { const t = order[mid]; order[mid] = order[hi]; order[hi] = t; }
      const p = order[mid];
      let i = lo - 1;
      let j = hi + 1;
      for (;;) {
        do { i++; } while (before(axis, order[i], p));
        do { j--; } while (before(axis, p, order[j]));
        if (i >= j) break;
        const t = order[i]; order[i] = order[j]; order[j] = t;
      }
      if (k <= j) hi = j; else lo = j + 1;
    }
  };

  const recurse = (from, to) => {
    sphereOfRange(pos, slots, from, to, sphere);
    const n = to - from;
    if (sphere.radius < maxRadius || n < minLeaf * 2) { ranges.push([from, to]); return; }

    /* Longest axis of this bucket's own box - `sphereOfRange` just filled it. */
    _box.getSize(_v);
    const axis = _v.x >= _v.y && _v.x >= _v.z ? cx : (_v.y >= _v.z ? cy : cz);

    /* Every centroid at the same coordinate on the longest axis: the cut is
     * spatially meaningless, so it would halve the triangle count without
     * shrinking either sphere, all the way down to `minLeaf`. Degenerate input
     * (one enormous quad, say) rather than an impossible one, so it stops here
     * and lets the caller see a bucket over the ceiling instead of paying for
     * a dozen leaves that are all the size of the parent. */
    let same = true;
    for (let i = from + 1; i < to; i++) {
      if (axis[order[i]] !== axis[order[from]]) { same = false; break; }
    }
    if (same) { ranges.push([from, to]); return; }

    const mid = from + (n >> 1);
    select(axis, from, to, mid);
    syncSlots(from, to);
    recurse(from, mid);
    recurse(mid, to);
  };
  recurse(0, tris);

  if (ranges.length === 1) return [geo];

  const out = [];
  for (const [from, to] of ranges) out.push(buildSub(geo, slots, from, to));
  return out;
}

/**
 * Split one mesh in place: the leaves replace it in its parent, wearing the
 * same material, shadow flags, layers and transform.
 *
 * The original geometry is disposed, because it is a partition - every triangle
 * of it now lives in a leaf, and keeping the parent resident would double the
 * district's bytes to buy nothing. A caller that wants the original kept should
 * call `splitGeometry` and place the results itself.
 *
 * Names are `parent#0`, `parent#1`, ... in emission order, which is stable
 * across builds and keeps `walkWorldTriangles`' `byName` breakdown readable:
 * the district still groups by its prefix.
 *
 * @param {THREE.Mesh} mesh
 * @param {{maxRadius?:number, minLeaf?:number}} [opts]
 * @returns {THREE.Mesh[]} `[mesh]` unchanged when no split was warranted
 */
export function splitMesh(mesh, opts = {}) {
  if (!mesh?.isMesh || mesh.isInstancedMesh || mesh.isBatchedMesh) return [mesh];
  const parts = splitGeometry(mesh.geometry, opts);
  if (parts.length === 1 && parts[0] === mesh.geometry) return [mesh];

  const parent = mesh.parent;
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const m = new THREE.Mesh(parts[i], mesh.material);
    m.name = `${mesh.name}#${i}`;
    m.castShadow = mesh.castShadow;
    m.receiveShadow = mesh.receiveShadow;
    m.renderOrder = mesh.renderOrder;
    m.frustumCulled = mesh.frustumCulled;
    m.layers.mask = mesh.layers.mask;
    m.position.copy(mesh.position);
    m.quaternion.copy(mesh.quaternion);
    m.scale.copy(mesh.scale);
    m.geometry.computeBoundingSphere();
    m.geometry.computeBoundingBox();
    if (parent) parent.add(m);
    out.push(m);
  }
  if (parent) parent.remove(mesh);
  mesh.geometry.dispose();
  return out;
}

/**
 * Split every mesh handed over, in place.
 *
 * The intended call site is immediately after `Batch.flush`, which already
 * returns exactly this array:
 *
 *   const meshes = splitDistricts(B.flush(this.group, k => this._mat(k), 'souk'));
 *
 * Meshes that opt out of frustum culling are returned untouched. A sky dome has
 * `frustumCulled = false` because it is drawn from everywhere by design, and
 * cutting a 900 m sphere into eight smaller ones would add seven draw calls to
 * make a promise the renderer has been told to ignore.
 *
 * ── Smallest first, and it is not tidiness ────────────────────────────────
 *
 * The work is done in ascending triangle order because that is what keeps the
 * biggest district inside design 5.4's 24 ms slice budget. Measured cold, on a
 * fresh process, one mesh at a time:
 *
 *   in the order the world emits them   cliff 32.5 ms, terrain 21.7 ms
 *   smallest first                      cliff 18.2 ms, terrain 13.2 ms
 *
 * Nothing about the algorithm changed. The first district through pays for
 * compiling `sphereOfRange`, `select` and `buildSub`, and paying that on a
 * 96-triangle banner instead of on the 54,432-triangle cliff is the whole
 * difference between the worst slice fitting the budget and missing it. Warm,
 * both orders converge (cliff 12.1 ms); cold is the number that ships, because
 * a world builds once.
 *
 * The order is still fully determined - ascending triangles, ties broken by
 * the caller's own order - so two builds produce the same graph.
 *
 * @param {THREE.Mesh[]} meshes
 * @param {{maxRadius?:number, minLeaf?:number}} [opts]
 * @returns {THREE.Mesh[]} the flattened result, split and unsplit together
 */
export function splitDistricts(meshes, opts = {}) {
  const order = meshes.map((m, i) => ({ m, i, t: triangleCount(m?.geometry) }));
  order.sort((a, b) => (a.t - b.t) || (a.i - b.i));
  const out = [];
  for (const { m } of order) {
    if (m?.frustumCulled === false) { out.push(m); continue; }
    for (const part of splitMesh(m, opts)) out.push(part);
  }
  return out;
}

/* ================================================================== */
/* Low detail                                                          */
/* ================================================================== */

/**
 * A cheaper geometry for a merged district, by dropping the triangles that are
 * too small to be seen from the distance the swap happens at.
 *
 * ── Why an area filter is the right decimator for THIS content ────────────
 *
 * Everything in a Citadel district is a box, and `Batch.box` rounds every box
 * whose smallest dimension clears `BEVEL_MIN = 0.55 m` with a
 * `RoundedBoxGeometry`. That is 108 triangles against a plain box's 12, and the
 * ratio is not spread evenly: six face quads are 12 of the 108 and carry
 * effectively all of the surface area, while the other 96 are bevel strips and
 * corner patches a few centimetres across. An area threshold therefore
 * separates "the shape" from "the rounding" on this content without needing to
 * recover which triangle belonged to which box, which merged non-indexed soup
 * cannot tell you.
 *
 * ── The honest caveat ─────────────────────────────────────────────────────
 *
 * Dropping a bevel strip leaves a slit where two faces no longer meet, and a
 * slit shows background through a solid box. The slit is at most `BEVEL` wide -
 * 0.075 m - so the swap distance has to be one where 0.075 m is under a pixel,
 * and `citadel-districts.test.mjs` asserts that rather than assuming it. It is
 * why this is not applied by default and why the caller passes the threshold: a
 * band chosen for triangle count rather than for pixels ships a shimmering
 * outline on every silhouette in the world.
 *
 * @param {THREE.BufferGeometry} geo
 * @param {{minArea?:number}} [opts] `minArea` in square metres
 * @returns {{geometry:THREE.BufferGeometry, kept:number, dropped:number}|null}
 *   null when nothing was dropped - there is no point registering a `lo` that
 *   is a copy of the `hi`, and `DistanceLod` would hold both.
 */
export function lowDetail(geo, opts = {}) {
  const minArea = opts.minArea ?? 0.5;
  const posA = geo?.attributes?.position;
  if (!posA) return null;
  const pos = posA.array;
  const tris = triangleCount(geo);
  const idx = geo.index?.array ?? null;

  const keep = new Uint32Array(tris * 3);
  let kept = 0;
  for (let t = 0; t < tris; t++) {
    const a = idx ? idx[t * 3] : t * 3;
    const b = idx ? idx[t * 3 + 1] : t * 3 + 1;
    const c = idx ? idx[t * 3 + 2] : t * 3 + 2;
    const i0 = a * 3; const i1 = b * 3; const i2 = c * 3;
    _ea.set(pos[i1] - pos[i0], pos[i1 + 1] - pos[i0 + 1], pos[i1 + 2] - pos[i0 + 2]);
    _eb.set(pos[i2] - pos[i0], pos[i2 + 1] - pos[i0 + 1], pos[i2 + 2] - pos[i0 + 2]);
    if (_ea.cross(_eb).length() * 0.5 < minArea) continue;
    keep[kept * 3] = a;
    keep[kept * 3 + 1] = b;
    keep[kept * 3 + 2] = c;
    kept++;
  }
  if (kept === tris || kept === 0) return null;
  const geometry = buildSub(geo, keep, 0, kept);
  geometry.computeBoundingSphere();
  return { geometry, kept, dropped: tris - kept };
}

/* ================================================================== */
/* DistanceLod registration                                            */
/* ================================================================== */

/**
 * Can this band ever change state, from anywhere a camera can stand?
 *
 * The failure this catches is silent: a band whose threshold no camera can
 * exceed is dead code that reads as a working optimisation, and the only
 * symptom is a frame cost nobody can explain. `station/Tower.js:1032-1049`
 * works the same sum by hand for one building and concludes that `SURFACE` on
 * it is "a true statement about the sphere and a useless one about the
 * building".
 *
 * `reach` is how far a camera can get from the world origin, so the furthest a
 * camera can be from a sphere centred at `c` is `reach + |c|`, and under
 * `SURFACE` the measured distance is that minus the radius.
 *
 * `reach` IS NOT `HALF`, and passing `HALF` was a shipped defect. `HALF` is the
 * half-EDGE of a square playfield; the locus a camera can stand on is that
 * whole square, whose furthest point from the origin is the corner at
 * `HALF * sqrt(2)`. Citadel passed `HALF` at both of its call sites and
 * understated every `furthest` by 186 m, which refused two live terrain bands.
 * The default below is the corner for the same reason.
 *
 * @param {THREE.Sphere} sphere world-space
 * @param {number} threshold metres; `Infinity` is a disabled band, not a dead one
 * @param {string} measure `CENTRE` or `SURFACE`
 * @param {number} reach metres from the origin a camera can reach
 * @returns {boolean}
 */
export function bandCanFire(sphere, threshold, measure, reach) {
  if (!Number.isFinite(threshold)) return true;
  if (!sphere) return false;
  const centreDist = sphere.center.length() + reach;
  const furthest = measure === SURFACE ? Math.max(0, centreDist - sphere.radius) : centreDist;
  return furthest > threshold;
}

/**
 * The world-space bounding sphere `DistanceLod` will actually measure against.
 *
 * It has to be read the same way `DistanceLod.add` reads it or every threshold
 * computed from it is wrong. An `InstancedMesh` carries its own sphere on the
 * OBJECT - it has to, it spans all instances - and its geometry's sphere covers
 * one instance sitting at the origin. Citadel's 41 date palms are exactly that:
 * a 4.3 m crown geometry on an object that spans the whole souk. Taking the
 * geometry's sphere would put a band 100 m closer than intended and would make
 * the nearest-point conversion below meaningless.
 *
 * @param {THREE.Mesh|THREE.InstancedMesh} mesh
 * @returns {THREE.Sphere|null}
 */
export function sourceSphere(mesh) {
  if (!mesh) return null;
  if (mesh.isInstancedMesh) {
    if (!mesh.boundingSphere) mesh.computeBoundingSphere();
    return mesh.boundingSphere;
  }
  const g = mesh.geometry;
  if (!g) return null;
  if (!g.boundingSphere) g.computeBoundingSphere();
  return g.boundingSphere;
}

/**
 * The camera distance at which a feature `metres` across covers one pixel.
 *
 * Used to choose a swap band that can be defended rather than argued about.
 * Vertical field of view and a reference height, because that pair is what a
 * projection matrix actually contains; 1080 lines is the reference this project
 * measures against and `CONFIG.render.fov` is 75.
 *
 * At 75 degrees and 1080 lines, one pixel subtends `d * 0.001421` metres, so
 * `BEVEL`'s 0.075 m slit disappears at 52.8 m.
 *
 * @param {number} metres feature size
 * @param {number} [fovDeg] vertical fov
 * @param {number} [pixels] vertical resolution
 * @returns {number} metres
 */
export function subPixelDistance(metres, fovDeg = 75, pixels = 1080) {
  const perMetre = pixels / (2 * Math.tan((fovDeg * Math.PI) / 360));
  return metres * perMetre;
}

/**
 * Register split district meshes with a `DistanceLod`.
 *
 * ── Everything here measures to `CENTRE`, and that is not a shortcut ──────
 *
 * `SURFACE` is `DistanceLod`'s own default and its own header calls it "the one
 * to reach for by default" - right for the objects it was written for, wrong
 * for these. It measures to the nearest point of the sphere, so a bucket of
 * radius r only demotes once the camera is `threshold + r` from its centre.
 * Measured over the seven positioned `VIEWS.citadel` framings, meshes hidden
 * per framing by a `hideBeyond 260` band under each measure:
 *
 *   UNSPLIT, 43 merged districts (spheres 103-637 m, all centred near the
 *   origin - the state this module exists to end)
 *     CENTRE   0 0 0 0 0 0 6      SURFACE   0 0 0 0 0 0 6
 *   Zero, from all six framings a player can stand at, under either measure -
 *   and the same at 200, 320 and 450. The only framing that hides anything is
 *   the aerial overview. `DistanceLod` on merged districts is not a weak
 *   optimisation, it is an inert one, and that is the whole of the "split
 *   first, then LOD" argument, measured.
 *
 *   SPLIT
 *     HALF 200, 69 buckets   CENTRE  9  5  7  7  2  2 23   SURFACE  3 2 2 2 0 0 15
 *     HALF 450, 91 buckets   CENTRE 32 29 29 29 26 28 43   SURFACE 16 14 14 14 14 16 29
 *   Both measures work once there is something to work on, and CENTRE fires on
 *   1.5x to 4x as many buckets at the same nominal distance.
 *
 * That is `station/Tower.js:1032-1049`'s argument, reproduced at district
 * scale: measured to the centre, the band is a plain "how far is the player
 * from this district", which is the question actually being asked.
 *
 * ── But the SWAP band is a claim about triangles, not about districts ─────
 *
 * A hide band asks about the district as a whole; a `lo` swap drops detail that
 * is nearest-point detail, so the honest threshold for it is a nearest-point
 * one. Rather than register a second measure, note that for a static mesh the
 * two are EXACTLY interchangeable - `SURFACE` distance is `CENTRE` distance
 * minus a constant radius - so `swapNearest` is taken as a nearest-point
 * distance and converted per mesh into the `CENTRE` threshold that means the
 * same thing. `citadel-districts.test.mjs` proves the identity rather than
 * asserting it. The alternative, `measure: SURFACE` on the entry, would have
 * been correct and would also have applied to the hide band on the same entry,
 * which is the failure above.
 *
 * `bandCanFire` then refuses any band that cannot change state from anywhere
 * inside `reach`, rather than registering a dead one. A refused band is
 * reported, not thrown - a world that lost its LOD should still build - and the
 * report is what the test asserts against.
 *
 * @param {import('../lod/DistanceLod.js').DistanceLod} lod
 * @param {THREE.Mesh[]} meshes
 * @param {{hideBeyond?:number, swapNearest?:number, band?:number, reach?:number,
 *          lo?:(geo:THREE.BufferGeometry)=>THREE.BufferGeometry|null}} [opts]
 *   `hideBeyond` is metres from the district CENTRE; `swapNearest` is metres
 *   from its NEAREST POINT.
 * @returns {{registered:number, skipped:number, loBytes:number, reasons:string[]}}
 */
export function registerDistricts(lod, meshes, opts = {}) {
  const band = opts.band ?? DEFAULT_BAND;
  const reach = opts.reach ?? HALF * Math.SQRT2;
  const hideBeyond = opts.hideBeyond ?? Infinity;
  const swapNearest = opts.swapNearest ?? Infinity;
  const result = { registered: 0, skipped: 0, loBytes: 0, reasons: [] };
  if (!lod) return result;

  for (const mesh of meshes) {
    if (!mesh?.isMesh || mesh.frustumCulled === false) { result.skipped++; continue; }
    const geo = mesh.geometry;
    const sphere = sourceSphere(mesh);
    if (!sphere) { result.skipped++; continue; }
    /* The conversion the header describes: nearest-point D is centre D + r. */
    const swapBeyond = Number.isFinite(swapNearest) ? swapNearest + sphere.radius : Infinity;

    const hideLive = bandCanFire(sphere, hideBeyond, CENTRE, reach);
    const swapLive = bandCanFire(sphere, swapBeyond, CENTRE, reach);
    if (!hideLive) {
      result.reasons.push(
        `${mesh.name}: hideBeyond ${hideBeyond} can never fire (r ${sphere.radius.toFixed(1)})`);
    }
    if (!swapLive && Number.isFinite(swapBeyond)) {
      result.reasons.push(
        `${mesh.name}: swapNearest ${swapNearest} can never fire (r ${sphere.radius.toFixed(1)})`);
    }

    let lo = null;
    if (swapLive && opts.lo) {
      lo = opts.lo(geo) ?? null;
      if (lo) result.loBytes += geometryBytes(lo);
    }
    const hide = hideLive ? hideBeyond : Infinity;
    if (!Number.isFinite(hide) && !lo) { result.skipped++; continue; }
    lod.add(mesh, {
      measure: CENTRE,
      band,
      hideBeyond: hide,
      ...(lo ? { lo, swapBeyond } : {}),
    });
    result.registered++;
  }
  return result;
}

/* ================================================================== */
/* Reporting                                                           */
/* ================================================================== */

/**
 * What a scene graph costs, deterministically.
 *
 * Deliberately NOT `renderer.info`: `src/dev/WorldTriangles.js` records that
 * frame totals move 10-13% between loads of an identical framing, and two
 * agents lost an afternoon each to that variance. Geometry identity is
 * de-duplicated for bytes and not for triangles, because two meshes sharing one
 * buffer upload it once and submit it twice.
 *
 * `over` collects the meshes at or above the ceiling so a failure can name
 * them. Two categories are excluded from the radius test, both for the same
 * reason `splitDistricts` excludes them from the split:
 *
 *  - `frustumCulled === false`. The sky dome is drawn from everywhere by
 *    design; a sphere is not a claim about it.
 *  - `InstancedMesh`. Citadel's 62 date palms are two instanced fields whose
 *    OBJECT spheres are 137.4 m and 71.2 m - true statements about the fields,
 *    and nothing this module can act on: an instanced field is split by
 *    building it as several fields, which is `MedievalWorld`'s quadrant tree
 *    buckets and is an authoring decision in the world, not surgery on a mesh.
 *    They are reported in `instanced` rather than silently dropped, because a
 *    metric that quietly stops counting the largest thing in the world is worse
 *    than one that fails.
 *
 * @param {THREE.Object3D} root
 * @param {number} [maxRadius]
 * @returns {{meshes:number, triangles:number, bytes:number, worstRadius:number,
 *            worstName:string, over:THREE.Mesh[],
 *            instanced:Array<{name:string, radius:number, triangles:number}>}}
 */
export function districtStats(root, maxRadius = MAX_DISTRICT_RADIUS) {
  const seen = new Set();
  const out = {
    meshes: 0, triangles: 0, bytes: 0, worstRadius: 0, worstName: '', over: [], instanced: [],
  };
  root?.traverse((o) => {
    if (!o.isMesh) return;
    out.meshes++;
    const g = o.geometry;
    out.triangles += triangleCount(g) * (o.isInstancedMesh ? o.count : 1);
    if (!seen.has(g)) { seen.add(g); out.bytes += geometryBytes(g); }
    if (o.frustumCulled === false) return;
    const r = sourceSphere(o)?.radius ?? 0;
    if (o.isInstancedMesh) {
      out.instanced.push({
        name: o.name || '(unnamed)', radius: r, triangles: triangleCount(g) * o.count,
      });
      return;
    }
    if (r > out.worstRadius) { out.worstRadius = r; out.worstName = o.name || '(unnamed)'; }
    if (r >= maxRadius) out.over.push(o);
  });
  return out;
}
