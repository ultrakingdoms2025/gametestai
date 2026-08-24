import * as THREE from 'three';

/**
 * A WHOLE GAME, WITHOUT A BROWSER, FOR DRIVING THE LOOP.
 *
 * Shared by `piloting-loop` and `piloting-return`, because both of them need
 * the same expensive thing: four REAL worlds registered with a REAL
 * `WorldManager`, a REAL `Physics`, a REAL `EventBus` and a REAL `Piloting`
 * driving the REAL `Flight` integrator.
 *
 * ── Why none of that is stubbed ────────────────────────────────────────────
 *
 * The house rule is that for anything a player's BODY does, you drive the real
 * integrator and derive nothing. A ship is a body. Every claim in these two
 * files - "you can take off from every pad", "you can always find the yard",
 * "landing too fast never strands you" - is only worth the paper it is on if
 * the thing being flown is the thing that ships.
 *
 * The specific traps that stubbing would hide, all of which this rig has
 * actually caught:
 *
 *   - `WorldManager._activate` rebuilds the physics world from the arriving
 *     world's colliders. A stub that just set `_active` would never notice a
 *     seam that lands the ship where the new world has no floor.
 *   - `Piloting` re-asserts the player's body every frame because
 *     `Player.teleport` (which activation calls) releases it. With a stub
 *     player that never releases anything, that whole hazard is invisible.
 *   - `buildShipModel` runs the real `Hulls.js` builders against the real yard
 *     material set. Headless, with the canvas shim below, that is a genuine
 *     exercise of the hull art - and it is how the 180-degree nose offset was
 *     confirmed rather than assumed.
 *
 * What IS stubbed is exactly two things, and neither is gameplay: a 2D canvas
 * context (the yard paints eleven procedural textures) and a WebGL renderer
 * object with the four methods the world builders poke. Both are the same
 * shims `planet-reach.test.mjs` and `dock-launch.test.mjs` already use.
 */

