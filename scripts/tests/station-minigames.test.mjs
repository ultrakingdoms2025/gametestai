import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

/**
 * THE STATION'S FIRST TWO CONTESTS — CAN THEY BE PLAYED?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT WAS MISSING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Twelve minigame venues shipped across six kinds, and the hub - the world
 * every player starts in and cannot avoid - carried ZERO. Sports has four, the
 * citadel seven, the yard one. A player's first hour was spent in the one world
 * with nothing to enter.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE THREE FAILURES THIS FILE IS WRITTEN AGAINST
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  1. **A point on a crate.** The hub deck carries 2,226 solid set-dressing
 *     props. A downward ray plus a headroom clause happily accepts the top of
 *     one, and two of the six first-draft relay masts settled onto props at
 *     5.45 m and 0.72 m over a 0.08 m deck. Test 2 re-asks the question the
 *     world's own `settlePoints` asks, against the built world.
 *
 *  2. **Two venues that shadow each other.** `MinigameManager._pollNear` picks,
 *     among the venues whose disc CONTAINS the player, the one whose CENTRE is
 *     nearest. The first draft put both venues in concentric rings around the
 *     origin, and measured against `_pollNear` the round won everywhere -
 *     INCLUDING at the splice's own access mast, so the splice could never have
 *     been started and nothing anywhere would have said so. The fix is a floor,
 *     not a tie-break: the round runs on the deck at y = 0.1 and the splice on
 *     the promenade at y = 10.005, and `_inVenue` tests a height band. Test 4
 *     is that separation, asserted from both ends.
 *
 *  3. **A promenade nobody can get to.** A ring of masts 10 m above the deck is
 *     the definitive "built but not reachable" venue if the stair flights do
 *     not land on it, or if the ring is not continuous all the way round.
 *     Test 3 walks the ring and checks the flights against
 *     `walkwayStairFlight()` - the same arithmetic
 *     `station-walkway-loop.test.mjs` pins, which is why that file's defect
 *     (flights that stopped at the deck CENTRELINE and ran underneath it)
 *     cannot come back without taking this venue with it.
 */

/* ------------------------------------------------------------------ */
/* A station, without a browser                                        */
/* ------------------------------------------------------------------ */

