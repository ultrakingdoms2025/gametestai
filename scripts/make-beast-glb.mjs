/**
 * Authored hero geometry for Aldermoor Vale's beasts.
 *
 * Phase 9 / decision D4: authored `.glb` hero assets through the pipeline
 * already proven three times (`make-newel-glb.mjs`, `make-ship-glb.mjs`,
 * `make-npc-glb.mjs`), procedural systems for bulk content. This is the
 * wildlife half of that, and wildlife is what Phase 3 gives this world: it is
 * the only world with beasts.
 *
 * ── What the screenshots said, which is why these parts and not others ────
 *
 * A wolf photographed at 5.5 m from three headings
 * (`.probe/art-medieval/beasts-before/`) reads as a smooth barrel with four
 * pods bolted to its sides and a featureless wedge for a head. Every one of
 * those is a place where a swept ellipse is the wrong description:
 *
 *   - **No ruff.** The neck runs into the shoulder as one continuous tube, so
 *     the animal has no shoulder line at all. A wolf's ruff is a mass with an
 *     EDGE - guard hair standing off the coat - and an ellipse swept along a
 *     path cannot have an edge. This is most of why the four leg-top masses
 *     read as separate pods: there is nothing across the shoulder to bind them
 *     into one form.
 *   - **No hackles.** The raised dorsal crest is the single most legible
 *     "this animal is a predator and it has noticed you" cue a canid has, and
 *     the profile spends one ellipsoid on it (`hump`), which is a bump.
 *   - **No brow.** The skull's `sweep` sections give a smooth taper, so the
 *     eyes sit on an unbroken curve and read as two beads on an egg.
 *   - **No nose.** The rhinarium is the same colour and the same surface as
 *     the muzzle it is on. Every real canid and ursid has a hard, dark,
 *     differently-shaped nose pad, and it is the one facial feature that still
 *     reads at twenty metres.
 *
 * Those four are exactly the list `make-npc-glb.mjs` reaches for on a face:
 * rigid features with edges, sitting on a lofted surface that is good at
 * everything except edges.
 *
 * ── Two rules that shape every vertex below ──────────────────────────────
 *
 * **1. NODE-LOCAL SPACE, not body space.** A beast is not one skinned mesh.
 * `BeastBody` builds a hierarchy of `THREE.Group`s - `tilt`, `neck`, `head`,
 * `jaw` - and the animator rotates them: the head looks at the player, the jaw
 * gapes through the telegraph. A part is therefore authored in the local space
 * of the node it belongs to, and the manifest names that node. A brow authored
 * in body space would stay behind when the head turned.
 *
 * **2. No new material, no new mesh, no new draw call.** Every part names one
 * of the four surfaces the animal already clones - `coat`, `belly`, `dark`,
 * `claw` - and is merged into the geometry `BeastBody` already builds for that
 * (node, slot) pair. There is no (node, slot) pair invented here: a part whose
 * pair does not already exist would be a new `THREE.Mesh`, and a beast is
 * already 22 meshes with a live cap of eight animals. The cost of everything
 * in this file is triangles and nothing else.
 *
 * That second rule is also the program-count rule. Three keys its shader cache
 * on material configuration, this project boots by warming the cartesian
 * product of those programs, and Phase 9 is named in the roadmap as the phase
 * most likely to regress production frame time. Reusing the four existing
 * surfaces costs exactly zero programs.
 *
 * ── Output ───────────────────────────────────────────────────────────────
 *
 *   public/assets/medieval/wolf.glb   the vale's pack predator
 *   public/assets/medieval/bear.glb   its solitary one
 *
 * One mesh per part, named for the part key. Which parts a species shows is a
 * manifest decision, not a geometry one.
 *
 *   node scripts/make-beast-glb.mjs                     # writes both
 *   BEAST_GLB_SET=wolf BEAST_GLB_OUT=/tmp/x.glb node scripts/make-beast-glb.mjs
 *
 * The env override exists for the same reason the ship and NPC generators have
 * one: the byte-diff test re-runs this into a temp file and compares buffers,
 * and a generator that can only write to its committed path cannot be tested.
 */

