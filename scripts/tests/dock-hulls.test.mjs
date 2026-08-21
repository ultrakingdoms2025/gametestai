import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

/**
 * THE FOUR HULLS: CAN A BODY GET IN, GET OUT, AND GET ON TOP?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THIS FILE EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "A ship you can see into and cannot get into" is risk one of this world, and
 * it is this project's signature defect: fifteen of fifty-four medieval
 * enterables could not be entered past a 1,074-test suite, and the station
 * built, glazed and railed a hangar mezzanine that nothing could reach. The
 * entire feature of this drop is the INSIDES of four buildings, so the whole of
 * it is one question asked four ways.
 *
 * Four properties, and none of them is "was it built":
 *
 * 1. **IN AND OUT.** Every compartment is flooded to from the point the gateway
 *    actually puts a body, on foot, with no jump and no climb, and then flooded
 *    to BACKWARDS. A cockpit you can enter and not leave is a soft lock, and
 *    the reverse flood is the only thing that catches one.
 * 2. **THE PROMPT APPEARS.** `Interiors.js:374` only offers a hatch when
 *    `|player.y - door.position.y| <= 2.6` and the horizontal distance is under
 *    3.0. The medieval winding house published its door at the sill, 2.03 m
 *    over the street, and its prompt therefore never appeared at all: built,
 *    glazed, furnished, silently unenterable.
 * 3. **THE COMPARTMENT IS NOT FULL OF THE STRUCTURE THAT DESCRIBES IT.** The
 *    fourth occurrence of the full-plan-box family, and ship interiors are made
 *    of nothing but the members that trigger it — frames, stringers, deck beams
 *    and cable trays. It will NOT be caught by a headroom probe, because those
 *    members have no colliders and a headroom probe probes colliders.
 * 4. **THE CLIMB IS REAL.** "Climb on top of the ship" is a collision
 *    constraint, not a wish. Every band on every hull is driven against the
 *    actual `FreeClimb` fan and the actual `Climb` mantle window, using the
 *    world's own `physics.raycast` and `physics.resolveCapsule` rather than a
 *    re-derivation of them.
 *
 * Every number below is quoted as floor/achieved rather than asserted as a
 * boolean, because a 6-of-15 that used to be 14-of-15 is a regression you want
 * to see and `false` is not.
 */

/* ================================================================== */
/* The envelope — measured, not computed                               */
/* ================================================================== */

/** `CONFIG.player.stepHeight`. */
const STEP_UP = 0.45;
/** The tallest drop an edge may use. A route that costs health is not a route. */
const DROP_MAX = 3.0;
/** `CONFIG.player.height`, and the crouch is `x 0.58`. */
const STAND_H = 1.75;
const CROUCH_H = 1.75 * 0.58;
const RADIUS = 0.35;
/** Standing room: the capsule plus 15 cm. */
const HEADROOM = 1.9;
/** Crouch room: the tucked capsule plus 5 cm. */
const CROUCH_ROOM = CROUCH_H + 0.05;
/**
 * Lattice pitch. 0.5 and not 1.0, for `dock-reach`'s reason: the yard's flights
 * run at 35 degrees, so a 1.0 m step gains 0.70 m and the graph would report
 * every stair in the world impassable — a false RED, which is the most
 * misleading kind. The Dray's cargo ramp at 19 degrees gains 0.17 m per step
 * and the Pike's access scaffold at 36 gains 0.36.
 */
const PITCH = 0.5;
const MERGE = 0.02;

/* `player/FreeClimb.js` */
const GRIP_H = 1.62 * 0.72;      // eye height x 0.72 = 1.1664
const GRIP_REACH = RADIUS + 0.62; // P.radius + REACH = 0.97
const WALL_NORMAL_Y = 0.5;
/* `player/Climb.js` */
const TOP_NORMAL_Y = 0.7;
const LAND_INSET = 0.42;
const MANTLE_MAX = 2.4;
const MANTLE_MIN_GROUND = 1.0;
const MANTLE_MIN_CLIMB = 0.25;
const MANTLE_HEADROOM = STAND_H - 0.2;   // 1.55
const _UP = new THREE.Vector3(0, 1, 0);

/* ================================================================== */
/* A world, built without a browser                                    */
/* ================================================================== */

function harness() {
  if (globalThis.__dockHullsHarness) return;
  globalThis.__dockHullsHarness = true;
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
  const t0 = Date.now();
  await world.build(() => {});
  _built = { world, physics, buildMs: Date.now() - t0 };
  return _built;
}

/** Local (ship frame) -> world, matching `GeoBatch.localAt` and `ShipBuild.P`. */
function P(berth, lx, ly, lz) {
  const c = Math.cos(berth.yaw), s = Math.sin(berth.yaw);
  return new THREE.Vector3(
    berth.x + lx * c + lz * s,
    berth.cradleTop + ly,
    berth.z - lx * s + lz * c
  );
}
/** The local +X axis of a hull, in world space. Outward on the starboard flank. */
function axisX(berth) {
  return new THREE.Vector3(Math.cos(berth.yaw), 0, -Math.sin(berth.yaw));
}

/* ================================================================== */
/* The column index and the walk graph                                 */
/* ================================================================== */

class Columns {
  constructor(physics, { skip = new Set(), headroom = HEADROOM } = {}) {
    this.headroom = headroom;
    this.cell = 6;
    this.grid = new Map();
    this.unhandled = [];
    const inv = new THREE.Matrix4();
    for (const c of physics.colliders) {
      if (!c.solid) continue;
      if ((c.layer & COLLISION_LAYER.WORLD) === 0) continue;
      if (skip.has(c)) continue;
      if (c.type !== 'box') { this.unhandled.push(c); continue; }
      inv.copy(c.matrix).invert();
      const m = c.matrix.elements;
      const h = c.halfExtents;
      const b = {
        inv: inv.clone(), h: h.clone(),
        x: m[12], y: m[13], z: m[14],
        ax: Math.abs(m[0]) * h.x + Math.abs(m[4]) * h.y + Math.abs(m[8]) * h.z,
        az: Math.abs(m[2]) * h.x + Math.abs(m[6]) * h.y + Math.abs(m[10]) * h.z,
      };
      const x0 = Math.floor((b.x - b.ax) / this.cell), x1 = Math.floor((b.x + b.ax) / this.cell);
      const z0 = Math.floor((b.z - b.az) / this.cell), z1 = Math.floor((b.z + b.az) / this.cell);
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
   * The vertical interval a Y line at (x, z) spends inside one box.
   *
   * Slab clipping in the BOX's own space, exact for any orientation, which is
   * not optional here: every ramp proxy in this world carries a pitch about X
   * as well as a yaw, and reading one as a yawed box would give each flight a
   * flat top at the height of its own centre — a floating slab halfway up.
   */
  _span(b, x, z) {
    const e = b.inv.elements;
    const px = e[0] * x + e[8] * z + e[12];
    const py = e[1] * x + e[9] * z + e[13];
    const pz = e[2] * x + e[10] * z + e[14];
    const dx = e[4], dy = e[5], dz = e[6];
    let t0 = -Infinity, t1 = Infinity;
    const slab = (p, d, h) => {
      if (Math.abs(d) < 1e-9) return p >= -h && p <= h;
      const a = (-h - p) / d, c = (h - p) / d;
      const lo = Math.min(a, c), hi = Math.max(a, c);
      if (lo > t0) t0 = lo;
      if (hi < t1) t1 = hi;
      return t0 <= t1;
    };
    if (!slab(px, dx, b.h.x)) return null;
    if (!slab(py, dy, b.h.y)) return null;
    if (!slab(pz, dz, b.h.z)) return null;
    return t1 > t0 ? [t0, t1] : null;
  }

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

  /** Every standable surface over a column, and the clear height over each. */
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

  /** Clear height over the surface nearest `y`, or 0 where there is none. */
  clearAt(x, z, y, tol = 0.5) {
    const s = this.spans(x, z);
    for (let i = 0; i < s.length; i++) {
      if (Math.abs(s[i][1] - y) > tol) continue;
      const ceil = i + 1 < s.length ? s[i + 1][0] : Infinity;
      return ceil - s[i][1];
    }
    return 0;
  }
}

function buildGraph(cols, bounds) {
  const { x0, x1, z0, z1 } = bounds;
  const nx = Math.round((x1 - x0) / PITCH) + 1;
  const nz = Math.round((z1 - z0) / PITCH) + 1;
  const decks = new Array(nx * nz).fill(null);
  const ids = new Map();
  const nodes = [];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const x = x0 + i * PITCH, z = z0 + j * PITCH;
      const d = cols.decks(x, z).filter((y) => y > -8 && y < 20);
      if (!d.length) continue;
      decks[i * nz + j] = d;
      for (let k = 0; k < d.length; k++) { ids.set(`${i}:${j}:${k}`, nodes.length); nodes.push({ i, j, k, x, z, y: d[k] }); }
    }
  }
  const fwd = nodes.map(() => []);
  const rev = nodes.map(() => []);
  for (let n = 0; n < nodes.length; n++) {
    const a = nodes[n];
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const bi = a.i + di, bj = a.j + dj;
      if (bi < 0 || bj < 0 || bi >= nx || bj >= nz) continue;
      const bd = decks[bi * nz + bj];
      if (!bd) continue;
      for (let k = 0; k < bd.length; k++) {
        const dy = bd[k] - a.y;
        if (dy > STEP_UP || -dy > DROP_MAX) continue;
        const m = ids.get(`${bi}:${bj}:${k}`);
        if (m !== undefined) { fwd[n].push(m); rev[m].push(n); }
      }
    }
  }
  return { nodes, ids, fwd, rev, x0, z0 };
}

function flood(graph, from, edges) {
  const seen = new Uint8Array(graph.nodes.length);
  if (from < 0) return seen;
  const q = [from];
  seen[from] = 1;
  for (let h = 0; h < q.length; h++) for (const m of edges[q[h]]) if (!seen[m]) { seen[m] = 1; q.push(m); }
  return seen;
}

