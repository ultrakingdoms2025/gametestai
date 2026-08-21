import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

/**
 * EVERY AUTHORED ROUTE, WALKED AGAINST THE WORLD IT IS AUTHORED IN.
 *
 * ── The defect this exists for ────────────────────────────────────────────
 * `Serjeant Hale` is a wall-walk sentry in Aldermoor Vale, and two of the four
 * legs of his round ran through thin air. His route was drawn round a castle
 * 44 m across; the castle that got built is 80 m across (`CASTLE.hx` is 40), so
 * the two north-south legs at x = -52 and x = -96 crossed sixty metres of open
 * bailey 10.6 m up. `Watchman Pell` beside him was worse: all three of his
 * waypoints were inside the bailey and all three were authored at wall-top
 * height, so every one of them resolved eleven metres below where it was
 * written. `_buildFolk` carried the same wrong enceinte and stood three static
 * sentries in mid-air on it.
 *
 * None of that was caught by anything, and until this file nothing could catch
 * it, because nothing validated an authored route against the world it is
 * authored in. That mattered less when `FriendlyNPC._pickWanderTarget` picked
 * one waypoint at random and steered at it - a route was a hint. It is a
 * contract now: `Navigation._advancePath` walks the legs in order, so a leg
 * that cannot be walked is a character stuck against a parapet for the life of
 * the process, silently, forever.
 *
 * ── What is checked ──────────────────────────────────────────────────────
 * Three properties, each measured with the engine's OWN machinery rather than
 * with a model of it, because a model that disagrees with the runtime is worse
 * than no test at all:
 *
 *   1. Every waypoint stands where it was authored. `Grounding.resolveSurfaceY`
 *      is what `NPCManager._snapToGround` calls, so this is exactly the
 *      surface the character will be put on; if it is more than `LEVEL_TOL`
 *      from the height the author wrote, the author meant a level that is not
 *      there.
 *
 *   2. No waypoint is inside a collider. `Physics.resolveCapsule` is the real
 *      solver; a push greater than the capsule radius is the solver reporting
 *      that the point is INSIDE something rather than merely close to it, so
 *      `INSIDE_TOL` is a radius plus a centimetre or so of slop.
 *
 *   3. Every leg has ground under it the whole way. Sampled at `SAMPLE` metres
 *      with `physics.groundHeight(x, z, prev + GROUND_PROBE_UP,
 *      GROUND_PROBE_UP + GROUND_PROBE_DROP)` - which is `NPC._sampleGround`,
 *      copied constant for constant. A stretch where that returns null is a
 *      stretch where the character's own ground follower loses the floor.
 *
 * A closed round is checked round its closing leg as well, because
 * `NPC.routeAhead` walks one; an open one is checked in BOTH directions,
 * because `routeAhead` reverses at the end of one and the reverse of a walk
 * over a ledge is a walk into a wall.
 *
 * ── What is deliberately NOT checked ─────────────────────────────────────
 * Clearance. A route that passes within a capsule radius of a bench is normal
 * and the steering handles it - measured over the five worlds, insisting on
 * clearance flags 41 of 55 station rounds, and every one of those characters
 * walks its round perfectly well. The line between "grazes a lamp post" and
 * "cannot get past" is a connectivity question and this file does not try to
 * answer it; what it answers is "is the floor there", which is the question the
 * two defects above are both answers to.
 *
 * ── Why a headless build, when nothing else here builds a world ──────────
 * `scripts/tests/station-audit.test.mjs` says a world "cannot be imported under
 * Node at all". That is out of date - it can be imported, and it turns out it
 * can be BUILT, given a canvas that draws nothing and a renderer that renders
 * nothing. Neither is used for anything a collider depends on: the textures go
 * into materials, the materials go into meshes, and this file never looks at a
 * mesh. What it looks at is `world.physics`, which is built from arithmetic.
 *
 * The alternative was a per-world reachability model written here, the way
 * `medieval-treasure.test.mjs` writes one for the vale's terrain. That is right
 * for terrain, which is one pure function; it is not right for a castle, a
 * station deck and a skate bowl, where the shape that matters IS the collider
 * set and a second model of it would be a second thing to get wrong.
 *
 * The cost is ~20 s for all seven worlds. The stubs are all in `harness()` and
 * all of them fail loudly rather than silently: a world that stops building is
 * a failed assertion below, not a skipped one.
 */

