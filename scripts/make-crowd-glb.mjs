/**
 * Authored hero geometry for Aether Nexus Station's ambient crowd.
 *
 * Phase 9 / decision D4: authored `.glb` hero assets through the pipeline
 * already proven four times (`make-newel-glb.mjs`, `make-ship-glb.mjs`,
 * `make-npc-glb.mjs`, `make-beast-glb.mjs`), procedural systems for bulk
 * content. This is the station's bulk population - the ~180 figures the hub
 * deck is inhabited with, which are world geometry built by `StationWorld`,
 * not NPCs.
 *
 * ── What the screenshots said, which is why these parts and not others ────
 *
 * A crowd figure photographed at 3.4 m from three headings
 * (`docs/superpowers/specs/img/2026-08-23-art-station/before-crowd-*.jpg`)
 * is a mannequin, and specifically:
 *
 *   - **No hands.** Both arms end in the round cap of a capsule. At 3-10 m a
 *     blunt stump where a hand belongs is the single loudest "this is a shop
 *     dummy" cue a figure can carry, and the plaza's gateway steps put figures
 *     at exactly that range in the entry world's hero framings.
 *   - **No hair.** The head is a bare scaled sphere with a box jaw: one smooth
 *     flesh-toned ovoid, lit identically all over because a sphere under a
 *     single overhead key has no self-occlusion anywhere. Hair is a mass with
 *     an EDGE - a fringe line, a temple line, an occipital bulge - and a
 *     sphere cannot have one.
 *   - **No collar.** The torso is a capsule over a cylinder, so the whole
 *     upper body is one unbroken barrel with a single horizontal seam at the
 *     waist. A coat collar and lapel are what say "dressed" rather than
 *     "moulded", and they are the only value break available above the belt.
 *   - **No shoes.** A 0.12 x 0.07 x 0.26 box. A real shoe has a toe that
 *     projects past the ankle and a heel that does not, and that asymmetry is
 *     most of what makes a leg read as ending in a foot rather than in a peg.
 *
 * All four are the same list `make-npc-glb.mjs` and `make-beast-glb.mjs`
 * reached for: rigid features with edges, sitting on a lofted surface that is
 * good at everything except edges.
 *
 * ── Two rules that shape every vertex below ──────────────────────────────
 *
 * **1. BODY SPACE, and the crowd's own joint table.** The crowd is not a
 * hierarchy - a figure is one merged geometry per variant plus one merged head
 * geometry, and both meshes are handed the SAME instance matrix every frame
 * (see the crowd block in `StationWorld._updateAnimated`). So there are no
 * nodes to author against and everything here is in body space, positioned
 * from `CROWD` in `station/StationKit.js` - the same table the world builds
 * the figure from. A wrist is `crowdWrist(side)`, not a number typed twice.
 *
 * **2. No new material, no new mesh, no new draw call.** Every part names one
 * of the two surfaces the crowd already draws - `body` (`M.crowd`, garment,
 * vertex-coloured) or `skin` (`M.skin`) - and is MERGED into the geometry that
 * mesh is already built from. The whole crowd is six draw calls for ~180
 * people and it stays six: what is added here is triangles and nothing else.
 *
 * That second rule is also the program-count rule. Three keys its shader cache
 * on material configuration, this project boots by warming the cartesian
 * product of those programs, and Phase 9 is named in the roadmap as the phase
 * most likely to regress production frame time - in the world where boot time
 * is measured. Reusing the two existing surfaces costs exactly zero programs.
 *
 * ── The consequence of rule 2 that decided where hair goes ───────────────
 *
 * `M.crowd` is built `vertexColors: true` so one draw call can carry a
 * three-band figure; `M.skin` is not, because it is tinted per instance from
 * its own pool of skin tones. There is no third slot, and adding one would be
 * a new material and a candidate new program - the exact cost this pipeline
 * exists to avoid.
 *
 * So hair is merged into the GARMENT geometry at a low vertex-colour shade,
 * which means a figure's hair is a dark version of its own coat colour rather
 * than an independently chosen hair colour. Every entry in the crowd palette
 * is already a desaturated dark, so at shade 0.26 the whole pool lands in a
 * near-black band with a faint hue - which is what dark hair looks like, and
 * it varies person to person for free. Stated out loud because it is a
 * constraint that was accepted, not an accident.
 *
 * ── Output ───────────────────────────────────────────────────────────────
 *
 *   public/assets/station/standing.glb   the three standing variants
 *   public/assets/station/seated.glb     the bench variant
 *
 * One mesh per part, named for the part key. Which parts a set shows is a
 * manifest decision, not a geometry one.
 *
 *   node scripts/make-crowd-glb.mjs                       # writes both
 *   CROWD_GLB_SET=seated CROWD_GLB_OUT=/tmp/x.glb node scripts/make-crowd-glb.mjs
 *
 * The env override exists for the reason the other four generators have one:
 * the byte-diff test re-runs this into a temp file and compares buffers, and a
 * generator that can only write to its committed path cannot be tested.
 */