function nodeAt(graph, x, y, z, { radius = 2.0, yTol = 1.0 } = {}) {
  let best = -1, bestD = Infinity;
  const i0 = Math.round((x - graph.x0) / PITCH), j0 = Math.round((z - graph.z0) / PITCH);
  const r = Math.ceil(radius / PITCH);
  for (let di = -r; di <= r; di++) {
    for (let dj = -r; dj <= r; dj++) {
      for (let k = 0; k < 8; k++) {
        const id = graph.ids.get(`${i0 + di}:${j0 + dj}:${k}`);
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

let _m = null;
async function measure() {
  if (_m) return _m;
  const { world, physics, buildMs } = await built();

  /* The doors are excluded, and ONLY the doors. `Interiors._onWorld` sets
   * `d.collider.solid = true` on every world change and clears it while the
   * leaf swings, so a shut hatch is solid to the capsule and open to the
   * player. A probe that respected it would report every interior in the game
   * as unreachable; one that dropped every thin collider would report walls as
   * doorways. */
  const doors = new Set();
  for (const e of world.enterables) for (const d of e.doors ?? []) if (d.collider) doors.add(d.collider);

  const cols = new Columns(physics, { skip: doors });
  const crouchCols = new Columns(physics, { skip: doors, headroom: CROUCH_ROOM });
  /* The lattice has to reach the PIERS. Three of the four hulls stand on decks
   * north of the old north wall now — the furthest 76 m out past it — so a
   * graph that stopped at `YARD_Z0` floods a bay with one hulk in it and
   * reports every ramp foot, every compartment and the Dray's brow as
   * unreachable while the world is perfectly fine. Same fix, same reason, as
   * `dock-reach.test.mjs`. */
  const zFar = Math.min(PLAN.YARD_Z0, ...PLAN.PIERS.map((p) => PLAN.pierPad(p).z1));
  const bounds = {
    x0: -PLAN.YARD_X + 0.5, x1: PLAN.YARD_X - 0.5,
    z0: zFar + 0.5, z1: PLAN.YARD_Z1 - 0.5,
  };
  const graph = buildGraph(cols, bounds);
  const crouchGraph = buildGraph(crouchCols, bounds);

  const spec = world.portalSpecs.find((s) => s.target === 'station');
  const rotY = spec.rotationY ?? 0;
  const arrival = {
    x: spec.position.x + Math.sin(rotY) * 2.6,
    y: spec.position.y,
    z: spec.position.z + Math.cos(rotY) * 2.6,
  };
  const start = nodeAt(graph, arrival.x, cols.decks(arrival.x, arrival.z)[0] ?? 0, arrival.z, { radius: 3, yTol: 1.5 });
  const cStart = nodeAt(crouchGraph, arrival.x, 0.12, arrival.z, { radius: 3, yTol: 1.5 });

  _m = {
    world, physics, cols, crouchCols, graph, crouchGraph, arrival, buildMs,
    out: flood(graph, start, graph.fwd),
    back: flood(graph, start, graph.rev),
    cOut: flood(crouchGraph, cStart, crouchGraph.fwd),
    cBack: flood(crouchGraph, cStart, crouchGraph.rev),
  };
  return _m;
}

/** Every compartment on every hull, as a world-space probe point. */
function compartments(world) {
  const out = [];
  for (const b of PLAN.BERTHS) {
    const H = HULL.HULLS[b.id];
    for (const r of H.rooms ?? []) {
      const lz = (r.z0 + r.z1) / 2;
      out.push({
        ship: b.id, room: r.id, berth: b,
        hull: H, spec: r,
        at: P(b, 0, r.floorY + 0.05, lz),
        clear: r.ceilY - r.floorY,
      });
    }
  }
  return out;
}

/* ================================================================== */
/* 1. The probe is sound                                               */
/* ================================================================== */

test('the probe sees four hulls, and every one of them is boxes', async () => {
  /* THE GUARD ON EVERY OTHER TEST IN THIS FILE. An index that quietly stopped
   * seeing hull colliders would report an empty graph and every reach test
   * below would go GREEN by finding no obstacles at all. */
  const { world, physics, cols, graph } = await measure();
  assert.equal(world.shipSpecs.length, 4);
  assert.equal(world.ships.length, 3,
    `${world.ships.length} customisable hulls published - the Bastion is a hulk and sells nothing`);

  /* Every enterable label is UNIQUE. The collected tag is
   * `interior:dock:${label}#${i}` (`Interiors.js:91`), so two hulls sharing a
   * label share tags and one of them silently loses its loot - which is a
   * defect nobody notices until a player wonders why the Pike is empty. */
  const labels = world.enterables.map((e) => e.label);
  assert.equal(new Set(labels).size, labels.length,
    `two enterables share a label and therefore share collectible tags: ${labels.join(', ')}`);

  /* And the route onto each spine is declared, once each. `dock-reach` trusts
   * `spineAccess` to decide which spines it floods to, so a hull quietly
   * relabelled 'climb' would remove itself from that probe rather than fail it
   * - which is the one way a data-driven test can be turned off by accident. */
  const access = world.shipSpecs.map((sp) => sp.spineAccess);
  assert.equal(access.filter((a) => a === 'scaffold').length, 1,
    `${access.filter((a) => a === 'scaffold').length} hulls claim a yard access scaffold; the Pike has the only one`);
  assert.equal(access.filter((a) => a === 'brow').length, 1,
    `${access.filter((a) => a === 'brow').length} hulls claim a brow off the gantry; the Dray has the only one`);
  assert.equal(access.filter((a) => a === 'climb').length, 2,
    'the Kestrel and the Bastion are the two hulls whose crowns are climb-only');
  assert.equal(cols.unhandled.length, 0,
    `${cols.unhandled.length} colliders are not boxes; this index cannot represent them and would ignore them`);

  /* NO TRIANGLE SOUP, and now it matters rather than being a promise.
   * `CitadelWorld.js:71-74`: a soup gives the climb probe a surface normal per
   * triangle and makes ledge detection chatter along every seam. These hulls
   * are the things being climbed. */
  const soups = physics.colliders.filter((c) => c.type === 'mesh');
  assert.equal(soups.length, 0,
    `${soups.length} triangle-soup colliders in a world whose hulls are meant to be free-climbed`);

  assert.ok(physics.colliders.length > 250,
    `only ${physics.colliders.length} colliders - the hulls did not build`);
  assert.ok(physics.colliders.length <= 1400,
    `${physics.colliders.length} colliders against a budget of 1400`);
  assert.ok(graph.nodes.length > 60000, `the walk graph has only ${graph.nodes.length} nodes`);

  // Each hull really is where its berth says, and really is solid there.
  for (const b of PLAN.BERTHS) {
    const H = HULL.HULLS[b.id];
    const p = P(b, 0, 0, 0);
    const s = cols.spans(p.x, p.z);
    const crown = b.cradleTop + H.spine.y;
    assert.ok(s.some((iv) => Math.abs(iv[1] - crown) < 0.25 || (iv[0] < crown && iv[1] > crown - 0.3)),
      `nothing solid at ${b.id}'s crown height ${crown.toFixed(2)}; column reads ${JSON.stringify(s)}`);
  }
});

/* ================================================================== */
/* 2. In and out                                                       */
/* ================================================================== */

test('every compartment on every hull can be walked into AND back out of', async () => {
  /* THE HEADLINE, and the assertion the medieval expansion did not have.
   * Reported as a table so a regression is a named compartment going missing
   * rather than `false`.
   *
   * Forward AND backward, because they are different questions: the forward
   * flood allows a 3 m drop, so a compartment you fall into and cannot climb
   * out of passes the first and fails the second. */
  const { world, graph, crouchGraph, out, back, cOut, cBack } = await measure();
  const rooms = compartments(world);
  const failures = [];
  const table = [];
  for (const c of rooms) {
    /* A compartment under `HEADROOM` is a CROUCH space and is flooded on the
     * crouch graph. That is not a relaxation: the Pike's gun bay is 1.50 m by
     * design, the crouch capsule is 1.015 m and the standing one is 1.75, so a
     * standing probe reports its floor as not existing at all. */
    const crouch = c.clear < HEADROOM;
    const g = crouch ? crouchGraph : graph;
    const o = crouch ? cOut : out;
    const bk = crouch ? cBack : back;
    const id = nodeAt(g, c.at.x, c.at.y, c.at.z, { radius: 1.6, yTol: 0.6 });
    const tag = `${c.ship}/${c.room}${crouch ? ' (crouch)' : ''}`;
    if (id === -1) { failures.push(`${tag}: nothing standable inside it at all`); continue; }
    if (!o[id]) { failures.push(`${tag}: BUILT but cannot be entered from the gateway`); continue; }
    if (!bk[id]) { failures.push(`${tag}: can be entered and NOT left - a soft lock`); continue; }
    table.push(`${tag} ok`);
  }
  assert.deepEqual(failures, [],
    `${failures.length} of ${rooms.length} compartments fail the walk:\n  ${failures.join('\n  ')}\n`
    + `passing: ${table.join(', ')}`);
  assert.ok(rooms.length >= 8,
    `only ${rooms.length} compartments probed - the three fitted hulls carry eight between them`);
});

test('no hull hides a room nothing can walk to', async () => {
  /* THE INVERSE OF THE HEADLINE, and the half that catches a different mistake.
   *
   * A plated section with nothing inside it is a hollow box with a floor, a
   * ceiling and two metres of headroom. Every walk probe in this repo is RIGHT
   * to call that standable — and it is invisible to a player, permanently
   * unreachable, and a false positive sitting inside the one class of test this
   * project most needs to trust. The Bastion's two sections and the Kestrel's
   * dorsal fairing are each about 300 cubic metres of exactly that shape.
   *
   * So: sample every hull's own volume on a 1 m lattice, and demand that every
   * standable surface found in there is either inside a DECLARED compartment or
   * on the round trip. Anything else is a room the world does not know it has.
   */
  const { world, cols, graph, out, back } = await measure();
  const orphans = [];
  let sampled = 0, inRoom = 0, walkable = 0;

  for (const b of PLAN.BERTHS) {
    const H = HULL.HULLS[b.id];
    const rooms = H.rooms ?? [];
    const hw = H.lower.hw, z0 = H.lower.z0, z1 = H.lower.z1;
    for (let lx = -hw + 0.5; lx <= hw - 0.5; lx += 1.0) {
      for (let lz = z0 + 0.5; lz <= z1 - 0.5; lz += 1.0) {
        const w = P(b, lx, 0, lz);
        const col = cols.spans(w.x, w.z);
        for (let i = 0; i < col.length; i++) {
          const y = col[i][1];
          // Only the hull's own height band: the shed floor under it and the
          // catwalk over it are the yard's business, not this test's.
          const ly = y - b.cradleTop;
          if (ly < H.belly.y0 - 0.05 || ly > H.spine.y + 0.05) continue;
          if (!cols.decks(w.x, w.z).some((d) => Math.abs(d - y) < 1e-6)) continue;
          /* ENCLOSED only. A hull's ledges and its dorsal spine are standable
           * surfaces inside its own footprint that a walk graph will never
           * reach, because they are reached by CLIMBING - and `dock-reach` and
           * the band test above own that. What this test is for is a surface
           * with a hull ceiling over it: a room. Anything with open air above
           * it up to the crown is weather deck. */
          const ceil = i + 1 < col.length ? col[i + 1][0] : Infinity;
          if (ceil - b.cradleTop > H.spine.y + 0.2) continue;
          sampled++;
          const room = rooms.some((r) =>
            Math.abs(lx) <= r.hw + 0.6 && lz >= r.z0 - 0.6 && lz <= r.z1 + 0.6
            && Math.abs(ly - r.floorY) < 0.4);
          if (room) { inRoom++; continue; }
          const id = nodeAt(graph, w.x, y, w.z, { radius: 1.2, yTol: 0.4 });
          if (id !== -1 && out[id] && back[id]) { walkable++; continue; }
          orphans.push(`${b.id}: a standable surface at local (${lx.toFixed(1)}, ${ly.toFixed(2)}, ${lz.toFixed(1)}) `
            + 'is in no declared compartment and on no route');
        }
      }
    }
  }
  assert.deepEqual(orphans.slice(0, 12), [],
    `${orphans.length} hidden standable surfaces inside the hulls `
    + `(of ${sampled} sampled: ${inRoom} in declared compartments, ${walkable} on the round trip):\n  `
    + orphans.slice(0, 12).join('\n  '));
  /* The guard, and the number is the one that came back the first time this ran
   * against the finished hulls: 168 enclosed standable surfaces across four of
   * them, 141 of which are declared compartment floors. A probe that finds
   * nothing reports no orphans, so a collapse here has to be a failure rather
   * than a pass. */
  assert.ok(sampled >= 140,
    `only ${sampled} enclosed surfaces sampled inside four hulls - the lattice has stopped finding them`);
  assert.ok(inRoom >= 120,
    `only ${inRoom} of ${sampled} enclosed surfaces are declared compartment floors`);
});

test('every hatch offers its prompt to a body standing at it', async () => {
  /* THE WINDING-HOUSE CLAUSE, for hatches rather than for a hut door.
   * `Interiors.js:374-376` offers a door only when `|player.y -
   * door.position.y| <= 2.6` and the horizontal distance is under 3.0. The
   * medieval winding house published its door at the sill, 2.03 m over the
   * street, so its prompt never appeared and the building was silently
   * unenterable. `position` must be at the height the FEET are — on the ramp
   * head, not at the hull origin. */
  const { world, cols, crouchCols } = await measure();
  const hatches = [];
  for (const e of world.enterables) for (const d of e.doors ?? []) hatches.push({ e, d });
  assert.ok(hatches.length >= 4,
    `only ${hatches.length} hatches in the yard - the office, the Kestrel, the Dray x2 and the Pike make five`);

  const worst = [];
  for (const { e, d } of hatches) {
    // The outward normal, from the descriptor rather than from a layout table.
    let nx = d.position.x - e.origin.x;
    let nz = d.position.z - e.origin.z;
    const nl = Math.hypot(nx, nz);
    assert.ok(nl > 0.3, `${e.label}/${d.id}: the hatch is on the hull origin - there is nothing to aim at`);
    nx /= nl; nz /= nl;
    // A body standing one metre outside it, on whatever it stands on.
    let stand = null;
    for (const r of [0.8, 1.2, 1.8]) {
      const x = d.position.x + nx * r, z = d.position.z + nz * r;
      const c = [...cols.decks(x, z), ...crouchCols.decks(x, z)]
        .filter((y) => Math.abs(y - d.position.y) <= 2.6)
        .sort((a, b) => Math.abs(a - d.position.y) - Math.abs(b - d.position.y))[0];
      if (c != null) { stand = { y: c, r }; break; }
    }
    assert.ok(stand, `${e.label}/${d.id}: there is nothing to stand on within 1.8 m outside the hatch`);
    const dy = Math.abs(stand.y - d.position.y);
    assert.ok(dy <= 2.6,
      `${e.label}/${d.id}: feet at ${stand.y.toFixed(2)}, hatch published at ${d.position.y.toFixed(2)} `
      + `- a ${dy.toFixed(2)} m gap, and the prompt appears within 2.6`);
    assert.ok(stand.r < 3.0,
      `${e.label}/${d.id}: the nearest standing point is ${stand.r} m out and the prompt reaches 3.0`);
    worst.push(`${d.id} dy=${dy.toFixed(2)}`);
  }
  // Quoted, so the margin is visible rather than merely satisfied.
  assert.ok(worst.length === hatches.length, worst.join(' '));
});

test('the boarding route to every fitted hull is a walk, not a scramble', async () => {
  /* The chain, end to end and named at each link: the gateway, the keel line,
   * the berth's own service stair or apron, the ramp foot, the ramp head, and
   * the hatch. Every one of them on the round trip, and every step of the ramp
   * inside `stepHeight` - because a ramp whose treads gain more than 0.45 m is
   * a ramp the capsule solver stops a body dead on. */
  const { world, cols, graph, out, back } = await measure();
  for (const spec of world.shipSpecs) {
    if (!spec.walkable) continue;
    assert.ok(spec.ramp, `${spec.id} publishes no boarding ramp foot`);
    const foot = nodeAt(graph, spec.ramp.x, spec.ramp.y, spec.ramp.z, { radius: 2.0, yTol: 0.8 });
    assert.notEqual(foot, -1, `${spec.id}: the ramp foot at (${spec.ramp.x.toFixed(1)}, ${spec.ramp.z.toFixed(1)}) is not standable`);
    assert.ok(out[foot] && back[foot], `${spec.id}: the ramp foot is not on the round trip`);

    // Where the ramp comes FROM has to be the thing the yard already proved.
    const berth = PLAN.BERTHS.find((b) => b.id === spec.id);
    if (spec.ramp.from === 'cradle') {
      assert.ok(Math.abs(spec.ramp.y - berth.cradleTop) < 0.2,
        `${spec.id}: a cradle ramp whose foot is at ${spec.ramp.y.toFixed(2)} and a cradle at ${berth.cradleTop}`);
    } else {
      assert.ok(Math.abs(spec.ramp.y - PLAN.DECK_Y) < 0.2,
        `${spec.id}: a deck ramp whose foot is at ${spec.ramp.y.toFixed(2)} and a shed floor at ${PLAN.DECK_Y}`);
      // ...and it lands where the drop-one anchor said it would.
      const d = Math.hypot(spec.ramp.x - spec.apron.x, spec.ramp.z - spec.apron.z);
      assert.ok(d < 2.5,
        `${spec.id}: the ramp foot is ${d.toFixed(2)} m from the apron anchor the yard published for it`);
    }

    // Every step up the ramp, sampled along its own line.
    const H = HULL.HULLS[spec.id];
    const head = P(berth, spec.boardSide * H.ramp.headX, H.ramp.rise, H.ramp.lz);
    const n = 24;
    let worst = 0, prev = null;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = spec.ramp.x + (head.x - spec.ramp.x) * t;
      const z = spec.ramp.z + (head.z - spec.ramp.z) * t;
      const want = spec.ramp.y + (head.y - spec.ramp.y) * t;
      const here = cols.decks(x, z).filter((y) => Math.abs(y - want) < 0.7).sort((a, b) => Math.abs(a - want) - Math.abs(b - want))[0];
      if (here == null) continue;
      if (prev !== null) worst = Math.max(worst, Math.abs(here - prev));
      prev = here;
    }
    assert.ok(worst <= STEP_UP,
      `${spec.id}: the boarding ramp gains ${worst.toFixed(2)} m in one sample and a body manages ${STEP_UP}`);
  }
});

test('the Pike gun bay is a crouch, and it is a crouch you can back out of', async () => {
  /* The design put this compartment under a floor hatch. That would be a
   * one-way drop: `Interiors` has no ladder verb, the crouch capsule is
   * 1.015 m and the standing one is 1.75, and there is not enough headroom in
   * there to jump. So it is a crouch hole through the forward bulkhead, and
   * this is the proof that it is BOTH a crouch (a standing capsule does not
   * fit) and a route (a crouched one gets in and back out). */
  const { world, cols, crouchCols, crouchGraph, cOut, cBack } = await measure();
  const berth = PLAN.BERTHS.find((b) => b.id === 'pike');
  const H = HULL.PIKE;
  const bay = H.rooms.find((r) => r.id === 'gunbay');
  const at = P(berth, 0, bay.floorY + 0.05, (bay.z0 + bay.z1) / 2);

  const clear = crouchCols.clearAt(at.x, at.z, berth.cradleTop + bay.floorY, 0.4);
  assert.ok(clear >= CROUCH_ROOM,
    `floor: ${CROUCH_ROOM.toFixed(3)} m (the crouch capsule plus 5 cm). achieved: ${clear.toFixed(2)} m of clear height in the gun bay`);
  assert.ok(clear < STAND_H,
    `ceiling: ${STAND_H} m. achieved: ${clear.toFixed(2)} m - the bay is meant to be crouch-only and a body can stand up in it`);

  // A STANDING probe finds no floor there at all, which is the same statement
  // read the other way and the one that would silently disappear if the
  // deckhead were ever drawn instead of collided.
  assert.equal(cols.decks(at.x, at.z).filter((y) => Math.abs(y - (berth.cradleTop + bay.floorY)) < 0.3).length, 0,
    'a standing capsule fits in the gun bay - its deckhead has stopped being a collider');

  const id = nodeAt(crouchGraph, at.x, at.y, at.z, { radius: 1.4, yTol: 0.5 });
  assert.notEqual(id, -1, 'nothing standable inside the gun bay even crouched');
  assert.ok(cOut[id], 'the gun bay cannot be crawled into from the gateway');
  assert.ok(cBack[id], 'the gun bay can be crawled into and not out of - a soft lock');

  // And the hole itself is the size the plan says.
  assert.ok(H.crouchHatch.h > CROUCH_H && H.crouchHatch.h < STAND_H,
    `the crouch hatch lintel is at ${H.crouchHatch.h} m, which is not between ${CROUCH_H.toFixed(3)} and ${STAND_H}`);
});

test('the Dray cargo lift is a route between two decks, not an ornament', async () => {
  /* `Interiors` has exactly two verbs and a ladder is neither of them. The lift
   * is what carries a body from the hold floor to the dorsal spine, and
   * `Physics.setBoxColliderY` is Y-only and safe only because the broadphase is
   * XZ-indexed - which is what makes a lift legal where a moving walkway is
   * not. */
  const { world, graph, out, back } = await measure();
  const dray = world.enterables.find((e) => e.label === 'ship-dray');
  assert.ok(dray, 'the Dray publishes no enterable');
  assert.equal(dray.lifts.length, 1, `${dray.lifts.length} lifts on the Dray`);
  const l = dray.lifts[0];
  assert.ok(Array.isArray(l.stops) && l.stops.length === 2, 'the lift does not publish two stops');
  assert.ok(l.collider && l.collider.type === 'box',
    'the lift car is not a box collider, and `setBoxColliderY` only moves boxes');
  assert.ok(l.callPos && Number.isFinite(l.callPos.x),
    'the lift publishes no callPos, so `Interiors` derives an axis-aligned one - which lands inside a bulkhead on a yawed hull');
  assert.ok(l.footprint && Number.isFinite(l.footprint.cx), 'the lift publishes no footprint');

  const berth = PLAN.BERTHS.find((b) => b.id === 'dray');
  // Both ends of the ride are places a body can be, reached without the lift:
  // the hold by its ramp, the spine by the brow. A lift is a shortcut, and a
  // shortcut that is the ONLY way is a lift outage that seals a compartment.
  /* `stops` are WORLD heights, not hull-local ones, because `Interiors` writes
   * them straight into `setBoxColliderY` and `car.position.y`. Probing beside
   * the shaft rather than on it, and INBOARD at the hold end, because outboard
   * of the shaft at deck level is the side tank. */
  for (const [name, y, dx] of [['hold floor', l.stops[0], -1], ['spine', l.stops[1], 1]]) {
    const at = P(berth, HULL.DRAY.lift.lx + dx * (HULL.DRAY.lift.half + 0.85), 0, HULL.DRAY.lift.lz);
    const id = nodeAt(graph, at.x, y, at.z, { radius: 2.2, yTol: 0.8 });
    assert.notEqual(id, -1, `nothing standable beside the lift at the ${name}`);
    assert.ok(out[id] && back[id], `the ${name} end of the lift is not on the round trip without using the lift`);
  }
  // The call point is somewhere a body actually stands.
  const cid = nodeAt(graph, l.callPos.x, l.stops[0], l.callPos.z, { radius: 1.6, yTol: 1.2 });
  assert.notEqual(cid, -1, 'the lift call point is not standable');
});

test('the Dray brow puts a body from the gantry onto a hull, and back', async () => {
  /* Quest 55's "get on the gantry the hard way, up the Dray's flank", proved as
   * a WALK in both directions. It is also the answer to a design that asked for
   * a spine-to-catwalk mantle the built yard cannot give: the berths are
   * 20-50 m from the perimeter runs and the two crossings that pass over them
   * are railed both sides, so the only mantle target above a hull would be the
   * 0.11 m top of a handrail. */
  /* ── Where the brow IS, now that the Dray is on a pier ─────────────────
   * `BROW.x` and `BROW.footZ` are WORLD coordinates from when berth two stood
   * on the shop floor under `CROSSINGS[0]`, and the ship has moved 152 m north
   * and turned 160 degrees. What survives the move is everything about the
   * flight ITSELF — `run`, `rise`, `width`, `risers`, `gapHW` — and the deck it
   * stands on, `DRAY.foredeck`. `DockWorld._buildBowGantry` composes those with
   * the berth to place it, and so does this: derived from the same three
   * sources rather than copied, so the brow and its test cannot drift.
   *
   * What it lands on is a bow gantry at the pier head instead of a catwalk
   * crossing, at `cradleTop + foredeck.y + BROW.rise`, which is 8.00 — the same
   * height the crossing was, because the numbers that put it there have not
   * changed. */
  const { graph, out, back, cols } = await measure();
  const B = HULL.BROW;
  const berth = PLAN.berthOf('dray');
  const fore = HULL.HULLS.dray.foredeck;
  const sgn = Math.cos(berth.yaw) >= 0 ? 1 : -1;
  const footLz = fore.z1 - 2.6;
  const bx = berth.x;
  const footZ = berth.z + sgn * footLz;
  const footY = berth.cradleTop + fore.y;
  const headZ = berth.z + sgn * (footLz + B.run);
  const headY = footY + B.rise;

  const foot = nodeAt(graph, bx, footY, footZ, { radius: 1.6, yTol: 0.6 });
  assert.notEqual(foot, -1, 'the brow has no standable foot on the Dray foredeck');
  const head = nodeAt(graph, bx, headY, headZ, { radius: 1.6, yTol: 0.6 });
  assert.notEqual(head, -1, 'the brow arrives at nothing on the bow gantry');
  assert.ok(out[foot] && back[foot], 'the brow foot is not on the round trip');
  assert.ok(out[head] && back[head], 'the brow head is not on the round trip');
  assert.ok(Math.abs(headY - PLAN.GANTRY_Y) < 0.01,
    `the bow gantry stands at ${headY.toFixed(2)} and the yard's walking level is ${PLAN.GANTRY_Y}`);

  /* And the rail is CUT where it arrives. Both ends being on the round trip is
   * not enough: the gantry is reachable by its own stair and the foredeck by
   * the hull, so a brow that ended at an unbroken handrail would leave both
   * ends green and the route itself impassable.
   *
   * The gantry's aft edge is the brow's head line; a body walks through where
   * there is nothing solid between the deck and the drop. */
  const railed = cols.spans(bx, headZ)
    .some((iv) => iv[0] < headY + 1.1 && iv[1] > headY + 0.4);
  assert.equal(railed, false,
    'the bow gantry rail is unbroken where the brow arrives - the brow ends at a fence');
  /* ...and it is cut ONLY there. The aft edge of the gantry carries two gaps —
   * the brow and the stair up from the pad — so the station that has to be
   * solid is the midpoint between them, 5.5 m clear of both. Sampling a fixed
   * 4 m to port would land off the end of the platform, which reads as an
   * unguarded rail and is really no rail because there is no deck. */
  const stairX = berth.x + sgn * -HULL.boardSide(berth) * 11;
  const solidX = (bx + stairX) / 2;
  const guarded = cols.spans(solidX, headZ)
    .some((iv) => iv[0] < headY + 1.1 && iv[1] > headY + 0.4);
  assert.ok(guarded,
    `the bow gantry rail is missing at x ${solidX.toFixed(1)} as well - a gap with nothing `
    + 'arriving at it is an 8 m fall');

  // Every step of it, and the pitch it comes out at.
  let worst = 0, prev = null;
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const z = footZ + (headZ - footZ) * t;
    const want = footY + B.rise * t;
    const y = cols.decks(bx, z).filter((v) => Math.abs(v - want) < 0.6).sort((a, b) => Math.abs(a - want) - Math.abs(b - want))[0];
    if (y == null) continue;
    if (prev !== null) worst = Math.max(worst, Math.abs(y - prev));
    prev = y;
  }
  const deg = (Math.atan2(B.rise, B.run) * 180) / Math.PI;
  assert.ok(worst <= STEP_UP, `the brow gains ${worst.toFixed(2)} m in one sample against ${STEP_UP}`);
  assert.ok(deg < 42,
    `ceiling: 42 degrees, because the capsule solver stops reporting a true face normal past about 44. achieved: ${deg.toFixed(1)}`);
});

/* ================================================================== */
/* 3. The compartments are not full of the structure that describes them */
/* ================================================================== */

/**
 * Recover the drawn parts inside a world-space box from the merged buffers.
 *
 * The interiors are MERGED - one mesh per material key per batch - so there is
 * no per-part object left once a batch has flushed. `GeoBatch` appends each
 * part's geometry whole, so a run of consecutive triangles that never jumps in
 * space IS a part, which is exactly what makes the medieval version of this
 * test work on a merged world.
 */
function partsInside(root, box) {
  const parts = [];
  const v = new THREE.Vector3();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh) return;
    const geo = o.geometry;
    const pos = geo?.attributes?.position;
    if (!pos) return;
    const idx = geo.index;
    const count = idx ? idx.count : pos.count;
    let cur = null;
    for (let i = 0; i < count; i += 3) {
      const tri = new THREE.Box3();
      for (let k = 0; k < 3; k++) {
        const vi = idx ? idx.getX(i + k) : i + k;
        v.fromBufferAttribute(pos, vi).applyMatrix4(o.matrixWorld);
        tri.expandByPoint(v);
      }
      if (!box.intersectsBox(tri)) { cur = null; continue; }
      if (cur && cur.box.distanceToPoint(tri.min) < 0.2 && cur.box.distanceToPoint(tri.max) < 0.2) cur.box.union(tri);
      else { cur = { box: tri.clone() }; parts.push(cur); }
    }
  });
  return parts.map((p) => p.box);
}

