import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

/**
 * CAN A BODY GET THERE, AND BACK? LODESTAR YARD, FLOODED.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THIS FILE EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Content that was BUILT and cannot be REACHED is this project's signature
 * defect. Fifteen of fifty-four medieval enterables could not be entered past
 * a 1,074-test suite, because "every existing test asks whether a thing was
 * BUILT correctly, and no test asked whether a player standing outside it
 * could reach it". The station built, glazed and railed a hangar mezzanine
 * that nothing could get to.
 *
 * The yard is four levels - trench -2.2, deck 0, gantry 8.0, crane 15.4 - and
 * every one of them is somewhere the design says a player goes. So this is not
 * an assertion, it is a PROBE: the real colliders out of a real build, flooded
 * from the exact point `WorldManager.arrivalFor` puts a body stepping out of
 * gateway six, forwards AND backwards, on foot.
 *
 * ── Why a flood rather than the medieval bearing march ────────────────────
 * `medieval-approach.test.mjs` walks a straight line at fifteen bearings into
 * a door. That is the right instrument for a village of ground-floor doors on
 * open ground and it cannot express this world at all: a straight line from
 * the apron to the crane cab passes through eight metres of air. What answers
 * "can a body get from the gateway to the crane cab" is a graph over every
 * surface in the world, with the edges the player's own movement can actually
 * take - and then the same graph reversed, because a stair you can climb and
 * a ledge you dropped off are not the same edge.
 *
 * The bearing march is still here, once, for the one thing it is the right
 * instrument for: the site office door, which is a ground-floor door on open
 * ground and is exactly the medieval case.
 *
 * ── The movement envelope. Measured, not computed. ────────────────────────
 * Taken from `citadel-reach.test.mjs`, which drove them against a real
 * `Player.fixedUpdate` in a browser and records why the closed forms are
 * wrong: gravity is applied BEFORE the integrator moves, so every trajectory
 * permanently loses |g|dt^2/2 and `v^2/2g` overstates a jump apex by 5 cm.
 *
 * NOTHING BELOW USES A JUMP. Every edge in the graph is a walk: a step up of
 * at most `stepHeight`, a slope the capsule solver resolves, or a drop the
 * body survives. That is deliberate and it is the strongest form of the claim
 * - if the yard is fully connected by WALKING, then it is connected for a
 * player who is out of stamina, cannot jump, has never learned to mantle and
 * is carrying the map open.
 */

/* ================================================================== */
/* The envelope                                                        */
/* ================================================================== */

/** `CONFIG.player.stepHeight`. The tallest rise a walk absorbs. */
const STEP_UP = 0.45;
/** Drop at which fall damage first appears. Driven off a real ledge. */
const FALL_DAMAGE_M = 7.5;
/**
 * The tallest drop an edge may use.
 *
 * 3.0 m, well under the 7.5 m damage threshold, because a route that costs
 * health is not a route - it is a shortcut. The trench is 2.2 m down and
 * therefore inside it; the gantry at 8.0 m is not, which is why the two stairs
 * have to be real.
 */
const DROP_MAX = 3.0;
/**
 * Clear air a surface needs above it to count as standing room.
 *
 * The player capsule is 1.75 m. 1.9 is that plus 15 cm, which is what
 * separates a deck from the underside of a catwalk.
 */
const HEADROOM = 1.9;
/**
 * Lattice pitch, and it is NOT a taste decision.
 *
 * The gantry flights run at 35 degrees, so a walk gains `tan(35) = 0.700 m`
 * of height per metre travelled. At a 1.0 m pitch every step on those flights
 * is a 0.70 m rise, over `stepHeight` 0.45, and the graph would report both
 * stairs as impassable and the whole gantry as unreachable - a false RED, and
 * the most misleading kind. 0.5 m gives 0.35 m per step on the gantry flights
 * and 0.39 m on the steeper crane run, both inside the budget with room.
 */
const PITCH = 0.5;
/** Merge tolerance for stacked colliders, metres. */
const MERGE = 0.02;

/* ================================================================== */
/* A world, built without a browser                                    */
/* ================================================================== */

function harness() {
  if (globalThis.__dockReachHarness) return;
  globalThis.__dockReachHarness = true;
  class Img {
    constructor(a, b, c) {
      if (typeof a === 'number') { this.width = a; this.height = b; this.data = new Uint8ClampedArray(a * b * 4); }
      else { this.data = a; this.width = b; this.height = c ?? 1; }
    }
  }
  const gradient = { addColorStop() {} };
  const context2d = (canvas) => {
    const real = {
      canvas,
      createImageData: (w, h) => new Img(Math.max(1, w | 0), Math.max(1, (h ?? w) | 0)),
      getImageData: (x, y, w, h) => new Img(Math.max(1, w | 0), Math.max(1, h | 0)),
      createLinearGradient: () => gradient,
      createRadialGradient: () => gradient,
      createConicGradient: () => gradient,
      createPattern: () => null,
      measureText: () => ({ width: 8 }),
      getLineDash: () => [],
    };
    return new Proxy(real, { get: (o, k) => (k in o ? o[k] : () => undefined), set: () => true });
  };
  globalThis.ImageData = Img;
  globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  globalThis.document = {
    createElement(tag) { const c = { width: 1, height: 1, style: {}, tagName: tag }; c.getContext = () => context2d(c); return c; },
    createElementNS(_ns, tag) { return this.createElement(tag); },
  };
  globalThis.window = globalThis;
  globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return context2d(this); } };
  const dead = () => ({ texture: null, dispose() {} });
  THREE.PMREMGenerator.prototype.fromEquirectangular = dead;
  THREE.PMREMGenerator.prototype.fromScene = dead;
  THREE.PMREMGenerator.prototype.compileEquirectangularShader = () => {};
}

harness();
const { Physics, COLLISION_LAYER } = await import('../../src/physics/Physics.js');
const { DockWorld } = await import('../../src/worlds/DockWorld.js');
const PLAN = await import('../../src/worlds/dock/YardPlan.js');
const HULL = await import('../../src/worlds/dock/HullPlan.js');

let _built = null;
async function built() {
  if (_built) return _built;
  const physics = new Physics();
  const renderer = {
    capabilities: { getMaxAnisotropy: () => 4, isWebGL2: true },
    initTexture() {}, getContext: () => ({}),
    getRenderTarget: () => null, setRenderTarget() {}, render() {}, clear() {},
  };
  const world = new DockWorld({
    physics,
    scene: new THREE.Scene(),
    bus: { on: () => () => {}, emit() {} },
    engine: { renderer, onFrameUpdate: () => () => {}, onResize: () => () => {} },
    materials: { get: () => new THREE.MeshStandardMaterial(), dispose() {} },
  });
  world.physics = physics;
  await world.build(() => {});
  _built = { world, physics };
  return _built;
}

/* ================================================================== */
/* The column index                                                    */
/* ================================================================== */

/**
 * Every solid interval standing over a column of the yard.
 *
 * Built as its own XZ index rather than by leaning on `Physics.raycast`, for
 * the reason `citadel-reach.test.mjs` records: a downward ray answers "what is
 * the first thing under me", and what a walk graph needs is the WHOLE column -
 * the deck, the catwalk eight metres over it, the trench floor two metres
 * under it, and how much air sits above each.
 *
 * ── Every box, at any orientation, by slab clipping ───────────────────────
 * The citadel's version reads the yaw out of the collider matrix and assumes
 * rotation about Y only. That is false here: `_flight` registers each stair as
 * ONE hidden ramp proxy through `addBoxFromObject`, whose matrix carries a
 * PITCH about X as well - and those proxies are the only collision the six
 * flights in this world have. Reading them as yawed boxes would give each
 * stair a flat top at the height of its own centre, which is a floating slab
 * halfway up. So the column is clipped against each box's three local slabs in
 * the box's own space, which is exact for any orientation and costs one
 * matrix-inverse transform per test.
 */