import * as THREE from 'three';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BEAST_PROFILES } from '../src/npc/BeastBody.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ */
/* The frame every measurement below is taken against                  */
/* ------------------------------------------------------------------ */

/**
 * Landmarks READ OUT OF `BeastBody.PROFILES`, not guessed.
 *
 * `make-ship-glb.mjs` learned this one the hard way: asserting two of a plan's
 * fields once let a 0.40 m divergence ship unnoticed. So the generator derives
 * its anchors from the same table the game builds from, and
 * `scripts/tests/beast-assets.test.mjs` asserts the derivation still holds -
 * which means a profile edit that moves a skull moves the brow with it, or
 * fails the gate.
 *
 * `witherZ`/`toplineY` are the barrel station nearest the shoulder; `neckR` is
 * the neck's mid-section radius; `eye` is the exact expression `BeastBody`
 * uses for the eye beads, so a brow placed against it cannot drift off the
 * orbit. `noseTip` is the last head section, which is where the muzzle ends.
 */
function frameFor(id) {
  const P = BEAST_PROFILES[id];
  const barrel = P.hull ?? P.barrel;
  /* Nearest barrel station to the shoulder mass, which is where the topline
   * has to be read for a crest to sit ON it rather than float over it. */
  const witherZ = P.masses[0].p[2];
  let station = barrel[0];
  for (const s of barrel) {
    if (Math.abs(s.z - witherZ) < Math.abs(station.z - witherZ)) station = s;
  }
  const eyeX = P.head.eye?.x ?? P.head.cheeks.p[0] * 0.62;
  const eyeY = P.head.eye?.y ?? P.head.cheeks.p[1] + 0.038;
  const eyeZ = P.head.eye?.z ?? P.head.sections[2].z + 0.02;
  const nose = P.head.sections[P.head.sections.length - 1];
  return {
    /** Body space (y from the ground), because `tilt` sits at the root. */
    witherZ,
    toplineY: station.y + station.ry,
    barrelHalfW: station.rx,
    humpTopY: P.hump ? P.hump.p[1] + P.hump.r[1] : station.y + station.ry,
    humpZ: P.hump ? P.hump.p[2] : witherZ,
    /** Neck-local, from `P.neck.sections`. */
    neckMid: P.neck.sections[1],
    neckBase: P.neck.sections[0],
    /** Head-local. */
    eye: { x: eyeX, y: eyeY, z: eyeZ },
    skullR: P.head.sections[1].rx,
    noseTip: { y: nose.y, z: nose.z, rx: nose.rx, ry: nose.ry },
  };
}

/** The four surfaces a beast already owns. Mirrored from `BeastBody._build`. */
export const SLOT = Object.freeze(['coat', 'belly', 'dark', 'claw']);

/**
 * (node, slot) pairs `BeastBody` already draws a mesh for.
 *
 * A part outside this set would need a mesh of its own, which is a draw call
 * on an animal that already spends 22 and may be on screen eight at a time.
 * The loader refuses one; this is the list it refuses against, and the test
 * holds both copies together.
 */
export const WELDABLE = Object.freeze([
  'body:coat', 'neck:coat', 'head:coat', 'head:dark', 'head:claw',
  'jaw:belly', 'jaw:claw',
]);

/* ------------------------------------------------------------------ */
/* A very small geometry kit                                           */
/* ------------------------------------------------------------------ */

/**
 * Accumulates transformed primitives into one indexed buffer.
 *
 * Deliberately primitive-based, and deliberately the same class
 * `make-npc-glb.mjs` uses. The lofting machinery in `BeastBody` is the right
 * tool for a limb that tapers along a path; a hackle crest and a nose pad are
 * rigid solids, and building them from scaled spheres and wedges keeps this
 * file readable and its triangle count something a reviewer can hold in their
 * head.
 */