import * as THREE from 'three';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CROWD, crowdWrist, crowdSeatedWrist, crowdFore } from '../src/worlds/station/StationKit.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ */
/* The two surfaces a part may draw in                                 */
/* ------------------------------------------------------------------ */

/**
 * `body` is `M.crowd` - the garment material, vertex-coloured, tinted per
 * instance with a coat colour. `skin` is `M.skin` - flesh, tinted per instance
 * from its own pool and carrying NO vertex colours.
 *
 * A part in the wrong slot is not a subtle defect: a hand in `body` is a
 * navy-blue hand, and hair in `skin` is a bald head with a flesh-coloured cap
 * on it. Both are refused by the loader rather than guessed at.
 */
export const SLOT = Object.freeze(['body', 'skin']);

/**
 * Which geometry each slot's parts are merged into, per set. The loader holds
 * the same list; `crowd-assets.test.mjs` keeps the two in step.
 */
export const WELDABLE = Object.freeze(['body', 'skin']);

/* ------------------------------------------------------------------ */
/* A tiny mesh accumulator                                             */
/* ------------------------------------------------------------------ */
/* Lifted in shape from `make-beast-glb.mjs`, which took it from
 * `make-npc-glb.mjs`. Kept as its own copy rather than factored into a shared
 * module for the reason `make-newel-glb.mjs` gives: five generators that each
 * stand alone can be read end to end, and the byte-diff tests pin all five
 * against their committed output, so a divergence cannot ship silently. */

class Mesher {
  constructor() {
    this.pos = [];
    this.nor = [];
    this.uv = [];
    this.idx = [];
  }

  /**
   * @param {THREE.BufferGeometry} geo already sized; only placed here
   * @param {[number,number,number]} at body-space position
   * @param {{rot?:[number,number,number], scale?:[number,number,number]}} [opts]
   */
  add(geo, at, opts = {}) {
    const g = geo.clone();
    const { rot, scale } = opts;
    if (scale) g.scale(scale[0], scale[1], scale[2]);
    if (rot) { g.rotateX(rot[0]); g.rotateY(rot[1]); g.rotateZ(rot[2]); }
    g.translate(at[0], at[1], at[2]);
    if (!g.index) throw new Error('Mesher.add needs indexed geometry');
    const base = this.pos.length / 3;
    const p = g.attributes.position.array;
    const n = g.attributes.normal.array;
    const t = g.attributes.uv?.array;
    for (let i = 0; i < p.length; i++) this.pos.push(p[i]);
    for (let i = 0; i < n.length; i++) this.nor.push(n[i]);
    for (let i = 0; i < p.length / 3; i++) {
      this.uv.push(t ? t[i * 2] : 0, t ? t[i * 2 + 1] : 0);
    }
    const idx = g.index.array;
    for (let i = 0; i < idx.length; i++) this.idx.push(idx[i] + base);
    g.dispose();
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
      /* A NaN position blooms over the whole figure once it is merged, and is
       * invisible in the numbers printed at the end. Same gate the other four
       * generators carry, for the same reason. */
      if (!Number.isFinite(v)) throw new Error(`${name}: non-finite position`);
    }
    return g;
  }
}

