/**
 * Authored hero architecture for Sunspire Citadel.
 *
 * Phase 9 / decision D4: authored `.glb` hero assets through the pipeline
 * already proven four times (`make-newel-glb.mjs`, `make-ship-glb.mjs`,
 * `make-npc-glb.mjs`, `make-beast-glb.mjs`), procedural systems for bulk
 * content. This is the architecture half of that for the citadel.
 *
 * ── What the before shots said, which is why these parts and not others ───
 *
 * Thirteen framings at 1600x900, hardware GL, `gameplayDriven: true`
 * (`.probe/art-citadel/before/`). The mesa, the ring plan, the haze and the
 * silhouette are strong and are NOT the subject of this pass. Three things
 * were:
 *
 *   - **`gate-approach`.** `_buildCurtainWall`'s own comment calls the
 *     gatehouse opening "the arch the player walks in under". It is a
 *     rectangular hole under a flat lintel. So is every doorway in the souk,
 *     every window reveal, and the keep. **This world's entire architectural
 *     language is a language of arches and it does not contain one**, because
 *     `Batch.box` is an axis-aligned rounded box and a curved void is the one
 *     shape it cannot make. Stepping a curve out of twenty-four small boxes is
 *     a staircase, not an arch, and costs more triangles than authoring it.
 *   - **`souk-alley`.** Both walls of the world's signature climb are blank
 *     plaster with two near-black horizontal slabs across them. The openings
 *     read as dark slots. There is nothing on a facade that says a person
 *     lives behind it.
 *   - **`ward-centre` / `minaret-bridge`.** The four minarets are square
 *     shafts with flat slab balcony rings and an onion cap - chess pawns. What
 *     makes a minaret a minaret is the corbelled bracket course that carries
 *     its gallery, and a corbel course is a stack of nested niches with curved
 *     edges: the second shape a box batch cannot make.
 *
 * Those three are exactly the list this pipeline reaches for: rigid features
 * with edges and curves, sitting on surfaces built by a tool that is good at
 * everything except edges and curves.
 *
 * ── Two rules that shape every vertex below ──────────────────────────────
 *
 * **1. NORMALISED LOCAL SPACE.** Every part is authored to a unit frame and
 * placed by a matrix, because the same arch has to fit a 6.0 m gate and a
 * 1.25 m doorway. The frames are documented on each part and asserted by
 * `scripts/tests/citadel-assets.test.mjs` against the committed bytes, so a
 * generator edit that moves the springing line fails the gate rather than
 * quietly sliding every arch in the world.
 *
 * **2. NO NEW MATERIAL, NO NEW MESH, NO NEW DRAW CALL.** Every part names one
 * of the material keys the destination `Batch` ALREADY emits and is added to
 * that batch with `Batch.add`, which merges it into the same bucket. There is
 * no key invented here: a part in a key its batch does not already flush would
 * be a new `THREE.Mesh` in `Batch.flush`, i.e. a draw call and a candidate
 * shader program, and Citadel's whole render argument is 166 meshes for
 * 350,000 triangles.
 *
 * That second rule is the program-count rule. Three keys its shader cache on
 * material configuration, this project boots by warming the cartesian product
 * of those programs, and Phase 9 is named in the roadmap as the phase most
 * likely to regress production frame time. Reusing the keys the world already
 * clones costs exactly zero programs. The cost of everything in this file is
 * triangles and nothing else, and `TRI_BUDGET` below is the reservation.
 *
 * ── Output ───────────────────────────────────────────────────────────────
 *
 *   public/assets/citadel/citadel.glb   arch, screen, corbel
 *
 * One mesh per part, named for the part key.
 *
 *   node scripts/make-citadel-glb.mjs
 *   CITADEL_GLB_SET=citadel CITADEL_GLB_OUT=/tmp/x.glb node scripts/make-citadel-glb.mjs
 *
 * The env override exists for the reason every generator here has one: the
 * byte-diff test re-runs this into a temp file and compares buffers, and a
 * generator that can only write to its committed path cannot be tested.
 */

