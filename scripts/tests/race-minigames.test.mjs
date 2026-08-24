import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

/**
 * VELLUM RIDGE'S TWO CONTESTS ON FOOT — CAN THEY BE PLAYED?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE QUESTION THIS FILE ASKS, AND THE ONE IT REFUSES TO ASK
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It does NOT ask whether the venues were built. Every world test in this repo
 * once asked only that, and the medieval expansion shipped four defects through
 * the gap - things that existed and could not be reached. World 06 then found
 * the same shape NINE more times. The recorded conclusion is blunt: **a gate
 * that measures something the game does not do is worse than no gate.**
 *
 * So every assertion below is about a body:
 *
 *  1. Does the floor under each point exist, at the height the venue published?
 *  2. Can a capsule STAND there - headroom, and neighbours within a step?
 *  3. Can a body WALK from the depot to every drop, and from the paddock to
 *     Cinder Gorge? Measured by flooding a 4 m lattice over the whole estate
 *     with a 0.75 m step-up and a 1.9 m headroom clause.
 *  4. Does the venue disc hold the whole route? `MinigameManager` abandons a
 *     contest 9 s after the player leaves it, so a disc that does not cover the
 *     far end ends every run that reaches it - `citadel_skyline`'s lesson.
 *  5. Can the contest be WON by somebody walking, and LOST by somebody
 *     dawdling? Both driven through the real modules at `CONFIG.player`'s own
 *     speeds, over the real distances.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE FLOOD ALREADY EARNED ITS PLACE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The first three drop points for the paddock round were chosen off a height
 * map: flat, clear, sensible distances apart, and every geometric check green.
 * The flood found TWO OF THEM UNREACHABLE - (70, 132) and (0, 118) sit behind
 * the Vellum road's barrier line. A height probe cannot see a barrier; a walk
 * can. Both were replaced before anything shipped, which is the entire argument
 * for keeping this gate expensive.
 */

/* ------------------------------------------------------------------ */
/* A world, without a browser                                          */
/* ------------------------------------------------------------------ */

