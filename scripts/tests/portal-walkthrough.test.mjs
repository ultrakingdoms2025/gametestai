import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';

import { EventBus } from '../../src/core/EventBus.js';
import { CONFIG } from '../../src/core/Config.js';
import {
  PortalSystem,
  portalAperture,
  portalEntryFrame,
  PORTAL_ENTRY_RADIUS,
  PORTAL_REARM_DEPTH,
} from '../../src/systems/Portals.js';
import { PORTAL_ARRIVAL_OFFSET } from '../../src/worlds/WorldManager.js';
import {
  GATEWAY,
  GATEWAY_DECK_Y,
  GATEWAY_BEARINGS_DEG,
  gatewayCentre,
  gatewayFrameYaw,
  gatewayApproachFlight,
  gatewayApproachRisers,
} from '../../src/worlds/station/StationKit.js';

/**
 * WALKING THROUGH A GATEWAY.
 *
 * Reported as "portals in station should activate if i walk through them, in
 * other worlds this occurs like that already but not in station". Two
 * independent, station-only defects sat on that one path, and until this file
 * existed NOTHING covered the crossing state machine at all: `portalAperture`
 * and `PORTAL_ENTRY_RADIUS` had exactly one consumer, `harness-framings`, and
 * that one asserts framings do NOT cross. The whole trigger could have been
 * broken in either direction without a test noticing, and both halves of what
 * the player hit shipped that way.
 *
 *   A. `fixedUpdate` tested `p.ready` - `worldManager.isBuilt(target)` - before
 *      firing. Every world except the station publishes ONE portal, back to the
 *      resident world you came from, so `ready` was always true there. The
 *      station publishes SIX, to worlds `WorldPrefetch` prepares lazily one at
 *      a time, so five of them read STABILISING and a walk through them did
 *      nothing, silently, while E at the same disc worked and said so.
 *
 *   B. The approach stairs were 6 mm too tall to climb in the centre lane. The
 *      station is the only world that collides its DRAWN geometry, and the
 *      decorative nosing on each tread stood 60 mm proud of it, putting the
 *      first riser off the plaza at 0.46 against `stepHeight` 0.45.
 *
 * So the gates below are in the order a player meets them: can they climb to
 * the disc, and does crossing it change the world. Everything is driven through
 * the REAL `PortalSystem` - its real constructor, its real `fixedUpdate`, its
 * real `enter` and its real transition clock - against a stub `WorldManager`,
 * so "the portal fired" is never asserted on its own: what is asserted is that
 * the world the stub reports as active afterwards is a different world.
 */

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

const STEP = 1 / 60;                       // Engine.js's fixed step
const DURATION = CONFIG.portal.transitionDuration;

/** The six station gateway specs, exactly as `_buildGateway` pushes them. */
function stationSpecs() {
  const targets = ['race', 'sports', 'maze', 'citadel', 'medieval', 'dock'];
  return GATEWAY_BEARINGS_DEG.map((deg, i) => {
    const [cx, cz] = gatewayCentre(deg);
    return {
      position: new THREE.Vector3(cx, GATEWAY_DECK_Y, cz),
      rotationY: gatewayFrameYaw(deg),
      target: targets[i],
      label: targets[i],
      accent: 0x4de3ff,
      bearing: deg,
    };
  });
}

/**
 * A live portal record, standing in the frame `portalEntryFrame` decides.
 *
 * Not a hand-written disc: `_createPortal` places the real one from that same
 * function, so a change to where a gateway's aperture is moves the game and
 * this test together. The other fields are the ones `enter` reads.
 */
function makePortal(worldId, spec, ready) {
  const { discPosition, normal, right } = portalEntryFrame(spec);
  return {
    id: `${worldId}->${spec.target}`,
    worldId,
    target: spec.target,
    targetName: spec.label,
    accent: new THREE.Color(spec.accent),
    position: spec.position.clone(),
    rotationY: spec.rotationY,
    normal,
    right,
    discPosition,
    ready,
    state: ready ? 'online' : 'stabilising',
    _armed: true,
    _side: 0,
    _proximity: 0,
    _pingUntil: 0,
  };
}

