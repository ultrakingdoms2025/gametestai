/**
 * Authored hero geometry for Meridian Athletic Grounds' crowd.
 *
 * Phase 9 / decision D4: authored `.glb` hero assets through the pipeline
 * proven five times (`make-newel-glb.mjs`, `make-ship-glb.mjs`,
 * `make-npc-glb.mjs`, `make-beast-glb.mjs`, `make-crowd-glb.mjs`,
 * `make-yard-glb.mjs`), procedural systems for bulk content. This world's bulk
 * content is its crowd - **583 figures**, measured, which is 21% of every
 * triangle the sports world draws - and this file authors the three features
 * that separate a person from the stack of six-sided cylinders
 * `SportsWorld._buildCrowd` merges.
 *
 * ── What the screenshots said, which is why these parts and not others ────
 *
 * `docs/superpowers/specs/img/2026-08-23-art-sports/before-crowdpad-front.jpg`
 * and `before-crowdplaza-three-quarter.jpg` are a crowd figure at four metres
 * from two headings. It is a mannequin, and specifically:
 *
 *   - **No hair.** The head is a bare `SphereGeometry(0.108, 8, 6)` and
 *     nothing else. Under this world's single 14-degree key a sphere has no
 *     self-occlusion anywhere, so every one of the 583 figures photographs as
 *     an identical smooth flesh egg balanced on a barrel. It is the single
 *     loudest cue in the frame and it is the same one `art-station` found on
 *     its own crowd.
 *   - **No hands.** Every arm ends in the flat six-sided cap of a
 *     `CylinderGeometry(..., 6)`. Not a rounded stump - a visibly CUT HEXAGON,
 *     which is worse, because a hexagon is a shape the eye recognises as
 *     machined.
 *   - **No shoes.** Every leg ends in the same cut hexagon, sitting flat on
 *     the concrete. A leg that ends in a disc reads as a peg; the thing that
 *     makes it read as a leg is a mass that projects FORWARD past the ankle,
 *     which no end cap of a vertical cylinder can ever do.
 *
 * ── Two rules that shape every vertex below ──────────────────────────────
 *
 * **1. FIGURE SPACE, and the crowd's own limb table.** A figure is not a
 * hierarchy - it is one merged cloth geometry and one merged skin geometry per
 * pose, both handed the same instance matrix. There are no nodes to author
 * against, so everything here is placed by `place(spec, ...)` against the LIMB
 * it attaches to, out of `src/worlds/sports/CrowdKit.js` - the same table
 * `SportsWorld` builds the figure from. A wrist is
 * `place(armOf(pose, side), [0, -len/2 - d, 0])`, never a number typed twice.
 * That is the `make-beast-glb.mjs` pattern rather than the older
 * `make-ship-glb.mjs` one, and it is why moving a sleeve length in the kit
 * turns the byte-diff test red instead of quietly putting a hand in mid-air.
 *
 * **2. No new material, no new mesh, no new draw call.** Every part names one
 * of the two surfaces the crowd already draws - `cloth` (`sports.crowd.cloth`)
 * or `skin` (`sports.crowd.skin`) - and is MERGED into the geometry that
 * `InstancedMesh` is already built from. The crowd is TEN instanced meshes for
 * 583 people and it stays ten: what is added here is triangles and nothing
 * else. That is also the program-count rule: three keys its shader cache on
 * material configuration and this project boots by warming the cartesian
 * product of those programs, so a crowd that brought its own PBR material
 * would be a new program family on every boot.
 *
 * ── Why the segment counts are lower than the station's ──────────────────
 *
 * `make-crowd-glb.mjs` spends 240 triangles a figure on four parts across ~180
 * figures on the entry world, where the hero framings put a figure at 3-10 m.
 * This world has **583** figures and its crowd is bulk set dressing seen
 * mostly at 8-60 m. 240 here would be 140,000 triangles, on a world already
 * measured at 511k-781k. So each part is authored at the coarsest count that
 * still carries its read: the hair cap is 8 x 2 rather than 8 x 3, and the
 * hand and the shoe are ONE box each rather than the station's two.
 *
 * A single box is not a compromise on the read, it is the read: what makes a
 * hand a hand at this distance is that the outline stops being a hexagon and
 * starts being a rectangle wider than the arm, and what makes a shoe a shoe is
 * that the mass projects forward past the ankle. Both are one box.
 *
 * ── The proportion decision, stated because it looks wrong written down ──
 *
 * The shoe is 0.19 m wide. That is enormous for a foot and correct for THIS
 * foot: the leg it caps is `r1 = 0.105`, so the ankle is 0.21 m across and its
 * hexagonal end face is 0.182 m flat-to-flat. A 0.10 m shoe - a real shoe -
 * would leave the leg's own end sticking out either side of it, which is worse
 * than no shoe. The figure's proportions are the brief, not a human's.
 *
 * That width is also load-bearing in the budget: because the shoe genuinely
 * covers the leg's end face, `SportsWorld` may build the leg `openEnded` and
 * save the twelve triangles of the cap it no longer needs. The same is true of
 * the hand and the sleeve. See `SPARED` at the bottom of this file.
 *
 * ── Output ───────────────────────────────────────────────────────────────
 *
 *   public/assets/sports/crowd-stand.glb    and carry / lean / sit / crouch
 *
 * One mesh per part, named for the part key. Which parts a set shows is a
 * manifest decision, not a geometry one.
 *
 *   node scripts/make-sports-crowd-glb.mjs                        # writes all five
 *   SPORTS_CROWD_GLB_SET=sit SPORTS_CROWD_GLB_OUT=/tmp/x.glb node scripts/make-sports-crowd-glb.mjs
 *
 * The env override exists for the reason the other six generators have one:
 * the byte-diff test re-runs this into a temp file and compares buffers, and a
 * generator that can only write to its committed path cannot be tested.
 */