class Mesher {
  constructor() {
    this.pos = [];
    this.nor = [];
    this.uv = [];
    this.idx = [];
  }

  /**
   * @param {THREE.BufferGeometry} geo already sized; only placed here
   * @param {[number,number,number]} at node-local position
   * @param {{rot?:[number,number,number], scale?:[number,number,number]}} [opts]
   */
  add(geo, at, opts = {}) {
    const g = geo.clone();
    const { rot, scale } = opts;
    if (scale) g.scale(scale[0], scale[1], scale[2]);
    if (rot) { g.rotateX(rot[0]); g.rotateY(rot[1]); g.rotateZ(rot[2]); }
    g.translate(at[0], at[1], at[2]);
    if (!g.index) {
      // Every primitive used here is indexed; a non-indexed one would silently
      // break the offset arithmetic below rather than fail.
      throw new Error('Mesher.add needs indexed geometry');
    }
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

  /** Mirror everything added by `fn` across x, winding corrected. */
  pair(fn) {
    const from = this.pos.length / 3;
    const fromI = this.idx.length;
    fn(1);
    const vCount = this.pos.length / 3 - from;
    const iCount = this.idx.length - fromI;
    const base = this.pos.length / 3;
    for (let v = 0; v < vCount; v++) {
      this.pos.push(-this.pos[(from + v) * 3], this.pos[(from + v) * 3 + 1], this.pos[(from + v) * 3 + 2]);
      this.nor.push(-this.nor[(from + v) * 3], this.nor[(from + v) * 3 + 1], this.nor[(from + v) * 3 + 2]);
      this.uv.push(this.uv[(from + v) * 2], this.uv[(from + v) * 2 + 1]);
    }
    // A mirror is a negative-determinant transform, so the winding flips with
    // it or every mirrored triangle faces inward and the part renders inside
    // out. Same correction the ship and NPC generators apply.
    for (let i = 0; i < iCount; i += 3) {
      this.idx.push(
        this.idx[fromI + i + 2] - from + base,
        this.idx[fromI + i + 1] - from + base,
        this.idx[fromI + i] - from + base
      );
    }
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
      // A NaN position blooms over the whole animal once it is merged and is
      // invisible in the numbers printed at the end. Same gate the ship and
      // NPC generators carry, for the same reason.
      if (!Number.isFinite(v)) throw new Error(`${name}: non-finite position`);
    }
    return g;
  }
}

/* Primitive stock. Built once, cloned per placement. Segment counts are chosen
 * against what the part is: a nose pad is read entirely by its front face and
 * gets 12 around, a hackle blade is a wedge and gets 4. */
const SPH = (w = 12, h = 8) => new THREE.SphereGeometry(1, w, h);
const BOX = () => new THREE.BoxGeometry(1, 1, 1);
/* Three tessellations, chosen against the reservation below rather than by
 * habit. A default `SphereGeometry(1, 12, 8)` is 192 triangles and there are
 * eight sphere placements per species here: at the default this file was 1,348
 * triangles, half again over its own budget, and the budget is the point. What
 * each one is read by decides its ring count - a nose pad is read by its front
 * face and its outline, a nostril lobe by nothing but its darkness. */
const sphMid = SPH(10, 6);   // 100 tris - masses read by their outline
const sphLo = SPH(8, 6);     //  80 tris
const sphTiny = SPH(6, 5);   //  48 tris - lobes read only as a dark patch
const box = BOX();

/* ------------------------------------------------------------------ */
/* The parts                                                           */
/* ------------------------------------------------------------------ */

/**
 * The dorsal crest, in BODY space, welded into the barrel.
 *
 * A ridge of tapered blades along the midline, tallest over the withers and
 * dying out fore and aft. Not one ellipsoid: the whole point of a raised
 * hackle is that it has a hard top edge against the sky, and an ellipsoid has
 * a soft one - which is what the profile's single `hump` already provides and
 * why the animal reads as smooth.
 *
 * The blades are RAKED BACK (`rot` about x), because guard hair lies along the
 * animal. A vertical comb reads as a stegosaur.
 */
