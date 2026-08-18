import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

/**
 * CAN ANYBODY ACTUALLY GET GOLD?
 *
 * A gold nobody can reach is the same defect as a relic nobody can find, and
 * this project has shipped that defect four times in a row by computing a
 * number instead of driving one. So no par time in `RooftopTrial` is asserted
 * here against a constant. Every one of them is re-derived, on every run, from
 * three measurements taken in this file:
 *
 *   1. **The pace**, from the real `Player` with the real `Stamina` pool, held
 *      at each gait on a flat rig. Not `sprintSpeed`: the number a runner
 *      actually averages once the drain/regen cycle is paid for.
 *   2. **The climb**, from the same real `Player` at a wall rig. Attach cost
 *      and ascent rate, measured rather than read off `FreeClimb`'s constants -
 *      a constant is what the code says, a rig is what the body does.
 *   3. **The route**, from a pad graph over the citadel's OWN published decks,
 *      with every deck edge found by probing the real colliders and every
 *      crossing validated by flying the real integrator at the three budgets.
 *
 * Those three are then composed by stepping the route through a real `Stamina`
 * instance - paying 15/s to sprint, 14 a leap, 7.0/s to climb, and WAITING when
 * the pool cannot afford the next leap - at three gaits. The fastest of the
 * three is the number gold has to be reachable against.
 *
 * -- The one thing that is NOT driven, and why ------------------------------
 *
 * A real `Player` autopilot was tried first and abandoned, and it is worth
 * recording why rather than leaving the next reader to repeat it. A body that
 * beelines at the next checkpoint 65 m away falls off the ring it is standing
 * on; a body that steers to stay on decks needs a rooftop-parkour AI. The
 * discarded probe "ran" the 483 m dash in 152 s with 110 s of that airborne and
 * 40 s of it free-climbing back out of the street - a measurement of the
 * autopilot, not of the route. (Those figures come from that probe and are NOT
 * reproduced by anything below; they are recorded so the next reader does not
 * spend the afternoon the same way.)
 *
 * What is done instead keeps every ingredient real and puts the arithmetic
 * where arithmetic belongs. Where the composition is imprecise it is imprecise
 * in the SAFE direction: it charges a descent at running pace when a falling
 * body covers ground faster, which is why the skyline ends up carrying 25% of
 * gold headroom against the flat dash's 15%.
 *
 * -- Cost -------------------------------------------------------------------
 *
 * One headless citadel build (~0.3 s), one pad graph (~0.1 s) and about 4
 * minutes of simulated player time at 60 Hz. Shared by every test through
 * `measure()`.
 */

/* ================================================================== */
/* A world and a body, without a browser                               */
/* ================================================================== */