class Columns {
  constructor(physics, { skip = new Set(), headroom = HEADROOM } = {}) {
    this.headroom = headroom;
    this.cell = 6;
    this.grid = new Map();
    this.boxes = [];
    this.unhandled = [];
    const inv = new THREE.Matrix4();
    for (const c of physics.colliders) {
      if (!c.solid) continue;
      if ((c.layer & COLLISION_LAYER.WORLD) === 0) continue;
      if (skip.has(c)) continue;
      if (c.type !== 'box') { this.unhandled.push(c); continue; }
      inv.copy(c.matrix).invert();
      const b = {
        col: c,
        inv: inv.clone(),
        h: c.halfExtents.clone(),
        x: c.matrix.elements[12], y: c.matrix.elements[13], z: c.matrix.elements[14],
      };
      // Conservative axis-aligned XZ span of the oriented box, for broadphase.
      const m = c.matrix.elements;
      b.ax = Math.abs(m[0]) * b.h.x + Math.abs(m[4]) * b.h.y + Math.abs(m[8]) * b.h.z;
      b.az = Math.abs(m[2]) * b.h.x + Math.abs(m[6]) * b.h.y + Math.abs(m[10]) * b.h.z;
      b.ay = Math.abs(m[1]) * b.h.x + Math.abs(m[5]) * b.h.y + Math.abs(m[9]) * b.h.z;
      this.boxes.push(b);
      const x0 = Math.floor((b.x - b.ax) / this.cell);
      const x1 = Math.floor((b.x + b.ax) / this.cell);
      const z0 = Math.floor((b.z - b.az) / this.cell);
      const z1 = Math.floor((b.z + b.az) / this.cell);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          const k = ((cx + 4096) << 13) | (cz + 4096);
          let list = this.grid.get(k);
          if (!list) this.grid.set(k, (list = []));
          list.push(b);
        }
      }
    }
  }

  _near(x, z) {
    return this.grid.get(((Math.floor(x / this.cell) + 4096) << 13) | (Math.floor(z / this.cell) + 4096)) ?? [];
  }

  /**
   * The vertical interval an infinite Y line at (x, z) spends inside one box,
   * or null. Slab clipping in the box's own space; exact for any orientation.
   */
  _span(b, x, z) {
    // The line in box space: a point plus a direction, both transformed.
    const e = b.inv.elements;
    const px = e[0] * x + e[4] * 0 + e[8] * z + e[12];
    const py = e[1] * x + e[5] * 0 + e[9] * z + e[13];
    const pz = e[2] * x + e[6] * 0 + e[10] * z + e[14];
    const dx = e[4], dy = e[5], dz = e[6];   // the world +Y axis in box space
    let t0 = -Infinity, t1 = Infinity;
    const slab = (p, d, h) => {
      if (Math.abs(d) < 1e-9) return p >= -h && p <= h;
      const a = (-h - p) / d;
      const c = (h - p) / d;
      const lo = Math.min(a, c), hi = Math.max(a, c);
      if (lo > t0) t0 = lo;
      if (hi < t1) t1 = hi;
      return t0 <= t1;
    };
    if (!slab(px, dx, b.h.x)) return null;
    if (!slab(py, dy, b.h.y)) return null;
    if (!slab(pz, dz, b.h.z)) return null;
    if (t1 <= t0) return null;
    return [t0, t1];
  }

  /** Merged solid intervals over a column, ascending. */
  spans(x, z) {
    const raw = [];
    for (const b of this._near(x, z)) {
      if (Math.abs(b.x - x) > b.ax || Math.abs(b.z - z) > b.az) continue;
      const s = this._span(b, x, z);
      if (s) raw.push(s);
    }
    if (!raw.length) return raw;
    raw.sort((a, b) => a[0] - b[0]);
    const out = [raw[0].slice()];
    for (let i = 1; i < raw.length; i++) {
      const last = out[out.length - 1];
      if (raw[i][0] <= last[1] + MERGE) last[1] = Math.max(last[1], raw[i][1]);
      else out.push(raw[i].slice());
    }
    return out;
  }

  /** Every standable surface over a column: an interval top with headroom. */
  decks(x, z) {
    const s = this.spans(x, z);
    const out = [];
    for (let i = 0; i < s.length; i++) {
      const top = s[i][1];
      const ceil = i + 1 < s.length ? s[i + 1][0] : Infinity;
      if (ceil - top >= this.headroom) out.push(top);
    }
    return out;
  }

  /** The highest deck at or below `y + tol`, or null. */
  deckUnder(x, z, y, tol = 0.6) {
    let best = null;
    for (const d of this.decks(x, z)) {
      if (d <= y + tol && (best === null || d > best)) best = d;
    }
    return best;
  }
}

/* ================================================================== */
/* The walk graph                                                      */
/* ================================================================== */

/**
 * Every place a body can stand, and every step it can take between two of
 * them.
 *
 * Nodes are `(i, j, deck)` on a `PITCH` lattice. Edges are DIRECTED and the
 * asymmetry is the whole point: a body can step UP `STEP_UP` and can drop
 * `DROP_MAX`, so a two-metre ledge is an edge one way and a wall the other.
 * Flooding forward from the arrival point answers "can you get there";
 * flooding the reversed graph from the same point answers "and back out",
 * which is the half the medieval suite never asked.
 *
 * Same-column vertical moves are FORBIDDEN. Standing on the grating over the
 * service trench, the column also contains the trench floor 2.1 m below, and
 * allowing the transition would have the body fall through a solid deck it is
 * standing on. Every descent has to happen at a neighbour - which, in this
 * world, means at one of the three ramped bays.
 */
function buildGraph(cols, { x0, x1, z0, z1 }) {
  const nx = Math.round((x1 - x0) / PITCH) + 1;
  const nz = Math.round((z1 - z0) / PITCH) + 1;
  /** @type {Array<Float64Array|null>} */
  const decks = new Array(nx * nz).fill(null);
  const ids = new Map();
  const nodes = [];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const x = x0 + i * PITCH;
      const z = z0 + j * PITCH;
      const d = cols.decks(x, z).filter((y) => y > -8 && y < 20);
      if (!d.length) continue;
      decks[i * nz + j] = Float64Array.from(d);
      for (let k = 0; k < d.length; k++) {
        ids.set(`${i}:${j}:${k}`, nodes.length);
        nodes.push({ i, j, k, x, z, y: d[k] });
      }
    }
  }
  const fwd = nodes.map(() => []);
  const rev = nodes.map(() => []);
  const NB = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let n = 0; n < nodes.length; n++) {
    const a = nodes[n];
    for (const [di, dj] of NB) {
      const bi = a.i + di, bj = a.j + dj;
      if (bi < 0 || bj < 0 || bi >= nx || bj >= nz) continue;
      const bd = decks[bi * nz + bj];
      if (!bd) continue;
      for (let k = 0; k < bd.length; k++) {
        const dy = bd[k] - a.y;
        if (dy > STEP_UP) continue;      // too tall to step up onto
        if (-dy > DROP_MAX) continue;    // too far to drop safely
        const m = ids.get(`${bi}:${bj}:${k}`);
        if (m === undefined) continue;
        fwd[n].push(m);
        rev[m].push(n);
      }
    }
  }
  return { nodes, ids, fwd, rev, nx, nz, x0, z0 };
}

function flood(graph, from, edges) {
  const seen = new Uint8Array(graph.nodes.length);
  const q = [from];
  seen[from] = 1;
  for (let h = 0; h < q.length; h++) {
    for (const m of edges[q[h]]) {
      if (seen[m]) continue;
      seen[m] = 1;
      q.push(m);
    }
  }
  return seen;
}

/** The graph node nearest a world point, searching outward. */
function nodeAt(graph, x, y, z, { radius = 2.5, yTol = 1.2 } = {}) {
  let best = -1;
  let bestD = Infinity;
  const i0 = Math.round((x - graph.x0) / PITCH);
  const j0 = Math.round((z - graph.z0) / PITCH);
  const r = Math.ceil(radius / PITCH);
  for (let di = -r; di <= r; di++) {
    for (let dj = -r; dj <= r; dj++) {
      const i = i0 + di, j = j0 + dj;
      for (let k = 0; k < 8; k++) {
        const id = graph.ids.get(`${i}:${j}:${k}`);
        if (id === undefined) break;
        const n = graph.nodes[id];
        if (Math.abs(n.y - y) > yTol) continue;
        const d = (n.x - x) ** 2 + (n.z - z) ** 2 + ((n.y - y) * 2) ** 2;
        if (d < bestD) { bestD = d; best = id; }
      }
    }
  }
  return best;
}

/* ================================================================== */
/* One build, one graph, shared by every test                          */
/* ================================================================== */

let _measured = null;
async function measure() {
  if (_measured) return _measured;
  const { world, physics } = await built();

  /* The doors are excluded, and ONLY the doors.
   *
   * `Interiors._onWorld` sets `d.collider.solid = true` on every world change
   * and clears it while the leaf swings, so a shut door is solid to the
   * capsule and open to the player. A route probe that respected it would
   * report every interior in the game as unreachable; one that dropped every
   * thin collider would report walls as doorways. */
  const doors = new Set();
  for (const e of world.enterables) for (const d of e.doors ?? []) if (d.collider) doors.add(d.collider);

  const cols = new Columns(physics, {});
  const colsOpen = new Columns(physics, { skip: doors });
  /* The lattice has to cover the PIERS as well as the bay.
   *
   * It used to stop at `YARD_Z0 + 0.5`, which was the inside face of a sealed
   * north wall and therefore the end of the world. The wall is a 164 m
   * aperture now and three of the four ships are on decks north of it, the
   * furthest 76 m out — so a lattice that stopped at the old wall would flood
   * a bay with no ships in it and report every pier relic, every pier cache
   * and every berth apron as unreachable while the world was perfectly fine.
   * Derived from `PIERS` rather than typed, so a pier that grows takes the
   * probe with it. */
  const zFar = Math.min(PLAN.YARD_Z0, ...PLAN.PIERS.map((p) => PLAN.pierPad(p).z1));
  const bounds = {
    x0: -PLAN.YARD_X + 0.5, x1: PLAN.YARD_X - 0.5,
    z0: zFar + 0.5, z1: PLAN.YARD_Z1 - 0.5,
  };
  const graph = buildGraph(colsOpen, bounds);

  /* THE ARRIVAL POINT, derived rather than typed.
   *
   * `WorldManager.arrivalFor` stands a body 2.6 m along the return portal's
   * own normal `(sin rotY, cos rotY)`. Reproducing that arithmetic here rather
   * than writing down the answer is what makes this test notice if somebody
   * turns the gateway round. */
  const spec = world.portalSpecs.find((s) => s.target === 'station');
  const rotY = spec.rotationY ?? 0;
  const arrival = {
    x: spec.position.x + Math.sin(rotY) * 2.6,
    y: spec.position.y,
    z: spec.position.z + Math.cos(rotY) * 2.6,
  };
  const start = nodeAt(graph, arrival.x, cols.deckUnder(arrival.x, arrival.z, arrival.y + 1.2) ?? 0, arrival.z);

  _measured = {
    world, physics, cols, colsOpen, graph, arrival, start, doors,
    out: flood(graph, start, graph.fwd),
    back: flood(graph, start, graph.rev),
  };
  return _measured;
}