/** A room's world-space AABB, built at the ORIGIN and unrotated. */
function roomBoxLocal(room, inset = 0.25) {
  return new THREE.Box3(
    new THREE.Vector3(-room.hw + inset, room.floorY, room.z0 + inset),
    new THREE.Vector3(room.hw - inset, room.ceilY, room.z1 - inset)
  );
}

test('nothing spans a compartment and hangs in the middle of it', async () => {
  /* THE FULL-PLAN-BOX RULE, fourth occurrence, ported from
   * `medieval-approach.test.mjs:595-668`. A part is an offender when all four
   * hold:
   *
   *   foot >= area * 0.5      it covers half the compartment in plan
   *   maxY > floorY + 0.15    it is not the floor
   *   minY < ceilY - 0.06     it is not the ceiling
   *   maxY < ceilY            ...and this last clause exempts the SHELL and the
   *                           deck slab, which span the plan and carry on up
   *
   * Without that fourth clause every hull plate would be flagged, and a test
   * that flags the building it is measuring gets deleted rather than fixed. The
   * medieval run found 130 slabs.
   *
   * ── Measured at the ORIGIN, unrotated ────────────────────────────────────
   * The AABB of a yawed box is not the box: at the Dray's 0.20 rad a 9 m hold
   * measures 10.6 m across in world axes, and every member in it would gain a
   * fictitious 18% of footprint. So each hull is rebuilt on its own frame with
   * `yaw = 0` and measured there.
   */
  const { Physics: Ph } = { Physics };
  const physics = new Ph();
  const { GeoBatch } = await import('../../src/worlds/station/StationKit.js');
  const { ShipBuild, shipMaterials } = await import('../../src/worlds/dock/ShipKit.js');
  const { buildKestrel, buildDray, buildPike } = await import('../../src/worlds/dock/Hulls.js');
  const { SHIP_TINTS } = await import('../../src/ships/ShipStats.js');
  const { world } = await built();

  const builders = { kestrel: buildKestrel, dray: buildDray, pike: buildPike };
  const offenders = [];
  const widths = [];
  for (const id of HULL.WALKABLE) {
    const H = HULL.HULLS[id];
    const { mats } = shipMaterials(world.mat, SHIP_TINTS[id]);
    const ext = new GeoBatch(), int = new GeoBatch();
    const group = new THREE.Group();
    const b = new ShipBuild({
      batch: ext, interior: int, physics, track: (c) => c, group,
      x: 0, y: 0, z: 0, yaw: 0,
    });
    builders[id](b, 1, PLAN.BERTHS.find((x) => x.id === id).cradleTop, mats);
    const root = new THREE.Group();
    ext.flush(root, mats, `flat-${id}`, {});
    int.flush(root, mats, `flat-${id}-in`, {});
    root.add(group);

    for (const room of H.rooms) {
      const box = roomBoxLocal(room);
      const area = (box.max.x - box.min.x) * (box.max.z - box.min.z);
      let widest = 0;
      let parts = 0;
      for (const p of partsInside(root, box)) {
        parts++;
        const w = Math.min(p.max.x, box.max.x) - Math.max(p.min.x, box.min.x);
        const d = Math.min(p.max.z, box.max.z) - Math.max(p.min.z, box.min.z);
        const foot = Math.max(0, w) * Math.max(0, d);
        if (p.max.y > room.floorY + 0.15 && p.min.y < room.ceilY - 0.06 && p.max.y < room.ceilY - 0.2) {
          widest = Math.max(widest, foot / area);
        }
        if (foot < area * 0.5) continue;
        if (p.max.y <= room.floorY + 0.15) continue;
        if (p.min.y >= room.ceilY - 0.06) continue;
        /* `- 0.2` and not `>= ceilY`, and the 0.2 is measured rather than
         * chosen. The part finder recovers a merged box FACE BY FACE, because
         * `BoxGeometry` jumps 1 m in space between its +X and -X faces and the
         * 0.2 m contiguity threshold correctly calls that a new part — so a
         * deckhead whose top IS the ceiling still yields a bottom face 0.12 m
         * under it, which a bare `>= ceilY` would flag as a slab hanging in the
         * room. The defect this rule exists for was plank at 1.66 m in a room
         * with a 2.85 m ceiling: 1.19 m of clearance, not 0.2. */
        if (p.max.y >= room.ceilY - 0.2) continue;
        offenders.push(`${id}/${room.id}: a part ${w.toFixed(1)} x ${d.toFixed(1)} m spanning `
          + `${((foot / area) * 100) | 0}% of the plan, from y ${p.min.y.toFixed(2)} to ${p.max.y.toFixed(2)} `
          + `in a compartment whose floor is ${room.floorY} and ceiling ${room.ceilY}`);
      }
      assert.ok(parts >= 4,
        `only ${parts} drawn parts inside ${id}/${room.id} - the part finder has stopped working, `
        + 'and a part finder that finds nothing reports no offenders');
      widths.push(`${id}/${room.id} ${(widest * 100).toFixed(0)}%`);
    }
  }
  assert.deepEqual(offenders, [],
    `${offenders.length} full-plan members hanging inside a ship:\n  ${offenders.join('\n  ')}`);
  /* Quoted rather than merely asserted, so the margin is visible: this is the
   * fraction of each compartment's plan covered by the widest thing hanging
   * between its floor and its ceiling, and the rule fires at 50%. */
  const worst = Math.max(...widths.map((w) => parseFloat(w.split(' ')[1])));
  assert.ok(worst < 50,
    `floor: nothing over 50% of the plan. achieved: ${widths.join(', ')}`);
});