function hackles(m, F, { from, to, height, thick, n }) {
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const z = from + (to - from) * t;
    // Tallest a third of the way back from the front of the run, which is over
    // the shoulder blade - where a canid's hackles actually stand.
    const h = height * Math.sin(Math.pow(t, 0.72) * Math.PI);
    if (h < 1e-4) continue;
    const y = F.toplineY - thick * 0.5;
    /* 4.6x the blade's own thickness, and that number is a screenshot's.
     *
     * At 2.6 the blades were *shorter* along the spine than the gap between
     * them, and the first after-shot showed the wolf wearing a row of discrete
     * scutes - an armadillo, not a raised coat. At 4.6 each blade overlaps its
     * neighbour by about half, so the run reads as one ridge with a broken top
     * edge, which is what standing guard hair looks like. Costs nothing: the
     * triangle count is the blade COUNT, not the blade size.
     *
     * The rake is steeper for the same reason. Hair lies along an animal; a
     * comb standing at 12 degrees off vertical reads as a fin. */
    m.add(box, [0, y + h * 0.5, z], {
      scale: [thick, h, thick * 4.6],
      rot: [-0.34, 0, 0],
    });
  }
}

/**
 * The ruff, in NECK space, welded into the neck sweep.
 *
 * Two lateral masses flaring off the sides of the neck plus a throat mass
 * under it, so the neck stops being a tube and the shoulder gets a line. The
 * lateral pair is what binds the four leg-top masses into one form: they read
 * as pods only because nothing crosses them.
 *
 * `spread` is a multiple of the neck's own mid radius rather than a length, so
 * a profile that thickens a neck thickens the ruff with it instead of leaving
 * it buried.
 */
function ruff(m, F, { spread, along, drop, back }) {
  const r = F.neckMid.rx;
  const y = F.neckMid.y;
  const z = F.neckMid.z + back;
  m.pair((s) => {
    m.add(sphMid, [s * r * 0.72, y, z], { scale: [r * spread, r * spread * 0.86, r * along] });
  });
  // The throat. A wolf's ruff hangs BELOW the jaw line and is most of the
  // animal's front-on width; without it the head-on silhouette is a stick.
  m.add(sphMid, [0, y - r * drop, z + r * 0.1], {
    scale: [r * spread * 0.92, r * 0.62, r * along * 0.86],
  });
}

/**
 * The supraorbital shelf, in HEAD space.
 *
 * Sits ABOVE the eye line and is continuous across the midline. Both are
 * load-bearing and both were learned on the station's apes: a shelf that drops
 * onto the eye line reads as a blindfold, and one broken into two arcs over
 * two eyes reads as a pair of eyebrows, which is a human feature and wrong on
 * every animal in this file.
 *
 * The eye position it is measured against is `BeastBody`'s own expression, so
 * a profile that moves the orbit moves this with it.
 */
function brow(m, F, { lift, w, h, d, buttress }) {
  const y = F.eye.y + lift;
  const z = F.eye.z - d * 0.15;
  m.add(sphMid, [0, y, z], { scale: [w, h, d] });
  // Outer buttresses, swept back and down toward the cheekbone, so the shelf
  // has somewhere to go instead of stopping in mid-air at its own edge.
  m.pair((s) => {
    m.add(sphTiny, [s * w * 0.82, y - h * buttress, z + d * 0.5], {
      scale: [w * 0.32, h * 0.82, d * 1.05],
    });
  });
}