/** Template: citadel-reach.test.mjs:165, itself from npc-routes.test.mjs:147. */
function harness() {
  if (globalThis.__rooftopTimesHarness) return;
  globalThis.__rooftopTimesHarness = true;
  class Img {
    constructor(a, b, c) {
      if (typeof a === 'number') {
        this.width = a; this.height = b; this.data = new Uint8ClampedArray(a * b * 4);
      } else { this.data = a; this.width = b; this.height = c ?? 1; }
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
    createElement(tag) {
      const c = { width: 1, height: 1, style: {}, tagName: tag };
      c.getContext = () => context2d(c);
      return c;
    },
    createElementNS(_ns, tag) { return this.createElement(tag); },
  };
  globalThis.window = globalThis;
  globalThis.OffscreenCanvas = class {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { return context2d(this); }
  };
  const dead = () => ({ texture: null, dispose() {} });
  THREE.PMREMGenerator.prototype.fromEquirectangular = dead;
  THREE.PMREMGenerator.prototype.fromScene = dead;
  THREE.PMREMGenerator.prototype.compileEquirectangularShader = () => {};
}
harness();

const { Physics } = await import('../../src/physics/Physics.js');
const { Player } = await import('../../src/player/Player.js');
const { Stamina } = await import('../../src/systems/Stamina.js');
const {
  parTimes, REF_PACE, CLIMB_LEG_S, LEAP_APEX, MEDAL_FACTOR,
  venueBounds, venueCoversRoute,
} = await import('../../src/minigames/RooftopTrial.js');

const { CONFIG } = await import('../../src/core/Config.js');

const DT = 1 / 60;
const GRAVITY = -22;

/**
 * The two ground TOP speeds, read off the config the player actually uses.
 *
 * `sprintSpeed` and not `sprintWishSpeed`: the grounded cap is
 * `acceleration / friction` = 8.2, which is what the flight budgets below are
 * also built on.
 */
const TOP = { walk: CONFIG.player.walkSpeed, sprint: CONFIG.player.sprintSpeed };

/* The three budgets a body can leave a roof with, restated from the design's
 * measured envelope. `v` is what lands in `_velocity.y` on the jump step and
 * `h` is the horizontal speed carried into it: walk 4.6, the GROUNDED sprint
 * cap 8.2 (acceleration / friction, not `sprintWishSpeed` 11.2), and the leap's
 * LEAP_LIFT 1.12 x 6.4 with LEAP_BOOST 1.42 x 8.2. */
const BUDGETS = [
  { id: 'walk', v: 6.4, h: 4.6 },
  { id: 'sprint', v: 6.4, h: 8.2 },
  { id: 'leap', v: 6.4 * 1.12, h: 8.2 * 1.42 },
];

/* Stamina prices, from the systems that charge them. */
const SPRINT_DRAIN = 15;
const LEAP_COST = 14;
const CLIMB_DRAIN = 1.6 + 5.4;

function makeInput() {
  return {
    state: {
      forward: 0, right: 0, jump: false, sprint: false, crouch: false, fire: false,
      aim: false, reload: false, interact: false, lookX: 0, lookY: 0, wheel: 0,
    },
  };
}

function makePlayer(physics, world = null) {
  const bus = { on: () => () => {}, emit() {} };
  const input = makeInput();
  const player = new Player({
    scene: new THREE.Scene(), engine: {}, physics, bus, materials: {}, input,
    camera: new THREE.PerspectiveCamera(),
  });
  // `Player` reads world rules off a `world:changed` the stub bus never
  // delivers; `allows(null, ...)` permits everything, but say it out loud.
  player._world = world;
  player.setYaw(-Math.PI / 2);          // forward is +X
  return { player, input };
}

/* ================================================================== */
/* Rig 1 - the pace                                                    */
/* ================================================================== */

/** Flat ground, 4 km of it, nothing to trip over. */
function flatRig() {
  const physics = new Physics();
  const deck = new THREE.Mesh(new THREE.BoxGeometry(8000, 4, 200));
  deck.position.set(0, -2, 0);
  deck.updateWorldMatrix(true, false);
  physics.addBoxFromObject(deck);
  return physics;
}

/**
 * Hold one gait for `seconds` and report the metres per second the body
 * actually averaged.
 *
 * `jumpEvery` is metres of ground covered between take-offs, because a rooftop
 * runner does not choose when to jump - the gap does. `leap` decides whether
 * sprint is still held on the take-off frame: `Parkour.tryLeap` turns EVERY
 * sprinting jump into a leap and charges 14 stamina for it, so a runner who
 * wants a plain jump has to let go of sprint for one frame. That is a real
 * technique and the difference between the two rows below is what it is worth.
 */
function pace({ sprint, jumpEvery = 0, leap = false, seconds = 90 }) {
  const physics = flatRig();
  const { player, input } = makePlayer(physics);
  player._position.set(0, 1.2, 0);
  for (let i = 0; i < 60; i++) player.fixedUpdate(DT, i * DT);
  const x0 = player.position.x;
  let sinceJump = 0;
  let jumps = 0;
  let leaps = 0;
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    const s = input.state;
    s.forward = 1;
    s.sprint = typeof sprint === 'function' ? sprint(player) : !!sprint;
    let j = false;
    if (jumpEvery > 0 && player.grounded) {
      sinceJump += Math.hypot(player.velocity.x, player.velocity.z) * DT;
      if (sinceJump >= jumpEvery) { j = true; sinceJump = 0; }
    }
    if (j && !leap) s.sprint = false;
    s.jump = j;
    const before = player.stamina?.value ?? 0;
    player.fixedUpdate(DT, (60 + i) * DT);
    if (j) { jumps++; if ((player.stamina?.value ?? 0) < before - 10) leaps++; }
  }
  return { v: (player.position.x - x0) / seconds, jumps, leaps };
}

/* ================================================================== */
/* Rig 2 - the climb                                                   */
/* ================================================================== */

/** A street with one climbable face `h` metres high, 20 m ahead. */
function wallRig(h) {
  const physics = new Physics();
  const add = (m) => { m.updateWorldMatrix(true, false); physics.addBoxFromObject(m); return m; };
  const street = new THREE.Mesh(new THREE.BoxGeometry(200, 4, 60));
  street.position.set(0, -2, 0);
  add(street);
  const block = new THREE.Mesh(new THREE.BoxGeometry(30, h, 40));
  block.position.set(35, h / 2, 0);
  add(block);
  return physics;
}

/** Run at the wall holding jump, and report when the body stands on top. */
function climbRun(h) {
  const physics = wallRig(h);
  const { player, input } = makePlayer(physics);
  player._position.set(14, 1.2, 0);
  for (let i = 0; i < 60; i++) player.fixedUpdate(DT, i * DT);
  let t = 0;
  let attachedAt = -1;
  let toppedAt = -1;
  for (let steps = 0; steps < 60 * 90; steps++) {
    const s = input.state;
    s.forward = 1;
    s.sprint = !player.isFreeClimbing;
    // Space HELD into the face, which is what `Player` distinguishes from a
    // jump near a wall - see the "grab a wall" block.
    s.jump = player.position.x > 18.5;
    player.fixedUpdate(DT, t);
    t += DT;
    if (player.isFreeClimbing && attachedAt < 0) attachedAt = t;
    if (player.grounded && player.position.y > h - 0.5) { toppedAt = t; break; }
  }
  return { h, ok: toppedAt > 0, total: toppedAt, attachedAt, face: toppedAt > 0 ? toppedAt - attachedAt : null };
}

