/**
 * Authored hero geometry for the race world - Vellum Ridge, Cinder Gorge and
 * Aurora Rise.
 *
 *   node scripts/make-race-glb.mjs                  # writes both files
 *   RACE_GLB_ASSET=spectator RACE_GLB_OUT=/tmp/x.glb node scripts/make-race-glb.mjs
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THESE TWO OBJECTS AND NOT SOMETHING ELSE IN THIS WORLD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 9 / decision D4: authored `.glb` hero assets through the pipeline
 * already proven five times (`make-newel-glb.mjs`, `make-ship-glb.mjs`,
 * `make-npc-glb.mjs`, `make-beast-glb.mjs`, `make-crowd-glb.mjs`,
 * `make-yard-glb.mjs`, `make-citadel-glb.mjs`); procedural systems for bulk
 * content.
 *
 * The architecture was measured before anything was authored. The race world
 * builds 453 renderables from 29 materials for 1.81 M triangles, already
 * merged by material per district plus 129 tiled `InstancedMesh` systems - the
 * citadel/dock shape, not the sports one. There is no draw-call win here and
 * none was attempted, and the roadmap forbids porting the maze's `BatchedMesh`
 * machinery into a world whose many-meshes-one-material split is deliberate
 * spatial partitioning for the frustum culler.
 *
 * Then the subjects were photographed at conversational distance, which is
 * what actually decided this file's contents.
 *
 * ── 1. The spectator ────────────────────────────────────────────────────
 *
 * `RaceWorld._spawnCrowd` builds 801 grandstand figures - the largest single
 * population in the world and the only one a player can walk up to - as
 *
 *     sweep([{y:0,rx:.20,ry:.13}, ... {y:.94,rx:.11,ry:.09}], 8)
 *     + blob(0.12, 0.14, 0.12, 0, 1.08, 0, 8)
 *
 * which is a lofted cone with a sphere balanced on it: 1.22 m tall, no
 * shoulders, no arms, no legs, no shoes, and a head that is exactly as wide as
 * the neck it stands on. Photographed from 6.5 m
 * (`img/2026-08-23-art-race/before-crowd-front.jpg`) it is a shelf of
 * skittles, and one thing is louder than the silhouette: **the head is painted
 * the shirt colour.** Body and head are merged into ONE geometry and handed
 * ONE `setColorAt` per instance, so a spectator in a green shirt has a green
 * head. Every one of the 801 does.
 *
 * ── 2. The marshal post ─────────────────────────────────────────────────
 *
 * `_buildTrackside` puts 29 of them round the three circuits, one every 150 m,
 * and every one is
 *
 *     B.box('metal.panel', 3.2, 2.6, 2.6, ...)     a solid riveted crate
 *     B.box('metal.trim',  3.6, 0.3, 3.0, ...)     a lid
 *     B.box('hazard.stripe', 3.3, 0.5, 0.2, ...)   a band nobody has ever seen
 *
 * The band is 0.2 m deep, drawn at the post's own centre, inside a box 2.6 m
 * deep. It is the citadel's window recesses again: arithmetic that reads
 * perfectly, a comment that describes what it was meant to do, and not one
 * rendered pixel since the day it was written. (It was also, separately,
 * placed 3.75 m into the air by the scratch-vector aliasing this branch fixes
 * in `RaceWorld.Batch.box` - so it was invisible for two independent reasons.)
 *
 * A marshal post is a flag point. It has a face you can see into, a rail, a
 * roof that overhangs, and a hazard band that reads from every side. None of
 * those are shapes `Batch.box` can make: a recess needs a surround standing
 * proud of a back panel, which is four solids and not one, and a box kit that
 * paints a panel inside a solid is the exact defect above.
 *
 * ── What is NOT here, and why ───────────────────────────────────────────
 *
 * The **tyre stacks** (314 of them, three tyres each) stay procedural. A tyre
 * is a surface of revolution, which is the shape a runtime primitive is *good*
 * at - the citadel's jar argument, from the other side. They become
 * eight-sided drums rather than authored toruses because a 12x5 torus is 120
 * triangles against 32, and 942 of them is +102,000 triangles of trackside
 * furniture seen from a car at 30 m/s.
 *
 * The **conifers, rocks, city, terrain, road ribbon, kerbs and barriers** are
 * bulk content over 1.7 km^2 and are exactly what D4 keeps procedural.
 *
 * ── The cost rule, which is the whole design ────────────────────────────
 *
 * Nothing here brings a material. The marshal's three meshes are NAMED FOR
 * RACE MATERIAL KEYS and are merged by `Batch.add` into the `trackside.<id>`
 * bucket of that key, so they land inside a mesh the world already draws. The
 * spectator's five meshes are merged into ONE geometry at load and drawn by
 * the same single `race:crowd` InstancedMesh, with each part's `shade` written
 * into a vertex-colour attribute that multiplies the per-instance shirt.
 *
 *   no new draw call, no new material, no new shader program, no new node.
 *
 * That last one is why the rule is a rule. Three keys its program cache on
 * material configuration, this project boots by warming the cartesian product
 * of those programs, and the roadmap names Phase 9 as the phase most likely to
 * regress production frame time. The cost of everything in this file is
 * triangles, and `TRI_BUDGET` below is where that is capped.
 *
 * ── The three gates, and why they are these three ───────────────────────
 *
 * `art-citadel` shipped 64 zero-length normals in a valid `.glb` and blew the
 * gatehouse into a white cloud, because a degenerate quad's cross product
 * divided by `len || 1` is the finite, NaN-on-`normalize` vector (0, 0, 0).
 * `art-maze` then found that a star-shaped "does every face point away from
 * the centroid" test fires on geometry that legitimately faces inward. So the
 * gates here are:
 *
 *   1. **No degenerate face.** Refused in `quad`/`tri`, at the line where the
 *      winding is decided, and re-asserted against the committed bytes by
 *      `scripts/tests/race-assets.test.mjs`.
 *   2. **Closed manifold.** Every directed edge matched by exactly one
 *      opposite directed edge, compared BY POSITION rather than by index, so
 *      two solids that share a face plane are still each closed.
 *   3. **Positive signed volume.** The divergence-theorem sum over the faces.
 *      A part wound entirely inside out passes (1) and (2) and fails this.
 *
 * Every part in this file is a set of closed solids, deliberately, so all
 * three apply to all of it. That is also why the spectator's face is a shallow
 * closed wedge rather than a plane: a plane cannot be checked.
 */

