import * as THREE from 'three';
import { scatter } from './Placement.js';

/**
 * THE PROP FAMILIES: the only part of a planet that is SHAPE rather than data.
 *
 * A descriptor says "150 columns on that disc, 0.9 to 2.3 m across, 3.5 to 13 m
 * tall". What a column IS - a hexagonal prism with a chipped top, one draw call
 * for all of them - lives here, because that is geometry and geometry is code.
 *
 * The boundary is deliberate and it is the one that keeps the tenth planet
 * cheap. A new PLACE for basalt costs a record in a descriptor. A new SHAPE -
 * ice spires, coral, wind-carved arches - costs a `kind` in this file, and then
 * every planet after it can use that shape by naming it. Nothing here knows
 * which planet it is building for.
 *
 * -- Draw calls -----------------------------------------------------------
 * Every family is ONE `InstancedMesh`. Cinder places 1,186 props and draws them
 * in five calls. Built one mesh at a time it would be 1,186 draws, which is the
 * budget for the whole frame in this project three times over.
 *
 * -- Colliders ------------------------------------------------------------
 * Only what a body can actually meet. A 4 m basalt column is a wall and gets a
 * box; a 60 cm obsidian shard is scenery and gets nothing. The rule is in the
 * descriptor (`collide`), because whether a thing is an obstacle is a property
 * of the planet's design, not of the shape.
 *
 * WHAT the box is, though, is a property of the shape, and it is not always the
 * whole instance. A column is a wall from the ground to its top and gets one
 * box for all of it. A spire is a needle above its first third, so it gets a
 * box round its FOOT - a full-height one would close the lanes the geometry
 * leaves open between them. Growth gets its TRUNK only, because a box round the
 * canopy is an invisible ceiling and you walk under a tree. A slab gets a
 * ROTATED box at its own footprint, flattened to a step, because an
 * axis-aligned cube round a tilted sheet is the invisible-wall error at its
 * purest. Each choice is stated again where it is made.
 *
 * -- The primitive is the problem -----------------------------------------
 * This project shipped spacecraft assembled from 197 stacked boxes and had them
 * rejected three times as "made of square blocks". The rule that came out of it
 * governs every family below: an ORGANIC or CRYSTALLINE form is a lathed,
 * tapered or faceted primitive with per-instance non-uniform scale and
 * rotation - never a stack of cuboids. `slabs` is a box because a shattered
 * plate IS a flat sheet, which is the other half of the same rule.
 */

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
/* A second set, for the one family that has to know its own world-space height
 * BEFORE the instance matrix is composed. Separate objects rather than the ones
 * above, because reusing a temporary two statements before it is read again is
 * how a shared scratch variable becomes a bug nobody can see. */
const _m2 = new THREE.Matrix4();
const _q2 = new THREE.Quaternion();
const _e2 = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

/** Pick one of `list` with a small lightness jitter, so no two repeat exactly. */
function tintOf(list, r) {
  const base = list[(r * list.length) | 0] ?? 0x888888;
  const f = 0.85 + r * 0.3;
  _c.setHex(base);
  _c.multiplyScalar(f);
  return _c;
}

/** Mean of a tint list, in the same working space `tintOf` produces. */
function tintMean(list) {
  let r = 0; let g = 0; let b = 0;
  const n = Math.max(1, list.length);
  for (const hex of list) { _c.setHex(hex); r += _c.r; g += _c.g; b += _c.b; }
  return [r / n, g / n, b / n];
}

/**
 * TWO COLOURS PER INSTANCE OUT OF ONE INSTANCE COLOUR.
 *
 * `InstancedMesh` carries one `vec3` per instance, and three multiplies it into
 * the geometry's own `color` attribute rather than replacing it
 * (`color_vertex.glsl`: `vColor *= color;` then `vColor.xyz *= instanceColor`).
 * Six numbers of colour per instance therefore do not fit; three do. So a
 * `growth` instance puts its CANOPY colour in the instance slot and the trunk
 * carries a fixed RATIO baked into the geometry - which still gives every
 * instance two different colours, both of which move with that instance's own
 * tint jitter, and still costs one draw call. Six numbers would cost a second
 * mesh, and one mesh per family is the whole reason this file exists.
 */
function trunkShade(trunkList, canopyList) {
  const t = tintMean(trunkList);
  const c = tintMean(canopyList);
  /* Guarded, and this is one of the two divisions in the file. A canopy palette
   * with a dead channel - a pure red 0xff0000 has none of the other two - would
   * divide by zero and write an Infinity into the vertex buffer, and an
   * Infinity through the bloom pass is the black-frame defect again. */
  const f = (a, b) => Math.min(4, Math.max(0, a / Math.max(b, 1e-3)));
  return [f(t[0], c[0]), f(t[1], c[1]), f(t[2], c[2])];
}