function harness() {
  if (globalThis.__stationMinigameHarness) return;
  globalThis.__stationMinigameHarness = true;
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
const { StationWorld } = await import('../../src/worlds/StationWorld.js');
const { LOOP_R, WALKWAY, WALKWAY_DECK_TOP, walkwayStairFlight } =
  await import('../../src/worlds/station/StationKit.js');
const { CONFIG } = await import('../../src/core/Config.js');
const { MinigameManager, consolationFor } = await import('../../src/minigames/MinigameManager.js');
const { createDeliveryRun, readRound, legPlan, DEPOT_R, DEPOT_BAND } =
  await import('../../src/minigames/DeliveryRun.js');
const { createDroneHack, readNodes, ACCESS_R, ACCESS_BAND } =
  await import('../../src/minigames/DroneHack.js');
const { STAND_HEADROOM } = await import('../../src/minigames/VenueGround.js');
const { HUD } = await import('../../src/ui/HUD.js');
const { EventBus } = await import('../../src/core/EventBus.js');

let _built = null;
async function built() {
  if (_built) return _built;
  const physics = new Physics();
  const renderer = {
    capabilities: { getMaxAnisotropy: () => 4, isWebGL2: true },
    initTexture() {}, getContext: () => ({}),
    getRenderTarget: () => null, setRenderTarget() {}, render() {}, clear() {},
  };
  const world = new StationWorld({
    physics,
    scene: new THREE.Scene(),
    bus: { on: () => () => {}, emit() {} },
    engine: { renderer, onFrameUpdate: () => () => {}, onResize: () => () => {} },
    materials: { get: () => new THREE.MeshStandardMaterial(), dispose() {} },
  });
  world.physics = physics;
  const say = console.log;
  console.log = () => {};
  try {
    await world.build(() => {});
  } finally {
    console.log = say;
  }
  _built = { world, physics };
  return _built;
}

async function venue(id) {
  const { world } = await built();
  const list = world.minigameVenues ?? [];
  const v = list.find((x) => x.id === id);
  assert.ok(v, `StationWorld publishes no venue "${id}"; it publishes ${JSON.stringify(list.map((x) => x.id))}`);
  return v;
}

function pointsOf(v) {
  if (v.kind === 'courier') return [v.config.depot, ...v.config.drops];
  return v.config.nodes;
}

const up = new THREE.Vector3(0, 1, 0);
const at = new THREE.Vector3();

/* ================================================================== */
/* 1. Published, armed, registered                                     */
/* ================================================================== */

test('the hub publishes two venues where it published none', async () => {
  const { world } = await built();
  const list = world.minigameVenues ?? [];
  assert.equal(list.length, 2, `expected two venues, got ${JSON.stringify(list.map((v) => v.id))}`);
  assert.deepEqual(list.map((v) => v.id).sort(), ['station_concourse_round', 'station_relay_splice']);
});

test('the real MinigameManager arms both, which a `_readVenue` typo would silently stop', async () => {
  const { world } = await built();
  const mgr = new MinigameManager({ bus: null, player: null, economy: null, input: null, worldManager: null });
  mgr.registerGame('courier', createDeliveryRun);
  mgr.registerGame('hack', createDroneHack);
  assert.equal(mgr.arm(world), true);
  assert.equal(mgr.venues.length, 2,
    `the manager armed ${mgr.venues.length} of ${world.minigameVenues.length} published venues`);
  mgr.dispose();
});

/* ================================================================== */
/* 2. Ground, headroom, and NOT a crate                                */
/* ================================================================== */

test('every published point stands on real floor at the height it claims', async () => {
  const { physics } = await built();
  let checked = 0;
  for (const id of ['station_concourse_round', 'station_relay_splice']) {
    const v = await venue(id);
    /* Two probe envelopes, because the two venues are on two levels and a
     * probe wide enough for both would let a promenade point settle onto the
     * concourse ten metres below it. */
    const [from, depth] = id === 'station_relay_splice' ? [18, 9] : [26, 40];
    for (const p of pointsOf(v)) {
      const g = physics.groundHeight(p.x, p.z, from, depth);
      assert.ok(g !== null, `${id}/${p.id} at (${p.x.toFixed(1)}, ${p.z.toFixed(1)}) has NO floor under it`);
      assert.ok(Math.abs(g - p.y) < 0.2,
        `${id}/${p.id} publishes y ${p.y.toFixed(2)} and the floor is at ${g.toFixed(2)}`);
      at.set(p.x, g + 0.08, p.z);
      const hit = physics.raycast(at, up, STAND_HEADROOM + 0.5, COLLISION_LAYER.WORLD);
      assert.ok(!hit || hit.distance >= STAND_HEADROOM,
        `${id}/${p.id} has ${hit?.distance.toFixed(2)} m of headroom; a capsule needs ${STAND_HEADROOM}`);
      checked++;
    }
  }
  assert.equal(checked, 10, `${checked} points; four in the round and six masts`);
});

test('no point is standing on a packing crate — its neighbours are within a step', async () => {
  /* THE DEFECT: floor plus headroom accepts a prop top, and this deck carries
   * 2,226 solid ones. Two of the six first-draft masts landed on them. This is
   * the world's own walk-on rule, re-asked against the built world. */
  const { physics } = await built();
  for (const id of ['station_concourse_round', 'station_relay_splice']) {
    const v = await venue(id);
    const [from, depth] = id === 'station_relay_splice' ? [18, 9] : [26, 40];
    for (const p of pointsOf(v)) {
      let agree = 0;
      const heights = [];
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const h = physics.groundHeight(p.x + Math.cos(a) * 1.2, p.z + Math.sin(a) * 1.2, from, depth);
        heights.push(h === null ? 'none' : h.toFixed(2));
        if (h !== null && Math.abs(h - (p.y - 0.05)) <= 0.75) agree++;
      }
      assert.ok(agree >= 5,
        `${id}/${p.id} at y ${p.y.toFixed(2)} has only ${agree}/8 walkable neighbours (${heights.join(' ')}) — it is a pedestal`);
    }
  }
});