/* ------------------------------------------------------------------ */
/* Constants, all of them taken from the code that will use them       */
/* ------------------------------------------------------------------ */

/** `NPC.GROUND_PROBE_UP` - the tallest step one simulated step can climb. */
const GROUND_PROBE_UP = 0.95;
/** `NPC.GROUND_PROBE_DROP` - how far below the feet the follower still sees. */
const GROUND_PROBE_DROP = 2.6;
/** `NPC` default capsule. */
const RADIUS = 0.33;
const HEIGHT = 1.75;

/** Sample spacing along a leg. Half a stride. */
const SAMPLE = 0.3;
/**
 * How far a waypoint's authored height may sit from the ground under it.
 *
 * Two metres, and it is a deliberately loose number: `y` on a waypoint is a
 * HINT, not a claim - `StationWorld` writes 0.2 on every hub waypoint whatever
 * the deck under it is doing, and `NPCManager._snapToGround` resolves it. What
 * two metres catches is a hint that names a level which is not there: Pell's
 * three were 11.20 m out, the canteen quartermaster's third waypoint was 3.20 m
 * up on his own shelf stack, the freight broker's was 5.28 m up on a plaza
 * structure, and the skate coach's was 3.24 m above the floor of the bowl she
 * was standing over. The largest survivor at two metres is 1.66 m, which is a
 * planter rim a character genuinely does stand on.
 */
const LEVEL_TOL = 2.0;
/**
 * Capsule push that means the point is inside geometry rather than beside it.
 *
 * `Physics._closestPoint` returns a push of `radius - distance` for a point
 * outside a collider and `radius + depth` for one inside, so anything over the
 * radius is an interior hit. 0.43 is the radius plus 10 cm, which is past the
 * grazes (0.34-0.40 across the five worlds) and inside every real one: the
 * dockhand stood 0.24 m inside a noodle cart, a breaker frame 0.63 m inside a
 * shipping container.
 */
const INSIDE_TOL = 0.43;
/**
 * Metres of continuous nothing-underfoot before a leg counts as broken.
 *
 * Four, and the gap between what passes and what fails is wide: with every
 * route in the game repaired the worst survivor is 0.9 m - one collider seam in
 * the medieval castle yard, which a walking character crosses on momentum - and
 * the things this caught were 61.2 m (Hale, twice), 14.1 m (a hub round over
 * the top of a plaza block), 6.9 m and 6.6 m. Nothing in these worlds sits
 * between 1 m and 6 m, so the threshold is not load-bearing.
 */
const AIR_RUN_M = 4.0;

/* ------------------------------------------------------------------ */
/* A world, built without a browser                                    */
/* ------------------------------------------------------------------ */

/**
 * Install the least DOM and WebGL that a world build touches.
 *
 * Everything here is a no-op that returns the SHAPE the caller needs, never a
 * plausible value: the 2D contexts draw nothing, `ImageData` is real storage
 * full of zeroes, and the renderer's methods return null. If a world ever comes
 * to depend on a pixel it painted, it will read zero rather than something that
 * looks like a texture - and it will be a wrong picture, not a wrong collider,
 * which is the only thing this file measures.
 */
