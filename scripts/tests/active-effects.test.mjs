/**
 * THE ACTIVE-EFFECT INDICATOR, and the clock defect underneath it.
 *
 * Three separate claims are made here and they are worth keeping apart:
 *
 *   1. THE MODEL. `ActiveEffects` starts, extends, counts down and ends, and
 *      it refuses anything that is not a timed effect - which is how a medkit
 *      and a nav chart get no chip without a second list of "which effects are
 *      timed" existing anywhere.
 *   2. THE CLOCK. A buff used while a UI panel holds gameplay lasts its full
 *      duration once the panel closes. This is a REGRESSION test for a defect
 *      that shipped: `Player._elapsed` is assigned from the engine inside
 *      `fixedUpdate`, main.js does not call `fixedUpdate` while
 *      `gameplayBlocked()`, and the inventory panel - the only way to use one
 *      of these items - raises that block. So a deadline written from the bag
 *      was dated from the moment the bag OPENED and read after the clock had
 *      snapped forward, and a Velocity Crown used forty seconds into a browse
 *      was over before the browse was.
 *   3. THE WIRING. `ItemUse` reaches the ledger for every timed effect and for
 *      no untimed one, driven through the real `ItemUseSystem` against stub
 *      systems rather than by asserting on the source text.
 *
 * No DOM: everything above is logic, and the house pattern for logic is to
 * test it off the DOM (see `inventory-hold-to-use.test.mjs`). The strip's
 * geometry is not logic and is graded by `hud-viewport-probe.mjs` instead.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ActiveEffects, EFFECT_KINDS } from '../../src/systems/ActiveEffects.js';
import { ItemUseSystem } from '../../src/systems/ItemUse.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

/** Block comments, and line comments that are not inside a string or a URL. */
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /(^|[^:'"`\\])\/\/[^\n]*/g;

/**
 * Read a repo file with line endings normalised and every comment removed.
 *
 * The normalise is the standing rule in this repository - it checks out with
 * `core.autocrlf` on, so a scrape anchored on a bare newline is green in one
 * checkout and red in another. See the long note in `hud-source-checks.mjs`.
 *
 * Stripping the comments is this file's own requirement, and it is not
 * cosmetic: every assertion below is about what the CODE reaches for, and the
 * prose beside that code names the very identifiers it is forbidding. Without
 * the strip, EXPLAINING the defect in a comment is what breaks the test that
 * guards it - which is a gate that punishes the thing this repository asks for
 * most.
 */
async function readCode(rel) {
  return (await readFile(path.join(root, rel), 'utf8'))
    .replace(/\r\n/g, '\n')
    .replace(BLOCK_COMMENT, '')
    .replace(LINE_COMMENT, '$1');
}

/** A bus that records, and hands back a real unsubscribe. */
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
      events.push([type, payload]);
      for (const fn of [...(handlers.get(type) ?? [])]) fn(payload);
    },
    of(type) {
      return events.filter((e) => e[0] === type).map((e) => e[1]);
    },
  };
}

/* ====================================================================== */
/* 1. The model                                                            */
/* ====================================================================== */

test('an effect starts, counts down and ends on the one clock', () => {
  const bus = fakeBus();
  let now = 100;
  const fx = new ActiveEffects({ bus, clock: () => now });

  assert.equal(fx.start('speed', 30, 'Velocity Crown'), true);
  const started = bus.of('effect:started');
  assert.equal(started.length, 1);
  assert.deepEqual(started[0], {
    id: 'speed',
    kind: 'speed',
    label: 'Velocity Crown',
    tag: 'SPD',
    duration: 30,
    endsAt: 130,
  });

  now = 129.9;
  fx.update();
  assert.equal(fx.has('speed'), true, 'ended a tenth of a second early');
  assert.equal(bus.of('effect:ended').length, 0);

  now = 130;
  fx.update();
  assert.equal(fx.has('speed'), false);
  assert.deepEqual(bus.of('effect:ended'), [{ id: 'speed', kind: 'speed' }]);

  // Idempotent: a second sweep past the deadline must not announce it twice.
  now = 200;
  fx.update();
  assert.equal(bus.of('effect:ended').length, 1);
});