/** Every place this drop says a player goes, as `[label, x, y, z]`. */
async function targets() {
  const { world } = await built();
  const t = [];
  const push = (label, x, y, z) => t.push({ label, x, y, z });

  // Deck level: the keel line end to end, the datum, the launch apron.
  push('keel line, apron end', 0, 0.12, 46);
  push('keel line, midships', 0, 0, 0);
  push('the datum plate', 0, 0, -1.5);
  push('keel line, blast-door end', 0, 0, -86);
  const launch = world.portalSpecs.find((s) => s.target === 'space');
  push('the launch portal disc', launch.position.x, 0, launch.position.z + 2.6);

  // Every berth apron - the point a boarding ramp foot lands on.
  for (const b of world.shipSpecs) push(`berth ${b.berth} apron (${b.id})`, b.apron.x, b.apron.y, b.apron.z);
  /* ...and the cradle top BESIDE each hull, which is the first metre of the
   * climb onto it and the landing the berth's service stair delivers you to.
   *
   * Not the cradle CENTRE any more, and the change is not a weakening: there is
   * a ship bolted to every cradle now, so the centre of a bearing face is
   * inside a hull. What has to be reachable is the strip of cradle a body
   * stands on to board or to start climbing, which is `lower.hw + 1.0 m` out
   * along the boarding flank in the hull's own frame. Derived from `HullPlan`
   * rather than written down, so a hull that grows a metre in the beam moves
   * this probe with it. */
  for (const b of world.shipSpecs) {
    const h = HULL.HULLS[b.id];
    const lx = (b.boardSide ?? 1) * (h.lower.hw + 1.0);
    const c = Math.cos(b.yaw), sn = Math.sin(b.yaw);
    push(`berth ${b.berth} cradle top, boarding side`, b.x + lx * c, b.keelY, b.z - lx * sn);
  }
  /* Every dorsal spine a body is meant to WALK onto — the Pike's, up the
   * yard's access scaffold, and the Dray's, off the gantry crossing by way of
   * the brow and the companionway.
   *
   * The Kestrel's and the Bastion's are deliberately absent and the reason is
   * published rather than assumed: `spineAccess` says 'climb' for both, which
   * means a mantle chain, and `dock-hulls.test.mjs` proves those against
   * `Climb`'s own window. A walk probe asked to reach them would report a
   * defect that is a design decision. */
  for (const b of world.shipSpecs) {
    if (b.spineAccess === 'climb') continue;
    const h = HULL.HULLS[b.id];
    const lz = (h.spine.z0 + h.spine.z1) / 2;
    const c = Math.cos(b.yaw), sn = Math.sin(b.yaw);
    push(`${b.id} dorsal spine (by ${b.spineAccess})`, b.x + lz * sn, b.crownY, b.z + lz * c);
  }

  /* ── The piers ─────────────────────────────────────────────────────────
   * Three points on each: the gate at the mouth, the middle of the spine, and
   * the far corner of the head pad. The far CORNER rather than the centre,
   * because the centre of a pad with a ship on it is inside the ship and
   * because the corner is the one place a rail could quietly fence off.
   *
   * "Walking a pier should feel like walking a gangway over nothing" is the
   * brief; "and back" is this file's whole reason for existing, and it matters
   * more out here than anywhere else in the world — the only thing under a
   * pier is 200 m of vacuum. */
  for (const p of PLAN.PIERS) {
    const pad = PLAN.pierPad(p);
    push(`${p.id} gate at the bay lip`, p.x, 0, PLAN.MOUTH_Z - 2);
    push(`${p.id} spine, midway out`, p.x, 0, (PLAN.MOUTH_Z + pad.z0) / 2);
    push(`${p.id} head pad, far corner`, p.x + (p.hw - 2.5), 0, pad.z1 + 2.5);
    push(`${p.id} head pad, near corner`, p.x - (p.hw - 2.5), 0, pad.z0 - 2.5);
  }

  // Every counter, from the customer's side.
  for (const c of PLAN.COUNTERS) push(`counter at z ${c.z}`, PLAN.COUNTER_X + 1.6, 0, c.z);

  // The office: the door, and the floor behind it.
  push('site office door', PLAN.OFFICE.doorX + 1.2, 0, PLAN.OFFICE.z);
  push('site office floor', PLAN.OFFICE.x, 0.12, PLAN.OFFICE.z);

  // The trench: both runs, and the floor between the bays.
  push('trench, south run', 0, PLAN.TRENCH_Y, 10);
  push('trench, under the datum island', 0, PLAN.TRENCH_Y, -20);
  push('trench, north end', 0, PLAN.TRENCH_Y, -66);

  // The gantry: all four runs, both crossings, both stair heads.
  push('gantry, port run', -84.8, PLAN.GANTRY_Y, 0);
  push('gantry, starboard run', 84.8, PLAN.GANTRY_Y, 0);
  push('gantry, apron run', 0, PLAN.GANTRY_Y, 56.8);
  push('gantry, blast-door run', 0, PLAN.GANTRY_Y, -102.8);
  for (const z of PLAN.CROSSINGS) push(`gantry crossing at z ${z}`, 0, PLAN.GANTRY_Y, z);
  for (const s of PLAN.STAIRS) push(`head of ${s.id}`, s.headX + 0.6, PLAN.GANTRY_Y, s.z);

  // The high ground, which is where the viewpoints are.
  for (const v of world.viewpoints) push(`viewpoint "${v.id}"`, v.x, v.y, v.z);
  push('crane runway walkway', PLAN.CRANE_WALK.x, PLAN.CRANE_Y, -28);

  // The scaffold decks, because a thing you can see a cache on is a thing you
  // have to be able to stand on.
  push('scaffold by berth one', -46, 2.0, 4);
  push('scaffold by berth three', 52, 2.0, -34);
  push('scaffold by the blast door', 16, 2.0, -84);

  return t;
}

/* ================================================================== */
/* Tests                                                              */
/* ================================================================== */

test('the probe itself is sound - the index sees the world it is measuring', async () => {
  /* THE GUARD ON EVERY OTHER TEST IN THIS FILE. A column index that quietly
   * stopped seeing colliders would report an empty graph and every reach test
   * would go GREEN by finding no obstacles at all. So: the yard is really
   * built, the index really represents it, and the floor really is where the
   * plan says. */
  const { world, physics, cols, graph } = await measure();
  assert.ok(physics.colliders.length > 80, `the yard built only ${physics.colliders.length} colliders`);
  assert.equal(cols.unhandled.length, 0,
    `${cols.unhandled.length} colliders are not boxes - this index cannot represent them and would silently ignore them`);
  assert.ok(graph.nodes.length > 40000, `the walk graph has only ${graph.nodes.length} nodes`);

  // The floor is at DECK_Y wherever there is nothing on it.
  for (const [x, z] of [[-60, 0], [60, 30], [-20, -90], [70, -70]]) {
    const d = cols.deckUnder(x, z, 1);
    assert.ok(d !== null && Math.abs(d - PLAN.DECK_Y) < 0.2,
      `the assembly floor at (${x}, ${z}) reads ${d}, not ${PLAN.DECK_Y}`);
  }
  // The roof really is collided, which is what keeps a flying mount in the shed.
  const roof = cols.spans(0, -20).find((s) => s[0] > 20);
  assert.ok(roof, 'nothing solid over the yard - a summoned mount leaves through the truss');
  assert.ok(Math.abs(roof[0] - PLAN.ROOF_Y) < 0.6,
    `the roof collider starts at ${roof[0].toFixed(2)}, not ${PLAN.ROOF_Y}`);
  assert.equal(world.id, 'dock');
});

