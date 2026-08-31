import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { build } from 'esbuild';

import { Physics } from '../../src/physics/Physics.js';
import { Stamina } from '../../src/systems/Stamina.js';
import { ItemUseSystem } from '../../src/systems/ItemUse.js';
import { ActiveEffects, EFFECT_KINDS } from '../../src/systems/ActiveEffects.js';
import { Marketplace } from '../../src/systems/Marketplace.js';
import { OFFLINE_BASE_ITEMS, offlineCatalog } from '../../src/systems/MarketplaceOffline.js';
import { ITEMS, SELL_RATE, isItem, itemDef, itemIconSVG, KIND_ACCENT } from '../../src/systems/ItemDefs.js';
import { SpaceCombat, SHIELD_CELL_CHARGE, SHIELD_FLOOR, SHIELD_PER_TIER, SHIELD_DELAY }
  from '../../src/ships/SpaceCombat.js';
import { CONFIG } from '../../src/core/Config.js';

/**
 * THREE CONSUMABLE FAMILIES, AND THE THINGS THAT MAKE THEM REAL RATHER THAN
 * DECLARED.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT WAS MISSING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three holes, each one a system the game already had and a shelf that said
 * nothing about it:
 *
 *   STAMINA had NOTHING TO BUY. Health has medkits, all four weapons have
 *   ammunition, the bag has three expansion rigs - and the pool that gates the
 *   sprint, both climbs, the mantle, the leap, the swim and the eagle's
 *   wingbeat was the one player resource with no row anywhere in the
 *   catalogue. Four `stamina_slowdown_*` action ids had sat in
 *   `MarketplaceActionId` since it was written, pointing at nothing.
 *
 *   SPACE had ONE consumable and it was a gun. The ship's shield absorbs every
 *   hit before the hull does and structurally cannot recover during a fight -
 *   `_playerHit` zeroes `_shieldIdle` on every hit and `_regen` waits
 *   `SHIELD_DELAY` seconds of quiet an engagement never gives. A pilot could
 *   buy width and could not buy survival.
 *
 *   DEFENCE had ONE ROW against four tiers of offence, four of mobility and
 *   four of crowd control - `shield_5s`, five seconds of TOTAL immunity. There
 *   was nothing between nothing and invulnerable.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT THIS FILE IS FOR, WHICH IS NOT "THE ITEMS EXIST"
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This repository's recorded failure mode is a thing that was BUILT and cannot
 * be REACHED, and its second is a unit destroyed for nothing. So the cases
 * below are about the mechanism and the refusals, in that order:
 *
 *   1. THE FUNNEL. A draught really scales the pool at `Stamina.drain`, the one
 *      place every exertion in the game reaches it through - driven through the
 *      real methods with the real `CONFIG` costs, not asserted off a field.
 *   2. THE CLOCK. Every deadline is `engine.simElapsed`, so a buff does not
 *      drain while the sheet it was used from is open.
 *   3. THE DAMAGE. A ward really reduces what `Player.applyDamage` takes off
 *      the pool, and a respawn really clears it - which is the entry the
 *      `ENDED_BY_RESPAWN` list is required to be honest about.
 *   4. THE REFUSALS. Every one of them is asked BEFORE `consumeFromBag`, so a
 *      refused item is KEPT. Each case checks the bag as well as the answer.
 *   5. THE SHELF. A catalogue row, a registered action, an offline mirror and a
 *      grant that resolves through the real `Marketplace._purchaseGrant` - the
 *      step whose recorded failure is a row that looks perfect and a purchase
 *      that returns `unsupported`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  MUTATION RECORD: 11 of 11 red
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Each edit was made to the thing under test, the file re-run, and the edit
 * reverted. Nothing here passes because the code merely exists.
 *
 *   1. `drain`: `amount * this._drainScale` -> `amount`
 *      (the funnel stops scaling)                          -> 3 cases red
 *   2. `spend`: affordability against the RAW cost          -> 1 case red
 *   3. `drain`: `!(want > 0)` -> `!(want >= 0)`
 *      (a zero scale marks the pool drained again)          -> 1 case red
 *   4. `applyDamage`: the ward term made unreachable        -> 3 cases red
 *   5. `respawn`: the two `_ward*` lines deleted            -> 1 case red
 *   6. `grantWard`: `Math.max(WARD_MUL_MIN, ...)` dropped   -> 1 case red
 *   7. `canChargeShield`: the `shield < shieldMax` term cut -> 1 case red
 *   8. `chargeShield`: `_shieldIdle = SHIELD_DELAY` deleted -> 1 case red
 *   9. `_canApply` 'ward': the `!isDead` term dropped       -> 1 case red
 *  10. `_canApply` 'stamina': the `!isDead` term dropped    -> 1 case red
 *  11. `_effectFor`: the top draught given 30 s not 15      -> 2 cases red
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFile(path.join(root, rel), 'utf8');

/**
 * The one renderer-bound thing `Player` builds is `Weapon`, whose viewmodel
 * textures are painted on a 2D canvas and thrown away headless. The same
 * concession `player-speed.test.mjs` and `player-slope.test.mjs` make, for the
 * same reason: it takes no part in `applyDamage`, which is the only thing the
 * ward cases here drive.
 */
function shimCanvas() {
  if (globalThis.document?.createElement) return;
  const noop = () => {};
  const ctx2d = () => ({
    createImageData: (a, b) => ({
      data: new Uint8ClampedArray((a | 0) * ((b ?? a) | 0) * 4), width: a | 0, height: (b ?? a) | 0,
    }),
    getImageData: (x, y, a, b) => ({
      data: new Uint8ClampedArray((a | 0) * (b | 0) * 4), width: a | 0, height: b | 0,
    }),
    putImageData: noop, fillRect: noop, clearRect: noop, beginPath: noop, closePath: noop,
    arc: noop, moveTo: noop, lineTo: noop, fill: noop, stroke: noop, save: noop,
    restore: noop, rotate: noop, translate: noop, scale: noop, drawImage: noop,
    setTransform: noop, fillText: noop, strokeText: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    measureText: () => ({ width: 0 }),
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalCompositeOperation: '',
    globalAlpha: 1, font: '', textAlign: '', textBaseline: '',
  });
  const existing = globalThis.document ?? {};
  globalThis.document = {
    hidden: false, getElementById: () => null, querySelector: () => null,
    ...existing,
    createElement: (tag) => {
      if (tag !== 'canvas') return {};
      const c = { width: 1, height: 1, style: {}, tagName: 'CANVAS' };
      c.getContext = ctx2d;
      return c;
    },
  };
}
shimCanvas();
const { Player } = await import('../../src/player/Player.js');