import * as THREE from 'three';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ */
/* The arch curve, which three parts are measured against              */
/* ------------------------------------------------------------------ */

/**
 * Two-centre pointed arch, normalised to a half-span of 1.
 *
 * Centres sit on the springing line at `x = -+ARCH_C`, radius `ARCH_R =
 * 1 + ARCH_C`, so the right-hand arc passes through the right springing point
 * (1, 0) and reaches the crown on the axis. `ARCH_CROWN = sqrt(1 + 2c)` falls
 * out of that and is the rise of the arch in half-spans.
 *
 * `c = 0.5` is not arbitrary. At `c = 0` this is a semicircle - a Roman arch,
 * which is the wrong period and, more usefully, is the one shape a stack of
 * boxes half-manages. At `c = 1` the point is so sharp it reads as a gothic
 * lancet. Half a span puts the rise at 1.414 half-spans, which is the
 * proportion the Timurid and Mamluk gates this town is dressed as actually
 * carry, and it is steep enough that the pointed head is unmistakable in
 * silhouette at the 231 m of `desert-overview`.
 */
export const ARCH_C = 0.5;
export const ARCH_R = 1 + ARCH_C;
export const ARCH_CROWN = Math.sqrt(1 + 2 * ARCH_C);
/** Angle at the crown, measured from the springing line at the far centre. */
export const ARCH_T_CROWN = Math.acos(ARCH_C / ARCH_R);

/**
 * Stations along one half of the intrados.
 *
 * Nine, and the number was chosen against a pixel rather than by habit. The
 * biggest arch in the world is the 6.0 m gate, seen from `gate-approach` at
 * 18 m; eight chords over a 90-degree-ish sweep leave a maximum sagitta of
 * `R(1 - cos(t/2))` = 0.043 half-spans = 13 cm on that arch, which at 18 m and
 * a 72-degree field is under two pixels of deviation at 1080 lines. Sixteen
 * stations would double the triangle bill of the most-repeated part in this
 * file to fix something nobody can resolve.
 */
export const ARCH_STATIONS = 9;

/** Intrados point at station `j` of the RIGHT half, in the normalised frame. */
export function archPoint(j, n = ARCH_STATIONS) {
  const t = (ARCH_T_CROWN * j) / (n - 1);
  return {
    t,
    x: -ARCH_C + ARCH_R * Math.cos(t),
    y: ARCH_R * Math.sin(t),
    /** Unit normal pointing INTO the void, which is the soffit's facing. */
    nx: -Math.cos(t),
    ny: -Math.sin(t),
  };
}

/* ------------------------------------------------------------------ */
/* Where each part is allowed to be welded                             */
/* ------------------------------------------------------------------ */

/**
 * `batch:materialKey` buckets `CitadelWorld` already flushes.
 *
 * A part added to a batch in a key that batch does not already emit opens a
 * NEW bucket, and `Batch.flush` turns every bucket into its own `THREE.Mesh`.
 * That is a draw call and a candidate shader program on a world whose entire
 * render argument is 166 meshes. The loader refuses a bind outside this list;
 * `citadel-assets.test.mjs` holds the list against a real headless build, so
 * it cannot rot into a stale claim that welding somewhere is safe.
 */
export const WELDABLE = Object.freeze([
  'wall:stone.castle',
  'souk:stone.castle',
  'souk:wood.beam',
  'citadel:stone.castle',
  'citadel:plaster.wall',
]);

/** part key -> { slot, batches } - mirrored into the manifest's `bind`. */
export const PART_BINDING = Object.freeze({
  arch: { slot: 'stone.castle', batches: ['wall', 'souk'] },
  screen: { slot: 'wood.beam', batches: ['souk'] },
  corbel: { slot: 'stone.castle', batches: ['citadel', 'wall'] },
});