/* ================================================================== */
/* Rig 3 - the route                                                   */
/* ================================================================== */

let _built = null;
async function buildCitadel() {
  if (_built) return _built;
  const { CitadelWorld } = await import('../../src/worlds/CitadelWorld.js');
  const physics = new Physics();
  const renderer = {
    capabilities: { getMaxAnisotropy: () => 4, isWebGL2: true },
    initTexture() {}, getContext: () => ({}),
    getRenderTarget: () => null, setRenderTarget() {}, render() {}, clear() {},
  };
  const scene = new THREE.Scene();
  const world = new CitadelWorld({
    physics, scene,
    bus: { on: () => () => {}, emit() {} },
    engine: { renderer, onFrameUpdate: () => () => {}, onResize: () => () => {} },
    materials: { get: () => new THREE.MeshStandardMaterial(), dispose() {} },
  });
  world.physics = physics;
  await world.build(() => {});
  _built = { world, physics, scene };
  return _built;
}

/**
 * Horizontal distance a budget carries before the body has fallen back to
 * `dy`, and the seconds it spends doing it.
 *
 * `Player.fixedUpdate` applies gravity BEFORE `_move` integrates, so the first
 * step of the rise is taken at `v0 + g*dt` and the arc permanently loses
 * |g|dt^2/2. This reproduces that ORDER rather than the closed form - which is
 * why `flat` comes out at 4.647 m for a sprint jump and not the 4.72 the
 * textbook gives, and why the apex is 0.878 and not 0.93.
 */
function fly(v, h, dy) {
  let y = 0;
  let vy = v;
  let x = 0;
  let t = 0;
  let apex = 0;
  let above = dy <= 0;
  for (let i = 0; i < 240; i++) {
    vy += GRAVITY * DT;
    y += vy * DT;
    x += h * DT;
    t += DT;
    if (y > apex) apex = y;
    if (y > dy) above = true;
    if (above && vy < 0 && y <= dy) return { x, t, apex };
  }
  return { x: 0, t: 0, apex };
}

/**
 * The deck network, as a graph, built from what the world publishes and what
 * the colliders answer - never from the generator.
 *
 * Nodes are the world's own `_roofs`, `_towers` and rope-bridge midpoints,
 * which `citadel-reach.test.mjs` already proves are the tops of real colliders.
 * Edges are classified by probing: march out from each pad along the line of
 * centres until the deck stops answering, and the gap is what is left over.
 */
