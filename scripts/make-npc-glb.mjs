/**
 * Authored hero-character geometry for the station's eleven referenced roles.
 *
 * Phase 6 / decision D4: authored `.glb` hero assets through the pipeline
 * already proven twice (`make-newel-glb.mjs`, `make-ship-glb.mjs`), procedural
 * systems for bulk content. This is the character half of that.
 *
 * ── What is authored here, and what is deliberately NOT ───────────────────
 *
 * The references in `demopics/` are apes: four armed beast-apes (`g1`-`g4`) and
 * seven gorilla crew in EVA rig (`n1`-`n7`). What separates an ape from the
 * procedural human `Humanoid` already builds is a small, specific list -
 * a domed crested cranium, a heavy supraorbital shelf, a prognathic muzzle,
 * big set-wide ears, heavy knuckled hands - plus worn kit: a pauldron, a
 * bandolier, a belt, a life-support pack.
 *
 * Those are exactly the things procedural lofting is bad at and authoring is
 * good at, so those are what this file makes. Everything else - the body, the
 * limbs, the garments, the skin and cloth textures, the variation across a
 * crowd - stays procedural, because that is what procedural is good at and
 * what "hybrid" in D4 means. **This file authors features, not whole
 * characters**, and the report says so out loud rather than claiming a full
 * authored character pipeline that does not exist.
 *
 * ── Two rules that shape every vertex below ───────────────────────────────
 *
 * **1. Character space, not bone-local.** Every position here is in the same
 * space `Humanoid.js` lofts its body in: feet at y=0, head bone at y=1.545,
 * the face looking down -Z. That is not a stylistic choice - `assignSkinWeights`
 * bins vertices by distance to bone segments in exactly this space, so geometry
 * authored anywhere else would be skinned to the wrong bones.
 *
 * **2. No new material, ever.** The loaded glTF material is discarded (see
 * `HeroAssets.js`); every part names one of the six existing character slots
 * and draws with that slot's already-cached material. Three keys its shader
 * cache on the material configuration, and this repo has a documented history
 * of art changes costing boot time by adding programs. A hero character that
 * added six programs per archetype would be a worse outcome than a plain one.
 * The placeholder materials written into the file exist only so it opens in a
 * viewer, and the tests assert the game never reads them.
 *
 * A consequence worth stating: **there is no helmet bubble.** `n3`-`n7` wear
 * one, and a transparent material is a new program family. `n1` and `n2` do
 * not, so the crew are authored on those two, and the bubble is recorded as
 * deliberately skipped rather than quietly missed.
 *
 * ── Output ────────────────────────────────────────────────────────────────
 *
 *   public/assets/npc/raider.glb   the four attackers' features and kit
 *   public/assets/npc/crew.glb     the seven fixed roles' features and kit
 *
 * One mesh per part, named for the part key. Which parts a given archetype or
 * role shows is a manifest decision, not a geometry one, which is how four
 * visibly different attackers come out of one file.
 *
 *   node scripts/make-npc-glb.mjs                    # writes both
 *   NPC_GLB_SET=raider NPC_GLB_OUT=/tmp/x.glb node scripts/make-npc-glb.mjs
 *
 * The env override exists for the same reason the ship generator has one: the
 * byte-diff test re-runs this into a temp file and compares buffers, and a
 * generator that can only write to its committed path cannot be tested.
 */

import * as THREE from 'three';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ */
/* The frame every measurement below is taken against                  */
/* ------------------------------------------------------------------ */

/**
 * Landmarks read out of `Humanoid.js`, not guessed.
 *
 * `SKULL` is `headFrame(P)` at girth 1: centre and radii of the ellipsoid the
 * procedural head is sculpted from. Authored features are positioned against
 * it so they sit ON the face rather than near it, and so they still do when a
 * heavier build widens the skull underneath (the loader scales nothing - a
 * wider head simply pushes a little further into the shell, which is the
 * correct behaviour for a rigid feature and is why these are generous).
 *
 * Exported so `scripts/tests/npc-assets.test.mjs` can assert this file and
 * `Humanoid.js` have not drifted apart. The ship generator learned that one
 * the hard way: asserting two of a plan's fields once let a 0.40 m divergence
 * ship unnoticed.
 */