test('a body can walk the hub deck from the freight kiosk to every rim kiosk', async () => {
  const { physics } = await built();
  const v = await venue('station_concourse_round');
  /* A 1.5 m lattice with a 0.45 m step-up - `CONFIG.player`'s own step height,
   * the same figure `planet-walk-kit` floods with - over the hub floor only.
   * The band is what keeps the flood ON the deck: a cell whose floor is more
   * than 3 m up is the promenade, a plinth or a roof, and none of those is the
   * route between two kiosks. */
  const PITCH = 1.5;
  const STEP = 0.45;
  const SPAN = 60;
  const N = Math.round((SPAN * 2) / PITCH) + 1;
  const H = new Float32Array(N * N).fill(NaN);
  const height = (ix, iz) => {
    const k = iz * N + ix;
    if (!Number.isNaN(H[k])) return H[k];
    const g = physics.groundHeight(-SPAN + ix * PITCH, -SPAN + iz * PITCH, 26, 40);
    H[k] = g === null || g > 3 ? Infinity : g;
    return H[k];
  };
  const seen = new Uint8Array(N * N);
  const idx = (x, z) => [Math.round((x + SPAN) / PITCH), Math.round((z + SPAN) / PITCH)];
  const [sx, sz] = idx(v.config.depot.x, v.config.depot.z);
  const stack = [sz * N + sx];
  seen[stack[0]] = 2;
  while (stack.length) {
    const k = stack.pop();
    const ix = k % N;
    const iz = (k - ix) / N;
    const y = height(ix, iz);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const jx = ix + dx;
      const jz = iz + dz;
      if (jx < 0 || jz < 0 || jx >= N || jz >= N) continue;
      const kk = jz * N + jx;
      if (seen[kk]) continue;
      const yy = height(jx, jz);
      if (!Number.isFinite(yy) || Math.abs(yy - y) > STEP) { seen[kk] = 1; continue; }
      at.set(-SPAN + jx * PITCH, yy + 0.08, -SPAN + jz * PITCH);
      const hit = physics.raycast(at, up, STAND_HEADROOM + 0.5, COLLISION_LAYER.WORLD);
      if (hit && hit.distance < STAND_HEADROOM) { seen[kk] = 1; continue; }
      seen[kk] = 2;
      stack.push(kk);
    }
  }
  const reached = seen.reduce((n, s) => n + (s === 2 ? 1 : 0), 0);
  assert.ok(reached > 1500, `the hub flood only reached ${reached} cells; the deck is not one space`);
  for (const d of v.config.drops) {
    const [ix, iz] = idx(d.x, d.z);
    assert.equal(seen[iz * N + ix], 2,
      `${d.label} at (${d.x.toFixed(0)}, ${d.z.toFixed(0)}) cannot be walked to from the freight kiosk`);
  }

  /* THE NEGATIVE CONTROL. A reachability gate that passes everything is not a
   * gate, and this one has already rejected four points that every geometric
   * check called perfect: flat, clear, 1.9 m of headroom, eight walkable
   * neighbours — and the flood out of the freight kiosk does not get to them.
   * Kept here so that loosening the flood fails a test rather than quietly
   * re-admitting the whole class of defect.
   *
   * ── RE-TAKEN 2026-08-30, AND THE REASON MATTERS ──────────────────────────
   *
   * The previous control was bearing 255 at r = 46, and it became REACHABLE
   * without this flood being touched. The cause was found by A/B rather than
   * assumed: `_solidifyProps` had been giving the ambient crowd static
   * colliders — 202 of them — and one of those figures was standing in the gap
   * of the queue-barrier line at z = -41 that sealed that pocket. Restore the
   * crowd colliders and the point is unreachable again; remove them and it is
   * not.
   *
   * So the control had been resting on a PERSON, and one who walks: the crowd
   * animates away from the position those boxes were cut at. Re-taking a
   * negative control is normally the move it exists to prevent, and it is done
   * here on the only ground that permits it — the wall it depended on was a
   * defect, proved by experiment, and removing it is the fix. If this one ever
   * goes reachable, do the same A/B before touching this line.
   *
   * (-40.5, -18) is the same KIND of point, chosen from the 596 cells the
   * flood still refuses that pass every local check: outside the gateway ring,
   * eight walkable neighbours, no headroom obstruction. */
  const dead = idx(-40.5, -18);
  assert.notEqual(seen[dead[1] * N + dead[0]], 2,
    '(-40.5, -18) is now reachable — the hub flood has been loosened and proves nothing. '
    + 'Before re-taking this point, A/B the change: the last time it moved, the cause was a collider '
    + 'that should never have existed.');
});

/* ================================================================== */
/* 3. The promenade is a real place with a real way up                 */
/* ================================================================== */

test('the promenade ring is continuous all the way round, at every mast\'s height', async () => {
  /* A splice that goes round the walkway needs the walkway to BE a ring. One
   * missing plate is one leg of the chain that cannot be walked, and the
   * contest would simply time out there forever. Sampled every 5 degrees. */
  const { physics } = await built();
  const v = await venue('station_relay_splice');
  let worst = null;
  for (let deg = 0; deg < 360; deg += 5) {
    const a = (deg * Math.PI) / 180;
    const g = physics.groundHeight(Math.cos(a) * LOOP_R, Math.sin(a) * LOOP_R, 18, 9);
    if (g === null) { worst = `bearing ${deg}: no walkway`; break; }
    if (Math.abs(g - WALKWAY_DECK_TOP) > 0.6) { worst = `bearing ${deg}: ${g.toFixed(2)} m, not ${WALKWAY_DECK_TOP}`; break; }
  }
  assert.equal(worst, null, `the promenade is not continuous — ${worst}`);
  for (const n of v.config.nodes) {
    assert.ok(Math.abs(Math.hypot(n.x, n.z) - LOOP_R) < 0.01,
      `${n.id} is at r ${Math.hypot(n.x, n.z).toFixed(2)} and the walkway is at ${LOOP_R}`);
  }
});

