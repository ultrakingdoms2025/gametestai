/**
 * Authored hero geometry for Lodestar Yard's hull sections.
 *
 *   node scripts/make-yard-glb.mjs                    # writes all three
 *   YARD_GLB_SECTION=sec-b2 YARD_GLB_OUT=/tmp/x.glb node scripts/make-yard-glb.mjs
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THESE THREE OBJECTS AND NOT SOMETHING ELSE IN THIS WORLD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 9 / decision D4: authored `.glb` hero assets through the pipeline
 * already proven four times (`make-newel-glb.mjs`, `make-ship-glb.mjs`,
 * `make-npc-glb.mjs`, `make-beast-glb.mjs`), procedural systems for bulk
 * content. The dock's four HULLS went through that pipeline in an earlier
 * drop, so the question this branch had to answer is what is left.
 *
 * The screenshots answered it. `DockWorld`'s own header states what this place
 * is — *"Lodestar Yard does not BUILD ships, it re-assembles them. Nothing
 * bigger than a gateway arch has ever come through a gateway, so every hull
 * here arrived in sections narrow enough to walk through a portal and was
 * pinned back together on a cradle."* Those sections are `SECTIONS` in
 * `dock/YardPlan.js` and they are the three largest props in the yard: 6.2 to
 * 8.8 m across and 11 to 16 m long, on jigs in the middle of the floor, in
 * shot from `chandlery`, `datum`, `yard-wide`, `crane-cab` and `keel-line`.
 *
 * Photographed, the biggest of them measured **mean luma 39.1 at saturation
 * 0.193, 85% of its pixels under 48/255** — a flat dark mass with a 1.4:1
 * range across a 9 m diameter. It is drawn as
 *
 *     new THREE.CylinderGeometry(r, r, len, 16, 1, true)
 *
 * plus a `TorusGeometry` at each frame line: a sixteen-sided smooth tube with
 * doughnuts on it, open at both ends so the far wall is culled and you look
 * clean through the thing this world is named for.
 *
 * ── What authoring buys, stated honestly ─────────────────────────────────
 *
 * NOT a different topology. A hull section IS a drum, and unlike the Kestrel —
 * whose problem was that a box kit cannot make a hull at all — the primitive
 * here is the right primitive. What a runtime primitive kit cannot express is
 * the detail that makes a drum read as *plating pinned to frames*:
 *
 *   - **Lapped strakes.** Twenty-four plates round the girth, alternate ones
 *     standing 40 mm proud, so every strake has two EDGES down its length.
 *     Edges are what a raking sodium lamp has to catch; a smooth tube has
 *     exactly two lit bands and nothing between them, which is the 1.4:1 range
 *     above. A `CylinderGeometry` cannot have an interior edge: its radius is
 *     one number.
 *   - **Flanged ring frames instead of doughnuts.** A torus is round in
 *     section; a ship frame is a flat bar with a web and two corners. The
 *     corners are the read.
 *   - **An interior.** The -Z end closes on a bulkhead (which is what the next
 *     section pins to) and the +Z end is cut open on eight stringers, a heavy
 *     collar frame and a lining you can see. Today both ends are open and
 *     backface culling makes the section a shell you see through.
 *   - **A bolted string course at every frame line**, which the world's own
 *     comment has claimed since drop one and which nothing has ever drawn.
 *   - **A cut edge that is cut.** The open rim is scalloped by a seeded jitter
 *     — a section separated with a cutting frame does not come apart on a
 *     perfect circle.
 *
 * ── The cost rule, which is the whole design ─────────────────────────────
 *
 * **Every mesh in these files is NAMED FOR A YARD MATERIAL KEY**, and
 * `dock/YardAssets.js` reads that name and hands the geometry to
 * `DockWorld._put`, which drops it in the `GeoBatch` bucket of that key. The
 * glTF material beside it is discarded unread. So an authored section merges
 * into meshes the yard already draws:
 *
 *   no new draw call, no new material, no new shader program.
 *
 * That last one is why the rule is a rule. Three keys its program cache on
 * material configuration, this project boots by warming the cartesian product
 * of those programs, and the roadmap names Phase 9 as the phase most likely to
 * regress production frame time. The cost of everything in this file is
 * triangles, and `TRI_BUDGET` below is where that is capped.
 *
 * ── Where the numbers come from ──────────────────────────────────────────
 *
 * `SECTIONS` is IMPORTED from `dock/YardPlan.js` rather than copied. The ship
 * generator duplicates `HullPlan`'s constants deliberately (it predates the
 * import-the-plan pattern and asserts the copy in its test); `make-beast-glb`
 * derives from `BeastBody.PROFILES` instead, and this follows the newer one.
 * The consequence is worth stating: change a section's radius in the plan and
 * the committed `.glb` goes stale, and `yard-assets.test.mjs`'s byte-diff goes
 * red telling you to re-run this script. That is the intended failure.
 */