export const FRAME = {
  headBoneY: 1.545,
  skullCentre: [0, 1.6543, 0.01],
  skullRadii: [0.08851, 0.11183, 0.10547],
  neckY: 1.464,
  chestY: 1.29,
  spine02Y: 1.18,
  pelvisY: 0.995,
  hipY: 0.955,
  clavicleY: 1.392,
  ankleY: 0.098,
  legSideX: 0.095,
};

/** The six character material slots, mirrored from `Humanoid.SLOT`. */
export const SLOT = { SKIN: 0, PRIMARY: 1, SECONDARY: 2, LEATHER: 3, METAL: 4, GLOW: 5 };

/* ------------------------------------------------------------------ */
/* A very small geometry kit                                           */
/* ------------------------------------------------------------------ */

/**
 * Accumulates transformed primitives into one indexed buffer.
 *
 * Deliberately primitive-based rather than lofted. The lofting machinery in
 * `Humanoid.js` is the right tool for a limb that has to taper and bend along
 * a bone; a brow ridge and a pauldron are rigid solids, and building them from
 * scaled spheres and boxes keeps this file readable and its triangle count
 * something a reviewer can hold in their head.
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
   * @param {[number,number,number]} at character-space position
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
    // out. Same correction the ship loader applies for a mirrored hull.
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
      // A NaN position blooms over the whole character once it is skinned and
      // is invisible in the numbers printed at the end. Same gate the ship
      // generator carries, for the same reason.
      if (!Number.isFinite(v)) throw new Error(`${name}: non-finite position`);
    }
    return g;
  }
}

/* Primitive stock. Built once, cloned per placement. Segment counts are chosen
 * against what the part is: a brow ridge is read entirely by its top edge and
 * gets 16 around, a pauldron is a slab and gets 8. */
const SPH = (w = 12, h = 8) => new THREE.SphereGeometry(1, w, h);
const BOX = () => new THREE.BoxGeometry(1, 1, 1);
const CYL = (seg = 10, open = false) => new THREE.CylinderGeometry(1, 1, 1, seg, 1, open);
const CONE = (seg = 6) => new THREE.ConeGeometry(1, 1, seg, 1);
const TOR = (seg = 16, tube = 6) => new THREE.TorusGeometry(1, 0.25, tube, seg);

const sph = SPH(), sphLo = SPH(8, 6), box = BOX(), cyl = CYL(), cylLo = CYL(8), cone = CONE(), tor = TOR();

/* ------------------------------------------------------------------ */
/* The ape face                                                        */
/* ------------------------------------------------------------------ */

const S = FRAME.skullCentre;
const R = FRAME.skullRadii;

/**
 * The cranium: a domed shell over the top and back of the procedural skull.
 *
 * Set BACK and UP relative to the human skull it covers, which is the whole
 * anatomical difference: an ape's braincase sits behind and above a face that
 * juts forward, where a human's sits over one that does not. Because it is set
 * back, the front of the procedural face - crucially, the eye sockets and the
 * live eye rig in them - is still exposed under the brow, so the character
 * keeps its look-at, its blinks and its gaze. Swallowing the face inside a
 * closed shell would have been easier and would have cost the one feature that
 * makes these characters feel alive.
 *
 * `crest` raises a sagittal ridge along the midline - the silverback tell, and
 * the single clearest silhouette difference between `n1`-`n7` and a person.
 */
function cranium(m, { lift, back, crest, crestH }) {
  m.add(sph, [S[0], S[1] + lift, S[2] + back], { scale: [R[0] * 1.16, R[1] * 1.10, R[2] * 1.08] });
  if (crest) {
    // A tapered blade along the midline, not a half-torus: the ridge is tallest
    // over the crown and dies out at the occiput.
    for (let i = 0; i < 7; i++) {
      const t = i / 6;
      const z = S[2] + back - 0.055 + t * 0.15;
      const h = crestH * Math.sin((1 - t * 0.72) * Math.PI * 0.62);
      m.add(box, [0, S[1] + lift + R[1] * 1.02 + h * 0.4, z], { scale: [0.019, h, 0.028] });
    }
  }
}