function buildGraph({ world, physics }) {
  const deck = (x, z, fromY, dist = 90) => physics.groundHeight(x, z, fromY, dist);

  const pads = [];
  for (const r of world._roofs) {
    pads.push({ x: r.x, y: r.y, z: r.z, kind: r.ring === undefined ? 'roof' : 'souk', ring: r.ring });
  }
  for (const t of world._towers) {
    pads.push({ x: t.x, y: t.y, z: t.z, kind: t.great ? 'great' : t.minaret ? 'minaret' : 'tower' });
  }
  for (const b of world.ropeBridges) {
    pads.push({ x: b.mid.x, y: b.mid.y, z: b.mid.z, kind: 'plank', bridge: b.id });
  }

  /* 30% of souk roofs carry a dome standing proud of the middle of the deck, so
   * a pad at the published centre can be a pad inside a dome. Ask the collision
   * world, the same probe `CitadelWorld._publishVenues` uses on its own
   * checkpoints. */
  let snapped = 0;
  let orphan = 0;
  for (const pad of pads) {
    const on = (x, z) => {
      const g = deck(x, z, pad.y + 1.2, 4.0);
      return g !== null && Math.abs(g - pad.y) < 0.3;
    };
    if (on(pad.x, pad.z)) continue;
    let fixed = false;
    for (const r of [2.0, 3.0, 4.0]) {
      for (let i = 0; i < 8 && !fixed; i++) {
        const a = (i / 8) * Math.PI * 2;
        const x = pad.x + Math.cos(a) * r;
        const z = pad.z + Math.sin(a) * r;
        if (on(x, z)) { pad.x = x; pad.z = z; fixed = true; snapped++; }
      }
      if (fixed) break;
    }
    if (!fixed) { pad.orphan = true; orphan++; }
  }

  /** March out along (ux,uz) until the deck under the probe stops being this pad's. */
  const edgeAlong = (pad, ux, uz) => {
    let lo = 0;
    let hi = 0;
    for (let L = 0.5; L <= 26; L += 0.5) {
      const g = deck(pad.x + ux * L, pad.z + uz * L, pad.y + 1.2, 4.0);
      if (g !== null && Math.abs(g - pad.y) < 0.45) { lo = L; continue; }
      hi = L;
      break;
    }
    if (hi === 0) return lo;
    for (let i = 0; i < 7; i++) {
      const m = (lo + hi) / 2;
      const g = deck(pad.x + ux * m, pad.z + uz * m, pad.y + 1.2, 4.0);
      if (g !== null && Math.abs(g - pad.y) < 0.45) lo = m; else hi = m;
    }
    return lo;
  };
  const streetY = (x, z) => deck(x, z, 19.0, 24);

  const adj = pads.map(() => []);
  const tally = {};
  for (let i = 0; i < pads.length; i++) {
    for (let j = i + 1; j < pads.length; j++) {
      const a = pads[i];
      const b = pads[j];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const D = Math.hypot(dx, dz);
      if (D > 26 || D < 1e-3) continue;
      const ux = dx / D;
      const uz = dz / D;
      const gap = D - edgeAlong(a, ux, uz) - edgeAlong(b, -ux, -uz);
      const link = (from, to) => {
        const A = pads[from];
        const B = pads[to];
        const dy = B.y - A.y;
        let kind = null;
        let air = 0;
        let flightT = 0;
        if (gap <= 0.4 && Math.abs(dy) <= 0.95) kind = 'walk';
        else if (gap <= 0.95 && dy > 0.95 && dy <= 2.4) kind = 'mantle';
        else if (gap <= 0.4 && dy < -0.95) kind = 'drop';
        else {
          for (const bd of BUDGETS) {
            const f = fly(bd.v, bd.h, dy);
            // 0.4 m of landing margin: the arc is flown as a point and the body
            // is 0.33 m wide.
            if (f.x >= gap + 0.4) { kind = bd.id; air = gap; flightT = f.t; break; }
          }
        }
        let rise = 0;
        let drop = 0;
        if (!kind && dy > 0) {
          /* No ballistic answer and the target is above: the body goes down
           * into the street and up the far face. Legal here because the souk's
           * plaster walls carry window-course colliders precisely so they can
           * be climbed - CitadelWorld:1470. */
          const gY = streetY((A.x + B.x) / 2, (A.z + B.z) / 2);
          if (gY !== null && B.y - gY <= 29.3 && gap <= 9 && A.y - gY <= 40) {
            kind = 'climb';
            rise = B.y - gY;
            drop = A.y - gY;
          }
        }
        if (!kind) return;
        tally[kind] = (tally[kind] ?? 0) + 1;
        adj[from].push({ to, kind, gap: Math.max(0, gap), air, flightT, rise, drop, dy, dist: Math.hypot(D, dy), D });
      };
      link(i, j);
      link(j, i);
    }
  }
  /* The rope bridges. Their planks are not published individually, so the span
   * is modelled from the three points that ARE - the two anchors and the
   * catenary's own low point - rather than by recomputing the generator. */
  for (const b of world.ropeBridges) {
    const at = (p) => pads.findIndex((q) => Math.hypot(q.x - p.x, q.z - p.z) < 3 && Math.abs(q.y - p.y) < 3);
    const mid = pads.findIndex((q) => q.bridge === b.id);
    for (const [u, v] of [[at(b.a), mid], [mid, at(b.b)]]) {
      if (u < 0 || v < 0 || u === v) continue;
      const dist = Math.hypot(pads[v].x - pads[u].x, pads[v].y - pads[u].y, pads[v].z - pads[u].z);
      for (const [p, q] of [[u, v], [v, u]]) {
        adj[p].push({ to: q, kind: 'bridge', gap: 0, air: 0, flightT: 0, rise: 0, drop: 0, dy: pads[q].y - pads[p].y, dist, D: dist });
      }
      tally.bridge = (tally.bridge ?? 0) + 2;
    }
  }

  const nearest = (c) => {
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < pads.length; i++) {
      const d = Math.hypot(pads[i].x - c.x, pads[i].z - c.z) + Math.abs(pads[i].y - c.y) * 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };
  /* Dijkstra on a time-shaped cost, so a route that could go the long way round
   * on the flat is preferred to one that stops to climb. */
  const cost = (e) => (e.kind === 'climb'
    ? Math.sqrt(2 * Math.max(0, e.drop) / 22) + e.D / 8.2 + e.rise / 2.05 + 0.7
    : (e.D - e.air) / 8.2 + e.flightT);
  const path = (src, dst) => {
    const dist = new Float64Array(pads.length).fill(Infinity);
    const prev = new Int32Array(pads.length).fill(-1);
    const seen = new Uint8Array(pads.length);
    dist[src] = 0;
    for (;;) {
      let u = -1;
      let bu = Infinity;
      for (let i = 0; i < pads.length; i++) if (!seen[i] && dist[i] < bu) { bu = dist[i]; u = i; }
      if (u < 0 || u === dst) break;
      seen[u] = 1;
      for (const e of adj[u]) {
        const d = dist[u] + cost(e);
        if (d < dist[e.to]) { dist[e.to] = d; prev[e.to] = u; }
      }
    }
    if (!Number.isFinite(dist[dst])) return null;
    const nodes = [];
    for (let c = dst; c >= 0; c = prev[c]) nodes.push(c);
    nodes.reverse();
    const edges = [];
    for (let k = 1; k < nodes.length; k++) edges.push(adj[nodes[k - 1]].find((e) => e.to === nodes[k]));
    return edges;
  };
  return { pads, adj, nearest, path, tally, snapped, orphan };
}