import * as THREE from 'three';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  POSES, POSE_KEYS, place, specOf, headOf,
} from '../src/worlds/sports/CrowdKit.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ */
/* The two surfaces a part may draw in                                 */
/* ------------------------------------------------------------------ */

/**
 * `cloth` is the garment material and `skin` is flesh. BOTH are built
 * `vertexColors: true` in this world and both are tinted per instance, so
 * unlike the station's crowd every part here carries a `shade` - a skin part
 * with no shade would merge with the generic vertex-attribute default of
 * (0,0,0) and render the hands pure black, which is exactly the failure
 * `whiteColor()` in `SportsWorld.js` documents having already shipped once.
 *
 * A part in the wrong slot is not a subtle defect: a hand in `cloth` is a
 * navy-blue hand and hair in `skin` is a flesh-coloured cap. Both are refused
 * by the loader rather than guessed at.
 */
export const SLOT = Object.freeze(['cloth', 'skin']);

/* ------------------------------------------------------------------ */
/* A tiny mesh accumulator                                             */
/* ------------------------------------------------------------------ */
/* Lifted in shape from `make-crowd-glb.mjs`, which took it from
 * `make-beast-glb.mjs`. Kept as its own copy rather than factored into a
 * shared module for the reason `make-newel-glb.mjs` gives: generators that
 * each stand alone can be read end to end, and the byte-diff tests pin all of
 * them against their committed output, so a divergence cannot ship silently. */

class Mesher {
  constructor() {
    this.pos = [];
    this.nor = [];
    this.uv = [];
    this.idx = [];
  }

  /**
   * @param {THREE.BufferGeometry} geo already sized; only placed here
   * @param {number[]} at figure-space position
   * @param {{rot?:number[], scale?:number[]}} [opts]
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
      /* A NaN position blooms over the whole figure once it is merged and is
       * invisible in the numbers printed at the end. Same gate the other six
       * generators carry, for the same reason. */
      if (!Number.isFinite(v)) throw new Error(`${name}: non-finite position`);
    }
    /* THE NON-UNIT NORMAL GATE.
     *
     * `art-citadel` dissolved a gatehouse into a white cloud because a
     * degenerate quad produced a ZERO-LENGTH normal: finite, valid glTF, and
     * NaN the instant a shader normalizes it. Nothing here builds a quad by
     * hand - every part is a three primitive, scaled - but a scale with a zero
     * component would produce exactly that, and a scale with a zero component
     * is one mistyped number away at all times. So the build refuses rather
     * than shipping a file that renders as a hole.
     *
     * `sports-crowd-assets.test.mjs` re-asserts this against the COMMITTED
     * bytes, because a gate that only runs in the generator cannot see a file
     * that was committed before the gate existed. */
    for (let i = 0; i < this.nor.length; i += 3) {
      const l = Math.hypot(this.nor[i], this.nor[i + 1], this.nor[i + 2]);
      if (!(Math.abs(l - 1) < 1e-3)) {
        throw new Error(`${name}: normal ${i / 3} has length ${l}, not 1`);
      }
    }
    return g;
  }
}