/**
 * The nose pad, in HEAD space, welded into the EYE mesh.
 *
 * That weld target is the whole reason this part is worth authoring. The eyes
 * are the head's only `dark`-surfaced mesh, so a nose merged into them costs
 * no draw call and arrives already the right colour - a hard, near-black,
 * wet-looking pad against a matte coat. Painted onto the muzzle instead it
 * would need a fifth material and a fifth mesh.
 *
 * Two nostril dimples are pressed in as flattened lobes rather than cut as
 * holes: a boolean at this scale costs geometry nobody will resolve, and two
 * dark lobes sitting a millimetre proud read identically at any distance a
 * player will ever see a wolf from.
 */
function nosePad(m, F, { w, h, d, nostril }) {
  const y = F.noseTip.y + F.noseTip.ry * 0.28;
  const z = F.noseTip.z - F.noseTip.rx * 0.55;
  m.add(sphMid, [0, y, z], { scale: [w, h, d] });
  // The bridge - a short taper back onto the muzzle, so the pad is part of the
  // face rather than a bead stuck to the end of it.
  m.add(sphTiny, [0, y + h * 0.42, z + d * 1.5], { scale: [w * 0.66, h * 0.52, d * 1.7] });
  m.pair((s) => {
    m.add(sphTiny, [s * w * 0.46, y - h * 0.12, z - d * 0.55], {
      scale: [w * nostril, h * nostril * 1.5, d * 0.55],
    });
  });
}

/* ------------------------------------------------------------------ */
/* The two sets                                                        */
/* ------------------------------------------------------------------ */

const WOLF = frameFor('wolf');
const BEAR = frameFor('bear');

/**
 * @typedef {{node:string, slot:string, build:(m:Mesher)=>void}} PartDef
 */

/** @type {Record<string, {file:string, parts:Record<string, PartDef>}>} */
const SETS = {
  wolf: {
    file: 'wolf.glb',
    parts: {
      /* From just behind the poll to the middle of the back. A wolf's hackles
       * run the length of the spine but only the shoulder third stands up. */
      hackles: {
        node: 'body', slot: 'coat',
        build: (m) => hackles(m, WOLF, {
          from: WOLF.witherZ - 0.20, to: WOLF.witherZ + 0.34,
          height: 0.047, thick: 0.014, n: 14,
        }),
      },
      /* 1.9x the neck's own radius. Measured by eye against the profile shot:
       * at 1.4 the ruff is inside the shoulder masses and does nothing, and
       * past 2.2 the wolf grows a lion's mane. */
      ruff: {
        node: 'neck', slot: 'coat',
        build: (m) => ruff(m, WOLF, { spread: 1.9, along: 1.35, drop: 0.72, back: 0.02 }),
      },
      brow: {
        node: 'head', slot: 'coat',
        build: (m) => brow(m, WOLF, {
          lift: 0.026, w: 0.070, h: 0.021, d: 0.040, buttress: 0.44,
        }),
      },
      nose: {
        node: 'head', slot: 'dark',
        build: (m) => nosePad(m, WOLF, { w: 0.026, h: 0.019, d: 0.020, nostril: 0.42 }),
      },
    },
  },

  bear: {
    file: 'bear.glb',
    parts: {
      /* Over the hump, not over the withers: a bear's crest of guard hair sits
       * on the tallest point of the animal, which is the hump and not the
       * shoulder blade. The run is shorter and the blades are longer and
       * coarser than a wolf's - bear guard hair is. */
      hackles: {
        node: 'body', slot: 'coat',
        build: (m) => {
          const F = { ...BEAR, toplineY: BEAR.humpTopY };
          hackles(m, F, {
            from: BEAR.humpZ - 0.26, to: BEAR.humpZ + 0.30,
            height: 0.062, thick: 0.024, n: 12,
          });
        },
      },
      /* Shallower than the wolf's. A bear's neck is already immensely thick,
       * so a 1.9 ruff on it is a beard; what the silhouette needs is the line
       * where the neck meets the shoulder, and 1.35 gives that and no more. */
      ruff: {
        node: 'neck', slot: 'coat',
        build: (m) => ruff(m, BEAR, { spread: 1.35, along: 1.15, drop: 0.58, back: 0.01 }),
      },
      brow: {
        node: 'head', slot: 'coat',
        build: (m) => brow(m, BEAR, {
          lift: 0.038, w: 0.122, h: 0.032, d: 0.062, buttress: 0.40,
        }),
      },
      /* Big. A bear's nose pad is the largest single feature on its face and
       * is most of what says "bear" head-on, where the hump is edge-on and
       * carries nothing. */
      nose: {
        node: 'head', slot: 'dark',
        build: (m) => nosePad(m, BEAR, { w: 0.056, h: 0.036, d: 0.034, nostril: 0.40 }),
      },
    },
  },
};