/**
 * The supraorbital shelf.
 *
 * Sits ABOVE the eye line, not on it. The margin is small and was set by
 * screenshot rather than by arithmetic: a shelf 8 mm lower reads as a blindfold
 * because it closes the gap the eyes live in, and one 8 mm higher reads as a
 * headband because it detaches from the orbit. What makes it read as bone is
 * that it is continuous across the midline - a brow broken into two arcs over
 * two eyes is a pair of eyebrows, which is a human feature.
 */
function brow(m, { y, z, w, h, d }) {
  m.add(sph, [0, y, z], { scale: [w, h, d] });
  // Outer buttresses, swept back and down towards the cheekbone, so the shelf
  // has somewhere to go instead of stopping in mid-air at its own edge.
  m.pair((s) => {
    m.add(sph, [s * w * 0.86, y - h * 0.42, z + d * 0.55], { scale: [w * 0.30, h * 0.86, d * 1.05] });
  });
}

/**
 * The muzzle: prognathic, wide, and deep enough to enclose the procedural
 * nose and mouth completely.
 *
 * That enclosure is the point. The face underneath is a human one and it is
 * welded into a cached body geometry that cannot be edited per character, so
 * the only way to have an ape face is to build one in front of it. The muzzle
 * therefore starts behind the human nose tip and ends well in front of it.
 *
 * @param {{open:number}} opts `open` drops a separate lower jaw, in radians -
 *   the roaring attackers use it; the crew are closed-mouthed and pass 0.
 */
function muzzle(m, { y, z, w, h, d, open, teeth }) {
  // Upper jaw: a rounded wedge, widest at the cheek and narrowing to the nose.
  m.add(sph, [0, y, z], { scale: [w, h, d] });
  m.add(sph, [0, y + h * 0.34, z + d * 0.30], { scale: [w * 0.82, h * 0.66, d * 0.86] });
  // Nostrils: two shallow dimples pressed into the front face. Inverted spheres
  // would need a boolean; two dark discs sitting a millimetre proud read the
  // same at any distance a player will ever see this from.
  m.pair((s) => m.add(sphLo, [s * w * 0.30, y + h * 0.30, z - d * 0.90], { scale: [w * 0.20, h * 0.16, d * 0.10] }));

  if (open > 0) {
    // The lower jaw swings about the condyle, which is behind and above the
    // bite line - rotating about the muzzle centre instead splays the jaw out
    // of the face, which is what the first attempt did.
    const hy = y + h * 0.10;
    const hz = z + d * 0.62;
    const jaw = new Mesher();
    jaw.add(sph, [0, y - h * 0.52, z + d * 0.06], { scale: [w * 0.90, h * 0.46, d * 0.92] });
    if (teeth) {
      // Canines only. A full dentition at this scale is a light-coloured smear;
      // four fangs are what actually reads as a threat display.
      jaw.pair((s) => jaw.add(cone, [s * w * 0.52, y - h * 0.34, z - d * 0.52], {
        scale: [0.011, 0.040, 0.011], rot: [Math.PI, 0, s * -0.10],
      }));
    }
    rotateAbout(jaw, hy, hz, open);
    m.pos.push(...jaw.pos); m.nor.push(...jaw.nor); m.uv.push(...jaw.uv);
    // Indices were built against the sub-mesher's own zero base.
    const base = (m.pos.length - jaw.pos.length) / 3;
    for (const i of jaw.idx) m.idx.push(i + base);
  }
  if (teeth && open > 0) {
    // Upper canines, fixed to the skull rather than to the swinging jaw.
    m.pair((s) => m.add(cone, [s * w * 0.54, y - h * 0.30, z - d * 0.56], {
      scale: [0.012, 0.044, 0.012], rot: [0, 0, s * 0.10],
    }));
  }
}