test('a body can see across every compartment at head height', async () => {
  /* The complement of the rule above, and the thing the rule is a proxy for.
   * The medieval version of this failed because the first thing over a head was
   * plank at 1.66 m in a room with a 2.85 m ceiling - a room the headroom test
   * correctly called 2.85 m clear, because those members have no colliders. */
  const { world } = await built();
  const ray = new THREE.Raycaster();
  const dir = new THREE.Vector3();
  const from = new THREE.Vector3();
  const meshes = [];
  world.group.traverse((o) => { if (o.isMesh && !o.isInstancedMesh) meshes.push(o); });

  for (const b of PLAN.BERTHS) {
    const H = HULL.HULLS[b.id];
    for (const room of H.rooms ?? []) {
      /* Eye height for the compartment: standing where it is tall enough,
       * crouched where it is not. The Pike's gun bay is 1.50 m and a standing
       * eye in there would be inside its own deckhead. */
      const tall = room.ceilY - room.floorY >= HEADROOM;
      const eye = room.floorY + (tall ? 1.62 : 0.9);
      let blocked = 0, total = 0;
      for (let t = 0.2; t <= 0.8; t += 0.15) {
        const lz = room.z0 + (room.z1 - room.z0) * t;
        const a = P(b, -room.hw + 0.35, eye, lz);
        const c = P(b, room.hw - 0.35, eye, lz);
        from.copy(a);
        dir.copy(c).sub(a);
        const len = dir.length();
        ray.set(from, dir.normalize());
        ray.far = len;
        total++;
        if (ray.intersectObjects(meshes, false).length) blocked++;
      }
      const frac = total ? blocked / total : 0;
      assert.ok(frac <= 0.4,
        `${b.id}/${room.id}: ${(frac * 100) | 0}% of the sightlines across it at ${tall ? 'eye' : 'crouched eye'} `
        + 'height hit something. floor: 40%');
    }
  }
});