/* Primitive stock, built once and cloned per placement.
 *
 * Segment counts are chosen against the reservation at the bottom of this
 * file, not by habit: these parts are multiplied by 583 figures in the world
 * group, so every ring costs 583 times what it looks like it costs. */
const box = new THREE.BoxGeometry(1, 1, 1);

/**
 * The hair cap's shell, and the two numbers a screenshot forced on the station
 * and arithmetic forces here.
 *
 * `segments` is how many facets go round and `rings` how many go down; `grow`
 * is how far the cap's vertices stand off the skull. They are not independent.
 * The cap is 8 segments round and so is the head under it, and both start at
 * phi 0, so the two agree exactly in azimuth and there is no sag THERE. In
 * THETA they do not: the cap covers `0.58 * PI` in two rings, so each ring
 * spans 52.2 degrees and its chord sits `1 - cos(26.1deg)` = **10.2%** of the
 * radius inside the arc its vertices lie on.
 *
 * So `grow` must exceed 1.102 or the skin stripes through the hair in two
 * bands - which is the striped helmet `make-crowd-glb.mjs` records
 * photographing on the station's first attempt, and which is invisible in
 * source. 1.13 clears it with 2.8 points of margin, and a hair mass that
 * stands a centimetre off the skull is what hair does anyway.
 *
 * `sports-crowd-assets.test.mjs` holds the relation, so raising `rings`
 * without lowering `grow` cannot silently bring the stripes back.
 */
export const HAIR_CAP = Object.freeze({ segments: 8, rings: 2, sweep: 0.58, grow: 1.13 });

const capShell = new THREE.SphereGeometry(
  1, HAIR_CAP.segments, HAIR_CAP.rings, 0, Math.PI * 2, 0, Math.PI * HAIR_CAP.sweep
);

/* ------------------------------------------------------------------ */
/* The parts                                                           */
/* ------------------------------------------------------------------ */

/**
 * Hair, merged into the CLOTH geometry.
 *
 * Two masses, not three: a shell over the cranium stretched backwards so the
 * occipital bulge comes for free from the scale rather than from a second
 * sphere, and a fringe bar across the brow.
 *
 * The fringe is the part that cannot be dropped. Without it the cap fades into
 * the head at exactly the value boundary the eye uses to find a face, because
 * the cap's lower edge is a smooth circle lying ON the skull and a smooth
 * circle at a grazing angle has no silhouette. A hard bar across the brow
 * gives the hair a lower EDGE, and an edge is what a 14-degree key catches.
 *
 * Placed against the GROWN cap rather than against the skull, so it stays
 * welded to the cap's lower rim if the clearance above ever changes.
 */
function hair(m, pose) {
  const h = headOf(pose);
  const g = HAIR_CAP.grow;
  const [hx, hy, hz] = h.at;
  /* Stretched 1.18 in Z: a head is longer front-to-back than it is wide, and
   * the crowd's is a perfect sphere. The stretch is applied to the HAIR rather
   * than to the head because the head is skin geometry shared with the neck
   * and 583 instances of a re-scaled sphere is a change to a shape a player
   * sees the front of; the hair is the mass that is supposed to overhang the
   * nape, and overhanging the nape is what turns a profile from "ball" into
   * "head". */
  m.add(capShell, [hx, hy, hz - h.r * 0.05], {
    scale: [h.r * g, h.r * g, h.r * g * 1.18],
  });
  m.add(box, [hx, hy + h.r * 0.46 * g, hz + h.r * 0.72 * g], {
    scale: [h.r * 1.52, h.r * 0.42, h.r * 0.40],
    rot: [-0.30, 0, 0],
  });
}

/**
 * A hand, merged into the SKIN geometry, placed in the ARM's own frame.
 *
 * `place(arm, [0, -len/2 - d, 0])` is the wrist plus `d` further down the
 * sleeve, expressed in limb space and transformed by the arm's own rotation -
 * so the hand continues the sleeve at whatever angle the sleeve happens to be
 * at, including `carry`'s raised left arm at 0.9 rad, without this file
 * knowing that angle.
 *
 * `WRIST_LAP` is negative overlap: the hand starts 15 mm ABOVE the sleeve's end
 * face, so the two solids interpenetrate rather than meeting on a plane. Two
 * coplanar faces at the same depth is z-fighting, and z-fighting on a wrist is
 * a flickering ring the shot review will call "shadow acne".
 */
const WRIST_LAP = 0.015;