import * as THREE from 'three';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ */
/* Budgets                                                             */
/* ------------------------------------------------------------------ */

/**
 * Per-file triangle reservation.
 *
 * The spectator is instanced 801 times and the marshal placed 29 times, so
 * these two numbers are the whole triangle cost of this branch's authoring:
 * 801 * spectator + 29 * marshal. At the caps below that is at most 240,300 +
 * 11,600 = 251,900 against the 1,812,804 the world already draws, and the
 * shipped build comes in well under - see the manifest and the design note.
 */
const TRI_BUDGET = { spectator: 300, marshal: 400 };

/**
 * Texel density. `race.paint.enamel` is authored for 0.6 m per UV tile and the
 * material library leaves `repeat` at 1, so UVs are METRES / 0.6 - the same
 * convention `RaceWorld.Batch.add` uses when it re-projects a batched box.
 *
 * Only the spectator's UVs survive to the GPU. The marshal's parts go through
 * `Batch.add`, which throws its own planar world-space projection over
 * whatever the file carries, so theirs are written for a viewer and not for
 * the renderer.
 */
const ENAMEL_TILE = 0.6;

/* ------------------------------------------------------------------ */
/* A quad mesher with the three gates                                  */
/* ------------------------------------------------------------------ */

/**
 * Flat-shaded quads and nothing else.
 *
 * Flat is the subject rather than a shortcut: a spectator at 40 m is a
 * silhouette with a value break at the shoulder and one at the waist, and
 * smooth normals over a six-sided torso remove exactly those breaks. Every
 * vertex here belongs to exactly one face.
 */
class Quads {
  constructor(name) {
    this.name = name;
    this.pos = [];
    this.nor = [];
    this.uv = [];
    this.idx = [];
    /** Directed edges, by rounded position, for the manifold gate. */
    this._edges = new Map();
    /** Twice the signed volume, accumulated per triangle. */
    this._vol2 = 0;
  }

  /** Position key for the manifold gate. 0.1 mm, which is finer than anything here. */
  static _k(p) { return `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)},${Math.round(p[2] * 1e4)}`; }