/** Rotate a sub-mesh about an axis through (0, y, z) parallel to x. */
function rotateAbout(m, y, z, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  for (let i = 0; i < m.pos.length; i += 3) {
    const dy = m.pos[i + 1] - y, dz = m.pos[i + 2] - z;
    m.pos[i + 1] = y + dy * c - dz * s;
    m.pos[i + 2] = z + dy * s + dz * c;
    const ny = m.nor[i + 1], nz = m.nor[i + 2];
    m.nor[i + 1] = ny * c - nz * s;
    m.nor[i + 2] = ny * s + nz * c;
  }
}

/** Big, set-wide, low ape ears. Small part, disproportionate silhouette value. */
function ears(m, { y, z, r }) {
  m.pair((s) => {
    m.add(sphLo, [s * (R[0] * 1.20), y, z], { scale: [r * 0.34, r, r * 0.80] });
  });
}

/* ------------------------------------------------------------------ */
/* Worn kit                                                            */
/* ------------------------------------------------------------------ */

/** A strap running between two character-space points, as a flattened box. */
function strap(m, a, b, width, thick) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const len = Math.hypot(dx, dy, dz);
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  // Roll about z to lie along the run, then yaw so it wraps rather than
  // standing proud of the chest.
  const roll = Math.atan2(dx, dy);
  const yaw = Math.atan2(dz, Math.hypot(dx, dy));
  m.add(box, mid, { scale: [width, len, thick], rot: [-yaw, 0, -roll] });
}

/** Webbing belt with pouches. Worn by every archetype and every role. */
function belt(m, { y, rx, rz, pouches }) {
  // Sixteen segments, not twenty-two. A belt is read as a band, and the extra
  // six cost 72 triangles on every hero character in the world to smooth a
  // curve nobody looks at.
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    m.add(box, [Math.sin(a) * rx, y, Math.cos(a) * rz], {
      scale: [0.030, 0.048, 0.022], rot: [0, a, 0],
    });
  }
  for (let i = 0; i < pouches; i++) {
    // Spread across the front two-thirds; nobody wears a pouch on their spine.
    const a = -0.9 + (i / Math.max(1, pouches - 1)) * 1.8;
    m.add(box, [Math.sin(a) * rx * 1.06, y - 0.024, Math.cos(a) * rz * 1.06], {
      scale: [0.052, 0.062, 0.038], rot: [0, a, 0],
    });
  }
}

/* ------------------------------------------------------------------ */
/* The two part sets                                                   */
/* ------------------------------------------------------------------ */

/**
 * PART KEYS ARE A CONTRACT. `HeroAssets.HERO_PART_KEYS` holds the same list and
 * a test asserts they agree, because a part whose name the loader does not
 * recognise is dropped with a warning - which is a silent art regression.
 *
 * Each entry names the material SLOT it draws in and the bone it is rigidly
 * skinned to. Nothing here introduces a material.
 */