/* ------------------------------------------------------------------ */
/* Size records, and the one rule about them                           */
/* ------------------------------------------------------------------ */

/**
 * Read a `[min, max]` size range and return `[min, span]` ready to sample.
 *
 * THROWS rather than hand back anything a matrix could be composed from. A
 * prior defect in this project put a NaN into a mesh and nineteen bad pixels
 * through the bloom pass blacked out all 921,600 of them, so every arithmetic
 * path that can reach `Matrix4.compose` starts here.
 *
 * `min === max` is ALLOWED and is not degenerate: it means "every instance is
 * this size in this dimension", nothing divides by the width of the range, and
 * the other channels (lean, yaw, anisotropy) still vary. What is refused is a
 * pair that cannot produce a positive finite number - including a zero, because
 * a zero scale makes a singular instance matrix and `Matrix4.decompose` divides
 * by the scale to recover the rotation.
 */
function range(v, what) {
  if (!Array.isArray(v) || v.length !== 2) {
    throw new Error(`[PlanetProps] size.${what} must be a [min, max] pair, got ${JSON.stringify(v) ?? String(v)}`);
  }
  const lo = v[0];
  const hi = v[1];
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    throw new Error(`[PlanetProps] size.${what} is [${lo}, ${hi}] - a non-finite dimension reaches the shader as NaN`);
  }
  if (hi < lo) throw new Error(`[PlanetProps] size.${what} is [${lo}, ${hi}] - max is below min`);
  if (lo <= 0) {
    throw new Error(`[PlanetProps] size.${what} is [${lo}, ${hi}] - a zero or negative dimension makes a singular`
      + ' instance matrix, and decomposing one divides by the scale');
  }
  return [lo, hi - lo];
}

/** The middle of a `[min, span]` range. */
function mid(r) { return r[0] + r[1] * 0.5; }