  _face(a, b, c) {
    const K = Quads._k;
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const key = `${K(p)}|${K(q)}`;
      this._edges.set(key, (this._edges.get(key) ?? 0) + 1);
    }
    /* Divergence theorem: sum of a . (b x c) over every triangle is six times
     * the enclosed signed volume. Positive means the faces are wound
     * outward-facing, which is the only thing the sign can tell us. */
    this._vol2 +=
      a[0] * (b[1] * c[2] - b[2] * c[1])
      - a[1] * (b[0] * c[2] - b[2] * c[0])
      + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }

  /** One quad, wound CCW seen from the side the normal points at. */
  quad(a, b, c, d, uvs) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    /* GATE 1. A zero normal is finite, writes valid glTF, passes every NaN
     * check, and is NaN the instant a shader calls `normalize` on it. It cost
     * `art-citadel` a gatehouse. Refused here, at the line that decides it. */
    if (!(len > 1e-9)) throw new Error(`${this.name}: degenerate quad`);
    nx /= len; ny /= len; nz /= len;
    const base = this.pos.length / 3;
    for (const p of [a, b, c, d]) {
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(nx, ny, nz);
    }
    const t = uvs ?? [[0, 0], [1, 0], [1, 1], [0, 1]];
    for (const [u, v] of t) this.uv.push(u, v);
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    this._face(a, b, c);
    this._face(a, c, d);
    return this;
  }

  /** One triangle, same winding rule. */
  tri(a, b, c, uvs) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 1e-9)) throw new Error(`${this.name}: degenerate triangle`);
    nx /= len; ny /= len; nz /= len;
    const base = this.pos.length / 3;
    for (const p of [a, b, c]) {
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(nx, ny, nz);
    }
    const t = uvs ?? [[0, 0], [1, 0], [0, 1]];
    for (const [u, v] of t) this.uv.push(u, v);
    this.idx.push(base, base + 1, base + 2);
    this._face(a, b, c);
    return this;
  }

  /**
   * A closed axis-aligned box, from its centre and half-extents.
   *
   * `uvScale` is metres per UV unit. Everything in the spectator uses
   * `ENAMEL_TILE`; the marshal's UVs are overwritten by `Batch.add` and are
   * written at the same scale only so the file reads sanely in a viewer.
   */
  box(cx, cy, cz, hx, hy, hz, uvScale = ENAMEL_TILE) {
    const P = (sx, sy, sz) => [cx + sx * hx, cy + sy * hy, cz + sz * hz];
    const uvOf = (a, b) => [[0, 0], [2 * a / uvScale, 0], [2 * a / uvScale, 2 * b / uvScale], [0, 2 * b / uvScale]];
    this.quad(P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1), uvOf(hx, hy));    // +Z
    this.quad(P(1, -1, -1), P(-1, -1, -1), P(-1, 1, -1), P(1, 1, -1), uvOf(hx, hy)); // -Z
    this.quad(P(1, -1, 1), P(1, -1, -1), P(1, 1, -1), P(1, 1, 1), uvOf(hz, hy));    // +X
    this.quad(P(-1, -1, -1), P(-1, -1, 1), P(-1, 1, 1), P(-1, 1, -1), uvOf(hz, hy)); // -X
    this.quad(P(-1, 1, 1), P(1, 1, 1), P(1, 1, -1), P(-1, 1, -1), uvOf(hx, hz));    // +Y
    this.quad(P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1), uvOf(hx, hz)); // -Y
    return this;
  }

  /**
   * A closed lofted prism: `sides` faces round, one band per pair of stations,
   * capped top and bottom.
   *
   * Every organic mass in the spectator is one of these. `sections` is
   * `[{ y, rx, rz, dz }]` - a half-width in x, a half-depth in z, and an
   * optional forward offset so a shape can lean.
   *
   * `phase` rotates the ring. Six sides with `phase = 0` puts a FLAT face at
   * +Z and -Z, which is what a chest and a back are; the default is therefore
   * not the same as an arbitrary rotation, and moving it changes the
   * silhouette rather than only the shading.
   */
  prism(sections, sides, { phase = 0, uvScale = ENAMEL_TILE, capTop = true, capBottom = true, xOff = 0 } = {}) {
    const ring = (s) => {
      const out = [];
      for (let k = 0; k < sides; k++) {
        const a = phase + (k / sides) * Math.PI * 2;
        out.push([xOff + (s.dx ?? 0) + Math.cos(a) * s.rx, s.y, (s.dz ?? 0) + Math.sin(a) * s.rz]);
      }
      return out;
    };
    const rings = sections.map(ring);
    for (let i = 0; i < rings.length - 1; i++) {
      const lo = rings[i];
      const hi = rings[i + 1];
      const dy = sections[i + 1].y - sections[i].y;
      for (let k = 0; k < sides; k++) {
        const k2 = (k + 1) % sides;
        const w = Math.hypot(lo[k2][0] - lo[k][0], lo[k2][2] - lo[k][2]);
        const u0 = (k / sides) * (w * sides) / uvScale;
        const u1 = ((k + 1) / sides) * (w * sides) / uvScale;
        const v0 = sections[i].y / uvScale;
        const v1 = (sections[i].y + Math.abs(dy)) / uvScale;
        /* `lo[k] -> hi[k] -> hi[k2] -> lo[k2]`, and the order is not free: the
         * ring runs from +X towards +Z as the angle increases, so winding the
         * band the other way round puts every side face inside out. The
         * signed-volume gate catches it, which is the whole reason that gate
         * is here rather than a comment claiming the winding is right. */
        this.quad(lo[k], hi[k], hi[k2], lo[k2], [[u0, v0], [u0, v1], [u1, v1], [u1, v0]]);
      }
    }
    const cap = (r, up) => {
      const c = [
        r.reduce((s, p) => s + p[0], 0) / sides,
        r[0][1],
        r.reduce((s, p) => s + p[2], 0) / sides,
      ];
      for (let k = 0; k < sides; k++) {
        const k2 = (k + 1) % sides;
        const uv = [[0.5, 0.5], [0, 0], [1, 0]];
        if (up) this.tri(c, r[k2], r[k], uv);
        else this.tri(c, r[k], r[k2], uv);
      }
    };
    if (capBottom) cap(rings[0], false);
    if (capTop) cap(rings[rings.length - 1], true);
    return this;
  }

  get tris() { return this.idx.length / 3; }

  /**
   * GATE 2 and GATE 3, run once per part when the geometry is taken.
   *
   * Both are cheap and both catch a class of mistake a screenshot review does
   * not: a hole in a solid is invisible from most angles, and a solid wound
   * inside out is invisible from ALL of them, which is worse.
   */
  check() {
    let open = 0;
    for (const [key, n] of this._edges) {
      if (n !== 1) throw new Error(`${this.name}: edge ${key} used ${n} times in the same direction`);
      const [a, b] = key.split('|');
      if ((this._edges.get(`${b}|${a}`) ?? 0) !== 1) open++;
    }
    if (open) throw new Error(`${this.name}: ${open} unmatched directed edge(s) - not a closed manifold`);
    if (!(this._vol2 > 0)) {
      throw new Error(`${this.name}: signed volume ${(this._vol2 / 6).toFixed(4)} is not positive - wound inside out`);
    }
    return this;
  }

  geometry() {
    this.check();
    for (const v of this.pos) {
      if (!Number.isFinite(v)) throw new Error(`${this.name}: non-finite position`);
    }
    for (const v of this.uv) {
      if (!Number.isFinite(v)) throw new Error(`${this.name}: non-finite uv`);
    }
    for (let i = 0; i < this.nor.length; i += 3) {
      const l = Math.hypot(this.nor[i], this.nor[i + 1], this.nor[i + 2]);
      if (!Number.isFinite(l) || Math.abs(l - 1) > 1e-4) {
        throw new Error(`${this.name}: normal of length ${l} at vertex ${i / 3}`);
      }
    }
    const g = new THREE.BufferGeometry();
    g.name = this.name;
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    return g;
  }
}

