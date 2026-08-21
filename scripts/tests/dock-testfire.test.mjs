import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as THREE from 'three';

/**
 * THE TEST-FIRE BUTTS: A RANGE YOU CAN ACTUALLY SHOOT.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE SIGNATURE DEFECT, EXPRESSED AS A SHOOTING RANGE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "Content that is BUILT but cannot be REACHED" is this project's recorded
 * signature defect, and a range has two ways to commit it that a building does
 * not:
 *
 *  1. **A plate with no collider.** It would be drawn, aimed at, and rounds
 *     would pass through it. `weapon:hit` only fires where `physics.raycast`
 *     found something, so an uncollided plate scores nothing, forever, with no
 *     error anywhere. Test 2 asserts every published target has a real box.
 *  2. **A plate nothing has line of fire to.** This is the one a geometry test
 *     misses entirely: the plate is built, collided, correctly sized, and a
 *     cradle leg, a bracket, the plate in front of it or its own hazard frame
 *     stands in the way. Test 3 fires the REAL `physics.raycast` from the real
 *     firing mark at eye height and demands that the FIRST thing the ray meets
 *     is the plate it was aimed at.
 *
 * And a third, which is not about the range at all: the butts sit in the
 * service trench, which is also the route to the northern collectible spots
 * and the bay-n ramp out. Plates that seal a 3 m corridor would trade a
 * contest for a whole section of the world. Test 4 measures the clear lane.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT IS DRIVEN, AND WHAT IS ASSERTED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Everything here runs against a REAL `DockWorld.build()` on the real
 * `Physics`, and against the real `TestFire` module - no re-implementation of
 * either. The scoring tests feed it the exact event shape `Combat` and
 * `Projectiles` emit, because that is the contract that would break silently:
 * the module subscribes to two events it does not own, and a payload change
 * would leave a range where nothing scores and no test failed.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

/* ================================================================== */
/* A world, built without a browser                                    */
/* ================================================================== */