const RAIDER_PARTS = {
  /* The face. Skin, so it takes the character's own tone: the attackers are
   * created with a near-black tone and a violet rim, which is where the
   * references' colour comes from - authored geometry, procedural colour. */
  cranium: { slot: SLOT.SKIN, bone: 'head', build: (m) => cranium(m, { lift: 0.020, back: 0.030, crest: true, crestH: 0.030 }) },
  brow: { slot: SLOT.SKIN, bone: 'head', build: (m) => brow(m, { y: S[1] + 0.030, z: S[2] - 0.082, w: 0.088, h: 0.026, d: 0.034 }) },
  muzzle: {
    slot: SLOT.SKIN, bone: 'head',
    build: (m) => muzzle(m, { y: S[1] - 0.036, z: S[2] - 0.088, w: 0.062, h: 0.045, d: 0.062, open: 0.34, teeth: false }),
  },
  /* Fangs draw in METAL, not in a new bone-white material. At the size a fang
   * occupies on screen the slot that matters is "hard and pale-ish", and METAL
   * is already cached for the weapon this character is holding. */
  fangs: {
    slot: SLOT.METAL, bone: 'head',
    build: (m) => muzzleTeethOnly(m, { y: S[1] - 0.036, z: S[2] - 0.088, w: 0.062, h: 0.045, d: 0.062, open: 0.34 }),
  },
  ear: { slot: SLOT.SKIN, bone: 'head', build: (m) => ears(m, { y: S[1] - 0.004, z: S[2] + 0.026, r: 0.038 }) },
  /* Two glowing eyes. The one part that exists purely for the reference: every
   * one of `g1`-`g4` reads first as a pair of violet lights in a dark mass. */
  eyeGlow: {
    slot: SLOT.GLOW, bone: 'head',
    build: (m) => m.pair((s) => m.add(sphLo, [s * 0.030, S[1] + 0.002, S[2] - 0.083], { scale: [0.0145, 0.0125, 0.010] })),
  },
  /* Kit. */
  pauldron: {
    slot: SLOT.METAL, bone: 'clavicleR',
    build: (m) => {
      // One shoulder only, as in g1 / g4. A matched pair reads as a uniform;
      // one plate reads as scavenged, which is what these are.
      m.add(sph, [0.150, FRAME.clavicleY + 0.030, -0.004], { scale: [0.088, 0.055, 0.090] });
      for (let i = 0; i < 3; i++) {
        m.add(box, [0.150, FRAME.clavicleY - 0.010 - i * 0.036, -0.004], {
          scale: [0.150 - i * 0.014, 0.026, 0.150 - i * 0.014], rot: [0, 0, -0.16],
        });
      }
    },
  },
  harness: {
    slot: SLOT.LEATHER, bone: 'spine02',
    build: (m) => {
      // The crossed bandolier of g1: over one shoulder, under the other arm.
      strap(m, [0.115, FRAME.clavicleY + 0.010, -0.030], [-0.090, 1.055, 0.020], 0.050, 0.020);
      strap(m, [-0.115, FRAME.clavicleY + 0.010, -0.030], [0.090, 1.070, -0.055], 0.044, 0.018);
    },
  },
  /* The lit nodes on the breaker's harness in g3. Six cubes, GLOW slot. */
  harnessGlow: {
    slot: SLOT.GLOW, bone: 'spine02',
    build: (m) => {
      for (let i = 0; i < 5; i++) {
        const t = i / 4;
        m.add(box, [0.115 - t * 0.205, FRAME.clavicleY + 0.010 - t * 0.345, -0.030 + t * 0.050], {
          scale: [0.018, 0.018, 0.014],
        });
      }
    },
  },
  spineSpikes: {
    slot: SLOT.METAL, bone: 'spine02',
    build: (m) => {
      // Dorsal row down the back, tallest at the shoulder. g2 and g4.
      for (let i = 0; i < 6; i++) {
        const t = i / 5;
        const h = 0.052 * (1 - t * 0.55);
        m.add(cone, [0, 1.40 - t * 0.30, 0.075 + t * 0.020], { scale: [0.016, h, 0.016], rot: [-0.5, 0, 0] });
      }
    },
  },
  armSpikes: {
    slot: SLOT.METAL, bone: 'foreArmR',
    build: (m) => m.pair((s) => {
      for (let i = 0; i < 3; i++) {
        m.add(cone, [s * (0.245 + i * 0.012), 1.10 - i * 0.055, 0.028], {
          scale: [0.013, 0.040, 0.013], rot: [0, 0, s * -1.2],
        });
      }
    }),
  },
  belt: { slot: SLOT.LEATHER, bone: 'pelvis', build: (m) => belt(m, { y: FRAME.pelvisY - 0.012, rx: 0.132, rz: 0.104, pouches: 4 }) },
  /* Heavy knuckled hands. The procedural hand is a human one and it is the
   * second thing a player looks at on a character holding a weapon. */
  knuckle: {
    slot: SLOT.SKIN, bone: 'handR',
    build: (m) => m.pair((s) => {
      m.add(sph, [s * 0.222, 1.008, 0.006], { scale: [0.040, 0.046, 0.052] });
      for (let i = 0; i < 4; i++) {
        m.add(sphLo, [s * (0.200 + i * 0.014), 0.982, 0.030 - i * 0.016], { scale: [0.013, 0.014, 0.014] });
      }
    }),
  },
};