/* ------------------------------------------------------------------ */
/* The spectator                                                       */
/* ------------------------------------------------------------------ */

/**
 * The figure's own frame, and none of it is a free choice.
 *
 *   y = 0    the sole. `_spawnCrowd` composes the instance matrix from the
 *            placement point directly, so the origin is where the feet go.
 *   -Z       the front. `_buildFullPaddock` yaws every figure with `alongYaw`,
 *            which maps local +X onto the racing direction and local +Z onto
 *            the terrace's step-back direction - i.e. AWAY from the circuit.
 *            A spectator faces the circuit, so a spectator faces -Z.
 *   +X       the shoulder line, along the straight.
 *
 * ── The height, and the change that comes with it ────────────────────────
 *
 * 1.70 m, against the 1.22 m of the shape it replaces. The old figure was
 * placed standing ON the 0.42 m seat plank, which put its head at deck + 1.64
 * - almost exactly where a standing adult's head belongs - so the head heights
 * were right and the PEOPLE were 1.2 m tall. `_buildFullPaddock` and
 * `_buildLitePaddock` now stand them on the DECK, set back past the plank, and
 * the head lands at deck + 1.70. The plank in front then does what a bench in
 * front of a standing crowd does: it hides the shins, which is why a real
 * grandstand reads as a band of torsos.
 */
const SPEC = {
  height: 1.70,
  sole: 0.0,
  ankle: 0.10,
  knee: 0.46,
  hip: 0.90,
  waist: 1.04,
  chest: 1.24,
  shoulder: 1.42,
  neck: 1.47,
  jaw: 1.545,
  brow: 1.615,
  crown: 1.70,
  /** Half the shoulder span. 0.21 gives a 0.42 m shoulder line at scale 1. */
  shoulderHalf: 0.21,
  chestHalf: 0.175,
  waistHalf: 0.148,
  hipHalf: 0.163,
  /** Half depths. A person is about 0.6 as deep as they are wide. */
  chestDepth: 0.108,
  waistDepth: 0.092,
  hipDepth: 0.105,
  /** Arms hang just clear of the flank, so daylight shows between them. */
  armX: 0.235,
  armTop: 1.38,
  armElbow: 1.09,
  armWrist: 0.80,
  armR: 0.052,
  /** Legs. */
  legX: 0.082,
  legR: 0.062,
  shoeLen: 0.135,
  shoeHalfW: 0.052,
  /** Head. A skull is 0.145 across and 0.185 deep, which is 1/7.5 of height. */
  headHalf: 0.0755,
  headDepth: 0.093,
};