import * as THREE from 'three';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SECTIONS } from '../src/worlds/dock/YardPlan.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ */
/* The frame                                                           */
/* ------------------------------------------------------------------ */

/**
 * Local axes, and they are not free choices — `DockWorld._buildSections`
 * places what comes out of here with `put(key, geo, s.x, cy, s.z, s.yaw)`,
 * which is a translate and a Y rotation and nothing else.
 *
 *   +Z   along the section's own length. The CUT END. `s.yaw` rotates about
 *        Y, so the plan's yaw means the same thing it meant when the drum was
 *        a `CylinderGeometry(...).rotateX(PI/2)`.
 *   -Z   the JOINED end, closed by a transverse bulkhead.
 *   +Y   up. `t = 0` is top dead centre, `t = PI` is the keel — which is where
 *        the skid pads go, because that is the arc sitting in the jig's
 *        saddles.
 *   +X   starboard. The access hatch is on this flank at mid-length.
 *
 * The origin is the drum's axis centre, so the caller's `cy = 1.9 + s.r` is
 * unchanged from the procedural build and the section does not move when this
 * lands.
 */
const pt = (t, rad, z) => [Math.sin(t) * rad, Math.cos(t) * rad, z];

/** Strakes round the girth. 24 gives 0.81-1.15 m plates, which is plating. */
const STRAKES = 24;
/** How far a proud strake stands off its neighbours. */
const LAP = 0.04;
/** Ring-frame bar: how far it stands off the skin, and how wide along Z. */
const FRAME_PROUD = 0.17;
const FRAME_W = 0.30;
/**
 * Bolts per frame line, and why there are only eight of them.
 *
 * A 0.11 m bolt head subtends one pixel at 75 m and about four at the 20 m
 * between the apron arrival point and the nearest jig, so they DO read — the
 * player walks past these. But drawn as full boxes at twelve a ring they came
 * to 864 triangles against 288 for the entire skin, which is the wrong half of
 * the object carrying three quarters of the cost. Eight a ring, each a capped
 * stud with no underside, is 400.
 */
const BOLTS = 8;
/** Segments in anything drawn as a ring rather than as plating. */
const RING_SEG = 16;
/** Longitudinal stringers inside, seen through the cut end. */
const STRINGERS = 8;

/** Texel density, matching `StationKit.boxGeo`'s default: 1 uv unit per 2 m. */
const TILE = 2;

/**
 * Deterministic jitter for the cut rim.
 *
 * Seeded off the section id so the three sections tear differently and any one
 * of them tears the same way every run — the byte-diff test is the reason the
 * second half of that sentence is not optional.
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

/* ------------------------------------------------------------------ */
/* A quad mesher                                                       */
/* ------------------------------------------------------------------ */

/**
 * Flat-shaded quads and nothing else.
 *
 * Flat is not a shortcut here, it is the subject. Every surface in this file
 * is either a plate or a bar, and a plate that shades as a curve has no edge —
 * which is precisely the defect being fixed. `make-ship-glb.mjs` averages
 * normals within a patch and splits at named creases because a hull's flank is
 * a developed surface; a hull SECTION on a jig is twenty-four flat plates, and
 * every vertex here therefore belongs to exactly one face.
 */