/** The edge list a whole route resolves to, or null if any leg has no path. */
function routeEdges(graph, cps) {
  const out = [];
  for (let i = 1; i < cps.length; i++) {
    const legs = graph.path(graph.nearest(cps[i - 1]), graph.nearest(cps[i]));
    if (!legs) return null;
    out.push(...legs);
  }
  return out;
}

/**
 * Step a route through a REAL `Stamina` pool at one gait and report the clock.
 *
 * This is where the three rigs meet, and the ground speeds it runs at are the
 * TOP speeds off `Config` - `walkSpeed` 4.6 and the grounded sprint cap 8.2 -
 * never the flat rig's 6.29. That distinction is the correctable mistake this
 * file made first time out: 6.29 is what a sprinter AVERAGES once the pool's
 * drain/regen cycle has been paid for, so running at 6.29 while also draining
 * the pool charges the same cycle twice and cost the ascent's par 3 s it should
 * never have had. The pool is the shipped class, so the exhaustion latch
 * (`RECOVER_FRACTION` 0.22) and the 0.9 s regen delay are live, and re-reading
 * the gait every step is what lets a runner drop to a jog mid-edge - which is
 * exactly how the 6.29 emerges again as an OUTPUT. `the simulator reproduces
 * the flat rig` below is that check.
 */
function simulate(edges, gait, paces) {
  const stam = new Stamina({ bus: { on: () => () => {}, emit() {} } });
  let t = 0;
  let waiting = 0;
  let leaps = 0;
  let sprintM = 0;
  let jogM = 0;
  /** Cover `metres` of deck, re-deciding the gait on every step. */
  const cover = (metres) => {
    let left = metres;
    while (left > 1e-9) {
      const sprinting = gait(stam) && stam.canSprint;
      const v = sprinting ? paces.sprintTop : paces.walkTop;
      const d = Math.min(left, v * DT);
      const dt = d / v;
      if (sprinting) { stam.drain(SPRINT_DRAIN * dt, 'sprint'); sprintM += d; } else jogM += d;
      stam.fixedUpdate(dt, t);
      t += dt;
      left -= d;
    }
  };
  const waitFor = (need) => {
    let w = 0;
    while (stam.value < need && w < 60) { stam.fixedUpdate(DT, t); t += DT; w += DT; }
    waiting += w;
  };
  for (const e of edges) {
    if (e.kind === 'climb') {
      t += Math.sqrt(2 * Math.max(0, e.drop) / 22);
      cover(Math.max(0, e.D - 1));
      waitFor(Math.min(99, (e.rise / paces.climb) * CLIMB_DRAIN + 4));
      t += paces.attach;
      let left = e.rise;
      while (left > 0) {
        stam.drain(CLIMB_DRAIN * DT, 'climb');
        stam.fixedUpdate(DT, t);
        t += DT;
        left -= paces.climb * DT;
      }
      continue;
    }
    cover(Math.max(0, e.D - e.air));
    if (e.kind === 'leap') {
      waitFor(LEAP_COST);
      stam.spend(LEAP_COST, 'leap');
      leaps++;
      t += e.flightT;
    } else if (e.air > 0) {
      t += e.flightT;
    }
  }
  return { t, waiting, leaps, left: stam.value, sprintM, jogM };
}

const GAITS = {
  committed: () => true,
  managed: (s) => s.value > 50,
  jog: () => false,
};

/* ================================================================== */
/* One measurement, shared                                             */
/* ================================================================== */

let _measured = null;
async function measure() {
  if (_measured) return _measured;
  const built = await buildCitadel();
  const graph = buildGraph(built);

  const paces = {
    walk: pace({ sprint: false }).v,
    sprint: pace({ sprint: true }).v,
    sprintJump: pace({ sprint: true, jumpEvery: 15 }).v,
    sprintLeap: pace({ sprint: true, jumpEvery: 15, leap: true }).v,
    managed: pace({ sprint: (p) => (p.stamina?.value ?? 100) > 50, jumpEvery: 15 }).v,
  };
  const climbs = [6, 10, 14].map(climbRun);
  const ok = climbs.filter((c) => c.ok);
  const rate = ok.length >= 2
    ? (ok[ok.length - 1].h - ok[0].h) / (ok[ok.length - 1].face - ok[0].face)
    : 2.05;
  const attach = ok.length ? ok[0].attachedAt : 0.7;

  const routes = [];
  for (const v of built.world.minigameVenues) {
    const cps = v.config.checkpoints;
    const edges = routeEdges(graph, cps);
    const par = parTimes(cps, v.config.routeLength);
    const runs = {};
    if (edges) {
      for (const [name, gait] of Object.entries(GAITS)) {
        runs[name] = simulate(edges, gait, { sprintTop: TOP.sprint, walkTop: TOP.walk, climb: rate, attach });
      }
    }
    routes.push({
      venue: v,
      cps,
      edges,
      par,
      runs,
      metres: edges ? edges.reduce((a, e) => a + e.dist, 0) : 0,
      climbs: edges ? edges.filter((e) => e.kind === 'climb').length : 0,
      best: Object.values(runs).length ? Math.min(...Object.values(runs).map((r) => r.t)) : Infinity,
    });
  }
  _measured = { ...built, graph, paces, climbRate: rate, attach, climbs, routes };
  return _measured;
}