/**
 * The five parts, and the value each is drawn at.
 *
 * ── THE CONSTRAINT THIS FIGURE IS BUILT AROUND ──────────────────────────
 *
 * One `InstancedMesh`, one material, and therefore exactly ONE per-figure
 * colour: `setColorAt` writes the shirt. The vertex-colour attribute the
 * loader bakes from these shades MULTIPLIES it, which means no part of this
 * figure can have a hue the shirt does not have.
 *
 * That is the same constraint `make-crowd-glb.mjs` accepted for the station's
 * plaza crowd, and it is accepted here for the same reason: the alternative is
 * a second `InstancedMesh` per grandstand for skin, which is +3 renderables
 * and +3 draw calls on a budget whose whole instruction is that renderables do
 * not move. So the head is HAIR at 0.30 rather than skin at 1.0, and the shirt
 * palette in `RaceWorld` is desaturated to match - a dark version of your own
 * coat colour is what dark hair looks like, and it varies person to person for
 * free.
 *
 * The face is the one part above 1.0. A shade of 1.34 against a desaturated
 * shirt lands on a pale warm patch under a dark fringe, which at 6 m is a
 * face and at 40 m is the value break that says "this thing has a head".
 *
 * Stated out loud because it is a constraint that was accepted, not an
 * accident: this crowd's skin tone is a function of its shirt.
 */
export const SPECTATOR_PARTS = Object.freeze({
  torso: 0.98,
  head: 0.30,
  face: 1.34,
  legs: 0.44,
  shoes: 0.16,
});

/** @returns {Record<string, Quads>} keyed by the names in {@link SPECTATOR_PARTS}. */
export function buildSpectator() {
  const S = SPEC;
  const torso = new Quads('spectator:torso');
  const head = new Quads('spectator:head');
  const face = new Quads('spectator:face');
  const legs = new Quads('spectator:legs');
  const shoes = new Quads('spectator:shoes');

  /* ── Trunk ──────────────────────────────────────────────────────────────
   * Six sides with `phase = 0`, so a flat face lands at +X and -X and the
   * chest and back are each a pair of angled planes meeting on the centre
   * line. That is the read: a spectator lit from one side gets a bright half
   * and a dark half with a crease between them, which is a torso. A cylinder
   * gets a smooth ramp, which is a bollard.
   *
   * Four stations rather than two because the WAIST is the only value break
   * available between the shoulder and the hip, and it is what stops the
   * garment reading as a barrel. */
  torso.prism([
    { y: S.hip - 0.02, rx: S.hipHalf, rz: S.hipDepth },
    { y: S.waist, rx: S.waistHalf, rz: S.waistDepth },
    { y: S.chest, rx: S.chestHalf, rz: S.chestDepth },
    { y: S.shoulder, rx: S.shoulderHalf, rz: S.chestDepth * 0.96 },
    { y: S.neck, rx: S.shoulderHalf * 0.72, rz: S.chestDepth * 0.80 },
  ], 6);

  /* ── Arms ───────────────────────────────────────────────────────────────
   * Four-sided and slightly splayed, which is the whole point: an arm welded
   * to the flank is a bulge on a silhouette, and an arm hanging 2 cm clear
   * puts a strip of background between it and the body. At 40 m that strip is
   * the difference between a person and a post - it is the same argument the
   * station crowd's hands made at 3 m, one distance band out. */
  for (const s of [-1, 1]) {
    torso.prism([
      { y: S.armWrist, rx: S.armR * 0.82, rz: S.armR * 0.82, dz: 0.012, dx: s * 0.020 },
      { y: S.armElbow, rx: S.armR * 0.90, rz: S.armR * 0.94, dz: 0.004, dx: s * 0.010 },
      { y: S.armTop, rx: S.armR * 1.18, rz: S.armR * 1.24, dz: -0.006, dx: 0 },
    ], 4, { phase: Math.PI / 4, xOff: s * S.armX });
  }

  /* ── Legs ───────────────────────────────────────────────────────────────
   * Trousers, at shade 0.44. A grandstand seen from the circuit is a band of
   * coloured torsos over a dark base, and the dark base is legs - so this part
   * carries more of the read than its triangle count suggests. */
  for (const s of [-1, 1]) {
    legs.prism([
      { y: S.ankle, rx: S.legR * 0.78, rz: S.legR * 0.82 },
      { y: S.knee, rx: S.legR * 0.86, rz: S.legR * 0.90 },
      { y: S.hip + 0.01, rx: S.legR * 1.16, rz: S.legR * 1.10 },
    ], 4, { phase: Math.PI / 4, xOff: s * S.legX });
  }

  /* ── Shoes ──────────────────────────────────────────────────────────────
   * A toe that projects past the ankle and a heel that does not. `art-station`
   * found that asymmetry is most of what makes a leg read as ending in a foot
   * rather than in a peg, and a crowd standing on a deck is a row of feet. */
  for (const s of [-1, 1]) {
    shoes.box(s * S.legX, S.ankle * 0.5, -0.026, S.shoeHalfW, S.ankle * 0.5, S.shoeLen * 0.5);
    shoes.box(s * S.legX, S.ankle * 0.34, -0.026 - S.shoeLen * 0.5 - 0.021, S.shoeHalfW * 0.86, S.ankle * 0.34, 0.021);
  }

  /* ── Head ───────────────────────────────────────────────────────────────
   * Six-sided, four stations: the neck, the jaw, the brow and the crown. The
   * jaw is WIDER than the crown - a skull tapers upward - which is the one
   * proportion a sphere cannot have and the reason the old figure read as a
   * bowling pin.
   *
   * Drawn at shade 0.30, so this whole mass is the hair. */
  head.prism([
    { y: S.neck - 0.005, rx: S.headHalf * 0.56, rz: S.headDepth * 0.56 },
    { y: S.jaw, rx: S.headHalf * 0.94, rz: S.headDepth * 0.92 },
    { y: S.brow, rx: S.headHalf, rz: S.headDepth, dz: -0.004 },
    { y: S.crown - 0.018, rx: S.headHalf * 0.90, rz: S.headDepth * 0.88, dz: -0.006 },
    { y: S.crown, rx: S.headHalf * 0.58, rz: S.headDepth * 0.56, dz: -0.008 },
  ], 6);

  /* ── Face ───────────────────────────────────────────────────────────────
   * A closed wedge standing 1.4 cm proud of the front of the skull, not a
   * plane on it: a plane cannot be checked by the manifold or the volume gate,
   * and this file's rule is that every part is a closed solid so that all
   * three gates apply to all of it.
   *
   * It sits BELOW the brow station, so the hair above it overhangs and casts
   * the fringe line that separates them. */
  {
    const zb = -(S.headDepth * 0.90) + 0.020;   // buried in the skull
    const zf = -(S.headDepth * 0.90) - 0.014;   // 1.4 cm proud of it
    const y0 = S.jaw - 0.004;
    const y1 = S.brow - 0.012;
    const hw = S.headHalf * 0.62;
    const hw2 = hw * 0.86;
    const B0 = [-hw, y0, zb];
    const B1 = [hw, y0, zb];
    const B2 = [hw, y1, zb];
    const B3 = [-hw, y1, zb];
    const F0 = [-hw2, y0 + 0.006, zf];
    const F1 = [hw2, y0 + 0.006, zf];
    const F2 = [hw2, y1 - 0.006, zf];
    const F3 = [-hw2, y1 - 0.006, zf];
    const u = [[0, 0], [2 * hw / ENAMEL_TILE, 0], [2 * hw / ENAMEL_TILE, (y1 - y0) / ENAMEL_TILE], [0, (y1 - y0) / ENAMEL_TILE]];
    face.quad(F1, F0, F3, F2, u);      // the face itself, -Z
    face.quad(B0, B1, B2, B3, u);      // the back, against the skull, +Z
    face.quad(B1, B0, F0, F1, u);      // under the chin
    face.quad(B3, B2, F2, F3, u);      // the brow shelf
    face.quad(B1, F1, F2, B2, u);      // +X cheek
    face.quad(F0, B0, B3, F3, u);      // -X cheek
  }

  return { torso, head, face, legs, shoes };
}

