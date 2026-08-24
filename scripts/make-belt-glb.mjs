/**
 * Authored hero geometry for Halberd Reach — the boulders you fly around.
 *
 *   node scripts/make-belt-glb.mjs                  # writes the committed file
 *   BELT_GLB_OUT=/tmp/x.glb node scripts/make-belt-glb.mjs
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THIS OBJECT AND NOT SOMETHING ELSE IN THIS WORLD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 9 / decision D4: authored `.glb` hero assets through the pipeline
 * proven five times (`make-newel-glb`, `make-ship-glb`, `make-npc-glb`,
 * `make-beast-glb`, `make-yard-glb`), procedural systems for bulk content.
 *
 * Open space has almost no GEOMETRY in it. Twelve of its bodies are raw
 * `ShaderMaterial` spheres — an authored mesh cannot help a shader — and the
 * yard's exterior has already had its own documented pass. What is left is
 * `space/Belt.js`, and `Belt.js`'s own header says what it is: *"the one thing
 * out here you fly INTO rather than at."*
 *
 * Photographed at 900 m — which is a second and a half of cruise — the largest
 * rock in the field measured **mean luma 4.9 at 99.6% of its pixels under
 * 48/255, mean Sobel edge energy 5.5** across 700 px of screen. Two separate
 * faults, and the second is invisible until the first is fixed:
 *
 *  1. **The albedo was applied twice.** `MeshStandardMaterial({ color: tint })`
 *     AND `setColorAt(i, tint * variation)`; three multiplies `vColor` into
 *     `diffuseColor`, so the field's albedo was `0x5d564e` SQUARED — linear
 *     0.0117 instead of 0.108, a lump of coal. Fixed in `Belt.js`, measured
 *     A/B on the same three facets: 4.5 → 36.8, 8.4 → 57.8, 8.9 → 56.6.
 *  2. **The rock is a cut gem.** `IcosahedronGeometry(1, 1)` is 80 triangles.
 *     On an 18 m pebble drawn 4 px across that is generous. On the 336 m
 *     boulder this file replaces it is 20 visible facets over 700 px — each
 *     one 78 x 78 pixels of unbroken flat shading. It reads as a die.
 *
 * ── What authoring buys, stated honestly ─────────────────────────────────
 *
 * NOT a different topology. An asteroid IS a displaced sphere, and the
 * primitive is the right primitive. What 80 triangles cannot express, and what
 * this file spends 500 on:
 *
 *   - **Craters.** Seven of them, each a bowl with a raised rim. A crater is
 *     the one feature that says "this has been in space for four billion
 *     years", and at 80 triangles a crater is one facet, which is not a
 *     crater, it is a dent.
 *   - **Fracture planes.** Three seeded half-space cuts. A rock in a DEBRIS
 *     field is a fragment: it came off something, and the faces it came off on
 *     are flat, large and meet the rest of the body on a hard edge. This is
 *     the cheapest possible detail — flattening costs no triangles at all —
 *     and it is the single strongest cue that this is a shard rather than a
 *     pebble.
 *   - **A silhouette with concavities in it.** Three octaves of value noise
 *     rather than the one-octave per-vertex jitter the procedural rock uses,
 *     so the outline has bays in it instead of being a rounded polygon.
 *
 * ── The cost rule, which is the whole design ─────────────────────────────
 *
 * The mesh is NAMED FOR THE BELT'S MATERIAL KEY (`rock`). `space/BeltAssets.js`
 * reads that name, discards the glTF material beside it unread, and `Belt`
 * hands the geometry to a fourth `InstancedMesh` that shares the SAME
 * `MeshStandardMaterial` instance as the other three. So:
 *
 *   no new material, no new shader program, no new light.
 *
 * It does cost **one renderable, one instanced mesh and one draw call**, and
 * that is stated here rather than buried: an `InstancedMesh` cannot carry two
 * geometries, so hero detail for the 44 rocks that need it is either a fourth
 * bucket or a silhouette taken away from the 216 that do not. `Belt.js`'s own
 * header argues for three distinct small silhouettes with a reason, so the
 * fourth bucket is the honest price. It is paid back twice over in materials:
 * the belt built three byte-identical `MeshStandardMaterial`s and now shares
 * one, so the world's material count goes DOWN by two.
 *
 * Three keys its shader-program cache on material configuration and this
 * project boots by warming the cartesian product of those programs, so a
 * program is the expensive axis and a draw call is not. Measured across all
 * fifteen space framings: see `docs/superpowers/specs/2026-08-23-art-space-design.md`.
 *
 * ── Which rocks get it, and why that threshold ───────────────────────────
 *
 * `Belt.HERO_RADIUS` decides, and it is the SAME number the collider set uses.
 * That is not a coincidence, it is the rule:
 *
 *   **every rock the flight model can hit is a rock drawn at hero detail.**
 *
 * A threshold invented here would be a second number to keep in step with the
 * first, and `space-backdrop.test.mjs` already pins the size distribution the
 * two are derived from. This file does not import it - the shape it writes is
 * scale-free and has no opinion about which rocks use it - so the guarantee is
 * a test rather than a shared constant: `scripts/tests/belt-assets.test.mjs`
 * asserts the hero bucket and the collider set are the SAME SET, off a real
 * `Belt`, rather than asserting that two files read the same number.
 */