test('a stair flight lands ON the promenade, so the splice has a way up', async () => {
  /* The other half of reachability, and the one a flood at deck level cannot
   * see. `station-walkway-loop.test.mjs` records the defect this pins: the
   * flights climbed to the deck's CENTRELINE and the last 3 m of every one ran
   * underneath the walkway, leaving 0.16 m of headroom - nobody could reach the
   * promenade at all. Asserted here too, because that defect returning would
   * take this whole venue with it and nothing else would connect the two. */
  const { rInner, rise } = walkwayStairFlight();
  assert.equal(rise, WALKWAY_DECK_TOP, 'the flight no longer climbs to the walkway deck');
  assert.equal(rInner, LOOP_R + WALKWAY.WIDTH / 2,
    'the flight stops at the deck centreline again — it runs under the walkway it climbs to');
  const v = await venue('station_relay_splice');
  assert.ok(Math.abs(v.config.nodes[0].y - (WALKWAY_DECK_TOP + 0.05)) < 0.2,
    `the access mast sits at ${v.config.nodes[0].y.toFixed(2)} and the flight arrives at ${WALKWAY_DECK_TOP}`);
});

/* ================================================================== */
/* 4. The two venues do not shadow each other                          */
/* ================================================================== */

test('the deck venue and the promenade venue can never both contain a body', async () => {
  const round = await venue('station_concourse_round');
  const splice = await venue('station_relay_splice');
  const mgr = new MinigameManager({ bus: null, player: { position: new THREE.Vector3() }, economy: null, input: null, worldManager: null });

  // On the deck: the round, and only the round.
  mgr.player.position.set(round.config.depot.x, round.config.depot.y + 0.9, round.config.depot.z);
  assert.equal(mgr._inVenue(round, 0), true, 'the round does not contain its own depot');
  assert.equal(mgr._inVenue(splice, 0), false,
    'the promenade splice reaches down to the hub floor — it would shadow the round');

  // On the promenade: the splice, and only the splice.
  const mast = splice.config.nodes[0];
  mgr.player.position.set(mast.x, mast.y + 0.9, mast.z);
  assert.equal(mgr._inVenue(splice, 0), true, 'the splice does not contain its own access mast');
  assert.equal(mgr._inVenue(round, 0), false,
    'the deck round reaches up to the promenade — it would shadow the splice, and the splice could never be started');
  mgr.dispose();
});

test('each start point resolves its OWN venue through the real _pollNear', async () => {
  const { world } = await built();
  const mgr = new MinigameManager({ bus: null, player: { position: new THREE.Vector3() }, economy: null, input: null, worldManager: null });
  mgr.registerGame('courier', createDeliveryRun);
  mgr.registerGame('hack', createDroneHack);
  mgr.arm(world);
  for (const id of ['station_concourse_round', 'station_relay_splice']) {
    const v = await venue(id);
    const start = pointsOf(v)[0];
    mgr.player.position.set(start.x, start.y + 0.9, start.z);
    mgr._pollNear();
    assert.ok(mgr.nearest, `nothing is offered at ${id}'s start point`);
    assert.equal(mgr.nearest.id, id,
      `standing at ${id}'s start point offers "${mgr.nearest.id}" — ${id} cannot be started anywhere`);
  }
  mgr.dispose();
});

test('each venue disc holds every point of its own route', async () => {
  const mgr = new MinigameManager({ bus: null, player: { position: new THREE.Vector3() }, economy: null, input: null, worldManager: null });
  for (const id of ['station_concourse_round', 'station_relay_splice']) {
    const v = await venue(id);
    for (const p of pointsOf(v)) {
      mgr.player.position.set(p.x, p.y + 0.9, p.z);
      assert.equal(mgr._inVenue(v, 0), true,
        `${id}: the disc does not hold ${p.id}; a run reaching it is abandoned 9 s later`);
    }
  }
  mgr.dispose();
});

test('no start point stands inside a gateway\'s reach, which would take the E key away', async () => {
  const { world } = await built();
  const NEAR = CONFIG.portal.activationRange + CONFIG.portal.radius + 1.4;
  const portals = world.portalSpecs ?? [];
  assert.ok(portals.length >= 6, `the hub publishes ${portals.length} gateways`);
  for (const id of ['station_concourse_round', 'station_relay_splice']) {
    const v = await venue(id);
    const start = pointsOf(v)[0];
    for (const p of portals) {
      const d = Math.hypot(p.position.x - start.x, p.position.z - start.z);
      const dy = Math.abs((p.position.y ?? 0) - start.y);
      assert.ok(d > NEAR || dy > 6,
        `${id} starts ${d.toFixed(1)} m from the ${p.target} gateway, inside its ${NEAR.toFixed(1)} m prompt`);
    }
  }
});

/* ================================================================== */
/* 5. Can it be won? Can it be lost?                                   */
/* ================================================================== */

const DT = 1 / 60;