function hand(m, pose, side) {
  const arm = specOf(pose, 'arm', side);
  if (!arm) return;
  /* Half the hand's own length past the sleeve end, less the lap. */
  const HAND_LEN = 0.115;
  const at = place(arm, [0, -arm.len / 2 - HAND_LEN / 2 + WRIST_LAP, 0]);
  m.add(box, at, {
    scale: [0.100, HAND_LEN, 0.085],
    rot: [arm.rx ?? 0, 0, arm.rz ?? 0],
  });
}

/**
 * A shoe, merged into the CLOTH geometry, in FIGURE space rather than in the
 * leg's.
 *
 * Deliberately not in the leg's frame, which is what the hand uses. A sleeve
 * carries the hand with it when it swings; a foot does not roll with the
 * shin - it stays flat on the ground and points where the person is facing,
 * and every one of this world's legs is within 0.12 rad of vertical anyway.
 * Taking the ankle POINT from the limb and then standing the shoe up in figure
 * space is what a foot does.
 *
 * The rake is on X so the toe cap falls away toward the front, which is the
 * only shape information a single box can carry.
 */
function shoe(m, pose, side) {
  const leg = specOf(pose, 'leg', side);
  if (!leg) return;
  const [ax, ay, az] = place(leg, [0, -leg.len / 2, 0]);
  /* Sit on the ground the ankle sits on, not below it: `sit`'s shins end on a
   * bleacher tread at y=0 exactly as `stand`'s legs end on the pad, and both
   * want the sole at the same place. */
  m.add(box, [ax, Math.max(ay, 0) + 0.036, az + 0.052], {
    scale: [0.190, 0.072, 0.300],
    rot: [-0.10, 0, 0],
  });
}

/* ------------------------------------------------------------------ */
/* The five sets                                                       */
/* ------------------------------------------------------------------ */

/**
 * `slot` is which of the crowd's two geometries a part merges into and `shade`
 * is the vertex-colour value baked on at load, which multiplies that
 * instance's tint.
 *
 * Hair at 0.22 against this world's sixteen-colour sportswear palette lands
 * every figure in a near-black band with a faint hue of its own top - which is
 * what dark hair looks like and varies person to person for free. It is a
 * constraint accepted rather than an accident: the crowd draws through one
 * instance-tinted material, and an independently chosen hair colour would be a
 * second material and a candidate new shader program, which is the one cost
 * this whole pipeline exists to avoid.
 *
 * The shoe at 0.30 is the same bargain. Skin at 1.0 is a no-op multiplier: the
 * hand takes the figure's own skin tone, which is the only correct answer.
 */
const PART_DEFS = {
  hair: { slot: 'cloth', shade: 0.22, build: hair },
  hand: { slot: 'skin', shade: 1.0, build: (m, pose) => { hand(m, pose, -1); hand(m, pose, 1); } },
  shoe: { slot: 'cloth', shade: 0.30, build: (m, pose) => { shoe(m, pose, -1); shoe(m, pose, 1); } },
};

/** Which parts each pose set ships. All five get all three. */
const SETS = Object.freeze(Object.fromEntries(
  POSE_KEYS.map((pose) => [pose, { file: `crowd-${pose}.glb`, parts: ['hair', 'hand', 'shoe'] }])
));

/* ------------------------------------------------------------------ */
/* Minimal binary glTF 2.0 writer                                      */
/* ------------------------------------------------------------------ */
/* Verbatim from `make-crowd-glb.mjs`. See the note on `Mesher` for why this is
 * copied rather than shared. */

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