import * as THREE from 'three';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BELT_PART_KEY, HERO_DETAIL, HERO_TRI_BUDGET } from '../src/worlds/space/BeltAssets.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ */
/* The frame                                                           */
/* ------------------------------------------------------------------ */

/**
 * Local axes and units, and they are not free choices.
 *
 * `Belt.update` composes every instance as
 *
 *     compose(pos, tumbleQuat, (r*s*sx, r*s*sy, r*s*sz))
 *
 * so this geometry is authored on a UNIT sphere: radius 1 means "the rock's
 * nominal radius `r`". Every number below is therefore a fraction of the
 * rock's own size and the shape is scale-free, which is what lets one file
 * serve a 90 m rock and a 336 m one.
 *
 * There is no privileged axis — the instance tumble is about a random axis at
 * a random phase — so "up" here means nothing and the features are placed on
 * seeded directions rather than on named faces.
 */

/**
 * Radial envelope. The procedural rock this replaces displaces its vertices to
 * between 0.62 and 1.24 of the unit sphere, and `SpaceWorld._buildBelt`
 * registers a collider box of half-extent `r * 0.62` — the inscribed box of
 * the r-sphere — so a drawn rock already reaches outside its own collider.
 * That is documented and deliberate ("the failure mode is clipping a rock's
 * edge rather than hitting empty space").
 *
 * The authored rock must not make it WORSE, so it lives inside the same
 * envelope. Asserted at the bottom of this file and again, off the committed
 * bytes, in `belt-assets.test.mjs`.
 */
const R_MAX = 1.24;
const R_MIN = 0.45;

/* ------------------------------------------------------------------ */
/* Deterministic noise                                                 */
/* ------------------------------------------------------------------ */

/**
 * Seeded PRNG. The byte-diff test is the reason this is not `Math.random`,
 * and it is also the reason the seed is written here rather than passed in.
 */