/**
 * A `PortalSystem` on a headless engine, with the six station gateways live.
 *
 * `built` is the set of worlds the stub `WorldManager` reports as generated -
 * the lazily-prepared station is modelled by leaving five of its six
 * destinations out of it, which is the state the reported defect lives in.
 */
function makeSystem({ built = ['station'], ready = null, worldId = 'station' } = {}) {
  const scene = new THREE.Scene();
  const bus = new EventBus();
  const engine = {
    elapsed: 0,
    simElapsed: 0,
    renderer: { capabilities: {} },
    camera: new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 2000),
  };
  const builtSet = new Set(built);
  const wm = {
    active: worldId,
    activations: [],
    builds: [],
    isBuilt: (id) => builtSet.has(id),
    isVolatile: () => false,
    build: async (id) => { wm.builds.push(id); builtSet.add(id); },
    activate: async (id) => { wm.activations.push(id); wm.active = id; builtSet.add(id); },
  };
  const input = { enabled: true, setEnabled(v) { input.enabled = v; } };
  const player = { position: new THREE.Vector3() };
  const notifies = [];
  const entering = [];
  bus.on('hud:notify', (p) => notifies.push(p));
  bus.on('portal:entering', (p) => entering.push(p));

  const sys = new PortalSystem({
    scene, engine, physics: null, bus, materials: {},
    input, player, worldManager: wm,
  });
  sys._worldId = worldId;
  const specs = stationSpecs();
  sys._portals = specs.map((s) => makePortal(worldId, s, ready === null ? builtSet.has(s.target) : ready));
  sys._armAt = 0;

  /** Advance the sim by one fixed step with the player at `feet`. */
  const stepTo = (feet) => {
    player.position.set(feet[0], feet[1], feet[2]);
    engine.elapsed += STEP;
    engine.simElapsed += STEP;
    sys.fixedUpdate(STEP, engine.elapsed);
  };

  /** Run the transition clock out, exactly as `update()` does while one is up. */
  const settle = async () => {
    for (let i = 0; i < 400 && sys.isTransitioning; i++) {
      sys._updateTransition(STEP);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    }
  };

  return { sys, engine, bus, wm, input, player, specs, notifies, entering, stepTo, settle };
}

/** Walk the feet from `a` to `b` at ~walk speed, one fixed step at a time. */
function walk(h, a, b) {
  const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const steps = Math.max(1, Math.ceil(d / (CONFIG.player.walkSpeed * STEP)));
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    h.stepTo([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]);
    if (h.sys.isTransitioning) return true;
  }
  return false;
}

/**
 * Feet position `m` metres along a gateway's normal from its plinth, `side`
 * metres off the centre line, standing on the dais deck.
 */
function standAt(spec, depth, lateral = 0) {
  const { normal, right } = portalEntryFrame(spec);
  return [
    spec.position.x + normal.x * depth + right.x * lateral,
    spec.position.y,
    spec.position.z + normal.z * depth + right.z * lateral,
  ];
}

/* ------------------------------------------------------------------ */
/* 0. The harness stands where the game stands                         */
/* ------------------------------------------------------------------ */

test('the harness disc is the disc the game measures', () => {
  // `portalAperture` is the repo's existing, independently pinned mirror of
  // `fixedUpdate`'s arithmetic (harness-framings.test.mjs walks it). If the
  // record this file builds and that function ever disagree about which side of
  // a disc a body is on, every gate below is measuring a disc of its own.
  for (const spec of stationSpecs()) {
    for (const depth of [-3, -1, 0.5, 2.6, 6]) {
      const feet = standAt(spec, depth);
      const ap = portalAperture(spec, feet);
      const p = makePortal('station', spec, true);
      const rel = new THREE.Vector3(feet[0], feet[1] + 0.95, feet[2]).sub(p.discPosition);
      const w = rel.dot(p.normal);
      assert.equal(w >= 0 ? 1 : -1, ap.side, `${spec.target} at depth ${depth}`);
      assert.ok(Math.abs(Math.abs(w) - Math.abs(ap.depth)) < 1e-9);
    }
  }
});

/* ------------------------------------------------------------------ */
/* 1. B - the flight a player has to climb to reach the disc           */
/* ------------------------------------------------------------------ */

/**
 * The approach profile for an arbitrary nosing height, so this file can show
 * its own gate discriminating rather than assert that it does.
 */