/**
 * Triangle reservation, per part, for ONE placement.
 *
 * These merge into geometry the world already draws, so they cost no draw
 * call, no material and no program - but they do cost triangles, and unlike a
 * beast (of which eight are ever resident) a doorway arch is placed on every
 * street-facing house in a 200-building souk. The reservation is per part and
 * the world-level reservation is `CITADEL_TRI_BUDGET` in `CitadelAssets.js`,
 * asserted against a real build.
 */
export const TRI_BUDGET = Object.freeze({ arch: 260, screen: 240, corbel: 260 });

/** Total for the one file, for the manifest test. */
export const SET_TRI_BUDGET = 760;

/* ------------------------------------------------------------------ */
/* A very small surface kit                                            */
/* ------------------------------------------------------------------ */

/**
 * Accumulates explicit quads into one indexed buffer.
 *
 * Quad-based rather than primitive-based, and that is the difference between
 * this generator and `make-beast-glb.mjs`. A hackle crest is a row of scaled
 * boxes and a nose pad is a squashed sphere, so that file places primitives. A
 * pointed arch is a ruled surface between a curve and a rectangle - there is
 * no primitive for it, which is precisely why it is here rather than in a
 * `Batch.box` call.
 *
 * Vertices are NOT shared between quads. The parts are hard-edged
 * architecture, every quad wants its own normal, and welding would cost a
 * comparison pass for a smoothing nobody wants on a stone arris. The soffit is
 * the one curved surface and it passes its own per-vertex normals.
 */
class Mesher {
  constructor() {
    this.pos = [];
    this.nor = [];
    this.uv = [];
    this.idx = [];
  }