test('the gateway puts a body on solid ground facing down the yard', async () => {
  const { cols, arrival, start, graph } = await measure();
  const deck = cols.deckUnder(arrival.x, arrival.z, arrival.y + 1.2);
  assert.ok(deck !== null, 'there is no floor under the arrival point');
  assert.ok(Math.abs(deck - 0.12) < 0.25,
    `the arrival stands at ${deck?.toFixed(2)} - the apron pad is 0.12 m`);
  assert.notEqual(start, -1, 'the arrival point is not on the walk graph at all');
  assert.ok(Math.hypot(graph.nodes[start].x - arrival.x, graph.nodes[start].z - arrival.z) < 1.0);

  /* And it faces the right way. `arrivalFor` turns the body to `rotY + PI`,
   * and characters look down -Z at yaw 0, so the heading is `-(sin, cos)` of
   * the portal's own rotation. At `rotationY: PI` that is +Z... which would be
   * back into the wall. It is not: the normal at PI is -Z, the body is placed
   * at z 49.4 BEHIND the arch, and the heading carries it on down the yard.
   * The check that matters is that the point 30 m along the heading is still
   * inside the world and standable. */
  const { world } = await built();
  const spec = world.portalSpecs.find((s) => s.target === 'station');
  const yaw = (spec.rotationY ?? 0) + Math.PI;
  const hx = arrival.x - Math.sin(yaw) * 30;
  const hz = arrival.z - Math.cos(yaw) * 30;
  assert.ok(hz < arrival.z - 20,
    `the arrival faces z ${hz.toFixed(1)} from ${arrival.z.toFixed(1)} - it is looking at the apron wall`);
  assert.ok(cols.deckUnder(hx, hz, 1) !== null, 'the view down the keel line ends in a hole');
});

test('EVERY level of the yard is reachable on foot from the gateway, and back', async () => {
  /* THE HEADLINE. This is the assertion the medieval expansion did not have,
   * reported as a table rather than as a boolean so a regression shows up as a
   * named place going missing rather than as "false".
   *
   * Forward AND backward, because they are different questions: the forward
   * flood allows a 3 m drop, so a route that goes DOWN into the trench and has
   * no ramp out would pass it and fail the reverse. */
  const { graph, out, back } = await measure();
  const list = await targets();
  const failures = [];
  for (const t of list) {
    const id = nodeAt(graph, t.x, t.y, t.z, { radius: 3.0, yTol: 1.5 });
    if (id === -1) { failures.push(`${t.label}: nothing standable within 3 m of (${t.x}, ${t.y}, ${t.z})`); continue; }
    if (!out[id]) { failures.push(`${t.label}: BUILT but unreachable from the gateway`); continue; }
    if (!back[id]) { failures.push(`${t.label}: reachable, but there is no way back from it`); }
  }
  assert.deepEqual(failures, [],
    `${failures.length} of ${list.length} places in Lodestar Yard fail the walk:\n  ` + failures.join('\n  '));
  assert.ok(list.length >= 30, `only ${list.length} places probed - the target list has been gutted`);
});