function risersForProud(proud) {
  const out = [];
  let from = 0;
  for (let k = GATEWAY.TREADS - 1; k >= 0; k--) {
    const top = GATEWAY.TREAD_RISE * (GATEWAY.TREADS - k) + proud;
    out.push(top - from);
    from = top;
  }
  return out;
}

test('every riser on a gateway approach is inside stepHeight', () => {
  const steps = gatewayApproachRisers();
  assert.equal(steps.length, GATEWAY.TREADS + 1, 'six treads and the dais');
  for (const s of steps) {
    assert.ok(
      s.riser <= CONFIG.player.stepHeight,
      `${s.what}: riser ${s.riser.toFixed(3)} > stepHeight ${CONFIG.player.stepHeight}`
    );
  }
  // The first one specifically, because it is the only one that ever failed:
  // every later tread is climbed FROM a nosing, so the nosing cancels out and a
  // flight that is unwalkable at its foot looks perfect from the second step up.
  assert.ok(steps[0].what.startsWith('plaza'), steps[0].what);
  assert.ok(steps[0].riser <= CONFIG.player.stepHeight, `first riser ${steps[0].riser}`);
});

test('the riser gate measures the NOSING, not the tread box', () => {
  // The defect: `TREAD_RISE` was 0.40 throughout and correct throughout. What
  // stopped the player was the 0.08 trim plate on top of it, which this world
  // collides because `_solidifyStructure` turns drawn geometry into colliders.
  // A gate that measured `TREAD_RISE` alone passes with the bug in place.
  const flight = gatewayApproachFlight();
  for (const t of flight) {
    assert.ok(t.trimTop > t.rise, `tread ${t.i}: the nosing must sit ON the tread`);
    assert.ok(
      t.trimTop - t.rise < 0.02,
      `tread ${t.i}: nosing ${(t.trimTop - t.rise).toFixed(3)} m proud is a step in its own right`
    );
    // It must still be a plate on top, not a plate floating over a gap.
    assert.ok(t.trimY - GATEWAY.TRIM_T / 2 < t.rise, `tread ${t.i}: the nosing floats`);
  }
  // And the shipped geometry: 0.06 proud, which is the flight the user met.
  const shipped = risersForProud(0.06);
  assert.ok(
    shipped[0] > CONFIG.player.stepHeight,
    'the 0.06-proud nosing must fail this gate, or the gate proves nothing'
  );
  assert.ok(
    risersForProud(GATEWAY.TRIM_PROUD)[0] <= CONFIG.player.stepHeight,
    'the shipped nosing must pass it'
  );
  // Every riser after the first was fine even then - that asymmetry is why the
  // measured profile read 0.00 -> 0.46 -> 0.86 -> 1.26 and not six failures.
  for (let i = 1; i < shipped.length; i++) {
    assert.ok(shipped[i] <= CONFIG.player.stepHeight, `historic riser ${i}`);
  }
});

test('the flight still totals the dais height on every bearing', () => {
  // The fix must not be paid for by shortening the climb: the head of the
  // flight has to meet `GATEWAY_DECK_Y`, and StationKit's bearing-clearance
  // maths measures TREAD_Z0 / PITCH / TREADS, so neither may move either.
  const flight = gatewayApproachFlight();
  assert.equal(flight.length, GATEWAY.TREADS);
  assert.ok(Math.abs(flight[0].rise - GATEWAY_DECK_Y) < 1e-9, `flight head ${flight[0].rise}`);
  assert.equal(GATEWAY.TREADS, 6);
  assert.equal(GATEWAY.TREAD_RISE, 0.4);
  assert.equal(GATEWAY.TREAD_PITCH, 1.3);
  assert.equal(GATEWAY.TREAD_Z0, 11);
  const last = gatewayApproachRisers().at(-1);
  assert.ok(Math.abs(last.riser) < 0.02, `dais threshold is a ${last.riser} m step`);
});

/* ------------------------------------------------------------------ */
/* 2. A - the reported defect                                          */
/* ------------------------------------------------------------------ */

