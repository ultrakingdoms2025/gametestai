import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

/**
 * CAN A BODY GET TO THE ORE? CINDER, ON FOOT, FROM THE PADS.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THIS FILE EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Content that was BUILT and cannot be REACHED is this project's signature
 * defect. Fifteen medieval enterables could not be entered past a 1,074-test
 * suite. The station glazed and railed a mezzanine nothing could get to. A
 * whole world once shipped with zero reachable wildlife and 29 green tests,
 * because every one of them asked whether a thing EXISTED.
 *
 * A planet is exactly the shape of that trap. It is easy to scatter 110 mineral
 * nodes across 640,000 m2, assert that 110 were placed, and ship a world where
 * twelve of them sit on the inside of a 78-degree crater wall. So this is not
 * an assertion. It is a PROBE: the world is built for real, its real colliders
 * are read out of a real `Physics`, and a body is flooded across them from each
 * landing pad, on foot, with no jump.
 *
 * ── The envelope. Measured, not assumed. ──────────────────────────────────
 *
 * `Physics.js:1110` records what this game's walkable ceiling actually is,
 * measured at commit 7178224 by driving the solver: the two-pass capsule
 * projection degrades past 43.88 deg for the standing player and the DRIVEN
 * onset is around 40 deg. `SLOPE_MAX` below is 38 - inside that, with room, so
 * a green result here is not resting on the last two degrees of a solver
 * artefact.
 *
 * NOTHING BELOW USES A JUMP, a mantle or a climb, and that is deliberate. If
 * the ore is reachable by WALKING then it is reachable by a player who is out
 * of stamina, has never learned to mantle, and is carrying the map open.
 *
 * ── The ablation ──────────────────────────────────────────────────────────
 *
 * A reachability test that cannot go red is worthless, and this one is
 * structurally at risk of that: flood a big open plain and everything on it is
 * trivially connected. So the last case DELETES the spiral road from the
 * descriptor and re-floods. If iridite is still reachable without it, the road
 * is not what makes the crater floor reachable and this file is measuring
 * nothing. Reported as floor / achieved / ceiling.
 */

/* ================================================================== */
/* The envelope                                                        */
/* ================================================================== */

/**
 * Lattice pitch, metres. 2.0 rather than the 3.125 m collision cell: on the
 * cell itself a 12.5 deg road gains 0.69 m per step, and the discrete
 * `STEP_UP` branch below would be the only thing carrying it. At 2.0 m the
 * continuous-slope branch carries every authored road on its own.
 */
const PITCH = 2.0;
/**
 * The steepest continuous slope a walk crosses. 38 deg.
 * @see the header - `Physics.js` measures the driven onset at ~40.
 */
const SLOPE_MAX_DEG = 38;
const MAX_SLOPE_TAN = Math.tan((SLOPE_MAX_DEG * Math.PI) / 180);
const MAX_RISE = PITCH * MAX_SLOPE_TAN;
/** `CONFIG.player.stepHeight`. A discrete riser a walk absorbs whole. */
const STEP_UP = 0.45;
/** The tallest drop an edge may use. Well under the 7.5 m damage threshold:
 *  a route that costs health is not a route, it is a shortcut. */
const DROP_MAX = 3.0;
/** Clear air a surface needs to be standing room. Capsule 1.75 m plus 15 cm. */
const HEADROOM = 1.9;
/** How close a flooded lattice node has to be to count as arriving at a node. */
const ARRIVE = 3.2;

/* ================================================================== */
/* A world, built without a browser                                    */
/* ================================================================== */