test('the reachable component is the yard, not a corner of it', async () => {
  /* A floor that is FULLY connected but that only covers the apron would pass
   * the test above with a target list that happened to sit on the apron. This
   * is the coverage floor: the round-trip component has to be most of the
   * walkable world, quoted as a percentage so a regression is a number sliding
   * rather than a boolean flipping.
   *
   * The ceiling is computed by ablation in the message: the unreachable
   * remainder is dominated by rail tops, string courses and the crane runway
   * beams - surfaces that are solid, are standable in principle, and that
   * nothing is supposed to be able to walk onto. */
  const { graph, out, back } = await measure();
  let deck = 0, both = 0;
  const orphans = new Map();
  for (let n = 0; n < graph.nodes.length; n++) {
    const node = graph.nodes[n];
    // Count the floor, the gantry and the trench: the three levels a player uses.
    const onLevel = Math.abs(node.y - PLAN.DECK_Y) < 0.35
      || Math.abs(node.y - PLAN.GANTRY_Y) < 0.35
      || Math.abs(node.y - PLAN.TRENCH_Y) < 0.35;
    if (!onLevel) continue;
    deck++;
    if (out[n] && back[n]) both++;
    else {
      const key = Math.abs(node.y - PLAN.GANTRY_Y) < 0.35 ? 'gantry'
        : Math.abs(node.y - PLAN.TRENCH_Y) < 0.35 ? 'trench' : 'deck';
      orphans.set(key, (orphans.get(key) ?? 0) + 1);
    }
  }
  const pct = (both / deck) * 100;
  assert.ok(pct >= 97,
    `floor: 97%. achieved: ${pct.toFixed(1)}% (${both} of ${deck} standing positions on the three walkable levels `
    + `are on the round trip). unreachable by level: ${[...orphans].map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  assert.ok(deck > 30000, `only ${deck} standing positions on the walkable levels`);
});

test('the trench is a route with two ends, not a pit', async () => {
  /* The specific failure this guards: a 2.2 m drop is INSIDE the forward
   * flood's `DROP_MAX`, so a trench with no ramp at all would still be
   * "reachable". Only the reverse flood catches it - and the way it catches
   * it is that every point on the trench floor loses its way home. */
  const { graph, out, back, cols } = await measure();
  let floor = 0, home = 0;
  for (const [z0, z1] of PLAN.TRENCH_RUNS) {
    for (let z = z0 + 0.5; z < z1 - 0.5; z += PITCH) {
      const id = nodeAt(graph, 0, PLAN.TRENCH_Y, z, { radius: 1.0, yTol: 0.4 });
      if (id === -1) continue;
      floor++;
      if (out[id] && back[id]) home++;
    }
  }
  assert.ok(floor > 100, `only ${floor} standing positions on the trench floor`);
  assert.equal(home, floor,
    `${floor - home} of ${floor} points on the trench floor have no way back out - the ramps are not doing their job`);

  // And the headroom down there is real headroom, not a crawl.
  for (const z of [-20, -40, 6]) {
    const s = cols.spans(0, z);
    const floorTop = s.find((iv) => Math.abs(iv[1] - PLAN.TRENCH_Y) < 0.2);
    assert.ok(floorTop, `no trench floor at z ${z}`);
    const above = s.find((iv) => iv[0] > floorTop[1] + 0.1);
    assert.ok(above, `nothing over the trench at z ${z} - it is not covered`);
    const clear = above[0] - floorTop[1];
    assert.ok(clear >= HEADROOM,
      `the trench at z ${z} has ${clear.toFixed(2)} m of clear height against a 1.75 m capsule`);
  }
});

test('the bay lip cannot be walked off, and every gate in it leads to a pier', async () => {
  /* ═══════════════════════════════════════════════════════════════════════
   * THE ONE FAILURE THIS WORLD CAN NOW HAVE THAT IT COULD NOT BEFORE.
   *
   * The north end used to be a wall. It is 164 m of open vacuum now, and past
   * `MOUTH_Z` there is no ground at all except the five piers — so every metre
   * of that lip is either a pier gate or a place a walking body steps into
   * space. `Unstuck` recovers a fall below `bounds.min.y`, and a world that
   * uses the rescue system as its edge treatment is a world with a hole in it.
   *
   * So: march the whole lip at 0.25 m and, at every station, one of exactly
   * two things must be true — there is pier deck to walk onto, or there is a
   * solid the height of the balustrade standing in the way. `MOUTH_KERB_H` is
   * 1.15, over `stepHeight` 0.45 and under the 1.55 m a mantle needs, so
   * "solid" here means a body is stopped rather than slowed.
   *
   * MUTATION: shrink the gate list to four piers and this reports the fifth
   * pier's own 7.4 m gate as 30 unguarded stations; publish the balustrade at
   * 0.40 m and every one of the 640 stations between the gates fails.
   * ═══════════════════════════════════════════════════════════════════════ */
  const { cols } = await measure();
  const lip = PLAN.MOUTH_Z;
  const open = [];
  const gates = new Map(PLAN.PIERS.map((p) => [p.id, 0]));

  for (let x = -PLAN.MOUTH_HW + 0.125; x < PLAN.MOUTH_HW; x += 0.25) {
    /* Is there pier deck immediately outside the lip? Sampled 1.5 m out, past
     * the kerb's own footprint and inside the first pier bay. */
    const outside = cols.decks(x, lip - 1.5).some((y) => Math.abs(y - PLAN.DECK_Y) < 0.4);
    if (outside) {
      const p = PLAN.PIERS.find((q) => Math.abs(q.x - x) <= q.hw + 0.01)
        ?? PLAN.PIERS.find((q) => Math.abs(q.x - x) <= PLAN.PIER_GATE_HW + 0.01);
      if (!p) { open.push(`x ${x.toFixed(2)}: deck outside the lip that belongs to no pier`); continue; }
      gates.set(p.id, gates.get(p.id) + 1);
      continue;
    }
    /* No deck out there. Then the lip has to be walled: a solid whose top is
     * at least a step-height over the deck, standing in the 0.5 m band the
     * balustrade occupies. */
    const spans = cols.spans(x, lip + 0.25);
    const wall = spans.some((s) => s[1] >= PLAN.DECK_Y + STEP_UP + 0.2 && s[0] <= PLAN.DECK_Y + 0.3);
    if (!wall) open.push(`x ${x.toFixed(2)}: no pier and no balustrade - a walk into the void`);
  }

  assert.deepEqual(open.slice(0, 12), [],
    `floor: 0 unguarded stations along ${(PLAN.MOUTH_HW * 2).toFixed(0)} m of bay lip. `
    + `achieved: ${open.length}\n  ` + open.slice(0, 12).join('\n  '));
  for (const [id, n] of gates) {
    assert.ok(n >= 8, `${id} has only ${n} stations of deck outside the lip - its gate leads nowhere`);
  }
});

test('every pier is a walk out to its tip and a walk back, with the ship at the end boardable', async () => {
  /* The brief in one sentence: "at the end of each pier is a spaceship that i
   * can then pilot the ship into space". A pier whose tip is BUILT and cannot
   * be REACHED is this project's signature defect moved 150 m north, and a
   * pier you can walk out and not back is worse than one you cannot walk at
   * all — it strands the player over vacuum.
   *
   * The generic target sweep above already floods four points on every pier.
   * This is the part that sweep cannot say: that the walk is CONTINUOUS, with
   * no rail, no bollard and no lamp post pinching the 6.8 m spine into
   * something a body has to go round. Every half metre of every spine
   * centreline is a round-trip node.
   *
   * MUTATION: rail one spine on both sides with no gate and this reports the
   * whole run; move a pier lamp onto the centreline and it reports the metre
   * it stands in. */
  const { graph, out, back } = await measure();
  const { world } = await built();

  /** Is every half metre of `x` between `z0` and `z1` a round-trip node? */
  const lane = (x, z0, z1) => {
    const bad = [];
    for (let z = z0; z > z1; z -= 0.5) {
      const n = nodeAt(graph, x, PLAN.DECK_Y, z, { radius: 1.2, yTol: 1.0 });
      if (n < 0) bad.push(`z ${z.toFixed(1)}: nothing standable`);
      else if (!out[n] || !back[n]) bad.push(`z ${z.toFixed(1)}: out=${out[n] ? 1 : 0} back=${back[n] ? 1 : 0}`);
    }
    return bad;
  };

  const broken = [];
  for (const p of PLAN.PIERS) {
    const pad = PLAN.pierPad(p);
    // The spine is walked down its centreline, because that is all it is.
    const spine = lane(p.x, PLAN.MOUTH_Z - 0.5, pad.z0);
    if (spine.length) broken.push(`${p.id} spine: ${spine.length} bad, first ${spine[0]}`);

    /* The PAD is not, and cannot be: there is a ship bolted to the middle of
     * three of the five. What has to be continuous is A lane the length of the
     * pad — the centreline where the pier is empty, and the strip beside the
     * hull where it is not. `hw - 2.0` keeps it a metre inside the rail. */
    const lanes = [p.x, p.x + (p.hw - 2.0), p.x - (p.hw - 2.0)]
      .map((x) => ({ x, bad: lane(x, pad.z0 - 0.5, pad.z1 + 1.0) }))
      .sort((a, b) => a.bad.length - b.bad.length);
    if (lanes[0].bad.length) {
      broken.push(`${p.id} pad: no clear lane. best x ${lanes[0].x.toFixed(1)} `
        + `has ${lanes[0].bad.length} bad, first ${lanes[0].bad[0]}`);
    }
  }
  assert.deepEqual(broken, [],
    `floor: every pier has a continuous round-trip walk out and back. achieved: ${broken.length} bad\n  `
    + broken.join('\n  '));

  // ...and every hull on a pier can actually be boarded from that pier.
  const onPiers = world.shipSpecs.filter((s) => PLAN.berthOf(s.id)?.pier);
  assert.equal(onPiers.length, 3, `${onPiers.length} hulls on piers - the brief asks for a ship at the end of each`);
  for (const s of onPiers) {
    const a = nodeAt(graph, s.apron.x, s.apron.y, s.apron.z, { radius: 3, yTol: 1.2 });
    assert.notEqual(a, -1, `${s.id}: no standable ground at its boarding apron`);
    assert.ok(out[a] && back[a], `${s.id}: its boarding apron is not a round trip`);
    if (!s.ramp) continue;
    const f = nodeAt(graph, s.ramp.x, s.ramp.y, s.ramp.z, { radius: 3, yTol: 1.4 });
    assert.notEqual(f, -1, `${s.id}: its ramp foot lands on nothing`);
    assert.ok(out[f] && back[f], `${s.id}: its ramp foot is not a round trip`);
  }
});

test('the gantry is reached by stairs, and the rails have gaps where they arrive', async () => {
  /* Two halves of one property, and each of them is a real defect on its own:
   * a flight with no gap in the rail at its head is a stair that arrives at a
   * fence, and a gap where nothing arrives is an 8 m fall with nothing in
   * front of it. */
  const { graph, out, back, cols } = await measure();
  /* TWO flights, and both of them work.
   *
   * The loop below only checks the stairs that exist, so deleting one leaves
   * it green — the gantry is still reachable by the other, from 160 m away.
   * "Reachable" is not the property; "reachable from either end of a 162 m
   * bay" is, which is why there are two. */
  assert.equal(PLAN.STAIRS.length, 2,
    `the yard has ${PLAN.STAIRS.length} gantry flights — one end of the bay has lost its way up`);
  const apart = Math.abs(PLAN.STAIRS[0].z - PLAN.STAIRS[1].z);
  assert.ok(apart > (PLAN.YARD_Z1 - PLAN.YARD_Z0) * 0.6,
    `the two flights are ${apart.toFixed(0)} m apart in a ${PLAN.YARD_Z1 - PLAN.YARD_Z0} m bay — they belong at opposite ends`);
  for (const s of PLAN.STAIRS) {
    // The foot, on the deck.
    const foot = nodeAt(graph, s.footX, 0, s.z, { radius: 1.5, yTol: 0.6 });
    assert.notEqual(foot, -1, `${s.id} has no standable foot`);
    assert.ok(out[foot] && back[foot], `${s.id}'s foot is not on the round trip`);
    // The head, on the catwalk, INBOARD of the rail line.
    const head = nodeAt(graph, s.headX + 0.8, PLAN.GANTRY_Y, s.z, { radius: 1.2, yTol: 0.6 });
    assert.notEqual(head, -1, `${s.id} has no standable head at gantry level`);
    assert.ok(out[head], `${s.id} climbs to a head nothing can reach`);
    assert.ok(back[head], `${s.id} cannot be climbed back down`);
    // Every step of the flight is inside the walk budget.
    let worst = 0;
    const n = Math.round(Math.abs(s.headX - s.footX) / PITCH);
    for (let k = 0; k < n; k++) {
      const xa = s.footX + ((s.headX - s.footX) * k) / n;
      const xb = s.footX + ((s.headX - s.footX) * (k + 1)) / n;
      const ya = cols.deckUnder(xa, s.z, PLAN.GANTRY_Y + 1);
      const yb = cols.deckUnder(xb, s.z, PLAN.GANTRY_Y + 1);
      if (ya === null || yb === null) continue;
      worst = Math.max(worst, Math.abs(yb - ya));
    }
    assert.ok(worst <= STEP_UP,
      `${s.id} climbs ${worst.toFixed(2)} m in one ${PITCH} m step, and the body can manage ${STEP_UP}`);
  }

  /* The rail is CONTINUOUS everywhere a stair does not arrive. Sampled along
   * the port run: at gantry height, one step inboard of the rail line, there
   * must be something solid between the walkway and the drop except in the
   * authored gaps. */
  const gaps = [
    ...PLAN.STAIRS.map((s) => s.z),
    ...PLAN.CROSSINGS,
    PLAN.CRANE_RUN.z,
  ];
  let guarded = 0, open = 0;
  for (let z = PLAN.YARD_Z0 + 2; z < PLAN.YARD_Z1 - 2; z += 1.0) {
    if (gaps.some((g) => Math.abs(z - g) < 2.2)) continue;
    const s = cols.spans(-PLAN.GANTRY_X, z);
    const rail = s.some((iv) => iv[0] < PLAN.GANTRY_Y + 1.1 && iv[1] > PLAN.GANTRY_Y + 0.4);
    if (rail) guarded++; else open++;
  }
  assert.equal(open, 0,
    `${open} of ${guarded + open} metres of the port catwalk are unguarded away from any stair or crossing`);
  assert.ok(guarded > 130, `only ${guarded} m of port rail found - the sampler is missing it`);
});