const CREW_PARTS = {
  cranium: { slot: SLOT.SKIN, bone: 'head', build: (m) => cranium(m, { lift: 0.016, back: 0.028, crest: true, crestH: 0.018 }) },
  brow: { slot: SLOT.SKIN, bone: 'head', build: (m) => brow(m, { y: S[1] + 0.028, z: S[2] - 0.080, w: 0.082, h: 0.022, d: 0.031 }) },
  /* Closed-mouthed and shorter than the raider's: `n1`-`n7` are calm, and the
   * whole difference between a friendly ape and a hostile one at a glance is
   * the jaw. */
  muzzle: {
    slot: SLOT.SKIN, bone: 'head',
    build: (m) => muzzle(m, { y: S[1] - 0.034, z: S[2] - 0.080, w: 0.056, h: 0.040, d: 0.052, open: 0, teeth: false }),
  },
  ear: { slot: SLOT.SKIN, bone: 'head', build: (m) => ears(m, { y: S[1] - 0.006, z: S[2] + 0.024, r: 0.036 }) },
  /* EVA kit, on `n1` / `n2`: an open collar ring, a life-support pack, a chest
   * harness with a lit panel, a webbing belt and heavy boots. */
  collar: {
    slot: SLOT.METAL, bone: 'neck',
    build: (m) => {
      m.add(tor, [0, FRAME.neckY - 0.020, 0.006], { scale: [0.072, 0.072, 0.052], rot: [Math.PI / 2, 0, 0] });
      m.add(cyl, [0, FRAME.neckY - 0.048, 0.006], { scale: [0.080, 0.030, 0.080] });
    },
  },
  backpack: {
    slot: SLOT.METAL, bone: 'spine02',
    build: (m) => {
      m.add(box, [0, 1.285, 0.145], { scale: [0.215, 0.270, 0.105] });
      m.add(box, [0, 1.420, 0.140], { scale: [0.170, 0.048, 0.090] });
      m.pair((s) => m.add(cylLo, [s * 0.072, 1.285, 0.205], { scale: [0.038, 0.230, 0.038] }));
    },
  },
  chestRig: {
    slot: SLOT.LEATHER, bone: 'spine02',
    build: (m) => {
      m.pair((s) => strap(m, [s * 0.098, FRAME.clavicleY + 0.006, -0.026], [s * 0.072, 1.045, -0.020], 0.046, 0.018));
      m.add(box, [0, 1.230, -0.108], { scale: [0.150, 0.115, 0.052] });
    },
  },
  chestLamp: {
    slot: SLOT.GLOW, bone: 'spine02',
    build: (m) => m.add(box, [0, 1.242, -0.136], { scale: [0.086, 0.062, 0.008] }),
  },
  belt: { slot: SLOT.LEATHER, bone: 'pelvis', build: (m) => belt(m, { y: FRAME.pelvisY - 0.016, rx: 0.124, rz: 0.098, pouches: 3 }) },
  boot: {
    slot: SLOT.PRIMARY, bone: 'footR',
    build: (m) => m.pair((s) => {
      m.add(box, [s * FRAME.legSideX, FRAME.ankleY - 0.030, -0.030], { scale: [0.104, 0.070, 0.230] });
      m.add(cyl, [s * FRAME.legSideX, FRAME.ankleY + 0.060, 0.010], { scale: [0.070, 0.090, 0.070] });
    }),
  },
  /* Bare ape hands: the crew wear no gloves in `n1`-`n4`, which is most of what
   * makes them read as animals wearing suits rather than as people in suits. */
  knuckle: {
    slot: SLOT.SKIN, bone: 'handR',
    build: (m) => m.pair((s) => {
      m.add(sph, [s * 0.218, 1.010, 0.004], { scale: [0.036, 0.042, 0.048] });
      for (let i = 0; i < 4; i++) {
        m.add(sphLo, [s * (0.198 + i * 0.013), 0.986, 0.026 - i * 0.015], { scale: [0.012, 0.013, 0.013] });
      }
    }),
  },
};

