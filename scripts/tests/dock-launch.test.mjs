import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

/**
 * THE LAUNCH SEAM, FLOWN BOTH WAYS, BEFORE THERE IS ANYTHING TO FLY.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THIS TEST IS WRITTEN IN THE DOCK DROP
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The dock drop's job is to leave a seam the flight drop plugs into without
 * rework. There are exactly three ways that goes wrong, all of them recorded
 * in the design's risk register, and all three are silent until somebody
 * actually walks through the blast door:
 *
 *  1. The launch portal is authored INSIDE A COCKPIT. `arrivalFor` stands a
 *     returning body 2.6 m along the portal's own normal, so a spec inside a
 *     3 m cockpit puts the pilot in the far bulkhead - or through it.
 *  2. A SECOND spec is added for the return leg. `arrivalFor` finds the return
 *     portal BY TARGET and takes `.find()`'s first match, so with two the
 *     wrong one wins, silently and not always.
 *  3. `_kit()` is never branched and the blast door grows a ceremonial arch
 *     with three approach steps and two jambs in the middle of a hangar floor.
 *
 * "If that test is green at the end of Drop One, the flight drop plugs in; if
 * it does not exist, the flight drop starts by rewriting the dock."
 *
 * ── Driven through the real WorldManager ──────────────────────────────────
 * `arrivalFor` is not reimplemented here. Both worlds are registered with a
 * real `WorldManager`, really built through its real `_runBuild` (scratch
 * physics, progress relay, collider harvest and all), and the arrival points
 * are the ones the game will actually use. Reproducing the 2.6 m offset in the
 * test would only prove that this file and that file agree about arithmetic
 * neither of them is running.
 */