test('the crane cab is a place, not a marker on a beam', async () => {
  /* `Viewpoints` will publish a marker, a prompt and a fast-travel anchor on
   * any platform a world names, whether or not a body can get to it. The
   * fourth viewpoint the design asked for - the Bastion's dorsal rib - is
   * deliberately NOT published for this reason: the Bastion is the next
   * stage's, and a viewpoint on a hull that does not exist is a marker on
   * nothing. These three exist, so these three have to be standable. */
  const { world, graph, out, back } = await measure();
  assert.ok(world.viewpoints.length >= 3, 'the yard publishes fewer than three viewpoints');
  for (const v of world.viewpoints) {
    const id = nodeAt(graph, v.x, v.y, v.z, { radius: 2.0, yTol: 0.8 });
    assert.notEqual(id, -1, `viewpoint "${v.id}" at (${v.x}, ${v.y}, ${v.z}) has no standable surface under it`);
    assert.ok(out[id], `viewpoint "${v.id}" cannot be climbed to`);
    assert.ok(back[id], `viewpoint "${v.id}" cannot be climbed down from`);
  }
  assert.ok(!world.viewpoints.some((v) => v.id === 'bastion-rib'),
    'a viewpoint has been published on a hull the ship stage has not built yet');

  /* The leap of faith. The cab's launch point must have a haystack under it
   * and the drop must be one the soft landing is actually FOR - over the
   * 7.5 m fall-damage threshold, or the leap is just a step. */
  const cab = world.viewpoints.find((v) => v.id === 'crane-cab');
  assert.ok(cab.launch, 'the crane cab publishes no launch point');
  assert.ok(cab.hay, 'the crane cab publishes no haystack');
  const hay = world.haystacks.find((h) => Math.hypot(h.x - cab.hay.x, h.z - cab.hay.z) < 0.5);
  assert.ok(hay, 'the cab names a haystack the world does not publish');
  const drop = cab.launch.y - hay.y;
  assert.ok(drop > FALL_DAMAGE_M,
    `the leap drops ${drop.toFixed(1)} m, under the ${FALL_DAMAGE_M} m the soft landing exists to save you from`);
  const reach = Math.hypot(cab.launch.x - hay.x, cab.launch.z - hay.z);
  assert.ok(reach < hay.r,
    `the hay is ${reach.toFixed(1)} m from the launch point and only ${hay.r} m across - the leap misses it`);

  /* And the line down is EMPTY. A catwalk, a crossing or a hook block between
   * the cab and the hay is a leap that lands on something else. */
  const { cols } = await measure();
  for (let t = 0.05; t < 1; t += 0.05) {
    const x = cab.launch.x + (hay.x - cab.launch.x) * t;
    const z = cab.launch.z + (hay.z - cab.launch.z) * t;
    const y = cab.launch.y + (hay.y - cab.launch.y) * t;
    for (const [a, b] of cols.spans(x, z)) {
      assert.ok(!(y > a + 0.1 && y < b - 0.1),
        `the leap from the crane cab passes through something solid at (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)})`);
    }
  }
});

test('the site office can be walked into from any bearing that is not a wall', async () => {
  /* THE MEDIEVAL PROBE, on the one thing in this world it is the right
   * instrument for. Fifteen bearings from -70 to +70 degrees at three start
   * radii: head-on must work, six of fifteen must work, and every step of the
   * approach must be inside `stepHeight`.
   *
   * Reported as `bearings_passed/15` rather than as a boolean, because a 6/15
   * that used to be 14/15 is a regression you want to see. */
  const { world, colsOpen } = await measure();
  const office = world.enterables.find((e) => e.label === 'yard-office');
  assert.ok(office, 'the yard publishes no site office');
  const door = office.doors[0];

  // The outward normal, taken from the descriptor rather than the layout table.
  let nx = door.position.x - office.origin.x;
  let nz = door.position.z - office.origin.z;
  const nl = Math.hypot(nx, nz);
  assert.ok(nl > 0.5, 'the door is on the origin - there is nothing to aim at');
  nx /= nl; nz /= nl;

  const worstStep = (pts) => {
    let worst = 0;
    let prev = null;
    for (const [x, z] of pts) {
      /* The ceiling is 2.0, not 3.5. The site office's own ROOF is at 3.44,
       * and a probe allowed to see it walks along the roof and reports the
       * threshold as a 3.3 m step — a false RED that looks exactly like a real
       * one. Nothing a body can walk onto around this door is over 2 m. */
      const y = colsOpen.deckUnder(x, z, 2.0, 0.8);
      if (y === null) return Infinity;
      if (prev !== null) worst = Math.max(worst, Math.abs(y - prev));
      prev = y;
    }
    return worst;
  };
  const march = (ox, oz, R) => {
    const pts = [];
    const steps = Math.ceil(R / 0.35);
    for (let k = 0; k <= steps; k++) {
      const t = 1 - k / steps;
      pts.push([door.position.x + nx * 0.4 + ox * R * t, door.position.z + nz * 0.4 + oz * R * t]);
    }
    return worstStep(pts);
  };

  let usable = 0;
  let headOn = false;
  let worstAll = 0;
  const perBearing = [];
  for (let deg = -70; deg <= 70; deg += 10) {
    const a = (deg * Math.PI) / 180;
    const ox = nx * Math.cos(a) + nz * Math.sin(a);
    const oz = nz * Math.cos(a) - nx * Math.sin(a);
    let ok = false;
    let worst = Infinity;
    for (const R of [9, 5, 2.5]) {
      const w = march(ox, oz, R);
      if (w <= STEP_UP) { ok = true; worst = Math.min(worst, w); break; }
    }
    perBearing.push(`${deg}:${ok ? 'ok' : 'blocked'}`);
    if (!ok) continue;
    usable++;
    if (deg === 0) headOn = true;
    worstAll = Math.max(worstAll, worst);
  }
  assert.ok(headOn,
    `the office cannot be approached straight at the door. bearings: ${perBearing.join(' ')}`);
  assert.ok(usable >= 6,
    `only ${usable} of 15 bearings reach the office door - it is walled in. bearings: ${perBearing.join(' ')}`);
  assert.ok(worstAll <= STEP_UP,
    `walking in needs a ${worstAll.toFixed(2)} m step, and the player can climb ${STEP_UP}`);

  /* THE WINDING-HOUSE CLAUSE. `Interiors.js:374` only offers the door when
   * `|player.y - door.position.y| <= 2.6`. The medieval winding house
   * published its door at the sill, 2.03 m over the street, and the prompt
   * never appeared at all - the building was built, glazed, furnished and
   * silently unenterable. `position` must be published at the height the
   * player's FEET are when standing at it. */
  const standY = colsOpen.deckUnder(door.position.x + nx * 1.0, door.position.z + nz * 1.0, 2.0, 0.8);
  assert.ok(standY !== null, 'there is no ground to stand on outside the office door');
  assert.ok(Math.abs(standY - door.position.y) <= 2.6,
    `standing at the office door the feet are at ${standY.toFixed(2)} and the door is published at `
    + `${door.position.y.toFixed(2)} - a ${Math.abs(standY - door.position.y).toFixed(2)} m gap, and the prompt appears within 2.6`);
});

test('you can step over the threshold and be standing on the office floor', async () => {
  /* The approach test stops at the doorway. This one walks THROUGH it, with
   * the door collider excluded and ONLY that one, because the last two risers
   * are the ones a shell never builds: the ground outside, the threshold, and
   * then the interior deck. */
  const { world, colsOpen, graph, out, back, physics, doors } = await measure();
  const office = world.enterables.find((e) => e.label === 'yard-office');
  const door = office.doors[0];
  const dir = Math.sign(office.origin.x - door.position.x) || -1;
  let prev = null;
  let worst = 0;
  for (let t = -2.0; t <= 3.0; t += 0.25) {
    const x = door.position.x + dir * -t;
    // Ceiling 1.4, for the reason in the approach march above: the office roof
    // is at 3.44 and is not something a body walks across on the way in.
    const y = colsOpen.deckUnder(x, door.position.z, 1.4, 0.6);
    assert.ok(y !== null, `no floor at ${t.toFixed(2)} m through the office door`);
    if (prev !== null) worst = Math.max(worst, Math.abs(y - prev));
    prev = y;
  }
  assert.ok(worst <= STEP_UP, `crossing the office threshold needs a ${worst.toFixed(2)} m step`);

  // ...and the inside is on the round trip, not just standable.
  const inside = nodeAt(graph, office.origin.x, 0.12, office.origin.z, { radius: 2, yTol: 0.6 });
  assert.notEqual(inside, -1, 'the office has no standable interior');
  assert.ok(out[inside], 'the office interior cannot be reached from the gateway');
  assert.ok(back[inside], 'the office can be entered and not left');

  // Every collectible spot in every enterable is somewhere a body could be.
  for (const e of world.enterables) {
    for (const s of e.collectibleSpots ?? []) {
      /* Tolerance 0.05, so the probe takes the surface the spot is SITTING ON
       * rather than the highest one under a generous ceiling. A 2.2 m
       * tolerance picked the site office's own roof at 3.44 m for a
       * collectible on a desk at 1.05 m, and then reported that roof as
       * unreachable - a true statement about the wrong surface. */
      /* CROUCH headroom, not standing headroom, and only here.
       *
       * `Columns.decks` requires 1.9 m of clear air before it will call a
       * surface standable, which is right for a route. It is wrong for a
       * COLLECTIBLE, because the Pike's gun bay is 1.50 m by design — the
       * crouch capsule is `1.75 * 0.58 = 1.015 m` and the standing one is 1.75,
       * which is the entire point of the room — so a standing-height probe
       * reports the floor of it as not existing at all and calls a pickup
       * sitting on an ammunition crate a pickup hanging over nothing.
       *
       * The route into that bay is still proved at standing height right up to
       * its hatch, and the crouch itself is proved in `dock-hulls.test.mjs`
       * against both capsules. */
      const crouch = new Columns(physics, { skip: doors, headroom: 1.06 });
      const y = crouch.deckUnder(s.position.x, s.position.z, s.position.y, 0.05);
      assert.ok(y !== null,
        `${e.label}: a collectible at (${s.position.x}, ${s.position.y}, ${s.position.z}) hangs over nothing`);
      const id = nodeAt(graph, s.position.x, y, s.position.z, { radius: 3.5, yTol: 2.0 });
      assert.notEqual(id, -1, `${e.label}: nothing standable near a collectible spot`);
      assert.ok(out[id] && back[id], `${e.label}: a collectible spot is not on the round trip`);
    }
  }
});