test('a second charge extends the one effect rather than raising a second chip', () => {
  const bus = fakeBus();
  let now = 0;
  const fx = new ActiveEffects({ bus, clock: () => now });

  fx.start('magnet', 30, 'Vacuum Rune');
  now = 10;
  fx.start('magnet', 30, 'Vacuum Rune');

  assert.equal(fx.list().length, 1, 'two chips for one magnet - Loot holds one deadline');
  assert.equal(fx.list()[0].endsAt, 40, 'the deadline must move forward, matching Loot.setMagnet');

  /* And it can never move BACKWARD, which is the half `Math.max` is really
   * there for: a 20 s lodestone used on top of a 30 s rune must not cut the
   * rune short. */
  now = 15;
  fx.start('magnet', 20, 'Ferro-basalt');
  assert.equal(fx.list()[0].endsAt, 40, 'a shorter charge shortened a longer one');
});

test('nav_chart never produces a chip, and neither does a medkit', () => {
  const bus = fakeBus();
  const fx = new ActiveEffects({ bus, clock: () => 0 });

  /* `chart` and `heal` are the two effect types `ItemUse._effectFor` publishes
   * with no `duration`, and they are absent from `EFFECT_KINDS` on purpose: a
   * charted viewpoint is a PERMANENT map reveal and a medkit is over the
   * instant it lands. A countdown against either would be inventing an expiry
   * the game does not have. */
  assert.equal('chart' in EFFECT_KINDS, false);
  assert.equal('heal' in EFFECT_KINDS, false);

  assert.equal(fx.start('chart', undefined, 'Nav Chart'), false);
  assert.equal(fx.start('chart', 30, 'Nav Chart'), false, 'a duration must not smuggle a chart in');
  assert.equal(fx.start('heal', 50, 'Medkit'), false);
  assert.equal(fx.list().length, 0);
  assert.equal(bus.of('effect:started').length, 0);
});

test('a duration that is not a positive finite number is not an effect', () => {
  const fx = new ActiveEffects({ bus: fakeBus(), clock: () => 0 });
  for (const bad of [0, -5, NaN, Infinity, null, undefined, '30']) {
    assert.equal(fx.start('speed', bad), false, `start accepted a duration of ${String(bad)}`);
  }
});

test('a world change ends what a world change actually ends, and no more', () => {
  const bus = fakeBus();
  const fx = new ActiveEffects({ bus, clock: () => 0 });
  for (const kind of Object.keys(EFFECT_KINDS)) fx.start(kind, 30);

  bus.emit('world:changed', { id: 'maze' });

  /* `Combat.reset()` is wired to `world:changed` and zeroes the damage boost,
   * and a gateway ping lives on a portal object thrown away with the old world.
   * Nothing resets the speed boost, the shield, the magnet or the crowd pause,
   * so those four really do travel through the gate with the player.
   *
   * `gunSpread` is the fifth survivor and it was traced rather than assumed:
   * `SpaceCombat._adopt` is the only thing that answers `world:changed` there,
   * it swaps encounter zones and stands the wing down, and it does not touch
   * `_spreadBolts` - there is no `SpaceCombat.reset()` at all. So a pilot who
   * buys a fan, docks and launches again really does still have it. */
  assert.deepEqual(
    fx.list().map((e) => e.kind).sort(),
    ['gunSpread', 'magnet', 'pauseNpcs', 'shield', 'speed'],
  );
});

test('a respawn ends exactly what Player.respawn clears', () => {
  const bus = fakeBus();
  const fx = new ActiveEffects({ bus, clock: () => 0 });
  for (const kind of Object.keys(EFFECT_KINDS)) fx.start(kind, 30);

  bus.emit('player:respawned', {});

  /* `respawn()` sets `_speedBoostUntil = 0` and overwrites `_invulnUntil`, and
   * that is the whole of it - it has never held a reference to `SpaceCombat`,
   * so the gun fan survives a death exactly as the firepower boost does. */
  assert.deepEqual(
    fx.list().map((e) => e.kind).sort(),
    ['firepower', 'gunSpread', 'magnet', 'pauseNpcs', 'portalPing'],
  );
});

test('a page where an effect was never used costs nothing and announces nothing', () => {
  const bus = fakeBus();
  const fx = new ActiveEffects({ bus, clock: () => 0 });
  for (let i = 0; i < 1000; i++) fx.update();
  assert.equal(bus.events.length, 0);
  assert.equal(fx.list().length, 0);
});

test('dispose unsubscribes, so a disposed ledger cannot be revived by a world change', () => {
  const bus = fakeBus();
  const fx = new ActiveEffects({ bus, clock: () => 0 });
  fx.start('firepower', 30);
  fx.dispose();
  bus.emit('world:changed', { id: 'maze' });
  assert.equal(bus.of('effect:ended').length, 0, 'a disposed ledger still answered the bus');
});

/* ====================================================================== */
/* 2. The clock                                                            */
/* ====================================================================== */