/* Primitive stock, built once and cloned per placement.
 *
 * Segment counts are chosen against the reservation at the bottom of this
 * file, not by habit. A default `SphereGeometry(1, 12, 8)` is 192 triangles;
 * these parts are multiplied by ~180 figures in the world group, so every ring
 * costs 180 times what it looks like it costs. What a part is READ BY decides
 * its count: a hand is read by its outline and its knuckle break, a shoe by
 * its toe, and a hair cap by where its edge crosses the brow. */
const SPH = (w, h, phiLen = Math.PI * 2, thetaStart = 0, thetaLen = Math.PI) =>
  new THREE.SphereGeometry(1, w, h, 0, phiLen, thetaStart, thetaLen);
const BOX = () => new THREE.BoxGeometry(1, 1, 1);

const box = BOX();
/**
 * The hair cap's shell, and the two numbers a screenshot forced.
 *
 * `segments` is how many facets go round it and `grow` is how far its vertices
 * stand off the skull. They are exported together because they are not
 * independent: a chord of an `n`-segment circle sits `1 - cos(pi/n)` of the
 * radius INSIDE the arc its vertices lie on, so a cap that clears the head at
 * its vertices can still be pierced by it between them. Raising the segment
 * count without lowering `grow`, or lowering `grow` without raising the
 * segment count, brings back the striped helmet of `after-crowd-front` (first
 * attempt). `crowd-assets.test.mjs` holds the relation.
 */
export const HAIR_CAP = Object.freeze({ segments: 8, rings: 3, grow: 1.13 });

/** Upper 55% of a sphere, 8 around x 3 down: 40 tris. A hair cap's shell. */
const capShell = SPH(HAIR_CAP.segments, HAIR_CAP.rings, Math.PI * 2, 0, Math.PI * 0.55);
/** 6x3 sphere, 24 tris. A mass read by nothing but a rounded silhouette. */
const sphTiny = SPH(6, 3);

/* ------------------------------------------------------------------ */
/* The parts                                                           */
/* ------------------------------------------------------------------ */

/**
 * Hair, merged into the GARMENT geometry (see the header for why).
 *
 * Three masses, not one cap:
 *
 *  1. a shell over the cranium, scaled by the head sphere's OWN non-uniform
 *     triple so it hugs a 0.94/1.12/1.0 ovoid instead of floating off it at
 *     the temples;
 *  2. an occipital wedge at the back, which is the mass that turns a profile
 *     from "ball" into "head" and is the only part of this that reads from
 *     behind - and behind is where most of a crowd is seen from;
 *  3. a fringe bar across the brow, sitting just proud of the skull, which
 *     gives the hair a hard lower EDGE against the face. Without it the cap
 *     fades into the head at exactly the value boundary the eye uses to find a
 *     face, and the figure is bald again at 15 m.
 *
 * `dy`/`dz` carry the seated head's offset, so one function authors both sets.
 */
function hair(m, dy = 0, dz = 0) {
  const C = CROWD;
  const cy = C.HEAD_Y + dy;
  /* 1.13, and the number is a screenshot's.
   *
   * The first draft used 1.045 - about 4.5 mm of clearance on a 105 mm skull,
   * which reads as ample and is not. The cap is EIGHT segments around and the
   * head under it is twelve, and a chord of an eight-segment circle sits
   * `1 - cos(pi/8)` = 7.6% of the radius INSIDE the arc its vertices are on.
   * So the cap's flat facets dipped below the smooth sphere between every pair
   * of vertices and the skin striped through the hair: eight bright wedges
   * radiating off the crown, which photographed as a black-and-tan striped
   * helmet and was completely invisible in the source.
   *
   * 13% clears 7.6% of sag with margin, and a hair mass that stands a
   * centimetre off the skull is what hair does anyway. The alternative - more
   * segments - costs ten triangles times a hundred and eighty figures for a
   * rounder edge nobody can resolve, which is the trade this whole file is
   * about. */
  const { grow } = HAIR_CAP;
  m.add(capShell, [0, cy, dz], {
    scale: [C.HEAD_R * C.HEAD_SX * grow, C.HEAD_R * C.HEAD_SY * grow, C.HEAD_R * C.HEAD_SZ * grow],
  });
  // Occipital mass: back of the skull, dropping onto the nape.
  m.add(sphTiny, [0, cy - 0.028, dz - C.HEAD_R * 0.46], {
    scale: [C.HEAD_R * 0.88, C.HEAD_R * 0.80, C.HEAD_R * 0.66],
  });
  /* Fringe: a shallow bar across the brow, raked back a little so it reads as
   * hair lying on a head rather than as a headband. Placed against the GROWN
   * cap rather than against the skull, so it stays welded to the cap's lower
   * edge instead of sinking behind it when the clearance above changes. */
  m.add(box, [0, cy + C.HEAD_R * 0.50 * grow, dz + C.HEAD_R * 0.66 * grow], {
    scale: [C.HEAD_R * 1.58, C.HEAD_R * 0.46, C.HEAD_R * 0.42],
    rot: [-0.34, 0, 0],
  });
}