test('walking into a STABILISING station gateway transits to it', async () => {
  // The regression this file exists for. `sports` is not built, so the record's
  // `ready` is false - exactly the station's normal state under WorldPrefetch.
  const h = makeSystem({ built: ['station'] });
  const spec = h.specs.find((s) => s.target === 'sports');
  assert.equal(h.sys.portals.find((p) => p.target === 'sports').ready, false);

  const crossed = walk(h, standAt(spec, 2.4), standAt(spec, -1.2));
  assert.ok(crossed, 'walking through the disc did not start a transition');

  await h.settle();
  assert.equal(h.wm.active, 'sports', 'the world did not change');
  assert.deepEqual(h.wm.activations, ['sports']);
  assert.ok(h.wm.builds.includes('sports'), 'the unbuilt destination was never kicked');
  assert.ok(
    h.notifies.some((n) => /still stabilising/i.test(n.text ?? '')),
    'the player crossed into an unbuilt world with no word about it'
  );
  assert.equal(h.input.enabled, true, 'input was left disabled after the transition');
});

test('walking into an ONLINE gateway transits, as it always did in other worlds', async () => {
  const h = makeSystem({ built: ['station', 'sports'] });
  const spec = h.specs.find((s) => s.target === 'sports');
  assert.equal(h.sys.portals.find((p) => p.target === 'sports').ready, true);
  assert.ok(walk(h, standAt(spec, 2.4), standAt(spec, -1.2)));
  await h.settle();
  assert.equal(h.wm.active, 'sports');
  assert.equal(
    h.notifies.some((n) => /still stabilising/i.test(n.text ?? '')), false,
    'a built destination must not claim to be stabilising'
  );
});

test('E still works, at a stabilising gateway and at a live one', async () => {
  for (const built of [['station'], ['station', 'maze']]) {
    const h = makeSystem({ built });
    assert.equal(h.sys.enterById('station->maze'), true, `enterById with built=${built}`);
    await h.settle();
    assert.equal(h.wm.active, 'maze');
  }
  // And the id has to be the one the world publishes, or the affordance is
  // silently gone for the cockpit caller that is the only user of this path.
  const h = makeSystem();
  assert.equal(h.sys.enterById('station->nowhere'), false);
});

test('all six station gateways walk through, not just the resident one', async () => {
  // The intermittency the user did not report but would have hit: the gateway
  // you came home through IS built, so that one worked all along.
  for (const spec of stationSpecs()) {
    const h = makeSystem({ built: ['station'] });
    assert.ok(
      walk(h, standAt(spec, 2.4), standAt(spec, -1.2)),
      `bearing ${spec.bearing} (${spec.target}) did not fire`
    );
    await h.settle();
    assert.equal(h.wm.active, spec.target, `bearing ${spec.bearing}`);
  }
});

/* ------------------------------------------------------------------ */
/* 3. What must NOT fire                                               */
/* ------------------------------------------------------------------ */

test('walking ALONGSIDE a gateway does not activate it', async () => {
  const h = makeSystem({ built: ['station'] });
  const spec = h.specs.find((s) => s.target === 'sports');
  const { right } = portalEntryFrame(spec);
  // A pass across the front face, 1.2 m out, never crossing the plane.
  const a = standAt(spec, 1.2, -8);
  const b = standAt(spec, 1.2, 8);
  assert.equal(walk(h, a, b), false, 'a pass in front of the disc fired it');
  assert.equal(h.wm.active, 'station');
  assert.ok(right.lengthSq() > 0);
});

test('crossing the plane OUTSIDE the aperture does not activate it', async () => {
  const h = makeSystem({ built: ['station'] });
  const spec = h.specs.find((s) => s.target === 'sports');
  // Same walk-through, displaced past the entry radius: through the arch's
  // jamb line, not through the event horizon.
  const lateral = PORTAL_ENTRY_RADIUS + 0.6;
  assert.equal(
    walk(h, standAt(spec, 2.4, lateral), standAt(spec, -1.2, lateral)), false,
    'a crossing outside the aperture fired'
  );
  assert.equal(h.wm.active, 'station');
});