/**
 * The engine's two clocks, driven by hand.
 *
 * `elapsed` is wall time and never stops. `simElapsed` is play time and stops
 * while a UI panel holds gameplay - which is the whole distinction the defect
 * below turns on. This is the same arithmetic `Engine._loop` does.
 */
function fakeEngine() {
  return {
    elapsed: 0,
    simElapsed: 0,
    simulating: true,
    setSimulating(on) { this.simulating = !!on; },
    tick(dt) {
      this.elapsed += dt;
      if (this.simulating) this.simElapsed += dt;
    },
  };
}

/**
 * The two fields of `Player` this is about, and the four sites that touch them,
 * lifted out so the defect can be driven without a THREE scene, a physics world
 * and a weapon. The bodies are copied from `Player.js`; `player-clock.test.mjs`
 * below asserts the real file still reads that way.
 */
function fakePlayer(engine) {
  return {
    engine,
    _elapsed: 0,
    _speedBoostUntil: 0,
    _speedBoostMul: 1,
    _buffNow() { return this.engine?.simElapsed ?? this._elapsed; },
    get speedMultiplier() {
      return this._buffNow() < this._speedBoostUntil ? this._speedBoostMul : 1;
    },
    boostSpeed(multiplier, duration) {
      if (!(multiplier > 1) || !(duration > 0)) return false;
      this._speedBoostMul = Math.max(this.speedMultiplier, multiplier);
      this._speedBoostUntil = Math.max(this._speedBoostUntil, this._buffNow() + duration);
      return true;
    },
    /** What main.js does every fixed step, and ONLY while gameplay is not blocked. */
    fixedUpdate(elapsed) { this._elapsed = elapsed; },
  };
}

test('a buff started while gameplay is blocked lasts its full duration once unblocked', () => {
  const engine = fakeEngine();
  const player = fakePlayer(engine);
  const bus = fakeBus();
  const fx = new ActiveEffects({ bus, engine });

  /* Forty seconds of play, with the engine and the player in step. */
  for (let i = 0; i < 40 * 60; i++) {
    engine.tick(1 / 60);
    player.fixedUpdate(engine.elapsed);
  }
  assert.ok(Math.abs(engine.simElapsed - 40) < 1e-6);

  /* THE BAG OPENS. main.js adds 'inventory' to `gameplayUiBlocks`, so
   * `engine.onFixedUpdate` early-returns and `player.fixedUpdate` stops being
   * called - the player's own `_elapsed` freezes here and does not move again
   * until the bag closes. `engine.elapsed` keeps running; `simElapsed` does not. */
  engine.setSimulating(false);
  for (let i = 0; i < 40 * 60; i++) engine.tick(1 / 60);

  assert.ok(Math.abs(engine.elapsed - 80) < 1e-6, 'wall time must keep running behind a panel');
  assert.ok(Math.abs(engine.simElapsed - 40) < 1e-6, 'play time must not');
  assert.ok(Math.abs(player._elapsed - 40) < 1e-6, 'the player clock is frozen while blocked');

  /* THE VELOCITY CROWN, used from inside the bag after forty seconds of it. */
  assert.equal(player.boostSpeed(2, 30), true);
  fx.start('speed', 30, 'Velocity Crown');

  /* THE BAG CLOSES, and the player's `_elapsed` snaps forward to wall time -
   * which is the moment the old code lost the buff. */
  engine.setSimulating(true);
  player.fixedUpdate(engine.elapsed);
  assert.equal(player.speedMultiplier, 2, 'the boost expired before the panel closed');
  assert.equal(fx.has('speed'), true, 'the chip expired before the panel closed');

  /* Twenty-nine seconds of PLAY later it is still running, because the thirty
   * seconds were sold in play time. */
  for (let i = 0; i < 29 * 60; i++) {
    engine.tick(1 / 60);
    player.fixedUpdate(engine.elapsed);
    fx.update();
  }
  assert.equal(player.speedMultiplier, 2, 'the boost is a second short of thirty and already gone');
  assert.equal(fx.has('speed'), true);

  /* And on the thirtieth it ends - the buff and the chip together, because they
   * are reading the same clock. */
  for (let i = 0; i < 61; i++) {
    engine.tick(1 / 60);
    player.fixedUpdate(engine.elapsed);
    fx.update();
  }
  assert.equal(player.speedMultiplier, 1);
  assert.equal(fx.has('speed'), false);
});