/* ------------------------------------------------------------------ */
/* The marshal post                                                    */
/* ------------------------------------------------------------------ */

/**
 * The post's own frame, matched to the box it replaces so nothing moves.
 *
 *   3.2 m along X, 2.6 m along Z, 2.6 m tall, y = 0 at the ground and the
 *   origin on the footprint centre - exactly `B.box('metal.panel', 3.2, 2.6,
 *   2.6, x, y + 1.3, z, yaw)`, so the existing collider still matches what is
 *   drawn to the centimetre and no route moves.
 *
 *   -Z is the TRACK SIDE. `_buildTrackside` yaws the post with
 *   `atan2(rx, rz)`, which maps local +Z onto the road's right-hand normal;
 *   that points away from the circuit for a post at positive lateral offset
 *   and towards it for one at negative. `RaceWorld` therefore adds PI to the
 *   yaw on the inboard side, and `race-assets.test.mjs` pins that rule.
 */
const POST = { hx: 1.6, hz: 1.3, h: 2.6 };

/** @returns {Record<string, Quads>} keyed by RACE MATERIAL KEY. */
export function buildMarshal() {
  const panel = new Quads('marshal:metal.panel');
  const trim = new Quads('marshal:metal.trim');
  const stripe = new Quads('marshal:hazard.stripe');
  const { hx, hz, h } = POST;
  const T = 3;   // metal.panel is authored for 3 m per tile

  /* ── The shell ──────────────────────────────────────────────────────────
   * Still a solid block of the same 3.2 x 2.6 x 2.6, because the collider is
   * that block and art may not move a route. What changes is that the front is
   * no longer one flat quad: it is a SURROUND - sill, head and two jambs -
   * standing 0.14 m proud of a back panel, with the observation slot recessed
   * between them.
   *
   * That distinction is the whole lesson `art-citadel` paid for. Two hundred
   * souk houses painted a dark panel 16 cm INSIDE a solid box under a comment
   * calling it "what the eye reads as depth", and not one of the eight hundred
   * openings ever drew a pixel. A recess is geometry that stands proud, not a
   * colour that sits inside. */
  const slotY0 = 1.06;
  const slotY1 = 1.86;
  const slotHX = 1.14;
  const PROUD = 0.14;

  /** The core: everything except the front face, which the surround builds. */
  panel.box(0, h * 0.5, PROUD * 0.5, hx, h * 0.5, hz - PROUD * 0.5, T);

  /* The surround, four bars standing off the recessed panel. Each is closed,
   * so the manifold and volume gates cover them individually. */
  const fz = -hz + PROUD * 0.5;
  // sill
  panel.box(0, slotY0 * 0.5, fz, hx, slotY0 * 0.5, PROUD * 0.5, T);
  // head
  panel.box(0, (slotY1 + h) * 0.5, fz, hx, (h - slotY1) * 0.5, PROUD * 0.5, T);
  // jambs
  for (const s of [-1, 1]) {
    panel.box(s * (hx + slotHX) * 0.5, (slotY0 + slotY1) * 0.5, fz,
      (hx - slotHX) * 0.5, (slotY1 - slotY0) * 0.5, PROUD * 0.5, T);
  }
  /* A mullion in the middle of the slot, so the opening reads as glazing
   * rather than as a hole punched in a crate. */
  panel.box(0, (slotY0 + slotY1) * 0.5, fz - 0.03, 0.045, (slotY1 - slotY0) * 0.5, PROUD * 0.5 - 0.03, T);

  /* A working platform and a kick rail across the front, at the height a
   * marshal stands to wave a flag from. */
  panel.box(0, 0.09, -hz - 0.30, hx * 0.86, 0.09, 0.30, T);
  for (const s of [-1, 1]) {
    panel.box(s * hx * 0.80, 0.52, -hz - 0.55, 0.045, 0.52, 0.045, T);
  }

  /* ── The roof ───────────────────────────────────────────────────────────
   * 3.6 x 3.0 x 0.3 at y 2.6..2.9 - the same lid the box already carries,
   * except that until this branch it was drawn 1.30 m above the box because
   * `Batch.box` had overwritten the caller's scratch vector. It is authored
   * here so the drip edge under the overhang is a real surface rather than the
   * underside of a slab. */
  trim.box(0, h + 0.14, 0, hx + 0.2, 0.14, hz + 0.2, 1.5);
  trim.box(0, h + 0.30, 0, hx + 0.10, 0.02, hz + 0.10, 1.5);
  /* A grab rail down each flank, which is what a 2.6 m box gets climbed by. */
  for (const s of [-1, 1]) {
    trim.box(s * (hx + 0.05), 1.55, 0, 0.05, 0.035, hz * 0.72, 1.5);
  }

  /* ── The hazard band, which is the part that has never rendered ─────────
   * 0.5 m tall at y 2.05..2.55, standing 0.06 m proud on ALL FOUR faces
   * rather than 0.2 m deep at the post's own centre inside a 2.6 m solid.
   * Four bars rather than one, because a band that wraps is the thing a
   * marshal post is recognised by from a car. */
  const by = 2.30;
  const bh = 0.25;
  const PR = 0.06;
  stripe.box(0, by, -hz - PR * 0.5, hx + 0.02, bh, PR * 0.5, 2);
  stripe.box(0, by, hz + PR * 0.5, hx + 0.02, bh, PR * 0.5, 2);
  for (const s of [-1, 1]) {
    stripe.box(s * (hx + PR * 0.5), by, 0, PR * 0.5, bh, hz + 0.02, 2);
  }

  return { 'metal.panel': panel, 'metal.trim': trim, 'hazard.stripe': stripe };
}