const noopCtx = () => {
  const grad = { addColorStop() {} };
  return {
    canvas: null,
    createLinearGradient: () => grad, createRadialGradient: () => grad, createPattern: () => null,
    fillRect() {}, clearRect() {}, strokeRect() {}, fill() {}, stroke() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arc() {}, ellipse() {},
    roundRect() {}, quadraticCurveTo() {}, bezierCurveTo() {},
    save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
    setTransform() {}, transform() {}, drawImage() {}, fillText() {}, strokeText() {},
    measureText: () => ({ width: 10 }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData() {},
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  };
};
globalThis.document ??= {
  createElement(tag) {
    if (tag !== 'canvas') return {};
    return { width: 1, height: 1, getContext: () => noopCtx(), style: {} };
  },
};

const { RaceWorld } = await import('../../src/worlds/RaceWorld.js');
const { Physics, COLLISION_LAYER } = await import('../../src/physics/Physics.js');
const { CONFIG } = await import('../../src/core/Config.js');
const { MinigameManager, MINIGAME_STATE } = await import('../../src/minigames/MinigameManager.js');
const { createDeliveryRun, readRound, legPlan } = await import('../../src/minigames/DeliveryRun.js');
const { createDroneHack, readNodes } = await import('../../src/minigames/DroneHack.js');
const { STAND_HEADROOM } = await import('../../src/minigames/VenueGround.js');

const matCache = new Map();
const materials = {
  has: () => true,
  get: (k) => { if (!matCache.has(k)) matCache.set(k, new THREE.MeshStandardMaterial()); return matCache.get(k); },
  register: (k, m) => matCache.set(k, m),
  tinted: (k) => materials.get(k),
};

let _built = null;
async function built() {
  if (_built) return _built;
  const physics = new Physics();
  const world = new RaceWorld({
    scene: new THREE.Scene(), engine: null, physics,
    bus: { on() {}, off() {}, emit() {} }, materials,
  });
  const say = console.log;
  console.log = () => {};
  try {
    await world.build();
  } finally {
    console.log = say;
  }
  _built = { world, physics };
  return _built;
}

/** The venue with this id, or a failure that names what WAS published. */
async function venue(id) {
  const { world } = await built();
  const list = world.minigameVenues ?? [];
  const v = list.find((x) => x.id === id);
  assert.ok(v, `RaceWorld publishes no venue "${id}"; it publishes ${JSON.stringify(list.map((x) => x.id))}`);
  return v;
}

/** Every point a venue sends the player to, depot/access node first. */
function pointsOf(v) {
  if (v.kind === 'courier') return [v.config.depot, ...v.config.drops];
  return v.config.nodes;
}

/* ------------------------------------------------------------------ */
/* The walk lattice                                                    */
/* ------------------------------------------------------------------ */

const PITCH = 4;
/**
 * Height a step may rise or fall between neighbouring cells.
 *
 * Deliberately conservative - 0.75 m over 4 m is a 10.6% grade, and this world
 * has 11.3% road grades on it - because a flood that is too GENEROUS is the
 * failure mode that matters here. A permissive flood reports a route the player
 * does not have; a strict one at worst rejects a point that would have worked.
 */
const STEP = 0.75;

let _lattice = null;
/**
 * Flood the whole estate from the paddock depot, once.
 *
 * Cached at module level because it is the expensive assertion in this file and
 * every test below wants the same answer. 720 x 820 m at 4 m is 37,286 cells.
 */
async function lattice() {
  if (_lattice) return _lattice;
  const { world, physics } = await built();
  const start = world.minigameVenues.find((v) => v.id === 'vellum_paddock_round')?.config?.depot;
  assert.ok(start, 'no depot to flood from');

  const MINX = -560; const MAXX = 160; const MINZ = -560; const MAXZ = 260;
  const NX = Math.round((MAXX - MINX) / PITCH) + 1;
  const NZ = Math.round((MAXZ - MINZ) / PITCH) + 1;
  const H = new Float32Array(NX * NZ).fill(NaN);
  const up = new THREE.Vector3(0, 1, 0);
  const at = new THREE.Vector3();
  const height = (ix, iz) => {
    const k = iz * NX + ix;
    if (!Number.isNaN(H[k])) return H[k];
    const g = physics.groundHeight(MINX + ix * PITCH, MINZ + iz * PITCH, 220, 420);
    H[k] = g === null ? Infinity : g;
    return H[k];
  };
  const seen = new Uint8Array(NX * NZ);
  const sx = Math.round((start.x - MINX) / PITCH);
  const sz = Math.round((start.z - MINZ) / PITCH);
  const stack = [sz * NX + sx];
  seen[stack[0]] = 2;
  while (stack.length) {
    const k = stack.pop();
    const ix = k % NX;
    const iz = (k - ix) / NX;
    const y = height(ix, iz);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const jx = ix + dx;
      const jz = iz + dz;
      if (jx < 0 || jz < 0 || jx >= NX || jz >= NZ) continue;
      const kk = jz * NX + jx;
      if (seen[kk]) continue;
      const yy = height(jx, jz);
      if (!Number.isFinite(yy) || Math.abs(yy - y) > STEP) { seen[kk] = 1; continue; }
      at.set(MINX + jx * PITCH, yy + 0.08, MINZ + jz * PITCH);
      const hit = physics.raycast(at, up, STAND_HEADROOM + 0.5, COLLISION_LAYER.WORLD);
      if (hit && hit.distance < STAND_HEADROOM) { seen[kk] = 1; continue; }
      seen[kk] = 2;
      stack.push(kk);
    }
  }
  _lattice = {
    reached(x, z) {
      const ix = Math.round((x - MINX) / PITCH);
      const iz = Math.round((z - MINZ) / PITCH);
      if (ix < 0 || iz < 0 || ix >= NX || iz >= NZ) return false;
      return seen[iz * NX + ix] === 2;
    },
    cells: seen.reduce((n, s) => n + (s === 2 ? 1 : 0), 0),
  };
  return _lattice;
}

/* ================================================================== */
/* 1. The world publishes two venues, and the manager arms both        */
/* ================================================================== */

test('Vellum Ridge publishes two venues where it published none', async () => {
  const { world } = await built();
  const list = world.minigameVenues ?? [];
  assert.equal(list.length, 2, `expected two venues, got ${JSON.stringify(list.map((v) => v.id))}`);
  assert.deepEqual(list.map((v) => v.kind).sort(), ['courier', 'hack']);
});

test('the real MinigameManager arms both, which is what a `_readVenue` typo would stop', async () => {
  const { world } = await built();
  /* Every field `_readVenue` validates, validated by `_readVenue` itself. A
   * venue missing a centre, a radius or a registered kind is dropped SILENTLY -
   * "a published slot, not an error" - so nothing else in the suite would
   * notice a world publishing two prompts that never appear. */
  const mgr = new MinigameManager({ bus: null, player: null, economy: null, input: null, worldManager: null });
  mgr.registerGame('courier', createDeliveryRun);
  mgr.registerGame('hack', createDroneHack);
  assert.equal(mgr.arm(world), true);
  assert.equal(mgr.venues.length, 2,
    `the manager armed ${mgr.venues.length} of the world's ${world.minigameVenues.length} venues`);
  mgr.dispose();
});