  /**
   * One quad, wound p0 -> p1 -> p2 -> p3 counter-clockwise as seen from the
   * side the normal points at.
   *
   * @param {number[]} p0 [x,y,z]
   * @param {number[]} p1
   * @param {number[]} p2
   * @param {number[]} p3
   * @param {number[][]} [normals] four per-vertex normals; flat-shaded from
   *   the triangle plane when absent.
   */
  quad(p0, p1, p2, p3, normals = null) {
    const base = this.pos.length / 3;
    let n = normals;
    if (!n) {
      /* ── THE ONE THAT WHITED OUT THE WHOLE GATEHOUSE ───────────────────
       *
       * A quad on this kind of surface is often HALF degenerate: an arch's
       * spandrel has zero width at the springing line, so its first station's
       * `p0` and `p1` are the same point, and a corbel bracket's cheek has
       * zero area wherever the profile has not stepped out yet. The cross
       * product of the first triangle is then the zero vector.
       *
       * Divided by `len || 1` that becomes the normal (0, 0, 0), which is
       * finite, passes every check this file had, writes cleanly into the
       * `.glb`, and is a NaN the moment the shader calls `normalize` on it.
       * Measured: 8 in the arch and 56 in the corbel, times ~350 placements,
       * merged into two of the world's districts - and
       * `.probe/art-citadel/mid2/` is a photograph of a gatehouse that has
       * become a white cloud through bloom. Exactly the shape of the CC0
       * roughness-map defect the roadmap warns about, arriving from the other
       * direction: a channel that is silently wrong rather than absent.
       *
       * So the normal is taken from whichever of the quad's two triangles has
       * area, and a quad with neither is DROPPED - it has no area to shade and
       * emitting it can only cost. `geometry()` then refuses any normal that
       * is not unit length, so this cannot come back quietly. */
      const face = (q0, q1, q2) => {
        const ax = q1[0] - q0[0], ay = q1[1] - q0[1], az = q1[2] - q0[2];
        const bx = q2[0] - q0[0], by = q2[1] - q0[1], bz = q2[2] - q0[2];
        const cx = ay * bz - az * by;
        const cy = az * bx - ax * bz;
        const cz = ax * by - ay * bx;
        const len = Math.hypot(cx, cy, cz);
        return len > 1e-9 ? [cx / len, cy / len, cz / len] : null;
      };
      const c = face(p0, p1, p2) ?? face(p0, p2, p3) ?? face(p1, p2, p3);
      if (!c) return this;                 // no area anywhere: nothing to draw
      n = [c, c, c, c];
    }
    const uvs = [[0, 0], [1, 0], [1, 1], [0, 1]];
    for (let i = 0; i < 4; i++) {
      const p = [p0, p1, p2, p3][i];
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(n[i][0], n[i][1], n[i][2]);
      this.uv.push(uvs[i][0], uvs[i][1]);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    return this;
  }

  /**
   * A rectangular prism between two opposite corners, six quads, outward
   * normals. The one primitive this file does keep, because a keystone and a
   * screen mullion really are boxes and writing them as six `quad` calls each
   * would be noise.
   */
  boxAt(x0, y0, z0, x1, y1, z1) {
    const q = (a, b, c, d) => this.quad(a, b, c, d);
    q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);  // +z
    q([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]);  // -z
    q([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]);  // +x
    q([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);  // -x
    q([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]);  // +y
    q([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);  // -y
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
    /* A mirror is a negative-determinant transform, so the winding flips with
     * it or every mirrored triangle faces inward and the part renders inside
     * out. Same correction the ship, NPC and beast generators apply. */
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
      /* A NaN position blooms over the whole district once it is merged and is
       * invisible in the numbers printed at the end. Same gate every generator
       * in this repository carries, for the same reason. */
      if (!Number.isFinite(v)) throw new Error(`${name}: non-finite position`);
    }
    /* AND THE NORMALS, which is the gate the other generators do not need and
     * this one does. They build from `SphereGeometry` and `BoxGeometry`, whose
     * normals are unit by construction; this file computes its own off a cross
     * product, and a zero-length one is finite, writes cleanly, and is NaN in
     * the shader. See the note in `quad`. Checked to 1e-4 rather than exactly,
     * because these are single-precision floats by the time they land here. */
    for (let i = 0; i < this.nor.length; i += 3) {
      const len = Math.hypot(this.nor[i], this.nor[i + 1], this.nor[i + 2]);
      if (!(Math.abs(len - 1) < 1e-4)) {
        throw new Error(`${name}: normal ${i / 3} has length ${len} - a shader normalizes that to NaN`);
      }
    }
    return g;
  }
}

/* ------------------------------------------------------------------ */
/* The parts                                                           */
/* ------------------------------------------------------------------ */

/**
 * `arch` - the pointed-arch surround.
 *
 * FRAME. `x` in [-1, 1] is the span; `y = 0` is the SPRINGING LINE and `y`
 * rises to `ARCH_CROWN`; `z` in [-0.5, 0.5] is the wall's own thickness. A
 * placement scales x by the half-span, y by the same (so the arch keeps its
 * proportion), and z by the depth of the wall it is set into.
 *
 * WHAT IT IS, and why it is a surround rather than a whole arch. The world's
 * openings already exist: the gatehouse is a real hole between two flanking
 * blocks, and a souk doorway is a near-black panel set into the wall face.
 * Both are rectangles. This part is the SOLID that turns a rectangle into a
 * pointed opening - the two spandrels that fill the top corners, the archivolt
 * moulding that runs round the curve, and the keystone. Placed over what is
 * already there it works identically on a hole and on a painted recess, which
 * is why there is one arch part and not two.
 *
 * The spandrel is the region between the rectangle `|x| <= 1, 0 <= y <=
 * ARCH_CROWN` and the pointed void. At the springing line it has zero width
 * and at the crown it is nearly the full span, which is what an arch spandrel
 * is. Front face, back face and the curved soffit between them; the outer
 * jamb face and the top are included so the piece is closed, which costs four
 * triangles and means a placement half-buried in a wall never shows a hole.
 */
function arch(m) {
  const N = ARCH_STATIONS;
  const H = 0.5;               // half the normalised thickness
  /** Archivolt: how far it stands off the intrados, and how proud of the face. */
  const A_OUT = 0.20;
  const A_PROUD = 0.085;

  m.pair(() => {
    for (let j = 0; j < N - 1; j++) {
      const a = archPoint(j);
      const b = archPoint(j + 1);
      // Front and back spandrel faces.
      m.quad([a.x, a.y, H], [1, a.y, H], [1, b.y, H], [b.x, b.y, H]);
      m.quad([b.x, b.y, -H], [1, b.y, -H], [1, a.y, -H], [a.x, a.y, -H]);
      /* The soffit. Per-vertex normals from the arc, not from the chord: this
       * is the one curved surface in the file and flat-shading eight chords
       * over ninety degrees puts a visible facet band inside every arch in the
       * world. */
      const na = [a.nx, a.ny, 0];
      const nb = [b.nx, b.ny, 0];
      m.quad(
        [a.x, a.y, -H], [a.x, a.y, H], [b.x, b.y, H], [b.x, b.y, -H],
        [na, na, nb, nb]
      );
      /* The archivolt, swept along the same stations: a band standing proud of
       * the FRONT face only, from the intrados outward. Three faces - the
       * proud top, the inner return against the void, the outer return - which
       * is what gives an arch its shadow line. The back face carries none: it
       * is either inside a wall or, at the gate, framed by its own mirrored
       * placement. */
      const ao = [a.x - a.nx * A_OUT, a.y - a.ny * A_OUT];
      const bo = [b.x - b.nx * A_OUT, b.y - b.ny * A_OUT];
      const P = H + A_PROUD;
      m.quad([a.x, a.y, P], [ao[0], ao[1], P], [bo[0], bo[1], P], [b.x, b.y, P]);
      m.quad(
        [a.x, a.y, H], [a.x, a.y, P], [b.x, b.y, P], [b.x, b.y, H],
        [[a.nx, a.ny, 0], [a.nx, a.ny, 0], [b.nx, b.ny, 0], [b.nx, b.ny, 0]]
      );
      m.quad([ao[0], ao[1], P], [ao[0], ao[1], H], [bo[0], bo[1], H], [bo[0], bo[1], P]);
    }
    // Outer jamb face and the top, so the spandrel is a closed solid.
    m.quad([1, 0, H], [1, 0, -H], [1, ARCH_CROWN, -H], [1, ARCH_CROWN, H]);
    m.quad([0, ARCH_CROWN, H], [1, ARCH_CROWN, H], [1, ARCH_CROWN, -H], [0, ARCH_CROWN, -H]);
  });

  /* Keystone. A wedge proud of the archivolt on the axis, because an arch
   * without one has nothing at its crown for the eye to land on and the two
   * halves read as two separate curves meeting by accident. */
  const kw = 0.16;
  m.boxAt(-kw, ARCH_CROWN - 0.30, H, kw, ARCH_CROWN + 0.14, H + A_PROUD + 0.045);
}

/**
 * `screen` - the mashrabiya window panel.
 *
 * FRAME. `x` and `y` in [-0.5, 0.5] are the opening; `z` in [-0.5, 0.5] is
 * the reveal depth. A placement scales x and y by the window's own width and
 * height and z by how far it stands proud of the recess.
 *
 * WHAT IT IS. A framed lattice with a pointed head, sitting in front of the
 * near-black recess panel `_buildSouk` already paints. From the alley the
 * recess reads as a hole; with a screen over it, it reads as a window
 * somebody lives behind - and it is the ONE element in this world's vocabulary
 * that is defined by its holes rather than by its mass.
 *
 * WHY IT IS AUTHORED, honestly. A lattice CAN be approximated by boxes: this
 * is six mullions, six transoms, a frame and a head. Done as `Batch.box` calls
 * that is sixteen boxes at twelve triangles each, 192 triangles, against 200
 * here - so the triangle argument is a wash and is not the argument. The
 * argument is the HEAD: the pointed arch over the panel is the same curve as
 * `arch`, it ties the window to the doorway below it, and a box batch cannot
 * make it. A screen with a square head is a prison grille.
 */
function screen(m) {
  const F = 0.5;               // outer half-extent in x and y
  const T = 0.5;               // half the normalised thickness
  const FR = 0.075;            // frame bar width
  const BAR = 0.032;           // lattice bar half-width

  // Outer frame: four bars round the opening.
  m.boxAt(-F, -F, -T, F, -F + FR, T);
  m.boxAt(-F, F - FR, -T, F, F, T);
  m.boxAt(-F, -F + FR, -T, -F + FR, F - FR, T);
  m.boxAt(F - FR, -F + FR, -T, F, F - FR, T);

  /* The lattice. Three mullions and three transoms over the lower two thirds,
   * which is where a screen's pattern is legible from a 3 m alley; the top
   * third belongs to the head. Bars are thinner than the frame so the frame
   * reads as the frame. */
  const inner = F - FR;
  const headY = F - FR - (2 * inner) * 0.34;     // springing of the head
  for (let i = 1; i <= 3; i++) {
    const x = -inner + (2 * inner * i) / 4;
    m.boxAt(x - BAR, -inner, -T * 0.55, x + BAR, headY, T * 0.55);
  }
  for (let i = 1; i <= 3; i++) {
    const y = -inner + (headY + inner) * (i / 4);
    m.boxAt(-inner, y - BAR, -T * 0.55, inner, y + BAR, T * 0.55);
  }

  /* The head: the same two-centre curve as `arch`, drawn as a thin ribbon of
   * bar rather than as a solid, so the shape is in the tracery and the light
   * still comes through. Scaled from the normalised arch frame into the panel:
   * half-span `inner`, rise `inner * ARCH_CROWN` clamped to the space left. */
  const rise = Math.min(inner * ARCH_CROWN, F - FR - headY);
  const ky = rise / ARCH_CROWN;
  const N = 7;
  const ribbon = 0.030;
  m.pair(() => {
    for (let j = 0; j < N - 1; j++) {
      const a = archPoint(j, N);
      const b = archPoint(j + 1, N);
      const ax = a.x * inner, ay = headY + a.y * ky;
      const bx = b.x * inner, by = headY + b.y * ky;
      // A flat ribbon following the curve, one quad per station per face.
      const aox = ax - a.nx * ribbon, aoy = ay - a.ny * ribbon;
      const box_ = bx - b.nx * ribbon, boy = by - b.ny * ribbon;
      const z = T * 0.55;
      m.quad([ax, ay, z], [aox, aoy, z], [box_, boy, z], [bx, by, z]);
      m.quad([bx, by, -z], [box_, boy, -z], [aox, aoy, -z], [ax, ay, -z]);
    }
  });
}

/**
 * `corbel` - one straight run of a muqarnas bracket course.
 *
 * FRAME. `x` in [-0.5, 0.5] is the run's LENGTH along the wall; `y` in
 * [-1, 0] hangs BELOW the slab it carries, so a placement puts the origin on
 * the underside of the gallery and needs no height arithmetic; `z` in [0, 1]
 * projects OUT from the wall face. A placement scales x by the side's length,
 * y by the drop and z by the projection, and rotates about y by the face's
 * bearing.
 *
 * WHAT IT IS. Two tiers of nested pointed niches, the upper tier offset half a
 * cell from the lower, which is the whole trick of a muqarnas: each cell is
 * carried on the two below it, so the course steps out from the wall in a
 * honeycomb rather than in a straight bracket. Three cells over the run, four
 * on the tier below.
 *
 * WHY IT IS AUTHORED. This is the shape the roadmap's "don't build organic
 * shapes from stacked boxes" line is about, from the architectural side. A
 * corbel course is nested CURVED niches; every approximation from boxes is a
 * staircase, and the four minarets are the world's most distant readable
 * silhouette - the thing `desert-overview` and `eyrie-summit` both photograph
 * from a quarter of a kilometre. There is nothing else in this world's toolbox
 * that can put a shadow under a gallery.
 */
function corbel(m) {
  /* ── WHAT THE FIRST VERSION GOT WRONG, WHICH IS WHY THIS ONE IS SOLID ────
   *
   * The obvious muqarnas is a row of nested NICHES: hollow cells, each carried
   * on the two below it. Built that way and photographed
   * (`.probe/art-citadel/mid1/ward-centre.png`, `…/gate-approach.png`) the
   * course read as a row of dark hanging TEETH. Two reasons, and both are
   * about light rather than about shape:
   *
   *   - A niche is a cavity, every surface in it faces inward, and `Batch`'s
   *     baked `sky` term darkens exactly those. Sixty courses of cavity is
   *     sixty black fringes.
   *   - Open at the back, each cell was silhouetted against the sky between
   *     its neighbours. A bracket course reads as MASS with shadow in it, not
   *     as shadow with mass around it, and the difference is entirely whether
   *     there is anything behind the cells.
   *
   * So this is the same architecture from the solid side: a course of stepped
   * BRACKETS with a backing panel, in two tiers half a cell out of phase, which
   * is the honeycomb stagger a muqarnas is actually read by. Every surface that
   * faces the camera now faces OUT, and the dark is the gaps between brackets
   * rather than the inside of every one of them.
   */

  /** Stations down one bracket's front profile. Four - it is a 0.7 m band. */
  const M = 4;
  /** Bracket profile: how far out the front stands, at depth `t` down. */
  const zAt = (t) => 1 - t * t;

  /**
   * One bracket: a closed wedge standing off the wall, widest at the top where
   * it meets the slab and dying into the face at the bottom.
   */
  function bracket(cx, halfW, y0, y1, out0, out1) {
    const yAt = (t) => y1 + (y0 - y1) * t;
    const oAt = (t) => out0 + (out1 - out0) * zAt(t);
    for (let j = 0; j < M - 1; j++) {
      const t0 = j / (M - 1);
      const t1 = (j + 1) / (M - 1);
      const y0j = yAt(t0), y1j = yAt(t1);
      const z0 = oAt(t0), z1 = oAt(t1);
      // Front face, looking out and slightly down.
      m.quad([cx - halfW, y1j, z1], [cx + halfW, y1j, z1], [cx + halfW, y0j, z0], [cx - halfW, y0j, z0]);
      // The two cheeks.
      m.quad([cx + halfW, y1j, z1], [cx + halfW, y1j, out0], [cx + halfW, y0j, out0], [cx + halfW, y0j, z0]);
      m.quad([cx - halfW, y1j, out0], [cx - halfW, y1j, z1], [cx - halfW, y0j, z0], [cx - halfW, y0j, out0]);
    }
    // Top cap, against the slab this bracket pretends to carry.
    m.quad([cx - halfW, y1, out1], [cx + halfW, y1, out1], [cx + halfW, y1, out0], [cx - halfW, y1, out0]);
  }

  /* Two tiers, the upper one offset half a cell so each of its brackets lands
   * over the gap between two of the lower ones. That stagger is the whole
   * difference between a muqarnas and a row of dentils. */
  const LOWER = 4;
  const UPPER = 3;
  for (let c = 0; c < LOWER; c++) {
    const cx = -0.5 + (c + 0.5) / LOWER;
    bracket(cx, (0.5 / LOWER) * 0.74, -0.70, -0.30, 0.04, 0.52);
  }
  for (let c = 0; c < UPPER; c++) {
    const cx = -0.5 + (c + 1) / (UPPER + 1);
    bracket(cx, (0.5 / UPPER) * 0.70, -0.34, 0.0, 0.34, 1.0);
  }

  /* The backing panel, which is the fix. Nothing behind the brackets and the
   * course is a fringe against the sky; a hand's width of wall behind them and
   * it is a course with shadow in it. Runs the full length and the full drop so
   * no gap can see daylight from any bearing a player reaches. */
  m.boxAt(-0.5, -0.74, 0, 0.5, 0.02, 0.1);

  /* The drip mould on top: the string course the gallery actually sits on, and
   * the horizontal that stops the brackets reading as an isolated frill. */
  m.boxAt(-0.5, -0.02, 0, 0.5, 0.10, 1.06);
}

/* ------------------------------------------------------------------ */
/* The set                                                             */
/* ------------------------------------------------------------------ */

/** @type {Record<string, {file:string, parts:Record<string, (m:Mesher)=>void>}>} */
const SETS = {
  citadel: {
    file: 'citadel.glb',
    parts: { arch, screen, corbel },
  },
};

/** The parts each set contains, for the manifest and for the tests. */
export const SET_PARTS = Object.freeze(
  Object.fromEntries(Object.entries(SETS).map(([k, v]) => [k, Object.keys(v.parts)]))
);

/* ------------------------------------------------------------------ */
/* glTF writer - the same one every generator in this repo uses        */
/* ------------------------------------------------------------------ */

const align = (n) => (n % 4 ? 4 - (n % 4) : 0);

function accessorMinMax(arr, itemSize, count) {
  const min = new Array(itemSize).fill(Infinity);
  const max = new Array(itemSize).fill(-Infinity);
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < itemSize; k++) {
      const v = arr[i * itemSize + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
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
  const perPart = {};
  let tris = 0;
  let verts = 0;

  for (const [key, build] of Object.entries(parts)) {
    const m = new Mesher();
    build(m);
    const geo = m.geometry(key);
    const vCount = geo.attributes.position.count;
    const iArr = geo.index.array;
    verts += vCount;
    tris += iArr.length / 3;
    perPart[key] = iArr.length / 3;

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
      pbrMetallicRoughness: { baseColorFactor: [0.72, 0.66, 0.52, 1], metallicFactor: 0, roughnessFactor: 0.92 },
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
      generator: 'aether-nexus scripts/make-citadel-glb.mjs',
      copyright: 'generated - procedurally authored in this repository, no external source',
    },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    /* Placeholders so the file stands alone in a viewer. The game DISCARDS
     * every one of these and adds each part to the world's own `Batch` under
     * the material key the manifest names - see CitadelAssets.js. A test
     * asserts a built world's mesh and material counts are unchanged by
     * loading this. */
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

  return { glb: Buffer.concat([header, jsonHeader, jsonBytes, binHeader, binBytes]), tris, verts, perPart };
}

/* Guarded so the module can be imported by the test without writing files.
 * `import.meta.main` is Node 22; the `argv` comparison is the portable half. */
const isMain = path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const only = process.env.CITADEL_GLB_SET;
  const outOverride = process.env.CITADEL_GLB_OUT;
  if (outOverride && !only) {
    throw new Error('CITADEL_GLB_OUT needs CITADEL_GLB_SET - it names one file, not both');
  }

  for (const [name, set] of Object.entries(SETS)) {
    if (only && only !== name) continue;
    for (const key of Object.keys(set.parts)) {
      const bind = PART_BINDING[key];
      if (!bind) throw new Error(`${name}.${key} has no binding declared`);
      for (const batch of bind.batches) {
        const pair = `${batch}:${bind.slot}`;
        if (!WELDABLE.includes(pair)) {
          throw new Error(`${name}.${key} binds to '${pair}', which CitadelWorld does not already flush`);
        }
      }
    }
    const { glb, tris, verts, perPart } = writeGlb(name, set.parts);
    for (const [key, n] of Object.entries(perPart)) {
      if (n > TRI_BUDGET[key]) {
        throw new Error(`${name}.${key} is ${n} tris - over the ${TRI_BUDGET[key]} reservation`);
      }
    }
    if (tris > SET_TRI_BUDGET) {
      throw new Error(`${name} is ${tris} tris - over the ${SET_TRI_BUDGET} reservation`);
    }
    const out = outOverride
      ? path.resolve(outOverride)
      : path.join(root, 'public/assets/citadel', set.file);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, glb);
    console.log(`${out}\n  ${Object.keys(set.parts).length} parts, ${verts} verts, ${tris} tris, ${glb.length} bytes`);
    for (const [key, n] of Object.entries(perPart)) console.log(`    ${key.padEnd(10)} ${n} tris`);
  }
}