test('the berth anchors the ship stage will build on are all walkable to', async () => {
  /* This drop publishes `shipSpecs` and builds no ships. The contract is that
   * a hull dropped onto one of these anchors can be BOARDED, so the anchor's
   * apron - the point a boarding ramp foot lands on - has to be on the round
   * trip before the ramp exists, and the berth footprint has to be clear of
   * anything the derived collision pass would otherwise have to fight. */
  const { world, graph, out, back, physics } = await measure();
  assert.equal(world.shipSpecs.length, 4);
  for (const b of world.shipSpecs) {
    for (const f of ['x', 'z', 'yaw', 'keelY']) {
      assert.ok(Number.isFinite(b[f]), `berth ${b.berth} publishes a non-finite ${f}`);
    }
    assert.ok(b.footprint && b.apron, `berth ${b.berth} publishes no footprint or apron`);
    const id = nodeAt(graph, b.apron.x, b.apron.y, b.apron.z, { radius: 2.5, yTol: 1.0 });
    assert.notEqual(id, -1, `berth ${b.berth}'s apron is not standable`);
    assert.ok(out[id] && back[id], `berth ${b.berth}'s apron is not on the round trip`);
    /* WHERE the apron has to be, and it is two different rules now.
     *
     * On the shop floor it is the keel-line side, because the keel line is the
     * only route through the bay and a boarding point on the far flank is a
     * ramp you walk round a 28 m hull to reach. On a PIER the route is the
     * pier, the pad surrounds the hull on all four sides, and the flank that
     * matters is whichever one `HullPlan.boardSide` derives — so what has to
     * be true out there is that the apron is on the pad at all. A hard rule
     * about the keel line applied to a berth 150 m north of the bay would only
     * be measuring a coordinate that has stopped meaning anything. */
    const plan = PLAN.berthOf(b.id);
    if (plan?.pier) {
      const pier = PLAN.pierOf(plan.pier);
      const pad = PLAN.pierPad(pier);
      assert.ok(Math.abs(b.apron.x - pier.x) <= pier.hw - 0.5,
        `berth ${b.berth}'s apron at x ${b.apron.x} is off the side of ${pier.id}'s pad`);
      assert.ok(b.apron.z < pad.z0 && b.apron.z > pad.z1,
        `berth ${b.berth}'s apron at z ${b.apron.z} is off the end of ${pier.id}'s pad`);
    } else {
      assert.ok(Math.abs(b.apron.x) < Math.abs(b.x),
        `berth ${b.berth}'s apron is further from the keel line than its cradle`);
    }
  }

  /* NO TRIANGLE SOUP ANYWHERE NEAR A HULL. `CitadelWorld.js:71-74` records
   * why: a soup gives the climb probe a surface normal per triangle and makes
   * ledge detection chatter along every seam. The yard collides nothing as a
   * soup today, and this is the assertion that keeps it that way once the
   * hulls arrive. */
  const soups = physics.colliders.filter((c) => c.type === 'mesh');
  assert.equal(soups.length, 0,
    `${soups.length} triangle-soup colliders in a world whose hulls are meant to be free-climbed`);
});

test('nothing a player walks on is built out of a stack of boxes', async () => {
  /* The capsule solver resolves slopes and does NOT step up
   * (`station/Tower.js:527`), so a flight drawn as treads and collided as
   * treads stops the body dead at the first riser. Every flight in this world
   * is drawn as treads over ONE hidden ramp proxy, and the proxies are named
   * and flagged rather than merely invisible, because `visible` belongs to the
   * renderer - the boot shader rehearsal clears it across a whole world group
   * for three frames, and anything identifying a proxy by `visible === false`
   * finds none at all inside that window. */
  const { world, physics } = await built();
  const { RAMP_PROXY_FLAG, rampProxiesIn } = await import('../../src/worlds/station/StationKit.js');
  const proxies = rampProxiesIn(world.group);
  assert.ok(proxies.length >= 12,
    `only ${proxies.length} ramp proxies - the yard has two gantry flights, one crane run, one signal-post flight, three trench ramps and four berth stairs`);
  for (const p of proxies) {
    assert.equal(p.userData[RAMP_PROXY_FLAG], true);
    assert.equal(p.visible, false, 'a ramp proxy is being drawn');
  }
  // Every proxy is tilted: a proxy with no pitch is a flat slab, not a flight.
  let tilted = 0;
  for (const p of proxies) {
    p.updateWorldMatrix(true, false);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(p.getWorldQuaternion(new THREE.Quaternion()));
    if (up.y < 0.999) tilted++;
  }
  assert.equal(tilted, proxies.length, `${proxies.length - tilted} ramp proxies are flat`);
  assert.ok(physics.colliders.length <= 1400,
    `${physics.colliders.length} colliders against a budget of 1400`);
});

/* ================================================================== */
/* What the world HIDES, and whether a body can get to it              */
/* ================================================================== */

/**
 * `Relics` and `Caches` place themselves off published fields, driven here
 * against the real built world rather than against a description of it.
 *
 * ── Why this block exists ─────────────────────────────────────────────────
 * It is the assertion `citadel-reach.test.mjs:2194` makes and this file did
 * not: "every relic and cache site is in the reachable component". Without it,
 * three separate defects were live in this world at once while every one of
 * the yard's other 77 tests was green:
 *
 *   - ZERO caches. `Caches._findHigh` darts from y 320 and takes the first
 *     hit, which under a 172 x 162 m roof plate is the roof, every time: 400
 *     of 400 darts landed at 26.80, `sheer` was 0 on all of them and the world
 *     placed nothing at all - silently, because the `[Caches]` log line only
 *     prints when something landed. `CACHE_TABLES.dock` is the only in-world
 *     source of `alloy_scrap`, `hull_plate` and `laser_cell` while
 *     `hostiles: false`, so that alone made quest 54 step 1 impossible and
 *     blocked 55-60 behind it, the launch included.
 *   - Four relics on top of that same roof, 18.8 m above the catwalk with the
 *     roof slab itself as the ceiling in between.
 *   - Four more three metres out over open air, because the corner anchors
 *     moved INBOARD of `GANTRY_X` - which is the catwalk's inner edge, not its
 *     centre line.
 *
 * All eight of those pass "a relic exists", "a table exists" and "a field is
 * published". None of them passes "a body can stand within `PICKUP_R` of it,
 * having walked there from the gateway, and walk back".
 */

const { Relics } = await import('../../src/systems/Relics.js');
const { Caches } = await import('../../src/systems/Caches.js');

/** `Relics.PICKUP_R`. Not exported; pinned here and quoted in every message. */
const PICKUP_R = 2.0;
/**
 * The tallest continuous free climb a full stamina bar buys, metres.
 * `DRAIN_UP = 5.4`/s against a 100 bar climbing at 2.05 m/s (`FreeClimb.js`).
 */
const CLIMB_BUDGET = 13.7;
/**
 * How far from a relic the ground a climb STARTS on may be, metres.
 *
 * Set by the widest thing in the yard rather than by taste: the Bastion is
 * 16 m in the beam, so a body climbing to a relic on her spine starts 8-9 m
 * away from it horizontally.
 */
const CLIMB_REACH = 12;

let _placed = null;
async function placed() {
  if (_placed) return _placed;
  const { world, physics } = await built();
  const relics = new Relics({ bus: null, physics, player: null, scene: new THREE.Scene(), inventory: null });
  relics._onWorld('dock', world);
  /* The loot stub records what each site was stocked with, which is the only
   * way to see `CACHE_TABLES.dock` from outside - it is a module const and is
   * deliberately not exported. */
  const stocked = [];
  const caches = new Caches({
    bus: null, physics, player: null, worldManager: null, waterVolumes: null,
    loot: { spawn: (pos, contents) => { stocked.push({ pos, contents }); return { pos, contents }; } },
  });
  caches._onWorld('dock', world);
  _placed = { relics: relics.sites, caches: caches.sites, stocked, cacheSystem: caches };
  return _placed;
}