/**
 * Floor / achieved / ceiling, the format citadel-reach.test.mjs established -
 * and BOTH ends asserted, which this copy used not to do.
 *
 * It printed a ceiling and asserted only the floor, while every call site
 * passed `100` for the ceiling of a percentage: a decorative column. The
 * original's docstring is explicit that a wrong ceiling must fail, and the
 * reason is the one this file is full of - a gold with 45% of headroom is a
 * gold everybody gets, which is the same defect as a gold nobody gets wearing
 * the opposite hat. The two upper bounds were asserted separately below with
 * good messages; they are folded into this call now rather than standing
 * beside it, because two guards on one property means deleting either one
 * leaves the behaviour correct and neither can be proved load-bearing.
 */
function floorCheck(label, floor, achieved, ceiling, note = '') {
  const pad = String(label).padEnd(52);
  console.log(`    ${pad} floor ${String(floor).padStart(8)}   achieved ${String(achieved).padStart(8)}   ceiling ${String(ceiling).padStart(8)} ${note}`);
  assert.ok(achieved >= floor, `${label}: ${achieved} is under the floor of ${floor}`);
  assert.ok(achieved <= ceiling, `${label}: ${achieved} is over the ceiling of ${ceiling}`);
}

/* ================================================================== */
/* The rigs, proved against themselves                                 */
/* ================================================================== */

test('the flat rig reproduces the paces the par model was calibrated on', async () => {
  const { paces } = await measure();
  for (const [k, v] of Object.entries(paces)) console.log(`    ${k.padEnd(12)} ${v.toFixed(3)} m/s`);

  /* A walk is `walkSpeed` exactly - there is nothing to pay for. */
  assert.ok(Math.abs(paces.walk - 4.6) < 0.05, `walk measured ${paces.walk.toFixed(3)}, expected walkSpeed 4.6`);
  /* Sprint is NOT `sprintSpeed` 8.2: the pool empties in 6.67 s and latches
   * until 22%, so the sustained average is the duty cycle. TrackRace derives
   * 6.21 m/s for the same cycle by hand; this drives it. */
  assert.ok(paces.sprint > 5.9 && paces.sprint < 6.6, `sustained sprint measured ${paces.sprint.toFixed(3)}, expected ~6.26`);
  assert.ok(paces.sprint < 8.2, 'a sustained sprint cannot be the sprint top speed');
  /* Jumping does not cost time - the arc is ballistic at the speed you left
   * at - and leaping BUYS time at 11.64 m/s horizontal. If this inverts, the
   * whole "gaps cost stamina, not seconds" argument in RooftopTrial is void. */
  assert.ok(paces.sprintJump >= paces.sprint - 0.05, 'jumping every 15 m cost time');
  assert.ok(paces.sprintLeap > paces.sprintJump, 'leaping was not faster than jumping');
  /* And the module's reference pace has to be reachable on the flat before any
   * question about a route arises. */
  assert.ok(paces.sprint > REF_PACE, `REF_PACE ${REF_PACE} is above the sustained sprint ${paces.sprint.toFixed(3)}`);
});

test('the wall rig reproduces FreeClimb`s ascent rate and its attach cost', async () => {
  const { climbs, climbRate, attach } = await measure();
  for (const c of climbs) {
    console.log(`    wall ${String(c.h).padStart(2)} m: ok=${c.ok} attach ${c.attachedAt.toFixed(2)} s, face ${(c.face ?? 0).toFixed(2)} s, total ${(c.total ?? 0).toFixed(2)} s`);
    assert.ok(c.ok, `the body never got to the top of a ${c.h} m wall`);
  }
  /* `FreeClimb.SPEED_UP` is 2.05. Measured off the rig rather than read off the
   * constant, because a constant is what the code says and a rig is what the
   * body does. */
  assert.ok(Math.abs(climbRate - 2.05) < 0.06, `climb rate measured ${climbRate.toFixed(3)} m/s, expected 2.05`);
  assert.ok(attach > 0.3 && attach < 1.4, `attach measured ${attach.toFixed(2)} s`);
  /* The per-leg charge the par model makes has to cover a real souk face. The
   * inner rings stand 12-13 m over the street. */
  const twelve = 12 / climbRate + attach;
  console.log(`    a 12 m souk face costs ${twelve.toFixed(2)} s; the par model charges ${CLIMB_LEG_S} s a climb leg`);
  assert.ok(CLIMB_LEG_S >= twelve * 0.95, `CLIMB_LEG_S ${CLIMB_LEG_S} is under the ${twelve.toFixed(2)} s a 12 m face costs`);
});