/** Walk a body along a polyline at a fixed speed, stepping the contest. */
function drive(game, player, route, speed, holdAt = new Set(), holdS = 0) {
  let clock = 0;
  let out = null;
  for (const t of route) {
    for (let guard = 0; guard < 60 * 900; guard++) {
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
    if (holdAt.has(t)) {
      for (let i = 0; i < Math.round(holdS / DT); i++) {
        clock += DT;
        out = game.fixedUpdate(DT, clock);
        if (out) return { out, clock };
      }
    }
  }
  for (let i = 0; i < 60 * 900 && !out; i++) {
    clock += DT;
    out = game.fixedUpdate(DT, clock);
  }
  return { out, clock };
}

test('the concourse round is winnable at walking pace and lost at half of it', async () => {
  const v = await venue('station_concourse_round');
  const round = readRound(v);
  const legs = legPlan(round);
  const bus = { emit() {}, on: () => () => {} };
  const route = legs.map((l) => l.to);

  const player = { position: new THREE.Vector3(round.depot.x, round.depot.y, round.depot.z) };
  const game = createDeliveryRun(v, { bus, player });
  assert.ok(game, 'the round refused to start at its own depot');
  game.begin(0);
  const won = drive(game, player, route, CONFIG.player.walkSpeed);
  assert.ok(won.out, 'the round never ended');
  assert.equal(won.out.won, true, `a body at walkSpeed lost the round: ${won.out.detail}`);
  const budget = legs.reduce((n, l) => n + l.limit, 0);
  assert.ok(won.clock < budget * 0.8,
    `the ideal walk used ${won.clock.toFixed(0)} s of a ${budget.toFixed(0)} s schedule — no room for a crate`);
  game.dispose();

  const slowP = { position: new THREE.Vector3(round.depot.x, round.depot.y, round.depot.z) };
  const slow = createDeliveryRun(v, { bus, player: slowP });
  slow.begin(0);
  const lost = drive(slow, slowP, route, CONFIG.player.walkSpeed / 2);
  assert.ok(lost.out && lost.out.won === false, 'a body at half walking pace still made the schedule');
  slow.dispose();
});

test('the relay splice is winnable walking the ring, and lost by dawdling', async () => {
  /* Driven along the WALKWAY, not across the middle of the dome. That is the
   * distance the player really covers - 75.4 m of arc between masts 60 degrees
   * apart on a 72 m ring, against a 72 m chord - and sizing a trace clock
   * against the chord would ship a contest that cannot be finished. */
  const v = await venue('station_relay_splice');
  const chain = readNodes(v);
  const bus = { emit() {}, on: () => () => {} };
  const holds = new Set();
  const route = [];
  for (let i = 0; i < chain.nodes.length; i++) {
    const from = chain.nodes[(i - 1 + chain.nodes.length) % chain.nodes.length];
    const to = chain.nodes[i];
    if (i > 0) {
      const a0 = Math.atan2(from.z, from.x);
      let a1 = Math.atan2(to.z, to.x);
      while (a1 - a0 > Math.PI) a1 -= Math.PI * 2;
      while (a1 - a0 < -Math.PI) a1 += Math.PI * 2;
      for (let s = 1; s < 12; s++) {
        const a = a0 + ((a1 - a0) * s) / 12;
        route.push({ x: Math.cos(a) * LOOP_R, y: to.y, z: Math.sin(a) * LOOP_R });
      }
    }
    route.push(to);
    holds.add(to);
  }

  const first = chain.nodes[0];
  const player = { position: new THREE.Vector3(first.x, first.y, first.z) };
  const game = createDroneHack(v, { bus, player });
  assert.ok(game, 'the splice refused to start at its own access mast');
  game.begin(0);
  const won = drive(game, player, route, CONFIG.player.walkSpeed, holds, chain.holdS + 0.2);
  assert.ok(won.out, 'the splice never ended');
  assert.equal(won.out.won, true, `a body walking the ring was traced: ${won.out.detail}`);
  assert.equal(won.out.score, chain.nodes.length);
  game.dispose();

  const slowP = { position: new THREE.Vector3(first.x, first.y, first.z) };
  const slow = createDroneHack(v, { bus, player: slowP });
  slow.begin(0);
  const lost = drive(slow, slowP, route, CONFIG.player.walkSpeed / 2, holds, chain.holdS + 0.2);
  assert.ok(lost.out && lost.out.won === false, 'a body at half pace beat the trace round the ring');
  slow.dispose();
});

test('each contest fits the 1-5 minute band brief 5.3 asks for', async () => {
  const legs = legPlan(readRound(await venue('station_concourse_round')));
  const budget = legs.reduce((n, l) => n + l.limit, 0);
  assert.ok(budget >= 60 && budget <= 300, `${budget.toFixed(0)} s of schedule is outside 1-5 minutes`);

  const chain = readNodes(await venue('station_relay_splice'));
  const ceiling = chain.limit + chain.bonus * chain.nodes.length;
  assert.ok(ceiling >= 60 && ceiling <= 300, `${ceiling.toFixed(0)} s of trace is outside 1-5 minutes`);
});

/* ================================================================== */
/* 6. Economy and vocabulary                                           */
/* ================================================================== */

test('both venues pay inside the measured 8-18 CR band, and a loss pays under a win', async () => {
  for (const id of ['station_concourse_round', 'station_relay_splice']) {
    const v = await venue(id);
    assert.ok(v.reward >= 8 && v.reward <= 18,
      `${id} pays ${v.reward} CR; §8 measured the band at 8-18 and §5 calls this a sink problem`);
    const floor = consolationFor(v);
    assert.ok(floor > 0 && floor < v.reward, `${id}: floor ${floor} against prize ${v.reward}`);
  }
});

test('the quest vocabulary offers both venues and both outcomes in the station', async () => {
  const vocab = await import('../../scripts/quest-vocab.mjs');
  const offered = vocab.candidateValues('minigame', 'station');
  for (const want of ['station_concourse_round', 'station_relay_splice',
    'delivery_run_won', 'delivery_run_lost', 'drone_hack_won', 'drone_hack_lost']) {
    assert.ok(offered.includes(want),
      `the vocabulary does not offer "${want}" in the station: ${JSON.stringify(offered)}`);
  }
});


/* ================================================================== */
/* 7. The venue that took the E key off the whole concourse            */
/* ================================================================== */

/**
 * ── THE DEFECT, REPORTED FROM REAL PLAY ──────────────────────────────────
 *
 * "when on concourse I can not talk to people as it is always saying press E to
 * start concourse run".
 *
 * `MinigameManager._pollNear` offered a venue wherever the player was CONTAINED
 * by its disc, and that disc is not an offer - it is the abandonment test, and
 * it has to hold the WHOLE route or `LEAVE_GRACE_S` aborts every run nine
 * seconds after it reaches the far end (`citadel_skyline`'s recorded lesson,
 * repeated in `SportsWorld` over the ski slope and the 400 m). Measured on the
 * built station: the Concourse Round's disc is r 64.8 about (5.95, 0.10, -3.66)
 * and SEVEN of the world's friendly NPCs stand inside it. `HUD._updateInput`
 * stands its E-to-chat branch down while a venue prompt is up - deliberately,
 * so one E cannot both open a chat and start a match at the lido - so all seven
 * were unreachable. And the venue could not be started from any of those places
 * either: `createDeliveryRun` refuses beyond `DEPOT_R` = 6 m of the kiosk. The
 * words, the key and the game all disagreed at once.
 *
 * The fix separates the two jobs. Containment is unchanged. The venue now also
 * publishes an OFFER gate - `start` / `startRadius` / `startBand` - and
 * `StationWorld` reads those numbers from `DeliveryRun` and `DroneHack`
 * themselves, so the prompt appears exactly where a start is possible.
 *
 * These tests are written so that reverting either half goes red: the first
 * three fail on the fix's absence, and the containment test fails if the disc
 * is shrunk to "fix" the prompt instead.
 */

/** The concourse friendlies that stand inside the round's containment disc. */
async function shadowedFriendlies() {
  const { world } = await built();
  const v = await venue('station_concourse_round');
  const mgr = new MinigameManager({
    bus: null, player: { position: new THREE.Vector3() }, economy: null, input: null, worldManager: null,
  });
  const out = [];
  for (const s of world.npcSpawns ?? []) {
    if (s.type !== 'friendly') continue;
    mgr.player.position.set(s.position.x, s.position.y + 0.9, s.position.z);
    if (!mgr._inVenue(v, 0)) continue;
    out.push(s);
  }
  mgr.dispose();
  return out;
}

/** An armed manager on the built station, with both games registered. */
async function armed(bus = new EventBus()) {
  const { world } = await built();
  const mgr = new MinigameManager({
    bus, player: { position: new THREE.Vector3() }, economy: null, input: null, worldManager: null,
  });
  mgr.registerGame('courier', createDeliveryRun);
  mgr.registerGame('hack', createDroneHack);
  mgr.arm(world);
  return mgr;
}

test('the round shadows most of the concourse — the disc really is that wide', async () => {
  /* The premise every test below rests on, asserted rather than assumed. If
   * somebody "fixes" the report by shrinking the disc, this goes red and points
   * at the abandonment test further down. */
  const shadowed = await shadowedFriendlies();
  assert.ok(shadowed.length >= 5,
    `only ${shadowed.length} friendlies stand inside the round's disc; this file's premise `
    + 'has moved and the tests below no longer measure the reported defect');
  const v = await venue('station_concourse_round');
  for (const s of shadowed) {
    const d = Math.hypot(s.position.x - v.start.x, s.position.z - v.start.z);
    assert.ok(d > DEPOT_R,
      `${s.name} stands ${d.toFixed(1)} m from the kiosk, inside the start gate — pick another control`);
  }
});

test('standing beside a concourse NPC, the venue does NOT claim the E key', async () => {
  const mgr = await armed();
  for (const s of await shadowedFriendlies()) {
    mgr.player.position.set(s.position.x, s.position.y + 0.9, s.position.z);
    mgr._pollNear();
    mgr._pollPrompt();
    assert.equal(mgr.nearest, null,
      `standing at ${s.name} the venue offers "${mgr.nearest?.id}" — that NPC cannot be talked to`);
    assert.equal(mgr._promptText, null,
      `standing at ${s.name} the HUD is told "${mgr._promptText}", which takes E off the NPC`);
  }
  mgr.dispose();
});

test('the real HUD opens a chat on E beside a shadowed concourse NPC', async () => {
  /* Driven through the REAL `HUD.prototype._updateInput`, over a REAL
   * `EventBus`, with `_minigamePrompt` set only by the manager's own
   * `minigame:prompt` event. A test that re-implemented the guard would keep
   * passing after the guard changed; this one IS the guard. */
  const bus = new EventBus();
  const mgr = await armed(bus);

  const hud = Object.create(HUD.prototype);
  Object.assign(hud, {
    _relock: 0, _relockCheck: 0, _chatOpen: false, _saveExpectT: 0,
    _nearPortal: null, _minigamePrompt: null, _chatNpc: null,
    bus,
    _tickLock() {},
    _openChat(npc) { this._opened = npc ?? null; },
    input: { pressed: (code) => code === 'KeyE' },
  });
  bus.on('minigame:prompt', (p) => { hud._minigamePrompt = p?.text ?? null; });

  const away = (await shadowedFriendlies())[0];
  hud._chatNpc = { id: 'npc-1', name: away.name, role: 'civilian' };
  mgr.player.position.set(away.position.x, away.position.y + 0.9, away.position.z);
  mgr._pollNear();
  mgr._pollPrompt();
  hud._opened = undefined;
  hud._updateInput(1 / 60);
  assert.equal(hud._opened?.name, away.name,
    `E beside ${away.name} opened no chat; the HUD holds a venue prompt of "${hud._minigamePrompt}"`);

  // ...and at the kiosk the documented rule still holds: the venue wins on E.
  const v = await venue('station_concourse_round');
  mgr.player.position.set(v.start.x, v.start.y + 0.9, v.start.z);
  mgr._pollNear();
  mgr._pollPrompt();
  hud._opened = undefined;
  hud._updateInput(1 / 60);
  assert.equal(hud._opened, undefined,
    'standing at the freight kiosk, E opened a chat instead of starting the round — '
    + 'the lido rule (arrive at a venue, be offered the contest) has been inverted');
  mgr.dispose();
});

test('standing AT the kiosk and AT the access mast, each venue DOES claim E', async () => {
  const mgr = await armed();
  for (const id of ['station_concourse_round', 'station_relay_splice']) {
    const v = await venue(id);
    mgr.player.position.set(v.start.x, v.start.y + 0.9, v.start.z);
    mgr._pollNear();
    mgr._pollPrompt();
    assert.equal(mgr.nearest?.id, id, `${id} is not offered at its own start point`);
    assert.ok(mgr._promptText && mgr._promptText.startsWith('Start'),
      `${id} publishes "${mgr._promptText}" at its own start point`);
  }
  mgr.dispose();
});

test('a quest manager still outranks a venue, gate or no gate', async () => {
  /* The rule `MinigameManager` already carried, which the offer gate must not
   * quietly retire: at a start point a quest manager or lorekeeper takes the
   * key back, because the HUD puts exactly those two above the venue. */
  const bus = new EventBus();
  const mgr = await armed(bus);
  const v = await venue('station_concourse_round');
  mgr.player.position.set(v.start.x, v.start.y + 0.9, v.start.z);

  for (const npc of [{ name: 'Dispatcher', isQuestManager: true }, { name: 'Wen', isLorekeeper: true }]) {
    bus.emit('chat:available', { npc });
    mgr._pollNear();
    mgr._pollPrompt();
    assert.equal(mgr._keyTaken, true, `${npc.name} no longer takes the key at the kiosk`);
    assert.equal(mgr._promptText, null,
      `${npc.name} is standing at the kiosk and the HUD is still told "${mgr._promptText}"`);
  }
  // An ordinary NPC at the kiosk does NOT: the venue wins, exactly as at the lido.
  bus.emit('chat:available', { npc: { name: 'Bex' } });
  mgr._pollNear();
  mgr._pollPrompt();
  assert.equal(mgr._keyTaken, false, 'an ordinary NPC now outranks a venue at its own start point');
  assert.equal(mgr.nearest?.id, 'station_concourse_round');
  mgr.dispose();
});

test('containment is UNCHANGED: the far end of the route is still inside the venue', async () => {
  /* The half of the fix that must not move. `_inVenue` and `_atStart` answer
   * DIFFERENTLY at a rim kiosk, and that difference is the whole point: the
   * offer is off out there and the abandonment clock is not. Shrink the disc to
   * fix the prompt and this goes red. */
  const mgr = new MinigameManager({
    bus: null, player: { position: new THREE.Vector3() }, economy: null, input: null, worldManager: null,
  });
  for (const id of ['station_concourse_round', 'station_relay_splice']) {
    const v = await venue(id);
    const pts = pointsOf(v);
    let differed = 0;
    for (const p of pts) {
      mgr.player.position.set(p.x, p.y + 0.9, p.z);
      assert.equal(mgr._inVenue(v, 0), true,
        `${id}/${p.id}: outside the disc, so a run reaching it is abandoned 9 s later`);
      if (!mgr._atStart(v, 0)) differed++;
    }
    assert.equal(differed, pts.length - 1,
      `${id}: the offer gate says yes at ${pts.length - differed} of its ${pts.length} route points; `
      + 'exactly one — the start — should be offered, or the gate is the disc wearing a new name');
  }
  mgr.dispose();
});

test('the offer gate IS the game module\'s own start gate — the two cannot drift', async () => {
  const round = await venue('station_concourse_round');
  assert.equal(round.startRadius, DEPOT_R,
    `the round offers within ${round.startRadius} m and DeliveryRun starts within ${DEPOT_R} m; `
    + 'E would be pressed where the factory then refuses it');
  assert.equal(round.startBand, DEPOT_BAND);
  assert.deepEqual(
    { x: round.start.x, z: round.start.z },
    { x: round.config.depot.x, z: round.config.depot.z },
    'the round offers itself somewhere other than its own depot'
  );

  const splice = await venue('station_relay_splice');
  assert.equal(splice.startRadius, ACCESS_R,
    `the splice offers within ${splice.startRadius} m and DroneHack starts within ${ACCESS_R} m`);
  assert.equal(splice.startBand, ACCESS_BAND);
  assert.deepEqual(
    { x: splice.start.x, z: splice.start.z },
    { x: splice.config.nodes[0].x, z: splice.config.nodes[0].z },
    'the splice offers itself somewhere other than its own access mast'
  );
});

test('a start the venue offers is a start the module accepts, all the way round the gate', async () => {
  /* The two gates agreeing on paper is not the same as agreeing on the ground.
   * Sampled every 10 degrees at the release radius: wherever the venue is still
   * offering, `createDeliveryRun` must build. This is the assertion that would
   * have caught hysteresis applied OUTWARD - a 2.5 m ring of "Start the
   * Concourse Round" that only ever earned a warning toast. */
  const bus = new EventBus();
  const mgr = await armed(bus);
  const v = await venue('station_concourse_round');
  let checked = 0;
  for (let deg = 0; deg < 360; deg += 10) {
    const a = (deg * Math.PI) / 180;
    for (const d of [DEPOT_R - 0.05, DEPOT_R - 1.5, 1]) {
      mgr.player.position.set(v.start.x + Math.cos(a) * d, v.start.y + 0.9, v.start.z + Math.sin(a) * d);
      mgr._pollNear();
      mgr._pollNear();      // second poll: hysteresis held, the widest the offer ever gets
      if (!mgr.nearest) continue;
      const game = createDeliveryRun(v, { player: mgr.player, bus });
      assert.ok(game,
        `the round is offered ${d.toFixed(2)} m out on bearing ${deg} and DeliveryRun refuses to build there`);
      game.dispose?.();
      checked++;
    }
  }
  assert.ok(checked > 30, `only ${checked} offered positions were sampled; the ring is not being walked`);
  mgr.dispose();
});

test('the prompt is sharp on the way in and forgiving on the way out, and NEVER beyond the module gate', async () => {
  /* `PROMPT_HYSTERESIS` exists so a body on a boundary does not flicker the
   * meaning of E every frame. Applied outward it would push the OFFER past the
   * gate `createDeliveryRun` enforces. So the band lives INSIDE the published
   * radius: armed close, released at the gate. Walked in and back out, one
   * centimetre at a time. */
  const mgr = await armed();
  const v = await venue('station_concourse_round');
  const set = (d) => mgr.player.position.set(v.start.x + d, v.start.y + 0.9, v.start.z);

  let armedAt = null;
  for (let d = 12; d >= 0; d -= 0.01) {
    set(d);
    mgr._pollNear();
    if (mgr.nearest) { armedAt = d; break; }
  }
  assert.ok(armedAt !== null, 'walking onto the kiosk never offered the round at all');
  assert.ok(armedAt <= DEPOT_R,
    `the round armed ${armedAt.toFixed(2)} m out and DeliveryRun refuses beyond ${DEPOT_R} m`);

  let releasedAt = null;
  for (let d = 0; d <= 12; d += 0.01) {
    set(d);
    mgr._pollNear();
    if (!mgr.nearest) { releasedAt = d; break; }
  }
  assert.ok(releasedAt !== null, 'the round never stopped offering, twelve metres from the kiosk');
  assert.ok(releasedAt <= DEPOT_R + 0.02,
    `the prompt survived to ${releasedAt.toFixed(2)} m, past the ${DEPOT_R} m the module will start at`);
  assert.ok(releasedAt > armedAt + 1,
    `armed at ${armedAt.toFixed(2)} m and released at ${releasedAt.toFixed(2)} m: `
    + 'there is no hysteresis band, so the prompt will flicker on the boundary');
  mgr.dispose();
});