function writeGlb(setName, partKeys) {
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

  for (const key of partKeys) {
    const def = PART_DEFS[key];
    const m = new Mesher();
    def.build(m, setName);
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
      generator: 'aether-nexus scripts/make-sports-crowd-glb.mjs',
      copyright: 'generated - procedurally authored in this repository, no external source',
    },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    /* Placeholders so the file stands alone in a viewer. The game DISCARDS
     * every one of these and merges each part into the geometry the crowd
     * already draws for the slot the manifest names - see SportsCrowdAssets.js.
     * A test asserts the material set of a crowd built with these files
     * installed is identical to one built without them. */
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
 * Triangle reservation, per figure, and the arithmetic behind it.
 *
 * These merge into geometry the crowd already draws, so they cost no draw call
 * and no material - but the crowd is WORLD geometry and every triangle here is
 * multiplied by the number of figures in its pose. Measured off a named-material
 * run of the real world (`byMaterial` on `sports.crowd.cloth` / `.skin`):
 *
 *     stand 132   lean 42   carry 19   crouch 8   sit 382   = 583 figures
 *
 * 84 triangles a set is 48,972 across the world. The reservation is 96 so a
 * fourth part can be added without editing this comment, and so that a segment
 * count raised by habit rather than by a screenshot fails the build.
 */
export const TRI_BUDGET = 96;

/**
 * What the authored parts BUY BACK, which is the other half of the budget.
 *
 * A `CylinderGeometry(r0, r1, len, 6)` is 24 triangles: 12 of side and 12 of
 * end cap. Once a shoe covers a leg's end face and a hand covers a sleeve's,
 * those caps are interior geometry that can never be seen, so `SportsWorld`
 * builds those limbs `openEnded` - **only when the authored part that covers
 * the far end has actually landed**, because an open-ended leg with no shoe on
 * it is a hollow tube and a graceful degradation that degrades to a hole is
 * not one.
 *
 * This table is the list of limbs that qualify, per pose, and it is exported
 * so `sports-crowd-assets.test.mjs` can hold the world's `figure()` to it. A
 * limb NOT in this list keeps its caps because one of its two end faces is
 * genuinely visible:
 *
 *   - every `torso`, whose top face is the shoulder plate and is only 46 mm
 *     covered by the neck;
 *   - `crouch`'s limbs, whose thigh and shin do not actually meet (their end
 *     faces are 30 cm apart in z) and whose shoulder sits clear of the torso;
 *   - `sit`'s arms, whose shoulder end is 33 cm from the torso axis against a
 *     torso radius of 0.155, and `sit`'s thighs, whose rear cap sits just
 *     below the torso rather than inside it.
 *
 * Each of those was computed rather than eyeballed, and each is a hole in the
 * figure if it is wrong. `openEnded` opens BOTH ends, which is why one visible
 * face disqualifies a limb.
 */
export const SPARED = Object.freeze({
  stand: ['leg', 'arm'],
  carry: ['leg', 'arm'],
  lean: ['leg', 'arm'],
  sit: ['leg'],
  crouch: [],
});

/** The parts each set shows, for the manifest and for the tests. */
export const SET_PARTS = Object.freeze(
  Object.fromEntries(Object.entries(SETS).map(([k, v]) => [k, v.parts]))
);

/** part key -> { slot, shade }, for the manifest and for the tests. */
export const PART_BINDING = Object.freeze(
  Object.fromEntries(Object.entries(PART_DEFS).map(([k, d]) => [k, { slot: d.slot, shade: d.shade }]))
);

/* Guarded so the module can be imported by the test without writing files. */
const isMain = path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const only = process.env.SPORTS_CROWD_GLB_SET;
  const outOverride = process.env.SPORTS_CROWD_GLB_OUT;
  if (outOverride && !only) {
    throw new Error('SPORTS_CROWD_GLB_OUT needs SPORTS_CROWD_GLB_SET - it names one file, not five');
  }
  if (only && !SETS[only]) {
    throw new Error(`SPORTS_CROWD_GLB_SET="${only}" is not a pose - have ${POSE_KEYS.join(', ')}`);
  }

  for (const [name, set] of Object.entries(SETS)) {
    if (only && only !== name) continue;
    for (const key of set.parts) {
      const def = PART_DEFS[key];
      if (!SLOT.includes(def.slot)) {
        throw new Error(`${name}.${key} binds to slot '${def.slot}', which the crowd draws no mesh for`);
      }
      if (!(def.shade > 0)) {
        throw new Error(`${name}.${key} has no shade - both crowd materials read vertex colours and would draw it black`);
      }
    }
    const { glb, tris, verts } = writeGlb(name, set.parts);
    if (tris > TRI_BUDGET) {
      throw new Error(`${name} is ${tris} tris - over the ${TRI_BUDGET} reservation`);
    }
    const out = outOverride
      ? path.resolve(outOverride)
      : path.join(root, 'public/assets/sports', set.file);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, glb);
    console.log(`${path.relative(root, out)}  ${tris} tris  ${verts} verts  ${glb.length} bytes`);
  }
  if (!only) {
    const per = Object.fromEntries(POSE_KEYS.map((p) => [p, 0]));
    for (const name of POSE_KEYS) per[name] = writeGlb(name, SETS[name].parts).tris;
    const counts = { stand: 132, carry: 19, lean: 42, sit: 382, crouch: 8 };
    let total = 0;
    for (const k of POSE_KEYS) total += per[k] * counts[k];
    console.log(`world cost: ${total} triangles across ${Object.values(counts).reduce((a, b) => a + b, 0)} figures`);
  }
}