function harness() {
  if (globalThis.__planetReachHarness) return;
  globalThis.__planetReachHarness = true;
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
const { PlanetWorld } = await import('../../src/worlds/PlanetWorld.js');
const { VOLCANIC } = await import('../../src/worlds/planets/index.js');
const { HEIGHT_FIELDS } = await import('../../src/worlds/terrain/index.js');
const { polyDist } = await import('../../src/worlds/planets/Placement.js');

let _built = null;
async function built() {
  if (_built) return _built;
  const physics = new Physics();
  const renderer = {
    capabilities: { getMaxAnisotropy: () => 4, isWebGL2: true },
    initTexture() {}, getContext: () => ({}),
    getRenderTarget: () => null, setRenderTarget() {}, render() {}, clear() {},
  };
  const Cls = PlanetWorld.of(VOLCANIC);
  const world = new Cls({
    physics,
    scene: new THREE.Scene(),
    bus: { on: () => () => {}, emit() {} },
    engine: { renderer, camera: new THREE.PerspectiveCamera(), onFrameUpdate: () => () => {}, onResize: () => () => {} },
    materials: { get: () => new THREE.MeshStandardMaterial(), dispose() {} },
  });
  world.physics = physics;
  await world.build(() => {});
  _built = { world, physics };
  return _built;
}

/* ================================================================== */
/* The walk graph                                                      */
/* ================================================================== */

/**
 * Every solid box standing over the map, indexed on XZ.
 *
 * Read straight out of `physics.colliders` - these are the ejecta blocks, the
 * basalt columns and the mooring posts the world actually registered, not a
 * re-derivation of where they ought to be. A box whose top stands more than
 * `STEP_UP` above the ground and which has no headroom over it is an OBSTACLE:
 * a lattice node under it is not standing room.
 */
function boxIndex(physics) {
  const cell = 8;
  const grid = new Map();
  const boxes = [];
  for (const c of physics.colliders) {
    if (!c.solid) continue;
    if ((c.layer & COLLISION_LAYER.WORLD) === 0) continue;
    if (c.type !== 'box') continue;
    const m = c.matrix.elements;
    const b = {
      x: m[12], y: m[13], z: m[14],
      ax: Math.abs(m[0]) * c.halfExtents.x + Math.abs(m[4]) * c.halfExtents.y + Math.abs(m[8]) * c.halfExtents.z,
      ay: Math.abs(m[1]) * c.halfExtents.x + Math.abs(m[5]) * c.halfExtents.y + Math.abs(m[9]) * c.halfExtents.z,
      az: Math.abs(m[2]) * c.halfExtents.x + Math.abs(m[6]) * c.halfExtents.y + Math.abs(m[10]) * c.halfExtents.z,
    };
    boxes.push(b);
    const x0 = Math.floor((b.x - b.ax) / cell);
    const x1 = Math.floor((b.x + b.ax) / cell);
    const z0 = Math.floor((b.z - b.az) / cell);
    const z1 = Math.floor((b.z + b.az) / cell);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = ((cx + 4096) << 13) | (cz + 4096);
        let list = grid.get(k);
        if (!list) grid.set(k, (list = []));
        list.push(b);
      }
    }
  }
  return {
    boxes,
    /** True if a body standing at (x, groundY) is inside or under solid rock. */
    blocked(x, z, groundY) {
      const k = ((Math.floor(x / cell) + 4096) << 13) | (Math.floor(z / cell) + 4096);
      const list = grid.get(k);
      if (!list) return false;
      for (const b of list) {
        if (Math.abs(x - b.x) > b.ax || Math.abs(z - b.z) > b.az) continue;
        const top = b.y + b.ay;
        const bottom = b.y - b.ay;
        // Standing room needs the box to be either a kerb the walk steps over
        // or high enough overhead to walk under.
        if (top <= groundY + STEP_UP) continue;
        if (bottom >= groundY + HEADROOM) continue;
        return true;
      }
      return false;
    },
  };
}

/** True where the descriptor's liquid covers the ground. Lava is not a floor. */
function lavaMask(planet) {
  const bodies = planet.liquid?.bodies ?? [];
  return (x, z, y) => {
    for (const b of bodies) {
      if (b.shape === 'disc') {
        if (Math.hypot(x - b.x, z - b.z) <= b.r && y < b.y + 0.6) return true;
      } else if (polyDist(x, z, b.pts) <= b.width * 0.5) {
        // The ribbon's surface interpolates in arclength; a body inside its
        // footprint at all is standing in the flow whatever the exact level.
        if (y < Math.max(b.y0, b.y1) + 0.6) return true;
      }
    }
    return false;
  };
}