/**
 * A coat collar and lapel, merged into the garment geometry.
 *
 * The collar is a raised band around the base of the neck; the lapels are two
 * flat wedges running down and out across the chest. Together they put a V
 * into the one part of the figure that had no shape information at all.
 *
 * Authored as two mirrored placements rather than through a mirror helper,
 * because the mirror is exact here (the torso is symmetric) and two explicit
 * placements are two lines - `Mesher.pair`'s winding correction earns itself
 * on a 300-triangle beast ruff, not on a pair of quads.
 */
function collar(m, { chestY, chestR, yokeY, tilt = 0, dz = 0 }) {
  /* Collar band: sits just above the yoke, at the neck. Slightly wider than
   * the neck so it stands off the shoulder line and catches the key. */
  m.add(box, [0, yokeY + 0.055, dz - 0.005], {
    scale: [0.17, 0.055, 0.155],
    rot: [tilt, 0, 0],
  });
  for (const s of [-1, 1]) {
    /* Lapel: from the collar down and outward to mid-chest. Rotated about z so
     * it lies along the V, and given a small x rotation so it follows the
     * barrel rather than cutting through it. */
    m.add(box, [s * chestR * 0.42, chestY + 0.14, dz + chestR * 0.86], {
      scale: [0.062, 0.30, 0.030],
      rot: [tilt + 0.12, 0, s * 0.46],
    });
  }
}

/**
 * A hand, merged into the SKIN geometry.
 *
 * A palm slab with a thumb mass and a tapered knuckle block. Not a sphere: at
 * the scale a crowd figure is seen the hand is four or five pixels across and
 * what carries it is the OUTLINE - a rectangle with a bump on one side reads
 * as a hand, and a ball reads as the capsule cap that is already there.
 *
 * `at` comes from `crowdWrist` / `crowdSeatedWrist`, never from a literal.
 * `down` is the unit direction the forearm points, so the hand continues the
 * arm instead of hanging off it at an angle.
 */
function hand(m, at, { rot }) {
  // Palm.
  m.add(box, at, { scale: [0.052, 0.105, 0.078], rot });
  /* Thumb: on the inboard side, which is what makes a hand a hand in outline.
   *
   * A box, not the small sphere it was first written as. The sphere was 36
   * triangles for a 2 cm lump - 72 across the pair, a quarter of this file's
   * whole reservation - and at 180 instances that is thirteen thousand
   * triangles spent on a rounded edge nobody can resolve. Canted off the palm
   * so the outline still breaks. */
  const inboard = at[0] > 0 ? -1 : 1;
  m.add(box, [at[0] + inboard * 0.028, at[1] + 0.020, at[2] + 0.012], {
    scale: [0.024, 0.052, 0.026],
    rot: [rot[0], rot[1], rot[2] + inboard * 0.42],
  });
  // Knuckle block, a touch narrower, closing the far end.
  m.add(box, [at[0], at[1] - 0.052, at[2]], { scale: [0.046, 0.038, 0.070], rot });
}

/**
 * A shoe, merged into the garment geometry, authored PER SIDE.
 *
 * The existing foot is one box centred on the ankle. A shoe is not symmetric
 * front-to-back: the toe runs forward past the ankle and the heel does not,
 * and that overhang is what the eye reads. Two masses - a raked toe cap and a
 * shorter heel block - cost forty triangles and give the leg an end.
 *
 * `fore` is `crowdFore(side)` and is DIFFERENT per side: the crowd's stance is
 * offset fore and aft as well as laterally, so these are not a mirror pair.
 */