function harness() {
  if (globalThis.__dockTestFireHarness) return;
  globalThis.__dockTestFireHarness = true;
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
const { TestFire, createTestFire, TEST_FIRE_GAME_ID, readTargets } =
  await import('../../src/minigames/TestFire.js');

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

/** The venue the world publishes, or throws. */
async function venue() {
  const { world } = await built();
  const v = (world.minigameVenues ?? []).find((x) => x.kind === 'test_fire');
  assert.ok(v, 'DockWorld publishes no test_fire venue');
  return v;
}

/** A bus that records what it was told. */
function fakeBus() {
  const seen = [];
  const subs = new Map();
  return {
    seen,
    emit(name, payload) { seen.push({ name, payload }); },
    on(name, fn) {
      if (!subs.has(name)) subs.set(name, new Set());
      subs.get(name).add(fn);
      return () => subs.get(name).delete(fn);
    },
    fire(name, payload) { for (const fn of subs.get(name) ?? []) fn(payload); },
    count(name) { return subs.get(name)?.size ?? 0; },
  };
}

/** A bag that answers the two methods the factory uses. */
function fakeBag(cells) {
  return {
    cells,
    bagCount(id) { return id === 'laser_cell' ? this.cells : 0; },
    consumeFromBag(id, n) {
      if (id !== 'laser_cell' || this.cells < n) return false;
      this.cells -= n;
      return true;
    },
  };
}

/** A player standing exactly on the firing mark. */
function onTheMark(v) {
  const m = v.config.fireMark;
  return { position: { x: m.x, y: m.y, z: m.z } };
}

/** Start a contest, past its countdown, with a recording bus. */
function running(v, ctx = {}) {
  const bus = ctx.bus ?? fakeBus();
  const game = new TestFire(v, { bus, player: onTheMark(v), ...ctx });
  game.begin(0);
  return { game, bus };
}

/** The centre of a published plate, as an event point. */
function centreOf(v, id) {
  const t = v.config.targets.find((x) => x.id === id);
  assert.ok(t, `no plate ${id}`);
  return { x: t.x, y: t.y, z: t.z };
}

/* ================================================================== */
/* 1. Three files have to agree, or the venue is inert                 */
/* ================================================================== */

test('the venue, the registration and the game module name the same contest', async () => {
  const v = await venue();
  const main = read('src/main.js');
  const module = read('src/minigames/TestFire.js');

  /* `MinigameManager.arm()` SKIPS a venue whose kind has no registered
   * factory - "a published slot, not an error" - so a venue with a typo'd
   * kind is not a broken prompt, it is NO prompt, and nothing anywhere says
   * so. This is that silence, converted. */
  assert.match(main, /registerGame\('test_fire'/,
    'main.js registers no factory for kind "test_fire": the venue would arm nothing at all');
  assert.match(main, /import \{ createTestFire \} from '\.\/minigames\/TestFire\.js'/,
    'the registration must reach the module by its imported name, which is what quest-vocab follows');
  assert.equal(v.kind, 'test_fire');

  /* `scripts/quest-vocab.mjs` scrapes the game id by this exact declaration
   * shape. Rename the constant and a `minigame` step in the dock silently
   * loses its only legal targets. */
  assert.match(module, /export const TEST_FIRE_GAME_ID = 'test_fire'/);
  assert.equal(TEST_FIRE_GAME_ID, 'test_fire');

  const vocab = await import('../../scripts/quest-vocab.mjs');
  const offered = vocab.candidateValues('minigame', 'dock');
  assert.ok(offered.includes('test_fire_won'),
    `the quest vocabulary offers no win target in the dock: ${JSON.stringify(offered)}`);
  assert.ok(offered.includes(v.id), 'the venue id is not an offered target');
});

test('the arm-time capability gate is declared, and the prompt stays underground', async () => {
  const v = await venue();
  assert.equal(v.requires, 'weapons',
    'a contest that needs a weapon must declare the rule, or turning weapons off leaves a range nobody can shoot');
  /* The deck is 2.2 m over the trench floor. A yTolerance of 2.2 or more would
   * offer the contest to somebody walking on the grating ABOVE the range, who
   * cannot see a plate and would be teleported nowhere. */
  assert.ok(v.yTolerance < Math.abs(PLAN.TRENCH_Y),
    `yTolerance ${v.yTolerance} reaches the deck ${Math.abs(PLAN.TRENCH_Y)} m overhead`);
  // ..and it must still cover a body standing on the trench floor.
  assert.ok(v.yTolerance >= 1.0, `yTolerance ${v.yTolerance} is tighter than standing on the floor`);
});

/* ================================================================== */
/* 2. Every target is a real collider                                  */
/* ================================================================== */

test('every published plate is a real box collider at exactly its published size', async () => {
  const { physics } = await built();
  const v = await venue();
  const targets = v.config.targets;
  assert.equal(targets.length, PLAN.BUTTS_PLATES.length);
  assert.ok(targets.length >= 6, `${targets.length} plates is not a range`);

  const centre = new THREE.Vector3();
  const half = new THREE.Vector3();
  let matched = 0;
  for (const t of targets) {
    let hit = null;
    for (const c of physics.colliders) {
      if (!c.solid || c.type !== 'box') continue;
      if ((c.layer & COLLISION_LAYER.WORLD) === 0) continue;
      centre.setFromMatrixPosition(c.matrix);
      if (centre.distanceTo(new THREE.Vector3(t.x, t.y, t.z)) > 0.02) continue;
      half.set(c.halfExtents?.x ?? 0, c.halfExtents?.y ?? 0, c.halfExtents?.z ?? 0);
      hit = { c, half: half.clone() };
      break;
    }
    assert.ok(hit, `plate ${t.id} at (${t.x}, ${t.y}, ${t.z}) has NO collider: rounds would pass through it`);
    /* The extents the world collides must be the extents the game scores.
     * This is the assertion that caught the plates being DRAWN yawed 90 deg
     * while being COLLIDED square: the line-of-fire probe was green because it
     * only ever asks the collider, and a player would have been aiming at six
     * targets seen edge-on. */
    assert.ok(Math.abs(hit.half.x - t.hx) < 0.01 && Math.abs(hit.half.y - t.hy) < 0.01
      && Math.abs(hit.half.z - t.hz) < 0.01,
      `plate ${t.id} collides as ${hit.half.toArray()} but is scored as (${t.hx}, ${t.hy}, ${t.hz})`);
    // ..and it must face the shooter: thin in Z, wide in X.
    assert.ok(t.hz < t.hx && t.hz < t.hy,
      `plate ${t.id} is thicker than it is wide — it is not facing down the range`);
    matched++;
  }
  assert.equal(matched, targets.length);
});

/* ================================================================== */
/* 3. Line of fire, with the real raycast                              */
/* ================================================================== */

test('the firing mark has clear line of fire to every plate, and the plate is what the round meets first', async () => {
  const { physics } = await built();
  const v = await venue();
  const m = v.config.fireMark;
  /* Eye height, not foot height. `Combat._shoot` casts from the camera, which
   * `Player` carries at eye level - a ray from the floor would clear a bracket
   * that a real shot does not. */
  const EYE = 1.6;
  const from = new THREE.Vector3(m.x, m.y + EYE, m.z);
  const dir = new THREE.Vector3();

  const report = [];
  for (const t of v.config.targets) {
    const to = new THREE.Vector3(t.x, t.y, t.z);
    const range = from.distanceTo(to);
    dir.copy(to).sub(from).normalize();
    const hit = physics.raycast(from, dir, range + 1.0, COLLISION_LAYER.WORLD);
    assert.ok(hit, `nothing at all was hit shooting at ${t.id} from the mark`);
    const d = hit.distance;
    /* The FIRST thing the ray meets must be this plate: its near face, which
     * is `hz` in front of its centre. Anything closer is an obstruction, and
     * an obstruction is a target that cannot be shot from the place the game
     * makes you stand. */
    assert.ok(d >= range - t.hz - 0.08 && d <= range + 0.08,
      `${t.id}: the first solid on the line is at ${d.toFixed(3)} m, and the plate is at ${range.toFixed(3)} m — something is in the way`);
    report.push(`${t.id} ${range.toFixed(1)}m`);
  }
  assert.equal(report.length, v.config.targets.length);
});

test('the ranks are ordered by distance and the plates shrink as they recede', async () => {
  const v = await venue();
  const m = v.config.fireMark;
  const byRank = new Map();
  for (const t of v.config.targets) {
    const d = Math.hypot(t.x - m.x, t.z - m.z);
    const r = byRank.get(t.rank) ?? { d: 0, half: 0, n: 0 };
    byRank.set(t.rank, { d: Math.max(r.d, d), half: Math.max(r.half, t.hx), n: r.n + 1 });
  }
  const ranks = [...byRank.keys()].sort((a, b) => a - b);
  assert.ok(ranks.length >= 3, `${ranks.length} ranks is not three difficulty rows`);
  for (let i = 1; i < ranks.length; i++) {
    const a = byRank.get(ranks[i - 1]);
    const b = byRank.get(ranks[i]);
    assert.ok(b.d > a.d, `rank ${ranks[i]} is not further out than rank ${ranks[i - 1]}`);
    assert.ok(b.half < a.half,
      `rank ${ranks[i]} is further out and NOT smaller (${b.half} vs ${a.half}) — the ranks are a distance, not a difficulty`);
  }
  for (const r of ranks) assert.equal(byRank.get(r).n, 2, `rank ${r} does not hold two plates`);
});

/* ================================================================== */
/* 4. The range does not seal the trench                               */
/* ================================================================== */

test('a body can still walk the trench past every rank — the plates leave a real lane', async () => {
  const { physics } = await built();
  const v = await venue();
  /* `CONFIG.player.radius`. A lane narrower than twice this is a wall with a
   * gap in it that nobody fits through. */
  const R = 0.35;
  const FLOOR = 1.9;

  const worst = { z: null, lane: Infinity };
  for (const t of v.config.targets) {
    // Sweep the slot at this rank's Z and find the widest run of clear x.
    let best = 0;
    let run = 0;
    for (let x = -PLAN.TRENCH_HW; x <= PLAN.TRENCH_HW + 1e-9; x += 0.02) {
      // Clear when a standing capsule's column has floor-to-ceiling room here.
      const down = physics.raycast(
        new THREE.Vector3(x, PLAN.TRENCH_Y + 1.0, t.z),
        new THREE.Vector3(0, -1, 0), 3.0, COLLISION_LAYER.WORLD);
      const up = physics.raycast(
        new THREE.Vector3(x, PLAN.TRENCH_Y + 0.05, t.z),
        new THREE.Vector3(0, 1, 0), 4.0, COLLISION_LAYER.WORLD);
      const head = up ? up.distance : Infinity;
      if (down && head >= FLOOR) { run += 0.02; best = Math.max(best, run); } else run = 0;
    }
    if (best < worst.lane) { worst.lane = best; worst.z = t.z; }
  }
  assert.ok(worst.lane >= 2 * R,
    `the narrowest lane through the butts is ${worst.lane.toFixed(2)} m at z ${worst.z}, and the capsule is ${(2 * R).toFixed(2)} m across`);
  /* The floor, quoted. A lane that has drifted from 1.58 to 0.71 is still a
   * pass on the line above and is a corridor nobody would ever walk down. */
  assert.ok(worst.lane >= 1.2,
    `lane floor 1.20 m, achieved ${worst.lane.toFixed(2)} m — the trench is the route to bay-n and the -58 stash`);
});

/* ================================================================== */
/* 5. Scoring                                                          */
/* ================================================================== */

test('a resolved world hit on the armed rank knocks a plate down; one 1 m wide does not', async () => {
  const v = await venue();
  const { game, bus } = running(v);
  assert.equal(game.down, 0);

  const near = centreOf(v, 'near-port');
  bus.fire('weapon:hit', { point: { ...near, x: near.x + 1.0 }, isNPC: false });
  assert.equal(game.down, 0, 'a hit a metre off the plate scored');

  bus.fire('weapon:hit', { point: near, isNPC: false });
  assert.equal(game.down, 1, 'a hit dead centre of an armed plate did not score');
  game.dispose();
});

test('a hit on an UNARMED rank scores nothing — the sequence is the contest', async () => {
  const v = await venue();
  const { game, bus } = running(v);
  bus.fire('weapon:hit', { point: centreOf(v, 'far-stbd'), isNPC: false });
  bus.fire('weapon:hit', { point: centreOf(v, 'mid-port'), isNPC: false });
  assert.equal(game.down, 0, 'plates behind the armed rank scored while rank 0 was still up');
  assert.equal(game.rank, 0);
  game.dispose();
});

test('clearing a rank arms the next one, and only then do its plates count', async () => {
  const v = await venue();
  const { game, bus } = running(v);
  bus.fire('weapon:hit', { point: centreOf(v, 'near-port'), isNPC: false });
  bus.fire('weapon:hit', { point: centreOf(v, 'near-stbd'), isNPC: false });
  assert.equal(game.rank, 1, 'the rank did not advance when both near plates went down');
  bus.fire('weapon:hit', { point: centreOf(v, 'mid-port'), isNPC: false });
  assert.equal(game.down, 3);
  game.dispose();
});

test('a hit on a BODY never scores, even standing on a plate', async () => {
  const v = await venue();
  const { game, bus } = running(v);
  const p = centreOf(v, 'near-port');
  bus.fire('weapon:hit', { point: p, isNPC: true });
  bus.fire('projectile:hit', { point: p, npc: { id: 'someone' } });
  assert.equal(game.down, 0, 'a round that hit a person was scored as a plate');
  bus.fire('projectile:hit', { point: p, npc: null });
  assert.equal(game.down, 1, 'an arrow into the plate did not score');
  game.dispose();
});

test('all six plates down is a win; the clock running out is a loss, and both name the count', async () => {
  const v = await venue();
  const { game, bus } = running(v);
  assert.equal(game.fixedUpdate(0.016, 1), null, 'the contest ended before a plate moved');

  for (const id of ['near-port', 'near-stbd', 'mid-port', 'mid-stbd', 'far-port']) {
    bus.fire('weapon:hit', { point: centreOf(v, id), isNPC: false });
  }
  assert.equal(game.fixedUpdate(0.016, 2), null, 'five of six plates ended the contest');
  bus.fire('weapon:hit', { point: centreOf(v, 'far-stbd'), isNPC: false });
  const won = game.fixedUpdate(0.016, 3);
  assert.ok(won && won.won === true, 'six of six did not win');
  assert.equal(won.score, 6);
  game.dispose();

  const b = running(v);
  b.bus.fire('weapon:hit', { point: centreOf(v, 'near-port'), isNPC: false });
  const lost = b.game.fixedUpdate(0.016, v.config.seconds + 0.1);
  assert.ok(lost && lost.won === false, 'the clock ran out and the contest did not end');
  assert.equal(lost.score, 1, 'a loss must still carry what was hit');
  b.game.dispose();
});

test('nothing scores before begin() or after dispose() — the countdown and the teardown are both real', async () => {
  const v = await venue();
  const bus = fakeBus();
  const game = new TestFire(v, { bus, player: onTheMark(v) });
  // Constructed, counting down, NOT begun.
  bus.fire('weapon:hit', { point: centreOf(v, 'near-port'), isNPC: false });
  assert.equal(game.down, 0, 'a round fired during the countdown put a plate down');

  game.begin(0);
  assert.ok(bus.count('weapon:hit') >= 1, 'begin() subscribed to nothing');
  bus.fire('weapon:hit', { point: centreOf(v, 'near-port'), isNPC: false });
  assert.equal(game.down, 1);

  game.dispose();
  assert.equal(bus.count('weapon:hit'), 0, 'dispose() left a live subscription on the bus');
  bus.fire('weapon:hit', { point: centreOf(v, 'near-stbd'), isNPC: false });
  assert.equal(game.down, 1, 'a disposed contest went on scoring');
});

/* ================================================================== */
/* 6. The cell rack is the entry fee, and it is charged in order       */
/* ================================================================== */

test('the butts burn laser cells, refuse without them, and never charge for a run that does not start', async () => {
  const v = await venue();
  const cost = v.config.cells;
  assert.ok(cost > 0, 'the venue names no cell cost, so the only sink laser_cell has in this drop is gone');

  // Short bag: refused, and not a cell taken.
  const poor = fakeBag(cost - 1);
  const busA = fakeBus();
  assert.equal(createTestFire(v, { bus: busA, player: onTheMark(v), inventory: poor }), null);
  assert.equal(poor.cells, cost - 1, 'a refused run still charged for the rack');
  assert.ok(busA.seen.some((e) => e.name === 'hud:notify' && /cell/i.test(e.payload.text)),
    'a refusal for want of cells said nothing about cells');

  // Off the mark: refused BEFORE the cells are read, so standing in the wrong
  // place can never cost a rack.
  const rich = fakeBag(cost + 100);
  const far = { position: { x: 0, y: PLAN.TRENCH_Y, z: v.config.fireMark.z + 40 } };
  assert.equal(createTestFire(v, { bus: fakeBus(), player: far, inventory: rich }), null);
  assert.equal(rich.cells, cost + 100, 'walking up to the far end of the range cost a rack');

  // On the mark with cells: built, and charged exactly once.
  const game = createTestFire(v, { bus: fakeBus(), player: onTheMark(v), inventory: rich });
  assert.ok(game instanceof TestFire);
  assert.equal(rich.cells, cost + 100 - cost, `the run charged ${cost + 100 - rich.cells} cells against a published ${cost}`);
  game.dispose();
});

/* ================================================================== */
/* 7. A malformed venue is inert, never a thrown contest               */
/* ================================================================== */

test('a venue with no usable plates yields no contest and no exception', () => {
  assert.equal(readTargets({ config: { targets: [] } }), null);
  assert.equal(readTargets({ config: {} }), null);
  assert.equal(readTargets(null), null);
  // A plate with a zero extent is not a target you can hit; it is a point.
  assert.equal(readTargets({ config: { targets: [{ x: 0, y: 0, z: 0, hx: 0, hy: 1, hz: 1 }] } }), null);
  assert.equal(createTestFire({ id: 'x', label: 'x', config: { targets: null } }, {}), null);
});

test('the reward and the clock are the world plan\'s numbers, not the module\'s defaults', async () => {
  const v = await venue();
  assert.equal(v.reward, PLAN.BUTTS_REWARD);
  assert.equal(v.config.seconds, PLAN.BUTTS_SECONDS);
  assert.equal(v.config.cells, PLAN.BUTTS_CELL_COST);
  /* Four counts of `survive` is two minutes in this world's other quests; a
   * range that allowed as long would not be a contest. And it must be long
   * enough to walk 26 m and fire six aimed rounds. */
  assert.ok(v.config.seconds >= 30 && v.config.seconds <= 90,
    `${v.config.seconds} s is outside the band a six-plate course is a contest in`);
});