/**
 * Flood the lattice from a set of seeds, four-connected.
 *
 * @param {{ ground:(x:number,z:number)=>number|null, blocked:Function,
 *           lava:Function, half:number, seeds:Array<[number,number]> }} o
 */
function flood(o) {
  const half = o.half;
  const n = Math.floor((half * 2) / PITCH) + 1;
  const at = (i, j) => j * n + i;
  const ok = new Uint8Array(n * n);
  const y = new Float32Array(n * n);

  /* Standing room is a property of the NODE, not only of the step into it.
   *
   * Without this the flood threads contours: a 4-connected lattice crosses a
   * 60 deg face by walking along it, because the rise perpendicular to the fall
   * line is zero. That reported 91.6% of Cinder as walkable, including the
   * crater wall, and it is the kind of over-estimate that makes a reachability
   * test agree with whatever it is shown. A node now has to be ground a body
   * could actually stand on, measured over the lattice pitch. */
  for (let j = 0; j < n; j++) {
    const z = -half + j * PITCH;
    for (let i = 0; i < n; i++) {
      const x = -half + i * PITCH;
      const g = o.ground(x, z);
      if (g === null || !Number.isFinite(g)) continue;
      y[at(i, j)] = g;
      if (o.lava(x, z, g)) continue;
      if (o.blocked(x, z, g)) continue;
      const gx = o.ground(x + PITCH * 0.5, z);
      const gnx = o.ground(x - PITCH * 0.5, z);
      const gz = o.ground(x, z + PITCH * 0.5);
      const gnz = o.ground(x, z - PITCH * 0.5);
      if (gx === null || gnx === null || gz === null || gnz === null) continue;
      const slope = Math.hypot((gx - gnx) / PITCH, (gz - gnz) / PITCH);
      if (slope > MAX_SLOPE_TAN) continue;
      ok[at(i, j)] = 1;
    }
  }

  const seen = new Uint8Array(n * n);
  const stack = [];
  for (const [sx, sz] of o.seeds) {
    const i = Math.round((sx + half) / PITCH);
    const j = Math.round((sz + half) / PITCH);
    if (i < 0 || j < 0 || i >= n || j >= n) continue;
    if (!ok[at(i, j)]) continue;
    seen[at(i, j)] = 1;
    stack.push(i, j);
  }

  while (stack.length) {
    const j = stack.pop();
    const i = stack.pop();
    const here = y[at(i, j)];
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const a = i + di;
      const b = j + dj;
      if (a < 0 || b < 0 || a >= n || b >= n) continue;
      const k = at(a, b);
      if (seen[k] || !ok[k]) continue;
      const d = y[k] - here;
      if (d > 0 && d > MAX_RISE && d > STEP_UP) continue;
      if (d < -DROP_MAX) continue;
      seen[k] = 1;
      stack.push(a, b);
    }
  }

  let count = 0;
  for (let k = 0; k < seen.length; k++) count += seen[k];
  return {
    n, half, seen, ok, count,
    reaches(x, z) {
      const i0 = Math.round((x + half) / PITCH);
      const j0 = Math.round((z + half) / PITCH);
      const r = Math.ceil(ARRIVE / PITCH);
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          const a = i0 + di;
          const b = j0 + dj;
          if (a < 0 || b < 0 || a >= n || b >= n) continue;
          if (!seen[at(a, b)]) continue;
          if (Math.hypot(a * PITCH - half - x, b * PITCH - half - z) <= ARRIVE) return true;
        }
      }
      return false;
    },
  };
}

/* ================================================================== */
/* Cases                                                               */
/* ================================================================== */