/* ================================================================== */
/* 4. The climb                                                        */
/* ================================================================== */

/**
 * `player/FreeClimb._probe`, reproduced against the real physics.
 *
 * Three rays at `yaw +/- 0.26` rad from `feet + 1.166`, out to
 * `P.radius + REACH = 0.97 m`, taking any hit whose `|normal.y| <= 0.5`.
 */
function grip(physics, at, inward) {
  const o = new THREE.Vector3();
  const d = new THREE.Vector3();
  let best = null;
  for (const off of [-0.26, 0, 0.26]) {
    d.copy(inward).applyAxisAngle(_UP, off);
    o.copy(at);
    o.y += GRIP_H;
    const hit = physics.raycast(o, d, GRIP_REACH, COLLISION_LAYER.WORLD);
    if (!hit || !hit.normal) continue;
    if (Math.abs(hit.normal.y) > WALL_NORMAL_Y) continue;
    if (!best || hit.distance < best.distance) best = hit;
  }
  return best;
}

/**
 * `player/Climb._probe`'s second half, reproduced against the real physics:
 * the top of the wall, the headroom over the landing, and a `resolveCapsule`
 * that actually reports the body grounded there.
 */
function mantle(physics, feet, wall, inward, minRise) {
  const fx = inward.x, fz = inward.z;
  const inX = wall.point.x + fx * 0.14;
  const inZ = wall.point.z + fz * 0.14;
  const o = new THREE.Vector3(inX, feet.y + MANTLE_MAX + 0.45, inZ);
  const top = physics.raycast(o, new THREE.Vector3(0, -1, 0), MANTLE_MAX + 1.6, COLLISION_LAYER.WORLD);
  if (!top) return { ok: false, why: 'no top face over the wall it grabbed' };
  if (top.normal.y < TOP_NORMAL_Y) {
    return { ok: false, why: `the top face normal.y is ${top.normal.y.toFixed(2)}, under ${TOP_NORMAL_Y} - it is not standable` };
  }
  const topY = top.point.y;
  const rise = topY - feet.y;
  if (rise < minRise || rise > MANTLE_MAX) {
    return { ok: false, why: `rise ${rise.toFixed(2)} m is outside [${minRise}, ${MANTLE_MAX}]` };
  }
  const landX = wall.point.x + fx * (RADIUS + LAND_INSET);
  const landZ = wall.point.z + fz * (RADIUS + LAND_INSET);
  const up = physics.raycast(new THREE.Vector3(landX, topY + 0.12, landZ), new THREE.Vector3(0, 1, 0),
    MANTLE_HEADROOM, COLLISION_LAYER.WORLD);
  if (up) return { ok: false, why: `only ${up.distance.toFixed(2)} m of headroom over the landing, and ${MANTLE_HEADROOM} is needed` };
  const cap = new THREE.Vector3(landX, topY - 0.03, landZ);
  const res = physics.resolveCapsule(cap, RADIUS, STAND_H);
  if (!res.grounded) return { ok: false, why: 'resolveCapsule does not report the body grounded on the landing' };
  const slide = Math.hypot(cap.x - landX, cap.z - landZ);
  if (slide > 0.2) return { ok: false, why: `the solver slid the capsule ${slide.toFixed(2)} m off the landing, and Climb gives up past 0.20` };
  if (cap.y > topY + 0.3 || cap.y < topY - 0.35) {
    return { ok: false, why: `the capsule settled at ${cap.y.toFixed(2)} against a top at ${topY.toFixed(2)}` };
  }
  return { ok: true, rise, topY, slide, normalY: top.normal.y };
}

test('every hull can be climbed, band by band, against the real probes', async () => {
  /* "Climb on top of the ship" is a collision constraint, not a wish, and this
   * is where it is settled. Nothing here re-derives the movement code: the
   * three-ray fan is fired with `physics.raycast` at the height `FreeClimb`
   * fires it from, and the mantle is checked with `physics.resolveCapsule`
   * exactly as `Climb._probe` does, including the 0.20 m slide it gives up at.
   *
   * Reported as a table per band, because "the Dray is climbable" is a boolean
   * and "the Dray's second band lost its landing" is a bug report. */
  const { physics, cols } = await measure();
  const rows = [];
  const failures = [];

  for (const b of PLAN.BERTHS) {
    const H = HULL.HULLS[b.id];
    /* A body grabbing the STARBOARD flank faces INBOARD, i.e. along local -X,
     * which in world terms is `-axisX`. `FreeClimb` fires its fan as three rays
     * about the facing direction at +/- 0.26 rad, so the direction is what is
     * carried here rather than a yaw — a yaw would have to be converted back
     * through `(-sin, -cos)` and that conversion is the exact place a probe
     * ends up firing at the sky. */
    const inward = axisX(b).multiplyScalar(-1);

    for (const band of H.bands) {
      const tag = `${b.id}: ${band.what}`;
      const climb = band.to - band.from;
      if (band.how === 'step') {
        assert.ok(climb <= STEP_UP + 1e-6,
          `${tag} is called a step and gains ${climb.toFixed(2)} m against ${STEP_UP}`);
        rows.push(`${tag}: step ${climb.toFixed(2)} m`);
        continue;
      }
      if (band.how === 'climb') {
        assert.ok(climb <= HULL.CLIMB_BUDGET,
          `${tag} is ${climb.toFixed(2)} m of continuous climb against ${HULL.CLIMB_BUDGET} m of stamina bar`);
      }

      /* 0. THE STANCE IS REAL. A band's `standX/from/z` is where the feet are
       * while reaching, and a probe that skipped this would happily test a fan
       * fired from mid-air — which is exactly what happens when a ledge is
       * shortened out from under the band it carries. Only the first move of a
       * chain has to be on solid ground; a `climb` band that begins partway up
       * a face is a body already hanging off it. */
      const feet = P(b, band.standX, band.from, band.z);
      if (band.from === 0 || band.how !== 'climb') {
        const under = cols.decks(feet.x, feet.z).some((y) => Math.abs(y - feet.y) < 0.25);
        if (!under) {
          failures.push(`${tag}: there is nothing to stand on at local (${band.standX}, ${band.from}, ${band.z}) `
            + `- the band starts in mid-air, so whatever the fan finds is not a move a player can make`);
          continue;
        }
      }
      const g = grip(physics, feet, inward);
      if (!g) {
        failures.push(`${tag}: the three-ray fan finds no face with |n.y| <= ${WALL_NORMAL_Y} within ${GRIP_REACH} m `
          + `of a body standing at local x ${band.standX}`);
        continue;
      }
      // ...and it is the face the plan says, not something else in the way.
      const wantX = Math.abs(band.faceX);
      const gotLocal = Math.abs((g.point.x - b.x) * Math.cos(b.yaw) - (g.point.z - b.z) * Math.sin(b.yaw));
      if (Math.abs(gotLocal - wantX) > 0.35) {
        failures.push(`${tag}: the fan grabbed something at local x ${gotLocal.toFixed(2)} and the plan says ${wantX}`);
        continue;
      }

      // 2. The mantle completes. From the ground the floor is 1.0 m; arriving
      //    from a climb it drops to 0.25, which is why a `climb` band is probed
      //    from 1.6 m below its own top rather than from its foot.
      const minRise = band.how === 'climb' ? MANTLE_MIN_CLIMB : MANTLE_MIN_GROUND;
      const at = band.how === 'climb' ? P(b, band.standX, band.to - 1.6, band.z) : feet;
      const m = mantle(physics, at, g, inward, minRise);
      if (!m.ok) { failures.push(`${tag}: ${m.why}`); continue; }

      // 3. It lands where the plan says it lands.
      const wantTop = b.cradleTop + band.to;
      if (Math.abs(m.topY - wantTop) > 0.2) {
        failures.push(`${tag}: the mantle lands at ${m.topY.toFixed(2)} and the plan says ${wantTop.toFixed(2)}`);
        continue;
      }
      rows.push(`${tag}: rise ${m.rise.toFixed(2)} m, n.y ${m.normalY.toFixed(2)}, slide ${m.slide.toFixed(3)} m`);
    }
  }
  assert.deepEqual(failures, [],
    `${failures.length} climb bands fail:\n  ${failures.join('\n  ')}\npassing:\n  ${rows.join('\n  ')}`);
  assert.ok(rows.length >= 9,
    `only ${rows.length} bands probed - the four hulls carry ten between them`);
});