/** The fangs, alone, so they can draw in a different slot from the jaw. */
function muzzleTeethOnly(m, { y, z, w, h, d, open }) {
  const lower = new Mesher();
  lower.pair((s) => lower.add(cone, [s * w * 0.52, y - h * 0.34, z - d * 0.52], {
    scale: [0.011, 0.040, 0.011], rot: [Math.PI, 0, s * -0.10],
  }));
  rotateAbout(lower, y + h * 0.10, z + d * 0.62, open);
  const base = m.pos.length / 3;
  m.pos.push(...lower.pos); m.nor.push(...lower.nor); m.uv.push(...lower.uv);
  for (const i of lower.idx) m.idx.push(i + base);
  m.pair((s) => m.add(cone, [s * w * 0.54, y - h * 0.30, z - d * 0.56], {
    scale: [0.012, 0.044, 0.012], rot: [0, 0, s * 0.10],
  }));
}

const SETS = {
  raider: { parts: RAIDER_PARTS, file: 'raider.glb' },
  crew: { parts: CREW_PARTS, file: 'crew.glb' },
};

/* ------------------------------------------------------------------ */
/* Minimal binary glTF 2.0 writer                                      */
/* ------------------------------------------------------------------ */
/* Lifted from `scripts/make-newel-glb.mjs`, which established it, and widened
 * to many meshes the way `make-ship-glb.mjs` did. Kept verbatim rather than
 * factored into a shared module on purpose: three generators that each stand
 * alone can be read end to end, and the byte-diff tests pin all three against
 * their committed output, so a divergence cannot ship silently. */

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
      pbrMetallicRoughness: { baseColorFactor: [0.5, 0.5, 0.5, 1], metallicFactor: 0, roughnessFactor: 0.8 },
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
      generator: 'aether-nexus scripts/make-npc-glb.mjs',
      copyright: 'generated - procedurally authored in this repository, no external source',
    },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    /* Placeholders so the file stands alone in a viewer. The game DISCARDS
     * every one of these and draws each part with the character material slot
     * the manifest names - see HeroAssets.js. A test asserts that the set of
     * material names the game ends up with is unchanged by loading this. */
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
 * These fold into the character's own merged SkinnedMesh, so they cost no draw
 * call - but they do cost triangles on every hero character in the world, and
 * the station carries ~68 of them. 3,000 triangles a character against a
 * ~2.9 M-triangle station framing is about 7% if every character were on
 * screen at once, which none of them are. Ten thousand would not be, so the
 * gate is here rather than in a review comment.
 */
export const TRI_BUDGET = { raider: 3600, crew: 3200 };

const only = process.env.NPC_GLB_SET;
const outOverride = process.env.NPC_GLB_OUT;
if (outOverride && !only) {
  throw new Error('NPC_GLB_OUT needs NPC_GLB_SET - it names one file, not both');
}

for (const [name, set] of Object.entries(SETS)) {
  if (only && only !== name) continue;
  const { glb, tris, verts } = writeGlb(name, set.parts);
  if (tris > TRI_BUDGET[name]) {
    throw new Error(`${name} is ${tris} tris - over the ${TRI_BUDGET[name]} reservation`);
  }
  const out = outOverride ? path.resolve(outOverride) : path.join(root, 'public/assets/npc', set.file);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, glb);
  console.log(`${out}\n  ${Object.keys(set.parts).length} parts, ${verts} verts, ${tris} tris, ${glb.length} bytes`);
}