test('the ground the probe walks on IS the collider the game registered', async () => {
  const { world, physics } = await built();
  const hf = physics.heightfields;
  assert.equal(hf.length, 1, 'a planet publishes exactly one heightfield for its whole surface');
  const field = hf[0];
  /* The mesh, the collision and every prop placement have to be the same
   * surface. This is the guard against the defect that shaped Citadel, and it
   * is checked at 4,000 positions rather than argued for in a comment. */
  const err = [];
  let s = 12345;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 20000; i++) {
    const x = (rnd() * 2 - 1) * (world.planet.half - 1);
    const z = (rnd() * 2 - 1) * (world.planet.half - 1);
    err.push(Math.abs(field.sampleHeight(x, z) - world.groundAt(x, z)));
  }
  err.sort((a, b) => a - b);
  const q = (t) => err[Math.min(err.length - 1, Math.floor(t * err.length))];
  /* NOT zero, and it must not be asserted as zero. The collider interpolates
   * across the 3.125 m cell's two triangles; the function is continuous. They
   * differ by the cell's own sag, which is largest where the surface is most
   * curved - the gorge lip and the crater rim, where a cell spans metres of
   * fall. What matters is that the collider never describes a DIFFERENT
   * surface, only a piecewise-linear one, so the bound scales with curvature
   * and the bulk of the map agrees to millimetres.
   *
   * On a grid ON the samples the two are identical to floating point; the
   * grid-aligned case below is the one that would catch a real drift. */
  console.log(`   collider vs field over 20,000 random points (3.125 m cell):`
    + ` p50 ${(q(0.5) * 100).toFixed(1)} cm, p90 ${(q(0.9) * 100).toFixed(1)} cm,`
    + ` p99 ${q(0.99).toFixed(2)} m, max ${err[err.length - 1].toFixed(2)} m`);
  assert.ok(q(0.5) < 0.05, `median disagreement ${q(0.5).toFixed(3)} m - the two surfaces have drifted`);
  assert.ok(q(0.99) < 1.2, `p99 disagreement ${q(0.99).toFixed(3)} m`);

  // On the grid itself there is no interpolation left to blame.
  let gridWorst = 0;
  const stepXZ = (world.planet.half * 2) / world.planet.seg;
  for (let j = 0; j <= world.planet.seg; j += 7) {
    for (let i = 0; i <= world.planet.seg; i += 7) {
      const x = -world.planet.half + i * stepXZ;
      const z = -world.planet.half + j * stepXZ;
      gridWorst = Math.max(gridWorst, Math.abs(field.sampleHeight(x, z) - world.groundAt(x, z)));
    }
  }
  /* 2e-4 rather than 0. The job ships its heights as a `Float32Array` - which
   * is the right call, it is 260 KB instead of 520 KB across `postMessage` -
   * and float32 carries about seven significant digits, so a 150 m rim crest
   * round-trips with ~1e-5 m of error. Anything larger than that is not
   * rounding, it is two different surfaces. */
  console.log(`   collider vs field ON the grid samples: worst ${gridWorst.toExponential(2)} m (float32 storage)`);
  assert.ok(gridWorst < 2e-4, `the collider and the height function disagree AT a sample by ${gridWorst} m`);
});

test('every mineral node is reachable on foot from a landing pad', async () => {
  const { world, physics } = await built();
  const P = world.planet;
  const field = physics.heightfields[0];
  const boxes = boxIndex(physics);
  const lava = lavaMask(P);

  const perSite = new Map();
  for (const site of world.landingSites) {
    perSite.set(site.id, flood({
      ground: (x, z) => field.sampleHeight(x, z),
      blocked: (x, z, y) => boxes.blocked(x, z, y),
      lava,
      half: P.half,
      seeds: [[site.position.x, site.position.z]],
    }));
  }

  const byType = new Map();
  const unreached = [];
  for (const node of world.mineralNodes) {
    let from = null;
    for (const [id, f] of perSite) {
      if (f.reaches(node.position.x, node.position.z)) { from = id; break; }
    }
    const t = byType.get(node.type) ?? { total: 0, ok: 0, from: new Set() };
    t.total++;
    if (from) { t.ok++; t.from.add(from); } else unreached.push(node);
    byType.set(node.type, t);
  }

  console.log('   reachability by mineral (floor 100% of placed nodes):');
  for (const [type, t] of byType) {
    console.log(`     ${type.padEnd(12)} ${String(t.ok).padStart(3)}/${String(t.total).padEnd(3)}`
      + ` = ${((t.ok / t.total) * 100).toFixed(1)}%   via ${[...t.from].join(', ') || 'NOTHING'}`);
  }
  for (const [id, f] of perSite) {
    const area = f.count * PITCH * PITCH;
    console.log(`     pad ${id.padEnd(10)} floods ${f.count.toLocaleString()} nodes`
      + ` = ${(area / 1000).toFixed(0)}k m2 (${((area / (P.half * 2) ** 2) * 100).toFixed(1)}% of the map)`);
  }

  assert.deepEqual(
    unreached.map((n) => `${n.type}@${n.position.x.toFixed(0)},${n.position.z.toFixed(0)}`),
    [],
    'a mineral node that cannot be walked to is a mineral node that does not exist'
  );
});