class Quads {
  constructor(name) {
    this.name = name;
    this.pos = [];
    this.nor = [];
    this.uv = [];
    this.idx = [];
  }

  /**
   * One quad, wound CCW seen from the side the normal points at.
   *
   * `expect` is the reason this file has a `facing` argument at all. Backface
   * culling makes an inside-out quad INVISIBLE rather than wrong-looking, and
   * a surface that is simply absent from a 1600x900 shot of a 9 m drum at 20 m
   * is not something a screenshot review reliably catches: the first build of
   * these sections shipped the cut-end collar and every one of the
   * twenty-four plate laps wound backwards, and the picture just looked a bit
   * flat. Passing the direction the face is supposed to be seen from turns
   * that into a build error, at the line where the winding is decided.
   *
   * @param {[number,number,number]} [expect] a direction the normal must have a
   *   positive dot product with - i.e. roughly where the viewer stands
   */
  quad(a, b, c, d, uvs, expect) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    /* A degenerate quad has no normal, and a zero normal is a black facet that
     * survives every numeric check in this file. Refused where it is written
     * rather than discovered in a screenshot. */
    if (!(len > 1e-9)) throw new Error(`${this.name}: degenerate quad`);
    nx /= len; ny /= len; nz /= len;
    if (expect) {
      const dot = nx * expect[0] + ny * expect[1] + nz * expect[2];
      if (!(dot > 1e-6)) {
        throw new Error(
          `${this.name}: quad is wound inside out - normal (${nx.toFixed(2)}, ${ny.toFixed(2)}, `
          + `${nz.toFixed(2)}) faces away from (${expect.map((v) => v.toFixed(2)).join(', ')})`
        );
      }
    }
    const base = this.pos.length / 3;
    for (const p of [a, b, c, d]) {
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(nx, ny, nz);
    }
    const t = uvs ?? [[0, 0], [1, 0], [1, 1], [0, 1]];
    for (const [u, v] of t) this.uv.push(u, v);
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
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
    return this;
  }

  /**
   * A box given as a centre, half-extents and an optional yaw about Z, in the
   * section's own frame. Used for bolts, skids and coaming bars — everything
   * that is a bar rather than a plate.
   */
  bar(cx, cy, cz, hx, hy, hz, roll = 0) {
    const c = Math.cos(roll), s = Math.sin(roll);
    const P = (sx, sy, sz) => {
      const lx = sx * hx, ly = sy * hy;
      return [cx + lx * c - ly * s, cy + lx * s + ly * c, cz + sz * hz];
    };
    const uvXY = [[0, 0], [2 * hx / TILE, 0], [2 * hx / TILE, 2 * hy / TILE], [0, 2 * hy / TILE]];
    const uvZY = [[0, 0], [2 * hz / TILE, 0], [2 * hz / TILE, 2 * hy / TILE], [0, 2 * hy / TILE]];
    const uvXZ = [[0, 0], [2 * hx / TILE, 0], [2 * hx / TILE, 2 * hz / TILE], [0, 2 * hz / TILE]];
    this.quad(P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1), uvXY);      // +Z
    this.quad(P(1, -1, -1), P(-1, -1, -1), P(-1, 1, -1), P(1, 1, -1), uvXY);  // -Z
    this.quad(P(1, -1, 1), P(1, -1, -1), P(1, 1, -1), P(1, 1, 1), uvZY);      // +X
    this.quad(P(-1, -1, -1), P(-1, -1, 1), P(-1, 1, 1), P(-1, 1, -1), uvZY);  // -X
    this.quad(P(-1, 1, 1), P(1, 1, 1), P(1, 1, -1), P(-1, 1, -1), uvXZ);      // +Y
    this.quad(P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1), uvXZ);  // -Y
    return this;
  }

  /**
   * A stud standing off a curved surface: a cap and four sides, no underside.
   *
   * The underside is against the plate it is bolted to and cannot be seen from
   * anywhere. Five quads rather than six is not a rounding — there are sixty of
   * these on the biggest section and the face nobody can see was a sixth of
   * every one of them.
   */
  stud(cx, cy, cz, half, rise, roll) {
    const c = Math.cos(roll), s = Math.sin(roll);
    /* `roll` turns the stud so its own +X lies along the surface normal; the
     * cap is therefore the +X face and the "underside" the -X one. */
    const P = (sx, sy, sz) => {
      const lx = sx === 1 ? rise : 0, ly = sy * half;
      return [cx + lx * c - ly * s, cy + lx * s + ly * c, cz + sz * half];
    };
    const u = [[0, 0], [2 * half / TILE, 0], [2 * half / TILE, 2 * half / TILE], [0, 2 * half / TILE]];
    this.quad(P(1, -1, 1), P(1, -1, -1), P(1, 1, -1), P(1, 1, 1), u);   // cap
    this.quad(P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1), u);
    this.quad(P(1, -1, -1), P(-1, -1, -1), P(-1, 1, -1), P(1, 1, -1), u);
    this.quad(P(-1, 1, 1), P(1, 1, 1), P(1, 1, -1), P(-1, 1, -1), u);
    this.quad(P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1), u);
    return this;
  }

  get tris() { return this.idx.length / 3; }

  geometry() {
    for (const v of this.pos) {
      /* The NaN gate `make-ship-glb.mjs` paid for: 148 bad texture coordinates
       * once rendered as a white screen with a ship-shaped hole in it, because
       * `UnrealBloomPass` smears one bad texel over the whole frame. A .glb is
       * data and nothing downstream re-checks it. */
      if (!Number.isFinite(v)) throw new Error(`${this.name}: non-finite position`);
    }
    for (const v of this.uv) {
      if (!Number.isFinite(v)) throw new Error(`${this.name}: non-finite uv`);
    }
    for (const v of this.nor) {
      if (!Number.isFinite(v)) throw new Error(`${this.name}: non-finite normal`);
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
/* The section                                                         */
/* ------------------------------------------------------------------ */

/**
 * Build one section's four part meshes.
 *
 * @param {{id:string, r:number, len:number, frames:number}} s a `SECTIONS` row
 * @returns {Record<string, Quads>} keyed by YARD MATERIAL KEY - see the header
 */
export function buildSection(s) {
  const { r, len, frames } = s;
  const z0 = -len / 2, z1 = len / 2;
  const rnd = seededRandom(s.id);

  const plate = new Quads(`${s.id}:plate`);
  const steel = new Quads(`${s.id}:steel`);
  const dark = new Quads(`${s.id}:steelDark`);
  const hazard = new Quads(`${s.id}:hazard`);

  /** Frame-line z positions: `frames` bays means `frames + 1` lines. */
  const lineZ = [];
  for (let i = 0; i <= frames; i++) lineZ.push(z0 + (len * i) / frames);

  /** Radius of strake `i` — alternate plates stand proud, so every seam is an edge. */
  const strakeR = (i) => r + ((i % 2) ? LAP : 0);
  const theta = (i) => (i / STRAKES) * Math.PI * 2;
  /** Outward radial at angle t - where a viewer of the skin stands. */
  const out = (t) => [Math.sin(t), Math.cos(t), 0];
  /** Tangential at angle t, in the direction of increasing t. */
  const tan = (t) => [Math.cos(t), -Math.sin(t), 0];
  const neg = (v) => [-v[0], -v[1], -v[2]];
  const AFT = [0, 0, -1];    // out of the joined end
  const FWD = [0, 0, 1];     // out of the cut end

  /**
   * THE CUT RIM.
   *
   * A section is separated from its neighbour with a cutting frame, not
   * unwrapped from a mould, so its open end is not a circle. Each strake's
   * forward edge is pulled back by 0 to 0.34 m. Seeded off the id, so it is
   * the same tear every run and a different one on each section.
   */
  const rimZ = [];
  for (let i = 0; i < STRAKES; i++) rimZ.push(z1 - 0.02 - rnd() * 0.34);

  /* ── The skin: lapped strakes, bay by bay ─────────────────────────────── */
  for (let i = 0; i < STRAKES; i++) {
    const t0 = theta(i), t1 = theta(i + 1);
    const rad = strakeR(i);
    const arc = rad * (t1 - t0);
    for (let b = 0; b < frames; b++) {
      const a = lineZ[b];
      /* The last bay stops at this strake's own cut edge rather than at the
       * frame line, which is what makes the rim a tear rather than a fringe
       * hanging off a straight end. */
      const c = b === frames - 1 ? rimZ[i] : lineZ[b + 1];
      if (c - a < 0.02) continue;
      plate.quad(
        pt(t0, rad, a), pt(t0, rad, c), pt(t1, rad, c), pt(t1, rad, a),
        [[0, a / TILE], [0, c / TILE], [arc / TILE, c / TILE], [arc / TILE, a / TILE]],
        out((t0 + t1) / 2)
      );
    }
    /* ── The lap ──────────────────────────────────────────────────────────
     * The riser between this strake and the next one round, drawn on the proud
     * strake's two edges only so there is one riser per seam rather than two
     * coincident ones.
     *
     * EACH RISER FACES THE LOWER NEIGHBOUR. The seam at `t1` has the proud
     * plate below it in t and the flush plate above, so its wall is seen from
     * +t; the seam at `t0` is the mirror of that and is seen from -t. Both of
     * these were re-derived by hand during this pass, "corrected", and turned
     * out to have been right the first time - which is the second argument for
     * `expect`: a facing you can state is a facing a machine can check, and
     * three lines of cross product done in a comment is not. */
    if (i % 2) {
      const inner = r;
      const zEnd = Math.min(rimZ[i], rimZ[(i + 1) % STRAKES]);
      plate.quad(
        pt(t1, rad, z0), pt(t1, rad, zEnd), pt(t1, inner, zEnd), pt(t1, inner, z0),
        [[0, z0 / TILE], [0, zEnd / TILE], [LAP / TILE, zEnd / TILE], [LAP / TILE, z0 / TILE]],
        tan(t1)
      );
      const zEnd0 = Math.min(rimZ[i], rimZ[(i - 1 + STRAKES) % STRAKES]);
      plate.quad(
        pt(t0, inner, z0), pt(t0, inner, zEnd0), pt(t0, rad, zEnd0), pt(t0, rad, z0),
        [[0, z0 / TILE], [0, zEnd0 / TILE], [LAP / TILE, zEnd0 / TILE], [LAP / TILE, z0 / TILE]],
        neg(tan(t0))
      );
    }
    /* The torn edge itself, seen end-on: the plate's thickness at the rim. */
    const inner = rad - 0.05;
    dark.quad(
      pt(t0, rad, rimZ[i]), pt(t0, inner, rimZ[i]), pt(t1, inner, rimZ[i]), pt(t1, rad, rimZ[i]),
      [[0, 0], [0.05 / TILE, 0], [0.05 / TILE, arc / TILE], [0, arc / TILE]],
      FWD
    );
  }

  /* ── The lining, so the section is not a shell you see through ────────── */
  const liningR = r - 0.09;
  for (let i = 0; i < STRAKES; i++) {
    const t0 = theta(i), t1 = theta(i + 1);
    const arc = liningR * (t1 - t0);
    const zEnd = Math.min(rimZ[i], rimZ[(i + 1) % STRAKES]);
    // Wound the other way round: this face is seen from INSIDE the drum.
    dark.quad(
      pt(t1, liningR, z0), pt(t1, liningR, zEnd), pt(t0, liningR, zEnd), pt(t0, liningR, z0),
      [[0, z0 / TILE], [0, zEnd / TILE], [arc / TILE, zEnd / TILE], [arc / TILE, z0 / TILE]],
      neg(out((t0 + t1) / 2))
    );
  }

  /* ── The joined end: a transverse bulkhead ────────────────────────────── */
  for (let i = 0; i < RING_SEG; i++) {
    const t0 = (i / RING_SEG) * Math.PI * 2;
    const t1 = ((i + 1) / RING_SEG) * Math.PI * 2;
    /* Two faces 60 mm apart, and WHICH ONE IS IN FRONT is checked rather than
     * assumed - see the winding note at the collar below. The outward face is
     * the plate the next section pins against and stands at z0; the inboard
     * one is what you see looking down the drum from the cut end. */
    steel.quad(
      pt(t0, r, z0), pt(t1, r, z0), [0, 0, z0], [0, 0, z0],
      [[0, 0], [r / TILE, 0], [r / TILE, r / TILE], [0, r / TILE]],
      AFT
    );
    steel.quad(
      pt(t1, liningR, z0 + 0.06), pt(t0, liningR, z0 + 0.06),
      [0, 0, z0 + 0.06], [0, 0, z0 + 0.06],
      [[0, 0], [r / TILE, 0], [r / TILE, r / TILE], [0, r / TILE]],
      FWD
    );
  }

  /* ── Ring frames: flat bar with a web and two corners ─────────────────── */
  for (const z of lineZ) {
    if (z > z1 - 0.05) continue;   // the cut end carries a collar instead
    for (let i = 0; i < RING_SEG; i++) {
      const t0 = (i / RING_SEG) * Math.PI * 2;
      const t1 = ((i + 1) / RING_SEG) * Math.PI * 2;
      const inner = r + LAP;
      const outer = r + LAP + FRAME_PROUD;
      const arc = outer * (t1 - t0);
      const za = z - FRAME_W / 2, zb = z + FRAME_W / 2;
      const uOut = [[0, 0], [arc / TILE, 0], [arc / TILE, FRAME_W / TILE], [0, FRAME_W / TILE]];
      const uSide = [[0, 0], [arc / TILE, 0], [arc / TILE, FRAME_PROUD / TILE], [0, FRAME_PROUD / TILE]];
      const o = out((t0 + t1) / 2);
      steel.quad(pt(t0, outer, za), pt(t0, outer, zb), pt(t1, outer, zb), pt(t1, outer, za), uOut, o);
      steel.quad(pt(t0, inner, za), pt(t0, outer, za), pt(t1, outer, za), pt(t1, inner, za), uSide, AFT);
      steel.quad(pt(t1, inner, zb), pt(t1, outer, zb), pt(t0, outer, zb), pt(t0, inner, zb), uSide, FWD);
    }
    /* The bolted string course the world's own comment has always claimed. */
    for (let i = 0; i < BOLTS; i++) {
      const t = (i / BOLTS) * Math.PI * 2 + Math.PI / BOLTS;
      const rad = r + LAP + FRAME_PROUD;
      const p = pt(t, rad, z);
      /* `-t` rather than `PI/2 - t`: `pt` puts t = 0 at +Y, so the outward
       * normal at angle t is (sin t, cos t) and rolling the stud's +X onto it
       * is a rotation of -t about Z. Getting this wrong lays every bolt flat
       * against the frame, which looks like a shadow rather than an error. */
      dark.stud(p[0], p[1], p[2], 0.055, 0.055, Math.PI / 2 - t);
    }
  }

  /* ── The cut end: a collar frame, stringers, and a hazard band ────────── */
  const rimMin = Math.min(...rimZ);
  const collarZ = rimMin - 0.30;
  for (let i = 0; i < RING_SEG; i++) {
    const t0 = (i / RING_SEG) * Math.PI * 2;
    const t1 = ((i + 1) / RING_SEG) * Math.PI * 2;
    const inner = r - 0.62;
    const arc = r * (t1 - t0);
    const uRad = [[0, 0], [arc / TILE, 0], [arc / TILE, 0.62 / TILE], [0, 0.62 / TILE]];
    /* The collar's face, seen by somebody standing off the cut end and looking
     * in. This is the single quad that most needed `expect`: wound the other
     * way it is culled from exactly the one viewpoint the collar exists for,
     * and the section reads as an empty pipe. */
    steel.quad(
      pt(t0, inner, collarZ), pt(t1, inner, collarZ),
      pt(t1, liningR, collarZ), pt(t0, liningR, collarZ), uRad, FWD
    );
    // ...and its bore, so the collar has depth rather than being a decal. Seen
    // from the axis outwards, which is where the eye is when it looks in.
    steel.quad(
      pt(t0, inner, collarZ), pt(t0, inner, collarZ - 0.22),
      pt(t1, inner, collarZ - 0.22), pt(t1, inner, collarZ), uRad,
      neg(out((t0 + t1) / 2))
    );
  }
  for (let i = 0; i < STRINGERS; i++) {
    const t = (i / STRINGERS) * Math.PI * 2 + Math.PI / STRINGERS;
    const rad = liningR - 0.11;
    const zc = (z0 + collarZ) / 2;
    const hz = (collarZ - z0) / 2 - 0.08;
    if (hz <= 0.05) continue;
    const p = pt(t, rad, zc);
    steel.bar(p[0], p[1], p[2], 0.07, 0.11, hz, -t);
  }
  /* A chevron band inboard of the tear. `hazard` is the yard's own diagonal
   * stripe tile, so this costs the bucket a ring of quads and nothing else. */
  for (let i = 0; i < STRAKES; i++) {
    const t0 = theta(i), t1 = theta(i + 1);
    const rad = r + LAP + 0.055;
    const arc = rad * (t1 - t0);
    const a = collarZ - 0.44, b = collarZ - 0.10;
    hazard.quad(
      pt(t0, rad, a), pt(t0, rad, b), pt(t1, rad, b), pt(t1, rad, a),
      [[0, 0], [0, 0.34 / TILE], [arc / TILE, 0.34 / TILE], [arc / TILE, 0]],
      out((t0 + t1) / 2)
    );
  }

  /* ── The access hatch, starboard flank, mid-length ────────────────────── */
  {
    const tc = Math.PI / 2;                       // +X
    const halfArc = 0.62 / r;                     // 1.24 m of girth
    const zc = (z0 + z1) / 2;
    const hz = 0.85;
    const rad = r + LAP + 0.02;
    // Coaming: four bars round the opening, each rolled to sit on the girth.
    for (const sg of [-1, 1]) {
      const t = tc + sg * halfArc;
      const p = pt(t, rad + 0.05, zc);
      dark.bar(p[0], p[1], p[2], 0.07, 0.07, hz + 0.14, -t);
    }
    for (const sg of [-1, 1]) {
      const p = pt(tc, rad + 0.05, zc + sg * (hz + 0.07));
      dark.bar(p[0], p[1], p[2], halfArc * r + 0.14, 0.07, 0.07, -tc);
    }
    // The leaf, set 60 mm into the coaming so the opening has depth.
    const leafR = rad - 0.02;
    const arc = leafR * halfArc * 2;
    dark.quad(
      pt(tc - halfArc, leafR, zc - hz), pt(tc - halfArc, leafR, zc + hz),
      pt(tc + halfArc, leafR, zc + hz), pt(tc + halfArc, leafR, zc - hz),
      [[0, 0], [0, 2 * hz / TILE], [arc / TILE, 2 * hz / TILE], [arc / TILE, 0]],
      out(tc)
    );
    // Two dogs on the leaf, because a pressure hatch has them and they are the
    // only thing on this flank that is not a rectangle.
    for (const sg of [-1, 1]) {
      const p = pt(tc, leafR + 0.06, zc + sg * 0.34);
      steel.bar(p[0], p[1], p[2], 0.22, 0.05, 0.05, -tc);
    }
  }

  /* ── Skid pads at the keel, where the jig's saddles take the weight ───── */
  for (const f of [0.28, 0.72]) {
    const z = z0 + len * f;
    const p = pt(Math.PI, r - 0.02, z);
    dark.bar(p[0], p[1], p[2], 0.55, 0.09, 0.42, 0);
  }

  return { plate, steel, steelDark: dark, hazard };
}

/* ------------------------------------------------------------------ */
/* Budget                                                              */
/* ------------------------------------------------------------------ */

/**
 * Triangle reservation, per section.
 *
 * These merge into buckets the yard already draws, so they cost no draw call,
 * no material and no program — but they do cost triangles in every framing
 * that sees a jig. The dock measured 163k-231k world triangles across its 24
 * framings before this landed; 2,600 a section is 7,800 at the worst framing,
 * i.e. **under 3.6%**, and the three sections are never all in shot at once
 * except from `yard-wide` and `crane-cab`. Twenty thousand would not be, so
 * the gate is here rather than in a review comment.
 */
export const TRI_BUDGET = 2600;

/** Section id -> the part keys its file contains. For the manifest and tests. */
export const SECTION_PARTS = Object.freeze(
  Object.fromEntries(SECTIONS.map((s) => [s.id, ['plate', 'steel', 'steelDark', 'hazard']]))
);

/**
 * Every part key this generator will ever emit.
 *
 * These are YARD MATERIAL KEYS, not part names: the mesh name IS the bucket
 * `DockWorld._put` drops the geometry in. `yard-assets.test.mjs` holds each of
 * them against the live output of `buildYardMaterials`, so a key the yard has
 * no material for cannot ship — that part would need a material of its own,
 * which is the draw call and the shader program this design exists to avoid.
 */
export const YARD_PART_KEYS = Object.freeze(['plate', 'steel', 'steelDark', 'hazard']);

/* ------------------------------------------------------------------ */
/* Minimal binary glTF 2.0 writer                                      */
/* ------------------------------------------------------------------ */
/* Lifted from `scripts/make-beast-glb.mjs`, which took it from
 * `make-npc-glb.mjs`, which took it from `make-newel-glb.mjs`. Kept verbatim
 * rather than factored into a shared module, for the reason those files give:
 * five generators that each stand alone can be read end to end, and the
 * byte-diff tests pin all five against their committed output, so a
 * divergence cannot ship silently. */

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
  const report = [];

  for (const key of YARD_PART_KEYS) {
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

    materials.push({
      name: `${setName}-${key}-placeholder`,
      pbrMetallicRoughness: {
        baseColorFactor: key === 'hazard' ? [0.72, 0.66, 0.55, 1]
          : key === 'steelDark' ? [0.34, 0.38, 0.43, 1] : [0.55, 0.60, 0.66, 1],
        metallicFactor: 0.3, roughnessFactor: 0.7,
      },
    });
    meshes.push({
      /* THE MESH NAME IS THE CONTRACT — it is the yard material key the part is
       * drawn with. `dock/YardAssets.js` reads it and discards the glTF
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
      generator: 'aether-nexus scripts/make-yard-glb.mjs',
      copyright: 'generated - procedurally authored in this repository, no external source',
    },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    /* Placeholders so the file stands alone in a viewer. The game DISCARDS
     * every one of these and draws each part with the yard's own cached
     * material of the same name as the mesh - see YardAssets.js. */
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
  const only = process.env.YARD_GLB_SECTION;
  const outOverride = process.env.YARD_GLB_OUT;
  if (outOverride && !only) {
    throw new Error('YARD_GLB_OUT needs YARD_GLB_SECTION - it names one file, not all three');
  }
  for (const s of SECTIONS) {
    if (only && only !== s.id) continue;
    const { glb, tris, verts, report } = writeGlb(s.id, buildSection(s));
    if (tris > TRI_BUDGET) {
      throw new Error(`${s.id} is ${tris} tris - over the ${TRI_BUDGET} reservation`);
    }
    const out = outOverride
      ? path.resolve(outOverride)
      : path.join(root, 'public/assets/dock', `${s.id}.glb`);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, glb);
    console.log(`${out}   r ${s.r} len ${s.len} frames ${s.frames}`);
    for (const p of report) {
      console.log(`  ${p.key.padEnd(10)} ${String(p.verts).padStart(5)} verts  ${String(p.tris).padStart(5)} tris`);
    }
    console.log(`  ${'TOTAL'.padEnd(10)} ${String(verts).padStart(5)} verts  ${String(tris).padStart(5)} tris  ${glb.length} bytes`);
  }
}