test('the flight model reproduces the browser-measured movement envelope', async () => {
  /* First, because every route number depends on it. The three flat gaps and
   * the two apexes were measured live in a browser; if this drifts, nothing
   * else in the file means anything. */
  const rows = BUDGETS.map((b) => ({ id: b.id, ...fly(b.v, b.h, 0) }));
  for (const r of rows) console.log(`    ${r.id.padEnd(7)} flat ${r.x.toFixed(3)} m, apex ${r.apex.toFixed(3)} m, air ${r.t.toFixed(3)} s`);
  const [walk, sprint, leap] = rows;
  assert.ok(Math.abs(walk.x - 2.607) < 0.01, `walk jump ${walk.x.toFixed(3)}, measured 2.607`);
  assert.ok(Math.abs(sprint.x - 4.647) < 0.01, `sprint jump ${sprint.x.toFixed(3)}, measured 4.647`);
  assert.ok(Math.abs(leap.x - 7.569) < 0.01, `leap ${leap.x.toFixed(3)}, measured 7.569`);
  assert.ok(Math.abs(walk.apex - 0.878) < 0.005, `jump apex ${walk.apex.toFixed(3)}, measured 0.878`);
  assert.ok(Math.abs(leap.apex - LEAP_APEX) < 0.005, `leap apex ${leap.apex.toFixed(3)}, measured ${LEAP_APEX}`);
  /* The closed form gives 0.930 and 1.170. It is wrong because gravity is
   * applied before the integrator; 5 cm is a ledge band a leap does not clear. */
  assert.ok(walk.apex < 6.4 * 6.4 / 44, 'the integrator is agreeing with the closed form, which means it is wrong');
});

/* ================================================================== */
/* The routes                                                          */
/* ================================================================== */

test('every published rooftop route resolves on the real deck network', async () => {
  const { routes, graph } = await measure();
  console.log(`    ${graph.pads.length} pads (${graph.snapped} moved off a dome, ${graph.orphan} on no deck), edges ${JSON.stringify(graph.tally)}`);
  assert.ok(routes.length >= 3, 'the citadel should publish three rooftop venues');
  for (const r of routes) {
    const kinds = {};
    for (const e of r.edges ?? []) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
    console.log(`    ${r.venue.id.padEnd(20)} chain ${r.par.chain.toFixed(1).padStart(6)} m -> route ${r.metres.toFixed(1).padStart(6)} m over ${String(r.edges?.length ?? 0).padStart(3)} edges  ${JSON.stringify(kinds)}`);
    assert.ok(r.edges, `${r.venue.id}: a leg of this route has no path over the decks at all`);
    /* The route a body walks is longer than the chain a world publishes, and
     * REF_PACE is priced in CHAIN metres - so if a route ever weaves far enough
     * that the ratio blows out, the par stops being generous and starts being
     * unreachable. Recorded as a measurement, floored so it cannot creep. */
    const detour = r.metres / r.par.chain;
    assert.ok(detour >= 0.95, `${r.venue.id}: the graph found a route SHORTER than the published chain (${detour.toFixed(3)})`);
    assert.ok(detour < 1.45, `${r.venue.id}: the route weaves ${detour.toFixed(2)}x the published chain; REF_PACE cannot absorb that`);
  }
});

test('FLOOR: every gold is reachable, measured against the real Stamina pool', async () => {
  const { routes } = await measure();
  for (const r of routes) {
    const rows = Object.entries(r.runs)
      .map(([k, v]) => `${k} ${v.t.toFixed(1)}s (${v.waiting.toFixed(1)}s waiting, ${v.leaps} leaps)`)
      .join('  ');
    console.log(`    ${r.venue.id.padEnd(20)} ${rows}`);
    console.log(`    ${''.padEnd(20)} par gold ${r.par.gold.toFixed(1)}  silver ${r.par.silver.toFixed(1)}  bronze ${r.par.bronze.toFixed(1)}  (${r.par.climbLegs} climb legs)`);
    const margin = ((r.par.gold - r.best) / r.par.gold) * 100;
    /* Both ends, in one call. 45 is the ceiling and it is a real bound, not a
     * decoration: a gold with 45% of headroom is a gold everybody gets, which
     * is the same defect as one nobody gets, wearing the opposite hat.
     * Measured today at 14.9 (dash), 3.5 (ascent) and 25.4 (skyline). */
    floorCheck(
      `${r.venue.id}  gold headroom, %`,
      2, Number(margin.toFixed(1)), 45,
      `(best measured ${r.best.toFixed(1)} s against a gold of ${r.par.gold.toFixed(1)} s)`
    );
    assert.ok(r.best < r.par.gold, `${r.venue.id}: gold at ${r.par.gold.toFixed(1)} s is FASTER than the best measured line of ${r.best.toFixed(1)} s - nobody can reach it`);
  }
});