function seededRandom(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return () => {
    h += 0x6d2b79f5;
    let x = h;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer lattice hash -> [0,1). Pure arithmetic; no table, no state. */
function hash3(i, j, k) {
  let h = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(j | 0, 0x165667b1) ^ Math.imul(k | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;

/** Trilinear value noise on the integer lattice, in [0,1). */
function vnoise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const tx = smooth(x - xi), ty = smooth(y - yi), tz = smooth(z - zi);
  const c = (dx, dy, dz) => hash3(xi + dx, yi + dy, zi + dz);
  const x00 = lerp(c(0, 0, 0), c(1, 0, 0), tx);
  const x10 = lerp(c(0, 1, 0), c(1, 1, 0), tx);
  const x01 = lerp(c(0, 0, 1), c(1, 0, 1), tx);
  const x11 = lerp(c(0, 1, 1), c(1, 1, 1), tx);
  return lerp(lerp(x00, x10, ty), lerp(x01, x11, ty), tz);
}

/**
 * Three octaves, signed, in roughly [-1, 1].
 *
 * Three and not one. The procedural rock jitters each vertex independently,
 * which is one octave at the tessellation's own frequency: the result is a
 * rounded polygon with no feature larger than a facet. What gives a rock a
 * silhouette with BAYS in it is a first octave whose wavelength is comparable
 * to the body, and that is what octave 0 at frequency 1.7 is.
 */
function fbm(x, y, z) {
  let sum = 0, amp = 1, freq = 1.7, norm = 0;
  for (let o = 0; o < 4; o++) {
    sum += (vnoise(x * freq + o * 31.7, y * freq + o * 17.3, z * freq + o * 53.1) * 2 - 1) * amp;
    norm += amp;
    amp *= 0.62;
    freq *= 2.35;
  }
  return sum / norm;
}

/* ------------------------------------------------------------------ */
/* The features                                                        */
/* ------------------------------------------------------------------ */

/**
 * Craters, as directions on the unit sphere with an angular radius and a depth.
 *
 * Seeded rather than typed so the set is reproducible and unbiased, but the
 * COUNT and the size band are authored: nine craters between 0.13 and 0.34
 * radians is between 1% and 4.6% of the sphere's area each, which at 500 faces
 * is five to twenty-three facets — enough for a bowl to be a bowl. Fewer and
 * larger reads as a bitten apple; more and smaller reads as texture, and there
 * is no tessellation here to carry texture.
 */
function makeCraters(rnd) {
  const out = [];
  for (let i = 0; i < 9; i++) {
    /* Uniform on the sphere, not uniform in (theta, phi) - the latter piles
     * craters onto the poles of an axis that means nothing here anyway. */
    const u = rnd() * 2 - 1;
    const th = rnd() * Math.PI * 2;
    const rp = Math.sqrt(Math.max(0, 1 - u * u));
    out.push({
      ax: [Math.cos(th) * rp, u, Math.sin(th) * rp],
      /* Big ones first, so the largest are placed before the rejection test
       * below starts refusing overlaps. */
      a: 0.34 - i * 0.026,
      depth: 0.17 + rnd() * 0.07,
    });
  }
  /* Overlapping craters are real, but two bowls whose rims cross at this
   * tessellation just cancel each other into a flat. Reject a centre that
   * falls inside an earlier crater's rim. */
  const keep = [];
  for (const c of out) {
    let clash = false;
    for (const k of keep) {
      const d = Math.acos(Math.min(1, Math.max(-1,
        c.ax[0] * k.ax[0] + c.ax[1] * k.ax[1] + c.ax[2] * k.ax[2])));
      if (d < Math.max(c.a, k.a) * 1.05) { clash = true; break; }
    }
    if (!clash) keep.push(c);
  }
  return keep;
}

/**
 * Fracture planes: half-space cuts at `off` from the centre.
 *
 * ── The number that had to be measured rather than guessed ───────────────
 *
 * A plane at offset `o` shears off a cap of half-angle `acos(o)`. The first
 * build put them at 0.58-0.74, reasoning that a deep cut makes a big
 * convincing flat; photographed, 0.58 is a 55-degree cap - **more than a
 * quarter of the whole body** - and three of them left a rock whose entire
 * lit hemisphere was one unbroken plane. It read as a smooth disc, which is
 * the SAME defect the 80-triangle rock had, arrived at from the other side.
 *
 * 0.86 to 0.94 is a 20-to-31-degree cap: a flat that is unmistakably a shear
 * face and unmistakably a feature ON a rock rather than the rock itself.
 * Three of them, on seeded normals, and the rejection below keeps them off
 * each other's shoulders for the same reason the craters are kept apart.
 */
function makePlanes(rnd) {
  const out = [];
  let guard = 0;
  while (out.length < 3 && guard++ < 64) {
    const u = rnd() * 2 - 1;
    const th = rnd() * Math.PI * 2;
    const rp = Math.sqrt(Math.max(0, 1 - u * u));
    const n = [Math.cos(th) * rp, u, Math.sin(th) * rp];
    let clash = false;
    for (const p of out) {
      if (n[0] * p.n[0] + n[1] * p.n[1] + n[2] * p.n[2] > 0.45) { clash = true; break; }
    }
    if (clash) continue;
    out.push({ n, off: 0.86 + rnd() * 0.08 });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The displacement                                                    */
/* ------------------------------------------------------------------ */

/**
 * Where one point of the unit sphere ends up.
 *
 * Order matters and it is the order a rock was actually made in: the body gets
 * its lumpy shape, then four billion years of impacts dig into that shape, and
 * only then does the collision that put it in a debris field shear a flat
 * through the lot. Cutting first and cratering after would put craters on the
 * fresh face, which is the one surface that should be clean.
 *
 * @param {number[]} d unit direction
 * @param {ReturnType<makeCraters>} craters
 * @param {ReturnType<makePlanes>} planes
 * @returns {number[]} the displaced point
 */
function displace(d, craters, planes) {
  /* 1. The body. */
  let rr = 1 + fbm(d[0], d[1], d[2]) * 0.26;

  /* 2. The impacts. A bowl with a raised rim: the rim is what makes a
   * depression read as a CRATER rather than as a dent, and it is one extra
   * term. `t` is 0 at the centre and 1 at the rim. */
  for (const c of craters) {
    const dot = Math.min(1, Math.max(-1, d[0] * c.ax[0] + d[1] * c.ax[1] + d[2] * c.ax[2]));
    const ang = Math.acos(dot);
    if (ang >= c.a * 1.22) continue;
    const t = ang / c.a;
    if (t <= 1) {
      /* Bowl: deepest at the centre, easing out to nothing at the rim. */
      rr -= c.depth * (1 - t * t) * (1 - t * t);
    }
    /* Rim: a ring of ejecta straddling t = 1, half a crater-radius wide. */
    const rim = 1 - Math.abs(t - 1.0) / 0.22;
    if (rim > 0) rr += c.depth * 0.42 * rim * rim;
  }

  let p = [d[0] * rr, d[1] * rr, d[2] * rr];

  /* 3. The shear. Project anything outside the half-space onto the plane. */
  for (const pl of planes) {
    const s = p[0] * pl.n[0] + p[1] * pl.n[1] + p[2] * pl.n[2];
    if (s > pl.off) {
      const k = s - pl.off;
      p = [p[0] - pl.n[0] * k, p[1] - pl.n[1] * k, p[2] - pl.n[2] * k];
    }
  }
  return p;
}

/* ------------------------------------------------------------------ */
/* The mesher                                                          */
/* ------------------------------------------------------------------ */

/**
 * Flat-shaded triangles and nothing else.
 *
 * Flat is the subject, not a shortcut: `Belt`'s material carries
 * `flatShading: true`, and with it three ignores the stored normals entirely
 * and takes the geometric normal from screen-space derivatives of the view
 * position. Writing per-face normals anyway costs 12 bytes a vertex and buys
 * a file that is correct on its own terms in any viewer, and — much more
 * importantly — it lets the generator CHECK them.
 *
 * The check is the one `art-citadel` paid for: a degenerate triangle has a
 * zero-length normal, which is finite, valid glTF, and NaN the instant a
 * shader normalizes it. Under `flatShading` the normalize happens in the
 * fragment shader on `cross(dFdx, dFdy)`, one NaN pixel reaches
 * `UnrealBloomPass`, and the whole frame goes white. Refused here, at the line
 * where the triangle is written.
 */
class Tris {
  constructor(name) {
    this.name = name;
    this.pos = [];
    this.nor = [];
    this.idx = [];
    this.worstDot = 1;
  }

  /**
   * One triangle, wound CCW seen from outside.
   *
   * `outward` is the winding gate. A backfacing triangle on a closed body is
   * ABSENT rather than wrong-looking — you see straight through the rock to
   * its far inside wall — and `art-dock` recorded that a screenshot review
   * cannot catch that. So the direction the face is supposed to be seen from
   * is passed in and checked, at the line where the winding is decided.
   *
   * The threshold is -0.35 and not 0 on purpose: a crater's inner WALL is a
   * steep slope on a star-shaped body and its normal genuinely leans back
   * towards the centre. Banning that would ban craters. What -0.35 still
   * catches is a whole patch turned inside out, and the signed-volume check in
   * `build()` catches the rest.
   */
  tri(a, b, c) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 1e-9)) throw new Error(`${this.name}: degenerate triangle`);
    nx /= len; ny /= len; nz /= len;

    const cx = (a[0] + b[0] + c[0]) / 3, cy = (a[1] + b[1] + c[1]) / 3, cz = (a[2] + b[2] + c[2]) / 3;
    const cl = Math.hypot(cx, cy, cz);
    if (!(cl > 1e-9)) throw new Error(`${this.name}: triangle centred on the origin`);
    const dot = (nx * cx + ny * cy + nz * cz) / cl;
    if (dot < this.worstDot) this.worstDot = dot;
    if (!(dot > -0.35)) {
      throw new Error(
        `${this.name}: triangle is wound inside out - normal (${nx.toFixed(2)}, ${ny.toFixed(2)}, `
        + `${nz.toFixed(2)}) faces ${dot.toFixed(2)} against its own outward direction`
      );
    }

    const base = this.pos.length / 3;
    for (const p of [a, b, c]) {
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(nx, ny, nz);
    }
    this.idx.push(base, base + 1, base + 2);
    return this;
  }

  get tris() { return this.idx.length / 3; }
}

/* ------------------------------------------------------------------ */
/* The rock                                                            */
/* ------------------------------------------------------------------ */

/**
 * Build the hero boulder.
 *
 * The base tessellation comes from three's own `IcosahedronGeometry`, at the
 * detail `BeltAssets` publishes, so the triangle count in the manifest, the
 * budget in the loader and the geometry in the file cannot drift apart.
 *
 * `PolyhedronGeometry` emits `20 * (detail + 1)^2` triangles with DUPLICATED
 * vertices at every shared corner. Displacing per index therefore tears the
 * shape open along every seam — the same trap `Belt.makeRockGeometry` records
 * and solves the same way: hash the rounded direction so every copy of one
 * corner is displaced identically.
 *
 * @returns {Tris}
 */
export function buildHeroRock() {
  const rnd = seededRandom('halberd-reach:hero:1');
  const craters = makeCraters(rnd);
  const planes = makePlanes(rnd);

  const base = new THREE.IcosahedronGeometry(1, HERO_DETAIL);
  const pos = base.attributes.position;

  /* direction key -> displaced point. Rounded to 5 places, which is far
   * coarser than the float error between two copies of a shared corner and far
   * finer than the gap between two distinct ones at this detail. */
  const cache = new Map();
  const at = (i) => {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const l = Math.hypot(x, y, z) || 1;
    const d = [x / l, y / l, z / l];
    const key = `${d[0].toFixed(5)},${d[1].toFixed(5)},${d[2].toFixed(5)}`;
    let p = cache.get(key);
    if (p === undefined) {
      p = displace(d, craters, planes);
      cache.set(key, p);
    }
    return p;
  };

  const out = new Tris(BELT_PART_KEY);
  for (let i = 0; i < pos.count; i += 3) out.tri(at(i), at(i + 1), at(i + 2));
  base.dispose();
  return out;
}

/**
 * Six times the signed volume of a closed triangle soup.
 *
 * Positive means the whole surface is wound outward. The per-face gate above
 * is local and deliberately permissive so craters survive it; this is the
 * global one, and between them a mesh that renders as a hole cannot ship.
 */
function signedVolume6(t) {
  let v = 0;
  for (let i = 0; i < t.idx.length; i += 3) {
    const a = t.idx[i] * 3, b = t.idx[i + 1] * 3, c = t.idx[i + 2] * 3;
    const ax = t.pos[a], ay = t.pos[a + 1], az = t.pos[a + 2];
    const bx = t.pos[b], by = t.pos[b + 1], bz = t.pos[b + 2];
    const cx = t.pos[c], cy = t.pos[c + 1], cz = t.pos[c + 2];
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v;
}

/** Radial extent, for the collider-envelope assertion. */
function radialRange(t) {
  let lo = Infinity, hi = 0;
  for (let i = 0; i < t.pos.length; i += 3) {
    const r = Math.hypot(t.pos[i], t.pos[i + 1], t.pos[i + 2]);
    if (r < lo) lo = r;
    if (r > hi) hi = r;
  }
  return [lo, hi];
}

/* ------------------------------------------------------------------ */
/* glTF 2.0 binary, written by hand                                    */
/* ------------------------------------------------------------------ */

const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

/**
 * No `GLTFExporter`. The exporter is a DOM-shaped module that wants a
 * `FileReader`, and every generator in this repository writes the container by
 * hand for the same reason: a byte-for-byte reproducible file cannot go
 * through a dependency whose output is allowed to change between versions.
 *
 * There are no TEXCOORDs. The belt's material carries no map — `color`,
 * `roughness`, `metalness`, `flatShading` and nothing else — so a UV set would
 * be twelve kilobytes claiming a texture that does not exist. If one is ever
 * added, this is the file to change and `belt-assets.test.mjs` is where the
 * change gets a gate.
 */
function writeGlb(t) {
  const bins = [];
  const bufferViews = [];
  const accessors = [];
  let binOffset = 0;

  const push = (typed, { itemSize, componentType, type, target, withMinMax = false }) => {
    const bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    const pad = (4 - (bytes.length % 4)) % 4;
    bufferViews.push({
      buffer: 0, byteOffset: binOffset, byteLength: bytes.length, target,
    });
    bins.push(bytes);
    if (pad) bins.push(Buffer.alloc(pad, 0));
    binOffset += bytes.length + pad;

    const acc = {
      bufferView: bufferViews.length - 1,
      componentType,
      count: typed.length / itemSize,
      type,
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
  const wide = vCount > 65535;
  const idxAcc = push(wide ? new Uint32Array(t.idx) : new Uint16Array(t.idx), {
    itemSize: 1, componentType: wide ? UNSIGNED_INT : UNSIGNED_SHORT, type: 'SCALAR',
    target: ELEMENT_ARRAY_BUFFER,
  });

  const json = {
    asset: {
      version: '2.0',
      generator: 'aether-nexus scripts/make-belt-glb.mjs',
      copyright: 'generated - procedurally authored in this repository, no external source',
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: BELT_PART_KEY }],
    meshes: [{
      /* THE MESH NAME IS THE CONTRACT - it is the belt material key the part
       * is drawn with. `space/BeltAssets.js` reads it and discards the glTF
       * material beside it unread. See the header. */
      name: BELT_PART_KEY,
      primitives: [{
        attributes: { POSITION: posAcc, NORMAL: norAcc },
        indices: idxAcc, mode: 4, material: 0,
      }],
    }],
    /* A placeholder so the file stands alone in a viewer. The game DISCARDS
     * it and draws the rock with the belt's own shared material. */
    materials: [{
      name: 'reach-boulder-placeholder',
      pbrMetallicRoughness: {
        baseColorFactor: [0.36, 0.34, 0.31, 1], metallicFactor: 0.06, roughnessFactor: 0.94,
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
export function heroReport() {
  const t = buildHeroRock();
  const [rLo, rHi] = radialRange(t);
  return { tris: t.tris, verts: t.pos.length / 3, rLo, rHi, volume6: signedVolume6(t), worstDot: t.worstDot };
}

/* ------------------------------------------------------------------ */

/* Guarded so the module can be imported by the test without writing files.
 * The `argv` comparison is the portable half of `import.meta.main`. */
const isMain = path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const t = buildHeroRock();
  if (t.tris > HERO_TRI_BUDGET) {
    throw new Error(`hero rock is ${t.tris} tris - over the ${HERO_TRI_BUDGET} reservation`);
  }
  const [rLo, rHi] = radialRange(t);
  if (!(rHi <= R_MAX)) throw new Error(`hero rock reaches ${rHi.toFixed(3)} - outside the ${R_MAX} collider envelope`);
  if (!(rLo >= R_MIN)) throw new Error(`hero rock pinches to ${rLo.toFixed(3)} - under the ${R_MIN} floor`);
  if (!(signedVolume6(t) > 0)) throw new Error('hero rock is wound inside out - negative signed volume');

  const { glb, verts } = writeGlb(t);
  const out = process.env.BELT_GLB_OUT
    ? path.resolve(process.env.BELT_GLB_OUT)
    : path.join(root, 'public/assets/space', 'reach-boulder.glb');
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, glb);
  console.log(`${out}`);
  console.log(`  ${String(verts).padStart(5)} verts  ${String(t.tris).padStart(5)} tris  ${glb.length} bytes`);
  console.log(`  radius ${rLo.toFixed(3)} .. ${rHi.toFixed(3)}   worst outward dot ${t.worstDot.toFixed(3)}`);
}