test('every rest ledge is deep enough for a mantle to finish on', async () => {
  /* The number the hulls are shaped by, stated on its own so a change to a beam
   * cannot quietly break it: `P.radius + LAND_INSET = 0.77 m` of flat, plus the
   * capsule's own 0.35 m radius before the next wall stands up. A 0.14 m bolted
   * flange - which is what the lore hangs on every section joint - is a
   * handhold the mantle refuses to finish on, and that is why what makes the
   * ledge is the hull STEPPING IN rather than the course. */
  for (const id of Object.keys(HULL.HULLS)) {
    const H = HULL.HULLS[id];
    const step = H.ledge.outer - H.ledge.inner;
    assert.ok(Math.abs(step - H.ledge.stepIn) < 1e-6,
      `${id}: the plan says stepIn ${H.ledge.stepIn} and outer - inner is ${step.toFixed(3)}`);
    assert.ok(step >= HULL.MIN_STEP_IN,
      `floor: ${HULL.MIN_STEP_IN} m (0.77 landing + 0.35 capsule). achieved: ${id} steps in ${step.toFixed(2)} m at its section joint`);
  }
});

test('no hull is banded further apart than one stamina bar', async () => {
  /* `DRAIN_UP = 5.4`/s against a 100 bar at `SPEED_UP = 2.05` m/s is 13.7 m of
   * continuous climb, and holding on costs only `DRAIN_HOLD = 1.6`, so a ledge
   * is a real rest and any height is reachable given the patience to pause.
   * Every band here is well inside it, and the ceiling is quoted because the
   * useful failure is a band that grew, not a band that broke. */
  const worst = [];
  for (const id of Object.keys(HULL.HULLS)) {
    for (const band of HULL.HULLS[id].bands) {
      worst.push({ id, what: band.what, m: band.to - band.from });
    }
  }
  worst.sort((a, b) => b.m - a.m);
  assert.ok(worst[0].m <= HULL.CLIMB_BUDGET,
    `ceiling: ${HULL.CLIMB_BUDGET} m. achieved: the longest band is ${worst[0].id}'s ${worst[0].what} at ${worst[0].m.toFixed(2)} m`);
  // ...and the whole climb from cradle top to crown, per hull.
  for (const id of Object.keys(HULL.HULLS)) {
    const H = HULL.HULLS[id];
    const total = H.spine.y;
    assert.ok(Math.abs(H.bands[H.bands.length - 1].to - total) < 1e-6,
      `${id}: the last band tops out at ${H.bands[H.bands.length - 1].to} and the spine is at ${total}`);
  }
});

/* ================================================================== */
/* 5. Budgets                                                          */
/* ================================================================== */

test('the hulls fit inside the drop budget they were given', async () => {
  const { world, physics, buildMs } = await measure();
  /* `build()` runs the texture painters, nine canvases, four hulls and the
   * whole yard. The design budget is 900 ms on the target machine; node is not
   * that machine and its canvas is a stub, so what this asserts is a CEILING
   * with a lot of margin - a regression that doubles the build shows up, and a
   * machine difference does not. */
  assert.ok(buildMs < 6000, `the yard built in ${buildMs} ms`);

  const soups = physics.colliders.filter((c) => c.type === 'mesh');
  assert.equal(soups.length, 0, 'a triangle-soup collider appeared');

  // Draw calls: one mesh per material key per batch, and each hull owns two
  // batches. The whole yard has to stay inside 220 with the portal system, the
  // NPCs and the HUD still to pay for.
  let meshes = 0;
  world.group.traverse((o) => { if (o.isMesh) meshes++; });
  /* 156, up from 140, and the eleven were all one thing: THE SKY.
   *
   * The yard's north end is a 164 m aperture onto space now, so the world
   * draws a starfield (1 `Points`), three bodies with their limb haloes
   * (3 + 3), a ring for the gas giant (1), the containment-field scrim (1) and
   * a pier edge-light bucket (1). Measured at 150 against a frame budget of
   * 220 draws — and 22 of the 150 are the flights' hidden ramp proxies, which
   * `projectObject` never pushes.
   *
   * The ceiling moves rather than the sky being trimmed because the sky is
   * what the rebuild is FOR: eleven draw calls is what the whole difference
   * between "a big dark room" and a hangar bay open to a lit void costs.
   *
   * ── AND PHASE 2 MOVED IT AGAIN, FOR THE SAME REASON ──────────────────────
   *
   * The sky went from FIVE bodies to TWELVE. `YardPlan.BODIES` hangs every
   * entry of `SPACE_BODIES` on a proxy shell between `VOID_NEAR` and
   * `VOID_FAR` — it does not pick a subset — so seven new bodies is seven new
   * spheres plus a limb halo for each of the six that has air. Measured 150 →
   * 165, i.e. +15 for seven bodies, which is the ~2.1 a body that arithmetic
   * predicts. Effective draws are 165 − 22 hidden ramp proxies = 143 against a
   * 220 frame budget.
   *
   * THE CEILING IS DERIVED NOW, NOT TYPED. A hand-set number is what let this
   * rot: it was correct for a five-body sky and silently became a failure the
   * day the sky grew, with nothing saying which of the two was wrong. Deriving
   * it from `PLAN.BODIES.length` means an eleventh planet updates the budget by
   * itself, while `PER_BODY` still fails loudly if a body starts costing more
   * than a sphere and a halo — which is the regression this case is actually
   * for. */
  const ceiling = PLAN.meshCeiling();
  assert.ok(meshes <= ceiling,
    `ceiling: ${ceiling} meshes for a ${PLAN.BODIES.length}-body sky `
    + `(the frame budget is 220 draws with the portals, NPCs and HUD still to pay for). `
    + `achieved: ${meshes}`);
  /* The frame budget is the thing that actually matters, and it is absolute:
   * no number of planets may push the yard past what a frame can draw. */
  assert.ok(meshes - PLAN.HIDDEN_RAMP_PROXIES <= PLAN.FRAME_DRAW_BUDGET,
    `${meshes} meshes less ${PLAN.HIDDEN_RAMP_PROXIES} hidden ramp proxies is past `
    + `the ${PLAN.FRAME_DRAW_BUDGET}-draw frame budget`);

  // Triangles. Measured off the merged buffers rather than `renderer.info`,
  // which moves 10-13% between loads of the same framing because the shadow
  // pass follows the player.
  let tris = 0;
  world.group.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry;
    const n = g?.index ? g.index.count : (g?.attributes?.position?.count ?? 0);
    tris += (n / 3) * (o.isInstancedMesh ? o.count : 1);
  });
  assert.ok(tris <= 900000,
    `ceiling: 900k triangles for the worst framing. achieved: ${Math.round(tris)} for the WHOLE world`);
  /* And the hulls are a real share of it, measured off their own merged
   * buffers by name. A guard on the world total would go green on a yard whose
   * ships had silently stopped building; this one cannot. */
  let hullTris = 0;
  world.group.traverse((o) => {
    if (!o.isMesh || !/^ship-/.test(o.name)) return;
    const g = o.geometry;
    hullTris += (g?.index ? g.index.count : (g?.attributes?.position?.count ?? 0)) / 3;
  });
  assert.ok(hullTris > 12000,
    `only ${Math.round(hullTris)} triangles across four hulls - one of them did not land`);
  assert.ok(hullTris < 400000,
    `ceiling: 400k for the hulls. achieved: ${Math.round(hullTris)} (world total ${Math.round(tris)})`);

  // Every hull interior is LOD-banded, and its colliders are not.
  assert.ok(world._lod.entries.length >= 4,
    `${world._lod.entries.length} LOD entries - the office and three ship interiors make at least four`);
});

test('every hull light grades with distance, exactly as the yard\'s own do', async () => {
  /* `shipMaterials` clones the yard's emissive materials so a livery painted on
   * one hull does not repaint the shed. The comment beside that clone used to
   * claim that `onBeforeCompile` and `customProgramCacheKey` "survive `clone()`
   * by reference". They do not: `Material.copy` in three r185 copies neither,
   * so every hull glow reverted to the prototype's empty hook and to the
   * default cache key.
   *
   * What that looked like, measured on the built world: every `yard:*` emissive
   * carried `customProgramCacheKey() === 'yard-emfade'` and all four
   * `ship-*:glow` materials carried the default. The fade is
   * `mix(0.30, 1.0, smoothstep(140, 46, dist))`, so from the apron arrival at
   * z 49.4 the Bastion at (40, -64) is ~115 m off, where the yard's own strips
   * render at 0.414x and the hulls' running lights rendered at 1.0x - a 2.4x
   * mismatch, and inconsistent WITHIN one hull, because the amber `warn`
   * strips are shared by reference and kept the grade while the cyan `glow`
   * clones lost it. The fade exists because a sub-pixel emitter at full
   * intensity is an aliasing source rather than a light.
   *
   * Asserted through the FACTORY rather than through a material list, so it
   * cannot be satisfied by a hand-written copy that drifts: the hull's hook has
   * to be the yard's own function object, which is also what keeps the two on
   * one compiled program. */
  const { world } = await built();
  const { shipMaterials } = await import('../../src/worlds/dock/ShipKit.js');
  const M = world.mat;

  // The yard's own graded emissives, as the control.
  assert.equal(M.emCyan.customProgramCacheKey(), 'yard-emfade',
    'the yard\'s cyan emissive has lost its distance grade - the control for this test is gone');
  assert.notEqual(M.emLaunch.customProgramCacheKey(), 'yard-emfade',
    'the launch aperture is meant NOT to grade off: reading it from the apron 150 m away is its whole job');

  const { mats } = shipMaterials(M, { hull: 0x808080, trim: 0x808080, glass: 0x203040, glow: 0x4fe3ff, accent: 0x808080 });
  assert.equal(mats.glow.customProgramCacheKey(), 'yard-emfade',
    'a hull\'s running lights are on the default program: they will not fade with distance, and they are a new program');
  assert.equal(mats.glow.onBeforeCompile, M.emCyan.onBeforeCompile,
    'a hull\'s glow has its own shader hook rather than the yard\'s - the two will diverge');

  // ...and the built world agrees with the factory.
  const wrong = [];
  world.group.traverse((o) => {
    const list = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of list) {
      if (!/^ship-.*:(glow|warn|lamp|danger)$/.test(o.name)) continue;
      const key = m.customProgramCacheKey ? m.customProgramCacheKey() : '(none)';
      if (key !== 'yard-emfade') wrong.push(`${o.name}: ${key.slice(0, 40)}`);
    }
  });
  assert.deepEqual(wrong, [],
    `${wrong.length} hull emissive materials are not on the yard's graded program:\n  ` + wrong.join('\n  '));
});