test('a portal that has not been left alone does not fire', async () => {
  // The arming gate itself: a body standing inside the aperture when the
  // portals are built must walk clear before a crossing counts.
  const h = makeSystem({ built: ['station'] });
  const spec = h.specs.find((s) => s.target === 'sports');
  for (const p of h.sys.portals) p._armed = false;
  h.sys._armAt = h.engine.elapsed + 5;             // still inside ARM_DELAY
  assert.equal(walk(h, standAt(spec, 0.9), standAt(spec, -0.9)), false);
  assert.equal(h.wm.active, 'station');
  assert.equal(h.sys.portals.find((p) => p.target === 'sports')._armed, false);
});

test('a transition already running swallows further crossings', async () => {
  const h = makeSystem({ built: ['station'] });
  const spec = h.specs.find((s) => s.target === 'sports');
  assert.ok(walk(h, standAt(spec, 2.4), standAt(spec, -1.2)));
  const before = h.entering.length;
  // Keep walking, back and forth through the same disc, mid-white-out.
  for (let i = 0; i < 30; i++) {
    h.stepTo(standAt(spec, i % 2 ? 2.4 : -1.2));
    assert.equal(h.sys.enterById('station->sports'), false, 're-entered mid-transition');
  }
  assert.equal(h.entering.length, before, 'a second entry fired during the white-out');
  await h.settle();
  assert.deepEqual(h.wm.activations, ['sports']);
});

/* ------------------------------------------------------------------ */
/* 4. Arrival must not bounce the player back                          */
/* ------------------------------------------------------------------ */

test('arriving in a world does not immediately re-trigger the return portal', async () => {
  const h = makeSystem({ built: ['station', 'sports'] });
  const spec = h.specs.find((s) => s.target === 'sports');
  // Arrival state: portals rebuilt (nothing armed), player planted in front of
  // the return gateway on its plinth, and ARM_DELAY still running.
  for (const p of h.sys.portals) { p._armed = false; p._side = 0; }
  h.sys._disarmAll();

  const at = standAt(spec, PORTAL_ARRIVAL_OFFSET);
  // Two seconds of capsule settling and a sidestep, which is what used to throw
  // the player straight back through the door they had just walked out of.
  for (let i = 0; i < 120; i++) {
    const jx = Math.sin(i * 0.7) * 0.06;
    const jy = i < 20 ? -0.05 * (1 - i / 20) : 0;
    h.stepTo([at[0] + jx, at[1] + jy, at[2] + jx * 0.4]);
    assert.equal(h.sys.isTransitioning, false, `bounced back on step ${i}`);
  }
  assert.equal(h.wm.active, 'station');

  // ...and it is not simply dead: a deliberate walk back in still works.
  assert.ok(walk(h, at, standAt(spec, -1.2)), 'the return gateway never armed');
  await h.settle();
  assert.equal(h.wm.active, 'sports');
});

test('the arrival offset must clear the re-arm depth', () => {
  /* The cross-file invariant nothing pinned. `WorldManager.arrivalFor` stands
   * the player `PORTAL_ARRIVAL_OFFSET` in front of the return gateway, and
   * that gateway's aperture already CONTAINS them radially - the chest is
   * 1.726 m below a disc centre whose entry radius is 2.226 - so the depth
   * against the plane is the only thing that arms it.
   *
   * Shorten the offset below `PORTAL_REARM_DEPTH` and the failure is not a
   * bounce-back, which is loud; it is that walk-through silently stops working
   * in every world, forever. DockWorld already records someone reaching for a
   * shorter offset. */
  assert.ok(
    PORTAL_ARRIVAL_OFFSET > PORTAL_REARM_DEPTH,
    `arrival offset ${PORTAL_ARRIVAL_OFFSET} does not clear re-arm depth ${PORTAL_REARM_DEPTH}`
  );
  const spec = stationSpecs()[1];
  const ap = portalAperture(spec, standAt(spec, PORTAL_ARRIVAL_OFFSET));
  assert.ok(
    ap.radius < PORTAL_ENTRY_RADIUS,
    'the arrival point is meant to be radially INSIDE the aperture - if it is ' +
    'not, this invariant is being kept by luck rather than by the offset'
  );
});