/** The four draughts, weakest first. The order is load-bearing in section 5. */
const DRAUGHTS = ['stamina_draught_25', 'stamina_draught_50', 'stamina_draught_75', 'stamina_draught_100'];
/** The three wards, weakest first. Same. */
const WARDS = ['ward_20', 'ward_35', 'ward_50'];
/** The catalogue keys the draughts are sold under. NOT the item ids - see below. */
const DRAUGHT_KEYS = ['stamina_slowdown_25', 'stamina_slowdown_50', 'stamina_slowdown_75', 'stamina_slowdown_100'];

/* The catalogue is TypeScript in the site and cannot be imported directly; the
 * house pattern for reaching it from a test is esbuild, exactly as
 * `bag-expansion.test.mjs` and `mount-catalog.test.mjs` do. Memoised - the
 * bundle is the slow part. */
let catalogPromise = null;
function loadCatalog() {
  if (!catalogPromise) {
    catalogPromise = build({
      entryPoints: [path.join(root, 'site/lib/marketplaceCatalog.ts')],
      bundle: true, write: false, format: 'esm', platform: 'node', target: 'node22', logLevel: 'silent',
      resolveExtensions: ['.ts', '.js'],
    }).then((r) => import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`));
  }
  return catalogPromise;
}

/**
 * A bus that records AND really dispatches.
 *
 * The dispatch half is not decoration: `ActiveEffects` subscribes to
 * `player:respawned` in its constructor, and a stub whose `on` throws the
 * handler away would make the respawn case below pass no matter what
 * `ENDED_BY_RESPAWN` said - a vacuous assertion, which this repository has
 * shipped before and written down.
 */
function fakeBus() {
  const handlers = new Map();
  const events = [];
  return {
    events,
    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(fn);
      return () => handlers.get(type)?.delete(fn);
    },
    emit(type, payload) {
      events.push({ type, payload });
      for (const fn of [...(handlers.get(type) ?? [])]) fn(payload);
    },
    of(type) { return events.filter((e) => e.type === type); },
    lastToast() {
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].type === 'hud:notify') return events[i].payload?.text ?? null;
      }
      return null;
    },
  };
}

/** A bag that counts what it hands out, so "consumed exactly once" is checkable. */
function fakeBag(stock = {}) {
  const bag = new Map(Object.entries(stock));
  return {
    takes: [],
    bagCount(id) { return bag.get(id) ?? 0; },
    consumeFromBag(id, n) {
      const have = bag.get(id) ?? 0;
      if (have < n) return false;
      bag.set(id, have - n);
      this.takes.push([id, n]);
      return true;
    },
  };
}

/** A `SpaceCombat` with no world under it. Enough for the pool and the guards. */
function bareCombat({ engine = { simElapsed: 0 }, flying = true, tierShield = 0 } = {}) {
  const combat = new SpaceCombat({
    scene: null,
    camera: null,
    bus: null,
    input: null,
    player: null,
    worldManager: { active: flying ? { id: 'space' } : null },
    piloting: flying
      ? { active: true, landed: false, _travelling: false, shipId: 'kestrel' }
      : { active: false, landed: true, _travelling: false, shipId: null },
    engine,
  });
  /* `tiers()` reads the ship registry, which is not wired here. The pool size
   * is the only thing that reads it and it is exactly what these cases want to
   * vary, so it is stubbed rather than a whole registry being stood up. */
  combat.tiers = () => ({ shield: tierShield });
  combat.shieldMax = Math.max(SHIELD_FLOOR, SHIELD_PER_TIER * tierShield);
  combat.shield = combat.shieldMax;
  return combat;
}

/* ====================================================================== */
/* 1. Stamina: the funnel                                                 */
/* ====================================================================== */

test('a draught scales the pool at drain(), the one place every exertion reaches it', () => {
  /* THE CLAIM THIS FILE EXISTS TO MAKE. `Stamina.drain` was chosen as the
   * single application point because eight callers across six files reach the
   * pool through it or through `spend`, which calls it. Driving `drain`
   * directly with the REAL sprint cost is what makes "the funnel scales" a
   * measurement rather than a reading of a field. */
  const stam = new Stamina({ bus: null, engine: { simElapsed: 0 } });
  const cost = CONFIG.player.sprintStaminaDrain;

  assert.equal(stam.drainScale, 1, 'a fresh pool is not at the stock rate');
  assert.equal(stam.drain(cost, 'sprint'), cost, 'the unmodified drain is not the cost');

  stam.reset();
  assert.equal(stam.setDrainScale(0.25, 30), true);
  assert.equal(stam.drainScale, 0.25);
  assert.equal(stam.drain(cost, 'sprint'), cost * 0.25,
    'the draught did not reach the funnel - a sprint still cost full price');
  assert.equal(stam.value, stam.max - cost * 0.25);
});

test('spend() measures affordability against the SCALED cost, or the funnel leaks', () => {
  /* THE BUG THIS CASE IS HERE TO STOP. `spend` is the atomic path a mantle and
   * a leap take, and it refuses when the pool cannot cover the cost. Testing
   * the RAW cost there while `drain` charged the scaled one would have meant
   * that under a draught pausing the drain outright, a sprint cost nothing and
   * a mantle at 10 stamina was still refused - two code paths disagreeing about
   * one item, which the player reads as the item being broken. */
  const climb = CONFIG.player.climbStaminaCost;
  const stam = new Stamina({ bus: null, engine: { simElapsed: 0 } });

  // Unmodified: a pool below the cost refuses, and takes nothing.
  stam.drain(stam.max - (climb - 1));
  assert.equal(stam.value, climb - 1);
  assert.equal(stam.spend(climb, 'climb'), false, 'an unaffordable mantle was paid for');
  assert.equal(stam.value, climb - 1, 'a refused mantle still took stamina');

  // With the drain paused, the same pool affords it and pays nothing.
  assert.equal(stam.setDrainScale(0, 15), true);
  assert.equal(stam.spend(climb, 'climb'), true,
    'the drain was paused and a mantle was still refused for want of stamina');
  assert.equal(stam.value, climb - 1, 'a paused drain still charged for the mantle');
});

test('a scale of zero is no drain at all, so the pool refills under a sprint', () => {
  /* NOT A SUBTLETY - IT IS THE DIFFERENCE BETWEEN THE ITEM AND ITS OPPOSITE.
   * `_lastDrainAt` suppresses regeneration for `staminaRegenDelay` seconds. If
   * `drain` wrote it on a scaled cost of zero, a player holding Shift under the
   * top draught would be pinned at whatever the pool held when they drank it -
   * never losing, never recovering. "Stamina drain off" would have meant "the
   * pool is frozen", which is not what the shop says. */
  const stam = new Stamina({ bus: null, engine: { simElapsed: 0 } });
  const cost = CONFIG.player.sprintStaminaDrain;
  stam.drain(60);
  const low = stam.value;
  assert.ok(low < stam.max);

  stam.setDrainScale(0, 15);
  // Sprint for two seconds of fixed steps while the pool is meant to recover.
  let t = 0;
  for (let i = 0; i < 120; i++) {
    stam.drain(cost * (1 / 60), 'sprint');
    t += 1 / 60;
    stam.fixedUpdate(1 / 60, t);
  }
  assert.ok(stam.value > low,
    `the pool sat at ${stam.value.toFixed(1)} through two seconds of free sprinting - `
    + 'a scaled cost of zero is still marking the pool as drained');
});

test('a draught expires on the play clock and not on wall time', () => {
  /* The inventory sheet a draught is drunk FROM raises `inventory:open`, which
   * blocks gameplay, which stops `simElapsed`. `fixedUpdate` is handed
   * `engine.elapsed`, which does NOT stop - so a deadline read off its
   * argument would burn part of the player's thirty seconds while they were
   * still looking at the bag, and the HUD chip (which counts on `simElapsed`)
   * would disagree with it on screen. */
  const engine = { simElapsed: 100 };
  const stam = new Stamina({ bus: null, engine });
  assert.equal(stam.setDrainScale(0.5, 30), true);

  // Thirty seconds of real frames with gameplay blocked: `elapsed` runs on.
  let wall = 0;
  for (let i = 0; i < 1800; i++) { wall += 1 / 60; stam.fixedUpdate(1 / 60, wall); }
  assert.equal(stam.drainScale, 0.5, 'the draught expired while the game was paused');

  engine.simElapsed = 129.9;
  stam.fixedUpdate(1 / 60, wall += 1 / 60);
  assert.equal(stam.drainScale, 0.5, 'the draught ended a tenth of a second early');

  engine.simElapsed = 130;
  stam.fixedUpdate(1 / 60, wall += 1 / 60);
  assert.equal(stam.drainScale, 1, 'the draught never ended');
});

test('a second draught extends the window and keeps the better rate', () => {
  /* `boostSpeed` read for a number where SMALLER is stronger, and the reason it
   * matters to a player: a weak draught drunk under a strong one must not
   * DOWNGRADE them. It buys time at the strong rate, which is more than it
   * promised. `ActiveEffects.start` draws one chip over the pair for the same
   * reason - one entry per kind, deadline forward only. */
  const engine = { simElapsed: 0 };
  const stam = new Stamina({ bus: null, engine });

  stam.setDrainScale(0.25, 30);
  engine.simElapsed = 10;
  stam.setDrainScale(0.75, 30);
  assert.equal(stam.drainScale, 0.25, 'a weaker draught downgraded a running one');

  engine.simElapsed = 39.9;
  stam.fixedUpdate(1 / 60, 39.9);
  assert.equal(stam.drainScale, 0.25, 'the second draught did not extend the window');
  engine.simElapsed = 40;
  stam.fixedUpdate(1 / 60, 40);
  assert.equal(stam.drainScale, 1);
});

test('setDrainScale refuses everything that is not an effect', () => {
  const stam = new Stamina({ bus: null, engine: { simElapsed: 0 } });
  for (const bad of [0, -5, NaN, Infinity, null, undefined, '30']) {
    assert.equal(stam.setDrainScale(0.5, bad), false, `a duration of ${String(bad)} was accepted`);
  }
  /* 1 is the STOCK rate - an "effect" that grants what the player already has -
   * and anything above it would sell a PENALTY through a path only ever reached
   * by an item somebody paid for. */
  for (const bad of [1, 1.5, -0.1, NaN, 'half', null]) {
    assert.equal(stam.setDrainScale(bad, 30), false, `a scale of ${String(bad)} was accepted`);
  }
  assert.equal(stam.drainScale, 1);
});

test('a respawn refills the pool and does NOT cancel the draught', () => {
  /* The asymmetry with the ward, asserted at the owning system rather than
   * inferred from the ledger's list. `Stamina.reset()` is wired to
   * `player:respawned` and writes the POOL; the draught is a purchased
   * modifier dated on the play clock and dying does not make the thirty seconds
   * stop being thirty seconds. `ENDED_BY_RESPAWN` omits `stamina` BECAUSE of
   * this line, which is the rule that list is written under. */
  const stam = new Stamina({ bus: null, engine: { simElapsed: 0 } });
  stam.setDrainScale(0.5, 30);
  stam.drain(70);
  assert.ok(stam.value < stam.max);

  stam.reset();
  assert.equal(stam.value, stam.max, 'a respawn left the player gasping');
  assert.equal(stam.drainScale, 0.5, 'a respawn cancelled a draught the player paid for');
});

/* ====================================================================== */
/* 2. Stamina: the item                                                   */
/* ====================================================================== */

/** A real `Stamina`, a real `ItemUseSystem`, and a bag that counts. */
function draughtRig({ stock = {}, dead = false, stamina = undefined } = {}) {
  const bus = fakeBus();
  const engine = { simElapsed: 0 };
  const pool = stamina === undefined ? new Stamina({ bus: null, engine }) : stamina;
  const inventory = fakeBag(stock);
  const player = { health: 100, maxHealth: 100, isDead: dead };
  const effects = new ActiveEffects({ bus, engine });
  const itemUse = new ItemUseSystem({ bus, player, inventory, effects, stamina: pool });
  return { bus, engine, pool, inventory, itemUse, effects };
}

test('each draught applies its own rate and window, and consumes exactly one', () => {
  /* One row per draught, so a rung that grows a new number and forgets the
   * effect switch fails here rather than shipping a shop that charges for a
   * strength it does not grant. */
  const cases = [
    ['stamina_draught_25', 0.75, 30],
    ['stamina_draught_50', 0.5, 30],
    ['stamina_draught_75', 0.25, 30],
    ['stamina_draught_100', 0, 15],
  ];
  for (const [itemId, scale, duration] of cases) {
    const r = draughtRig({ stock: { [itemId]: 2 } });
    const res = r.itemUse.use(itemId);
    assert.equal(res.ok, true, `${itemId} was refused: ${res.reason}`);
    assert.equal(r.pool.drainScale, scale, `${itemId} applied a rate of ${r.pool.drainScale}`);
    assert.deepEqual(r.inventory.takes, [[itemId, 1]], `${itemId} consumed ${r.inventory.takes.length} units`);
    assert.equal(r.inventory.bagCount(itemId), 1);

    // ..and one chip, of the right kind, counting the right number of seconds.
    const started = r.bus.of('effect:started');
    assert.equal(started.length, 1, `${itemId} raised ${started.length} chips`);
    assert.equal(started[0].payload.kind, 'stamina');
    assert.equal(started[0].payload.endsAt, duration, `${itemId} counts down from ${started[0].payload.endsAt}s`);
    assert.equal(started[0].payload.label, ITEMS[itemId].name, 'the chip does not name the item used');
  }
});

test('the top draught runs half the window of the rungs below it, and that is deliberate', () => {
  /* PINNED AS A NUMBER because it is the one balance decision in this family
   * that a later tidy-up would find irresistible: three rungs at 30 and one at
   * 15 looks like an oversight and is not. x0 does not make exertion cheaper,
   * it removes the resource - and the game's only other total-negation
   * consumable, the Aegis Shard, is priced in seconds for exactly that reason
   * (five, against the thirty every graded effect gets).
   *
   * The 15 is derived: the pool is `maxStamina` and a sprint drains
   * `sprintStaminaDrain` a second, so one full pool is 6.67 s of unbroken
   * sprint and the window is two of them. Re-derived here rather than typed, so
   * a config re-tune that invalidates the derivation shows up. */
  const sys = new ItemUseSystem({});
  const top = sys._effectFor('stamina_draught_100');
  assert.equal(top.scale, 0);
  const onePool = CONFIG.player.maxStamina / CONFIG.player.sprintStaminaDrain;
  assert.ok(Math.abs(top.duration - 2 * onePool) < 2,
    `the top draught runs ${top.duration}s against two full pools of sprint at `
    + `${(2 * onePool).toFixed(1)}s - the derivation in ItemUse no longer describes the number`);
  for (const id of DRAUGHTS.slice(0, 3)) {
    assert.equal(sys._effectFor(id).duration, 30,
      `${id} does not run the thirty seconds every other timed rung in the switch runs`);
  }
});

test('a draught used over your own corpse is refused and KEPT', () => {
  /* The medkit's recorded defect, in a new family. A corpse can open the bag -
   * `gameplayBlocked` skips `player.fixedUpdate`, so the respawn tick never
   * runs while a panel is up - and a body exerts nothing, so every second of
   * the window would be spent on nobody. The guard is asked BEFORE
   * `consumeFromBag`, which is the only reason the unit survives. */
  const r = draughtRig({ stock: { stamina_draught_50: 1 }, dead: true });
  const res = r.itemUse.use('stamina_draught_50');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'dead', 'the refusal has no reason code of its own, so main.js stacks a second toast');
  assert.equal(r.inventory.bagCount('stamina_draught_50'), 1, 'a refused draught was consumed anyway');
  assert.equal(r.pool.drainScale, 1);
  assert.match(r.bus.lastToast() ?? '', /Kept, not spent/, 'the player was not told they still have it');
  assert.equal(r.bus.of('effect:started').length, 0, 'a refused use put a countdown on the HUD');
});

test('an unwired pool refuses the use rather than eating the draught', () => {
  const bus = fakeBus();
  const inventory = fakeBag({ stamina_draught_25: 1 });
  const itemUse = new ItemUseSystem({ bus, player: { isDead: false }, inventory });
  const res = itemUse.use('stamina_draught_25');
  assert.equal(res.ok, false);
  assert.equal(inventory.bagCount('stamina_draught_25'), 1, 'an unwired Stamina ate the draught');
});

/* ====================================================================== */
/* 3. The ward                                                            */
/* ====================================================================== */

/** A real `Player` on a flat deck. `applyDamage` and `respawn` both need one. */
function makePlayer(engine = { simElapsed: 0 }) {
  const physics = new Physics();
  const deck = new THREE.Mesh(new THREE.BoxGeometry(400, 2, 400));
  deck.position.set(0, -1, 0);
  deck.updateWorldMatrix(true, false);
  physics.addBoxFromObject(deck);
  return new Player({
    scene: new THREE.Scene(),
    engine,
    physics,
    bus: { on: () => () => {}, emit() {} },
    materials: {},
    input: { state: {} },
    camera: new THREE.PerspectiveCamera(),
  });
}

test('a ward really reduces what applyDamage takes off the pool', () => {
  /* MEASURED THROUGH THE REAL `applyDamage`, not asserted off `_wardMul`. The
   * whole family is one multiplicative term in one method, and a term that is
   * present in the file and not in the arithmetic is this project's signature
   * defect - the thing that was built and cannot be reached. */
  const engine = { simElapsed: 0 };
  const player = makePlayer(engine);
  const full = player.health;

  assert.equal(player.applyDamage(40), 40, 'the unwarded baseline is not the damage dealt');
  player.heal(100);
  assert.equal(player.health, full);

  assert.equal(player.grantWard(0.5, 30), true);
  assert.equal(player.wardMultiplier, 0.5);
  assert.equal(player.applyDamage(40), 20, 'a half ward did not halve the damage');
  assert.equal(player.health, full - 20);
});

test('a ward expires on the play clock, and the last instant of it still counts', () => {
  const engine = { simElapsed: 100 };
  const player = makePlayer(engine);
  player.grantWard(0.5, 30);

  engine.simElapsed = 129.99;
  assert.equal(player.applyDamage(40), 20, 'the ward stopped a hundredth of a second early');
  player.heal(100);

  engine.simElapsed = 130;
  assert.equal(player.applyDamage(40), 40, 'the ward never ended');
});

test('a second ward extends the window and keeps the better rate', () => {
  const engine = { simElapsed: 0 };
  const player = makePlayer(engine);
  player.grantWard(0.5, 30);
  engine.simElapsed = 10;
  player.grantWard(0.8, 30);
  assert.equal(player.wardMultiplier, 0.5, 'a weaker ward downgraded a running one');

  engine.simElapsed = 39.99;
  assert.equal(player.wardMultiplier, 0.5, 'the second ward did not extend the window');
  engine.simElapsed = 40;
  assert.equal(player.wardMultiplier, 1);
});

test('a ward cannot reach immunity, whatever it is handed', async () => {
  /* `WARD_MUL_MIN` is a floor and not a documented convention because
   * `applyDamage` multiplies a ward in BESIDE the mount Armour term. Two
   * independently-bought reductions compounding is intended; two compounding to
   * zero would be `shield_5s` sold by accident, for six times as long, at a
   * lower price. The clamp is in `grantWard` so a save, a cheat or a
   * mis-authored catalogue row cannot walk past it. */
  const src = await read('src/player/Player.js');
  const floor = Number(/const WARD_MUL_MIN = ([\d.]+);/.exec(src)?.[1]);
  assert.ok(floor > 0 && floor < 1, 'WARD_MUL_MIN has been renamed or removed');

  const player = makePlayer();
  assert.equal(player.grantWard(0, 30), true, 'a zero ward was refused rather than clamped');
  assert.equal(player.wardMultiplier, floor, 'a zero ward was granted as total immunity');
  assert.ok(player.applyDamage(100) > 0, 'a ward made the player untouchable');

  // ..and the values above 1 are not effects at all.
  const p2 = makePlayer();
  for (const bad of [1, 1.5, -1, NaN, 'half', null, undefined]) {
    assert.equal(p2.grantWard(bad, 30), false, `a multiplier of ${String(bad)} was accepted`);
  }
  for (const bad of [0, -5, NaN, Infinity, null, '30']) {
    assert.equal(p2.grantWard(0.5, bad), false, `a duration of ${String(bad)} was accepted`);
  }
  assert.equal(p2.wardMultiplier, 1);
});

test('a respawn clears the ward, which is why `ward` is on ENDED_BY_RESPAWN', () => {
  /* THE HALF THE LEDGER CANNOT SEE. `ActiveEffects.ENDED_BY_RESPAWN` is
   * required to name exactly what `Player.respawn` clears, and a list that
   * merely looks right is how a chip starts counting down over a multiplier
   * that went back to 1 three seconds ago. So the claim is checked at the
   * OWNING SYSTEM, and the list is checked against it. */
  const engine = { simElapsed: 0 };
  const player = makePlayer(engine);
  player.grantWard(0.5, 30);
  assert.equal(player.wardMultiplier, 0.5);

  player.respawn();
  assert.equal(player.wardMultiplier, 1, 'a corpse got up under half damage the player paid for');

  // The spawn grace is invulnerability, so step past it before measuring.
  engine.simElapsed = 60;
  assert.equal(player.applyDamage(40), 40, 'the ward outlived the body that bought it');

  assert.ok('ward' in EFFECT_KINDS, 'the ward has no chip');
  const fx = new ActiveEffects({ bus: fakeBus(), clock: () => 0 });
  fx.start('ward', 30);
  fx.bus.emit('player:respawned', {});
  assert.deepEqual(fx.list(), [], 'the chip survived a respawn that cleared the effect');
});

test('a ward and an Aegis Shard do not conflict, and cannot compound', () => {
  /* THE STACKING QUESTION, ANSWERED BY THE CODE RATHER THAN BY A RULE.
   * `shield_5s` is `grantIFrames`, and `applyDamage` RETURNS 0 before it ever
   * reaches the ward term - so while the shard is up the ward is simply not
   * consulted, and when the shard ends the ward carries on. Nothing needed
   * writing to prevent a compound, because there is no arithmetic in which the
   * two could compound: zero times anything is zero.
   *
   * That is why both may run at once and both get a chip. A player who buys
   * five seconds of immunity and thirty of half damage has bought two different
   * windows, and the interface says so. */
  const engine = { simElapsed: 0 };
  const player = makePlayer(engine);
  player.grantWard(0.5, 30);
  player.grantShield(5);

  assert.equal(player.applyDamage(40), 0, 'the shard did not stop the hit');
  engine.simElapsed = 5;
  assert.equal(player.applyDamage(40), 20, 'the ward did not survive the shard it was used under');
});

/* ====================================================================== */
/* 4. The ward as an item                                                 */
/* ====================================================================== */

function wardRig({ stock = {}, dead = false, player = undefined } = {}) {
  const bus = fakeBus();
  const engine = { simElapsed: 0 };
  const p = player === undefined ? makePlayer(engine) : player;
  if (p && dead) Object.defineProperty(p, 'isDead', { get: () => true, configurable: true });
  const inventory = fakeBag(stock);
  const effects = new ActiveEffects({ bus, engine });
  return { bus, engine, player: p, inventory, effects, itemUse: new ItemUseSystem({ bus, player: p, inventory, effects }) };
}

test('each ward applies its own rate, consumes exactly one, and raises one chip', () => {
  const cases = [['ward_20', 0.8], ['ward_35', 0.65], ['ward_50', 0.5]];
  for (const [itemId, mul] of cases) {
    const r = wardRig({ stock: { [itemId]: 2 } });
    const res = r.itemUse.use(itemId);
    assert.equal(res.ok, true, `${itemId} was refused: ${res.reason}`);
    assert.ok(Math.abs(r.player.wardMultiplier - mul) < 1e-9,
      `${itemId} granted ${r.player.wardMultiplier} rather than ${mul}`);
    assert.deepEqual(r.inventory.takes, [[itemId, 1]]);

    const started = r.bus.of('effect:started');
    assert.equal(started.length, 1, `${itemId} raised ${started.length} chips`);
    assert.equal(started[0].payload.kind, 'ward');
    assert.equal(started[0].payload.endsAt, 30);
    assert.equal(started[0].payload.tag, EFFECT_KINDS.ward.tag);
  }
});

test('the toast reports the RUNNING reduction, not the charm just used', () => {
  /* The bag rigs' discipline, in a buff: `_apply` reads the number back off the
   * player rather than off the effect it was handed. A Bulwark fixed under an
   * Adamant leaves 50% off and not 20%, and a toast quoting the item would tell
   * the player their protection had just got worse at the moment it got
   * longer. */
  const r = wardRig({ stock: { ward_50: 1, ward_20: 1 } });
  r.itemUse.use('ward_50');
  r.itemUse.use('ward_20');
  assert.equal(r.player.wardMultiplier, 0.5);
  assert.match(r.bus.lastToast() ?? '', /50% less damage/, `the toast said: ${r.bus.lastToast()}`);
});

test('a ward used over your own corpse is refused and KEPT, and the refusal says why', () => {
  /* Sharper than the draught's version of the same case: `Player.respawn`
   * ZEROES the ward, so a charm fixed to a body is not merely useless, it is
   * guaranteed to be erased by the very next thing that happens to the player.
   * That is the unit destroyed for nothing, with a receipt. */
  const r = wardRig({ stock: { ward_35: 1 }, dead: true });
  const res = r.itemUse.use('ward_35');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'dead');
  assert.equal(r.inventory.bagCount('ward_35'), 1, 'a refused ward was consumed anyway');
  assert.match(r.bus.lastToast() ?? '', /Kept, not spent/);
  assert.equal(r.bus.of('effect:started').length, 0);
});

test('a Player too old to have grantWard keeps the charm rather than swallowing it', () => {
  const bus = fakeBus();
  const inventory = fakeBag({ ward_20: 1 });
  const itemUse = new ItemUseSystem({ bus, player: { isDead: false }, inventory });
  assert.equal(itemUse.use('ward_20').ok, false);
  assert.equal(inventory.bagCount('ward_20'), 1, 'an unwired Player ate the ward');
});

/* ====================================================================== */
/* 5. The ship shield recharge cell                                       */
/* ====================================================================== */

test('canChargeShield is canWidenGuns plus room in the pool', () => {
  /* Three answers, and each is a different refusal the player would otherwise
   * pay for: on the deck there is no shield to charge, in the air with a full
   * pool there is nowhere for the charge to go, and in the air with a dent
   * there is. */
  const onFoot = bareCombat({ flying: false, tierShield: 2 });
  onFoot.shield = 0;
  assert.equal(onFoot.canChargeShield(), false, 'a cell can be spent standing on the concourse');

  const full = bareCombat({ flying: true, tierShield: 2 });
  assert.equal(full.shield, full.shieldMax, 'premise: the pool starts full');
  assert.equal(full.canChargeShield(), false, 'a cell can be poured into a full shield');

  const dented = bareCombat({ flying: true, tierShield: 2 });
  dented.shield = 1;
  assert.equal(dented.canChargeShield(), true, 'a shield one point down refuses a cell');

  /* And ONE POINT DOWN IS ENOUGH ON PURPOSE. `chargeShield` clamps to what
   * fits, so a near-full pool takes a sliver and the rest is gone - which is
   * real value, and refusing it would be the bag rigs' mirror failure at 59 of
   * 60 slots: a unit withheld for nothing. */
  dented.shield = dented.shieldMax - 0.5;
  assert.equal(dented.canChargeShield(), true);
});

test('chargeShield fills the pool, clamps at the ceiling and unsticks the regulator', () => {
  /* THE SECOND HALF OF THE ITEM IS `_shieldIdle`. `_playerHit` zeroes it on
   * every hit and `_regen` only tops the pool up once it has passed
   * `SHIELD_DELAY` - so a cell that only wrote `shield` would hand the pilot
   * the charge and leave them locked out of their own regeneration for four and
   * a half seconds of the fight it was bought for. */
  const combat = bareCombat({ flying: true, tierShield: 3 });
  assert.equal(combat.shieldMax, SHIELD_PER_TIER * 3);
  combat.shield = 0;
  combat._shieldIdle = 0;

  assert.equal(combat.chargeShield(SHIELD_CELL_CHARGE), SHIELD_CELL_CHARGE);
  assert.equal(combat.shield, SHIELD_CELL_CHARGE);
  assert.equal(combat._shieldIdle, SHIELD_DELAY, 'the cell left the regulator locked out');

  // Clamped, and honest about what it actually put in.
  const put = combat.chargeShield(SHIELD_CELL_CHARGE);
  assert.equal(put, combat.shieldMax - SHIELD_CELL_CHARGE, 'the overflow was not reported as the real figure');
  assert.equal(combat.shield, combat.shieldMax, 'the pool went past its own ceiling');
  assert.equal(combat.chargeShield(SHIELD_CELL_CHARGE), 0, 'a full pool still took a charge');

  for (const bad of [0, -5, NaN, Infinity, null, '110']) {
    assert.equal(combat.chargeShield(bad), 0, `an amount of ${String(bad)} was accepted`);
  }
});

test('the cell is sized against the ladder it must not replace', () => {
  /* A cell that always filled the bar would make the shield ladder in the
   * Fitting Shop pointless - why buy a bigger tank when a bottle fills any
   * tank. Re-derived rather than typed, so a re-tune of either constant that
   * broke the relationship shows up here. */
  assert.equal(SHIELD_CELL_CHARGE, SHIELD_PER_TIER * 2);
  assert.ok(SHIELD_CELL_CHARGE > SHIELD_FLOOR,
    'a cell does not even fill the floor pool a new pilot flies with');
  assert.ok(SHIELD_CELL_CHARGE < SHIELD_PER_TIER * 3,
    'a cell fills a maximum shield outright, which deletes the reason to buy one');
});

/** A `SpaceCombat` stand-in that records what the use path asked it. */
function fakeShip({ chargeable = true, put = 60, shield = 40, shieldMax = 165 } = {}) {
  return {
    calls: [],
    chargeable,
    shield,
    shieldMax,
    canChargeShield() { return this.chargeable; },
    chargeShield(amount) { this.calls.push(amount); this.shield += put; return put; },
  };
}

test('a cell used in the seat charges the shield and consumes exactly one', () => {
  const bus = fakeBus();
  const inventory = fakeBag({ shield_cell: 3 });
  const effects = new ActiveEffects({ bus, clock: () => 0 });
  const ship = fakeShip();
  const itemUse = new ItemUseSystem({ bus, player: { isDead: false }, inventory, effects, spaceCombat: ship });

  const res = itemUse.use('shield_cell');
  assert.equal(res.ok, true, `refused: ${res.reason}`);
  assert.deepEqual(ship.calls, [SHIELD_CELL_CHARGE],
    'the cell asked for an amount that is not the published charge');
  assert.deepEqual(inventory.takes, [['shield_cell', 1]]);
  assert.equal(inventory.bagCount('shield_cell'), 2);
  assert.match(bus.lastToast() ?? '', /Shield recharged \+60/, `the toast said: ${bus.lastToast()}`);

  /* NO CHIP. Instantaneous, like a medkit: it changes a number once and there
   * is nothing left running to count down. `ActiveEffects.start` answers false
   * to an undefined duration, which is how this file keeps no second list of
   * which effects are timed. */
  assert.equal(bus.of('effect:started').length, 0, 'an instantaneous charge put a countdown on the HUD');
  assert.equal('shipShield' in EFFECT_KINDS, false);
});

test('a cell on the concourse, or into a full shield, is refused and KEPT', () => {
  for (const label of ['on foot', 'at a full shield']) {
    const bus = fakeBus();
    const inventory = fakeBag({ shield_cell: 1 });
    const ship = fakeShip({ chargeable: false });
    const itemUse = new ItemUseSystem({ bus, player: { isDead: false }, inventory, spaceCombat: ship });
    const res = itemUse.use('shield_cell');
    assert.equal(res.ok, false, `${label}: the cell was accepted`);
    assert.equal(res.reason, 'no-shield',
      `${label}: the refusal has no reason code of its own, so main.js stacks a second toast on it`);
    assert.equal(inventory.bagCount('shield_cell'), 1, `${label}: a refused cell was consumed anyway`);
    assert.deepEqual(ship.calls, [], `${label}: the ship was charged despite the refusal`);
    assert.match(bus.lastToast() ?? '', /Kept, not spent/);
  }

  // ..and an unwired SpaceCombat answers the same way rather than throwing.
  const inventory = fakeBag({ shield_cell: 1 });
  const res = new ItemUseSystem({ bus: fakeBus(), player: { isDead: false }, inventory }).use('shield_cell');
  assert.equal(res.ok, false);
  assert.equal(inventory.bagCount('shield_cell'), 1, 'an unwired SpaceCombat ate the cell');
});

/* ====================================================================== */
/* 6. The shelf                                                           */
/* ====================================================================== */

test('every new item has a catalogue row with a registered action and a real grant', async () => {
  /* THE NINE-STEP REGISTRATION, END TO END, for all eight rows. Step 6 (a
   * `game_action` the seed normaliser accepts) and step 7 (a grant that
   * actually resolves) are the two whose failures are silent: an unregistered
   * action makes `rowToItem` THROW and takes the whole listing down, and a
   * `source_key` that misses `MARKETPLACE_CONSUMABLE_ITEMS` makes every
   * purchase return `unsupported` while the row looks perfect. */
  const { BASE_ITEMS, MARKETPLACE_ACTIONS, MARKETPLACE_CATEGORIES } = await loadCatalog();
  const actions = new Set(MARKETPLACE_ACTIONS.map((a) => a.id));
  const grantOf = (row) => Marketplace.prototype._purchaseGrant.call({}, row);

  /** catalogue key -> the bag item a purchase must hand over. */
  const expect = new Map([
    ...DRAUGHT_KEYS.map((k, i) => [k, DRAUGHTS[i]]),
    ...WARDS.map((w) => [w, w]),
    ['part_shield_cell', 'shield_cell'],
  ]);

  for (const [key, itemId] of expect) {
    const row = BASE_ITEMS.find((r) => r.source_key === key);
    assert.ok(row, `no BASE_ITEMS row for ${key}: the item exists and nobody sells it`);
    assert.ok(actions.has(row.game_action),
      `${key}: game_action ${row.game_action} is in no MARKETPLACE_ACTIONS row, so the seed normaliser rejects it`);
    assert.ok(MARKETPLACE_CATEGORIES.includes(row.category), `${key}: category ${row.category}`);
    assert.equal(row.pricing_kind, 'consumable',
      `${key}: these are consumed, so they follow the regional consumable rates like every other row that is`);
    assert.ok(row.cost_buy > row.cost_sell, `${key}: buy ${row.cost_buy} <= sell ${row.cost_sell} prints credits`);

    /* Driven through the REAL `_purchaseGrant`, and with the world-stamped key
     * as well as the bare one: `buildMarketplaceSeedItems` stamps
     * `:<world>` onto every key and nothing between the DB row and the game
     * strips it, which is the exact shape of the recorded step-7 failure. */
    for (const probe of [key, `${key}:station`, `${key}:dock`]) {
      const grant = grantOf({ source_key: probe, action_config: row.action_config });
      assert.ok(grant, `${probe}: resolves to nothing, so the purchase returns 'unsupported'`);
      assert.equal(grant.itemId, itemId, `${probe}: grants "${grant.itemId}"`);
      assert.equal(grant.qty, 1);
      assert.ok(isItem(grant.itemId), `${probe}: grants something that is not an item`);
    }
  }
});

test('the offline mirror carries all eight, so they can be bought with the API down', () => {
  const bundled = new Map(OFFLINE_BASE_ITEMS.map((r) => [r.source_key, r]));
  for (const key of [...DRAUGHT_KEYS, ...WARDS, 'part_shield_cell']) {
    assert.ok(bundled.has(key), `${key} is on the server and not in the bundle`);
  }

  /* The draughts are `health` and the wards are `spells`, and both are stocked
   * by a real vendor in a real world. The shield cell is `ships`, which the
   * whole Nexus carries at ONE counter, so it is checked in the yard and
   * checked ABSENT everywhere else - that is what its allowlist means. */
  const citadel = offlineCatalog('citadel');
  for (const key of [...DRAUGHT_KEYS, ...WARDS]) {
    const row = citadel.find((r) => r.source_key === key);
    assert.ok(row, `${key} is on no citadel shelf`);
    assert.equal(row.id, `${key}:citadel`, 'the id is not the seeder id, so offline and online name different rows');
  }
  const dock = offlineCatalog('dock');
  assert.ok(dock.some((r) => r.source_key === 'part_shield_cell'), 'the yard does not stock the shield cell');
  assert.equal(offlineCatalog('station').some((r) => r.source_key === 'part_shield_cell'), false,
    'the station stocks a ships row, and no counter there carries the category');
});

test('the three families are purchase-only: no drop table, no cache table, no supply contract', async () => {
  /* A DECISION, WRITTEN DOWN, and the reason differs per family.
   *
   * The draughts: a resource whose entire design is that it runs out is not one
   * to hand back off a guard by the fistful. `Loot._dropFor` and
   * `Caches._contentsFor` roll consumables in threes.
   *
   * The wards: the shard they are the alternative to is not in any table
   * either, and a defensive buff falling off the enemy that would have used it
   * on you is the loop paying you to be attacked.
   *
   * The shield cell: `laser_cell` IS in the yard's tables, and that is exactly
   * the precedent this refuses. Cells fall out of the kill ladder twenty at a
   * time; a shield bottle arriving on the same schedule would mean the pool
   * effectively never empties, which deletes both the tension the shield exists
   * for and the reason to buy a shield tier at the Fitting Shop. */
  for (const rel of ['src/systems/Loot.js', 'src/systems/Caches.js', 'src/systems/Contracts.js']) {
    const src = await read(rel);
    for (const id of [...DRAUGHTS, ...WARDS, 'shield_cell']) {
      assert.ok(!src.includes(id), `${rel} mentions ${id} - a purchase-only row that drops is a balance change nobody asked for`);
    }
    assert.ok(!src.includes('stamina_draught'), `${rel} mentions stamina_draught`);
  }
});

test('every new item is a `consumable` with an icon of its own, or the bag cannot use it', async () => {
  /* `InventoryUI._hasUse` draws the hold-to-use ring for `consumable`, `skin`
   * and `mountpower` ONLY, so any other kind is an effect with no way to reach
   * it - the failure `laser_cell` was relabelled to fix.
   *
   * And the icon must not fall through to `ICONS.unknown`: that renderer is the
   * question mark, and an item that reaches it is the recorded
   * `planet-minerals` failure, invisible because a question mark still looks
   * like art. Checked by rendering the real SVG and comparing it against what
   * `unknown` actually draws, rather than by asserting a key exists in a map
   * this file cannot see. */
  const ui = await read('src/ui/InventoryUI.js');
  const hasUse = ui.match(/_hasUse\(def\)\s*\{[\s\S]*?\n {2}\}/)?.[0] ?? '';
  assert.ok(hasUse, 'found _hasUse');
  assert.match(hasUse, /'consumable'/, 'the hold-to-use ring no longer covers consumables');

  const unknown = itemIconSVG('a-key-no-renderer-will-ever-have');
  const strip = (s) => s.replace(/ig\d+/g, 'ig');
  for (const id of [...DRAUGHTS, ...WARDS, 'shield_cell']) {
    const def = itemDef(id);
    assert.ok(def, `${id} is not in ITEMS`);
    assert.equal(def.kind, 'consumable', `${id} is "${def.kind}", so the bag offers it no Use`);
    assert.ok(KIND_ACCENT[def.kind], `${id} has a kind with no accent colour, so a pickup falls back to cyan`);
    assert.ok(def.short && def.short.length <= 4, `${id} has no short badge`);
    const svg = itemIconSVG(id);
    assert.match(svg, /^<svg /, `${id} rendered no icon`);
    assert.notEqual(strip(svg), strip(unknown), `${id} draws ICONS.unknown - the question mark`);
  }

  /* The chip tag is the same short badge the bag row prints, so the strip and
   * the inventory speak one vocabulary. */
  assert.equal(EFFECT_KINDS.stamina.tag, ITEMS.stamina_draught_25.short);
  assert.equal(EFFECT_KINDS.ward.tag, ITEMS.ward_20.short);
});

test('no buy-sell-buy loop prints credits at any regional multiplier', async () => {
  /* The cheapest a row can ever be bought is Meridian's 0.7 consumable rate and
   * the most the game will ever pay back for the item is Sunspire's 1.45. A
   * ladder that got those two the wrong way round would be a credit printer in
   * a world with a portal to both. */
  const bundled = new Map(OFFLINE_BASE_ITEMS.map((r) => [r.source_key, r]));
  const pairs = [
    ...DRAUGHT_KEYS.map((k, i) => [k, DRAUGHTS[i]]),
    ...WARDS.map((w) => [w, w]),
    ['part_shield_cell', 'shield_cell'],
  ];
  for (const [key, itemId] of pairs) {
    const row = bundled.get(key);
    const sellBack = Math.max(1, Math.round(ITEMS[itemId].value * SELL_RATE)) * 1.45;
    assert.ok(row.cost_buy * 0.7 > sellBack,
      `${key}: bought at ${(row.cost_buy * 0.7).toFixed(0)} in Meridian and sold back for `
      + `${sellBack.toFixed(0)} in Sunspire - that is a credit printer`);
    assert.ok(row.cost_buy > row.cost_sell * 2,
      `${key}: buy ${row.cost_buy} against a sell of ${row.cost_sell} - the regional spread `
      + '(0.7 buy, 1.4 sell) closes a gap narrower than 2x');
  }
});

test('both ladders rise with strength, and the top ward stops short of the shard', () => {
  const bundled = new Map(OFFLINE_BASE_ITEMS.map((r) => [r.source_key, r]));
  const rising = (keys, what) => {
    for (let i = 1; i < keys.length; i++) {
      assert.ok(bundled.get(keys[i]).cost_buy > bundled.get(keys[i - 1]).cost_buy,
        `${what}: ${keys[i]} is not dearer than ${keys[i - 1]}`);
    }
  };
  rising(DRAUGHT_KEYS, 'the draught ladder');
  rising(WARDS, 'the ward ladder');

  /* THE WARD LADDER STOPS AT HALF, AND THE SHARD IS WHY. `shield_5s` is total
   * immunity for five seconds; a x0 ward at thirty would be that item deleted.
   * Half is exactly double effective health, which is where a middle ground
   * ends and a better shard begins. Read off `ItemUse` rather than off a
   * comment, so a fourth rung added quietly fails here. */
  const sys = new ItemUseSystem({});
  const deepest = Math.min(...WARDS.map((w) => sys._effectFor(w).multiplier));
  assert.equal(deepest, 0.5, 'the ward ladder now goes deeper than half');
  assert.ok(deepest > 0, 'a ward reaching zero is the Aegis Shard, for six times as long');

  /* And the shard is still what it was, so the argument above still holds. */
  assert.equal(sys._effectFor('shield_5s').duration, 5);
  assert.equal(sys._effectFor('shield_5s').type, 'shield');

  // A draught is cheaper than the speed rung it sits under at every rung.
  const speed = ['spell_velocity_25', 'spell_velocity_50', 'spell_velocity_75', 'spell_velocity_100'];
  for (let i = 0; i < 4; i++) {
    assert.ok(bundled.get(DRAUGHT_KEYS[i]).cost_buy < bundled.get(speed[i]).cost_buy,
      `${DRAUGHT_KEYS[i]} is dearer than ${speed[i]} - mobility is the more decisive purchase of the two`);
  }
});