function harness() {
  if (globalThis.__routeHarness) return;
  globalThis.__routeHarness = true;

  class Img {
    constructor(a, b, c) {
      if (typeof a === 'number') {
        this.width = a; this.height = b;
        this.data = new Uint8ClampedArray(a * b * 4);
      } else {
        this.data = a; this.width = b; this.height = c ?? 1;
      }
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
    // Everything else - fillRect, arc, drawImage, the style setters - is a
    // no-op that returns undefined.
    return new Proxy(real, {
      get: (o, k) => (k in o ? o[k] : () => undefined),
      set: () => true,
    });
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

  /* The one piece of THREE that insists on a real GL context. `PMREMGenerator`
   * renders a cube pass to build an environment map; there is no environment
   * here and no shading to apply it to, and its output is only ever assigned to
   * `world.environment.envMap`. */
  const dead = () => ({ texture: null, dispose() {} });
  THREE.PMREMGenerator.prototype.fromEquirectangular = dead;
  THREE.PMREMGenerator.prototype.fromScene = dead;
  THREE.PMREMGenerator.prototype.compileEquirectangularShader = () => {};
}

/** The worlds, and the one thing each of them is expected to produce. */
const WORLDS = [
  { id: 'station', path: '../../src/worlds/StationWorld.js', cls: 'StationWorld', minRoutes: 40 },
  { id: 'medieval', path: '../../src/worlds/MedievalWorld.js', cls: 'MedievalWorld', minRoutes: 20 },
  { id: 'sports', path: '../../src/worlds/SportsWorld.js', cls: 'SportsWorld', minRoutes: 15 },
  { id: 'citadel', path: '../../src/worlds/CitadelWorld.js', cls: 'CitadelWorld', minRoutes: 0 },
  { id: 'race', path: '../../src/worlds/RaceWorld.js', cls: 'RaceWorld', minRoutes: 0 },
  /* Lodestar Yard. Four of its seven authored friendlies carry a patrol - the
   * Yard Warden down the keel line and the three yard hands round their own
   * berths - and the three counters are `anchored` on purpose, so the floor is
   * four rather than seven.
   *
   * `levelTol` is 0.45 here and 2.0 everywhere else, and the difference is a
   * fact about the worlds rather than a preference. Two metres is loose
   * because `y` on a station or medieval waypoint is a HINT over terrain the
   * author did not compute; every surface in the yard is a published datum -
   * deck 0, catwalk 8.0, a cradle top - so a yard waypoint that resolves onto
   * something ELSE is furniture, not slop. 0.45 is `CONFIG.player.stepHeight`:
   * a rise the walk absorbs.
   *
   * The defect this was written for: the Yard Warden's third waypoint was
   * (-9, 0.2, 8), which is 0.25 m inside the +x face and 0.30 m inside the +z
   * face of the Fitting Shop counter. `auditRoute` resolves a waypoint onto
   * whatever it is standing in FIRST and then tests the capsule there, so the
   * counter registered as ground and the 0.855 m level error sat comfortably
   * inside two metres - a lorekeeper finishing her round on a merchant's
   * worktop, past a green route audit. The other five worlds do NOT hold 0.45
   * today (station 1.46, sports 1.60, medieval 0.95, all measured); tightening
   * them is a change to those worlds and not to this file. */
  { id: 'dock', path: '../../src/worlds/DockWorld.js', cls: 'DockWorld', minRoutes: 4, levelTol: 0.45 },
  { id: 'maze', path: '../../src/worlds/MazeWorld.js', cls: 'MazeWorld', minRoutes: 0 },
];

harness();
const { Physics } = await import('../../src/physics/Physics.js');
const { resolveSurfaceY } = await import('../../src/npc/Grounding.js');

/** Build one world with its real physics. */
async function buildWorld(spec) {
  const { [spec.cls]: World } = await import(spec.path);
  const physics = new Physics();
  const renderer = {
    capabilities: { getMaxAnisotropy: () => 4, isWebGL2: true },
    initTexture() {}, getContext: () => ({}),
    getRenderTarget: () => null, setRenderTarget() {}, render() {}, clear() {},
  };
  const world = new World({
    physics,
    scene: new THREE.Scene(),
    bus: { on: () => () => {}, emit() {} },
    engine: { renderer, onFrameUpdate: () => () => {}, onResize: () => () => {} },
    materials: { get: () => new THREE.MeshStandardMaterial(), dispose() {} },
  });
  world.physics = physics;
  await world.build(() => {});
  return { world, physics };
}

/**
 * Everything in a world that carries waypoints.
 *
 * `npcSpawns[].patrol` is the whole of it today - the station's zone casts are
 * appended to the same array, and the vale's streamed residency hands
 * `MedievalResidency` specs of the same shape. `_population.people` is read
 * when it is there so that the streamed cast cannot become a second, unchecked
 * kind of route.
 */
function routesOf(world) {
  const out = [];
  const take = (name, patrol) => {
    if (patrol?.length > 1) out.push({ name: name ?? '(unnamed)', pts: patrol });
  };
  for (const s of world.npcSpawns ?? []) take(s.name ?? s.type, s.patrol);
  for (const s of world._population?.people ?? []) take(s.name, s.patrol);
  return out;
}

/* ------------------------------------------------------------------ */
/* The walk                                                            */
/* ------------------------------------------------------------------ */

const _capsule = new THREE.Vector3();

/** How far `resolveCapsule` shoves a body standing at (x, y, z). */
function capsulePush(physics, x, y, z) {
  _capsule.set(x, y + 0.05, z);
  physics.resolveCapsule(_capsule, RADIUS, HEIGHT);
  return Math.hypot(_capsule.x - x, _capsule.z - z);
}

/**
 * Walk one leg with the ground follower and return the longest run, in metres,
 * over which it found no floor.
 */
function airRun(physics, from, fromY, to) {
  const len = Math.hypot(to.x - from.x, to.z - from.z);
  const steps = Math.max(2, Math.ceil(len / SAMPLE));
  let prev = fromY;
  let run = 0;
  let worst = 0;
  let worstAt = null;
  for (let s = 1; s < steps; s++) {
    const t = s / steps;
    const x = from.x + (to.x - from.x) * t;
    const z = from.z + (to.z - from.z) * t;
    const y = physics.groundHeight(x, z, prev + GROUND_PROBE_UP, GROUND_PROBE_UP + GROUND_PROBE_DROP);
    if (y === null) {
      run++;
      if (run > worst) { worst = run; worstAt = [x, z, prev]; }
      continue;
    }
    run = 0;
    prev = y;
  }
  return { metres: worst * SAMPLE, at: worstAt };
}

/** `NPC._measureRouteClosed`, reproduced so a closing leg is checked iff it exists. */
function isClosed(pts) {
  const n = pts.length;
  if (n < 3) return false;
  let longest = 0;
  for (let i = 1; i < n; i++) longest = Math.max(longest, pts[i - 1].distanceToSquared(pts[i]));
  return pts[n - 1].distanceToSquared(pts[0]) <= longest;
}

/** Audit one route. Returns a finding list; empty means the route is walkable. */
function auditRoute(physics, pts, levelTol = LEVEL_TOL) {
  const level = [];
  const inside = [];
  const air = [];
  const ground = [];

  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const y = resolveSurfaceY(physics, p.x, p.z, p.y);
    ground.push(y);
    const where = `waypoint ${i} at (${p.x.toFixed(1)}, ${p.z.toFixed(1)})`;
    if (y === null) { level.push(`${where} has no surface under it at all`); continue; }
    if (Math.abs(y - p.y) > levelTol) {
      level.push(`${where} is authored at y = ${p.y.toFixed(2)} and the ground there is ${y.toFixed(2)} - ${Math.abs(p.y - y).toFixed(2)} m out`);
    }
    const push = capsulePush(physics, p.x, y, p.z);
    if (push > INSIDE_TOL) {
      inside.push(`${where} is ${(push - RADIUS).toFixed(2)} m inside a collider`);
    }
  }

  const n = pts.length;
  const closed = isClosed(pts);
  const legs = [];
  for (let i = 1; i < n; i++) legs.push([i - 1, i]);
  if (closed) legs.push([n - 1, 0]);
  for (const [a, b] of legs) {
    if (ground[a] === null || ground[b] === null) continue;
    // A closed round is only ever walked forwards; an open one is walked back.
    const ways = closed
      ? [[pts[a], ground[a], pts[b]]]
      : [[pts[a], ground[a], pts[b]], [pts[b], ground[b], pts[a]]];
    for (const [from, fromY, to] of ways) {
      const r = airRun(physics, from, fromY, to);
      if (r.metres >= AIR_RUN_M) {
        air.push(
          `leg ${a}->${b}, (${pts[a].x.toFixed(1)}, ${pts[a].z.toFixed(1)}) to (${pts[b].x.toFixed(1)}, ${pts[b].z.toFixed(1)}): ` +
          `${r.metres.toFixed(1)} m of it has no ground under it, from (${r.at[0].toFixed(1)}, ${r.at[1].toFixed(1)}) ` +
          `with the last footing at ${r.at[2].toFixed(2)} m`
        );
        break;
      }
    }
  }
  return { level, inside, air, closed };
}

/* ------------------------------------------------------------------ */
/* Run it once, for every world                                        */
/* ------------------------------------------------------------------ */

/**
 * Built one at a time and dropped, so the peak is one world's collider set
 * rather than seven. The station's is 26,000 colliders and 8,192 triangle
 * chunks; all seven at once is not something to hold in a test process.
 */
const AUDIT = [];
for (const spec of WORLDS) {
  const { world, physics } = await buildWorld(spec);
  const routes = routesOf(world).map((r) => ({ ...r, ...auditRoute(physics, r.pts, spec.levelTol) }));
  AUDIT.push({ ...spec, routes, colliders: world.colliders.length });
  world.dispose?.();
}

/** All findings of one kind, tagged with the world and character they came from. */
const collect = (kind) => AUDIT.flatMap(
  (w) => w.routes.flatMap((r) => r[kind].map((f) => `[${w.id}] ${r.name}: ${f}`))
);

/* ------------------------------------------------------------------ */
/* The gate                                                            */
/* ------------------------------------------------------------------ */

test('every world builds headlessly and is asked about its routes', () => {
  /* The failure this guards is the silent one: a world whose build throws, or
   * whose cast moves somewhere this file does not look, passes every assertion
   * below by having nothing to check. */
  for (const w of AUDIT) {
    assert.ok(w.colliders > 10, `${w.id} built ${w.colliders} colliders - it did not really build`);
    assert.ok(w.routes.length >= w.minRoutes,
      `${w.id} produced ${w.routes.length} routes, expected at least ${w.minRoutes}`);
  }
  // Citadel and the race circuits author spawns with no `patrol` at all. That
  // is a fact about them, and it is asserted rather than assumed so that the
  // day one of them gains a route, it gains this file's attention with it.
  const withRoutes = AUDIT.filter((w) => w.routes.length > 0).map((w) => w.id);
  assert.deepEqual(withRoutes.sort(), ['dock', 'medieval', 'sports', 'station']);
  const total = AUDIT.reduce((n, w) => n + w.routes.length, 0);
  assert.ok(total >= 90, `only ${total} routes found across every world`);
});

test('every waypoint stands on the level it was authored for', () => {
  /* THE DEFECT, HALF ONE. `Watchman Pell`'s three waypoints were all authored
   * at wall-top height inside the castle bailey: 20.80 m written, 9.60 m of
   * grass under each of them. `NPCManager._snapToGround` dutifully put him on
   * the grass and he walked a triangle round the bailey doing a wall-walk
   * sentry's round at ground level for the life of the process. */
  const bad = collect('level');
  assert.deepEqual(bad, [], `\n  ${bad.join('\n  ')}\n`);
});

test('no waypoint is inside a collider', () => {
  const bad = collect('inside');
  assert.deepEqual(bad, [], `\n  ${bad.join('\n  ')}\n`);
});

test('every leg of every route has ground under it the whole way', () => {
  /* THE DEFECT, HALF TWO. `Serjeant Hale`'s round had four legs and two of them
   * were 68 m of open air over the castle bailey - 204 of the 227 samples on
   * each with nothing under them. The route follower contained him safely (he
   * paced the wall and deflected off the parapet rather than falling) which is
   * exactly why it never surfaced: nothing broke, he simply could not finish. */
  const bad = collect('air');
  assert.deepEqual(bad, [], `\n  ${bad.join('\n  ')}\n`);
});

test('a round that measures as closed can actually be closed', () => {
  /* `NPC.routeAhead` walks a closed round forever in one direction, so its
   * closing leg is a leg like any other and is checked as one above. What this
   * adds is the count: if every round in the game quietly became open, the
   * closing-leg checks would all pass by not existing. */
  const closed = AUDIT.flatMap((w) => w.routes.filter((r) => r.closed));
  assert.ok(closed.length >= 60, `only ${closed.length} routes measure as closed rounds`);
  for (const r of closed) {
    assert.ok(r.air.length === 0 && r.level.length === 0,
      `${r.name}'s round cannot be closed: ${[...r.air, ...r.level].join('; ')}`);
  }
});

/* ------------------------------------------------------------------ */
/* The vale's two sentries, named                                      */
/* ------------------------------------------------------------------ */

test('the castle sentries walk a curtain wall that exists', () => {
  /* Named, because the general gates above would go on passing if somebody
   * "fixed" the two of them by deleting their rounds, and because the shape of
   * the repair is worth pinning: the wall walk is four disconnected runs (each
   * corner tower carries a closed parapet ring at WT + 1.2), so a sentry's beat
   * is a run, not a lap. Both of them are on the south curtain, which is the
   * face the castle-approach framing looks at. */
  const vale = AUDIT.find((w) => w.id === 'medieval');
  const hale = vale.routes.find((r) => r.name === 'Serjeant Hale');
  const pell = vale.routes.find((r) => r.name === 'Watchman Pell');
  assert.ok(hale && pell, 'the wall-walk sentries are gone');

  for (const [who, r] of [['Hale', hale], ['Pell', pell]]) {
    assert.equal(r.air.length + r.level.length + r.inside.length, 0,
      `${who} still cannot walk his round`);
    // On the wall, not in the bailey: the deck is at 20.2 and the bailey at 9.6.
    for (const p of r.pts) {
      assert.ok(p.y > 19 && p.y < 22, `${who} has a waypoint at y = ${p.y.toFixed(2)}`);
      assert.ok(Math.abs(p.z - -24.4) < 0.01,
        `${who} has a waypoint at z = ${p.z.toFixed(2)}, off the south curtain's walkable band`);
      assert.ok(p.x > -105.6 && p.x < -38.4,
        `${who} has a waypoint at x = ${p.x.toFixed(1)}, past a corner tower's parapet ring`);
    }
    // Open, so `routeAhead` reverses instead of striking out across the bailey.
    assert.equal(r.closed, false, `${who}'s round wraps; the wrap crosses the castle`);
    const span = Math.max(...r.pts.map((p) => p.x)) - Math.min(...r.pts.map((p) => p.x));
    assert.ok(span > 20, `${who} paces only ${span.toFixed(0)} m`);
  }
  // Their beats do not overlap, so they never meet head-on on a 2.4 m deck.
  const haleMax = Math.max(...hale.pts.map((p) => p.x));
  const pellMin = Math.min(...pell.pts.map((p) => p.x));
  assert.ok(pellMin - haleMax >= 4, 'the two sentries share stretches of wall');
});