/* ------------------------------------------------------------------ */
/* Part keys, and the contract they carry                              */
/* ------------------------------------------------------------------ */

/**
 * The marshal's mesh names, which ARE race material keys.
 *
 * `src/worlds/race/RaceAssets.js` reads the name off the mesh, discards the
 * glTF material unread, and `RaceWorld._buildTrackside` hands the geometry to
 * the `Batch` bucket of that key. A key the world has no material for is not a
 * wrong colour: `Batch.flush` would build `new THREE.Mesh(merged, undefined)`,
 * which three fills in with a default white `MeshBasicMaterial` - a new draw
 * call, a new material and a new shader program, silently, on the one thing
 * this design exists to prevent. The loader refuses one, the world re-checks
 * against its own live material set, and the test reads that set off a real
 * built `RaceWorld` rather than off a copy of it.
 */
export const MARSHAL_PART_KEYS = Object.freeze(['metal.panel', 'metal.trim', 'hazard.stripe']);

/** Everything this generator writes, in file order. */
export const RACE_ASSETS = Object.freeze([
  { id: 'spectator', file: 'spectator.glb', parts: Object.keys(SPECTATOR_PARTS), build: buildSpectator },
  { id: 'marshal', file: 'marshal.glb', parts: MARSHAL_PART_KEYS, build: buildMarshal },
]);