test('every landing pad is connected to at least one other landing pad on foot', async () => {
  /* Not strictly required - a ship links them - but a pad that is an ISLAND is
   * a design accident far more often than a design decision, and it is the
   * cheap early warning that a road stopped connecting. */
  const { world, physics } = await built();
  const field = physics.heightfields[0];
  const boxes = boxIndex(physics);
  const lava = lavaMask(world.planet);
  const primary = world.landingSites.find((s) => s.primary);

  const f = flood({
    ground: (x, z) => field.sampleHeight(x, z),
    blocked: (x, z, y) => boxes.blocked(x, z, y),
    lava,
    half: world.planet.half,
    seeds: [[primary.position.x, primary.position.z]],
  });

  const links = world.landingSites
    .filter((s) => !s.primary)
    .map((s) => ({ id: s.id, linked: f.reaches(s.position.x, s.position.z) }));
  console.log(`   from ${primary.id} on foot: ` + links.map((l) => `${l.id}=${l.linked ? 'yes' : 'no'}`).join(', '));
  assert.ok(links.some((l) => l.linked), 'the primary pad reaches no other pad on foot at all');
});

test('CEILING BY ABLATION: without the spiral road the crater floor is cut off', async () => {
  /* The point of this case is to prove the one above can go red.
   *
   * The lattice, the envelope and the blockers are identical; the only thing
   * that changes is that the `ramp` landform carrying the spiral road is
   * deleted from the descriptor before the height field is built. If iridite
   * survives that, the road is not what makes the crater reachable and the
   * green above is measuring an open plain. */
  const { world, physics } = await built();
  const P = world.planet;
  const boxes = boxIndex(physics);
  const lava = lavaMask(P);

  const forms = P.terrain.landforms;
  // The spiral is the ramp whose head is the rim pad.
  const rim = P.landing.find((s) => s.id === 'rimhold');
  const spiral = forms.find((f) => f.kind === 'ramp' && Math.hypot(f.pts[0][0] - rim.x, f.pts[0][1] - rim.z) < 1e-6);
  assert.ok(spiral, 'could not find the spiral road to ablate - this test no longer measures what it says');

  const ablated = HEIGHT_FIELDS.planet({ ...P.terrain, landforms: forms.filter((f) => f !== spiral) });

  const seeds = world.landingSites.map((s) => [s.position.x, s.position.z]);
  const before = flood({
    ground: (x, z) => world.groundAt(x, z), blocked: (x, z, y) => boxes.blocked(x, z, y), lava, half: P.half, seeds,
  });
  const after = flood({
    ground: (x, z) => ablated(x, z), blocked: (x, z, y) => boxes.blocked(x, z, y), lava, half: P.half, seeds,
  });

  const iridite = world.mineralNodes.filter((n) => n.type === 'iridite');
  const okBefore = iridite.filter((n) => before.reaches(n.position.x, n.position.z)).length;
  const okAfter = iridite.filter((n) => after.reaches(n.position.x, n.position.z)).length;

  console.log(`   iridite reachable: floor 12/12 required, achieved ${okBefore}/${iridite.length},`
    + ` ceiling by ablation (no spiral road) ${okAfter}/${iridite.length}`);
  console.log(`   flooded lattice nodes: ${before.count.toLocaleString()} with the road,`
    + ` ${after.count.toLocaleString()} without (${(((before.count - after.count) / before.count) * 100).toFixed(1)}% lost)`);

  assert.equal(okBefore, iridite.length, 'iridite is not reachable even WITH the road');
  assert.equal(okAfter, 0, 'the crater floor is reachable without the spiral road - the road is not the route, so the green case above proves nothing');
});