function shoe(m, side, { x, y, z }) {
  // Toe cap, raked so its top face falls away toward the front.
  m.add(box, [side * x, y + 0.012, z + 0.115], {
    scale: [0.104, 0.052, 0.115],
    rot: [-0.16, 0, 0],
  });
  // Heel: shorter, squarer, set back under the ankle.
  m.add(box, [side * x, y - 0.006, z - 0.098], {
    scale: [0.098, 0.062, 0.076],
  });
}

/* ------------------------------------------------------------------ */
/* The two sets                                                        */
/* ------------------------------------------------------------------ */

/**
 * `slot` is which of the crowd's two existing geometries a part merges into;
 * `shade` is the vertex-colour value baked on at load for `body` parts, which
 * multiplies the instance's garment colour. `skin` parts carry no vertex
 * colour at all, because `M.skin` is not built with `vertexColors`.
 */
const SETS = {
  standing: {
    file: 'standing.glb',
    parts: {
      hair: {
        slot: 'body', shade: 0.26, uv: 2,
        build: (m) => hair(m),
      },
      collar: {
        slot: 'body', shade: 1.22, uv: 3,
        build: (m) => collar(m, {
          chestY: CROWD.CHEST_Y, chestR: CROWD.CHEST_R, yokeY: CROWD.YOKE_Y,
        }),
      },
      hand: {
        slot: 'skin', uv: 2,
        build: (m) => {
          for (const s of [-1, 1]) {
            hand(m, crowdWrist(s), { rot: [0, 0, s * CROWD.ARM_TILT] });
          }
        },
      },
      shoe: {
        slot: 'body', shade: 0.30, uv: 3,
        build: (m) => {
          for (const s of [-1, 1]) {
            shoe(m, s, {
              x: CROWD.LEG_X,
              y: CROWD.FOOT_Y,
              z: crowdFore(s) + CROWD.FOOT_DZ,
            });
          }
        },
      },
    },
  },
  seated: {
    file: 'seated.glb',
    parts: {
      hair: {
        slot: 'body', shade: 0.26, uv: 2,
        build: (m) => hair(m, CROWD.SEAT_HEAD_DY, CROWD.SEAT_HEAD_DZ),
      },
      collar: {
        slot: 'body', shade: 1.22, uv: 3,
        build: (m) => collar(m, {
          chestY: CROWD.SEAT_CHEST_Y, chestR: CROWD.CHEST_R, yokeY: CROWD.SEAT_YOKE_Y,
          tilt: CROWD.SEAT_CHEST_RX, dz: CROWD.SEAT_CHEST_Z,
        }),
      },
      hand: {
        slot: 'skin', uv: 2,
        build: (m) => {
          for (const s of [-1, 1]) {
            hand(m, crowdSeatedWrist(s), {
              rot: [CROWD.SEAT_ARM_RX, 0, s * CROWD.SEAT_ARM_TILT],
            });
          }
        },
      },
      shoe: {
        slot: 'body', shade: 0.30, uv: 3,
        build: (m) => {
          for (const s of [-1, 1]) {
            shoe(m, s, {
              x: CROWD.SEAT_THIGH_X,
              y: CROWD.SEAT_FOOT_Y,
              z: CROWD.SEAT_FOOT_Z + CROWD.FOOT_DZ,
            });
          }
        },
      },
    },
  },
};

/* ------------------------------------------------------------------ */
/* Minimal binary glTF 2.0 writer                                      */
/* ------------------------------------------------------------------ */
/* Verbatim from `make-beast-glb.mjs`, which took it from
 * `make-npc-glb.mjs`, which took it from `make-newel-glb.mjs`. See the note on
 * `Mesher` for why this is copied rather than shared. */

const align = (n) => Math.ceil(n / 4) * 4 - n;