/* ------------------------------------------------------------------ */
/* Minimal binary glTF 2.0 writer                                      */
/* ------------------------------------------------------------------ */
/* Lifted from `scripts/make-yard-glb.mjs`, which took it from
 * `make-beast-glb.mjs`, which took it from `make-npc-glb.mjs`. Kept verbatim
 * rather than factored into a shared module, for the reason those files give:
 * a generator that stands alone can be read end to end, and the byte-diff
 * tests pin every one of them against its committed output, so a divergence
 * cannot ship silently. */

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

export function writeGlb(setName, order, parts) {
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
  const report = [];

  for (const key of order) {
    const q = parts[key];
    if (!q || !q.tris) throw new Error(`${setName}: part '${key}' is empty`);
    const geo = q.geometry();
    const vCount = geo.attributes.position.count;
    const iArr = geo.index.array;
    verts += vCount;
    tris += iArr.length / 3;
    report.push({ key, verts: vCount, tris: iArr.length / 3 });

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
      itemSize: 1, componentType: wide ? UNSIGNED_INT : UNSIGNED_SHORT, type: 'SCALAR',
      target: ELEMENT_ARRAY_BUFFER,
    });

    const shade = SPECTATOR_PARTS[key];
    materials.push({
      name: `${setName}-${key}-placeholder`,
      pbrMetallicRoughness: {
        baseColorFactor: shade !== undefined
          ? [0.62 * shade, 0.55 * shade, 0.50 * shade, 1]
          : key === 'hazard.stripe' ? [0.88, 0.78, 0.24, 1]
            : key === 'metal.trim' ? [0.62, 0.66, 0.70, 1] : [0.82, 0.80, 0.74, 1],
        metallicFactor: shade !== undefined ? 0.0 : 0.35,
        roughnessFactor: shade !== undefined ? 0.85 : 0.65,
      },
    });
    meshes.push({
      /* THE MESH NAME IS THE CONTRACT. For the marshal it is a race MATERIAL
       * key; for the spectator it is a part name whose vertex-colour shade the
       * manifest carries. `race/RaceAssets.js` reads it and discards the glTF
       * material beside it unread. See the header. */
      name: key,
      primitives: [{
        attributes: { POSITION: posAcc, NORMAL: norAcc, TEXCOORD_0: uvAcc },
        indices: idxAcc, mode: 4, material: materials.length - 1,
      }],
    });
    nodes.push({ mesh: meshes.length - 1, name: key });
    geo.dispose();
  }

  const json = {
    asset: {
      version: '2.0',
      generator: 'aether-nexus scripts/make-race-glb.mjs',
      copyright: 'generated - procedurally authored in this repository, no external source',
    },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    /* Placeholders so the file stands alone in a viewer. The game DISCARDS
     * every one of these - see RaceAssets.js. */
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

  return { glb: Buffer.concat([header, jsonHeader, jsonBytes, binHeader, binBytes]), tris, verts, report };
}

/* ------------------------------------------------------------------ */

/* Guarded so the module can be imported by the test without writing files.
 * The `argv` comparison is the portable half of `import.meta.main`. */
const isMain = path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const only = process.env.RACE_GLB_ASSET;
  const outOverride = process.env.RACE_GLB_OUT;
  if (outOverride && !only) {
    throw new Error('RACE_GLB_OUT needs RACE_GLB_ASSET - it names one file, not all of them');
  }
  for (const a of RACE_ASSETS) {
    if (only && only !== a.id) continue;
    const { glb, tris, verts, report } = writeGlb(a.id, a.parts, a.build());
    if (tris > TRI_BUDGET[a.id]) {
      throw new Error(`${a.id} is ${tris} tris - over the ${TRI_BUDGET[a.id]} reservation`);
    }
    const out = outOverride
      ? path.resolve(outOverride)
      : path.join(root, 'public/assets/race', a.file);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, glb);
    console.log(out);
    for (const p of report) {
      console.log(`  ${p.key.padEnd(14)} ${String(p.verts).padStart(5)} verts  ${String(p.tris).padStart(5)} tris`);
    }
    console.log(`  ${'TOTAL'.padEnd(14)} ${String(verts).padStart(5)} verts  ${String(tris).padStart(5)} tris  ${glb.length} bytes`);
  }
}