/** An optional scalar knob: finite or it throws, then clamped into its band. */
function knob(v, dflt, lo, hi, what) {
  const n = v === undefined ? dflt : v;
  if (!Number.isFinite(n)) throw new Error(`[PlanetProps] size.${what} must be a finite number, got ${n}`);
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Deterministic 0..1 from an integer.
 *
 * Not a PRNG: geometry is built once per field and must come out identical
 * every session and from any call order, the same property `Placement.scatter`
 * has. A stateful generator here would re-shape the props the day somebody
 * added a family above this one.
 */
function hash1(i) {
  const s = Math.sin(i * 127.1 + 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

/**
 * Concatenate geometries into ONE non-indexed buffer with flat normals.
 *
 * A `growth` prop is a trunk and a canopy, and they have to be one geometry or
 * a stand of them is two draw calls. Position and uv only, then
 * `computeVertexNormals` on the non-indexed result, which is what makes the
 * facets read as facets rather than as a smooth blob.
 *
 * @returns {{ geo: THREE.BufferGeometry, counts: number[] }} vertex count per part
 */
function weld(parts) {
  const flat = parts.map((g) => {
    const f = g.index ? g.toNonIndexed() : g;
    if (f !== g) g.dispose();
    return f;
  });
  let n = 0;
  for (const f of flat) n += f.attributes.position.count;
  const pos = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  const col = new Float32Array(n * 3).fill(1);
  const counts = [];
  let o = 0;
  for (const f of flat) {
    const c = f.attributes.position.count;
    pos.set(f.attributes.position.array, o * 3);
    if (f.attributes.uv) uv.set(f.attributes.uv.array, o * 2);
    counts.push(c);
    o += c;
    f.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return { geo: g, counts };
}

/**
 * Geometry per kind, built once per field.
 *
 * Every one is authored around a UNIT footprint (radius 1, height 1, origin at
 * the base) so the instance matrix carries all the size. That keeps one
 * geometry per family however many size bands a descriptor asks for.
 */
function geometryFor(kind, size, authored = null) {
  /* ── THE AUTHORED SUBSTITUTION ────────────────────────────────────────
   *
   * An authored `.glb` part REPLACES the primitive inside the field's existing
   * `InstancedMesh` rather than earning a bucket of its own. Everything after
   * this point - the instance loop, the tints, the colliders, the draw call -
   * is unchanged and does not know which arm it got. So the asset costs no
   * renderable, no instanced mesh, no draw call, no material and no shader
   * program; only triangles move.
   *
   * CLONED, and that is not defensive. `blockGeometry()` hands back ONE
   * geometry for the session and thirteen fields across ten planets each pass
   * theirs to an `InstancedMesh` whose `dispose()` disposes it - so the second
   * planet in a session would instance a disposed buffer, and the symptom is an
   * empty field with no error.
   *
   * Null is the normal path, not an error branch: `node --test` has no `fetch`,
   * a deploy can be missing the file, and a slow network times out. @see
   * `planets/PlanetAssets.js`. */
  const part = authored?.[kind];
  if (part) return part.clone();

  switch (kind) {
    case 'columns': {
      /* A hexagonal prism, because that is what cooling basalt does - and it is
       * the single most legible "this is volcanic" shape there is. Origin at
       * the base so the instance matrix's Y is the ground. */
      const g = new THREE.CylinderGeometry(1, 1.04, 1, size.sides ?? 6, 1, false);
      g.translate(0, 0.5, 0);
      return g;
    }
    case 'shards': {
      // Four-sided spike. Obsidian fractures conchoidally; a four-sided cone is
      // the cheapest thing that catches a highlight on one facet at a time.
      const g = new THREE.ConeGeometry(1, 1, 4, 1);
      g.translate(0, 0.5, 0);
      return g;
    }
    case 'boulders': {
      // Icosahedron at detail 0: 20 flat faces, which under a low sun gives an
      // ejecta block a different value on every side for 20 triangles.
      const g = new THREE.IcosahedronGeometry(1, 0);
      return g;
    }
    case 'vents': {
      // A flared mouth: a truncated cone, open at both ends so you can see down
      // it, with the wide end at the ground.
      const g = new THREE.CylinderGeometry(0.55, 1, 1, 9, 1, true);
      g.translate(0, 0.5, 0);
      return g;
    }
    case 'spires': {
      /* A PINNACLE, WHICH IS NOT A CONE.
       *
       * Three things separate the two, and all three are here rather than in
       * the instance loop because they are shape:
       *
       *  1. A near-zero but NOT zero top radius. A true point is a vertex the
       *     light never catches; 0.07 leaves a chipped tip that reads as broken
       *     crystal and costs `facets` triangles.
       *  2. Four to seven sides, so the silhouette is a polygon. This is the
       *     "made of square blocks" lesson from the ship hulls read the other
       *     way round: the primitive has to BE the shape, and a crystal really
       *     is a low-order prism.
       *  3. A CONCAVE profile. The mid ring is pulled inside the straight taper
       *     (0.535 linear -> 0.396), which is the difference between a party
       *     hat and an ice pinnacle. Straight-sided is the tell.
       *
       * The per-column radius jitter makes the cross-section irregular, so a
       * yaw actually changes the silhouette instead of rotating a symmetry. */
      const facets = Math.round(knob(size.facets, 5, 4, 7, 'facets'));
      range(size.h, 'h');
      range(size.base, 'base');
      const g = new THREE.CylinderGeometry(0.07, 1, 1, facets, 2, false);
      const pos = g.attributes.position;
      const TAU = Math.PI * 2;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const z = pos.getZ(i);
        const rad = Math.hypot(x, z);
        if (rad < 1e-6) continue; // cap centres: no angle to jitter along
        const col = Math.round((Math.atan2(z, x) / TAU) * facets);
        const j = 1 + 0.22 * (hash1(col) - 0.5);
        const needle = Math.abs(y) < 1e-6 ? 0.74 : 1;
        const f = j * needle;
        pos.setXYZ(i, x * f, y, z * f);
      }
      g.translate(0, 0.5, 0);
      const flat = g.toNonIndexed();
      g.dispose();
      flat.computeVertexNormals();
      return flat;
    }
    case 'growth': {
      /* A TRUNK AND A CANOPY, WELDED, AT UNIT HEIGHT.
       *
       * The proportions are baked from the FIELD's own size record - trunk and
       * canopy radius as fractions of the mean height - because an instance
       * matrix has one scale vector and cannot carry three independent
       * dimensions. What that costs is that a stand shares its proportions;
       * what the instance loop buys back is a per-instance height, two
       * different canopy half-widths and a yaw, which is what makes a stand
       * read as vegetation rather than as one plant stamped N times.
       *
       * The canopy is deliberately NOT a sphere on a stick. It is a subdivided
       * icosahedron, squashed, lumped per vertex, and drooped under the
       * equator so the underside sags and flares. Flat normals on the welded
       * result give it facets, which is what stops it reading as a ball. */
      const trunk = range(size.trunk, 'trunk');
      const h = range(size.h, 'h');
      const canopy = range(size.canopy, 'canopy');
      const droop = knob(size.droop, 0.35, 0, 1, 'droop');

      /* The only other division in this file, and `range` has already refused a
       * zero or negative height, so it cannot be by zero. */
      const hMid = mid(h);
      const tr = Math.min(0.3, Math.max(0.008, mid(trunk) / hMid));
      const cr = Math.min(0.9, Math.max(0.08, mid(canopy) / hMid));
      const canH = cr * 0.46;                                  // squashed
      const yc = Math.min(0.95, Math.max(0.25, 1 - canH));     // canopy centre

      // Slim and tapered: 0.42 of the base radius at the top.
      const stem = new THREE.CylinderGeometry(tr * 0.42, tr, yc, 5, 1, false);
      stem.translate(0, yc * 0.5, 0);

      const mass = new THREE.IcosahedronGeometry(1, 1);
      const p = mass.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const lump = 0.82 + hash1(i) * 0.36;
        let x = p.getX(i) * cr * lump;
        let y = p.getY(i) * canH * lump;
        let z = p.getZ(i) * cr * lump;
        if (y < 0) {
          const t = Math.min(1, -y / Math.max(canH, 1e-4));
          y -= droop * canH * t * (0.6 + hash1(i + 91) * 0.8);
          const flare = 1 + droop * 0.35 * t;
          x *= flare;
          z *= flare;
        }
        p.setXYZ(i, x, y, z);
      }
      mass.translate(0, yc, 0);

      // Trunk FIRST, so `buildPropField` can repaint exactly its vertices with
      // the trunk/canopy colour ratio without knowing how either was built.
      const { geo, counts } = weld([stem, mass]);
      /* The CLAMPED proportions, published rather than recomputed. The instance
       * loop has to divide a world canopy radius by this exact number, and a
       * second copy of the clamp would be a second copy that goes stale. */
      geo.userData.growth = { trunkVerts: counts[0], trunkR: tr, canopyR: cr, trunkTop: yc };
      return geo;
    }
    case 'slabs': {
      /* A BOX, AND HONESTLY SO.
       *
       * The lesson this project paid for three times is that an ORGANIC or
       * CRYSTALLINE shape must not be stacked out of boxes. A shattered plate
       * is neither: it is a flat sheet, and a flat sheet is a box. What would
       * make a field of them read as a floor is not the primitive, it is
       * sameness - so the eight corners are jittered by a deterministic hash
       * (keyed on the CORNER, not the vertex, or the three copies of each
       * corner would come apart) and the outline stops being a rectangle. The
       * tilt, the yaw and the thickness are per-instance, in the loop. */
      const g = new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
      const pos = g.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const z = pos.getZ(i);
        const corner = (x > 0 ? 1 : 0) | (y > 0 ? 2 : 0) | (z > 0 ? 4 : 0);
        pos.setXYZ(
          i,
          x * (1 + 0.24 * (hash1(corner) - 0.5)),
          y * (1 + 0.30 * (hash1(corner + 17) - 0.5)),
          z * (1 + 0.24 * (hash1(corner + 53) - 0.5)),
        );
      }
      const flat = g.toNonIndexed();
      g.dispose();
      flat.computeVertexNormals(); // the jitter made the faces non-planar
      return flat;
    }
    default:
      throw new Error(`[PlanetProps] unknown prop kind "${kind}"`);
  }
}

/**
 * Build one prop field.
 *
 * @param {object} spec the descriptor's `props[i]` record
 * @param {{ height:(x,z)=>number, half:number, slopeStep:number, seed:number,
 *           liquid:object|null, landing:object[], material:THREE.Material,
 *           authored?:Record<string, THREE.BufferGeometry|null>,
 *           physics:any, group:THREE.Group, track:(c:any)=>any }} ctx
 * @returns {{ mesh: THREE.InstancedMesh, material: THREE.Material, placed: number,
 *             requested: number, colliders: number, points: object[] }}
 */
export function buildPropField(spec, ctx) {
  const res = scatter({
    region: spec.region,
    count: spec.count,
    spacing: spec.spacing ?? 0,
    seed: ctx.seed,
    height: ctx.height,
    half: ctx.half,
    slopeStep: ctx.slopeStep,
    liquid: ctx.liquid,
    landing: ctx.landing,
  });

  const sz = spec.size ?? {};
  const geo = geometryFor(spec.kind, sz, ctx.authored);

  /* A `growth` field paints its trunk vertices with the trunk/canopy ratio
   * before a single instance exists - see `trunkShade`. The geometry knows
   * which vertices are the trunk; the field knows the two palettes. */
  if (spec.kind === 'growth' && geo.userData.growth) {
    const shade = trunkShade(spec.trunkTint ?? [0x5a4632], spec.tint ?? [0x888888]);
    const col = geo.attributes.color;
    for (let v = 0; v < geo.userData.growth.trunkVerts; v++) col.setXYZ(v, shade[0], shade[1], shade[2]);
    col.needsUpdate = true;
  }

  /* An emissive tint is a property of the FIELD, not of the instance.
   *
   * `MeshStandardMaterial` multiplies the per-instance colour into the DIFFUSE
   * and never into the emissive, so an ice world's glowing crystal cannot be
   * carried by `setColorAt`. It is carried the way `PlanetWorld._buildMinerals`
   * already carries a seam's glow: one material for the family, cloned off the
   * shared rock so the per-instance tint still works on the diffuse. It is
   * still ONE mesh, so it is still one draw call. Opt-in: a field with no
   * `glow` gets the shared material back, byte for byte. */
  let material = ctx.material;
  /* `!== 0` and not a truthiness test: `NaN` is falsy, so `if (spec.glow)` would
   * have waved a NaN colour straight through to the one place this file is not
   * allowed to let one reach. */
  const glow = spec.glow ?? 0;
  if (glow !== 0) {
    if (!Number.isFinite(glow)) throw new Error(`[PlanetProps] props "${spec.id}" glow must be a finite number (a colour), got ${glow}`);
    material = ctx.material.clone();
    material.name = `${ctx.material.name ?? 'planet.rock'}.${spec.id}`;
    material.emissive = new THREE.Color(glow);
    material.emissiveIntensity = knob(spec.glowStrength, 1.4, 0, 8, 'glowStrength');
  }

  const mesh = new THREE.InstancedMesh(geo, material, Math.max(1, res.points.length));
  mesh.name = `planet:prop:${spec.id}`;
  mesh.castShadow = spec.kind !== 'shards';
  mesh.receiveShadow = true;
  mesh.count = res.points.length;

  let colliders = 0;

  /* The three `[min, max]` families read their ranges ONCE, here, so a bad size
   * record throws before an instance exists rather than 340 times inside the
   * loop - and so the loop below contains no validation, only arithmetic that
   * has already been proved finite. */
  const R = {};
  if (spec.kind === 'spires') {
    R.h = range(sz.h, 'h');
    R.base = range(sz.base, 'base');
    R.lean = knob(sz.lean, 0.16, 0, 0.6, 'lean');
  } else if (spec.kind === 'growth') {
    R.h = range(sz.h, 'h');
    R.canopy = range(sz.canopy, 'canopy');
    range(sz.trunk, 'trunk');
    R.geoR = geo.userData.growth;
    /* Clamped in `geometryFor` to at least 0.08, so this is never a divide by
     * zero however the descriptor proportions the plant. */
    R.canR = Math.max(1e-3, R.geoR ? R.geoR.canopyR : 0.3);
  } else if (spec.kind === 'slabs') {
    R.w = range(sz.w, 'w');
    R.d = range(sz.d, 'd');
    R.t = range(sz.t, 't');
    R.tilt = knob(sz.tilt, 0.5, 0, 1.35, 'tilt');
  }

  for (let i = 0; i < res.points.length; i++) {
    const pt = res.points[i];
    /* A second stream off the point's own stored roll rather than a shared
     * generator: the placement loop rejects candidates, so a generator consumed
     * here would advance a different number of times depending on how many
     * rejections happened before this point, and every instance downstream
     * would shift the moment a filter changed. */
    const a = pt.rnd;
    const b = (a * 7.13) % 1;
    const c = (a * 31.7) % 1;
    const d = (a * 113.9) % 1;

    let sx; let sy; let sz2; let rotX = 0; let rotZ = 0; let sink = 0;
    /* Collider half-extents for the kinds that want something other than a box
     * round the whole instance. Left null by the four original families, which
     * keep exactly the box they had. `cy` is measured up from the instance's
     * own origin; `yaw` present means a rotated box. */
    let col = null;
    switch (spec.kind) {
      case 'columns': {
        const r = (sz.rMin ?? 1) + a * ((sz.rMax ?? 2) - (sz.rMin ?? 1));
        /* Height correlates with radius, inverted: the thin columns are the
         * tall ones. That is how a real colonnade reads, and it also means the
         * silhouette has a range in it rather than one repeated stick. */
        const h = (sz.hMin ?? 3) + (1 - a) * ((sz.hMax ?? 10) - (sz.hMin ?? 3)) * (0.55 + b * 0.9);
        sx = r; sz2 = r; sy = h;
        // A degree or two off plumb. Columns cool against each other, not level.
        rotX = (c - 0.5) * 0.09;
        rotZ = (d - 0.5) * 0.09;
        sink = 0.4;
        break;
      }
      case 'shards': {
        const w = (sz.wMin ?? 0.4) + b * ((sz.wMax ?? 1.5) - (sz.wMin ?? 0.4));
        sx = w; sz2 = w;
        sy = (sz.hMin ?? 1) + c * ((sz.hMax ?? 4) - (sz.hMin ?? 1));
        // Shards lean hard - they are shatter, not growth.
        rotX = (a - 0.5) * 0.75;
        rotZ = (d - 0.5) * 0.75;
        sink = sy * 0.18;
        break;
      }
      case 'boulders': {
        const r = (sz.rMin ?? 0.6) + a * ((sz.rMax ?? 3) - (sz.rMin ?? 0.6));
        sx = r * (0.7 + b * 0.6);
        sy = r * (0.6 + c * 0.7);
        sz2 = r * (0.7 + d * 0.6);
        rotX = a * Math.PI;
        rotZ = c * Math.PI;
        // Half-buried. An ejecta block resting exactly on the surface reads as
        // a prop dropped on the terrain, which is what it is.
        sink = sy * 0.42;
        break;
      }
      case 'vents': {
        const r = (sz.rMin ?? 0.8) + a * ((sz.rMax ?? 2.5) - (sz.rMin ?? 0.8));
        sx = r; sz2 = r;
        sy = r * (0.5 + b * 0.7);
        sink = sy * 0.25;
        break;
      }
      case 'spires': {
        const h = R.h[0] + a * R.h[1];
        const base = R.base[0] + b * R.base[1];
        /* Two different half-widths. A round pinnacle rotated by a yaw is the
         * same pinnacle; an elliptical one is a different silhouette every
         * time, and the yaw below is then doing work rather than nothing. */
        sx = base * (0.78 + c * 0.44);
        sz2 = base * (0.78 + d * 0.44);
        sy = h;
        // Grown, not planted. `lean` is the half-angle, so this spans +/- lean.
        rotX = (c - 0.5) * 2 * R.lean;
        rotZ = (d - 0.5) * 2 * R.lean;
        // Its foot is in the ice, never resting on it, and never so deep that a
        // short spire disappears: the min() is against the base, not the height.
        sink = Math.min(h * 0.10, base * 0.8);
        /* THE COLLIDER IS THE FOOT, NOT THE WHOLE SPIRE.
         *
         * A full-height box round a pinnacle is a slab where the geometry is a
         * needle: above the first third the thing is thinner than a forearm and
         * a body brushes past it, but the box would still be `base` wide all the
         * way up and a field at 4 m spacing would have no lanes left in it. So
         * the bottom 45% gets a box at the radius the taper actually has in the
         * middle of that stub (~0.775 of base), times the same 0.8 under-side
         * factor the columns use. What you can walk between, you can walk
         * between; what stops you is the part that is genuinely in the way. */
        const stub = sy * 0.45;
        col = {
          hx: sx * 0.775 * 0.8,
          hz: sz2 * 0.775 * 0.8,
          hy: stub * 0.5,
          cy: stub * 0.5,
        };
        break;
      }
      case 'growth': {
        const h = R.h[0] + a * R.h[1];
        /* The canopy is sampled and the trunk follows it, not the other way
         * round. One scale vector cannot honour two independent radii (see
         * `geometryFor`), and the canopy is the mass you actually see - which
         * is also the truthful coupling, because a heavy crown does not sit on
         * a wire. Two half-widths off two different streams, so no crown is
         * round and the yaw changes the outline. */
        const cw = R.canopy[0] + b * R.canopy[1];
        const cd = R.canopy[0] + d * R.canopy[1];
        sy = h;
        // `R.canR` is the geometry's own clamped canopy radius, never zero.
        sx = cw / R.canR;
        sz2 = cd / R.canR;
        sink = Math.min(h * 0.03, 0.25);
        /* Three degrees off plumb, no more. Growth is not shatter and it does
         * not lean like a spire, but a stand in which every stem is exactly
         * vertical is a stand somebody planted. The collider below stays plumb:
         * at this angle the trunk's top wanders 5 cm inside a 1 m box, and the
         * under-side error is the one to take. */
        rotX = (c - 0.5) * 0.10;
        rotZ = (b - 0.5) * 0.10;
        /* THE COLLIDER IS THE TRUNK, AND ONLY THE TRUNK.
         *
         * A box round the canopy would be an invisible ceiling over every gap
         * in the stand - the same defect as a door you cannot walk through, one
         * storey up. You walk UNDER growth. So the box is the trunk: its own
         * radius (0.9 of it, under-side) and its own height, and the crown
         * overhead is scenery you can stand in. */
        const tr = R.geoR ? R.geoR.trunkR : 0.05;
        const top = (R.geoR ? R.geoR.trunkTop : 0.7) * sy;
        col = { hx: sx * tr * 0.9, hz: sz2 * tr * 0.9, hy: top * 0.5, cy: top * 0.5 };
        break;
      }
      case 'slabs': {
        sx = R.w[0] + a * R.w[1];
        sz2 = R.d[0] + c * R.d[1];
        // Thickness varies too, or the field is one plate at N addresses.
        sy = R.t[0] + b * R.t[1];
        rotX = (b - 0.5) * 2 * R.tilt;
        rotZ = (d - 0.5) * 2 * R.tilt;
        /* HALF THE PLATE'S OWN VERTICAL EXTENT, EXACTLY.
         *
         * Not `sy + sx*sin(rotZ) + sz*sin(rotX)`. That reads like the answer and
         * it is wrong by up to 2x, because the yaw sits BETWEEN the two tilts in
         * the Euler order and mixes them - the two tilts partly cancel for some
         * yaws and the estimate does not know it. Over-estimating here would
         * sink the plate too far AND make the collider below taller than the
         * sheet it stands for, which is exactly the invisible wall this file
         * refuses everywhere else. So the rotation is composed and the second
         * row of it is read, which is the definition rather than a guess.
         * Everything in it is a sin or a cos of a finite angle, so it is finite. */
        _e2.set(rotX, a * Math.PI * 2, rotZ);
        _q2.setFromEuler(_e2);
        _m2.makeRotationFromQuaternion(_q2);
        const rot = _m2.elements; // column-major: [1], [5], [9] are the world-Y row
        const vHalf = 0.5 * (sx * Math.abs(rot[1]) + sy * Math.abs(rot[5]) + sz2 * Math.abs(rot[9]));
        // 40% under. The low edge is IN the ground, which is what makes a plate
        // read as upended rather than as a tile someone put down.
        sink = vHalf * 0.40;
        /* THE COLLIDER IS A STEP AT THE PLATE'S OWN FOOTPRINT.
         *
         * An axis-aligned box round a tilted, yawed plate is a cube round a
         * sheet - the invisible-wall error, and the worse of the two. So this
         * is a ROTATED box: the yaw is carried exactly, the footprint is the
         * plate's own (0.85 of it, under-side), and the tilt is flattened into
         * a low step 0.85 of the plate's rise. You step onto a slab. You are
         * never stopped by air beside one. */
        col = {
          hx: sx * 0.5 * 0.85,
          hz: sz2 * 0.5 * 0.85,
          hy: vHalf * 0.85,
          cy: 0,
          yaw: a * Math.PI * 2,
        };
        break;
      }
      default:
        throw new Error(`[PlanetProps] unknown prop kind "${spec.kind}"`);
    }

    _e.set(rotX, a * Math.PI * 2, rotZ);
    _q.setFromEuler(_e);
    _p.set(pt.x, pt.y - sink, pt.z);
    _s.set(sx, sy, sz2);
    _m.compose(_p, _q, _s);
    mesh.setMatrixAt(i, _m);
    mesh.setColorAt(i, tintOf(spec.tint ?? [0x888888], b));

    if (spec.collide && ctx.physics) {
      const baseY = pt.y - sink;
      if (col && col.yaw !== undefined) {
        ctx.track(ctx.physics.addRotatedBox(
          new THREE.Vector3(pt.x, baseY + col.cy, pt.z),
          new THREE.Vector3(col.hx, col.hy, col.hz),
          col.yaw,
        ));
        colliders++;
      } else if (col) {
        ctx.track(ctx.physics.addBox(pt.x, baseY + col.cy, pt.z, col.hx, col.hy, col.hz));
        colliders++;
      } else {
      /* An axis-aligned box round the instance, not the oriented hull. The
       * instances are within a few degrees of plumb, and a box is what gives
       * the climb probe one consistent normal per face - which is why every
       * structure in Citadel is a box too.
       *
       * 0.8 of the circumradius: a hexagonal prism measures 0.866r flat-to-flat
       * and r corner-to-corner, so this is between the two and slightly under
       * the corner. Deliberately the under side - the visible geometry is the
       * authority on where a wall is, and a collider wider than the thing it
       * stands for is an invisible wall, which is the worse of the two errors. */
        const hx = Math.max(sx, sz2) * 0.8;
        const hy = sy * 0.5;
        ctx.track(ctx.physics.addBox(pt.x, pt.y - sink + hy, pt.z, hx, hy, hx));
        colliders++;
      }
    }
  }

  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  ctx.group.add(mesh);

  return {
    mesh,
    geo,
    /* Returned so the caller can OWN it. A field with a `glow` built its own
     * clone; if nobody disposes it the planet leaks a material per visit. */
    material,
    placed: res.points.length,
    requested: res.requested,
    colliders,
    points: res.points,
    rejects: res.rejects,
  };
}

/* ================================================================== */
/* Steam                                                               */
/* ================================================================== */

const PLUME_VERT = /* glsl */`
  /* aOrigin, and NOT instanceMatrix.
   *
   * Three declares "attribute mat4 instanceMatrix" only for an InstancedMesh;
   * an InstancedBufferGeometry on a plain Mesh gets no such declaration, so the
   * first version of this shader referenced an attribute that did not exist. It
   * cost nothing at build time and the whole steam field was simply absent from
   * the frame. A puff needs a POSITION, not a transform, so this is the honest
   * attribute anyway.
   * (No backticks in here: this string is a template literal.) */
  attribute vec3 aOrigin;
  attribute vec4 aPuff;      // x,z jitter, rise speed, phase
  attribute float aScale;
  uniform float uTime;
  uniform float uHeight;
  varying float vFade;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    /* Life runs 0..1 and wraps. Everything about a puff - its height, its
     * width, its opacity - is a function of that one number, so the whole
     * field animates with no CPU work and no per-frame allocation. */
    float life = fract(uTime * aPuff.z + aPuff.w);
    float rise = life * uHeight * aScale;
    // Wide at the top, narrow at the mouth: steam entrains air as it climbs.
    float wide = aScale * (1.2 + life * 5.0);
    vFade = sin(life * 3.14159) * (1.0 - life * 0.35);

    vec4 centre = vec4(aOrigin, 1.0);
    centre.xyz += vec3(aPuff.x * life * 6.0, rise, aPuff.y * life * 6.0);
    vec4 mv = modelViewMatrix * centre;
    // Billboard: the quad's own XY is applied in view space, so it always faces
    // the camera without a per-frame CPU pass over every puff.
    mv.xy += position.xy * wide;
    gl_Position = projectionMatrix * mv;
  }
`;

const PLUME_FRAG = /* glsl */`
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vFade;
  varying vec2 vUv;
  void main() {
    vec2 d = vUv - 0.5;
    float r = sqrt(dot(d, d)) * 2.0;
    /* pow 2.6 on the radial falloff, not a squared quadratic. The first version
     * gave every puff a hard bright core and the vent fields read as popcorn
     * stuck to the ground; steam has no core, only an edge that is slightly
     * less transparent than the middle of the next one. */
    float a = pow(clamp(1.0 - r, 0.0, 1.0), 2.6) * vFade * uOpacity;
    if (a < 0.004) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

/**
 * Steam over a set of vents.
 *
 * One `InstancedMesh` of camera-facing quads, animated entirely in the vertex
 * shader off `uTime` and a per-instance phase. The CPU touches it once at build
 * and then only to write a float per frame, which is what makes sixty plumes
 * affordable at all - and is the house rule about never allocating inside a
 * frame handler expressed as a design rather than as a discipline.
 *
 * @param {Array<{x:number,y:number,z:number,rnd:number}>} vents
 * @param {{ perVent:number, height:number, color:number, opacity:number, scale:number }} o
 */
export function buildPlumes(vents, o) {
  const perVent = o.perVent ?? 5;
  const n = Math.max(1, vents.length * perVent);
  const geo = new THREE.InstancedBufferGeometry();
  const quad = new THREE.PlaneGeometry(1, 1);
  geo.index = quad.index;
  geo.attributes.position = quad.attributes.position;
  geo.attributes.uv = quad.attributes.uv;
  quad.dispose();

  const puff = new Float32Array(n * 4);
  const scale = new Float32Array(n);
  const origin = new Float32Array(n * 3);
  let k = 0;
  for (const v of vents) {
    for (let i = 0; i < perVent; i++) {
      const r = ((v.rnd * 977 + i * 131.7) % 1);
      const r2 = ((v.rnd * 313 + i * 57.3) % 1);
      puff[k * 4] = (r - 0.5) * 0.9;
      puff[k * 4 + 1] = (r2 - 0.5) * 0.9;
      puff[k * 4 + 2] = 0.05 + r * 0.06;          // rise rate, cycles/second
      puff[k * 4 + 3] = i / perVent + r2 * 0.15;  // phase, so a vent is a column
      scale[k] = 0.7 + r2 * 0.8;
      origin[k * 3] = v.x;
      origin[k * 3 + 1] = v.y + 0.4;
      origin[k * 3 + 2] = v.z;
      k++;
    }
  }
  geo.setAttribute('aPuff', new THREE.InstancedBufferAttribute(puff, 4));
  geo.setAttribute('aScale', new THREE.InstancedBufferAttribute(scale, 1));
  geo.setAttribute('aOrigin', new THREE.InstancedBufferAttribute(origin, 3));
  geo.instanceCount = k;

  const mat = new THREE.ShaderMaterial({
    name: 'planet.plume',
    uniforms: {
      uTime: { value: 0 },
      uHeight: { value: o.height ?? 14 },
      uColor: { value: new THREE.Color(o.color ?? 0xc8b0a0) },
      uOpacity: { value: o.opacity ?? 0.3 },
    },
    vertexShader: PLUME_VERT,
    fragmentShader: PLUME_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'planet:plumes';
  /* Never culled and drawn late. The bounding sphere of an instanced geometry
   * whose instances are moved in the shader is a lie, and a plume that vanishes
   * because the renderer believed it is the classic version of this bug. */
  mesh.frustumCulled = false;
  mesh.renderOrder = 8;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return { mesh, material: mat, geometry: geo, count: k };
}