function harness() {
  if (globalThis.__dockLaunchHarness) return;
  globalThis.__dockLaunchHarness = true;
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
const { Physics } = await import('../../src/physics/Physics.js');
const { WorldManager } = await import('../../src/worlds/WorldManager.js');
const { DockWorld } = await import('../../src/worlds/DockWorld.js');
const { SpaceWorld } = await import('../../src/worlds/SpaceWorld.js');
const PLAN = await import('../../src/worlds/dock/YardPlan.js');
/* The apron's own half-width, read rather than typed. This test used to have
 * `65` written into its kerb probe, which was the apron half-width at the time
 * - so when the apron widened to match the 164 m mouth it serves, the probe
 * landed on open deck and the test went red for a correct change. A test that
 * hard-codes a dimension of the thing it is testing fails for the right change
 * and passes for the wrong one. */
const { APRON_HALF_W } = await import('../../src/worlds/space/DockExterior.js');

let _rig = null;
async function rig() {
  if (_rig) return _rig;
  const renderer = {
    capabilities: { getMaxAnisotropy: () => 4, isWebGL2: true },
    initTexture() {}, getContext: () => ({}),
    getRenderTarget: () => null, setRenderTarget() {}, render() {}, clear() {},
  };
  const ctx = {
    scene: new THREE.Scene(),
    engine: { renderer, running: false, onFrameUpdate: () => () => {}, onResize: () => () => {} },
    physics: new Physics(),
    bus: { on: () => () => {}, emit() {} },
    materials: { get: () => new THREE.MeshStandardMaterial(), dispose() {} },
  };
  const wm = new WorldManager(ctx);
  wm.register(DockWorld).register(SpaceWorld);
  const dock = await wm.build('dock');
  const space = await wm.build('space');
  _rig = { wm, dock, space };
  return _rig;
}

/**
 * The ground under a point, out of a world's own harvested colliders.
 *
 * `WorldManager.arrivalFor` only snaps when the target world is the LIVE one,
 * and nothing here activates anything - so the arrival points below are the
 * un-snapped ones, and this is what checks there is something under them. A
 * real activation would put the body 0.05 m over whatever this finds.
 */
function groundAt(world, x, z, from = 4) {
  const p = new Physics();
  for (const c of world.colliders) if (c) p.add(c);
  return p.groundHeight(x, z, from, 30);
}

/* ====================================================================== */

test('there is exactly ONE spec for the pair, on each side', async () => {
  /* The whole trap in `arrivalFor` is `.find()`: it takes the FIRST portal
   * whose target matches, so a second spec added "for the return leg" is a
   * coin flip that lands on source order. One spec per pair, per side. */
  const { dock, space } = await rig();
  const out = dock.portalSpecs.filter((s) => s.target === 'space');
  assert.equal(out.length, 1, `the yard publishes ${out.length} portals to space`);
  const home = space.portalSpecs.filter((s) => s.target === 'dock');
  assert.equal(home.length, 1, `open space publishes ${home.length} portals to the yard`);
  assert.equal(space.portalSpecs.length, 1, 'open space publishes a portal to somewhere else as well');
  // ...and the yard still has its gateway home, which is a different pair.
  assert.equal(dock.portalSpecs.filter((s) => s.target === 'station').length, 1);
  assert.equal(dock.portalSpecs.length, 2);
});

test('THE LAUNCH PORTAL IS ON THE DECK, NOT IN A COCKPIT', async () => {
  /* Stated as a position test rather than as a comment, because the reason it
   * matters is invisible from the spec: a cockpit is 2.4-3.4 m across, and
   * `arrivalFor` puts a returning body 2.6 m from the portal. The only way
   * that is safe is for there to be tens of metres of clear deck in front of
   * the aperture, which is what these bounds are. */
  const { dock } = await rig();
  const spec = dock.portalSpecs.find((s) => s.target === 'space');
  assert.equal(spec.position.z, PLAN.PORTAL_SPACE_Z);
  assert.equal(spec.position.x, 0, 'the launch portal has left the keel line');
  /* It stands on BERTH ZERO'S PAD now, not on the deck in front of a blast
   * door — there is no blast door, the north end is a 164 m open mouth and the
   * one empty pier is where a ship leaves from and comes home to. The claim in
   * the title is unchanged and is the one that matters: this is a pad with
   * fifteen metres of clear deck on every side of it, not a 3 m cockpit. */
  const zero = PLAN.PIERS.find((p) => p.dock);
  const pad = PLAN.pierPad(zero);
  assert.ok(spec.position.z < pad.z0 && spec.position.z > pad.z1,
    `the launch portal at z ${spec.position.z} is not on Berth Zero's pad (${pad.z1}..${pad.z0})`);
  // Not inside any berth footprint, which is where the cockpits will be.
  for (const b of dock.shipSpecs) {
    const dx = spec.position.x - b.x;
    const dz = spec.position.z - b.z;
    assert.ok(Math.hypot(dx, dz) > Math.max(b.footprint.hw, b.footprint.hd) + 4,
      `the launch portal is inside berth ${b.berth}'s footprint`);
  }
  /* And 2.6 m in front of it, plus the width of a body, is clear deck. */
  for (let r = 0; r <= 6; r += 0.5) {
    const g = groundAt(dock, 0, spec.position.z + r);
    assert.ok(g !== null && Math.abs(g) < 0.3,
      `${r} m in front of the launch portal the ground reads ${g} - it should be the deck at 0`);
  }
});

test('dock -> space -> dock: both arrivals land on solid ground, inside the right footprint', async () => {
  const { wm, dock, space } = await rig();

  /* OUTBOUND. Arriving in space from the dock, `arrivalFor` looks up the
   * portal in SPACE whose target is `dock` - the way home - and stands the
   * body in front of it. */
  const out = wm.arrivalFor('space', 'dock', { snapToGround: false });
  assert.ok(out.portalSpec, 'no return portal found in space for an arrival from the dock');
  assert.equal(out.portalSpec.target, 'dock');
  /* The 60 m holding platform this used to check is gone; the space side of
   * the seam is now the yard's own docking APRON, between the hangar mouth and
   * the piers. The guarantee is unchanged - you arrive on deck, not in vacuum. */
  assert.ok(Math.abs(out.position.x) < 60,
    `the outbound arrival lands at x ${out.position.x.toFixed(1)}, off the side of the apron`);
  assert.ok(out.position.z < -18 && out.position.z > -84,
    `the outbound arrival lands at z ${out.position.z.toFixed(1)}, off the apron (-18 to -84)`);
  const outGround = groundAt(space, out.position.x, out.position.z, out.position.y + 2);
  assert.ok(outGround !== null,
    'the outbound arrival lands in vacuum - there is no deck under it');
  assert.ok(Math.abs(outGround - 0) < 0.2, `the apron reads ${outGround}, not 0`);

  /* INBOUND. Coming home, `arrivalFor` looks up the portal in the DOCK whose
   * target is `space` - which is the same spec the outbound leg used, because
   * there is only one. That is the arrangement, and this is the assertion that
   * proves the one spec serves both directions. */
  const home = wm.arrivalFor('dock', 'space', { snapToGround: false });
  assert.ok(home.portalSpec, 'no return portal found in the dock for an arrival from space');
  assert.equal(home.portalSpec.target, 'space');
  assert.equal(home.portalSpec, dock.portalSpecs.find((s) => s.target === 'space'),
    'the inbound leg resolved to a different spec from the outbound one');
  const zeroPier = PLAN.PIERS.find((p) => p.dock);
  const zeroPad = PLAN.pierPad(zeroPier);
  assert.ok(home.position.z < zeroPad.z0 && home.position.z > zeroPad.z1,
    `coming home lands at z ${home.position.z.toFixed(1)}, off Berth Zero's pad `
    + `(${zeroPad.z1}..${zeroPad.z0})`);
  assert.ok(Math.abs(home.position.x) < 6, 'coming home lands off the keel line');
  const homeGround = groundAt(dock, home.position.x, home.position.z, home.position.y + 2);
  assert.ok(homeGround !== null,
    "coming home lands in vacuum - the deck of Berth Zero's docking cradle is missing");
  assert.ok(Math.abs(homeGround) < 0.3, `Berth Zero's pad reads ${homeGround}, not the deck at 0`);

  /* Both arrivals face INTO their world rather than at the thing they just
   * came out of. `arrivalFor` returns `rotY + PI`, and a character looks down
   * -Z at yaw 0, so the heading is `-(sin yaw, cos yaw)`. */
  const heading = (yaw, from, dist) => ({
    x: from.x - Math.sin(yaw) * dist,
    z: from.z - Math.cos(yaw) * dist,
  });
  const hHome = heading(home.yaw, home.position, 40);
  assert.ok(hHome.z > home.position.z + 20,
    'a pilot coming home is looking at the blast door instead of down the yard');
  assert.ok(groundAt(dock, hHome.x, hHome.z) !== null, 'the view down the yard ends in a hole');
  const hOut = heading(out.yaw, out.position, 15);
  assert.ok(groundAt(space, hOut.x, hOut.z) !== null,
    'arriving in space you are facing back at the blast door, or out over nothing');
  assert.ok(hOut.z < out.position.z,
    'arriving in space you are facing the hangar you just came out of, not the piers');
});

test('the return trip through the STATION gateway still works, unchanged', async () => {
  /* The yard is the first world with two gateways, so the second one is the
   * one that could break the first. `arrivalFor` keys on target, and both
   * specs are in the same array. */
  const { wm } = await rig();
  const a = wm.arrivalFor('dock', 'station', { snapToGround: false });
  assert.equal(a.portalSpec.target, 'station');
  assert.ok(a.position.z > PLAN.YARD_Z1 - 12 && a.position.z < PLAN.YARD_Z1,
    `arriving from the station lands at z ${a.position.z.toFixed(1)}, off the apron`);
  assert.notEqual(a.portalSpec.target, 'space', 'the launch portal answered a station arrival');
});

test('the blast door does not grow a ceremonial arch', async () => {
  /* `_kit` branches on the DESTINATION, so with no `style` on the spec both
   * legs of this pair would resolve to the station's alloy frame: an arch, two
   * jambs, three processional approach steps and a stepped dais, in the middle
   * of a hangar floor and ten metres from a sealed 34 m blast door.
   *
   * Checked on the SPECS rather than by building a PortalSystem, because
   * building one needs a renderer, a camera and a scene graph, and what is
   * being asserted is a contract between the world and the portal system that
   * lives entirely in the spec. The matching half - that `_kit` honours it and
   * that the collider block goes flush - is asserted against the source. */
  const { dock, space } = await rig();
  const launch = dock.portalSpecs.find((s) => s.target === 'space');
  assert.equal(launch.style, 'launch', 'the launch portal does not ask for the launch style');
  const home = space.portalSpecs.find((s) => s.target === 'dock');
  assert.equal(home.style, 'launch', 'the way home from space is a ceremonial gateway');
  // The station gateway is deliberately NOT a launch aperture: it is a
  // gateway, and it should look like every other gateway on the ring.
  const gate = dock.portalSpecs.find((s) => s.target === 'station');
  assert.ok(!gate.style, 'the yard has restyled its own gateway home');

  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const src = readFileSync(path.join(root, 'src/systems/Portals.js'), 'utf8');
  assert.match(src, /_kit\(target, wanted = null\)/, '_kit no longer accepts a style');
  assert.match(src, /wanted === 'launch' \? 'launch'/, "_kit does not honour a spec's style");
  assert.match(src, /this\._kit\(target, spec\.style\)/, '_createPortal is not passing the style through');
  assert.match(src, /_buildLaunchAperture\(kit\)/, 'there is no launch aperture builder');
  // The three things a launch aperture must not have.
  assert.match(src, /const flush = kit\.style === 'launch';/, 'the collider block does not know about the flush style');
  assert.match(src, /for \(const tier of flush \? \[\] : PLINTH_TIERS\)/, 'a launch aperture still builds a dais');
  assert.match(src, /for \(let s = 0; flush \? false : s < 3; s\+\+\)/, 'a launch aperture still builds approach steps');
  assert.match(src, /for \(const sx of flush \? \[\] : \[-1, 1\]\)/, 'a launch aperture still builds jambs');
});

test('the cockpit seat has a door to knock on', async () => {
  /* The one API the flight drop needs from this drop. The seat cannot author
   * its own portal - see the position test above - so it has to enter the one
   * on the deck by id, and the id is `${worldId}->${target}`. Three lines in
   * `PortalSystem`, written now so the flight drop does not reach into
   * `_portals` and make a private array public by accident. */
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const src = readFileSync(path.join(root, 'src/systems/Portals.js'), 'utf8');
  assert.match(src, /^\s{2}enterById\(id\) \{/m, 'PortalSystem has no enterById');
  assert.match(src, /id: `\$\{this\._worldId\}->\$\{target\}`/,
    'the portal id is no longer `world->target`, so `dock->space` names nothing');

  /* And the quest that ends on it names exactly that id. Quest 60 is the hook
   * the flight drop lands on; when the seat exists it calls
   * `enterById('dock->space')` and emits the SAME `quest:activity` the deck
   * portal emits today, so the quest does not change. */
  const { DOCK_QUESTS } = await import('../../admin/lib/quests/index.mjs');
  const last = DOCK_QUESTS.find((q) => q.n === 60);
  assert.ok(last, 'quest 60 is missing');
  const step = last.steps.find((s) => s.type === 'interact');
  assert.equal(step.target, 'dock->space',
    'the final step of the yard does not name the launch portal by id');
});

test('open space gives a body deck to stand on, kerbs, and a way home', async () => {
  /* This used to assert a 60 m holding platform. That platform was a
   * deliberate stub and it is gone; what stands at the seam now is the yard's
   * exterior - the apron outside the hangar mouth and the four piers reaching
   * into vacuum.
   *
   * The assertions are the same QUESTIONS, asked of the new geometry, because
   * they were never about the platform. The honest failure mode for a place
   * you arrive in is not "too small", it is "not actually a world": no floor,
   * no way back, a spawn inside geometry, a bottomless edge you cannot see.
   *
   * The pier check is the one that matters most here and it is new. Four piers
   * are DRAWN reaching out to four berths; this walks the deck out to each
   * berth pad and asserts there is ground the whole way. Content that is built
   * but cannot be reached is the signature defect of this project, and a pier
   * with no collider under it is exactly that - it looks like somewhere you
   * can walk to a parked ship, and it is a painting. */
  const { space } = await rig();
  assert.ok(space.colliders.length >= 8, `the yard exterior has ${space.colliders.length} colliders`);

  // Deck on the apron, in front of the mouth and out to the cross-walk.
  for (const [x, z] of [[0, -30], [0, -60], [40, -50], [-40, -50], [0, -88]]) {
    assert.ok(groundAt(space, x, z) !== null, `no deck at (${x}, ${z})`);
  }

  // ...and out along every pier, to the berth at the end of it.
  for (const berth of space.dock.anchor.berths) {
    const [bx, , bz] = berth.position;
    for (let z = -100; z >= bz; z -= 20) {
      assert.ok(groundAt(space, bx, z) !== null,
        `${berth.id}: the pier has no deck at z ${z} - it is drawn but not walkable`);
    }
    assert.ok(groundAt(space, bx, bz) !== null, `${berth.id}: no pad at the berth itself`);
  }

  // And vacuum where there should be vacuum: past the piers, and out to the side.
  assert.equal(groundAt(space, 0, -400), null, 'there is deck out past the end of the piers');
  assert.equal(groundAt(space, 400, -50), null, 'there is deck out beyond the apron');

  // The kerb is over the step and under a mantle: you cannot walk off the
  // apron and you cannot climb out of it by accident either.
  const kerb = groundAt(space, APRON_HALF_W, -50, 4);
  assert.ok(kerb !== null && kerb > 0.45 && kerb < 1.55,
    `the apron kerb tops out at ${kerb} - over 0.45 so it cannot be stepped over, under 1.55 so it is not a mantle`);

  // The cold spawn is on the deck, not in the kerb and not in the portal.
  const spawnGround = groundAt(space, space.playerSpawn.x, space.playerSpawn.z);
  assert.ok(spawnGround !== null, 'the cold spawn in open space is over nothing');
  assert.ok(Math.abs(spawnGround) < 0.3, `the cold spawn stands on ${spawnGround}, not the deck at 0`);

  // One way home, and it goes to the dock.
  const home = space.portalSpecs.filter((sp) => sp.target === 'dock');
  assert.equal(home.length, 1, 'open space must have exactly one way home');

  /* Vacuum has no economy, no garrison and nothing to find on foot. HOSTILES
   * is the exception and it is deliberate: alien craft attacking the ship in
   * flight is the headline feature of this volume, so the gate is open even
   * while the spawner is still being written. */
  for (const rule of ['merchants', 'quests', 'loot', 'caches', 'relics', 'races', 'mounts']) {
    assert.equal(space.rules[rule], false, `open space permits ${rule}`);
  }
  assert.equal(space.rules.hostiles, true, 'open space has to allow hostiles - that is the point of it');
  assert.equal(space.rules.jump, true, 'jumping is a property of the player, not of the place');
});