export function domHarness() {
  if (globalThis.__flightRigHarness) return;
  globalThis.__flightRigHarness = true;
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

domHarness();

const { Physics } = await import('../../src/physics/Physics.js');
const { EventBus } = await import('../../src/core/EventBus.js');
const { WorldManager } = await import('../../src/worlds/WorldManager.js');
const { DockWorld } = await import('../../src/worlds/DockWorld.js');
const { SpaceWorld } = await import('../../src/worlds/SpaceWorld.js');
const { StationWorld } = await import('../../src/worlds/StationWorld.js');
/* Registered, never built by `rig()` itself. `harness-framings.test.mjs` asks
 * for it and builds it on demand; nothing else pays for it. Registration is
 * what lets a suite `goto('sports')` at all - a world the manager has never
 * heard of cannot be activated, and that is why the sports framings had no
 * ray probe of their own for as long as they have existed. */
const { SportsWorld } = await import('../../src/worlds/SportsWorld.js');
const { worldClasses } = await import('../../src/worlds/planets/index.js');
const { Piloting } = await import('../../src/ships/Piloting.js');
const { Mining } = await import('../../src/systems/Mining.js');
const { ShipRegistry } = await import('../../src/ships/ShipRegistry.js');
const { FLIGHT } = await import('../../src/ships/Flight.js');
const { BIAS_PER_POINT } = await import('../../src/ships/Ship.js');
const { SHIP_BASE_STATS, SHIP_STAT_META, SHIP_ORDER, holdCapacity } =
  await import('../../src/ships/ShipStats.js');

export { Physics, WorldManager, Piloting, Mining, ShipRegistry, EventBus };
export { SHIP_ORDER };

/** The fixed step the engine runs at. Everything below is driven at this. */
export const DT = 1 / 60;

/**
 * A player, reduced to the surface `Piloting` writes to and reads from.
 *
 * Every field here is one this mode actually touches, and the two that look
 * like decoration are not: `movementOverrideCollide` is what stops a 0.35 m
 * capsule solve ejecting a 28 m hull from a hangar, and `_harnessFrozen` is
 * what stops `Player._applyCamera`, `CameraRig` and `Unstuck` from fighting the
 * chase camera. A stub that omitted either would let a regression through.
 */
export function fakePlayer() {
  return {
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    yaw: 0,
    movementOverride: false,
    movementOverrideCollide: true,
    _harnessFrozen: false,
    health: 100,
    /* `SpaceCombat._hullAlarm` reads the FRACTION, so the ceiling has to be
     * here as well as the current value - a hull alarm against an undefined
     * max is an alarm that never fires. */
    maxHealth: 100,
    damageTaken: 0,
    setYaw(y) { this.yaw = y; },
    applyDamage(n) { this.damageTaken += n; this.health -= n; },
    teleport(p, yaw = this.yaw) { this.position.copy(p); this.yaw = yaw; this.movementOverride = false; },
  };
}

/** An input device with no device. Fields match `src/core/Input.js`'s surface. */
export function fakeInput() {
  return {
    state: { forward: 0, right: 0, jump: false, crouch: false, sprint: false, interact: false },
    textCaptured: false,
    _look: { dx: 0, dy: 0 },
    _pressed: new Set(),
    _held: new Set(),
    consumeLook() { const l = { ...this._look }; this._look.dx = 0; this._look.dy = 0; return l; },
    pressed(code) { return this._pressed.has(code); },
    held(code) { return this._held.has(code); },
    press(code) { this._pressed.add(code); },
    endFrame() { this._pressed.clear(); },
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 *  THE RIG MUST FLY THE SHIP THE GAME FLIES
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── What went wrong, and it invalidated four suites' worth of numbers ──────
 *
 * `Piloting.board` asks `_shipRecord` for the hull it hands `Flight.setShip`,
 * and both of that method's original lookups were WORLD-SCOPED: only
 * `DockWorld` publishes `world.ships`, and `ShipRegistry._adopt` replaces its
 * `_ships` map on every `world:changed`. Every board that did not happen
 * inside the yard therefore fell through to `setShip({ powerMul: 1 })`, and a
 * bare snapshot is exempt from `setShip`'s own throw — so nothing said a word.
 *
 * The rig boards after `goto('space')` (combat, objectives, transit) and after
 * landing on a planet (returns), so the flown Kestrel cruised at 120 m/s where
 * the game's stock Kestrel cruises at 210. Slower than a skiff. Every suite
 * that measured an engagement range, a leg time or a closing speed through
 * this rig measured a hull the game does not have — optimistic in one
 * direction (a slow ship is easy to hold in a gunsight) and pessimistic in the
 * other (it can never outrun anything).
 *
 * That is this project's signature defect — a harness that measures something
 * the game does not do — for the third time in one day, after reach probes
 * flooding at 38 degrees where the game walks 56.6, and a `contract-check`
 * regex reporting a method present against a file with the method deleted.
 *
 * ── So the rig now refuses to fly a substitute ────────────────────────────
 *
 * `rig()` wraps the live `Piloting.board` with {@link assertFlownHull}. Every
 * successful board — including the two `Piloting` makes internally, off KeyF
 * and out of `deserialize` — is checked against `ShipStats` before the caller
 * gets control back, and a mismatch THROWS out of `board` into the test.
 *
 * The expectation is restated from the DATA rather than read back off the code
 * path under test: `SHIP_BASE_STATS` x `BIAS_PER_POINT`, the ladder's own
 * `SHIP_STAT_META.power.perTier`, `FLIGHT.thrust / FLIGHT.drag`,
 * `FLIGHT.hardCap` and `holdCapacity`. Calling `cruiseTopSpeed(f.powerMul)`
 * here would have passed against a `powerMul` of 1 quite happily, which is the
 * whole reason this guard exists.
 *
 * It is a wrapper on the instance rather than a `pilot:boarded` subscriber
 * because `EventBus.emit` CATCHES handler exceptions and logs them — a guard
 * that can only console.error is the silent substitution again with an extra
 * step.
 */

/** What `ShipStats` says this hull is, at this owned power tier. */
export function expectedHull(shipId, tiers = {}) {
  const base = SHIP_BASE_STATS[shipId];
  if (!base) return null;
  const t = (k) => Math.max(0, Math.floor(Number(tiers?.[k]) || 0));
  const powerMul = (1 + base.power * BIAS_PER_POINT)
    * (1 + (t('power') * SHIP_STAT_META.power.perTier) / 100);
  return {
    powerMul,
    accelMul: powerMul,
    cruiseTop: (FLIGHT.thrust * powerMul) / FLIGHT.drag,
    boostTop: FLIGHT.hardCap * powerMul,
    hold: holdCapacity(shipId, t('hold')),
  };
}

/** Equal to within a float epsilon, and FINITE — a NaN must never read equal. */
function near(a, b) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
}

/**
 * Throw unless the hull now in the seat is the one `ShipStats` describes.
 *
 * Checks the three numbers a substituted ship changes and one that catches a
 * NaN reaching the integrator: `powerMul`, cruise top, boost top and hold.
 * Called on every successful `board` by the wrapper `rig()` installs, and
 * exported so a case that reaches for `Flight` directly can use it too.
 */
export function assertFlownHull(r, shipId) {
  const want = expectedHull(shipId);
  if (!want) return;              // not a hull with a stat ladder; nothing to pin
  const tiers = r.ships?.getPowers?.(shipId) ?? {};
  const full = expectedHull(shipId, tiers);
  const f = r.piloting.flight;
  const bad = [];
  if (!near(f.powerMul, full.powerMul)) bad.push(`powerMul ${f.powerMul} != ${full.powerMul}`);
  if (!near(f.accelMul, full.accelMul)) bad.push(`accelMul ${f.accelMul} != ${full.accelMul}`);
  if (!near(f.cruiseTop, full.cruiseTop)) bad.push(`cruiseTop ${f.cruiseTop} != ${full.cruiseTop}`);
  if (!near(f.boostTop, full.boostTop)) bad.push(`boostTop ${f.boostTop} != ${full.boostTop}`);
  if (r.piloting.cargoCapacity !== full.hold) {
    bad.push(`hold ${r.piloting.cargoCapacity} != ${full.hold}`);
  }
  if (!bad.length) return;
  throw new Error(
    `_flightrig: the rig is not flying the game's ${shipId}.\n`
    + `  world  : ${r.wm?.active?.id ?? 'none'}\n`
    + `  tiers  : ${JSON.stringify(tiers)}\n`
    + `  wrong  : ${bad.join('; ')}\n`
    + '  A stock hull at powerMul 1 cruises at 120 m/s, slower than every ship the\n'
    + '  yard sells. Every range, leg time and closing speed measured through a rig\n'
    + '  in that state describes a ship the game does not have. See the note above\n'
    + '  assertFlownHull in scripts/tests/_flightrig.mjs.'
  );
}

/**
 * Board a hull at an explicit upgrade tier, through the real purchase path.
 *
 * The tier bag is set with `ShipRegistry.grantPower`, which is what the
 * marketplace calls, so `_knownStat` still refuses a stat a hull does not
 * sell. `grantPower` only ever RAISES, and the registry is shared across
 * cases, so the bag is cleared first — the same test-isolation reset
 * `space-combat.test.mjs` documents.
 */
export function boardHull(r, shipId, { tiers = null, silent = true } = {}) {
  if (r.piloting.active) r.piloting.disembark({ silent: true, force: true });
  delete r.ships._powers[shipId];
  if (tiers) for (const k in tiers) if (tiers[k] > 0) r.ships.grantPower(shipId, k, tiers[k]);
  const ok = r.piloting.board(shipId, { silent });
  if (!ok) throw new Error(`_flightrig: could not board the ${shipId} in ${r.wm?.active?.id}`);
  return r.piloting.flight;
}

let _rig = null;

/**
 * Build the whole thing once per process.
 *
 * The dock, the void, Cinder and the station are all generated for real, which
 * is 3-6 seconds. `worldManager.build` is idempotent and the instances are
 * cached, so every case after the first pays nothing.
 *
 * The station is registered because one of the hazard cases needs a world a
 * ship CANNOT fly in, and a fake id would not exercise `_onWorldChanging`'s
 * real path through `WorldManager`.
 */
export async function rig() {
  if (_rig) return _rig;
  const renderer = {
    capabilities: { getMaxAnisotropy: () => 4, isWebGL2: true },
    initTexture() {}, getContext: () => ({}),
    getRenderTarget: () => null, setRenderTarget() {}, render() {}, clear() {},
  };
  const bus = new EventBus();
  const physics = new Physics(bus);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 2000);
  const ctx = {
    scene,
    engine: { renderer, camera, running: false, elapsed: 0, onFrameUpdate: () => () => {}, onResize: () => () => {} },
    physics,
    bus,
    materials: { get: () => new THREE.MeshStandardMaterial(), dispose() {} },
  };
  const wm = new WorldManager(ctx);
  wm.register(DockWorld).register(SpaceWorld).register(StationWorld).register(SportsWorld);
  for (const C of worldClasses()) wm.register(C);

  const player = fakePlayer();
  const input = fakeInput();
  wm.attach({ player });

  await wm.build('dock');
  await wm.build('space');
  await wm.build('cinder');

  const ships = new ShipRegistry({ bus, worldManager: wm });
  const economy = { credits: 0, add(n) { this.credits += n; } };
  const piloting = new Piloting({
    scene, engine: ctx.engine, physics, bus, input, player, camera,
    cameraRig: null, avatar: { visible: true, setVisible(v) { this.visible = v; } },
    worldManager: wm, ships, economy,
  });
  const mining = new Mining({ bus, player, input, worldManager: wm, piloting });

  _rig = { wm, bus, physics, scene, camera, player, input, piloting, mining, ships, economy, ctx };

  /* THE GUARD. See the block above `assertFlownHull`.
   *
   * Wrapped on the instance, so `this.board(...)` from inside `Piloting` -
   * KeyF at a berth, and the re-board `deserialize` performs - is checked too.
   * Only a board that SUCCEEDED is checked: a refusal never touched `Flight`. */
  const realBoard = piloting.board.bind(piloting);
  piloting.board = (shipId, opts) => {
    const ok = realBoard(shipId, opts);
    if (ok) assertFlownHull(_rig, shipId);
    return ok;
  };

  return _rig;
}

/** Activate a world and let every microtask and rAF the swap queued settle. */
export async function goto(r, id) {
  await r.wm.activate(id);
  await settle();
}

/** Let pending promises and the harness's rAF timers run. */
export async function settle(times = 4) {
  for (let i = 0; i < times; i++) await new Promise((res) => setTimeout(res, 0));
}

const _d = new THREE.Vector3();
const _inv = new THREE.Quaternion();

/**
 * PROPORTIONAL STEERING ONTO A POINT, THROUGH THE REAL COMMAND STRUCT.
 *
 * This is the whole autopilot the tests fly with, and it deliberately has no
 * privileged access: it writes `pitch`, `yaw`, `throttle`, `boost` and `brake`
 * - the same five fields a keyboard writes through `Flight.readInput` - and
 * `Piloting.fixedUpdate` does the rest. Nothing here calls `place`, sets a
 * velocity or nudges a position, so a route it can fly is a route a player can
 * fly, and a seam it triggers is a seam a player triggers.
 *
 * The body-frame conversion is the one piece of arithmetic worth stating:
 * `Flight` commands +pitch as NOSE UP and +yaw as NOSE RIGHT, and the nose is
 * local -Z, so a target whose body-frame offset has positive Y is above (pitch
 * up) and positive X is to starboard (yaw right). Those two signs are checked
 * by a case of their own, because getting one backwards produces an autopilot
 * that flies away from everything and a test file that fails for a reason that
 * has nothing to do with the game.
 */
export function steerTo(flight, target, { gain = 3.0, throttle = 1, boost = false, brake = false } = {}) {
  _d.copy(target).sub(flight.position);
  const dist = _d.length();
  if (dist < 1e-6) return 0;
  _d.divideScalar(dist);
  _inv.copy(flight.quaternion).invert();
  _d.applyQuaternion(_inv);
  flight.setCommand({
    pitch: Math.max(-1, Math.min(1, _d.y * gain)),
    yaw: Math.max(-1, Math.min(1, _d.x * gain)),
    roll: 0,
    /* Throttle is cut when the nose is more than about 65 degrees off, so a
     * turn-in is a turn rather than a wide arc. A player does exactly this. */
    throttle: _d.z < -0.42 ? throttle : 0,
    vertical: 0,
    boost: boost && _d.z < -0.9,
    brake,
  });
  return dist;
}

/**
 * A PILOT WHO RESPECTS A SPEED BUDGET.
 *
 * `steerTo` points the nose; this decides how fast to go while doing it. The
 * rule is the one a human uses on any approach: never be going faster than the
 * distance remaining allows you to stop in. `k` is that ratio, and 0.3-0.35
 * comes out of the flight model's own measured braking - 33.7 m of stopping
 * distance from cruise with the airbrake held, against 180.6 m coasting.
 *
 * Without it the tests fly like a brick: `steerTo` alone pins the throttle,
 * every approach overshoots, and the first descent onto Cinder went through
 * the caldera floor at 130 m/s. That is a real thing a real player does, and
 * `_forceSetDown` exists for it - but a test that ONLY ever crashes is not
 * testing landing.
 */
export function approach(flight, target, { k = 0.35, min = 8, max = 300 } = {}) {
  const d = flight.position.distanceTo(target);
  const want = Math.max(min, Math.min(max, d * k));
  return steerTo(flight, target, {
    throttle: flight.speed < want * 0.85 ? 1 : 0,
    brake: flight.speed > want,
  });
}

/**
 * TAKE OFF THE WAY THE CONTROL SCHEME INTENDS: STRAIGHT UP FIRST.
 *
 * `Flight.readInput` binds Space to vertical thrust at `verticalFrac` 0.50 of
 * the main engine, and that - not the throttle - is how a ship leaves a pad.
 * The distinction is not pedantry: driving a climb with `pitch + throttle` from
 * Rimhold Shelf, which is a 20 m pad cut into a crater rim that falls 64.8 m
 * across its own disc, flies the hull into the rim wall before the nose has
 * finished coming up. Measured: 84 impacts in 90 s and never above 118 m.
 *
 * So: vertical thrust until the hull is clear of everything around it, then
 * nose up and throttle. It is what a pilot does and it is what the keys are
 * for.
 */
export function liftOff(flight, clearAlt) {
  const climbing = flight.position.y < clearAlt;
  flight.setCommand({
    pitch: climbing ? 0 : 0.55,
    yaw: 0,
    roll: 0,
    throttle: climbing ? 0 : 1,
    vertical: 1,
    boost: !climbing,
  });
}

/**
 * Fly, one fixed step at a time, until `done` says stop or the clock runs out.
 *
 * `await`s every step so the asynchronous world swap inside `Piloting._travel`
 * can actually resolve - a synchronous loop would spin past the activation and
 * report that the seam never fired.
 *
 * @returns {{t:number, steps:number, done:boolean}}
 */
export async function fly(r, drive, done, { limit = 240 } = {}) {
  const steps = Math.round(limit / DT);
  for (let i = 0; i < steps; i++) {
    if (r.piloting._travelling) { await settle(2); continue; }
    /* `done` is checked BEFORE the drive as well as after it.
     *
     * A seam fires inside `fixedUpdate` and resolves asynchronously, so the
     * iteration that notices it has already run one `drive` call in the NEW
     * world. That is how a homing leg that had just docked called
     * `navReport()` from inside the yard, got an empty list, and failed an
     * assertion about a flight that had in fact succeeded. */
    if (done(i * DT)) return { t: i * DT, steps: i, done: true };
    drive(i * DT);
    r.piloting.fixedUpdate(DT, i * DT);
    if (done(i * DT)) return { t: i * DT, steps: i, done: true };
    /* Yield to the microtask queue every step. Cheap, and it is what lets a
     * seam that fires on step N have finished activating by step N+1. */
    if ((i & 15) === 0) await null;
    else await null;
  }
  return { t: limit, steps, done: false };
}