/* ================================================================== */
/* 6. Four machines, not four drums                                    */
/* ================================================================== */

/**
 * Rebuild one hull on its OWN frame at `yaw = 0`, and return its exterior
 * geometry.
 *
 * The same trick the full-plan-box test uses and for the same reason: the AABB
 * of a yawed hull is not the hull, and every shape descriptor below is read off
 * an axis-aligned box. At the Dray's 0.20 rad a 10.4 m beam measures 12.8 m in
 * world axes, which would hand the Dray a slenderness it does not have.
 */
async function flatHull(id) {
  const physics = new Physics();
  const { GeoBatch } = await import('../../src/worlds/station/StationKit.js');
  const { ShipBuild, shipMaterials } = await import('../../src/worlds/dock/ShipKit.js');
  const H = await import('../../src/worlds/dock/Hulls.js');
  const { SHIP_TINTS } = await import('../../src/ships/ShipStats.js');
  const { world } = await built();
  const berth = PLAN.BERTHS.find((x) => x.id === id);
  const { mats } = shipMaterials(world.mat, SHIP_TINTS[id]);
  const ext = new GeoBatch(), int = new GeoBatch();
  const group = new THREE.Group();
  const b = new ShipBuild({
    batch: ext, interior: int, physics, track: (c) => c, group,
    x: 0, y: 0, z: 0, yaw: 0,
  });
  if (id === 'bastion') H.buildBastion(b, berth.cradleTop, mats);
  else if (id === 'kestrel') H.buildKestrel(b, 1, berth.cradleTop, mats);
  else if (id === 'dray') H.buildDray(b, 1, berth.cradleTop, mats);
  else H.buildPike(b, 1, berth.cradleTop, mats);
  const root = new THREE.Group();
  ext.flush(root, mats, 'flat-' + id, {});
  root.updateMatrixWorld(true);
  return { root, physics, hull: HULL.HULLS[id] };
}

/**
 * Shape descriptors, read off the built exterior rather than off `HullPlan`.
 *
 * Off the BUILT geometry on purpose: a plan can claim a swept nose and a
 * builder can still emit a box, and this drop is about what the hull looks
 * like rather than about what it was specified as.
 */
function silhouette(root, hull) {
  const v = new THREE.Vector3();
  const N = 44;
  const z0 = hull.z0, z1 = hull.z1;
  const halfBeam = new Float64Array(N);
  const top = new Float64Array(N).fill(-Infinity);
  const bot = new Float64Array(N).fill(Infinity);
  root.traverse((o) => {
    if (!o.isMesh) return;
    const pos = o.geometry?.attributes?.position;
    if (!pos) return;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      const t = (v.z - z0) / (z1 - z0);
      if (t < 0 || t > 1) continue;
      const k = Math.min(N - 1, Math.max(0, Math.floor(t * N)));
      if (Math.abs(v.x) > halfBeam[k]) halfBeam[k] = Math.abs(v.x);
      if (v.y > top[k]) top[k] = v.y;
      if (v.y < bot[k]) bot[k] = v.y;
    }
  });
  /* `beam` is the 90th percentile of the per-station half-beam, NOT the widest
   * vertex, and the difference is a boarding ramp.
   *
   * A hull's builder also emits things that belong to the BERTH rather than to
   * the ship: the Dray's cargo ramp reaches local x 13.6 at one station and
   * the Bastion's engine bell stands beside her cradle at x -14.7. Taking the
   * maximum made the Dray measure 27.3 m in the beam against a real 10.4 — a
   * descriptor describing a ramp. A percentile over 44 stations along the
   * length ignores whatever happens at one or two of them.
   *
   * The Bastion's figure still carries her bell, which spans six stations, and
   * that is left alone rather than special-cased: it is a number about what
   * stands at that berth, it is derived the same way for all four, and no
   * assertion below is about an absolute value. */
  const sorted = Array.from(halfBeam).filter((q) => q > 0).sort((p, q) => p - q);
  const beam = 2 * (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.90))] ?? 0);
  let height = 0;
  for (let k = 0; k < N; k++) {
    if (Number.isFinite(top[k]) && Number.isFinite(bot[k]) && top[k] - bot[k] > height) height = top[k] - bot[k];
  }
  /* The parallel middle body: the share of the length carried at very nearly
   * full beam. It is the naval architect's own number for "how much of this
   * ship is a box" and it is the descriptor that separates every pair of these
   * four but one. */
  let full = 0, live = 0;
  for (let k = 0; k < N; k++) {
    if (halfBeam[k] <= 0) continue;
    live++;
    if (halfBeam[k] * 2 >= beam * 0.92) full++;
  }
  return {
    length: z1 - z0,
    beam,
    height,
    slender: (z1 - z0) / beam,
    stance: height / beam,
    parallel: full / Math.max(1, live),
  };
}

test('the four hulls are four different machines, and it is measurable', async () => {
  /* THE HEADLINE OF THIS DROP, and the reason it is a test rather than a
   * screenshot: "they all read as variations on a plated drum" is exactly the
   * kind of judgement that comes back six months later, and a screenshot
   * cannot fail.
   *
   * Three descriptors, all read off the BUILT exterior in each hull's own
   * frame: how slender it is, how tall it stands for its beam, and what share
   * of its length is carried at full beam. Two hulls are DIFFERENT when any
   * one of the three differs by 20% of the larger — about the point where a
   * difference survives a dark shed at thirty metres.
   *
   * The table is printed on failure rather than merely asserted, because the
   * useful report is "the Pike has drifted towards the Kestrel", not `false`.
   *
   * Measured on this build, exteriors only, each in its own frame:
   *   kestrel  L 14.0  B  9.2  H  5.5  slender 1.52  stance 0.60  parallel 0.27
   *   dray     L 28.0  B 13.4  H 11.7  slender 2.09  stance 0.87  parallel 0.19
   *   pike     L 18.0  B 11.2  H  8.1  slender 1.61  stance 0.72  parallel 0.12
   *   bastion  L 44.0  B 26.8  H 16.4  slender 1.64  stance 0.61  parallel 0.15 */
  const ids = ['kestrel', 'dray', 'pike', 'bastion'];
  const rows = {};
  for (const id of ids) {
    const { root, hull } = await flatHull(id);
    rows[id] = silhouette(root, hull);
  }
  const table = ids.map((id) => {
    const s = rows[id];
    return id + ' L ' + s.length.toFixed(1) + ' B ' + s.beam.toFixed(1) + ' H ' + s.height.toFixed(1)
      + ' slender ' + s.slender.toFixed(2) + ' stance ' + s.stance.toFixed(2)
      + ' parallel ' + s.parallel.toFixed(2);
  });

  /* No hull is a drum. `parallel` is the share of the length carried at full
   * beam and the ceiling is 0.62 — comfortably over the worst of these four,
   * which is the Kestrel at 0.27 because a quarter of its length really is a
   * parallel plated midbody with a compartment inside it. */
  for (const id of ids) {
    assert.ok(rows[id].parallel <= 0.62,
      'ceiling: 0.62 of the length at full beam. achieved: ' + id + ' carries '
      + rows[id].parallel.toFixed(2) + ' - it is a drum with ends on it.\n  ' + table.join('\n  '));
  }

  const same = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = rows[ids[i]], c = rows[ids[j]];
      const rel = (p, q) => Math.abs(p - q) / Math.max(Math.abs(p), Math.abs(q), 1e-6);
      const best = Math.max(rel(a.slender, c.slender), rel(a.stance, c.stance), rel(a.parallel, c.parallel));
      if (best < 0.20) {
        same.push(ids[i] + ' and ' + ids[j] + ' differ by only '
          + (best * 100).toFixed(0) + '% on their strongest axis');
      }
    }
  }
  assert.deepEqual(same, [],
    same.length + ' pairs of hulls read the same:\n  ' + same.join('\n  ') + '\n  ' + table.join('\n  '));

  /* And the guard, because a descriptor that measures nothing reports no
   * duplicates: every hull has to have found real geometry in its own frame. */
  for (const id of ids) {
    assert.ok(rows[id].beam > 3 && rows[id].height > 3,
      id + ' measured B ' + rows[id].beam.toFixed(1) + ' H ' + rows[id].height.toFixed(1)
      + ' - the silhouette probe found nothing');
  }
});

test('the Kestrel pods are as far outboard as its own climb allows, and no further', async () => {
  /* The one place on these four hulls where looks and the climb had to be
   * settled against each other with a number rather than by preference.
   *
   * The pods are the Kestrel's silhouette. The second move of its climb stands
   * ON a pod and reaches for the hull flank, and `FreeClimb` fires its fan out
   * to `P.radius + REACH = 0.97 m` — so the pod's INBOARD edge cannot be more
   * than that beyond the flank or the move becomes a reach across open air.
   * This is what stops the next person moving them 0.4 m further out for the
   * look of it and silently deleting a move. */
  const H = HULL.KESTREL;
  const reach = 0.35 + 0.62;
  assert.ok(H.nacelle.x0 <= H.lower.hw + reach + 1e-9,
    'ceiling: the pod inboard edge at ' + (H.lower.hw + reach).toFixed(2)
    + ' (flank ' + H.lower.hw + ' + reach ' + reach + '). achieved: ' + H.nacelle.x0);
  const band = H.bands[1];
  assert.ok(band.standX >= H.nacelle.x0 && band.standX <= H.nacelle.x1,
    'the second band stands at x ' + band.standX + ' and the pod runs '
    + H.nacelle.x0 + '-' + H.nacelle.x1);
  assert.ok(band.standX - H.lower.hw <= reach,
    'the second band reaches ' + (band.standX - H.lower.hw).toFixed(2)
    + ' m for the flank against a ' + reach + ' m reach');
  /* And the other half of the trade, which a climb test would never notice:
   * a pod flush with the flank is a blister, not a silhouette. */
  assert.ok(H.nacelle.x0 - H.lower.hw >= 0.5,
    'floor: 0.5 m of daylight between flank and pod, or the pod is a blister. achieved: '
    + (H.nacelle.x0 - H.lower.hw).toFixed(2) + ' m');
});