/* ------------------------------------------------------------------ */
/* Minimal binary glTF 2.0 writer                                      */
/* ------------------------------------------------------------------ */
/* Lifted from `scripts/make-npc-glb.mjs`, which took it from
 * `make-newel-glb.mjs`. Kept verbatim rather than factored into a shared
 * module on purpose, and for the reason that file gives: four generators that
 * each stand alone can be read end to end, and the byte-diff tests pin all
 * four against their committed output, so a divergence cannot ship silently. */

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
      generator: 'aether-nexus scripts/make-beast-glb.mjs',
      copyright: 'generated - procedurally authored in this repository, no external source',
    },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    /* Placeholders so the file stands alone in a viewer. The game DISCARDS
     * every one of these and merges each part into the mesh the animal already
     * draws for the (node, slot) pair the manifest names - see BeastAssets.js.
     * A test asserts the set of materials a built beast ends up with is
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
 * Triangle reservation.
 *
 * These merge into geometry the animal already draws, so they cost no draw
 * call and no material - but they do cost triangles on every beast in the
 * world, and `MedievalResidency` streams up to EIGHT bodies at once. 900
 * triangles an animal is 7,200 against a medieval framing that measured
 * 1.84-2.64 M, i.e. under 0.4% at the live cap. Ten thousand would not be, so
 * the gate is here rather than in a review comment.
 */
export const TRI_BUDGET = { wolf: 900, bear: 900 };

/** The parts each species shows, for the manifest and for the tests. */
export const SET_PARTS = Object.freeze(
  Object.fromEntries(Object.entries(SETS).map(([k, v]) => [k, Object.keys(v.parts)]))
);

/** part key -> { node, slot }, for the manifest and for the tests. */
export const PART_BINDING = Object.freeze(
  Object.fromEntries(
    Object.entries(SETS).map(([k, v]) => [
      k,
      Object.fromEntries(Object.entries(v.parts).map(([pk, pd]) => [pk, { node: pd.node, slot: pd.slot }])),
    ])
  )
);

export { frameFor };

/* Guarded so the module can be imported by the test without writing files.
 * `import.meta.main` is Node 22; the `argv` comparison is the portable half. */
const isMain = path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const only = process.env.BEAST_GLB_SET;
  const outOverride = process.env.BEAST_GLB_OUT;
  if (outOverride && !only) {
    throw new Error('BEAST_GLB_OUT needs BEAST_GLB_SET - it names one file, not both');
  }

  for (const [name, set] of Object.entries(SETS)) {
    if (only && only !== name) continue;
    for (const [key, def] of Object.entries(set.parts)) {
      const pair = `${def.node}:${def.slot}`;
      if (!WELDABLE.includes(pair)) {
        throw new Error(`${name}.${key} binds to '${pair}', which BeastBody draws no mesh for`);
      }
    }
    const { glb, tris, verts } = writeGlb(name, set.parts);
    if (tris > TRI_BUDGET[name]) {
      throw new Error(`${name} is ${tris} tris - over the ${TRI_BUDGET[name]} reservation`);
    }
    const out = outOverride
      ? path.resolve(outOverride)
      : path.join(root, 'public/assets/medieval', set.file);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, glb);
    console.log(`${out}\n  ${Object.keys(set.parts).length} parts, ${verts} verts, ${tris} tris, ${glb.length} bytes`);
  }
}