function accessorMinMax(array, itemSize, count) {
  const min = new Array(itemSize).fill(Infinity);
  const max = new Array(itemSize).fill(-Infinity);
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < itemSize; c++) {
      const v = array[i * itemSize + c];
      if (v < min[c]) min[c] = v;
      if (v > max[c]) max[c] = v;
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
  let tris = 0;
  let verts = 0;

  for (const [key, def] of Object.entries(parts)) {
    const m = new Mesher();
    def.build(m);
    const geo = m.geometry(key);
    const vCount = geo.attributes.position.count;
    const iArr = geo.index.array;
    verts += vCount;
    tris += iArr.length / 3;

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
      pbrMetallicRoughness: { baseColorFactor: [0.5, 0.5, 0.5, 1], metallicFactor: 0, roughnessFactor: 0.9 },
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
      generator: 'aether-nexus scripts/make-crowd-glb.mjs',
      copyright: 'generated - procedurally authored in this repository, no external source',
    },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    /* Placeholders so the file stands alone in a viewer. The game DISCARDS
     * every one of these and merges each part into the geometry the crowd
     * already draws for the slot the manifest names - see CrowdAssets.js. A
     * test asserts the set of materials a built crowd ends up with is
     * unchanged by loading this. */
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

  return { glb: Buffer.concat([header, jsonHeader, jsonBytes, binHeader, binBytes]), tris, verts };
}

/* ------------------------------------------------------------------ */

/**
 * Triangle reservation, and the reason it is tighter than the beast's.
 *
 * These merge into geometry the crowd already draws, so they cost no draw call
 * and no material - but the crowd is WORLD geometry, ~180 instances of it, and
 * every triangle here is therefore multiplied by 180 in the world-triangle
 * number Phase 9 is gated on. A standing figure is 784 triangles today (524
 * body + 260 head); 240 more is +31% on a figure and about 43,000 on a station
 * framing measured at 2.1-3.3 M, i.e. under 1.5%.
 *
 * Six hundred would not be, and the difference between 240 and 600 here is a
 * couple of segment counts nobody would notice at 3 m and everybody would pay
 * for at 180 instances. So the gate is in the generator, not in a review
 * comment.
 */
export const TRI_BUDGET = { standing: 240, seated: 240 };

/** The parts each set shows, for the manifest and for the tests. */
export const SET_PARTS = Object.freeze(
  Object.fromEntries(Object.entries(SETS).map(([k, v]) => [k, Object.keys(v.parts)]))
);

/** part key -> { slot, shade, uv }, for the manifest and for the tests. */
export const PART_BINDING = Object.freeze(
  Object.fromEntries(
    Object.entries(SETS).map(([k, v]) => [
      k,
      Object.fromEntries(Object.entries(v.parts).map(([pk, pd]) => [
        pk,
        pd.slot === 'body' ? { slot: pd.slot, shade: pd.shade, uv: pd.uv } : { slot: pd.slot, uv: pd.uv },
      ])),
    ])
  )
);

/* Guarded so the module can be imported by the test without writing files.
 * `import.meta.main` is Node 22; the `argv` comparison is the portable half. */
const isMain = path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const only = process.env.CROWD_GLB_SET;
  const outOverride = process.env.CROWD_GLB_OUT;
  if (outOverride && !only) {
    throw new Error('CROWD_GLB_OUT needs CROWD_GLB_SET - it names one file, not both');
  }

  for (const [name, set] of Object.entries(SETS)) {
    if (only && only !== name) continue;
    for (const [key, def] of Object.entries(set.parts)) {
      if (!WELDABLE.includes(def.slot)) {
        throw new Error(`${name}.${key} binds to slot '${def.slot}', which the crowd draws no mesh for`);
      }
      if (def.slot === 'body' && !(def.shade > 0)) {
        throw new Error(`${name}.${key} is a body part with no shade - it would merge with no vertex colour`);
      }
      if (def.slot === 'skin' && def.shade !== undefined) {
        throw new Error(`${name}.${key} is a skin part with a shade - M.skin has no vertexColors to read it`);
      }
    }
    const { glb, tris, verts } = writeGlb(name, set.parts);
    if (tris > TRI_BUDGET[name]) {
      throw new Error(`${name} is ${tris} tris - over the ${TRI_BUDGET[name]} reservation`);
    }
    const out = outOverride
      ? path.resolve(outOverride)
      : path.join(root, 'public/assets/station', set.file);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, glb);
    console.log(`${out}\n  ${Object.keys(set.parts).length} parts, ${verts} verts, ${tris} tris, ${glb.length} bytes`);
  }
}