test('the Pike wing is flat over the whole landing its first mantle finishes on', async () => {
  /* The diamond planform is the Pike's silhouette and the flat upper surface
   * is what let it happen: `Climb` puts a mantling body 0.77 m inboard of the
   * edge it grabbed and the capsule is 0.35 m in radius, so 1.12 m in from the
   * wingtip has to be at exactly wing height with nothing on it. All of the
   * section taper is therefore on the UNDERSIDE.
   *
   * Probed with the world's own raycaster against the built colliders at four
   * stations across the landing, rather than asserted off the plan. */
  const { physics } = await measure();
  const H = HULL.PIKE;
  const berth = PLAN.BERTHS.find((b) => b.id === 'pike');
  const down = new THREE.Vector3(0, -1, 0);
  const wantY = berth.cradleTop + H.wing.y1;
  const bad = [];
  for (const s of [-1, 1]) {
    for (const inboard of [0.14, 0.5, 0.77, 1.12]) {
      const side = s > 0 ? 'stbd' : 'port';
      const at = P(berth, s * (H.wing.x1 - inboard), H.wing.y1 + 0.9, H.bands[0].z);
      const hit = physics.raycast(at, down, 1.6, COLLISION_LAYER.WORLD);
      if (!hit) { bad.push(side + ' +' + inboard + ': nothing under the landing at all'); continue; }
      if (Math.abs(hit.point.y - wantY) > 0.06) {
        bad.push(side + ' +' + inboard + ': the surface is at ' + hit.point.y.toFixed(2)
          + ' and the wing is at ' + wantY.toFixed(2));
      }
      if (hit.normal.y < TOP_NORMAL_Y) {
        bad.push(side + ' +' + inboard + ': normal.y ' + hit.normal.y.toFixed(2)
          + ' - the taper has reached the top surface');
      }
    }
  }
  assert.deepEqual(bad, [],
    bad.length + ' of 8 stations across the Pike mantle landing are not flat wing:\n  ' + bad.join('\n  '));
  // ...and the underside really does taper, or "flat over" is describing a slab.
  assert.ok(H.wing.botTip - H.wing.botRoot >= 0.2,
    'floor: 0.2 m of thickness taper root to tip. achieved: '
    + (H.wing.botTip - H.wing.botRoot).toFixed(2) + ' m');
  assert.ok(H.wing.leadRoot - H.wing.leadTip >= 1.5 && H.wing.trailTip - H.wing.trailRoot >= 1.5,
    'floor: 1.5 m of sweep on each edge, or the diamond is a rectangle. achieved: lead '
    + (H.wing.leadRoot - H.wing.leadTip).toFixed(2) + ', trail '
    + (H.wing.trailTip - H.wing.trailRoot).toFixed(2));
});

test('the Bastion stripped bays are holes in her plating, not painted ones', async () => {
  /* What makes a 44 m hull read as a WRECK from across the shed is plating
   * that is not there, and "not there" is the one thing a screenshot of a dark
   * shed cannot settle.
   *
   * ── Counted, not raycast, and the difference is a mutation that survived ──
   * The first version of this test fired a ray into the middle of a bay and
   * compared how deep it went against an intact station. It passed — and it
   * still passed when the panel-line grid was restored across the whole flank,
   * which is exactly the defect the bays were failing on when they were built.
   * Panel seams are 1.7 m apart in z and 0.7 m in y and are 50 mm proud: a ray
   * through the centre of a bay threads between them, and so did a 5 x 5 grid
   * of rays. So the plating band is COUNTED instead — every drawn vertex
   * standing in the slab the plating occupies, inside the bay's own rectangle
   * — and a single restored seam is a non-zero count.
   *
   * The colliders are deliberately not consulted: the section is filled 0.22 m
   * inboard of the plating whether or not a bay is open, which is the honest
   * answer for a hole you can see into and cannot walk through, so a collider
   * probe would report the two stations as identical either way. */
  const { root } = await flatHull('bastion');
  const H = HULL.BASTION;
  const meshes = [];
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  assert.ok(meshes.length > 3, 'only ' + meshes.length + ' meshes on the Bastion - the flat rebuild found nothing');

  /* The band the outer plating occupies: its slab is `SKIN` thick with its
   * outer face on `lower.hw`, and 0.15 m of margin outboard catches anything
   * bolted onto it. */
  /* TRIANGLES, not vertices, and that is a mutation that survived.
   *
   * The first count of this test walked the position attribute. It passed —
   * and it still passed when the panel-line grid was restored across the bays
   * and when the bay frames were put back on the plating line, which are the
   * two defects it exists to catch. A box has vertices only at its corners, so
   * a seam spanning the full height of the flank has none inside a window
   * inset from the top and bottom of a bay, and neither does a frame spanning
   * the full height of the hole. Overlapping each triangle's own box with the
   * window catches both. */
  const a = new THREE.Vector3(), c2 = new THREE.Vector3(), d2 = new THREE.Vector3();
  const onPlate = (y0, y1, z0, z1) => {
    let n = 0;
    for (const o of meshes) {
      const pos = o.geometry?.attributes?.position;
      if (!pos) continue;
      const idx = o.geometry.index;
      const count = idx ? idx.count : pos.count;
      for (let i = 0; i + 2 < count; i += 3) {
        const ia = idx ? idx.getX(i) : i;
        const ib = idx ? idx.getX(i + 1) : i + 1;
        const ic = idx ? idx.getX(i + 2) : i + 2;
        a.fromBufferAttribute(pos, ia).applyMatrix4(o.matrixWorld);
        c2.fromBufferAttribute(pos, ib).applyMatrix4(o.matrixWorld);
        d2.fromBufferAttribute(pos, ic).applyMatrix4(o.matrixWorld);
        const axl = Math.abs(a.x), bxl = Math.abs(c2.x), cxl = Math.abs(d2.x);
        if (Math.max(axl, bxl, cxl) < H.lower.hw - 0.16) continue;
        if (Math.min(axl, bxl, cxl) > H.lower.hw + 0.15) continue;
        if (Math.max(a.y, c2.y, d2.y) < y0 || Math.min(a.y, c2.y, d2.y) > y1) continue;
        if (Math.max(a.z, c2.z, d2.z) < z0 || Math.min(a.z, c2.z, d2.z) > z1) continue;
        n++;
      }
    }
    return n;
  };

  /* A bay has to BE a bay before "nothing is standing in it" means anything:
   * shrink one to 0.1 m and the window this test measures inverts, finds no
   * triangles, and passes. Measured — that mutation survived the first two
   * versions of this test. */
  for (const c of H.stripped) {
    assert.ok(c.z1 - c.z0 >= 3.0 && c.y1 - c.y0 >= 1.2,
      'a stripped bay ' + (c.z1 - c.z0).toFixed(1) + ' x ' + (c.y1 - c.y0).toFixed(1)
      + ' m is not a bay: a window smaller than the probe reports nothing standing in it');
  }

  const bay = H.stripped[0];
  const inset = 0.2;
  const openN = onPlate(bay.y0 + inset, bay.y1 - inset, bay.z0 + inset, bay.z1 - inset);
  // The control: an intact run of flank of the same size, between the two bays.
  const cz = (H.stripped[0].z1 + H.stripped[1].z0) / 2;
  const span = (bay.z1 - bay.z0) / 2;
  const shutN = onPlate(bay.y0 + inset, bay.y1 - inset, cz - span + inset, cz + span - inset);

  assert.ok(shutN >= 200,
    'floor: 200 drawn triangles standing on the plating line over an intact run this size. achieved: '
    + shutN + ' - the control found nothing and this test cannot fail');
  assert.equal(openN, 0,
    'a stripped bay still has ' + openN + ' drawn triangles standing on the plating line '
    + '(the intact run beside it has ' + shutN + '): the hole has been painted back in');

  /* And the bays are nowhere near the flank her climb grips, which is the
   * constraint that decided where they went rather than taste. */
  for (const band of H.bands) {
    for (const c of H.stripped) {
      assert.ok(band.z < c.z0 - 1.5 || band.z > c.z1 + 1.5,
        'a climb band grips the flank at z ' + band.z + ' and a stripped bay runs ' + c.z0 + ' to ' + c.z1);
    }
  }
});

test('the Dray derrick swings clear of the yard it is standing in', async () => {
  /* The boom is the Dray's silhouette and it is 11 m long, so where it is
   * allowed to point is decided by the shed rather than by the ship.
   * `CROSSINGS[0]` runs over this berth at world z 10 with its deck collided
   * at 7.86, and the roof plate is at `ROOF_Y`. A boom that reached the bow
   * would be inside the catwalk; one that swung lower would be through the
   * foredeck a body walks. */
  const { world } = await built();
  const berth = PLAN.BERTHS.find((b) => b.id === 'dray');
  const D = HULL.DRAY.derrick;
  const tip = P(berth, D.mastX, D.tipY, D.tipZ);
  const mast = P(berth, D.mastX, D.mastTop, D.mastZ);
  const crossZ = PLAN.CROSSINGS[0] - 2.4 / 2;
  assert.ok(tip.z < crossZ - 1.0,
    'the boom tip is at world z ' + tip.z.toFixed(1) + ' and the crossing south edge is at ' + crossZ.toFixed(1));
  assert.ok(mast.y < PLAN.ROOF_Y - 4,
    'the masthead is at ' + mast.y.toFixed(1) + ' against a roof plate at ' + PLAN.ROOF_Y);
  // ...and it really is over the foredeck rather than parked over the deckhouse.
  assert.ok(D.tipZ > HULL.DRAY.foredeck.z0 + 2 && D.tipZ < HULL.DRAY.foredeck.z1,
    'the boom tips at local z ' + D.tipZ + ' and the foredeck runs '
    + HULL.DRAY.foredeck.z0 + ' to ' + HULL.DRAY.foredeck.z1);
  // The hook hangs high enough over that deck for a 1.75 m body to walk under.
  assert.ok(D.hookY - HULL.DRAY.foredeck.y >= 2.0,
    'floor: 2.0 m under the hook block. achieved: '
    + (D.hookY - HULL.DRAY.foredeck.y).toFixed(2) + ' m over the foredeck');
  assert.ok(world.shipSpecs.find((s) => s.id === 'dray'),
    'the Dray did not build, and every number above is about nothing');
});