/** The nearest round-trip-reachable standing position to a world point. */
function nearestRoundTrip(graph, out, back, p, reach = 4) {
  let best = Infinity;
  for (let n = 0; n < graph.nodes.length; n++) {
    if (!(out[n] && back[n])) continue;
    const nd = graph.nodes[n];
    if (Math.abs(nd.x - p.x) > reach || Math.abs(nd.z - p.z) > reach) continue;
    // The body's centre is 0.9 m over its feet; a pickup is measured to it.
    const d = Math.hypot(nd.x - p.x, nd.z - p.z, nd.y + 0.9 - p.y);
    if (d < best) best = d;
  }
  return best;
}

test('every relic in the yard is standing on something, and nothing is buried in a hull', async () => {
  /* Two floors, and they catch different things. The first is physical: is
   * there a surface within arm's reach at all? That is what the four mid-air
   * gantry-corner relics failed - measured at 3.27 m from the nearest body
   * position against a 2.0 m pickup radius, and 3.33 m from the nearest
   * surface of any kind. The second is the citadel's own defect, which
   * `Relics` grew `anchor` to fix: a relic at a footprint CENTRE ends up
   * inside whatever stands on that footprint. There is a ship bolted to every
   * cradle in this world, and berth two's site measured (34, 2.15, -2), inside
   * a solid spanning [2.00, 2.60] - the Dray's belly plating. */
  const { cols } = await measure();
  const { relics } = await placed();
  assert.ok(relics.length >= 24, `only ${relics.length} relic sites placed`);

  const noFooting = [];
  const buried = [];
  for (const s of relics) {
    const p = s.pos;
    let best = Infinity;
    for (let dx = -3; dx <= 3; dx += 0.25) {
      for (let dz = -3; dz <= 3; dz += 0.25) {
        for (const d of cols.decks(p.x + dx, p.z + dz)) {
          best = Math.min(best, Math.hypot(dx, dz, d + 0.9 - p.y));
        }
      }
    }
    if (best > PICKUP_R) {
      noFooting.push(`(${p.x.toFixed(1)}, ${p.y.toFixed(2)}, ${p.z.toFixed(1)}) nearest footing ${best.toFixed(2)} m`);
    }
    for (const span of cols.spans(p.x, p.z)) {
      if (p.y > span[0] && p.y < span[1]) {
        buried.push(`(${p.x.toFixed(1)}, ${p.y.toFixed(2)}, ${p.z.toFixed(1)}) inside [${span[0].toFixed(2)}, ${span[1].toFixed(2)}]`);
      }
    }
  }
  assert.deepEqual(noFooting, [],
    `floor: 0 relics with no footing inside PICKUP_R = ${PICKUP_R} m. achieved: ${noFooting.length} of ${relics.length}\n  `
    + noFooting.join('\n  '));
  assert.deepEqual(buried, [],
    `floor: 0 relics inside a solid. achieved: ${buried.length} of ${relics.length}\n  ` + buried.join('\n  '));
});

test('the relics are reached by walking, except the ones that are reached by climbing', async () => {
  /* The footing test above cannot catch a relic on the SHED ROOF: the roof is
   * a real surface with infinite headroom over it, so a body standing there
   * would be standing on something. What catches it is this - the walk graph
   * the rest of this file is built on, plus the one honest exception.
   *
   * The exception is real and is not a loophole: this world puts relics on
   * hull crowns and on the office roof deliberately, and `spineAccess` already
   * records which hulls are climbs rather than walks. So a relic off the walk
   * graph has to be a CLIMB - a round-trip standing position within 12 m
   * horizontally, no further below the relic than one full stamina bar of
   * continuous free climb. The four roof relics failed exactly that: the
   * nearest thing a body could walk to was the catwalk 18.4-18.5 m below,
   * against a 13.7 m budget, with the roof slab in between - and note that it
   * is the BUDGET that catches them, not the horizontal window, which is why
   * the window can afford to be generous. 12 m and not 6 because the Bastion
   * is 16 m in the beam: the ground a body starts her climb from is 8-9 m out
   * from the spine the relic sits on, and a 6 m window called that stranded.
   *
   * Quoted rather than asserted as a boolean, because a walkable count that
   * slides from 26 to 20 is a regression even while the test stays green. */
  const { graph, out, back } = await measure();
  const { relics } = await placed();
  const walked = [];
  const climbs = [];
  const stranded = [];
  for (const s of relics) {
    const p = s.pos;
    if (nearestRoundTrip(graph, out, back, p, 3) <= PICKUP_R) { walked.push(p); continue; }
    // Not a walk. Is it a climb from somewhere a walk reaches?
    let bestRise = Infinity;
    let bestAt = null;
    for (let n = 0; n < graph.nodes.length; n++) {
      if (!(out[n] && back[n])) continue;
      const nd = graph.nodes[n];
      if (Math.hypot(nd.x - p.x, nd.z - p.z) > CLIMB_REACH) continue;
      const rise = p.y - 0.55 - nd.y;
      if (rise < bestRise) { bestRise = rise; bestAt = nd; }
    }
    if (bestAt && bestRise <= CLIMB_BUDGET) climbs.push({ p, rise: bestRise });
    else {
      stranded.push(`(${p.x.toFixed(1)}, ${p.y.toFixed(2)}, ${p.z.toFixed(1)}) - `
        + (bestAt
          ? `${bestRise.toFixed(1)} m of climb from the nearest walkable ground, budget ${CLIMB_BUDGET}`
          : `no walkable ground within ${CLIMB_REACH} m`));
    }
  }
  assert.deepEqual(stranded, [],
    `floor: every relic is a walk or a climb. achieved: ${walked.length} walked, ${climbs.length} climbed, `
    + `${stranded.length} stranded of ${relics.length}\n  ` + stranded.join('\n  '));
  assert.ok(walked.length >= 24,
    `floor: 24 of ${relics.length} relics reachable on foot. achieved: ${walked.length}. `
    + `climbs (rise from the nearest walkable ground): ${climbs.map((c) => c.rise.toFixed(1)).join(', ')}`);
  assert.ok(climbs.length <= 6,
    `ceiling: 6 climb-only relics. achieved: ${climbs.length} - a world where the relics are mostly climbs `
    + 'is a world where most of them are proved by nothing');
});

test('the yard places its caches, stocks them from its own table, and they are reachable', async () => {
  /* `PER_WORLD.high` is 3 and the yard's extent does not scale it up, so three
   * is the whole of it. Before the yard published `cacheSites` this was ZERO -
   * see the block header. The stock assertion is the other half: a cache that
   * lands but rolls the station's table is the silent-fallback defect, and the
   * three items named here are the ones the dock quest line collects. */
  const { graph, out, back } = await measure();
  const { caches, stocked, cacheSystem } = await placed();
  assert.ok(caches.length >= 3,
    `floor: 3 cache sites. achieved: ${caches.length}. `
    + '(A roofed world cannot dart for its own: every dart lands on the roof.)');

  const far = [];
  for (const s of caches) {
    const d = nearestRoundTrip(graph, out, back, s.pos, 4);
    if (d > PICKUP_R) {
      far.push(`${s.kind} at (${s.pos.x.toFixed(1)}, ${s.pos.y.toFixed(2)}, ${s.pos.z.toFixed(1)})`
        + ` - nearest round trip ${d === Infinity ? 'none' : `${d.toFixed(2)} m`}`);
    }
  }
  assert.deepEqual(far, [],
    `floor: every cache is on the round trip within ${PICKUP_R} m. achieved: ${caches.length - far.length} of ${caches.length}\n  `
    + far.join('\n  '));

  /* Every placed site was actually stocked, through the real `_stock`. */
  assert.equal(stocked.length, caches.length,
    `${caches.length} cache sites but ${stocked.length} of them were stocked`);

  /* And what the table can produce, rolled two hundred times.
   *
   * `_stock` rolls with `Math.random` on purpose - a restock should not be the
   * same box twice - so the union of ONE session's three sites is a sample and
   * not a statement about the table: `laser_cell` is absent from all three
   * about one run in twenty. The real code path, driven enough times to be an
   * assertion about `CACHE_TABLES.dock` rather than about a coin. */
  const items = new Set();
  for (let i = 0; i < 200; i++) for (const c of cacheSystem._roll()) items.add(c.itemId);
  for (const id of ['alloy_scrap', 'hull_plate', 'laser_cell']) {
    assert.ok(items.has(id),
      `nothing in the yard's caches is ${id}, which no other source in this world produces `
      + `(hostiles are off). stocked: ${[...items].join(', ') || 'nothing'}`);
  }
  for (const id of ['bullet', 'nexus_shard', 'arrow']) {
    assert.ok(!items.has(id), `a cache in the yard rolled ${id} - the station table is back`);
  }
});