test('the re-arm depth is what actually arms an arriving gateway', () => {
  // Behavioural half of the pin above, so the numbers cannot be "correct" while
  // the machine ignores them.
  for (const [offset, want] of [[PORTAL_ARRIVAL_OFFSET, true], [PORTAL_REARM_DEPTH - 0.2, false]]) {
    const h = makeSystem({ built: ['station', 'sports'] });
    const spec = h.specs.find((s) => s.target === 'sports');
    for (const p of h.sys.portals) p._armed = false;
    h.sys._armAt = 0;                       // past ARM_DELAY
    h.stepTo(standAt(spec, offset));
    assert.equal(
      h.sys.portals.find((p) => p.target === 'sports')._armed, want,
      `standing ${offset} m out ${want ? 'must' : 'must not'} arm the gateway`
    );
  }
});

/* ------------------------------------------------------------------ */
/* 5. The guard that pays for dropping `p.ready`                       */
/* ------------------------------------------------------------------ */

test('a teleport across an armed disc is not a transit', async () => {
  /* Removing `p.ready` removed an accidental brake: a body that LANDS across an
   * armed disc now transits even when the destination is unbuilt. Seven call
   * sites move a body discontinuously - Unstuck, SaveGame's load, the race grid,
   * Viewpoints and respawn - and every one goes through `Player.teleport`, which
   * is the single emitter of `player:spawned`. */
  const h = makeSystem({ built: ['station'] });
  const spec = h.specs.find((s) => s.target === 'sports');

  // Stand outside, arm the gateway for real, then be PUT on the far side.
  h.stepTo(standAt(spec, 6));
  assert.equal(h.sys.portals.find((p) => p.target === 'sports')._armed, true);

  h.bus.emit('player:spawned', { position: new THREE.Vector3() });
  h.stepTo(standAt(spec, -0.4));
  assert.equal(h.sys.isTransitioning, false, 'a teleport read as a walk-through');
  assert.equal(h.wm.active, 'station');
  for (const p of h.sys.portals) assert.equal(p._armed, false);
});

test('without the spawn guard the same teleport DOES transit', async () => {
  // Shows the guard above is load-bearing rather than decorative: the identical
  // sequence with the listener detached crosses.
  const h = makeSystem({ built: ['station'] });
  const spec = h.specs.find((s) => s.target === 'sports');
  for (const off of h.sys._offBus) off();      // detach `player:spawned`
  h.stepTo(standAt(spec, 6));
  h.bus.emit('player:spawned', { position: new THREE.Vector3() });
  h.stepTo(standAt(spec, -0.4));
  assert.equal(h.sys.isTransitioning, true, 'the guard is not what stops this');
});

test('dispose drops the spawn subscription', () => {
  const h = makeSystem();
  // The stub records carry no GPU materials, and `clear()` disposes real ones;
  // the subscription is what is under test, so hand it an empty world first.
  h.sys._portals = [];
  h.sys.dispose();
  assert.equal(h.sys._offBus.length, 0);
  // A disposed system must not still be re-stamping arming clocks.
  const armAt = h.sys._armAt;
  h.engine.elapsed += 10;
  h.bus.emit('player:spawned', { position: new THREE.Vector3() });
  assert.equal(h.sys._armAt, armAt);
});

/* ------------------------------------------------------------------ */
/* 6. The guard that is NOT in this file                               */
/* ------------------------------------------------------------------ */

test('the fixed loop that drives fixedUpdate is behind gameplayBlocked', () => {
  /* Walk-through has no `!input.textCaptured` test, and does not need one: when
   * a modal is up or the pointer lock drops, `main.js` skips the ENTIRE fixed
   * loop, so nothing integrates and there is nothing to drift into a portal
   * with. That is a property of the CALL SITE, not of `Portals`, so it is
   * checked at the call site - a reordering that moved `portals.fixedUpdate`
   * above the early return would hand typing players a live portal trigger and
   * no unit test of this system could see it. */
  const src = fs.readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('engine.onFixedUpdate('));
  const end = body.indexOf('\n});');
  assert.ok(end > 0, 'could not find the fixed-update block in main.js');
  const block = body.slice(0, end);
  const guard = block.indexOf('if (gameplayBlocked()) return;');
  const call = block.indexOf('portals.fixedUpdate(');
  assert.ok(guard >= 0, 'the fixed loop no longer early-returns on gameplayBlocked()');
  assert.ok(call > guard, 'portals.fixedUpdate runs before the gameplayBlocked() guard');
});