test('FLOOR: a jogger who never sprints still finishes inside bronze', async () => {
  const { routes } = await measure();
  for (const r of routes) {
    const jog = r.runs.jog.t;
    const margin = ((r.par.bronze - jog) / r.par.bronze) * 100;
    /* And the other end, in the same call. Bronze must not be so loose that
     * finishing at all is a formality: a bronze factor of 2.6 instead of 1.6
     * passes every floor in this file and puts the jogger 53% inside bronze,
     * which is what the 45 catches. Measured today at 24.0 (dash), 16.5
     * (ascent) and 21.1 (skyline). */
    floorCheck(
      `${r.venue.id}  bronze headroom for a jogger, %`,
      2, Number(margin.toFixed(1)), 45,
      `(jog ${jog.toFixed(1)} s against a bronze of ${r.par.bronze.toFixed(1)} s)`
    );
    // The separate half: a jog must not take GOLD - which is what happened
    // when the climb charge was scaled by the medal factor.
    assert.ok(jog > r.par.gold, `${r.venue.id}: a jog at ${jog.toFixed(1)} s takes GOLD - the spread is meaningless`);
  }
});

test('the medal spread is monotone and the timeout sits outside it', async () => {
  const { routes } = await measure();
  for (const r of routes) {
    assert.ok(r.par.gold < r.par.silver && r.par.silver < r.par.bronze && r.par.bronze < r.par.timeout, `${r.venue.id}: medals out of order`);
    assert.ok(r.par.gold > 5, `${r.venue.id}: a gold of ${r.par.gold.toFixed(1)} s is not a contest`);
  }
  assert.ok(MEDAL_FACTOR.gold < MEDAL_FACTOR.silver && MEDAL_FACTOR.silver < MEDAL_FACTOR.bronze);
});

/* ================================================================== */
/* The venue disc holds the whole route                                */
/* ================================================================== */

/**
 * FLOOR. Every published trial disc contains its own route.
 *
 * `MinigameManager.fixedUpdate` abandons a contest `LEAVE_GRACE_S` = 9 s after
 * the player leaves the venue disc, measured against the venue's own `centre`,
 * `radius` and `yTolerance`. CitadelWorld used to publish each trial's disc as
 * `centre = checkpoints[0], radius 12, yTolerance 5` - a START LINE - so every
 * one of these routes left its own venue within a few seconds and self-aborted
 * before it could be finished. It now publishes `venueBounds(checkpoints)`
 * (`CitadelWorld.js:2845`), and this asserts the property that fixed rather
 * than the state that was broken.
 *
 * `SportsWorld` records the identical requirement twice, once over the ski
 * slope's 60 m radius and once over the track's.
 *
 * The START is a separate gate and does NOT widen with the disc:
 * `createRooftopTrial` refuses to build unless the player is within
 * `START_RADIUS` of checkpoint 0, the same split the ski run uses.
 *
 * Floor, achieved and ceiling are all the venue count, because a disc that
 * holds nine tenths of its route is a trial that self-aborts nine tenths of the
 * way round: there is no partial credit here and the ceiling is the floor.
 */
test('FLOOR: every published venue disc holds its own route', async () => {
  const { routes } = await measure();
  let covered = 0;
  for (const r of routes) {
    const v = r.venue;
    const want = venueBounds(r.cps);
    let worstR = 0;
    let worstY = 0;
    for (const c of r.cps) {
      worstR = Math.max(worstR, Math.hypot(c.x - v.centre.x, c.z - v.centre.z));
      worstY = Math.max(worstY, Math.abs(c.y - v.centre.y));
    }
    const ok = venueCoversRoute(v, r.cps);
    if (ok) covered++;
    console.log(`    ${v.id.padEnd(20)} published r=${v.radius.toFixed(1)} yTol=${v.yTolerance.toFixed(1)} -> route needs r=${worstR.toFixed(1)} yTol=${worstY.toFixed(1)}   covers=${ok}`);
    console.log(`    ${''.padEnd(20)} venueBounds says centre (${want.centre.x.toFixed(1)}, ${want.centre.y.toFixed(1)}, ${want.centre.z.toFixed(1)}), radius ${want.radius.toFixed(1)}, yTolerance ${want.yTolerance.toFixed(1)}`);
    // The helper must always answer a disc that works, whatever the world says.
    assert.ok(venueCoversRoute(want, r.cps), `${v.id}: venueBounds returned a disc that does not hold its own route`);
    assert.ok(
      ok,
      `${v.id}: the published disc (r ${v.radius.toFixed(1)}, yTol ${v.yTolerance.toFixed(1)}) does not hold its own route `
      + `(needs r > ${worstR.toFixed(1)}, yTol >= ${worstY.toFixed(1)}) - LEAVE_GRACE_S will abandon every run`
    );
  }
  floorCheck('venue discs that hold their whole route', routes.length, covered, routes.length);
});