test('main.js registers both kinds, or every venue here is an inert slot', async () => {
  const { readFileSync } = await import('node:fs');
  const main = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(main, /registerGame\('courier'/);
  assert.match(main, /registerGame\('hack'/);
  assert.match(main, /import \{ createDeliveryRun \} from '\.\/minigames\/DeliveryRun\.js'/,
    'quest-vocab follows the registration to the module by its imported name');
  assert.match(main, /import \{ createDroneHack \} from '\.\/minigames\/DroneHack\.js'/);
});

/* ================================================================== */
/* 2. Every point stands on ground a body can stand on                 */
/* ================================================================== */

test('every published point sits on real floor at the height it claims, with room to stand', async () => {
  const { physics } = await built();
  const up = new THREE.Vector3(0, 1, 0);
  let checked = 0;
  for (const id of ['vellum_paddock_round', 'gorge_relay_splice']) {
    const v = await venue(id);
    for (const p of pointsOf(v)) {
      const g = physics.groundHeight(p.x, p.z, 220, 420);
      assert.ok(g !== null, `${id}/${p.id} at (${p.x}, ${p.z}) has NO floor under it`);
      assert.ok(Math.abs(g - p.y) < 0.2,
        `${id}/${p.id} publishes y ${p.y.toFixed(2)} and the floor is at ${g.toFixed(2)}`);
      const hit = physics.raycast(
        new THREE.Vector3(p.x, g + 0.08, p.z), up, STAND_HEADROOM + 0.5, COLLISION_LAYER.WORLD);
      assert.ok(!hit || hit.distance >= STAND_HEADROOM,
        `${id}/${p.id} has ${hit?.distance.toFixed(2)} m of headroom; a capsule needs ${STAND_HEADROOM}`);
      checked++;
    }
  }
  assert.equal(checked, 10, `${checked} points checked; four in the round and six in the splice`);
});

test('a body can WALK from the paddock depot to every point of both venues', async () => {
  /* THE ASSERTION THAT CHANGED THE CONTENT. Two of the first three drops were
   * geometrically perfect and behind a barrier. */
  const lat = await lattice();
  assert.ok(lat.cells > 20000, `the flood only reached ${lat.cells} cells; something sealed the estate`);
  for (const id of ['vellum_paddock_round', 'gorge_relay_splice']) {
    const v = await venue(id);
    for (const p of pointsOf(v)) {
      assert.ok(lat.reached(p.x, p.z),
        `${id}/${p.id} at (${p.x.toFixed(0)}, ${p.z.toFixed(0)}) cannot be walked to from the paddock depot`);
    }
  }
});

test('the flood can fail — the two drops it rejected are still rejected', async () => {
  /* A reachability gate that passes everything is not a gate. These are the two
   * points the first draft of `_publishVenues` used, kept as the negative
   * control: if this test ever goes green-by-default, the flood has stopped
   * measuring anything. */
  const lat = await lattice();
  assert.equal(lat.reached(70, 132), false,
    '(70, 132) is now reachable — the flood has been loosened and no longer proves anything');
  assert.equal(lat.reached(0, 118), false, '(0, 118) is now reachable');
});

/* ================================================================== */
/* 3. The disc holds the route                                         */
/* ================================================================== */

test('each venue disc holds every point of its own route, with room for the arrival radius', async () => {
  const mgr = new MinigameManager({ bus: null, player: { position: new THREE.Vector3() }, economy: null, input: null, worldManager: null });
  for (const id of ['vellum_paddock_round', 'gorge_relay_splice']) {
    const v = await venue(id);
    for (const p of pointsOf(v)) {
      /* Asked through `_inVenue` itself rather than re-derived: the disc test
       * that matters is the one `fixedUpdate` runs before it calls `abort`. */
      mgr.player.position.set(p.x, p.y + 0.9, p.z);
      assert.equal(mgr._inVenue(v, 0), true,
        `${id}: the disc does not contain ${p.id}; every run reaching it is abandoned 9 s later`);
    }
  }
  mgr.dispose();
});

test('the two venues cannot shadow each other — each start point resolves its OWN venue', async () => {
  /* `_pollNear` picks, among the venues CONTAINING the player, the one whose
   * centre is nearest. Two overlapping discs therefore make one of them
   * unstartable, and nothing anywhere says so. This is that, asserted. */
  const { world } = await built();
  const mgr = new MinigameManager({ bus: null, player: { position: new THREE.Vector3() }, economy: null, input: null, worldManager: null });
  mgr.registerGame('courier', createDeliveryRun);
  mgr.registerGame('hack', createDroneHack);
  mgr.arm(world);
  for (const id of ['vellum_paddock_round', 'gorge_relay_splice']) {
    const v = await venue(id);
    const start = pointsOf(v)[0];
    mgr.player.position.set(start.x, start.y + 0.9, start.z);
    mgr._pollNear();
    assert.ok(mgr.nearest, `nothing at all is offered at ${id}'s start point`);
    assert.equal(mgr.nearest.id, id,
      `standing at ${id}'s start point offers "${mgr.nearest.id}" instead — ${id} cannot be started anywhere`);
  }
  mgr.dispose();
});

test('no start point stands inside a portal\'s reach, which would take the E key away', async () => {
  /* `MinigameManager._keyTaken` stands the venue prompt down while a portal is
   * near, correctly - E belongs to the door. A start point inside that range is
   * a venue that cannot be started. NEAR_RANGE is
   * `activationRange + radius + 1.4`. */
  const { world } = await built();
  const NEAR = CONFIG.portal.activationRange + CONFIG.portal.radius + 1.4;
  const portals = world.portalSpecs ?? [];
  assert.ok(portals.length >= 1, 'the race world publishes no portals at all');
  for (const id of ['vellum_paddock_round', 'gorge_relay_splice']) {
    const v = await venue(id);
    const start = pointsOf(v)[0];
    for (const p of portals) {
      const d = Math.hypot(p.position.x - start.x, p.position.z - start.z);
      assert.ok(d > NEAR,
        `${id} starts ${d.toFixed(1)} m from the ${p.target} gateway, inside its ${NEAR.toFixed(1)} m prompt`);
    }
  }
});

/* ================================================================== */
/* 4. Can it be won? Can it be lost?                                   */
/* ================================================================== */

/**
 * Walk a body between points at a fixed speed, stepping the contest.
 *
 * Straight lines, because the flood has already proved a route exists and this
 * measures the CLOCK, not the pathfinding. Straight-line distance is the best
 * case, which is the right side to err on for the "can it be lost" half and the
 * one that must be corrected for in the "can it be won" half - hence the
 * generous margin demanded below rather than a bare pass.
 */
function walk(game, player, targets, speed, opts = {}) {
  const DT = 1 / 60;
  const hold = opts.hold ?? 0;
  let clock = 0;
  let out = null;
  for (const t of targets) {
    // Travel.
    for (let guard = 0; guard < 60 * 600; guard++) {
      const dx = t.x - player.position.x;
      const dz = t.z - player.position.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.05) break;
      const s = Math.min(d, speed * DT);
      player.position.x += (dx / d) * s;
      player.position.z += (dz / d) * s;
      player.position.y = t.y;
      clock += DT;
      out = game.fixedUpdate(DT, clock);
      if (out) return { out, clock };
    }
    // Stand.
    for (let i = 0; i < Math.round(hold / DT); i++) {
      clock += DT;
      out = game.fixedUpdate(DT, clock);
      if (out) return { out, clock };
    }
  }
  // Nothing ended: keep stepping in place so a deadline can still fire.
  for (let i = 0; i < 60 * 600 && !out; i++) {
    clock += DT;
    out = game.fixedUpdate(DT, clock);
  }
  return { out, clock };
}

test('the paddock round is winnable at walking pace and lost at half of it', async () => {
  const v = await venue('vellum_paddock_round');
  const round = readRound(v);
  const legs = legPlan(round);
  const bus = { emit() {}, on: () => () => {} };

  const player = { position: new THREE.Vector3(round.depot.x, round.depot.y, round.depot.z) };
  const game = createDeliveryRun(v, { bus, player });
  assert.ok(game, 'the round refused to start at its own depot');
  game.begin(0);
  const fast = walk(game, player, legs.map((l) => l.to), CONFIG.player.walkSpeed);
  assert.ok(fast.out, 'the round never ended');
  assert.equal(fast.out.won, true,
    `a body at walkSpeed ${CONFIG.player.walkSpeed} lost the round: ${fast.out.detail}`);
  assert.equal(fast.out.score, round.drops.length);
  /* Not a bare pass: a straight line is the best case and a player walks
   * corners, so the schedule has to hold with room. Stated as the fraction of
   * the total budget the ideal walk consumed. */
  const budget = legs.reduce((n, l) => n + l.limit, 0);
  assert.ok(fast.clock < budget * 0.8,
    `the ideal walk used ${fast.clock.toFixed(0)} s of a ${budget.toFixed(0)} s schedule — no room for a corner`);
  game.dispose();

  const slowPlayer = { position: new THREE.Vector3(round.depot.x, round.depot.y, round.depot.z) };
  const slow = createDeliveryRun(v, { bus, player: slowPlayer });
  slow.begin(0);
  const lost = walk(slow, slowPlayer, legs.map((l) => l.to), CONFIG.player.walkSpeed / 2);
  assert.ok(lost.out, 'the slow round never ended');
  assert.equal(lost.out.won, false, 'a body at half walking pace still made the schedule');
  slow.dispose();
});

test('the gorge splice is winnable at walking pace, and standing still loses it', async () => {
  const v = await venue('gorge_relay_splice');
  const chain = readNodes(v);
  const bus = { emit() {}, on: () => () => {} };
  const first = chain.nodes[0];

  const player = { position: new THREE.Vector3(first.x, first.y, first.z) };
  const game = createDroneHack(v, { bus, player });
  assert.ok(game, 'the splice refused to start at its own access relay');
  game.begin(0);
  const won = walk(game, player, chain.nodes, CONFIG.player.walkSpeed, { hold: chain.holdS + 0.2 });
  assert.ok(won.out, 'the splice never ended');
  assert.equal(won.out.won, true, `a body at walkSpeed was traced: ${won.out.detail}`);
  assert.equal(won.out.score, chain.nodes.length);
  game.dispose();

  // ..and the trace is real opposition: half pace cannot make it.
  const slowPlayer = { position: new THREE.Vector3(first.x, first.y, first.z) };
  const slow = createDroneHack(v, { bus, player: slowPlayer });
  slow.begin(0);
  const lost = walk(slow, slowPlayer, chain.nodes, CONFIG.player.walkSpeed / 2, { hold: chain.holdS + 0.2 });
  assert.ok(lost.out && lost.out.won === false, 'a body at half pace beat the trace');
  slow.dispose();

  // ..and a body that never leaves the first relay is traced with one node down.
  const still = { position: new THREE.Vector3(first.x, first.y, first.z) };
  const idle = createDroneHack(v, { bus, player: still });
  idle.begin(0);
  const traced = walk(idle, still, [], 1);
  assert.ok(traced.out && traced.out.won === false);
  assert.equal(traced.out.score, 1, 'standing on the access relay cracked more than the access relay');
  idle.dispose();
});

test('each contest fits the 1-5 minute band brief 5.3 asks for', async () => {
  const roundV = await venue('vellum_paddock_round');
  const round = readRound(roundV);
  const legs = legPlan(round);
  const budget = legs.reduce((n, l) => n + l.limit, 0);
  assert.ok(budget >= 60 && budget <= 300, `${budget.toFixed(0)} s of schedule is outside 1-5 minutes`);

  const chain = readNodes(await venue('gorge_relay_splice'));
  const ceiling = chain.limit + chain.bonus * chain.nodes.length;
  assert.ok(ceiling >= 60 && ceiling <= 300, `${ceiling.toFixed(0)} s of trace is outside 1-5 minutes`);
});

/* ================================================================== */
/* 5. The economy, and the quest vocabulary                            */
/* ================================================================== */

test('both venues pay inside the measured 8-18 CR band, and a loss pays under a win', async () => {
  const { consolationFor } = await import('../../src/minigames/MinigameManager.js');
  for (const id of ['vellum_paddock_round', 'gorge_relay_splice']) {
    const v = await venue(id);
    assert.ok(v.reward >= 8 && v.reward <= 18,
      `${id} pays ${v.reward} CR; §8 measured the whole minigame band at 8-18 and §5 says this is a sink problem`);
    const floor = consolationFor(v);
    assert.ok(floor > 0 && floor < v.reward, `${id}: floor ${floor} against prize ${v.reward}`);
  }
});

test('the quest vocabulary offers both venues and both outcomes in this world', async () => {
  const vocab = await import('../../scripts/quest-vocab.mjs');
  const offered = vocab.candidateValues('minigame', 'race');
  for (const want of ['vellum_paddock_round', 'gorge_relay_splice', 'delivery_run_won', 'delivery_run_lost', 'drone_hack_won', 'drone_hack_lost']) {
    assert.ok(offered.includes(want),
      `the vocabulary does not offer "${want}" in the race world: ${JSON.stringify(offered)}`);
  }
});