test('the wall clock would have lost the buff - the defect this replaces', () => {
  /* The old arithmetic, written out, so the regression above is anchored to a
   * failure that can be reproduced rather than to a description of one.
   * `_speedBoostUntil = frozenElapsed + duration`, read against live time. */
  const panelOpenedAt = 40;
  const browsedFor = 40;
  const duration = 30;
  const oldDeadline = panelOpenedAt + duration;       // dated from the frozen clock
  const clockOnClose = panelOpenedAt + browsedFor;    // where `_elapsed` snapped to
  assert.ok(clockOnClose > oldDeadline,
    'the premise of the defect no longer holds - re-derive this test');
});

test('every timed effect is dated from engine.simElapsed and read from it', async () => {
  /* A source check, because this is the one property no unit can observe from
   * the outside: five systems each own one deadline, and the indicator is only
   * honest while all five agree about what time it is. `_buffNow` is the single
   * name they all reach the clock through, so this asserts the name exists and
   * that nothing has gone back to `engine.elapsed` beside a deadline. */
  const files = [
    ['src/player/Player.js', ['_speedBoostUntil', '_invulnUntil']],
    ['src/systems/Combat.js', ['_playerDamageBoostUntil']],
    ['src/systems/Loot.js', ['_magnetUntil']],
    ['src/npc/NPCManager.js', ['_pauseUntil']],
    ['src/systems/Portals.js', ['_pingUntil']],
  ];
  for (const [rel, fields] of files) {
    const src = await readCode(rel);
    assert.match(src, /_buffNow\(\)\s*\{/, `${rel} lost its buff clock accessor`);
    assert.match(src, /simElapsed/, `${rel} no longer reads the play clock at all`);
    for (const field of fields) {
      /* No line that touches one of these deadlines may also read the WALL
       * clock. That is the regression this guards: `engine.elapsed` and the
       * `elapsed` argument handed to a system's update are both wall time, and
       * either of them beside a deadline is the defect coming back.
       *
       * It asserts the NEGATIVE rather than "every such line says `_buffNow()`",
       * because `Portals.pingNearest` reads the clock into a local two lines
       * above the write it belongs to and a positive test would have to be
       * written around that one call site. Nothing may bring the wall clock
       * near these five fields; how the play clock gets there is the file's
       * own business. */
      for (const line of src.split('\n')) {
        if (!line.includes(field)) continue;
        assert.equal(
          /\belapsed\b/.test(line.replace(/simElapsed/g, '')), false,
          `${rel}: "${line.trim()}" dates ${field} from the wall clock`,
        );
      }
    }
  }
});

test('the engine keeps play time separately and stops it on a blocked frame', async () => {
  const src = await readCode('src/core/Engine.js');
  assert.match(src, /this\.simElapsed = 0;/);
  assert.match(src, /if \(this\._simulating\) this\.simElapsed \+= dt;/);
  assert.match(src, /setSimulating\(on\) \{/);

  /* And main.js has to be the thing that closes the loop: the engine has no
   * idea which panels exist, so `setGameplayBlocked` is the only place that
   * can tell it. Without this line every deadline silently reverts to wall
   * time and nothing else in this file would notice. */
  const main = await readCode('src/main.js');
  assert.match(main, /engine\.setSimulating\(!gameplayBlocked\(\)\);/);
});

/* ====================================================================== */
/* 3. The wiring                                                           */
/* ====================================================================== */

/** A bag that always has the item and always gives it up. */
function fakeBag() {
  return { consumeFromBag: () => true };
}

/**
 * `ItemUseSystem` with every collaborator stubbed to succeed, so a use reaches
 * the ledger exactly when the real systems would have taken the effect.
 */
function useSystem(effects) {
  return new ItemUseSystem({
    bus: fakeBus(),
    inventory: fakeBag(),
    effects,
    player: {
      health: 10,
      maxHealth: 100,
      heal: () => 50,
      boostSpeed: () => true,
      grantShield: () => true,
    },
    loot: { setMagnet: () => true },
    combat: { boostPlayerDamage: () => true },
    npcManager: { pauseFor: () => true },
    portals: { portals: [{ id: 'p', target: 'maze', position: { x: 0, y: 0, z: 0 } }], pingNearest: () => ({ id: 'p', target: 'maze' }) },
    viewpoints: { canChart: () => true, chartNearest: () => ({ id: 'vp', name: 'The Long Pier' }) },
  });
}

test('using a timed consumable raises exactly one chip, of the right kind and length', () => {
  /* One row per timed item id in `ItemUse._effectFor`, so an item that grows a
   * new duration and forgets the ledger fails here rather than shipping a
   * silent buff. */
  const cases = [
    ['speed_boost_25', 'speed', 30],
    ['speed_boost_100', 'speed', 30],
    ['shield_5s', 'shield', 5],
    ['firepower_boost_50', 'firepower', 30],
    ['loot_magnet_30s', 'magnet', 30],
    ['ferrobasalt', 'magnet', 20],
    ['npc_pause_5s', 'pauseNpcs', 5],
    ['npc_pause_60s', 'pauseNpcs', 60],
    ['portal_ping_30s', 'portalPing', 30],
  ];
  for (const [itemId, kind, duration] of cases) {
    const bus = fakeBus();
    const fx = new ActiveEffects({ bus, clock: () => 0 });
    const res = useSystem(fx).use(itemId);
    assert.equal(res.ok, true, `${itemId} was refused by the stub systems`);
    const started = bus.of('effect:started');
    assert.equal(started.length, 1, `${itemId} raised ${started.length} chips`);
    assert.equal(started[0].kind, kind, `${itemId} raised a ${started[0].kind} chip`);
    assert.equal(started[0].endsAt, duration, `${itemId} counts down from ${started[0].endsAt}s`);
    assert.ok(started[0].label, `${itemId} raised a chip with no name on it`);
  }
});

test('using a medkit or a nav chart raises no chip at all', () => {
  for (const itemId of ['medkit', 'nav_chart']) {
    const bus = fakeBus();
    const fx = new ActiveEffects({ bus, clock: () => 0 });
    const res = useSystem(fx).use(itemId);
    assert.equal(res.ok, true, `${itemId} was refused - this test is not exercising the path`);
    assert.equal(bus.of('effect:started').length, 0, `${itemId} put a countdown on the HUD`);
    assert.equal(fx.list().length, 0);
  }
});

test('a refused use raises no chip, and an unwired ledger never refuses a use', () => {
  const bus = fakeBus();
  const fx = new ActiveEffects({ bus, clock: () => 0 });
  /* `boostSpeed` answering false is `_apply` returning null, which is a refusal
   * AFTER the consume - the one path where a chip would describe an effect that
   * is not running. */
  const sys = useSystem(fx);
  sys.player.boostSpeed = () => false;
  assert.equal(sys.use('speed_boost_25').ok, false);
  assert.equal(bus.of('effect:started').length, 0);

  // And the ledger is optional: without one the item still works.
  const bare = useSystem(null);
  assert.equal(bare.use('speed_boost_25').ok, true);
});

/* ====================================================================== */
/* 4. The HUD end of the contract                                          */
/* ====================================================================== */

test('the HUD learns about effects from the bus and holds no system to poll', async () => {
  const src = await readCode('src/ui/HUD.js');

  assert.match(src, /this\._on\('effect:started'/, 'the strip is not wired to the bus');
  assert.match(src, /this\._on\('effect:ended'/);

  /* THE POINT OF THE WHOLE DESIGN. `HUD.attach()` is never called anywhere in
   * this repository, so `_updateSystems` resolves every late-bound system off
   * `window.GAME` - which main.js only publishes under `?dev=1`. A poll of the
   * owning systems would have worked in the screenshot harness and shown
   * nothing whatsoever to a real player. */
  assert.equal(src.includes('_playerDamageBoostUntil'), false,
    'the HUD is polling Combat - see window.GAME being ?dev=1 only');
  assert.equal(src.includes('_magnetUntil'), false, 'the HUD is polling Loot');
  assert.equal(src.includes('_pauseUntil'), false, 'the HUD is polling NPCManager');
  assert.equal(src.includes('_speedBoostUntil'), false, 'the HUD is polling Player');

  /* And the countdown is read off play time, not wall time - the chip has to
   * freeze with the effect while the panel that used it is still open. */
  assert.match(src, /this\.engine\?\.simElapsed \?\? 0/);
});

test('the layout gate grades the strip', async () => {
  const probe = await readCode('scripts/hud-viewport-probe.mjs');
  assert.ok(probe.includes("'.effects'"), 'the strip is not in the probe NAMED list');
  for (const other of ['.vitals', '.minimap', '.ammo', '.killfeed', '.toasts', '.wstrip']) {
    assert.ok(
      probe.includes(`['.effects', '${other}']`) || probe.includes(`['${other}', '.effects']`),
      `the strip is not graded against ${other}`,
    );
  }

  /* And the harness has to actually put chips on screen, or the gate measures
   * an empty rectangle and reports the strip clean at every viewport. */
  const harness = await readCode('scripts/harness/hud-viewport.js');
  assert.match(harness, /new ActiveEffects\(/);
});
